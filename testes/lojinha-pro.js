'use strict';

/** node --test testes/lojinha-pro.js — sem rede, sem Supabase remoto. */
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { PermissionFlagsBits, MessageFlags, ChannelType } = require('discord.js');
const supabase = require('../src/servicos/supabase');
const royal = require('../src/servicos/royalSupabase');
const loja = require('../src/comandos/lojinhaPro');
const avisos = require('../src/servicos/avisosEconomia');
const originalAvisar = avisos.avisarStaff;
const avisosChamados = [];
let avisoFalha = false;
avisos.avisarStaff = async (i, dados) => { avisosChamados.push({ i, ...dados }); if (avisoFalha) throw new Error('aviso indisponível'); };
after(() => { avisos.avisarStaff = originalAvisar; });

const G1 = '111111111111111111';
const G2 = '222222222222222222';
const U1 = '333333333333333333';
const U2 = '444444444444444444';
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const item = (n, extra = {}) => ({ id: uuid(n), guild_id: G1, slug: `item-${n}`, name: `Produto ${n}`,
  description: `Descrição ${n}`, price: n, active: true, stock: null, reward_type: 'pix', reward_value: '5.00', ...extra });
function dbFake() {
  avisosChamados.length = 0; avisoFalha = false;
  const db = {
    tables: {
      royal_shop_items: Array.from({ length: 30 }, (_, n) => item(n + 1)),
      royal_profiles: [
        { guild_id: G1, user_id: U1, coins: 1000, spins: 4, wins: 8, losses: 2, wos: 1 },
        { guild_id: G1, user_id: U2, coins: 500, spins: 0, wins: 1, losses: 0 },
        { guild_id: G2, user_id: U1, coins: 9000, spins: 0, wins: 50, losses: 0 },
      ], royal_inventory: [], royal_purchases: [], royal_audit_events: [], discord_configuracoes: [],
    }, calls: [], requests: new Map(), intents: new Map(), ack: () => {}, rpcError: null, configReadError: false, configWriteError: false, markError: false,
    from(tabela) {
      db.ack();
      const state = { tabela, eqs: [], gt: [], order: [], operation: 'select' };
      db.calls.push(state);
      const q = {
        select(cols, opts) { state.cols = cols; state.options = opts; return q; },
        eq(key, value) { state.eqs.push([key, value]); return q; },
        gt(key, value) { state.gt.push([key, value]); return q; },
        order(key, opts) { state.order.push([key, opts?.ascending !== false]); return q; },
        limit(n) { state.limit = n; return q; },
        range(inicio, fim) { state.range = [inicio, fim]; return q; },
        maybeSingle() { state.single = true; return q; },
        insert(values) { state.operation = 'insert'; state.values = values; return q; },
        upsert(values) { state.operation = 'upsert'; state.values = values; return q; },
        then(resolve, reject) {
          return Promise.resolve().then(() => {
            if (tabela === 'discord_configuracoes' && (state.operation === 'select'
              ? db.configReadError || state.eqs.some(([key, value]) => key === 'chave' && value === db.configReadKeyError)
              : db.configWriteError)) return { data: null, error: { message: 'indisponível' } };
            const source = db.tables[tabela] ||= [];
            if (state.operation === 'insert' || state.operation === 'upsert') {
              source.push(structuredClone(state.values)); return { data: null, error: null };
            }
            let rows = source.filter((row) => state.eqs.every(([k, v]) => row[k] === v) && state.gt.every(([k, v]) => row[k] > v));
            rows.sort((a, b) => {
              for (const [key, asc] of state.order) {
                if (a[key] !== b[key]) return (a[key] > b[key] ? 1 : -1) * (asc ? 1 : -1);
              }
              return 0;
            });
            const count = rows.length;
            if (state.range) rows = rows.slice(state.range[0], state.range[1] + 1);
            if (state.limit) rows = rows.slice(0, state.limit);
            if (['royal_inventory', 'royal_purchases'].includes(tabela)) {
              rows = rows.map((row) => ({ ...row, royal_shop_items: db.tables.royal_shop_items.find((i) => i.id === row.item_id) }));
            }
            return { data: state.single ? rows[0] || null : rows, count, error: null };
          }).then(resolve, reject);
        },
      };
      return q;
    },
    async rpc(nome, args) {
      db.ack();
      db.calls.push({ rpc: nome, args });
      if (nome === 'royal_rescue_action') {
        const purchase = db.tables.royal_purchases.find((p) => p.guild_id === args.p_guild_id && p.id === args.p_protocol);
        if (!purchase) return { data: { result: 'not_found' }, error: null };
        if (args.p_action === 'claim') {
          if (purchase.owner) return { data: { result: 'already_owned' }, error: null };
          purchase.owner = args.p_actor_id;
          return { data: { result: 'acquired', user_id: purchase.user_id, reward_type: purchase.terms_snapshot.reward_type, reward_value: purchase.terms_snapshot.reward_value }, error: null };
        }
        if (db.markError) return { data: null, error: { message: 'sem registro de entrega' } };
        purchase.status = 'delivered'; return { data: { result: 'finished' }, error: null };
      }
      if (nome === 'royal_mark_purchase_delivered') {
        if (db.markError) return { data: null, error: { message: 'sem registro de entrega' } };
        const purchase = db.tables.royal_purchases.find((p) => p.guild_id === args.p_guild_id && p.user_id === args.p_user_id && p.id === args.p_purchase_id);
        if (!purchase) return { data: null, error: { message: 'não encontrada' } };
        purchase.status = 'delivered'; return { data: true, error: null };
      }
      if (nome === 'royal_create_shop_intention') {
        const anterior = [...db.intents.values()].find((x) => x.guild === args.p_guild_id && x.source === args.p_source_id);
        if (anterior) return { data: [anterior.view], error: null };
        const produto = db.tables.royal_shop_items.find((x) => x.guild_id === args.p_guild_id && x.active && x.id === args.p_item_id);
        if (!produto) return { error: { message: 'Item indisponível' } };
        if (produto.stock !== null && produto.stock < 1) return { error: { message: 'Item sem estoque' } };
        const nonce = uuid(1000 + db.intents.size);
        const terms = { slug: produto.slug, name: produto.name, description: produto.description,
          price: String(produto.price), reward_type: produto.reward_type, reward_value: produto.reward_value, metadata: produto.metadata || {} };
        const view = { nonce, terms, stock: produto.stock };
        db.intents.set(nonce, { view, guild: args.p_guild_id, user: args.p_user_id, item: produto.id, source: args.p_source_id });
        return { data: [view], error: null };
      }
      assert.equal(nome, 'royal_confirm_shop_intention');
      if (db.rpcError) return { data: null, error: { message: db.rpcError } };
      const intent = db.intents.get(args.p_nonce);
      if (!intent || intent.guild !== args.p_guild_id || intent.user !== args.p_user_id) return { error: { message: 'Intenção inválida' } };
      if (intent.result) return { data: [{ ...intent.result, is_replay: true }], error: null };
      const produto = db.tables.royal_shop_items.find((x) => x.guild_id === intent.guild && x.active && x.id === intent.item);
      const perfil = db.tables.royal_profiles.find((x) => x.guild_id === intent.guild && x.user_id === intent.user);
      if (!produto) return { error: { message: 'Item indisponível' } };
      if (db.alterarPrecoNaRpc) produto.price = db.alterarPrecoNaRpc;
      if (String(produto.price) !== intent.view.terms.price) return { error: { message: 'O preço mudou' } };
      if (produto.reward_type !== intent.view.terms.reward_type || produto.reward_value !== intent.view.terms.reward_value || produto.name !== intent.view.terms.name || produto.description !== intent.view.terms.description) return { error: { message: 'Os termos do item mudaram' } };
      if (!perfil || perfil.coins < produto.price) return { error: { message: 'Saldo insuficiente' } };
      if (produto.stock !== null && produto.stock < 1) return { error: { message: 'Item sem estoque' } };
      perfil.coins -= produto.price;
      if (produto.stock !== null) produto.stock--;
      const status = ['pix', 'physical', 'role'].includes(produto.reward_type) ? 'pending' : 'completed';
      const purchase = { id: uuid(500 + db.tables.royal_purchases.length), guild_id: intent.guild, user_id: intent.user,
        item_id: produto.id, price: produto.price, status, terms_snapshot: structuredClone(intent.view.terms), snapshot_source: 'purchase', created_at: '2026-11-17T12:00:00Z' };
      db.tables.royal_purchases.push(purchase);
      db.tables.royal_inventory.push({ guild_id: intent.guild, user_id: intent.user, item_id: produto.id, quantity: 1 });
      intent.result = { purchase_id: purchase.id, item_name: produto.name, new_balance: perfil.coins, status, reward_type: produto.reward_type, reward_value: produto.reward_value, is_replay: false };
      if (db.afterConfirm) db.afterConfirm(purchase, produto);
      return { data: [intent.result], error: null };
    },
  };
  return db;
}
let seq = 0;
function interacao({ id, user = U1, guild = G1, customId, values, sub, chave, admin = false, roleAdd } = {}) {
  const membro = {
    permissions: { has: (p) => p === PermissionFlagsBits.Administrator && admin },
    roles: { cache: new Map(), add: async (role) => { if (roleAdd) await roleAdd(role.id); } },
  };
  const role = { id: '123456789012345678', position: 1, managed: false, editable: true };
  const i = {
    id: id || String(++seq).padStart(18, '0'), guildId: guild, channelId: '555555555555555555', user: { id: user },
    customId, values, deferred: false, replied: false, chamadas: [],
    member: membro,
    guild: { id: guild, members: { me: { permissions: { has: (p) => p === PermissionFlagsBits.ManageRoles }, roles: { highest: { position: 5 } } }, cache: new Map([[user, membro]]) }, roles: { cache: new Map([[role.id, role]]) }, channels: { cache: new Map() } },
    options: { getSubcommand: () => sub, getString: () => chave },
    async deferReply(payload) { i.chamadas.push(['defer', payload]); i.deferred = true; },
    async editReply(payload) { i.chamadas.push(['edit', payload]); i.payload = payload; },
    async followUp(payload) { i.chamadas.push(['followUp', payload]); i.payload = payload; },
    channel: { id: '555555555555555555', guildId: guild, type: ChannelType.GuildText, permissionsFor: () => ({ has: () => true }), async send(payload) { i.publico = payload; return { id: '666666666666666666' }; } },
  };
  return i;
}
function texto(i) { return JSON.stringify(i.payload?.embeds?.map((e) => e.toJSON()) || []); }
function componentes(i) { return (i.payload?.components || []).map((row) => row.toJSON()); }
async function comDb(db, i, fn) {
  const anterior = supabase.obterCliente;
  supabase.obterCliente = () => db;
  db.ack = () => assert.equal(i.deferred, true, 'deferReply deve preceder acesso ao banco');
  try { return await fn(); } finally { supabase.obterCliente = anterior; }
}
async function clicar(db, customId, opts = {}) {
  const i = interacao({ customId, ...opts });
  await comDb(db, i, () => loja.handleComponent(i));
  assert.equal(i.chamadas[0][0], 'defer'); assert.equal(i.chamadas[0][1].flags, MessageFlags.Ephemeral);
  return i;
}

