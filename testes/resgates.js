'use strict';

// node --test testes/resgates.js — dados simulados, nenhuma conexão externa.
const test = require('node:test');
const assert = require('node:assert/strict');
const { MessageFlags, PermissionFlagsBits } = require('discord.js');
const supabase = require('../src/servicos/supabase');
const royal = require('../src/servicos/royalSupabase');
const { comandos } = require('../src/comandos/resgates');

const G1 = '111111111111111111';
const G2 = '222222222222222222';
const U1 = '333333333333333333';
const U2 = '444444444444444444';
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const item = (n, tipo = 'pix', guild = G1, nome = `Produto ${n}`) => ({
  id: uuid(n), guild_id: guild, name: nome, reward_type: tipo, reward_value: tipo === 'pix' ? '5.00' : '123456789012345678',
});
const compra = (n, itemId, status = 'pending', guild = G1, usuario = U1) => ({
  id: uuid(100 + n), guild_id: guild, user_id: usuario, item_id: itemId, status,
  created_at: `2026-01-${String(n).padStart(2, '0')}T00:00:00Z`,
});
const entrega = (n, tipo = 'pix', status = 'pending', guild = G1, usuario = U1) => ({
  request_id: `spin:interaction-${n}`, guild_id: guild, user_id: usuario, reward_type: tipo, reward_value: tipo === 'pix' ? '5.00' : '123456789012345678', status,
  created_at: `2026-01-${String(n).padStart(2, '0')}T00:00:00Z`,
});

function dbFake() {
  const db = {
    tables: { royal_shop_items: [], royal_purchases: [], royal_reward_deliveries: [], royal_audit_events: [] },
    calls: [], semData: new Set(), erros: [], antesUpdate: null, ack: () => {},
    from(nome) {
      db.ack();
      const c = { nome, operacao: 'select', eqs: [], ins: [], ordens: [] };
      db.calls.push(c);
      const q = {
        select(cols) { c.cols = cols; return q; },
        update(valores) { c.operacao = 'update'; c.valores = structuredClone(valores); return q; },
        insert(valores) { c.operacao = 'insert'; c.valores = structuredClone(valores); return q; },
        eq(chave, valor) { c.eqs.push([chave, valor]); return q; },
        in(chave, valores) { c.ins.push([chave, [...valores]]); return q; },
        order(chave, opcoes) { c.ordens.push([chave, opcoes?.ascending !== false]); return q; },
        range(inicio, fim) { c.range = [inicio, fim]; return q; },
        limit(n) { c.limit = n; return q; },
        maybeSingle() { c.single = true; return q; },
        then(resolve, reject) {
          return Promise.resolve().then(async () => {
            const erroIndice = db.erros.findIndex((e) => e.quando(c));
            if (erroIndice !== -1) return { data: null, error: db.erros.splice(erroIndice, 1)[0].erro };
            if (c.operacao === 'insert') {
              db.tables[nome].push(structuredClone(c.valores));
              return { data: null, error: null };
            }
            if (c.operacao === 'update' && c.valores.delivered_at && db.semData.has(nome)) {
              return { data: null, error: { code: 'PGRST204', message: `Could not find the 'delivered_at' column of '${nome}' in the schema cache` } };
            }
            if (c.operacao === 'update' && db.antesUpdate) {
              const fn = db.antesUpdate; db.antesUpdate = null; await fn(c);
            }
            const buscarCampo = (row, chave) => {
              if (chave.startsWith('royal_shop_items.')) {
                const rel = db.tables.royal_shop_items.find((x) => x.id === row.item_id);
                return rel?.[chave.slice('royal_shop_items.'.length)];
              }
              return row[chave];
            };
            let rows = db.tables[nome].filter((row) =>
              c.eqs.every(([k, v]) => buscarCampo(row, k) === v) &&
              c.ins.every(([k, vs]) => vs.includes(buscarCampo(row, k))));
            rows.sort((a, b) => {
              for (const [chave, asc] of c.ordens) {
                if (a[chave] !== b[chave]) return (a[chave] > b[chave] ? 1 : -1) * (asc ? 1 : -1);
              }
              return 0;
            });
            if (c.range) rows = rows.slice(c.range[0], c.range[1] + 1);
            if (c.limit) rows = rows.slice(0, c.limit);
            if (c.operacao === 'update') for (const row of rows) Object.assign(row, c.valores);
            rows = rows.map((row) => ({ ...structuredClone(row), ...(nome === 'royal_purchases' ? {
              royal_shop_items: structuredClone(db.tables.royal_shop_items.find((x) => x.id === row.item_id)),
            } : {}) }));
            return { data: c.single ? rows[0] || null : rows, error: null };
          }).then(resolve, reject);
        },
      };
      return q;
    },
  };
  return db;
}

