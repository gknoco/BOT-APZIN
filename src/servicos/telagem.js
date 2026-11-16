'use strict';

/**
 * Telagem: sala de call exclusiva por canal/partida.
 *
 * ── LINK ────────────────────────────────────────────────────────────────────
 * O código é DETERMINÍSTICO (derivado do servidor + canal/partida): a mesma
 * sala sempre recebe o mesmo código; canais diferentes nunca compartilham.
 *
 * ── POOL DE LINKS REAIS DO GOOGLE MEET ──────────────────────────────────────
 * Como o Google não tem API pública para criar salas, o bot mantém um POOL de
 * links reais do Meet (TELAGEM_LINKS no .env + links cadastrados pelo
 * `/telagem_links`). Cada partida/canal RESERVA um link ainda não usado e o
 * link fica gravado no banco: a sala nunca se cruza com outra partida e, se a
 * partida terminou, o link volta a ficar disponível.
 *
 * Sem nenhum link no pool, o bot cai no provedor configurado (jitsi por
 * padrão) para nunca deixar a staff sem sala.
 */

const crypto = require('crypto');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../config');
const { embed } = require('../util/embeds');
const { TABELAS } = require('../db/esquema');
const { cliente, executar, excluir, listarPaginado, rpc } = require('../db/consultas');

const ALFABETO = 'abcdefghijkmnopqrstuvwxyz';

const PROVEDORES = {
  jitsi: { nome: 'Jitsi Meet', base: 'https://meet.jit.si', prefixo: 'royal-ap-' },
  google: { nome: 'Google Meet', base: 'https://meet.google.com', prefixo: '' },
};

const MENSAGEM_POOL = 'Todos os links do Google Meet do pool estão em uso. Peça a um ADM para adicionar mais com `/telagem_links adicionar`.';

function bloco(tamanho) {
  let texto = '';
  for (let i = 0; i < tamanho; i += 1) {
    texto += ALFABETO[crypto.randomInt(0, ALFABETO.length)];
  }
  return texto;
}

/** Código aleatório no formato 3-4-3 (usado só quando não há canal). */
function novoCodigo() {
  return `${bloco(3)}-${bloco(4)}-${bloco(3)}`;
}

/**
 * Código exclusivo e estável por canal/partida (3-4-3).
 * O mesmo canal devolve sempre o mesmo código; canais diferentes, códigos
 * diferentes — ninguém cai na call de outra partida.
 */
function codigoDoCanal(...partes) {
  const chave = partes.map(String).filter(Boolean).join(':');
  if (!chave) return novoCodigo();

  const hash = crypto.createHash('sha256').update(chave).digest();
  let indice = 0;
  const letra = () => ALFABETO[hash[indice++] % ALFABETO.length];
  const grupo = (tamanho) => Array.from({ length: tamanho }, letra).join('');
  return `${grupo(3)}-${grupo(4)}-${grupo(3)}`;
}

function provedor() {
  const escolhido = String(config.TELAGEM_PROVEDOR || 'jitsi').toLowerCase();
  return PROVEDORES[escolhido] ? escolhido : 'jitsi';
}

const nomeProvedor = () => PROVEDORES[provedor()].nome;

/** Link real do Meet configurado no ambiente (ou null). */
function linkFixo() {
  const fixo = String(config.TELAGEM_LINK || '').trim();
  return /^https:\/\/meet\.google\.com\/\S+$/i.test(fixo) ? fixo : null;
}

/** Confere se o link colado é um Meet válido e devolve ele limpo. */
function linkValido(valor) {
  const limpo = String(valor || '').trim();
  return /^https:\/\/meet\.google\.com\/[A-Za-z0-9\-_/?=&.]+$/i.test(limpo) ? limpo : null;
}

const ehMeet = (url) => /^https:\/\/meet\.google\.com\//i.test(String(url || ''));

/**
 * Link final da sala.
 * Prioridade: link informado → TELAGEM_LINK → provedor configurado.
 */
function link(codigo, { url = null, qual = null } = {}) {
  const colado = linkValido(url);
  if (colado) return colado;

  const fixo = linkFixo();
  if (fixo) return fixo;

  const escolhido = qual && PROVEDORES[qual] ? qual : provedor();
  if (escolhido === 'google') {
    // Formato oficial do Meet (o domínio é sempre meet.google.com).
    return `https://meet.google.com/${codigo}`;
  }

  // Jitsi: aceita um servidor próprio no .env, mas nunca a base do Google.
  const baseEnv = String(config.TELAGEM_URL_BASE || '').replace(/\/+$/, '');
  const base = /meet\.google\.com/i.test(baseEnv) || !baseEnv ? PROVEDORES.jitsi.base : baseEnv;
  return `${base}/${PROVEDORES.jitsi.prefixo}${codigo}`;
}

/* ─────────────────────── Pool de links reais do Meet ─────────────────────── */

/** Links válidos do .env (TELAGEM_LINKS, separados por vírgula/quebra). */
function linksDoAmbiente() {
  return String(config.TELAGEM_LINKS || '')
    .split(/[,\n;]+/)
    .map((url) => linkValido(url))
    .filter(Boolean);
}

