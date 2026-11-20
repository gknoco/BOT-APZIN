BEGIN;
SET TRANSACTION ISOLATION LEVEL READ COMMITTED;

-- Drena as transações da implementação anterior antes da fotografia e troca da
-- RPC. O lock de carteira é compartilhado com reserva e liquidação; o lock de
-- pedido serializa os webhooks do mesmo pagamento. Erros abortam todo o corte.
-- Toda escrita antiga deve estar parada antes do corte (veja o runbook).
-- Timeout evita aguardar indefinidamente se o dreno foi incompleto.
SET LOCAL lock_timeout = '5s';
LOCK TABLE public.royal_room_purchase_orders, public.royal_room_wallets,
  public.royal_room_ledger, public.royal_wallet_topups,
  public.royal_wallet_balances, public.royal_wallet_topup_ledger,
  public.royal_room_mp_webhook_events IN ACCESS EXCLUSIVE MODE;

ALTER TABLE public.royal_room_purchase_orders
  ADD COLUMN IF NOT EXISTS direct_refund_observed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS direct_refunded_cents bigint NOT NULL DEFAULT 0;
ALTER TABLE public.royal_room_wallets
  ADD COLUMN IF NOT EXISTS direct_refund_review boolean NOT NULL DEFAULT false;
ALTER TABLE public.royal_wallet_balances
  ADD COLUMN IF NOT EXISTS topup_ledger_review boolean NOT NULL DEFAULT false;
ALTER TABLE public.royal_wallet_balances DROP CONSTRAINT IF EXISTS royal_wallet_topup_ledger_review_check;
ALTER TABLE public.royal_wallet_balances ADD CONSTRAINT royal_wallet_topup_ledger_review_check
  CHECK (NOT topup_ledger_review OR is_frozen);

-- Um desbloqueio do runbook de recarga não pode remover uma revisão independente
-- de compra direta, mesmo quando o motivo visível tiver sido sobrescrito.
ALTER TABLE public.royal_room_wallets DROP CONSTRAINT IF EXISTS royal_room_direct_refund_hold_check;
ALTER TABLE public.royal_room_wallets ADD CONSTRAINT royal_room_direct_refund_hold_check
  CHECK (NOT direct_refund_review OR is_frozen);
ALTER TABLE public.royal_room_purchase_orders DROP CONSTRAINT IF EXISTS royal_room_direct_refunded_cents_check;
ALTER TABLE public.royal_room_purchase_orders ADD CONSTRAINT royal_room_direct_refunded_cents_check
  CHECK (direct_refunded_cents >= 0 AND direct_refunded_cents <= amount_cents);
ALTER TABLE public.royal_room_ledger DROP CONSTRAINT IF EXISTS royal_room_ledger_event_type_check;
ALTER TABLE public.royal_room_ledger ADD CONSTRAINT royal_room_ledger_event_type_check
  CHECK (event_type IN ('purchase', 'reserved', 'created', 'released', 'reversed', 'admin_grant', 'refund_review'));

-- As versões antigas não persistiam o valor parcial. Quarentene evidência
-- identificável, inclusive revisão com crédito já lançado, e reversão integral
-- aparentemente ausente. Nunca infira quantas salas foram consumidas por pedido.
UPDATE public.royal_room_purchase_orders o SET direct_refund_observed = true
 WHERE o.mp_status IS DISTINCT FROM 'wallet'
   AND (o.status IN ('refunded','charged_back')
     OR o.error_code = 'partial_refund_requires_review'
     OR o.mp_status IN ('refunded','charged_back')
     OR (o.status = 'manual_review' AND (o.approved_at IS NOT NULL OR EXISTS
       (SELECT 1 FROM public.royal_room_ledger l WHERE l.request_id = 'purchase:' || o.id::text))));

INSERT INTO public.royal_room_wallets(guild_id,user_id,is_frozen,frozen_reason,direct_refund_review,updated_at)
SELECT DISTINCT o.guild_id,o.user_id,true,'direct_room_refund_cutover',true,now()
  FROM public.royal_room_purchase_orders o
 WHERE o.mp_status IS DISTINCT FROM 'wallet' AND (
   (o.direct_refund_observed AND o.status NOT IN ('refunded','charged_back'))
   OR (o.status IN ('refunded','charged_back') AND (o.approved_at IS NOT NULL OR EXISTS
      (SELECT 1 FROM public.royal_room_ledger l WHERE l.request_id = 'purchase:' || o.id::text))
      AND NOT (EXISTS (SELECT 1 FROM public.royal_room_ledger l
        WHERE l.request_id='purchase:'||o.id::text AND l.order_id=o.id AND l.guild_id=o.guild_id
          AND l.user_id=o.user_id AND l.event_type='purchase' AND l.delta_rooms=o.rooms_quantity)
       AND EXISTS (SELECT 1 FROM public.royal_room_ledger l
        WHERE l.request_id='reversal:'||o.id::text AND l.order_id=o.id AND l.guild_id=o.guild_id
          AND l.user_id=o.user_id AND l.event_type='reversed' AND l.delta_rooms=-o.rooms_quantity)))
 )
ON CONFLICT (guild_id,user_id) DO UPDATE SET is_frozen=true,
  frozen_reason='direct_room_refund_cutover',direct_refund_review=true,updated_at=now();

UPDATE public.royal_room_purchase_orders SET status='manual_review',
  error_code=COALESCE(error_code,'direct_refund_requires_review'),updated_at=now()
 WHERE mp_status IS DISTINCT FROM 'wallet' AND direct_refund_observed
   AND status NOT IN ('manual_review','refunded','charged_back');

