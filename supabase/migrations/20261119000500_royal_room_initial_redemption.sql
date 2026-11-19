BEGIN;

-- Credita o resgate inicial na mesma carteira/ledger usados pela aprovação
-- de compras. O request_id impede créditos duplicados mesmo após retries.
CREATE OR REPLACE FUNCTION public.royal_room_credit_initial_redemption(
  p_guild_id text,
  p_user_id text,
  p_request_id text,
  p_rooms_quantity bigint DEFAULT 10
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_purchased bigint;
  v_reserved bigint;
  v_consumed bigint;
  v_reversed bigint;
  v_available bigint;
BEGIN
  IF COALESCE(trim(p_guild_id), '') = ''
     OR COALESCE(trim(p_user_id), '') = ''
     OR COALESCE(trim(p_request_id), '') = ''
     OR length(trim(p_request_id)) > 180
     OR p_rooms_quantity IS NULL
     OR p_rooms_quantity < 1 THEN
    RAISE EXCEPTION 'INVALID_INITIAL_ROOM_REDEMPTION';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('initial-room-redeem:' || trim(p_guild_id) || ':' || trim(p_user_id), 0));

  SELECT purchased_rooms, reserved_rooms, consumed_rooms, reversed_rooms
    INTO v_purchased, v_reserved, v_consumed, v_reversed
    FROM public.royal_room_wallets
   WHERE guild_id = trim(p_guild_id) AND user_id = trim(p_user_id)
   FOR UPDATE;

  IF EXISTS (
    SELECT 1 FROM public.royal_room_ledger WHERE request_id = trim(p_request_id)
  ) THEN
    v_available := COALESCE(v_purchased, 0) - COALESCE(v_reserved, 0)
      - COALESCE(v_consumed, 0) + COALESCE(v_reversed, 0);
    RETURN jsonb_build_object(
      'guild_id', trim(p_guild_id),
      'user_id', trim(p_user_id),
      'available_rooms', GREATEST(v_available, 0),
      'redeemed', false,
      'idempotent', true
    );
  END IF;

  INSERT INTO public.royal_room_wallets (guild_id, user_id, purchased_rooms, updated_at)
    VALUES (trim(p_guild_id), trim(p_user_id), p_rooms_quantity, now())
    ON CONFLICT (guild_id, user_id) DO UPDATE
      SET purchased_rooms = public.royal_room_wallets.purchased_rooms + EXCLUDED.purchased_rooms,
          updated_at = now();

  INSERT INTO public.royal_room_ledger (
    guild_id, user_id, request_id, event_type, delta_rooms, detail
  ) VALUES (
    trim(p_guild_id), trim(p_user_id), trim(p_request_id), 'admin_grant', p_rooms_quantity,
    jsonb_build_object('source', 'initial_redemption', 'rooms_quantity', p_rooms_quantity)
  );

  SELECT purchased_rooms, reserved_rooms, consumed_rooms, reversed_rooms
    INTO v_purchased, v_reserved, v_consumed, v_reversed
    FROM public.royal_room_wallets
   WHERE guild_id = trim(p_guild_id) AND user_id = trim(p_user_id);

  v_available := v_purchased - v_reserved - v_consumed + v_reversed;
  RETURN jsonb_build_object(
    'guild_id', trim(p_guild_id),
    'user_id', trim(p_user_id),
    'available_rooms', GREATEST(v_available, 0),
    'redeemed', true,
    'idempotent', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.royal_room_credit_initial_redemption(text, text, text, bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.royal_room_credit_initial_redemption(text, text, text, bigint)
  TO service_role;

COMMIT;
