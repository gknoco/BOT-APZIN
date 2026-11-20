'use strict';

/** Moderação: blacklist, limpeza, anúncios, DMs e logs. */

const { SlashCommandBuilder, ChannelType } = require('discord.js');
const config = require('../config');
const persistenciaSupabase = require('../servicos/supabase');
const blacklist = require('../servicos/blacklist');
const paineis = require('../servicos/paineis');
const auditoria = require('../servicos/auditoria');
const { exigirStaff, exigirAdmin, responderPrivado, responderErro } = require('../util/seguranca');
const { embed, embedSucesso, embedErro, mencao, dataBR } = require('../util/embeds');

const espera = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CANAIS_ANUNCIO = [
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.AnnouncementThread,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
];
function validarCanalAnuncio(interaction, canal) {
  if (!canal?.id || typeof canal.send !== 'function' || !CANAIS_ANUNCIO.includes(canal.type)) {
    throw new Error('O destino precisa ser um canal de texto ou thread deste servidor.');
  }
  const guildId = canal.guildId || canal.guild?.id;
  if (String(guildId || '') !== String(interaction.guildId || '')) {
    throw new Error('O canal de anúncio precisa pertencer a este servidor.');
  }
  const bot = interaction.guild?.members?.me || interaction.client?.user;
  const permissoes = canal.permissionsFor?.(bot);
  const thread = [ChannelType.AnnouncementThread, ChannelType.PublicThread, ChannelType.PrivateThread].includes(canal.type);
  if (permissoes && (!permissoes.has?.('ViewChannel') || !permissoes.has?.(thread ? 'SendMessagesInThreads' : 'SendMessages'))) {
    throw new Error('O bot não tem permissão para visualizar e enviar mensagens nesse canal.');
  }
  return canal;
}