async function prepararCompra(db, itemId = uuid(1), opts = {}) {
  const detalhes = await clicar(db, `lojinhapro:selecionar:${opts.user || U1}`, { ...opts, values: [itemId] });
  return componentes(detalhes)[0]?.components[0]?.custom_id;
}
async function comprar(db, itemId = uuid(1), opts = {}) {
  const botao = await prepararCompra(db, itemId, opts);
  assert.ok(botao, 'prévia deve gerar botão');
  return clicar(db, botao, opts);
}

test('contrato exportado e slash compatível', () => {
  assert.equal(typeof loja.publicarPainel, 'function'); assert.equal(typeof loja.handleComponent, 'function');
  const json = loja.comando.data.toJSON();
  assert.equal(json.name, 'lojinha');
  assert.deepEqual(json.options.map((x) => x.name), ['listar', 'comprar']);
  assert.equal(json.options.find((x) => x.name === 'comprar').options[0].name, 'item');
});

test('publicação exige ADM, envia painel público estável, salva IDs e tolera falta de banner', async () => {
  const db = dbFake();
  const nao = interacao();
  await comDb(db, nao, () => loja.publicarPainel(nao));
  assert.equal(nao.publico, undefined); assert.match(texto(nao), /Somente a administração/); assert.equal(db.calls.length, 0);
  const i = interacao({ admin: true });
  const original = fs.accessSync;
  fs.accessSync = () => { throw new Error('arquivo ausente'); };
  try { await comDb(db, i, () => loja.publicarPainel(i)); } finally { fs.accessSync = original; }
  assert.equal(i.chamadas[0][1].flags, MessageFlags.Ephemeral);
  assert.match(JSON.stringify(i.publico.embeds[0].toJSON()), /A cada WIN, você ganha 1 COIN/);
  assert.equal(i.publico.files, undefined);
  const botoes = i.publico.components[0].toJSON().components;
  assert.deepEqual(botoes.map((b) => b.label), ['Seus Royal Coins', 'Ranking', 'Seu Inventário/Resgates', 'Catálogo de Itens']);
  assert.ok(botoes.every((b) => b.custom_id.startsWith('lojinhapro:')));
  assert.deepEqual(JSON.parse(db.tables.discord_configuracoes[0].valor), { canal_id: i.channelId, mensagem_id: '666666666666666666' });
});

