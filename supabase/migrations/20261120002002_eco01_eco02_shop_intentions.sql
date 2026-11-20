BEGIN;

-- Histórico antigo não armazenava os termos; apenas o preço é comprovadamente
-- histórico. Os demais campos são o melhor retrato disponível na migração.
ALTER TABLE public.royal_purchases
  ADD COLUMN IF NOT EXISTS terms_snapshot jsonb,
  ADD COLUMN IF NOT EXISTS snapshot_source text;

UPDATE public.royal_purchases q
   SET terms_snapshot = jsonb_build_object(
     'slug', i.slug, 'name', i.name, 'description', i.description,
     'price', q.price::text, 'reward_type', i.reward_type,
     'reward_value', i.reward_value, 'metadata', i.metadata),
       snapshot_source = 'legacy_current'
  FROM public.royal_shop_items i
 WHERE i.id = q.item_id AND i.guild_id = q.guild_id AND q.terms_snapshot IS NULL;

CREATE OR REPLACE FUNCTION public.royal_shop_terms(i public.royal_shop_items)
RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT jsonb_build_object('slug', i.slug, 'name', i.name, 'description', i.description,
    'price', i.price::text, 'reward_type', i.reward_type,
    'reward_value', i.reward_value, 'metadata', i.metadata)
$$;

-- UPDATE/DELETE adquire lock de linha antes do trigger. A compra e a roleta
-- bloqueiam esta mesma linha antes de criar histórico/inventário. Assim não há
-- janela entre a verificação e a alteração, mesmo em UPDATEs diretos do admin.
CREATE OR REPLACE FUNCTION public.royal_shop_guard_item()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND
     (NEW.id, NEW.guild_id, NEW.slug, NEW.name, NEW.description, NEW.reward_type, NEW.reward_value)
       IS NOT DISTINCT FROM
     (OLD.id, OLD.guild_id, OLD.slug, OLD.name, OLD.description, OLD.reward_type, OLD.reward_value) THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM public.royal_purchases q WHERE q.item_id=OLD.id) OR
     EXISTS (SELECT 1 FROM public.royal_inventory v WHERE v.item_id=OLD.id) THEN
    RAISE EXCEPTION 'Este item possui histórico; identidade e recompensa são imutáveis';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS royal_shop_guard_item ON public.royal_shop_items;
CREATE TRIGGER royal_shop_guard_item BEFORE UPDATE OR DELETE ON public.royal_shop_items
  FOR EACH ROW EXECUTE FUNCTION public.royal_shop_guard_item();

-- Também cobre as RPCs legadas e INSERTs administrativos: a origem do snapshot
-- é sempre a linha do item bloqueada no banco, nunca dados enviados pelo cliente.
CREATE OR REPLACE FUNCTION public.royal_purchase_snapshot_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE i public.royal_shop_items%ROWTYPE;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.id, NEW.created_at, NEW.guild_id, NEW.user_id, NEW.item_id, NEW.price, NEW.request_id,
        NEW.terms_snapshot, NEW.snapshot_source)
       IS DISTINCT FROM
       (OLD.id, OLD.created_at, OLD.guild_id, OLD.user_id, OLD.item_id, OLD.price, OLD.request_id,
        OLD.terms_snapshot, OLD.snapshot_source) THEN
      RAISE EXCEPTION 'Termos da compra são imutáveis';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO i FROM public.royal_shop_items
   WHERE id=NEW.item_id AND guild_id=NEW.guild_id FOR UPDATE;
  IF NOT FOUND OR NEW.price IS DISTINCT FROM i.price THEN
    RAISE EXCEPTION 'Item ou preço da compra inválido';
  END IF;
  NEW.terms_snapshot := public.royal_shop_terms(i);
  NEW.snapshot_source := 'purchase';
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS royal_purchase_snapshot_guard ON public.royal_purchases;
CREATE TRIGGER royal_purchase_snapshot_guard BEFORE INSERT OR UPDATE ON public.royal_purchases
  FOR EACH ROW EXECUTE FUNCTION public.royal_purchase_snapshot_guard();

