-- Mantém o instante do último início de chamada mesmo após a partida terminar
-- ou a atribuição mudar. A mesma URL só pode ser escolhida novamente após 2h.
CREATE TABLE IF NOT EXISTS public.royal_telagem_cooldowns (
  guild_id text NOT NULL,
  url text NOT NULL,
  usado_em bigint NOT NULL,
  PRIMARY KEY (guild_id, url)
);

INSERT INTO public.royal_telagem_cooldowns(guild_id,url,usado_em)
SELECT guild_id,url,criado_em FROM public.royal_telagens
ON CONFLICT (guild_id,url) DO UPDATE SET usado_em=greatest(royal_telagem_cooldowns.usado_em,excluded.usado_em);

CREATE OR REPLACE FUNCTION public.royal_operacional_reservar_telagem(
  p_guild_id text,p_chave text,p_codigo text,p_links_ambiente text[] DEFAULT ARRAY[]::text[]
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_existente royal_telagens%rowtype;
  v_links text[];
  v_url text;
  v_now bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('royal-telagem:'||p_guild_id,0));
  v_now := royal_operacional_agora();

  SELECT * INTO v_existente FROM royal_telagens WHERE guild_id=p_guild_id AND chave=p_chave;
  IF FOUND THEN
    IF v_existente.criado_em > v_now - 7200000 OR EXISTS (
      SELECT 1 FROM royal_partidas p WHERE p.guild_id=p_guild_id
        AND v_existente.chave='partida:'||p.id AND p.status NOT IN ('finalizada','cancelada')
    ) THEN
      RETURN jsonb_build_object('chave',v_existente.chave,'url',v_existente.url,'codigo',v_existente.codigo,'origem','reservado');
    END IF;
    DELETE FROM royal_telagens WHERE guild_id=p_guild_id AND chave=p_chave;
  END IF;

  -- Atribuições expiradas e encerradas não bloqueiam mais, mas o registro de
  -- cooldown separado continua valendo até completar exatamente 7.200.000 ms.
  DELETE FROM royal_telagens t
  WHERE t.guild_id=p_guild_id
    AND NOT EXISTS (SELECT 1 FROM royal_partidas p WHERE p.guild_id=p_guild_id
      AND t.chave='partida:'||p.id AND p.status NOT IN ('finalizada','cancelada'))
    AND EXISTS (SELECT 1 FROM royal_telagem_cooldowns c WHERE c.guild_id=t.guild_id
      AND c.url=t.url AND c.usado_em <= v_now - 7200000);

  SELECT array_agg(q.url ORDER BY q.prioridade,q.criado_em,q.url) INTO v_links FROM (
    SELECT url,min(prioridade) AS prioridade,min(criado_em) AS criado_em FROM (
      SELECT url,0 AS prioridade,ordem::bigint AS criado_em FROM unnest(coalesce(p_links_ambiente,ARRAY[]::text[])) WITH ORDINALITY e(url,ordem)
      UNION ALL SELECT url,1,criado_em FROM royal_telagem_links WHERE guild_id=p_guild_id
    ) fontes WHERE url ~* '^https://meet[.]google[.]com/[A-Za-z0-9_/?=&.\-]+$' GROUP BY url
  ) q;
  IF coalesce(array_length(v_links,1),0)=0 THEN RETURN NULL; END IF;

  SELECT l.url INTO v_url FROM unnest(v_links) WITH ORDINALITY l(url,ordem)
  WHERE NOT EXISTS (SELECT 1 FROM royal_telagens t WHERE t.guild_id=p_guild_id AND t.url=l.url)
    AND NOT EXISTS (SELECT 1 FROM royal_telagem_cooldowns c WHERE c.guild_id=p_guild_id
      AND c.url=l.url AND c.usado_em > v_now - 7200000)
  ORDER BY l.ordem LIMIT 1;

  IF v_url IS NULL THEN
    RAISE EXCEPTION 'Nenhum link do Google Meet está disponível: os links estão em uso ou no cooldown de 2 horas. Tente novamente após a liberação ou adicione links com `/telagem_links adicionar`.';
  END IF;

  INSERT INTO royal_telagens(guild_id,chave,codigo,url,criado_em)
  VALUES(p_guild_id,p_chave,p_codigo,v_url,v_now);
  INSERT INTO royal_telagem_cooldowns(guild_id,url,usado_em) VALUES(p_guild_id,v_url,v_now)
  ON CONFLICT(guild_id,url) DO UPDATE SET usado_em=excluded.usado_em;
  RETURN jsonb_build_object('chave',p_chave,'url',v_url,'codigo',p_codigo,'origem','pool');
