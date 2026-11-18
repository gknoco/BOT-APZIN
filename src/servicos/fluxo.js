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
const royalSupabase = require('./royalSupabase');

const { STATUS } = partidas;
const notificacoesEmAndamento = new Set();

const NOME_TIME = { 1: 'Equipe 1', 2: 'Equipe 2' };
const nomeTime = (time) => NOME_TIME[Number(time)] || `Equipe ${time}`;

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
    const comissao = Number(partida.comissao) > 0 ? Number(partida.comissao) : config.COMISSAO_PADRAO;
    const premio = Math.round(Number(partida.preco) * 2 * (1 - comissao));
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
    {
      name: 'Regra da partida',
      value: partida.regras
        ? `${partida.regras}\n— por ${mencao(partida.regras_por)}`
        : '`ninguém enviou ainda`',
      inline: false,
    },
  ];

  let titulo = `🎯 AP ${modo ? modo.titulo : partida.modo} · ${reais(partida.preco)}`;
  let descricao = '';
  let cor = config.CORES.principal;

  switch (partida.status) {
    case STATUS.AGUARDANDO_MEDIADOR:
      descricao = `**Passo 2 · Mediação**\nRegras confirmadas. Aguardando ${mencaoCargo(config.CARGO_MEDIADOR_ID)} assumir a sala.`;
      cor = config.CORES.aviso;
      campos.push({
        name: 'PIX do mediador',
        value: 'aparece aqui quando o mediador assumir a sala',
        inline: false,
      });
      break;
    case STATUS.AGUARDANDO_PAGAMENTO:
      descricao =
        '**Passo 3 · Pagamento**\n' +
        `Mediador: ${mencao(partida.mediador_id)}\n` +
        'Clique em **Enviar PIX** para mandar a chave, e em **Pagamento recebido** depois de conferir os comprovantes.';
      cor = config.CORES.aviso;
      campos.push({
        name: 'PIX do mediador',
        value: 'consulte a mensagem de pagamento enviada pelo mediador nesta sala',
        inline: false,
      });
      break;
    case STATUS.PAGO:
      descricao =
        '**Passo 4 · Sala**\nPagamento confirmado ✅\n' +
        'Clique em **Criar sala (Nix)**: o ID e a senha são publicados automaticamente no canal da fila.';
      cor = config.CORES.gelo;
      campos.push({
        name: 'PIX do mediador',
        value: 'pagamento confirmado',
        inline: true,
      });
      break;
    case STATUS.SALA_LIBERADA:
      descricao =
        '**Passo 5 · Sala liberada**\nEntrem no Free Fire com o ID e a senha abaixo.\n' +
        'Quando os **dois** estiverem dentro da sala, cada um digita `/go` aqui no canal.\n' +
        'O bot avisa e a partida inicia em 3 segundos.';
      cor = config.CORES.sucesso;
      campos.push(
        { name: 'ID da sala', value: partida.sala_id ? `\`${partida.sala_id}\`` : '—', inline: true },
        { name: 'Senha', value: partida.sala_senha ? `\`${partida.sala_senha}\`` : '—', inline: true },
      );
      break;
    case STATUS.EM_ANDAMENTO:
      descricao =
        '**Partida em andamento ⚔️**\nOs dois jogadores deram GO.\n' +
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
          botao(`ap:criarsala:${id}`, 'Criar sala (Nix)', '🎮', ButtonStyle.Primary),
          botao(`ap:cancelar:${id}`, 'Cancelar', '🚫', ButtonStyle.Danger),
        ),
      );
      break;
    case STATUS.SALA_LIBERADA:
    case STATUS.EM_ANDAMENTO:
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

