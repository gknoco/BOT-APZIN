'use strict';

/** Versículo do dia e configuração dos canais de entrada/saída. */

const {
  ChannelType,
  EmbedBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');
const persistenciaSupabase = require('../servicos/supabase');
const versiculos = require('../servicos/versiculos');
const { responderErro, responderPrivado } = require('../util/seguranca');

function dataHoraBrasilia(data = new Date()) {
  const partes = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(data);
  const porTipo = Object.fromEntries(partes.map((parte) => [parte.type, parte.value]));
  return `${porTipo.day}/${porTipo.month}/${porTipo.year} ${porTipo.hour}:${porTipo.minute}`;
}

function embedVersiculo(versiculo, data = new Date()) {
  const embed = new EmbedBuilder()
    .setColor(0xf1c40f)
    .setTitle('📿 Versículo do Dia')
    .setDescription(`*"${versiculo.texto}"*\n\n**— ${versiculo.referencia}**`)
    .setFooter({ text: `ORG Royal AP · ${dataHoraBrasilia(data)}` });
  return embed;
}

function temAdministrator(interaction) {
  return Boolean(interaction.memberPermissions?.has?.(PermissionFlagsBits.Administrator));
}

async function configurarCanal(interaction, chave, rotulo, clienteSupabase) {
  if (!temAdministrator(interaction)) {
    return responderErro(interaction, 'Você precisa da permissão **Administrator** do Discord para configurar este canal.');
  }

  const canal = interaction.options.getChannel('canal') || interaction.channel;
  if (!canal?.isTextBased?.() || typeof canal.send !== 'function') {
    return responderErro(interaction, 'Escolha um canal de texto válido, ou execute o comando em um canal de texto.');
  }

  await persistenciaSupabase.definirConfig(interaction.guildId, chave, canal.id, clienteSupabase);
  return responderPrivado(interaction, { content: `✅ Canal de ${rotulo} salvo: ${canal}.` });
}

const canaisDeTexto = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const permissaoAdmin = PermissionFlagsBits.Administrator;

const comandos = [
  {
    data: new SlashCommandBuilder()
      .setName('versiculododia')
      .setDescription('Envia um versículo bíblico ainda não usado')
      .setDefaultMemberPermissions(null),
    defer: 'privado',

    async executar(interaction, contexto = {}) {
      const canal = interaction.channel;
      if (!canal?.isTextBased?.() || typeof canal.send !== 'function') {
        return responderErro(interaction, 'Use este comando em um canal de texto onde o bot possa enviar mensagens.');
      }
      let sorteio;
      try {
        sorteio = await versiculos.sortear({
          guildId: interaction.guildId,
          userId: interaction.user.id,
          cliente: contexto.db?.client || contexto.supabase,
        });
      } catch (erro) {
        console.error('[versiculos] falha no sorteio:', erro.message);
        return responderErro(interaction, 'A base de versículos não está disponível. A equipe precisa conferir o Supabase e carregar a lista.');
      }
      await canal.send({ embeds: [embedVersiculo(sorteio.versiculo)], allowedMentions: { parse: [] } });
      return responderPrivado(interaction, { content: 'Versículo publicado neste canal.', allowedMentions: { parse: [] } });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('configcanal1')
      .setDescription('Define o canal de boas-vindas para a entrada de jogadores')
      .addChannelOption((opcao) =>
        opcao.setName('canal').setDescription('Canal de boas-vindas (vazio = canal atual)').addChannelTypes(...canaisDeTexto),
      )
      .setDefaultMemberPermissions(permissaoAdmin),

    async executar(interaction, contexto = {}) {
      return configurarCanal(interaction, 'canal_boas_vindas', 'boas-vindas', contexto.db?.client || contexto.supabase);
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('configcanal2')
      .setDescription('Define o canal de saída de jogadores')
      .addChannelOption((opcao) =>
        opcao.setName('canal').setDescription('Canal de saída (vazio = canal atual)').addChannelTypes(...canaisDeTexto),
      )
      .setDefaultMemberPermissions(permissaoAdmin),

    async executar(interaction, contexto = {}) {
      return configurarCanal(interaction, 'canal_saida', 'saída', contexto.db?.client || contexto.supabase);
    },
  },
];

module.exports = { comandos, dataHoraBrasilia, embedVersiculo, configurarCanal };
