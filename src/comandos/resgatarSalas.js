'use strict';

const { SlashCommandBuilder } = require('discord.js');
const vendasDb = require('../servicos/roomSalesSupabase');
const { responderPrivado, responderErro } = require('../util/seguranca');
const { embedSucesso } = require('../util/embeds');

const CARGO_MEDIADOR = '1543684028719173732';
const COTA_INICIAL = 10;

const comando = {
  data: new SlashCommandBuilder()
    .setName('resgatarsalas')
    .setDescription('Resgata 10 salas personalizadas como mediador'),
  async executar(interaction, { db }) {
    if (!interaction.member?.roles?.cache?.has(CARGO_MEDIADOR)) {
      return responderErro(interaction, `Apenas mediadores com o cargo ${CARGO_MEDIADOR} podem usar este comando.`);
    }

    const resultado = await vendasDb.resgatarSalasIniciais({
      guildId: interaction.guildId,
      userId: interaction.user.id,
      quantidade: COTA_INICIAL,
    });
    if (resultado.redeemed === false && !resultado.recovered) {
      return responderErro(interaction, 'Você já resgatou suas salas iniciais.');
    }
    return responderPrivado(interaction, {
      embeds: [embedSucesso(resultado.recovered
        ? `✅ Seu saldo inicial foi sincronizado novamente.\n**Saldo disponível:** ${resultado.available_rooms} sala(s).`
        : `✅ Você resgatou **${COTA_INICIAL} salas personalizadas**.\n**Saldo disponível:** ${resultado.available_rooms} sala(s).`)],
    });
  },
};

module.exports = { comandos: [comando] };
