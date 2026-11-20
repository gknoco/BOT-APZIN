'use strict';

const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { EFEMERO, responderPrivado, responderErro, ehAdmin } = require('../util/seguranca');
const CARGO_ADM = '1543684028719173732';

function painel() {
  return { embeds: [new EmbedBuilder().setColor(0xfacc15).setTitle('Distribuição de salas').setDescription('Selecione um ADM para conceder créditos de salas Nix.')], components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ap:addsalas:selecionar').setLabel('Selecionar adm').setStyle(ButtonStyle.Primary))] };
}
const comando = {
  data: new SlashCommandBuilder().setName('addsalas').setDescription('Distribui salas para um ADM').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  async executar(interaction) {
    if (!ehAdmin(interaction.member)) return responderErro(interaction, 'Somente administradores podem distribuir salas.');
    return responderPrivado(interaction, painel());
  },
};
async function selectAdm(interaction) {
  const adiadoAqui = !interaction.deferred && !interaction.replied;
  if (adiadoAqui) await interaction.deferReply({ flags: EFEMERO });
  const responder = (payload) => adiadoAqui ? interaction.editReply(payload) : responderPrivado(interaction, payload);
  let membros;
  try {
    if (!interaction.guild?.members?.fetch) throw new Error('servidor indisponível');
    membros = await interaction.guild.members.fetch();
  } catch (erro) {
    console.error('[addsalas] não consegui consultar os membros:', erro.message);
    return responder({ content: 'Não consegui consultar os membros do servidor. Verifique o intent de membros e tente novamente.' });
  }
  const elegiveis = [...membros.values()]
    .filter((m) => m.user && !m.user.bot && m.roles?.cache?.has(CARGO_ADM)).slice(0, 25);
  if (!elegiveis.length) return responder({ content: 'Nenhum usuário humano com o cargo administrativo exigido foi encontrado.' });
  return responder({ content: 'Selecione o ADM que receberá as salas:', components: [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('ap:addsalasadm').setPlaceholder('Selecione um ADM').addOptions(elegiveis.map((m) => ({ label: m.user.username.slice(0, 100), value: m.id, description: `ID ${m.id}` }))))] });
}
function modalQuantidade(userId) {
  return new ModalBuilder().setCustomId(`ap:modaladdsalas:${userId}`).setTitle('Quantidade de salas').addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('quantidade').setLabel('Quantidade de salas').setPlaceholder('Ex.: 10').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(6)));
}
module.exports = { comandos: [comando], CARGO_ADM, painel, selectAdm, modalQuantidade };