test('banner presente usa attachment local e URI attachment', async () => {
  const db = dbFake(), i = interacao({ admin: true });
  const acesso = fs.accessSync, stat = fs.statSync;
  fs.accessSync = () => {}; fs.statSync = () => ({ isFile: () => true });
  try { await comDb(db, i, () => loja.publicarPainel(i)); } finally { fs.accessSync = acesso; fs.statSync = stat; }
  assert.equal(i.publico.files[0].name, 'lojinha-royal-ap.png');
  assert.equal(i.publico.embeds[0].toJSON().image.url, 'attachment://lojinha-royal-ap.png');
});

test('se a gravação de IDs falhar, confirma que o painel já foi publicado', async () => {
  const db = dbFake(), i = interacao({ admin: true }); db.configWriteError = true;
  await comDb(db, i, () => loja.publicarPainel(i));
  assert.ok(i.publico); assert.match(texto(i), /foi publicado.*não consegui salvar/i);
});

test('componentes não pertencentes ao prefixo não são tocados', async () => {
  const i = interacao({ customId: 'outro:coins' });
  assert.equal(await loja.handleComponent(i), false); assert.deepEqual(i.chamadas, []);
});

test('Royal Coins e ranking usam dados reais da guild, com resposta privada', async () => {
  const db = dbFake();
  const saldo = await clicar(db, 'lojinhapro:coins');
  assert.match(texto(saldo), /1\.000 COIN/); assert.match(texto(saldo), /Vitórias.*8/); assert.match(texto(saldo), /#1/);
  const rank = await clicar(db, 'lojinhapro:ranking');
  assert.match(texto(rank), new RegExp(U1)); assert.match(texto(rank), new RegExp(U2)); assert.doesNotMatch(texto(rank), /9\.000 COIN/);
  assert.deepEqual(rank.payload.allowedMentions, { parse: [] });
  assert.ok(db.calls.filter((x) => x.tabela === 'royal_profiles').every((x) => x.eqs.some(([k, v]) => k === 'guild_id' && v === G1)));
});

test('catálogo pagina e prévia cria intenção vinculada; confirmação usa nonce', async () => {
  const db = dbFake(); db.tables.royal_shop_items[26].stock = 2;
  const lista = await clicar(db, 'lojinhapro:catalogo');
  assert.equal(componentes(lista)[0].components[0].options.length, 25);
  const pagina = await clicar(db, componentes(lista)[1].components[1].custom_id);
  const menu = componentes(pagina)[0].components[0];
  const detalhes = await clicar(db, menu.custom_id, { values: [uuid(27)] });
  assert.match(texto(detalhes), /Produto 27/); assert.match(texto(detalhes), /2 em estoque/);
  const cid = componentes(detalhes)[0].components[0].custom_id;
  assert.ok(cid.length <= 100);
  const confirmado = await clicar(db, cid, { id: '777777777777777777' });
  assert.match(texto(confirmado), /pendente/);
  assert.deepEqual(db.calls.find((x) => x.rpc === 'royal_confirm_shop_intention').args,
    { p_guild_id: G1, p_user_id: U1, p_nonce: cid.split(':').at(-1) });
  assert.equal(db.tables.royal_profiles[0].coins, 973); assert.equal(db.tables.royal_shop_items[26].stock, 1);
});

test('replay com outros IDs não debita ou entrega novamente; nova prévia permite nova compra', async () => {
  const db = dbFake(); Object.assign(db.tables.royal_shop_items[0], { reward_type: 'role', reward_value: '123456789012345678' });
  let entregas = 0;
  const cid = await prepararCompra(db);
  await clicar(db, cid, { id: '777777777777777777', roleAdd: async () => { entregas++; } });
  const repetido = await clicar(db, cid, { id: '888888888888888888', roleAdd: async () => { entregas++; } });
  assert.match(texto(repetido), /já foi usada/); assert.equal(entregas, 1);
  assert.equal(db.tables.royal_profiles[0].coins, 999); assert.equal(db.tables.royal_purchases.length, 1);
  await comprar(db); assert.equal(db.tables.royal_purchases.length, 2); assert.equal(db.tables.royal_profiles[0].coins, 998);
});

test('menus privados, nonce de outra pessoa e botões antigos são rejeitados', async () => {
  const db = dbFake(); const cid = await prepararCompra(db);
  const antes = db.calls.length;
  const alheia = await clicar(db, cid, { user: U2 });
  assert.match(texto(alheia), /pertence a outro jogador/); assert.equal(db.calls.length, antes);
  const adulterado = await clicar(db, cid.replace(U1, U2), { user: U2 });
  assert.match(texto(adulterado), /inválida/);
  const velho = await clicar(db, `lojinhapro:comprar:${U1}:${uuid(1)}:1`);
  assert.match(texto(velho), /Interação inválida/); assert.equal(db.tables.royal_purchases.length, 0);
});

test('alteração de preço ou recompensa após prévia não debita', async () => {
  for (const campo of ['price', 'reward_value']) {
    const db = dbFake(); const cid = await prepararCompra(db);
    db.tables.royal_shop_items[0][campo] = campo === 'price' ? 100 : '6.00';
    const i = await clicar(db, cid);
    assert.match(texto(i), campo === 'price' ? /O preço mudou/ : /termos do item mudaram/);
    assert.equal(db.tables.royal_profiles[0].coins, 1000); assert.equal(db.tables.royal_purchases.length, 0);
  }
});

test('slash abre prévia e não compra; id e slug são aceitos', async () => {
  const db = dbFake();
  for (const chave of ['item-5', uuid(5)]) {
    const i = interacao({ sub: 'comprar', chave }); await comDb(db, i, () => loja.comando.executar(i));
    assert.match(texto(i), /Produto 5/); assert.ok(componentes(i)[0]);
  }
  assert.equal(db.tables.royal_purchases.length, 0);
});

test('saldo, estoque e erros de transporte não são ignorados', async () => {
  for (const tipo of ['saldo', 'estoque', 'transporte', 'limite']) {
    const db = dbFake(); const cid = await prepararCompra(db);
    if (tipo === 'saldo') db.tables.royal_profiles[0].coins = 0;
    if (tipo === 'estoque') db.tables.royal_shop_items[0].stock = 0;
    if (tipo === 'transporte') db.rpcError = 'falha de transporte';
    if (tipo === 'limite') db.rpcError = 'Limite de compras por usuário atingido';
    const i = await clicar(db, cid);
    assert.match(texto(i), { saldo: /Saldo insuficiente/, estoque: /sem estoque/, transporte: /Consulte seu histórico/, limite: /já atingiu o limite/ }[tipo]);
    assert.equal(db.tables.royal_purchases.length, 0);
  }
});

test('cargo é entregue pelo snapshot, falha permanece pendente', async () => {
  for (const falha of [false, true]) {
    const db = dbFake(); Object.assign(db.tables.royal_shop_items[0], { reward_type: 'role', reward_value: '123456789012345678' });
    let chamadas = 0;
    const i = await comprar(db, uuid(1), { roleAdd: async (id) => { chamadas++; assert.equal(id, '123456789012345678'); if (falha) throw new Error('sem permissão'); } });
    assert.equal(chamadas, 1); assert.equal(db.tables.royal_purchases[0].status, falha ? 'pending' : 'delivered');
    assert.match(texto(i), falha ? /revisão da administração/ : /Cargo concedido/);
  }
});

test('entrega da compra usa claim persistente e snapshot mesmo se o cadastro divergir', async () => {
  const db = dbFake();
  Object.assign(db.tables.royal_shop_items[0], { reward_type: 'role', reward_value: '123456789012345678' });
  db.afterConfirm = (_, produto) => { produto.reward_value = '999999999999999999'; };
  let entregas = 0;
  await comprar(db, uuid(1), { roleAdd: async (id) => { entregas++; assert.equal(id, '123456789012345678'); } });
  assert.equal(entregas, 1);
  assert.deepEqual(db.calls.filter((x) => x.rpc === 'royal_rescue_action').map((x) => x.args.p_action), ['claim', 'finish']);
  assert.equal(db.calls.some((x) => x.rpc === 'royal_mark_purchase_delivered'), false);
  assert.equal(db.tables.royal_purchases[0].status, 'delivered');
});

test('histórico usa snapshot de nome, não cadastro mutável', async () => {
  const db = dbFake(); await comprar(db);
  db.tables.royal_shop_items[0].name = 'Nome novo';
  const i = await clicar(db, 'lojinhapro:inventario');
  assert.match(texto(i), /Produto 1/);
});

test('SQL versionado contém lock, checagem de saldo e estoque, e pendência para Pix/físico', () => {
  const sql = fs.readFileSync(require('node:path').join(__dirname, '../supabase/migrations/202611150002_economy_source_of_truth.sql'), 'utf8');
  const trecho = sql.slice(sql.indexOf('create or replace function public.royal_buy_item'), sql.indexOf('create or replace function public.royal_mark_reward_delivered'));
  assert.match(trecho, /pg_advisory_xact_lock/); assert.match(trecho, /for update/);
  assert.match(trecho, /r\.coins<i\.price/); assert.match(trecho, /i\.stock<1/);
  assert.match(trecho, /'pix','physical','role'\) then 'pending'/);
});


