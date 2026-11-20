'use strict';

const { TABELAS } = require('../db/esquema');
const { cliente, executar, listarPaginado, limitePositivo, rpc } = require('../db/consultas');
const CAMPOS = 'guild_id,user_id,motivo,autor_id,criado_em';

async function adicionar(db, { guildId, userId, motivo, autorId }) {
  const texto = String(motivo || '').trim();
  if (texto.length < 3) throw new Error('Escreva o motivo (pelo menos 3 letras).');
  const resultado = await rpc(db, 'royal_operacional_adicionar_blacklist', {
    p_guild_id: String(guildId), p_user_id: String(userId), p_motivo: texto.slice(0, 300),
    p_autor_id: String(autorId), p_criado_em: Date.now(),
  });
  return { ...resultado.registro, filas_afetadas: resultado.filas_afetadas };
}

async function obter(db, guildId, userId) {
  return await executar(cliente(db).from(TABELAS.blacklist).select(CAMPOS)
    .eq('guild_id', String(guildId)).eq('user_id', String(userId)).maybeSingle(), 'consultar blacklist') || null;
}

async function estaBloqueado(db, guildId, userId) { return Boolean(await obter(db, guildId, userId)); }

async function remover(db, { guildId, userId }) {
  return rpc(db, 'royal_operacional_remover_blacklist', { p_guild_id: String(guildId), p_user_id: String(userId) });
}

async function listar(db, guildId, limite = 50) {
  return listarPaginado(() => cliente(db).from(TABELAS.blacklist).select(CAMPOS)
    .eq('guild_id', String(guildId)).order('criado_em', { ascending: false }).order('user_id'),
  'listar blacklist', limitePositivo(limite));
}

module.exports = { adicionar, obter, estaBloqueado, remover, listar };
