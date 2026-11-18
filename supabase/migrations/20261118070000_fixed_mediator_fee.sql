-- Substitui a receita percentual legada pela taxa fixa de R$ 0,10 por capitão.
-- A coluna comissao permanece no schema apenas para compatibilidade com RPCs antigas.
CREATE OR REPLACE FUNCTION public.royal_operacional_receita(p_guild_id text,p_desde_ms bigint DEFAULT 0)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.taxa_mediador DESC,q.mediador_id),'[]'::jsonb)
  FROM (
    SELECT p.mediador_id,
      count(*) AS partidas,
      sum(p.preco::bigint * jogadores.quantidade) AS movimentado,
      sum(10 * capitães.quantidade)::bigint AS taxa_mediador
    FROM royal_partidas p
    CROSS JOIN LATERAL (
      SELECT count(*) AS quantidade
      FROM royal_partida_jogadores
      WHERE partida_id = p.id
    ) jogadores
    CROSS JOIN LATERAL (
      SELECT greatest(count(DISTINCT time), 1) AS quantidade
      FROM royal_partida_jogadores
      WHERE partida_id = p.id
    ) capitães
    WHERE p.guild_id = p_guild_id
      AND p.status = 'finalizada'
      AND p.mediador_id IS NOT NULL
      AND p.finalizada_em >= p_desde_ms
    GROUP BY p.mediador_id
  ) q
$$;
