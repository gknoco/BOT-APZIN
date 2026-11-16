-- Complemento da migração de persistência operacional BOT-APZIN.
-- Aplicar APÓS as migrações existentes; não substitui nem altera a migração central.
-- Auditoria reutiliza public.royal_audit_events (actor_id/action/detail/created_at).
BEGIN;

CREATE TABLE IF NOT EXISTS public.royal_paineis (
  guild_id text NOT NULL,
  modo text NOT NULL,
  canal_id text NOT NULL,
  mensagem_id text NOT NULL,
  criado_em bigint NOT NULL,
  PRIMARY KEY (guild_id, modo)
);

CREATE TABLE IF NOT EXISTS public.royal_mensagens_painel (
  guild_id text NOT NULL,
  modo text NOT NULL,
  preco integer NOT NULL,
  canal_id text NOT NULL,
  mensagem_id text NOT NULL,
  atualizado_em bigint NOT NULL,
  PRIMARY KEY (guild_id, modo, preco)
);

CREATE TABLE IF NOT EXISTS public.royal_plantao (
  guild_id text NOT NULL,
  user_id text NOT NULL,
  entrou_em bigint NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);
-- A migração central já cria essa tabela sem id. A coluna de desempate é complementar.
ALTER TABLE public.royal_plantao
  ADD COLUMN IF NOT EXISTS id bigint GENERATED ALWAYS AS IDENTITY;
CREATE UNIQUE INDEX IF NOT EXISTS royal_plantao_id ON public.royal_plantao (id);
CREATE INDEX IF NOT EXISTS royal_plantao_ordem
  ON public.royal_plantao (guild_id, entrou_em, id);

CREATE TABLE IF NOT EXISTS public.royal_logs_dm (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  guild_id text NOT NULL,
  user_id text NOT NULL,
  autor_id text NOT NULL,
  mensagem text NOT NULL,
  criado_em bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS royal_logs_dm_usuario
  ON public.royal_logs_dm (guild_id, user_id, criado_em DESC);

-- Substituição atômica das mensagens de um painel e da mensagem principal.
-- Serializa republicações concorrentes do mesmo servidor/modo.
CREATE OR REPLACE FUNCTION public.royal_registrar_mensagens_painel(
  p_guild_id text,
  p_modo text,
  p_canal_id text,
  p_mensagens jsonb,
  p_atualizado_em bigint
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_guild_id IS NULL OR p_modo IS NULL OR p_canal_id IS NULL
     OR p_atualizado_em IS NULL OR p_mensagens IS NULL
     OR jsonb_typeof(p_mensagens) <> 'array' THEN
    RAISE EXCEPTION 'Dados de painel inválidos';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array(p_guild_id, p_modo)::text, 0));

  DELETE FROM public.royal_mensagens_painel
    WHERE guild_id = p_guild_id AND modo = p_modo;
  INSERT INTO public.royal_mensagens_painel
    (guild_id, modo, preco, canal_id, mensagem_id, atualizado_em)
    SELECT p_guild_id, p_modo, x.preco, p_canal_id, x.mensagem_id, p_atualizado_em
    FROM jsonb_to_recordset(p_mensagens) AS x(preco integer, mensagem_id text);

  INSERT INTO public.royal_paineis (guild_id, modo, canal_id, mensagem_id, criado_em)
    VALUES (p_guild_id, p_modo, p_canal_id,
            coalesce(p_mensagens->0->>'mensagem_id', ''), p_atualizado_em)
    ON CONFLICT (guild_id, modo) DO UPDATE
      SET canal_id = EXCLUDED.canal_id,
          mensagem_id = EXCLUDED.mensagem_id,
          criado_em = EXCLUDED.criado_em;
END;
$$;

DO $$
DECLARE tabela text;
BEGIN
  FOREACH tabela IN ARRAY ARRAY[
    'royal_paineis', 'royal_mensagens_painel', 'royal_plantao', 'royal_logs_dm'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', tabela);
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC, anon, authenticated', tabela);
    EXECUTE format('GRANT ALL PRIVILEGES ON TABLE public.%I TO service_role', tabela);
    EXECUTE format('DROP POLICY IF EXISTS service_role_full_access ON public.%I', tabela);
    EXECUTE format('CREATE POLICY service_role_full_access ON public.%I FOR ALL TO service_role USING (true) WITH CHECK (true)', tabela);
  END LOOP;
END;
$$;
GRANT USAGE, SELECT ON SEQUENCE public.royal_plantao_id_seq, public.royal_logs_dm_id_seq TO service_role;
REVOKE ALL ON FUNCTION public.royal_registrar_mensagens_painel(text, text, text, jsonb, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.royal_registrar_mensagens_painel(text, text, text, jsonb, bigint) TO service_role;

COMMIT;
