'use strict';

const supabaseBase = require('./supabase');
const cliente = () => supabaseBase.obterCliente();

async function rpc(nome, args) {
  const { data, error } = await cliente().rpc(nome, args);
  if (error) throw new Error(`${nome}: ${error.message}`);
  return Array.isArray(data) ? data[0] : data;
}

async function criarRecarga({ guildId, userId, requestId, amountCents, payerEmail }) {
  return rpc('royal_wallet_create_topup', {
    p_guild_id: String(guildId),
    p_user_id: String(userId),
    p_request_id: String(requestId),
    p_amount_cents: Math.trunc(Number(amountCents)),
    p_payer_email: String(payerEmail || '').trim().toLowerCase(),
  });
}

async function anexarPagamento({ topupId, paymentId, qrCode, qrBase64, ticketUrl, expiresAt }) {
  return rpc('royal_wallet_attach_topup_payment', {
    p_topup_id: String(topupId),
    p_payment_id: String(paymentId),
    p_qr_code: String(qrCode || ''),
    p_qr_base64: qrBase64 || null,
    p_ticket_url: ticketUrl || null,
    p_expires_at: expiresAt || null,
  });
}

async function marcarFalha({ topupId, status, errorCode }) {
  return rpc('royal_wallet_mark_topup_failure', {
    p_topup_id: String(topupId),
    p_status: String(status),
    p_error_code: String(errorCode || 'unknown').slice(0, 80),
  });
}

async function obterRecargaInterna(topupId) {
  const { data, error } = await cliente()
    .from('royal_wallet_topups')
    .select('id,guild_id,user_id,amount_cents,status,mp_payment_id')
    .eq('id', String(topupId))
    .maybeSingle();
  if (error) throw new Error(`consulta interna da recarga no Supabase: ${error.message}`);
  return data;
}

async function obterRecargaUsuario({ topupId, guildId, userId }) {
  const { data, error } = await cliente()
    .from('royal_wallet_topups')
    .select('id,guild_id,user_id,amount_cents,status,mp_payment_id,mp_status,pix_copy_paste,pix_qr_base64,ticket_url,expires_at')
    .eq('id', String(topupId))
    .eq('guild_id', String(guildId))
    .eq('user_id', String(userId))
    .maybeSingle();
  if (error) throw new Error(`consulta da recarga no Supabase: ${error.message}`);
  return data;
}

async function obterCodigoPixUsuario({ topupId, guildId, userId }) {
  const { data, error } = await cliente()
    .from('royal_wallet_topups')
    .select('pix_copy_paste,status')
    .eq('id', String(topupId))
    .eq('guild_id', String(guildId))
    .eq('user_id', String(userId))
    .eq('status', 'pending')
    .maybeSingle();
  if (error) throw new Error(`consulta do código Pix no Supabase: ${error.message}`);
  return data?.pix_copy_paste || null;
}

async function aplicarPagamento({ topupId, paymentId, status, amountCents, currency, externalReference, paymentMethod, refundedCents = 0 }) {
  return rpc('royal_wallet_apply_topup_payment', {
    p_topup_id: String(topupId),
    p_payment_id: String(paymentId),
    p_status: String(status || 'pending').toLowerCase(),
    p_amount_cents: amountCents == null ? null : Math.trunc(Number(amountCents)),
    p_currency: currency ? String(currency) : null,
    p_external_reference: externalReference ? String(externalReference) : null,
    p_payment_method: paymentMethod ? String(paymentMethod) : null,
    p_refunded_cents: Math.max(0, Math.trunc(Number(refundedCents) || 0)),
  });
}

async function saldoUsuario(guildId, userId) {
  const { data, error } = await cliente().rpc('royal_wallet_balance', {
    p_guild_id: String(guildId),
    p_user_id: String(userId),
  });
  if (error) throw new Error(`consulta do saldo no Supabase: ${error.message}`);
  return Number(data || 0);
}

module.exports = {
  criarRecarga,
  anexarPagamento,
  marcarFalha,
  obterRecargaInterna,
  obterRecargaUsuario,
  obterCodigoPixUsuario,
  aplicarPagamento,
  saldoUsuario,
};
