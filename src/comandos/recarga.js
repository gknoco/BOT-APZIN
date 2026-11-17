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
const { embed, embedSucesso, reais, dataBR } = require('../util/embeds');
const { responderErro: responderErroSeguro, responderPrivado: responderPrivadoSeguro } = require('../util/seguranca');

const BANNER_NOME = 'recarga-royal-ap.jpg';
const BANNER_PATH = path.join(__dirname, '../../assets', BANNER_NOME);
const BANNER_INFINITA_NOME = 'sala-infinita-royal-ap.png';
const BANNER_INFINITA_PATH = path.join(__dirname, '../../assets', BANNER_INFINITA_NOME);
const BANNER_EXTRATO_NOME = 'extrato-royal-ap.png';
const BANNER_EXTRATO_PATH = path.join(__dirname, '../../assets', BANNER_EXTRATO_NOME);
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

function embedSalaInfinita() {
  return embed('Sala Infinita · Planos Premium', 'O pagamento é por Pix e o plano ativa automaticamente. Comprar de novo soma os dias.', {
    cor: config.CORES.neutro,
    rodape: 'Operado por Royal AP · Suporte Royal AP',
  }).setImage(`attachment://${BANNER_INFINITA_NOME}`);
}

function componentesSalaInfinita() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ap:recargavoltar').setLabel('Voltar').setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ap:recargasemanal').setLabel('Semanal R$ 5,00').setEmoji('📅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('ap:recargamensal').setLabel('Mensal R$ 13,00').setEmoji('💎').setStyle(ButtonStyle.Success),
  )];
}

function rotuloMovimento(tipo) {
  if (tipo === 'topup') return 'Recarga Pix';
  if (tipo === 'refund_review') return 'Ajuste em análise';
  return 'Movimentação';
}

function embedExtratoCarteira(extrato = {}) {
  const saldo = Number(extrato.balanceCents) || 0;
  const entradas = Number(extrato.totalEntriesCents) || 0;
  const saidas = Number(extrato.totalExitsCents) || 0;
  const movimentos = Array.isArray(extrato.movements) ? extrato.movements.slice(0, 6) : [];
  const linhas = movimentos.map((movimento) => {
    const delta = Number(movimento.deltaCents) || 0;
    const sinal = delta < 0 ? '−' : '+';
    const data = movimento.createdAt ? dataBR(Date.parse(movimento.createdAt)) : 'Data indisponível';
    return `• **${rotuloMovimento(movimento.eventType)}** · ${sinal}${reais(Math.abs(delta))} · ${data}`;
  });
  const recentes = linhas.length ? linhas.join('\n') : 'Nenhuma movimentação ainda.';

  return embed('Meu Extrato', '**Últimas movimentações**\n' + recentes, {
    cor: config.CORES.neutro,
    rodape: 'Operado por Royal AP · Suporte Royal AP',
    campos: [
      { name: 'SALDO ATUAL', value: `**${reais(saldo)}**`, inline: true },
      { name: 'TOTAL DE ENTRADAS', value: `+ **${reais(entradas)}**`, inline: true },
      { name: 'TOTAL DE SAÍDAS', value: `− **${reais(saidas)}**`, inline: true },
      { name: 'STATUS DA CARTEIRA', value: `**${String(extrato.status || 'Normal').slice(0, 40)}**`, inline: true },
    ],
  }).setImage(`attachment://${BANNER_EXTRATO_NOME}`);
}

function componentesExtrato() {
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ap:extratovoltar').setLabel('Voltar').setEmoji('⬅️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ap:extratoatualizar').setLabel('Atualizar extrato').setEmoji('🔄').setStyle(ButtonStyle.Primary),
  )];
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
  BANNER_INFINITA_NOME,
  BANNER_INFINITA_PATH,
  BANNER_EXTRATO_NOME,
  BANNER_EXTRATO_PATH,
  CHAVE_CANAL_RECARGA,
  embedPainelRecarga,
  embedSalaInfinita,
  componentesRecarga,
  componentesSalaInfinita,
  embedExtratoCarteira,
  componentesExtrato,
  comandos,
};
