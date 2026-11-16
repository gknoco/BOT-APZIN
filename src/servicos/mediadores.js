'use strict';

/**
 * Módulo de mediadores: cargos permitidos, canais do painel e modo de trabalho.
 * Tudo fica na tabela `discord_configuracoes` (por servidor), com padrões no .env.
 */

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  RoleSelectMenuBuilder,
  PermissionFlagsBits,
} = require('discord.js');
const config = require('../config');
const { obterConfig, definirConfig } = require('../db');
const { embed, mencaoCargo } = require('../util/embeds');

const LIMITE_CARGOS = 10;
const CHAVES_REMOTAS = ['cargos_mediadores', 'canal_bateponto', 'canal_configpix', 'modo_mediadores', 'limpar_fila_auto'];
const MODOS = {
  rodizio: 'Rodízio',
  fila: 'Fila',
};

const padrao = () => [config.CARGO_MEDIADOR_ID, config.CARGO_ADMIN_ID].filter(Boolean);
const lerJson = (valor) => {
  try {
    const lista = JSON.parse(valor);
    return Array.isArray(lista) ? lista.map(String).filter(Boolean) : null;
  } catch {
    return null;
  }
};

/** Cargos que atuam como mediador/ADM nas filas (banco → .env). */
async function cargos(db, guildId) {
  const doBanco = db ? lerJson(await obterConfig(db, guildId, 'cargos_mediadores', null)) : null;
  const lista = doBanco && doBanco.length ? doBanco : padrao();
  return [...new Set(lista)].slice(0, LIMITE_CARGOS);
}

async function definirCargos(db, guildId, ids) {
  const lista = [...new Set((ids || []).map(String).filter(Boolean))].slice(0, LIMITE_CARGOS);
  await definirConfig(db, guildId, 'cargos_mediadores', JSON.stringify(lista));
  return lista;
}

const canalBatePonto = async (db, guildId) => obterConfig(db, guildId, 'canal_bateponto', null);
const canalConfigPix = async (db, guildId) => obterConfig(db, guildId, 'canal_configpix', null);
const definirCanalBatePonto = async (db, guildId, id) => definirConfig(db, guildId, 'canal_bateponto', id);
const definirCanalConfigPix = async (db, guildId, id) => definirConfig(db, guildId, 'canal_configpix', id);

const modo = async (db, guildId) => {
  const salvo = String(await obterConfig(db, guildId, 'modo_mediadores', 'rodizio') || 'rodizio').toLowerCase();
  return MODOS[salvo] ? salvo : 'rodizio';
};
const definirModo = async (db, guildId, valor) => {
  const escolhido = MODOS[String(valor || '').toLowerCase()] ? String(valor).toLowerCase() : 'rodizio';
  await definirConfig(db, guildId, 'modo_mediadores', escolhido);
  return escolhido;
};

const limparFilaAuto = async (db, guildId) => await obterConfig(db, guildId, 'limpar_fila_auto', '0') === '1';
const definirLimparFilaAuto = async (db, guildId, ativo) =>
  definirConfig(db, guildId, 'limpar_fila_auto', ativo ? '1' : '0');

/** Compatibilidade: valida e lê a nuvem, sem copiar configurações ou criar cache. */
async function hidratarConfiguracaoRemota(db, guildId) {
  const { data, error } = await db.client.from('discord_configuracoes').select('chave,valor')
    .eq('guild_id', String(guildId)).in('chave', CHAVES_REMOTAS).limit(CHAVES_REMOTAS.length);
  if (error) throw new Error(`Não consegui ler as configurações de mediadores no Supabase: ${error.message}`);
  return Object.fromEntries((data || []).map(({ chave, valor }) => [chave, valor]));
}


/**
 * Tem algum dos CARGOS configurados para mediação?
 * Sem bypass de permissão: serve para o botão "Entrar" do plantão, onde o
 * requisito é ter o cargo de Mediador ou de ADM configurado no módulo.
 */
async function temCargoMediador(db, guildId, member) {
  const cache = member?.roles?.cache;
  if (!cache?.has) return false;
  return (await cargos(db, guildId)).some((id) => cache.has(id));
}

