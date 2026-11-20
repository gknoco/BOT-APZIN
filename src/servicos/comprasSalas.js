'use strict';

const crypto = require('crypto');
const mp = require('./mercadoPago');
const vendas = require('./roomSalesSupabase');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MENSAGEM_EMAIL_INVALIDO = '❌ E-mail inválido. Por favor, insira um endereço de e-mail válido para continuar.';

function validarEmailPix(valor) {
  return mp.validarEmailPix(valor);
}

function textoPagamentoAprovado(quantidade) {
  const total = Math.max(0, Math.trunc(Number(quantidade) || 0));
  return `✅ Pagamento aprovado! O saldo de ${total} ${total === 1 ? 'sala' : 'salas'} já caiu na sua conta para criar salas. Use /minhassalas para ver suas salas.`;
}

function resumoErro(error) {
  return String(error?.code || (error?.status ? `mp_http_${error.status}` : error?.name || 'mp_processing_error')).slice(0, 80);
}

function mensagemFalhaMercadoPago(error) {
  if (error?.code === 'mp_config_missing' || error?.code === 'mp_webhook_url_invalid' || error?.code === 'mp_token_missing') {
    return 'A integração do Mercado Pago está incompleta. A administração precisa revisar as credenciais e a URL do webhook.';
  }
  if (error?.definitive) {
    const detalhe = String(error.apiCause?.[0]?.description || error.apiMessage || '').replace(/[\r\n]/g, ' ').trim().slice(0, 240);
    return detalhe
      ? `O Mercado Pago rejeitou a cobrança: ${detalhe}`
      : 'O Mercado Pago rejeitou a cobrança. Confira o e-mail informado e tente novamente.';
  }
  return 'O resultado da solicitação ao Mercado Pago ficou incerto. Não repita o pagamento; aguarde o webhook ou procure a administração.';
}

async function criarPedidoPix({ guildId, userId, requestId, quantity, couponCode, payerEmail }) {
  const email = String(payerEmail || '').trim().toLowerCase();
  if (!validarEmailPix(email)) throw new Error(MENSAGEM_EMAIL_INVALIDO);
  mp.exigirAmbiente();
  const qtd = Number(quantity);
  if (!Number.isInteger(qtd) || qtd < 1 || qtd > 1000) throw new Error('A quantidade precisa ser um número inteiro entre 1 e 1.000 salas.');

  const order = await vendas.criarPedido({ guildId, userId, requestId, quantity: qtd, couponCode, payerEmail: email });
  if (order.mp_payment_id && order.pix_copy_paste) {
    return { order, payment: { id: String(order.mp_payment_id), status: order.status, qrCode: order.pix_copy_paste, qrBase64: order.pix_qr_base64, ticketUrl: order.ticket_url, expiresAt: order.expires_at } };
  }
  if (order.status === 'failed') throw new Error('Este pedido já foi recusado. Inicie uma nova compra.');
  if (order.status === 'manual_review') throw new Error('Esta compra ficou com resultado incerto. Não faça outro Pix; aguarde a confirmação ou procure a administração.');

  let payment;
  try {
    payment = await mp.criarPix({ order, payerEmail: email });
    await vendas.anexarPagamento({
      orderId: order.id,
      paymentId: payment.id,
      qrCode: payment.qrCode,
      qrBase64: payment.qrBase64,
      ticketUrl: payment.ticketUrl,
      expiresAt: payment.expiresAt,
    });
  } catch (error) {
    // O cliente atual usa fetch; manter também error.response.data para compatibilidade com Axios.
    // Não registrar token, QR completo nem e-mail do pagador.
    console.error('[compras-salas] erro exato ao criar/anexar Pix do Mercado Pago:', JSON.stringify({
      responseData: error?.response?.data || error?.details || null,
      message: error?.message || String(error),
      code: resumoErro(error),
      status: error?.status || error?.response?.status || null,
      apiMessage: error?.apiMessage || null,
      apiCause: error?.apiCause || null,
      orderId: String(order.id),
      transactionAmount: Number((Number(order.amount_cents) / 100).toFixed(2)),
    }));
    const status = error?.definitive ? 'failed' : 'manual_review';
    await vendas.marcarFalhaPedido({ orderId: order.id, status, errorCode: resumoErro(error) }).catch((dbError) => {
      console.error('[compras-salas] não consegui atualizar o pedido após falha MP:', dbError.message);
    });
    throw new Error(mensagemFalhaMercadoPago(error));
  }

  if (payment.status === 'approved') {
    const atualizado = await processarPagamento(payment.id, order.id);
    return { order: atualizado, payment };
  }
  return { order: { ...order, status: 'pending' }, payment };
}