let seq = 0;
function interacao({ sub = 'pendentes', tipo, protocolo, pagina, admin = true, guild = G1, deferred = false } = {}) {
  const i = {
    id: `interacao-${++seq}`, guildId: guild, user: { id: U2 }, deferred, replied: false, calls: [],
    member: { permissions: { has: (p) => admin && p === PermissionFlagsBits.Administrator }, roles: { cache: { has: () => false } } },
    options: { getSubcommand: () => sub, getString: (key) => ({ tipo, protocolo })[key], getInteger: () => pagina },
    async deferReply(payload) { i.calls.push(['defer', payload]); i.deferred = true; },
    async editReply(payload) { i.calls.push(['edit', payload]); i.payload = payload; },
    async reply(payload) { i.calls.push(['reply', payload]); i.payload = payload; i.replied = true; },
    async followUp(payload) { i.calls.push(['followUp', payload]); i.payload = payload; },
  };
  return i;
}
function texto(i) {
  return i.payload?.content || JSON.stringify(i.payload?.embeds?.map((x) => x.toJSON()) || []);
}
async function executar(db, i, { auditoriaReal = false, erroAuditoria = false } = {}) {
  const obterOriginal = supabase.obterCliente;
  const auditarOriginal = royal.auditar;
  db.eventos = [];
  supabase.obterCliente = () => { assert.equal(i.deferred, true, 'ACK privado precede o banco'); return db; };
  if (!auditoriaReal) royal.auditar = async (evento) => {
    db.eventos.push(structuredClone(evento));
    if (erroAuditoria) throw new Error('auditoria indisponível');
  };
  try { await comandos[0].executar(i); } finally { supabase.obterCliente = obterOriginal; royal.auditar = auditarOriginal; }
  if (i.calls[0][0] === 'defer') assert.equal(i.calls[0][1].flags, MessageFlags.Ephemeral);
  return i;
}
function conferirEscopo(db, guild = G1) {
  for (const c of db.calls.filter((x) => x.operacao !== 'insert')) {
    assert.ok(c.eqs.some(([k, v]) => k === 'guild_id' && v === guild), `${c.nome} sem guild`);
  }
}
function povoar(db) {
  db.tables.royal_shop_items.push(item(1, 'pix'), item(2, 'role'), item(3, 'physical'), item(4, 'coins'), item(5, 'pix', G2));
  db.tables.royal_purchases.push(compra(1, uuid(1)), compra(2, uuid(2)), compra(3, uuid(3)),
    compra(4, uuid(4)), compra(5, uuid(5), 'pending', G2, U2));
  db.tables.royal_reward_deliveries.push(entrega(1), entrega(2, 'role'), entrega(3, 'coins'), entrega(4, 'pix', 'delivered'), entrega(5, 'pix', 'pending', G2));
}

test('contrato slash define subcomandos, tipo e protocolo obrigatórios, e servidor obrigatório', () => {
  assert.equal(comandos.length, 1);
  assert.equal(typeof comandos[0].executar, 'function');
  const json = comandos[0].data.toJSON();
  assert.equal(json.name, 'resgates'); assert.equal(json.dm_permission, false);
  assert.deepEqual(json.options.map((s) => s.name), ['pendentes', 'concluir']);
  assert.equal(json.options[0].options[0].name, 'pagina');
  const opcoes = json.options[1].options;
  assert.deepEqual(opcoes.map((x) => x.name), ['tipo', 'protocolo']);
  assert.ok(opcoes.every((x) => x.required));
  assert.deepEqual(opcoes[0].choices.map((x) => x.value), ['loja', 'roleta']);
});

