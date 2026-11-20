-- Blacklist e filas: serialização transacional também para escritores diretos.
-- Ordem obrigatória: advisory GLOBAL -> advisory da guild -> advisory da fila -> linhas.
-- O global é necessário porque um UPDATE/DELETE direto só conhece suas guilds
-- depois de iniciar a instrução; o trigger por linha seria tarde demais.
-- Quem usar SELECT FOR UPDATE antes de escrever deve chamar primeiro
-- royal_blacklist_fila_lock() na mesma transação, antes de obter qualquer linha.
BEGIN;

CREATE INDEX IF NOT EXISTS royal_filas_blacklist_usuario_idx ON public.royal_filas(guild_id,user_id);

-- READ COMMITTED atualiza o snapshot após esperar pelo lock. Um snapshot de
-- REPEATABLE READ/SERIALIZABLE tomado antes do bloqueio poderia não enxergar
-- a blacklist recém-confirmada; falhar é mais seguro do que admitir o jogador.
CREATE OR REPLACE FUNCTION public.royal_blacklist_fila_lock()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION USING ERRCODE='25001', MESSAGE='Blacklist e filas exigem transação READ COMMITTED.';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('royal-blacklist-filas-global-v1',0));
END $$;

-- BEFORE STATEMENT roda antes de qualquer row lock, inclusive UPDATE e DELETE.
-- A granularidade global sacrifica paralelismo entre guilds em troca de ordem
-- inequívoca para instruções diretas, inclusive as que afetam várias guilds.
CREATE OR REPLACE FUNCTION public.royal_blacklist_fila_antes()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  PERFORM royal_blacklist_fila_lock();
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION public.royal_blacklist_fila_depois()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  DELETE FROM royal_filas WHERE guild_id=NEW.guild_id AND user_id=NEW.user_id;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS royal_blacklist_fila_antes ON public.royal_blacklist;
CREATE TRIGGER royal_blacklist_fila_antes BEFORE INSERT OR UPDATE OR DELETE ON public.royal_blacklist
  FOR EACH STATEMENT EXECUTE FUNCTION public.royal_blacklist_fila_antes();
DROP TRIGGER IF EXISTS royal_blacklist_fila_depois ON public.royal_blacklist;
CREATE TRIGGER royal_blacklist_fila_depois AFTER INSERT OR UPDATE ON public.royal_blacklist
  FOR EACH ROW EXECUTE FUNCTION public.royal_blacklist_fila_depois();

DROP TRIGGER IF EXISTS royal_filas_lock_antes ON public.royal_filas;
CREATE TRIGGER royal_filas_lock_antes BEFORE INSERT OR UPDATE OR DELETE ON public.royal_filas
  FOR EACH STATEMENT EXECUTE FUNCTION public.royal_blacklist_fila_antes();

CREATE OR REPLACE FUNCTION public.royal_fila_verificar_blacklist()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_motivo text;
BEGIN
  SELECT motivo INTO v_motivo FROM royal_blacklist WHERE guild_id=NEW.guild_id AND user_id=NEW.user_id;
  IF FOUND THEN
    RAISE EXCEPTION USING ERRCODE='PBL01', MESSAGE='Você está na lista negra da ORG: **' || v_motivo || '**.';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS royal_fila_verificar_blacklist ON public.royal_filas;
CREATE TRIGGER royal_fila_verificar_blacklist BEFORE INSERT OR UPDATE OF guild_id,user_id ON public.royal_filas
  FOR EACH ROW EXECUTE FUNCTION public.royal_fila_verificar_blacklist();

-- Remove resíduos anteriores à instalação, sem tocar em partidas já formadas.
DELETE FROM public.royal_filas f USING public.royal_blacklist b
WHERE f.guild_id=b.guild_id AND f.user_id=b.user_id;

