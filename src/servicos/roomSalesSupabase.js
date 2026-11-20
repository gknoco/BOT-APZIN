'use strict';

/** Fonte de verdade para a central de vendas e créditos de salas. */
const supabaseBase = require('./supabase');
const cliente = () => supabaseBase.obterCliente();
const saldoMemoria = new Map();
const chaveSaldo = (guildId, userId) => `${String(guildId)}:${String(userId)}`;
const requestResgateInicial = (guildId, userId) => `initial-redeem:${String(guildId)}:${String(userId)}`;

function saldoResposta(dados) {
  const valor = dados?.available_rooms ?? dados?.balance_rooms ?? dados?.saldo ?? dados;
  const numero = Number(valor);
  return Number.isFinite(numero) ? Math.max(0, Math.trunc(numero)) : 0;
}

function salvarSaldoMemoria(guildId, userId, saldo) {
  const valor = Math.max(0, Math.trunc(Number(saldo) || 0));
  saldoMemoria.set(chaveSaldo(guildId, userId), valor);
  return valor;
}

function fallbackEstatisticas(guildId, userId) {
  return {
    available_rooms: saldoMemoria.get(chaveSaldo(guildId, userId)) || 0,
    reserved_rooms: 0,
    purchased_rooms_total: saldoMemoria.get(chaveSaldo(guildId, userId)) || 0,
    created_today: 0,
    created_total: 0,
    approved_purchase_count: 0,
    pending_usages: [],
  };
}

async function rpc(nome, args) {
  const { data, error } = await cliente().rpc(nome, args);
  if (error) throw new Error(`${nome}: ${error.message}`);
  return Array.isArray(data) ? data[0] : data;
}

async function obterConfiguracao(guildId) {
  const { data, error } = await cliente()
    .from('royal_room_purchase_settings')
    .select('guild_id,allowed_role_ids,panel_channel_id,updated_at')
    .eq('guild_id', String(guildId))
    .maybeSingle();
  if (error) throw new Error(`configuração de compras Supabase: ${error.message}`);
  return data || { guild_id: String(guildId), allowed_role_ids: [], panel_channel_id: null };
}

async function salvarConfiguracao({ guildId, roleIds, channelId, actorId }) {
  return rpc('royal_room_set_purchase_settings', {
    p_guild_id: String(guildId),
    p_role_ids: Array.isArray(roleIds) ? roleIds.map(String) : [],
    p_panel_channel_id: channelId ? String(channelId) : null,
    p_actor_id: actorId ? String(actorId) : null,
  });
}

async function salvarCupom({ guildId, code, discountPercent, active, actorId }) {
  return rpc('royal_room_upsert_coupon', {
    p_guild_id: String(guildId),
    p_code: String(code || '').trim().toUpperCase(),
    p_discount_percent: discountPercent == null ? null : Math.trunc(Number(discountPercent)),
    p_active: Boolean(active),
    p_actor_id: actorId ? String(actorId) : null,
  });
}

async function criarPedido({ guildId, userId, requestId, quantity, couponCode, payerEmail }) {
  return rpc('royal_room_create_purchase', {
    p_guild_id: String(guildId),
    p_user_id: String(userId),
    p_request_id: String(requestId),
    p_rooms_quantity: Math.trunc(Number(quantity)),
    p_coupon_code: couponCode ? String(couponCode).trim().toUpperCase() : null,
    p_payer_email: String(payerEmail || '').trim().toLowerCase(),
  });
}

async function comprarComSaldo({ guildId, userId, requestId, quantity, amountCents }) {
  return rpc('royal_wallet_purchase_rooms', {
    p_guild_id: String(guildId),
    p_user_id: String(userId),
    p_request_id: String(requestId),
    p_rooms_quantity: Math.trunc(Number(quantity)),
    p_amount_cents: Math.trunc(Number(amountCents)),
  });
}

