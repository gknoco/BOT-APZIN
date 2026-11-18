'use strict';

/**
 * /mediadores          → painel de configuração (cargos, canais, modo).
 * /painel_mediadores   → publica o painel institucional no canal atual:
 *   tipo:fila     → bate-ponto (Entrar/Sair/Atualizar/Config)
 *   tipo:registro → Central de Pagamentos (Configurar PIX / Verificar Cadastro)
 */

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const mediadores = require('../servicos/mediadores');
const plantao = require('../servicos/plantao');
const persistenciaSupabase = require('../servicos/supabase');
const { obterConfig } = require('../db');
const { exigirAdmin, responderPrivado, responderErro } = require('../util/seguranca');
const { embedSucesso } = require('../util/embeds');

const comandos = [
  {
    data: new SlashCommandBuilder()
      .setName('mediadores')
      .setDescription('Painel de configuração dos mediadores (cargos, canais e modo)')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async executar(interaction, { db }) {
      if (!(await exigirAdmin(interaction, 'Só ADM pode configurar o módulo de mediadores.'))) return;
      await mediadores.hidratarConfiguracaoRemota(db, interaction.guildId);
      return responderPrivado(interaction, await mediadores.painelConfig(db, interaction.guildId));
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('painel_mediadores')
      .setDescription('Publica o painel de plantão ou o painel de PIX no canal atual')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption((opcao) =>
        opcao
          .setName('tipo')
          .setDescription('Qual painel publicar')
          .addChoices(
            { name: 'Fila / bate-ponto dos mediadores', value: 'fila' },
            { name: 'Registro de PIX', value: 'registro' },
          ),
      ),

    async executar(interaction, { db }) {
      if (!(await exigirAdmin(interaction, 'Só ADM pode publicar os painéis de mediação.'))) return;

      const tipo = interaction.options.getString('tipo') || 'fila';
      const canal = interaction.channel;
      if (!canal?.send) {
        return responderErro(interaction, 'Use esse comando em um canal de texto.');
      }

      const chaveCanal = tipo === 'registro' ? 'canal_configpix' : 'canal_bateponto';
      if (tipo === 'fila' && String(await obterConfig(db, interaction.guildId, 'canal_partidas_formadas', '') || '') === String(canal.id)) {
        return responderErro(interaction, 'O painel de bate-ponto não pode ser publicado no canal configurado para partidas formadas. Escolha outro canal.');
      }
      await persistenciaSupabase.definirConfig(interaction.guildId, chaveCanal, canal.id);
      const painel = tipo === 'registro' ? plantao.painelRegistroPix() : await plantao.painel(db, interaction.guildId);
      const mensagem = await canal.send(painel).catch((erro) => {
        console.error('[mediadores] não consegui publicar o painel:', erro.message);
        return null;
      });
      if (!mensagem) return responderErro(interaction, 'Não consegui publicar o painel neste canal.');

      if (typeof mensagem.pin === 'function') await mensagem.pin().catch(() => {});

      if (tipo === 'fila') await mediadores.definirCanalBatePonto(db, interaction.guildId, canal.id);
      else await mediadores.definirCanalConfigPix(db, interaction.guildId, canal.id);

      return responderPrivado(interaction, {
        embeds: [
          embedSucesso(
            tipo === 'registro'
              ? `Central de Pagamentos publicada e fixada em <#${canal.id}>. Canal salvo com sucesso no banco de dados (Supabase).`
              : `Fila de mediadores publicada e fixada em <#${canal.id}>. Canal salvo com sucesso no banco de dados (Supabase).`,
          ),
        ],
      });
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('limparbatepapomediadores')
      .setDescription('Reseta o plantão e remove o cargo de mediador de plantão')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async executar(interaction, { db }) {
      if (!(await exigirAdmin(interaction, 'Só ADM pode limpar o bate-ponto dos mediadores.'))) return;
      try {
        const resultado = await plantao.limparComCargo(interaction.guild, db);
        const avisoFalhas = resultado.falhas.length
          ? ` ${resultado.falhas.length} remoção(ões) falharam; verifique a hierarquia/permissões do bot.`
          : '';
        return responderPrivado(interaction, {
          embeds: [embedSucesso(
            `Bate-ponto resetado com sucesso. ${resultado.removidos}/${resultado.encontrados} cargo(s) de plantão removido(s).${avisoFalhas}`,
          )],
        });
      } catch (erro) {
        console.error(`[mediadores] falha ao resetar bate-ponto da guild ${interaction.guildId}:`, erro);
        return responderErro(interaction, erro.message);
      }
    },
  },
];

module.exports = { comandos };