-- O retorno identifica somente os painéis afetados, para atualização best effort
-- após o commit; falhas do Discord nunca revertem nem mascaram o bloqueio.
CREATE OR REPLACE FUNCTION public.royal_operacional_adicionar_blacklist(
  p_guild_id text,p_user_id text,p_motivo text,p_autor_id text,p_criado_em bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_registro royal_blacklist%rowtype; v_filas jsonb;
BEGIN
  IF length(trim(coalesce(p_motivo,'')))<3 THEN RAISE EXCEPTION 'Escreva o motivo (pelo menos 3 letras).'; END IF;
  PERFORM royal_blacklist_fila_lock();
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('royal-blacklist-filas',p_guild_id)::text,0));
  SELECT coalesce(jsonb_agg(to_jsonb(q) ORDER BY q.modo,q.preco),'[]'::jsonb) INTO v_filas
  FROM (SELECT DISTINCT modo,preco FROM royal_filas WHERE guild_id=p_guild_id AND user_id=p_user_id) q;
  INSERT INTO royal_blacklist(guild_id,user_id,motivo,autor_id,criado_em)
  VALUES(p_guild_id,p_user_id,left(trim(p_motivo),300),p_autor_id,p_criado_em)
  ON CONFLICT(guild_id,user_id) DO UPDATE SET motivo=excluded.motivo,autor_id=excluded.autor_id,criado_em=excluded.criado_em
  RETURNING * INTO v_registro;
  RETURN jsonb_build_object('registro',to_jsonb(v_registro),'filas_afetadas',v_filas);
END $$;

CREATE OR REPLACE FUNCTION public.royal_operacional_entrar_fila(
  p_guild_id text,p_modo text,p_preco integer,p_gelo text,p_user_id text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_inseridos integer; v_posicao bigint;
BEGIN
  PERFORM royal_blacklist_fila_lock();
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('royal-blacklist-filas',p_guild_id)::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('royal-fila',p_guild_id,p_modo,p_preco,p_gelo)::text,0));
  INSERT INTO royal_filas(guild_id,modo,preco,gelo,user_id,entrou_em)
  VALUES(p_guild_id,p_modo,p_preco,p_gelo,p_user_id,royal_operacional_agora()) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_inseridos = ROW_COUNT;
  SELECT q.posicao INTO v_posicao FROM (
    SELECT user_id,row_number() OVER (ORDER BY entrou_em,id) AS posicao FROM royal_filas
    WHERE guild_id=p_guild_id AND modo=p_modo AND preco=p_preco AND gelo=p_gelo
  ) q WHERE q.user_id=p_user_id;
  RETURN jsonb_build_object('entrou',v_inseridos=1,'posicao',v_posicao);
END $$;

-- Um DELETE direto pode tomar o snapshot antes de esperar no trigger BEFORE
-- STATEMENT. O lock deve ser obtido em outro comando PL/pgSQL; só então o
-- DELETE usa um snapshot READ COMMITTED novo, inclusive após aguardar INSERT.
CREATE OR REPLACE FUNCTION public.royal_operacional_remover_filas(
  p_guild_id text,p_modo text,p_preco integer,p_gelo text,p_user_id text,p_user_ids text[]
) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_removidos integer;
BEGIN
  IF nullif(trim(p_guild_id),'') IS NULL THEN RAISE EXCEPTION 'Servidor obrigatório.'; END IF;
  PERFORM royal_blacklist_fila_lock();
  DELETE FROM royal_filas f WHERE f.guild_id=p_guild_id
    AND (p_modo IS NULL OR f.modo=p_modo)
    AND (p_preco IS NULL OR f.preco=p_preco)
    AND (p_gelo IS NULL OR f.gelo=p_gelo)
    AND (p_user_id IS NULL OR f.user_id=p_user_id)
    AND (p_user_ids IS NULL OR f.user_id=ANY(p_user_ids));
  GET DIAGNOSTICS v_removidos=ROW_COUNT;
  RETURN v_removidos;
END $$;

