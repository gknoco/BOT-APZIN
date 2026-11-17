'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { test } = require('node:test');

const mp = {
  exigirAmbiente() { mp.ambienteExigido = true; },
  validarEmailPix: (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
  centavos(valor) {
    const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(valor ?? ''));
    return match ? Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0') || 0) : null;
  },
  async criarPix(input) { mp.pixArgs = input; return mp.pix; },
  async buscarPagamento(id) { mp.buscarId = id; return mp.pagamento; },
};
const supabase = {
  async criarRecarga(input) { supabase.createArgs = input; return supabase.order; },
  async anexarPagamento(input) { supabase.attachArgs = input; return { ...supabase.order, status: 'pending', mp_payment_id: input.paymentId }; },
  async marcarFalha(input) { supabase.failureArgs = input; },
  async obterRecargaUsuario(input) { supabase.ownerArgs = input; return supabase.order; },
  async obterCodigoPixUsuario(input) { supabase.codeArgs = input; return '000201pixcode'; },
  async aplicarPagamento(input) { supabase.applyArgs = input; return supabase.applied; },
  async saldoUsuario(guildId, userId) { supabase.balanceArgs = [guildId, userId]; return 1345; },
};
const loadOriginal = Module._load;
Module._load = function loadMock(request, parent, isMain) {
  const filename = Module._resolveFilename(request, parent, isMain);
  if (filename === path.resolve(__dirname, '../src/servicos/mercadoPago.js')) return mp;
  if (filename === path.resolve(__dirname, '../src/servicos/recargasSupabase.js')) return supabase;
  return loadOriginal.call(this, request, parent, isMain);
};
let recargas;
try { recargas = require('../src/servicos/recargas'); }
finally { Module._load = loadOriginal; }
const modais = require('../src/interacoes/modais');
const botoes = require('../src/interacoes/botoes');

const ORDER_ID = '550e8400-e29b-41d4-a716-446655440000';
function preparar() {
  mp.ambienteExigido = false;
  mp.pixArgs = null;
  mp.buscarId = null;
  mp.pagamento = null;
  mp.pix = { id: '123456789', status: 'pending', qrCode: '000201PIX', qrBase64: Buffer.from('qr').toString('base64'), ticketUrl: null, expiresAt: '2026-11-18T00:00:00.000Z' };
  supabase.createArgs = null;
  supabase.attachArgs = null;
  supabase.failureArgs = null;
  supabase.ownerArgs = null;
  supabase.codeArgs = null;
  supabase.applyArgs = null;
  supabase.applied = null;
  supabase.order = {
    id: ORDER_ID,
    guild_id: 'guild-a',
    user_id: 'user-a',
    amount_cents: 1234,
    status: 'creating',
    mp_payment_id: null,
    expires_at: null,
  };
}

test('parser aceita decimal com vírgula/ponto e não aceita valor zero, precisão excedente ou formatos ambíguos', () => {
  assert.equal(recargas.valorEmCentavos('10,00'), 1000);
  assert.equal(recargas.valorEmCentavos('0.01'), 1);
  assert.equal(recargas.valorEmCentavos('10'), 1000);
  assert.equal(recargas.valorEmCentavos('0'), null);
  assert.equal(recargas.valorEmCentavos('1,234'), null);
  assert.equal(recargas.valorEmCentavos('1.000,00'), null);
  assert.equal(recargas.valorEmCentavos('1e2'), null);
  assert.equal(recargas.valorEmCentavos('999999999999999999999'), null);
});

test('botão Gerar Pix abre modal com valor/e-mail exigidos e sem ACK deferido', async () => {
  let modal;
  let deferido = false;
  const interaction = {
    customId: 'ap:recargapix',
    user: { id: 'user-a' },
    showModal: async (payload) => { modal = payload; },
    deferUpdate: async () => { deferido = true; },
  };
  assert.equal(await botoes.handleBotao(interaction, { db: {}, client: {} }), true);
  assert.equal(deferido, false);
  const json = modal.toJSON();
  assert.equal(json.custom_id, 'ap:modalrecarga');
  assert.equal(json.title, 'Gerar Pix de Recarga');
  const campos = json.components.flatMap((row) => row.components);
  assert.deepEqual(campos.map((campo) => [campo.custom_id, campo.label, campo.placeholder]), [
    ['valor', 'Valor da recarga', 'Ex: 10,00 ou 0.01'],
    ['email', 'E-mail (Gmail)', 'seuemail@gmail.com'],
  ]);
  assert.ok(campos.every((campo) => campo.required));
});

