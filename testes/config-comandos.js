'use strict';

process.env.DISCORD_TOKEN ||= 'test.token.value';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const comandos = require('../src/comandos');
const configComandos = require('../src/comandos/configComandos');
const permissions = require('../src/servicos/permissoesComandos');
const eventos = require('../src/eventos');
const { MessageFlags } = require('discord.js');

const guildId = '12345678901234567';
const userId = '22345678901234567';
const roleId = '32345678901234567';
const roleId2 = '42345678901234567';

function clientFake() {
  const rows = [];
  const calls = [];
  const client = {
    from(table) {
      const query = { table, filters: {} };
      query.select = () => query;
      query.eq = (column, value) => { query.filters[column] = String(value); return query; };
      query.range = (start, end) => { query.rangeValues = [start, end]; return query; };
      query.then = (resolve, reject) => Promise.resolve({
        data: rows.filter((row) => Object.entries(query.filters).every(([key, value]) => String(row[key]) === value))
          .slice(query.rangeValues?.[0] || 0, (query.rangeValues?.[1] ?? Infinity) + 1)
          .map(({ command_name, role_id }) => ({ command_name, role_id })),
        error: null,
      }).then(resolve, reject);
      return query;
    },
    async rpc(name, args) {
      calls.push([name, args]);
      if (name === 'discord_command_permissions_set_page') {
        const names = new Set(args.p_command_names);
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i].guild_id === args.p_guild_id && rows[i].role_id === args.p_role_id && names.has(rows[i].command_name)) rows.splice(i, 1);
        }
        for (const command_name of args.p_allowed_names) rows.push({ guild_id: args.p_guild_id, role_id: args.p_role_id, command_name });
      } else if (name === 'discord_command_permissions_clear_role') {
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i].guild_id === args.p_guild_id && rows[i].role_id === args.p_role_id) rows.splice(i, 1);
        }
      } else return { error: { message: 'RPC desconhecida' } };
      return { data: 1, error: null };
    },
  };
  return { client, rows, calls };
}

function interaction(overrides = {}) {
  return {
    guildId,
    commandName: 'painelrecarga',
    user: { id: userId },
    member: { permissions: { has: () => false }, roles: { cache: new Map() } },
    memberPermissions: { has: () => false },
    ...overrides,
  };
}

test('registra /configentrada_saida e /configcomandos e remove os comandos de canal antigos', () => {
  assert.ok(comandos.buscar('configcomandos'));
  assert.deepEqual(comandos.buscar('config').data.toJSON().options.map((item) => item.name), ['lojinha']);
  assert.equal(comandos.buscar('configentrada_saida').data.toJSON().default_member_permissions, '8');
  assert.equal(comandos.buscar('configcanal1'), null);
  assert.equal(comandos.buscar('configcanal2'), null);
  assert.equal(comandos.buscar('configcomandos').data.toJSON().default_member_permissions, '8');
});

test('sem regra mantém acesso nativo; regra exige um dos cargos; Administrator sempre passa', async () => {
  const fake = clientFake();
  permissions.limparCache(guildId);
  const livre = await permissions.verificarAcesso(interaction(), fake.client);
  assert.equal(livre.permitido, true);
  await permissions.salvarPagina({ guildId, roleId, commandNames: ['painelrecarga'], allowedNames: ['painelrecarga'], client: fake.client });
  const bloqueado = await permissions.verificarAcesso(interaction(), fake.client);
  assert.equal(bloqueado.permitido, false);
  assert.deepEqual(bloqueado.cargos, [roleId]);
  const autorizado = await permissions.verificarAcesso(interaction({ member: { permissions: { has: () => false }, roles: { cache: new Map([[roleId, {}]]) } } }), fake.client);
  assert.equal(autorizado.permitido, true);
  const admin = await permissions.verificarAcesso(interaction({ memberPermissions: { has: () => true } }), fake.client);
  assert.equal(admin.permitido, true);
});

test('interceptor bloqueia em privado e informa o cargo necessário', async () => {
  const fake = clientFake();
  permissions.limparCache(guildId);
  await permissions.salvarPagina({ guildId, roleId, commandNames: ['painelrecarga'], allowedNames: ['painelrecarga'], client: fake.client });
  const respostas = [];
  const i = interaction({ reply: async (payload) => { respostas.push(payload); } });
  assert.equal(await eventos.autorizarComando(i, { client: fake.client }), false);
  assert.equal(respostas.length, 1);
  assert.match(respostas[0].content, new RegExp(`<@&${roleId}>`));
  assert.equal(respostas[0].flags & MessageFlags.Ephemeral, MessageFlags.Ephemeral);
  assert.deepEqual(respostas[0].allowedMentions, { parse: [] });
});

