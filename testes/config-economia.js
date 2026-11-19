'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { MessageFlags, ChannelType } = require('discord.js');
const base = require('../src/servicos/supabase');
const modulo = require('../src/comandos/configEconomia');
const registro = require('../src/comandos');
const antigos = { obterCliente: base.obterCliente, obterConfig: base.obterConfig, definirConfig: base.definirConfig };
const G = '111111111111111111';
const OUTRO_G = '222222222222222222';
const U = '333333333333333333';
const OUTRO_U = '444444444444444444';
const C = '555555555555555555';
const ROLE = '666666666666666666';
let db;
let configs;
let chamadas;
let falhas;
let antesExecucao;

class Query {
  constructor(tabela) { this.tabela = tabela; this.filtros = []; this.op = 'read'; this.inicio = 0; this.fim = Infinity; }
  select(colunas) { this.colunas = colunas; return this; }
  eq(campo, valor) { this.filtros.push([campo, valor]); return this; }
  is(campo, valor) { return this.eq(campo, valor); }
  order(campo) { this.ordem = campo; return this; }
  range(inicio, fim) { this.inicio = inicio; this.fim = fim; return this; }
  limit(n) { this.inicio = 0; this.fim = n - 1; return this; }
  insert(valor) { this.op = 'insert'; this.valor = valor; return this; }
  update(valor) { this.op = 'update'; this.valor = valor; return this; }
  async single() { return this.executar(true); }
  async maybeSingle() { return this.executar(true); }
  then(resolve, reject) { return this.executar(false).then(resolve, reject); }
  async executar(um) {
    chamadas.push({ tabela: this.tabela, op: this.op, filtros: [...this.filtros], valor: this.valor });
    if (antesExecucao) await antesExecucao(this);
    const falha = falhas(this);
    if (falha) return { data: null, error: typeof falha === 'object' ? falha : { message: 'service-role segredo não deve aparecer', code: '23514' } };
    const tabela = db[this.tabela] ||= [];
    if (this.op === 'insert') {
      const row = { ...this.valor };
      if (this.tabela !== 'royal_audit_events') {
        row.id ||= randomUUID();
        if (this.tabela === 'royal_shop_items') row.updated_at ||= '2026-01-01T00:00:00.000Z';
      }
      tabela.push(row);
      return { data: this.colunas ? { ...row } : null, error: null };
    }
    let rows = tabela.filter((r) => this.filtros.every(([k, v]) => r[k] === v));
    if (this.op === 'update') {
      rows.forEach((r) => Object.assign(r, this.valor));
    }
    if (this.ordem) rows.sort((a, b) => String(a[this.ordem]).localeCompare(String(b[this.ordem])));
    rows = rows.slice(this.inicio, this.fim + 1).map((r) => ({ ...r }));
    return { data: um ? rows[0] || null : rows, error: null };
  }
}
function iniciar() {
  db = { royal_shop_items: [], royal_roulette_prizes: [], royal_audit_events: [], royal_roulette_spins: [], royal_purchases: [], royal_inventory: [] };
  configs = new Map(); chamadas = []; falhas = () => false; antesExecucao = null;
  base.obterCliente = () => ({ from: (tabela) => new Query(tabela) });
  base.obterConfig = async (g, chave) => configs.get(`${g}:${chave}`) ?? null;
  base.definirConfig = async (g, chave, valor) => { configs.set(`${g}:${chave}`, valor); };
}
after(() => Object.assign(base, antigos));

