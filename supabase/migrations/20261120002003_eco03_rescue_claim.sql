-- ECO-03. Corte: parar e drenar TODAS as versões antigas antes desta migração.
-- A transação fotografa pendências legadas para revisão; nunca presume que
-- status=pending prova que pagamento/envio/concessão ainda não aconteceu.
BEGIN;
LOCK TABLE public.royal_purchases, public.royal_reward_deliveries IN ACCESS EXCLUSIVE MODE;

CREATE TABLE IF NOT EXISTS public.royal_rescue_claims (
  guild_id text NOT NULL,
  source text NOT NULL CHECK (source IN ('loja','roleta')),
  protocol_hash text NOT NULL,
  protocol text NOT NULL,
  state text NOT NULL CHECK (state IN ('review','claimed','completed')),
  owner_id text,
  claim_request_id text,
  claimed_at timestamptz,
  completed_at timestamptz,
  user_id text,
  item_id uuid,
  reward_type text,
  reward_value text,
  PRIMARY KEY (guild_id, source, protocol_hash),
  CHECK (protocol_hash = md5(protocol)),
  CHECK (state = 'review' OR (owner_id IS NOT NULL AND claim_request_id IS NOT NULL AND claimed_at IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS public.royal_rescue_cutover (id boolean PRIMARY KEY DEFAULT true CHECK (id));
ALTER TABLE public.royal_rescue_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.royal_rescue_cutover ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.royal_rescue_claims, public.royal_rescue_cutover FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.royal_rescue_claims TO service_role;
-- O backend não pode apagar, reidentificar ou atualizar diretamente a fonte;
-- as funções já existentes de compra/giro (SECURITY DEFINER) continuam inserindo.
REVOKE UPDATE, DELETE, TRUNCATE ON public.royal_purchases, public.royal_reward_deliveries FROM PUBLIC, anon, authenticated, service_role;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.relname, a.attname FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    WHERE n.nspname='public' AND c.relname IN ('royal_purchases','royal_reward_deliveries')
  LOOP
    EXECUTE format('REVOKE UPDATE (%I) ON public.%I FROM PUBLIC, anon, authenticated, service_role', r.attname, r.relname);
  END LOOP;
END $$;
-- Falhe fechado se uma role herdada (inclusive via SET ROLE) ainda permitir
-- alterar/apagar as fontes ou forjar reservas. Não alteramos privilégios dela.
DO $$
DECLARE r record; t record; a record;
BEGIN
  FOR r IN SELECT oid,rolname,rolsuper FROM pg_catalog.pg_roles
           WHERE pg_catalog.pg_has_role('service_role', oid, 'MEMBER')
  LOOP
    IF r.rolsuper THEN RAISE EXCEPTION 'RESCUE_DIRECT_WRITE_PRIVILEGE_UNSAFE: % superuser',r.rolname; END IF;
    FOR t IN SELECT c.oid,c.relname,c.relowner FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname IN ('royal_purchases','royal_reward_deliveries','royal_rescue_claims')
    LOOP
      IF t.relowner=r.oid OR has_table_privilege(r.oid,t.oid,'UPDATE') OR has_table_privilege(r.oid,t.oid,'DELETE')
         OR has_table_privilege(r.oid,t.oid,'TRUNCATE')
         OR (t.relname='royal_rescue_claims' AND has_table_privilege(r.oid,t.oid,'INSERT')) THEN
        RAISE EXCEPTION 'RESCUE_DIRECT_WRITE_PRIVILEGE_UNSAFE: % %',r.rolname,t.relname;
      END IF;
      FOR a IN SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=t.oid AND attnum>0 AND NOT attisdropped LOOP
        IF has_column_privilege(r.oid,t.oid,a.attnum,'UPDATE')
           OR (t.relname='royal_rescue_claims' AND has_column_privilege(r.oid,t.oid,a.attnum,'INSERT')) THEN
          RAISE EXCEPTION 'RESCUE_DIRECT_WRITE_PRIVILEGE_UNSAFE: % %',r.rolname,t.relname;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
END $$;

-- Sem repetir a fotografia em uma reaplicação: novas pendências não são legado.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.royal_rescue_cutover WHERE id) THEN
    INSERT INTO public.royal_rescue_claims(guild_id,source,protocol_hash,protocol,state)
      SELECT guild_id, 'loja', md5(id::text), id::text, 'review'
      FROM public.royal_purchases WHERE status='pending'
      ON CONFLICT DO NOTHING;
    INSERT INTO public.royal_rescue_claims(guild_id,source,protocol_hash,protocol,state)
      SELECT guild_id, 'roleta', md5(request_id), request_id, 'review'
      FROM public.royal_reward_deliveries WHERE status='pending'
      ON CONFLICT DO NOTHING;
    INSERT INTO public.royal_rescue_cutover(id) VALUES (true);
  END IF;
END $$;

-- Não permitir o antigo UPDATE direto ou as RPCs legadas de marcar entrega.
-- O contexto transacional é privado ao caminho de conclusão novo. O backend
-- service_role é confiável; acesso SQL privilegiado é sempre administrativo.
CREATE OR REPLACE FUNCTION public.royal_rescue_guard_status() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM 'delivered' AND NEW.status='delivered'
     AND current_setting('royal.rescue_finishing', true) IS DISTINCT FROM 'yes' THEN
    RAISE EXCEPTION 'RESCUE_CLAIM_REQUIRED';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS royal_rescue_guard_status ON public.royal_purchases;
CREATE TRIGGER royal_rescue_guard_status BEFORE UPDATE OF status ON public.royal_purchases
FOR EACH ROW EXECUTE FUNCTION public.royal_rescue_guard_status();
DROP TRIGGER IF EXISTS royal_rescue_guard_status ON public.royal_reward_deliveries;
CREATE TRIGGER royal_rescue_guard_status BEFORE UPDATE OF status ON public.royal_reward_deliveries
FOR EACH ROW EXECUTE FUNCTION public.royal_rescue_guard_status();

-- Uma única linha de origem é o lock de serialização de claim e conclusão.
-- Auto e atendente usam os mesmos locks. Não existe TTL nem retomada automática.
CREATE OR REPLACE FUNCTION public.royal_rescue_action(
  p_action text, p_guild_id text, p_source text, p_protocol text, p_actor_id text, p_request_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
DECLARE
  v_protocol text := p_protocol;
  v_status text;
  v_user text;
  v_item uuid;
  v_type text;
  v_value text;
  c public.royal_rescue_claims%ROWTYPE;
  v_found boolean;
BEGIN
  IF p_action NOT IN ('claim','finish') OR p_action IS NULL
     OR p_source NOT IN ('loja','roleta') OR p_source IS NULL
     OR p_guild_id IS NULL OR btrim(p_guild_id)='' OR length(p_guild_id)>100
     OR p_actor_id IS NULL OR btrim(p_actor_id)='' OR length(p_actor_id)>150
     OR p_request_id IS NULL OR btrim(p_request_id)='' OR length(p_request_id)>150
     OR p_protocol IS NULL OR btrim(p_protocol)='' OR length(p_protocol)>1000
     OR p_protocol ~ '[[:cntrl:]]' THEN
    RAISE EXCEPTION 'RESCUE_INVALID_ARGUMENT';
  END IF;
  IF p_source='loja' THEN
    IF p_protocol !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RETURN jsonb_build_object('result','not_found');
    END IF;
    v_protocol := lower(p_protocol);
    -- A recompensa é a comprada, não o cadastro atual. O join apenas verifica
    -- o escopo do item legado; o snapshot imutável dispensa lock no cadastro.
    SELECT q.status,q.user_id,q.item_id,q.terms_snapshot->>'reward_type',q.terms_snapshot->>'reward_value'
      INTO v_status,v_user,v_item,v_type,v_value
      FROM public.royal_purchases q JOIN public.royal_shop_items i ON i.id=q.item_id AND i.guild_id=q.guild_id
      WHERE q.guild_id=p_guild_id AND q.id=v_protocol::uuid
      FOR UPDATE OF q;
  ELSE
    SELECT r.status,r.user_id,r.reward_type,r.reward_value
      INTO v_status,v_user,v_type,v_value
      FROM public.royal_reward_deliveries r WHERE r.guild_id=p_guild_id AND r.request_id=v_protocol
      FOR UPDATE OF r;
  END IF;
  IF NOT FOUND OR v_type IS NULL OR (p_source='loja' AND v_type NOT IN ('role','pix','physical'))
               OR (p_source='roleta' AND v_type NOT IN ('role','pix')) THEN
    RETURN jsonb_build_object('result','not_found');
  END IF;
  IF v_status='delivered' THEN RETURN jsonb_build_object('result','delivered'); END IF;
  IF v_status IS DISTINCT FROM 'pending' THEN RETURN jsonb_build_object('result','not_pending'); END IF;

  SELECT * INTO c FROM public.royal_rescue_claims
    WHERE guild_id=p_guild_id AND source=p_source AND protocol_hash=md5(v_protocol) FOR UPDATE;
  v_found := FOUND;
  -- Mesmo uma colisão de hash é bloqueada, nunca reutilizada como outra reserva.
  IF v_found AND c.protocol IS DISTINCT FROM v_protocol THEN RETURN jsonb_build_object('result','review'); END IF;
  IF v_found AND c.state='review' THEN RETURN jsonb_build_object('result','review'); END IF;
  IF v_found AND c.state='completed' THEN RETURN jsonb_build_object('result','review'); END IF;
  IF p_action='claim' THEN
    IF v_found THEN
      RETURN jsonb_build_object('result',CASE WHEN c.owner_id=p_actor_id THEN 'already_owned' ELSE 'owned' END,
                                'owner_id',c.owner_id,'claimed_at',c.claimed_at);
    END IF;
    INSERT INTO public.royal_rescue_claims(guild_id,source,protocol_hash,protocol,state,owner_id,claim_request_id,claimed_at,user_id,item_id,reward_type,reward_value)
      VALUES (p_guild_id,p_source,md5(v_protocol),v_protocol,'claimed',p_actor_id,p_request_id,clock_timestamp(),v_user,v_item,v_type,v_value);
    INSERT INTO public.royal_audit_events(guild_id,actor_id,action,entity_type,entity_id,request_id,detail)
      VALUES (p_guild_id,p_actor_id,'reward.delivery.claimed',CASE WHEN p_source='loja' THEN 'purchase' ELSE 'reward_delivery' END,v_protocol,p_request_id,'Reserva sem expiração; nenhum pagamento ou envio efetuado pela reserva.');
    RETURN jsonb_build_object('result','acquired','owner_id',p_actor_id,'user_id',v_user,'reward_type',v_type,'reward_value',v_value);
  END IF;
  IF NOT v_found THEN RETURN jsonb_build_object('result','unclaimed'); END IF;
  IF c.owner_id IS DISTINCT FROM p_actor_id THEN RETURN jsonb_build_object('result','owned','owner_id',c.owner_id,'claimed_at',c.claimed_at); END IF;
  IF c.user_id IS DISTINCT FROM v_user OR c.item_id IS DISTINCT FROM v_item OR
     c.reward_type IS DISTINCT FROM v_type OR c.reward_value IS DISTINCT FROM v_value THEN
    RETURN jsonb_build_object('result','changed');
  END IF;
  PERFORM set_config('royal.rescue_finishing','yes',true);
  IF p_source='loja' THEN
    UPDATE public.royal_purchases SET status='delivered' WHERE id=v_protocol::uuid AND guild_id=p_guild_id AND status='pending';
  ELSE
    UPDATE public.royal_reward_deliveries SET status='delivered',delivered_at=clock_timestamp()
      WHERE guild_id=p_guild_id AND request_id=v_protocol AND status='pending';
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'RESCUE_SOURCE_CHANGED'; END IF;
  PERFORM set_config('royal.rescue_finishing','no',true);
  UPDATE public.royal_rescue_claims SET state='completed',completed_at=clock_timestamp()
    WHERE guild_id=p_guild_id AND source=p_source AND protocol_hash=md5(v_protocol);
  INSERT INTO public.royal_audit_events(guild_id,actor_id,action,entity_type,entity_id,request_id,before_data,after_data,detail)
    VALUES (p_guild_id,p_actor_id,CASE WHEN p_actor_id LIKE 'auto:%' THEN 'reward.delivery.auto_marked' ELSE 'reward.delivery.manual_marked' END,
            CASE WHEN p_source='loja' THEN 'purchase' ELSE 'reward_delivery' END,v_protocol,p_request_id,
            '{"status":"pending"}'::jsonb,'{"status":"delivered"}'::jsonb,'Conclusão registrada; operação externa não verificada.');
  RETURN jsonb_build_object('result','finished');
END $$;
REVOKE ALL ON FUNCTION public.royal_rescue_action(text,text,text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.royal_rescue_action(text,text,text,text,text,text) TO service_role;
REVOKE ALL ON FUNCTION public.royal_rescue_guard_status() FROM PUBLIC, anon, authenticated;
-- O proprietário pode reescrever funções mesmo sem EXECUTE: não pode ser uma
-- role alcançável pelo backend. A definição e a auditoria ficam na transação.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT oid,rolname FROM pg_catalog.pg_roles WHERE pg_catalog.pg_has_role('service_role',oid,'MEMBER') LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.proowner=r.oid AND p.oid IN
      ('public.royal_rescue_action(text,text,text,text,text,text)'::regprocedure,
       'public.royal_rescue_guard_status()'::regprocedure)) THEN
      RAISE EXCEPTION 'RESCUE_FUNCTION_OWNER_UNSAFE: %',r.rolname;
    END IF;
  END LOOP;
END $$;
COMMIT;
