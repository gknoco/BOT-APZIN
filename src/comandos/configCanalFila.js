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

const CONFIGS = {
  configcanalfila: { key: 'canal_partidas_formadas', label: 'partidas formadas', modal: 'modalconfigcanalfila' },
  configcanalfilasssmobile: { key: 'canal_filas_ss_mobile', label: 'filas SS Mobile', modal: 'modalconfigcanalfilasssmobile' },
  configcanalfilasssemu: { key: 'canal_filas_ss_emu', label: 'filas SS EMU', modal: 'modalconfigcanalfilasssemu' },
};

function criarComando(nome, descricao) {
  const definicao = CONFIGS[nome];
  return {
    data: new SlashCommandBuilder().setName(nome).setDescription(descricao)
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    defer: 'nenhum',
    async executar(interaction) {
      if (!ehAdmin(interaction.member)) return responderErro(interaction, 'Somente administradores podem configurar o canal de filas.');
      return interaction.showModal(new ModalBuilder()
        .setCustomId(`ap:${definicao.modal}`).setTitle(`Canal de ${definicao.label}`)
        .addComponents(new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('canal_id').setLabel('ID do Canal')
            .setPlaceholder('Ex.: 123456789012345678').setStyle(TextInputStyle.Short)
            .setMinLength(17).setMaxLength(20).setRequired(true),
        )));
    },
  };
}

const comandos = [
  criarComando('configcanalfila', 'Configura o canal de avisos de partidas formadas'),
  criarComando('configcanalfilasssmobile', 'Configura o canal de filas SS Mobile'),
  criarComando('configcanalfilasssemu', 'Configura o canal de filas SS EMU'),
];

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

async function salvarCanalModalidade(db, guildId, canalId, modalidade) {
  const valor = String(canalId || '').trim();
  if (!/^\d{17,20}$/.test(valor)) throw new Error('Informe um ID de canal Discord válido.');
  const tipo = String(modalidade);
  const key = tipo === 'ss_mobile' ? CONFIGS.configcanalfilasssmobile.key
    : tipo === 'ss_emu' ? CONFIGS.configcanalfilasssemu.key : null;
  if (!key) throw new Error('Modalidade de canal inválida.');
  const canalBatePonto = await obterConfig(db, guildId, 'canal_bateponto', null);
  if (String(canalBatePonto || '') === valor) throw new Error('O canal de filas não pode ser o mesmo canal do bate-ponto. Escolha outro canal.');
  await definirConfig(db, guildId, key, valor);
  return valor;
}

module.exports = { comandos, salvarCanalFila, salvarCanalModalidade, CONFIGS };
