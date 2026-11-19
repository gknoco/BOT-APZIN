'use strict';

/** Cota de salas personalizadas por mediador. A fonte primária é o Supabase. */

const CARGO_MEDIADOR = '1543684028719173732';
const COTA_INICIAL = 10;
const memoria = new Map();
const resgatesMemoria = new Set();

const chave = (guildId, userId) => `${String(guildId)}:${String(userId)}`;
const chaveResgate = (guildId, userId) => `${String(guildId)}:${String(userId)}`;
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

function sincronizarMemoria(guildId, userId, saldo) {
  const valor = Math.max(0, Math.trunc(Number(saldo)));
  memoria.set(chave(guildId, userId), valor);
  return valor;
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
    return sincronizarMemoria(guildId, userId, saldoDaResposta(data));
  } catch (erro) {
    console.warn('[cotas] usando fallback em memória:', erro.message);
    return inicializarMemoria(guildId, userId);
  }
}

async function reservar(db, guildId, userId, opcoes = {}) {
  try {
    const { data, error } = await db.client.rpc('royal_mediator_reserve_room_quota', {
      p_guild_id: String(guildId),
      p_user_id: String(userId),
    });
    if (error) {
      if (/MEDIATOR_ROOM_QUOTA_EXHAUSTED/i.test(error.message || '')) throw erroDeCota();
      throw error;
    }
    const saldo = sincronizarMemoria(guildId, userId, saldoDaResposta(data));
    return { saldo, persistente: true };
  } catch (erro) {
    if (erro?.codigo === 'MEDIATOR_ROOM_QUOTA_EXHAUSTED') {
      const id = chave(guildId, userId);
      const saldoMemoria = memoria.get(id);
      if (Number(saldoMemoria) > 0) {
        if (!opcoes.tentouReparar) {
          const reparo = await reparar(db, guildId, userId);
          if (reparo?.saldo > 0) return reservar(db, guildId, userId, { tentouReparar: true });
        }
        const saldo = sincronizarMemoria(guildId, userId, Number(saldoMemoria) - 1);
        console.warn('[cotas] Supabase informou saldo zero, mas o saldo resgatado em memória foi usado.');
        return { saldo, persistente: false };
      }
      if (!opcoes.tentouReparar) {
        const reparo = await reparar(db, guildId, userId);
        if (reparo?.saldo > 0) return reservar(db, guildId, userId, { tentouReparar: true });
      }
      throw erro;
    }
    console.warn('[cotas] reserva Supabase indisponível; usando fallback:', erro.message);
    const atual = inicializarMemoria(guildId, userId);
    if (atual < 1) throw erroDeCota();
    const saldo = sincronizarMemoria(guildId, userId, atual - 1);
    return { saldo, persistente: false };
  }
}

async function reparar(db, guildId, userId) {
  try {
    const { data, error } = await db.client.rpc('royal_mediator_repair_initial_quota', {
      p_guild_id: String(guildId),
      p_user_id: String(userId),
      p_quantidade: COTA_INICIAL,
    });
    if (error) throw error;
    return { saldo: sincronizarMemoria(guildId, userId, saldoDaResposta(data)), persistente: true };
  } catch (erro) {
    console.warn('[cotas] não foi possível reparar o saldo persistente:', erro.message);
    return null;
  }
}

async function resgatar(db, guildId, userId, quantidade = COTA_INICIAL) {
  const valor = Math.max(1, Math.trunc(Number(quantidade) || COTA_INICIAL));
  const idResgate = chaveResgate(guildId, userId);
  if (resgatesMemoria.has(idResgate)) return { jaResgatou: true, saldo: memoria.get(chave(guildId, userId)) ?? 0 };
  try {
    const { data, error } = await db.client.rpc('royal_mediator_redeem_initial_quota', {
      p_guild_id: String(guildId),
      p_user_id: String(userId),
      p_quantidade: valor,
    });
    if (error) throw error;
    const saldo = sincronizarMemoria(guildId, userId, saldoDaResposta(data));
    if (data?.resgatado === false || data?.redeemed === false) {
      resgatesMemoria.add(idResgate);
      return { jaResgatou: true, saldo };
    }
    resgatesMemoria.add(idResgate);
    return { jaResgatou: false, saldo, persistente: true };
  } catch (erro) {
    console.warn('[cotas] resgate Supabase indisponível; usando fallback:', erro.message);
    if (resgatesMemoria.has(idResgate)) return { jaResgatou: true, saldo: memoria.get(chave(guildId, userId)) ?? 0 };
    const id = chave(guildId, userId);
    const atual = memoria.has(id) ? memoria.get(id) : 0;
    const saldo = sincronizarMemoria(guildId, userId, atual + valor);
    resgatesMemoria.add(idResgate);
    return { jaResgatou: false, saldo, persistente: false };
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
  resgatar,
  devolver,
};
