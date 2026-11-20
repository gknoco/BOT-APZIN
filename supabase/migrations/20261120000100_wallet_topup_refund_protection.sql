BEGIN;

-- Reembolso/chargeback após aprovação congela atomicamente a carteira. A compra e
-- o webhook serializam na mesma linha de saldo, então não há janela de gasto entre
-- a detecção do estorno e a aplicação do bloqueio.
ALTER TABLE public.royal_wallet_balances
  ADD COLUMN IF NOT EXISTS is_frozen boolean NOT NULL DEFAULT false;
ALTER TABLE public.royal_wallet_balances
  ADD COLUMN IF NOT EXISTS frozen_reason text;

-- Nova assinatura recebe o montante efetivamente reembolsado. A assinatura antiga
-- permanece como wrapper para compatibilidade com instâncias ainda não atualizadas.
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
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_row public.royal_wallet_topups%ROWTYPE;
  v_status text := lower(trim(COALESCE(p_status, '')));
  v_balance bigint;
  v_frozen boolean := false;
  v_reason text;
  v_wallet_reason text;
  v_final_status text;
  v_previous_status text;
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

    INSERT INTO public.royal_wallet_topup_ledger
      (guild_id, user_id, request_id, event_type, delta_cents, topup_id, balance_after_cents, detail)
    VALUES (v_row.guild_id, v_row.user_id,
      'refund_review:' || v_row.id::text || ':' || md5(p_payment_id || ':' || v_wallet_reason || ':' || v_status || ':' || COALESCE(p_refunded_cents, 0)::text),
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
    IF COALESCE(v_frozen, false) THEN
      UPDATE public.royal_wallet_topups SET status = 'manual_review', mp_payment_id = COALESCE(mp_payment_id, p_payment_id),
        mp_status = 'approved', error_code = 'wallet_frozen_pending_review', updated_at = now()
        WHERE id = p_topup_id RETURNING * INTO v_row;
      RETURN to_jsonb(v_row) || jsonb_build_object('balance_cents', 0, 'wallet_frozen', true);
    END IF;

    IF v_row.status NOT IN ('approved', 'refunded', 'charged_back') THEN
      UPDATE public.royal_wallet_balances SET balance_cents = balance_cents + v_row.credit_cents, updated_at = now()
        WHERE guild_id = v_row.guild_id AND user_id = v_row.user_id RETURNING balance_cents INTO v_balance;
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
      UPDATE public.royal_wallet_topups SET mp_status = 'approved', updated_at = now()
        WHERE id = p_topup_id RETURNING * INTO v_row;
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

CREATE OR REPLACE FUNCTION public.royal_wallet_apply_topup_payment(
  p_topup_id uuid, p_payment_id text, p_status text, p_amount_cents bigint,
  p_currency text, p_external_reference text, p_payment_method text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN public.royal_wallet_apply_topup_payment(
    p_topup_id, p_payment_id, p_status, p_amount_cents, p_currency,
    p_external_reference, p_payment_method, 0);
END;
$$;

CREATE OR REPLACE FUNCTION public.royal_wallet_purchase_rooms(
  p_guild_id text, p_user_id text, p_request_id text,
  p_rooms_quantity integer, p_amount_cents bigint
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_order public.royal_room_purchase_orders%ROWTYPE;
  v_balance bigint;
  v_frozen boolean := false;
BEGIN
  IF COALESCE(trim(p_guild_id), '') = '' OR COALESCE(trim(p_user_id), '') = '' OR
     COALESCE(trim(p_request_id), '') = '' OR length(trim(p_request_id)) > 180 OR
     p_rooms_quantity IS NULL OR p_rooms_quantity < 1 OR p_rooms_quantity > 1000 OR
     p_amount_cents IS NULL OR p_amount_cents <> p_rooms_quantity::bigint * 3 THEN
    RAISE EXCEPTION 'INVALID_WALLET_ROOM_PURCHASE';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('wallet-room-purchase:' || trim(p_request_id), 0));

  SELECT * INTO v_order FROM public.royal_room_purchase_orders
    WHERE request_id = trim(p_request_id) FOR UPDATE;
  IF FOUND THEN
    IF v_order.guild_id <> trim(p_guild_id) OR v_order.user_id <> trim(p_user_id) OR
       v_order.rooms_quantity <> p_rooms_quantity OR v_order.amount_cents <> p_amount_cents OR
       v_order.mp_status IS DISTINCT FROM 'wallet' THEN
      RAISE EXCEPTION 'WALLET_ROOM_PURCHASE_REQUEST_REUSED_WITH_DIFFERENT_DATA';
    END IF;
    SELECT balance_cents, is_frozen INTO v_balance, v_frozen FROM public.royal_wallet_balances
      WHERE guild_id = trim(p_guild_id) AND user_id = trim(p_user_id);
    RETURN to_jsonb(v_order) || jsonb_build_object(
      'status', v_order.status, 'balance_cents', CASE WHEN COALESCE(v_frozen, false) THEN 0 ELSE COALESCE(v_balance, 0) END,
      'wallet_payment', true, 'wallet_frozen', COALESCE(v_frozen, false), 'idempotent', true);
  END IF;

  INSERT INTO public.royal_wallet_balances (guild_id, user_id, balance_cents, updated_at)
    VALUES (trim(p_guild_id), trim(p_user_id), 0, now()) ON CONFLICT (guild_id, user_id) DO NOTHING;
  SELECT balance_cents, is_frozen INTO v_balance, v_frozen FROM public.royal_wallet_balances
    WHERE guild_id = trim(p_guild_id) AND user_id = trim(p_user_id) FOR UPDATE;
  IF COALESCE(v_frozen, false) THEN
    RETURN jsonb_build_object('status', 'wallet_frozen', 'balance_cents', 0,
      'amount_cents', p_amount_cents, 'rooms_quantity', p_rooms_quantity, 'wallet_frozen', true);
  END IF;
  IF v_balance < p_amount_cents THEN
    RETURN jsonb_build_object('status', 'insufficient_funds', 'balance_cents', v_balance,
      'amount_cents', p_amount_cents, 'rooms_quantity', p_rooms_quantity);
  END IF;

  UPDATE public.royal_wallet_balances SET balance_cents = balance_cents - p_amount_cents, updated_at = now()
    WHERE guild_id = trim(p_guild_id) AND user_id = trim(p_user_id) RETURNING balance_cents INTO v_balance;
  INSERT INTO public.royal_room_purchase_orders (
    guild_id, user_id, request_id, rooms_quantity, unit_price_cents,
    gross_amount_cents, discount_cents, amount_cents, payer_email, status, mp_status, approved_at
  ) VALUES (
    trim(p_guild_id), trim(p_user_id), trim(p_request_id), p_rooms_quantity, 3,
    p_amount_cents::integer, 0, p_amount_cents::integer, 'wallet@internal.invalid', 'approved', 'wallet', now()
  ) RETURNING * INTO v_order;
  INSERT INTO public.royal_room_wallets (guild_id, user_id, purchased_rooms, updated_at)
    VALUES (v_order.guild_id, v_order.user_id, v_order.rooms_quantity, now())
    ON CONFLICT (guild_id, user_id) DO UPDATE
      SET purchased_rooms = public.royal_room_wallets.purchased_rooms + EXCLUDED.purchased_rooms, updated_at = now();
  INSERT INTO public.royal_room_ledger (guild_id, user_id, request_id, event_type, delta_rooms, order_id, detail)
    VALUES (v_order.guild_id, v_order.user_id, 'purchase:' || v_order.id::text,
      'purchase', v_order.rooms_quantity, v_order.id,
      jsonb_build_object('amount_cents', v_order.amount_cents, 'payment_source', 'wallet'));
  INSERT INTO public.royal_wallet_topup_ledger (
    guild_id, user_id, request_id, event_type, delta_cents, topup_id, balance_after_cents, detail
  ) VALUES (
    v_order.guild_id, v_order.user_id, 'room_purchase:' || v_order.id::text,
    'room_purchase', -p_amount_cents, NULL, v_balance,
    jsonb_build_object('order_id', v_order.id, 'rooms_quantity', p_rooms_quantity,
      'unit_price_cents', 3, 'payment_source', 'wallet')
  );
  RETURN to_jsonb(v_order) || jsonb_build_object(
    'status', 'approved', 'balance_cents', v_balance, 'wallet_payment', true,
    'wallet_frozen', false, 'idempotent', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.royal_wallet_balance(p_guild_id text, p_user_id text)
RETURNS bigint
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT CASE WHEN COALESCE((SELECT is_frozen FROM public.royal_wallet_balances
    WHERE guild_id = p_guild_id AND user_id = p_user_id), false) THEN 0
    ELSE COALESCE((SELECT balance_cents FROM public.royal_wallet_balances
      WHERE guild_id = p_guild_id AND user_id = p_user_id), 0) END
$$;

REVOKE ALL ON FUNCTION public.royal_wallet_apply_topup_payment(uuid,text,text,bigint,text,text,text,bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.royal_wallet_apply_topup_payment(uuid,text,text,bigint,text,text,text,bigint)
  TO service_role;
REVOKE ALL ON FUNCTION public.royal_wallet_apply_topup_payment(uuid,text,text,bigint,text,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.royal_wallet_apply_topup_payment(uuid,text,text,bigint,text,text,text)
  TO service_role;
REVOKE ALL ON FUNCTION public.royal_wallet_purchase_rooms(text,text,text,integer,bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.royal_wallet_purchase_rooms(text,text,text,integer,bigint)
  TO service_role;
REVOKE ALL ON FUNCTION public.royal_wallet_balance(text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.royal_wallet_balance(text,text) TO service_role;
DO $acl$
BEGIN
  IF to_regprocedure('public.royal_room_admin_grant(text,text,text,bigint,text)') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.royal_room_admin_grant(text,text,text,bigint,text) FROM PUBLIC, anon, authenticated';
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.royal_room_admin_grant(text,text,text,bigint,text) TO service_role';
  END IF;
END;
$acl$;



-- Reflete o congelamento no saldo apresentado ao usuário e no estado do extrato.
CREATE OR REPLACE FUNCTION public.royal_wallet_statement(p_guild_id text, p_user_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_balance bigint;
  v_frozen boolean := false;
  v_entries bigint;
  v_exits bigint;
  v_movements jsonb;
BEGIN
  IF COALESCE(trim(p_guild_id), '') = '' OR COALESCE(trim(p_user_id), '') = '' THEN
    RAISE EXCEPTION 'WALLET_STATEMENT_IDENTITY_REQUIRED';
  END IF;
  SELECT COALESCE(balance_cents, 0), COALESCE(is_frozen, false)
    INTO v_balance, v_frozen FROM public.royal_wallet_balances
    WHERE guild_id = trim(p_guild_id) AND user_id = trim(p_user_id);
  v_balance := CASE WHEN COALESCE(v_frozen, false) THEN 0 ELSE COALESCE(v_balance, 0) END;
  SELECT COALESCE(SUM(delta_cents) FILTER (WHERE delta_cents > 0), 0),
         COALESCE(SUM(-delta_cents) FILTER (WHERE delta_cents < 0), 0)
    INTO v_entries, v_exits FROM public.royal_wallet_topup_ledger
    WHERE guild_id = trim(p_guild_id) AND user_id = trim(p_user_id);
  SELECT COALESCE(jsonb_agg(to_jsonb(recentes)), '[]'::jsonb) INTO v_movements
    FROM (SELECT id, event_type, delta_cents, balance_after_cents, created_at
      FROM public.royal_wallet_topup_ledger WHERE guild_id = trim(p_guild_id) AND user_id = trim(p_user_id)
      ORDER BY created_at DESC, id DESC LIMIT 6) AS recentes;
  RETURN jsonb_build_object(
    'balance_cents', v_balance,
    'total_entries_cents', COALESCE(v_entries, 0),
    'total_exits_cents', COALESCE(v_exits, 0),
    'wallet_status', CASE WHEN COALESCE(v_frozen, false) THEN 'Bloqueada para revisão' ELSE 'Normal' END,
    'movements', v_movements
  );
END;
$$;
REVOKE ALL ON FUNCTION public.royal_wallet_statement(text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.royal_wallet_statement(text,text) TO service_role;


-- Créditos de sala podem ter sido convertidos a partir do saldo Pix antes do
-- chargeback. Congele essa carteira também e faça a reserva conferir o bloqueio.
-- O freeze é deliberadamente sticky: só deve ser removido após reconciliação
-- administrativa do pagamento e das duas carteiras, nunca por webhook automático.
ALTER TABLE public.royal_room_wallets
  ADD COLUMN IF NOT EXISTS is_frozen boolean NOT NULL DEFAULT false;
ALTER TABLE public.royal_room_wallets
  ADD COLUMN IF NOT EXISTS frozen_reason text;

CREATE OR REPLACE FUNCTION public.royal_wallet_propagate_freeze_to_rooms()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.is_frozen THEN
    INSERT INTO public.royal_room_wallets (guild_id, user_id, updated_at)
      VALUES (NEW.guild_id, NEW.user_id, now())
      ON CONFLICT (guild_id, user_id) DO NOTHING;
    UPDATE public.royal_room_wallets SET is_frozen = true,
      frozen_reason = NEW.frozen_reason, updated_at = now()
      WHERE guild_id = NEW.guild_id AND user_id = NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS royal_wallet_propagate_freeze_to_rooms ON public.royal_wallet_balances;
CREATE TRIGGER royal_wallet_propagate_freeze_to_rooms
  AFTER INSERT OR UPDATE OF is_frozen ON public.royal_wallet_balances
  FOR EACH ROW EXECUTE FUNCTION public.royal_wallet_propagate_freeze_to_rooms();

CREATE OR REPLACE FUNCTION public.royal_room_reserve_room(
  p_guild_id text, p_user_id text, p_request_id text, p_source text, p_source_ref text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_wallet public.royal_room_wallets%ROWTYPE;
  v_usage public.royal_room_usages%ROWTYPE;
  v_premium_until timestamptz;
  v_premium boolean := false;
BEGIN
  IF COALESCE(trim(p_guild_id), '') = '' OR COALESCE(trim(p_user_id), '') = '' OR COALESCE(trim(p_request_id), '') = '' THEN
    RAISE EXCEPTION 'ROOM_USAGE_IDENTITY_REQUIRED';
  END IF;
  IF p_source NOT IN ('nix_command', 'match') OR (p_source = 'match' AND COALESCE(trim(p_source_ref), '') = '') THEN
    RAISE EXCEPTION 'INVALID_ROOM_USAGE_SOURCE';
  END IF;
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
  SELECT premium_until INTO v_premium_until FROM public.royal_infinite_subscriptions
    WHERE guild_id = p_guild_id AND user_id = p_user_id;
  v_premium := COALESCE(v_premium_until > now(), false);
  INSERT INTO public.royal_room_wallets (guild_id, user_id)
    VALUES (p_guild_id, p_user_id) ON CONFLICT (guild_id, user_id) DO NOTHING;
  SELECT * INTO v_wallet FROM public.royal_room_wallets
    WHERE guild_id = p_guild_id AND user_id = p_user_id FOR UPDATE;
  IF NOT v_premium AND COALESCE(v_wallet.is_frozen, false) THEN
    RAISE EXCEPTION 'ROOM_WALLET_FROZEN_FOR_REVIEW';
  END IF;
  IF NOT v_premium AND v_wallet.purchased_rooms - v_wallet.reserved_rooms - v_wallet.consumed_rooms - v_wallet.reversed_rooms < 1 THEN
    RAISE EXCEPTION 'INSUFFICIENT_ROOM_CREDITS';
  END IF;
  INSERT INTO public.royal_room_usages (guild_id, user_id, request_id, source, source_ref, status, credit_charged)
    VALUES (p_guild_id, p_user_id, p_request_id, p_source, p_source_ref, 'reserved', NOT v_premium) RETURNING * INTO v_usage;
  IF NOT v_premium THEN
    UPDATE public.royal_room_wallets SET reserved_rooms = reserved_rooms + 1, updated_at = now()
      WHERE guild_id = p_guild_id AND user_id = p_user_id RETURNING * INTO v_wallet;
  END IF;
  INSERT INTO public.royal_room_ledger (guild_id, user_id, request_id, event_type, delta_rooms, usage_id, detail)
    VALUES (p_guild_id, p_user_id, 'reserve:' || p_request_id, 'reserved', 0, v_usage.id,
      jsonb_build_object('source', p_source, 'source_ref', p_source_ref, 'premium', v_premium, 'premium_until', v_premium_until));
  RETURN jsonb_build_object('usage', to_jsonb(v_usage),
    'available_rooms', CASE WHEN COALESCE(v_wallet.is_frozen, false) THEN 0
      ELSE v_wallet.purchased_rooms - v_wallet.reserved_rooms - v_wallet.consumed_rooms - v_wallet.reversed_rooms END,
    'unlimited_rooms', v_premium, 'premium_until', v_premium_until,
    'wallet_frozen', COALESCE(v_wallet.is_frozen, false));
END;
$$;

CREATE OR REPLACE FUNCTION public.royal_room_stats(p_guild_id text, p_user_id text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_wallet public.royal_room_wallets%ROWTYPE;
  v_today timestamptz;
  v_today_count bigint;
  v_total bigint;
  v_orders bigint;
  v_pending jsonb;
BEGIN
  SELECT * INTO v_wallet FROM public.royal_room_wallets WHERE guild_id = p_guild_id AND user_id = p_user_id;
  IF NOT FOUND THEN
    v_wallet.purchased_rooms := 0; v_wallet.reserved_rooms := 0; v_wallet.consumed_rooms := 0;
    v_wallet.reversed_rooms := 0; v_wallet.is_frozen := false;
  END IF;
  v_today := date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo';
  SELECT count(*) INTO v_today_count FROM public.royal_room_usages
    WHERE guild_id = p_guild_id AND user_id = p_user_id AND status = 'created' AND settled_at >= v_today;
  SELECT count(*) INTO v_total FROM public.royal_room_usages
    WHERE guild_id = p_guild_id AND user_id = p_user_id AND status = 'created';
  SELECT count(*) INTO v_orders FROM public.royal_room_purchase_orders
    WHERE guild_id = p_guild_id AND user_id = p_user_id AND status = 'approved';
  SELECT COALESCE(jsonb_agg(jsonb_build_object('request_id', request_id, 'source', source,
      'source_ref', source_ref, 'status', status, 'created_at', created_at) ORDER BY created_at DESC), '[]'::jsonb)
    INTO v_pending FROM public.royal_room_usages
    WHERE guild_id = p_guild_id AND user_id = p_user_id AND status IN ('reserved', 'unknown');
  RETURN jsonb_build_object(
    'available_rooms', CASE WHEN COALESCE(v_wallet.is_frozen, false) THEN 0
      ELSE v_wallet.purchased_rooms - v_wallet.reserved_rooms - v_wallet.consumed_rooms - v_wallet.reversed_rooms END,
    'reserved_rooms', v_wallet.reserved_rooms,
    'purchased_rooms_total', v_wallet.purchased_rooms,
    'created_today', v_today_count,
    'created_total', v_total,
    'approved_purchase_count', v_orders,
    'pending_usages', v_pending,
    'wallet_frozen', COALESCE(v_wallet.is_frozen, false)
  );
END;
$$;
REVOKE ALL ON FUNCTION public.royal_room_reserve_room(text,text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.royal_room_reserve_room(text,text,text,text,text) TO service_role;
REVOKE ALL ON FUNCTION public.royal_room_stats(text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.royal_room_stats(text,text) TO service_role;
REVOKE ALL ON FUNCTION public.royal_wallet_propagate_freeze_to_rooms() FROM PUBLIC, anon, authenticated;
COMMIT;