test('somente administrador, em servidor, com resposta privada e sem acesso indevido ao banco', async () => {
  for (const sub of ['pendentes', 'concluir']) {
    const db = dbFake(), i = interacao({ sub, admin: false, tipo: 'loja', protocolo: uuid(101) });
    await executar(db, i); assert.match(texto(i), /Somente administradores/); assert.equal(db.calls.length, 0);
    assert.equal(i.calls[0][1].flags, MessageFlags.Ephemeral);
  }
  const db = dbFake(), dm = interacao({ guild: null });
  await executar(db, dm); assert.match(texto(dm), /servidor/); assert.equal(db.calls.length, 0);
  const reconhecida = interacao({ deferred: true }); await executar(db, reconhecida);
  assert.equal(reconhecida.calls[0][0], 'edit'); assert.deepEqual(reconhecida.payload.allowedMentions, { parse: [] });
});

test('lista em páginas limitadas ambas as origens, tipos elegíveis e identificadores completos', async () => {
  const db = dbFake(); povoar(db);
  for (let pagina = 1; pagina <= 3; pagina++) {
    const i = interacao({ pagina }); await executar(db, i);
    assert.match(texto(i), new RegExp(`página ${pagina}`));
    assert.match(texto(i), new RegExp(uuid(100 + pagina)));
    assert.match(texto(i), new RegExp(U1));
    assert.doesNotMatch(texto(i), new RegExp(uuid(105)));
    assert.match(texto(i), /não processa pagamentos/);
    assert.match(texto(i), /manualmente/);
    assert.ok(texto(i).length <= 2000);
    if (pagina === 1) assert.match(texto(i), /Valor PIX: R\$ 5\.00/);
    if (pagina === 2) assert.match(texto(i), /ID do cargo: 123456789012345678/);
    assert.deepEqual(i.payload.allowedMentions, { parse: [] });
    if (pagina <= 2) assert.match(texto(i), new RegExp(`spin:interaction-${pagina}`));
    else assert.match(texto(i), /Nenhuma entrega/);
  }
  const vazio = interacao({ pagina: 4 }); await executar(db, vazio);
  assert.match(texto(vazio), /Nenhuma compra/); assert.match(texto(vazio), /Nenhuma entrega/);
  conferirEscopo(db);
  for (const q of db.calls) {
    assert.equal(q.eqs.find(([k]) => k === 'status')[1], 'pending');
    assert.equal(q.range[1] - q.range[0], 0);
  }
  const lojas = db.calls.filter((x) => x.nome === 'royal_purchases');
  assert.ok(lojas.every((x) => x.eqs.some(([k, v]) => k === 'royal_shop_items.guild_id' && v === G1)));
  assert.ok(lojas.every((x) => x.ins.some(([k, v]) => k === 'royal_shop_items.reward_type' && v.join(',') === 'role,pix,physical')));
});

test('não trunca protocolo, nem estoura 2000 caracteres com dados excepcionais', async () => {
  const db = dbFake(); povoar(db);
  db.tables.royal_reward_deliveries[0].request_id = 'spin:' + 'x'.repeat(995);
  let i = interacao(); await executar(db, i);
  assert.ok(texto(i).includes(db.tables.royal_reward_deliveries[0].request_id));
  assert.ok(texto(i).length <= 2000);
  db.tables.royal_reward_deliveries[0].request_id += 'x';
  i = interacao(); await executar(db, i);
  assert.match(texto(i), /identificador incompatível/); assert.ok(texto(i).length <= 2000);
});

test('conclui apenas pendência da loja, sem horário quando coluna não existe e com auditoria', async () => {
  const db = dbFake(); povoar(db); db.semData.add('royal_purchases');
  const i = interacao({ sub: 'concluir', tipo: 'loja', protocolo: uuid(101) });
  await executar(db, i);
  assert.equal(db.tables.royal_purchases[0].status, 'delivered');
  assert.equal(db.tables.royal_purchases[0].delivered_at, undefined);
  assert.match(texto(i), /coluna delivered_at está indisponível/);
  assert.match(texto(i), /não verifica se o pagamento ou envio ocorreu/);
  assert.match(texto(i), /operações separadas/);
  assert.equal(db.eventos.length, 1);
  assert.deepEqual(db.eventos[0], {
    guildId: G1, actorId: U2, action: 'reward.delivery.manual_marked', entityType: 'purchase',
    entityId: uuid(101), requestId: i.id, beforeData: { status: 'pending' }, afterData: { status: 'delivered' },
    detail: 'Registro de entrega marcado manualmente; pagamento ou envio não processado pelo comando.',
  });
  const updates = db.calls.filter((c) => c.operacao === 'update');
  assert.equal(updates.length, 2); assert.ok(updates[0].valores.delivered_at); assert.equal(updates[1].valores.delivered_at, undefined);
  for (const q of updates) {
    assert.ok(q.eqs.some(([k, v]) => k === 'status' && v === 'pending'));
    assert.ok(q.eqs.some(([k, v]) => k === 'user_id' && v === U1));
    assert.ok(q.eqs.some(([k, v]) => k === 'item_id' && v === uuid(1)));
  }
  conferirEscopo(db);
});

