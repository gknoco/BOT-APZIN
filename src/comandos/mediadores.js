'use strict';

/** Configuração e painéis separados do plantão de mediadores. */

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const mediadores = require('../servicos/mediadores');
const plantao = require('../servicos/plantao');
const plantaoModalidade = require('../servicos/plantaoModalidade');
const persistenciaSupabase = require('../servicos/supabase');
const { obterConfig } = require('../db');
const { exigirAdmin, responderPrivado, responderErro } = require('../util/seguranca');
const { embedSucesso } = require('../util/embeds');

async function publicarPainel(interaction, payload, sucesso) {
  const canal = interaction.channel;
  if (!canal?.send) return responderErro(interaction, 'Use este comando em um canal de texto.');
  const mensagem = await canal.send(payload).catch((erro) => {
    console.error('[mediadores] não consegui publicar o painel:', erro.message);
    return null;
  });
  if (!mensagem) return responderErro(interaction, 'Não consegui publicar o painel neste canal.');
  await mensagem.pin?.().catch(() => {});
  return responderPrivado(interaction, { embeds: [embedSucesso(`${sucesso} Painel fixado em <#${canal.id}>.`)] });
}

function podeUsarPainel(member) {
  return plantao.autorizado(member);
}

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
      .setName('painelpixmediadores')
      .setDescription('Publica o painel de registro de PIX dos mediadores'),
    async executar(interaction, { db }) {
      if (!podeUsarPainel(interaction.member)) {
        return responderErro(interaction, `Apenas membros com o cargo <@&${plantao.CARGO_MEDIADOR_ACESSO}> podem usar este comando.`);
      }
      const canalId = interaction.channelId;
      await persistenciaSupabase.definirConfig(interaction.guildId, 'canal_configpix', canalId);
      await mediadores.definirCanalConfigPix(db, interaction.guildId, canalId);
      return publicarPainel(interaction, plantao.painelRegistroPix(), 'Registro de PIX publicado com sucesso.');
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('painelbatepontomediadores')
      .setDescription('Publica o painel de bate-ponto dos mediadores'),
    async executar(interaction, { db }) {
      if (!podeUsarPainel(interaction.member)) {
        return responderErro(interaction, `Apenas membros com o cargo <@&${plantao.CARGO_MEDIADOR_ACESSO}> podem usar este comando.`);
      }
      if (String(await obterConfig(db, interaction.guildId, 'canal_partidas_formadas', '') || '') === String(interaction.channelId)) {
        return responderErro(interaction, 'O painel de bate-ponto não pode ser publicado no canal de partidas formadas.');
      }
      await persistenciaSupabase.definirConfig(interaction.guildId, 'canal_bateponto', interaction.channelId);
      await mediadores.definirCanalBatePonto(db, interaction.guildId, interaction.channelId);
      return publicarPainel(interaction, await plantao.painel(db, interaction.guildId), 'Bate-ponto dos mediadores publicado com sucesso.');
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName('painelpixss')
      .setDescription('Publica o painel de registro e gestão de PIX para SS Mobile e SS EMU'),
    async executar(interaction) {
      const autorizado = plantaoModalidade.autorizado(interaction.member, 'ss_mobile')
        || plantaoModalidade.autorizado(interaction.member, 'ss_emu');
      if (!autorizado) {
        return responderErro(interaction, 'Apenas membros com cargo SS Mobile ou SS EMU podem usar este painel.');
      }
      return publicarPainel(interaction, plantao.painelPixSS(), 'Painel PIX SS publicado com sucesso.');
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
          embeds: [embedSucesso(`Bate-ponto resetado com sucesso. ${resultado.removidos}/${resultado.encontrados} cargo(s) de plantão removido(s).${avisoFalhas}`)],
        });
      } catch (erro) {
        console.error(`[mediadores] falha ao resetar bate-ponto da guild ${interaction.guildId}:`, erro);
        return responderErro(interaction, erro.message);
      }
    },
  },
];

const paineisEspeciais = [
  ['painelbatepontossmobile', 'ss_mobile', 'Publica o painel de bate-ponto SS Mobile'],
  ['painelbatepontossemu', 'ss_emu', 'Publica o painel de bate-ponto SS EMU'],
].flatMap(([nome, modalidade, descricao]) => [
  {
    data: new SlashCommandBuilder().setName(nome).setDescription(descricao),
    async executar(interaction, { db }) {
      if (!(await exigirAdmin(interaction, 'Só ADM pode publicar este painel de bate-ponto.'))) return;
      return publicarPainel(interaction, await plantaoModalidade.painel(db, interaction.guildId, modalidade), `Painel ${plantaoModalidade.obterModalidade(modalidade).label} publicado com sucesso.`);
    },
  },
  {
    data: new SlashCommandBuilder()
      .setName(nome.replace('painel', 'limpar'))
      .setDescription(`Limpa o plantão ${plantaoModalidade.obterModalidade(modalidade).label} e remove o cargo específico`),
    async executar(interaction, { db }) {
      if (!(await exigirAdmin(interaction, 'Só ADM pode limpar este plantão.'))) return;
      const resultado = await plantaoModalidade.limparComCargo(interaction.guild, db, modalidade);
      const aviso = resultado.falhas.length ? ` ${resultado.falhas.length} remoção(ões) falharam por permissão.` : '';
      return responderPrivado(interaction, {
        embeds: [embedSucesso(`Plantão ${plantaoModalidade.obterModalidade(modalidade).label} resetado. ${resultado.removidos}/${resultado.encontrados} cargo(s) removido(s).${aviso}`)],
      });
    },
  },
]);

comandos.push(...paineisEspeciais);

module.exports = { comandos };