test('painel permite voltar à seleção, configurar vários cargos em lote e limpar todos', async () => {
  const fake = clientFake();
  permissions.limparCache(guildId);
  const role = { id: roleId, name: 'Mediadores', managed: false };
  const role2 = { id: roleId2, name: 'SS Mobile', managed: false };
  const guild = { roles: { cache: new Map([[roleId, role], [roleId2, role2]]), fetch: async (id) => id === roleId ? role : role2 } };
  const base = {
    guildId, guild, user: { id: userId }, member: { permissions: { has: () => true } },
    deferred: false, replied: false, values: [roleId, roleId2],
    deferUpdate: async function () { this.deferred = true; },
    editReply: async function (payload) { this.lastEdit = payload; return payload; },
    followUp: async function (payload) { this.lastFollowUp = payload; return payload; },
    isMessageComponent: () => true,
    isRoleSelectMenu: () => true, isStringSelectMenu: () => false, isButton: () => false,
  };
  const escolherCargo = { ...base, customId: `${configComandos.PREFIXO}${userId}:role` };
  await configComandos.handleComponent(escolherCargo, { db: { client: fake.client } });
  const painel = escolherCargo.lastEdit;
  assert.match(painel.embeds[0].toJSON().description, /Nenhuma restrição configurada/);
  assert.match(painel.embeds[0].toJSON().description, /Mediadores, SS Mobile/);
  const select = painel.components[0].components[0].toJSON();
  assert.ok(select.options.length <= 25);
  assert.ok(select.custom_id.endsWith(':commands'));
  assert.equal(configComandos.menuInicial(userId).components[0].components[0].toJSON().max_values, 25);
  const botoes = painel.components[1].components.map((botao) => botao.toJSON());
  assert.equal(botoes[3].label, 'Voltar');

  const escolherComando = {
    ...base, values: [select.options[0].value], customId: select.custom_id,
    isRoleSelectMenu: () => false, isStringSelectMenu: () => true,
  };
  await configComandos.handleComponent(escolherComando, { db: { client: fake.client } });
  assert.deepEqual(fake.calls.map(([nome]) => nome), [
    'discord_command_permissions_set_page', 'discord_command_permissions_set_page',
  ]);
  assert.ok(fake.rows.some((row) => row.role_id === roleId && row.command_name === select.options[0].value));
  assert.ok(fake.rows.some((row) => row.role_id === roleId2 && row.command_name === select.options[0].value));
  assert.match(escolherComando.lastFollowUp.content, /salvas no Supabase/);
  assert.match(escolherComando.lastFollowUp.content, /2 cargo/);
  assert.ok(escolherComando.lastEdit.embeds[0].toJSON().description.includes(`/${select.options[0].value}`));
  const acessoCargo2 = await permissions.verificarAcesso(interaction({
    commandName: select.options[0].value,
    member: { permissions: { has: () => false }, roles: { cache: new Map([[roleId2, role2]]) } },
  }), fake.client);
  assert.equal(acessoCargo2.permitido, true, 'cache deve refletir a gravação em lote para o segundo cargo');

  const clearId = escolherComando.lastEdit.components[1].components[2].toJSON().custom_id;
  const limpar = {
    ...base, values: [], customId: clearId,
    isRoleSelectMenu: () => false, isStringSelectMenu: () => false, isButton: () => true,
  };
  await configComandos.handleComponent(limpar, { db: { client: fake.client } });
  assert.deepEqual(fake.calls.slice(2).map(([nome]) => nome), [
    'discord_command_permissions_clear_role', 'discord_command_permissions_clear_role',
  ]);
  assert.equal(fake.rows.some((row) => row.role_id === roleId), false);
  assert.equal(fake.rows.some((row) => row.role_id === roleId2), false);
  assert.match(limpar.lastFollowUp.content, /2 cargo\(s\)/);

  const idVoltar = botoes[3].custom_id;
  const voltar = {
    ...base, values: [], customId: idVoltar,
    isRoleSelectMenu: () => false, isStringSelectMenu: () => false, isButton: () => true,
  };
  await configComandos.handleComponent(voltar, { db: { client: fake.client } });
  assert.equal(voltar.lastEdit.embeds[0].toJSON().title, '🔐 Permissões de comandos por cargo');
  assert.equal(voltar.lastEdit.components[0].components[0].toJSON().max_values, 25);
});

test('migração cria regras por servidor/comando/cargo com RLS e operações transacionais restritas a service_role', () => {
  const sql = fs.readFileSync(require.resolve('../supabase/migrations/20261122000100_discord_command_role_permissions.sql'), 'utf8');
  assert.match(sql, /PRIMARY KEY \(guild_id, command_name, role_id\)/i);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(sql, /discord_command_permissions_set_page/);
  assert.match(sql, /discord_command_permissions_clear_role/);
  assert.match(sql, /TO service_role/i);
  const eventSource = fs.readFileSync(require.resolve('../src/eventos/index.js'), 'utf8');
  assert.match(eventSource, /permissoesComandos\.verificarAcesso/);
  assert.match(eventSource, /allowedMentions: \{ parse: \[\] \}/);
});
