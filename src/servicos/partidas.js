'use strict';

/** Estado operacional persistente. Transições críticas serializadas no PostgreSQL. */
const { TABELAS } = require('../db/esquema');
const { cliente, executar, contar, listarPaginado, rpc } = require('../db/consultas');

const STATUS = Object.freeze({
  CONFIRMANDO: 'confirmando', AGUARDANDO_MEDIADOR: 'aguardando_mediador',
  AGUARDANDO_PAGAMENTO: 'aguardando_pagamento', PAGO: 'pago',
  SALA_LIBERADA: 'sala_liberada', EM_ANDAMENTO: 'em_andamento',
  FINALIZADA: 'finalizada', CANCELADA: 'cancelada',
});
const ATIVOS = new Set([STATUS.CONFIRMANDO, STATUS.AGUARDANDO_MEDIADOR,
  STATUS.AGUARDANDO_PAGAMENTO, STATUS.PAGO, STATUS.SALA_LIBERADA, STATUS.EM_ANDAMENTO]);
const CAMPOS = 'id,guild_id,modo,preco,gelo,canal_id,mensagem_id,status,regras,regras_por,mediador_id,pix_chave,pix_titular,sala_id,sala_senha,sala_versao,vencedor_time,motivo_fim,comissao,criado_em,pago_em,liberada_em,finalizada_em,nix_sessao';
const CAMPOS_JOGADOR = 'partida_id,user_id,time,confirmou';

async function criar(db, { reservaId, partidaId, guildId, modo, preco, gelo, canalId, jogadores: lista }) {
  if (!reservaId || !partidaId) throw new Error('Reserva e partida exigem IDs estáveis.');
  if (!Array.isArray(lista) || !lista.length) throw new Error('Não dá para criar partida sem jogadores.');
  return rpc(db, 'royal_operacional_criar_partida', {
    p_reserva_id: String(reservaId), p_id: String(partidaId), p_guild_id: String(guildId), p_modo: String(modo),
    p_preco: Math.trunc(preco), p_gelo: String(gelo), p_canal_id: String(canalId),
    p_jogadores: lista.map((jogador) => ({ user_id: String(jogador.userId), time: Number(jogador.time) })),
  });
}

async function buscar(db, id, guildId = null) {
  let consulta = cliente(db).from(TABELAS.partidas).select(CAMPOS).eq('id', String(id));
  if (guildId) consulta = consulta.eq('guild_id', String(guildId));
  return await executar(consulta.maybeSingle(), 'buscar partida') || null;
}

async function jogadores(db, id) {
  return listarPaginado(() => cliente(db).from(TABELAS.partida_jogadores).select(CAMPOS_JOGADOR)
    .eq('partida_id', String(id)).order('time').order('ordem').order('user_id'), 'listar jogadores');
}

async function confirmados(db, id) {
  return contar(cliente(db).from(TABELAS.partida_jogadores).select('user_id', { head: true, count: 'exact' })
    .eq('partida_id', String(id)).eq('confirmou', 1), 'contar confirmações');
}

async function definirMensagem(db, id, mensagemId) {
  await executar(cliente(db).from(TABELAS.partidas).update({ mensagem_id: String(mensagemId) })
    .eq('id', String(id)), 'definir mensagem da partida');
}

async function porCanal(db, guildId, canalId) {
  const consulta = () => cliente(db).from(TABELAS.partidas).select(CAMPOS)
    .eq('guild_id', String(guildId)).eq('canal_id', String(canalId))
    .order('criado_em', { ascending: false }).order('id').limit(1);
  const ativa = await executar(consulta().in('status', [...ATIVOS]).maybeSingle(), 'buscar partida ativa do canal');
  return ativa || await executar(consulta().maybeSingle(), 'buscar última partida do canal') || null;
}

