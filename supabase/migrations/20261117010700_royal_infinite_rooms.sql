BEGIN;

CREATE TABLE IF NOT EXISTS public.royal_infinite_subscriptions (
  guild_id text NOT NULL,
  user_id text NOT NULL,
  premium_until timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.royal_infinite_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id text NOT NULL,
  user_id text NOT NULL,
  request_id text NOT NULL UNIQUE,
  plan text NOT NULL CHECK (plan IN ('semanal','mensal')),
  days integer NOT NULL,
  amount_cents integer NOT NULL,
  CHECK ((plan='semanal' AND days=7 AND amount_cents=500) OR (plan='mensal' AND days=30 AND amount_cents=1300)),
  payer_email text NOT NULL,
  status text NOT NULL DEFAULT 'creating'
    CHECK (status IN ('creating','pending','approved','rejected','cancelled','refunded','charged_back','manual_review','failed','expired')),
  mp_payment_id text UNIQUE,
  mp_status text,
  pix_copy_paste text,
  pix_qr_base64 text,
  ticket_url text,
  expires_at timestamptz,
  premium_until_after timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_royal_infinite_orders_owner
  ON public.royal_infinite_orders (guild_id, user_id, created_at DESC);

ALTER TABLE public.royal_room_usages
  ADD COLUMN IF NOT EXISTS credit_charged boolean NOT NULL DEFAULT true;

ALTER TABLE public.royal_infinite_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.royal_infinite_orders ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_role_full_access ON public.royal_infinite_subscriptions;
CREATE POLICY service_role_full_access ON public.royal_infinite_subscriptions
  FOR ALL TO service_role USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
DROP POLICY IF EXISTS service_role_full_access ON public.royal_infinite_orders;
CREATE POLICY service_role_full_access ON public.royal_infinite_orders
  FOR ALL TO service_role USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
REVOKE ALL ON public.royal_infinite_subscriptions, public.royal_infinite_orders FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.royal_infinite_subscriptions, public.royal_infinite_orders TO service_role;

CREATE OR REPLACE FUNCTION public.royal_infinite_create_order(
  p_guild_id text, p_user_id text, p_request_id text, p_plan text, p_payer_email text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_order public.royal_infinite_orders%ROWTYPE; v_days integer; v_amount integer; v_email text := lower(trim(COALESCE(p_payer_email,'')));
BEGIN
  IF COALESCE(trim(p_guild_id),'') = '' OR COALESCE(trim(p_user_id),'') = '' OR COALESCE(trim(p_request_id),'') = '' THEN RAISE EXCEPTION 'INFINITE_ORDER_IDENTITY_REQUIRED'; END IF;
  IF p_plan = 'semanal' THEN v_days := 7; v_amount := 500;
  ELSIF p_plan = 'mensal' THEN v_days := 30; v_amount := 1300;
  ELSE RAISE EXCEPTION 'INVALID_INFINITE_PLAN'; END IF;
  IF length(v_email) > 254 OR v_email !~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$' THEN RAISE EXCEPTION 'INVALID_PAYER_EMAIL'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('infinite-order:' || p_request_id, 0));
  SELECT * INTO v_order FROM public.royal_infinite_orders WHERE request_id = p_request_id FOR UPDATE;
  IF FOUND THEN
    IF v_order.guild_id <> p_guild_id OR v_order.user_id <> p_user_id OR v_order.plan <> p_plan OR v_order.payer_email <> v_email THEN
      RAISE EXCEPTION 'INFINITE_ORDER_REQUEST_REUSED_WITH_DIFFERENT_DATA';
    END IF;
    RETURN to_jsonb(v_order);
  END IF;
  INSERT INTO public.royal_infinite_orders (guild_id,user_id,request_id,plan,days,amount_cents,payer_email)
    VALUES (trim(p_guild_id),trim(p_user_id),trim(p_request_id),p_plan,v_days,v_amount,v_email) RETURNING * INTO v_order;
  RETURN to_jsonb(v_order);
END;
$$;

CREATE OR REPLACE FUNCTION public.royal_infinite_attach_payment(
  p_order_id uuid, p_payment_id text, p_qr_code text, p_qr_base64 text, p_ticket_url text, p_expires_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_order public.royal_infinite_orders%ROWTYPE;
BEGIN
  SELECT * INTO v_order FROM public.royal_infinite_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INFINITE_ORDER_NOT_FOUND'; END IF;
  IF COALESCE(trim(p_payment_id),'') = '' OR COALESCE(trim(p_qr_code),'') = '' THEN RAISE EXCEPTION 'INFINITE_PAYMENT_DATA_REQUIRED'; END IF;
  IF v_order.mp_payment_id IS NOT NULL AND v_order.mp_payment_id <> p_payment_id THEN RAISE EXCEPTION 'INFINITE_PAYMENT_ID_MISMATCH'; END IF;
  UPDATE public.royal_infinite_orders SET mp_payment_id=p_payment_id,pix_copy_paste=p_qr_code,pix_qr_base64=p_qr_base64,
    ticket_url=p_ticket_url,expires_at=p_expires_at,status=CASE WHEN status='creating' THEN 'pending' ELSE status END,
    mp_status=COALESCE(mp_status,'pending'),updated_at=now() WHERE id=p_order_id RETURNING * INTO v_order;
  RETURN to_jsonb(v_order);
END;
$$;

CREATE OR REPLACE FUNCTION public.royal_infinite_mark_failure(p_order_id uuid,p_status text,p_error_code text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_order public.royal_infinite_orders%ROWTYPE;
BEGIN
  IF p_status NOT IN ('failed','manual_review') THEN RAISE EXCEPTION 'INVALID_INFINITE_FAILURE_STATUS'; END IF;
  UPDATE public.royal_infinite_orders SET status=p_status,error_code=left(COALESCE(p_error_code,'unknown'),80),updated_at=now()
    WHERE id=p_order_id AND status<>'approved' RETURNING * INTO v_order;
  IF NOT FOUND THEN SELECT * INTO v_order FROM public.royal_infinite_orders WHERE id=p_order_id; END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'INFINITE_ORDER_NOT_FOUND'; END IF;
  RETURN to_jsonb(v_order);
END;
$$;

CREATE OR REPLACE FUNCTION public.royal_infinite_apply_payment(
  p_order_id uuid,p_payment_id text,p_status text,p_amount_cents bigint,p_currency text,p_external_reference text,p_payment_method text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_order public.royal_infinite_orders%ROWTYPE;
  v_status text := lower(trim(COALESCE(p_status,'')));
  v_subscription public.royal_infinite_subscriptions%ROWTYPE;
  v_reason text;
BEGIN
  SELECT * INTO v_order FROM public.royal_infinite_orders WHERE id=p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'INFINITE_ORDER_NOT_FOUND'; END IF;
  IF COALESCE(trim(p_payment_id),'') = '' THEN RAISE EXCEPTION 'INFINITE_PAYMENT_ID_REQUIRED'; END IF;
  IF EXISTS (SELECT 1 FROM public.royal_infinite_orders WHERE mp_payment_id=p_payment_id AND id<>p_order_id) THEN
    UPDATE public.royal_infinite_orders SET status='manual_review',mp_status=v_status,error_code='payment_id_already_linked',updated_at=now()
      WHERE id=p_order_id RETURNING * INTO v_order;
    RETURN to_jsonb(v_order);
  END IF;
  IF COALESCE(p_external_reference,'') <> v_order.id::text THEN v_reason := 'external_reference_mismatch';
  ELSIF COALESCE(upper(p_currency),'') <> 'BRL' THEN v_reason := 'currency_mismatch';
  ELSIF COALESCE(lower(p_payment_method),'') <> 'pix' THEN v_reason := 'payment_method_mismatch';
  ELSIF v_order.mp_payment_id IS NOT NULL AND v_order.mp_payment_id <> p_payment_id THEN v_reason := 'payment_id_mismatch';
  ELSIF v_status='approved' AND COALESCE(p_amount_cents,-1) <> v_order.amount_cents THEN v_reason := 'amount_mismatch';
  END IF;
  IF v_reason IS NOT NULL THEN
    UPDATE public.royal_infinite_orders SET status='manual_review',mp_payment_id=COALESCE(mp_payment_id,p_payment_id),
      mp_status=v_status,error_code=v_reason,updated_at=now() WHERE id=p_order_id RETURNING * INTO v_order;
    RETURN to_jsonb(v_order);
  END IF;
  IF v_status='approved' THEN
    IF v_order.status NOT IN ('approved','refunded','charged_back') THEN
      INSERT INTO public.royal_infinite_subscriptions (guild_id,user_id,premium_until)
        VALUES (v_order.guild_id,v_order.user_id,now()) ON CONFLICT (guild_id,user_id) DO NOTHING;
      SELECT * INTO v_subscription FROM public.royal_infinite_subscriptions
        WHERE guild_id=v_order.guild_id AND user_id=v_order.user_id FOR UPDATE;
      UPDATE public.royal_infinite_subscriptions SET premium_until=GREATEST(v_subscription.premium_until,now()) + make_interval(days => v_order.days),updated_at=now()
        WHERE guild_id=v_order.guild_id AND user_id=v_order.user_id RETURNING * INTO v_subscription;
      UPDATE public.royal_infinite_orders SET status='approved',mp_payment_id=p_payment_id,mp_status='approved',
        premium_until_after=v_subscription.premium_until,approved_at=COALESCE(approved_at,now()),error_code=NULL,updated_at=now()
        WHERE id=p_order_id RETURNING * INTO v_order;
    ELSE
      UPDATE public.royal_infinite_orders SET mp_status='approved',updated_at=now() WHERE id=p_order_id RETURNING * INTO v_order;
    END IF;
  ELSIF v_order.status<>'approved' THEN
    IF v_status NOT IN ('pending','in_process','rejected','cancelled','expired','refunded','charged_back') THEN v_status := 'pending'; END IF;
    IF v_status IN ('refunded','charged_back') THEN
      UPDATE public.royal_infinite_orders SET status='manual_review',mp_payment_id=COALESCE(mp_payment_id,p_payment_id),mp_status=v_status,
        error_code='refund_requires_manual_review',updated_at=now() WHERE id=p_order_id RETURNING * INTO v_order;
    ELSE
      UPDATE public.royal_infinite_orders SET status=v_status,mp_payment_id=COALESCE(mp_payment_id,p_payment_id),mp_status=v_status,updated_at=now()
        WHERE id=p_order_id RETURNING * INTO v_order;
    END IF;
  END IF;
  RETURN to_jsonb(v_order);
END;
$$;

CREATE OR REPLACE FUNCTION public.royal_infinite_subscription(p_guild_id text,p_user_id text)
RETURNS timestamptz LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT premium_until FROM public.royal_infinite_subscriptions WHERE guild_id=p_guild_id AND user_id=p_user_id
$$;

CREATE OR REPLACE FUNCTION public.royal_room_reserve_room(
  p_guild_id text,p_user_id text,p_request_id text,p_source text,p_source_ref text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_wallet public.royal_room_wallets%ROWTYPE;
  v_usage public.royal_room_usages%ROWTYPE;
  v_premium_until timestamptz;
  v_premium boolean := false;
BEGIN
  IF COALESCE(trim(p_guild_id),'')='' OR COALESCE(trim(p_user_id),'')='' OR COALESCE(trim(p_request_id),'')='' THEN RAISE EXCEPTION 'ROOM_USAGE_IDENTITY_REQUIRED'; END IF;
  IF p_source NOT IN ('nix_command','match') OR (p_source='match' AND COALESCE(trim(p_source_ref),'')='') THEN RAISE EXCEPTION 'INVALID_ROOM_USAGE_SOURCE'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('room-wallet:'||p_guild_id||':'||p_user_id,0));
  SELECT * INTO v_usage FROM public.royal_room_usages WHERE request_id=p_request_id FOR UPDATE;
  IF FOUND THEN RAISE EXCEPTION 'ROOM_USAGE_REQUEST_ALREADY_EXISTS'; END IF;
  IF p_source='match' THEN
    SELECT * INTO v_usage FROM public.royal_room_usages WHERE guild_id=p_guild_id AND source='match' AND source_ref=p_source_ref
      AND status IN ('reserved','unknown','created') FOR UPDATE;
    IF FOUND THEN
      IF v_usage.status='created' THEN RAISE EXCEPTION 'ROOM_ALREADY_CREATED'; END IF;
      RAISE EXCEPTION 'ROOM_CREATION_PENDING';
    END IF;
  END IF;
  SELECT premium_until INTO v_premium_until FROM public.royal_infinite_subscriptions
    WHERE guild_id=p_guild_id AND user_id=p_user_id;
  v_premium := COALESCE(v_premium_until > now(),false);
  INSERT INTO public.royal_room_wallets (guild_id,user_id) VALUES (p_guild_id,p_user_id) ON CONFLICT (guild_id,user_id) DO NOTHING;
  SELECT * INTO v_wallet FROM public.royal_room_wallets WHERE guild_id=p_guild_id AND user_id=p_user_id FOR UPDATE;
  IF NOT v_premium AND v_wallet.purchased_rooms-v_wallet.reserved_rooms-v_wallet.consumed_rooms-v_wallet.reversed_rooms < 1 THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROOM_CREDITS';
  END IF;
  INSERT INTO public.royal_room_usages (guild_id,user_id,request_id,source,source_ref,status,credit_charged)
    VALUES (p_guild_id,p_user_id,p_request_id,p_source,p_source_ref,'reserved',NOT v_premium) RETURNING * INTO v_usage;
  IF NOT v_premium THEN
    UPDATE public.royal_room_wallets SET reserved_rooms=reserved_rooms+1,updated_at=now()
      WHERE guild_id=p_guild_id AND user_id=p_user_id RETURNING * INTO v_wallet;
  END IF;
  INSERT INTO public.royal_room_ledger (guild_id,user_id,request_id,event_type,delta_rooms,usage_id,detail)
    VALUES (p_guild_id,p_user_id,'reserve:'||p_request_id,'reserved',0,v_usage.id,
      jsonb_build_object('source',p_source,'source_ref',p_source_ref,'premium',v_premium,'premium_until',v_premium_until));
  RETURN jsonb_build_object('usage',to_jsonb(v_usage),'available_rooms',v_wallet.purchased_rooms-v_wallet.reserved_rooms-v_wallet.consumed_rooms-v_wallet.reversed_rooms,
    'unlimited_rooms',v_premium,'premium_until',v_premium_until);
END;
$$;

CREATE OR REPLACE FUNCTION public.royal_room_settle_room(
  p_request_id text,p_status text,p_room_id text DEFAULT NULL,p_session_id text DEFAULT NULL,p_error_code text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_usage public.royal_room_usages%ROWTYPE;
BEGIN
  IF p_status NOT IN ('created','failed','unknown') THEN RAISE EXCEPTION 'INVALID_ROOM_SETTLEMENT_STATUS'; END IF;
  SELECT * INTO v_usage FROM public.royal_room_usages WHERE request_id=p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ROOM_USAGE_NOT_FOUND'; END IF;
  IF v_usage.status IN ('created','failed') THEN RETURN to_jsonb(v_usage); END IF;
  IF p_status='unknown' THEN
    UPDATE public.royal_room_usages SET status='unknown',error_code=left(COALESCE(p_error_code,'unknown'),80),updated_at=now()
      WHERE request_id=p_request_id RETURNING * INTO v_usage;
    RETURN to_jsonb(v_usage);
  END IF;
  IF v_usage.credit_charged THEN
    UPDATE public.royal_room_wallets SET reserved_rooms=GREATEST(0,reserved_rooms-1),
      consumed_rooms=consumed_rooms+CASE WHEN p_status='created' THEN 1 ELSE 0 END,updated_at=now()
      WHERE guild_id=v_usage.guild_id AND user_id=v_usage.user_id;
  END IF;
  UPDATE public.royal_room_usages SET status=p_status,room_id=COALESCE(p_room_id,room_id),session_id=COALESCE(p_session_id,session_id),
    error_code=left(COALESCE(p_error_code,''),80),settled_at=now(),updated_at=now()
    WHERE request_id=p_request_id RETURNING * INTO v_usage;
  INSERT INTO public.royal_room_ledger (guild_id,user_id,request_id,event_type,delta_rooms,usage_id,detail)
    VALUES (v_usage.guild_id,v_usage.user_id,CASE WHEN p_status='created' THEN 'created:' ELSE 'released:' END||p_request_id,
      CASE WHEN p_status='created' THEN 'created' ELSE 'released' END,
      CASE WHEN p_status='created' AND v_usage.credit_charged THEN -1 ELSE 0 END,v_usage.id,
      jsonb_build_object('room_id',v_usage.room_id,'session_id',v_usage.session_id,'error_code',v_usage.error_code,'credit_charged',v_usage.credit_charged))
    ON CONFLICT (request_id) DO NOTHING;
  RETURN to_jsonb(v_usage);
END;
$$;

REVOKE ALL ON FUNCTION public.royal_infinite_create_order(text,text,text,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.royal_infinite_attach_payment(uuid,text,text,text,text,timestamptz) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.royal_infinite_mark_failure(uuid,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.royal_infinite_apply_payment(uuid,text,text,bigint,text,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.royal_infinite_subscription(text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.royal_room_reserve_room(text,text,text,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.royal_room_settle_room(text,text,text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.royal_infinite_create_order(text,text,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.royal_infinite_attach_payment(uuid,text,text,text,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.royal_infinite_mark_failure(uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.royal_infinite_apply_payment(uuid,text,text,bigint,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.royal_infinite_subscription(text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.royal_room_reserve_room(text,text,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.royal_room_settle_room(text,text,text,text,text) TO service_role;

COMMIT;