test('loja usa canal configurado, instruções públicas limitadas e registra destino e fixação', async () => {
  const db = dbFake(), i = interacao({ admin: true });
  const C = '777777777777777777';
  db.tables.discord_configuracoes.push(
    { guild_id: G1, chave: 'lojinha_canal', valor: C },
    { guild_id: G1, chave: 'lojinha_instrucoes', valor: '@everyone <@123456789012345678> **atenção**\n' + 'x'.repeat(8000) },
    { guild_id: G2, chave: 'lojinha_instrucoes', valor: 'NÃO MOSTRAR' },
  );
  const destino = { ...i.channel, id: C, async send(payload) {
    i.destino = payload; return { id: '888888888888888888', async pin() { i.fixado = true; } };
  } };
  i.guild.channels.fetch = async (id) => { assert.equal(id, C); return destino; };
  await comDb(db, i, () => loja.publicarPainel(i));
  assert.equal(i.publico, undefined); assert.ok(i.destino); assert.equal(i.fixado, true);
  assert.match(texto(i), /fixado/); assert.match(texto(i), new RegExp(C));
  const desc = i.destino.embeds[0].toJSON().description;
  assert.match(desc, /\*\*Instruções\*\*/); assert.match(desc, /@\u200beveryone/);
  assert.doesNotMatch(desc, /@everyone|<@123456789012345678>|NÃO MOSTRAR/);
  assert.ok(desc.length < 700); assert.deepEqual(i.destino.allowedMentions, { parse: [] });
  const salvo = db.tables.discord_configuracoes.find((c) => c.chave === 'lojinhapro_painel');
  assert.deepEqual(JSON.parse(salvo.valor), { canal_id: C, mensagem_id: '888888888888888888' });
});

