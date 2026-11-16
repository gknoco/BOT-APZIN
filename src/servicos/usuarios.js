'use strict';

/** Histórico operacional; a economia continua sob responsabilidade de royal_profiles. */
const { rpc, limitePositivo } = require('../db/consultas');

async function historicoApostas(db, guildId, userId, limite = 10) {
  return await rpc(db, 'royal_operacional_historico_apostas', {
    p_guild_id: String(guildId), p_user_id: String(userId), p_limite: limitePositivo(limite, 10),
  }) || [];
}

module.exports = { historicoApostas };
