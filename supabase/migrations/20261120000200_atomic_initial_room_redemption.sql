BEGIN;
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;

-- Drena transações que já escreveram e impede novas leituras/escritas até o
-- snapshot e os REVOKEs serem confirmados juntos. O fallback fazia comandos em
-- transações separadas: uma carteira já confirmada, mas ainda sem ledger, deve
-- aparecer na fotografia de revisão. As instâncias antigas ainda precisam ser
-- paradas: elas podem anunciar sucesso apenas em memória quando a escrita falha.
LOCK TABLE public.royal_room_wallets, public.royal_room_ledger,
           public.royal_room_initial_redemptions IN ACCESS EXCLUSIVE MODE;

-- Consumidores atuais do repositório usam RPCs para mutação. Mantemos SELECT
-- para o backend, mas nenhum cliente pode atualizar diretamente estas tabelas.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.royal_room_wallets, public.royal_room_ledger
  FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.royal_room_wallets, public.royal_room_ledger TO service_role;

-- A migration antiga não habilitou RLS nesta tabela. Ela permanece privada e
-- o bot passa a inserir somente pela função SECURITY DEFINER abaixo.
ALTER TABLE public.royal_room_initial_redemptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.royal_room_initial_redemptions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.royal_room_initial_redemptions TO service_role;
DROP POLICY IF EXISTS service_role_read_initial_redemptions ON public.royal_room_initial_redemptions;
CREATE POLICY service_role_read_initial_redemptions ON public.royal_room_initial_redemptions
  FOR SELECT TO service_role USING (true);

-- A versão anterior só retropreencheu source=initial_redemption. O fallback
-- direto também podia gravar o ledger e falhar antes de inserir o marcador.
-- Um ledger comprovado impede novo crédito; nunca altera a carteira histórica.
INSERT INTO public.royal_room_initial_redemptions (guild_id, user_id, request_id, rooms_quantity, redeemed_at)
SELECT DISTINCT ON (l.guild_id, l.user_id)
       l.guild_id, l.user_id, l.request_id, l.delta_rooms, l.created_at
  FROM public.royal_room_ledger AS l
 WHERE l.event_type = 'admin_grant' AND l.delta_rooms > 0
   AND l.detail ->> 'source' IN ('initial_redemption', 'initial_redemption_direct_fallback')
 ORDER BY l.guild_id, l.user_id, l.created_at, l.id
ON CONFLICT DO NOTHING;

-- Um crash do fallback depois do upsert e antes do ledger não deixa prova da
-- origem do saldo. No corte, toda carteira preexistente sem marcador comprovado
-- é colocada em revisão, mesmo que possa ser uma compra legítima. Não deduzir
-- crédito pelo saldo e não criar ledger/ajuste artificial. Esta fotografia é
-- feita apenas na criação da tabela; reaplicar a migration não inclui carteiras
-- criadas depois do corte. Pare todas as versões antigas do bot durante o corte.
DO $$
BEGIN
  IF to_regclass('public.royal_room_initial_redemption_reviews') IS NULL THEN
    CREATE TABLE public.royal_room_initial_redemption_reviews (
      guild_id text NOT NULL,
      user_id text NOT NULL,
      reason text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (guild_id, user_id)
    );
    INSERT INTO public.royal_room_initial_redemption_reviews (guild_id, user_id, reason)
    SELECT w.guild_id, w.user_id, 'pre_cutover_wallet_without_redemption_evidence'
      FROM public.royal_room_wallets AS w
     WHERE NOT EXISTS (
       SELECT 1 FROM public.royal_room_initial_redemptions AS r
        WHERE r.guild_id = w.guild_id AND r.user_id = w.user_id
     );
    -- Inclui ledger suspeito mesmo se a carteira tiver sido removida ou o
    -- retropreenchimento não puder inserir um marcador por conflito de chave.
    INSERT INTO public.royal_room_initial_redemption_reviews (guild_id, user_id, reason)
    SELECT DISTINCT l.guild_id, l.user_id, 'unmapped_initial_redemption_ledger'
      FROM public.royal_room_ledger AS l
     WHERE l.event_type = 'admin_grant'
       AND l.detail ->> 'source' IN ('initial_redemption', 'initial_redemption_direct_fallback')
       AND NOT EXISTS (SELECT 1 FROM public.royal_room_initial_redemptions AS r
                        WHERE r.guild_id = l.guild_id AND r.user_id = l.user_id)
    ON CONFLICT (guild_id, user_id) DO NOTHING;
    -- A tabela/coluna legada é opcional: alguns ambientes não aplicaram as
    -- migrations de cotas. Um marcador legado isolado também requer revisão.
    IF to_regclass('public.royal_mediator_room_quotas') IS NOT NULL
       AND EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                    WHERE attrelid = to_regclass('public.royal_mediator_room_quotas')
                      AND attname = 'resgate_inicial_realizado' AND NOT attisdropped) THEN
      EXECUTE $sql$
        INSERT INTO public.royal_room_initial_redemption_reviews (guild_id, user_id, reason)
        SELECT q.guild_id, q.user_id, 'legacy_quota_redemption_requires_review'
          FROM public.royal_mediator_room_quotas AS q
         WHERE q.resgate_inicial_realizado IS TRUE
           AND NOT EXISTS (SELECT 1 FROM public.royal_room_initial_redemptions AS r
                            WHERE r.guild_id = q.guild_id AND r.user_id = q.user_id)
        ON CONFLICT (guild_id, user_id) DO NOTHING
      $sql$;
    END IF;
  END IF;
