'use strict';

/**
 * Eventos do Discord: conexão, interações, convites, entradas e erros.
 */

const { EmbedBuilder, Events } = require('discord.js');
const config = require('../config');
const comandos = require('../comandos');
const { handleBotao } = require('../interacoes/botoes');
const { handleSelect } = require('../interacoes/selects');
const { handleModal } = require('../interacoes/modais');
const roletaPro = require('../comandos/roletaPro');
const lojinhaPro = require('../comandos/lojinhaPro');
const configEconomia = require('../comandos/configEconomia');
const convites = require('../servicos/convites');
const auditoria = require('../servicos/auditoria');
const royalSupabase = require('../servicos/royalSupabase');
const { registrarComandos, limparComandoGo } = require('../servicos/registroComandos');
const membros = require('./membros');
const mediadores = require('../servicos/mediadores');
const cotasMediadores = require('../servicos/cotasMediadores');
const fluxo = require('../servicos/fluxo');
const { embedErro } = require('../util/embeds');
const { responderPrivado } = require('../util/seguranca');
const automacoes = require('../servicos/automacoesDiscord');
const estadoRuntime = require('../estadoRuntime');
const permissoesComandos = require('../servicos/permissoesComandos');
const configComandos = require('../comandos/configComandos');

// Compartilhado entre chamadas repetidas de montar(client, db): uma mesma
// interação nunca pode iniciar dois handlers concorrentes (p.ex. dois modais).
const interacoesVistasPorCliente = new WeakMap();
const contextosPorCliente = new WeakMap();
const CANAL_LOG_INVITES = '1543685343591800832';

async function publicarLogInvite(guild, titulo, descricao, cor) {
  const canal = await guild.channels.fetch(CANAL_LOG_INVITES).catch((erro) => {
    console.error('[convites] não consegui buscar o canal de logs:', erro.message);
    return null;
  });
  if (!canal?.isTextBased?.() || typeof canal.send !== 'function') return null;
  return canal.send({
    embeds: [new EmbedBuilder().setColor(cor).setTitle(titulo).setDescription(descricao).setTimestamp()],
    allowedMentions: { parse: [] },
  });
}

async function autorizarComando(interaction, db) {
  if (!interaction?.commandName || !interaction?.guildId) return true;
  let acesso;
  try {
    acesso = await permissoesComandos.verificarAcesso(interaction, db?.client || db?.supabase);
  } catch (erro) {
    console.error('[permissoes-comandos] não foi possível validar o acesso:', erro.message);
    await responderPrivado(interaction, { content: 'Não foi possível validar as permissões deste comando agora. Tente novamente em instantes.', allowedMentions: { parse: [] } });
    return false;
  }
  if (acesso.permitido) return true;
  const cargosNecessarios = acesso.cargos.map((id) => `<@&${id}>`).join(', ');
  await responderPrivado(interaction, {
    content: `⛔ Este comando está restrito a ${cargosNecessarios}. Você precisa ter pelo menos um desses cargos; administradores podem executar qualquer comando.`,
    allowedMentions: { parse: [] },
  });
  return false;
}

function primeiraEntrega(client, interaction) {
  let vistas = interacoesVistasPorCliente.get(client);
  if (!vistas) {
    vistas = new Set();
    interacoesVistasPorCliente.set(client, vistas);
  }
  const id = String(interaction.id || '');
  if (!id || vistas.has(id)) return false;
  vistas.add(id);
  // Limite memória sem abrir uma janela de duplicação normal do Gateway.
  if (vistas.size > 10_000) {
    for (const antigo of vistas) {
      vistas.delete(antigo);
      if (vistas.size <= 8_000) break;
    }
  }
  return true;
}

