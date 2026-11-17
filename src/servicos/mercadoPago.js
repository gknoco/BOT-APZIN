'use strict';

const crypto = require('crypto');
const config = require('../config');

const API = 'https://api.mercadopago.com';
const TIMEOUT_MS = 12000;

class ErroMercadoPago extends Error {
  constructor(message, { status = 0, definitive = false, code = 'mp_error' } = {}) {
    super(message);
    this.name = 'ErroMercadoPago';
    this.status = status;
    this.definitive = definitive;
    this.code = code;
  }
}

function ambienteCompleto() {
  return Boolean(config.MP_ACCESS_TOKEN && config.MP_WEBHOOK_SECRET && config.MP_WEBHOOK_URL);
}

function exigirAmbiente() {
  const faltam = [];
  if (!config.MP_ACCESS_TOKEN) faltam.push('MP_ACCESS_TOKEN');
  if (!config.MP_WEBHOOK_SECRET) faltam.push('MP_WEBHOOK_SECRET');
  if (!config.MP_WEBHOOK_URL) faltam.push('MP_WEBHOOK_URL');
  if (faltam.length) {
    throw new ErroMercadoPago(`Integração Pix ainda não configurada no Railway: ${faltam.join(', ')}.`, {
      code: 'mp_config_missing',
      definitive: true,
    });
  }
  let url;
  try {
    url = new URL(config.MP_WEBHOOK_URL);
  } catch {
    throw new ErroMercadoPago('MP_WEBHOOK_URL precisa ser uma URL HTTPS pública.', { code: 'mp_webhook_url_invalid', definitive: true });
  }
  if (url.protocol !== 'https:' || url.pathname.replace(/\/$/, '') !== '/webhooks/mercadopago') {
    throw new ErroMercadoPago('MP_WEBHOOK_URL deve terminar exatamente em /webhooks/mercadopago e usar HTTPS.', {
      code: 'mp_webhook_url_invalid',
      definitive: true,
    });
  }
}

function centavos(valor) {
  const texto = String(valor ?? '').trim();
  const achou = /^(\d+)(?:\.(\d{1,2}))?$/.exec(texto);
  if (!achou) return null;
  return Number(achou[1]) * 100 + Number((achou[2] || '').padEnd(2, '0') || 0);
}

