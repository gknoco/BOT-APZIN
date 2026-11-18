'use strict';

/**
 * Bate-ponto / plantão dos mediadores: fila de quem está online e apto a
 * receber partidas, com o painel institucional (Imagem 3) e a Central de
 * Pagamentos (Imagem 4) para registro do PIX individual.
 */

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const config = require('../config');
const { embed, mencao } = require('../util/embeds');

const agora = () => Date.now();
const CARGO_PLANTAO_ID = '1572560471402217603';
const CARGO_MEDIADOR_ACESSO = '1543684028719173732';

function autorizado(member) {
  return Boolean(member?.roles?.cache?.has(CARGO_MEDIADOR_ACESSO));
}

async function cargoPlantao(guild) {
  const cargo = guild?.roles?.cache?.get(CARGO_PLANTAO_ID)
    || await guild?.roles?.fetch?.(CARGO_PLANTAO_ID).catch?.(() => null);
  if (!cargo) throw new Error(`O cargo de plantão ${CARGO_PLANTAO_ID} não existe neste servidor.`);
  const bot = guild.members.me || await guild.members.fetchMe();
  if (!bot.permissions.has(PermissionFlagsBits.ManageRoles)) {
    throw new Error('O bot precisa da permissão Gerenciar Cargos para administrar o cargo de plantão.');
  }
  if (cargo.managed || bot.roles.highest.comparePositionTo(cargo) <= 0) {
    throw new Error('O cargo do bot precisa estar acima do cargo de plantão na hierarquia do Discord.');
  }
  return cargo;
}

async function adicionarCargo(guild, userId) {
  const cargo = await cargoPlantao(guild);
  const membro = await guild.members.fetch(String(userId));
  if (!membro.roles.cache.has(cargo.id)) await membro.roles.add(cargo, 'Entrada no bate-ponto de mediadores');
  return true;
}

async function removerCargo(guild, userId) {
  const cargo = await cargoPlantao(guild);
  const membro = await guild.members.fetch(String(userId));
  if (membro.roles.cache.has(cargo.id)) await membro.roles.remove(cargo, 'Saída do bate-ponto de mediadores');
  return true;
}

async function limparComCargo(guild, db) {
  const cargo = await cargoPlantao(guild);
  const membros = await guild.members.fetch();
  const alvos = [...membros.values()].filter((membro) => membro.roles.cache.has(cargo.id));
  await limpar(db, guild.id);
  const resultados = await Promise.allSettled(
    alvos.map((membro) => membro.roles.remove(cargo, 'Reset do bate-ponto de mediadores')),
  );
  const falhas = resultados.filter((resultado) => resultado.status === 'rejected');
  return { encontrados: alvos.length, removidos: resultados.length - falhas.length, falhas };
}

async function entrar(db, { guildId, userId }) {
  const { data, error } = await db.client.from('royal_plantao').upsert({
    guild_id: String(guildId), user_id: String(userId), entrou_em: agora(),
  }, { onConflict: 'guild_id,user_id', ignoreDuplicates: true }).select('user_id');
  if (error) throw new Error(`Não consegui entrar no plantão no Supabase: ${error.message}`);
  return Boolean(data?.length);
}

async function sair(db, { guildId, userId }) {
  const { count, error } = await db.client.from('royal_plantao').delete({ count: 'exact' })
    .eq('guild_id', String(guildId)).eq('user_id', String(userId));
  if (error) throw new Error(`Não consegui sair do plantão no Supabase: ${error.message}`);
  return count || 0;
}

async function listar(db, guildId) {
  const fila = [];
  const tamanho = 1000;
  for (let inicio = 0; ; inicio += tamanho) {
    const { data, error } = await db.client.from('royal_plantao')
      .select('guild_id,user_id,entrou_em')
      .eq('guild_id', String(guildId))
      .order('entrou_em', { ascending: true }).order('id', { ascending: true })
      .range(inicio, inicio + tamanho - 1);
    if (error) throw new Error(`Não consegui listar o plantão no Supabase: ${error.message}`);
    fila.push(...(data || []));
    if (!data || data.length < tamanho) return fila;
  }
}

