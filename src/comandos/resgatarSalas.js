'use strict';

const { SlashCommandBuilder } = require('discord.js');
const vendasDb = require('../servicos/roomSalesSupabase');
const { EFEMERO, responderPrivado, responderErro } = require('../util/seguranca');
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
    if (!interaction.guildId) return responderErro(interaction, 'Use este comando dentro do servidor.');
    if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: EFEMERO });
    let resultado;
    try {
      resultado = await vendasDb.resgatarSalasIniciais({
        guildId: interaction.guildId,
        userId: interaction.user.id,
        quantidade: COTA_INICIAL,
      });
    } catch (erro) {
      console.error('[salas-credito] não foi possível confirmar o resgate:', erro.message);
      if (/INITIAL_ROOM_REDEMPTION_REVIEW_REQUIRED/.test(erro.message || '')) {
        return responderErro(interaction, 'Seu histórico de salas precisa de revisão. Procure a administração antes de tentar novamente.');
      }
      return responderErro(interaction, 'Não foi possível confirmar o resgate. Tente novamente em instantes ou procure a administração.');
    }
    if (resultado.redeemed === false) {
      return responderErro(interaction, 'Você já resgatou suas salas iniciais.');
    }
    return responderPrivado(interaction, {
      embeds: [embedSucesso(`✅ Você resgatou **${COTA_INICIAL} salas personalizadas**.\n**Saldo disponível:** ${resultado.available_rooms} sala(s).`)],
    });
  },
};

module.exports = { comandos: [comando] };