function validarEmailPix(valor) {
  const email = String(valor || '').trim();
  if (email.length < 5 || email.length > 254 || /\s/.test(email)) return false;
  const partes = email.split('@');
  if (partes.length !== 2) return false;
  const [local, dominio] = partes;
  if (!local || local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return false;
  if (!/^[A-Z0-9._%+-]+$/i.test(local)) return false;
  const rotulos = dominio.split('.');
  return dominio.length <= 253 && rotulos.length >= 2 && rotulos.every((rotulo) =>
    rotulo.length > 0 && rotulo.length <= 63 && /^[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?$/i.test(rotulo),
  ) && /^[A-Z]{2,63}$/i.test(rotulos.at(-1));
}

function assinaturaValida({ signature, requestId, dataId, secret }) {
  if (!signature || !requestId || !dataId || !secret) return false;
  const partes = Object.fromEntries(
    String(signature)
      .split(',')
      .map((parte) => parte.trim().split('='))
      .filter((item) => item.length === 2)
      .map(([chave, valor]) => [chave, valor]),
  );
  const ts = partes.ts;
  const v1 = partes.v1;
  if (!/^\d+$/.test(String(ts || '')) || !/^[a-f0-9]{64}$/i.test(String(v1 || ''))) return false;
  const manifesto = `id:${String(dataId).trim().toLowerCase()};request-id:${String(requestId).trim()};ts:${ts};`;
  const esperado = crypto.createHmac('sha256', String(secret)).update(manifesto).digest();
  const recebido = Buffer.from(String(v1), 'hex');
  return esperado.length === recebido.length && crypto.timingSafeEqual(esperado, recebido);
}

async function requisitar(caminho, { metodo = 'GET', corpo, idempotencyKey } = {}) {
  if (!config.MP_ACCESS_TOKEN) {
    throw new ErroMercadoPago('MP_ACCESS_TOKEN não está configurado no Railway.', { code: 'mp_token_missing', definitive: true });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  if (typeof timer.unref === 'function') timer.unref();
  const headers = {
    Authorization: `Bearer ${config.MP_ACCESS_TOKEN}`,
    Accept: 'application/json',
  };
  if (corpo) headers['Content-Type'] = 'application/json';
  if (idempotencyKey) headers['X-Idempotency-Key'] = String(idempotencyKey);
  try {
    const response = await fetch(`${API}${caminho}`, {
      method: metodo,
      headers,
      body: corpo ? JSON.stringify(corpo) : undefined,
      signal: controller.signal,
    });
    const texto = await response.text().catch(() => '');
    let data = {};
    try { data = texto ? JSON.parse(texto) : {}; } catch { data = {}; }
    if (!response.ok) {
      throw new ErroMercadoPago(`Mercado Pago respondeu HTTP ${response.status}.`, {
        status: response.status,
        definitive: response.status >= 400 && response.status < 500,
        code: `mp_http_${response.status}`,
      });
    }
    return data;
  } catch (error) {
    if (error instanceof ErroMercadoPago) throw error;
    const abortado = error?.name === 'AbortError';
    throw new ErroMercadoPago(abortado ? 'Tempo limite ao falar com o Mercado Pago.' : 'Falha de rede ao falar com o Mercado Pago.', {
      code: abortado ? 'mp_timeout' : 'mp_network_error',
      definitive: false,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function criarPix({ order, payerEmail, description }) {
  exigirAmbiente();
  if (!order?.id || !Number.isInteger(Number(order.amount_cents)) || Number(order.amount_cents) < 1) {
    throw new ErroMercadoPago('Pedido inválido para gerar Pix.', { code: 'mp_order_invalid', definitive: true });
  }
  const email = String(payerEmail || '').trim().toLowerCase();
  if (!validarEmailPix(email)) {
    throw new ErroMercadoPago('Informe um e-mail válido do pagador.', { code: 'mp_email_invalid', definitive: true });
  }
  const corpo = {
    transaction_amount: Number((Number(order.amount_cents) / 100).toFixed(2)),
    payment_method_id: 'pix',
    description: String(description || `${Number(order.rooms_quantity)} sala(s) automatizada(s) · Royal Sala`).slice(0, 250),
    external_reference: String(order.id),
    payer: { email },
    date_of_expiration: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    notification_url: config.MP_WEBHOOK_URL,
  };
  // A chave é o UUID persistido do pedido e fica estável em qualquer retry da mesma compra.
  const pagamento = await requisitar('/v1/payments', {
    metodo: 'POST',
    corpo,
    idempotencyKey: String(order.id),
  });
  const transacao = pagamento?.point_of_interaction?.transaction_data || {};
  if (!pagamento?.id || !transacao.qr_code || !transacao.qr_code_base64) {
    throw new ErroMercadoPago('O pagamento foi criado, mas o Mercado Pago não retornou o Pix copia e cola; verifique o status antes de tentar novamente.', {
      status: 201,
      definitive: false,
      code: 'mp_qr_missing',
    });
  }
  return {
    id: String(pagamento.id),
    status: String(pagamento.status || 'pending').toLowerCase(),
    qrCode: String(transacao.qr_code),
    qrBase64: transacao.qr_code_base64 ? String(transacao.qr_code_base64) : null,
    ticketUrl: transacao.ticket_url ? String(transacao.ticket_url) : null,
    expiresAt: pagamento.date_of_expiration || null,
  };
}

async function buscarPagamento(paymentId) {
  const id = String(paymentId || '').trim();
  if (!/^\d{1,32}$/.test(id)) throw new ErroMercadoPago('Identificador de pagamento inválido.', { code: 'mp_payment_id_invalid', definitive: true });
  return requisitar(`/v1/payments/${encodeURIComponent(id)}`);
}

module.exports = {
  API,
  ErroMercadoPago,
  ambienteCompleto,
  exigirAmbiente,
  centavos,
  validarEmailPix,
  assinaturaValida,
  requisitar,
  criarPix,
  buscarPagamento,
};
