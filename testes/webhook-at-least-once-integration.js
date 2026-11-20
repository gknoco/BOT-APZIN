'use strict';

// Executado pelo teste Python que cria o cluster PostgreSQL efêmero. O adapter
// SQL substitui somente o transporte Supabase; handler, worker, validação,
// decisão de compra e RPCs são os mesmos do aplicativo.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const config = require('../src/config');
const vendas = require('../src/servicos/roomSalesSupabase');
const compras = require('../src/servicos/comprasSalas');
const recargas = require('../src/servicos/recargas');
const mp = require('../src/servicos/mercadoPago');
const worker = require('../src/servicos/mercadoPagoWorker');
const { criarServidor } = require('../src/servidor');

const quote = (v) => v == null ? 'NULL' : `'${String(v).replaceAll("'", "''")}'`;
async function sql(statement, role = true) {
  const { stdout } = await exec('psql', ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c',
    (role ? 'SET ROLE service_role; ' : '') + statement], { env: process.env, timeout: 12000 });
  return stdout.trim();
}
async function obj(statement, role = true) { return JSON.parse(await sql(statement, role)); }
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}
function post(port, signature = true) {
  const body = JSON.stringify({ id: 'same-provider-id', type: 'payment', action: 'payment.updated', data: { id: '12345' } });
  const requestId = 'same-request-id';
  const ts = '1700000000';
  const digest = crypto.createHmac('sha256', 'local-test-secret')
    .update(`id:12345;request-id:${requestId};ts:${ts};`).digest('hex');
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/webhooks/mercadopago', method: 'POST', headers: {
      'content-type': 'application/json', 'x-request-id': requestId,
      'x-signature': `ts=${ts},v1=${signature ? digest : '0'.repeat(64)}`,
    } }, (res) => {
      let text = '';
      res.on('data', (data) => { text += data; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
async function main() {
  config.MP_WEBHOOK_SECRET = 'local-test-secret';
  config.MP_ACCESS_TOKEN = 'local-test-token';
  const order = await obj("SELECT royal_room_create_purchase('http-integration','u','http-integration-order',10,NULL,'u@example.com')");
  let enqueueReplyLost = false;
  let finishReplyLost = false;
  let providerFailure = false;
  let status = 'approved';
  let consults = 0;
  let firstStarted = deferred();
  let release = deferred();
  vendas.enfileirarEvento = async ({ eventKey, paymentId, action }) => {
    const result = await obj(`SELECT royal_room_enqueue_payment_event(${quote(eventKey)},${quote(paymentId)},${quote(action)})`);
    if (enqueueReplyLost) { enqueueReplyLost = false; throw new Error('lost reply after enqueue COMMIT'); }
    return result;
  };
  vendas.reivindicarEventos = async (limit) => obj(`SELECT COALESCE(json_agg(e),'[]'::json) FROM royal_room_claim_payment_events(${Number(limit)}) e`);
  vendas.finalizarEvento = async ({ eventId, attempt, success, errorCode }) => {
    await sql(`SELECT royal_room_finish_payment_event(${quote(eventId)},${success ? 'true' : 'false'},${quote(errorCode)},${Number(attempt)})`);
    if (success && finishReplyLost) { finishReplyLost = false; throw new Error('lost reply after ACK COMMIT'); }
  };
  vendas.obterPedidoInterno = async (id) => obj(`SELECT COALESCE((SELECT to_jsonb(o) FROM royal_room_purchase_orders o WHERE id=${quote(id)}),'null'::jsonb)`);
  vendas.aplicarPagamento = async (p) => obj(`SELECT royal_room_apply_payment(${quote(p.orderId)},${quote(p.paymentId)},${quote(p.status)},${p.amountCents == null ? 'NULL' : Number(p.amountCents)},${quote(p.currency)},${quote(p.externalReference)},${p.refundedCents == null ? 'NULL' : Number(p.refundedCents)},${quote(p.manualReason)})`);
  recargas.processarPagamentoWebhook = async () => ({ identificado: false });
  mp.buscarPagamento = async (id) => {
    consults++;
    if (providerFailure) { providerFailure = false; throw Object.assign(new Error('provider offline'), { code: 'ETIMEDOUT' }); }
    const snapshot = { id, status, transaction_amount: 0.30, currency_id: 'BRL', payment_method_id: 'pix', external_reference: order.id,
      transaction_amount_refunded: status === 'refunded' ? 0.30 : 0 };
    if (consults === 1) { firstStarted.resolve(); await release.promise; }
    return snapshot;
  };
  const server = criarServidor();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    assert.equal((await post(port, false)).status, 401);
    assert.equal(await sql('SELECT count(*) FROM royal_room_mp_webhook_events', false), '0');
    assert.equal((await post(port)).status, 200);
    const firstWorker = worker.processarLote();
    await firstStarted.promise; // provider respondeu snapshot aprovado, ainda não aplicado
    status = 'refunded';
    assert.equal((await post(port)).status, 200); // mesmo body.id/action durante processing
    release.resolve();
    await firstWorker;
    assert.equal(await sql("SELECT count(*) FROM royal_room_mp_webhook_events WHERE status='pending'", false), '1');
    await worker.processarLote();
    assert.equal(consults, 2);
    assert.equal(await sql(`SELECT status FROM royal_room_purchase_orders WHERE id=${quote(order.id)}`, false), 'refunded');
    assert.equal(await sql("SELECT purchased_rooms||':'||reversed_rooms FROM royal_room_wallets WHERE guild_id='http-integration'", false), '10:10');
    assert.equal(await sql(`SELECT count(*) FROM royal_room_ledger WHERE order_id=${quote(order.id)} AND event_type='reversed'`, false), '1');

    // Mesmo ID já finalizado ainda é outra consulta, inclusive se a resposta
    // da persistência foi perdida depois de COMMIT e o emissor retransmitiu.
    enqueueReplyLost = true;
    assert.equal((await post(port)).status, 500);
    assert.equal((await post(port)).status, 200);
    assert.equal(await sql("SELECT count(*) FROM royal_room_mp_webhook_events WHERE status='pending'", false), '2');
    await worker.processarLote();
    assert.equal(consults, 4);
    assert.equal(await sql("SELECT count(DISTINCT event_key) FROM royal_room_mp_webhook_events", false), '4');

    finishReplyLost = true;
    assert.equal((await post(port)).status, 200);
    await worker.processarLote(); // ACK com commit, resposta perdida, tentativa de retry é no-op
    assert.equal(await sql("SELECT count(*) FROM royal_room_mp_webhook_events WHERE status <> 'processed'", false), '0');
    assert.equal(consults, 5);

    providerFailure = true;
    assert.equal((await post(port)).status, 200);
    await worker.processarLote();
    assert.equal(await sql("SELECT count(*) FROM royal_room_mp_webhook_events WHERE status='pending' AND last_error='ETIMEDOUT'", false), '1');
    await sql("UPDATE royal_room_mp_webhook_events SET available_at=now() WHERE status='pending'", false);
    await worker.processarLote();
    assert.equal(consults, 7);
    assert.equal(await sql("SELECT count(*) FROM royal_room_mp_webhook_events WHERE status <> 'processed'", false), '0');
    assert.equal(await sql("SELECT purchased_rooms||':'||reversed_rooms FROM royal_room_wallets WHERE guild_id='http-integration'", false), '10:10');
    console.log('HTTP + worker + PostgreSQL: assinatura, recebimentos, corrida, ACK ambíguo e retry OK');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
