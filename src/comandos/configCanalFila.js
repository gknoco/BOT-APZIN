'use strict';

const {
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  PermissionFlagsBits,
} = require('discord.js');
const { obterConfig, definirConfig } = require('../db');
const { ehAdmin, responderPrivado, responderErro } = require('../util/seguranca');

const comando = {
  data: new SlashCommandBuilder()
    .setName('configcanalfila')
    .setDescription('Configura o canal de avisos de partidas formadas')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  defer: 'nenhum',
  async executar(interaction) {
    if (!ehAdmin(interaction.member)) return responderErro(interaction, 'Somente administradores podem configurar o canal de filas.');
    return interaction.showModal(new ModalBuilder()
      .setCustomId('ap:modalconfigcanalfila')
      .setTitle('Canal de partidas formadas')
      .addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('canal_id')
          .setLabel('ID do Canal')
          .setPlaceholder('Ex.: 123456789012345678')
          .setStyle(TextInputStyle.Short)
          .setMinLength(17)
          .setMaxLength(20)
          .setRequired(true),
      )));
  },
};

async function salvarCanalFila(db, guildId, canalId) {
  const valor = String(canalId || '').trim();
  if (!/^\d{17,20}$/.test(valor)) throw new Error('Informe um ID de canal Discord válido.');
  const canalBatePonto = await obterConfig(db, guildId, 'canal_bateponto', null);
  if (String(canalBatePonto || '') === valor) {
    throw new Error('O canal de partidas formadas não pode ser o mesmo canal do bate-ponto. Escolha outro canal.');
  }
  await definirConfig(db, guildId, 'canal_partidas_formadas', valor);
  return valor;
}

module.exports = { comandos: [comando], salvarCanalFila };
