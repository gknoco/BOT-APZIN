'use strict';

/**
 * Fluxo do AP: fila -> sala privada -> regras -> mediador -> PIX -> pagamento ->
 * sala liberada -> resultado. Toda a parte que fala com o Discord mora aqui.
 */

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionFlagsBits,
} = require('discord.js');

const crypto = require('node:crypto');
const config = require('../config');
const { obterConfig, definirConfig } = require('../db');
const { embed, reais, mencao, mencaoCargo, tituloCurto } = require('../util/embeds');
const filas = require('./filas');
const partidas = require('./partidas');
const paineis = require('./paineis');
const mediadores = require('./mediadores');
const plantao = require('./plantao');
const blacklist = require('./blacklist');
const auditoria = require('./auditoria');

const { STATUS } = partidas;
const CARGO_MEDIADOR_ACESSO = '1543684028719173732';
const notificacoesEmAndamento = new Set();
const atualizacoesPartida = new Map();

const NOME_TIME = { 1: 'Equipe 1', 2: 'Equipe 2' };
const TAXA_MEDIADOR_CENTAVOS = 10;
const nomeTime = (time) => NOME_TIME[Number(time)] || `Equipe ${time}`;
const valorPorCapitao = (partida) => Math.trunc(Number(partida?.preco) || 0) + TAXA_MEDIADOR_CENTAVOS;

function textoJogadores(lista) {
  return [1, 2]
    .map((time) => {
      const doTime = lista.filter((linha) => Number(linha.time) === time);
      const linhas = doTime.length
        ? doTime.map((linha) => `${linha.confirmou ? '✅' : '⏳'} ${mencao(linha.user_id)}`).join('\n')
        : '`vazio`';
      return `**${nomeTime(time)}**\n${linhas}`;
    })
    .join('\n\n');
}

/** "1v1 Mobile Gelo Normal" — tipo da partida no card da sala. */
function tipoPartida(modo, gelo) {
  if (!modo) return String(gelo || 'AP');
  const variante = config.varianteDoModo(modo, gelo);
  return `${tituloCurto(modo)}${variante ? ` ${variante.nome}` : ''}`;
}

function embedPartida(partida, lista) {
  const modo = config.modoPorId(partida.modo);
  const variante = config.varianteDoModo(modo, partida.gelo);

  // Card de abertura da sala: "Aguardando" + aposta + premiação + jogadores.
  // Sem textão de instruções — o fluxo anda pelos botões.
  if (partida.status === STATUS.CONFIRMANDO) {
    const premio = Math.trunc(Number(partida.preco) || 0) * 2;
    const jogadores = lista.length
      ? lista
          .map((linha, indice) => `${indice + 1}. ${mencao(linha.user_id)}${linha.confirmou ? ' ✅' : ''}`)
          .join('\n')
      : '`sem jogadores`';

    return embed(`⏳ Aguardando · ${tipoPartida(modo, partida.gelo)}`, null, {
      cor: config.CORES.aviso,
      campos: [
        { name: 'Aposta', value: reais(partida.preco), inline: true },
        { name: 'Premiação', value: reais(premio), inline: true },
        { name: 'Jogadores', value: jogadores, inline: false },
      ],
      rodape: `Sala ${partida.id} · ORG Royal AP`,
    });
  }

  const campos = [
    { name: 'Modo', value: modo ? modo.titulo : partida.modo, inline: true },
    { name: 'Aposta', value: reais(partida.preco), inline: true },
    { name: 'Tipo', value: variante ? `${variante.emoji} ${variante.nome}` : partida.gelo, inline: true },
    { name: 'Jogadores', value: textoJogadores(lista), inline: false },
  ];

  let titulo = `🎯 AP ${modo ? modo.titulo : partida.modo} · ${reais(partida.preco)}`;
  let descricao = '';
  let cor = config.CORES.principal;

  switch (partida.status) {
    case STATUS.AGUARDANDO_MEDIADOR:
      descricao = `**Passo 2 · Mediação**\nRegras confirmadas. Aguardando ${mencaoCargo(config.CARGO_MEDIADOR_ID)} assumir a sala.`;
      cor = config.CORES.aviso;
      break;
    case STATUS.AGUARDANDO_PAGAMENTO:
      descricao =
        '**Passo 3 · Pagamento**\n' +
        `Mediador: ${mencao(partida.mediador_id)}\n` +
        'Clique em **Enviar PIX** para mandar a chave, e em **Pagamento recebido** depois de conferir os comprovantes.';
      cor = config.CORES.aviso;
      break;
    case STATUS.PAGO:
      descricao = '**Pagamento confirmado ✅**\nApós criar a sala pelo comando oficial externo, o mediador responsável informa o ID e a senha neste cartão. Este botão não cria nem inicia a sala.';
      cor = config.CORES.gelo;
      break;
    case STATUS.SALA_LIBERADA:
      descricao =
        '**Passo 5 · Sala liberada**\nEntrem no Free Fire com o ID e a senha abaixo.\n' +
        'Cada jogador/capitão cadastrado deve clicar em **Estou pronto** para sinalizar prontidão. ' +
        'Isso não inicia a sala: o início é feito externamente pelo comando oficial. O mediador pode corrigir os dados somente antes da primeira prontidão; depois, cancele e refaça a partida se necessário.';
      cor = config.CORES.sucesso;
      campos.push(
        { name: 'ID da sala', value: partida.sala_id ? `\`${partida.sala_id}\`` : '—', inline: true },
        { name: 'Senha', value: partida.sala_senha ? `\`${partida.sala_senha}\`` : '—', inline: true },
      );
      break;
    case STATUS.EM_ANDAMENTO:
      descricao =
        '**Prontidão registrada ⚔️**\nTodos os jogadores/capitães cadastrados sinalizaram prontidão; o estado interno está em andamento.\n' +
        'O início da sala é externo e não é confirmado por este botão.\n' +
        'Ao terminar, o mediador clica no vencedor (ou aplica W.O.).';
      cor = config.CORES.sucesso;
      campos.push(
        { name: 'ID da sala', value: partida.sala_id ? `\`${partida.sala_id}\`` : '—', inline: true },
        { name: 'Senha', value: partida.sala_senha ? `\`${partida.sala_senha}\`` : '—', inline: true },
      );
      break;
    case STATUS.FINALIZADA:
      titulo = `🏆 AP encerrado · ${nomeTime(partida.vencedor_time)} venceu`;
      descricao =
        `**Resultado:** ${nomeTime(partida.vencedor_time)} venceu${partida.motivo_fim === 'wo' ? ' por **W.O.**' : ''}.\n` +
        `Valor: ${reais(partida.preco)} · Modo: ${modo ? modo.titulo : partida.modo}`;
      cor = config.CORES.ouro;
      break;
    case STATUS.CANCELADA:
      titulo = '🚫 AP cancelado';
      descricao = `Essa sala foi cancelada.\nMotivo: ${partida.motivo_fim || 'não informado'}`;
      cor = config.CORES.erro;
      break;
    default:
      descricao = `Status: ${partida.status}`;
  }

  if (partida.mediador_id) {
    campos.push({ name: 'Mediador', value: mencao(partida.mediador_id), inline: true });
  }

  return embed(titulo, descricao, {
    cor,
    campos,
    rodape: `Sala ${partida.id} · ORG Royal AP`,
  });
}

