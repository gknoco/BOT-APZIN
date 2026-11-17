'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { test } = require('node:test');

const mp = {
  exigirAmbiente() { mp.envCalls += 1; },
  validarEmailPix(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); },
  centavos(value) {
    const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value ?? ''));
    return match ? Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0')) : null;
  },
  async criarPix(args) { mp.pixArgs = args; return mp.pix; },
  async buscarPagamento(id) { mp.lookupId = id; return mp.payment; },
  envCalls: 0,
};
const db = {
  async criarPedido(args) { db.createArgs = args; return db.order; },
  async anexarPagamento(args) { db.attachArgs = args; return { ...db.order, ...args, status: 'pending', mp_payment_id: args.paymentId }; },
  async marcarFalha(args) { db.failureArgs = args; },
  async obterPedidoUsuario(args) { db.ownerArgs = args; return db.order; },
  async obterCodigoPixUsuario(args) { db.codeArgs = args; return db.code; },
  async aplicarPagamento(args) { db.applyArgs = args; return db.applied; },
};
const mediadores = { async podeUsarSalas() { return true; }, AVISO_CARGO: 'Cargo de mediador exigido.' };
const loadOriginal = Module._load;
Module._load = function loadTest(request, parent, isMain) {
  const filename = Module._resolveFilename(request, parent, isMain);
  if (filename === path.resolve(__dirname, '../src/servicos/mercadoPago.js')) return mp;
  if (filename === path.resolve(__dirname, '../src/servicos/salaInfinitaSupabase.js')) return db;
  if (filename === path.resolve(__dirname, '../src/servicos/mediadores.js')) return mediadores;
  return loadOriginal.call(this, request, parent, isMain);
};
let salaInfinita;
let modais;
let botoes;
try {
  salaInfinita = require('../src/servicos/salaInfinita');
  modais = require('../src/interacoes/modais');
  botoes = require('../src/interacoes/botoes');
} finally {
  Module._load = loadOriginal;
}

const ORDER = '550e8400-e29b-41d4-a716-446655440000';
function preparar() {
  mp.envCalls = 0;
  mp.pixArgs = null;
  mp.lookupId = null;
  mp.payment = null;
  mp.pix = { id: '987654321', status: 'pending', qrCode: '000201INFINITA', qrBase64: Buffer.from('qr').toString('base64'), expiresAt: '2026-11-19T00:00:00Z' };
  db.createArgs = null;
  db.attachArgs = null;
  db.failureArgs = null;
  db.ownerArgs = null;
  db.codeArgs = null;
  db.applyArgs = null;
  db.applied = null;
  db.code = '000201INFINITA';
  db.order = { id: ORDER, guild_id: 'guild-a', user_id: 'user-a', plan: 'semanal', days: 7, amount_cents: 500,
    status: 'creating', mp_payment_id: null, pix_copy_paste: null, pix_qr_base64: null, premium_until_after: null };
}
function interaction(customId, fields = {}) {
  const calls = [];
  const i = {
    customId, id: 'discord-request-1', guildId: 'guild-a', guild: { id: 'guild-a' },
    user: { id: 'user-a' }, member: { roles: { cache: new Map() } },
    fields: { getTextInputValue: (key) => fields[key] || '' },
    deferred: false, replied: false, calls,
    showModal: async (modal) => calls.push(['showModal', modal]),
    update: async (payload) => { calls.push(['update', payload]); i.replied = true; },
    deferUpdate: async () => { calls.push(['deferUpdate']); i.deferred = true; },
    deferReply: async (payload) => { calls.push(['deferReply', payload]); i.deferred = true; },
    reply: async (payload) => { calls.push(['reply', payload]); i.replied = true; },
    followUp: async (payload) => calls.push(['followUp', payload]),
    editReply: async (payload) => calls.push(['editReply', payload]),
    isMessageComponent: () => true,
    isModalSubmit: () => customId.includes('modal'),
  };
  return i;
}
const last = (i) => i.calls.at(-1)?.[1];

test('planos têm preço/duração fixos e a criação Pix grava a ordem antes de chamar Mercado Pago', async () => {
  preparar();
  assert.deepEqual(salaInfinita.PLANOS, {
    semanal: { dias: 7, amountCents: 500, nome: 'Semanal' },
    mensal: { dias: 30, amountCents: 1300, nome: 'Mensal' },
  });
  const result = await salaInfinita.criarPixPlano({ guildId: 'guild-a', userId: 'user-a', requestId: 'discord-request-1', plan: 'semanal', payerEmail: 'Buyer@Example.com' });
  assert.equal(mp.envCalls, 1);
  assert.deepEqual(db.createArgs, { guildId: 'guild-a', userId: 'user-a', requestId: 'discord-request-1', plan: 'semanal', payerEmail: 'buyer@example.com' });
  assert.equal(mp.pixArgs.order.id, ORDER);
  assert.equal(mp.pixArgs.order.amount_cents, 500, 'a ordem de fixture representa o valor escolhido no banco');
  assert.equal(mp.pixArgs.description, 'Sala Infinita Semanal · Royal AP');
  assert.equal(result.payment.qrCode, '000201INFINITA');
  assert.equal(db.attachArgs.paymentId, '987654321');
});

