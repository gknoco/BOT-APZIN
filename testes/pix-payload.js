'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const Module = require('node:module');
const path = require('node:path');
const { test, after } = require('node:test');
const pix = require('../src/servicos/pixPayload');
const mp = require('../src/servicos/mercadoPago');
const config = require('../src/config');

const originalConfig = { MP_ACCESS_TOKEN: config.MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET: config.MP_WEBHOOK_SECRET, MP_WEBHOOK_URL: config.MP_WEBHOOK_URL };
Object.assign(config, { MP_ACCESS_TOKEN: 'token-teste', MP_WEBHOOK_SECRET: 'segredo-teste', MP_WEBHOOK_URL: 'https://example.com/webhooks/mercadopago' });
after(() => Object.assign(config, originalConfig));
const ORDER_ID = '550e8400-e29b-41d4-a716-446655440000';
const t = pix.montarTLV;
function finalizar(corpo) { const prefixo = `${corpo}6304`; return `${prefixo}${pix.crc16Ccitt(prefixo)}`; }
function payload({ contaId = '26', gui = 'br.gov.bcb.pix', extra = '', nome = 'Fulano de Tal' } = {}) {
  const conta = t('00', gui) + t('01', 'chave@example.com') + (extra ? t('02', extra) : '');
  return finalizar(t('00', '01') + t(contaId, conta) + t('52', '0000') + t('53', '986') + t('58', 'BR') + t('59', nome) + t('60', 'BRASILIA') + t('62', t('05', '***')));
}
function pagamento(qrCode) {
  return { id: 123456, status: 'pending', point_of_interaction: { transaction_data: { qr_code: qrCode, qr_code_base64: 'cXI=' } } };
}
async function comFetch(mock, fn) {
  const original = global.fetch;
  global.fetch = mock;
  try { return await fn(); } finally { global.fetch = original; }
}
const inputPix = { order: { id: ORDER_ID, amount_cents: 1234 }, payerEmail: ' Buyer@example.com ' };

