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
      .setName('registrar_pix')
      .setDescription('Cadastra sua chave PIX de mediador (aparece nas salas que você assumir)')
      .addStringOption((opcao) =>
        opcao.setName('chave').setDescription('Sua chave PIX (CPF, e-mail, telefone ou aleatória)').setRequired(true),
      )
      .addStringOption((opcao) => opcao.setName('titular').setDescription('Nome de quem recebe')),

    async executar(interaction, { db, client }) {
      if (!(await staffSupabase.temCargoMediador(interaction.guildId, interaction.member))) {
        return responderErro(interaction, 'Só staff/mediador com cargo pode registrar PIX.');
      }

      const chave = interaction.options.getString('chave');
      const titular = interaction.options.getString('titular');

      const registro = await staffSupabase.registrarPix({
        guildId: interaction.guildId,
        userId: interaction.user.id,
        chave,
        titular,
      });

      await auditoria.registrar(db, client, {
        guildId: interaction.guildId,
        autorId: interaction.user.id,
        acao: 'PIX de mediador atualizado',
        detalhe: `${mencao(interaction.user.id)} · taxa fixa de R$ 0,10 por capitão`,
      });

      return responderPrivado(interaction, {
        embeds: [
          embedSucesso(
              `Sua chave PIX foi salva e vai aparecer nas salas que você assumir.\n` +
              `**Chave:** \`${registro.pix_chave}\`\n` +
              '**Taxa do mediador:** R$ 0,10 por capitão\n\n' +
              '_A chave fica visível apenas para os jogadores das suas salas._',
          ),
        ],
      });
    },
  },

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
          'Cadastre sua chave primeiro: `/registrar_pix chave:SuaChave`.',
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

  {
    data: new SlashCommandBuilder()
      .setName('painel_mediador')
      .setDescription('Publica o painel de controle da moderação/mediadores'),

    async executar(interaction, { db, client }) {
      if (!(await exigirMediador(interaction))) return;
      const ativas = await partidas.ativasReais(db, interaction.guildId, client);
      const pendentes = ativas.filter((partida) => partida.status !== 'confirmando').length;
      const registroPix = await staffSupabase.obter(interaction.guildId, interaction.user.id);

      const embedPainel = embed(
        '👑 Painel do Mediador',
        [
          '**Rotina de uma sala:**',
          '1. Assuma a sala pelo botão **Assumir sala** dentro do canal do AP.',
          '2. Clique em **Enviar PIX** (ou use `/pix` na sala) e confira os comprovantes.',
          '3. Clique em **Pagamento recebido** e depois em **Liberar sala** com o ID e a senha.',
          '4. No fim, declare o vencedor pelo botão ou com `/vencedor`.',
          '',
          '**Comandos úteis:** `/vencedor` · `/wo` · `/registrar_pix` · `/pix`',
        ].join('\n'),
        {
          cor: config.CORES.principal,
          campos: [
            { name: 'Salas em andamento', value: String(ativas.length), inline: true },
            { name: 'Aguardando você', value: String(pendentes), inline: true },
            {
              name: 'Taxa do mediador',
              value: registroPix
                ? 'R$ 0,10 por capitão'
                : 'sem PIX cadastrado',
              inline: true,
            },
          ],
          rodape: 'ORG Royal AP',
        },
      );

      const botoes = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ap:minhasalas').setLabel('Minhas salas').setEmoji('📋').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('ap:pixinfo').setLabel('Meu PIX').setEmoji('💸').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('ap:ranking').setLabel('Ranking').setEmoji('🏆').setStyle(ButtonStyle.Secondary),
      );

      await interaction.channel.send({ embeds: [embedPainel], components: [botoes] });
      return responderPrivado(interaction, { content: '✅ Painel do mediador publicado neste canal.' });
    },
  },


];

module.exports = { comandos, lerPaginado };