test('checkout mensal aplica a quantia fixa de R$ 13,00 ao pedido persistido, sem aceitar preço do cliente', async () => {
  preparar();
  db.order = { ...db.order, plan: 'mensal', days: 30, amount_cents: 1300 };
  await salaInfinita.criarPixPlano({ guildId: 'guild-a', userId: 'user-a', requestId: 'request-month', plan: 'mensal', payerEmail: 'buyer@example.com' });
  assert.equal(mp.pixArgs.order.amount_cents, 1300);
  assert.equal(mp.pixArgs.description, 'Sala Infinita Mensal · Royal AP');
  assert.equal(db.createArgs.plan, 'mensal');
});

test('pagamento aprovado é verificado pelo dono e encaminhado ao Supabase com os dados do provedor', async () => {
  preparar();
  db.order = { ...db.order, status: 'pending', mp_payment_id: '987654321' };
  mp.payment = { id: '987654321', status: 'approved', transaction_amount: 5, currency_id: 'BRL', external_reference: ORDER, payment_method_id: 'pix' };
  db.applied = { ...db.order, status: 'approved', premium_until_after: '2026-11-24T00:00:00Z' };
  const result = await salaInfinita.verificarPlano({ orderId: ORDER, guildId: 'guild-a', userId: 'user-a' });
  assert.deepEqual(db.ownerArgs, { orderId: ORDER, guildId: 'guild-a', userId: 'user-a' });
  assert.equal(mp.lookupId, '987654321');
  assert.deepEqual(db.applyArgs, { orderId: ORDER, paymentId: '987654321', status: 'approved', amountCents: 500, currency: 'BRL', externalReference: ORDER, paymentMethod: 'pix' });
  assert.equal(result.status, 'approved');
});

test('referência/moeda/método/valor divergentes encaminham status manual_review em vez de ativar plano', async () => {
  const order = { id: ORDER, amount_cents: 500, mp_payment_id: '987654321' };
  for (const payment of [
    { id: '987654321', status: 'approved', transaction_amount: 5, currency_id: 'BRL', external_reference: 'wrong', payment_method_id: 'pix' },
    { id: '987654321', status: 'approved', transaction_amount: 5, currency_id: 'USD', external_reference: ORDER, payment_method_id: 'pix' },
    { id: '987654321', status: 'approved', transaction_amount: 5, currency_id: 'BRL', external_reference: ORDER, payment_method_id: 'credit_card' },
    { id: '987654321', status: 'approved', transaction_amount: 4.99, currency_id: 'BRL', external_reference: ORDER, payment_method_id: 'pix' },
  ]) {
    const checked = salaInfinita.validarPagamento(order, payment);
    assert.ok(checked.reason);
  }
});

test('botão público Sala Infinita abre painel efêmero e só atualiza mensagem quando ela já é privada', async () => {
  const i = interaction('ap:recargasalainfinita');
  await botoes.handleBotao(i, { db: {}, client: {} });
  assert.deepEqual(i.calls.map(([name]) => name), ['reply']);
  const payload = last(i);
  assert.equal(payload.flags & 64, 64);
  assert.equal(payload.embeds[0].toJSON().image.url, 'attachment://sala-infinita-royal-ap.png');
  assert.equal(payload.embeds[0].toJSON().description, 'O pagamento é por Pix e o plano ativa automaticamente. Comprar de novo soma os dias.');
  assert.equal(payload.embeds[0].toJSON().footer.text, 'Operado por Royal AP · Suporte Royal AP');
  assert.equal(payload.files[0].attachment, path.resolve(__dirname, '../assets/sala-infinita-royal-ap.png'));
  const components = payload.components.flatMap((row) => row.toJSON().components);
  assert.deepEqual(components.map((button) => button.custom_id), ['ap:recargavoltar', 'ap:recargasemanal', 'ap:recargamensal']);
  assert.deepEqual(components.map((button) => button.label), ['Voltar', 'Semanal R$ 5,00', 'Mensal R$ 13,00']);
  assert.deepEqual(components.map((button) => button.emoji.name), ['⬅️', '📅', '💎']);
  assert.deepEqual(components.map((button) => button.style), [2, 3, 3]);
  assert.ok(fs.statSync(path.resolve(__dirname, '../assets/sala-infinita-royal-ap.png')).size > 1000);

  const privateNav = interaction('ap:recargasalainfinita');
  privateNav.message = { flags: { has: (flag) => flag === 64 } };
  await botoes.handleBotao(privateNav, { db: {}, client: {} });
  assert.deepEqual(privateNav.calls.map(([name]) => name), ['update']);

  const back = interaction('ap:recargavoltar');
  back.message = { flags: { has: (flag) => flag === 64 } };
  await botoes.handleBotao(back, { db: {}, client: {} });
  assert.deepEqual(back.calls.map(([name]) => name), ['update']);
  const restored = last(back);
  assert.equal(restored.embeds[0].toJSON().image.url, 'attachment://recarga-royal-ap.jpg');
  assert.deepEqual(restored.components.flatMap((row) => row.toJSON().components).map((button) => button.label), ['Gerar Pix', 'Sala Infinita', 'Extrato']);
});

