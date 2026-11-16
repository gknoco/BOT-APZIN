'use strict';

/** Fila operacional persistente. A seleção/remoção de grupo é uma única RPC. */
const { TABELAS } = require('../db/esquema');
const { cliente, executar, contar: contarConsulta, excluir, listarPaginado, rpc } = require('../db/consultas');
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

async function sair(db, filtros) {
  return excluir(filtrar(cliente(db).from(TABELAS.filas).delete({ count: 'exact' }), filtros), 'sair da fila');
}

async function remover(db, { ids, ...filtros }) {
  if (!Array.isArray(ids) || !ids.length) return 0;
  return excluir(filtrar(cliente(db).from(TABELAS.filas).delete({ count: 'exact' }), filtros)
    .in('user_id', ids.map(String)), 'remover jogadores da fila');
}

async function limpar(db, { guildId, modo = null }) {
  return excluir(filtrar(cliente(db).from(TABELAS.filas).delete({ count: 'exact' }), { guildId, modo }), 'limpar fila');
}

async function modosComFila(db, guildId) {
  return rpc(db, 'royal_operacional_modos_fila', { p_guild_id: String(guildId) });
}

async function reservar(db, { guildId, modo, preco, gelo, quantidade }) {
  if (!Number.isInteger(quantidade) || quantidade < 1) throw new Error('A quantidade de jogadores precisa ser um inteiro positivo.');
  return rpc(db, 'royal_operacional_reservar_fila', {
    p_guild_id: String(guildId), p_modo: String(modo), p_preco: Math.trunc(preco),
    p_gelo: String(gelo), p_quantidade: quantidade,
  });
}

module.exports = { entrar, listar, total, posicao, contar, sair, remover, limpar, modosComFila, reservar };