async function ativasDoJogador(db, guildId, userId) {
  const linhas = await listarPaginado(() => cliente(db).from(TABELAS.partidas)
    .select(`${CAMPOS},royal_partida_jogadores!inner(user_id)`)
    .eq('guild_id', String(guildId)).eq('royal_partida_jogadores.user_id', String(userId))
    .in('status', [STATUS.SALA_LIBERADA, STATUS.EM_ANDAMENTO])
    .order('criado_em', { ascending: false }).order('id'), 'listar partidas do jogador');
  return linhas.map(({ royal_partida_jogadores, ...partida }) => partida);
}

async function ativas(db, guildId) {
  return listarPaginado(() => cliente(db).from(TABELAS.partidas).select(CAMPOS)
    .eq('guild_id', String(guildId)).in('status', [...ATIVOS]).order('criado_em').order('id'), 'listar partidas ativas');
}

/** Lista somente salas ativas cujo canal privado ainda existe no Discord. */
async function ativasReais(db, guildId, client) {
  const candidatas = await ativas(db, guildId);
  const reais = [];
  for (const partida of candidatas) {
    const canalId = String(partida.canal_id || '').trim();
    const canal = canalId && client?.channels?.fetch
      ? client.channels.cache?.get?.(canalId) || await client.channels.fetch(canalId).catch(() => null)
      : null;
    const pertenceAoServidor = canal && String(canal.guildId || canal.guild?.id || '') === String(guildId);
    const canalDeTexto = canal && (typeof canal.isTextBased !== 'function' || canal.isTextBased());
    if (pertenceAoServidor && canalDeTexto) {
      reais.push(partida);
      continue;
    }
    try {
      await cancelar(db, {
        partidaId: partida.id,
        motivo: canalId ? 'canal da sala não existe mais' : 'partida sem canal de sala válido',
      });
      console.warn(`[partidas] partida ${partida.id} encerrada como órfã: canal ${canalId || '(vazio)'} inválido.`);
    } catch (erro) {
      console.error(`[partidas] não consegui limpar a partida órfã ${partida.id}:`, erro.message);
    }
  }
  return reais;
}

async function pendentes(db, guildId) {
  return listarPaginado(() => cliente(db).from(TABELAS.partidas).select(CAMPOS)
    .eq('guild_id', String(guildId)).eq('status', STATUS.AGUARDANDO_MEDIADOR).is('mediador_id', null)
    .order('criado_em').order('id'), 'listar partidas pendentes de mediador');
}

/** RPC específica de transições da partida; não interpreta SQL nem replica SQLite. */
async function alterar(db, id, acao, dados = {}) {
  return rpc(db, 'royal_operacional_alterar_partida', { p_id: String(id), p_acao: acao, p_dados: dados });
}

async function definirRegras(db, id, texto, autorId) {
  const limpo = String(texto || '').trim().slice(0, 900);
  if (limpo.length < 5) throw new Error('Escreva a regra da partida (pelo menos 5 letras).');
  return alterar(db, id, 'regras', { regras: limpo, autor_id: String(autorId) });
}

async function confirmar(db, id, userId) {
  return rpc(db, 'royal_operacional_confirmar_partida', { p_id: String(id), p_user_id: String(userId) });
}

async function assumir(db, id, mediadorId) {
  return alterar(db, id, 'assumir', {
    mediador_id: String(mediadorId), comissao: 0,
  });
}

async function marcarPago(db, id) { return alterar(db, id, 'pago'); }

async function liberarSala(db, id, { salaId, senha, sessao = null }) {
  const identificador = String(salaId || '').trim().slice(0, 40);
  if (!identificador.length) throw new Error('Informe o ID da sala.');
  return alterar(db, id, 'sala', {
    sala_id: identificador, sala_senha: senha ? String(senha).trim().slice(0, 40) : null,
    nix_sessao: sessao ? String(sessao).trim().slice(0, 64) : null,
  });
}

async function publicarSalaManual(db, { partidaId, guildId, canalId, mensagemId, mediadorId, salaVersao, salaId, senha }) {
  const identificador = String(salaId || '').trim().slice(0, 40);
  if (!identificador) throw new Error('Informe o ID da sala.');
  return rpc(db, 'royal_operacional_publicar_sala_manual', {
    p_id: String(partidaId), p_guild_id: String(guildId), p_canal_id: String(canalId),
    p_mensagem_id: mensagemId == null ? null : String(mensagemId),
    p_mediador_id: String(mediadorId), p_sala_versao: salaVersao == null ? null : Number(salaVersao), p_sala_id: identificador,
    p_senha: senha ? String(senha).trim().slice(0, 40) : null,
  });
}

