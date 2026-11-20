'use strict';

/** Fila operacional persistente. A seleção/remoção de grupo é uma única RPC. */
const { TABELAS } = require('../db/esquema');
const { cliente, contar: contarConsulta, listarPaginado, rpc } = require('../db/consultas');
const CAMPOS = 'id,guild_id,modo,preco,gelo,user_id,entrou_em';

function filtrar(consulta, { guildId, modo, preco = null, gelo = null, userId }) {
  let q = consulta.eq('guild_id', String(guildId));
  if (modo != null) q = q.eq('modo', String(modo));
  if (preco != null) q = q.eq('preco', Math.trunc(preco));
  if (gelo) q = q.eq('gelo', String(gelo));
  if (userId != null) q = q.eq('user_id', String(userId));
  return q;
}

async function entrar(db, { guildId, modo, preco, gelo, userId }) {
  return rpc(db, 'royal_operacional_entrar_fila', {
    p_guild_id: String(guildId), p_modo: String(modo), p_preco: Math.trunc(preco),
    p_gelo: String(gelo), p_user_id: String(userId),
  });
}

async function listar(db, filtros) {
  return listarPaginado(() => filtrar(cliente(db).from(TABELAS.filas).select(CAMPOS), filtros)
    .order('entrou_em').order('id'), 'listar fila');
}

async function total(db, filtros) {
  return contarConsulta(filtrar(cliente(db).from(TABELAS.filas).select('id', { count: 'exact', head: true }), filtros), 'contar fila');
}

async function posicao(db, filtros) {
  const grupo = await listar(db, { ...filtros, userId: undefined });
  const indice = grupo.findIndex((linha) => linha.user_id === String(filtros.userId));
  return indice === -1 ? null : indice + 1;
}

async function contar(db, filtros) { return total(db, filtros); }

function removerFilas(db, { guildId, modo, preco = null, gelo = null, userId }, ids = null) {
  const precoFiltrado = preco == null ? null : Math.trunc(preco);
  if (precoFiltrado !== null && !Number.isFinite(precoFiltrado)) throw new Error('Preço inválido para remoção da fila.');
  return rpc(db, 'royal_operacional_remover_filas', {
    p_guild_id: String(guildId), p_modo: modo == null ? null : String(modo),
    p_preco: precoFiltrado, p_gelo: gelo ? String(gelo) : null,
    p_user_id: userId == null ? null : String(userId), p_user_ids: ids,
  });
}

async function sair(db, filtros) {
  return removerFilas(db, filtros);
}

async function remover(db, { ids, ...filtros }) {
  if (!Array.isArray(ids) || !ids.length) return 0;
  return removerFilas(db, filtros, ids.map(String));
}

async function limpar(db, { guildId, modo = null }) {
  return removerFilas(db, { guildId, modo });
}

async function modosComFila(db, guildId) {
  return rpc(db, 'royal_operacional_modos_fila', { p_guild_id: String(guildId) });
}

async function reservar(db, { reservaId, partidaId, guildId, modo, preco, gelo, quantidade }) {
  if (!Number.isInteger(quantidade) || quantidade < 1) throw new Error('A quantidade de jogadores precisa ser um inteiro positivo.');
  if (!reservaId || !partidaId) throw new Error('Reserva e partida exigem IDs estáveis.');
  return rpc(db, 'royal_operacional_reservar_fila', {
    p_reserva_id: String(reservaId), p_partida_id: String(partidaId),
    p_guild_id: String(guildId), p_modo: String(modo), p_preco: Math.trunc(preco),
    p_gelo: String(gelo), p_quantidade: quantidade,
  });
}

async function vincularCanal(db, { reservaId, guildId, canalId }) {
  if (!reservaId || !guildId || !canalId) throw new Error('Reserva, servidor e canal são obrigatórios.');
  return rpc(db, 'royal_operacional_vincular_canal_reserva', {
    p_reserva_id: String(reservaId), p_guild_id: String(guildId), p_canal_id: String(canalId),
  });
}

async function cancelarReserva(db, { reservaId, guildId }) {
  if (!reservaId || !guildId) throw new Error('Reserva e servidor são obrigatórios.');
  return rpc(db, 'royal_operacional_cancelar_reserva', { p_reserva_id: String(reservaId), p_guild_id: String(guildId) });
}

module.exports = { entrar, listar, total, posicao, contar, sair, remover, limpar, modosComFila, reservar, vincularCanal, cancelarReserva };