function interacao({ dom = 'r', acao = 'criar', tipo = 'button', user = U, owner = U, guild = G, originalGuild = G, admin = true, fields = {}, extra, options = 'roleta' } = {}) {
  const eventos = [];
  const i = {
    id: '777777777777777777', guildId: guild, user: { id: user },
    customId: `configeco:${owner}:${originalGuild}:${dom}:${acao}${extra === undefined ? '' : `:${extra}`}`,
    guild: {
      id: guild,
      roles: { cache: new Map([[ROLE, { id: ROLE, guild: { id: guild }, editable: true }]]) },
      channels: { cache: new Map([[C, { id: C, guildId: guild, type: ChannelType.GuildText }]]) },
    },
    member: { permissions: { has: () => admin }, roles: { cache: new Map() } },
    fields: { getTextInputValue: (id) => fields[id] ?? '' },
    options: { getSubcommand: () => options },
    isButton: () => tipo === 'button', isModalSubmit: () => tipo === 'modal',
    isMessageComponent: () => tipo === 'button',
    async deferReply(arg) { eventos.push(['deferReply', arg]); this.deferred = true; },
    async showModal(m) { eventos.push(['showModal', m.toJSON()]); this.replied = true; },
    async reply(arg) { eventos.push(['reply', arg]); this.replied = true; },
    async editReply(arg) { eventos.push(['editReply', arg]); },
    async followUp(arg) { eventos.push(['followUp', arg]); },
    eventos,
  };
  return i;
}
function texto(i) { return i.eventos.map((x) => x[1]?.content || '').join('\n'); }
async function submeter(dom, acao, fields, extra = {}) {
  const i = interacao({ dom, acao: `m-${acao}`, tipo: 'modal', fields, ...extra });
  assert.equal(await modulo.handleComponent(i), true);
  return i;
}
const premio = (overrides = {}) => ({ id: randomUUID(), guild_id: G, name: 'Prêmio', reward_type: 'coins', reward_value: '50', weight: 10, active: true, ...overrides });
const produto = (overrides = {}) => ({ id: randomUUID(), guild_id: G, slug: 'produto', name: 'Produto', description: 'Descrição', price: 100, reward_type: 'spins', reward_value: '1', stock: 5, metadata: {}, active: true, updated_at: '2026-01-01T00:00:00.000Z', ...overrides });
const fieldsR = (overrides = {}) => ({ nome: 'Prêmio', tipo: 'coins', valor: '50', peso: '10', ...overrides });
const fieldsL = (overrides = {}) => ({ slug: 'produto', nome: 'Produto', recompensa: 'spins|1', preco: '100', estoque: '5|livre|Descrição', ...overrides });

test('/configroleta mantém o painel completo privado, e /config mantém somente lojinha', async () => {
  iniciar();
  const def = modulo.comando.data.toJSON();
  assert.equal(def.name, 'config');
  assert.deepEqual(def.options.map((x) => x.name), ['lojinha']);
  const i = interacao({ tipo: 'slash' });
  i.commandName = 'configroleta';
  i.options.getSubcommand = () => { throw new Error('/configroleta não tem subcomandos'); };
  await registro.executar(i, {});
  assert.deepEqual(i.eventos.map((e) => e[0]), ['deferReply', 'editReply']);
  assert.ok((i.eventos[0][1].flags & MessageFlags.Ephemeral) !== 0);
  assert.match(texto(i), /dependem da migração/);
  const rows = i.eventos[1][1].components.map((r) => r.toJSON());
  const botoes = rows.flatMap((r) => r.components);
  assert.deepEqual(botoes.map((b) => b.custom_id), [
    'lista:0', 'criar', 'editar', 'estado', 'config', 'estoque', 'giros', 'excluir',
  ].map((acao) => `configeco:${U}:${G}:r:${acao}`));
  for (const botao of botoes) {
    const clique = interacao();
    clique.customId = botao.custom_id;
    await modulo.handleComponent(clique);
    assert.equal(clique.eventos[0][0], botao.custom_id.endsWith(':lista:0') ? 'deferReply' : 'showModal');
  }
  const loja = interacao({ tipo: 'slash', options: 'lojinha' });
  await modulo.comando.executar(loja);
  assert.match(texto(loja), /Configuração · Lojinha/);
  assert.ok((loja.eventos[0][1].flags & MessageFlags.Ephemeral) !== 0);
  const antigo = interacao({ tipo: 'slash', options: 'roleta' });
  await modulo.comando.executar(antigo);
  assert.match(texto(antigo), /Subcomando inválido.*\/configroleta/);
  assert.equal(antigo.eventos[0][1].components.length, 0);
  const naoAdmin = interacao({ tipo: 'slash', admin: false });
  await registro.buscar('configroleta').executar(naoAdmin);
  assert.match(JSON.stringify(naoAdmin.eventos), /Somente administradores/);
  const dm = interacao({ tipo: 'slash', guild: '' });
  await registro.buscar('configroleta').executar(dm);
  assert.match(texto(dm), /servidor válido/);
  const lojaNaoAdmin = interacao({ tipo: 'slash', options: 'lojinha', admin: false });
  await modulo.comando.executar(lojaNaoAdmin);
  assert.match(JSON.stringify(lojaNaoAdmin.eventos), /Somente administradores/);
});