/** Aviso padrão quando falta o cargo configurado. */
const AVISO_CARGO =
  'Você precisa ter um dos cargos configurados no painel de mediadores (**Mediador** ou **ADM**) para usar este comando.';

/**
 * Pode usar os comandos de sala (telagem e automação Nix)?
 * Exige um dos cargos configurados; a permissão de Administrador só vale como
 * reserva enquanto nenhum cargo foi configurado no módulo.
 */
async function podeUsarSalas(db, guildId, member) {
  const ids = await cargos(db, guildId);
  if (ids.some((id) => member?.roles?.cache?.has?.(id))) return true;
  return ids.length === 0 && Boolean(member?.permissions?.has?.(PermissionFlagsBits.Administrator));
}

/** O membro pode atuar como mediador/ADM nas filas? */
async function ehMediador(db, guildId, member) {
  if (!member) return false;
  if (member.permissions?.has?.(PermissionFlagsBits.Administrator)) return true;
  const cache = member.roles?.cache;
  if (!cache?.has) return false;
  return (await cargos(db, guildId)).some((id) => cache.has(id));
}

/** Menções usadas nos avisos de partida (só mediadores e ADM). */
async function mencoes(db, guildId) {
  return [...new Set([...await cargos(db, guildId), config.CARGO_ADMIN_ID].filter(Boolean))];
}

/** Painel de configuração (/mediadores) — usado também pelos selects. */
async function painelConfig(db, guildId) {
  const [ids, fila, pix, atual, limparAuto] = await Promise.all([
    cargos(db, guildId), canalBatePonto(db, guildId), canalConfigPix(db, guildId),
    modo(db, guildId), limparFilaAuto(db, guildId),
  ]);

  const corpo = [
    'Configure como os mediadores interagem com o sistema.',
    '',
    `**Cargos de Mediador:** ${ids.length ? ids.map((id) => mencaoCargo(id)).join(', ') : '`nenhum`'}`,
    `**Painel de Fila:** ${fila ? `<#${fila}>` : '`não definido`'}`,
    `**Painel de Cadastro:** ${pix ? `<#${pix}>` : '`não definido`'}`,
    `**Limpar Fila Auto:** ${limparAuto ? 'Ativado' : 'Desativado'}`,
    `**Modo Atual:** ${MODOS[atual]}`,
    '',
    `╰ \`${MODOS[atual]}:\` o mediador entra em uma fila e é chamado na ordem.`,
  ].join('\n');

  const cargosRow = new ActionRowBuilder().addComponents(
    new RoleSelectMenuBuilder()
      .setCustomId('ap:medcargos')
      .setPlaceholder('Selecionar cargos de mediador…')
      .setMinValues(1)
      .setMaxValues(LIMITE_CARGOS),
  );
  const filaRow = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId('ap:medfila')
      .setPlaceholder('Canal do painel de fila (bate-ponto)')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
  );
  const pixRow = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder()
      .setCustomId('ap:medpix')
      .setPlaceholder('Canal do painel de cadastro (PIX)')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement),
  );
  const acoes = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ap:medlimpar').setLabel('Limpar Fila').setEmoji('🕒').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ap:medgestaopix').setLabel('Gestão PIX').setEmoji('💠').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('ap:medmodo').setLabel(`Modo: ${MODOS[atual]}`).setEmoji('🔄').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('ap:medreenviar').setLabel('Reenviar').setEmoji('📨').setStyle(ButtonStyle.Primary),
  );

  return {
    embeds: [embed('👤 Módulo de Mediadores', corpo, { cor: config.CORES.principal, rodape: 'ORG Royal AP · mediação' })],
    components: [cargosRow, filaRow, pixRow, acoes],
  };
}

module.exports = {
  MODOS,
  LIMITE_CARGOS,
  cargos,
  definirCargos,
  canalBatePonto,
  canalConfigPix,
  definirCanalBatePonto,
  definirCanalConfigPix,
  modo,
  definirModo,
  limparFilaAuto,
  definirLimparFilaAuto,
  hidratarConfiguracaoRemota,
  AVISO_CARGO,
  podeUsarSalas,
  temCargoMediador,
  ehMediador,
  mencoes,
  painelConfig,
};
