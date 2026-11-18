'use strict';

/** Cliques em botões: fila, gelo, regras, mediação, PIX, resultado. */

const config = require('../config');
const fluxo = require('../servicos/fluxo');
const partidas = require('../servicos/partidas');
const staffSupabase = require('../servicos/staffSupabase');
const persistenciaSupabase = require('../servicos/supabase');
const filas = require('../servicos/filas');
const paineis = require('../servicos/paineis');
const plantao = require('../servicos/plantao');
const plantaoModalidade = require('../servicos/plantaoModalidade');
const salas = require('../servicos/salas');
const mediadores = require('../servicos/mediadores');
const auditoria = require('../servicos/auditoria');
const royalSupabase = require('../servicos/royalSupabase');
const comprasSalas = require('../servicos/comprasSalas');
const vendasDb = require('../servicos/roomSalesSupabase');
const extratoCarteira = require('../servicos/extratoCarteira');
const vendasUI = require('../comandos/vendas');
const recargaUI = require('../comandos/recarga');
const { embed, embedSucesso, embedErro, reais, mencao, mencaoCargo, dataBR } = require('../util/embeds');
const { MessageFlags } = require('discord.js');
const {
  EFEMERO,
  responderPrivado,
  responderErro,
  ehMediador,
  ehAdmin,
  ehStaff,
} = require('../util/seguranca');

const varianteNome = (modo, id) => config.varianteDoModo(modo, id)?.nome ?? String(id);

const { textoPagamentoAprovado } = comprasSalas;

function mensagemEfemera(interaction) {
  const flags = interaction.message?.flags;
  const bitfield = flags?.bitfield ?? flags;
  return Boolean(flags?.has?.(MessageFlags.Ephemeral) || (Number(bitfield) & MessageFlags.Ephemeral));
}

function payloadPainelRecarga() {
  const { AttachmentBuilder } = require('discord.js');
  return {
    embeds: [recargaUI.embedPainelRecarga()],
    files: [new AttachmentBuilder(recargaUI.BANNER_PATH, { name: recargaUI.BANNER_NOME })],
    attachments: [],
    components: recargaUI.componentesRecarga(),
    allowedMentions: { parse: [] },
  };
}

function payloadPainelSalaInfinita() {
  const { AttachmentBuilder } = require('discord.js');
  return {
    embeds: [recargaUI.embedSalaInfinita()],
    files: [new AttachmentBuilder(recargaUI.BANNER_INFINITA_PATH, { name: recargaUI.BANNER_INFINITA_NOME })],
    attachments: [],
    components: recargaUI.componentesSalaInfinita(),
    allowedMentions: { parse: [] },
  };
}

function payloadPainelExtrato(extrato, usuario) {
  return {
    content: '',
    embeds: [recargaUI.embedExtratoCarteira(extrato, usuario)],
    components: recargaUI.componentesExtrato(),
    allowedMentions: { parse: [] },
  };
}

function agendarExclusaoPainelCarteira(interaction, mensagem) {
  const alvo = mensagem?.delete
    ? mensagem
    : { delete: () => interaction.deleteReply() };
  return vendasUI.agendarExclusaoPainel(alvo);
}

/** O botão já pode ter sido reconhecido por deferUpdate antes da consulta PIX. */
async function responderVerificacaoPix(interaction, payload) {
  const corpo = typeof payload === 'string' ? { content: payload } : { ...payload };
  corpo.flags = (corpo.flags ?? 0) | EFEMERO;
  if (interaction.deferred || interaction.replied) return interaction.followUp(corpo);
  // O helper também trata o caso em que o Discord aceitou o ACK, mas o estado
  // local ainda está falso (40060): tenta followUp, nunca um segundo reply.
  return responderPrivado(interaction, corpo);
}

/**
 * Mensagem PÚBLICA na sala: quem confirmou, quem falta e a marcação da
 * @STAFF / @MEDIADOR — exatamente o texto combinado com a ORG.
 */
async function avisarConfirmacao(client, db, { partida, userId, completo, faltando = [] }) {
  try {
    const canal =
      client?.channels?.cache?.get?.(partida.canal_id) || (await client?.channels?.fetch?.(partida.canal_id));
    if (!canal?.send) return;

    // Só mediadores e ADM são marcados nas partidas (suporte fica no atendimento externo).
    const cargos = await mediadores.mencoes(db, partida.guild_id);
    const marcaStaff = cargos.length ? `\n${cargos.map((id) => mencaoCargo(id)).join(' ')}` : '';
    const restantes =
      faltando.length > 1
        ? `Agora faltam ${faltando.length} jogadores: ${faltando.map((id) => mencao(id)).join(', ')}.`
        : `Agora falta apenas ${mencao(faltando[0])} para confirmar.`;

    await canal.send({
      content: completo
        ? `✅ ${mencao(userId)} confirmou a partida. Todos confirmaram! Partida iniciando...${marcaStaff}`
        : `✅ ${mencao(userId)} confirmou a partida. ${restantes}${marcaStaff}`,
      allowedMentions: { users: [String(userId)], roles: cargos.map(String) },
    });
  } catch (erro) {
    console.error('[botoes] não consegui avisar a confirmação na sala:', erro.message);
  }
}

/**
 * Edita o PRÓPRIO card que o jogador clicou (não depende do ID salvo no banco).
 * É isso que garante o nome aparecendo na hora e o Sair só nesta faixa.
 */
async function atualizarCardDoClique(interaction, db, modo, preco) {
  const valor = Number(preco);
  if (!config.PRECOS.includes(valor)) return false;
  try {
    const entradas = await filas.listar(db, { guildId: interaction.guildId, modo: modo.id });
    const visual = await paineis.obterVisual(db, interaction.guildId);
    const card = paineis.mensagemPreco(modo, valor, entradas, visual);
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(card);
    } else if (typeof interaction.update === 'function') {
      await interaction.update(card);
    } else {
      await interaction.editReply(card);
    }
    return true;
  } catch (erro) {
    console.error('[botoes] não consegui editar o card da fila:', erro.message);
    return false;
  }
}