test('modal abre como primeira resposta; revalida dono, servidor e admin; demais prefixos são ignorados', async () => {
  iniciar();
  for (const [dom, acao] of [['r', 'criar'], ['r', 'editar'], ['r', 'estado'], ['r', 'estoque'], ['l', 'criar'], ['l', 'editar'], ['l', 'config']]) {
    const i = interacao({ dom, acao });
    await modulo.handleComponent(i);
    assert.equal(i.eventos.length, 1);
    assert.equal(i.eventos[0][0], 'showModal');
    assert.ok(i.eventos[0][1].custom_id.startsWith(`configeco:${U}:${G}:${dom}:m-`));
    assert.ok(i.eventos[0][1].components.length <= 5);
  }
  for (const extra of [{ user: OUTRO_U }, { admin: false }, { guild: OUTRO_G }, { guild: '' }]) {
    const i = interacao(extra);
    await modulo.handleComponent(i);
    assert.equal(i.eventos[0][0], 'reply');
    assert.ok((i.eventos[0][1].flags & MessageFlags.Ephemeral) !== 0);
    assert.equal(i.eventos.some((e) => e[0] === 'showModal'), false);
  }
  const i = interacao(); i.customId = 'outro:teste';
  assert.equal(await modulo.handleComponent(i), false);
  assert.equal(chamadas.length, 0);
});

test('modal submetido responde deferReply efêmero imediatamente, inclusive se admin revogado', async () => {
  iniciar();
  const i = await submeter('r', 'criar', fieldsR(), { admin: false });
  assert.deepEqual(i.eventos.map((e) => e[0]), ['deferReply', 'editReply']);
  assert.equal(i.eventos[0][1].flags, MessageFlags.Ephemeral);
  assert.match(texto(i), /Somente administradores/);
  assert.equal(chamadas.length, 0);
  const roubado = await submeter('r', 'criar', fieldsR(), { user: OUTRO_U });
  assert.deepEqual(roubado.eventos.map((e) => e[0]), ['deferReply', 'editReply']);
  assert.equal(chamadas.length, 0);
});

test('criação e edição de prêmio aplicam escopo, validam peso e gravam auditoria antes/depois', async () => {
  iniciar();
  const i = await submeter('r', 'criar', fieldsR());
  assert.match(texto(i), /Alteração salva/);
  assert.equal(db.royal_roulette_prizes.length, 1);
  const registro = db.royal_roulette_prizes[0];
  assert.equal(registro.guild_id, G); assert.equal(registro.weight, 10);
  assert.deepEqual(db.royal_audit_events.map((a) => a.action), ['config_economia.criar.intent', 'config_economia.criar.complete']);
  assert.equal(db.royal_audit_events[1].entity_id, registro.id);
  assert.ok(chamadas.findIndex((c) => c.tabela === 'royal_audit_events') < chamadas.findIndex((c) => c.tabela === 'royal_roulette_prizes' && c.op === 'insert'));
  const edit = await submeter('r', 'editar', fieldsR({ id: registro.id, nome: 'Novo', peso: '15' }));
  assert.match(texto(edit), /Alteração salva/);
  assert.equal(registro.name, 'Novo'); assert.equal(registro.weight, 15);
  const update = chamadas.find((c) => c.op === 'update');
  assert.ok(update.filtros.some(([k, v]) => k === 'guild_id' && v === G));
  assert.ok(update.filtros.some(([k, v]) => k === 'id' && v === registro.id));
  assert.ok(db.royal_audit_events.at(-1).before_data.name === 'Prêmio');
});