test('conclui roleta pelo request_id integral, com delivered_at e auditoria real simulada', async () => {
  const db = dbFake(); povoar(db);
  const i = interacao({ sub: 'concluir', tipo: 'roleta', protocolo: 'spin:interaction-1' });
  await executar(db, i, { auditoriaReal: true });
  const registro = db.tables.royal_reward_deliveries[0];
  assert.equal(registro.status, 'delivered'); assert.ok(Number.isFinite(Date.parse(registro.delivered_at)));
  assert.equal(db.tables.royal_audit_events.length, 1);
  const ev = db.tables.royal_audit_events[0];
  assert.equal(ev.guild_id, G1); assert.equal(ev.actor_id, U2); assert.equal(ev.entity_id, 'spin:interaction-1');
  assert.equal(ev.request_id, i.id); assert.equal(ev.after_data.status, 'delivered');
  assert.doesNotMatch(JSON.stringify(ev), /reward_value|holder|pix_key/i);
  assert.match(texto(i), /não processa pagamentos/);
  conferirEscopo(db);
});

test('horário é registrado na loja quando existente e opcional também na roleta', async () => {
  for (const tipo of ['loja', 'roleta']) {
    const db = dbFake(); povoar(db);
    if (tipo === 'roleta') db.semData.add('royal_reward_deliveries');
    const i = interacao({ sub: 'concluir', tipo, protocolo: tipo === 'loja' ? uuid(101) : 'spin:interaction-1' });
    await executar(db, i);
    const linha = tipo === 'loja' ? db.tables.royal_purchases[0] : db.tables.royal_reward_deliveries[0];
    assert.equal(linha.status, 'delivered');
    if (tipo === 'loja') assert.ok(Number.isFinite(Date.parse(linha.delivered_at)));
    else { assert.equal(linha.delivered_at, undefined); assert.match(texto(i), /horário não foi registrado/); }
    const updates = db.calls.filter((c) => c.operacao === 'update');
    assert.ok(updates.every((c) => c.limit === undefined), 'UPDATE não deve depender de LIMIT');
    conferirEscopo(db);
  }
});

test('servidor alheio, protocolos forjados, tipo inelegível e status não pendente não mudam nada', async () => {
  const db = dbFake(); povoar(db);
  db.tables.royal_purchases.push(compra(6, uuid(1), 'cancelled'));
  const casos = [
    { tipo: 'loja', protocolo: uuid(105), mensagem: /não encontrado ou não elegível/ },
    { tipo: 'roleta', protocolo: 'spin:interaction-5', mensagem: /não encontrado ou não elegível/ },
    { tipo: 'loja', protocolo: uuid(104), mensagem: /não encontrado ou não elegível/ },
    { tipo: 'roleta', protocolo: 'spin:interaction-3', mensagem: /não encontrado ou não elegível/ },
    { tipo: 'loja', protocolo: 'não-uuid', mensagem: /UUID para loja/ },
    { tipo: 'roleta', protocolo: 'interaction-1', mensagem: /não encontrado ou não elegível/ },
    { tipo: 'invalido', protocolo: uuid(101), mensagem: /Informe o tipo/ },
    { tipo: 'loja', protocolo: uuid(106), mensagem: /não está pendente/ },
  ];
  for (const caso of casos) {
    const i = interacao({ sub: 'concluir', ...caso }); await executar(db, i);
    assert.match(texto(i), caso.mensagem); assert.doesNotMatch(texto(i), new RegExp(G2));
  }
  assert.equal(db.calls.filter((c) => c.operacao === 'update').length, 0);
  assert.equal(db.tables.royal_purchases.find((x) => x.id === uuid(105)).status, 'pending');
  conferirEscopo(db);
});

