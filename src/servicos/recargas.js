'use strict';

const crypto = require('node:crypto');
const mp = require('./mercadoPago');
const db = require('./recargasSupabase');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function valorEmCentavos(valor) {
  let texto = String(valor ?? '').trim().replace(/^R\$\s*/i, '');
  if (!texto || /\s/.test(texto)) return null;
  if (texto.includes(',') && texto.includes('.')) return null;
  if (texto.includes(',')) texto = texto.replace(',', '.');
  const partes = /^(\d+)(?:\.(\d{1,2}))?$/.exec(texto);
  if (!partes) return null;
  const inteiro = Number(partes[1]);
  const centavos = Number((partes[2] || '').padEnd(2, '0') || 0);
  const total = inteiro * 100 + centavos;
  return Number.isSafeInteger(total) && total > 0 ? total : null;
}

function resumoErro(error) {
  return String(error?.code || (error?.status ? `mp_http_${error.status}` : error?.name || 'mp_processing_error')).slice(0, 80);
}

async function criarRecargaPix({ guildId, userId, requestId, amountCents, payerEmail }) {
  if (!guildId || !userId || !requestId) throw new Error('Não consegui identificar servidor, usuário ou solicitação da recarga.');
  if (!Number.isSafeInteger(Number(amountCents)) || Number(amountCents) < 1) throw new Error('Informe um valor de recarga válido e maior que zero.');
  const email = String(payerEmail || '').trim().toLowerCase();
  if (!mp.validarEmailPix(email)) throw new Error('Informe um e-mail válido para gerar o Pix.');
  mp.exigirAmbiente();

  const order = await db.criarRecarga({
    guildId,
    userId,
    requestId,
    amountCents: Number(amountCents),
    payerEmail: email,
  });
  if (order.mp_payment_id && order.pix_copy_paste && order.pix_qr_base64) {
    return {
      order,
      payment: {
        id: String(order.mp_payment_id),
        status: order.mp_status || order.status,
        qrCode: order.pix_copy_paste,
        qrBase64: order.pix_qr_base64,
        ticketUrl: order.ticket_url,
        expiresAt: order.expires_at,
      },
    };
  }
  if (order.status === 'approved') {
    return { order: { ...order, balance_cents: await db.saldoUsuario(guildId, userId) }, payment: null };
  }
  if (order.status === 'failed') throw new Error('Esta tentativa de recarga foi recusada. Inicie uma nova solicitação.');
  if (order.status === 'manual_review') throw new Error('A solicitação ficou com resultado incerto. Não gere outro Pix para esta tentativa; procure a administração.');

  try {
    const payment = await mp.criarPix({
      order: { id: order.id, amount_cents: order.amount_cents },
      payerEmail: email,
      description: 'Recarga da carteira digital · ORG Royal AP',
    });
    const atualizado = await db.anexarPagamento({
      topupId: order.id,
      paymentId: payment.id,
      qrCode: payment.qrCode,
      qrBase64: payment.qrBase64,
      ticketUrl: payment.ticketUrl,
      expiresAt: payment.expiresAt,
    });
    if (payment.status === 'approved') {
      const aprovado = await verificarRecarga({ topupId: order.id, guildId, userId });
      return { order: aprovado, payment };
    }
    return { order: atualizado, payment };
  } catch (error) {
    const status = error?.definitive ? 'failed' : 'manual_review';
    await db.marcarFalha({ topupId: order.id, status, errorCode: resumoErro(error) }).catch((dbError) => {
      console.error('[recargas] falha ao salvar resultado incerto no Supabase:', dbError.message);
    });
    if (status === 'manual_review') {
      throw new Error('O resultado da solicitação ao Mercado Pago ficou incerto. Não gere outro Pix; aguarde ou procure a administração.');
    }
    throw new Error(error.message || 'Não consegui criar o Pix. Confira a integração Mercado Pago.');
  }
}

function validarPagamento(order, payment) {
  const amountCents = mp.centavos(payment?.transaction_amount);
  const externalReference = String(payment?.external_reference || '');
  let reason = null;
  if (externalReference !== String(order.id)) reason = 'external_reference_mismatch';
  else if (String(payment?.currency_id || '').toUpperCase() !== 'BRL') reason = 'currency_mismatch';
  else if (String(payment?.payment_method_id || '').toLowerCase() !== 'pix') reason = 'payment_method_mismatch';
  else if (order.mp_payment_id && String(order.mp_payment_id) !== String(payment?.id || '')) reason = 'payment_id_mismatch';
  else if (String(payment?.status || '').toLowerCase() === 'approved' && amountCents !== Number(order.amount_cents)) reason = 'amount_mismatch';
  return { amountCents, externalReference, reason };
}

async function aplicarStatusPagamento(order, payment) {
  if (!payment?.id) throw new Error('O Mercado Pago não retornou um ID de pagamento válido.');
  const { amountCents, externalReference, reason } = validarPagamento(order, payment);
  const refundedCents = mp.centavos(payment.transaction_amount_refunded) ?? 0;
  return db.aplicarPagamento({
    topupId: order.id,
    paymentId: String(payment.id),
    status: reason ? 'manual_review' : String(payment.status || 'pending').toLowerCase(),
    amountCents,
    currency: payment.currency_id || null,
    externalReference,
    paymentMethod: payment.payment_method_id || null,
    refundedCents,
  });
}

async function verificarRecarga({ topupId, guildId, userId }) {
  if (!UUID.test(String(topupId || ''))) throw new Error('Identificador de recarga inválido.');
  const order = await db.obterRecargaUsuario({ topupId, guildId, userId });
  if (!order) throw new Error('Esta recarga não pertence à sua carteira.');
  if (order.status === 'approved') return { ...order, balance_cents: await db.saldoUsuario(guildId, userId) };
  if (!order.mp_payment_id) {
    if (order.status === 'manual_review') throw new Error('Esta recarga está em revisão. Não gere outro Pix; procure a administração.');
    throw new Error('O Mercado Pago ainda não vinculou um pagamento a esta recarga. Aguarde e tente verificar novamente.');
  }
  const payment = await mp.buscarPagamento(order.mp_payment_id);
  return aplicarStatusPagamento(order, payment);
}

async function processarPagamentoWebhook(payment) {
  const topupId = String(payment?.external_reference || '');
  if (!UUID.test(topupId)) return { identificado: false, ignorado: true, motivo: 'external_reference_not_topup' };
  const order = await db.obterRecargaInterna(topupId);
  if (!order) return { identificado: false, ignorado: true, motivo: 'topup_not_found' };
  const resultado = await aplicarStatusPagamento(order, payment);
  return { identificado: true, ignorado: false, resultado };
}

async function codigoPixUsuario({ topupId, guildId, userId }) {
  if (!UUID.test(String(topupId || ''))) return null;
  return db.obterCodigoPixUsuario({ topupId, guildId, userId });
}

function novoRequestId() {
  return crypto.randomUUID();
}

module.exports = {
  UUID,
  valorEmCentavos,
  resumoErro,
  criarRecargaPix,
  validarPagamento,
  aplicarStatusPagamento,
  verificarRecarga,
  processarPagamentoWebhook,
  codigoPixUsuario,
  novoRequestId,
};