test('leituras da configuração e destinos inválidos jamais desviam a loja para o canal atual', async () => {
  for (const falha of ['leitura', 'instrucoes', 'ausente', 'guild', 'tipo', 'ver', 'enviar', 'fetch']) {
    const db = dbFake(), i = interacao({ admin: true });
    const C = '777777777777777777'; db.tables.discord_configuracoes.push({ guild_id: G1, chave: 'lojinha_canal', valor: C });
    if (falha === 'leitura') db.configReadError = true;
    if (falha === 'instrucoes') db.configReadKeyError = 'lojinha_instrucoes';
    if (falha === 'fetch') i.guild.channels.fetch = async () => { throw new Error('negado'); };
    if (!['ausente', 'leitura', 'instrucoes', 'fetch'].includes(falha)) {
      i.guild.channels.cache.set(C, {
        ...i.channel, id: C, guildId: falha === 'guild' ? G2 : G1,
        type: falha === 'tipo' ? ChannelType.GuildForum : ChannelType.GuildText,
        permissionsFor: () => ({ has: (p) => p !== (falha === 'ver' ? PermissionFlagsBits.ViewChannel : falha === 'enviar' ? PermissionFlagsBits.SendMessages : 0n) }),
        async send() { throw new Error('não deve enviar'); },
      });
    }
    await comDb(db, i, () => loja.publicarPainel(i));
    assert.equal(i.publico, undefined, falha); assert.match(texto(i), /nenhum painel foi publicado/i, falha);
    assert.equal(db.tables.discord_configuracoes.some((x) => x.chave === 'lojinhapro_painel'), false);
  }
});