async function criarCanalPartida(client, db, guild, { modo, preco, gelo, jogadores }) {
  // A sala privada nasce DENTRO da categoria configurada (CATEGORIA_FILAS_ID ou
  // `/boombot setcategoria`). Sem categoria configurada o bot tenta achar uma
  // categoria de filas pelo nome antes de criar na raiz do servidor.
  const categoria = await resolverCategoria(guild, db, 'categoria_filas', config.CATEGORIA_FILAS_ID);
  const A = PermissionFlagsBits;
  const permissoes = [
    { id: guild.roles.everyone.id, deny: [A.ViewChannel] },
    {
      id: client.user.id,
      allow: [A.ViewChannel, A.SendMessages, A.EmbedLinks, A.ReadMessageHistory, A.ManageChannels, A.ManageMessages],
    },
    ...jogadores.map((userId) => ({
      id: String(userId),
      allow: [A.ViewChannel, A.SendMessages, A.ReadMessageHistory, A.EmbedLinks],
    })),
  ];
  // Só mediadores e ADM veem a sala de aposta.
  for (const cargo of await mediadores.mencoes(db, guild.id)) {
    permissoes.push({
      id: cargo,
      allow: [A.ViewChannel, A.SendMessages, A.ReadMessageHistory, A.EmbedLinks],
    });
  }

  // #fila-gelo-normal-001 — numeração contínua por tipo de entrada.
  const nome = paineis.nomeSalaFila(guild, modo, gelo);

  const canal = await guild.channels.create({
    name: nome,
    type: ChannelType.GuildText,
    ...(categoria ? { parent: categoria.id } : {}),
    topic: `AP ${modo.titulo} · ${reais(preco)} · ${gelo} · sala privada`,
    permissionOverwrites: permissoes,
  });

  return canal;
}

async function publicarSala(client, db, partida) {
  try {
    const canal = client.channels.cache.get(partida.canal_id) || (await client.channels.fetch(partida.canal_id));
    if (!canal) return false;
    const lista = await partidas.jogadores(db, partida.id);
    const mensagem = await canal.send({
      content: `${lista.map((linha) => mencao(linha.user_id)).join(' ')} — sala de AP criada.`,
      embeds: [embedPartida(partida, lista)],
      components: componentesPartida(partida),
      allowedMentions: { parse: ['users'] },
    });
    await partidas.definirMensagem(db, partida.id, mensagem.id);
    // Nada de "mandem o ID e a senha": o mediador cria a sala pelo bot.
    return true;
  } catch (erro) {
    console.error('[fluxo] não consegui publicar a sala:', erro.message);
    return false;
  }
}

async function atualizarPartida(client, db, partidaId) {
  const partida = await partidas.buscar(db, partidaId);
  if (!partida) return false;
  try {
    const canal = client.channels.cache.get(partida.canal_id) || (await client.channels.fetch(partida.canal_id));
    if (!canal) return false;
    const lista = await partidas.jogadores(db, partidaId);
    const payload = { embeds: [embedPartida(partida, lista)], components: componentesPartida(partida) };

    if (partida.mensagem_id) {
      const mensagem = await canal.messages.fetch(partida.mensagem_id).catch(() => null);
      if (mensagem) {
        await mensagem.edit(payload);
        return true;
      }
    }
    const nova = await canal.send({ ...payload, allowedMentions: { parse: ['users'] } });
    await partidas.definirMensagem(db, partidaId, nova.id);
    return true;
  } catch (erro) {
    console.error('[fluxo] não consegui atualizar a sala:', erro.message);
    return false;
  }
}

