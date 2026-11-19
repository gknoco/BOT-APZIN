ALTER TABLE public.royal_mediator_room_quotas
  ADD COLUMN IF NOT EXISTS resgate_inicial_realizado boolean NOT NULL DEFAULT false;

CREATE OR REPLACE FUNCTION public.royal_mediator_redeem_initial_quota(
  p_guild_id text, p_user_id text, p_quantidade bigint DEFAULT 10
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_saldo bigint;
BEGIN
  IF COALESCE(trim(p_guild_id), '') = '' OR COALESCE(trim(p_user_id), '') = '' OR p_quantidade < 1 THEN
    RAISE EXCEPTION 'INVALID_MEDIATOR_INITIAL_REDEEM';
  END IF;

  INSERT INTO public.royal_mediator_room_quotas (guild_id, user_id, salas_disponiveis, resgate_inicial_realizado)
    VALUES (trim(p_guild_id), trim(p_user_id), 0, false)
    ON CONFLICT (guild_id, user_id) DO NOTHING;

  UPDATE public.royal_mediator_room_quotas
    SET salas_disponiveis = salas_disponiveis + p_quantidade,
        resgate_inicial_realizado = true,
        atualizado_em = now()
    WHERE guild_id = trim(p_guild_id) AND user_id = trim(p_user_id)
      AND resgate_inicial_realizado = false
    RETURNING salas_disponiveis INTO v_saldo;

  IF NOT FOUND THEN
    SELECT salas_disponiveis INTO v_saldo
      FROM public.royal_mediator_room_quotas
      WHERE guild_id = trim(p_guild_id) AND user_id = trim(p_user_id);
    RETURN jsonb_build_object(
      'guild_id', trim(p_guild_id), 'user_id', trim(p_user_id),
      'salas_disponiveis', COALESCE(v_saldo, 0), 'resgatado', false
    );
  END IF;

  RETURN jsonb_build_object(
    'guild_id', trim(p_guild_id), 'user_id', trim(p_user_id),
    'salas_disponiveis', v_saldo, 'resgatado', true
  );
END; $$;

REVOKE ALL ON FUNCTION public.royal_mediator_redeem_initial_quota(text, text, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.royal_mediator_redeem_initial_quota(text, text, bigint) TO service_role;
