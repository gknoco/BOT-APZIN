'use strict';

/** Cota de salas personalizadas por mediador. A fonte primária é o Supabase. */

const CARGO_MEDIADOR = '1543684028719173732';
const COTA_INICIAL = 10;
const memoria = new Map();

const chave = (guildId, userId) => `${String(guildId)}:${String(userId)}`;
const mensagemCotaEsgotada = 'Suas 10 salas personalizadas acabaram. Vá ao canal <#1571760194692587601> para comprar mais.';

function saldoDaResposta(data) {
  const valor = data?.salas_disponiveis ?? data?.rooms_available ?? data?.saldo ?? data;
  const numero = Number(valor);
  return Number.isFinite(numero) ? Math.max(0, Math.trunc(numero)) : COTA_INICIAL;
}

function inicializarMemoria(guildId, userId) {
  const id = chave(guildId, userId);
  if (!memoria.has(id)) memoria.set(id, COTA_INICIAL);
  return memoria.get(id);
}

function erroDeCota() {
  const erro = new Error(mensagemCotaEsgotada);
  erro.codigo = 'MEDIATOR_ROOM_QUOTA_EXHAUSTED';
  return erro;
}

async function inicializar(db, guildId, userId) {
  try {
    const { data, error } = await db.client.rpc('royal_mediator_ensure_room_quota', {
      p_guild_id: String(guildId),
      p_user_id: String(userId),
    });
    if (error) throw error;
    return saldoDaResposta(data);
  } catch (erro) {
    console.warn('[cotas] usando fallback em memória:', erro.message);
    return inicializarMemoria(guildId, userId);
  }
}

async function reservar(db, guildId, userId) {
  try {
    const { data, error } = await db.client.rpc('royal_mediator_reserve_room_quota', {
      p_guild_id: String(guildId),
      p_user_id: String(userId),
    });
    if (error) {
      if (/MEDIATOR_ROOM_QUOTA_EXHAUSTED/i.test(error.message || '')) throw erroDeCota();
      throw error;
    }
    return { saldo: saldoDaResposta(data), persistente: true };
  } catch (erro) {
    if (erro?.codigo === 'MEDIATOR_ROOM_QUOTA_EXHAUSTED') throw erro;
    console.warn('[cotas] reserva Supabase indisponível; usando fallback:', erro.message);
    const id = chave(guildId, userId);
    const atual = inicializarMemoria(guildId, userId);
    if (atual < 1) throw erroDeCota();
    memoria.set(id, atual - 1);
    return { saldo: atual - 1, persistente: false };
  }
}

async function devolver(db, guildId, userId, persistente) {
  if (!persistente) {
    const id = chave(guildId, userId);
    memoria.set(id, inicializarMemoria(guildId, userId) + 1);
    return;
  }
  const { error } = await db.client.rpc('royal_mediator_restore_room_quota', {
    p_guild_id: String(guildId),
    p_user_id: String(userId),
  });
  if (error) console.error('[cotas] não consegui devolver a cota:', error.message);
}

module.exports = {
  CARGO_MEDIADOR,
  COTA_INICIAL,
  mensagemCotaEsgotada,
  inicializar,
  reservar,
  devolver,
};
