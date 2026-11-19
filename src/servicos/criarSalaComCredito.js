'use strict';

const nix = require('./nix');
const vendas = require('./roomSalesSupabase');

function erroDeSaldo(error) {
  const msg = String(error?.message || '');
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
      await vendas.liquidarUsoSala({ requestId, status: estado, errorCode: codigo }).catch((settleError) => {
        console.error('[salas-credito] falha ao persistir resultado Nix:', settleError.message);
      });
      if (!conclusiva) {
        throw new Error('A Nix não confirmou o resultado da criação. O crédito ficou reservado para evitar cobrança duplicada; procure a administração para reconciliar antes de tentar de novo.');
      }
      throw error;
    }
  }

  let creditoLiquidado = true;
  try {
    await vendas.liquidarUsoSala({
      requestId,
      status: 'created',
      roomId: dados.room_id,
      sessionId: dados.session_id,
    });
  } catch (error) {
    creditoLiquidado = false;
    console.error('[salas-credito] sala criada, mas liquidação do crédito está pendente:', error.message);
  }
  return { dados, creditoLiquidado };
}

module.exports = { criar, erroDeSaldo };