CREATE TABLE IF NOT EXISTS public.royal_shop_intentions (
  nonce uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id text NOT NULL,
  user_id text NOT NULL,
  item_id uuid NOT NULL REFERENCES public.royal_shop_items(id) ON DELETE CASCADE,
  source_id text NOT NULL,
  terms_snapshot jsonb NOT NULL,
  stock_snapshot bigint,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp() + interval '15 minutes'),
  purchase_id uuid UNIQUE REFERENCES public.royal_purchases(id),
  UNIQUE (guild_id, source_id)
);
CREATE OR REPLACE FUNCTION public.royal_shop_intention_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF (NEW.nonce,NEW.guild_id,NEW.user_id,NEW.item_id,NEW.source_id,NEW.terms_snapshot,
      NEW.stock_snapshot,NEW.created_at,NEW.expires_at) IS DISTINCT FROM
     (OLD.nonce,OLD.guild_id,OLD.user_id,OLD.item_id,OLD.source_id,OLD.terms_snapshot,
      OLD.stock_snapshot,OLD.created_at,OLD.expires_at) OR OLD.purchase_id IS NOT NULL OR NEW.purchase_id IS NULL THEN
    RAISE EXCEPTION 'Intenção é imutável ou já consumida';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.royal_purchases q WHERE q.id=NEW.purchase_id
       AND q.guild_id=NEW.guild_id AND q.user_id=NEW.user_id AND q.item_id=NEW.item_id
       AND q.request_id='shop-intent:'||NEW.nonce::text AND q.terms_snapshot=NEW.terms_snapshot) THEN
    RAISE EXCEPTION 'Compra não corresponde à intenção';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS royal_shop_intention_guard ON public.royal_shop_intentions;
CREATE TRIGGER royal_shop_intention_guard BEFORE UPDATE ON public.royal_shop_intentions
  FOR EACH ROW EXECUTE FUNCTION public.royal_shop_intention_guard();
ALTER TABLE public.royal_shop_intentions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.royal_shop_intentions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.royal_shop_intentions TO service_role;

-- A interação que abriu a prévia também é idempotente; retransmissão do mesmo
-- evento não cria outra intenção. Uma nova interação legítima gera outro nonce.
CREATE OR REPLACE FUNCTION public.royal_create_shop_intention(
  p_guild_id text, p_user_id text, p_item_id uuid, p_source_id text
) RETURNS TABLE(nonce uuid, terms jsonb, stock text, expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v public.royal_shop_intentions%ROWTYPE; i public.royal_shop_items%ROWTYPE;
BEGIN
  IF NULLIF(trim(p_guild_id),'') IS NULL OR NULLIF(trim(p_user_id),'') IS NULL OR p_item_id IS NULL OR
     NULLIF(trim(p_source_id),'') IS NULL OR length(trim(p_source_id)) < 8 OR length(trim(p_source_id)) > 200 THEN
    RAISE EXCEPTION 'Intenção inválida';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(trim(p_guild_id)||':shop-intent-source:'||trim(p_source_id),0));
  SELECT * INTO v FROM public.royal_shop_intentions s
   WHERE s.guild_id=trim(p_guild_id) AND s.source_id=trim(p_source_id);
  IF FOUND THEN
    IF v.user_id IS DISTINCT FROM trim(p_user_id) OR v.item_id IS DISTINCT FROM p_item_id THEN
      RAISE EXCEPTION 'Interação reutilizada para outro usuário ou item';
    END IF;
    RETURN QUERY SELECT v.nonce, v.terms_snapshot, v.stock_snapshot::text, v.expires_at;
    RETURN;
  END IF;
  SELECT * INTO i FROM public.royal_shop_items s
   WHERE s.guild_id=trim(p_guild_id) AND s.id=p_item_id AND s.active FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Item indisponível'; END IF;
  IF i.stock IS NOT NULL AND i.stock < 1 THEN RAISE EXCEPTION 'Item sem estoque'; END IF;
  INSERT INTO public.royal_shop_intentions(guild_id,user_id,item_id,source_id,terms_snapshot,stock_snapshot)
  VALUES(trim(p_guild_id),trim(p_user_id),i.id,trim(p_source_id),public.royal_shop_terms(i),i.stock)
  RETURNING * INTO v;
  RETURN QUERY SELECT v.nonce,v.terms_snapshot,v.stock_snapshot::text,v.expires_at;
END $$;