function montar(client, db) {
  if (contextosPorCliente.has(client)) return contextosPorCliente.get(client);
  const ctx = { db, client };
  contextosPorCliente.set(client, ctx);
  let preparado = false;
  membros.registrar(client, db);

  let tarefaReady;
  client.once(Events.ClientReady, (conectado) => {
    tarefaReady ||= preparar(conectado);
    return tarefaReady;
  });

  async function preparar(conectado) {
    console.log(`\n✅ Conectado como ${conectado.user.tag}`);
    console.log(`   Servidores: ${conectado.guilds.cache.size}`);
    let filasPublicadas;
    for (let tentativa = 1; tentativa <= 6; tentativa++) {
      try {
        // Não libera handlers sem validar a fonte de verdade, inclusive após falhas de rede.
        for (const guild of conectado.guilds.cache.values()) {
          await mediadores.hidratarConfiguracaoRemota(db, guild.id);
        }
        const { count, error } = await db.client.from('royal_paineis')
          .select('modo', { count: 'exact', head: true });
        if (error) throw new Error(`Não consegui contar os painéis no Supabase: ${error.message}`);
        filasPublicadas = count || 0;
        preparado = true;
        break;
      } catch (erro) {
        console.error(`[ready] preparação Supabase falhou (tentativa ${tentativa}/6):`, erro.message);
        if (tentativa === 6) {
          console.error('[ready] tentativas esgotadas; encerrando para reinício pelo supervisor.');
          const encerramentos = await Promise.allSettled([
            Promise.resolve().then(() => client.destroy()),
            Promise.resolve().then(() => db.close()),
          ]);
          for (const resultado of encerramentos) {
            if (resultado.status === 'rejected') console.error('[ready] falha no encerramento:', resultado.reason);
          }
          process.exit(1);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (tentativa - 1)));
      }
    }
    try {
      conectado.user.setActivity('AP da ORG Royal AP', { type: 3 });
    } catch {
      /* atividade é opcional */
    }

    try {
      const lista = comandos.definicoes();
      const registro = await registrarComandos({
        token: config.TOKEN,
        clientId: conectado.application.id,
        guildId: config.GUILD_ID,
        definicoes: lista,
      });
      if (registro.guildId) {
        const guild = conectado.guilds.cache.get(registro.guildId);
        console.log(`✅ ${lista.length} comandos registrados em "${guild?.name || registro.guildId}" (na hora).`);
      } else {
        console.log(`✅ ${lista.length} comandos registrados globalmente (pode levar até 1 hora).`);
        console.log('   Dica: defina GUILD_ID nas variáveis de ambiente para aparecer na hora.');
      }
      // A sincronização substitui apenas o escopo escolhido. Limpe /go nos
      // demais escopos conhecidos sem sobrescrever os outros comandos neles.
      void limparComandoGo({
        token: config.TOKEN,
        clientId: conectado.application.id,
        incluirGlobal: Boolean(registro.guildId),
        guildIds: [...conectado.guilds.cache.keys()].filter((id) => String(id) !== registro.guildId),
      }).then((limpeza) => {
        if (limpeza.removidos) console.log(`[comandos] ${limpeza.removidos} /go antigo(s) removido(s) de outros escopos.`);
        for (const erro of limpeza.erros) console.warn(`[comandos] não foi possível verificar /go em ${erro.escopo}: ${erro.mensagem}`);
      }).catch((erro) => console.warn('[comandos] não foi possível verificar /go em outros escopos:', erro.message));
      console.log(`   Painéis de AP já publicados: ${filasPublicadas}/15\n`);
    } catch (erro) {
      const detalhes = [erro.code && `código ${erro.code}`, erro.status && `HTTP ${erro.status}`, erro.message]
        .filter(Boolean)
        .join(' | ');
      console.error('❌ Não consegui registrar os comandos:', detalhes);
      if (/Missing Access|Missing Permissions/i.test(erro.message)) {
        console.error('   Convide o bot novamente com o escopo applications.commands.');
      }
      console.error('   Após corrigir token/IDs/permissões, execute npm run commands:sync para tentar novamente.');
    }

    for (const guild of conectado.guilds.cache.values()) {
      await convites.atualizarCache(guild).catch(() => {});
    }
    automacoes.iniciar(conectado, db);
    for (const guild of conectado.guilds.cache.values()) {
      fluxo.restaurarCartoesPartida(conectado, db, guild.id).catch((erro) => {
        console.error(`[fluxo] não foi possível restaurar cartões da guild ${guild.id}:`, erro.message);
      });
      roletaPro.restaurarPainelSalvo(guild, ctx).catch((erro) => {
        console.error('[roletapro] não foi possível restaurar o painel salvo:', erro.message);
      });
    }
  }

  client.on(Events.InteractionCreate, async (interaction) => {
    // Precisa acontecer de forma síncrona, antes de qualquer await de cargo,
    // Supabase ou outro serviço.
    if (!primeiraEntrega(client, interaction)) {
      console.warn(`[interacao] evento duplicado ignorado: ${interaction.id}`);
      return;
    }
    try {
      if (!preparado) {
        await responderPrivado(interaction, {
          embeds: [embedErro('O bot está preparando a persistência na nuvem. Tente de novo em alguns segundos.')],
        });
        return;
      }
      if (interaction.isChatInputCommand()) {
        if (!(await autorizarComando(interaction, db))) return;
        await comandos.executar(interaction, ctx);
        return;
      }
      // /ajuda possui seu próprio coletor local para paginação.
      if (String(interaction.customId || '').startsWith('ajuda:')) return;
      // Custom IDs estáveis permitem que painéis públicos continuem operando
      // após reinicializações, sem depender de coletores em memória.
      const customId = String(interaction.customId || '');
      if (customId.startsWith('cmdperm:')) {
        await configComandos.handleComponent(interaction, ctx);
        return;
      }
      if (customId.startsWith('roletapro:')) {
        await roletaPro.handleComponent(interaction, ctx);
        return;
      }
      if (customId.startsWith('lojinhapro:')) {
        await lojinhaPro.handleComponent(interaction, ctx);
        return;
      }
      if (customId.startsWith('configeco:')) {
        await configEconomia.handleComponent(interaction, ctx);
        return;
      }
      if (interaction.isButton()) {
        const tratado = await handleBotao(interaction, ctx);
        if (!tratado) {
          console.warn(`[interacao] botão sem tratamento: ${interaction.customId}`);
        }
        return;
      }
      // Qualquer menu de seleção (texto, CARGO, CANAL, usuário…) vai para o
      // mesmo tratador. Se só o de texto fosse tratado, os menus de cargo e de
      // canal ficariam sem resposta e o Discord mostraria "não respondeu a tempo".
      const ehMenu =
        interaction.isStringSelectMenu?.() ||
        interaction.isRoleSelectMenu?.() ||
        interaction.isChannelSelectMenu?.() ||
        interaction.isUserSelectMenu?.() ||
        interaction.isMentionableSelectMenu?.() ||
        interaction.isAnySelectMenu?.();
      if (ehMenu) {
        await handleSelect(interaction, ctx);
        return;
      }
      if (interaction.isModalSubmit()) {
        await handleModal(interaction, ctx);
        return;
      }
    } catch (erro) {
      console.error(`[interacao] erro em ${interaction.customId || interaction.commandName}:`, erro);
      try {
        const aviso = {
          embeds: [embedErro('Deu um erro aqui. A staff já foi avisada — tente de novo em alguns segundos.')],
        };
        // O helper escolhe reply/editReply/followUp e trata inclusive 40060,
        // quando o Discord aceitou o ACK, mas a resposta HTTP se perdeu.
        await responderPrivado(interaction, aviso);
      } catch {
        /* se nem isso funcionar, o log acima já registrou */
      }
      await auditoria
        .registrar(db, client, {
          guildId: interaction.guildId,
          autorId: interaction.user?.id,
          acao: 'Erro em interação',
          detalhe: `${interaction.customId || interaction.commandName} · ${erro.message}`,
        })
        .catch(() => {});
    }
  });

  client.on(Events.GuildMemberAdd, async (membro) => {
    try {
      const codigo = await convites.detectar(membro);
      if (codigo) {
        const guild = membro.guild;
        const cacheConvites = await guild.invites.fetch().catch(() => null);
        const convite = cacheConvites?.get(codigo);
        if (convite?.inviter) {
          await royalSupabase.registrarInvite({
            guildId: guild.id,
            invitedUserId: membro.id,
            inviterUserId: convite.inviter.id,
            code: codigo,
          }).catch((erro) => console.error('[convites] Supabase:', erro.message));
          const contagem = await royalSupabase.contarConvites(guild.id, convite.inviter.id).catch(() => null);
          await publicarLogInvite(
            guild,
            '📨 Invite utilizado',
            `<@${membro.id}> entrou usando o convite de <@${convite.inviter.id}>.\n` +
              `**Convite:** \`${codigo}\`\n` +
              (contagem === null ? '' : `**Invites reais atuais:** ${contagem}`),
            0xfacc15,
          ).catch((erro) => console.error('[convites] log de entrada:', erro.message));
          await royalSupabase.auditar({
            guildId: guild.id,
            actorId: convite.inviter.id,
            action: 'member.join',
            entityType: 'invite',
            entityId: membro.id,
            detail: `convite ${codigo}`,
          }).catch(() => {});
        }
      }
    } catch (erro) {
      console.error('[convites] erro ao registrar convite:', erro.message);
    }
  });

  const atualizarConvites = (guild) => convites.atualizarCache(guild).catch(() => {});
  client.on(Events.InviteCreate, (convite) => atualizarConvites(convite.guild));
  client.on(Events.InviteDelete, (convite) => atualizarConvites(convite.guild));

  client.on(Events.GuildMemberRemove, async (membro) => {
    try {
      const registro = await royalSupabase.removerInvite(membro.guild.id, membro.id);
      if (!registro?.inviter_user_id) return;
      await publicarLogInvite(
        membro.guild,
        '📤 Membro convidado saiu',
        `<@${membro.id}> saiu do servidor. O invite de <@${registro.inviter_user_id}> foi atualizado.\n` +
          `**Invites reais:** ${Number(registro.invites_reais || 0)} · **Saídas:** ${Number(registro.invites_saidas || 0)}`,
        0xfacc15,
      );
      await royalSupabase.auditar({
        guildId: membro.guild.id,
        actorId: registro.inviter_user_id,
        action: 'member.leave',
        entityType: 'invite',
        entityId: membro.id,
        detail: 'invite decrementado após saída',
      }).catch(() => {});
    } catch (erro) {
      console.error('[convites] erro ao remover invite:', erro.message);
    }
  });

  client.on(Events.GuildMemberUpdate, async (anterior, atual) => {
    const tinhaCargo = anterior.roles.cache.has(cotasMediadores.CARGO_MEDIADOR);
    const recebeuCargo = atual.roles.cache.has(cotasMediadores.CARGO_MEDIADOR);
    if (!recebeuCargo || tinhaCargo) return;
    await cotasMediadores.inicializar(db, atual.guild.id, atual.id).catch((erro) => {
      console.error('[cotas] não consegui inicializar a cota do mediador:', erro.message);
    });
  });

  client.on(Events.Error, (erro) => console.error('[discord] erro do cliente:', erro.message));

  return ctx;
}