async function total(db, guildId) {
  const { count, error } = await db.client.from('royal_plantao')
    .select('user_id', { count: 'exact', head: true }).eq('guild_id', String(guildId));
  if (error) throw new Error(`Não consegui contar o plantão no Supabase: ${error.message}`);
  return count || 0;
}

async function posicao(db, { guildId, userId }) {
  const fila = await listar(db, guildId);
  const indice = fila.findIndex((linha) => linha.user_id === String(userId));
  return indice === -1 ? null : indice + 1;
}

async function ativo(db, { guildId, userId }) {
  const { data, error } = await db.client.from('royal_plantao').select('user_id')
    .eq('guild_id', String(guildId)).eq('user_id', String(userId)).maybeSingle();
  if (error) throw new Error(`Não consegui validar o plantão no Supabase: ${error.message}`);
  return Boolean(data?.user_id);
}

async function limpar(db, guildId) {
  const { count, error } = await db.client.from('royal_plantao').delete({ count: 'exact' })
    .eq('guild_id', String(guildId));
  if (error) throw new Error(`Não consegui limpar o plantão no Supabase: ${error.message}`);
  return count || 0;
}

/** Próximo da fila (rodízio) — usado quando uma sala precisa de mediador. */
async function proximo(db, guildId) {
  const { data, error } = await db.client.from('royal_plantao').select('user_id')
    .eq('guild_id', String(guildId))
    .order('entrou_em', { ascending: true }).order('id', { ascending: true }).limit(1);
  if (error) throw new Error(`Não consegui ler o próximo mediador no Supabase: ${error.message}`);
  return data?.[0]?.user_id ?? null;
}

function componentes() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ap:plantaoentrar').setLabel('Entrar').setEmoji('✅').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('ap:plantaosair').setLabel('Sair').setEmoji('🚪').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('ap:plantaostatus').setLabel('Atualizar').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    ),
  ];
}

async function embedFila(db, guildId) {
  const fila = await listar(db, guildId);
  const corpo = [
    '**Painel exclusivo de plantão para mediadores**',
    '',
    `**Status atual:** ${fila.length} mediador(es) online`,
    fila.length
      ? fila.map((linha, indice) => `**${indice + 1}.** ${mencao(linha.user_id)}`).join('\n')
      : '⚠️ **Nenhum mediador online neste plantão.**',
    '',
    'Apenas membros com o cargo <@&1543684028719173732> podem interagir com este painel.',
  ].join('\n');

  return embed('🛡️ Plantão de Mediadores', corpo, { cor: config.CORES.principal, rodape: 'ORG Royal AP · mediação' });
}

const painel = async (db, guildId) => ({ embeds: [await embedFila(db, guildId)], components: componentes() });

/** Central de Pagamentos: Mediadores (registro individual de PIX). */
function painelRegistroPix() {
  const corpo = [
    'Bem-vindo ao sistema de remuneração. Para garantir o recebimento ágil de suas participações, mantenha seus dados PIX sempre atualizados.',
    '',
    '🏷️ **Chave PIX:** CPF, E-mail, Telefone ou Chave Aleatória',
    '👤 **Nome Completo:** Titular da conta bancária',
    '💬 **Cidade:** Cidade de registro da conta',
    '',
    '⚠️ **Importante:** Os pagamentos são processados com base nestes dados. Verifique cuidadosamente antes de salvar.',
  ].join('\n');

  const linha = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ap:pixregistrar').setLabel('Configurar Pix').setEmoji('💠').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('ap:pixverificar').setLabel('Verificar Cadastro').setEmoji('ℹ️').setStyle(ButtonStyle.Secondary),
  );

  return {
    embeds: [
      embed('💳 Central de Pagamentos: Mediadores', corpo, { cor: config.CORES.principal, rodape: 'ORG Royal AP · PIX' }),
    ],
    components: [linha],
  };
}

module.exports = {
  CARGO_PLANTAO_ID,
  CARGO_MEDIADOR_ACESSO,
  autorizado,
  cargoPlantao,
  adicionarCargo,
  removerCargo,
  limparComCargo,
  entrar,
  sair,
  listar,
  total,
  posicao,
  ativo,
  limpar,
  proximo,
  componentes,
  embedFila,
  painel,
  painelRegistroPix,
};
