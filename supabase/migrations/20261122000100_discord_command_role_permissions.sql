-- Permissões opt-in por cargo: comandos sem linhas seguem as permissões nativas do Discord.
CREATE TABLE IF NOT EXISTS public.discord_command_role_permissions (
  guild_id text NOT NULL,
  command_name text NOT NULL,
  role_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, command_name, role_id)
);

CREATE INDEX IF NOT EXISTS discord_command_role_permissions_guild_role_idx
  ON public.discord_command_role_permissions (guild_id, role_id, command_name);

ALTER TABLE public.discord_command_role_permissions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.discord_command_role_permissions FROM PUBLIC, anon, authenticated;
GRANT ALL PRIVILEGES ON TABLE public.discord_command_role_permissions TO service_role;

CREATE OR REPLACE FUNCTION public.discord_command_permissions_set_page(
  p_guild_id text,
  p_role_id text,
  p_command_names text[],
  p_allowed_names text[]
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_changed integer;
BEGIN
  IF p_guild_id IS NULL OR p_guild_id !~ '^\d{15,20}$' OR
     p_role_id IS NULL OR p_role_id !~ '^\d{15,20}$' THEN
    RAISE EXCEPTION 'IDs de servidor ou cargo inválidos.';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('discord-command-permissions:' || p_guild_id || ':' || p_role_id, 0));
  DELETE FROM public.discord_command_role_permissions
  WHERE guild_id = p_guild_id AND role_id = p_role_id
    AND command_name = ANY(coalesce(p_command_names, ARRAY[]::text[]));
  INSERT INTO public.discord_command_role_permissions (guild_id, command_name, role_id)
  SELECT p_guild_id, items.command_name, p_role_id
  FROM unnest(coalesce(p_allowed_names, ARRAY[]::text[])) AS items(command_name)
  WHERE items.command_name <> '' AND items.command_name = ANY(coalesce(p_command_names, ARRAY[]::text[]))
  ON CONFLICT (guild_id, command_name, role_id) DO NOTHING;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  RETURN v_changed;
END;
$$;

CREATE OR REPLACE FUNCTION public.discord_command_permissions_clear_role(
  p_guild_id text,
  p_role_id text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_deleted integer;
BEGIN
  IF p_guild_id IS NULL OR p_guild_id !~ '^\d{15,20}$' OR
     p_role_id IS NULL OR p_role_id !~ '^\d{15,20}$' THEN
    RAISE EXCEPTION 'IDs de servidor ou cargo inválidos.';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('discord-command-permissions:' || p_guild_id || ':' || p_role_id, 0));
  DELETE FROM public.discord_command_role_permissions
  WHERE guild_id = p_guild_id AND role_id = p_role_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.discord_command_permissions_set_page(text, text, text[], text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.discord_command_permissions_set_page(text, text, text[], text[]) TO service_role;
REVOKE ALL ON FUNCTION public.discord_command_permissions_clear_role(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.discord_command_permissions_clear_role(text, text) TO service_role;
