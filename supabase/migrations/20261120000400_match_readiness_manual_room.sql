-- Prontidão e sala manual não criam nem iniciam salas Nix.
BEGIN;

-- A versão invalida cartões/formulários renderizados antes de uma correção.
ALTER TABLE public.royal_partidas ADD COLUMN IF NOT EXISTS sala_versao bigint NOT NULL DEFAULT 0;

-- O UPDATE já detém o lock da partida; dar_go toma o mesmo lock antes de
-- inserir uma prontidão. Protege também escritas diretas e o caminho Nix
-- legado, não apenas a RPC de publicação manual. A versão é calculada aqui
-- para que nenhuma das rotas possa esquecer ou duplicar o incremento.
CREATE OR REPLACE FUNCTION public.royal_operacional_proteger_sala()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF ROW(NEW.sala_id,NEW.sala_senha,NEW.nix_sessao)
       IS DISTINCT FROM ROW(OLD.sala_id,OLD.sala_senha,OLD.nix_sessao)
     OR (OLD.status='pago' AND NEW.status='sala_liberada') THEN
    IF EXISTS(SELECT 1 FROM royal_partida_go WHERE partida_id=OLD.id) THEN
      RAISE EXCEPTION 'Já existe prontidão registrada. Não é possível corrigir ID ou senha; cancele e refaça a partida, se necessário.';
    END IF;
    NEW.sala_versao:=OLD.sala_versao+1;
  ELSE
    -- Nenhuma outra atualização pode reduzir ou forjar a versão do cartão.
    NEW.sala_versao:=OLD.sala_versao;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS royal_partida_proteger_sala ON public.royal_partidas;
CREATE TRIGGER royal_partida_proteger_sala BEFORE UPDATE ON public.royal_partidas
  FOR EACH ROW EXECUTE FUNCTION public.royal_operacional_proteger_sala();
REVOKE ALL ON FUNCTION public.royal_operacional_proteger_sala() FROM PUBLIC,anon,authenticated,service_role;