function linha(...botoes) {
  return new ActionRowBuilder().addComponents(...botoes);
}

function componentesPartida(partida) {
  const id = partida.id;
  const linhas = [];
  const botao = (customId, label, emoji, style) =>
    new ButtonBuilder().setCustomId(customId).setLabel(label).setEmoji(emoji).setStyle(style);

  switch (partida.status) {
    case STATUS.CONFIRMANDO:
      linhas.push(
        linha(
          botao(`ap:confirmar:${id}`, 'Confirmar Partida', '✅', ButtonStyle.Success),
          botao(`ap:cancelar:${id}`, 'Cancelar', '🚫', ButtonStyle.Danger),
        ),
      );
      break;
    case STATUS.AGUARDANDO_MEDIADOR:
      linhas.push(
        linha(
          botao(`ap:cancelar:${id}`, 'Cancelar', '🚫', ButtonStyle.Danger),
        ),
      );
      break;
    case STATUS.AGUARDANDO_PAGAMENTO:
      linhas.push(
        linha(
          botao(`ap:pix:${id}`, 'Enviar PIX', '💸', ButtonStyle.Primary),
          botao(`ap:pago:${id}`, 'Pagamento recebido', '✅', ButtonStyle.Success),
          botao(`ap:cancelar:${id}`, 'Cancelar', '🚫', ButtonStyle.Danger),
        ),
      );
      break;
    case STATUS.PAGO:
      linhas.push(
        linha(
          botao(`ap:liberar:${id}:${partida.sala_versao ?? 0}`, 'Informar ID e senha', '🎮', ButtonStyle.Success),
          botao(`ap:renomear:${id}`, 'Renomear', '✏️', ButtonStyle.Primary),
          botao(`ap:cancelar:${id}`, 'Cancelar', '🚫', ButtonStyle.Danger),
        ),
      );
      break;
    case STATUS.SALA_LIBERADA:
    case STATUS.EM_ANDAMENTO:
      if (partida.status === STATUS.SALA_LIBERADA) {
        linhas.push(linha(
          botao(`ap:pronto:${id}:${partida.sala_versao ?? 0}`, 'Estou pronto', '✅', ButtonStyle.Primary),
          botao(`ap:liberar:${id}:${partida.sala_versao ?? 0}`, 'Corrigir ID e senha', '✏️', ButtonStyle.Secondary),
        ));
      }
      linhas.push(
        linha(
          botao(`ap:vencer:${id}:1`, 'Equipe 1 venceu', '🏆', ButtonStyle.Success),
          botao(`ap:vencer:${id}:2`, 'Equipe 2 venceu', '🏆', ButtonStyle.Success),
        ),
        linha(
          botao(`ap:wo:${id}:1`, 'W.O. da Equipe 1', '⚠️', ButtonStyle.Secondary),
          botao(`ap:wo:${id}:2`, 'W.O. da Equipe 2', '⚠️', ButtonStyle.Secondary),
          botao(`ap:cancelar:${id}`, 'Cancelar', '🚫', ButtonStyle.Danger),
        ),
      );
      break;
    case STATUS.FINALIZADA:
    case STATUS.CANCELADA:
      linhas.push(linha(botao(`ap:fechar:${id}`, 'Fechar sala', '🔒', ButtonStyle.Secondary)));
      break;
    default:
      break;
  }
  return linhas;
}

/** Categoria onde as salas são criadas (env -> banco -> nome "filas aqui"). */
async function resolverCategoria(guild, db, chave, envId) {
  const salvo = await obterConfig(db, guild.id, chave, envId);
  if (salvo) {
    const porId =
      guild.channels.cache.get(salvo) || (await guild.channels.fetch(salvo).catch(() => null));
    if (porId && porId.type === ChannelType.GuildCategory) return porId;
  }
  const categorias = guild.channels.cache.filter((canal) => canal.type === ChannelType.GuildCategory);
  return (
    categorias.find((canal) => /filas?\s*aqui/i.test(canal.name)) ||
    categorias.find((canal) => /\bfilas?\b/i.test(canal.name)) ||
    null
  );
}

