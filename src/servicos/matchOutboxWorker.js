'use strict';

const crypto = require('node:crypto');
const { rpc } = require('../db/consultas');
const { obterConfig } = require('../db');
const config = require('../config');
const { embedLog } = require('../util/embeds');
const fluxo = require('./fluxo');

let timer = null;
let ocupado = false;

// Discord deduplica nonce por uma janela curta, não para sempre. O mesmo ID é
// reutilizado após falhas e reinícios; isso não fornece exactly-once externo.
function nonceEvento(evento) {
  return crypto.createHash('sha256').update(`match-log:${evento.id}`).digest('hex').slice(0, 24);
}

async function processarEvento(client, db, evento, token) {
  if (evento.tipo === 'economia_legada') {
    const aplicado = await rpc(db, 'royal_match_outbox_economia_legada', { p_id: String(evento.id), p_token: token });
    if (!aplicado) throw new Error('lease da economia não pertence mais ao consumidor');
    return;
  }
  if (evento.tipo === 'cartao') {
    if (!await fluxo.atualizarPartida(client, db, evento.partida_id)) {
      throw new Error('cartão não foi atualizado; conferir canal e mensagem');
    }
  } else if (evento.tipo === 'log') {
    const p = evento.payload;
    const canalId = await obterConfig(db, p.guild_id, 'canal_logs', config.CANAL_LOGS_ID);
    if (!canalId) throw new Error('canal de logs não configurado');
    const canal = client.channels.cache.get(String(canalId)) || await client.channels.fetch(String(canalId));
    if (!canal?.isTextBased?.() || typeof canal.send !== 'function'
        || String(canal.guildId || canal.guild?.id || '') !== String(p.guild_id)) {
      throw new Error('canal de logs indisponível ou pertence a outro servidor');
    }
    await canal.send({
      embeds: [embedLog(p.acao, p.detalhe || '—', p.autor_id)],
      nonce: nonceEvento(evento), enforceNonce: true, allowedMentions: { parse: [] },
    });
  } else {
    throw new Error(`tipo de evento desconhecido: ${evento.tipo}`);
  }
  const confirmado = await rpc(db, 'royal_match_outbox_concluir', {
    p_id: String(evento.id), p_token: token, p_sucesso: true, p_erro: null,
  });
  if (!confirmado) console.warn(`[match-outbox] evento ${evento.id}: lease perdido antes da confirmação.`);
}

async function processarLote(client, db) {
  if (ocupado || !client?.isReady?.()) return;
  ocupado = true;
  try {
    for (let i = 0; i < 10; i++) {
      const token = crypto.randomUUID();
      const evento = await rpc(db, 'royal_match_outbox_reivindicar', { p_token: token });
      if (!evento) break;
      try {
        await processarEvento(client, db, evento, token);
      } catch (erro) {
        // Nunca apaga o trabalho após erro, inclusive após resposta ambígua.
        // Uma tentativa externa pode ter sido aceita mesmo se o HTTP falhou.
        await rpc(db, 'royal_match_outbox_concluir', {
          p_id: String(evento.id), p_token: token, p_sucesso: false,
          p_erro: String(erro?.message || 'erro de processamento').slice(0, 500),
        }).catch((falha) => console.error('[match-outbox] falha ao reagendar:', falha.message));
        console.error(`[match-outbox] evento ${evento.id} (${evento.tipo}) pendente:`, erro.message);
      }
    }
  } catch (erro) {
    console.error('[match-outbox] falha ao reivindicar:', erro.message);
  } finally {
    ocupado = false;
  }
}

function iniciar(client, db) {
  if (timer) return;
  timer = setInterval(() => { void processarLote(client, db); }, 5000);
  timer.unref?.();
  void processarLote(client, db);
  console.log('[match-outbox] consumidor durável iniciado.');
}
function parar() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { iniciar, parar, processarLote, processarEvento, nonceEvento };