test('falhas ao fixar ou salvar IDs são relatadas honestamente', async () => {
  for (const modo of ['pin', 'ids', 'ambos']) {
    const db = dbFake(), i = interacao({ admin: true });
    db.configWriteError = modo !== 'pin';
    i.channel.send = async (p) => { i.publico = p; return { id: 'mensagem', async pin() { if (modo !== 'ids') throw new Error('sem permissão'); } }; };
    await comDb(db, i, () => loja.publicarPainel(i));
    assert.ok(i.publico);
    if (modo !== 'ids') assert.match(texto(i), /não fixado/);
    else assert.match(texto(i), /e fixado/);
    if (modo !== 'pin') assert.match(texto(i), /não consegui salvar/i);
    else assert.match(texto(i), /Canal e mensagem registrados/);
  }
});

test('publicação por /lojinhapainel funciona sem contexto e aceita cliente opcional', async () => {
  const mestres = require('../src/comandos/comandosMestres');
  const comandoPainel = mestres.comandos.find((c) => c.data.name === 'lojinhapainel');
  assert.ok(comandoPainel);
  assert.equal(mestres.comandos.some((c) => c.data.name === 'loja' && c.data.toJSON().options?.some((o) => o.name === 'painel')), false);
  const db = dbFake(), i = interacao({ admin: true });
  await comDb(db, i, () => comandoPainel.executar(i));
  assert.ok(i.publico); assert.match(texto(i), /não fixado/);
  const db2 = dbFake(), outro = interacao({ admin: true });
  db2.ack = () => assert.equal(outro.deferred, true);
  await comandoPainel.executar(outro, { db: { client: db2 } });
  assert.ok(outro.publico); assert.ok(db2.tables.discord_configuracoes.some((c) => c.chave === 'lojinhapro_painel'));
});