test('IDs de outros servidores e formulários inválidos não alteram tabelas', async () => {
  iniciar();
  const externo = premio({ guild_id: OUTRO_G }); db.royal_roulette_prizes.push(externo);
  const i = await submeter('r', 'editar', fieldsR({ id: externo.id, nome: 'Invasão' }));
  assert.match(texto(i), /não encontrado neste servidor/); assert.equal(externo.name, 'Prêmio');
  for (const fields of [fieldsR({ peso: '0' }), fieldsR({ peso: '1000001' }), fieldsR({ valor: '-1' }), fieldsR({ tipo: 'nada' }), fieldsR({ valor: '1e9' }), fieldsR({ valor: '1000000001' })]) {
    const falha = await submeter('r', 'criar', fields);
    assert.doesNotMatch(texto(falha), /Alteração salva/);
  }
  assert.equal(db.royal_roulette_prizes.length, 1);
});

test('limita soma de pesos para o integer usado pela RPC', async () => {
  iniciar();
  db.royal_roulette_prizes.push(premio({ weight: 2147483640 }));
  const i = await submeter('r', 'criar', fieldsR({ peso: '10' }));
  assert.match(texto(i), /soma dos pesos/);
  assert.equal(db.royal_roulette_prizes.length, 1);
});

test('produto: criar/editar, estoque livre, slug e descrição validados', async () => {
  iniciar();
  const criado = await submeter('l', 'criar', fieldsL({ estoque: 'livre|2|Entrega manual' }));
  assert.match(texto(criado), /Alteração salva/);
  const item = db.royal_shop_items[0]; assert.equal(item.stock, null); assert.equal(item.price, 100); assert.equal(item.metadata.max_per_user, 2);
  item.metadata.outros = 'preservar';
  const editado = await submeter('l', 'editar', fieldsL({ id: item.id, preco: '250', estoque: '0|livre|Sem estoque' }));
  assert.match(texto(editado), /Alteração salva/); assert.equal(item.stock, 0); assert.equal(item.price, 250); assert.deepEqual(item.metadata, { outros: 'preservar' });
  for (const fields of [fieldsL({ slug: 'errado x' }), fieldsL({ preco: '0' }), fieldsL({ estoque: '-1|livre|x' }), fieldsL({ estoque: '1|0|x' }), fieldsL({ estoque: '1|1000001|x' }), fieldsL({ recompensa: 'pix|chave-secreta' }), fieldsL({ recompensa: 'spins|1.5' }), fieldsL({ recompensa: 'shop_item|teste' })]) {
    const i = await submeter('l', 'criar', fields);
    assert.doesNotMatch(texto(i), /Alteração salva/);
  }
  assert.equal(db.royal_shop_items.length, 1);
});

test('referências ativas de loja são verificadas no servidor e impedem desativação', async () => {
  iniciar();
  const item = produto(); db.royal_shop_items.push(item);
  const criado = await submeter('r', 'criar', fieldsR({ tipo: 'shop_item', valor: item.id }));
  assert.match(texto(criado), /Alteração salva/);
  const bloquear = await submeter('l', 'estado', { id: item.id, estado: 'inativo' });
  assert.match(texto(bloquear), /prêmio ativo/); assert.equal(item.active, true);
  const premioId = db.royal_roulette_prizes[0].id;
  await submeter('r', 'estado', { id: premioId, estado: 'inativo' });
  const desativar = await submeter('l', 'estado', { id: item.id, estado: 'inativo' });
  assert.match(texto(desativar), /Alteração salva/); assert.equal(item.active, false);
  const reativarPremio = await submeter('r', 'estado', { id: premioId, estado: 'ativo' });
  assert.match(texto(reativarPremio), /deve estar ativo/);
  await submeter('l', 'estado', { id: item.id, estado: 'ativo' });
  await submeter('r', 'estado', { id: premioId, estado: 'ativo' });
  assert.equal(item.active, true); assert.equal(db.royal_roulette_prizes[0].active, true);
  assert.equal(chamadas.some((c) => c.op === 'delete'), false);
  const estrangeiro = produto({ guild_id: OUTRO_G }); db.royal_shop_items.push(estrangeiro);
  const invalido = await submeter('r', 'criar', fieldsR({ tipo: 'shop_item', valor: estrangeiro.id }));
  assert.match(texto(invalido), /não encontrado neste servidor/);
});

