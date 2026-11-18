-- Contadores do InviteTracker: total de entradas, saídas e membros convidados ativos.
CREATE TABLE IF NOT EXISTS public.royal_invite_stats (
  guild_id text NOT NULL,
  user_id text NOT NULL,
  invites_total integer NOT NULL DEFAULT 0 CHECK (invites_total >= 0),
  invites_saidas integer NOT NULL DEFAULT 0 CHECK (invites_saidas >= 0),
  invites_reais integer NOT NULL DEFAULT 0 CHECK (invites_reais >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);

INSERT INTO public.royal_invite_stats (guild_id, user_id, invites_total, invites_reais)
SELECT guild_id, inviter_user_id, count(*)::integer, count(*)::integer
FROM public.royal_invites
WHERE inviter_user_id IS NOT NULL
GROUP BY guild_id, inviter_user_id
ON CONFLICT (guild_id, user_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS royal_invite_stats_rank
  ON public.royal_invite_stats (guild_id, invites_reais DESC, invites_total DESC);

CREATE OR REPLACE FUNCTION public.royal_record_invite_join(
  p_guild_id text,
  p_invited_user_id text,
  p_inviter_user_id text,
  p_code text DEFAULT NULL,
  p_confidence text DEFAULT 'observed'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_inserted boolean := false;
  v_stats public.royal_invite_stats;
BEGIN
  INSERT INTO public.royal_invites (guild_id, invited_user_id, inviter_user_id, code, confidence)
  VALUES (trim(p_guild_id), trim(p_invited_user_id), nullif(trim(p_inviter_user_id), ''), p_code,
    CASE WHEN p_confidence = 'unknown' THEN 'unknown' ELSE 'observed' END)
  ON CONFLICT (guild_id, invited_user_id) DO NOTHING;
  v_inserted := FOUND;

  IF v_inserted AND p_inviter_user_id IS NOT NULL THEN
    INSERT INTO public.royal_invite_stats (guild_id, user_id, invites_total, invites_reais, updated_at)
    VALUES (trim(p_guild_id), trim(p_inviter_user_id), 1, 1, now())
    ON CONFLICT (guild_id, user_id) DO UPDATE SET
      invites_total = public.royal_invite_stats.invites_total + 1,
      invites_reais = public.royal_invite_stats.invites_reais + 1,
      updated_at = now();
  END IF;

  IF p_inviter_user_id IS NULL THEN RETURN '{}'::jsonb; END IF;
  SELECT * INTO v_stats FROM public.royal_invite_stats
  WHERE guild_id = trim(p_guild_id) AND user_id = trim(p_inviter_user_id);
  RETURN jsonb_build_object('inviter_user_id', v_stats.user_id, 'invites_total', v_stats.invites_total,
    'invites_saidas', v_stats.invites_saidas, 'invites_reais', v_stats.invites_reais);
END $$;

CREATE OR REPLACE FUNCTION public.royal_record_invite_leave(
  p_guild_id text, p_invited_user_id text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_inviter text;
  v_stats public.royal_invite_stats;
BEGIN
  SELECT inviter_user_id INTO v_inviter
  FROM public.royal_invites
  WHERE guild_id = trim(p_guild_id) AND invited_user_id = trim(p_invited_user_id)
  FOR UPDATE;
  IF v_inviter IS NULL THEN RETURN '{}'::jsonb; END IF;

  DELETE FROM public.royal_invites
  WHERE guild_id = trim(p_guild_id) AND invited_user_id = trim(p_invited_user_id);

  INSERT INTO public.royal_invite_stats (guild_id, user_id, invites_saidas, updated_at)
  VALUES (trim(p_guild_id), trim(v_inviter), 1, now())
  ON CONFLICT (guild_id, user_id) DO UPDATE SET
    invites_saidas = public.royal_invite_stats.invites_saidas + 1,
    invites_reais = greatest(public.royal_invite_stats.invites_reais - 1, 0),
    updated_at = now();

  SELECT * INTO v_stats FROM public.royal_invite_stats
  WHERE guild_id = trim(p_guild_id) AND user_id = trim(v_inviter);
  RETURN jsonb_build_object('inviter_user_id', v_inviter, 'invites_total', v_stats.invites_total,
    'invites_saidas', v_stats.invites_saidas, 'invites_reais', v_stats.invites_reais);
END $$;

DROP FUNCTION IF EXISTS public.royal_invite_ranking(text, integer);
CREATE OR REPLACE FUNCTION public.royal_invite_ranking(p_guild_id text, p_limit integer DEFAULT 10)
RETURNS TABLE(user_id text, total bigint) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT s.user_id, s.invites_reais::bigint AS total
  FROM public.royal_invite_stats s
  WHERE s.guild_id = p_guild_id AND s.invites_reais > 0
  ORDER BY s.invites_reais DESC, s.user_id
  LIMIT greatest(1, least(coalesce(p_limit, 10), 100))
$$;

REVOKE ALL ON TABLE public.royal_invite_stats FROM anon, authenticated;
GRANT ALL ON TABLE public.royal_invite_stats TO service_role;
REVOKE ALL ON FUNCTION public.royal_record_invite_join(text, text, text, text, text) FROM public, anon, authenticated;
REVOKE ALL ON FUNCTION public.royal_record_invite_leave(text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.royal_record_invite_join(text, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.royal_record_invite_leave(text, text) TO service_role;
REVOKE ALL ON FUNCTION public.royal_invite_ranking(text, integer) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.royal_invite_ranking(text, integer) TO service_role;