async function aplicarPagamentoVerificado(order, payment) {
  const paymentId = String(payment?.id || '');
  if (!paymentId) throw new Error('MP_PAYMENT_ID_MISSING');
  const externalReference = String(payment.external_reference || '');
  const status = String(payment.status || 'pending').toLowerCase();
  const amountCents = mp.centavos(payment.transaction_amount);
  const refundedCents = mp.centavos(payment.transaction_amount_refunded) ?? 0;
  let manualReason = null;
  if (externalReference !== String(order.id)) manualReason = 'external_reference_mismatch';
  else if (String(payment.currency_id || '').toUpperCase() !== 'BRL') manualReason = 'currency_mismatch';
  else if (String(payment.payment_method_id || '').toLowerCase() !== 'pix') manualReason = 'payment_method_mismatch';
  else if (order.mp_payment_id && String(order.mp_payment_id) !== paymentId) manualReason = 'payment_id_mismatch';
  else if (status === 'approved' && amountCents !== Number(order.amount_cents)) manualReason = 'amount_mismatch';

  return vendas.aplicarPagamento({
    orderId: order.id,
    paymentId,
    status: manualReason ? 'manual_review' : status,
    amountCents,
    currency: payment.currency_id || null,
    externalReference,
    refundedCents,
    manualReason,
  });
}

async function processarPagamento(paymentId, expectedOrderId = null) {
  const payment = await mp.buscarPagamento(paymentId);
  const orderId = String(payment.external_reference || '');
  if (!UUID.test(orderId) || (expectedOrderId && orderId !== String(expectedOrderId))) throw new Error('MP_EXTERNAL_REFERENCE_MISMATCH');
  const order = await vendas.obterPedidoInterno(orderId);
  if (!order) throw new Error('MP_ORDER_NOT_FOUND');
  return aplicarPagamentoVerificado(order, payment);
}

async function verificarPedido({ orderId, guildId, userId }) {
  const order = await vendas.obterPedidoUsuario({ orderId, guildId, userId });
  if (!order) throw new Error('Esse pedido não pertence à sua conta.');
  if (order.status === 'approved') return order;
  if (!order.mp_payment_id) {
    if (order.status === 'manual_review') throw new Error('O resultado da solicitação ainda está incerto. Não crie outra cobrança e procure a administração.');
    throw new Error('O Mercado Pago ainda não vinculou um pagamento a este pedido. Aguarde o Pix ou tente mais tarde.');
  }
  return processarPagamento(order.mp_payment_id, order.id);
}

async function processarEventoWebhook(evento, pagamentoExistente = null) {
  const payment = pagamentoExistente || await mp.buscarPagamento(evento.payment_id);
  const orderId = String(payment.external_reference || '');
  if (!UUID.test(orderId)) return { ignorado: true, motivo: 'external_reference_not_royal' };
  const order = await vendas.obterPedidoInterno(orderId);
  if (!order) return { ignorado: true, motivo: 'order_not_found' };
  const resultado = await aplicarPagamentoVerificado(order, payment);
  return { ignorado: false, resultado };
}

function chaveEvento(body, paymentId) {
  if (body?.id != null) return `mp:${String(body.id).slice(0, 140)}`;
  const action = String(body?.action || body?.type || 'payment').slice(0, 100);
  const hash = crypto.createHash('sha256').update(`${action}:${paymentId}`).digest('hex');
  return `sha256:${hash}`;
}

module.exports = {
  UUID,
  MENSAGEM_EMAIL_INVALIDO,
  validarEmailPix,
  textoPagamentoAprovado,
  resumoErro,
  mensagemFalhaMercadoPago,
  criarPedidoPix,
  aplicarPagamentoVerificado,
  processarPagamento,
  verificarPedido,
  processarEventoWebhook,
  chaveEvento,
};