test('histórico impede modificar identidade e recompensa; peso, preço e estoque permanecem editáveis', async () => {
  iniciar();
  const p = premio(); const item = produto(); db.royal_roulette_prizes.push(p); db.royal_shop_items.push(item);
  db.royal_roulette_spins.push({ id: randomUUID(), guild_id: G, prize_id: p.id });
  db.royal_purchases.push({ id: randomUUID(), guild_id: G, item_id: item.id });
  const b1 = await submeter('r', 'editar', fieldsR({ id: p.id, valor: '100' }));
  assert.match(texto(b1), /possui histórico/); assert.equal(p.reward_value, '50');
  const b2 = await submeter('l', 'editar', fieldsL({ id: item.id, nome: 'Outra coisa' }));
  assert.match(texto(b2), /possui histórico/); assert.equal(item.name, 'Produto');
  await submeter('r', 'editar', fieldsR({ id: p.id, peso: '99' }));
  await submeter('l', 'editar', fieldsL({ id: item.id, preco: '101', estoque: '4|livre|Descrição' }));
  assert.equal(p.weight, 99); assert.equal(item.price, 101); assert.equal(item.stock, 4);
});

test('tipo PIX aceita apenas quantia; cargo deve pertencer ao servidor', async () => {
  iniciar();
  const pix = await submeter('r', 'criar', fieldsR({ tipo: 'pix', valor: '5,5' }));
  assert.match(texto(pix), /Alteração salva/); assert.equal(db.royal_roulette_prizes[0].reward_value, '5.50');
  const cargo = await submeter('l', 'criar', fieldsL({ recompensa: `role|${ROLE}` }));
  assert.match(texto(cargo), /Alteração salva/);
  const falso = await submeter('r', 'criar', fieldsR({ tipo: 'role', valor: OUTRO_U }));
  assert.match(texto(falso), /Cargo inexistente/);
  const chave = await submeter('r', 'criar', fieldsR({ tipo: 'pix', valor: 'segredo@exemplo.com' }));
  assert.match(texto(chave), /não informe chave PIX/);
  assert.doesNotMatch(texto(chave), /segredo@exemplo.com/);
});

test('admin é alertado sobre item que pode gerar lucro em coins', async () => {
  iniciar();
  const i = await submeter('l', 'criar', fieldsL({ recompensa: 'coins|200', preco: '100', estoque: 'livre|livre|Coins' }));
  assert.match(texto(i), /compras repetidas podem criar saldo/);
});

test('configurações são auditadas e salvas com as chaves de contrato e sem prometer execução', async () => {
  iniciar();
  const i = await submeter('r', 'config', { canal: `<#${C}>`, opcao: '60' });
  assert.match(texto(i), /depende da migração/);
  assert.equal(configs.get(`${G}:roleta_canal`), C);
  assert.equal(configs.get(`${G}:roleta_cooldown_segundos`), '60');
  assert.equal(db.royal_audit_events.length, 4);
  const loja = await submeter('l', 'config', { canal: C, opcao: 'Procure a staff' });
  assert.match(texto(loja), /lojinha_instrucoes/);
  assert.equal(configs.get(`${G}:lojinha_canal`), C);
  assert.equal(configs.get(`${G}:lojinha_instrucoes`), 'Procure a staff');
  const ruim = await submeter('r', 'config', { canal: OUTRO_U, opcao: '999999' });
  assert.doesNotMatch(texto(ruim), /Salvo:/);
  assert.equal(configs.get(`${G}:roleta_cooldown_segundos`), '60');
});

