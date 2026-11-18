'use strict';

const { EmbedBuilder, SlashCommandBuilder } = require('discord.js');
const { responderErro, responderPrivado } = require('../util/seguranca');

const CANAL_BUGS = '1572600044258066472';
const CANAL_SUGESTOES = '1572600148629127220';

async function buscarCanal(interaction, id) {
  const canal = await interaction.guild.channels.fetch(id).catch((erro) => {
    console.error(`[feedback] não consegui buscar o canal ${id}:`, erro.message);
    return null;
  });
  if (!canal?.isTextBased?.() || typeof canal.send !== 'function') return null;
  return canal;
}

const comandos = [
  {
    data: new SlashCommandBuilder()
      .setName('reportarbug')
      .setDescription('Relata um problema para a equipe do bot')
      .addStringOption((opcao) =>
        opcao.setName('bug').setDescription('Descrição curta do problema').setRequired(true),
      )
      .addStringOption((opcao) =>
        opcao.setName('passos').setDescription('Passo a passo para reproduzir o problema').setRequired(true),
      )
      .addAttachmentOption((opcao) =>
        opcao.setName('print').setDescription('Print ou imagem comprobatória'),
      ),

    async executar(interaction) {
      const canal = await buscarCanal(interaction, CANAL_BUGS);
      if (!canal) return responderErro(interaction, 'Não consegui acessar o canal de reportes. Avise a administração.');

      const bug = interaction.options.getString('bug', true);
      const passos = interaction.options.getString('passos', true);
      const print = interaction.options.getAttachment('print');
      const relatorio = new EmbedBuilder()
        .setColor(0xe74c3c)
        .setTitle('🐛 Novo reporte de bug')
        .setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL({ size: 128 }) })
        .addFields(
          { name: 'Bug relatado', value: bug.slice(0, 1024) },
          { name: 'Passo a passo', value: passos.slice(0, 1024) },
          { name: 'Autor', value: `<@${interaction.user.id}> · \`${interaction.user.id}\`` },
        )
        .setTimestamp()
        .setFooter({ text: 'ORG Royal AP · Central de reportes' });
      if (print?.url) relatorio.setImage(print.url);

      await canal.send({ embeds: [relatorio], allowedMentions: { parse: [] } });
      return responderPrivado(interaction, { content: '✅ Seu reporte foi enviado para a equipe responsável.' });
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('sugestao')
      .setDescription('Envia uma sugestão para a comunidade')
      .addStringOption((opcao) =>
        opcao.setName('ideia').setDescription('Descreva sua sugestão detalhadamente').setRequired(true),
      ),

    async executar(interaction) {
      const canal = await buscarCanal(interaction, CANAL_SUGESTOES);
      if (!canal) return responderErro(interaction, 'Não consegui acessar o canal de sugestões. Avise a administração.');

      const ideia = interaction.options.getString('ideia', true);
      const mensagem = await canal.send({
        embeds: [
          new EmbedBuilder()
            .setColor(0x3498db)
            .setTitle('💡 Nova sugestão')
            .setAuthor({ name: interaction.user.tag, iconURL: interaction.user.displayAvatarURL({ size: 128 }) })
            .setDescription(ideia.slice(0, 4096))
            .addFields({ name: 'Autor', value: `<@${interaction.user.id}> · \`${interaction.user.id}\`` })
            .setTimestamp()
            .setFooter({ text: 'ORG Royal AP · Vote nesta sugestão' }),
        ],
        allowedMentions: { parse: [] },
      });
      await Promise.allSettled([mensagem.react('👍'), mensagem.react('👎')]);
      return responderPrivado(interaction, { content: '✅ Sua sugestão foi enviada para votação da comunidade.' });
    },
  },
];

module.exports = { comandos, CANAL_BUGS, CANAL_SUGESTOES };