END $$;

CREATE OR REPLACE FUNCTION public.royal_operacional_fixar_telagem(
  p_guild_id text,p_chave text,p_url text,p_codigo text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE
  v_now bigint;
  v_existente royal_telagens%rowtype;
BEGIN
  IF p_url IS NULL OR p_url !~* '^https://meet[.]google[.]com/[A-Za-z0-9_/?=&.\-]+$' THEN
    RAISE EXCEPTION 'Link inválido. Use um link real do Meet.';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('royal-telagem:'||p_guild_id,0));
  v_now := royal_operacional_agora();

  SELECT * INTO v_existente FROM royal_telagens WHERE guild_id=p_guild_id AND chave=p_chave AND url=p_url;
  IF FOUND THEN
    RETURN jsonb_build_object('chave',p_chave,'url',p_url,'codigo',v_existente.codigo,'origem','manual');
  END IF;

  IF EXISTS (
    SELECT 1 FROM royal_telagens t WHERE t.guild_id=p_guild_id AND t.url=p_url AND t.chave<>p_chave
      AND (EXISTS (SELECT 1 FROM royal_partidas p WHERE p.guild_id=p_guild_id
        AND t.chave='partida:'||p.id AND p.status NOT IN ('finalizada','cancelada'))
        OR EXISTS (SELECT 1 FROM royal_telagem_cooldowns c WHERE c.guild_id=t.guild_id
          AND c.url=t.url AND c.usado_em > v_now - 7200000))
  ) OR EXISTS (SELECT 1 FROM royal_telagem_cooldowns c WHERE c.guild_id=p_guild_id
    AND c.url=p_url AND c.usado_em > v_now - 7200000) THEN
    RAISE EXCEPTION 'Esse link está em uso ou no cooldown de 2 horas para outra partida.';
  END IF;

  DELETE FROM royal_telagens t
  WHERE t.guild_id=p_guild_id AND t.url=p_url
    AND NOT EXISTS (SELECT 1 FROM royal_partidas p WHERE p.guild_id=p_guild_id
      AND t.chave='partida:'||p.id AND p.status NOT IN ('finalizada','cancelada'))
    AND NOT EXISTS (SELECT 1 FROM royal_telagem_cooldowns c WHERE c.guild_id=t.guild_id
      AND c.url=t.url AND c.usado_em > v_now - 7200000);
  DELETE FROM royal_telagens WHERE guild_id=p_guild_id AND chave=p_chave;
  INSERT INTO royal_telagens(guild_id,chave,codigo,url,criado_em) VALUES(p_guild_id,p_chave,p_codigo,p_url,v_now);
  INSERT INTO royal_telagem_cooldowns(guild_id,url,usado_em) VALUES(p_guild_id,p_url,v_now)
  ON CONFLICT(guild_id,url) DO UPDATE SET usado_em=excluded.usado_em;
  RETURN jsonb_build_object('chave',p_chave,'url',p_url,'codigo',p_codigo,'origem','manual');
END $$;

REVOKE ALL ON TABLE public.royal_telagem_cooldowns FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.royal_telagem_cooldowns TO service_role;
REVOKE ALL ON FUNCTION public.royal_operacional_reservar_telagem(text,text,text,text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.royal_operacional_fixar_telagem(text,text,text,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.royal_operacional_reservar_telagem(text,text,text,text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.royal_operacional_fixar_telagem(text,text,text,text) TO service_role;