function ligarProcesso(db, recursos = {}) {
  let desligando = false;
  const desligar = async (sinal, codigo = 0) => {
    if (desligando) return;
    desligando = true;
    console.log(`\n👋 Recebi ${sinal}, encerrando recursos com segurança (código ${codigo})...`);
    const limite = setTimeout(() => process.exit(1), 10_000);
    try {
      recursos.pararWorker?.();
    } catch (erro) {
      console.error('[processo] falha ao parar worker:', erro?.stack || erro);
    }
    try {
      await recursos.client?.destroy?.();
    } catch (erro) {
      console.error('[processo] falha ao encerrar cliente Discord:', erro?.stack || erro);
    }
    try {
      const servidor = recursos.servidorHttp;
      if (servidor?.listening) {
        const fechado = new Promise((resolve) => servidor.close(() => resolve()));
        servidor.closeAllConnections?.();
        await fechado;
      }
    } catch (erro) {
      console.error('[processo] falha ao fechar servidor HTTP:', erro?.stack || erro);
    }
    try {
      await db?.close?.();
    } catch (erro) {
      console.error('[processo] falha ao fechar o banco:', erro?.stack || erro);
      codigo = 1;
    }
    clearTimeout(limite);
    process.exit(codigo);
  };
  const encerrarPorFalha = (tipo, motivo) => {
    const erro = motivo instanceof Error ? motivo : new Error(String(motivo));
    estadoRuntime.marcarDegradado(tipo);
    console.error(`[processo] ${tipo} fatal; iniciando encerramento controlado:`, erro.stack || erro);
    void desligar(tipo, 1).catch((falha) => {
      console.error('[processo] falha durante encerramento fatal:', falha?.stack || falha);
      process.exit(1);
    });
  };
  process.once('uncaughtException', (erro) => encerrarPorFalha('uncaught_exception', erro));
  process.once('unhandledRejection', (motivo) => encerrarPorFalha('unhandled_rejection', motivo));
  process.on('SIGINT', () => { void desligar('SIGINT', process.exitCode || 0).catch((erro) => { console.error('[processo] desligamento:', erro?.stack || erro); process.exit(1); }); });
  process.on('SIGTERM', () => { void desligar('SIGTERM', process.exitCode || 0).catch((erro) => { console.error('[processo] desligamento:', erro?.stack || erro); process.exit(1); }); });
}

module.exports = { montar, ligarProcesso, autorizarComando };
