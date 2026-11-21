'use strict';

/** Domínio econômico persistente da Royal AP. A fonte de verdade é sempre o Supabase. */
const crypto = require('crypto');
const supabaseBase = require('./supabase');
const cliente = () => supabaseBase.obterCliente();
const requestId = (prefix, value) => `${prefix}:${value || crypto.randomUUID()}`;

async function rpc(nome, args) {
  const { data, error } = await cliente().rpc(nome, args);
  if (error) throw new Error(`${nome}: ${error.message}`);
  return Array.isArray(data) ? data[0] : data;
}

async function girar({ guildId, userId, request }) {
  return rpc('royal_spin', {
    p_guild_id: String(guildId),
    p_user_id: String(userId),
    p_request_id: requestId('spin', request),
  });
}

async function ajustarPerfil({ guildId, userId, deltas, reason, actorId, request }) {
  const row = await rpc('royal_adjust_profile', {
    p_guild_id: String(guildId),
    p_user_id: String(userId),
    p_deltas: deltas,
    p_reason: String(reason || 'ajuste'),
    p_actor_id: actorId ? String(actorId) : null,
    p_request_id: requestId('profile', request),
  });
  if (!row) throw new Error('O Supabase não retornou o perfil atualizado.');
  return row;
}

async function registrarResultadoPartida({ guildId, matchId, winnerTime, stake, players, reason }) {
  return rpc('royal_apply_match_result', {
    p_guild_id: String(guildId),
    p_match_id: String(matchId),
    p_winner_time: Number(winnerTime),
    p_stake: Math.max(0, Math.trunc(Number(stake) || 0)),
    p_reason: String(reason || 'resultado'),
    p_players: players.map((player) => ({
      user_id: String(player.user_id),
      team: Number(player.time),
      confirmed: Boolean(player.confirmou),
    })),
  });
}

async function criarIntencaoLoja({ guildId, userId, itemId, sourceId }) {
  if (!sourceId) throw new Error('Interação de intenção obrigatória');
  return rpc('royal_create_shop_intention', {
    p_guild_id: String(guildId), p_user_id: String(userId),
    p_item_id: itemId, p_source_id: String(sourceId),
  });
}

async function confirmarIntencaoLoja({ guildId, userId, nonce }) {
  if (!nonce) throw new Error('Nonce de intenção obrigatório');
  return rpc('royal_confirm_shop_intention', {
    p_guild_id: String(guildId), p_user_id: String(userId), p_nonce: String(nonce),
  });
}

async function marcarRecompensaEntregue({ guildId, userId, request }) {
  return rpc('royal_mark_reward_delivered', {
    p_guild_id: String(guildId),
    p_request_id: requestId('spin', request),
    p_user_id: String(userId),
  });
}

async function marcarCompraEntregue({ guildId, userId, purchaseId }) {
  return rpc('royal_mark_purchase_delivered', {
    p_guild_id: String(guildId),
    p_purchase_id: String(purchaseId),
    p_user_id: String(userId),
  });
}

async function listarItens(guildId) {
  const { data, error } = await cliente()
    .from('royal_shop_items')
    .select('*')
    .eq('guild_id', String(guildId))
    .eq('active', true)
    .order('price');
  if (error) throw new Error(`listar loja: ${error.message}`);
  return data || [];
}

async function inventario(guildId, userId) {
  const { data, error } = await cliente()
    .from('royal_inventory')
    .select('quantity,item_id,royal_shop_items(name,description,reward_type,reward_value)')
    .eq('guild_id', String(guildId))
    .eq('user_id', String(userId))
    .gt('quantity', 0)
    .order('updated_at', { ascending: false });
  if (error) throw new Error(`inventário: ${error.message}`);
  return data || [];
}

async function perfil(guildId, userId) {
  const { data, error } = await cliente()
    .from('royal_profiles')
    .select('guild_id,user_id,coins,spins,wins,losses,wos,apostado,ganho')
    .eq('guild_id', String(guildId))
    .eq('user_id', String(userId))
    .maybeSingle();
  if (error) throw new Error(`perfil Supabase: ${error.message}`);
  return data;
}

async function resumo(guildId, userId) {
  const row = await perfil(guildId, userId);
  const resumoPerfil = {
    guild_id: String(guildId),
    user_id: String(userId),
    coins: Number(row?.coins || 0),
    giros: Number(row?.spins || 0),
    vitorias: Number(row?.wins || 0),
    derrotas: Number(row?.losses || 0),
    wos: Number(row?.wos || 0),
    apostado: Number(row?.apostado || 0),
    ganho: Number(row?.ganho || 0),
  };
  resumoPerfil.total = resumoPerfil.vitorias + resumoPerfil.derrotas;
  resumoPerfil.aproveitamento = resumoPerfil.total
    ? Math.round((resumoPerfil.vitorias / resumoPerfil.total) * 100)
    : 0;
  return resumoPerfil;
}