test('falha da auditoria anterior impede mutação; falha posterior informa sucesso parcial sem vazar erro', async () => {
  iniciar(); falhas = (q) => q.tabela === 'royal_audit_events';
  const antes = await submeter('r', 'criar', fieldsR());
  assert.equal(db.royal_roulette_prizes.length, 0);
  assert.doesNotMatch(texto(antes), /segredo|service-role/);
  iniciar(); falhas = (q) => q.tabela === 'royal_audit_events' && String(q.valor.action).endsWith('.complete');
  const depois = await submeter('r', 'criar', fieldsR());
  assert.equal(db.royal_roulette_prizes.length, 1);
  assert.match(texto(depois), /alteração foi salva.*auditoria/s);
  assert.equal(db.royal_audit_events.length, 1);
});

test('falha ao gravar, inclusive PIX antes da migração, não é exposta como segredo', async () => {
  iniciar(); falhas = (q) => q.tabela === 'royal_roulette_prizes' && q.op === 'insert';
  const i = await submeter('r', 'criar', fieldsR({ tipo: 'pix', valor: '5.00' }));
  assert.match(texto(i), /Não foi possível concluir/);
  assert.doesNotMatch(texto(i), /segredo|service-role/);
  assert.equal(db.royal_roulette_prizes.length, 0);
});

test('concorrência de estoque provoca conflito e não sobrescreve a compra', async () => {
  iniciar();
  const item = produto(); db.royal_shop_items.push(item);
  antesExecucao = async (q) => { if (q.tabela === 'royal_shop_items' && q.op === 'update') { item.stock = 4; antesExecucao = null; } };
  const i = await submeter('l', 'editar', fieldsL({ id: item.id, estoque: '10|livre|Descrição' }));
  assert.match(texto(i), /mudou durante a operação/); assert.equal(item.stock, 4);
});

test('estoque de prêmio usa a coluna migrada, preserva escopo e protege contra giro concorrente', async () => {
  iniciar();
  const p = premio({ stock: null }); db.royal_roulette_prizes.push(p);
  const i = await submeter('r', 'estoque', { id: p.id, estoque: '10' });
  assert.match(texto(i), /Estoque do prêmio salvo/); assert.equal(p.stock, 10);
  const alteracao = chamadas.find((c) => c.tabela === 'royal_roulette_prizes' && c.op === 'update');
  assert.ok(alteracao.filtros.some(([k, v]) => k === 'guild_id' && v === G));
  assert.ok(alteracao.filtros.some(([k, v]) => k === 'stock' && v === null));
  antesExecucao = async (q) => { if (q.tabela === 'royal_roulette_prizes' && q.op === 'update') { p.stock = 9; antesExecucao = null; } };
  const conflito = await submeter('r', 'estoque', { id: p.id, estoque: '20' });
  assert.match(texto(conflito), /estoque mudou/); assert.equal(p.stock, 9);
});

test('sem a coluna migrada, listagem antiga funciona e o estoque mostra orientação', async () => {
  iniciar();
  const p = premio(); db.royal_roulette_prizes.push(p);
  falhas = (q) => q.tabela === 'royal_roulette_prizes' && q.colunas?.includes(',stock')
    ? { code: '42703', message: 'column stock does not exist' } : false;
  const lista = interacao({ dom: 'r', acao: 'lista', extra: 0 });
  await modulo.handleComponent(lista);
  assert.match(texto(lista), /Prêmio/);
  const estoque = await submeter('r', 'estoque', { id: p.id, estoque: '1' });
  assert.match(texto(estoque), /exige a migração/);
  assert.equal(db.royal_audit_events.length, 0);
});