-- As tabelas são fonte de verdade: impedir que o backend contorne os novos
-- marcadores através de UPDATE direto ou grants de coluna herdados.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.royal_room_purchase_orders FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.royal_room_purchase_orders TO service_role;
DO $acl$
DECLARE cols text; target record; role_rec record; priv text;
BEGIN
  SELECT string_agg(format('%I',a.attname),', ' ORDER BY a.attnum) INTO cols
    FROM pg_catalog.pg_attribute a WHERE a.attrelid='public.royal_room_purchase_orders'::regclass
      AND a.attnum>0 AND NOT a.attisdropped;
  EXECUTE format('REVOKE INSERT (%s), UPDATE (%s), REFERENCES (%s) ON public.royal_room_purchase_orders FROM PUBLIC, anon, authenticated, service_role',cols,cols,cols);
  FOR target IN SELECT oid,rolname FROM pg_catalog.pg_roles WHERE rolname IN ('anon','authenticated','service_role') LOOP
    FOR role_rec IN SELECT oid,rolname,rolsuper FROM pg_catalog.pg_roles r
      WHERE pg_catalog.pg_has_role(target.oid,r.oid,'MEMBER') LOOP
      IF role_rec.rolsuper THEN RAISE EXCEPTION 'ROOM_ORDER_DIRECT_WRITE_UNSAFE: % can assume superuser %',target.rolname,role_rec.rolname; END IF;
      FOREACH priv IN ARRAY ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
        IF pg_catalog.has_table_privilege(role_rec.oid,'public.royal_room_purchase_orders',priv) THEN
          RAISE EXCEPTION 'ROOM_ORDER_DIRECT_WRITE_UNSAFE: % can assume % with %',target.rolname,role_rec.rolname,priv;
        END IF;
      END LOOP;
      FOREACH priv IN ARRAY ARRAY['INSERT','UPDATE','REFERENCES'] LOOP
        IF pg_catalog.has_any_column_privilege(role_rec.oid,'public.royal_room_purchase_orders',priv) THEN
          RAISE EXCEPTION 'ROOM_ORDER_DIRECT_WRITE_UNSAFE: % can assume % with column %',target.rolname,role_rec.rolname,priv;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
END $acl$;