CREATE OR REPLACE FUNCTION public.royal_operacional_remover_blacklist(p_guild_id text,p_user_id text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_removidos integer;
BEGIN
  IF nullif(trim(p_guild_id),'') IS NULL OR p_user_id IS NULL THEN RAISE EXCEPTION 'Servidor e usuário obrigatórios.'; END IF;
  PERFORM royal_blacklist_fila_lock();
  DELETE FROM royal_blacklist WHERE guild_id=p_guild_id AND user_id=p_user_id;
  GET DIAGNOSTICS v_removidos=ROW_COUNT;
  RETURN v_removidos;
END $$;

-- O ID é criado pelo cliente antes de qualquer chamada. Estados terminais também
-- são persistidos: inclusive cancelamento antes de um pedido de reserva atrasado.
CREATE TABLE IF NOT EXISTS public.royal_fila_reservas (
  id text PRIMARY KEY,
  partida_id text UNIQUE,
  guild_id text NOT NULL,
  modo text, preco integer, gelo text, quantidade integer,
  estado text NOT NULL CHECK (estado IN ('reservada','concluida','cancelada','insuficiente')),
  jogadores jsonb NOT NULL DEFAULT '[]'::jsonb,
  filas_originais jsonb NOT NULL DEFAULT '[]'::jsonb,
  canal_id text,
  jogadores_partida jsonb,
  criado_em bigint NOT NULL,
  atualizado_em bigint NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS royal_fila_reservas_canal_idx ON public.royal_fila_reservas(guild_id,canal_id) WHERE canal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS royal_fila_reservas_pendentes_idx ON public.royal_fila_reservas(guild_id,criado_em) WHERE estado='reservada';
ALTER TABLE public.royal_fila_reservas ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.royal_fila_reservas FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT ON TABLE public.royal_fila_reservas TO service_role;
DROP POLICY IF EXISTS royal_fila_reservas_service_read ON public.royal_fila_reservas;
CREATE POLICY royal_fila_reservas_service_read ON public.royal_fila_reservas FOR SELECT TO service_role USING (true);

CREATE OR REPLACE FUNCTION public.royal_fila_usuario_reservado(p_guild_id text,p_user_id text)
RETURNS boolean LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=public,pg_temp AS $$
  SELECT EXISTS (SELECT 1 FROM royal_fila_reservas r
    WHERE r.guild_id=p_guild_id AND r.estado='reservada' AND r.jogadores ? p_user_id)
$$;

-- IDs suspensos ainda pertencem à reserva, mesmo em outra guild. Cancelamento
-- muda o estado sob o mesmo lock antes de restaurá-los, preservando entrou_em,id.
-- Falhar fechado se já houver uma colisão anterior à instalação, inclusive
-- entre reservas ativas: a reconciliação desses dados não é automática.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM royal_fila_reservas r
    CROSS JOIN LATERAL jsonb_to_recordset(r.filas_originais) AS f(id bigint)
    WHERE r.estado='reservada'
    GROUP BY f.id
    HAVING count(*)>1 OR EXISTS (SELECT 1 FROM royal_filas q WHERE q.id=f.id)
  ) THEN
    RAISE EXCEPTION 'IDs de filas reservadas já colidem; reconcilie antes do corte.';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.royal_fila_verificar_id_reservado()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM royal_fila_reservas r
    CROSS JOIN LATERAL jsonb_to_recordset(r.filas_originais) AS f(id bigint)
    WHERE r.estado='reservada' AND f.id=NEW.id
  ) THEN
    RAISE EXCEPTION USING ERRCODE='PRV03', MESSAGE='ID de fila pertence a uma reserva pendente.';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS royal_fila_verificar_id_reservado ON public.royal_filas;
CREATE TRIGGER royal_fila_verificar_id_reservado BEFORE INSERT OR UPDATE OF id ON public.royal_filas
  FOR EACH ROW EXECUTE FUNCTION public.royal_fila_verificar_id_reservado();

CREATE OR REPLACE FUNCTION public.royal_fila_verificar_blacklist()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_motivo text;
BEGIN
  SELECT motivo INTO v_motivo FROM royal_blacklist WHERE guild_id=NEW.guild_id AND user_id=NEW.user_id;
  IF FOUND THEN
    RAISE EXCEPTION USING ERRCODE='PBL01', MESSAGE='Você está na lista negra da ORG: **' || v_motivo || '**.';
  END IF;
  IF royal_fila_usuario_reservado(NEW.guild_id,NEW.user_id) THEN
    RAISE EXCEPTION USING ERRCODE='PRV01', MESSAGE='Você já possui uma reserva de partida pendente neste servidor.';
  END IF;
  RETURN NEW;
