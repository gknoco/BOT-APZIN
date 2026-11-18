'use strict';

/**
 * Filas de AP: UMA MENSAGEM POR FAIXA DE APOSTA (15 mensagens no canal).
 *
 * Ordem de envio: do MAIOR preço para o MENOR. No Discord a mensagem mais nova
 * fica embaixo, então a faixa mais barata (R$ 0,50) é a última mensagem do
 * canal e os valores vão subindo conforme você rola para cima — exatamente o
 * layout combinado com a ORG.
 *
 * O comando `/filas…` publica as 15 mensagens no canal onde foi executado —
 * NÃO cria canal. Quem cria canal é o matchmaking: quando a fila fecha, a sala
 * privada da partida nasce DENTRO da categoria configurada (CATEGORIA_FILAS_ID
 * no .env ou `/boombot setcategoria`).
 */

const {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const config = require('../config');
const { embed, reais, mencao, tituloCurto, listaUsuarios } = require('../util/embeds');
const filasServico = require('./filas');

const CHAVE_VISUAL = 'filas_visual';
async function obterVisual(db, guildId) {
  const valor = await require('./supabase').obterConfig(guildId, CHAVE_VISUAL, db?.client);
  try { return valor ? JSON.parse(valor) : {}; } catch { return {}; }
}
async function salvarVisual(db, guildId, tipo, valor) {
  const atual = await obterVisual(db, guildId);
  if (valor === null) delete atual[`${tipo}_url`];
  else atual[`${tipo}_url`] = String(valor);
  await require('./supabase').definirConfig(guildId, CHAVE_VISUAL, JSON.stringify(atual), db?.client);
  return atual;
}

/** Preços do maior para o menor: é essa a ordem em que as mensagens saem. */
const PRECOS_ENVIO = [...config.PRECOS].sort((a, b) => b - a);

/** Linhas de cada tipo de entrada (gelo/categoria) com os jogadores na fila. */
function linhasDeEntrada(modo, preco, entradas) {
  const doPreco = entradas.filter((linha) => Number(linha.preco) === Number(preco));
  const variantes = config.variantesDoModo(modo).map((variante) => {
    const ids = doPreco.filter((linha) => linha.gelo === variante.id).map((linha) => linha.user_id);
    return `${variante.emoji} **${variante.nome}** (${ids.length}/${config.CAPITAES_POR_PARTIDA} capitães): ${listaUsuarios(ids)}`;
  });
  return { doPreco, variantes };
}

/** Card de um valor (usado no painel antigo, de uma mensagem só). */
function linhaDePreco(modo, preco, entradas) {
  const { doPreco, variantes } = linhasDeEntrada(modo, preco, entradas);
  return {
    name: `💵 ${reais(preco)} · ${doPreco.length} na fila`,
    value: variantes.join('\n') || 'Nenhum jogador na fila.',
    inline: false,
  };
}

/** Painel antigo (todos os valores em um embed) — mantido para compatibilidade. */
function embedPainel(modo, entradas = []) {
  return embed(`🎯 AP ${modo.titulo}`, [
    `**Modo:** ${modo.titulo}   ·   **Abre com:** ${config.CAPITAES_POR_PARTIDA} capitães (1 por time) · formato ${modo.time}x${modo.time}`,
    `**Cards:** de ${reais(config.PRECOS[0])} (topo) até ${reais(config.PRECOS[config.PRECOS.length - 1])} (fundo).`,
    '',
    '**Como entrar:** escolha o valor no menu abaixo e depois o botão da sua categoria.',
    'Quando os 2 capitães entram, o bot abre uma **sala privada** com a regra, o mediador e o PIX.',
  ].join('\n'), {
    cor: config.CORES.principal,
    campos: config.PRECOS.map((preco) => linhaDePreco(modo, preco, entradas)),
    rodape: `ORG Royal AP · ${entradas.length} jogador(es) na fila`,
  });
}

/** Menu com todos os valores + Sair + Como funciona (ranking é comando separado). */
function componentesPainel(modo) {
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`ap:preco:${modo.id}`)
    .setPlaceholder('Escolha a faixa de aposta…')
    .addOptions(
      config.PRECOS.map((preco) => ({
        label: reais(preco),
        value: String(preco),
        description: `AP ${modo.titulo} · 2 capitães (1 por time)`,
      })),
    );

  const botoes = [
    new ButtonBuilder()
      .setCustomId(`ap:sair:${modo.id}:todos`)
      .setLabel('Sair da Fila')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger),
  ];
  if (config.mostrarComoFunciona(modo)) {
    botoes.push(
      new ButtonBuilder()
        .setCustomId('ap:como')
        .setLabel('Como funciona')
        .setEmoji('❓')
        .setStyle(ButtonStyle.Secondary),
    );
  }

  return [new ActionRowBuilder().addComponents(menu), new ActionRowBuilder().addComponents(...botoes)];
}