/** Notifica a staff quando os capitães confirmam a partida; a assunção usa o lock do Supabase. */
async function notificarPartidaFormada(client, db, partida) {
  if (partida?.mediador_id) return false;
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
    const plantonistas = await plantao.listar(db, partida.guild_id);
    if (!plantonistas.length) {
      console.warn(`[fluxo] partida ${partida.id} não publicada: nenhum mediador ativo na guild ${partida.guild_id}.`);
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
  const pendentes = await partidas.pendentes(db, guildId);
  let removidas = 0;
  for (const partida of pendentes) {
    const chaveMensagem = `partida_aceite_mensagem_${partida.id}`;
    const mensagemId = await obterConfig(db, guildId, chaveMensagem, null);
    if (!mensagemId) continue;
    const canalId = await obterConfig(db, guildId, 'canal_partidas_formadas', null);
    const canal = canalId
      ? (client.channels.cache.get(String(canalId)) || await client.channels.fetch(String(canalId)).catch(() => null))
      : null;
    const mensagem = await canal?.messages?.fetch?.(String(mensagemId)).catch?.(() => null);
    if (mensagem) {
      await mensagem.delete().catch(() => {});
      removidas += 1;
    }
    await definirConfig(db, guildId, chaveMensagem, null);
  }
  return removidas;
}

async function concederAcessoPartida(client, db, partidaId, userId) {
  const partida = await partidas.buscar(db, partidaId);
  if (!partida) return false;
  const canal = client.channels.cache.get(String(partida.canal_id)) || await client.channels.fetch(String(partida.canal_id)).catch(() => null);
  if (!canal?.permissionOverwrites?.edit) return false;
  await canal.permissionOverwrites.edit(String(userId), {
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
    `💸 **PIX do mediador** — ${mencao(mediadorId)}`,
    `**Chave:** \`${chave}\``,
    titular ? `**Titular:** ${titular}` : null,
    `**Valor por capitão (1 por time):** ${reais(partida.preco)}`,
    '',
    'Enviem o comprovante **nesta sala**. O mediador libera a sala depois de conferir.',
  ]
    .filter(Boolean)
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
 * Lança Error com mensagem amigável quando algo impede a entrada.
 */
async function entrarNaFila(client, db, { guild, userId, modo, preco, gelo }) {
  const modoInfo = config.modoPorId(modo);
  if (!modoInfo) throw new Error('Modo de AP inválido.');
  const valor = Number(preco);
  if (!config.PRECOS.includes(valor)) throw new Error('Faixa de aposta inválida.');
  if (!config.varianteDoModo(modoInfo, gelo)) {
    throw new Error('Escolha uma opção de entrada válida para esse modo.');
  }

  const bloqueio = await blacklist.obter(db, guild.id, userId);
  if (bloqueio) throw new Error(`Você está na lista negra da ORG: **${bloqueio.motivo}**.`);

  const resultado = await filas.entrar(db, {
    guildId: guild.id,
    modo: modoInfo.id,
    preco: valor,
    gelo,
    userId,
  });

  if (!resultado.entrou) {
    throw new Error(`Você já está nessa fila (posição ${resultado.posicao}).`);
  }

  const painelOk = await paineis.atualizar(client, db, {
    guildId: guild.id,
    modo: modoInfo.id,
    preco: valor,
  });
  if (!painelOk) {
    console.error(
      `[fluxo] o jogador entrou na fila, mas o painel ${modoInfo.id} (${reais(valor)}) não atualizou. ` +
        'Confira se o bot pode Ver o canal, Enviar e Editar mensagens.',
    );
  }

  const naFila = await filas.contar(db, { guildId: guild.id, modo: modoInfo.id, preco: valor, gelo });
  // TODA fila abre com 2 capitães (1 por time). Em 3x3/4x4 o capitão leva o
  // time dele para a sala personalizada com o ID/senha — não espera 6 ou 8.
  if (naFila < config.CAPITAES_POR_PARTIDA) {
    return {
      posicao: resultado.posicao,
      naFila,
      faltam: config.CAPITAES_POR_PARTIDA - naFila,
      fechou: false,
      partida: null,
    };
  }

  const ids = await filas.reservar(db, {
    guildId: guild.id,
    modo: modoInfo.id,
    preco: valor,
    gelo,
    quantidade: config.CAPITAES_POR_PARTIDA,
  });
  if (!ids) {
    return { posicao: resultado.posicao, naFila, faltam: 1, fechou: false, partida: null };
  }

  const jogadores = ids.map((id, indice) => ({
    userId: id,
    time: indice + 1,
  }));

  let canal = null;
  let partida;
  try {
    canal = await criarCanalPartida(client, db, guild, { modo: modoInfo, preco: valor, gelo, jogadores: ids });
    partida = await partidas.criar(db, {
      guildId: guild.id,
      modo: modoInfo.id,
      preco: valor,
      gelo,
      canalId: canal.id,
      jogadores,
    });
  } catch (erro) {
    console.error('[fluxo] falha ao criar sala/partida:', erro.message);
    if (canal) {
      try {
        // A RPC pode ter feito commit antes de perder a resposta HTTP.
        partida = await partidas.porCanal(db, guild.id, canal.id);
        if (partida && (String(partida.guild_id) !== String(guild.id) || String(partida.canal_id) !== String(canal.id))) {
          throw new Error('A consulta retornou uma partida de outro servidor/canal.');
        }
      } catch (consultaErro) {
        console.error(`[fluxo] criação incerta; guild ${guild.id}, canal ${canal.id}, capitães ${ids.join(', ')}:`, consultaErro.message);
        throw new Error(
          `Não foi possível confirmar a criação da partida no Supabase. Peça a um ADM verificar o canal ${canal.id} antes de tentar novamente. Os capitães não foram recolocados na fila para evitar uma partida duplicada.`,
          { cause: consultaErro },
        );
      }
    }
    if (!partida) {
      // Só compensa após ausência confirmada (ou antes de existir um canal).
      const compensacoes = await Promise.allSettled(jogadores.map((jogador) => filas.entrar(db, {
        guildId: guild.id, modo: modoInfo.id, preco: valor, gelo, userId: jogador.userId,
      })));
      if (canal) compensacoes.push(...await Promise.allSettled([
        Promise.resolve().then(() => canal.delete('Criação da partida não persistida no Supabase')),
      ]));
      compensacoes.push(...await Promise.allSettled([
        paineis.atualizar(client, db, { guildId: guild.id, modo: modoInfo.id, preco: valor }),
      ]));
      for (const resultado of compensacoes) {
        if (resultado.status === 'rejected') console.error('[fluxo] falha ao compensar criação da partida:', resultado.reason);
      }
      throw new Error(canal
        ? 'Não consegui salvar a partida no Supabase. Peça a um ADM verificar a fila e os canais antes de tentar novamente.'
        : 'Os dois capitães entraram, mas não consegui criar a sala privada. Peça para um ADM verificar se o bot tem **Gerenciar Canais** e se a categoria de filas existe.');
    }
  }

  await publicarSala(client, db, partida);
  await paineis.atualizar(client, db, { guildId: guild.id, modo: modoInfo.id, preco: valor });
  await auditoria.registrar(db, client, {
    guildId: guild.id,
    acao: 'AP criado',
    detalhe: `${modoInfo.titulo} · ${reais(valor)} · ${gelo} · sala ${canal.name} · ${ids.length} capitães (1 por time)`,
  });

  return { posicao: resultado.posicao, naFila: 0, faltam: 0, fechou: true, partida, canalId: canal.id };
}

/** Finaliza e avisa na sala. */
async function finalizarERegistrarNoSupabase(db, { partidaId, vencedorTime, autorId, motivo }) {
  const existente = await partidas.buscar(db, partidaId);
  let resultado;
  if (existente?.status === STATUS.FINALIZADA) {
    // Se a RPC de resultado falhou após finalizar o estado na nuvem, o mesmo
    // botão pode repetir a sincronização com o ID da partida como chave idempotente.
    if (Number(existente.vencedor_time) !== Number(vencedorTime) || existente.motivo_fim !== motivo) {
      throw new Error('Essa partida já foi encerrada com outro resultado.');
    }
    resultado = { partida: existente, jogadores: await partidas.jogadores(db, partidaId) };
  } else {
    resultado = await partidas.finalizar(db, { partidaId, vencedorTime, autorId, motivo });
  }

  await royalSupabase.registrarResultadoPartida({
    guildId: resultado.partida.guild_id,
    matchId: partidaId,
    winnerTime: vencedorTime,
    stake: resultado.partida.preco,
    players: resultado.jogadores,
    reason: motivo,
  });
  return resultado;
}

async function encerrarPartida(client, db, { partidaId, vencedorTime, autorId, motivo = 'resultado' }) {
  const resultado = await finalizarERegistrarNoSupabase(db, { partidaId, vencedorTime, autorId, motivo });
  await atualizarPartida(client, db, partidaId);
  await auditoria.registrar(db, client, {
    guildId: resultado.partida.guild_id,
    autorId,
    acao: motivo === 'wo' ? 'W.O. aplicado' : 'Resultado registrado',
    detalhe: `Sala ${partidaId} · ${nomeTime(vencedorTime)} venceu · ${reais(resultado.partida.preco)}`,
  });
  return resultado;
}

async function aplicarWO(client, db, { partidaId, timeAusente, autorId }) {
  const ausente = Number(timeAusente);
  if (![1, 2].includes(ausente)) throw new Error('O time ausente precisa ser 1 ou 2.');
  const resultado = await finalizarERegistrarNoSupabase(db, {
    partidaId,
    vencedorTime: ausente === 1 ? 2 : 1,
    autorId,
    motivo: 'wo',
  });
  await atualizarPartida(client, db, partidaId);
  await auditoria.registrar(db, client, {
    guildId: resultado.partida.guild_id,
    autorId,
    acao: 'W.O. aplicado',
    detalhe: `Sala ${partidaId} · ${nomeTime(timeAusente)} não apareceu · ${reais(resultado.partida.preco)}`,
  });
  return resultado;
}

async function cancelarPartida(client, db, { partidaId, autorId, motivo }) {
  const partida = await partidas.cancelar(db, { partidaId, autorId, motivo });
  await atualizarPartida(client, db, partidaId);
  await auditoria.registrar(db, client, {
    guildId: partida.guild_id,
    autorId,
    acao: 'AP cancelado',
    detalhe: `Sala ${partidaId} · ${motivo}`,
  });
  return partida;
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
  notificarPartidaFormada,
  notificarPartidasPendentes,
  ocultarPartidasPendentes,
  concederAcessoPartida,
  entrarNaFila,
  anunciarPix,
  encerrarPartida,
  aplicarWO,
  cancelarPartida,
  definirConfig,
};
