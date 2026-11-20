'use strict';
// Testes sem rede. O teste SQL separado exercita atomicidade no PostgreSQL.
const test = require('node:test');
const assert = require('node:assert/strict');
const { MessageFlags, PermissionFlagsBits } = require('discord.js');
const supabase = require('../src/servicos/supabase');
const claims = require('../src/servicos/rescueClaim');
const { comandos } = require('../src/comandos/resgates');
const guild = '111111111111111111', staff = '222222222222222222';
const uuid = '00000000-0000-4000-8000-000000000101';

function interacao({ sub = 'iniciar', tipo = 'loja', protocolo = uuid, admin = true, user = staff, servidor = guild } = {}) {
  const i = { id: 'interaction-1', guildId: servidor, user: { id: user }, deferred: false, replied: false, calls: [],
    member: { permissions: { has: (p) => admin && p === PermissionFlagsBits.Administrator }, roles: { cache: { has: () => false } } },
    options: { getSubcommand: () => sub, getString: (k) => ({ tipo, protocolo })[k], getInteger: () => 1 },
    async deferReply(x) { this.calls.push(['defer', x]); this.deferred = true; },
    async editReply(x) { this.payload = x; }, async reply(x) { this.payload = x; this.replied = true; },
    async followUp(x) { this.payload = x; },
  };
  return i;
}
function dbFake() {
  const db = { calls: [], results: [], tables: {
    royal_purchases: [{ id: uuid, guild_id: guild, user_id: staff, status: 'pending', item_id: 'item', created_at: '1',
      terms_snapshot: { name: 'Açaí comprado', reward_type: 'physical', reward_value: 'copão' }, snapshot_source: 'legacy_current',
      royal_shop_items: { guild_id: guild, name: 'Açaí', reward_type: 'physical', reward_value: 'copão' } }],
    royal_reward_deliveries: [{ guild_id: guild, user_id: staff, request_id: 'spin:one', reward_type: 'pix', reward_value: '5.00', status: 'pending', created_at: '1' }],
    royal_rescue_claims: [],
  },
    async rpc(name, args) { db.calls.push({ name, args }); return db.results.shift() || { data: { result: 'acquired' }, error: null }; },
    from(table) {
      const q = { filters: [], ins: [], select() { return q; },
        eq(k, v) { q.filters.push([k, v]); return q; }, in(k, v) { q.ins.push([k, v]); return q; },
        order() { return q; }, range(a, b) { q.rangeVal = [a, b]; return q; }, limit() { return q; },
        maybeSingle() { q.single = true; return q; },
        then(resolve, reject) { return Promise.resolve().then(() => {
          db.calls.push({ table, filters: q.filters, ins: q.ins });
          const field = (r, k) => k === 'terms_snapshot->>reward_type' ? r.terms_snapshot?.reward_type : k.startsWith('royal_shop_items.') ? r.royal_shop_items?.[k.split('.')[1]] : r[k];
          let rows = db.tables[table].filter((r) => q.filters.every(([k, v]) => field(r, k) === v) && q.ins.every(([k, vs]) => vs.includes(field(r, k))));
          if (q.rangeVal) rows = rows.slice(q.rangeVal[0], q.rangeVal[1] + 1);
          return { data: q.single ? rows[0] || null : rows, error: null };
        }).then(resolve, reject); },
      }; return q;
    },
  }; return db;
}
async function executar(db, i) {
  const original = supabase.obterCliente;
  supabase.obterCliente = () => { assert.equal(i.deferred, true); return db; };
  try { await comandos[0].executar(i); } finally { supabase.obterCliente = original; }
  assert.equal(i.calls[0][1].flags, MessageFlags.Ephemeral);
  if (i.payload.allowedMentions) assert.deepEqual(i.payload.allowedMentions, { parse: [] });
  return i.payload.content || JSON.stringify(i.payload.embeds?.map((x) => x.toJSON()) || []);
}

test('contrato slash inclui iniciar e concluir com origem e protocolo obrigatórios', () => {
  const cmd = comandos[0].data.toJSON();
  assert.equal(cmd.dm_permission, false);
  assert.deepEqual(cmd.options.map((x) => x.name), ['pendentes', 'iniciar', 'concluir']);
  for (const sub of cmd.options.slice(1)) {
    assert.deepEqual(sub.options.map((x) => x.name), ['tipo', 'protocolo']);
    assert.ok(sub.options.every((x) => x.required));
  }
});

test('somente admin de servidor consulta ou reserva, com resposta privada', async () => {
  for (const sub of ['pendentes', 'iniciar', 'concluir']) {
    const db = dbFake(), i = interacao({ sub, admin: false });
    assert.match(await executar(db, i), /Somente administradores/);
    assert.equal(db.calls.length, 0);
  }
  const db = dbFake(), i = interacao({ servidor: null });
  assert.match(await executar(db, i), /servidor válido/); assert.equal(db.calls.length, 0);
});