-- As assinaturas históricas continuam disponíveis; replays usam o snapshot.
CREATE OR REPLACE FUNCTION public.royal_buy_item(p_guild_id text,p_user_id text,p_item_id uuid,p_request_id text)
RETURNS TABLE(purchase_id uuid,item_name text,new_balance bigint,status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  i public.royal_shop_items%ROWTYPE;
  r public.royal_profiles%ROWTYPE;
  q public.royal_purchases%ROWTYPE;
  already record;
  reward_amount bigint;
  new_balance_value bigint;
  purchase_status text;
  max_text text;
  max_per_user bigint;
  purchase_count bigint;
BEGIN
  IF NULLIF(trim(p_guild_id), '') IS NULL OR NULLIF(trim(p_user_id), '') IS NULL THEN
    RAISE EXCEPTION 'Servidor e usuário são obrigatórios';
  END IF;
  IF NULLIF(trim(p_request_id), '') IS NULL OR length(trim(p_request_id)) < 8 THEN
    RAISE EXCEPTION 'request_id inválido';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(trim(p_guild_id)||':buy:'||trim(p_request_id),0));
  SELECT q0.id AS purchase_id, COALESCE(q0.terms_snapshot->>'name',i0.name) AS item_name, r0.coins AS new_balance,
         q0.status, q0.user_id, q0.item_id
    INTO already FROM public.royal_purchases q0
    JOIN public.royal_shop_items i0 ON i0.id=q0.item_id
    LEFT JOIN public.royal_profiles r0 ON r0.guild_id=q0.guild_id AND r0.user_id=q0.user_id
   WHERE q0.guild_id=trim(p_guild_id) AND q0.request_id=trim(p_request_id);
  IF FOUND THEN
    IF already.user_id IS DISTINCT FROM trim(p_user_id) OR already.item_id IS DISTINCT FROM p_item_id THEN
      RAISE EXCEPTION 'request_id reutilizado para outro usuário ou item';
    END IF;
    RETURN QUERY SELECT already.purchase_id,already.item_name,already.new_balance,already.status;
    RETURN;
  END IF;

  SELECT * INTO i FROM public.royal_shop_items
   WHERE id=p_item_id AND guild_id=trim(p_guild_id) AND active FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Item indisponível'; END IF;
  max_text := i.metadata->>'max_per_user';
  IF max_text IS NOT NULL THEN
    max_text := trim(max_text);
    IF max_text !~ '^[0-9]{1,9}$' THEN RAISE EXCEPTION 'Limite por usuário inválido'; END IF;
    max_per_user := max_text::bigint;
    IF max_per_user > 0 THEN
      SELECT count(*) INTO purchase_count FROM public.royal_purchases q0
       WHERE q0.guild_id=trim(p_guild_id) AND q0.user_id=trim(p_user_id)
         AND q0.item_id=i.id AND q0.status <> 'cancelled';
      IF purchase_count >= max_per_user THEN RAISE EXCEPTION 'Limite de compras por usuário atingido'; END IF;
    END IF;
  END IF;
  INSERT INTO public.royal_profiles(guild_id,user_id) VALUES(trim(p_guild_id),trim(p_user_id)) ON CONFLICT DO NOTHING;
  SELECT * INTO r FROM public.royal_profiles WHERE guild_id=trim(p_guild_id) AND user_id=trim(p_user_id) FOR UPDATE;
  IF r.coins<i.price THEN RAISE EXCEPTION 'Saldo insuficiente'; END IF;
  IF i.stock IS NOT NULL AND i.stock<1 THEN RAISE EXCEPTION 'Item sem estoque'; END IF;
  UPDATE public.royal_profiles SET coins=coins-i.price,updated_at=now()
   WHERE guild_id=trim(p_guild_id) AND user_id=trim(p_user_id) RETURNING * INTO r;
  IF i.stock IS NOT NULL THEN UPDATE public.royal_shop_items SET stock=stock-1,updated_at=now() WHERE id=i.id; END IF;
  purchase_status := CASE WHEN i.reward_type IN ('pix','physical','role') THEN 'pending' ELSE 'completed' END;
  INSERT INTO public.royal_purchases(guild_id,user_id,item_id,price,request_id,status)
  VALUES(trim(p_guild_id),trim(p_user_id),i.id,i.price,trim(p_request_id),purchase_status) RETURNING * INTO q;
  INSERT INTO public.royal_inventory(guild_id,user_id,item_id,quantity)
  VALUES(trim(p_guild_id),trim(p_user_id),i.id,1)
  ON CONFLICT(guild_id,user_id,item_id) DO UPDATE SET quantity=public.royal_inventory.quantity+1,updated_at=now();
  INSERT INTO public.royal_wallet_ledger(guild_id,user_id,asset,amount,balance_after,reason,request_id)
  VALUES(trim(p_guild_id),trim(p_user_id),'coins',-i.price,r.coins,'compra:'||i.slug,trim(p_request_id)||':debit');
  IF i.reward_type IN ('coins','spins') THEN
    reward_amount := i.reward_value::bigint;
    IF reward_amount < 0 THEN RAISE EXCEPTION 'Recompensa de saldo inválida'; END IF;
    IF i.reward_type='coins' THEN
      UPDATE public.royal_profiles SET coins=coins+reward_amount,updated_at=now()
       WHERE guild_id=trim(p_guild_id) AND user_id=trim(p_user_id) RETURNING coins INTO new_balance_value;
      INSERT INTO public.royal_wallet_ledger(guild_id,user_id,asset,amount,balance_after,reason,request_id)
      VALUES(trim(p_guild_id),trim(p_user_id),'coins',reward_amount,new_balance_value,'recompensa loja:'||i.slug,trim(p_request_id)||':reward');
    ELSE
      UPDATE public.royal_profiles SET spins=spins+reward_amount,updated_at=now()
       WHERE guild_id=trim(p_guild_id) AND user_id=trim(p_user_id) RETURNING spins INTO new_balance_value;
      INSERT INTO public.royal_wallet_ledger(guild_id,user_id,asset,amount,balance_after,reason,request_id)
      VALUES(trim(p_guild_id),trim(p_user_id),'spins',reward_amount,new_balance_value,'recompensa loja:'||i.slug,trim(p_request_id)||':reward');
    END IF;
    SELECT * INTO r FROM public.royal_profiles WHERE guild_id=trim(p_guild_id) AND user_id=trim(p_user_id);
  END IF;
  RETURN QUERY SELECT q.id,i.name,r.coins,q.status;
