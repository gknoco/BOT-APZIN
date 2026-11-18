-- Plantões separados para SS Mobile e SS EMU, sem misturar com o bate-ponto geral.
CREATE TABLE IF NOT EXISTS public.royal_plantao_modalidades (
  id bigint generated always as identity primary key,
  guild_id text NOT NULL,
  user_id text NOT NULL,
  modalidade text NOT NULL CHECK (modalidade IN ('ss_mobile', 'ss_emu')),
  entrou_em bigint NOT NULL,
  UNIQUE (guild_id, user_id, modalidade)
);

CREATE INDEX IF NOT EXISTS royal_plantao_modalidades_ordem
  ON public.royal_plantao_modalidades (guild_id, modalidade, entrou_em, id);

REVOKE ALL ON TABLE public.royal_plantao_modalidades FROM anon, authenticated;
GRANT ALL ON TABLE public.royal_plantao_modalidades TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.royal_plantao_modalidades_id_seq TO service_role;