async function topPerfis(guildId, tipo = 'vitorias', limit = 10) {
  const ordenacao = {
    coins: 'coins',
    giros: 'spins',
    vitorias: 'wins',
  }[tipo] || 'wins';
  const { data, error } = await cliente()
    .from('royal_profiles')
    .select('guild_id,user_id,coins,spins,wins,losses,wos,apostado,ganho')
    .eq('guild_id', String(guildId))
    .order(ordenacao, { ascending: false })
    .order('user_id', { ascending: true })
    .limit(Math.max(1, Math.min(1000, Math.trunc(Number(limit) || 10))));
  if (error) throw new Error(`ranking Supabase: ${error.message}`);
  const perfilRows = (data || []).filter((row) => Number(row[ordenacao] || 0) > 0);
  return perfilRows.map((row) => ({
    ...row,
    coins: Number(row.coins || 0),
    giros: Number(row.spins || 0),
    vitorias: Number(row.wins || 0),
    derrotas: Number(row.losses || 0),
    wos: Number(row.wos || 0),
  }));
}

async function posicaoRanking(guildId, userId, tipo = 'vitorias') {
  const rows = await topPerfis(guildId, tipo, 1000);
  const index = rows.findIndex((row) => row.user_id === String(userId));
  return index < 0 ? null : index + 1;
}

async function ranking(guildId, tipo = 'vitorias', limit = 10) {
  if (tipo === 'invites') return rankingConvites(guildId, limit);
  return topPerfis(guildId, tipo, limit);
}

async function rankingConvites(guildId, limit = 10) {
  const { data, error } = await cliente().rpc('royal_invite_ranking', {
    p_guild_id: String(guildId),
    p_limit: Math.max(1, Math.min(100, Math.trunc(Number(limit) || 10))),
  });
  if (error) throw new Error(`ranking invites: ${error.message}`);
  return (data || []).map((row) => ({
    user_id: row.user_id,
    inviter_user_id: row.user_id,
    total: Number(row.total || row.invites_reais || 0),
  }));
}

async function contarConvites(guildId, userId) {
  const { count, error } = await cliente()
    .from('royal_invites')
    .select('invited_user_id', { count: 'exact', head: true })
    .eq('guild_id', String(guildId))
    .eq('inviter_user_id', String(userId));
  if (error) throw new Error(`contar invites: ${error.message}`);
  return Number(count || 0);
}

async function conviteDoUsuario(guildId, invitedUserId) {
  const { data, error } = await cliente()
    .from('royal_invites')
    .select('inviter_user_id,code,confidence,created_at')
    .eq('guild_id', String(guildId))
    .eq('invited_user_id', String(invitedUserId))
    .maybeSingle();
  if (error) throw new Error(`consultar invite: ${error.message}`);
  return data
    ? { convidador_id: data.inviter_user_id, codigo: data.code, confianca: data.confidence, criado_em: data.created_at }
    : null;
}

async function registrarInvite({ guildId, invitedUserId, inviterUserId, code, confidence = 'observed' }) {
  const { error } = await cliente().rpc('royal_record_invite_join', {
    p_guild_id: String(guildId),
    p_invited_user_id: String(invitedUserId),
    p_inviter_user_id: inviterUserId ? String(inviterUserId) : null,
    p_code: code || null,
    p_confidence: confidence,
  });
  if (error) throw new Error(`registrar invite: ${error.message}`);
}

async function removerInvite(guildId, invitedUserId) {
  const { data, error } = await cliente().rpc('royal_record_invite_leave', {
    p_guild_id: String(guildId),
    p_invited_user_id: String(invitedUserId),
  });
  if (error) throw new Error(`remover invite: ${error.message}`);
  return data || null;
}

async function auditar(evento) {
  const { error } = await cliente().from('royal_audit_events').insert({
    guild_id: evento.guildId ? String(evento.guildId) : null,
    actor_id: evento.actorId ? String(evento.actorId) : null,
    action: String(evento.action || 'unknown'),
    entity_type: evento.entityType || null,
    entity_id: evento.entityId ? String(evento.entityId) : null,
    request_id: evento.requestId || null,
    before_data: evento.beforeData || null,
    after_data: evento.afterData || null,
    detail: evento.detail || null,
  });
  if (error) console.error('[royal-supabase] auditoria:', error.message);
}
async function auditarAjusteGiros({ guildId, actorId, userId, quantidade, motivo, requestId }) {
  const delta = Number(quantidade);
  return auditar({
    guildId,
    actorId,
    action: 'wallet.spins.adjust',
    entityType: 'profile',
    entityId: userId,
    requestId,
    detail: `${delta > 0 ? '+' : ''}${delta} giros${motivo ? ` · motivo: ${String(motivo).slice(0, 120)}` : ''}`,
  });
}

module.exports = {
  girar,
  ajustarPerfil,
  registrarResultadoPartida,
  criarIntencaoLoja,
  confirmarIntencaoLoja,
  marcarRecompensaEntregue,
  marcarCompraEntregue,
  listarItens,
  inventario,
  perfil,
  resumo,
  topPerfis,
  posicaoRanking,
  ranking,
  rankingConvites,
  contarConvites,
  conviteDoUsuario,
  registrarInvite,
  removerInvite,
  auditar,
  auditarAjusteGiros,
};
