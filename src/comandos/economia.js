'use strict';

/** Economia: perfis, Royal Coins, giros e vitórias persistidos no Supabase. */

const { SlashCommandBuilder } = require('discord.js');
const royal = require('../servicos/royalSupabase');
const { exigirStaff, exigirAdmin, responderPrivado } = require('../util/seguranca');
const { embedSucesso, numeroBR, mencao } = require('../util/embeds');

const comandos = [
  {
    data: new SlashCommandBuilder()
      .setName('addgiros')
      .setDescription('Adiciona (ou tira) giros de um jogador')
      .addUserOption((opcao) => opcao.setName('usuario').setDescription('Jogador').setRequired(true))
      .addIntegerOption((opcao) =>
        opcao.setName('quantidade').setDescription('Quantidade (use negativo para tirar)').setRequired(true),
      ),

    async executar(interaction, { db, client }) {
      if (!(await exigirStaff(interaction))) return;
      const alvo = interaction.options.getUser('usuario');
      const quantidade = interaction.options.getInteger('quantidade');
      if (!Number.isInteger(quantidade) || quantidade === 0) throw new Error('A quantidade de giros não pode ser zero.');
      const perfil = await royal.ajustarPerfil({
        guildId: interaction.guildId,
        userId: alvo.id,
        deltas: { spins: quantidade },
        reason: 'ajuste da staff',
        actorId: interaction.user.id,
        request: interaction.id,
      });
      await royal.auditarAjusteGiros({
        guildId: interaction.guildId,
        actorId: interaction.user.id,
        userId: alvo.id,
        quantidade,
        motivo: 'ajuste da staff',
        requestId: interaction.id,
      });
      return responderPrivado(interaction, {
        embeds: [embedSucesso(`${mencao(alvo.id)} agora tem **${numeroBR(perfil.spins)}** giros.`)],
      });
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('addvitoria')
      .setDescription('Soma vitórias no perfil do jogador')
      .addUserOption((opcao) => opcao.setName('usuario').setDescription('Jogador').setRequired(true))
      .addIntegerOption((opcao) =>
        opcao.setName('quantidade').setDescription('Quantas vitórias somar').setMinValue(1).setMaxValue(50),
      ),

    async executar(interaction, { db, client }) {
      if (!(await exigirStaff(interaction))) return;
      const alvo = interaction.options.getUser('usuario');
      const quantidade = interaction.options.getInteger('quantidade') ?? 1;
      const perfil = await royal.ajustarPerfil({
        guildId: interaction.guildId,
        userId: alvo.id,
        deltas: { wins: quantidade, coins: quantidade },
        reason: 'vitória manual',
        actorId: interaction.user.id,
        request: interaction.id,
      });
      await royal.auditar({
        guildId: interaction.guildId,
        actorId: interaction.user.id,
        action: 'profile.wins.adjust',
        entityType: 'profile',
        entityId: alvo.id,
        requestId: interaction.id,
        detail: `+${quantidade} vitória(s)`,
      });
      return responderPrivado(interaction, {
        embeds: [embedSucesso(`+${quantidade} vitória(s) e +${quantidade} Royal Coins para ${mencao(alvo.id)}.\nAgora: **${perfil.wins}V / ${perfil.losses}D**.`)],
      });
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('vitoria')
      .setDescription('Registra uma vitória (e opcionalmente o valor apostado)')
      .addUserOption((opcao) => opcao.setName('usuario').setDescription('Jogador').setRequired(true))
      .addNumberOption((opcao) =>
        opcao.setName('valor').setDescription('Valor apostado em reais (ex: 5 ou 5,50)').setMinValue(0),
      ),

    async executar(interaction, { db, client }) {
      if (!(await exigirStaff(interaction))) return;
      const alvo = interaction.options.getUser('usuario');
      const valor = interaction.options.getNumber('valor') ?? 0;
      const centavos = Math.max(0, Math.round(valor * 100));
      const perfil = await royal.ajustarPerfil({
        guildId: interaction.guildId,
        userId: alvo.id,
        deltas: { wins: 1, coins: 1, apostado: centavos, ganho: centavos },
        reason: 'vitória manual',
        actorId: interaction.user.id,
        request: interaction.id,
      });
      await royal.auditar({
        guildId: interaction.guildId,
        actorId: interaction.user.id,
        action: 'profile.win.register',
        entityType: 'profile',
        entityId: alvo.id,
        requestId: interaction.id,
        detail: `vitória; apostado/ganho ${centavos} centavos`,
      });
      const total = perfil.wins + perfil.losses;
      const aproveitamento = total ? Math.round((perfil.wins / total) * 100) : 0;
      return responderPrivado(interaction, {
        embeds: [
          embedSucesso(
            `Vitória registrada para ${mencao(alvo.id)}${centavos ? ` (R$ ${(centavos / 100).toFixed(2).replace('.', ',')})` : ''}.\n` +
              `Perfil: **${perfil.wins}V / ${perfil.losses}D** · ${aproveitamento}% de aproveitamento.\n` +
              `Recompensa: **+1 Royal Coin**.`,
          ),
        ],
      });
    },
  },

  ...['addcoins', 'removercoins'].map((nome) => ({
    data: new SlashCommandBuilder()
      .setName(nome)
      .setDescription(nome === 'addcoins' ? 'Adiciona Royal Coins para um jogador' : 'Remove Royal Coins de um jogador')
      .addUserOption((o) => o.setName('usuario').setDescription('Jogador').setRequired(true))
      .addIntegerOption((o) => o.setName('quantidade').setDescription('Quantidade de Royal Coins').setRequired(true)),

    async executar(interaction) {
      const credito = nome === 'addcoins';
      const alvo = interaction.options.getUser('usuario');
      const quantidade = interaction.options.getInteger('quantidade');

      if (!(await exigirAdmin(interaction, 'Só ADM pode mexer no saldo de outra pessoa.'))) return;
      if (!Number.isInteger(quantidade) || quantidade <= 0) throw new Error('Informe uma quantidade maior que zero.');
      const valor = credito ? quantidade : -quantidade;
      const perfil = await royal.ajustarPerfil({
        guildId: interaction.guildId,
        userId: alvo.id,
        deltas: { coins: valor },
        reason: credito ? 'crédito da staff' : 'débito da staff',
        actorId: interaction.user.id,
        request: interaction.id,
      });
      await royal.auditar({
        guildId: interaction.guildId,
        actorId: interaction.user.id,
        action: credito ? 'wallet.coins.credit' : 'wallet.coins.debit',
        entityType: 'profile',
        entityId: alvo.id,
        requestId: interaction.id,
        detail: `${numeroBR(Math.abs(valor))} Royal Coins`,
      });

      return responderPrivado(interaction, {
        embeds: [
          embedSucesso(
            `${credito ? 'Adicionado' : 'Removido'} **${numeroBR(Math.abs(valor))} Royal Coins** de ${mencao(alvo.id)}.\n` +
              `Saldo agora: **${numeroBR(perfil.coins)}**.`,
          ),
        ],
      });
    },
  })),
];

module.exports = { comandos };