/**
 * Botões do card, conforme a categoria do canal:
 *  mobile   → Gelo Infinito · Gelo Normal · Como funciona · Sair
 *  emu      → Normal · Full UMP e XM8 · Como funciona · Sair
 *  fullcapa → Full Capa · Como funciona · Sair
 *  misto    → 1 Emu (2 Emu, 3 Emu conforme o time) · Sair  (sem "Como funciona")
 */
function componentesEntrada(modo, preco, opcoes = {}) {
  const estilos = [ButtonStyle.Primary, ButtonStyle.Success, ButtonStyle.Secondary];
  const botoes = config.variantesDoModo(modo).map((variante, indice) =>
    new ButtonBuilder()
      .setCustomId(`ap:entrar:${modo.id}:${preco}:${variante.id}`)
      .setLabel(variante.nome)
      .setEmoji(variante.emoji)
      .setStyle(estilos[indice] || ButtonStyle.Secondary),
  );

  if (config.mostrarComoFunciona(modo)) {
    botoes.push(
      new ButtonBuilder()
        .setCustomId('ap:como')
        .setLabel('Como funciona')
        .setEmoji('❓')
        .setStyle(ButtonStyle.Secondary),
    );
  }

  // "Sair da fila" entra na MESMA linha do card, ao lado de "Como funciona",
  // e só na faixa que tem jogador. Quando a faixa esvazia, o botão some.
  if (opcoes.sair) botoes.push(botaoSair(modo, preco));

  return [new ActionRowBuilder().addComponents(...botoes)];
}

/** Botão "Sair" de uma faixa (o card mostra só quando a faixa tem jogador). */
function botaoSair(modo, preco) {
  return new ButtonBuilder()
    .setCustomId(`ap:sair:${modo.id}:${preco}`)
    .setLabel('Sair da fila')
    .setEmoji('❌')
    .setStyle(ButtonStyle.Danger);
}

/** Linha pronta com o "Sair" para a resposta efêmera de quem entrou. */
function linhaSair(modo, preco) {
  return new ActionRowBuilder().addComponents(botaoSair(modo, preco));
}

/** Jogadores de uma faixa no formato limpo: "Gelo Normal | <@id>". */
function jogadoresDaFaixa(modo, preco, entradas = []) {
  return entradas
    .filter((linha) => Number(linha.preco) === Number(preco))
    .map((linha) => `${config.varianteDoModo(modo, linha.gelo)?.nome ?? linha.gelo} | ${mencao(linha.user_id)}`);
}

/**
 * UMA mensagem da fila: card minimalista com o título do modo + valor e o
 * campo Jogadores. Sem textão explicativo e sem rodapé pesado.
 */
function mensagemPreco(modo, preco, entradas = [], visual = {}) {
  const jogadores = jogadoresDaFaixa(modo, preco, entradas);
  const card = embed(`${tituloCurto(modo)} | Zenith - Hub`, null, {
    cor: 0xed4245,
    campos: [
      { name: '⦿  Modo:', value: `${modo.titulo} · ${modo.time}v${modo.time}`, inline: false },
      { name: '◉  Valor:', value: reais(preco), inline: false },
      { name: '♙  Jogadores:', value: jogadores.length ? jogadores.join('\n') : 'Nenhum jogador na fila.', inline: false },
    ],
    rodape: 'Zenith - Hub · Entre na fila pelos botões abaixo',
  });
  if (visual.avatar_url) card.setThumbnail(visual.avatar_url);
  if (visual.banner_url) card.setImage(visual.banner_url);

  return {
    embeds: [card],
    components: componentesEntrada(modo, preco, { sair: jogadores.length > 0 }),
  };
}

/**
 * As 15 mensagens da fila, na ordem de envio:
 * R$ 100,00 primeiro (topo) … R$ 0,50 por último (fica embaixo).
 */
function mensagensFila(modo, entradas = []) {
  return PRECOS_ENVIO.map((preco) => ({ preco, payload: mensagemPreco(modo, preco, entradas) }));
}

/** Painel antigo completo (uma mensagem só). */
function mensagemPainel(modo, entradas) {
  return { embeds: [embedPainel(modo, entradas)], components: componentesPainel(modo) };
}

async function salvar(db, { guildId, modo, canalId, mensagemId }) {
  const { error } = await db.client.from('royal_paineis').upsert({
    guild_id: String(guildId),
    modo: String(modo),
    canal_id: String(canalId),
    mensagem_id: String(mensagemId),
    criado_em: Date.now(),
  }, { onConflict: 'guild_id,modo' });
  if (error) throw new Error(`Não consegui salvar o painel no Supabase: ${error.message}`);
}