async function anexarPagamento({ orderId, paymentId, qrCode, qrBase64, ticketUrl, expiresAt }) {
  return rpc('royal_room_attach_payment', {
    p_order_id: String(orderId),
    p_payment_id: String(paymentId),
    p_qr_code: String(qrCode || ''),
    p_qr_base64: qrBase64 || null,
    p_ticket_url: ticketUrl || null,
    p_expires_at: expiresAt || null,
  });
}

async function marcarFalhaPedido({ orderId, status, errorCode }) {
  return rpc('royal_room_mark_purchase_failure', {
    p_order_id: String(orderId),
    p_status: status,
    p_error_code: String(errorCode || 'unknown').slice(0, 80),
  });
}

async function obterPedidoUsuario({ orderId, guildId, userId }) {
  const { data, error } = await cliente()
    .from('royal_room_purchase_orders')
    .select('id,guild_id,user_id,rooms_quantity,amount_cents,status,mp_payment_id,mp_status,expires_at,created_at')
    .eq('id', String(orderId))
    .eq('guild_id', String(guildId))
    .eq('user_id', String(userId))
    .maybeSingle();
  if (error) throw new Error(`consulta do pedido Supabase: ${error.message}`);
  return data;
}

async function obterPixPedidoUsuario({ orderId, guildId, userId }) {
  const { data, error } = await cliente()
    .from('royal_room_purchase_orders')
    .select('id,status,pix_copy_paste,expires_at')
    .eq('id', String(orderId))
    .eq('guild_id', String(guildId))
    .eq('user_id', String(userId))
    .eq('status', 'pending')
    .maybeSingle();
  if (error) throw new Error(`consulta do Pix do pedido Supabase: ${error.message}`);
  return data;
}

async function obterPedidoInterno(orderId) {
  const { data, error } = await cliente()
    .from('royal_room_purchase_orders')
    .select('id,guild_id,user_id,rooms_quantity,amount_cents,discount_cents,status,mp_payment_id,expires_at')
    .eq('id', String(orderId))
    .maybeSingle();
  if (error) throw new Error(`consulta interna do pedido Supabase: ${error.message}`);
  return data;
}

async function aplicarPagamento({ orderId, paymentId, status, amountCents, currency, externalReference, refundedCents, manualReason }) {
  return rpc('royal_room_apply_payment', {
    p_order_id: String(orderId),
    p_payment_id: String(paymentId),
    p_status: String(status || 'pending').toLowerCase(),
    p_amount_cents: amountCents == null ? null : Math.trunc(Number(amountCents)),
    p_currency: currency ? String(currency) : null,
    p_external_reference: externalReference ? String(externalReference) : null,
    p_refunded_cents: refundedCents === undefined ? 0 : refundedCents === null ? null : Math.trunc(Number(refundedCents)),
    p_manual_reason: manualReason ? String(manualReason).slice(0, 80) : null,
  });
}

async function enfileirarEvento({ eventKey, paymentId, action }) {
  return rpc('royal_room_enqueue_payment_event', {
    p_event_key: String(eventKey),
    p_payment_id: String(paymentId),
    p_action: action ? String(action) : null,
  });
}

async function reivindicarEventos(limit = 5) {
  const { data, error } = await cliente().rpc('royal_room_claim_payment_events', { p_limit: Math.max(1, Math.min(20, limit)) });
  if (error) throw new Error(`fila de webhooks Supabase: ${error.message}`);
  return data || [];
}

async function finalizarEvento({ eventId, attempt, success, errorCode }) {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error('WEBHOOK_INVALID_LEASE');
  return rpc('royal_room_finish_payment_event', {
    p_event_id: String(eventId),
    p_success: Boolean(success),
    p_error_code: errorCode ? String(errorCode).slice(0, 80) : null,
    p_attempt: attempt,
  });
}