END $$;

-- APIs antigas continuam presentes apenas para falhar fechado, mesmo se um
-- papel privilegiado ainda conhecer suas assinaturas.
CREATE OR REPLACE FUNCTION public.royal_operacional_reservar_fila(
  p_guild_id text,p_modo text,p_preco integer,p_gelo text,p_quantidade integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'API antiga de reserva desativada; use uma chave de reserva durável.'; END $$;
CREATE OR REPLACE FUNCTION public.royal_operacional_criar_partida(
  p_id text,p_guild_id text,p_modo text,p_preco integer,p_gelo text,p_canal_id text,p_jogadores jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN RAISE EXCEPTION 'API antiga de criação desativada; use uma reserva durável.'; END $$;

CREATE OR REPLACE FUNCTION public.royal_operacional_reservar_fila(
  p_reserva_id text,p_partida_id text,p_guild_id text,p_modo text,p_preco integer,p_gelo text,p_quantidade integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_reserva royal_fila_reservas%rowtype; v_ids bigint[]; v_jogadores jsonb; v_filas jsonb;
BEGIN
  IF nullif(trim(p_reserva_id),'') IS NULL OR nullif(trim(p_partida_id),'') IS NULL
     OR nullif(trim(p_guild_id),'') IS NULL OR nullif(trim(p_modo),'') IS NULL
     OR p_preco IS NULL OR nullif(trim(p_gelo),'') IS NULL OR p_quantidade IS NULL OR p_quantidade NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'Dados de reserva inválidos.';
  END IF;
  PERFORM royal_blacklist_fila_lock();
  SELECT * INTO v_reserva FROM royal_fila_reservas WHERE id=p_reserva_id FOR UPDATE;
  IF FOUND THEN
    IF v_reserva.guild_id IS DISTINCT FROM p_guild_id THEN RAISE EXCEPTION 'Reserva pertence a outro servidor.'; END IF;
    -- Tombstone instalado antes de a requisição de reserva chegar.
    IF v_reserva.estado='cancelada' AND v_reserva.partida_id IS NULL THEN RETURN to_jsonb(v_reserva); END IF;
    IF v_reserva.partida_id IS DISTINCT FROM p_partida_id OR v_reserva.modo IS DISTINCT FROM p_modo
      OR v_reserva.preco IS DISTINCT FROM p_preco OR v_reserva.gelo IS DISTINCT FROM p_gelo
      OR v_reserva.quantidade IS DISTINCT FROM p_quantidade THEN RAISE EXCEPTION 'Chave de reserva reutilizada com dados diferentes.'; END IF;
    RETURN to_jsonb(v_reserva);
  END IF;
  DELETE FROM royal_filas f USING royal_blacklist b
   WHERE f.guild_id=p_guild_id AND f.modo=p_modo AND f.preco=p_preco AND f.gelo=p_gelo
     AND b.guild_id=f.guild_id AND b.user_id=f.user_id;
  SELECT array_agg(q.id ORDER BY q.entrou_em,q.id),jsonb_agg(q.user_id ORDER BY q.entrou_em,q.id)
    INTO v_ids,v_jogadores FROM (
      SELECT f.id,f.user_id,f.entrou_em FROM royal_filas f
      WHERE f.guild_id=p_guild_id AND f.modo=p_modo AND f.preco=p_preco AND f.gelo=p_gelo
        AND NOT royal_fila_usuario_reservado(f.guild_id,f.user_id)
      ORDER BY f.entrou_em,f.id LIMIT p_quantidade FOR UPDATE
    ) q;
  IF coalesce(array_length(v_ids,1),0)<p_quantidade THEN
    INSERT INTO royal_fila_reservas(id,partida_id,guild_id,modo,preco,gelo,quantidade,estado,criado_em,atualizado_em)
      VALUES(p_reserva_id,p_partida_id,p_guild_id,p_modo,p_preco,p_gelo,p_quantidade,'insuficiente',royal_operacional_agora(),royal_operacional_agora()) RETURNING * INTO v_reserva;
    RETURN to_jsonb(v_reserva);
  END IF;
  -- Todas as outras inscrições dos selecionados ficam suspensas, para que não
  -- sejam selecionados noutra fila e também para que os painéis não os contem.
  SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY f.id),'[]'::jsonb) INTO v_filas
    FROM royal_filas f WHERE f.guild_id=p_guild_id AND v_jogadores ? f.user_id;
  INSERT INTO royal_fila_reservas(id,partida_id,guild_id,modo,preco,gelo,quantidade,estado,jogadores,filas_originais,criado_em,atualizado_em)
    VALUES(p_reserva_id,p_partida_id,p_guild_id,p_modo,p_preco,p_gelo,p_quantidade,'reservada',v_jogadores,v_filas,royal_operacional_agora(),royal_operacional_agora()) RETURNING * INTO v_reserva;
  DELETE FROM royal_filas f WHERE f.guild_id=p_guild_id AND v_jogadores ? f.user_id;
  RETURN to_jsonb(v_reserva);
END $$;

CREATE OR REPLACE FUNCTION public.royal_operacional_vincular_canal_reserva(p_reserva_id text,p_guild_id text,p_canal_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r royal_fila_reservas%rowtype;
BEGIN
  IF nullif(trim(p_canal_id),'') IS NULL THEN RAISE EXCEPTION 'Canal inválido.'; END IF;
  PERFORM royal_blacklist_fila_lock();
  SELECT * INTO r FROM royal_fila_reservas WHERE id=p_reserva_id AND guild_id=p_guild_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reserva não encontrada neste servidor.'; END IF;
  IF r.estado NOT IN ('reservada','concluida') THEN RAISE EXCEPTION 'Reserva não está ativa.'; END IF;
  IF r.canal_id IS NOT NULL AND r.canal_id IS DISTINCT FROM p_canal_id THEN RAISE EXCEPTION 'Reserva já vinculada a outro canal.'; END IF;
  IF r.canal_id IS NULL THEN
    UPDATE royal_fila_reservas SET canal_id=p_canal_id,atualizado_em=royal_operacional_agora() WHERE id=p_reserva_id RETURNING * INTO r;
  END IF;
  RETURN to_jsonb(r);
END $$;

CREATE OR REPLACE FUNCTION public.royal_operacional_criar_partida(
  p_reserva_id text,p_id text,p_guild_id text,p_modo text,p_preco integer,p_gelo text,p_canal_id text,p_jogadores jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r royal_fila_reservas%rowtype; v_partida royal_partidas%rowtype; v_ids jsonb;
BEGIN
  IF jsonb_typeof(p_jogadores) IS DISTINCT FROM 'array' OR jsonb_array_length(p_jogadores)=0 THEN RAISE EXCEPTION 'Não dá para criar partida sem jogadores.'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_jogadores) j
    WHERE jsonb_typeof(j) IS DISTINCT FROM 'object' OR nullif(j->>'user_id','') IS NULL
      OR coalesce(j->>'time','') NOT IN ('1','2')) THEN RAISE EXCEPTION 'Cada jogador precisa ter usuário e time 1 ou 2.'; END IF;
  SELECT jsonb_agg(j.valor->>'user_id' ORDER BY j.ordem) INTO v_ids FROM jsonb_array_elements(p_jogadores) WITH ORDINALITY j(valor,ordem);
  PERFORM royal_blacklist_fila_lock();
  SELECT * INTO r FROM royal_fila_reservas WHERE id=p_reserva_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Reserva não encontrada.'; END IF;
  IF r.partida_id IS DISTINCT FROM p_id OR r.guild_id IS DISTINCT FROM p_guild_id OR r.modo IS DISTINCT FROM p_modo
    OR r.preco IS DISTINCT FROM p_preco OR r.gelo IS DISTINCT FROM p_gelo OR r.canal_id IS DISTINCT FROM p_canal_id
    OR nullif(trim(p_canal_id),'') IS NULL OR r.jogadores IS DISTINCT FROM v_ids THEN
    RAISE EXCEPTION 'Dados da partida não correspondem à reserva.';
  END IF;
  IF r.estado='concluida' THEN
    IF r.jogadores_partida IS DISTINCT FROM p_jogadores THEN RAISE EXCEPTION 'Replay da partida com jogadores ou times diferentes.'; END IF;
    SELECT * INTO v_partida FROM royal_partidas WHERE id=p_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Partida concluída ausente; intervenção administrativa necessária.'; END IF;
    RETURN to_jsonb(v_partida);
  END IF;
  IF r.estado<>'reservada' THEN RAISE EXCEPTION USING ERRCODE='PRV02', MESSAGE='Reserva cancelada ou não disponível.'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements_text(r.jogadores) j(user_id) JOIN royal_blacklist b
    ON b.guild_id=p_guild_id AND b.user_id=j.user_id) THEN
    RAISE EXCEPTION USING ERRCODE='PBL01', MESSAGE='Não é possível formar a partida: há jogador na lista negra.';
  END IF;
  INSERT INTO royal_partidas(id,guild_id,modo,preco,gelo,canal_id,status,criado_em)
    VALUES(p_id,p_guild_id,p_modo,p_preco,p_gelo,p_canal_id,'confirmando',royal_operacional_agora()) RETURNING * INTO v_partida;
  INSERT INTO royal_partida_jogadores(partida_id,user_id,time,confirmou,ordem)
    SELECT p_id,j.valor->>'user_id',(j.valor->>'time')::integer,0,j.ordem::integer FROM jsonb_array_elements(p_jogadores) WITH ORDINALITY j(valor,ordem);
  UPDATE royal_fila_reservas SET estado='concluida',jogadores_partida=p_jogadores,atualizado_em=royal_operacional_agora() WHERE id=p_reserva_id;
  RETURN to_jsonb(v_partida);
