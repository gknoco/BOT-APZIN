'use strict';

const { SlashCommandBuilder } = require('discord.js');
const config = require('./configEconomia');

function comandoConfig(nome, descricao, dominio) {
  return {
    data: new SlashCommandBuilder().setName(nome).setDescription(descricao).setDMPermission(false),
    async executar(interaction) {
      return config.abrirConfiguracao(interaction, dominio);
    },
  };
}

const comandos = [
  comandoConfig('configroleta', 'Abre a configuração mestre da roleta', 'roleta'),
];

module.exports = { comandos };
