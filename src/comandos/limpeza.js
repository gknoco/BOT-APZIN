'use strict';

/** Limpeza silenciosa do canal sem clonar nem substituir o canal. */
const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const { responderErro } = require('../util/seguranca');
const config = require('../config');
const IDADE_LIMITE_EM_MASSA = 14 * 24 * 60 * 60 * 1000;
const PERMISSAO_PADRAO = PermissionFlagsBits.ManageMessages;
const MAXIMO_CLEAR = 100000;
const MAXIMO_LIMPAR = config.LIMITES.MENSAGENS_LIMPAR;

function podeLimpar(interaction) {
  const permissoes = interaction.memberPermissions;
  return Boolean(
    permissoes?.has?.(PermissionFlagsBits.ManageMessages) ||
      permissoes?.has?.(PermissionFlagsBits.Administrator),
  );
}
function verificarCanal(canal) {
  if (!canal?.isTextBased?.() || !canal.messages?.fetch || typeof canal.bulkDelete !== 'function') {
    throw new Error('Este comando só funciona em canais de texto com histórico de mensagens.');
  }
}
function ehMensagemDesconhecida(erro) {
  return Number(erro?.code) === 10008 || erro?.name === 'UnknownMessage' || /^Unknown Message$/i.test(erro?.message || '');
}
function ehCanalDesconhecido(erro) {
  return Number(erro?.code) === 10003 || erro?.name === 'UnknownChannel' || /^Unknown Channel$/i.test(erro?.message || '');
}
async function apagarSeExiste(mensagem) {
  try {
    await mensagem.delete();
    return true;
  } catch (erro) {
    if (ehMensagemDesconhecida(erro)) return false;
    throw erro;
  }
}
/** Apaga exatamente as mensagens recebidas, usando exclusão individual para as antigas. */
async function apagarLote(canal, mensagens) {
  const corte = Date.now() - IDADE_LIMITE_EM_MASSA;
  const recentes = mensagens.filter((mensagem) => Number(mensagem.createdTimestamp) > corte);
  const antigas = mensagens.filter((mensagem) => Number(mensagem.createdTimestamp) <= corte);
  let apagadas = 0;
  if (recentes.length === 1) {
    if (await apagarSeExiste(recentes[0])) apagadas += 1;
  } else if (recentes.length > 1) {
    try {
      const resultado = await canal.bulkDelete(recentes, false);
      apagadas += resultado.size;
      if (resultado.size !== recentes.length) {
        for (const mensagem of recentes) {
          if (!resultado.has(mensagem.id) && await apagarSeExiste(mensagem)) apagadas += 1;
        }
      }
    } catch (erro) {
      if (!ehMensagemDesconhecida(erro)) throw erro;
      for (const mensagem of recentes) if (await apagarSeExiste(mensagem)) apagadas += 1;
    }
  }
  for (const mensagem of antigas) if (await apagarSeExiste(mensagem)) apagadas += 1;
  return apagadas;
}
async function apagarQuantidade(canal, quantidade) {
  verificarCanal(canal);
  let apagadas = 0;
  while (apagadas < quantidade) {
    const limite = Math.min(100, quantidade - apagadas);
    let lote;
    try { lote = await canal.messages.fetch({ limit: limite }); }
    catch (erro) { if (ehCanalDesconhecido(erro)) return apagadas; throw erro; }
    const mensagens = [...lote.values()].slice(0, limite);
    if (mensagens.length === 0) throw new Error(`Só consegui apagar ${apagadas} mensagem(ns); não havia mais mensagens no canal.`);
    let progresso;
    try { progresso = await apagarLote(canal, mensagens); }
    catch (erro) { if (ehCanalDesconhecido(erro)) return apagadas; throw erro; }
    if (progresso === 0) throw new Error('A limpeza parou porque nenhuma mensagem foi apagada.');
    apagadas += progresso;
  }
  return apagadas;
}
async function apagarTudo(canal) {
  verificarCanal(canal);
  let apagadas = 0;
  let lotesSemProgresso = 0;
  while (true) {
    let progresso;
    try {
      const lote = await canal.messages.fetch({ limit: 100 });
      const mensagens = [...lote.values()];
      if (mensagens.length === 0) return apagadas;
      progresso = await apagarLote(canal, mensagens);
    } catch (erro) {
      if (ehCanalDesconhecido(erro)) return apagadas;
      throw erro;
    }
    if (progresso === 0) {
      lotesSemProgresso += 1;
      if (lotesSemProgresso >= 3) return apagadas;
      continue;
    }
    lotesSemProgresso = 0;
    apagadas += progresso;
  }
}
async function removerResposta(interaction) {
  try { await interaction.deleteReply(); }
  catch (erro) {
    if (ehMensagemDesconhecida(erro) || ehCanalDesconhecido(erro) || [10015, 10062, 50027].includes(Number(erro?.code))) return;
    throw erro;
  }
}
async function executarLimpeza(interaction, quantidade, tudo = false) {
  if (!podeLimpar(interaction)) {
    return responderErro(interaction, 'Você precisa de **Manage Messages** ou **Administrator** para usar este comando.');
  }
  if (tudo) await apagarTudo(interaction.channel);
  else await apagarQuantidade(interaction.channel, quantidade);
  return removerResposta(interaction);
}
const comandoQuantidade = (nome, descricao, maximo) => ({
  data: new SlashCommandBuilder().setName(nome).setDescription(descricao)
    .addIntegerOption((opcao) => opcao.setName('quantidade').setDescription(`Quantidade a apagar (1 a ${maximo.toLocaleString('pt-BR')})`).setRequired(true).setMinValue(1).setMaxValue(maximo))
    .setDefaultMemberPermissions(PERMISSAO_PADRAO),
  defer: 'privado',
  async executar(interaction) { return executarLimpeza(interaction, interaction.options.getInteger('quantidade')); },
});
const comandos = [
  comandoQuantidade('limpar', 'Apaga mensagens recentes e antigas do canal', MAXIMO_LIMPAR),
  {
    data: new SlashCommandBuilder().setName('clearall').setDescription('Apaga todas as mensagens deste canal, inclusive as antigas').setDefaultMemberPermissions(PERMISSAO_PADRAO),
    defer: 'privado',
    async executar(interaction) { return executarLimpeza(interaction, null, true); },
  },
  comandoQuantidade('clear', 'Apaga a quantidade indicada das mensagens mais recentes deste canal', MAXIMO_CLEAR),
];
module.exports = { comandos, apagarLote, apagarQuantidade, apagarTudo, podeLimpar, apagarSeExiste, ehMensagemDesconhecida, ehCanalDesconhecido, removerResposta, executarLimpeza };