async function criarCanalPartida(client, db, guild, { modo, preco, gelo, jogadores, reservaId }) {
  // A sala privada nasce DENTRO da categoria configurada (CATEGORIA_FILAS_ID ou
  // `/boombot setcategoria`). Sem categoria configurada o bot tenta achar uma
  // categoria de filas pelo nome antes de criar na raiz do servidor.
  const categoria = await resolverCategoria(guild, db, 'categoria_filas', config.CATEGORIA_FILAS_ID);
  const A = PermissionFlagsBits;
  const cargosMediadores = new Set([
    CARGO_MEDIADOR_ACESSO,
    ...(await mediadores.cargos(db, guild.id)),
  ].filter(Boolean).map(String));
  const permissoes = [
    { id: guild.roles.everyone.id, deny: [A.ViewChannel] },
    ...[...cargosMediadores].map((id) => ({ id, deny: [A.ViewChannel] })),
    {
      id: client.user.id,
      allow: [A.ViewChannel, A.SendMessages, A.EmbedLinks, A.ReadMessageHistory, A.ManageChannels, A.ManageMessages],
    },
    ...jogadores.map((userId) => ({
      id: String(userId),
      allow: [A.ViewChannel, A.SendMessages, A.ReadMessageHistory, A.EmbedLinks],
    })),
  ];
  // #fila-gelo-normal-001 — numeração contínua por tipo de entrada.
  const nome = paineis.nomeSalaFila(guild, modo, gelo);

  const canal = await guild.channels.create({
    name: nome,
    type: ChannelType.GuildText,
    ...(categoria ? { parent: categoria.id } : {}),
    topic: `AP ${modo.titulo} · ${reais(preco)} · ${gelo} · reserva ${reservaId} · sala privada`,
    permissionOverwrites: permissoes,
  });

  return canal;
}

async function publicarSala(client, db, partida) {
  try {
    // Uma partida retomada pode já ter um cartão; só edite a referência salva.
    if (partida.mensagem_id) return await atualizarPartida(client, db, partida.id, { somenteEditar: true });
    const canal = client.channels.cache.get(partida.canal_id) || (await client.channels.fetch(partida.canal_id));
    if (!canal) return false;
    const lista = await partidas.jogadores(db, partida.id);
    const mensagem = await canal.send({
      content: `${lista.map((linha) => mencao(linha.user_id)).join(' ')} — sala de AP criada.`,
      embeds: [embedPartida(partida, lista)],
      components: componentesPartida(partida),
      allowedMentions: { parse: ['users'] },
    });
    if (typeof mensagem?.id !== 'string' || !mensagem.id.trim()) {
      throw new Error('Discord não confirmou o ID da mensagem enviada.');
    }
    await partidas.definirMensagem(db, partida.id, mensagem.id);
    // Nada de "mandem o ID e a senha": o mediador cria a sala pelo bot.
    return true;
  } catch (erro) {
    console.error('[fluxo] não consegui publicar a sala:', erro.message);
    return false;
  }
}

async function atualizarPartidaSemFila(client, db, partidaId) {
  const partida = await partidas.buscar(db, partidaId);
  if (!partida) return false;
  try {
    const canal = client.channels.cache.get(partida.canal_id) || (await client.channels.fetch(partida.canal_id));
    if (!canal) return false;
    const lista = await partidas.jogadores(db, partidaId);
    const payload = { embeds: [embedPartida(partida, lista)], components: componentesPartida(partida) };

    if (partida.mensagem_id) {
      // Um erro de rede não prova que a mensagem foi apagada. Nunca envie uma
      // segunda mensagem na reconciliação de uma publicação ambígua.
      const mensagem = await canal.messages.fetch(partida.mensagem_id);
      if (mensagem) {
        await mensagem.edit(payload);
        return true;
      }
    }
    // A ausência do ID também pode ser uma gravação perdida depois do envio.
    // Não é uma prova de que se pode publicar outro cartão, mesmo em cancelamento.
    return false;
  } catch (erro) {
    console.error('[fluxo] não consegui atualizar a sala:', erro.message);
    return false;
  }
}

// A leitura acontece dentro da fila: dois cliques não podem editar o cartão
// com um snapshot mais antigo depois de outro mais recente, nesta instância.
async function atualizarPartida(client, db, partidaId, opcoes = {}) {
  const chave = String(partidaId);
  const anterior = atualizacoesPartida.get(chave) || Promise.resolve();
  const atual = anterior.catch(() => {}).then(() => atualizarPartidaSemFila(client, db, partidaId, opcoes));
  atualizacoesPartida.set(chave, atual);
  try {
    return await atual;
  } finally {
    if (atualizacoesPartida.get(chave) === atual) atualizacoesPartida.delete(chave);
  }
}

/** Atualiza cartões existentes para expor os controles após uma reinicialização. */
async function restaurarCartoesPartida(client, db, guildId) {
  const ativas = await partidas.ativas(db, guildId);
  let atualizadas = 0;
  for (const partida of ativas) {
    if (![STATUS.PAGO, STATUS.SALA_LIBERADA, STATUS.EM_ANDAMENTO].includes(partida.status)) continue;
    try {
      if (await atualizarPartida(client, db, partida.id)) atualizadas += 1;
    } catch (erro) {
      console.error(`[fluxo] não consegui restaurar cartão ${partida.id}:`, erro.message);
    }
  }
  return atualizadas;
}

