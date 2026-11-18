'use strict';

/** Estado operacional persistente. Transições críticas serializadas no PostgreSQL. */
const crypto = require('node:crypto');
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
const CAMPOS = 'id,guild_id,modo,preco,gelo,canal_id,mensagem_id,status,regras,regras_por,mediador_id,pix_chave,pix_titular,sala_id,sala_senha,vencedor_time,motivo_fim,comissao,criado_em,pago_em,liberada_em,finalizada_em,nix_sessao';
const CAMPOS_JOGADOR = 'partida_id,user_id,time,confirmou';

async function criar(db, { guildId, modo, preco, gelo, canalId, jogadores: lista }) {
  if (!Array.isArray(lista) || !lista.length) throw new Error('Não dá para criar partida sem jogadores.');
  return rpc(db, 'royal_operacional_criar_partida', {
    p_id: crypto.randomBytes(6).toString('hex'), p_guild_id: String(guildId), p_modo: String(modo),
    p_preco: Math.trunc(preco), p_gelo: String(gelo), p_canal_id: String(canalId),
    p_jogadores: lista.map((jogador) => ({ user_id: String(jogador.userId), time: Number(jogador.time) })),
  });
}

async function buscar(db, id) {
  return await executar(cliente(db).from(TABELAS.partidas).select(CAMPOS)
    .eq('id', String(id)).maybeSingle(), 'buscar partida') || null;
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

async function darGo(db, { partidaId, userId }) {
  return rpc(db, 'royal_operacional_dar_go', { p_id: String(partidaId), p_user_id: String(userId) });
}

/** Resultado + jogadores + auditoria são confirmados em uma única transação. */
async function finalizar(db, { partidaId, vencedorTime, autorId = null, motivo = 'resultado' }) {
  const time = Number(vencedorTime);
  if (![1, 2].includes(time)) throw new Error('O time vencedor precisa ser 1 ou 2.');
  return rpc(db, 'royal_operacional_encerrar_partida', {
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
  const resultado = await rpc(db, 'royal_operacional_encerrar_partida', {
    p_id: String(partidaId), p_vencedor_time: null,
    p_autor_id: autorId == null ? null : String(autorId), p_motivo: String(motivo), p_cancelar: true,
  });
  return resultado.partida;
}

module.exports = { STATUS, ATIVOS, criar, buscar, jogadores, confirmados, definirMensagem, porCanal,
  ativas, pendentes, ativasDoJogador, definirRegras, confirmar, assumir, marcarPago, liberarSala,
  darGo, finalizar, aplicarWO, cancelar };
