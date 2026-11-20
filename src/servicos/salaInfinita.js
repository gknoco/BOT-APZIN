'use strict';

const crypto = require('node:crypto');
const mp = require('./mercadoPago');
const db = require('./salaInfinitaSupabase');

const PLANOS = Object.freeze({
  semanal: Object.freeze({ dias: 7, amountCents: 500, nome: 'Semanal' }),
  mensal: Object.freeze({ dias: 30, amountCents: 1300, nome: 'Mensal' }),
});
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validarPagamento(order, payment) {
  const amountCents = mp.centavos(payment?.transaction_amount);
  let reason = null;
  if (String(payment?.external_reference || '') !== String(order.id)) reason = 'external_reference_mismatch';
  else if (String(payment?.currency_id || '').toUpperCase() !== 'BRL') reason = 'currency_mismatch';
  else if (String(payment?.payment_method_id || '').toLowerCase() !== 'pix') reason = 'payment_method_mismatch';
  else if (order.mp_payment_id && String(order.mp_payment_id) !== String(payment?.id || '')) reason = 'payment_id_mismatch';
  else if (String(payment?.status || '').toLowerCase() === 'approved' && amountCents !== Number(order.amount_cents)) reason = 'amount_mismatch';
  return { amountCents, reason };
}

function resumoErro(error) {
  return String(error?.code || (error?.status ? `mp_http_${error.status}` : error?.name || 'mp_error')).slice(0, 80);
}

async function aplicarPagamento(order, payment) {
  if (!payment?.id) throw new Error('O Mercado Pago não retornou um identificador de pagamento válido.');
  const { amountCents, reason } = validarPagamento(order, payment);
  return db.aplicarPagamento({
    orderId: order.id,
    paymentId: String(payment.id),
    status: reason ? 'manual_review' : String(payment.status || 'pending').toLowerCase(),
    amountCents,
    currency: payment.currency_id || null,
    externalReference: payment.external_reference || null,
    paymentMethod: payment.payment_method_id || null,
  });
}

async function criarPixPlano({ guildId, userId, requestId, plan, payerEmail }) {
  const plano = PLANOS[String(plan || '')];
  if (!guildId || !userId || !requestId) throw new Error('Não consegui identificar servidor, usuário ou solicitação do plano.');
  if (!plano) throw new Error('Plano Sala Infinita inválido.');
  const email = String(payerEmail || '').trim().toLowerCase();
  if (!mp.validarEmailPix(email)) throw new Error('Informe um e-mail válido para gerar o Pix.');
  mp.exigirAmbiente();
  const order = await db.criarPedido({ guildId, userId, requestId, plan, payerEmail: email });
  if (order.status === 'approved') return { order, payment: null };
  if (order.status === 'failed') throw new Error('Esta solicitação de pagamento falhou. Inicie uma nova tentativa.');
  if (order.status === 'manual_review') throw new Error('A solicitação está em revisão. Não faça outro Pix; procure a administração.');
  if (['rejected', 'cancelled', 'expired', 'refunded', 'charged_back'].includes(order.status)) {
    throw new Error('Este pedido não está pendente de pagamento. Não pague o Pix antigo; consulte a administração.');
  }
  if (order.mp_payment_id && order.pix_copy_paste && order.pix_qr_base64) {
    return { order, payment: { id: String(order.mp_payment_id), status: order.mp_status || order.status, qrCode: order.pix_copy_paste,
      qrBase64: order.pix_qr_base64, expiresAt: order.expires_at, ticketUrl: order.ticket_url } };
  }
  let payment;
  try {
    payment = await mp.criarPix({
      order: { id: order.id, amount_cents: order.amount_cents },
      payerEmail: email,
      description: `Sala Infinita ${plano.nome} · Royal AP`,
    });
    const atualizado = await db.anexarPagamento({
      orderId: order.id, paymentId: payment.id, qrCode: payment.qrCode, qrBase64: payment.qrBase64,
      ticketUrl: payment.ticketUrl, expiresAt: payment.expiresAt,
    });
    if (payment.status === 'approved') {
      // criarPix retorna somente dados de apresentação; a validação precisa
      // consultar o pagamento completo (valor, moeda, método e referência).
      const verificado = await mp.buscarPagamento(payment.id);
      return { order: await aplicarPagamento(atualizado, verificado), payment };
    }
    return { order: atualizado, payment };
  } catch (error) {
    // Após a criação, até uma falha definitiva ao consultar/gravar não desfaz o Pix.
    const status = !payment && error?.definitive ? 'failed' : 'manual_review';
    await db.marcarFalha({ orderId: order.id, status, errorCode: resumoErro(error) }).catch((dbError) => {
      console.error('[sala-infinita] falha ao salvar estado do pedido:', dbError.message);
    });
    if (status === 'manual_review') throw new Error('O resultado do Mercado Pago ficou incerto. Não gere outro Pix para esta solicitação; procure a administração.');
    throw new Error(error.message || 'Não consegui gerar o Pix do plano Sala Infinita.');
  }
}

async function verificarPlano({ orderId, guildId, userId }) {
  if (!UUID.test(String(orderId || ''))) throw new Error('Identificador do pedido inválido.');
  const order = await db.obterPedidoUsuario({ orderId, guildId, userId });
  if (!order) throw new Error('Este pedido não pertence à sua conta neste servidor.');
  if (order.status === 'approved') return order;
  if (!order.mp_payment_id && order.status === 'manual_review') throw new Error('Esta solicitação está em revisão. Não gere outro Pix; procure a administração.');
  if (!order.mp_payment_id) throw new Error('O Mercado Pago ainda não vinculou um pagamento a esta solicitação. Aguarde e tente novamente.');
  const payment = await mp.buscarPagamento(order.mp_payment_id);
  return aplicarPagamento(order, payment);
}

async function codigoPixUsuario({ orderId, guildId, userId }) {
  if (!UUID.test(String(orderId || ''))) return null;
  return db.obterCodigoPixUsuario({ orderId, guildId, userId });
}

const novoRequestId = () => crypto.randomUUID();

module.exports = { PLANOS, UUID, validarPagamento, criarPixPlano, verificarPlano, codigoPixUsuario, novoRequestId };
