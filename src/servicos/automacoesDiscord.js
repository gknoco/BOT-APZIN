'use strict';

const { EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const supabase = require('./supabase');
const versiculos = require('./versiculos');

const CHAVE_VERSICULOS = 'versiculos_auto';
const CHAVE_ANUNCIOS = 'anuncios_auto';
const FUSO = 'America/Sao_Paulo';
const SNOWFLAKE = /^\d{13,20}$/;
const HORA = /^([01]\d|2[0-3]):([0-5]\d)$/;
let timer = null;
let ultimaExecucao = new Map();

function limpar(valor) {
  return String(valor ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
}
function validarHora(valor) {
  const hora = limpar(valor);
  if (!HORA.test(hora)) throw new Error('O horário deve estar no formato HH:MM, por exemplo 08:30.');
  return hora;
}
function validarCanal(valor) {
  const canal = limpar(valor).replace(/^<#(\d+)>$/, '$1');
  if (!SNOWFLAKE.test(canal)) throw new Error('Informe um ID de canal Discord válido.');
  return canal;
}
function validarLink(valor) {
  const link = limpar(valor);
  if (!/^https?:\/\/\S+$/i.test(link) || link.length > 500) throw new Error('Informe um link http(s) válido do servidor.');
  return link;
}
function validarCanais(valor) {
  const ids = [...new Set(limpar(valor).split(',').map((id) => id.trim()).filter(Boolean))];
  if (!ids.length || ids.length > 25 || ids.some((id) => !SNOWFLAKE.test(id))) {
    throw new Error('Informe de 1 a 25 IDs de canais válidos separados por vírgula.');
  }
  return ids;
}
function agora() {
  const partes = new Intl.DateTimeFormat('en-GB', { timeZone: FUSO, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  const valores = Object.fromEntries(partes.map((p) => [p.type, p.value]));
  return `${valores.hour}:${valores.minute}`;
}
function diaAtual() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: FUSO, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function configCliente(db) { return db?.client || supabase.obterCliente(); }
async function salvarVersiculos(db, guildId, canalId, horario) {
  const valor = { canal_id: validarCanal(canalId), horario: validarHora(horario) };
  await supabase.definirConfig(guildId, CHAVE_VERSICULOS, JSON.stringify(valor), configCliente(db));
  return valor;
}
async function salvarAnuncios(db, guildId, valor) {
  const configuracao = {
    canal_principal_id: limpar(valor.canal_principal_id) ? validarCanal(valor.canal_principal_id) : null,
    link: validarLink(valor.link),
    canais_divulgacao: validarCanais(valor.canais_divulgacao),
    horario: validarHora(valor.horario),
    mensagens: {},
  };
  const anterior = await lerConfig(db, guildId, CHAVE_ANUNCIOS);
  configuracao.mensagens = anterior?.mensagens && typeof anterior.mensagens === 'object' ? anterior.mensagens : {};
  await supabase.definirConfig(guildId, CHAVE_ANUNCIOS, JSON.stringify(configuracao), configCliente(db));
  return configuracao;
}
async function lerConfig(db, guildId, chave) {
  const valor = await supabase.obterConfig(guildId, chave, configCliente(db));
  if (!valor) return null;
  try { return JSON.parse(valor); } catch { return null; }
}
async function buscarCanal(client, id, guildId) {
  const canal = client.channels.cache.get(String(id)) || await client.channels.fetch(String(id)).catch(() => null);
  if (!canal?.isTextBased?.() || typeof canal.send !== 'function') throw new Error(`Canal ${id} indisponível para envio.`);
  const guildDoCanal = String(canal.guildId || canal.guild?.id || '');
  if (!guildId || guildDoCanal !== String(guildId)) {
    throw new Error(`Canal ${id} não pertence ao servidor que salvou esta automação.`);
  }
  return canal;
}
async function enviarVersiculo(client, db, guildId, config) {
  const canal = await buscarCanal(client, config.canal_id, guildId);
  const sorteio = await versiculos.sortear({ guildId, cliente: configCliente(db) });
  const embed = new EmbedBuilder().setColor(0xfacc15).setTitle('📿 Versículo do Dia')
    .setDescription(`*"${sorteio.versiculo.texto}"*\n\n**— ${sorteio.versiculo.referencia}**`)
    .setFooter({ text: 'ORG Royal AP · publicação automática' });
  await canal.send({ embeds: [embed], allowedMentions: { parse: [] } });
}
async function apagarMensagemAnterior(client, guildId, canalId, mensagemId) {
  if (!mensagemId) return;
  const canal = await buscarCanal(client, canalId, guildId).catch(() => null);
  if (!canal?.messages?.fetch) return;
  const mensagem = await canal.messages.fetch(String(mensagemId)).catch(() => null);
  if (mensagem?.delete) await mensagem.delete().catch(() => {});
}
async function enviarAnuncios(client, db, guildId, config) {
  const mensagens = { ...(config.mensagens || {}) };
  const canais = [...new Set([config.canal_principal_id, ...(config.canais_divulgacao || [])].filter(Boolean))];
  for (const canalId of canais) {
    await apagarMensagemAnterior(client, guildId, canalId, mensagens[canalId]);
    const canal = await buscarCanal(client, canalId, guildId);
    const mensagem = await canal.send({ content: config.link, allowedMentions: { parse: [] } });
    mensagens[canalId] = mensagem.id;
  }
  config.mensagens = mensagens;
  await supabase.definirConfig(guildId, CHAVE_ANUNCIOS, JSON.stringify(config), configCliente(db));
}
async function executarPendentes(client, db, force = false) {
  const horario = agora();
  const dia = diaAtual();
  for (const guild of client.guilds.cache.values()) {
    const versiculo = await lerConfig(db, guild.id, CHAVE_VERSICULOS);
    if (versiculo?.horario === horario && (force || ultimaExecucao.get(`${guild.id}:v:${dia}:${horario}`) !== horario)) {
      try { await enviarVersiculo(client, db, guild.id, versiculo); ultimaExecucao.set(`${guild.id}:v:${dia}:${horario}`, horario); }
      catch (erro) { console.error(`[auto-versiculos] ${guild.id}:`, erro.message); }
    }
    const anuncio = await lerConfig(db, guild.id, CHAVE_ANUNCIOS);
    if (anuncio?.horario === horario && (force || ultimaExecucao.get(`${guild.id}:a:${dia}:${horario}`) !== horario)) {
      try { await enviarAnuncios(client, db, guild.id, anuncio); ultimaExecucao.set(`${guild.id}:a:${dia}:${horario}`, horario); }
      catch (erro) { console.error(`[auto-anuncios] ${guild.id}:`, erro.message); }
    }
  }
  // Mantém somente as chaves recentes para o processo não crescer indefinidamente.
  if (ultimaExecucao.size > 500) ultimaExecucao = new Map([...ultimaExecucao].slice(-250));
}
function iniciar(client, db) {
  if (timer) return timer;
  timer = setInterval(() => executarPendentes(client, db).catch((erro) => console.error('[automacoes]', erro.message)), 30_000);
  timer.unref?.();
  executarPendentes(client, db).catch((erro) => console.error('[automacoes]', erro.message));
  return timer;
}
function parar() { if (timer) clearInterval(timer); timer = null; }
function ehAdmin(interaction) { return Boolean(interaction.memberPermissions?.has?.(PermissionFlagsBits.Administrator)); }

module.exports = {
  CHAVE_VERSICULOS, CHAVE_ANUNCIOS, validarHora, validarCanal, validarCanais,
  salvarVersiculos, salvarAnuncios, lerConfig, buscarCanal, executarPendentes, iniciar, parar, ehAdmin,
};