test('cria pedido persistente antes do Pix e anexa o código/QR à solicitação do mesmo usuário', async () => {
  preparar();
  const resultado = await recargas.criarRecargaPix({
    guildId: 'guild-a', userId: 'user-a', requestId: 'discord-interaction-1', amountCents: 1234, payerEmail: 'buyer@example.com',
  });
  assert.equal(mp.ambienteExigido, true);
  assert.deepEqual(supabase.createArgs, {
    guildId: 'guild-a', userId: 'user-a', requestId: 'discord-interaction-1', amountCents: 1234, payerEmail: 'buyer@example.com',
  });
  assert.equal(mp.pixArgs.order.id, ORDER_ID);
  assert.equal(mp.pixArgs.order.amount_cents, 1234);
  assert.equal(mp.pixArgs.description, 'Recarga da carteira digital · ORG Royal AP');
  assert.equal(mp.pixArgs.payerEmail, 'buyer@example.com');
  assert.equal(supabase.attachArgs.topupId, ORDER_ID);
  assert.equal(supabase.attachArgs.paymentId, '123456789');
  assert.equal(resultado.payment.qrCode, '000201PIX');
});

test('submissão do modal devolve QR, copia-e-cola e verificar pagamento em resposta privada', async () => {
  preparar();
  supabase.order = { ...supabase.order, bonus_cents: 123, credit_cents: 1357 };
  let payload;
  let deferPayload;
  const interaction = {
    customId: 'ap:modalrecarga',
    guildId: 'guild-a',
    id: 'discord-modal-request',
    user: { id: 'user-a' },
    fields: { getTextInputValue: (id) => ({ valor: '12,34', email: 'buyer@example.com' })[id] || '' },
    deferred: false,
    replied: false,
    deferReply: async (value) => { deferPayload = value; interaction.deferred = true; },
    reply: async (value) => { payload = value; interaction.replied = true; },
    editReply: async (value) => { payload = value; },
    followUp: async (value) => { payload = value; },
  };
  await modais.handleModal(interaction, { db: {}, client: {} });
  assert.equal(supabase.createArgs.amountCents, 1234);
  assert.equal(supabase.createArgs.userId, 'user-a');
  assert.ok(deferPayload.flags);
  assert.match(payload.embeds[0].toJSON().description, /R\$ 12,34/);
  assert.match(payload.embeds[0].toJSON().description, /\*\*Bônus Royal AP \(10%\):\*\* \+R\$ 1,23/);
  assert.doesNotMatch(payload.embeds[0].toJSON().description, /000201PIX|Pix Copia e Cola/);
  assert.equal(payload.files[0].name, 'royal-wallet-topup-qr.png');
  const components = payload.components.flatMap((row) => row.toJSON().components);
  assert.deepEqual(components.map((item) => [item.label, item.custom_id]), [
    ['Copia e Cola', `ap:copiarrecarga:${ORDER_ID}`],
    ['Verificar pagamento', `ap:verificarrecarga:${ORDER_ID}`],
  ]);
});

test('verificação consulta a recarga sob guild/user do clique e só repassa pagamento aprovado verificado ao RPC', async () => {
  preparar();
  supabase.order = { ...supabase.order, status: 'pending', mp_payment_id: '123456789' };
  mp.pagamento = {
    id: '123456789', status: 'approved', transaction_amount: 12.34,
    currency_id: 'BRL', external_reference: ORDER_ID, payment_method_id: 'pix',
  };
  supabase.applied = { ...supabase.order, status: 'approved', balance_cents: 1345 };
  const result = await recargas.verificarRecarga({ topupId: ORDER_ID, guildId: 'guild-a', userId: 'user-a' });
  assert.deepEqual(supabase.ownerArgs, { topupId: ORDER_ID, guildId: 'guild-a', userId: 'user-a' });
  assert.equal(mp.buscarId, '123456789');
  assert.deepEqual(supabase.applyArgs, {
    topupId: ORDER_ID,
    paymentId: '123456789',
    status: 'approved',
    amountCents: 1234,
    currency: 'BRL',
    externalReference: ORDER_ID,
    paymentMethod: 'pix',
  });
  assert.equal(result.status, 'approved');
});

