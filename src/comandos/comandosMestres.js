'use strict';

const { SlashCommandBuilder } = require('discord.js');
const roleta = require('./roletaPro');
const lojinha = require('./lojinhaPro');
const config = require('./configEconomia');

function comandoPainel(nome, descricao, publicar) {
  return {
    data: new SlashCommandBuilder().setName(nome).setDescription(descricao).setDMPermission(false),
    async executar(interaction, ctx = {}) {
      return publicar(interaction, ctx);
    },
  };
}

function comandoConfig(nome, descricao, dominio) {
  return {
    data: new SlashCommandBuilder().setName(nome).setDescription(descricao).setDMPermission(false),
    async executar(interaction) {
      return config.abrirConfiguracao(interaction, dominio);
    },
  };
}

const comandos = [
  comandoPainel('lojinhapainel', 'Publica e fixa o painel público oficial da lojinha', lojinha.publicarPainel),
  comandoConfig('configroleta', 'Abre a configuração mestre da roleta', 'roleta'),
];

module.exports = { comandos };