test('listagem exibe identidade da reserva ou revisão para as duas origens, com escopo de guild', async () => {
  const db = dbFake();
  db.tables.royal_rescue_claims.push({ guild_id: guild, source: 'loja', protocol: uuid, state: 'claimed', owner_id: staff },
    { guild_id: guild, source: 'roleta', protocol: 'spin:one', state: 'review', owner_id: null });
  const text = await executar(db, interacao({ sub: 'pendentes' }));
  assert.match(text, new RegExp(staff)); assert.match(text, /Revisão obrigatória/); assert.match(text, /spin:one/);
  assert.match(text, /Açaí comprado/); assert.match(text, /termos legados aproximados/);
  assert.match(text, /Reserva:/);
  assert.match(text, /não expira/); assert.ok(text.length <= 2000);
  for (const call of db.calls) assert.ok(call.filters.some(([k,v]) => k === 'guild_id' && v === guild));
});

test('listagem e elegibilidade usam snapshot, não recompensa atual do cadastro', async () => {
  const db = dbFake();
  Object.assign(db.tables.royal_purchases[0].royal_shop_items, { name: 'Alterado', reward_type: 'coins', reward_value: '999' });
  const text = await executar(db, interacao({ sub: 'pendentes' }));
  assert.match(text, /Açaí comprado/); assert.match(text, /copão/); assert.doesNotMatch(text, /Alterado|999/);
  const consulta = db.calls.find((x) => x.table === 'royal_purchases');
  assert.ok(consulta.ins.some(([key, tipos]) => key === 'terms_snapshot->>reward_type' && tipos.includes('physical')));
});

test('todos os resultados da RPC são traduzidos sem concluir ou processar por fora', async () => {
  const cenarios = [
    ['acquired', /Reserva obtida por você/], ['already_owned', /já detém.*retentativa não autoriza/],
    ['owned', /Reserva pertence a.*não inicie/], ['review', /revisão obrigatória/],
    ['not_found', /não encontrado ou não elegível/], ['not_pending', /não está pendente/],
    ['delivered', /já consta como entregue/], ['unclaimed', /use \/resgates iniciar/],
    ['changed', /mudaram desde a reserva/], ['finished', /auditoria gravada na mesma transação/],
  ];
  for (const [result, esperado] of cenarios) {
    const db = dbFake(); db.results.push({ data: { result, owner_id: 'outra-pessoa' }, error: null });
    const texto = await executar(db, interacao({ sub: result === 'finished' ? 'concluir' : 'iniciar' }));
    assert.match(texto, esperado); assert.equal(db.calls.length, 1);
    assert.equal(db.calls[0].name, 'royal_rescue_action');
    assert.equal(db.calls[0].args.p_guild_id, guild); assert.equal(db.calls[0].args.p_actor_id, staff);
    assert.equal(db.calls[0].args.p_action, result === 'finished' ? 'finish' : 'claim');
  }
});

test('falha ou resposta desconhecida não autoriza iniciar ou repetir e não faz fallback', async () => {
  for (const data of [{ data: null, error: { message: 'erro privado' } }, { data: { result: 'inesperado' }, error: null }]) {
    for (const sub of ['iniciar', 'concluir']) {
      const db = dbFake(); db.results.push(data);
      const texto = await executar(db, interacao({ sub }));
      assert.match(texto, /Não foi possível confirmar/); assert.match(texto, /Não inicie nem repita/);
      assert.doesNotMatch(texto, /erro privado/); assert.equal(db.calls.length, 1);
    }
  }
});

test('valida protocolos e não trunca IDs nem aceita controles; normaliza UUID', async () => {
  for (const protocolo of ['x', '', uuid + '\n', 'x'.repeat(1001)]) {
    const db = dbFake(); assert.match(await executar(db, interacao({ protocolo })), /UUID para loja/); assert.equal(db.calls.length, 0);
  }
  const db = dbFake(); await executar(db, interacao({ protocolo: uuid.toUpperCase() }));
  assert.equal(db.calls[0].args.p_protocol, uuid);
});

test('entrega automática só toca Discord após claim novo e conclui com mesma identidade', async () => {
  const db = dbFake(), original = supabase.obterCliente; let feitos = 0;
  supabase.obterCliente = () => db;
  try {
    const args = { guildId: guild, tipo: 'roleta', protocolo: 'spin:one', interactionId: 'x', userId: staff, roleId: 'r', entregar: async () => { feitos++; } };
    db.results.push({ data: { result: 'acquired', user_id: staff, reward_type: 'role', reward_value: 'r' } }, { data: { result: 'finished' } });
    await claims.entregaAutomatica(args); assert.equal(feitos, 1);
    assert.deepEqual(db.calls.map((x) => x.args.p_action), ['claim', 'finish']);
    assert.ok(db.calls.every((x) => x.args.p_actor_id === 'auto:x'));
    for (const data of [{ result: 'owned' }, { result: 'already_owned' }, { result: 'review' },
      { result: 'acquired', user_id: staff, reward_type: 'role', reward_value: 'outra' }]) {
      db.results.push({ data }); await assert.rejects(claims.entregaAutomatica(args)); assert.equal(feitos, 1);
    }
    db.results.push({ data: null, error: { message: 'timeout' } });
    await assert.rejects(claims.entregaAutomatica(args)); assert.equal(feitos, 1);
    db.results.push({ data: { result: 'acquired', user_id: staff, reward_type: 'role', reward_value: 'r' } }, { data: null, error: { message: 'timeout' } });
    await assert.rejects(claims.entregaAutomatica(args)); assert.equal(feitos, 2);
    db.results.push({ data: { result: 'already_owned' } });
    await assert.rejects(claims.entregaAutomatica(args)); assert.equal(feitos, 2);
  } finally { supabase.obterCliente = original; }
});
