'use strict';

// Aviso complementar, nunca fonte de verdade: a pendência é salva no Supabase
// antes desta chamada. Erros do Discord não revertem nem repetem a transação.
const { EmbedBuilder } = require('discord.js');
const config = require('../config');
const supabase = require('./supabase');

function textoSeguro(valor, limite = 300) {
  return String(valor ?? '').replace(/[\r\n\t]+/g, ' ').replace(/[`*_~|<>\\]/g, '\\$&').slice(0, limite);
}

async function avisarStaff(interaction, { origem, descricao, protocolo }) {
  try {
    if (!interaction?.guildId || !interaction.guild || !interaction.user?.id) return false;
    const configurado = await supabase.obterConfig(interaction.guildId, 'canal_logs');
    const canalId = configurado || config.CANAL_LOGS_ID;
    if (!canalId) return false;
    const canal = interaction.guild.channels?.cache?.get(String(canalId)) ||
      await interaction.guild.channels?.fetch?.(String(canalId));
    if (!canal || (canal.guildId && String(canal.guildId) !== String(interaction.guildId)) ||
        typeof canal.send !== 'function' || (canal.isTextBased && !canal.isTextBased())) return false;
    const usuario = String(interaction.user.id).replace(/[^0-9]/g, '');
    const embed = new EmbedBuilder()
      .setColor(0xd9a52f)
      .setTitle('ECONOMIA  •  ATENDIMENTO PENDENTE')
      .setDescription(
        `**Origem:** ${textoSeguro(origem, 60)}\n` +
        `**Jogador:** ${usuario ? `<@${usuario}>` : 'indisponível'}\n` +
        `**Resgate:** ${textoSeguro(descricao, 300)}\n` +
        `**Protocolo:** \`${textoSeguro(protocolo, 120)}\`\n\n` +
        'Confira a pendência antes de atender. Este aviso não comprova pagamento ou entrega.',
      )
      .setFooter({ text: 'ROYAL AP  •  EQUIPE' });
    await canal.send({ embeds: [embed], allowedMentions: { parse: [] } });
    return true;
  } catch (erro) {
    console.warn('[economia] aviso à staff não enviado:', erro.message);
    return false;
  }
}
module.exports = { avisarStaff };
