'use strict';

const {
  SlashCommandBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder,
  PermissionFlagsBits,
} = require('discord.js');
const automacoes = require('../servicos/automacoesDiscord');
const { responderPrivado, responderErro } = require('../util/seguranca');

const campo = (id, label, placeholder, max = 100, required = true) => new ActionRowBuilder().addComponents(
  new TextInputBuilder().setCustomId(id).setLabel(label).setPlaceholder(placeholder)
    .setStyle(TextInputStyle.Short).setMaxLength(max).setRequired(required),
);

const comandoVersiculos = {
  data: new SlashCommandBuilder().setName('configversiculosauto')
    .setDescription('Configura o versículo automático diário')
    .addStringOption((o) => o.setName('canal_id').setDescription('ID do canal de envio').setRequired(true))
    .addStringOption((o) => o.setName('horario').setDescription('Horário diário no formato HH:MM').setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  defer: 'privado',
  async executar(interaction, { db }) {
    if (!automacoes.ehAdmin(interaction)) return responderErro(interaction, 'Somente administradores podem configurar automações.');
    try {
      const valor = await automacoes.salvarVersiculos(db, interaction.guildId,
        interaction.options.getString('canal_id'), interaction.options.getString('horario'));
      return responderPrivado(interaction, { content: `✅ Versículo automático salvo: <#${valor.canal_id}> todos os dias às **${valor.horario}** (horário de Brasília).` });
    } catch (erro) { return responderErro(interaction, erro.message); }
  },
};

const comandoAnuncios = {
  data: new SlashCommandBuilder().setName('configanuncioauto')
    .setDescription('Configura anúncios automáticos diários com limpeza')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  defer: 'nenhum',
  async executar(interaction) {
    if (!automacoes.ehAdmin(interaction)) return responderErro(interaction, 'Somente administradores podem configurar automações.');
    return interaction.showModal(new ModalBuilder().setCustomId('ap:modalanuncioauto').setTitle('Anúncio automático diário')
      .addComponents(
        campo('canal_principal_id', 'ID do Canal Principal (opcional)', 'Deixe vazio para usar apenas os canais de divulgação', 20, false),
        campo('link', 'Link do Servidor', 'https://discord.gg/seuconvite', 500),
        campo('canais_divulgacao', 'IDs dos Canais (vírgula)', '82828287889298,7383992928287', 500),
        campo('horario', 'Horário Diário (HH:MM)', 'Ex.: 18:30', 5),
      ));
  },
};

module.exports = { comandos: [comandoVersiculos, comandoAnuncios] };