/** Links cadastrados no painel (/telagem_links) para este servidor. */
async function linksDoBanco(db, guildId) {
  const linhas = await listarPaginado(() => cliente(db).from(TABELAS.telagem_links).select('url')
    .eq('guild_id', String(guildId)).order('criado_em').order('url'), 'ler pool de telagem');
  return linhas.map((linha) => linha.url);
}

/** Pool completo (env + banco), sem repetição e só com links válidos. */
async function pool(db, guildId) {
  return [...new Set([...linksDoAmbiente(), ...await linksDoBanco(db, guildId)])].filter(linkValido);
}

async function adicionarLink(db, guildId, url) {
  const limpo = linkValido(url);
  if (!limpo) {
    throw new Error('Link inválido. Use um link real do Meet, ex: `https://meet.google.com/abc-defg-hij`.');
  }
  await executar(cliente(db).from(TABELAS.telagem_links).upsert({
    guild_id: String(guildId), url: limpo, criado_em: Date.now(),
  }, { onConflict: 'guild_id,url', ignoreDuplicates: true }), 'adicionar link de telagem');
  return limpo;
}

async function removerLink(db, guildId, url) {
  const limpo = linkValido(url) || String(url || '').trim();
  return excluir(cliente(db).from(TABELAS.telagem_links).delete({ count: 'exact' })
    .eq('guild_id', String(guildId)).eq('url', limpo), 'remover link de telagem');
}

/** Limpa o pool do banco e devolve as salas reservadas. */
async function limparLinks(db, guildId) {
  return rpc(db, 'royal_operacional_limpar_telagem', { p_guild_id: String(guildId) });
}

/** Salas com link reservado (mostra no /telagem_links listar). */
async function atribuicoes(db, guildId) {
  return listarPaginado(() => cliente(db).from(TABELAS.telagens).select('chave,codigo,url,criado_em')
    .eq('guild_id', String(guildId)).order('criado_em').order('chave'), 'listar atribuições de telagem');
}

async function atribuicaoDoCanal(db, guildId, chave) {
  return await executar(cliente(db).from(TABELAS.telagens).select('guild_id,chave,codigo,url,criado_em')
    .eq('guild_id', String(guildId)).eq('chave', String(chave)).maybeSingle(), 'consultar telagem do canal') || null;
}

/**
 * Reserva o link de uma partida/canal.
 * • Já reservado → devolve o mesmo link (a sala é fixa).
 * • Pool com link livre → reserva e grava.
 * • Pool cheio → libera o link de uma partida já encerrada; se todas estão
 *   ativas, lança erro amigável.
 * • Pool vazio → devolve null (o comando cai no provedor padrão).
 */
async function reservar(db, guildId, chave) {
  return rpc(db, 'royal_operacional_reservar_telagem', {
    p_guild_id: String(guildId), p_chave: String(chave),
    p_codigo: codigoDoCanal(guildId, chave), p_links_ambiente: linksDoAmbiente(),
  });
}

/** Fixa um link informado no comando (também fica gravado para a partida). */
async function fixar(db, guildId, chave, url) {
  const limpo = linkValido(url);
  if (!limpo) {
    throw new Error('Link inválido. Use um link real do Meet, ex: `https://meet.google.com/abc-defg-hij`.');
  }
  return rpc(db, 'royal_operacional_fixar_telagem', {
    p_guild_id: String(guildId), p_chave: String(chave), p_url: limpo,
    p_codigo: codigoDoCanal(guildId, chave),
  });
}

/* ─────────────────────────────── Painel ──────────────────────────────────── */

/** Painel "Sala de Telagem Criada" com código, URL e botão de entrada. */
function painel(codigo = novoCodigo(), { usuarios = 0, url = null, origem = null } = {}) {
  const destino = link(codigo, { url });
  const usandoFixo = Boolean(linkFixo()) && !linkValido(url);

  let etiqueta;
  if (ehMeet(destino)) {
    if (linkValido(url) && origem === 'manual') etiqueta = 'Google Meet (link do comando)';
    else if (usandoFixo) etiqueta = 'Google Meet (link fixo do .env)';
    else etiqueta = 'Google Meet (pool oficial)';
  } else {
    etiqueta = nomeProvedor();
  }

  return {
    embeds: [
      embed(
        '✅ Sala de Telagem Criada',
        [
          'A sala para análise dos jogadores foi iniciada com sucesso.',
          '',
          `ℹ️ **Código da Sala:** \`${codigo}\``,
          `👤 **Usuários na Call:** \`${usuarios}\``,
          `📡 **Plataforma:** ${etiqueta}`,
          `🔗 **Link da sala:** ${destino}`,
          '',
          '➜ Clique no botão abaixo para entrar na call:',
        ].join('\n'),
        { cor: config.CORES.sucesso, rodape: 'ORG Royal AP · telagem' },
      ),
    ],
    components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setURL(destino).setLabel('Entrar na Call').setEmoji('🎙️').setStyle(ButtonStyle.Link),
      ),
    ],
  };
}

module.exports = {
  PROVEDORES,
  MENSAGEM_POOL,
  novoCodigo,
  codigoDoCanal,
  provedor,
  nomeProvedor,
  link,
  linkFixo,
  linkValido,
  ehMeet,
  linksDoAmbiente,
  pool,
  adicionarLink,
  removerLink,
  limparLinks,
  atribuicoes,
  atribuicaoDoCanal,
  reservar,
  fixar,
  painel,
};