/** Grava a fila inteira: uma linha por faixa de preço. */
async function salvarFila(db, { guildId, modo, canalId, mensagens }) {
  const { error } = await db.client.rpc('royal_registrar_mensagens_painel', {
    p_guild_id: String(guildId),
    p_modo: String(modo),
    p_canal_id: String(canalId),
    p_mensagens: mensagens.map((linha) => ({
      preco: Math.trunc(linha.preco),
      mensagem_id: String(linha.mensagemId),
    })),
    p_atualizado_em: Date.now(),
  });
  if (error) throw new Error(`Não consegui registrar as mensagens do painel no Supabase: ${error.message}`);
}

/** Mensagens salvas, do maior preço para o menor (mesma ordem do canal). */
async function mensagensSalvas(db, { guildId, modo }) {
  const { data, error } = await db.client.from('royal_mensagens_painel')
    .select('guild_id,modo,preco,canal_id,mensagem_id,atualizado_em')
    .eq('guild_id', String(guildId)).eq('modo', String(modo))
    .order('preco', { ascending: false }).limit(config.PRECOS.length);
  if (error) throw new Error(`Não consegui ler as mensagens do painel no Supabase: ${error.message}`);
  return data || [];
}

async function obter(db, { guildId, modo }) {
  const { data, error } = await db.client.from('royal_paineis')
    .select('guild_id,modo,canal_id,mensagem_id,criado_em')
    .eq('guild_id', String(guildId)).eq('modo', String(modo)).maybeSingle();
  if (error) throw new Error(`Não consegui ler o painel no Supabase: ${error.message}`);
  return data || null;
}

async function todos(db, guildId) {
  const resultado = [];
  const tamanho = 1000;
  for (let inicio = 0; ; inicio += tamanho) {
    const { data, error } = await db.client.from('royal_paineis')
      .select('guild_id,modo,canal_id,mensagem_id,criado_em')
      .eq('guild_id', String(guildId)).order('modo', { ascending: true })
      .range(inicio, inicio + tamanho - 1);
    if (error) throw new Error(`Não consegui listar os painéis no Supabase: ${error.message}`);
    resultado.push(...(data || []));
    if (!data || data.length < tamanho) return resultado;
  }
}

/**
 * Apaga mensagens do painel anterior que ainda existem no canal.
 * Só apaga o que o próprio bot enviou — mensagem de outro bot fica intocada.
 */
async function apagarMensagens(canal, antigas = [], manter = new Set()) {
  if (!canal?.messages?.fetch) return 0;
  let apagadas = 0;
  for (const linha of antigas) {
    if (String(linha.canal_id) !== String(canal.id)) continue;
    if (manter.has(String(linha.mensagem_id))) continue;
    try {
      const mensagem = await canal.messages.fetch(linha.mensagem_id).catch(() => null);
      if (!mensagem?.delete) continue;
      const autor = mensagem.author?.id;
      const eu = canal.client?.user?.id;
      if (autor && eu && autor !== eu) continue; // painel de outro bot: não mexe
      await mensagem.delete();
      apagadas += 1;
    } catch {
      /* mensagem já apagada ou sem permissão: segue o jogo */
    }
  }
  return apagadas;
}

/**
 * Envia as 15 mensagens da fila no canal e guarda os IDs no banco.
 * Antes de salvar, guarda o conjunto antigo e apaga essas mensagens depois —
 * assim publicar o painel de novo não deixa 15 mensagens velhas no canal.
 */
async function publicarFila(db, canal, { guildId, modo, entradas = [] }) {
  const antigas = await mensagensSalvas(db, { guildId, modo: modo.id });
  const visual = await obterVisual(db, guildId);
  const enviadas = [];
  for (const { preco } of mensagensFila(modo, entradas)) {
    const payload = mensagemPreco(modo, preco, entradas, visual);
    const mensagem = await canal.send(payload);
    enviadas.push({ preco, mensagemId: mensagem.id });
  }
  await salvarFila(db, { guildId, modo: modo.id, canalId: canal.id, mensagens: enviadas });
  await apagarMensagens(canal, antigas, new Set(enviadas.map((linha) => String(linha.mensagemId))));
  return enviadas;
}

/**
 * Redesenha as mensagens da fila (todas ou só a faixa informada).
 *
 * Se NENHUMA mensagem puder ser editada (ID antigo, mensagem apagada ou painel
 * publicado por outro bot/token), o painel é republicado na hora e os novos
 * IDs são gravados — é isso que faz a fila voltar a mostrar os jogadores sem
 * precisar rodar o comando de painel de novo.
 */