// Vetor publicado pelo Banco Central, não gerado pela implementação sob teste.
const BCB = '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D';
test('CRC padrão e vetor oficial do Banco Central', () => {
  assert.equal(pix.crc16Ccitt('123456789'), '29B1');
  assert.equal(pix.crc16Ccitt(BCB.slice(0, -4)), '1D3D');
  assert.equal(pix.validarPixPayloadExato(BCB), true);
  assert.equal(pix.validarPixPayload(BCB), BCB);
});
test('preserva crase, espaços, dígitos 63 nos valores e Unicode sem normalizar', () => {
  const valor = payload({ contaId: '51', gui: 'Br.GoV.BcB.PiX', extra: '  63`Pix café 👑  ' });
  assert.equal(pix.validarPixPayloadExato(valor), true);
  assert.equal(pix.validarPixPayload(valor), valor);
  assert.equal(pix.normalizarPixPayload(valor), valor);
  assert.equal(pix.limparPayload(valor), valor);
  assert.equal(t('80', '👑'), '8001👑');
});
test('rejeita TLV incompleto, IDs repetidos, CRC ausente ou inválido sem consertar', () => {
  const bom = payload({ extra: 'texto63' });
  const errado = `${bom.slice(0, -4)}${bom.endsWith('0000') ? '0001' : '0000'}`;
  const conta = t('00', 'br.gov.bcb.pix') + t('01', 'chave@example.com');
  const repetido = finalizar(t('00', '01') + t('26', conta) + t('59', 'A') + t('59', 'B'));
  const depoisDoCrc = `${bom}5901A`;
  for (const invalido of ['0002012603ABC', bom.slice(0, -8), errado, repetido, depoisDoCrc, ` ${bom}`, `${bom}\n`, 123, null]) {
    assert.equal(pix.validarPixPayloadExato(invalido), false, String(invalido));
    assert.equal(pix.validarPixPayload(invalido), false);
    assert.throws(() => pix.normalizarPixPayload(invalido));
  }
});
test('CRC que contém dígitos 63 nunca é confundido com início do campo', () => {
  let bom;
  for (let i = 0; i < 20000; i++) {
    const candidato = payload({ extra: `valor${i}` });
    if (candidato.slice(-4).includes('63')) { bom = candidato; break; }
  }
  assert.ok(bom);
  assert.equal(pix.normalizarPixPayload(bom), bom);
});
test('centavos de valores grandes não colidem por arredondamento', () => {
  assert.equal(mp.centavos('90071992547409.91'), Number.MAX_SAFE_INTEGER);
  assert.equal(mp.centavos('90071992547409.92'), null);
  assert.equal(mp.centavos('90071992547409.93'), null);
  assert.throws(() => mp.montarPayloadPix({ order: { id: ORDER_ID, amount_cents: 9007199254740987 }, email: 'x@y.com' }), (e) => e.code === 'mp_amount_invalid');
  assert.throws(() => mp.montarPayloadPix({ order: { id: ORDER_ID, amount_cents: 1.5 }, email: 'x@y.com' }), (e) => e.code === 'mp_amount_invalid');
});
test('criação entrega o código exato, corpo estável e chave idempotente', async () => {
  const codigo = payload({ contaId: '29', gui: 'BR.GOV.BCB.PIX', extra: ' com ` e 63 ' });
  const requests = [];
  await comFetch(async (url, options) => {
    requests.push({ url, ...options });
    return new Response(JSON.stringify(pagamento(codigo)), { status: 201 });
  }, async () => {
    const primeiro = await mp.criarPix(inputPix);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const segundo = await mp.criarPix(inputPix);
    assert.equal(primeiro.qrCode, codigo);
    assert.deepEqual(Buffer.from(primeiro.qrCode, 'utf8'), Buffer.from(codigo, 'utf8'));
    assert.equal(segundo.qrCode, codigo);
    assert.equal(requests[0].headers['X-Idempotency-Key'], ORDER_ID);
    assert.equal(requests[0].body, requests[1].body);
    assert.equal(JSON.parse(requests[0].body).transaction_amount, 12.34);
    assert.equal(JSON.parse(requests[0].body).payer.email, 'buyer@example.com');
    assert.equal(JSON.parse(requests[0].body).date_of_expiration, undefined);
  });
});
test('cobrança com QR inválido ou CRC adulterado fica em resultado incerto sem substituição', async () => {
  const bom = payload();
  for (const codigo of ['not-an-emv', `${bom.slice(0, -4)}0000`, bom.slice(0, -1)]) {
    await comFetch(async () => new Response(JSON.stringify(pagamento(codigo)), { status: 201 }), async () => {
      await assert.rejects(mp.criarPix(inputPix), (e) => e.code === 'mp_qr_invalid' && e.definitive === false);
    });
  }
});
test('HTTP 400 é rejeição e conflitos, limitação e falhas do servidor são incertos', async () => {
  for (const [status, definitive] of [[400, true], [408, false], [409, false], [423, false], [429, false], [500, false]]) {
    await comFetch(async () => new Response(JSON.stringify({ message: 'erro' }), { status }), async () => {
      await assert.rejects(mp.criarPix(inputPix), (e) => e.code === `mp_http_${status}` && e.definitive === definitive);
    });
  }
});
test('falha real na leitura do corpo não é convertida em resposta vazia', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(201, { 'content-type': 'application/json', 'content-length': 1000 });
    res.write('{"id":');
    setTimeout(() => res.destroy(), 20);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const realFetch = global.fetch;
  try {
    await comFetch((_url, options) => realFetch(`http://127.0.0.1:${server.address().port}/`, options), async () => {
      await assert.rejects(mp.criarPix(inputPix), (e) => e.code === 'mp_network_error' && e.definitive === false);
    });
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});
test('timeout real durante leitura de corpo é classificado como incerto', async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(201, { 'content-type': 'application/json', 'content-length': 1000 });
    res.write('{"id":');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const realFetch = global.fetch;
  const realSetTimeout = global.setTimeout;
  try {
    global.setTimeout = (fn, delay, ...args) => realSetTimeout(fn, delay === 12000 ? 80 : delay, ...args);
    await comFetch((_url, options) => realFetch(`http://127.0.0.1:${server.address().port}/`, options), async () => {
      await assert.rejects(mp.criarPix(inputPix), (e) => e.code === 'mp_timeout' && e.definitive === false);
    });
  } finally { global.setTimeout = realSetTimeout; server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
});