/** Notifica a staff quando os capitães confirmam a partida; a assunção usa o lock do Supabase. */
async function notificarPartidaFormada(client, db, partida) {
  if (!partida || partida.status !== STATUS.AGUARDANDO_MEDIADOR || partida.mediador_id) return false;
  const plantonistas = await plantao.listar(db, partida.guild_id);
  if (!plantonistas.length) {
    console.warn(`[fluxo] partida ${partida.id} mantida pendente: nenhum mediador ativo na guild ${partida.guild_id}.`);
    return false;
  }
  const canalId = await obterConfig(db, partida.guild_id, 'canal_partidas_formadas', null);
  if (!canalId) {
    console.error(`[fluxo] canal_partidas_formadas não configurado para guild ${partida.guild_id}; execute /configcanalfila.`);
    return false;
  }
  const canalBatePonto = await obterConfig(db, partida.guild_id, 'canal_bateponto', null);
  if (String(canalBatePonto || '') === String(canalId)) {
    console.error(`[fluxo] publicação bloqueada para guild ${partida.guild_id}: canal de filas ${canalId} coincide com o canal de bate-ponto ${canalBatePonto}.`);
    return false;
  }
  const chaveExecucao = `${partida.guild_id}:${partida.id}`;
  if (notificacoesEmAndamento.has(chaveExecucao)) return false;
  notificacoesEmAndamento.add(chaveExecucao);
  try {
    const canal = client.channels.cache.get(String(canalId)) || await client.channels.fetch(String(canalId)).catch((erro) => {
      console.error(`[fluxo] não consegui buscar canal_partidas_formadas ${canalId} da guild ${partida.guild_id}:`, erro);
      return null;
    });
    if (!canal?.send) {
      console.error(`[fluxo] canal_partidas_formadas ${canalId} da guild ${partida.guild_id} não é um canal enviável.`);
      return false;
    }
    // Revalida imediatamente antes do envio para não publicar se o último
    // mediador tiver saído durante a busca do canal ou a montagem do painel.
    const plantonistasAntesDoEnvio = await plantao.listar(db, partida.guild_id);
    if (!plantonistasAntesDoEnvio.length) {
      console.warn(`[fluxo] partida ${partida.id} não publicada: plantão ficou vazio antes do envio na guild ${partida.guild_id}.`);
      return false;
    }
    const chaveMensagem = `partida_aceite_mensagem_${partida.id}`;
    const mensagemSalva = await obterConfig(db, partida.guild_id, chaveMensagem, null);
    if (mensagemSalva) {
      const mensagemExistente = await canal.messages.fetch(String(mensagemSalva)).catch((erro) => {
        if (erro?.code === 10008) console.warn(`[fluxo] painel salvo ${mensagemSalva} da partida ${partida.id} não existe mais; será reenviado.`);
        else console.error(`[fluxo] falha ao verificar painel salvo ${mensagemSalva} da partida ${partida.id}:`, erro);
        return null;
      });
      if (mensagemExistente) return true;
    }
    // Repara referências ausentes/stale e bloqueia duplicatas criadas por
    // reinício do processo ou por chamadas concorrentes que não salvaram a
    // configuração antes de uma nova varredura.
    const mensagensRecentes = await canal.messages.fetch({ limit: 100 }).catch((erro) => {
      console.error(`[fluxo] falha ao procurar painéis duplicados da partida ${partida.id}:`, erro);
      return null;
    });
    const customIdPainel = `ap:assumirnotificacao:${partida.id}`;
    const painelExistente = [...(mensagensRecentes?.values?.() || [])].find((mensagem) =>
      mensagem.components?.some((linha) => linha.components?.some((componente) => componente.customId === customIdPainel)));
    if (painelExistente) {
      await definirConfig(db, partida.guild_id, chaveMensagem, painelExistente.id);
      console.warn(`[fluxo] painel já existente da partida ${partida.id} reutilizado: ${painelExistente.id}.`);
      return true;
    }
    const guild = canal.guild || client.guilds.cache.get(String(partida.guild_id));
    const jogadores = await partidas.jogadores(db, partida.id);
    const nomes = await Promise.all(jogadores.map(async (linhaJogador) => {
      const membro = await guild?.members?.fetch?.(linhaJogador.user_id).catch?.(() => null);
      return membro?.displayName || membro?.user?.username || mencao(linhaJogador.user_id);
    }));
    const modo = config.modoPorId(partida.modo);
    const variante = config.varianteDoModo(modo, partida.gelo);
    const painel = embed('🎯 Partida formada · aguardando ADM',
      'Os jogadores confirmaram a partida. Apenas um administrador pode assumir esta sala.', {
        cor: config.CORES.aviso,
        campos: [
          { name: 'Modo', value: modo?.titulo || String(partida.modo), inline: true },
          { name: 'Categoria / Plataforma', value: variante ? `${variante.nome} · ${partida.gelo}` : String(partida.gelo), inline: true },
          { name: 'Valor da aposta', value: reais(partida.preco), inline: true },
          { name: 'Jogadores', value: nomes.map((nome, indice) => `${indice + 1}. **${String(nome).slice(0, 80)}**`).join('\n') || '`não informado`', inline: false },
        ],
        rodape: `Partida ${partida.id} · ORG Royal AP`,
      });
    const botao = new ButtonBuilder()
      .setCustomId(`ap:assumirnotificacao:${partida.id}`)
      .setLabel('Aceitar')
      .setEmoji('👑')
      .setStyle(ButtonStyle.Success);
    const mensagem = await canal.send({
      embeds: [painel],
      components: [linha(botao)],
      allowedMentions: { parse: [] },
    });
    await definirConfig(db, partida.guild_id, chaveMensagem, mensagem.id);
    return true;
  } catch (erro) {
    console.error(`[fluxo] não consegui notificar partida formada ${partida.id} no canal ${canalId}:`, erro);
    return false;
  } finally {
    notificacoesEmAndamento.delete(chaveExecucao);
  }
}

/** Publica, quando um mediador entra no plantão, todas as partidas já formadas. */
async function notificarPartidasPendentes(client, db, guildId) {
  const canalId = await obterConfig(db, guildId, 'canal_partidas_formadas', null);
  if (!canalId) {
    console.error(`[fluxo] varredura de pendências abortada: canal_partidas_formadas não configurado para guild ${guildId}.`);
    return 0;
  }
  const plantonistas = await plantao.listar(db, guildId);
  if (!plantonistas.length) {
    console.warn(`[fluxo] varredura de pendências sem publicação: plantão vazio na guild ${guildId}.`);
    return 0;
  }
  const pendentes = await partidas.pendentes(db, guildId);
  console.log(`[fluxo] varredura de entrada no plantão: guild ${guildId}, canal ${canalId}, plantonistas ${plantonistas.length}, partidas pendentes ${pendentes.length}.`);
  let publicadas = 0;
  for (const partida of pendentes) {
    if (await notificarPartidaFormada(client, db, partida)) publicadas += 1;
  }
  return publicadas;
}

