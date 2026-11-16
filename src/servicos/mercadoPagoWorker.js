'use strict';

const config = require('../config');
const vendas = require('./roomSalesSupabase');
const compras = require('./comprasSalas');

let timer = null;
let ocupado = false;

async function processarLote() {
  if (ocupado || !config.MP_ACCESS_TOKEN) return;
  ocupado = true;
  try {
    const eventos = await vendas.reivindicarEventos(5);
    for (const evento of eventos) {
      try {
        const resultado = await compras.processarEventoWebhook(evento);
        await vendas.finalizarEvento({ eventId: evento.id, success: true });
        if (resultado?.resultado?.status === 'manual_review') {
          console.error(`[mp-worker] pedido ${evento.payment_id} requer revisão; nenhum crédito foi liberado.`);
        }
      } catch (error) {
        const codigo = compras.resumoErro(error);
        await vendas.finalizarEvento({ eventId: evento.id, success: false, errorCode: codigo }).catch((dbError) => {
          console.error('[mp-worker] não consegui reagendar evento:', dbError.message);
        });
        console.error(`[mp-worker] evento ${evento.id} será tentado novamente (${codigo}).`);
      }
    }
  } catch (error) {
    console.error('[mp-worker] não consegui consultar fila de webhooks:', error.message);
  } finally {
    ocupado = false;
  }
}

function iniciar() {
  if (!config.MP_ACCESS_TOKEN) {
    console.log('[mp-worker] aguardando MP_ACCESS_TOKEN no ambiente para processar notificações.');
    return () => {};
  }
  if (timer) return () => parar();
  timer = setInterval(processarLote, 5000);
  if (typeof timer.unref === 'function') timer.unref();
  void processarLote();
  console.log('[mp-worker] processamento durável de notificações Mercado Pago ativo.');
  return () => parar();
}

function parar() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { iniciar, parar, processarLote };
