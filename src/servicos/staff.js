'use strict';

const { rpc } = require('../db/consultas');

/** Agregação no banco evita truncamento de partidas/jogadores pelo PostgREST. */
async function receita(db, guildId, desdeMs = 0) {
  return await rpc(db, 'royal_operacional_receita', {
    p_guild_id: String(guildId), p_desde_ms: Math.trunc(desdeMs),
  }) || [];
}

module.exports = { receita };