/** Remove painéis pendentes quando o último mediador deixa o plantão. */
async function ocultarPartidasPendentes(client, db, guildId) {
  if ((await plantao.listar(db, guildId)).length) return 0;
  const canalId = await obterConfig(db, guildId, 'canal_partidas_formadas', null);
  const canalBatePonto = await obterConfig(db, guildId, 'canal_bateponto', null);
  if (!canalId || String(canalId) === String(canalBatePonto || '')) return 0;
  const pendentes = await partidas.pendentes(db, guildId);
  let removidas = 0;
  for (const partida of pendentes) {
    const chaveMensagem = `partida_aceite_mensagem_${partida.id}`;
    const mensagemId = await obterConfig(db, guildId, chaveMensagem, null);
    if (!mensagemId) continue;
    const canal = client.channels.cache.get(String(canalId))
      || await client.channels.fetch(String(canalId)).catch((erro) => {
        console.error(`[fluxo] não consegui buscar canal de filas ${canalId} para limpeza:`, erro);
        return null;
      });
    const mensagem = await canal?.messages?.fetch?.(String(mensagemId)).catch?.((erro) => {
      if (erro?.code !== 10008) console.error(`[fluxo] não consegui verificar painel ${mensagemId} para limpeza:`, erro);
      return null;
    });
    if (mensagem) {
      await mensagem.delete().catch((erro) => console.error(`[fluxo] não consegui apagar painel ${mensagemId}:`, erro));
      removidas += 1;
    }
    await definirConfig(db, guildId, chaveMensagem, null);
  }
  const canal = client.channels.cache.get(String(canalId))
    || await client.channels.fetch(String(canalId)).catch((erro) => {
      console.error(`[fluxo] não consegui buscar canal de filas ${canalId} para limpar painéis órfãos:`, erro);
      return null;
    });
  if (canal?.messages?.fetch) {
    const mensagens = await canal.messages.fetch({ limit: 100 }).catch((erro) => {
      console.error(`[fluxo] não consegui varrer painéis órfãos no canal ${canalId}:`, erro);
      return null;
    });
    for (const mensagem of mensagens?.values?.() || []) {
      const ehPainelAceite = mensagem.components?.some((linha) =>
        linha.components?.some((componente) => String(componente.customId || '').startsWith('ap:assumirnotificacao:')));
      if (ehPainelAceite) {
        await mensagem.delete().then(() => { removidas += 1; }).catch((erro) => {
          console.error(`[fluxo] não consegui apagar painel órfão ${mensagem.id}:`, erro);
        });
      }
    }
  }
  return true;
}

/** Remove imediatamente o painel administrativo de uma partida aceita. */
async function removerPainelNotificacao(client, db, guildId, partidaId, mensagem = null) {
  const canalId = await obterConfig(db, guildId, 'canal_partidas_formadas', null);
  const chaveMensagem = `partida_aceite_mensagem_${partidaId}`;
  const mensagemId = await obterConfig(db, guildId, chaveMensagem, null);
  const alvos = [mensagem];
  if (canalId && mensagemId && (!mensagem || String(mensagem.id) !== String(mensagemId))) {
    const canal = client.channels.cache.get(String(canalId))
      || await client.channels.fetch(String(canalId)).catch((erro) => {
        console.error(`[fluxo] não consegui buscar canal de filas ${canalId} para apagar painel aceito:`, erro);
        return null;
      });
    const salvo = await canal?.messages?.fetch?.(String(mensagemId)).catch((erro) => {
      if (erro?.code !== 10008) console.error(`[fluxo] não consegui buscar painel aceito ${mensagemId}:`, erro);
      return null;
    });
    if (salvo) alvos.push(salvo);
  }
  for (const alvo of alvos.filter(Boolean)) {
    await alvo.delete().catch((erro) => {
      if (erro?.code !== 10008) console.error(`[fluxo] não consegui apagar painel aceito ${alvo.id}:`, erro);
    });
  }
  await definirConfig(db, guildId, chaveMensagem, null);
  return true;
}

async function concederAcessoPartida(client, db, partidaId, userId) {
  const partida = await partidas.buscar(db, partidaId);
  if (!partida) return false;
  const matchChannel = client.channels.cache.get(String(partida.canal_id))
    || await client.channels.fetch(String(partida.canal_id)).catch((erro) => {
      console.error(`[fluxo] não consegui buscar a sala privada ${partida.canal_id}:`, erro);
      return null;
    });
  if (!matchChannel?.permissionOverwrites?.edit) return false;
  const A = PermissionFlagsBits;
  const cargosMediadores = new Set([
    CARGO_MEDIADOR_ACESSO,
    ...(await mediadores.cargos(db, partida.guild_id)),
  ].filter(Boolean).map(String));
  const jogadores = await partidas.jogadores(db, partidaId);
  // Reaplica a trava no aceite para corrigir também salas criadas antes desta
  // regra: o cargo geral nunca herda acesso à sala de outro mediador.
  for (const cargoId of cargosMediadores) {
    await matchChannel.permissionOverwrites.edit(cargoId, {
      ViewChannel: false,
      SendMessages: false,
      ReadMessageHistory: false,
    });
  }
  for (const jogador of jogadores) {
    await matchChannel.permissionOverwrites.edit(String(jogador.user_id), {
      ViewChannel: true,
      SendMessages: true,
      ReadMessageHistory: true,
      EmbedLinks: true,
    });
  }
  await matchChannel.permissionOverwrites.edit(String(userId), {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
    EmbedLinks: true,
  });
  return true;
}

/**
 * Manda a chave PIX do mediador na sala e na DM dos jogadores.
 * Usado pelo botão "Enviar PIX" e pelo comando /pix.
 */
