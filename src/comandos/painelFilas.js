'use strict';

const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const config = require('../config');
const filas = require('../servicos/filas');
const paineis = require('../servicos/paineis');
const persistenciaSupabase = require('../servicos/supabase');
const { responderPrivado, responderErro, ehAdmin } = require('../util/seguranca');

const CHAVE_LOTE = 'painelfilas_lote_publicado';
const CANAIS_FILAS = {
  filasx1mobile: '1570224806236786769',
  filasx2mobile: '1570228167426187415',
  filasx3mobile: '1570023437873979434',
  filasx4mobile: '1570023482866139229',
  filasx1fullcapa: '1570023537715191808',
  filasx2fullcapa: '1570023573513572422',
  filasx3fullcapa: '1570023590320013413',
  filasx4fullcapa: '1570047348002787408',
  filasx1emu: '1570024211496570900',
  filasx2emu: '1570024244702744636',
  filasx3emu: '1570024270476869684',
  filasx4emu: '1570024295948754954',
  filasx2misto: '1570024326416171119',
  filasx3misto: '1570024350793465986',
  filasx4misto: '1570024378798710794',
};

function lerLote(valor) {
  try {
    const linhas = JSON.parse(valor || '[]');
    return Array.isArray(linhas) ? linhas.filter((linha) => linha?.channelId && linha?.messageId) : [];
  } catch {
    return [];
  }
}

async function enviarTodasAsFilas({ db, client, guildId }) {
  const resultados = await Promise.all(config.MODOS.map(async (modo) => {
    const channelId = CANAIS_FILAS[modo.comando];
    if (!channelId) return { enviadas: [], falhas: [] };
    try {
      const canal = client.channels.cache.get(channelId) || await client.channels.fetch(channelId);
      if (!canal?.send) throw new Error('canal não é enviável');
      const entradas = await filas.listar(db, { guildId, modo: modo.id });
      const mensagens = await paineis.publicarFila(db, canal, { guildId, modo, entradas });
      return {
        enviadas: mensagens.map((linha) => ({ channelId, messageId: linha.mensagemId })),
        falhas: [],
      };
    } catch (erro) {
      console.error(`[painelfilas] falha ao publicar ${modo.comando} no canal ${channelId}:`, erro);
      return { enviadas: [], falhas: [`${modo.comando}: ${erro.message}`] };
    }
  }));
  const enviadas = resultados.flatMap((resultado) => resultado.enviadas);
  const falhas = resultados.flatMap((resultado) => resultado.falhas);
  await persistenciaSupabase.definirConfig(guildId, CHAVE_LOTE, JSON.stringify(enviadas), db.client);
  return { enviadas, falhas };
}

async function apagarTodasAsFilas({ db, client, guildId }) {
  const valor = await persistenciaSupabase.obterConfig(guildId, CHAVE_LOTE, db.client);
  const lote = lerLote(valor);
  let apagadas = 0;
  for (const linha of lote) {
    try {
      const canal = client.channels.cache.get(String(linha.channelId)) || await client.channels.fetch(String(linha.channelId));
      const mensagem = await canal?.messages?.fetch(String(linha.messageId)).catch(() => null);
      if (mensagem) {
        await mensagem.delete().catch(() => {});
        apagadas += 1;
      }
    } catch (erro) {
      console.error(`[painelfilas] falha ao apagar mensagem ${linha.messageId}:`, erro);
    }
  }
  await persistenciaSupabase.removerConfig(guildId, CHAVE_LOTE, db.client);
  return { apagadas, encontradas: lote.length };
}

function componentesPainel() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ap:filasbanner').setLabel('Banner').setEmoji('🖼️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('ap:filasavatar').setLabel('Avatar').setEmoji('🖼️').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ap:filasenviar').setLabel('Enviar todas as filas').setEmoji('📤').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('ap:filasapagar').setLabel('Apagar filas').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
    ),
  ];
}

const comando = {
  data: new SlashCommandBuilder().setName('painelfilas').setDescription('Gerencia o banner, avatar e publicação das filas').setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  async executar(interaction) {
    if (!ehAdmin(interaction.member)) return responderErro(interaction, 'Somente administradores podem gerenciar as filas.');
    const painel = new EmbedBuilder().setColor(0xfacc15).setTitle('Gerenciamento das filas')
      .setDescription('Configure o banner e o avatar exibidos nos cards, publique todas as filas nos canais oficiais ou remova o lote publicado.\n\nDigite `EXCLUSIR` no modal para remover permanentemente uma imagem.');
    return responderPrivado(interaction, { embeds: [painel], components: componentesPainel() });
  },
};

module.exports = { comandos: [comando], enviarTodasAsFilas, apagarTodasAsFilas, CANAIS_FILAS, CHAVE_LOTE };
