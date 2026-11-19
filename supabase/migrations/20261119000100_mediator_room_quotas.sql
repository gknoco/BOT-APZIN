CREATE TABLE IF NOT EXISTS public.royal_mediator_room_quotas (
  guild_id text NOT NULL,
  user_id text NOT NULL,
  salas_disponiveis bigint NOT NULL DEFAULT 10 CHECK (salas_disponiveis >= 0),
  criado_em timestamptz NOT NULL DEFAULT now(),
  atualizado_em timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);

ALTER TABLE public.royal_mediator_room_quotas ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.royal_mediator_ensure_room_quota(
  p_guild_id text, p_user_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_saldo bigint;
BEGIN
  IF COALESCE(trim(p_guild_id), '') = '' OR COALESCE(trim(p_user_id), '') = '' THEN
    RAISE EXCEPTION 'INVALID_MEDIATOR_QUOTA';
  END IF;
  INSERT INTO public.royal_mediator_room_quotas (guild_id, user_id)
    VALUES (trim(p_guild_id), trim(p_user_id))
    ON CONFLICT (guild_id, user_id) DO NOTHING;
  SELECT salas_disponiveis INTO v_saldo
    FROM public.royal_mediator_room_quotas
    WHERE guild_id = trim(p_guild_id) AND user_id = trim(p_user_id);
  RETURN jsonb_build_object('guild_id', trim(p_guild_id), 'user_id', trim(p_user_id), 'salas_disponiveis', v_saldo);
END; $$;

CREATE OR REPLACE FUNCTION public.royal_mediator_reserve_room_quota(
  p_guild_id text, p_user_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_saldo bigint;
BEGIN
  PERFORM public.royal_mediator_ensure_room_quota(p_guild_id, p_user_id);
  UPDATE public.royal_mediator_room_quotas
    SET salas_disponiveis = salas_disponiveis - 1, atualizado_em = now()
    WHERE guild_id = trim(p_guild_id) AND user_id = trim(p_user_id) AND salas_disponiveis > 0
    RETURNING salas_disponiveis INTO v_saldo;
  IF NOT FOUND THEN RAISE EXCEPTION 'MEDIATOR_ROOM_QUOTA_EXHAUSTED'; END IF;
  RETURN jsonb_build_object('guild_id', trim(p_guild_id), 'user_id', trim(p_user_id), 'salas_disponiveis', v_saldo);
END; $$;

CREATE OR REPLACE FUNCTION public.royal_mediator_restore_room_quota(
  p_guild_id text, p_user_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_saldo bigint;
BEGIN
  UPDATE public.royal_mediator_room_quotas
    SET salas_disponiveis = salas_disponiveis + 1, atualizado_em = now()
    WHERE guild_id = trim(p_guild_id) AND user_id = trim(p_user_id)
    RETURNING salas_disponiveis INTO v_saldo;
  IF NOT FOUND THEN
    INSERT INTO public.royal_mediator_room_quotas (guild_id, user_id, salas_disponiveis)
      VALUES (trim(p_guild_id), trim(p_user_id), 1)
      RETURNING salas_disponiveis INTO v_saldo;
  END IF;
  RETURN jsonb_build_object('guild_id', trim(p_guild_id), 'user_id', trim(p_user_id), 'salas_disponiveis', v_saldo);
END; $$;

REVOKE ALL ON TABLE public.royal_mediator_room_quotas FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.royal_mediator_ensure_room_quota(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.royal_mediator_reserve_room_quota(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.royal_mediator_restore_room_quota(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.royal_mediator_ensure_room_quota(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.royal_mediator_reserve_room_quota(text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.royal_mediator_restore_room_quota(text, text) TO service_role;