async function anunciarPix(client, db, { partidaId, mediadorId, chave, titular }) {
  // A chave vem do Supabase e não é duplicada no registro operacional da partida.
  const partida = await partidas.buscar(db, partidaId);
  if (!partida) throw new Error('Partida não encontrada.');
  await atualizarPartida(client, db, partidaId);

  const jogadores = await partidas.jogadores(db, partidaId);
  const aviso = jogadores.map((linha) => mencao(linha.user_id)).join(' ');
  const texto = [
    '💸 **PIX DO MEDIADOR** 💸',
    '',
    `👤 **Mediador:** ${mencao(mediadorId)}`,
    `🔑 **Chave PIX:** \`${chave}\``,
    `👨‍💼 **Titular:** ${titular || '—'}`,
    `💰 **Valor por time:** \`${reais(valorPorCapitao(partida))}\``,
    '',
    '━━━━━━━━━━━━━━━━━━━━',
    '',
    '📌 **Instruções:**',
    '• Envie o comprovante **nesta sala**',
    '• Aguarde a conferência do mediador',
    '• A sala será liberada após a confirmação',
    '',
    '━━━━━━━━━━━━━━━━━━━━',
    '',
    '⚠️ *Não perca tempo enviando comprovante falso!!!*',
  ]
    .join('\n');

  try {
    const canal =
      client.channels.cache.get(partida.canal_id) || (await client.channels.fetch(partida.canal_id));
    await canal?.send({ content: `${aviso}\n${texto}`, allowedMentions: { parse: ['users'] } });

    for (const linha of jogadores) {
      const membro = await canal?.guild?.members?.fetch?.(linha.user_id)?.catch(() => null);
      await membro?.send?.({ embeds: [embed('💸 PIX do seu AP', texto)] })?.catch?.(() => {});
    }
  } catch (erro) {
    console.error('[fluxo] não consegui anunciar o PIX:', erro.message);
  }

  return partida;
}

/**
 * Coloca o jogador na fila e, se o grupo fechar, cria a sala privada.
 * Uma confirmação do banco nunca é desfeita nem descrita como falha de criação
 * por causa de um erro posterior do Discord, painel ou auditoria.
 */