END $$;

-- O tombstone é o fencing: se esta transação vencer, até um pedido de reserva
-- ou criação que ainda nem alcançou o servidor será impedido de confirmar.
CREATE OR REPLACE FUNCTION public.royal_operacional_cancelar_reserva(p_reserva_id text,p_guild_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE r royal_fila_reservas%rowtype;
BEGIN
  IF nullif(trim(p_reserva_id),'') IS NULL OR nullif(trim(p_guild_id),'') IS NULL THEN RAISE EXCEPTION 'Reserva ou servidor inválido.'; END IF;
  PERFORM royal_blacklist_fila_lock();
  SELECT * INTO r FROM royal_fila_reservas WHERE id=p_reserva_id FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO royal_fila_reservas(id,guild_id,estado,criado_em,atualizado_em)
      VALUES(p_reserva_id,p_guild_id,'cancelada',royal_operacional_agora(),royal_operacional_agora()) RETURNING * INTO r;
    RETURN to_jsonb(r);
  END IF;
  IF r.guild_id IS DISTINCT FROM p_guild_id THEN RAISE EXCEPTION 'Reserva pertence a outro servidor.'; END IF;
  IF r.estado<>'reservada' THEN RETURN to_jsonb(r); END IF;
  UPDATE royal_fila_reservas SET estado='cancelada',atualizado_em=royal_operacional_agora() WHERE id=p_reserva_id RETURNING * INTO r;
  INSERT INTO royal_filas(id,guild_id,modo,preco,gelo,user_id,entrou_em)
    SELECT f.id,f.guild_id,f.modo,f.preco,f.gelo,f.user_id,f.entrou_em
    FROM jsonb_to_recordset(r.filas_originais) AS f(id bigint,guild_id text,modo text,preco integer,gelo text,user_id text,entrou_em bigint)
    WHERE f.guild_id=r.guild_id
      AND NOT EXISTS (SELECT 1 FROM royal_blacklist b WHERE b.guild_id=f.guild_id AND b.user_id=f.user_id)
      AND NOT royal_fila_usuario_reservado(f.guild_id,f.user_id)
    ON CONFLICT(guild_id,modo,preco,gelo,user_id) DO NOTHING;
  RETURN to_jsonb(r);
END $$;

REVOKE ALL ON FUNCTION public.royal_fila_usuario_reservado(text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.royal_operacional_reservar_fila(text,text,integer,text,integer) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.royal_operacional_criar_partida(text,text,text,integer,text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;
REVOKE ALL ON FUNCTION public.royal_operacional_reservar_fila(text,text,text,text,integer,text,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.royal_operacional_vincular_canal_reserva(text,text,text) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.royal_operacional_criar_partida(text,text,text,text,integer,text,text,jsonb) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.royal_operacional_cancelar_reserva(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.royal_operacional_reservar_fila(text,text,text,text,integer,text,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.royal_operacional_vincular_canal_reserva(text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.royal_operacional_criar_partida(text,text,text,text,integer,text,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.royal_operacional_cancelar_reserva(text,text) TO service_role;

-- Importação legada: consulta e inserção no mesmo lock e transação, de modo que
-- bloqueios concorrentes não tornem uma filtragem no cliente obsoleta. Duplicatas
-- continuam ignoradas, demais erros abortam o lote sem perda silenciosa de dados.
CREATE OR REPLACE FUNCTION public.royal_operacional_importar_filas(p_filas jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_bloqueados integer; v_inseridos integer;
BEGIN
  IF jsonb_typeof(p_filas) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'As filas devem ser um array.'; END IF;
  PERFORM royal_blacklist_fila_lock();
  SELECT count(*) INTO v_bloqueados
  FROM jsonb_to_recordset(p_filas) AS f(guild_id text,user_id text)
  WHERE EXISTS (SELECT 1 FROM royal_blacklist b WHERE b.guild_id=f.guild_id AND b.user_id=f.user_id)
     OR royal_fila_usuario_reservado(f.guild_id,f.user_id);
  INSERT INTO royal_filas(guild_id,modo,preco,gelo,user_id,entrou_em)
  SELECT f.guild_id,f.modo,f.preco,f.gelo,f.user_id,f.entrou_em
  FROM jsonb_to_recordset(p_filas) AS f(guild_id text,modo text,preco integer,gelo text,user_id text,entrou_em bigint)
  WHERE NOT EXISTS (SELECT 1 FROM royal_blacklist b WHERE b.guild_id=f.guild_id AND b.user_id=f.user_id)
    AND NOT royal_fila_usuario_reservado(f.guild_id,f.user_id)
  ON CONFLICT(guild_id,modo,preco,gelo,user_id) DO NOTHING;
  GET DIAGNOSTICS v_inseridos = ROW_COUNT;
  RETURN jsonb_build_object('considerados',jsonb_array_length(p_filas),'inseridos',v_inseridos,'bloqueados',v_bloqueados);
END $$;

REVOKE ALL ON FUNCTION public.royal_operacional_entrar_fila(text,text,integer,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.royal_operacional_entrar_fila(text,text,integer,text,text) TO service_role;
REVOKE ALL ON FUNCTION public.royal_operacional_adicionar_blacklist(text,text,text,text,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.royal_operacional_adicionar_blacklist(text,text,text,text,bigint) TO service_role;
REVOKE ALL ON FUNCTION public.royal_operacional_importar_filas(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.royal_operacional_importar_filas(jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.royal_operacional_remover_filas(text,text,integer,text,text,text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.royal_operacional_remover_filas(text,text,integer,text,text,text[]) TO service_role;
REVOKE ALL ON FUNCTION public.royal_operacional_remover_blacklist(text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.royal_operacional_remover_blacklist(text,text) TO service_role;

-- REVOKE não remove grants de terceiros nem o poder do proprietário. MEMBER
-- inclui cadeias de membership mesmo com NOINHERIT/SET ROLE (e, de forma
-- conservadora, também memberships com SET desativado no PostgreSQL 16+).
-- Auditar cada papel alcançável, sem modificar grants de outros consumidores.
DO $$
DECLARE v_target record; v_role record; v_priv text; v_func text;
BEGIN
  FOR v_target IN SELECT oid,rolname FROM pg_catalog.pg_roles
                  WHERE rolname IN ('anon','authenticated','service_role') LOOP
    FOR v_role IN SELECT r.oid,r.rolname,r.rolsuper FROM pg_catalog.pg_roles r
                  WHERE pg_catalog.pg_has_role(v_target.oid,r.oid,'MEMBER') LOOP
      IF v_role.rolsuper THEN
        RAISE EXCEPTION 'Papel % pode assumir superusuário %; corte abortado.',v_target.rolname,v_role.rolname;
      END IF;
      FOREACH v_priv IN ARRAY ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
        IF pg_catalog.has_table_privilege(v_role.oid,'public.royal_fila_reservas'::regclass,v_priv) THEN
          RAISE EXCEPTION 'Reserva alterável por % via % (%); corte abortado.',v_target.rolname,v_role.rolname,v_priv;
        END IF;
      END LOOP;
      FOREACH v_priv IN ARRAY ARRAY['INSERT','UPDATE','REFERENCES'] LOOP
        IF pg_catalog.has_any_column_privilege(v_role.oid,'public.royal_fila_reservas'::regclass,v_priv) THEN
          RAISE EXCEPTION 'Grant de coluna % na reserva acessível a % via %; corte abortado.',v_priv,v_target.rolname,v_role.rolname;
        END IF;
      END LOOP;
      FOREACH v_func IN ARRAY ARRAY[
        'public.royal_operacional_reservar_fila(text,text,integer,text,integer)',
        'public.royal_operacional_criar_partida(text,text,text,integer,text,text,jsonb)'
      ] LOOP
        IF pg_catalog.has_function_privilege(v_role.oid,v_func,'EXECUTE') THEN
          RAISE EXCEPTION 'RPC legada % acessível a % via %; corte abortado.',v_func,v_target.rolname,v_role.rolname;
        END IF;
      END LOOP;
      -- service_role continua autorizado às RPCs atuais e à leitura da reserva.
      IF v_target.rolname IN ('anon','authenticated') THEN
        IF pg_catalog.has_table_privilege(v_role.oid,'public.royal_fila_reservas'::regclass,'SELECT') OR
           pg_catalog.has_any_column_privilege(v_role.oid,'public.royal_fila_reservas'::regclass,'SELECT') THEN
          RAISE EXCEPTION 'Reserva legível por % via %; corte abortado.',v_target.rolname,v_role.rolname;
        END IF;
        FOREACH v_func IN ARRAY ARRAY[
          'public.royal_operacional_reservar_fila(text,text,text,text,integer,text,integer)',
          'public.royal_operacional_vincular_canal_reserva(text,text,text)',
          'public.royal_operacional_criar_partida(text,text,text,text,integer,text,text,jsonb)',
          'public.royal_operacional_cancelar_reserva(text,text)',
          'public.royal_operacional_entrar_fila(text,text,integer,text,text)',
          'public.royal_operacional_importar_filas(jsonb)',
          'public.royal_operacional_adicionar_blacklist(text,text,text,text,bigint)',
          'public.royal_operacional_remover_filas(text,text,integer,text,text,text[])',
          'public.royal_operacional_remover_blacklist(text,text)'
        ] LOOP
          IF pg_catalog.has_function_privilege(v_role.oid,v_func,'EXECUTE') THEN
            RAISE EXCEPTION 'RPC de fila % acessível a % via %; corte abortado.',v_func,v_target.rolname,v_role.rolname;
          END IF;
        END LOOP;
      END IF;
    END LOOP;
  END LOOP;
END $$;

REVOKE ALL ON FUNCTION public.royal_blacklist_fila_lock() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.royal_blacklist_fila_lock() TO service_role;
REVOKE ALL ON FUNCTION public.royal_blacklist_fila_antes() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.royal_blacklist_fila_depois() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.royal_fila_verificar_blacklist() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.royal_fila_verificar_id_reservado() FROM PUBLIC,anon,authenticated;
COMMIT;