test('avisos de PIX, físico e cargo pendentes são pós-auditoria e best effort', async () => {
  for (const tipo of ['pix', 'physical', 'role']) {
    const db = dbFake(); avisoFalha = true;
    Object.assign(db.tables.royal_shop_items[0], { reward_type: tipo, reward_value: 'CHAVE-PIX-SEGREDO' });
    const i = await comprar(db, uuid(1), {
      roleAdd: async () => { throw new Error('sem permissão'); },
    });
    assert.match(texto(i), /pendente|revisão/);
    assert.equal(avisosChamados.length, 1);
    assert.equal(avisosChamados[0].protocolo, db.tables.royal_purchases[0].id);
    assert.doesNotMatch(avisosChamados[0].descricao, /CHAVE-PIX-SEGREDO/);
    assert.ok(db.tables.royal_audit_events.some((a) => a.action === 'reward.delivery.pending'));
    assert.ok(db.tables.royal_audit_events.some((a) => a.action === 'shop.purchase'));
    assert.doesNotMatch(texto(i), /staff avisada|aviso enviado/i);
  }
  const db = dbFake(); Object.assign(db.tables.royal_shop_items[0], { reward_type: 'role', reward_value: '123456789012345678' });
  await comprar(db);
  assert.equal(avisosChamados.length, 0);
});


