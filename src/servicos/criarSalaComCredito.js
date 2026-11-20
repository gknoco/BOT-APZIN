'use strict';

const nix = require('./nix');
const vendas = require('./roomSalesSupabase');

function erroDeSaldo(error) {
  const msg = String(error?.message || '');
  if (/ROOM_WALLET_FROZEN_FOR_REVIEW/i.test(msg)) return new Error('Sua carteira de salas está bloqueada para revisão de um estorno ou chargeback. Nenhuma sala foi criada; procure a administração para reconciliar o saldo.');
  if (/INSUFFICIENT_ROOM_CREDITS/i.test(msg)) return new Error('Você não tem salas disponíveis. Adquira mais pelo painel **ROYAL SALA**.');
  if (/ROOM_ALREADY_CREATED/i.test(msg)) return new Error('Esta partida já teve uma sala criada.');
  if (/ROOM_CREATION_PENDING/i.test(msg)) return new Error('A criação desta sala ainda está pendente ou em reconciliação. Não tente novamente para evitar criar uma sala duplicada.');
  return error;
}

async function criar({ guildId, userId, requestId, source, sourceRef, sala }) {
  if (!guildId || !userId || !requestId) throw new Error('Servidor, mediador e identificador da operação são obrigatórios.');
  if (!nix.configurado()) throw new nix.ErroNix('A API da Nix não está configurada. Defina NIX_API_KEY no ambiente do bot.');
  nix.validarCriacaoSala(sala);

  try {
    await vendas.reservarSala({ guildId, userId, requestId, source, sourceRef });
  } catch (error) {
    throw erroDeSaldo(error);
  }

  let dados;
  try {
    dados = await nix.criarSala(sala);
  } catch (error) {
    if (!dados) {
      const status = Number(error?.status || 0);
      const resultadoIncerto = [408, 409, 425, 429].includes(status);
      const conclusiva = error instanceof nix.ErroNix && status >= 400 && status < 500 && !resultadoIncerto;
      const estado = conclusiva ? 'failed' : 'unknown';
      const codigo = conclusiva ? `nix_http_${status}` : 'nix_result_unknown';
      try {
        const liquidacao = await vendas.liquidarUsoSala({ requestId, status: estado, errorCode: codigo });
        if (liquidacao?.status && liquidacao.status !== estado) throw new Error(`status retornado ${liquidacao.status}`);
      } catch (settleError) {
        console.error('[salas-credito] falha ao persistir resultado Nix; a reserva permanece bloqueada:', settleError.message);
        throw new Error('Não foi possível confirmar no Supabase o resultado da Nix. O crédito permanece reservado; não tente novamente até a reconciliação administrativa.');
      }
      if (!conclusiva) {
        throw new Error('A Nix não confirmou o resultado da criação. O crédito ficou reservado para evitar cobrança duplicada; procure a administração para reconciliar antes de tentar de novo.');
      }
      throw error;
    }
  }

  try {
    const liquidacao = await vendas.liquidarUsoSala({
      requestId,
      status: 'created',
      roomId: dados.room_id,
      sessionId: dados.session_id,
    });
    if (liquidacao?.status && liquidacao.status !== 'created') throw new Error(`status retornado ${liquidacao.status}`);
  } catch (error) {
    console.error('[salas-credito] sala criada, mas liquidação do crédito está pendente; a reserva permanece bloqueada:', error.message);
    throw new Error('A sala foi criada na Nix, mas o Supabase não confirmou a liquidação do crédito. Não tente criar outra sala; procure a administração para reconciliar.');
  }
  return { dados, creditoLiquidado: true };
}

module.exports = { criar, erroDeSaldo };
