'use strict';

const config = require('../config');
const mp = require('./mercadoPago');
const vendas = require('./roomSalesSupabase');
const compras = require('./comprasSalas');

const ROTA = '/webhooks/mercadopago';
const MAX_BODY = 64 * 1024;

function enviar(res, status, body) {
  if (res.headersSent) return;
  const texto = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(texto),
    'Cache-Control': 'no-store',
  });
  res.end(texto);
  return true;
}

function lerBody(req) {
  return new Promise((resolve, reject) => {
    let texto = '';
    let excedeuLimite = false;
    req.setEncoding('utf8');
    req.on('data', (parte) => {
      if (excedeuLimite) return;
      texto += parte;
      if (Buffer.byteLength(texto) > MAX_BODY) excedeuLimite = true;
    });
    req.on('end', () => excedeuLimite
      ? reject(Object.assign(new Error('payload_too_large'), { code: 'payload_too_large' }))
      : resolve(texto));
    req.on('error', reject);
  });
}

async function tratar(req, res) {
  let url;
  try { url = new URL(req.url || '/', 'http://localhost'); } catch { return false; }
  if (url.pathname !== ROTA) return false;
  if (req.method === 'GET') return enviar(res, 200, { ok: true, service: 'royal-sala-webhook' });
  if (req.method !== 'POST') return enviar(res, 405, { error: 'method_not_allowed' });
  if (!config.MP_WEBHOOK_SECRET) return enviar(res, 503, { error: 'webhook_not_configured' });

  let body;
  try {
    const raw = await lerBody(req);
    body = raw ? JSON.parse(raw) : {};
  } catch (error) {
    return enviar(res, error?.code === 'payload_too_large' ? 413 : 400, { error: error?.code || 'invalid_json' });
  }

  const topic = String(url.searchParams.get('type') || url.searchParams.get('topic') || body?.type || '').toLowerCase();
  if (topic && topic !== 'payment') return enviar(res, 200, { received: true, ignored: true });
  const paymentId = String(
    url.searchParams.get('data.id') || url.searchParams.get('data_id') || body?.data?.id || '',
  ).trim();
  if (!/^\d{1,32}$/.test(paymentId)) return enviar(res, 400, { error: 'invalid_payment_id' });
  const requestId = String(req.headers['x-request-id'] || '').trim();
  const signature = String(req.headers['x-signature'] || '');
  if (!mp.assinaturaValida({ signature, requestId, dataId: paymentId, secret: config.MP_WEBHOOK_SECRET })) {
    return enviar(res, 401, { error: 'invalid_signature' });
  }

  try {
    const eventKey = compras.chaveEvento(body, paymentId);
    await vendas.enfileirarEvento({ eventKey, paymentId, action: body?.action || body?.type || 'payment.updated' });
    return enviar(res, 200, { received: true });
  } catch (error) {
    console.error('[mp-webhook] não consegui persistir uma notificação válida:', error.message);
    return enviar(res, 500, { error: 'event_persistence_failed' });
  }
}

module.exports = { ROTA, MAX_BODY, enviar, lerBody, tratar };
