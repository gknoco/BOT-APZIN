BEGIN;

CREATE TABLE IF NOT EXISTS public.royal_wallet_balances (
  guild_id text NOT NULL,
  user_id text NOT NULL,
  balance_cents bigint NOT NULL DEFAULT 0 CHECK (balance_cents >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.royal_wallet_topups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id text NOT NULL,
  user_id text NOT NULL,
  request_id text NOT NULL UNIQUE,
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  bonus_cents bigint NOT NULL DEFAULT 0 CHECK (bonus_cents >= 0),
  credit_cents bigint NOT NULL CHECK (credit_cents > 0),
  payer_email text NOT NULL,
  status text NOT NULL DEFAULT 'creating'
    CHECK (status IN ('creating','pending','approved','rejected','cancelled','refunded','charged_back','manual_review','failed','expired')),
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
CREATE INDEX IF NOT EXISTS idx_royal_wallet_topups_guild_user
  ON public.royal_wallet_topups (guild_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_royal_wallet_topups_status
  ON public.royal_wallet_topups (status, created_at);

CREATE TABLE IF NOT EXISTS public.royal_wallet_topup_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guild_id text NOT NULL,
  user_id text NOT NULL,
  request_id text NOT NULL UNIQUE,
  event_type text NOT NULL CHECK (event_type IN ('topup','refund_review')),
  delta_cents bigint NOT NULL,
  topup_id uuid REFERENCES public.royal_wallet_topups(id),
  balance_after_cents bigint NOT NULL CHECK (balance_after_cents >= 0),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_royal_wallet_topup_ledger_user
  ON public.royal_wallet_topup_ledger (guild_id, user_id, created_at DESC);

ALTER TABLE public.royal_wallet_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.royal_wallet_topups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.royal_wallet_topup_ledger ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_role_full_access ON public.royal_wallet_balances;
CREATE POLICY service_role_full_access ON public.royal_wallet_balances
  FOR ALL TO service_role USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
DROP POLICY IF EXISTS service_role_full_access ON public.royal_wallet_topups;
CREATE POLICY service_role_full_access ON public.royal_wallet_topups
  FOR ALL TO service_role USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
DROP POLICY IF EXISTS service_role_full_access ON public.royal_wallet_topup_ledger;
CREATE POLICY service_role_full_access ON public.royal_wallet_topup_ledger
  FOR ALL TO service_role USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
REVOKE ALL ON public.royal_wallet_balances, public.royal_wallet_topups, public.royal_wallet_topup_ledger FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.royal_wallet_balances, public.royal_wallet_topups, public.royal_wallet_topup_ledger TO service_role;

CREATE OR REPLACE FUNCTION public.royal_wallet_create_topup(
  p_guild_id text,
  p_user_id text,
  p_request_id text,
  p_amount_cents bigint,
  p_payer_email text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_row public.royal_wallet_topups%ROWTYPE; v_bonus bigint; v_credit bigint;
BEGIN
  IF COALESCE(trim(p_guild_id), '') = '' OR COALESCE(trim(p_user_id), '') = '' OR
     COALESCE(trim(p_request_id), '') = '' OR p_amount_cents IS NULL OR p_amount_cents < 1 OR
     COALESCE(trim(p_payer_email), '') = '' THEN
    RAISE EXCEPTION 'INVALID_WALLET_TOPUP';
  END IF;
  SELECT * INTO v_row FROM public.royal_wallet_topups WHERE request_id = p_request_id FOR UPDATE;
  IF FOUND THEN
    IF v_row.guild_id <> p_guild_id OR v_row.user_id <> p_user_id OR
       v_row.amount_cents <> p_amount_cents OR lower(v_row.payer_email) <> lower(p_payer_email) THEN
      RAISE EXCEPTION 'WALLET_TOPUP_REQUEST_REUSED_WITH_DIFFERENT_DATA';
    END IF;
    RETURN to_jsonb(v_row);
  END IF;
  v_bonus := CASE WHEN p_amount_cents >= 1000 THEN round(p_amount_cents * 0.10)::bigint ELSE 0 END;
  v_credit := p_amount_cents + v_bonus;
  INSERT INTO public.royal_wallet_topups (guild_id, user_id, request_id, amount_cents, bonus_cents, credit_cents, payer_email)
    VALUES (trim(p_guild_id), trim(p_user_id), trim(p_request_id), p_amount_cents, v_bonus, v_credit, lower(trim(p_payer_email)))
    RETURNING * INTO v_row;
  RETURN to_jsonb(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.royal_wallet_attach_topup_payment(
  p_topup_id uuid,
  p_payment_id text,
  p_qr_code text,
  p_qr_base64 text,
  p_ticket_url text,
  p_expires_at timestamptz
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_row public.royal_wallet_topups%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM public.royal_wallet_topups WHERE id = p_topup_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WALLET_TOPUP_NOT_FOUND'; END IF;
  IF COALESCE(trim(p_payment_id), '') = '' OR COALESCE(trim(p_qr_code), '') = '' THEN RAISE EXCEPTION 'WALLET_TOPUP_PAYMENT_DATA_REQUIRED'; END IF;
  IF v_row.mp_payment_id IS NOT NULL AND v_row.mp_payment_id <> p_payment_id THEN RAISE EXCEPTION 'WALLET_TOPUP_PAYMENT_ID_MISMATCH'; END IF;
  UPDATE public.royal_wallet_topups SET mp_payment_id = p_payment_id, pix_copy_paste = p_qr_code,
    pix_qr_base64 = p_qr_base64, ticket_url = p_ticket_url, expires_at = p_expires_at,
    status = CASE WHEN status = 'creating' THEN 'pending' ELSE status END,
    mp_status = COALESCE(mp_status, 'pending'), updated_at = now()
    WHERE id = p_topup_id RETURNING * INTO v_row;
  RETURN to_jsonb(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.royal_wallet_mark_topup_failure(
  p_topup_id uuid,
  p_status text,
  p_error_code text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_row public.royal_wallet_topups%ROWTYPE;
BEGIN
  IF p_status NOT IN ('failed', 'manual_review') THEN RAISE EXCEPTION 'INVALID_WALLET_TOPUP_FAILURE_STATUS'; END IF;
  UPDATE public.royal_wallet_topups SET status = p_status,
    error_code = left(COALESCE(p_error_code, 'unknown'), 80), updated_at = now()
    WHERE id = p_topup_id AND status <> 'approved' RETURNING * INTO v_row;
  IF NOT FOUND THEN SELECT * INTO v_row FROM public.royal_wallet_topups WHERE id = p_topup_id; END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'WALLET_TOPUP_NOT_FOUND'; END IF;
  RETURN to_jsonb(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.royal_wallet_apply_topup_payment(
  p_topup_id uuid,
  p_payment_id text,
  p_status text,
  p_amount_cents bigint,
  p_currency text,
  p_external_reference text,
  p_payment_method text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_row public.royal_wallet_topups%ROWTYPE;
  v_status text := lower(trim(COALESCE(p_status, '')));
  v_balance bigint;
  v_reason text;
BEGIN
  SELECT * INTO v_row FROM public.royal_wallet_topups WHERE id = p_topup_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'WALLET_TOPUP_NOT_FOUND'; END IF;
  IF COALESCE(trim(p_payment_id), '') = '' THEN RAISE EXCEPTION 'WALLET_TOPUP_PAYMENT_ID_REQUIRED'; END IF;
  IF EXISTS (SELECT 1 FROM public.royal_wallet_topups WHERE mp_payment_id = p_payment_id AND id <> p_topup_id) THEN
    UPDATE public.royal_wallet_topups SET status = 'manual_review', mp_status = v_status,
      error_code = 'payment_id_already_linked', updated_at = now() WHERE id = p_topup_id RETURNING * INTO v_row;
    RETURN to_jsonb(v_row) || jsonb_build_object('balance_cents', NULL);
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
    SELECT balance_cents INTO v_balance FROM public.royal_wallet_balances
      WHERE guild_id = v_row.guild_id AND user_id = v_row.user_id;
    RETURN to_jsonb(v_row) || jsonb_build_object('balance_cents', COALESCE(v_balance, 0));
  END IF;

  IF v_status = 'approved' THEN
    IF v_row.status NOT IN ('approved', 'refunded', 'charged_back') THEN
      INSERT INTO public.royal_wallet_balances (guild_id, user_id, balance_cents, updated_at)
        VALUES (v_row.guild_id, v_row.user_id, v_row.credit_cents, now())
        ON CONFLICT (guild_id, user_id) DO UPDATE SET
          balance_cents = public.royal_wallet_balances.balance_cents + EXCLUDED.balance_cents,
          updated_at = now();
      SELECT balance_cents INTO v_balance FROM public.royal_wallet_balances
        WHERE guild_id = v_row.guild_id AND user_id = v_row.user_id FOR UPDATE;
      INSERT INTO public.royal_wallet_topup_ledger
        (guild_id, user_id, request_id, event_type, delta_cents, topup_id, balance_after_cents, detail)
        VALUES (v_row.guild_id, v_row.user_id, 'topup:' || v_row.id::text, 'topup', v_row.credit_cents,
          v_row.id, v_balance, jsonb_build_object('payment_id', p_payment_id, 'amount_cents', v_row.amount_cents,
            'bonus_cents', v_row.bonus_cents, 'credit_cents', v_row.credit_cents))
        ON CONFLICT (request_id) DO NOTHING;
      UPDATE public.royal_wallet_topups SET status = 'approved', mp_payment_id = p_payment_id,
        mp_status = 'approved', approved_at = COALESCE(approved_at, now()), error_code = NULL, updated_at = now()
        WHERE id = p_topup_id RETURNING * INTO v_row;
    ELSE
      SELECT balance_cents INTO v_balance FROM public.royal_wallet_balances
        WHERE guild_id = v_row.guild_id AND user_id = v_row.user_id;
      UPDATE public.royal_wallet_topups SET mp_status = 'approved', updated_at = now()
        WHERE id = p_topup_id RETURNING * INTO v_row;
    END IF;
  ELSIF v_row.status <> 'approved' THEN
    IF v_status NOT IN ('pending','in_process','rejected','cancelled','expired','refunded','charged_back') THEN v_status := 'pending'; END IF;
    IF v_status IN ('refunded','charged_back') THEN
      UPDATE public.royal_wallet_topups SET status = 'manual_review', mp_payment_id = COALESCE(mp_payment_id, p_payment_id),
        mp_status = v_status, error_code = 'refund_requires_manual_review', updated_at = now()
        WHERE id = p_topup_id RETURNING * INTO v_row;
    ELSE
      UPDATE public.royal_wallet_topups SET status = v_status, mp_payment_id = COALESCE(mp_payment_id, p_payment_id),
        mp_status = v_status, updated_at = now() WHERE id = p_topup_id RETURNING * INTO v_row;
    END IF;
    SELECT balance_cents INTO v_balance FROM public.royal_wallet_balances
      WHERE guild_id = v_row.guild_id AND user_id = v_row.user_id;
  ELSE
    SELECT balance_cents INTO v_balance FROM public.royal_wallet_balances
      WHERE guild_id = v_row.guild_id AND user_id = v_row.user_id;
  END IF;
  RETURN to_jsonb(v_row) || jsonb_build_object('balance_cents', COALESCE(v_balance, 0));
END;
$$;

CREATE OR REPLACE FUNCTION public.royal_wallet_balance(p_guild_id text, p_user_id text)
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT COALESCE((SELECT balance_cents FROM public.royal_wallet_balances
    WHERE guild_id = p_guild_id AND user_id = p_user_id), 0)
$$;

REVOKE ALL ON FUNCTION public.royal_wallet_create_topup(text,text,text,bigint,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.royal_wallet_attach_topup_payment(uuid,text,text,text,text,timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.royal_wallet_mark_topup_failure(uuid,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.royal_wallet_apply_topup_payment(uuid,text,text,bigint,text,text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.royal_wallet_balance(text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.royal_wallet_create_topup(text,text,text,bigint,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.royal_wallet_attach_topup_payment(uuid,text,text,text,text,timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.royal_wallet_mark_topup_failure(uuid,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.royal_wallet_apply_topup_payment(uuid,text,text,bigint,text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.royal_wallet_balance(text,text) TO service_role;

COMMIT;