async function entrarNaFila(client, db, { guild, userId, modo, preco, gelo }) {
  const modoInfo = config.modoPorId(modo);
  if (!modoInfo) throw new Error('Modo de AP inválido.');
  const valor = Number(preco);
  if (!config.PRECOS.includes(valor)) throw new Error('Faixa de aposta inválida.');
  if (!config.varianteDoModo(modoInfo, gelo)) throw new Error('Escolha uma opção de entrada válida para esse modo.');

  const bloqueio = await blacklist.obter(db, guild.id, userId);
  if (bloqueio) throw new Error(`Você está na lista negra da ORG: **${bloqueio.motivo}**.`);

  let resultado;
  try {
    resultado = await filas.entrar(db, { guildId: guild.id, modo: modoInfo.id, preco: valor, gelo, userId });
    if (!resultado || typeof resultado.entrou !== 'boolean') throw new Error('Resposta de entrada inválida.');
  } catch (erro) {
    throw new Error('Não foi possível confirmar sua entrada na fila. Ela pode ter ocorrido; peça a um ADM para verificar antes de entrar novamente.', { cause: erro });
  }
  if (!resultado.entrou) throw new Error(`Você já está nessa fila (posição ${resultado.posicao}).`);

  // Todos são best effort; nenhum erro externo interrompe a reserva após a
  // inscrição, e uma publicação potencialmente parcial não é repetida.
  const problemasPaineis = new Map();
  async function atualizarPainel(modoPainel, precoPainel) {
    const chave = JSON.stringify([modoPainel, precoPainel]);
    // Atualizar pode republicar mensagens. Depois de falha, uma republicação
    // parcial pode ter acontecido: não tente automaticamente a mesma faixa.
    if (problemasPaineis.has(chave)) return;
    try {
      if (await paineis.atualizar(client, db, { guildId: guild.id, modo: modoPainel, preco: precoPainel }) !== true) {
        throw new Error('atualização não confirmada');
      }
      problemasPaineis.delete(chave);
    } catch (erro) {
      problemasPaineis.set(chave, `${modoPainel}/${precoPainel}`);
      console.error(`[fluxo] painel ${modoPainel}/${precoPainel} não confirmado:`, erro.message);
    }
  }
  const textoPaineis = () => problemasPaineis.size
    ? ` Painéis a verificar: ${[...problemasPaineis.values()].join(', ')}.` : '';
  await atualizarPainel(modoInfo.id, valor);

  let naFila;
  try {
    naFila = await filas.contar(db, { guildId: guild.id, modo: modoInfo.id, preco: valor, gelo });
  } catch (erro) {
    throw new Error(`Sua entrada foi registrada, mas não foi possível confirmar a contagem. Não entre novamente; peça a um ADM verificar.${textoPaineis()}`, { cause: erro });
  }
  if (naFila < config.CAPITAES_POR_PARTIDA) {
    if (problemasPaineis.size) {
      throw new Error(`Sua entrada foi registrada, mas a atualização do painel não foi confirmada. Não entre novamente; peça a um ADM verificar.${textoPaineis()}`);
    }
    return { posicao: resultado.posicao, naFila, faltam: config.CAPITAES_POR_PARTIDA - naFila, fechou: false, partida: null };
  }

  // Os IDs e argumentos permanecem idênticos em todas as tentativas.
  const reservaId = crypto.randomUUID();
  const partidaId = crypto.randomBytes(16).toString('hex');
  const contexto = { reservaId, partidaId, guildId: guild.id, modo: modoInfo.id,
    preco: valor, gelo, quantidade: config.CAPITAES_POR_PARTIDA };
  console.info(`[fluxo] reserva iniciada ${reservaId}; partida ${partidaId}; guild ${guild.id}; modo ${modoInfo.id}; preço ${valor}; gelo ${gelo}`);

  function erroComContexto(mensagem, causa, canalId = null, extra = {}) {
    return Object.assign(new Error(mensagem, causa ? { cause: causa } : undefined), {
      reservaId, partidaId, canalId, ...extra,
    });
  }
  async function repetirMesmoPedido(operacao, validar) {
    let ultima, houveIncerteza = false;
    for (let tentativa = 0; tentativa < 2; tentativa++) {
      try {
        const resposta = await operacao();
        if (!validar(resposta)) throw new Error('Resposta ausente ou incompatível.');
        return { resposta, houveIncerteza };
      } catch (causa) {
        const erro = causa instanceof Error ? causa : new Error(String(causa));
        ultima = erro;
        if (erro.code === 'PBL01' || erro.code === 'PRV02') {
          erro.tentativaAnteriorIncerta = houveIncerteza;
          break;
        }
        houveIncerteza = true;
      }
    }
    if (ultima.tentativaAnteriorIncerta === undefined) ultima.tentativaAnteriorIncerta = houveIncerteza;
    throw ultima;
  }

  let reserva;
  try {
    ({ resposta: reserva } = await repetirMesmoPedido(() => filas.reservar(db, contexto), (r) =>
      r && r.id === reservaId && r.guild_id === String(guild.id)
      && ['reservada', 'insuficiente', 'cancelada', 'concluida'].includes(r.estado)
      && (r.estado === 'cancelada' || (r.partida_id === partidaId && r.modo === modoInfo.id
        && Number(r.preco) === valor && r.gelo === gelo))));
  } catch (erro) {
    console.error(`[fluxo] reserva incerta ${reservaId}; partida ${partidaId}; guild ${guild.id}:`, erro.message);
    throw erroComContexto(`Não foi possível confirmar a reserva ${reservaId} da partida ${partidaId}. Peça a um ADM reconciliá-la; não entre novamente enquanto estiver pendente.${textoPaineis()}`, erro);
  }
  if (reserva.estado === 'insuficiente') {
    await atualizarPainel(modoInfo.id, valor);
    let restantes;
    try { restantes = await filas.contar(db, { guildId: guild.id, modo: modoInfo.id, preco: valor, gelo }); }
    catch (erro) {
      throw erroComContexto(`A reserva ${reservaId} não selecionou jogadores, mas a fila não pôde ser conferida. Peça a um ADM verificar antes de entrar novamente.${textoPaineis()}`, erro);
    }
    if (problemasPaineis.size) throw erroComContexto(`A reserva ${reservaId} não selecionou jogadores; a entrada pode continuar na fila. Não entre novamente; peça a um ADM verificar.${textoPaineis()}`);
    return { posicao: resultado.posicao, naFila: restantes,
      faltam: Math.max(1, config.CAPITAES_POR_PARTIDA - restantes), fechou: false, partida: null, reservaId, partidaId };
  }
  // A RPC remove todas as inscrições dos selecionados, inclusive noutros modos
  // e preços. Atualize cada cartão distinto mesmo que outro falhe.
  const alvos = new Map([[JSON.stringify([modoInfo.id, valor]), { modo: modoInfo.id, preco: valor }]]);
  let originaisIncompletas = !Array.isArray(reserva.filas_originais) || reserva.filas_originais.length === 0;
  if (Array.isArray(reserva.filas_originais)) {
    for (const fila of reserva.filas_originais) {
      const precoFila = Number(fila?.preco);
      if (!fila || String(fila.guild_id) !== String(guild.id) || typeof fila.modo !== 'string' || !fila.modo
        || fila.preco == null || !Number.isInteger(precoFila) || precoFila < 0) {
        originaisIncompletas = true;
        continue;
      }
      alvos.set(JSON.stringify([fila.modo, precoFila]), { modo: fila.modo, preco: precoFila });
    }
  }
  if (originaisIncompletas) {
    problemasPaineis.set('originais-incompletas', 'lista de filas removidas incompleta');
    console.error(`[fluxo] reserva ${reservaId}: lista de filas originais ausente ou inválida; verificação manual necessária.`);
  }
  for (const alvo of alvos.values()) await atualizarPainel(alvo.modo, alvo.preco);
  if (reserva.estado !== 'reservada' || !Array.isArray(reserva.jogadores)
    || reserva.jogadores.length !== config.CAPITAES_POR_PARTIDA
    || new Set(reserva.jogadores).size !== reserva.jogadores.length
    || reserva.jogadores.some((id) => typeof id !== 'string' || !id)) {
    throw erroComContexto(`Reserva ${reservaId}, partida ${partidaId}: estado ou participantes exigem verificação. Peça a um ADM reconciliá-la; não entre novamente.${textoPaineis()}`);
  }

  const ids = reserva.jogadores;
  const jogadores = ids.map((id, indice) => ({ userId: id, time: indice + 1 }));
  let canal = null, etapa = 'canal', partida, criacaoIncerta = false;
  try {
    canal = await criarCanalPartida(client, db, guild, { modo: modoInfo, preco: valor, gelo, jogadores: ids, reservaId });
    if (!canal?.id) throw new Error('Discord não retornou o ID do canal.');
    etapa = 'vinculo';
    await repetirMesmoPedido(() => filas.vincularCanal(db, { reservaId, guildId: guild.id, canalId: canal.id }), (r) =>
      r && r.id === reservaId && r.guild_id === String(guild.id) && r.canal_id === String(canal.id)
      && ['reservada', 'concluida'].includes(r.estado));
    etapa = 'partida';
    const dadosPartida = { reservaId, partidaId, guildId: guild.id, modo: modoInfo.id, preco: valor, gelo, canalId: canal.id, jogadores };
    const criacao = await repetirMesmoPedido(() => partidas.criar(db, dadosPartida), (p) =>
      p && String(p.id) === partidaId && String(p.guild_id) === String(guild.id)
      && String(p.canal_id) === String(canal.id) && String(p.modo) === String(modoInfo.id)
      && Number(p.preco) === valor && String(p.gelo) === String(gelo)
      && Object.values(STATUS).includes(p.status));
    partida = criacao.resposta;
    criacaoIncerta = criacao.houveIncerteza;
  } catch (erro) {
    // Só uma rejeição na primeira tentativa prova que essa tentativa de criação
    // foi recusada; uma tentativa anterior pode ainda chegar ao servidor.
    const canalId = canal?.id || null;
    console.error(`[fluxo] pareamento interrompido; reserva ${reservaId}, partida ${partidaId}, guild ${guild.id}, canal ${canalId || '(não confirmado)'}, capitães ${ids.join(', ')}, etapa ${etapa}, código ${erro.code || 'desconhecido'}:`, erro.message);
    const diagnostico = etapa === 'partida' && erro.code === 'PBL01' && !erro.tentativaAnteriorIncerta
      ? 'Criação recusada: há jogador na lista negra.'
      : 'Resultado do pareamento não confirmado; uma operação pode ainda estar em processamento.';
    const aviso = `${diagnostico} Reserva ${reservaId}; partida ${partidaId}; canal ${canalId || 'não confirmado'}. Peça a um ADM reconciliá-la; não reentre manualmente.${textoPaineis()}`;
    if (canal?.send) {
      try { await canal.send({ content: `${ids.map(mencao).join(' ')} ${aviso}`, allowedMentions: { parse: ['users'] } }); }
      catch (avisoErro) { console.error(`[fluxo] não consegui avisar no canal ${canalId}:`, avisoErro.message); }
    }
    throw erroComContexto(aviso, erro, canalId);
  }

  // Se uma criação foi repetida, ou o estado já avançou, outro ator pode ter
  // publicado. Sem ID salvo, não se pode concluir que o canal está vazio.
  let publicacaoConfirmada = false;
  try {
    if (partida.mensagem_id || criacaoIncerta || partida.status !== STATUS.CONFIRMANDO) {
      publicacaoConfirmada = await atualizarPartida(client, db, partidaId, { somenteEditar: true });
    } else {
      publicacaoConfirmada = await publicarSala(client, db, partida);
      if (!publicacaoConfirmada) {
        // Ler o ID persistido e editar é seguro; nunca reenviar aqui.
        publicacaoConfirmada = await atualizarPartida(client, db, partidaId, { somenteEditar: true });
      }
    }
  } catch (erro) {
    console.error(`[fluxo] publicação não confirmada da partida ${partidaId}:`, erro.message);
  }
  // Confirme novamente os painéis após a criação, ainda em best effort: a
  // partida já existe mesmo se qualquer uma dessas atualizações falhar.
  for (const alvo of alvos.values()) await atualizarPainel(alvo.modo, alvo.preco);
  let auditoriaConfirmada = true;
  try {
    await auditoria.registrar(db, client, {
      guildId: guild.id, acao: 'AP criado',
      detalhe: `${modoInfo.titulo} · ${reais(valor)} · ${gelo} · sala ${canal.name} · ${ids.length} capitães (1 por time)`,
    });
  } catch (erro) {
    auditoriaConfirmada = false;
    console.error(`[fluxo] auditoria não confirmada para partida ${partidaId}:`, erro.message);
  }
  const pendencias = [];
  if (!publicacaoConfirmada) pendencias.push('a publicação do cartão não foi confirmada e pode já ter ocorrido');
  if (partida.status !== STATUS.CONFIRMANDO) pendencias.push(`o estado retornado é ${partida.status}`);
  if (problemasPaineis.size) pendencias.push(`atualização dos painéis não confirmada (${[...problemasPaineis.values()].join(', ')})`);
  if (!auditoriaConfirmada) pendencias.push('auditoria não confirmada');
  if (pendencias.length) {
    throw erroComContexto(`A partida ${partidaId} foi confirmada no banco, na reserva ${reservaId} e canal ${canal.id}, mas ${pendencias.join('; ')}. Não entre novamente nem recrie a partida ou a mensagem. Peça a um ADM verificar o canal, a reserva e os painéis antes de qualquer ação.`, null, canal.id,
      { partidaConfirmada: true, publicacaoConfirmada, partida, paineisPendentes: [...problemasPaineis.values()] });
  }
  return { posicao: resultado.posicao, naFila: 0, faltam: 0, fechou: true, partida, reservaId, partidaId, canalId: canal.id };
}