test('pagamento com referência, moeda, método ou valor divergente nunca é encaminhado como aprovado', () => {
  const order = { id: ORDER_ID, amount_cents: 1000, mp_payment_id: '123456789' };
  for (const payment of [
    { id: '123456789', status: 'approved', transaction_amount: 10, currency_id: 'BRL', external_reference: 'outro', payment_method_id: 'pix' },
    { id: '123456789', status: 'approved', transaction_amount: 10, currency_id: 'USD', external_reference: ORDER_ID, payment_method_id: 'pix' },
    { id: '123456789', status: 'approved', transaction_amount: 10, currency_id: 'BRL', external_reference: ORDER_ID, payment_method_id: 'credit_card' },
    { id: '123456789', status: 'approved', transaction_amount: 9.99, currency_id: 'BRL', external_reference: ORDER_ID, payment_method_id: 'pix' },
  ]) {
    assert.ok(recargas.validarPagamento(order, payment).reason);
  }
});

test('migração credita bônus anunciado somente a partir de R$ 10 e valida antes de alterar saldo', () => {
  const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20261117001100_royal_wallet_topups.sql'), 'utf8');
  assert.match(migration, /p_amount_cents >= 1000 THEN round\(p_amount_cents \* 0\.10\)/);
  assert.match(migration, /ELSIF v_status = 'approved' AND COALESCE\(p_amount_cents, -1\) <> v_row\.amount_cents THEN v_reason := 'amount_mismatch'/);
  assert.match(migration, /ELSIF COALESCE\(upper\(p_currency\), ''\) <> 'BRL' THEN v_reason := 'currency_mismatch'/);
  assert.match(migration, /ELSIF COALESCE\(lower\(p_payment_method\), ''\) <> 'pix' THEN v_reason := 'payment_method_mismatch'/);
  assert.match(migration, /'topup:' \|\| v_row\.id::text/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.royal_wallet_apply_topup_payment/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.royal_wallet_apply_topup_payment.*TO service_role/);
});

test('consulta de código Pix mantém o filtro de servidor e usuário dono', async () => {
  preparar();
  const code = await recargas.codigoPixUsuario({ topupId: ORDER_ID, guildId: 'guild-a', userId: 'user-a' });
  assert.equal(code, '000201pixcode');
  assert.deepEqual(supabase.codeArgs, { topupId: ORDER_ID, guildId: 'guild-a', userId: 'user-a' });
});

test('botão Copia e Cola da recarga responde somente o código Pix contínuo, sem espaços ou cercas', async () => {
  const chamadas = [];
  const loadOriginal = Module._load;
  Module._load = function loadRecargasMock(request, parent, isMain) {
    const filename = Module._resolveFilename(request, parent, isMain);
    if (filename === path.resolve(__dirname, '../src/servicos/recargas.js')) {
      return { codigoPixUsuario: async (args) => {
        assert.deepEqual(args, { topupId: ORDER_ID, guildId: 'guild-a', userId: 'user-a' });
        return ' 000201\r\nPI X ` CODE  ';
      } };
    }
    return loadOriginal.call(this, request, parent, isMain);
  };
  const interaction = {
    customId: `ap:copiarrecarga:${ORDER_ID}`, guildId: 'guild-a', user: { id: 'user-a' }, deferred: false, replied: false,
    isMessageComponent: () => true,
    deferUpdate: async () => { interaction.deferred = true; chamadas.push(['deferUpdate']); },
    followUp: async (payload) => { chamadas.push(['followUp', payload]); },
  };
  try {
    await botoes.handleBotao(interaction, { db: {}, client: {} });
  } finally {
    Module._load = loadOriginal;
  }
  const resposta = chamadas.find(([nome]) => nome === 'followUp')[1];
  assert.equal(resposta.content, '000201PIXCODE');
  assert.doesNotMatch(resposta.content, /\s|`/);
  assert.equal(resposta.flags & 64, 64);
});
