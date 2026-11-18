'use strict';

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const config = require('../config');
const { embed, mencao } = require('../util/embeds');

const MODALIDADES = {
  ss_mobile: {
    label: 'SS Mobile',
    cargoAcesso: '1543684008037326849',
    cargoPlantao: '1572608936110989404',
    prefixo: 'ssmobile',
    tabela: 'royal_plantao_modalidades',
  },
  ss_emu: {
    label: 'SS EMU',
    cargoAcesso: '1543683966203207770',
    cargoPlantao: '1572610855290544288',
    prefixo: 'ssemu',
    tabela: 'royal_plantao_modalidades',
  },
};

function obterModalidade(nome) {
  const modalidade = MODALIDADES[nome];
  if (!modalidade) throw new Error(`Modalidade de plantão inválida: ${nome}`);
  return modalidade;
}

function autorizado(member, nome) {
  return Boolean(member?.roles?.cache?.has(obterModalidade(nome).cargoAcesso));
}

async function validarCargo(guild, nome) {
  const modalidade = obterModalidade(nome);
  const cargo = guild?.roles?.cache?.get(modalidade.cargoPlantao)
    || await guild?.roles?.fetch?.(modalidade.cargoPlantao).catch?.(() => null);
  if (!cargo) throw new Error(`O cargo de plantão ${modalidade.label} não existe neste servidor.`);
  const bot = guild.members.me || await guild.members.fetchMe();
  if (!bot.permissions.has(PermissionFlagsBits.ManageRoles)) {
    throw new Error('O bot precisa da permissão Gerenciar Cargos para administrar o plantão.');
  }
  if (cargo.managed || bot.roles.highest.comparePositionTo(cargo) <= 0) {
    throw new Error(`O cargo de plantão ${modalidade.label} precisa estar abaixo do cargo do bot.`);
  }
  return cargo;
}

async function adicionarCargo(guild, userId, nome) {
  const cargo = await validarCargo(guild, nome);
  const membro = await guild.members.fetch(String(userId));
  if (!membro.roles.cache.has(cargo.id)) await membro.roles.add(cargo, `Entrada no plantão ${obterModalidade(nome).label}`);
}

async function removerCargo(guild, userId, nome) {
  const cargo = await validarCargo(guild, nome);
  const membro = await guild.members.fetch(String(userId));
  if (membro.roles.cache.has(cargo.id)) await membro.roles.remove(cargo, `Saída do plantão ${obterModalidade(nome).label}`);
}

async function entrar(db, guildId, userId, nome) {
  const modalidade = obterModalidade(nome);
  const { data, error } = await db.client.from(modalidade.tabela).upsert({
    guild_id: String(guildId), user_id: String(userId), modalidade: nome, entrou_em: Date.now(),
  }, { onConflict: 'guild_id,user_id,modalidade', ignoreDuplicates: true }).select('user_id');
  if (error) throw new Error(`Não consegui entrar no plantão ${modalidade.label} no Supabase: ${error.message}`);
  return Boolean(data?.length);
}

async function sair(db, guildId, userId, nome) {
  const modalidade = obterModalidade(nome);
  const { count, error } = await db.client.from(modalidade.tabela).delete({ count: 'exact' })
    .eq('guild_id', String(guildId)).eq('user_id', String(userId)).eq('modalidade', nome);
  if (error) throw new Error(`Não consegui sair do plantão ${modalidade.label} no Supabase: ${error.message}`);
  return count || 0;
}

async function listar(db, guildId, nome) {
  const modalidade = obterModalidade(nome);
  const { data, error } = await db.client.from(modalidade.tabela)
    .select('user_id,entrou_em').eq('guild_id', String(guildId)).eq('modalidade', nome)
    .order('entrou_em', { ascending: true });
  if (error) throw new Error(`Não consegui listar o plantão ${modalidade.label}: ${error.message}`);
  return data || [];
}

async function limpar(db, guildId, nome) {
  const modalidade = obterModalidade(nome);
  const { count, error } = await db.client.from(modalidade.tabela).delete({ count: 'exact' })
    .eq('guild_id', String(guildId)).eq('modalidade', nome);
  if (error) throw new Error(`Não consegui limpar o plantão ${modalidade.label}: ${error.message}`);
  return count || 0;
}

async function limparComCargo(guild, db, nome) {
  const cargo = await validarCargo(guild, nome);
  const membros = await guild.members.fetch();
  const alvos = [...membros.values()].filter((membro) => membro.roles.cache.has(cargo.id));
  const removidosBanco = await limpar(db, guild.id, nome);
  const resultados = await Promise.allSettled(alvos.map((membro) => membro.roles.remove(cargo, `Reset do plantão ${obterModalidade(nome).label}`)));
  const falhas = resultados.filter((resultado) => resultado.status === 'rejected');
  return { banco: removidosBanco, encontrados: alvos.length, removidos: resultados.length - falhas.length, falhas };
}

function componentes(nome) {
  const modalidade = obterModalidade(nome);
  return [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ap:${modalidade.prefixo}entrar`).setLabel('Entrar').setEmoji('✅').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`ap:${modalidade.prefixo}sair`).setLabel('Sair').setEmoji('🚪').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`ap:${modalidade.prefixo}status`).setLabel('Atualizar').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
  )];
}

async function painel(db, guildId, nome) {
  const modalidade = obterModalidade(nome);
  const fila = await listar(db, guildId, nome);
  const corpo = [
    `**Painel exclusivo de plantão ${modalidade.label}**`,
    '',
    `**Status atual:** ${fila.length} mediador(es) online`,
    fila.length ? fila.map((linha, indice) => `**${indice + 1}.** ${mencao(linha.user_id)}`).join('\n') : '⚠️ **Nenhum mediador online neste plantão.**',
    '',
    `Apenas membros com o cargo <@&${modalidade.cargoAcesso}> podem interagir com este painel.`,
  ].join('\n');
  return { embeds: [embed(`🛡️ Plantão ${modalidade.label}`, corpo, { cor: config.CORES.principal, rodape: `ORG Royal AP · ${modalidade.label}` })], components: componentes(nome) };
}

module.exports = { MODALIDADES, obterModalidade, autorizado, adicionarCargo, removerCargo, entrar, sair, listar, limpar, limparComCargo, painel };