/** Resultado, economia, auditoria e outbox são confirmados na mesma RPC. */
async function finalizarERegistrarNoSupabase(db, dados) {
  return partidas.finalizar(db, dados);
}

async function encerrarPartida(client, db, { partidaId, vencedorTime, autorId, motivo = 'resultado' }) {
  return finalizarERegistrarNoSupabase(db, { partidaId, vencedorTime, autorId, motivo });
}

async function aplicarWO(client, db, { partidaId, timeAusente, autorId }) {
  const ausente = Number(timeAusente);
  if (![1, 2].includes(ausente)) throw new Error('O time ausente precisa ser 1 ou 2.');
  return finalizarERegistrarNoSupabase(db, {
    partidaId, vencedorTime: ausente === 1 ? 2 : 1, autorId, motivo: 'wo',
  });
}

async function cancelarPartida(client, db, { partidaId, autorId, motivo }) {
  return partidas.cancelar(db, { partidaId, autorId, motivo });
}

module.exports = {
  STATUS,
  nomeTime,
  textoJogadores,
  tipoPartida,
  embedPartida,
  componentesPartida,
  resolverCategoria,
  criarCanalPartida,
  publicarSala,
  atualizarPartida,
  restaurarCartoesPartida,
  notificarPartidaFormada,
  notificarPartidasPendentes,
  ocultarPartidasPendentes,
  removerPainelNotificacao,
  concederAcessoPartida,
  entrarNaFila,
  anunciarPix,
  encerrarPartida,
  aplicarWO,
  cancelarPartida,
  TAXA_MEDIADOR_CENTAVOS,
  valorPorCapitao,
  definirConfig,
};