test('replay informa já entregue, não reescreve horário nem gera outro evento', async () => {
  const db = dbFake(); povoar(db);
  const parametros = { sub: 'concluir', tipo: 'roleta', protocolo: 'spin:interaction-1' };
  await executar(db, interacao(parametros));
  const momento = db.tables.royal_reward_deliveries[0].delivered_at;
  const n = db.calls.filter((x) => x.operacao === 'update').length;
  const replay = interacao(parametros); await executar(db, replay);
  assert.match(texto(replay), /já consta como entregue/);
  assert.equal(db.calls.filter((x) => x.operacao === 'update').length, n);
  assert.equal(db.tables.royal_reward_deliveries[0].delivered_at, momento);
  assert.equal(db.eventos.length, 0);
});

test('corrida para delivered é detectada sem afirmar que esta tentativa atualizou ou auditou', async () => {
  const db = dbFake(); povoar(db);
  db.antesUpdate = async () => { db.tables.royal_reward_deliveries[0].status = 'delivered'; };
  const i = interacao({ sub: 'concluir', tipo: 'roleta', protocolo: 'spin:interaction-1' });
  await executar(db, i);
  assert.match(texto(i), /já consta como entregue/); assert.doesNotMatch(texto(i), /Status registrado como entregue/);
  assert.equal(db.eventos.length, 0); conferirEscopo(db);
});

test('corrida para outro status ou outro item não conclui nem inventa sucesso', async () => {
  for (const alteracao of ['status', 'item']) {
    const db = dbFake(); povoar(db);
    db.antesUpdate = async () => {
      if (alteracao === 'status') db.tables.royal_purchases[0].status = 'cancelled';
      else db.tables.royal_purchases[0].item_id = uuid(3);
    };
    const i = interacao({ sub: 'concluir', tipo: 'loja', protocolo: uuid(101) });
    await executar(db, i);
    assert.match(texto(i), /Nenhuma conclusão foi confirmada/); assert.equal(db.eventos.length, 0);
    assert.notEqual(db.tables.royal_purchases[0].status, 'delivered');
  }
});

test('falha genérica no update não é repetida; resultado e auditoria são assumidos indeterminados', async () => {
  const db = dbFake(); povoar(db);
  db.erros.push({ quando: (x) => x.operacao === 'update', erro: { code: 'XX000', message: 'erro privado' } });
  const i = interacao({ sub: 'concluir', tipo: 'loja', protocolo: uuid(101) }); await executar(db, i);
  assert.match(texto(i), /Não foi possível confirmar/); assert.match(texto(i), /não repita pagamento ou envio/);
  assert.match(texto(i), /auditoria e a atualização são separadas/);
  assert.doesNotMatch(texto(i), /erro privado/);
  assert.equal(db.calls.filter((x) => x.operacao === 'update').length, 1);
  assert.equal(db.eventos.length, 0);
});

test('erro de outra coluna não aciona o fallback de delivered_at', async () => {
  const db = dbFake(); povoar(db);
  db.erros.push({ quando: (x) => x.operacao === 'update', erro: { code: 'PGRST204', message: 'Could not find another column' } });
  const i = interacao({ sub: 'concluir', tipo: 'roleta', protocolo: 'spin:interaction-1' });
  await executar(db, i);
  assert.match(texto(i), /Não foi possível confirmar/);
  assert.equal(db.calls.filter((x) => x.operacao === 'update').length, 1);
  assert.equal(db.eventos.length, 0);
});

test('falha de auditoria não desfaz atualização e ressalva falta de atomicidade', async () => {
  const db = dbFake(); povoar(db);
  const i = interacao({ sub: 'concluir', tipo: 'roleta', protocolo: 'spin:interaction-1' });
  await executar(db, i, { erroAuditoria: true });
  assert.equal(db.tables.royal_reward_deliveries[0].status, 'delivered');
  assert.match(texto(i), /auditoria pode falhar/); assert.match(texto(i), /confira o registro de auditoria/);
});

test('um item associado indevidamente a outro servidor jamais é exibido ou concluído', async () => {
  const db = dbFake(); povoar(db);
  db.tables.royal_purchases.unshift(compra(7, uuid(5)));
  const lista = interacao(); await executar(db, lista);
  assert.doesNotMatch(texto(lista), new RegExp(uuid(107)));
  const i = interacao({ sub: 'concluir', tipo: 'loja', protocolo: uuid(107) }); await executar(db, i);
  assert.match(texto(i), /não encontrado ou não elegível/);
  assert.equal(db.tables.royal_purchases[0].status, 'pending');
});
