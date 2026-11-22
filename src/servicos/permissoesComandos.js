'use strict';

const { PermissionFlagsBits } = require('discord.js');
const { ehAdmin } = require('../util/seguranca');

const TABELA = 'discord_command_role_permissions';
const PRAZO_CACHE_MS = 15000;
const cachePorGuild = new Map();

function normalizar(rows = []) {
  const porComando = new Map();
  for (const row of rows) {
    const comando = String(row.command_name || '');
    const cargo = String(row.role_id || '');
    if (!comando || !cargo) continue;
    if (!porComando.has(comando)) porComando.set(comando, new Set());
    porComando.get(comando).add(cargo);
  }
  return porComando;
}

async function carregar(guildId, client, { force = false } = {}) {
  const id = String(guildId || '');
  if (!id || !client) throw new Error('Não foi possível acessar a persistência de permissões do Supabase.');
  const atual = cachePorGuild.get(id);
  if (!force && atual && atual.expiraEm > Date.now()) return atual.porComando;
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await client.from(TABELA).select('command_name,role_id').eq('guild_id', id).range(offset, offset + 999);
    if (error) throw new Error('Não foi possível consultar as permissões de comandos no Supabase.');
    rows.push(...(data || []));
    if ((data || []).length < 1000) break;
  }
  const porComando = normalizar(rows);
  cachePorGuild.set(id, { porComando, expiraEm: Date.now() + PRAZO_CACHE_MS });
  return porComando;
}

async function regrasPorCargo(guildId, roleId, client) {
  const porComando = await carregar(guildId, client);
  const comandos = [];
  for (const [nome, cargos] of porComando) if (cargos.has(String(roleId))) comandos.push(nome);
  return comandos.sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

async function salvarPagina({ guildId, roleId, commandNames, allowedNames, client }) {
  const names = [...new Set((commandNames || []).map(String).filter(Boolean))];
  const allowed = [...new Set((allowedNames || []).map(String).filter((nome) => names.includes(nome)))];
  const { error } = await client.rpc('discord_command_permissions_set_page', {
    p_guild_id: String(guildId),
    p_role_id: String(roleId),
    p_command_names: names,
    p_allowed_names: allowed,
  });
  if (error) throw new Error('Não foi possível salvar as permissões deste cargo no Supabase.');
  await carregar(guildId, client, { force: true });
  return regrasPorCargo(guildId, roleId, client);
}

async function limparCargo(guildId, roleId, client) {
  const { error } = await client.rpc('discord_command_permissions_clear_role', {
    p_guild_id: String(guildId),
    p_role_id: String(roleId),
  });
  if (error) throw new Error('Não foi possível limpar as permissões deste cargo no Supabase.');
  await carregar(guildId, client, { force: true });
  return [];
}

async function verificarAcesso(interaction, client) {
  if (!interaction?.guildId || !interaction?.commandName) return { permitido: true, cargos: [] };
  if (ehAdmin(interaction.member) || interaction.memberPermissions?.has?.(PermissionFlagsBits.Administrator) ||
      interaction.member?.permissions?.has?.(PermissionFlagsBits.Administrator)) return { permitido: true, cargos: [] };
  const porComando = await carregar(interaction.guildId, client);
  const cargos = [...(porComando.get(String(interaction.commandName)) || new Set())];
  if (!cargos.length) return { permitido: true, cargos: [] };
  const roles = interaction.member?.roles?.cache;
  return { permitido: cargos.some((id) => roles?.has?.(id)), cargos };
}

function limparCache(guildId) {
  cachePorGuild.delete(String(guildId));
}

module.exports = { TABELA, PRAZO_CACHE_MS, carregar, regrasPorCargo, salvarPagina, limparCargo, verificarAcesso, limparCache };
