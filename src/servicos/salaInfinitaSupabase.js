'use strict';

const supabaseBase = require('./supabase');
const cliente = () => supabaseBase.obterCliente();

async function rpc(nome, args) {
  const { data, error } = await cliente().rpc(nome, args);
  if (error) throw new Error(`${nome}: ${error.message}`);
  return Array.isArray(data) ? data[0] : data;
}

async function criarPedido({ guildId, userId, requestId, plan, payerEmail }) {
  return rpc('royal_infinite_create_order', {
    p_guild_id: String(guildId), p_user_id: String(userId), p_request_id: String(requestId),
    p_plan: String(plan), p_payer_email: String(payerEmail || '').trim().toLowerCase(),
  });
}

async function anexarPagamento({ orderId, paymentId, qrCode, qrBase64, ticketUrl, expiresAt }) {
  return rpc('royal_infinite_attach_payment', {
    p_order_id: String(orderId), p_payment_id: String(paymentId), p_qr_code: String(qrCode || ''),
    p_qr_base64: qrBase64 || null, p_ticket_url: ticketUrl || null, p_expires_at: expiresAt || null,
  });
}

async function marcarFalha({ orderId, status, errorCode }) {
  return rpc('royal_infinite_mark_failure', {
    p_order_id: String(orderId), p_status: String(status), p_error_code: String(errorCode || 'unknown').slice(0, 80),
  });
}

async function obterPedidoUsuario({ orderId, guildId, userId }) {
  const { data, error } = await cliente().from('royal_infinite_orders')
    .select('id,guild_id,user_id,plan,days,amount_cents,status,mp_payment_id,mp_status,pix_copy_paste,pix_qr_base64,ticket_url,expires_at,premium_until_after')
    .eq('id', String(orderId)).eq('guild_id', String(guildId)).eq('user_id', String(userId)).maybeSingle();
  if (error) throw new Error(`consulta do pedido Sala Infinita no Supabase: ${error.message}`);
  return data;
}

async function obterCodigoPixUsuario({ orderId, guildId, userId }) {
  const { data, error } = await cliente().from('royal_infinite_orders').select('pix_copy_paste')
    .eq('id', String(orderId)).eq('guild_id', String(guildId)).eq('user_id', String(userId)).eq('status', 'pending').maybeSingle();
  if (error) throw new Error(`consulta do código Pix Sala Infinita no Supabase: ${error.message}`);
  return data?.pix_copy_paste || null;
}

async function aplicarPagamento({ orderId, paymentId, status, amountCents, currency, externalReference, paymentMethod }) {
  return rpc('royal_infinite_apply_payment', {
    p_order_id: String(orderId), p_payment_id: String(paymentId), p_status: String(status || 'pending').toLowerCase(),
    p_amount_cents: amountCents == null ? null : Math.trunc(Number(amountCents)),
    p_currency: currency ? String(currency) : null,
    p_external_reference: externalReference ? String(externalReference) : null,
    p_payment_method: paymentMethod ? String(paymentMethod) : null,
  });
}

async function obterAssinatura({ guildId, userId }) {
  const { data, error } = await cliente().from('royal_infinite_subscriptions').select('guild_id,user_id,premium_until,updated_at')
    .eq('guild_id', String(guildId)).eq('user_id', String(userId)).maybeSingle();
  if (error) throw new Error(`consulta da assinatura Sala Infinita no Supabase: ${error.message}`);
  return data;
}

module.exports = { criarPedido, anexarPagamento, marcarFalha, obterPedidoUsuario, obterCodigoPixUsuario, aplicarPagamento, obterAssinatura };
