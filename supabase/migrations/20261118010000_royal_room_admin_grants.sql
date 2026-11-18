ALTER TABLE public.royal_room_ledger DROP CONSTRAINT IF EXISTS royal_room_ledger_event_type_check;
ALTER TABLE public.royal_room_ledger ADD CONSTRAINT royal_room_ledger_event_type_check
  CHECK (event_type IN ('purchase', 'reserved', 'created', 'released', 'reversed', 'admin_grant'));

CREATE OR REPLACE FUNCTION public.royal_room_admin_grant(
  p_guild_id text, p_user_id text, p_request_id text, p_rooms_quantity bigint, p_actor_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_purchased bigint; v_reserved bigint; v_consumed bigint; v_reversed bigint; v_balance bigint;
BEGIN
  IF COALESCE(trim(p_guild_id), '') = '' OR COALESCE(trim(p_user_id), '') = '' OR COALESCE(trim(p_request_id), '') = '' OR p_rooms_quantity < 1 THEN
    RAISE EXCEPTION 'INVALID_ADMIN_GRANT';
  END IF;
  IF EXISTS (SELECT 1 FROM public.royal_room_ledger WHERE request_id = p_request_id) THEN
    SELECT purchased_rooms, reserved_rooms, consumed_rooms, reversed_rooms INTO v_purchased, v_reserved, v_consumed, v_reversed
      FROM public.royal_room_wallets WHERE guild_id = p_guild_id AND user_id = p_user_id;
    RETURN jsonb_build_object('guild_id', p_guild_id, 'user_id', p_user_id, 'balance_rooms', COALESCE(v_purchased,0)-COALESCE(v_reserved,0)-COALESCE(v_consumed,0)+COALESCE(v_reversed,0));
  END IF;
  INSERT INTO public.royal_room_wallets (guild_id, user_id, purchased_rooms, updated_at)
    VALUES (p_guild_id, p_user_id, p_rooms_quantity, now())
    ON CONFLICT (guild_id, user_id) DO UPDATE SET purchased_rooms = public.royal_room_wallets.purchased_rooms + EXCLUDED.purchased_rooms, updated_at = now();
  INSERT INTO public.royal_room_ledger (guild_id, user_id, request_id, event_type, delta_rooms, detail)
    VALUES (p_guild_id, p_user_id, p_request_id, 'admin_grant', p_rooms_quantity, jsonb_build_object('actor_id', p_actor_id));
  SELECT purchased_rooms, reserved_rooms, consumed_rooms, reversed_rooms INTO v_purchased, v_reserved, v_consumed, v_reversed
    FROM public.royal_room_wallets WHERE guild_id = p_guild_id AND user_id = p_user_id;
  v_balance := v_purchased - v_reserved - v_consumed + v_reversed;
  RETURN jsonb_build_object('guild_id', p_guild_id, 'user_id', p_user_id, 'balance_rooms', v_balance);
END; $$;