END;
$$;
ALTER TABLE public.royal_room_initial_redemption_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.royal_room_initial_redemption_reviews FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.royal_room_initial_redemption_reviews TO service_role;
DROP POLICY IF EXISTS service_role_read_initial_redemption_reviews ON public.royal_room_initial_redemption_reviews;
CREATE POLICY service_role_read_initial_redemption_reviews ON public.royal_room_initial_redemption_reviews
  FOR SELECT TO service_role USING (true);

-- REVOKE da tabela não remove grants independentes por coluna. Também não
-- revogamos grants de roles de terceiros às cegas: eles podem servir outros
-- sistemas. Se um dos papéis puder herdá-los ou usar SET ROLE, falhe e desfaça
-- toda a migration para auditoria do ambiente e dos consumidores externos.
DO $$
DECLARE
  v_table regclass;
  v_columns text;
  v_target record;
  v_role record;
  v_privilege text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'public.royal_room_wallets'::regclass,
    'public.royal_room_ledger'::regclass,
    'public.royal_room_initial_redemptions'::regclass,
    'public.royal_room_initial_redemption_reviews'::regclass
  ] LOOP
    SELECT string_agg(format('%I', a.attname), ', ' ORDER BY a.attnum)
      INTO v_columns FROM pg_catalog.pg_attribute a
     WHERE a.attrelid = v_table AND a.attnum > 0 AND NOT a.attisdropped;
    EXECUTE format('REVOKE INSERT (%s), UPDATE (%s), REFERENCES (%s) ON TABLE %s FROM PUBLIC, anon, authenticated, service_role',
                   v_columns, v_columns, v_columns, v_table);
    FOR v_target IN SELECT oid, rolname FROM pg_catalog.pg_roles
                     WHERE rolname IN ('anon', 'authenticated', 'service_role') LOOP
      FOR v_role IN SELECT oid, rolname, rolsuper FROM pg_catalog.pg_roles r
                     WHERE pg_catalog.pg_has_role(v_target.oid, r.oid, 'MEMBER') LOOP
        IF v_role.rolsuper THEN
          RAISE EXCEPTION 'ROOM_DIRECT_WRITE_PRIVILEGE_UNSAFE: % can assume superuser %', v_target.rolname, v_role.rolname;
        END IF;
        FOREACH v_privilege IN ARRAY ARRAY['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] LOOP
          IF pg_catalog.has_table_privilege(v_role.oid, v_table, v_privilege) THEN
            RAISE EXCEPTION 'ROOM_DIRECT_WRITE_PRIVILEGE_UNSAFE: % can assume %, which has % on %',
              v_target.rolname, v_role.rolname, v_privilege, v_table;
          END IF;
        END LOOP;
        FOREACH v_privilege IN ARRAY ARRAY['INSERT', 'UPDATE', 'REFERENCES'] LOOP
          IF EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                      WHERE a.attrelid = v_table AND a.attnum > 0 AND NOT a.attisdropped
                        AND pg_catalog.has_column_privilege(v_role.oid, v_table, a.attnum, v_privilege)) THEN
            RAISE EXCEPTION 'ROOM_DIRECT_WRITE_PRIVILEGE_UNSAFE: % can assume %, which has column % on %',
              v_target.rolname, v_role.rolname, v_privilege, v_table;
          END IF;
        END LOOP;
      END LOOP;
    END LOOP;
  END LOOP;
