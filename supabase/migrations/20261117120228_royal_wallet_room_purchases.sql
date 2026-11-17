BEGIN;

-- Debits appear in the same per-user financial ledger used by the wallet statement.
ALTER TABLE public.royal_wallet_topup_ledger
  DROP CONSTRAINT IF EXISTS royal_wallet_topup_ledger_event_type_check;
ALTER TABLE public.royal_wallet_topup_ledger
  ADD CONSTRAINT royal_wallet_topup_ledger_event_type_check
  CHECK (event_type IN ('topup', 'refund_review', 'room_purchase'));

CREATE OR REPLACE FUNCTION public.royal_wallet_purchase_rooms(
  p_guild_id text,
  p_user_id text,
  p_request_id text,
  p_rooms_quantity integer,
  p_amount_cents bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order public.royal_room_purchase_orders%ROWTYPE;
  v_balance bigint;
BEGIN
  IF COALESCE(trim(p_guild_id), '') = '' OR COALESCE(trim(p_user_id), '') = '' OR
     COALESCE(trim(p_request_id), '') = '' OR length(trim(p_request_id)) > 180 OR
     p_rooms_quantity IS NULL OR p_rooms_quantity < 1 OR p_rooms_quantity > 1000 OR
     p_amount_cents IS NULL OR p_amount_cents <> p_rooms_quantity::bigint * 3 THEN
    RAISE EXCEPTION 'INVALID_WALLET_ROOM_PURCHASE';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('wallet-room-purchase:' || trim(p_request_id), 0));

  SELECT * INTO v_order
    FROM public.royal_room_purchase_orders
   WHERE request_id = trim(p_request_id)
   FOR UPDATE;
  IF FOUND THEN
    IF v_order.guild_id <> trim(p_guild_id) OR v_order.user_id <> trim(p_user_id) OR
       v_order.rooms_quantity <> p_rooms_quantity OR v_order.amount_cents <> p_amount_cents OR
       v_order.mp_status IS DISTINCT FROM 'wallet' THEN
      RAISE EXCEPTION 'WALLET_ROOM_PURCHASE_REQUEST_REUSED_WITH_DIFFERENT_DATA';
    END IF;
    SELECT balance_cents INTO v_balance
      FROM public.royal_wallet_balances
     WHERE guild_id = trim(p_guild_id) AND user_id = trim(p_user_id);
    RETURN to_jsonb(v_order) || jsonb_build_object(
      'status', v_order.status,
      'balance_cents', COALESCE(v_balance, 0),
      'wallet_payment', true,
      'idempotent', true
    );
  END IF;

  INSERT INTO public.royal_wallet_balances (guild_id, user_id, balance_cents, updated_at)
    VALUES (trim(p_guild_id), trim(p_user_id), 0, now())
    ON CONFLICT (guild_id, user_id) DO NOTHING;
  SELECT balance_cents INTO v_balance
    FROM public.royal_wallet_balances
   WHERE guild_id = trim(p_guild_id) AND user_id = trim(p_user_id)
   FOR UPDATE;

  IF v_balance < p_amount_cents THEN
    RETURN jsonb_build_object(
      'status', 'insufficient_funds',
      'balance_cents', v_balance,
      'amount_cents', p_amount_cents,
      'rooms_quantity', p_rooms_quantity
    );
  END IF;

  UPDATE public.royal_wallet_balances
     SET balance_cents = balance_cents - p_amount_cents, updated_at = now()
   WHERE guild_id = trim(p_guild_id) AND user_id = trim(p_user_id)
   RETURNING balance_cents INTO v_balance;

  INSERT INTO public.royal_room_purchase_orders (
    guild_id, user_id, request_id, rooms_quantity, unit_price_cents,
    gross_amount_cents, discount_cents, amount_cents, payer_email,
    status, mp_status, approved_at
  ) VALUES (
    trim(p_guild_id), trim(p_user_id), trim(p_request_id), p_rooms_quantity, 3,
    p_amount_cents::integer, 0, p_amount_cents::integer, 'wallet@internal.invalid',
    'approved', 'wallet', now()
  ) RETURNING * INTO v_order;

  INSERT INTO public.royal_room_wallets (guild_id, user_id, purchased_rooms, updated_at)
    VALUES (v_order.guild_id, v_order.user_id, v_order.rooms_quantity, now())
    ON CONFLICT (guild_id, user_id) DO UPDATE
      SET purchased_rooms = public.royal_room_wallets.purchased_rooms + EXCLUDED.purchased_rooms,
          updated_at = now();

  INSERT INTO public.royal_room_ledger (
    guild_id, user_id, request_id, event_type, delta_rooms, order_id, detail
  ) VALUES (
    v_order.guild_id, v_order.user_id, 'purchase:' || v_order.id::text,
    'purchase', v_order.rooms_quantity, v_order.id,
    jsonb_build_object('amount_cents', v_order.amount_cents, 'payment_source', 'wallet')
  );

  INSERT INTO public.royal_wallet_topup_ledger (
    guild_id, user_id, request_id, event_type, delta_cents, topup_id,
    balance_after_cents, detail
  ) VALUES (
    v_order.guild_id, v_order.user_id, 'room_purchase:' || v_order.id::text,
    'room_purchase', -p_amount_cents, NULL, v_balance,
    jsonb_build_object('order_id', v_order.id, 'rooms_quantity', p_rooms_quantity,
      'unit_price_cents', 3, 'payment_source', 'wallet')
  );

  RETURN to_jsonb(v_order) || jsonb_build_object(
    'status', 'approved',
    'balance_cents', v_balance,
    'wallet_payment', true,
    'idempotent', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.royal_wallet_purchase_rooms(text, text, text, integer, bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.royal_wallet_purchase_rooms(text, text, text, integer, bigint)
  TO service_role;

COMMIT;