test('listagem é efêmera, paginada e filtrada por guild; nenhum dado remoto aparece', async () => {
  iniciar();
  for (let n = 0; n < 5; n++) db.royal_shop_items.push(produto({ id: `00000000-0000-0000-0000-00000000000${n}` }));
  db.royal_shop_items.push(produto({ guild_id: OUTRO_G, name: 'segredo externo' }));
  const i = interacao({ dom: 'l', acao: 'lista', extra: 0 });
  await modulo.handleComponent(i);
  assert.equal(i.eventos[0][0], 'deferReply'); assert.match(texto(i), /página 1/);
  assert.doesNotMatch(texto(i), /segredo externo/);
  const navegacao = i.eventos[1][1].components[0].toJSON().components;
  assert.ok(navegacao.some((b) => b.custom_id.endsWith(':lista:1')));
  const segunda = interacao({ dom: 'l', acao: 'lista', extra: 1 });
  await modulo.handleComponent(segunda); assert.match(texto(segunda), /página 2/);
  assert.ok(texto(i).length <= 2000);
});


test('opções explicam canal, republicação e cooldown sem sugerir integração ausente', async () => {
  iniciar();
  for (const sub of ['roleta', 'lojinha']) {
    const i = interacao({ tipo: 'slash', options: sub });
    await (sub === 'roleta' ? registro.buscar('configroleta') : modulo.comando).executar(i);
    assert.match(texto(i), /canal configurado/i);
    assert.match(texto(i), /republique/i);
    assert.doesNotMatch(texto(i), /depend.*integração no fluxo/i);
    if (sub === 'roleta') {
      assert.match(texto(i), /cooldown padrão é 3 segundos \(0 desativa\)/i);
      assert.match(texto(i), /duração da animação \(3 a 20 segundos; padrão 8\)/i);
    }
    else assert.match(texto(i), /limite por comprador depende da migração/i);
  }
  const modal = interacao({ dom: 'r', acao: 'config' });
  await modulo.handleComponent(modal);
  const placeholder = modal.eventos[0][1].components[1].components[0].placeholder;
  assert.match(placeholder, /padrão 3, 0 desativa/);
  assert.doesNotMatch(placeholder, /ainda não aplicado/);
  const duracao = modal.eventos[0][1].components[2].components[0];
  assert.match(duracao.label, /Duração do giro em segundos/);
  assert.match(duracao.placeholder, /3 a 20 segundos; padrão 8/);
  const duracaoSalva = await submeter('r', 'config', { duracao: '12' });
  assert.match(texto(duracaoSalva), /Salvo: roleta_duracao_segundos/);
  assert.equal(configs.get(`${G}:roleta_duracao_segundos`), '12');
  for (const valor of ['2', '21', '3.5', '-1', 'abc']) {
    const invalida = await submeter('r', 'config', { duracao: valor });
    assert.match(texto(invalida), ['2', '21'].includes(valor)
      ? /Duração da roleta: permitido de 3 a 20/
      : /Duração da roleta: use um número inteiro não negativo/);
  }
  const salvo = await submeter('l', 'config', { canal: C, opcao: 'Orientação' });
  assert.match(texto(salvo), /exigem republicar/i);
  assert.doesNotMatch(texto(salvo), /integração no fluxo/i);
});

test('salvamento parcial de configuração indica apenas o que foi persistido', async () => {
  iniciar(); const definir = base.definirConfig;
  base.definirConfig = async (g, chave, valor) => {
    if (chave === 'lojinha_instrucoes') throw new Error('falha de persistência');
    await definir(g, chave, valor);
  };
  try {
    const i = await submeter('l', 'config', { canal: C, opcao: 'orientação' });
    assert.match(texto(i), /Salvo: lojinha_canal/);
    assert.match(texto(i), /Não foi possível salvar as demais alterações/);
    assert.match(texto(i), /republicar o painel/);
    assert.equal(configs.get(`${G}:lojinha_canal`), C);
    assert.equal(configs.has(`${G}:lojinha_instrucoes`), false);
  } finally { base.definirConfig = definir; }
});