async function atualizar(client, db, { guildId, modo, preco = null }) {
  const modoInfo = config.modoPorId(modo);
  if (!modoInfo) return false;

  const entradas = await filasServico.listar(db, { guildId, modo: modoInfo.id });
  const visual = await obterVisual(db, guildId);
  const linhas = await mensagensSalvas(db, { guildId, modo: modoInfo.id });

  if (linhas.length) {
    const filtradas =
      preco === null || preco === undefined
        ? linhas
        : linhas.filter((linha) => Number(linha.preco) === Number(preco));
    // Faixa nova sem linha salva: atualiza o painel inteiro em vez de não fazer nada.
    const alvo = filtradas.length ? filtradas : linhas;
    let editadas = 0;
    const problemas = [];

    for (const linha of alvo) {
      try {
        const canal =
          client.channels.cache.get(linha.canal_id) || (await client.channels.fetch(linha.canal_id));
        if (!canal) {
          problemas.push(`canal ${linha.canal_id} não encontrado`);
          continue;
        }
        const mensagem = await canal.messages.fetch(linha.mensagem_id).catch(() => null);
        if (!mensagem) {
          problemas.push(`mensagem ${linha.mensagem_id} apagada`);
          continue;
        }
        if (client.user?.id && mensagem.author?.id && mensagem.author.id !== client.user.id) {
          problemas.push(`mensagem ${linha.mensagem_id} é de outro bot`);
          continue;
        }
        await mensagem.edit(mensagemPreco(modoInfo, Number(linha.preco), entradas, visual));
        editadas += 1;
      } catch (erro) {
        problemas.push(erro.message);
        console.error(`[paineis] não consegui atualizar ${reais(Number(linha.preco))}:`, erro.message);
      }
    }
    if (editadas > 0) return true;

    const canalId = alvo[0]?.canal_id ?? linhas[0].canal_id;
    let canal = null;
    try {
      canal = client.channels.cache.get(canalId) || (await client.channels.fetch(canalId));
    } catch (erro) {
      problemas.push(erro.message);
    }
    if (!canal?.send) {
      console.error(
        `[paineis] painel ${modoInfo.id} sem edição e sem canal para republicar (${problemas.slice(0, 2).join(' | ')})`,
      );
      return false;
    }

    console.warn(
      `[paineis] painel ${modoInfo.id} será republicado (${problemas.slice(0, 2).join(' | ') || 'nada editado'})`,
    );
    try {
      const enviadas = await publicarFila(db, canal, { guildId, modo: modoInfo, entradas });
      return enviadas.length > 0;
    } catch (erro) {
      console.error(`[paineis] não consegui republicar o painel ${modoInfo.id}:`, erro.message);
      return false;
    }
  }

  // Compatibilidade: painel antigo, com todos os cards em uma mensagem só.
  const painel = await obter(db, { guildId, modo: modoInfo.id });
  if (!painel) return false;
  try {
    const canal =
      client.channels.cache.get(painel.canal_id) || (await client.channels.fetch(painel.canal_id));
    if (!canal) return false;
    const mensagem = await canal.messages.fetch(painel.mensagem_id).catch(() => null);
    if (mensagem) {
      await mensagem.edit(mensagemPainel(modoInfo, entradas));
      return true;
    }
    // Painel antigo apagado: publica o formato novo de 15 mensagens.
    const enviadas = await publicarFila(db, canal, { guildId, modo: modoInfo, entradas });
    return enviadas.length > 0;
  } catch (erro) {
    console.error(`[paineis] não consegui atualizar o painel ${modoInfo.id}:`, erro.message);
    return false;
  }
}

/** "Gelo Normal" -> "gelo-normal" */
function slug(texto) {
  return String(texto || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Nome da sala privada da partida: #fila-gelo-normal-001, #fila-gelo-normal-002…
 * A numeração continua de onde parou (mesmo padrão do exemplo fila-gelo-normal-069).
 */
function nomeSalaFila(guild, modo, gelo) {
  const variante = config.varianteDoModo(modo, gelo);
  const base = `fila-${slug(variante?.nome ?? gelo) || 'ap'}`.slice(0, 90);
  const canais = guild?.channels?.cache?.filter?.((canal) => String(canal.name || '').startsWith(`${base}-`));

  let maior = 0;
  if (canais) {
    for (const canal of canais.values()) {
      const numero = Number(String(canal.name).slice(base.length + 1));
      if (Number.isFinite(numero) && numero > maior) maior = numero;
    }
  }
  return `${base}-${String(maior + 1).padStart(3, '0')}`;
}

module.exports = {
  PRECOS_ENVIO,
  embedPainel,
  componentesPainel,
  componentesEntrada,
  componentesGelo: componentesEntrada,
  linhaSair,
  jogadoresDaFaixa,
  nomeSalaFila,
  mensagemPreco,
  mensagensFila,
  mensagemPainel,
  salvar,
  salvarFila,
  mensagensSalvas,
  publicarFila,
  apagarMensagens,
  obter,
  todos,
  atualizar,
  obterVisual,
  salvarVisual,
};