END;
$$;
-- A revisão é administrativa: examinar a origem do saldo, pedidos, ledger e
-- cota legada. Um operador privilegiado só remove a linha após concluir se já
-- houve resgate; se comprovado, registra o marcador com lastro auditável na
-- mesma transação. Documentar a decisão fora da tabela; se a origem continuar
-- incerta, manter o bloqueio. Nunca ajustar saldo nem fabricar evidências.

CREATE OR REPLACE FUNCTION public.royal_room_credit_initial_redemption(
  p_guild_id text, p_user_id text, p_request_id text, p_rooms_quantity bigint DEFAULT 10
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_guild text := trim(p_guild_id);
  v_user text := trim(p_user_id);
  v_request text := trim(p_request_id);
  v_wallet public.royal_room_wallets%ROWTYPE;
  v_redemption public.royal_room_initial_redemptions%ROWTYPE;
  v_ledger public.royal_room_ledger%ROWTYPE;
  v_redeemed boolean := false;
  v_available bigint;
BEGIN
  IF COALESCE(v_guild, '') = '' OR COALESCE(v_user, '') = ''
     OR COALESCE(v_request, '') = '' OR length(v_request) > 180
     OR p_rooms_quantity IS NULL OR p_rooms_quantity < 1 THEN
    RAISE EXCEPTION 'INVALID_INITIAL_ROOM_REDEMPTION';
  END IF;

  -- Mesmo lock da RPC histórica; serializa inclusive requests diferentes para
  -- o mesmo par e a constraint PK é uma segunda barreira de unicidade.
  PERFORM pg_advisory_xact_lock(hashtextextended('initial-room-redeem:' || v_guild || ':' || v_user, 0));

  SELECT * INTO v_redemption FROM public.royal_room_initial_redemptions WHERE request_id = v_request;
  IF FOUND AND (v_redemption.guild_id <> v_guild OR v_redemption.user_id <> v_user) THEN
    RAISE EXCEPTION 'INITIAL_ROOM_REQUEST_CONFLICT';
  END IF;
  -- Quarentena prevalece inclusive sobre um marcador/ledger que apareça depois
  -- do corte. Uma linha de ledger não deve encobrir uma revisão ainda aberta.
  IF EXISTS (SELECT 1 FROM public.royal_room_initial_redemption_reviews
              WHERE guild_id = v_guild AND user_id = v_user) THEN
    RAISE EXCEPTION 'INITIAL_ROOM_REDEMPTION_REVIEW_REQUIRED';
  END IF;
  SELECT * INTO v_redemption FROM public.royal_room_initial_redemptions
   WHERE guild_id = v_guild AND user_id = v_user;
  IF NOT FOUND THEN
    -- Também cobre ledgers antigos não retropreenchidos por conflitos ou dados
    -- importados após o corte. Não trata um request alheio como replay válido.
    SELECT * INTO v_ledger FROM public.royal_room_ledger
     WHERE guild_id = v_guild AND user_id = v_user AND event_type = 'admin_grant'
       AND delta_rooms > 0
       AND detail ->> 'source' IN ('initial_redemption', 'initial_redemption_direct_fallback')
     ORDER BY created_at, id LIMIT 1;
    IF FOUND THEN
      INSERT INTO public.royal_room_initial_redemptions (guild_id, user_id, request_id, rooms_quantity, redeemed_at)
      VALUES (v_guild, v_user, v_ledger.request_id, v_ledger.delta_rooms, v_ledger.created_at);
    ELSE
      IF EXISTS (SELECT 1 FROM public.royal_room_ledger WHERE request_id = v_request) THEN
        RAISE EXCEPTION 'INITIAL_ROOM_REQUEST_CONFLICT';
      END IF;
      INSERT INTO public.royal_room_initial_redemptions (guild_id, user_id, request_id, rooms_quantity)
      VALUES (v_guild, v_user, v_request, p_rooms_quantity);
      INSERT INTO public.royal_room_wallets (guild_id, user_id, purchased_rooms, updated_at)
      VALUES (v_guild, v_user, p_rooms_quantity, now())
      ON CONFLICT (guild_id, user_id) DO UPDATE
        SET purchased_rooms = public.royal_room_wallets.purchased_rooms + EXCLUDED.purchased_rooms,
            updated_at = now();
      INSERT INTO public.royal_room_ledger (guild_id, user_id, request_id, event_type, delta_rooms, detail)
      VALUES (v_guild, v_user, v_request, 'admin_grant', p_rooms_quantity,
              jsonb_build_object('source', 'initial_redemption', 'rooms_quantity', p_rooms_quantity));
      v_redeemed := true;
    END IF;
  END IF;
  -- O mesmo sinal e a mesma regra de congelamento das RPCs de reserva/stats.
  SELECT * INTO v_wallet FROM public.royal_room_wallets WHERE guild_id = v_guild AND user_id = v_user FOR UPDATE;
  v_available := CASE WHEN COALESCE(v_wallet.is_frozen, false) THEN 0 ELSE
    COALESCE(v_wallet.purchased_rooms, 0) - COALESCE(v_wallet.reserved_rooms, 0)
    - COALESCE(v_wallet.consumed_rooms, 0) - COALESCE(v_wallet.reversed_rooms, 0) END;
  RETURN jsonb_build_object('guild_id', v_guild, 'user_id', v_user,
    'available_rooms', v_available, 'redeemed', v_redeemed, 'idempotent', NOT v_redeemed);
END;
$$;
REVOKE ALL ON FUNCTION public.royal_room_credit_initial_redemption(text, text, text, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.royal_room_credit_initial_redemption(text, text, text, bigint) TO service_role;

-- Grant também usa a mesma fórmula da reserva, tanto na concessão como no
-- replay. O lock por request elimina corridas de replay entre administradores.
CREATE OR REPLACE FUNCTION public.royal_room_admin_grant(
  p_guild_id text, p_user_id text, p_request_id text, p_rooms_quantity bigint, p_actor_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_wallet public.royal_room_wallets%ROWTYPE;
  v_ledger public.royal_room_ledger%ROWTYPE;
  v_idempotent boolean := false;
  v_balance bigint;
BEGIN
  IF COALESCE(trim(p_guild_id), '') = '' OR COALESCE(trim(p_user_id), '') = ''
     OR COALESCE(trim(p_request_id), '') = '' OR p_rooms_quantity IS NULL OR p_rooms_quantity < 1 THEN
    RAISE EXCEPTION 'INVALID_ADMIN_GRANT';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('room-admin-grant:' || p_request_id, 0));
  SELECT * INTO v_ledger FROM public.royal_room_ledger WHERE request_id = p_request_id;
  IF FOUND THEN
    IF v_ledger.guild_id <> p_guild_id OR v_ledger.user_id <> p_user_id
       OR v_ledger.event_type <> 'admin_grant' OR v_ledger.delta_rooms <> p_rooms_quantity
       OR v_ledger.detail ->> 'source' IN ('initial_redemption', 'initial_redemption_direct_fallback')
       OR (v_ledger.detail ->> 'actor_id') IS DISTINCT FROM p_actor_id THEN
      RAISE EXCEPTION 'ADMIN_GRANT_REQUEST_CONFLICT';
    END IF;
    v_idempotent := true;
  ELSE
    INSERT INTO public.royal_room_wallets (guild_id, user_id, purchased_rooms, updated_at)
    VALUES (p_guild_id, p_user_id, p_rooms_quantity, now())
    ON CONFLICT (guild_id, user_id) DO UPDATE
      SET purchased_rooms = public.royal_room_wallets.purchased_rooms + EXCLUDED.purchased_rooms, updated_at = now();
    INSERT INTO public.royal_room_ledger (guild_id, user_id, request_id, event_type, delta_rooms, detail)
    VALUES (p_guild_id, p_user_id, p_request_id, 'admin_grant', p_rooms_quantity, jsonb_build_object('actor_id', p_actor_id));
  END IF;
  SELECT * INTO v_wallet FROM public.royal_room_wallets WHERE guild_id = p_guild_id AND user_id = p_user_id FOR UPDATE;
  v_balance := CASE WHEN COALESCE(v_wallet.is_frozen, false) THEN 0 ELSE
    COALESCE(v_wallet.purchased_rooms, 0) - COALESCE(v_wallet.reserved_rooms, 0)
    - COALESCE(v_wallet.consumed_rooms, 0) - COALESCE(v_wallet.reversed_rooms, 0) END;
  RETURN jsonb_build_object('guild_id', p_guild_id, 'user_id', p_user_id, 'balance_rooms', v_balance, 'idempotent', v_idempotent);
END;
$$;
REVOKE ALL ON FUNCTION public.royal_room_admin_grant(text, text, text, bigint, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.royal_room_admin_grant(text, text, text, bigint, text) TO service_role;

-- Não presumir que todas as funções existentes foram criadas pelo mesmo dono.
-- Se um owner dependia dos grants retirados ou de uma policy RLS não auditada,
-- o corte deve abortar em vez de quebrar compra, estorno, reserva ou liquidação.
DO $$
DECLARE
  v_check record;
  v_oid oid;
  v_owner oid;
  v_definer boolean;
  v_privilege text;
  v_bypass boolean;
  v_table_owner oid;
  v_force_rls boolean;
BEGIN
  FOR v_check IN SELECT * FROM (VALUES
    ('public.royal_room_credit_initial_redemption(text,text,text,bigint)', 'public.royal_room_wallets', ARRAY['SELECT','INSERT','UPDATE'], true),
    ('public.royal_room_credit_initial_redemption(text,text,text,bigint)', 'public.royal_room_ledger', ARRAY['SELECT','INSERT'], true),
    ('public.royal_room_credit_initial_redemption(text,text,text,bigint)', 'public.royal_room_initial_redemptions', ARRAY['SELECT','INSERT'], true),
    ('public.royal_room_credit_initial_redemption(text,text,text,bigint)', 'public.royal_room_initial_redemption_reviews', ARRAY['SELECT'], true),
    ('public.royal_room_admin_grant(text,text,text,bigint,text)', 'public.royal_room_wallets', ARRAY['SELECT','INSERT','UPDATE'], true),
    ('public.royal_room_admin_grant(text,text,text,bigint,text)', 'public.royal_room_ledger', ARRAY['SELECT','INSERT'], true),
    ('public.royal_room_apply_payment(uuid,text,text,bigint,text,text,bigint,text)', 'public.royal_room_wallets', ARRAY['SELECT','INSERT','UPDATE'], true),
    ('public.royal_room_apply_payment(uuid,text,text,bigint,text,text,bigint,text)', 'public.royal_room_ledger', ARRAY['SELECT','INSERT'], true),
    ('public.royal_wallet_purchase_rooms(text,text,text,integer,bigint)', 'public.royal_room_wallets', ARRAY['SELECT','INSERT','UPDATE'], true),
    ('public.royal_wallet_purchase_rooms(text,text,text,integer,bigint)', 'public.royal_room_ledger', ARRAY['INSERT'], true),
    ('public.royal_room_reserve_room(text,text,text,text,text)', 'public.royal_room_wallets', ARRAY['SELECT','INSERT','UPDATE'], true),
    ('public.royal_room_reserve_room(text,text,text,text,text)', 'public.royal_room_ledger', ARRAY['INSERT'], true),
    ('public.royal_room_settle_room(text,text,text,text,text)', 'public.royal_room_wallets', ARRAY['SELECT','UPDATE'], true),
    ('public.royal_room_settle_room(text,text,text,text,text)', 'public.royal_room_ledger', ARRAY['INSERT'], true),
    ('public.royal_room_stats(text,text)', 'public.royal_room_wallets', ARRAY['SELECT'], true),
    ('public.royal_wallet_propagate_freeze_to_rooms()', 'public.royal_room_wallets', ARRAY['SELECT','INSERT','UPDATE'], false)
  ) AS checks(signature, table_name, privileges, callable) LOOP
    v_oid := to_regprocedure(v_check.signature);
    SELECT p.proowner, p.prosecdef INTO v_owner, v_definer FROM pg_catalog.pg_proc p WHERE p.oid = v_oid;
    IF v_oid IS NULL OR NOT COALESCE(v_definer, false) OR
       (v_check.callable AND NOT pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE')) THEN
      RAISE EXCEPTION 'ROOM_DEFINER_UNSAFE: verify function % and service_role EXECUTE', v_check.signature;
    END IF;
    FOREACH v_privilege IN ARRAY v_check.privileges LOOP
      IF NOT pg_catalog.has_table_privilege(v_owner, v_check.table_name, v_privilege) THEN
        RAISE EXCEPTION 'ROOM_DEFINER_UNSAFE: owner of % lacks % on %', v_check.signature, v_privilege, v_check.table_name;
      END IF;
    END LOOP;
    SELECT r.rolsuper OR r.rolbypassrls INTO v_bypass FROM pg_catalog.pg_roles r WHERE r.oid = v_owner;
    SELECT c.relowner, c.relforcerowsecurity INTO v_table_owner, v_force_rls
      FROM pg_catalog.pg_class c WHERE c.oid = v_check.table_name::regclass;
    IF NOT v_bypass AND (v_force_rls OR NOT pg_catalog.pg_has_role(v_owner, v_table_owner, 'USAGE')) THEN
      RAISE EXCEPTION 'ROOM_DEFINER_UNSAFE: owner of % depends on unaudited RLS for %', v_check.signature, v_check.table_name;
    END IF;
  END LOOP;
END;
$$;

COMMIT;