const db = {
  async criarRecarga() { return db.order; },
  async saldoUsuario() { return 888; },
  async obterRecargaUsuario() { return db.order; },
  async obterRecargaInterna() { return db.order; },
  async aplicarPagamento(args) { db.aplicado = args; return { status: args.status }; },
  async anexarPagamento(args) { db.anexado = args; return db.order; },
  async marcarFalha(args) { db.falha = args; },
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (Module._resolveFilename(request, parent, isMain) === path.resolve(__dirname, '../src/servicos/recargasSupabase.js')) return db;
  return originalLoad.call(this, request, parent, isMain);
};
let recargas;
try { recargas = require('../src/servicos/recargas'); } finally { Module._load = originalLoad; }
function topup(status) { return { id: ORDER_ID, amount_cents: 1234, status, mp_payment_id: '123456', pix_copy_paste: payload(), pix_qr_base64: 'cXI=' }; }
const inputRecarga = { guildId: 'guild', userId: 'user', requestId: 'request', amountCents: 1234, payerEmail: 'a@b.com' };
test('recarga aprovada ou em revisão não reexibe o código anteriormente salvo', async () => {
  db.order = topup('approved');
  const aprovado = await recargas.criarRecargaPix(inputRecarga);
  assert.equal(aprovado.order.balance_cents, 888);
  assert.equal(aprovado.payment, null);
  for (const status of ['manual_review', 'failed', 'rejected', 'cancelled', 'expired', 'refunded', 'charged_back']) {
    db.order = topup(status);
    await assert.rejects(recargas.criarRecargaPix(inputRecarga));
  }
  db.order = { ...topup('pending'), pix_copy_paste: null };
  await assert.rejects(recargas.criarRecargaPix(inputRecarga), /já tem pagamento vinculado/);
  db.order = topup('pending');
  assert.equal((await recargas.criarRecargaPix(inputRecarga)).payment.qrCode, db.order.pix_copy_paste);
});
test('verificação consulta estorno posterior mesmo quando recarga já estava aprovada', async () => {
  db.order = topup('approved'); db.aplicado = null;
  const valor = { id: '123456', status: 'refunded', transaction_amount: 12.34, transaction_amount_refunded: 12.34, currency_id: 'BRL', external_reference: ORDER_ID, payment_method_id: 'pix' };
  const buscar = mp.buscarPagamento;
  mp.buscarPagamento = async () => valor;
  try {
    await recargas.verificarRecarga({ topupId: ORDER_ID, guildId: 'guild', userId: 'user' });
    assert.equal(db.aplicado.status, 'refunded');
    assert.equal(db.aplicado.refundedCents, 1234);
  } finally { mp.buscarPagamento = buscar; }
});
test('estorno malformado não é tratado como zero nem autoriza crédito', async () => {
  db.order = topup('pending'); db.aplicado = null;
  const valor = { id: '123456', status: 'approved', transaction_amount: 12.34, transaction_amount_refunded: 'oops', currency_id: 'BRL', external_reference: ORDER_ID, payment_method_id: 'pix' };
  await assert.rejects(recargas.aplicarStatusPagamento(db.order, valor), /estorno inválido/);
  assert.equal(db.aplicado, null);
});
test('falha incerta de criação é persistida para revisão e não anexa Pix', async () => {
  db.order = { ...topup('creating'), mp_payment_id: null, pix_copy_paste: null, pix_qr_base64: null };
  db.falha = null; db.anexado = null;
  await comFetch(async () => { throw new Error('socket desconectado'); }, async () => {
    await assert.rejects(recargas.criarRecargaPix(inputRecarga), /incerto/);
  });
  assert.equal(db.falha.status, 'manual_review');
  assert.equal(db.falha.errorCode, 'mp_network_error');
  assert.equal(db.anexado, null);
});
test('divergência de valor aprovado mantém status original para a RPC detectar e registrar revisão', async () => {
  db.order = topup('pending'); db.aplicado = null;
  const valor = { id: '123456', status: 'approved', transaction_amount: 1.23, currency_id: 'BRL', external_reference: ORDER_ID, payment_method_id: 'pix' };
  assert.equal(recargas.validarPagamento(db.order, valor).reason, 'amount_mismatch');
  await recargas.aplicarStatusPagamento(db.order, valor);
  assert.equal(db.aplicado.status, 'approved');
  assert.equal(db.aplicado.amountCents, 123);
  const fs = require('node:fs');
  const migration = fs.readFileSync(path.resolve(__dirname, '../supabase/migrations/20261120002001_pag04_direct_room_refunds.sql'), 'utf8');
  assert.match(migration, /v_status = 'approved' AND COALESCE\(p_amount_cents, -1\) <> v_row\.amount_cents THEN v_reason := 'amount_mismatch'/);
  assert.match(migration, /IF v_reason IS NOT NULL THEN[\s\S]*?SET status = 'manual_review'/);
});
test('ID irrecuperável e imagem QR ilegível após criação exigem reconciliação', async () => {
  const respostas = [
    [{ ...pagamento(payload()), id: 'abc' }, 'mp_payment_id_invalid'],
    [{ ...pagamento(payload()), id: Number.MAX_SAFE_INTEGER + 1 }, 'mp_payment_id_invalid'],
    [{ ...pagamento(payload()), point_of_interaction: { transaction_data: { qr_code: payload(), qr_code_base64: 'não é base64' } } }, 'mp_qr_image_invalid'],
  ];
  for (const [resposta, codigo] of respostas) {
    await comFetch(async () => new Response(JSON.stringify(resposta), { status: 201 }), async () => {
      await assert.rejects(mp.criarPix(inputPix), (e) => e.code === codigo && e.definitive === false);
    });
  }
});
test('falha definitiva na consulta posterior não marca cobrança já criada como inexistente', async () => {
  db.order = { ...topup('creating'), mp_payment_id: null, pix_copy_paste: null, pix_qr_base64: null };
  db.falha = null;
  const criar = mp.criarPix, buscar = mp.buscarPagamento, obter = db.obterRecargaUsuario;
  mp.criarPix = async () => ({ id: '123456', status: 'approved', qrCode: payload(), qrBase64: 'cXI=' });
  db.obterRecargaUsuario = async () => topup('pending');
  mp.buscarPagamento = async () => { throw new mp.ErroMercadoPago('HTTP 404', { status: 404, definitive: true, code: 'mp_http_404' }); };
  try {
    await assert.rejects(recargas.criarRecargaPix(inputRecarga), /incerto/);
    assert.equal(db.falha.status, 'manual_review');
    assert.equal(db.falha.errorCode, 'mp_http_404');
  } finally { mp.criarPix = criar; mp.buscarPagamento = buscar; db.obterRecargaUsuario = obter; }
});