async function reservarSala({ guildId, userId, requestId, source, sourceRef }) {
  const dados = await rpc('royal_room_reserve_room', {
    p_guild_id: String(guildId),
    p_user_id: String(userId),
    p_request_id: String(requestId),
    p_source: String(source),
    p_source_ref: sourceRef ? String(sourceRef) : null,
  });
  salvarSaldoMemoria(guildId, userId, saldoResposta(dados));
  return dados;
}

async function liquidarUsoSala({ requestId, status, roomId, sessionId, errorCode }) {
  return rpc('royal_room_settle_room', {
    p_request_id: String(requestId),
    p_status: String(status),
    p_room_id: roomId ? String(roomId) : null,
    p_session_id: sessionId ? String(sessionId) : null,
    p_error_code: errorCode ? String(errorCode).slice(0, 80) : null,
  });
}

async function concederSalas({ guildId, userId, requestId, quantity, actorId }) {
  return rpc('royal_room_admin_grant', {
    p_guild_id: String(guildId), p_user_id: String(userId), p_request_id: String(requestId),
    p_rooms_quantity: Math.trunc(Number(quantity)), p_actor_id: String(actorId),
  });
}

async function estatisticasSalas(guildId, userId) {
  try {
    const dados = await rpc('royal_room_stats', { p_guild_id: String(guildId), p_user_id: String(userId) });
    salvarSaldoMemoria(guildId, userId, saldoResposta(dados));
    return dados;
  } catch (erro) {
    console.warn('[salas-credito] estatísticas oficiais indisponíveis; usando saldo em memória:', erro.message);
    return fallbackEstatisticas(guildId, userId);
  }
}

// Sem fallback de escrita: carteira, ledger e marcador só podem mudar juntos.
// Se a resposta se perder após o COMMIT, a próxima tentativa usa a mesma chave.
async function resgatarSalasIniciais({ guildId, userId, quantidade = 10 }) {
  const guild = String(guildId ?? '').trim();
  const user = String(userId ?? '').trim();
  const valor = Number(quantidade);
  if (!guild || !user || !Number.isSafeInteger(valor) || valor < 1) {
    throw new Error('Dados inválidos para o resgate inicial de salas.');
  }
  const dados = await rpc('royal_room_credit_initial_redemption', {
    p_guild_id: guild,
    p_user_id: user,
    p_request_id: requestResgateInicial(guild, user),
    p_rooms_quantity: valor,
  });
  const saldo = Number(dados?.available_rooms);
  if (typeof dados?.redeemed !== 'boolean' || dados.available_rooms == null ||
      typeof dados.available_rooms === 'boolean' ||
      (typeof dados.available_rooms === 'string' && !dados.available_rooms.trim()) || !Number.isSafeInteger(saldo)) {
    throw new Error('O banco não confirmou o resultado do resgate inicial.');
  }
  // Pode ser negativo após estorno: não transformá-lo em crédito disponível.
  salvarSaldoMemoria(guild, user, saldo);
  return { ...dados, available_rooms: saldo };
}

async function reconciliarUso({ requestId, outcome, actorId, roomId, sessionId, note }) {
  return rpc('royal_room_resolve_usage', {
    p_request_id: String(requestId),
    p_outcome: String(outcome),
    p_actor_id: String(actorId),
    p_room_id: roomId ? String(roomId) : null,
    p_session_id: sessionId ? String(sessionId) : null,
    p_note: note ? String(note).slice(0, 300) : null,
  });
}

module.exports = {
  obterConfiguracao,
  salvarConfiguracao,
  salvarCupom,
  criarPedido,
  comprarComSaldo,
  anexarPagamento,
  marcarFalhaPedido,
  obterPedidoUsuario,
  obterPixPedidoUsuario,
  obterPedidoInterno,
  aplicarPagamento,
  enfileirarEvento,
  reivindicarEventos,
  finalizarEvento,
  reservarSala,
  liquidarUsoSala,
  estatisticasSalas,
  resgatarSalasIniciais,
  concederSalas,
  reconciliarUso,
};
