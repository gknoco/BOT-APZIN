'use strict';

// A reserva é persistente e não expira: em falha ambígua, nunca liberar nem
// repetir um efeito externo automaticamente. Toda decisão vem da RPC.
const supabase = require('./supabase');

async function acao({ cliente = supabase.obterCliente(), action, guildId, tipo, protocolo, actorId, requestId }) {
  const { data, error } = await cliente.rpc('royal_rescue_action', {
    p_action: action, p_guild_id: String(guildId), p_source: tipo, p_protocol: protocolo,
    p_actor_id: String(actorId), p_request_id: String(requestId),
  });
  if (error || !data || typeof data.result !== 'string') throw new Error('Reserva de resgate não confirmada');
  return data;
}

// Só uma resposta 'acquired' nova autoriza a chamada externa. Replays, respostas
// perdidas, divergências ou erro deixam a pendência bloqueada para reconciliação.
async function entregaAutomatica({ guildId, tipo, protocolo, interactionId, userId, roleId, entregar }) {
  const actorId = `auto:${interactionId}`;
  const args = { guildId, tipo, protocolo, actorId, requestId: String(interactionId) };
  const claim = await acao({ ...args, action: 'claim' });
  if (claim.result !== 'acquired' || claim.user_id !== String(userId) ||
      claim.reward_type !== 'role' || claim.reward_value !== String(roleId)) {
    throw new Error('Entrega exige reconciliação; reserva ou dados não confirmados');
  }
  await entregar();
  const concluido = await acao({ ...args, action: 'finish' });
  if (concluido.result !== 'finished') throw new Error('Entrega externa pode ter ocorrido; conclusão exige revisão');
}

module.exports = { acao, entregaAutomatica };
