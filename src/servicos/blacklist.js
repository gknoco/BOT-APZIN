'use strict';

const { TABELAS } = require('../db/esquema');
const { cliente, executar, excluir, listarPaginado, limitePositivo } = require('../db/consultas');
const CAMPOS = 'guild_id,user_id,motivo,autor_id,criado_em';

async function adicionar(db, { guildId, userId, motivo, autorId }) {
  const texto = String(motivo || '').trim();
  if (texto.length < 3) throw new Error('Escreva o motivo (pelo menos 3 letras).');
  return executar(cliente(db).from(TABELAS.blacklist).upsert({
    guild_id: String(guildId), user_id: String(userId), motivo: texto.slice(0, 300),
    autor_id: String(autorId), criado_em: Date.now(),
  }, { onConflict: 'guild_id,user_id' }).select(CAMPOS).single(), 'adicionar à blacklist');
}

async function obter(db, guildId, userId) {
  return await executar(cliente(db).from(TABELAS.blacklist).select(CAMPOS)
    .eq('guild_id', String(guildId)).eq('user_id', String(userId)).maybeSingle(), 'consultar blacklist') || null;
}

async function estaBloqueado(db, guildId, userId) { return Boolean(await obter(db, guildId, userId)); }

async function remover(db, { guildId, userId }) {
  return excluir(cliente(db).from(TABELAS.blacklist).delete({ count: 'exact' })
    .eq('guild_id', String(guildId)).eq('user_id', String(userId)), 'remover da blacklist');
}

async function listar(db, guildId, limite = 50) {
  return listarPaginado(() => cliente(db).from(TABELAS.blacklist).select(CAMPOS)
    .eq('guild_id', String(guildId)).order('criado_em', { ascending: false }).order('user_id'),
  'listar blacklist', limitePositivo(limite));
}

module.exports = { adicionar, obter, estaBloqueado, remover, listar };