async function darGo(db, { partidaId, userId, guildId, canalId, mensagemId, salaVersao }) {
  return rpc(db, 'royal_operacional_dar_go', {
    p_id: String(partidaId), p_user_id: String(userId), p_guild_id: guildId == null ? null : String(guildId),
    p_canal_id: canalId == null ? null : String(canalId), p_mensagem_id: mensagemId == null ? null : String(mensagemId),
    p_sala_versao: salaVersao == null ? null : Number(salaVersao),
  });
}

// O mesmo pedido pode ser repetido após timeout: a RPC verifica o resultado
// sob lock. Não transforme um commit possivelmente realizado em falha definitiva.
async function encerrarTransacional(db, parametros) {
  let ultima;
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    try {
      const resposta = await rpc(db, 'royal_operacional_encerrar_partida', parametros);
      const p = resposta?.partida;
      const motivo = parametros.p_motivo || (parametros.p_cancelar ? 'cancelada pela staff' : 'resultado');
      const motivoEsperado = parametros.p_cancelar ? [...motivo].slice(0, 200).join('') : motivo;
      if (!p || String(p.id) !== parametros.p_id || !Array.isArray(resposta.jogadores)
          || p.status !== (parametros.p_cancelar ? STATUS.CANCELADA : STATUS.FINALIZADA)
          || (p.motivo_fim || (parametros.p_cancelar ? '' : 'resultado')) !== motivoEsperado
          || (!parametros.p_cancelar && Number(p.vencedor_time) !== parametros.p_vencedor_time)) {
        throw new Error('Resposta de encerramento ausente ou incompatível.');
      }
      return resposta;
    }
    catch (erro) {
      // Erros de PostgreSQL/PostgREST são respostas definitivas; transporte não é.
      if (/^(?:[0-9A-Z]{5}|PGRST[0-9]+)$/.test(erro.code || '')) throw erro;
      ultima = erro;
    }
  }
  throw new Error('Não foi possível confirmar o encerramento; ele pode ter sido concluído. Consulte a partida ou repita exatamente o mesmo resultado antes de alterá-lo.', { cause: ultima });
}

/** Resultado, economia, auditoria e outbox são confirmados em uma única transação. */
async function finalizar(db, { partidaId, vencedorTime, autorId = null, motivo = 'resultado' }) {
  const time = Number(vencedorTime);
  if (![1, 2].includes(time)) throw new Error('O time vencedor precisa ser 1 ou 2.');
  return encerrarTransacional(db, {
    p_id: String(partidaId), p_vencedor_time: time,
    p_autor_id: autorId == null ? null : String(autorId), p_motivo: String(motivo), p_cancelar: false,
  });
}

async function aplicarWO(db, { partidaId, timeAusente, autorId = null }) {
  const ausente = Number(timeAusente);
  if (![1, 2].includes(ausente)) throw new Error('O time ausente precisa ser 1 ou 2.');
  return finalizar(db, { partidaId, vencedorTime: ausente === 1 ? 2 : 1, autorId, motivo: 'wo' });
}

async function cancelar(db, { partidaId, autorId = null, motivo = 'cancelada pela staff' }) {
  const resultado = await encerrarTransacional(db, {
    p_id: String(partidaId), p_vencedor_time: null,
    p_autor_id: autorId == null ? null : String(autorId), p_motivo: String(motivo), p_cancelar: true,
  });
  return resultado.partida;
}

module.exports = { STATUS, ATIVOS, criar, buscar, jogadores, confirmados, definirMensagem, porCanal,
  ativas, ativasReais, pendentes, ativasDoJogador, definirRegras, confirmar, assumir, marcarPago, liberarSala,
  publicarSalaManual, darGo, finalizar, aplicarWO, cancelar };