async function entrarNaFilaBotao(interaction, { db, client }, modoId, preco, gelo) {
  if (!interaction.guild) return responderErro(interaction, 'Use os painéis dentro do servidor.');
  const modo = config.modoPorId(modoId);
  if (!modo) return responderErro(interaction, 'Painel antigo. Peça para a staff publicar o painel de novo.');

  try {
    await fluxo.entrarNaFila(client, db, {
      guild: interaction.guild,
      userId: interaction.user.id,
      modo: modo.id,
      preco: Number(preco),
      gelo,
    });

    // Sem mensagem efêmera: o clique edita o card do painel na hora.
    await atualizarCardDoClique(interaction, db, modo, Number(preco));
    return true;
  } catch (erro) {
    if (/já está nessa fila/i.test(String(erro.message))) {
      return responderPrivado(interaction, { embeds: [embedErro(erro.message)] });
    }
    return responderErro(interaction, erro.message);
  }
}

async function sairDaFila(interaction, { db, client }, modoId, alvo) {
  const modo = config.modoPorId(modoId);
  if (!modo) return responderErro(interaction, 'Painel inválido.');
  const preco = alvo === 'todos' ? null : Number(alvo);

  const removidas = await filas.sair(db, {
    guildId: interaction.guildId,
    modo: modo.id,
    userId: interaction.user.id,
    preco,
  });
  if (!removidas) return responderErro(interaction, 'Você não está nessa fila.');
  await paineis.atualizar(client, db, { guildId: interaction.guildId, modo: modo.id, preco });
  // Sem mensagem extra: o próprio card volta para "Nenhum jogador" e perde o Sair.
  await atualizarCardDoClique(interaction, db, modo, preco);
  return true;
}

async function confirmarRegras(interaction, { db, client }, partidaId) {
  try {
    const resultado = await partidas.confirmar(db, partidaId, interaction.user.id);
    await fluxo.atualizarPartida(client, db, partidaId);

    const faltando = (await partidas.jogadores(db, partidaId))
      .filter((linha) => linha.confirmou !== 1)
      .map((linha) => linha.user_id);
    await avisarConfirmacao(client, db, {
      partida: resultado.partida,
      userId: interaction.user.id,
      completo: resultado.completo,
      faltando,
    });

    if (resultado.completo) {
      if (!resultado.jaConfirmou) await fluxo.notificarPartidaFormada(client, db, resultado.partida);
      return responderPrivado(interaction, {
        embeds: [embedSucesso('Todos confirmaram! ✅\nPartida iniciando — a staff já foi marcada na sala.')],
      });
    }

    return responderPrivado(interaction, {
      embeds: [
        embedSucesso(
          resultado.jaConfirmou
            ? 'Você já tinha confirmado. Falta o resto do pessoal.'
            : `Confirmação registrada: **${resultado.confirmados}/${resultado.total}**.\nAguardando os outros jogadores...`,
        ),
      ],
    });
  } catch (erro) {
    return responderErro(interaction, erro.message);
  }
}

async function assumirSala(interaction, { db, client }, partidaId) {
  if (!(await staffSupabase.temCargoMediador(interaction.guildId, interaction.member))) {
    return responderErro(interaction, 'Só mediadores/ADM podem assumir salas.');
  }
  const registro = await staffSupabase.obter(interaction.guildId, interaction.user.id);
  if (!registro?.pix_chave) {
    return responderErro(
      interaction,
      'Cadastre sua chave PIX antes de assumir uma sala: `/registrar_pix chave:SuaChave`.',
    );
  }

  try {
    // O modelo atual usa taxa fixa por capitão; não há comissão percentual.
    const partida = await partidas.assumir(db, partidaId, interaction.user.id);
    await fluxo.atualizarPartida(client, db, partidaId);
    await auditoria.registrar(db, client, {
      guildId: interaction.guildId,
      autorId: interaction.user.id,
      acao: 'Sala assumida',
      detalhe: `Sala ${partidaId} · ${reais(partida.preco)}`,
    });
    return responderPrivado(interaction, {
      embeds: [embedSucesso('Você assumiu a sala. Agora envie seu PIX e confira o pagamento.')],
    });
  } catch (erro) {
    return responderErro(interaction, erro.message);
  }
}

async function enviarPix(interaction, { db, client }, partidaId) {
  if (!(await staffSupabase.temCargoMediador(interaction.guildId, interaction.member))) return responderErro(interaction, 'Só o mediador da sala pode enviar o PIX.');
  const partida = await partidas.buscar(db, partidaId);
  if (!partida) return responderErro(interaction, 'Sala não encontrada.');

  const registro = await staffSupabase.obter(interaction.guildId, interaction.user.id);
  if (!registro?.pix_chave) {
    return responderErro(interaction, 'Você ainda não cadastrou PIX. Use `/registrar_pix`.');
  }
  if (partida.mediador_id && partida.mediador_id !== interaction.user.id) {
    return responderErro(interaction, 'Essa sala é de outro mediador.');
  }

  await fluxo.anunciarPix(client, db, {
    partidaId,
    mediadorId: interaction.user.id,
    chave: registro.pix_chave,
    titular: registro.pix_titular,
  });

  return responderPrivado(interaction, { embeds: [embedSucesso('PIX enviado na sala. Confira os comprovantes.')] });
}

async function pagamentoRecebido(interaction, { db, client }, partidaId) {
  if (!ehMediador(interaction.member)) return responderErro(interaction, 'Só o mediador pode confirmar o pagamento.');
  try {
    await partidas.marcarPago(db, partidaId);
    await fluxo.atualizarPartida(client, db, partidaId);
    await auditoria.registrar(db, client, {
      guildId: interaction.guildId,
      autorId: interaction.user.id,
      acao: 'Pagamento confirmado',
      detalhe: `Sala ${partidaId}`,
    });
    return responderPrivado(interaction, {
      embeds: [
        embedSucesso(
          'Pagamento confirmado ✅\nAgora clique em **Criar sala (Nix)** — o ID e a senha vão direto para o canal da fila.',
        ),
      ],
    });
  } catch (erro) {
    return responderErro(interaction, erro.message);
  }
}

