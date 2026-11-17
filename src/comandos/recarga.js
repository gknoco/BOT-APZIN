'use strict';

const path = require('node:path');
const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');
const config = require('../config');
const persistenciaSupabase = require('../servicos/supabase');
const { embed, embedSucesso } = require('../util/embeds');
const { responderErro: responderErroSeguro, responderPrivado: responderPrivadoSeguro } = require('../util/seguranca');

const BANNER_NOME = 'recarga-royal-ap.jpg';
const BANNER_PATH = path.join(__dirname, '../../assets', BANNER_NOME);
const CHAVE_CANAL_RECARGA = 'canal_recarga';

function embedPainelRecarga() {
  return embed(null, null, {
    cor: config.CORES.neutro,
    rodape: 'Operado por Royal AP · Suporte Royal AP',
  }).setImage(`attachment://${BANNER_NOME}`);
}

function componentesRecarga() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('ap:recargapix')
        .setLabel('Gerar Pix')
        .setEmoji('➕')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('ap:recargasalainfinita')
        .setLabel('Sala Infinita')
        .setEmoji('♾️')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('ap:recargaextrato')
        .setLabel('Extrato')
        .setEmoji('🧾')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

const comandos = [
  {
    data: new SlashCommandBuilder()
      .setName('recarga')
      .setDescription('Publica e fixa o painel de recargas da carteira digital Royal AP'),
    async executar(interaction, { db }) {
      if (!interaction.guildId || !interaction.channel?.send) {
        return responderErroSeguro(interaction, 'Use /recarga em um canal de texto de um servidor.');
      }
      const ehDono = interaction.guild?.ownerId && String(interaction.user.id) === String(interaction.guild.ownerId);
      const ehAdministrador = interaction.memberPermissions?.has?.(PermissionFlagsBits.Administrator);
      if (!ehDono && !ehAdministrador) {
        return responderErroSeguro(interaction, 'Somente um Administrador ou o proprietário do servidor pode publicar o painel /recarga.');
      }

      let mensagem;
      try {
        mensagem = await interaction.channel.send({
          embeds: [embedPainelRecarga()],
          files: [new AttachmentBuilder(BANNER_PATH, { name: BANNER_NOME })],
          components: componentesRecarga(),
          allowedMentions: { parse: [] },
        });
      } catch (erro) {
        console.error('[recarga] não consegui publicar o painel:', erro.message);
        return responderErroSeguro(interaction, 'Não consegui publicar o painel de recarga neste canal. Verifique as permissões de envio e anexos do bot.');
      }

      let fixado = false;
      try {
        if (typeof mensagem.pin === 'function') {
          await mensagem.pin();
          fixado = true;
        }
      } catch (erro) {
        console.warn('[recarga] painel publicado, mas não consegui fixá-lo:', erro.message);
      }

      try {
        await persistenciaSupabase.definirConfig(
          interaction.guildId,
          CHAVE_CANAL_RECARGA,
          interaction.channel.id,
          db?.client,
        );
      } catch (erro) {
        console.error('[recarga] painel publicado, mas não consegui salvar o canal no Supabase:', erro.message);
        return responderErroSeguro(
          interaction,
          `O painel foi publicado${fixado ? ' e fixado' : ''} em <#${interaction.channel.id}>, mas não consegui registrar o canal no Supabase.`,
        );
      }

      const statusFixado = fixado ? 'publicado e fixado' : 'publicado, mas não foi possível fixá-lo; confira a permissão Gerenciar Mensagens';
      return responderPrivadoSeguro(interaction, {
        embeds: [embedSucesso(`Painel de recarga ${statusFixado} em <#${interaction.channel.id}>. Canal registrado no Supabase.`)],
      });
    },
  },
];

module.exports = {
  BANNER_NOME,
  BANNER_PATH,
  CHAVE_CANAL_RECARGA,
  embedPainelRecarga,
  componentesRecarga,
  comandos,
};