-- A integração Nix ainda usa este contrato. Os ramos não relacionados à
-- sala permanecem iguais; após prontidão, somente um replay idêntico é no-op.
CREATE OR REPLACE FUNCTION public.royal_operacional_alterar_partida(p_id text,p_acao text,p_dados jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_partida royal_partidas%rowtype;
BEGIN
  SELECT * INTO v_partida FROM royal_partidas WHERE id=p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Partida não encontrada.'; END IF;
  CASE p_acao
  WHEN 'regras' THEN
    IF v_partida.status IN ('finalizada','cancelada') THEN RAISE EXCEPTION 'Essa partida já foi encerrada.'; END IF;
    IF length(trim(coalesce(p_dados->>'regras','')))<5 THEN RAISE EXCEPTION 'Escreva a regra da partida (pelo menos 5 letras).'; END IF;
    UPDATE royal_partidas SET regras=left(trim(p_dados->>'regras'),900),regras_por=p_dados->>'autor_id' WHERE id=p_id;
  WHEN 'assumir' THEN
    IF v_partida.mediador_id IS NOT NULL AND v_partida.mediador_id IS DISTINCT FROM p_dados->>'mediador_id' THEN
      RAISE EXCEPTION 'Essa sala já tem um mediador responsável.';
    END IF;
    UPDATE royal_partidas SET mediador_id=p_dados->>'mediador_id',comissao=coalesce((p_dados->>'comissao')::double precision,0),status='aguardando_pagamento'
    WHERE id=p_id AND status IN ('confirmando','aguardando_mediador','aguardando_pagamento');
  WHEN 'pago' THEN
    IF v_partida.status NOT IN ('aguardando_pagamento','pago') THEN RAISE EXCEPTION 'Só dá para confirmar pagamento com o mediador já na sala.'; END IF;
    UPDATE royal_partidas SET status='pago',pago_em=royal_operacional_agora() WHERE id=p_id;
  WHEN 'sala' THEN
    IF v_partida.status NOT IN ('pago','sala_liberada') THEN RAISE EXCEPTION 'Confirme o pagamento antes de liberar a criação da sala.'; END IF;
    IF nullif(trim(p_dados->>'sala_id'),'') IS NULL THEN RAISE EXCEPTION 'Informe o ID da sala.'; END IF;
    IF EXISTS(SELECT 1 FROM royal_partida_go WHERE partida_id=p_id) THEN
      IF v_partida.status='sala_liberada'
        AND v_partida.sala_id IS NOT DISTINCT FROM left(trim(p_dados->>'sala_id'),40)
        AND v_partida.sala_senha IS NOT DISTINCT FROM left(trim(p_dados->>'sala_senha'),40)
        AND v_partida.nix_sessao IS NOT DISTINCT FROM coalesce(nullif(left(trim(p_dados->>'nix_sessao'),64),''),v_partida.nix_sessao) THEN
        RETURN to_jsonb(v_partida);
      END IF;
      RAISE EXCEPTION 'Já existe prontidão registrada. Não é possível corrigir ID ou senha; cancele e refaça a partida, se necessário.';
    END IF;
    UPDATE royal_partidas SET sala_id=left(trim(p_dados->>'sala_id'),40),sala_senha=left(trim(p_dados->>'sala_senha'),40),
      nix_sessao=coalesce(nullif(left(trim(p_dados->>'nix_sessao'),64),''),nix_sessao),
      status='sala_liberada',liberada_em=royal_operacional_agora() WHERE id=p_id;
  ELSE RAISE EXCEPTION 'Transição operacional inválida: %',p_acao;
  END CASE;
  SELECT * INTO v_partida FROM royal_partidas WHERE id=p_id;
  RETURN to_jsonb(v_partida);
END $$;
REVOKE ALL ON FUNCTION public.royal_operacional_alterar_partida(text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.royal_operacional_alterar_partida(text,text,jsonb) TO service_role;

-- Elimina os contratos antigos que não verificavam o cartão sob o lock.
DROP FUNCTION IF EXISTS public.royal_operacional_dar_go(text,text);
DROP FUNCTION IF EXISTS public.royal_operacional_publicar_sala_manual(text,text,text,text,text,text);

CREATE OR REPLACE FUNCTION public.royal_operacional_dar_go(
  p_id text,p_user_id text,p_guild_id text,p_canal_id text,p_mensagem_id text,p_sala_versao bigint
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_partida royal_partidas%rowtype; v_total bigint; v_deram bigint; v_inseridos integer; v_iniciou boolean:=false;
BEGIN
  SELECT * INTO v_partida FROM royal_partidas WHERE id=p_id FOR UPDATE;
  IF NOT FOUND OR v_partida.guild_id IS DISTINCT FROM p_guild_id OR v_partida.canal_id IS DISTINCT FROM p_canal_id THEN
    RAISE EXCEPTION 'Partida não encontrada neste servidor e canal.';
  END IF;
  IF p_mensagem_id IS NULL OR v_partida.mensagem_id IS DISTINCT FROM p_mensagem_id THEN
    RAISE EXCEPTION 'Use o cartão atual da partida.';
  END IF;
  IF p_sala_versao IS NULL OR v_partida.sala_versao IS DISTINCT FROM p_sala_versao THEN
    RAISE EXCEPTION 'As credenciais foram alteradas. Atualize o cartão e confira os novos dados antes de sinalizar prontidão.';
  END IF;
  IF v_partida.status IN ('finalizada','cancelada') THEN RAISE EXCEPTION 'Essa partida já foi encerrada.'; END IF;
  IF v_partida.status NOT IN ('sala_liberada','em_andamento') THEN
    RAISE EXCEPTION 'A sala do jogo ainda não foi liberada. A prontidão só vale depois que o mediador publicar o ID e a senha.';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM royal_partida_jogadores WHERE partida_id=p_id AND user_id=p_user_id) THEN RAISE EXCEPTION 'Você não está nessa partida.'; END IF;
  INSERT INTO royal_partida_go(partida_id,user_id,criado_em) VALUES(p_id,p_user_id,royal_operacional_agora()) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_inseridos=ROW_COUNT;
  SELECT count(*) INTO v_total FROM royal_partida_jogadores WHERE partida_id=p_id;
  SELECT count(*) INTO v_deram FROM royal_partida_go WHERE partida_id=p_id;
  IF v_deram>=v_total AND v_partida.status='sala_liberada' THEN
    UPDATE royal_partidas SET status='em_andamento' WHERE id=p_id RETURNING * INTO v_partida;
    v_iniciou:=true;
  END IF;
  RETURN jsonb_build_object('jaDeu',v_inseridos=0,'deram',least(v_deram,v_total),'total',v_total,'iniciou',v_iniciou,'partida',to_jsonb(v_partida));
END $$;

CREATE OR REPLACE FUNCTION public.royal_operacional_publicar_sala_manual(
  p_id text,p_guild_id text,p_canal_id text,p_mensagem_id text,p_mediador_id text,
  p_sala_versao bigint,p_sala_id text,p_senha text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_partida royal_partidas%rowtype; v_sala text:=left(trim(p_sala_id),40); v_senha text:=nullif(left(trim(p_senha),40),'');
BEGIN
  SELECT * INTO v_partida FROM royal_partidas WHERE id=p_id FOR UPDATE;
  IF NOT FOUND OR v_partida.guild_id IS DISTINCT FROM p_guild_id OR v_partida.canal_id IS DISTINCT FROM p_canal_id THEN
    RAISE EXCEPTION 'Partida não encontrada neste servidor e canal.';
  END IF;
  IF p_mensagem_id IS NULL OR v_partida.mensagem_id IS DISTINCT FROM p_mensagem_id THEN
    RAISE EXCEPTION 'Use o cartão atual da partida.';
  END IF;
  IF v_partida.mediador_id IS NULL OR v_partida.mediador_id IS DISTINCT FROM p_mediador_id THEN
    RAISE EXCEPTION 'Somente o mediador responsável pode informar a sala.';
  END IF;
  IF nullif(v_sala,'') IS NULL THEN RAISE EXCEPTION 'Informe o ID da sala.'; END IF;
  -- Reenvio idêntico é seguro mesmo após progresso da partida ou perda da resposta.
  IF v_partida.status IN ('sala_liberada','em_andamento') AND v_partida.sala_id IS NOT DISTINCT FROM v_sala
     AND nullif(v_partida.sala_senha,'') IS NOT DISTINCT FROM v_senha THEN
    RETURN to_jsonb(v_partida);
  END IF;
  -- dar_go também trava esta linha antes de inserir. Assim, qualquer
  -- prontidão já registrada prevalece sobre uma correção concorrente.
  IF EXISTS(SELECT 1 FROM royal_partida_go WHERE partida_id=p_id) THEN
    RAISE EXCEPTION 'Já existe prontidão registrada. Não é possível corrigir ID ou senha; cancele e refaça a partida, se necessário.';
  END IF;
  IF v_partida.status NOT IN ('pago','sala_liberada') THEN
    RAISE EXCEPTION 'Não é possível alterar a sala após o início ou encerramento da partida.';
  END IF;
  IF p_sala_versao IS NULL OR v_partida.sala_versao IS DISTINCT FROM p_sala_versao THEN
    RAISE EXCEPTION 'Este formulário está desatualizado. Abra o cartão atual e confira os dados antes de corrigir.';
  END IF;
  UPDATE royal_partidas SET sala_id=v_sala,sala_senha=v_senha,status='sala_liberada',
    liberada_em=royal_operacional_agora() WHERE id=p_id RETURNING * INTO v_partida;
  RETURN to_jsonb(v_partida);
END $$;

REVOKE ALL ON FUNCTION public.royal_operacional_dar_go(text,text,text,text,text,bigint) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.royal_operacional_dar_go(text,text,text,text,text,bigint) TO service_role;
REVOKE ALL ON FUNCTION public.royal_operacional_publicar_sala_manual(text,text,text,text,text,bigint,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.royal_operacional_publicar_sala_manual(text,text,text,text,text,bigint,text,text) TO service_role;
COMMIT;