END $$;


CREATE OR REPLACE FUNCTION public.royal_buy_item_confirmed(
  p_guild_id text,
  p_user_id text,
  p_item_id uuid,
  p_request_id text,
  p_expected_price bigint
)
RETURNS TABLE(purchase_id uuid, item_name text, new_balance bigint, status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  existing record;
  item_price bigint;
BEGIN
  IF NULLIF(trim(p_guild_id), '') IS NULL OR NULLIF(trim(p_user_id), '') IS NULL THEN
    RAISE EXCEPTION 'Servidor e usuário são obrigatórios';
  END IF;
  IF NULLIF(trim(p_request_id), '') IS NULL OR length(trim(p_request_id)) < 8 THEN
    RAISE EXCEPTION 'request_id inválido';
  END IF;

  -- Ordem igual à royal_buy_item: request, item e finalmente perfil.
  PERFORM pg_advisory_xact_lock(hashtextextended(trim(p_guild_id)||':buy:'||trim(p_request_id), 0));
  SELECT q.id AS purchase_id, q.user_id, q.item_id, q.status,
         COALESCE(q.terms_snapshot->>'name',i.name) AS item_name, r.coins AS new_balance
    INTO existing
    FROM public.royal_purchases q
    JOIN public.royal_shop_items i ON i.id = q.item_id
    LEFT JOIN public.royal_profiles r ON r.guild_id = q.guild_id AND r.user_id = q.user_id
   WHERE q.guild_id = trim(p_guild_id) AND q.request_id = trim(p_request_id);
  IF FOUND THEN
    IF existing.user_id IS DISTINCT FROM trim(p_user_id) OR existing.item_id IS DISTINCT FROM p_item_id THEN
      RAISE EXCEPTION 'request_id reutilizado para outro usuário ou item';
    END IF;
    -- Como na RPC original, devolve o nome e o saldo atuais. Se um perfil foi
    -- removido, o saldo é NULL: nunca se tenta debitar uma compra já registrada.
    RETURN QUERY SELECT existing.purchase_id, existing.item_name, existing.new_balance, existing.status;
    RETURN;
  END IF;

  IF p_expected_price IS NULL THEN RAISE EXCEPTION 'Preço esperado obrigatório'; END IF;
  SELECT i.price INTO item_price FROM public.royal_shop_items i
   WHERE i.id = p_item_id AND i.guild_id = trim(p_guild_id) AND i.active FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Item indisponível'; END IF;
  IF item_price IS DISTINCT FROM p_expected_price THEN
    RAISE EXCEPTION 'O preço mudou';
  END IF;

  -- A linha continua bloqueada até o fim da transação, inclusive durante a
  -- RPC existente: não há janela entre a verificação de preço e o débito.
  RETURN QUERY SELECT b.purchase_id, b.item_name, b.new_balance, b.status
    FROM public.royal_buy_item(p_guild_id, p_user_id, p_item_id, p_request_id) AS b;
END $$;


-- Lock da intenção -> advisory da compra -> item -> perfil. A RPC legada usa
-- advisory -> item -> perfil; a roleta usa prêmio -> item -> perfil. O consumo
-- e todos os efeitos são revertidos juntos em caso de erro.
CREATE OR REPLACE FUNCTION public.royal_confirm_shop_intention(
  p_guild_id text, p_user_id text, p_nonce uuid
) RETURNS TABLE(purchase_id uuid, item_name text, new_balance text, status text,
                reward_type text, reward_value text, is_replay boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE v public.royal_shop_intentions%ROWTYPE; i public.royal_shop_items%ROWTYPE;
        q public.royal_purchases%ROWTYPE; b record; req text; balance bigint;
BEGIN
  IF NULLIF(trim(p_guild_id),'') IS NULL OR NULLIF(trim(p_user_id),'') IS NULL OR p_nonce IS NULL THEN
    RAISE EXCEPTION 'Intenção inválida';
  END IF;
  SELECT * INTO v FROM public.royal_shop_intentions s WHERE s.nonce=p_nonce FOR UPDATE;
  IF NOT FOUND OR v.guild_id IS DISTINCT FROM trim(p_guild_id) OR v.user_id IS DISTINCT FROM trim(p_user_id) THEN
    RAISE EXCEPTION 'Intenção inválida ou pertencente a outro usuário ou servidor';
  END IF;
  IF v.purchase_id IS NOT NULL THEN
    SELECT * INTO q FROM public.royal_purchases x WHERE x.id=v.purchase_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Compra da intenção não encontrada'; END IF;
    SELECT r.coins INTO balance FROM public.royal_profiles r WHERE r.guild_id=v.guild_id AND r.user_id=v.user_id;
    RETURN QUERY SELECT q.id,q.terms_snapshot->>'name',balance::text,q.status,
      q.terms_snapshot->>'reward_type',q.terms_snapshot->>'reward_value',true;
    RETURN;
  END IF;
  IF clock_timestamp() >= v.expires_at THEN RAISE EXCEPTION 'Intenção expirada'; END IF;
  req := 'shop-intent:'||v.nonce::text;
  PERFORM pg_advisory_xact_lock(hashtextextended(v.guild_id||':buy:'||req,0));
  -- Não adotar uma compra já existente feita por uma chamada legada com o
  -- mesmo request_id: somente esta transação pode vincular a intenção.
  IF EXISTS (SELECT 1 FROM public.royal_purchases x WHERE x.guild_id=v.guild_id AND x.request_id=req) THEN
    RAISE EXCEPTION 'Identificador da intenção já utilizado';
  END IF;
  SELECT * INTO i FROM public.royal_shop_items s WHERE s.id=v.item_id AND s.guild_id=v.guild_id FOR UPDATE;
  IF NOT FOUND OR NOT i.active THEN RAISE EXCEPTION 'Item indisponível'; END IF;
  IF public.royal_shop_terms(i) IS DISTINCT FROM v.terms_snapshot THEN
    IF i.price::text IS DISTINCT FROM v.terms_snapshot->>'price' THEN RAISE EXCEPTION 'O preço mudou'; END IF;
    RAISE EXCEPTION 'Os termos do item mudaram';
  END IF;
  SELECT * INTO b FROM public.royal_buy_item(v.guild_id,v.user_id,v.item_id,req);
  UPDATE public.royal_shop_intentions s SET purchase_id=b.purchase_id WHERE s.nonce=v.nonce;
  SELECT * INTO q FROM public.royal_purchases x WHERE x.id=b.purchase_id;
  RETURN QUERY SELECT q.id,q.terms_snapshot->>'name',b.new_balance::text,q.status,
    q.terms_snapshot->>'reward_type',q.terms_snapshot->>'reward_value',false;
END $$;

-- A entrega usa os termos comprados, não o cadastro atual.
CREATE OR REPLACE FUNCTION public.royal_mark_purchase_delivered(p_guild_id text,p_purchase_id uuid,p_user_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  UPDATE public.royal_purchases q SET status='delivered'
   WHERE q.id=p_purchase_id AND q.guild_id=trim(p_guild_id) AND q.user_id=trim(p_user_id)
     AND q.terms_snapshot->>'reward_type'='role' AND q.status='pending';
  IF FOUND THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM public.royal_purchases q WHERE q.id=p_purchase_id AND q.guild_id=trim(p_guild_id)
    AND q.user_id=trim(p_user_id) AND q.terms_snapshot->>'reward_type'='role' AND q.status='delivered') THEN RETURN true; END IF;
  RAISE EXCEPTION 'Compra de cargo pendente não encontrada';
END $$;

REVOKE ALL ON FUNCTION public.royal_create_shop_intention(text,text,uuid,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.royal_confirm_shop_intention(text,text,uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.royal_shop_terms(public.royal_shop_items) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.royal_shop_intention_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.royal_shop_guard_item() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.royal_purchase_snapshot_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.royal_mark_purchase_delivered(text,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.royal_create_shop_intention(text,text,uuid,text),
  public.royal_confirm_shop_intention(text,text,uuid), public.royal_mark_purchase_delivered(text,uuid,text) TO service_role;

-- As assinaturas antigas continuam apenas para chamadas internas por funções
-- SECURITY DEFINER confiáveis, não como RPCs acessíveis ao backend. A compra
-- externa deve sempre consumir uma intenção. Não basta revogar de service_role:
-- também há privilégios de coluna, roles herdadas/SET ROLE e proprietários.
REVOKE ALL ON FUNCTION public.royal_buy_item(text,text,uuid,text),
  public.royal_buy_item_confirmed(text,text,uuid,text,bigint) FROM PUBLIC, anon, authenticated, service_role;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.royal_purchases FROM PUBLIC, anon, authenticated, service_role;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT c.relname, a.attname FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    WHERE n.nspname='public' AND c.relname IN ('royal_purchases','royal_shop_intentions')
  LOOP
    EXECUTE format('REVOKE INSERT (%I), UPDATE (%I) ON public.%I FROM PUBLIC, anon, authenticated, service_role', r.attname, r.attname, r.relname);
  END LOOP;
END $$;
DO $$
DECLARE r record; t record; a record;
BEGIN
  FOR r IN SELECT oid,rolname,rolsuper FROM pg_catalog.pg_roles
    WHERE pg_catalog.pg_has_role('service_role',oid,'MEMBER')
  LOOP
    IF r.rolsuper OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.proowner=r.oid AND p.oid IN
          ('public.royal_buy_item(text,text,uuid,text)'::regprocedure,
           'public.royal_buy_item_confirmed(text,text,uuid,text,bigint)'::regprocedure,
           'public.royal_create_shop_intention(text,text,uuid,text)'::regprocedure,
           'public.royal_confirm_shop_intention(text,text,uuid)'::regprocedure,
           'public.royal_shop_terms(public.royal_shop_items)'::regprocedure,
           'public.royal_shop_guard_item()'::regprocedure,
           'public.royal_purchase_snapshot_guard()'::regprocedure,
           'public.royal_shop_intention_guard()'::regprocedure)) OR
       has_function_privilege(r.oid,'public.royal_buy_item(text,text,uuid,text)','EXECUTE') OR
       has_function_privilege(r.oid,'public.royal_buy_item_confirmed(text,text,uuid,text,bigint)','EXECUTE') THEN
      RAISE EXCEPTION 'SHOP_LEGACY_PURCHASE_PRIVILEGE_UNSAFE: %',r.rolname;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname='royal_shop_items' AND c.relowner=r.oid) THEN
      RAISE EXCEPTION 'SHOP_DIRECT_PURCHASE_PRIVILEGE_UNSAFE: % royal_shop_items',r.rolname;
    END IF;
    FOR t IN SELECT c.oid,c.relname,c.relowner FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname IN ('royal_purchases','royal_shop_intentions')
    LOOP
      IF t.relowner=r.oid OR has_table_privilege(r.oid,t.oid,'INSERT') OR has_table_privilege(r.oid,t.oid,'UPDATE') OR
         has_table_privilege(r.oid,t.oid,'DELETE') OR has_table_privilege(r.oid,t.oid,'TRUNCATE') THEN
        RAISE EXCEPTION 'SHOP_DIRECT_PURCHASE_PRIVILEGE_UNSAFE: % %',r.rolname,t.relname;
      END IF;
      FOR a IN SELECT attnum FROM pg_catalog.pg_attribute WHERE attrelid=t.oid AND attnum>0 AND NOT attisdropped LOOP
        IF has_column_privilege(r.oid,t.oid,a.attnum,'INSERT') OR has_column_privilege(r.oid,t.oid,a.attnum,'UPDATE') THEN
          RAISE EXCEPTION 'SHOP_DIRECT_PURCHASE_PRIVILEGE_UNSAFE: % %',r.rolname,t.relname;
        END IF;
      END LOOP;
    END LOOP;
  END LOOP;
END $$;

COMMIT;