test('canal atual em thread exige permissão de envio em thread e falhas não desviam publicação', async () => {
  for (const modo of ['thread-permitida', 'thread-negada', 'envio']) {
    const db = dbFake(), i = interacao({ admin: true });
    i.channel.type = modo.startsWith('thread') ? ChannelType.PublicThread : ChannelType.GuildText;
    i.channel.permissionsFor = () => ({ has: (p) => !(modo === 'thread-negada' && p === PermissionFlagsBits.SendMessagesInThreads) });
    if (modo === 'envio') i.channel.send = async () => { throw new Error('falha de envio'); };
    await comDb(db, i, () => loja.publicarPainel(i));
    if (modo === 'thread-permitida') { assert.ok(i.publico); assert.match(texto(i), /foi publicado/); }
    else {
      assert.equal(i.publico, undefined); assert.match(texto(i), /não pode enviar|Não consegui publicar/i);
      assert.equal(db.tables.discord_configuracoes.some((c) => c.chave === 'lojinhapro_painel'), false);
    }
  }
});

test('inventário e histórico permanecem privados e paginados', async () => {
  const db = dbFake();
  for (let n = 1; n <= 12; n++) {
    db.tables.royal_inventory.push({ guild_id: G1, user_id: U1, item_id: uuid(n), quantity: n, updated_at: `2026-11-${String(n).padStart(2, '0')}T12:00:00Z` });
    db.tables.royal_purchases.push({ id: uuid(200 + n), guild_id: G1, user_id: U1, item_id: uuid(n), price: n,
      terms_snapshot: { name: `Comprado ${n}` }, snapshot_source: 'purchase', status: 'pending', created_at: `2026-11-${String(n).padStart(2, '0')}T12:00:00Z` });
  }
  db.tables.royal_purchases.push({ id: uuid(400), guild_id: G2, user_id: U1, item_id: uuid(1), price: 1, terms_snapshot: { name: 'Não exibir' }, status: 'pending', created_at: '2026-12-01' });
  const inicio = await clicar(db, 'lojinhapro:inventario');
  assert.doesNotMatch(texto(inicio), /Não exibir/);
  const historico = componentes(inicio)[0].components.find((b) => b.label.includes('histórico'));
  const pagina = await clicar(db, historico.custom_id);
  assert.match(texto(pagina), /Página 1\/2/);
  const segunda = await clicar(db, componentes(pagina)[0].components[1].custom_id);
  assert.match(texto(segunda), /Página 2\/2/); assert.match(texto(segunda), /Comprado 1/);
});

test('erro ao marcar a entrega de cargo conserva pendência sem afirmar sucesso', async () => {
  const db = dbFake(); db.markError = true;
  Object.assign(db.tables.royal_shop_items[0], { reward_type: 'role', reward_value: '123456789012345678' });
  const i = await comprar(db);
  assert.match(texto(i), /revisão da administração/);
  assert.equal(db.tables.royal_purchases[0].status, 'pending');
  assert.ok(db.tables.royal_audit_events.some((x) => x.action === 'reward.delivery.pending'));
});

test('prévia exibe preço bigint exato recebido como texto', async () => {
  const db = dbFake(); db.tables.royal_shop_items[0].price = '9007199254740993';
  const detalhes = await clicar(db, `lojinhapro:selecionar:${U1}`, { values: [uuid(1)] });
  assert.match(texto(detalhes), /9\.007\.199\.254\.740\.993 COIN/);
});