async function fecharSala(interaction, { db, client }, partidaId) {
  if (!ehMediador(interaction.member)) return responderErro(interaction, 'Só a staff pode fechar a sala.');
  const partida = await partidas.buscar(db, partidaId);
  await responderPrivado(interaction, { content: '🔒 Fechando esta sala em 5 segundos...' });
  setTimeout(async () => {
    try {
      const canal =
        interaction.channel ??
        client.channels.cache.get(partida?.canal_id) ??
        (await client.channels.fetch(partida?.canal_id));
      await canal?.delete('Sala de AP encerrada');
    } catch (erro) {
      console.error('[botoes] não consegui fechar a sala:', erro.message);
    }
  }, 5000);
  return true;
}

async function tratarPlantaoModalidade(interaction, { db }, modalidade, acao) {
  const dados = plantaoModalidade.obterModalidade(modalidade);
  if (!plantaoModalidade.autorizado(interaction.member, modalidade)) {
    await responderErro(interaction, `Você precisa do cargo <@&${dados.cargoAcesso}> para usar o plantão ${dados.label}.`);
    return true;
  }

  if (acao === `${dados.prefixo}status`) {
    await interaction.editReply(await plantaoModalidade.painel(db, interaction.guildId, modalidade));
    return true;
  }

  if (acao === `${dados.prefixo}entrar`) {
    const cadastroPix = await staffSupabase.obter(interaction.guildId, interaction.user.id);
    if (!cadastroPix?.pix_chave) {
      await responderErro(interaction, 'Você precisa registrar seu Pix antes de entrar neste plantão.');
      return true;
    }
    try {
      await plantaoModalidade.adicionarCargo(interaction.guild, interaction.user.id, modalidade);
      try {
        await plantaoModalidade.entrar(db, interaction.guildId, interaction.user.id, modalidade);
      } catch (erro) {
        await plantaoModalidade.removerCargo(interaction.guild, interaction.user.id, modalidade).catch((rollback) => {
          console.error(`[botoes] rollback do cargo ${dados.label} falhou:`, rollback.message);
        });
        throw erro;
      }
      await interaction.editReply(await plantaoModalidade.painel(db, interaction.guildId, modalidade));
      await responderPrivado(interaction, { embeds: [embedSucesso(`Você entrou no plantão ${dados.label}.`)] });
    } catch (erro) {
      console.error(`[botoes] entrada no plantão ${dados.label}:`, erro);
      await responderErro(interaction, erro.message);
    }
    return true;
  }

  if (acao === `${dados.prefixo}sair`) {
    try {
      await plantaoModalidade.removerCargo(interaction.guild, interaction.user.id, modalidade);
      const saiu = await plantaoModalidade.sair(db, interaction.guildId, interaction.user.id, modalidade);
      await interaction.editReply(await plantaoModalidade.painel(db, interaction.guildId, modalidade));
      await responderPrivado(interaction, { embeds: [embedSucesso(saiu ? `Você saiu do plantão ${dados.label}.` : `Você não estava no plantão ${dados.label}.`)] });
    } catch (erro) {
      console.error(`[botoes] saída do plantão ${dados.label}:`, erro);
      await responderErro(interaction, erro.message);
    }
    return true;
  }

  return false;
}