CREATE OR REPLACE FUNCTION public.royal_room_apply_payment(
  p_order_id uuid, p_payment_id text, p_status text, p_amount_cents bigint,
  p_currency text, p_external_reference text, p_refunded_cents bigint DEFAULT 0,
  p_manual_reason text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  o public.royal_room_purchase_orders%ROWTYPE;
  w public.royal_room_wallets%ROWTYPE;
  purchase public.royal_room_ledger%ROWTYPE;
  reversal public.royal_room_ledger%ROWTYPE;
  s text := lower(trim(COALESCE(p_status,'')));
  reason text;
  signal boolean;
  full_refund boolean;
  has_purchase boolean;
  has_reversal boolean;
  hold boolean := false;
  review_key text;
BEGIN
  SELECT * INTO o FROM public.royal_room_purchase_orders WHERE id=p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PURCHASE_NOT_FOUND'; END IF;
  IF COALESCE(trim(p_payment_id),'')='' THEN RAISE EXCEPTION 'PAYMENT_ID_REQUIRED'; END IF;
  IF o.mp_status='wallet' THEN RAISE EXCEPTION 'DIRECT_PAYMENT_FOR_WALLET_ORDER'; END IF;

  -- Esta ordem não adquire locks de uso após o da carteira. Liquidação já toma
  -- o lock da linha da carteira em UPDATE, evitando inversão com o lock de uso.
  PERFORM pg_advisory_xact_lock(hashtextextended('room-wallet:'||o.guild_id||':'||o.user_id,0));
  INSERT INTO public.royal_room_wallets(guild_id,user_id) VALUES(o.guild_id,o.user_id)
    ON CONFLICT (guild_id,user_id) DO NOTHING;
  SELECT * INTO w FROM public.royal_room_wallets WHERE guild_id=o.guild_id AND user_id=o.user_id FOR UPDATE;
  SELECT * INTO purchase FROM public.royal_room_ledger WHERE request_id='purchase:'||o.id::text;
  has_purchase := FOUND;
  SELECT * INTO reversal FROM public.royal_room_ledger WHERE request_id='reversal:'||o.id::text;
  has_reversal := FOUND;

  signal := s IN ('refunded','charged_back') OR COALESCE(p_refunded_cents,0)>0
    OR p_refunded_cents IS NULL OR COALESCE(p_refunded_cents,0)<0
    OR COALESCE(p_refunded_cents,0)>o.amount_cents OR p_manual_reason='invalid_refunded_amount';
  IF EXISTS (SELECT 1 FROM public.royal_room_purchase_orders WHERE mp_payment_id=p_payment_id AND id<>o.id) THEN
    reason := 'payment_id_already_linked';
  ELSIF (o.mp_payment_id IS NOT NULL AND o.mp_payment_id<>p_payment_id)
    OR COALESCE(p_external_reference,'')<>o.id::text OR COALESCE(upper(p_currency),'')<>'BRL' THEN
    reason := 'payment_reference_currency_mismatch';
  ELSIF p_manual_reason IS NOT NULL OR s='manual_review' THEN
    reason := left(COALESCE(p_manual_reason,'payment_requires_review'),80);
  ELSIF (s='approved' OR signal) AND COALESCE(p_amount_cents,-1)<>o.amount_cents THEN
    reason := 'payment_amount_mismatch';
  ELSIF p_refunded_cents IS NULL OR p_refunded_cents<0 OR p_refunded_cents>o.amount_cents THEN
    reason := 'invalid_refunded_amount';
  ELSIF has_purchase AND (purchase.guild_id IS DISTINCT FROM o.guild_id OR purchase.user_id IS DISTINCT FROM o.user_id
      OR purchase.order_id IS DISTINCT FROM o.id OR purchase.event_type IS DISTINCT FROM 'purchase'
      OR purchase.delta_rooms IS DISTINCT FROM o.rooms_quantity::bigint) THEN
    reason := 'purchase_ledger_inconsistent';
  ELSIF has_reversal AND (reversal.guild_id IS DISTINCT FROM o.guild_id OR reversal.user_id IS DISTINCT FROM o.user_id
      OR reversal.order_id IS DISTINCT FROM o.id OR reversal.event_type IS DISTINCT FROM 'reversed'
      OR reversal.delta_rooms IS DISTINCT FROM -o.rooms_quantity::bigint OR NOT has_purchase) THEN
    reason := 'reversal_ledger_inconsistent';
  ELSIF has_reversal AND o.status NOT IN ('refunded','charged_back','manual_review') AND NOT signal THEN
    reason := 'reversal_status_inconsistent';
  ELSIF o.direct_refund_observed AND o.status NOT IN ('manual_review','refunded','charged_back') THEN
    reason := 'refund_status_inconsistent';
  ELSIF NOT has_purchase AND (o.status='approved' OR o.approved_at IS NOT NULL) THEN
    reason := 'purchase_ledger_missing';
  END IF;

  full_refund := reason IS NULL AND (s='charged_back' OR p_refunded_cents=o.amount_cents);
  IF signal THEN
    UPDATE public.royal_room_purchase_orders SET direct_refund_observed=true,
      direct_refunded_cents=GREATEST(direct_refunded_cents,
        CASE WHEN p_refunded_cents BETWEEN 0 AND amount_cents THEN p_refunded_cents ELSE 0 END),updated_at=now()
      WHERE id=o.id RETURNING * INTO o;
  END IF;

  -- A carteira é um pool sem associação de uso a pedido. Em estorno parcial
  -- não existe rateio seguro (especialmente com cupom e reservas em voo):
  -- congelar TUDO para revisão, sem retirar nem fabricar créditos.
  hold := (signal AND NOT full_refund AND o.status NOT IN ('refunded','charged_back'))
       OR (reason IS NOT NULL AND (has_purchase OR o.approved_at IS NOT NULL OR signal OR o.direct_refund_observed));
  IF hold THEN
    UPDATE public.royal_room_wallets SET is_frozen=true,direct_refund_review=true,
      frozen_reason='direct_room_refund_review:'||o.id::text,updated_at=now()
      WHERE guild_id=o.guild_id AND user_id=o.user_id;
    review_key := 'direct-refund-review:'||o.id::text||':'||md5(s||':'||COALESCE(p_refunded_cents::text,'null')||':'||COALESCE(reason,''));
    INSERT INTO public.royal_room_ledger(guild_id,user_id,request_id,event_type,delta_rooms,order_id,detail)
      VALUES(o.guild_id,o.user_id,review_key,'refund_review',0,o.id,
        jsonb_build_object('payment_id',p_payment_id,'provider_status',s,'refunded_cents',p_refunded_cents,
          'reason',COALESCE(reason,'partial_refund_requires_review'),'wallet_frozen',true))
      ON CONFLICT (request_id) DO NOTHING;
  END IF;

  IF reason IS NOT NULL THEN
    UPDATE public.royal_room_purchase_orders SET
      status=CASE WHEN status IN ('refunded','charged_back') THEN status ELSE 'manual_review' END,
      mp_status=CASE WHEN status IN ('refunded','charged_back') THEN mp_status ELSE s END,
      error_code=reason,updated_at=now() WHERE id=o.id RETURNING * INTO o;
    RETURN to_jsonb(o);
  END IF;

  IF signal THEN
    IF full_refund THEN
      IF has_purchase AND NOT has_reversal THEN
        -- Inserção e alteração de saldo são uma única transação; não use DO
        -- NOTHING para uma mutação de saldo sem confirmar o resultado do ledger.
        INSERT INTO public.royal_room_ledger(guild_id,user_id,request_id,event_type,delta_rooms,order_id,detail)
          VALUES(o.guild_id,o.user_id,'reversal:'||o.id::text,'reversed',-o.rooms_quantity,o.id,
            jsonb_build_object('payment_id',p_payment_id,'provider_status',s,'refunded_cents',p_refunded_cents));
        UPDATE public.royal_room_wallets SET reversed_rooms=reversed_rooms+o.rooms_quantity,updated_at=now()
          WHERE guild_id=o.guild_id AND user_id=o.user_id;
      END IF;
      UPDATE public.royal_room_purchase_orders SET
        status=CASE WHEN status='charged_back' OR s='charged_back' THEN 'charged_back' ELSE 'refunded' END,
        mp_payment_id=COALESCE(mp_payment_id,p_payment_id),mp_status=s,error_code=NULL,updated_at=now()
        WHERE id=o.id RETURNING * INTO o;
    ELSIF o.status NOT IN ('refunded','charged_back') THEN
      UPDATE public.royal_room_purchase_orders SET status='manual_review',
        mp_payment_id=COALESCE(mp_payment_id,p_payment_id),mp_status=s,
        error_code='partial_refund_requires_review',updated_at=now() WHERE id=o.id RETURNING * INTO o;
    END IF;
    RETURN to_jsonb(o);
  END IF;

  -- Um replay anterior ao estorno ou uma resposta fora de ordem jamais desfaz
  -- o marcador, o bloqueio, a reversão ou recria uma concessão.
  IF o.direct_refund_observed OR o.status IN ('manual_review','refunded','charged_back') OR has_reversal THEN
    RETURN to_jsonb(o);
  END IF;
  IF s='approved' THEN
    IF NOT has_purchase THEN
      INSERT INTO public.royal_room_ledger(guild_id,user_id,request_id,event_type,delta_rooms,order_id,detail)
        VALUES(o.guild_id,o.user_id,'purchase:'||o.id::text,'purchase',o.rooms_quantity,o.id,
          jsonb_build_object('payment_id',p_payment_id,'amount_cents',o.amount_cents));
      UPDATE public.royal_room_wallets SET purchased_rooms=purchased_rooms+o.rooms_quantity,updated_at=now()
        WHERE guild_id=o.guild_id AND user_id=o.user_id;
      IF o.coupon_id IS NOT NULL THEN
        INSERT INTO public.royal_room_coupon_uses(order_id,coupon_id,guild_id,user_id,discount_cents)
          VALUES(o.id,o.coupon_id,o.guild_id,o.user_id,o.discount_cents) ON CONFLICT (order_id) DO NOTHING;
      END IF;
    END IF;
    UPDATE public.royal_room_purchase_orders SET status='approved',mp_payment_id=p_payment_id,mp_status=s,
      approved_at=COALESCE(approved_at,now()),error_code=NULL,updated_at=now() WHERE id=o.id RETURNING * INTO o;
  ELSIF o.status<>'approved' THEN
    IF s NOT IN ('pending','in_process','rejected','cancelled','expired') THEN s:='pending'; END IF;
    UPDATE public.royal_room_purchase_orders SET status=s,mp_payment_id=COALESCE(mp_payment_id,p_payment_id),
      mp_status=s,updated_at=now() WHERE id=o.id RETURNING * INTO o;
  END IF;
  RETURN to_jsonb(o);
END $$;

-- Uma falha atrasada de criação não pode apagar status de estorno ou revisão.
CREATE OR REPLACE FUNCTION public.royal_room_mark_purchase_failure(p_order_id uuid,p_status text,p_error_code text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE o public.royal_room_purchase_orders%ROWTYPE;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('failed','manual_review') THEN RAISE EXCEPTION 'INVALID_PURCHASE_FAILURE_STATUS'; END IF;
  SELECT * INTO o FROM public.royal_room_purchase_orders WHERE id=p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PURCHASE_NOT_FOUND'; END IF;
  IF o.status NOT IN ('approved','manual_review','refunded','charged_back') AND NOT o.direct_refund_observed
     AND NOT EXISTS (SELECT 1 FROM public.royal_room_ledger WHERE request_id='purchase:'||o.id::text) THEN
    UPDATE public.royal_room_purchase_orders SET status=p_status,error_code=left(COALESCE(p_error_code,'unknown'),80),updated_at=now()
      WHERE id=p_order_id RETURNING * INTO o;
  END IF;
  RETURN to_jsonb(o);
END $$;
REVOKE ALL ON FUNCTION public.royal_room_apply_payment(uuid,text,text,bigint,text,text,bigint,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.royal_room_apply_payment(uuid,text,text,bigint,text,text,bigint,text) TO service_role;
REVOKE ALL ON FUNCTION public.royal_room_mark_purchase_failure(uuid,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.royal_room_mark_purchase_failure(uuid,text,text) TO service_role;

-- A revogação de escrita deve deixar as RPCs existentes funcionais, inclusive
-- em ambientes onde o owner de alguma delas não seja o owner da tabela.
DO $owners$
DECLARE sig text; oid_fn oid; owner_id oid; ok boolean; bypass boolean; tbl_owner oid; force_rls boolean; priv text;
BEGIN
  FOREACH sig IN ARRAY ARRAY[
    'public.royal_room_create_purchase(text,text,text,integer,text,text)',
    'public.royal_room_attach_payment(uuid,text,text,text,text,timestamptz)',
    'public.royal_room_mark_purchase_failure(uuid,text,text)',
    'public.royal_room_apply_payment(uuid,text,text,bigint,text,text,bigint,text)',
    'public.royal_wallet_purchase_rooms(text,text,text,integer,bigint)'
  ] LOOP
    oid_fn:=to_regprocedure(sig);
    SELECT p.proowner,p.prosecdef INTO owner_id,ok FROM pg_catalog.pg_proc p WHERE p.oid=oid_fn;
    IF oid_fn IS NULL OR NOT COALESCE(ok,false) OR NOT pg_catalog.has_function_privilege('service_role',oid_fn,'EXECUTE') THEN
      RAISE EXCEPTION 'ROOM_ORDER_DEFINER_UNSAFE: %',sig;
    END IF;
    FOREACH priv IN ARRAY ARRAY['SELECT','INSERT','UPDATE'] LOOP
      IF NOT pg_catalog.has_table_privilege(owner_id,'public.royal_room_purchase_orders',priv) THEN
        RAISE EXCEPTION 'ROOM_ORDER_DEFINER_UNSAFE: owner of % lacks %',sig,priv;
      END IF;
    END LOOP;
    SELECT r.rolsuper OR r.rolbypassrls INTO bypass FROM pg_catalog.pg_roles r WHERE r.oid=owner_id;
    SELECT c.relowner,c.relforcerowsecurity INTO tbl_owner,force_rls FROM pg_catalog.pg_class c WHERE c.oid='public.royal_room_purchase_orders'::regclass;
    IF NOT bypass AND (force_rls OR NOT pg_catalog.pg_has_role(owner_id,tbl_owner,'USAGE')) THEN
      RAISE EXCEPTION 'ROOM_ORDER_DEFINER_UNSAFE: owner of % depends on unaudited RLS',sig;
    END IF;
  END LOOP;
END $owners$;

-- Proteção monetária substitui a RPC antiga mantendo ambas as assinaturas.
CREATE OR REPLACE FUNCTION public.royal_wallet_apply_topup_payment(
  p_topup_id uuid,
  p_payment_id text,
  p_status text,
  p_amount_cents bigint,
  p_currency text,
  p_external_reference text,
  p_payment_method text,
  p_refunded_cents bigint
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_row public.royal_wallet_topups%ROWTYPE;
  v_status text := lower(trim(COALESCE(p_status, '')));
  v_balance bigint;
  v_frozen boolean := false;
  v_reason text;
  v_wallet_reason text;
  v_final_status text;
  v_previous_status text;
  v_credit public.royal_wallet_topup_ledger%ROWTYPE;
  v_has_credit boolean;
  v_open_refund boolean;
  v_open_reason text;
  v_review_base text;
  v_review_key text;
BEGIN
  SELECT * INTO v_row FROM public.royal_wallet_topups WHERE id = p_topup_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WALLET_TOPUP_NOT_FOUND'; END IF;
  IF COALESCE(trim(p_payment_id), '') = '' THEN RAISE EXCEPTION 'WALLET_TOPUP_PAYMENT_ID_REQUIRED'; END IF;
  IF EXISTS (SELECT 1 FROM public.royal_wallet_topups WHERE mp_payment_id = p_payment_id AND id <> p_topup_id) THEN
    UPDATE public.royal_wallet_topups SET status = 'manual_review', mp_status = v_status,
      error_code = 'payment_id_already_linked', updated_at = now() WHERE id = p_topup_id RETURNING * INTO v_row;
    RETURN to_jsonb(v_row) || jsonb_build_object('balance_cents', NULL, 'wallet_frozen', NULL);
  END IF;

  IF COALESCE(p_external_reference, '') <> v_row.id::text THEN v_reason := 'external_reference_mismatch';
  ELSIF COALESCE(upper(p_currency), '') <> 'BRL' THEN v_reason := 'currency_mismatch';
  ELSIF COALESCE(lower(p_payment_method), '') <> 'pix' THEN v_reason := 'payment_method_mismatch';
  ELSIF v_row.mp_payment_id IS NOT NULL AND v_row.mp_payment_id <> p_payment_id THEN v_reason := 'payment_id_mismatch';
  ELSIF v_status = 'approved' AND COALESCE(p_amount_cents, -1) <> v_row.amount_cents THEN v_reason := 'amount_mismatch';
  END IF;
  IF v_reason IS NOT NULL THEN
    UPDATE public.royal_wallet_topups SET status = 'manual_review', mp_payment_id = COALESCE(mp_payment_id, p_payment_id),
      mp_status = v_status, error_code = v_reason, updated_at = now() WHERE id = p_topup_id RETURNING * INTO v_row;
    SELECT balance_cents, is_frozen INTO v_balance, v_frozen FROM public.royal_wallet_balances
      WHERE guild_id = v_row.guild_id AND user_id = v_row.user_id;
    RETURN to_jsonb(v_row) || jsonb_build_object('balance_cents', CASE WHEN COALESCE(v_frozen, false) THEN 0 ELSE COALESCE(v_balance, 0) END,
      'wallet_frozen', COALESCE(v_frozen, false));
  END IF;

  IF v_status IN ('refunded', 'charged_back') OR COALESCE(p_refunded_cents, 0) > 0 THEN
    INSERT INTO public.royal_wallet_balances (guild_id, user_id, balance_cents, updated_at)
      VALUES (v_row.guild_id, v_row.user_id, 0, now())
      ON CONFLICT (guild_id, user_id) DO NOTHING;
    SELECT balance_cents, is_frozen INTO v_balance, v_frozen FROM public.royal_wallet_balances
      WHERE guild_id = v_row.guild_id AND user_id = v_row.user_id FOR UPDATE;

    v_previous_status := v_row.status;
    v_wallet_reason := CASE
      WHEN v_status = 'charged_back' THEN 'chargeback'
      WHEN v_status = 'refunded' AND (COALESCE(p_refunded_cents, 0) = 0 OR p_refunded_cents >= v_row.amount_cents) THEN 'refund'
      ELSE 'partial_refund_review'
    END;
    v_final_status := CASE
      WHEN v_wallet_reason = 'chargeback' THEN 'charged_back'
      WHEN v_wallet_reason = 'refund' THEN 'refunded'
      ELSE 'manual_review'
    END;
    UPDATE public.royal_wallet_balances SET is_frozen = true,
      frozen_reason = v_wallet_reason || ':' || v_row.id::text, updated_at = now()
      WHERE guild_id = v_row.guild_id AND user_id = v_row.user_id;
    UPDATE public.royal_wallet_topups SET status = v_final_status, mp_payment_id = COALESCE(mp_payment_id, p_payment_id),
      mp_status = v_status, error_code = CASE WHEN v_final_status = 'manual_review' THEN 'partial_refund_requires_review' ELSE NULL END,
      updated_at = now() WHERE id = p_topup_id RETURNING * INTO v_row;

    -- Uma ocorrência já resolvida não pode esconder um novo estorno idêntico.
    -- Reutilize a revisão enquanto aberta; após resolução, abra outra.
    v_review_base := 'refund_review:' || v_row.id::text || ':' || md5(p_payment_id || ':' || v_wallet_reason || ':' || v_status || ':' || COALESCE(p_refunded_cents, 0)::text);
    SELECT r.request_id INTO v_review_key FROM public.royal_wallet_topup_ledger r
      WHERE (r.request_id=v_review_base OR left(r.request_id,length(v_review_base)+1)=v_review_base||':')
        AND r.topup_id=v_row.id AND r.guild_id=v_row.guild_id AND r.user_id=v_row.user_id
        AND r.event_type='refund_review' AND r.detail->>'wallet_frozen'='true'
        AND NOT EXISTS (SELECT 1 FROM public.royal_wallet_topup_ledger x
          WHERE x.guild_id=r.guild_id AND x.user_id=r.user_id AND x.event_type='refund_review'
            AND x.detail->>'resolves_request_id'=r.request_id)
      ORDER BY r.created_at DESC LIMIT 1;
    IF v_review_key IS NULL THEN
      v_review_key := CASE WHEN EXISTS (SELECT 1 FROM public.royal_wallet_topup_ledger WHERE request_id=v_review_base)
        THEN v_review_base||':'||gen_random_uuid()::text ELSE v_review_base END;
    END IF;
    INSERT INTO public.royal_wallet_topup_ledger
      (guild_id, user_id, request_id, event_type, delta_cents, topup_id, balance_after_cents, detail)
    VALUES (v_row.guild_id, v_row.user_id, v_review_key,
      'refund_review', 0, v_row.id, COALESCE(v_balance, 0),
      jsonb_build_object('payment_id', p_payment_id, 'payment_status', v_status,
        'refunded_cents', COALESCE(p_refunded_cents, 0), 'credited_cents', v_row.credit_cents,
        'wallet_frozen', true, 'wallet_reason', v_wallet_reason, 'previous_topup_status', v_previous_status))
    ON CONFLICT (request_id) DO NOTHING;
    RETURN to_jsonb(v_row) || jsonb_build_object('balance_cents', 0, 'wallet_frozen', true);
  END IF;

  IF v_status = 'approved' THEN
    INSERT INTO public.royal_wallet_balances (guild_id, user_id, balance_cents, updated_at)
      VALUES (v_row.guild_id, v_row.user_id, 0, now())
      ON CONFLICT (guild_id, user_id) DO NOTHING;
    SELECT balance_cents, is_frozen INTO v_balance, v_frozen FROM public.royal_wallet_balances
      WHERE guild_id = v_row.guild_id AND user_id = v_row.user_id FOR UPDATE;
    SELECT * INTO v_credit FROM public.royal_wallet_topup_ledger
      WHERE request_id = 'topup:' || v_row.id::text;
    v_has_credit := FOUND;
    SELECT COALESCE(r.detail->>'wallet_reason','refund_review')||':'||r.topup_id::text
      INTO v_open_reason FROM public.royal_wallet_topup_ledger r
      WHERE r.topup_id=v_row.id AND r.event_type='refund_review' AND r.detail->>'wallet_frozen'='true'
        AND NOT EXISTS (SELECT 1 FROM public.royal_wallet_topup_ledger x
          WHERE x.guild_id=r.guild_id AND x.user_id=r.user_id AND x.event_type='refund_review'
            AND x.detail->>'resolves_request_id'=r.request_id)
      ORDER BY r.created_at DESC,r.id DESC LIMIT 1;
    v_open_refund := FOUND;
    IF (v_has_credit AND (v_credit.topup_id IS DISTINCT FROM v_row.id
        OR v_credit.guild_id IS DISTINCT FROM v_row.guild_id OR v_credit.user_id IS DISTINCT FROM v_row.user_id
        OR v_credit.event_type IS DISTINCT FROM 'topup' OR v_credit.delta_cents IS DISTINCT FROM v_row.credit_cents))
        OR (NOT v_has_credit AND (v_row.status='approved' OR v_row.approved_at IS NOT NULL)) THEN
      UPDATE public.royal_wallet_balances SET is_frozen=true,topup_ledger_review=true,
        frozen_reason=CASE WHEN is_frozen THEN frozen_reason ELSE 'topup_ledger_inconsistent:'||v_row.id::text END,
        updated_at=now() WHERE guild_id=v_row.guild_id AND user_id=v_row.user_id;
      UPDATE public.royal_wallet_topups SET status='manual_review', error_code='topup_ledger_inconsistent',
        updated_at=now() WHERE id=p_topup_id RETURNING * INTO v_row;
      RETURN to_jsonb(v_row)||jsonb_build_object('balance_cents',0,'wallet_frozen',true);
    END IF;
    IF COALESCE(v_frozen, false) OR v_open_refund THEN
      -- Nunca deixe um replay de approved apagar um status terminal; caso uma
      -- carteira tenha sido desbloqueada indevidamente, refaça o freeze.
      IF v_open_refund AND NOT COALESCE(v_frozen,false) THEN
        UPDATE public.royal_wallet_balances SET is_frozen=true,
          frozen_reason=v_open_reason,updated_at=now()
          WHERE guild_id=v_row.guild_id AND user_id=v_row.user_id;
      END IF;
      UPDATE public.royal_wallet_topups SET
        status=CASE WHEN status IN ('refunded','charged_back') THEN status ELSE 'manual_review' END,
        mp_payment_id=COALESCE(mp_payment_id,p_payment_id),mp_status='approved',
        error_code=CASE WHEN status IN ('refunded','charged_back') THEN error_code ELSE 'wallet_frozen_pending_review' END,
        updated_at=now() WHERE id=p_topup_id RETURNING * INTO v_row;
      RETURN to_jsonb(v_row) || jsonb_build_object('balance_cents',0,'wallet_frozen',true);
    END IF;
    IF v_row.status NOT IN ('refunded','charged_back') THEN
      IF NOT v_has_credit THEN
        -- A linha única é a autorização do crédito. O INSERT sem DO NOTHING
        -- e o UPDATE do saldo compartilham a transação e o lock da recarga.
        INSERT INTO public.royal_wallet_topup_ledger
          (guild_id,user_id,request_id,event_type,delta_cents,topup_id,balance_after_cents,detail)
        VALUES (v_row.guild_id,v_row.user_id,'topup:'||v_row.id::text,'topup',v_row.credit_cents,
          v_row.id,v_balance+v_row.credit_cents,jsonb_build_object('payment_id',p_payment_id,
            'amount_cents',v_row.amount_cents,'bonus_cents',v_row.bonus_cents,'credit_cents',v_row.credit_cents));
        UPDATE public.royal_wallet_balances SET balance_cents=balance_cents+v_row.credit_cents,updated_at=now()
          WHERE guild_id=v_row.guild_id AND user_id=v_row.user_id RETURNING balance_cents INTO v_balance;
      END IF;
      UPDATE public.royal_wallet_topups SET status='approved',mp_payment_id=p_payment_id,
        mp_status='approved',approved_at=COALESCE(approved_at,now()),error_code=NULL,updated_at=now()
        WHERE id=p_topup_id RETURNING * INTO v_row;
    ELSE
      UPDATE public.royal_wallet_topups SET mp_status='approved',updated_at=now()
        WHERE id=p_topup_id RETURNING * INTO v_row;
    END IF;
  ELSIF v_row.status NOT IN ('approved', 'refunded', 'charged_back') THEN
    IF v_status NOT IN ('pending','in_process','rejected','cancelled','expired') THEN v_status := 'pending'; END IF;
    UPDATE public.royal_wallet_topups SET status = v_status, mp_payment_id = COALESCE(mp_payment_id, p_payment_id),
      mp_status = v_status, updated_at = now() WHERE id = p_topup_id RETURNING * INTO v_row;
    SELECT balance_cents, is_frozen INTO v_balance, v_frozen FROM public.royal_wallet_balances
      WHERE guild_id = v_row.guild_id AND user_id = v_row.user_id;
  ELSE
    SELECT balance_cents, is_frozen INTO v_balance, v_frozen FROM public.royal_wallet_balances
      WHERE guild_id = v_row.guild_id AND user_id = v_row.user_id;
  END IF;
  RETURN to_jsonb(v_row) || jsonb_build_object(
    'balance_cents', CASE WHEN COALESCE(v_frozen, false) THEN 0 ELSE COALESCE(v_balance, 0) END,
    'wallet_frozen', COALESCE(v_frozen, false));
END;
$$;

REVOKE ALL ON FUNCTION public.royal_wallet_apply_topup_payment(uuid,text,text,bigint,text,text,text,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.royal_wallet_apply_topup_payment(uuid,text,text,bigint,text,text,text,bigint) TO service_role;

-- O bug anterior podia alterar o saldo sem um segundo lançamento. Não suponha
-- que a diferença é corrigível: congele para reconciliação administrativa.
WITH totals AS (
  SELECT guild_id,user_id,SUM(delta_cents) AS total FROM public.royal_wallet_topup_ledger GROUP BY guild_id,user_id
), mismatch AS (
  SELECT COALESCE(b.guild_id,t.guild_id) AS guild_id,COALESCE(b.user_id,t.user_id) AS user_id
    FROM public.royal_wallet_balances b FULL JOIN totals t USING(guild_id,user_id)
    WHERE COALESCE(b.balance_cents,0)<>COALESCE(t.total,0)
), bad_topups AS (
  SELECT t.guild_id,t.user_id FROM public.royal_wallet_topups t
    LEFT JOIN public.royal_wallet_topup_ledger l ON l.request_id='topup:'||t.id::text
    WHERE (t.status='approved' OR t.approved_at IS NOT NULL OR l.id IS NOT NULL)
      AND (l.id IS NULL OR l.guild_id IS DISTINCT FROM t.guild_id OR l.user_id IS DISTINCT FROM t.user_id
        OR l.topup_id IS DISTINCT FROM t.id OR l.event_type IS DISTINCT FROM 'topup'
        OR l.delta_cents IS DISTINCT FROM t.credit_cents)
), suspicious AS (
  SELECT guild_id,user_id FROM mismatch UNION SELECT guild_id,user_id FROM bad_topups
)
INSERT INTO public.royal_wallet_balances(guild_id,user_id,balance_cents,is_frozen,topup_ledger_review,frozen_reason,updated_at)
  SELECT guild_id,user_id,0,true,true,'topup_ledger_cutover',now() FROM suspicious
ON CONFLICT(guild_id,user_id) DO UPDATE SET is_frozen=true,topup_ledger_review=true,
  frozen_reason=CASE WHEN public.royal_wallet_balances.is_frozen
    THEN public.royal_wallet_balances.frozen_reason ELSE 'topup_ledger_cutover' END,updated_at=now();

-- Não permitir que o backend remova o marcador sticky ou altere saldo fora
-- das RPCs. Consumidores privilegiados externos também devem ser drenados.
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER
  ON public.royal_wallet_balances FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON public.royal_wallet_balances TO service_role;
DO $balance_acl$
DECLARE cols text; target record; role_rec record; priv text;
BEGIN
  SELECT string_agg(format('%I',a.attname),', ' ORDER BY a.attnum) INTO cols
    FROM pg_catalog.pg_attribute a WHERE a.attrelid='public.royal_wallet_balances'::regclass
      AND a.attnum>0 AND NOT a.attisdropped;
  EXECUTE format('REVOKE INSERT (%s), UPDATE (%s), REFERENCES (%s) ON public.royal_wallet_balances FROM PUBLIC, anon, authenticated, service_role',cols,cols,cols);
  FOR target IN SELECT oid,rolname FROM pg_catalog.pg_roles WHERE rolname IN ('anon','authenticated','service_role') LOOP
    FOR role_rec IN SELECT oid,rolname,rolsuper FROM pg_catalog.pg_roles r
      WHERE pg_catalog.pg_has_role(target.oid,r.oid,'MEMBER') LOOP
      IF role_rec.rolsuper THEN RAISE EXCEPTION 'WALLET_BALANCE_DIRECT_WRITE_UNSAFE: % can assume superuser %',target.rolname,role_rec.rolname; END IF;
      FOREACH priv IN ARRAY ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
        IF pg_catalog.has_table_privilege(role_rec.oid,'public.royal_wallet_balances',priv) THEN
          RAISE EXCEPTION 'WALLET_BALANCE_DIRECT_WRITE_UNSAFE: % can assume % with %',target.rolname,role_rec.rolname,priv;
        END IF;
      END LOOP;
      FOREACH priv IN ARRAY ARRAY['INSERT','UPDATE','REFERENCES'] LOOP
        IF pg_catalog.has_any_column_privilege(role_rec.oid,'public.royal_wallet_balances',priv) THEN
          RAISE EXCEPTION 'WALLET_BALANCE_DIRECT_WRITE_UNSAFE: % can assume % with column %',target.rolname,role_rec.rolname,priv;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
END $balance_acl$;
DO $balance_owners$
DECLARE sig text; oid_fn oid; owner_id oid; ok boolean; bypass boolean; tbl_owner oid; force_rls boolean; priv text;
BEGIN
  FOREACH sig IN ARRAY ARRAY[
    'public.royal_wallet_apply_topup_payment(uuid,text,text,bigint,text,text,text,bigint)',
    'public.royal_wallet_purchase_rooms(text,text,text,integer,bigint)'
  ] LOOP
    oid_fn:=to_regprocedure(sig);
    SELECT p.proowner,p.prosecdef INTO owner_id,ok FROM pg_catalog.pg_proc p WHERE p.oid=oid_fn;
    IF oid_fn IS NULL OR NOT COALESCE(ok,false) OR NOT pg_catalog.has_function_privilege('service_role',oid_fn,'EXECUTE') THEN
      RAISE EXCEPTION 'WALLET_BALANCE_DEFINER_UNSAFE: %',sig;
    END IF;
    FOREACH priv IN ARRAY ARRAY['SELECT','INSERT','UPDATE'] LOOP
      IF NOT pg_catalog.has_table_privilege(owner_id,'public.royal_wallet_balances',priv) THEN
        RAISE EXCEPTION 'WALLET_BALANCE_DEFINER_UNSAFE: owner of % lacks %',sig,priv;
      END IF;
    END LOOP;
    SELECT r.rolsuper OR r.rolbypassrls INTO bypass FROM pg_catalog.pg_roles r WHERE r.oid=owner_id;
    SELECT c.relowner,c.relforcerowsecurity INTO tbl_owner,force_rls FROM pg_catalog.pg_class c WHERE c.oid='public.royal_wallet_balances'::regclass;
    IF NOT bypass AND (force_rls OR NOT pg_catalog.pg_has_role(owner_id,tbl_owner,'USAGE')) THEN
      RAISE EXCEPTION 'WALLET_BALANCE_DEFINER_UNSAFE: owner of % depends on unaudited RLS',sig;
    END IF;
  END LOOP;
END $balance_owners$;

-- Cada chamada confirmada é uma obrigação de consulta própria, inclusive
-- reentrega ou resultado ambíguo após COMMIT. Nunca colapsar por ID/action.
CREATE OR REPLACE FUNCTION public.royal_room_enqueue_payment_event(
  p_event_key text, p_payment_id text, p_action text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v_row public.royal_room_mp_webhook_events%ROWTYPE;
BEGIN
  IF COALESCE(trim(p_event_key), '') = '' OR COALESCE(trim(p_payment_id), '') = '' THEN
    RAISE EXCEPTION 'WEBHOOK_EVENT_ID_REQUIRED';
  END IF;
  -- O sufixo é gerado no banco em CADA chamada, também para clientes antigos
  -- e retries com o mesmo p_event_key; truncamento jamais remove o sufixo.
  INSERT INTO public.royal_room_mp_webhook_events(event_key,payment_id,action)
    VALUES(left(p_event_key,120)||':'||gen_random_uuid()::text,
      left(trim(p_payment_id),80),left(COALESCE(p_action,''),100))
    RETURNING * INTO v_row;
  RETURN jsonb_build_object('id',v_row.id,'status',v_row.status);
END $$;

-- Claim já retorna attempts e utiliza SKIP LOCKED + lease de 60s. A tentativa
-- é fencing token: um worker expirado jamais finaliza a tentativa sucessora.
CREATE OR REPLACE FUNCTION public.royal_room_finish_payment_event(
  p_event_id uuid, p_success boolean, p_error_code text, p_attempt integer
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF p_attempt IS NULL OR p_attempt < 1 OR p_success IS NULL THEN
    RAISE EXCEPTION 'WEBHOOK_INVALID_LEASE';
  END IF;
  IF p_success THEN
    UPDATE public.royal_room_mp_webhook_events
      SET status='processed',lease_until=NULL,last_error=NULL,processed_at=now()
      WHERE id=p_event_id AND status='processing' AND attempts=p_attempt;
  ELSE
    UPDATE public.royal_room_mp_webhook_events
      SET status='pending',lease_until=NULL,
        available_at=now()+make_interval(secs=>LEAST(3600,15*power(2,LEAST(attempts,8))::integer)),
        last_error=left(COALESCE(p_error_code,'processing_failed'),80)
      WHERE id=p_event_id AND status='processing' AND attempts=p_attempt;
  END IF;
END $$;
REVOKE ALL ON FUNCTION public.royal_room_enqueue_payment_event(text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.royal_room_enqueue_payment_event(text,text,text) TO service_role;
REVOKE ALL ON FUNCTION public.royal_room_finish_payment_event(uuid,boolean,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.royal_room_finish_payment_event(uuid,boolean,text,integer) TO service_role;
-- A assinatura antiga não tem token e não pode confirmar leases novos.
REVOKE ALL ON FUNCTION public.royal_room_finish_payment_event(uuid,boolean,text) FROM PUBLIC,anon,authenticated,service_role;
DO $queue_acl$
DECLARE r record;
BEGIN
  FOR r IN SELECT oid,rolname FROM pg_catalog.pg_roles WHERE pg_catalog.pg_has_role('service_role',oid,'MEMBER') LOOP
    IF pg_catalog.has_function_privilege(r.oid,'public.royal_room_finish_payment_event(uuid,boolean,text)'::regprocedure,'EXECUTE') THEN
      RAISE EXCEPTION 'WEBHOOK_LEGACY_FINISH_UNSAFE: service_role can assume %',r.rolname;
    END IF;
  END LOOP;
END $queue_acl$;

-- Os registros anteriores podem ter suprimido notificações quando processed.
-- Reconsultar cada um; também recupera leases anteriores ao corte. Em uma
-- reaplicação deliberada haverá nova consulta, não exclusão de trabalho.
UPDATE public.royal_room_mp_webhook_events SET status='pending',lease_until=NULL,
  available_at=now(),last_error=NULL,processed_at=NULL;

COMMIT;