test('planos abrem modal de e-mail somente após autorização e modalinfinita processa Pix com QR/ações', async () => {
  const click = interaction('ap:recargasemanal');
  await botoes.handleBotao(click, { db: {}, client: {} });
  assert.deepEqual(click.calls.map(([name]) => name), ['showModal']);
  const modal = last(click).toJSON();
  assert.equal(modal.custom_id, 'ap:modalinfinita:semanal');
  assert.equal(modal.components[0].components[0].custom_id, 'email');
  assert.equal(modal.components[0].components[0].required, true);

  preparar();
  db.order = { ...db.order, status: 'pending', amount_cents: 500 };
  const submit = interaction('ap:modalinfinita:semanal', { email: 'buyer@example.com' });
  submit.isMessageComponent = () => false;
  await modais.handleModal(submit, { db: {}, client: {} });
  assert.equal(db.createArgs.plan, 'semanal');
  assert.equal(db.createArgs.userId, 'user-a');
  assert.ok(submit.calls[0][0] === 'deferReply');
  const payload = last(submit);
  assert.match(payload.embeds[0].toJSON().description, /R\$ 5,00/);
  assert.equal(payload.files[0].name, 'royal-infinite-qr.png');
  assert.deepEqual(payload.components.flatMap((row) => row.toJSON().components).map((button) => button.custom_id), [
    `ap:copiarinfinita:${ORDER}`, `ap:verificarinfinita:${ORDER}`,
  ]);
});

test('membro sem cargo autorizado não acessa o checkout público dos planos', async () => {
  const original = mediadores.podeUsarSalas;
  mediadores.podeUsarSalas = async () => false;
  try {
    const i = interaction('ap:recargamensal');
    await botoes.handleBotao(i, { db: {}, client: {} });
    assert.equal(i.calls.some(([name]) => name === 'showModal'), false);
    assert.equal(i.calls.at(-1)[0], 'reply');
    assert.match(last(i).embeds[0].toJSON().description, /Cargo de mediador exigido/);
  } finally {
    mediadores.podeUsarSalas = original;
  }
});

test('botão Copia e Cola retorna somente o código limpo e filtra pedido por servidor/usuário', async () => {
  preparar();
  const i = interaction(`ap:copiarinfinita:${ORDER}`);
  await botoes.handleBotao(i, { db: {}, client: {} });
  assert.deepEqual(db.codeArgs, { orderId: ORDER, guildId: 'guild-a', userId: 'user-a' });
  assert.equal(last(i).content, '000201INFINITA');
  assert.equal(last(i).flags & 64, 64);
});

test('migração declara RPCs protegidas e captura a isenção premium na reserva/liquidação', () => {
  const sql = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20261117010700_royal_infinite_rooms.sql'), 'utf8');
  assert.match(sql, /royal_infinite_subscriptions[\s\S]*premium_until timestamptz/);
  assert.match(sql, /royal_infinite_orders/);
  assert.match(sql, /p_plan = 'semanal'[\s\S]*v_days := 7; v_amount := 500[\s\S]*ELSIF p_plan = 'mensal'[\s\S]*v_days := 30; v_amount := 1300/);
  assert.match(sql, /v_premium := COALESCE\(v_premium_until > now\(\),false\)/);
  assert.match(sql, /credit_charged boolean NOT NULL DEFAULT true/);
  assert.match(sql, /IF NOT v_premium AND v_wallet\.purchased_rooms/);
  assert.match(sql, /IF v_usage\.credit_charged THEN/);
  assert.match(sql, /premium_until_after=v_subscription\.premium_until/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.royal_infinite_apply_payment/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.royal_infinite_apply_payment.*TO service_role/);
});