const comandos = [
  {
    data: new SlashCommandBuilder()
      .setName('blacklist')
      .setDescription('Lista negra de jogadores')
      .addSubcommand((sub) =>
        sub
          .setName('adicionar')
          .setDescription('Bloqueia um jogador de entrar nas filas')
          .addUserOption((o) => o.setName('usuario').setDescription('Jogador').setRequired(true))
          .addStringOption((o) => o.setName('motivo').setDescription('Motivo do bloqueio').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('remover')
          .setDescription('Tira um jogador da lista negra')
          .addUserOption((o) => o.setName('usuario').setDescription('Jogador').setRequired(true)),
      )
      .addSubcommand((sub) => sub.setName('listar').setDescription('Mostra todos os bloqueados')),

    async executar(interaction, { db, client }) {
      if (!(await exigirStaff(interaction))) return;
      const sub = interaction.options.getSubcommand();

      if (sub === 'listar') {
        const lista = await blacklist.listar(db, interaction.guildId);
        const corpo = lista.length
          ? lista
              .map(
                (linha) =>
                  `${mencao(linha.user_id)} — **${linha.motivo}**\n┄ por ${mencao(linha.autor_id)} em ${dataBR(linha.criado_em)}`,
              )
              .join('\n\n')
          : 'Ninguém na lista negra. 🙌';
        return responderPrivado(interaction, {
          embeds: [embed('🚫 Lista negra', corpo, { cor: config.CORES.erro })],
        });
      }

      if (!(await exigirAdmin(interaction, 'Só ADM pode alterar a lista negra.'))) return;
      const alvo = interaction.options.getUser('usuario');

      if (sub === 'adicionar') {
        const motivo = interaction.options.getString('motivo');
        const bloqueio = await blacklist.adicionar(db, {
          guildId: interaction.guildId,
          userId: alvo.id,
          motivo,
          autorId: interaction.user.id,
        });
        for (const { modo, preco } of bloqueio?.filas_afetadas || []) {
          try {
            const atualizado = await paineis.atualizar(client, db, { guildId: interaction.guildId, modo, preco });
            if (!atualizado) console.error(`[blacklist] não consegui atualizar painel ${modo}/${preco} após bloqueio.`);
          } catch (erro) {
            console.error(`[blacklist] falha ao atualizar painel ${modo}/${preco} após bloqueio:`, erro.message);
          }
        }
        await auditoria.registrar(db, client, {
          guildId: interaction.guildId,
          autorId: interaction.user.id,
          acao: 'Blacklist adicionada',
          detalhe: `${mencao(alvo.id)} · ${motivo}`,
        });
        return responderPrivado(interaction, {
          embeds: [embedSucesso(`${mencao(alvo.id)} foi bloqueado de entrar nas filas.\nMotivo: **${motivo}**`)],
        });
      }

      const removeu = await blacklist.remover(db, { guildId: interaction.guildId, userId: alvo.id });
      if (!removeu) return responderErro(interaction, `${mencao(alvo.id)} não estava na lista negra.`);

      await auditoria.registrar(db, client, {
        guildId: interaction.guildId,
        autorId: interaction.user.id,
        acao: 'Blacklist removida',
        detalhe: mencao(alvo.id),
      });
      return responderPrivado(interaction, {
        embeds: [embedSucesso(`${mencao(alvo.id)} saiu da lista negra e já pode entrar nas filas.`)],
      });
    },
  },


  {
    data: new SlashCommandBuilder()
      .setName('anunciar')
      .setDescription('Envia um anúncio oficial formatado')
      .addStringOption((opcao) => opcao.setName('titulo').setDescription('Título do anúncio').setRequired(true).setMaxLength(253))
      .addStringOption((opcao) => opcao.setName('mensagem').setDescription('Texto do anúncio').setRequired(true).setMaxLength(4000))
      .addChannelOption((opcao) => opcao.setName('canal').setDescription('Canal (vazio = aqui)').addChannelTypes(...CANAIS_ANUNCIO)),

    async executar(interaction, { db, client }) {
      if (!(await exigirAdmin(interaction))) return;
      const titulo = interaction.options.getString('titulo');
      const mensagem = interaction.options.getString('mensagem');
      const canal = validarCanalAnuncio(interaction, interaction.options.getChannel('canal') ?? interaction.channel);

      const enviado = await canal.send({
        content: '@everyone',
        embeds: [
          embed(`📢 ${titulo}`, mensagem, {
            cor: config.CORES.ouro,
            rodape: `ORG Royal AP · por ${interaction.user.username}`,
          }),
        ],
        allowedMentions: { parse: ['everyone'] },
      });

      await auditoria.registrar(db, client, {
        guildId: interaction.guildId,
        autorId: interaction.user.id,
        acao: 'Anúncio publicado',
        detalhe: `${titulo} em ${canal.name} · ${enviado.id}`,
      });

      return responderPrivado(interaction, { content: `✅ Anúncio publicado em ${canal}.` });
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('anunciar2')
      .setDescription('Anúncio simples e direto no canal atual (só staff)')
      .addStringOption((opcao) =>
        opcao
          .setName('texto')
          .setDescription('Mensagem do anúncio')
          .setRequired(true)
          .setMaxLength(1800),
      ),

    async executar(interaction, { db, client }) {
      if (!(await exigirStaff(interaction, 'Só a staff/ADM pode anunciar.'))) return;

      const texto = String(interaction.options.getString('texto') || '').trim();
      if (!texto) return responderErro(interaction, 'Escreva o texto do anúncio.');

      const canal = interaction.channel;
      try { validarCanalAnuncio(interaction, canal); }
      catch (erro) { return responderErro(interaction, erro.message); }

      // Mesmo padrão visual do /anunciar, só que sem título e sem formulário.
      const enviado = await canal.send({
        embeds: [
          embed('📢 Anúncio · ORG Royal AP', texto, {
            cor: config.CORES.ouro,
            rodape: `ORG Royal AP · por ${interaction.user.username}`,
          }),
        ],
        allowedMentions: { parse: [] },
      });

      await auditoria.registrar(db, client, {
        guildId: interaction.guildId,
        autorId: interaction.user.id,
        acao: 'Anúncio simples publicado',
        detalhe: `#${canal.name || canal.id} · ${enviado.id}`,
      });

      return responderPrivado(interaction, { content: `✅ Anúncio publicado em ${canal}.` });
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('enviar_dm')
      .setDescription('Envia uma mensagem privada pelo bot')
      .addUserOption((opcao) => opcao.setName('usuario').setDescription('Quem recebe').setRequired(true))
      .addStringOption((opcao) => opcao.setName('mensagem').setDescription('Texto da mensagem').setRequired(true)),

    async executar(interaction, { db, client }) {
      if (!(await exigirStaff(interaction))) return;
      const alvo = interaction.options.getUser('usuario');
      const mensagem = interaction.options.getString('mensagem');

      try {
        await alvo.send({
          embeds: [embed('📩 Mensagem da ORG Royal AP', mensagem, { rodape: 'Não responda esta mensagem: fale com a staff no servidor.' })],
        });
      } catch (erro) {
        return interaction.editReply({
          content: `❌ Não consegui mandar DM para ${mencao(alvo.id)} (a pessoa pode ter DMs fechadas).\n\`${erro.message}\``,
        });
      }

      const { error } = await db.client.from('royal_logs_dm').insert({
        guild_id: String(interaction.guildId),
        user_id: String(alvo.id),
        autor_id: String(interaction.user.id),
        mensagem,
        criado_em: Date.now(),
      });
      if (error) throw new Error(`A DM foi enviada, mas não consegui salvar seu registro no Supabase: ${error.message}`);

      await auditoria.registrar(db, client, {
        guildId: interaction.guildId,
        autorId: interaction.user.id,
        acao: 'DM enviada',
        detalhe: mencao(alvo.id),
      });
      return interaction.editReply({ content: `✅ DM enviada para ${mencao(alvo.id)}.` });
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('envio_massa')
      .setDescription('Envia uma mensagem para todos os membros (com confirmação)')
      .addStringOption((opcao) => opcao.setName('mensagem').setDescription('Texto que todos vão receber').setRequired(true))
      .addBooleanOption((opcao) =>
        opcao.setName('confirmar').setDescription('Marcar como true só depois de conferir o texto').setRequired(true),
      ),

    async executar(interaction, { db, client }) {
      if (!(await exigirAdmin(interaction))) return;
      const mensagem = interaction.options.getString('mensagem');
      const confirmar = interaction.options.getBoolean('confirmar');
      const guild = interaction.guild;

      let membros;
      try {
        membros = await guild.members.fetch();
      } catch (erro) {
        return responderErro(
          interaction,
          'Não consegui ler a lista de membros. Ative a opção **Server Members Intent** no Developer Portal (menu Bot).',
        );
      }
      const alvos = membros.filter((membro) => !membro.user.bot).first(config.LIMITES.DM_MASSA);

      if (!confirmar) {
        return responderPrivado(interaction, {
          embeds: [
            embed(
              '⚠️ Confirmação necessária',
              `Essa mensagem vai para **${alvos.length}** membros (limite ${config.LIMITES.DM_MASSA}).\n\n` +
                `**Texto:** ${mensagem}\n\n` +
                'Se estiver certo, rode de novo com `confirmar: true`.',
              { cor: config.CORES.aviso },
            ),
          ],
        });
      }

      let enviadas = 0;
      let falhas = 0;
      for (const membro of alvos) {
        try {
          await membro.send({ embeds: [embed('📣 Recado da ORG Royal AP', mensagem)] });
          enviadas += 1;
        } catch {
          falhas += 1;
        }
        await espera(150);
      }

      await auditoria.registrar(db, client, {
        guildId: interaction.guildId,
        autorId: interaction.user.id,
        acao: 'Envio em massa',
        detalhe: `${enviadas} enviadas, ${falhas} falhas`,
      });

      return interaction.editReply({
        content: `📣 Envio em massa terminado: **${enviadas}** entregues, **${falhas}** falharam (DM fechada ou membro saiu).`,
      });
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('limpardm')
      .setDescription('Apaga o histórico de DMs do bot com um jogador')
      .addUserOption((opcao) => opcao.setName('usuario').setDescription('Jogador').setRequired(true)),

    async executar(interaction, { db }) {
      if (!(await exigirAdmin(interaction))) return;
      const alvo = interaction.options.getUser('usuario');
      const { count, error } = await db.client.from('royal_logs_dm').delete({ count: 'exact' })
        .eq('guild_id', String(interaction.guildId)).eq('user_id', String(alvo.id));
      if (error) throw new Error(`Não consegui apagar o histórico de DMs no Supabase: ${error.message}`);
      return responderPrivado(interaction, {
        content: `🧹 Apaguei **${count ?? 0}** registro(s) de DM com ${mencao(alvo.id)}.`,
      });
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('logs')
      .setDescription('Define ou mostra o canal de auditoria')
      .addChannelOption((opcao) => opcao.setName('canal').setDescription('Canal que vai receber os logs')),

    async executar(interaction, { db }) {
      if (!(await exigirAdmin(interaction))) return;
      const canal = interaction.options.getChannel('canal');

      if (canal) {
        await persistenciaSupabase.definirConfig(interaction.guildId, 'canal_logs', canal.id, db.client);
        return responderPrivado(interaction, {
          embeds: [embedSucesso(`Canal de logs salvo com sucesso no banco de dados (Supabase): ${canal}.\nTudo que a staff fizer vai aparecer lá.`)],
        });
      }

      const [canalSalvo, recentes] = await Promise.all([
        persistenciaSupabase.obterConfig(interaction.guildId, 'canal_logs', db.client),
        auditoria.recentes(db, interaction.guildId, 10),
      ]);
      const atual = canalSalvo || config.CANAL_LOGS_ID;
      const corpo = recentes.length
        ? recentes
            .map((linha) => `\`${dataBR(linha.criado_em)}\` **${linha.acao}** — ${linha.detalhe || '—'}`)
            .join('\n')
        : 'Nenhuma ação registrada ainda.';

      return responderPrivado(interaction, {
        embeds: [
          embed('📋 Auditoria', corpo, {
            campos: [{ name: 'Canal de logs', value: atual ? `<#${atual}>` : 'não definido', inline: true }],
          }),
        ],
      });
    },
  },
];

module.exports = { comandos, validarCanalAnuncio };
