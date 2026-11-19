'use strict';

const { SlashCommandBuilder } = require('discord.js');
const cotasMediadores = require('../servicos/cotasMediadores');
const { responderPrivado, responderErro } = require('../util/seguranca');
const { embedSucesso } = require('../util/embeds');

const comando = {
  data: new SlashCommandBuilder()
    .setName('resgatarsalas')
    .setDescription('Resgata 10 salas personalizadas como mediador'),
  async executar(interaction, { db }) {
    if (!interaction.member?.roles?.cache?.has(cotasMediadores.CARGO_MEDIADOR)) {
      return responderErro(interaction, `Apenas mediadores com o cargo ${cotasMediadores.CARGO_MEDIADOR} podem usar este comando.`);
    }

    const resultado = await cotasMediadores.resgatar(db, interaction.guildId, interaction.user.id, cotasMediadores.COTA_INICIAL);
    if (resultado.jaResgatou) {
      return responderErro(interaction, 'Você já resgatou suas salas iniciais.');
    }
    return responderPrivado(interaction, {
      embeds: [embedSucesso(`✅ Você resgatou **${cotasMediadores.COTA_INICIAL} salas personalizadas**.\n**Saldo disponível:** ${resultado.saldo} sala(s).`)],
    });
  },
};

module.exports = { comandos: [comando] };