async function handleBotao(interaction, ctx) {
  const partes = String(interaction.customId || '').split(':');
  if (partes[0] !== 'ap') return false;

  const acao = partes[1];
  const args = partes.slice(2);
  const { db, client } = ctx;

  // "regras" e "liberar" abrem modal: showModal precisa ser a PRIMEIRA resposta,
  // por isso esses dois não podem ser adiados.
  const abreModal =
    acao === 'filasavatar' || acao === 'filasbanner' || acao === 'addsalas' || acao === 'regras' || acao === 'liberar' || acao.startsWith('bot') || acao === 'pixregistrar' || acao === 'comprar' ||
    acao === 'comprarsaldo' ||
    acao === 'recargapix' || acao === 'recargasemanal' || acao === 'recargamensal';
  const painelRecargaPrivado = mensagemEfemera(interaction) &&
    ['recargasalainfinita', 'recargavoltar', 'extratovoltar'].includes(acao);
  const respostaPrivadaRecarga = acao === 'recargasalainfinita' || acao === 'recargaextrato';

  // Confirma o clique imediatamente (deferUpdate) em todos os outros casos:
  // o Discord nunca mostra "O aplicativo não respondeu". O painel continua
  // igual e o texto do resultado vai em mensagem privada (followUp).
  if (!abreModal && !painelRecargaPrivado && !respostaPrivadaRecarga && !interaction.deferred && !interaction.replied) {
    try {
      await interaction.deferUpdate();
    } catch (erro) {
      console.error(`[botoes] não consegui confirmar o clique em ${interaction.customId}:`, erro.message);
    }
  }

  try {
    switch (acao) {
      case 'ssmobileentrar':
      case 'ssmobilesair':
      case 'ssmobilestatus':
        return tratarPlantaoModalidade(interaction, ctx, 'ss_mobile', acao);

      case 'ssemuentrar':
      case 'ssemusair':
      case 'ssemustatus':
        return tratarPlantaoModalidade(interaction, ctx, 'ss_emu', acao);

      case 'entrar':
      case 'gelo':
        await entrarNaFilaBotao(interaction, ctx, args[0], args[1], args[2]);
        return true;

      case 'roletagirar': {
        try {
          const resultado = await royalSupabase.girar({ guildId: interaction.guildId, userId: interaction.user.id, request: interaction.id });
          let entrega = 'O giro e o prêmio foram registrados no Supabase.';
          if (resultado.reward_type === 'role') {
            try {
              if (!interaction.member?.roles?.add) throw new Error('Membro/cargo indisponível para entrega.');
              await interaction.member.roles.add(String(resultado.reward_value));
              await royalSupabase.marcarRecompensaEntregue({
                guildId: interaction.guildId,
                userId: interaction.user.id,
                request: interaction.id,
              });
              entrega = 'O cargo foi concedido.';
            } catch (erroEntrega) {
              await royalSupabase.auditar({
                guildId: interaction.guildId,
                actorId: interaction.user.id,
                action: 'reward.delivery.pending',
                entityType: 'roulette_spin',
                entityId: resultado.spin_id,
                requestId: interaction.id,
                detail: `Cargo pendente: ${String(erroEntrega.message || 'falha Discord').slice(0, 300)}`,
              });
              entrega = 'O prêmio foi registrado, mas a entrega do cargo ficou pendente para a staff.';
            }
          }
          await responderPrivado(interaction, {
            content: `🎰 Você ganhou **${resultado.prize_name}**! Recompensa: **${resultado.reward_type} · ${resultado.reward_value}**\n${entrega}`,
          });
        } catch (erro) {
          await responderErro(interaction, erro.message);
        }
        return true;
      }

      case 'sair':
        await sairDaFila(interaction, ctx, args[0], args[1]);
        return true;

      case 'confirmar':
        await confirmarRegras(interaction, ctx, args[0]);
        return true;

      case 'assumir':
        await responderErro(interaction, 'O aceite de filas ocorre exclusivamente no painel administrativo do canal configurado.');
        return true;

      case 'assumirnotificacao': {
        if (!ehAdmin(interaction.member)) {
          await responderErro(interaction, 'Somente administradores podem aceitar uma partida formada.');
          return true;
        }
        if (!(await plantao.ativo(db, { guildId: interaction.guildId, userId: interaction.user.id }))) {
          await responderErro(interaction, 'Você precisa estar no bate-ponto dos mediadores para aceitar filas!');
          return true;
        }
        await assumirSala(interaction, ctx, args[0]);
        const atual = await partidas.buscar(db, args[0]);
        if (atual?.mediador_id === interaction.user.id) {
          // O painel do canal administrativo desaparece assim que o lock do
          // Supabase confirma o mediador, sem esperar o aviso da sala privada.
          await interaction.message?.delete?.().catch?.(() => {});
          await fluxo.removerPainelNotificacao(client, db, interaction.guildId, args[0])
            .catch((erro) => console.error(`[botoes] não consegui remover o painel aceito ${args[0]}:`, erro));
          const avisoPublicado = await fluxo.concederAcessoPartida(client, db, args[0], interaction.user.id);
          if (avisoPublicado) {
            if (interaction.channel?.isThread?.()) await interaction.channel.delete('Partida aceita por um ADM de plantão').catch(() => {});
          } else {
            console.error(`[botoes] aceite ${args[0]} concluído, mas o aviso público não foi publicado na sala privada.`);
          }
        }
        return true;
      }

      case 'pix':
        await enviarPix(interaction, ctx, args[0]);
        return true;

      case 'pago':
        await pagamentoRecebido(interaction, ctx, args[0]);
        return true;

      case 'vencer': {
        if (!ehMediador(interaction.member)) {
          await responderErro(interaction, 'Só o mediador pode declarar o vencedor.');
          return true;
        }
        const time = Number(args[1]);
        const resultado = await fluxo.encerrarPartida(client, db, {
          partidaId: args[0],
          vencedorTime: time,
          autorId: interaction.user.id,
        });
        await responderPrivado(interaction, {
          content: `🏆 **${fluxo.nomeTime(time)}** venceu o AP de ${reais(resultado.partida.preco)}. Resultado salvo!`,
        });
        return true;
      }

      case 'wo': {
        if (!ehMediador(interaction.member)) {
          await responderErro(interaction, 'Só o mediador pode aplicar W.O.');
          return true;
        }
        const ausente = Number(args[1]);
        const resultado = await fluxo.aplicarWO(client, db, {
          partidaId: args[0],
          timeAusente: ausente,
          autorId: interaction.user.id,
        });
        await responderPrivado(interaction, {
          content:
            `⚠️ W.O. aplicado.\n**${fluxo.nomeTime(ausente)}** não apareceu — vitória de ` +
            `**${fluxo.nomeTime(resultado.partida.vencedor_time)}** (${reais(resultado.partida.preco)}).`,
        });
        return true;
      }

      case 'cancelar': {
        if (!ehMediador(interaction.member)) {
          await responderErro(interaction, 'Só a staff pode cancelar um AP.');
          return true;
        }
        await fluxo.cancelarPartida(client, db, {
          partidaId: args[0],
          autorId: interaction.user.id,
          motivo: `cancelada por ${interaction.user.tag}`,
        });
        await responderPrivado(interaction, { embeds: [embedSucesso('Sala cancelada e registrada na auditoria.')] });
        return true;
      }

      case 'fechar':
        return await fecharSala(interaction, { ...ctx, db }, args[0]);

      case 'filasavatar':
      case 'filasbanner': {
        if (!ehAdmin(interaction.member)) { await responderErro(interaction, 'Só administradores podem alterar o visual das filas.'); return true; }
        const { abrirModalVisualFilas } = require('./modais');
        await abrirModalVisualFilas(interaction, acao === 'filasavatar' ? 'avatar' : 'banner');
        return true;
      }

      case 'addsalas': {
        if (!ehAdmin(interaction.member)) { await responderErro(interaction, 'Somente administradores podem distribuir salas.'); return true; }
        const { selectAdm } = require('../comandos/addsalas');
        await selectAdm(interaction);
        return true;
      }

      case 'regras':
      case 'liberar': {
        // abre modal (tratado em interacoes/modais.js)
        const { abrirModalRegras, abrirModalSala } = require('./modais');
        if (acao === 'regras') await abrirModalRegras(interaction, db, args[0]);
        else await abrirModalSala(interaction, db, args[0]);
        return true;
      }

      case 'botnome':
      case 'botavatar':
      case 'botdescricao':
      case 'botstatus': {
        if (!ehAdmin(interaction.member)) {
          await responderErro(interaction, 'Só ADMs podem mudar o perfil do bot.');
          return true;
        }
        const { abrirModalBotPerfil } = require('./modais');
        await abrirModalBotPerfil(interaction, acao.replace(/^bot/, ''));
        return true;
      }

      case 'plantaoentrar': {
        // Exige um dos CARGOS configurados (Mediador/ADM). Só cai na permissão
        // de Administrador quando nenhum cargo foi configurado ainda.
        const cargosMed = await mediadores.cargos(db, interaction.guildId);
        const temCargo = await mediadores.temCargoMediador(db, interaction.guildId, interaction.member);
        if (!temCargo && !(cargosMed.length === 0 && ehAdmin(interaction.member))) {
          await responderErro(
            interaction,
            'Você não tem nenhum dos cargos configurados para mediação (Mediador/ADM). Fale com a administração.',
          );
          return true;
        }
        const cadastroPix = await staffSupabase.obter(interaction.guildId, interaction.user.id);
        if (!cadastroPix?.pix_chave) {
          await responderErro(interaction, 'Você precisa registrar seu Pix antes de entrar no bate-ponto. Vá até o canal <#1543684933522821130> para registrar.');
          return true;
        }
        try {
          await plantao.adicionarCargo(interaction.guild, interaction.user.id);
        } catch (erro) {
          console.error(`[botoes] não consegui adicionar o cargo de plantão na guild ${interaction.guildId}:`, erro);
          await responderErro(interaction, erro.message);
          return true;
        }
        try {
          await plantao.entrar(db, { guildId: interaction.guildId, userId: interaction.user.id });
        } catch (erro) {
          await plantao.removerCargo(interaction.guild, interaction.user.id).catch((rollback) => {
            console.error(`[botoes] falha ao desfazer cargo após erro de entrada no Supabase da guild ${interaction.guildId}:`, rollback);
          });
          throw erro;
        }
        await fluxo.notificarPartidasPendentes(client, db, interaction.guildId).catch((erro) => {
          console.error(`[botoes] não consegui publicar partidas pendentes após entrada no plantão da guild ${interaction.guildId}:`, erro);
        });
        await interaction.editReply(await plantao.painel(db, interaction.guildId));
        const posicao = await plantao.posicao(db, { guildId: interaction.guildId, userId: interaction.user.id });
        await responderPrivado(interaction, {
          embeds: [embedSucesso(`Você está no plantão${posicao ? ` (posição ${posicao})` : ''}. Boa! ⚡`)],
        });
        return true;
      }

      case 'plantaosair': {
        try {
          await plantao.removerCargo(interaction.guild, interaction.user.id);
        } catch (erro) {
          console.error(`[botoes] não consegui remover o cargo de plantão na guild ${interaction.guildId}:`, erro);
          await responderErro(interaction, erro.message);
          return true;
        }
        const saiu = await plantao.sair(db, { guildId: interaction.guildId, userId: interaction.user.id });
        await fluxo.ocultarPartidasPendentes(client, db, interaction.guildId).catch((erro) => {
          console.error(`[botoes] não consegui ocultar partidas pendentes após saída do plantão da guild ${interaction.guildId}:`, erro);
        });
        await interaction.editReply(await plantao.painel(db, interaction.guildId));
        await responderPrivado(interaction, {
          embeds: [embedSucesso(saiu ? 'Você saiu do plantão.' : 'Você não estava no plantão.')],
        });
        return true;
      }

      case 'plantaostatus': {
        await interaction.editReply(await plantao.painel(db, interaction.guildId));
        return true;
      }

      case 'medlimpar': {
        if (!ehAdmin(interaction.member)) {
          await responderErro(interaction, 'Só ADM configura o módulo de mediadores.');
          return true;
        }
        const removidos = await plantao.limpar(db, interaction.guildId);
        await interaction.editReply(await mediadores.painelConfig(db, interaction.guildId));
        await responderPrivado(interaction, {
          embeds: [embedSucesso(`Fila de mediadores limpa (${removidos} mediador(es) removido(s)).`)],
        });
        return true;
      }

      case 'medmodo': {
        if (!ehAdmin(interaction.member)) {
          await responderErro(interaction, 'Só ADM configura o módulo de mediadores.');
          return true;
        }
        const atual = await mediadores.modo(db, interaction.guildId);
        const novo = atual === 'rodizio' ? 'fila' : 'rodizio';
        await persistenciaSupabase.definirConfig(interaction.guildId, 'modo_mediadores', novo);
        await mediadores.definirModo(db, interaction.guildId, novo);
        await interaction.editReply(await mediadores.painelConfig(db, interaction.guildId));
        await responderPrivado(interaction, {
          embeds: [embedSucesso(`Modo de mediação salvo no banco de dados (Supabase): **${mediadores.MODOS[novo]}**.`)],
        });
        return true;
      }

      case 'medgestaopix': {
        if (!ehAdmin(interaction.member)) {
          await responderErro(interaction, 'Só ADM vê a gestão de PIX dos mediadores.');
          return true;
        }
        const mediadoresCadastrados = await staffSupabase.listar(interaction.guildId);
        const corpo = mediadoresCadastrados.length
          ? mediadoresCadastrados
              .map(
                (linha) =>
                  `${mencao(linha.user_id)} — ${linha.pix_chave ? 'PIX cadastrado' : '**sem PIX**'} · ` +
                  `taxa fixa de R$ 0,10 por capitão${linha.ativo ? '' : ' · inativo'}`,
              )
              .join('\n')
          : 'Nenhum mediador cadastrado ainda. Use `/registrar_pix`.';
        await responderPrivado(interaction, {
          embeds: [
            embed('💠 Gestão PIX · mediadores', corpo, {
              cor: config.CORES.principal,
              rodape: 'Chaves completas não aparecem aqui · ORG Royal AP',
            }),
          ],
        });
        return true;
      }

      case 'medreenviar': {
        if (!ehAdmin(interaction.member)) {
          await responderErro(interaction, 'Só ADM pode reenviar o painel de mediadores.');
          return true;
        }
        const canalPainel = interaction.channel;
        if (!canalPainel?.send) {
          await responderErro(interaction, 'Use esse botão em um canal de texto.');
          return true;
        }
        await canalPainel.send(await mediadores.painelConfig(db, interaction.guildId));
        await responderPrivado(interaction, {
          embeds: [embedSucesso('Painel de mediadores reenviado neste canal.')],
        });
        return true;
      }

      case 'pixregistrar': {
        // showModal deve ser o primeiro ACK e precisa chegar dentro de 3s.
        // A autorização é conferida obrigatoriamente no submit em aplicarPix.
        const { abrirModalPix } = require('./modais');
        await abrirModalPix(interaction);
        return true;
      }

      case 'pixverificar': {
        const registro = await staffSupabase.obter(interaction.guildId, interaction.user.id);
        const corpo = registro?.pix_chave
          ? `**Chave PIX:** \`${registro.pix_chave}\`\n**Titular:** ${registro.pix_titular || '—'}\n` +
            `**Cidade:** ${registro.pix_cidade || '—'}\n**Taxa do mediador:** R$ 0,10 por capitão`
          : 'Você ainda não cadastrou PIX. Clique em **Configurar Pix**.';
        await responderVerificacaoPix(interaction, { embeds: [embed('💠 Seu cadastro PIX', corpo)] });
        return true;
      }

      case 'comprar': {
        const { abrirModalCompra } = require('./modais');
        await abrirModalCompra(interaction, null);
        return true;
      }

      case 'comprarsaldo': {
        const { abrirModalCompraSaldo } = require('./modais');
        await abrirModalCompraSaldo(interaction);
        return true;
      }

      case 'verpacotes': {
        const mensagemPacotes = await responderPrivado(interaction, {
          embeds: [vendasUI.embedPacotes()],
          components: vendasUI.componentesPacotes(),
        });
        vendasUI.agendarExclusaoPainel(mensagemPacotes);
        return true;
      }

      case 'recargapix':
        await require('./modais').abrirModalRecarga(interaction);
        return true;

      case 'recargasalainfinita': {
        const payload = payloadPainelSalaInfinita();
        const mensagem = mensagemEfemera(interaction)
          ? await interaction.update(payload)
          : await responderPrivado(interaction, payload);
        agendarExclusaoPainelCarteira(interaction, mensagem);
        return true;
      }

      case 'recargavoltar': {
        const payload = payloadPainelRecarga();
        const mensagem = mensagemEfemera(interaction)
          ? await interaction.update(payload)
          : await responderPrivado(interaction, payload);
        agendarExclusaoPainelCarteira(interaction, mensagem);
        return true;
      }

      case 'recargasemanal':
      case 'recargamensal': {
        if (!interaction.guildId) {
          await responderErro(interaction, 'Abra o painel de assinatura dentro do servidor.');
          return true;
        }
        if (!(await mediadores.podeUsarSalas(db, interaction.guildId, interaction.member))) {
          await responderErro(interaction, mediadores.AVISO_CARGO);
          return true;
        }
        await require('./modais').abrirModalPlanoInfinito(interaction, acao === 'recargasemanal' ? 'semanal' : 'mensal');
        return true;
      }

      case 'recargaextrato': {
        if (!interaction.guildId) {
          await responderErro(interaction, 'Abra o extrato dentro do servidor onde sua carteira está registrada.');
          return true;
        }
        if (mensagemEfemera(interaction)) await interaction.deferUpdate();
        else await interaction.deferReply({ flags: EFEMERO });
        if (!(await mediadores.podeUsarSalas(db, interaction.guildId, interaction.member))) {
          await interaction.editReply({ embeds: [embedErro(mediadores.AVISO_CARGO)] });
          return true;
        }
        const extrato = await extratoCarteira.obterExtrato({ guildId: interaction.guildId, userId: interaction.user.id });
        const mensagem = await interaction.editReply(payloadPainelExtrato(extrato, interaction.user));
        agendarExclusaoPainelCarteira(interaction, mensagem);
        return true;
      }

      case 'extratoatualizar': {
        if (!interaction.guildId) {
          await responderErro(interaction, 'Atualize o extrato dentro do servidor onde sua carteira está registrada.');
          return true;
        }
        if (!(await mediadores.podeUsarSalas(db, interaction.guildId, interaction.member))) {
          await responderErro(interaction, mediadores.AVISO_CARGO);
          return true;
        }
        const extrato = await extratoCarteira.obterExtrato({ guildId: interaction.guildId, userId: interaction.user.id });
        const mensagem = await interaction.editReply(payloadPainelExtrato(extrato, interaction.user));
        agendarExclusaoPainelCarteira(interaction, mensagem);
        return true;
      }

      case 'extratovoltar': {
        const payload = payloadPainelRecarga();
        if (mensagemEfemera(interaction)) await interaction.update(payload);
        else await responderPrivado(interaction, payload);
        return true;
      }

      case 'copiarinfinita': {
        const infinita = require('../servicos/salaInfinita');
        const codigo = await infinita.codigoPixUsuario({ orderId: args[0], guildId: interaction.guildId, userId: interaction.user.id });
        if (!codigo) {
          await responderErro(interaction, 'Não encontrei o código Pix deste plano na sua conta.');
          return true;
        }
        const limpo = typeof codigo === 'string' ? codigo : '';
        if (!limpo) { await responderErro(interaction, 'O código Pix salvo está inválido. Gere uma nova cobrança.'); return true; }
        if (limpo.length > 2000) {
          await responderErro(interaction, 'O código Pix excede o limite seguro de mensagem do Discord. Use o QR Code ou procure a administração.');
          return true;
        }
        await responderPrivado(interaction, { content: limpo, allowedMentions: { parse: [] } });
        return true;
      }

      case 'verificarinfinita': {
        if (!interaction.guildId) {
          await responderErro(interaction, 'Verifique o plano dentro do servidor onde ele foi criado.');
          return true;
        }
        const infinita = require('../servicos/salaInfinita');
        const order = await infinita.verificarPlano({ orderId: args[0], guildId: interaction.guildId, userId: interaction.user.id });
        if (order.status === 'approved' && order.premium_until_after) {
          await responderPrivado(interaction, {
            embeds: [embedSucesso(`Pagamento aprovado. Sala Infinita ativa até **${dataBR(Date.parse(order.premium_until_after))}**. As criações deste usuário usarão a assinatura registrada no Supabase, sem consumir créditos de sala.`)],
          });
          return true;
        }
        const revisao = order.status === 'manual_review';
        await responderPrivado(interaction, {
          embeds: [embed(revisao ? '⚠️ Pagamento em análise' : '♾️ Sala Infinita · pagamento pendente', revisao
            ? 'Não foi ativada nenhuma assinatura. Não faça outro Pix para esta solicitação; procure a administração.'
            : `Pagamento ainda não aprovado (status: **${order.status || 'pendente'}**). Após pagar, verifique novamente.`)],
        });
        return true;
      }

      case 'copiarrecarga': {
        const recargas = require('../servicos/recargas');
        const codigo = await recargas.codigoPixUsuario({
          topupId: args[0],
          guildId: interaction.guildId,
          userId: interaction.user.id,
        });
        if (!codigo) {
          await responderErro(interaction, 'Não encontrei o código Pix desta recarga na sua carteira.');
          return true;
        }
        const limpo = typeof codigo === 'string' ? codigo : '';
        if (!limpo) { await responderErro(interaction, 'O código Pix salvo está inválido. Gere uma nova cobrança.'); return true; }
        if (limpo.length > 2000) {
          await responderErro(interaction, 'O código Pix excede o limite seguro de mensagem do Discord. Use o QR Code exibido ou procure a administração.');
          return true;
        }
        await responderPrivado(interaction, { content: limpo, allowedMentions: { parse: [] } });
        return true;
      }

      case 'verificarrecarga': {
        if (!interaction.guildId) {
          await responderErro(interaction, 'Verifique a recarga dentro do servidor onde ela foi criada.');
          return true;
        }
        const recargas = require('../servicos/recargas');
        const resultado = await recargas.verificarRecarga({
          topupId: args[0],
          guildId: interaction.guildId,
          userId: interaction.user.id,
        });
        if (resultado.status === 'approved') {
          const bonus = Number(resultado.bonus_cents || 0);
          const credito = Number(resultado.credit_cents || resultado.amount_cents);
          await responderPrivado(interaction, {
            embeds: [embedSucesso(
              `Recarga aprovada! **${reais(credito)}** foram adicionados à sua carteira${bonus > 0 ? `, incluindo **${reais(bonus)}** de bônus` : ''}.\n` +
              `**Saldo disponível:** ${reais(resultado.balance_cents)}. O crédito está vinculado somente à sua conta Discord no Supabase.`,
            )],
          });
          return true;
        }
        const revisao = resultado.status === 'manual_review';
        await responderPrivado(interaction, {
          embeds: [embed(revisao ? '⚠️ Recarga em análise' : '💠 Status da recarga', revisao
            ? 'Não foi liberado nenhum crédito. Não faça outro Pix para esta solicitação; procure a administração.'
            : `Pagamento ainda não aprovado (status: **${resultado.status || 'pendente'}**). Tente verificar novamente após pagar.`)],
        });
        return true;
      }

      case 'meupainel': {
        if (!interaction.guildId) {
          await responderErro(interaction, 'Abra seu painel de salas dentro do servidor.');
          return true;
        }
        const dados = await vendasDb.estatisticasSalas(interaction.guildId, interaction.user.id);
        await responderPrivado(interaction, { embeds: [vendasUI.embedMeuPainel(dados)] });
        return true;
      }

      case 'verificarcompra': {
        const pedido = await comprasSalas.verificarPedido({
          orderId: args[0],
          guildId: interaction.guildId,
          userId: interaction.user.id,
        });
        if (pedido.status === 'approved') {
          await responderPrivado(interaction, {
            content: textoPagamentoAprovado(pedido.rooms_quantity),
          });
          return true;
        }
        const mensagem = pedido.status === 'manual_review'
          ? 'O pagamento está em revisão. Nenhum crédito foi liberado; não faça outro Pix para este pedido.'
          : `Pagamento ainda não aprovado (status: **${pedido.status || 'pendente'}**). Assim que o Mercado Pago confirmar, o saldo será liberado automaticamente.`;
        await responderPrivado(interaction, {
          embeds: [embed(pedido.status === 'approved' ? '✅ Pix aprovado' : '💠 Status do Pix', mensagem)],
        });
        return true;
      }

      case 'copiarpix': {
        const pedido = await vendasDb.obterPixPedidoUsuario({
          orderId: args[0],
          guildId: interaction.guildId,
          userId: interaction.user.id,
        });
        const codigo = typeof pedido?.pix_copy_paste === 'string' ? pedido.pix_copy_paste : '';
        if (!codigo) {
          await responderErro(interaction, 'Não encontrei o código Pix deste pedido. Confirme se o pedido pertence à sua conta ou gere um novo atendimento.');
          return true;
        }
        if (codigo.length > 2000) {
          await responderErro(interaction, 'O código Pix retornado excede o limite seguro de mensagem do Discord. Use o QR Code exibido no pedido e fale com a administração se precisar de ajuda.');
          return true;
        }
        await responderPrivado(interaction, {
          content: codigo,
          allowedMentions: { parse: [] },
        });
        return true;
      }

      case 'compraslimparcargos': {
        if (!config.DEV_OWNER_ID || String(interaction.user.id) !== String(config.DEV_OWNER_ID)) {
          await responderErro(interaction, 'Somente DEV_OWNER_ID pode alterar as permissões de compras.');
          return true;
        }
        const atual = await vendasDb.obterConfiguracao(interaction.guildId);
        const salvo = await vendasDb.salvarConfiguracao({
          guildId: interaction.guildId,
          roleIds: [],
          channelId: atual.panel_channel_id,
          actorId: interaction.user.id,
        });
        await interaction.editReply(vendasUI.embedPainelPermissoes(salvo));
        await responderPrivado(interaction, { content: '✅ Todos os cargos autorizados foram removidos com sucesso do Supabase. As compras por botão ficam bloqueadas até selecionar novos cargos.' });
        return true;
      }

      case 'criarsala': {
        const partida = await partidas.buscar(db, args[0]);
        if (!partida) {
          await responderErro(interaction, 'Sala não encontrada.');
          return true;
        }
        if (!(await mediadores.ehMediador(db, interaction.guildId, interaction.member))) {
          await responderErro(interaction, 'Só o mediador desta sala pode criar a sala do jogo.');
          return true;
        }
        if (partida.mediador_id && partida.mediador_id !== interaction.user.id && !ehAdmin(interaction.member)) {
          await responderErro(interaction, 'Essa sala é de outro mediador.');
          return true;
        }
        try {
          const criada = await salas.criarSalaDaPartida(client, db, {
            partidaId: args[0],
            actorId: interaction.user.id,
            requestId: interaction.id,
          });
          await fluxo.atualizarPartida(client, db, args[0]);
          await auditoria.registrar(db, client, {
            guildId: interaction.guildId,
            autorId: interaction.user.id,
            acao: 'Sala do jogo criada',
            detalhe: `Sala ${args[0]} · room ${criada.dados.room_id}`,
          });
          await responderPrivado(interaction, {
            embeds: [
              embedSucesso(
                `Sala criada! 🎮\n**ID:** \`${criada.dados.room_id}\` · **Senha:** \`${criada.dados.password}\`` +
                  (criada.canalId ? `\nID e senha publicados em <#${criada.canalId}>.` : '') +
                  (criada.creditoLiquidado ? '' : '\n⚠️ O crédito ficou reservado e precisa de reconciliação pela administração.'),
              ),
            ],
          });
        } catch (erro) {
          await responderErro(interaction, erro.message);
        }
        return true;
      }

      case 'ranking': {
        const lista = await royalSupabase.topPerfis(
          interaction.guildId,
          'vitorias',
          config.LIMITES.RANKING,
        );
        const medalhas = ['🥇', '🥈', '🥉'];
        const corpo = lista.length
          ? lista
              .map(
                (linha, indice) =>
                  `${medalhas[indice] ?? `**${indice + 1}.**`} ${mencao(linha.user_id)} — ${linha.wins}V / ${linha.losses}D`,
              )
              .join('\n')
          : 'Ranking ainda vazio. Bora fechar AP!';
        await responderPrivado(interaction, { embeds: [embed('🏆 Ranking · vitórias', corpo)] });
        return true;
      }

      case 'como':
      case 'ajuda': {
        await responderPrivado(interaction, {
          embeds: [
            embed(
              '❓ Como funciona o AP',
              '1. Escolha a faixa no menu do painel.\n' +
                '2. Escolha **Gelo Infinito** ou **Gelo Normal**.\n' +
                '3. O grupo fecha → sala privada criada automaticamente.\n' +
                '4. Um jogador envia a regra e **todos** confirmam.\n' +
                '5. O mediador assume, manda o PIX e confere o pagamento.\n' +
                '6. Sala liberada → joguem → mediador declara o vencedor.\n\n' +
                'Dúvida? Use a staff pelos canais oficiais.',
              { rodape: 'ORG Royal AP' },
            ),
          ],
        });
        return true;
      }

      case 'minhasalas': {
        if (!ehStaff(interaction.member)) {
          await responderErro(interaction, 'Só a staff vê as salas.');
          return true;
        }
        const ativas = (await partidas.ativas(db, interaction.guildId))
          .filter((partida) => partida.status !== 'confirmando');
        const corpo = ativas.length
          ? ativas
              .map(
                (partida) =>
                  `• <#${partida.canal_id}> — ${partida.modo} · ${reais(partida.preco)} · \`${partida.status}\`\n` +
                  `┄ mediador: ${partida.mediador_id ? mencao(partida.mediador_id) : 'livre'}`,
              )
              .join('\n')
          : 'Nenhuma sala precisando de mediador agora. 🙌';
        await responderPrivado(interaction, { embeds: [embed('📋 Salas em andamento', corpo)] });
        return true;
      }

      case 'pixinfo': {
        const registro = await staffSupabase.obter(interaction.guildId, interaction.user.id);
        const corpo = registro?.pix_chave
          ? `**Chave:** \`${registro.pix_chave}\`\n**Titular:** ${registro.pix_titular || '—'}\n` +
            `**Taxa do mediador:** R$ 0,10 por capitão\n**Status:** ${registro.ativo ? 'ativo' : 'inativo'}`
          : 'Você ainda não cadastrou PIX. Use `/registrar_pix chave:SuaChave`.';
        await responderPrivado(interaction, { embeds: [embed('💸 Meu PIX', corpo)] });
        return true;
      }

      default:
        return false;
    }
  } catch (erro) {
    console.error(`[botoes] erro em ${interaction.customId}:`, erro);
    if (acao === 'recargaextrato' && interaction.deferred && !interaction.replied) {
      await interaction.editReply({ embeds: [embedErro(erro.message || 'Não consegui carregar o extrato agora. Tente novamente.')] }).catch(() => {});
      return true;
    }
    await responderErro(
      interaction,
      erro.message || 'Deu um erro aqui. Tente de novo ou chame um ADM.',
    ).catch(() => {});
    return true;
  }
}

module.exports = {
  handleBotao,
  responderVerificacaoPix,
  textoPagamentoAprovado,
};
