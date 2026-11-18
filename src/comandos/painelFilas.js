'use strict';

const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const { responderPrivado, responderErro, ehAdmin } = require('../util/seguranca');

const comando = {
  data: new SlashCommandBuilder().setName('painelfilas').setDescription('Gerencia o banner e avatar das filas').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  async executar(interaction) {
    if (!ehAdmin(interaction.member)) return responderErro(interaction, 'Somente administradores podem gerenciar as filas.');
    const embed = new EmbedBuilder().setColor(0xed4245).setTitle('Gerenciamento visual das filas')
      .setDescription('Configure as imagens exibidas nos cards de todas as filas deste servidor.\n\nDigite `EXCLUSIR` no modal para remover permanentemente uma imagem.');
    return responderPrivado(interaction, { embeds: [embed], components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ap:filasbanner').setLabel('Banner').setEmoji('🖼️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('ap:filasavatar').setLabel('Avatar').setEmoji('🖼️').setStyle(ButtonStyle.Secondary),
    )] });
  },
};
module.exports = { comandos: [comando] };
