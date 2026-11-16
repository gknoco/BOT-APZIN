BEGIN;

CREATE TABLE IF NOT EXISTS public.royal_room_purchase_settings (
  guild_id text PRIMARY KEY,
  allowed_role_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(allowed_role_ids) = 'array'),
  panel_channel_id text,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.royal_room_coupons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id text NOT NULL,
  code text NOT NULL,
  discount_percent smallint NOT NULL CHECK (discount_percent BETWEEN 1 AND 99),
  active boolean NOT NULL DEFAULT true,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (guild_id, code)
);

CREATE TABLE IF NOT EXISTS public.royal_room_purchase_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id text NOT NULL,
  user_id text NOT NULL,
  request_id text NOT NULL UNIQUE,
  rooms_quantity integer NOT NULL CHECK (rooms_quantity BETWEEN 1 AND 1000),
  unit_price_cents integer NOT NULL DEFAULT 3 CHECK (unit_price_cents = 3),
  gross_amount_cents integer NOT NULL CHECK (gross_amount_cents > 0),
  discount_cents integer NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  coupon_id uuid REFERENCES public.royal_room_coupons(id),
  coupon_code text,
  payer_email text NOT NULL,
  status text NOT NULL DEFAULT 'creating'
    CHECK (status IN ('creating', 'pending', 'approved', 'rejected', 'cancelled', 'refunded', 'charged_back', 'manual_review', 'failed', 'expired')),
  mp_payment_id text UNIQUE,
  mp_status text,
  pix_copy_paste text,
  pix_qr_base64 text,
  ticket_url text,
  expires_at timestamptz,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_royal_room_orders_guild_user
  ON public.royal_room_purchase_orders (guild_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_royal_room_orders_status
  ON public.royal_room_purchase_orders (status, created_at);

CREATE TABLE IF NOT EXISTS public.royal_room_coupon_uses (
  order_id uuid PRIMARY KEY REFERENCES public.royal_room_purchase_orders(id),
  coupon_id uuid NOT NULL REFERENCES public.royal_room_coupons(id),
  guild_id text NOT NULL,
  user_id text NOT NULL,
  discount_cents integer NOT NULL CHECK (discount_cents >= 0),
  used_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.royal_room_wallets (
  guild_id text NOT NULL,
  user_id text NOT NULL,
  purchased_rooms bigint NOT NULL DEFAULT 0 CHECK (purchased_rooms >= 0),
  reserved_rooms bigint NOT NULL DEFAULT 0 CHECK (reserved_rooms >= 0),
  consumed_rooms bigint NOT NULL DEFAULT 0 CHECK (consumed_rooms >= 0),
  reversed_rooms bigint NOT NULL DEFAULT 0 CHECK (reversed_rooms >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.royal_room_usages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id text NOT NULL,
  user_id text NOT NULL,
  request_id text NOT NULL UNIQUE,
  source text NOT NULL CHECK (source IN ('nix_command', 'match')),
  source_ref text,
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved', 'unknown', 'created', 'failed')),
  room_id text,
  session_id text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
DROP INDEX IF EXISTS public.idx_royal_room_usage_match_once;
CREATE UNIQUE INDEX idx_royal_room_usage_match_once
  ON public.royal_room_usages (guild_id, source_ref)
  WHERE source = 'match' AND source_ref IS NOT NULL AND status IN ('reserved', 'unknown', 'created');
CREATE INDEX IF NOT EXISTS idx_royal_room_usage_stats
  ON public.royal_room_usages (guild_id, user_id, status, settled_at DESC);

CREATE TABLE IF NOT EXISTS public.royal_room_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id text NOT NULL,
  user_id text NOT NULL,
  request_id text NOT NULL UNIQUE,
  event_type text NOT NULL CHECK (event_type IN ('purchase', 'reserved', 'created', 'released', 'reversed')),
  delta_rooms bigint NOT NULL,
  order_id uuid REFERENCES public.royal_room_purchase_orders(id),
  usage_id uuid REFERENCES public.royal_room_usages(id),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_royal_room_ledger_wallet
  ON public.royal_room_ledger (guild_id, user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.royal_room_mp_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_key text NOT NULL UNIQUE,
  payment_id text NOT NULL,
  action text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'processed')),
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_royal_room_mp_events_ready
  ON public.royal_room_mp_webhook_events (status, available_at, lease_until, created_at);

CREATE OR REPLACE FUNCTION public.royal_room_set_purchase_settings(
  p_guild_id text,
  p_role_ids jsonb,
  p_panel_channel_id text,
  p_actor_id text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_roles jsonb := COALESCE(p_role_ids, '[]'::jsonb); v_row public.royal_room_purchase_settings%ROWTYPE;
BEGIN
  IF COALESCE(trim(p_guild_id), '') = '' OR jsonb_typeof(v_roles) <> 'array' OR jsonb_array_length(v_roles) > 10 THEN
    RAISE EXCEPTION 'INVALID_PURCHASE_SETTINGS';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_roles) AS r(value) WHERE r.value !~ '^[0-9]{17,20}$') THEN
    RAISE EXCEPTION 'INVALID_PURCHASE_ROLE_ID';
  END IF;
  IF p_panel_channel_id IS NOT NULL AND p_panel_channel_id !~ '^[0-9]{17,20}$' THEN
    RAISE EXCEPTION 'INVALID_PURCHASE_CHANNEL_ID';
  END IF;
  INSERT INTO public.royal_room_purchase_settings (guild_id, allowed_role_ids, panel_channel_id, updated_by, updated_at)
  VALUES (p_guild_id, v_roles, p_panel_channel_id, p_actor_id, now())
  ON CONFLICT (guild_id) DO UPDATE SET allowed_role_ids = EXCLUDED.allowed_role_ids,
    panel_channel_id = EXCLUDED.panel_channel_id, updated_by = EXCLUDED.updated_by, updated_at = now()
  RETURNING * INTO v_row;
  RETURN to_jsonb(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.royal_room_upsert_coupon(
  p_guild_id text,
  p_code text,
  p_discount_percent smallint,
  p_active boolean,
  p_actor_id text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_code text := upper(trim(COALESCE(p_code, ''))); v_row public.royal_room_coupons%ROWTYPE;
BEGIN
  IF COALESCE(trim(p_guild_id), '') = '' OR v_code !~ '^[A-Z0-9_-]{3,32}$' THEN RAISE EXCEPTION 'INVALID_COUPON_CODE'; END IF;
  IF p_active AND (p_discount_percent IS NULL OR p_discount_percent < 1 OR p_discount_percent > 99) THEN RAISE EXCEPTION 'INVALID_COUPON_PERCENT'; END IF;
  IF NOT p_active THEN
    UPDATE public.royal_room_coupons SET active = false, updated_at = now()
      WHERE guild_id = p_guild_id AND code = v_code RETURNING * INTO v_row;
    IF NOT FOUND THEN RAISE EXCEPTION 'COUPON_NOT_FOUND'; END IF;
  ELSE
    INSERT INTO public.royal_room_coupons (guild_id, code, discount_percent, active, created_by)
    VALUES (p_guild_id, v_code, p_discount_percent, true, p_actor_id)
    ON CONFLICT (guild_id, code) DO UPDATE SET discount_percent = EXCLUDED.discount_percent,
      active = true, created_by = EXCLUDED.created_by, updated_at = now()
    RETURNING * INTO v_row;
  END IF;
  RETURN to_jsonb(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.royal_room_create_purchase(
  p_guild_id text,
  p_user_id text,
  p_request_id text,
  p_rooms_quantity integer,
  p_coupon_code text,
  p_payer_email text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_existing public.royal_room_purchase_orders%ROWTYPE;
  v_coupon public.royal_room_coupons%ROWTYPE;
  v_order public.royal_room_purchase_orders%ROWTYPE;
  v_code text := upper(trim(COALESCE(p_coupon_code, '')));
  v_gross integer; v_discount integer := 0; v_percent integer := 0;
  v_email text := lower(trim(COALESCE(p_payer_email, '')));
BEGIN
  IF COALESCE(trim(p_guild_id), '') = '' OR COALESCE(trim(p_user_id), '') = '' OR COALESCE(trim(p_request_id), '') = '' THEN
    RAISE EXCEPTION 'PURCHASE_IDENTITY_REQUIRED';
  END IF;
  IF p_rooms_quantity IS NULL OR p_rooms_quantity < 1 OR p_rooms_quantity > 1000 THEN RAISE EXCEPTION 'INVALID_ROOM_QUANTITY'; END IF;
  IF length(v_email) > 254 OR v_email !~* '^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$' THEN RAISE EXCEPTION 'INVALID_PAYER_EMAIL'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('room-purchase:' || p_request_id, 0));
  SELECT * INTO v_existing FROM public.royal_room_purchase_orders WHERE request_id = p_request_id FOR UPDATE;
  IF FOUND THEN
    IF v_existing.guild_id <> p_guild_id OR v_existing.user_id <> p_user_id OR
       v_existing.rooms_quantity <> p_rooms_quantity OR v_existing.payer_email <> v_email OR
       COALESCE(v_existing.coupon_code, '') <> v_code THEN
      RAISE EXCEPTION 'PURCHASE_REQUEST_REUSED_WITH_DIFFERENT_DATA';
    END IF;
    RETURN to_jsonb(v_existing);
  END IF;
  v_gross := p_rooms_quantity * 3;
  IF v_code <> '' THEN
    SELECT * INTO v_coupon FROM public.royal_room_coupons
      WHERE guild_id = p_guild_id AND code = v_code AND active = true FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'COUPON_INVALID'; END IF;
    v_percent := v_coupon.discount_percent;
    v_discount := LEAST(round(v_gross * v_percent / 100.0)::integer, v_gross - 1);
  END IF;
  INSERT INTO public.royal_room_purchase_orders (
    guild_id, user_id, request_id, rooms_quantity, unit_price_cents, gross_amount_cents,
    discount_cents, amount_cents, coupon_id, coupon_code, payer_email, status
  ) VALUES (
    p_guild_id, p_user_id, p_request_id, p_rooms_quantity, 3, v_gross,
    v_discount, v_gross - v_discount, CASE WHEN v_code = '' THEN NULL ELSE v_coupon.id END,
    CASE WHEN v_code = '' THEN NULL ELSE v_code END, v_email, 'creating'
  ) RETURNING * INTO v_order;
  RETURN to_jsonb(v_order);
END;
$$;

CREATE OR REPLACE FUNCTION public.royal_room_attach_payment(
  p_order_id uuid,
  p_payment_id text,
  p_qr_code text,
  p_qr_base64 text,
  p_ticket_url text,
  p_expires_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_order public.royal_room_purchase_orders%ROWTYPE;
BEGIN
  SELECT * INTO v_order FROM public.royal_room_purchase_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PURCHASE_NOT_FOUND'; END IF;
  IF COALESCE(trim(p_payment_id), '') = '' OR COALESCE(trim(p_qr_code), '') = '' THEN RAISE EXCEPTION 'PAYMENT_DATA_REQUIRED'; END IF;
  IF v_order.mp_payment_id IS NOT NULL AND v_order.mp_payment_id <> p_payment_id THEN RAISE EXCEPTION 'PAYMENT_ID_MISMATCH'; END IF;
  UPDATE public.royal_room_purchase_orders SET
    mp_payment_id = p_payment_id,
    pix_copy_paste = p_qr_code,
    pix_qr_base64 = p_qr_base64,
    ticket_url = p_ticket_url,
    expires_at = p_expires_at,
    status = CASE WHEN status = 'creating' THEN 'pending' ELSE status END,
    mp_status = COALESCE(mp_status, 'pending'),
    updated_at = now()
  WHERE id = p_order_id RETURNING * INTO v_order;
  RETURN to_jsonb(v_order);
END;
$$;

CREATE OR REPLACE FUNCTION public.royal_room_mark_purchase_failure(
  p_order_id uuid,
  p_status text,
  p_error_code text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_order public.royal_room_purchase_orders%ROWTYPE;
BEGIN
  IF p_status NOT IN ('failed', 'manual_review') THEN RAISE EXCEPTION 'INVALID_PURCHASE_FAILURE_STATUS'; END IF;
  UPDATE public.royal_room_purchase_orders SET status = p_status, error_code = left(COALESCE(p_error_code, 'unknown'), 80), updated_at = now()
    WHERE id = p_order_id AND status <> 'approved' RETURNING * INTO v_order;
  IF NOT FOUND THEN SELECT * INTO v_order FROM public.royal_room_purchase_orders WHERE id = p_order_id; END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'PURCHASE_NOT_FOUND'; END IF;
  RETURN to_jsonb(v_order);
END;
$$;

CREATE OR REPLACE FUNCTION public.royal_room_apply_payment(
  p_order_id uuid,
  p_payment_id text,
  p_status text,
  p_amount_cents bigint,
  p_currency text,
  p_external_reference text,
  p_refunded_cents bigint DEFAULT 0,
  p_manual_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_order public.royal_room_purchase_orders%ROWTYPE; v_status text := lower(trim(COALESCE(p_status, '')));
BEGIN
  SELECT * INTO v_order FROM public.royal_room_purchase_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PURCHASE_NOT_FOUND'; END IF;
  IF COALESCE(trim(p_payment_id), '') = '' THEN RAISE EXCEPTION 'PAYMENT_ID_REQUIRED'; END IF;
  IF EXISTS (SELECT 1 FROM public.royal_room_purchase_orders WHERE mp_payment_id = p_payment_id AND id <> p_order_id) THEN
    UPDATE public.royal_room_purchase_orders SET status = 'manual_review', mp_status = v_status,
      error_code = 'payment_id_already_linked', updated_at = now()
      WHERE id = p_order_id RETURNING * INTO v_order;
    RETURN to_jsonb(v_order);
  END IF;
  IF COALESCE(v_order.mp_payment_id, p_payment_id) <> p_payment_id OR
     COALESCE(p_external_reference, '') <> v_order.id::text OR COALESCE(upper(p_currency), '') <> 'BRL' THEN
    UPDATE public.royal_room_purchase_orders SET status = 'manual_review', mp_payment_id = COALESCE(mp_payment_id, p_payment_id),
      mp_status = v_status, error_code = 'payment_reference_currency_mismatch', updated_at = now()
      WHERE id = p_order_id RETURNING * INTO v_order;
    RETURN to_jsonb(v_order);
  END IF;
  IF v_status = 'approved' AND COALESCE(p_amount_cents, -1) <> v_order.amount_cents THEN
    UPDATE public.royal_room_purchase_orders SET status = 'manual_review', mp_payment_id = COALESCE(mp_payment_id, p_payment_id),
      mp_status = v_status, error_code = 'payment_amount_mismatch', updated_at = now()
      WHERE id = p_order_id RETURNING * INTO v_order;
    RETURN to_jsonb(v_order);
  END IF;
  IF v_status = 'manual_review' THEN
    UPDATE public.royal_room_purchase_orders SET status = 'manual_review', mp_payment_id = COALESCE(mp_payment_id, p_payment_id),
      mp_status = v_status, error_code = left(COALESCE(p_manual_reason, 'payment_requires_review'), 80), updated_at = now()
      WHERE id = p_order_id RETURNING * INTO v_order;
    RETURN to_jsonb(v_order);
  END IF;
  IF v_order.status = 'manual_review' AND v_status = 'approved' THEN
    RETURN to_jsonb(v_order);
  END IF;
  IF v_status = 'approved' THEN
    IF v_order.status IN ('refunded', 'charged_back') THEN RETURN to_jsonb(v_order); END IF;
    IF v_order.status <> 'approved' THEN
      INSERT INTO public.royal_room_wallets (guild_id, user_id, purchased_rooms, updated_at)
        VALUES (v_order.guild_id, v_order.user_id, v_order.rooms_quantity, now())
        ON CONFLICT (guild_id, user_id) DO UPDATE SET purchased_rooms = public.royal_room_wallets.purchased_rooms + EXCLUDED.purchased_rooms, updated_at = now();
      INSERT INTO public.royal_room_ledger (guild_id, user_id, request_id, event_type, delta_rooms, order_id, detail)
        VALUES (v_order.guild_id, v_order.user_id, 'purchase:' || v_order.id::text, 'purchase', v_order.rooms_quantity, v_order.id,
          jsonb_build_object('payment_id', p_payment_id, 'amount_cents', v_order.amount_cents))
        ON CONFLICT (request_id) DO NOTHING;
      IF v_order.coupon_id IS NOT NULL THEN
        INSERT INTO public.royal_room_coupon_uses (order_id, coupon_id, guild_id, user_id, discount_cents)
          VALUES (v_order.id, v_order.coupon_id, v_order.guild_id, v_order.user_id, v_order.discount_cents)
          ON CONFLICT (order_id) DO NOTHING;
      END IF;
      UPDATE public.royal_room_purchase_orders SET status = 'approved', mp_payment_id = p_payment_id, mp_status = v_status,
        approved_at = now(), error_code = NULL, updated_at = now() WHERE id = p_order_id RETURNING * INTO v_order;
    ELSE
      UPDATE public.royal_room_purchase_orders SET mp_status = v_status, updated_at = now() WHERE id = p_order_id RETURNING * INTO v_order;
    END IF;
    RETURN to_jsonb(v_order);
  END IF;

  IF v_status IN ('refunded', 'charged_back') THEN
    IF v_order.status IN ('approved', 'manual_review') AND EXISTS (
      SELECT 1 FROM public.royal_room_ledger WHERE request_id = 'purchase:' || v_order.id::text
    ) THEN
      IF v_status = 'charged_back' OR COALESCE(p_refunded_cents, 0) >= v_order.amount_cents THEN
        IF NOT EXISTS (SELECT 1 FROM public.royal_room_ledger WHERE request_id = 'reversal:' || v_order.id::text) THEN
          INSERT INTO public.royal_room_wallets (guild_id, user_id, reversed_rooms, updated_at)
            VALUES (v_order.guild_id, v_order.user_id, v_order.rooms_quantity, now())
            ON CONFLICT (guild_id, user_id) DO UPDATE SET reversed_rooms = public.royal_room_wallets.reversed_rooms + EXCLUDED.reversed_rooms, updated_at = now();
          INSERT INTO public.royal_room_ledger (guild_id, user_id, request_id, event_type, delta_rooms, order_id, detail)
            VALUES (v_order.guild_id, v_order.user_id, 'reversal:' || v_order.id::text, 'reversed', -v_order.rooms_quantity, v_order.id,
              jsonb_build_object('payment_id', p_payment_id, 'provider_status', v_status))
            ON CONFLICT (request_id) DO NOTHING;
        END IF;
        UPDATE public.royal_room_purchase_orders SET status = v_status, mp_status = v_status, updated_at = now()
          WHERE id = p_order_id RETURNING * INTO v_order;
      ELSE
        UPDATE public.royal_room_purchase_orders SET status = 'manual_review', mp_status = v_status,
          error_code = 'partial_refund_requires_review', updated_at = now() WHERE id = p_order_id RETURNING * INTO v_order;
      END IF;
    ELSIF v_order.status NOT IN ('refunded', 'charged_back') THEN
      UPDATE public.royal_room_purchase_orders SET status = v_status, mp_status = v_status, updated_at = now()
        WHERE id = p_order_id RETURNING * INTO v_order;
    END IF;
    RETURN to_jsonb(v_order);
  END IF;

  IF v_order.status = 'manual_review' AND v_status <> 'approved' THEN
    RETURN to_jsonb(v_order);
  END IF;

  IF v_order.status NOT IN ('approved', 'refunded', 'charged_back') THEN
    IF v_status NOT IN ('pending', 'in_process', 'rejected', 'cancelled', 'expired') THEN v_status := 'pending'; END IF;
    UPDATE public.royal_room_purchase_orders SET status = v_status, mp_payment_id = COALESCE(mp_payment_id, p_payment_id),
      mp_status = v_status, updated_at = now() WHERE id = p_order_id RETURNING * INTO v_order;
  END IF;
  RETURN to_jsonb(v_order);
END;
$$;

CREATE OR REPLACE FUNCTION public.royal_room_reserve_room(
  p_guild_id text,
  p_user_id text,
  p_request_id text,
  p_source text,
  p_source_ref text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_wallet public.royal_room_wallets%ROWTYPE; v_usage public.royal_room_usages%ROWTYPE;
BEGIN
  IF COALESCE(trim(p_guild_id), '') = '' OR COALESCE(trim(p_user_id), '') = '' OR COALESCE(trim(p_request_id), '') = '' THEN RAISE EXCEPTION 'ROOM_USAGE_IDENTITY_REQUIRED'; END IF;
  IF p_source NOT IN ('nix_command', 'match') OR (p_source = 'match' AND COALESCE(trim(p_source_ref), '') = '') THEN RAISE EXCEPTION 'INVALID_ROOM_USAGE_SOURCE'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('room-wallet:' || p_guild_id || ':' || p_user_id, 0));
  SELECT * INTO v_usage FROM public.royal_room_usages WHERE request_id = p_request_id FOR UPDATE;
  IF FOUND THEN RAISE EXCEPTION 'ROOM_USAGE_REQUEST_ALREADY_EXISTS'; END IF;
  IF p_source = 'match' THEN
    SELECT * INTO v_usage FROM public.royal_room_usages
      WHERE guild_id = p_guild_id AND source = 'match' AND source_ref = p_source_ref
        AND status IN ('reserved', 'unknown', 'created') FOR UPDATE;
    IF FOUND THEN
      IF v_usage.status = 'created' THEN RAISE EXCEPTION 'ROOM_ALREADY_CREATED'; END IF;
      RAISE EXCEPTION 'ROOM_CREATION_PENDING';
    END IF;
  END IF;
  INSERT INTO public.royal_room_wallets (guild_id, user_id) VALUES (p_guild_id, p_user_id)
    ON CONFLICT (guild_id, user_id) DO NOTHING;
  SELECT * INTO v_wallet FROM public.royal_room_wallets WHERE guild_id = p_guild_id AND user_id = p_user_id FOR UPDATE;
  IF v_wallet.purchased_rooms - v_wallet.reserved_rooms - v_wallet.consumed_rooms - v_wallet.reversed_rooms < 1 THEN RAISE EXCEPTION 'INSUFFICIENT_ROOM_CREDITS'; END IF;
  INSERT INTO public.royal_room_usages (guild_id, user_id, request_id, source, source_ref, status)
    VALUES (p_guild_id, p_user_id, p_request_id, p_source, p_source_ref, 'reserved') RETURNING * INTO v_usage;
  UPDATE public.royal_room_wallets SET reserved_rooms = reserved_rooms + 1, updated_at = now()
    WHERE guild_id = p_guild_id AND user_id = p_user_id RETURNING * INTO v_wallet;
  INSERT INTO public.royal_room_ledger (guild_id, user_id, request_id, event_type, delta_rooms, usage_id, detail)
    VALUES (p_guild_id, p_user_id, 'reserve:' || p_request_id, 'reserved', 0, v_usage.id,
      jsonb_build_object('source', p_source, 'source_ref', p_source_ref));
  RETURN jsonb_build_object('usage', to_jsonb(v_usage), 'available_rooms', v_wallet.purchased_rooms - v_wallet.reserved_rooms - v_wallet.consumed_rooms - v_wallet.reversed_rooms);
END;
$$;

CREATE OR REPLACE FUNCTION public.royal_room_settle_room(
  p_request_id text,
  p_status text,
  p_room_id text DEFAULT NULL,
  p_session_id text DEFAULT NULL,
  p_error_code text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_usage public.royal_room_usages%ROWTYPE;
BEGIN
  IF p_status NOT IN ('created', 'failed', 'unknown') THEN RAISE EXCEPTION 'INVALID_ROOM_SETTLEMENT_STATUS'; END IF;
  SELECT * INTO v_usage FROM public.royal_room_usages WHERE request_id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ROOM_USAGE_NOT_FOUND'; END IF;
  IF v_usage.status IN ('created', 'failed') THEN RETURN to_jsonb(v_usage); END IF;
  IF p_status = 'unknown' THEN
    UPDATE public.royal_room_usages SET status = 'unknown', error_code = left(COALESCE(p_error_code, 'unknown'), 80), updated_at = now()
      WHERE request_id = p_request_id RETURNING * INTO v_usage;
    RETURN to_jsonb(v_usage);
  END IF;
  UPDATE public.royal_room_wallets SET
    reserved_rooms = GREATEST(0, reserved_rooms - 1),
    consumed_rooms = consumed_rooms + CASE WHEN p_status = 'created' THEN 1 ELSE 0 END,
    updated_at = now()
  WHERE guild_id = v_usage.guild_id AND user_id = v_usage.user_id;
  UPDATE public.royal_room_usages SET status = p_status, room_id = COALESCE(p_room_id, room_id),
    session_id = COALESCE(p_session_id, session_id), error_code = left(COALESCE(p_error_code, ''), 80),
    settled_at = now(), updated_at = now() WHERE request_id = p_request_id RETURNING * INTO v_usage;
  INSERT INTO public.royal_room_ledger (guild_id, user_id, request_id, event_type, delta_rooms, usage_id, detail)
    VALUES (v_usage.guild_id, v_usage.user_id,
      CASE WHEN p_status = 'created' THEN 'created:' ELSE 'released:' END || p_request_id,
      CASE WHEN p_status = 'created' THEN 'created' ELSE 'released' END,
      CASE WHEN p_status = 'created' THEN -1 ELSE 0 END, v_usage.id,
      jsonb_build_object('room_id', v_usage.room_id, 'session_id', v_usage.session_id, 'error_code', v_usage.error_code))
    ON CONFLICT (request_id) DO NOTHING;
  RETURN to_jsonb(v_usage);
END;
$$;

CREATE OR REPLACE FUNCTION public.royal_room_resolve_usage(
  p_request_id text,
  p_outcome text,
  p_actor_id text,
  p_room_id text DEFAULT NULL,
  p_session_id text DEFAULT NULL,
  p_note text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_usage public.royal_room_usages%ROWTYPE;
BEGIN
  IF p_outcome NOT IN ('created', 'failed') THEN RAISE EXCEPTION 'INVALID_ROOM_RESOLUTION'; END IF;
  SELECT * INTO v_usage FROM public.royal_room_usages WHERE request_id = p_request_id FOR UPDATE;
  IF NOT FOUND OR v_usage.status NOT IN ('reserved', 'unknown') THEN RAISE EXCEPTION 'ROOM_USAGE_NOT_RECONCILABLE'; END IF;
  SELECT * INTO v_usage FROM jsonb_populate_record(NULL::public.royal_room_usages,
    public.royal_room_settle_room(p_request_id, p_outcome, p_room_id, p_session_id, 'manual_reconciliation'));
  INSERT INTO public.royal_audit_events (guild_id, actor_id, action, entity_type, entity_id, request_id, detail)
    VALUES (v_usage.guild_id, p_actor_id, 'room.usage.reconciled', 'room_usage', v_usage.id::text, p_request_id, left(COALESCE(p_note, p_outcome), 300));
  RETURN to_jsonb(v_usage);
END;
$$;

CREATE OR REPLACE FUNCTION public.royal_room_stats(p_guild_id text, p_user_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_wallet public.royal_room_wallets%ROWTYPE; v_today timestamptz; v_today_count bigint; v_total bigint; v_orders bigint; v_pending jsonb;
BEGIN
  SELECT * INTO v_wallet FROM public.royal_room_wallets WHERE guild_id = p_guild_id AND user_id = p_user_id;
  IF NOT FOUND THEN
    v_wallet.purchased_rooms := 0; v_wallet.reserved_rooms := 0; v_wallet.consumed_rooms := 0; v_wallet.reversed_rooms := 0;
  END IF;
  v_today := date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo';
  SELECT count(*) INTO v_today_count FROM public.royal_room_usages
    WHERE guild_id = p_guild_id AND user_id = p_user_id AND status = 'created' AND settled_at >= v_today;
  SELECT count(*) INTO v_total FROM public.royal_room_usages
    WHERE guild_id = p_guild_id AND user_id = p_user_id AND status = 'created';
  SELECT count(*) INTO v_orders FROM public.royal_room_purchase_orders
    WHERE guild_id = p_guild_id AND user_id = p_user_id AND status = 'approved';
  SELECT COALESCE(jsonb_agg(jsonb_build_object('request_id', request_id, 'source', source, 'source_ref', source_ref, 'status', status, 'created_at', created_at)
      ORDER BY created_at DESC), '[]'::jsonb)
    INTO v_pending FROM public.royal_room_usages
    WHERE guild_id = p_guild_id AND user_id = p_user_id AND status IN ('reserved', 'unknown');
  RETURN jsonb_build_object(
    'available_rooms', v_wallet.purchased_rooms - v_wallet.reserved_rooms - v_wallet.consumed_rooms - v_wallet.reversed_rooms,
    'reserved_rooms', v_wallet.reserved_rooms,
    'purchased_rooms_total', v_wallet.purchased_rooms,
    'created_today', v_today_count,
    'created_total', v_total,
    'approved_purchase_count', v_orders,
    'pending_usages', v_pending
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.royal_room_enqueue_payment_event(
  p_event_key text,
  p_payment_id text,
  p_action text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_row public.royal_room_mp_webhook_events%ROWTYPE;
BEGIN
  IF COALESCE(trim(p_event_key), '') = '' OR COALESCE(trim(p_payment_id), '') = '' THEN RAISE EXCEPTION 'WEBHOOK_EVENT_ID_REQUIRED'; END IF;
  INSERT INTO public.royal_room_mp_webhook_events (event_key, payment_id, action)
    VALUES (left(p_event_key, 160), left(trim(p_payment_id), 80), left(COALESCE(p_action, ''), 100))
    ON CONFLICT (event_key) DO UPDATE SET event_key = EXCLUDED.event_key
    RETURNING * INTO v_row;
  RETURN jsonb_build_object('id', v_row.id, 'status', v_row.status);
END;
$$;

CREATE OR REPLACE FUNCTION public.royal_room_claim_payment_events(p_limit integer DEFAULT 5)
RETURNS TABLE(id uuid, event_key text, payment_id text, action text, attempts integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT e.id FROM public.royal_room_mp_webhook_events e
      WHERE (e.status = 'pending' AND e.available_at <= now()) OR (e.status = 'processing' AND e.lease_until < now())
      ORDER BY e.created_at LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 5), 20)) FOR UPDATE SKIP LOCKED
  ), claimed AS (
    UPDATE public.royal_room_mp_webhook_events e SET status = 'processing', attempts = e.attempts + 1,
      lease_until = now() + interval '60 seconds'
      FROM candidates c WHERE e.id = c.id
      RETURNING e.id, e.event_key, e.payment_id, e.action, e.attempts
  ) SELECT claimed.id, claimed.event_key, claimed.payment_id, claimed.action, claimed.attempts FROM claimed;
END;
$$;

CREATE OR REPLACE FUNCTION public.royal_room_finish_payment_event(
  p_event_id uuid,
  p_success boolean,
  p_error_code text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_success THEN
    UPDATE public.royal_room_mp_webhook_events SET status = 'processed', lease_until = NULL, last_error = NULL, processed_at = now()
      WHERE id = p_event_id;
  ELSE
    UPDATE public.royal_room_mp_webhook_events SET status = 'pending', lease_until = NULL,
      available_at = now() + make_interval(secs => LEAST(3600, 15 * power(2, LEAST(attempts, 8))::integer)),
      last_error = left(COALESCE(p_error_code, 'processing_failed'), 80)
      WHERE id = p_event_id;
  END IF;
END;
$$;

DO $$
DECLARE v_table text;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'royal_room_purchase_settings', 'royal_room_coupons', 'royal_room_purchase_orders',
    'royal_room_coupon_uses', 'royal_room_wallets', 'royal_room_usages',
    'royal_room_ledger', 'royal_room_mp_webhook_events'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM anon, authenticated', v_table);
    EXECUTE format('GRANT ALL PRIVILEGES ON TABLE public.%I TO service_role', v_table);
    EXECUTE format('DROP POLICY IF EXISTS service_role_full_access ON public.%I', v_table);
    EXECUTE format('CREATE POLICY service_role_full_access ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)', v_table);
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.royal_room_set_purchase_settings(text, jsonb, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.royal_room_set_purchase_settings(text, jsonb, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.royal_room_upsert_coupon(text, text, smallint, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.royal_room_upsert_coupon(text, text, smallint, boolean, text) TO service_role;
REVOKE ALL ON FUNCTION public.royal_room_create_purchase(text, text, text, integer, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.royal_room_create_purchase(text, text, text, integer, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.royal_room_attach_payment(uuid, text, text, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.royal_room_attach_payment(uuid, text, text, text, text, timestamptz) TO service_role;
REVOKE ALL ON FUNCTION public.royal_room_mark_purchase_failure(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.royal_room_mark_purchase_failure(uuid, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.royal_room_apply_payment(uuid, text, text, bigint, text, text, bigint, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.royal_room_apply_payment(uuid, text, text, bigint, text, text, bigint, text) TO service_role;
REVOKE ALL ON FUNCTION public.royal_room_reserve_room(text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.royal_room_reserve_room(text, text, text, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.royal_room_settle_room(text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.royal_room_settle_room(text, text, text, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.royal_room_resolve_usage(text, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.royal_room_resolve_usage(text, text, text, text, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.royal_room_stats(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.royal_room_stats(text, text) TO service_role;
REVOKE ALL ON FUNCTION public.royal_room_enqueue_payment_event(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.royal_room_enqueue_payment_event(text, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.royal_room_claim_payment_events(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.royal_room_claim_payment_events(integer) TO service_role;
REVOKE ALL ON FUNCTION public.royal_room_finish_payment_event(uuid, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.royal_room_finish_payment_event(uuid, boolean, text) TO service_role;

COMMIT;
