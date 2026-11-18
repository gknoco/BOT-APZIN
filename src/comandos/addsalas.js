'use strict';

const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { responderPrivado, responderErro, ehAdmin } = require('../util/seguranca');
const CARGO_ADM = '1543684028719173732';

function painel() {
  return { embeds: [new EmbedBuilder().setColor(0x2ecc71).setTitle('Distribuição de salas').setDescription('Selecione um ADM para conceder créditos de salas Nix.')], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ap:addsalas:selecionar').setLabel('Selecionar adm').setStyle(ButtonStyle.Primary))] };
}
const comando = {
  data: new SlashCommandBuilder().setName('addsalas').setDescription('Distribui salas para um ADM').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  async executar(interaction) {
    if (!ehAdmin(interaction.member)) return responderErro(interaction, 'Somente administradores podem distribuir salas.');
    return responderPrivado(interaction, painel());
  },
};
function selectAdm(interaction) {
  const membros = [...(interaction.guild?.members?.cache?.values?.() || [])].filter((m) => m.roles?.cache?.has(CARGO_ADM)).slice(0, 25);
  if (!membros.length) return responderErro(interaction, 'Nenhum usuário humano com o cargo administrativo exigido foi encontrado.');
  return interaction.reply({ content: 'Selecione o ADM que receberá as salas:', ephemeral: true, components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('ap:addsalasadm').setPlaceholder('Selecione um ADM').addOptions(membros.map((m) => ({ label: m.user.username.slice(0, 100), value: m.id, description: `ID ${m.id}` }))))] });
}
function modalQuantidade(userId) {
  return new ModalBuilder().setCustomId(`ap:modaladdsalas:${userId}`).setTitle('Quantidade de salas').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('quantidade').setLabel('Quantidade de salas').setPlaceholder('Ex.: 10').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(6)));
}
module.exports = { comandos: [comando], CARGO_ADM, painel, selectAdm, modalQuantidade };
