'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { test, after } = require('node:test');
const config = require('../src/config');
const estadoRuntime = require('../src/estadoRuntime');
const mercadoPago = require('../src/servicos/mercadoPago');
const mercadoPagoWebhook = require('../src/servicos/mercadoPagoWebhook');
const roomSales = require('../src/servicos/roomSalesSupabase');
const compras = require('../src/servicos/comprasSalas');
const recargas = require('../src/servicos/recargas');
const worker = require('../src/servicos/mercadoPagoWorker');
const servidor = require('../src/servidor');

const original = {
  secret: config.MP_WEBHOOK_SECRET,
  token: config.MP_ACCESS_TOKEN,
  assinatura: mercadoPago.assinaturaValida,
  enfileirar: roomSales.enfileirarEvento,
  reivindicar: roomSales.reivindicarEventos,
  finalizar: roomSales.finalizarEvento,
  buscar: mercadoPago.buscarPagamento,
  recarga: recargas.processarPagamentoWebhook,
  compra: compras.processarEventoWebhook,
};

function respostaHttp(porta, { method = 'GET', path = '/', body = '', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: porta, method, path, headers }, (res) => {
      let texto = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { texto += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: texto }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
async function comServidor(fn) {
  const srv = servidor.criarServidor();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  try { return await fn(srv.address().port); }
  finally { await new Promise((resolve) => srv.close(resolve)); }
}
function json(resposta) { return JSON.parse(resposta.body); }

after(() => {
  config.MP_WEBHOOK_SECRET = original.secret;
  config.MP_ACCESS_TOKEN = original.token;
  mercadoPago.assinaturaValida = original.assinatura;
  roomSales.enfileirarEvento = original.enfileirar;
  roomSales.reivindicarEventos = original.reivindicar;
  roomSales.finalizarEvento = original.finalizar;
  mercadoPago.buscarPagamento = original.buscar;
  recargas.processarPagamentoWebhook = original.recarga;
  compras.processarEventoWebhook = original.compra;
  worker.parar();
});

test('handler HTTP responde health, HEAD e rota desconhecida sem tocar no pagamento', async () => {
  await comServidor(async (porta) => {
    const health = await respostaHttp(porta, { path: '/health' });
    assert.equal(health.status, 200);
    assert.match(health.body, /Bot Royal AP Online e Operante!/);
    const head = await respostaHttp(porta, { method: 'HEAD', path: '/' });
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    const desconhecida = await respostaHttp(porta, { path: '/nao-existe' });
    assert.equal(desconhecida.status, 404);
    assert.match(desconhecida.body, /Not found/);
  });
});

test('handler HTTP valida configuração, JSON, assinatura e persiste evento de pagamento', async () => {
  const secretAntes = config.MP_WEBHOOK_SECRET;
  const assinaturaAntes = mercadoPago.assinaturaValida;
  const enfileirados = [];
  try {
    config.MP_WEBHOOK_SECRET = '';
    const semConfig = await comServidor((porta) => respostaHttp(porta, {
      method: 'POST', path: '/webhooks/mercadopago', body: '{}', headers: { 'content-type': 'application/json' },
    }));
    assert.equal(semConfig.status, 503);
    assert.deepEqual(json(semConfig), { error: 'webhook_not_configured' });

    config.MP_WEBHOOK_SECRET = 'secret-test';
    const invalido = await comServidor((porta) => respostaHttp(porta, {
      method: 'POST', path: '/webhooks/mercadopago', body: '{', headers: { 'content-type': 'application/json' },
    }));
    assert.equal(invalido.status, 400);
    assert.deepEqual(json(invalido), { error: 'invalid_json' });

    mercadoPago.assinaturaValida = () => false;
    const semAssinatura = await comServidor((porta) => respostaHttp(porta, {
      method: 'POST', path: '/webhooks/mercadopago?type=payment&data.id=123', body: '{}',
    }));
    assert.equal(semAssinatura.status, 401);
    assert.deepEqual(json(semAssinatura), { error: 'invalid_signature' });

    mercadoPago.assinaturaValida = () => true;
    roomSales.enfileirarEvento = async (evento) => { enfileirados.push(evento); };
    const body = JSON.stringify({ id: 'event-1', type: 'payment', data: { id: '123' }, action: 'payment.updated' });
    const aceito = await comServidor((porta) => respostaHttp(porta, {
      method: 'POST', path: '/webhooks/mercadopago', body,
      headers: { 'content-type': 'application/json', 'x-request-id': 'request-1', 'x-signature': 'ts=1,v1=test' },
    }));
    assert.equal(aceito.status, 200);
    assert.deepEqual(json(aceito), { received: true });
    assert.equal(enfileirados.length, 1);
    assert.match(enfileirados[0].eventKey, /^receipt:[0-9a-f-]{36}$/);
    assert.equal(enfileirados[0].paymentId, '123');
    assert.equal(enfileirados[0].action, 'payment.updated');
  } finally {
    config.MP_WEBHOOK_SECRET = secretAntes;
    mercadoPago.assinaturaValida = assinaturaAntes;
    roomSales.enfileirarEvento = original.enfileirar;
  }
});

test('worker processa recarga, encaminha compra quando necessário e confirma somente após persistência', async () => {
  const tokenAntes = config.MP_ACCESS_TOKEN;
  const chamadas = [];
  try {
    config.MP_ACCESS_TOKEN = 'token-test';
    roomSales.reivindicarEventos = async () => [
      { id: 'event-recarga', payment_id: '100', attempts: 1 },
      { id: 'event-compra', payment_id: '200', attempts: 1 },
    ];
    mercadoPago.buscarPagamento = async (id) => ({ id, status: 'approved', external_reference: `order-${id}` });
    recargas.processarPagamentoWebhook = async (pagamento) => {
      chamadas.push(`recarga:${pagamento.id}`);
      return { identificado: pagamento.id === '100', resultado: { status: 'approved' } };
    };
    compras.processarEventoWebhook = async (evento, pagamento) => {
      chamadas.push(`compra:${evento.id}:${pagamento.id}`);
      return { ignorado: false, resultado: { status: 'approved' } };
    };
    roomSales.finalizarEvento = async (dados) => { chamadas.push(`${dados.eventId}:${dados.success ? 'ack' : 'retry'}`); };

    await worker.processarLote();
    assert.deepEqual(chamadas, [
      'recarga:100', 'event-recarga:ack',
      'recarga:200', 'compra:event-compra:200', 'event-compra:ack',
    ]);
  } finally {
    config.MP_ACCESS_TOKEN = tokenAntes;
    roomSales.reivindicarEventos = original.reivindicar;
    roomSales.finalizarEvento = original.finalizar;
    mercadoPago.buscarPagamento = original.buscar;
    recargas.processarPagamentoWebhook = original.recarga;
    compras.processarEventoWebhook = original.compra;
  }
});

test('worker reprocessa com segurança quando a aplicação falha e não confirma o evento', async () => {
  const tokenAntes = config.MP_ACCESS_TOKEN;
  const chamadas = [];
  let tentativa = 0;
  try {
    config.MP_ACCESS_TOKEN = 'token-test';
    roomSales.reivindicarEventos = async () => [{ id: 'event-retry', payment_id: '300', attempts: tentativa + 1 }];
    mercadoPago.buscarPagamento = async () => ({ id: '300', status: 'approved', external_reference: 'order-300' });
    recargas.processarPagamentoWebhook = async () => {
      tentativa += 1;
      if (tentativa === 1) throw Object.assign(new Error('transporte'), { code: 'ETIMEDOUT' });
      return { identificado: true, resultado: { status: 'approved' } };
    };
    roomSales.finalizarEvento = async (dados) => { chamadas.push(dados); };

    await worker.processarLote();
    await worker.processarLote();
    assert.equal(tentativa, 2);
    assert.deepEqual(chamadas, [
      { eventId: 'event-retry', attempt: 1, success: false, errorCode: 'ETIMEDOUT' },
      { eventId: 'event-retry', attempt: 2, success: true },
    ]);
  } finally {
    config.MP_ACCESS_TOKEN = tokenAntes;
    roomSales.reivindicarEventos = original.reivindicar;
    roomSales.finalizarEvento = original.finalizar;
    mercadoPago.buscarPagamento = original.buscar;
    recargas.processarPagamentoWebhook = original.recarga;
  }
});
