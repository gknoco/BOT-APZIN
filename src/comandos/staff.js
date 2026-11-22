'use strict';

/** Comandos da staff: PIX e painel do mediador. */

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder,
} = require('discord.js');
const config = require('../config');
const staffSupabase = require('../servicos/staffSupabase');
const partidas = require('../servicos/partidas');
const auditoria = require('../servicos/auditoria');
const fluxo = require('../servicos/fluxo');
const {
  exigirStaff,
  exigirMediador,
  ehAdmin,
  ehMediador,
  responderPrivado,
  responderErro,
} = require('../util/seguranca');
const { embed, embedSucesso, mencao } = require('../util/embeds');

async function lerPaginado(db, tabela, colunas, filtrar) {
  const registros = [];
  const tamanhoPagina = 500;
  for (let inicio = 0; ; inicio += tamanhoPagina) {
    const consulta = filtrar(db.client.from(tabela).select(colunas));
    const { data, error } = await consulta.range(inicio, inicio + tamanhoPagina - 1);
    if (error) throw new Error(`Não consegui consultar ${tabela} no Supabase: ${error.message}`);
    registros.push(...(data || []));
    if (!data || data.length < tamanhoPagina) return registros;
  }
}

const comandos = [
  {
    data: new SlashCommandBuilder()
      .setName('pix')
      .setDescription('Envia sua chave PIX na sala de AP que você está mediando'),

    async executar(interaction, { db, client }) {
      if (!(await staffSupabase.temCargoMediador(interaction.guildId, interaction.member))) {
        return responderErro(interaction, 'Só o mediador da sala pode enviar o PIX.');
      }

      // Pode ser usado em QUALQUER canal: procura a sala do mediador.
      const abertas = await lerPaginado(db, 'royal_partidas', 'id,canal_id,mediador_id,status', (consulta) =>
        consulta.eq('guild_id', String(interaction.guildId)).in('status', ['aguardando_pagamento', 'pago'])
          .order('id', { ascending: false }));

      let partida = abertas.find((linha) => String(linha.canal_id) === String(interaction.channelId)) || null;

      if (!partida) {
        const minhas = abertas.filter(
          (linha) => !linha.mediador_id || String(linha.mediador_id) === String(interaction.user.id),
        );
        if (minhas.length === 1) {
          [partida] = minhas;
        } else if (minhas.length > 1) {
          return responderErro(
            interaction,
            'Você tem mais de uma sala aguardando PIX. Use `/pix` dentro do canal da sala desejada:\n' +
              minhas.map((linha) => `• <#${linha.canal_id}>`).join('\n'),
          );
        }
      }

      if (!partida) {
        return responderErro(
          interaction,
          'Nenhuma sala aguardando PIX agora. Abra o `/pix` dentro da sala ou aguarde o pagamento dos jogadores.',
        );
      }

      const registro = await staffSupabase.obter(interaction.guildId, interaction.user.id);
      if (!registro?.pix_chave) {
        return responderErro(
          interaction,
          'Cadastre sua chave no painel `/painelpixmediadores` antes de enviar o PIX.',
        );
      }

      if (partida.mediador_id && partida.mediador_id !== interaction.user.id && !ehAdmin(interaction.member)) {
        return responderErro(interaction, 'Essa sala é de outro mediador.');
      }

      try {
        await fluxo.anunciarPix(client, db, {
          partidaId: partida.id,
          mediadorId: interaction.user.id,
          chave: registro.pix_chave,
          titular: registro.pix_titular,
        });
        await auditoria.registrar(db, client, {
          guildId: interaction.guildId,
          autorId: interaction.user.id,
          acao: 'PIX enviado na sala',
          detalhe: `Sala ${partida.id} · chave PIX enviada (valor omitido)`,
        });
        return responderPrivado(interaction, {
          embeds: [embedSucesso('PIX enviado na sala e na DM dos jogadores. Confira os comprovantes.')],
        });
      } catch (erro) {
        return responderErro(interaction, erro.message);
      }
    },
  },

];

module.exports = { comandos, lerPaginado };
