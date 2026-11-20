'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const worker = require('../src/servicos/matchOutboxWorker');
const fluxo = require('../src/servicos/fluxo');
const partidas = require('../src/servicos/partidas');

function dbFalso(rpc, canal = 'logs') {
  return { client: {
    rpc: async (nome, args) => rpc(nome, args),
    from: () => ({ select() { return this; }, eq() { return this; },
      async maybeSingle() { return { data: { valor: canal }, error: null }; } }),
  } };
}
const ready = (channel) => ({ isReady: () => true, channels: { cache: new Map([['logs', channel]]), fetch: async () => channel } });
const ok = (data) => ({ data, error: null });

test('o mesmo resultado é repetido após timeout ou resposta incompleta, sem RPC econômica separada', async () => {
  const chamadas = [];
  const resultado = { partida: { id: 'p', status: 'finalizada', vencedor_time: 1, motivo_fim: 'resultado' }, jogadores: [] };
  const db = dbFalso(async (nome, args) => {
    chamadas.push([nome, args]);
    return chamadas.length === 1 ? ok(null) : ok(resultado);
  });
  assert.deepEqual(await partidas.finalizar(db, { partidaId: 'p', vencedorTime: 1, autorId: 'adm' }), resultado);
  assert.equal(chamadas.length, 2);
  assert.deepEqual(chamadas[0], chamadas[1]);
  assert.equal(chamadas[0][0], 'royal_operacional_encerrar_partida');
  await assert.rejects(() => partidas.finalizar(dbFalso(async () => { throw new Error('timeout'); }),
    { partidaId: 'p', vencedorTime: 1 }), /pode ter sido concluído/);
});

test('erro SQL definitivo não é apresentado como incerteza e não é repetido', async () => {
  let chamadas = 0;
  const db = dbFalso(async () => { chamadas++; return { data: null, error: { code: 'P0001', message: 'outro resultado' } }; });
  await assert.rejects(() => partidas.finalizar(db, { partidaId: 'p', vencedorTime: 1 }), /outro resultado/);
  assert.equal(chamadas, 1);
});

test('log usa nonce estável e confirma somente depois do envio; replay reaproveita o nonce', async () => {
  const chamadas = []; const enviados = [];
  const db = dbFalso(async (nome, args) => { chamadas.push([nome, args]); return ok(true); });
  const canal = { guildId: 'g', isTextBased: () => true, send: async (payload) => { enviados.push(payload); } };
  const ev = { id: '9007199254740993', tipo: 'log', partida_id: 'p', payload: { guild_id: 'g', acao: 'Resultado', detalhe: 'd', autor_id: 'a' } };
  await worker.processarEvento(ready(canal), db, ev, 'token-a');
  await worker.processarEvento(ready(canal), db, ev, 'token-b');
  assert.equal(enviados[0].nonce, enviados[1].nonce);
  assert.equal(enviados[0].nonce.length, 24);
  assert.equal(enviados[0].enforceNonce, true);
  assert.deepEqual(enviados[0].allowedMentions, { parse: [] });
  assert.equal(chamadas[0][1].p_id, '9007199254740993');
  assert.equal(chamadas[0][1].p_sucesso, true);
});

test('falha do Discord reagenda, e erro de confirmação após envio também deixa evento recuperável', async () => {
  for (const falharEnvio of [true, false]) {
    const chamadas = []; let capturado = false; let envios = 0;
    const db = dbFalso(async (nome, args) => {
      chamadas.push([nome, args]);
      if (nome === 'royal_match_outbox_reivindicar') {
        if (capturado) return ok(null);
        capturado = true;
        return ok({ id: '123', tipo: 'log', payload: { guild_id: 'g', acao: 'Resultado' } });
      }
      if (args.p_sucesso && !falharEnvio) throw new Error('resposta perdida');
      return ok(true);
    });
    const canal = { guildId: 'g', isTextBased: () => true, async send() { envios++; if (falharEnvio) throw new Error('timeout Discord'); } };
    await worker.processarLote(ready(canal), db);
    assert.equal(envios, 1);
    assert.equal(chamadas.filter(([nome, args]) => nome === 'royal_match_outbox_concluir' && args.p_sucesso === false).length, 1);
  }
});

test('cartão não confirmado é reagendado, economia legada só conclui na RPC atômica', async () => {
  const antigo = fluxo.atualizarPartida;
  const chamadas = []; let reivindicadas = 0;
  const eventos = [ { id: '1', tipo: 'cartao', partida_id: 'p' }, { id: '2', tipo: 'economia_legada', partida_id: 'p2' } ];
  const db = dbFalso(async (nome, args) => {
    chamadas.push([nome, args]);
    if (nome === 'royal_match_outbox_reivindicar') return ok(eventos[reivindicadas++] || null);
    return ok(true);
  });
  fluxo.atualizarPartida = async () => false;
  try { await worker.processarLote(ready(), db); } finally { fluxo.atualizarPartida = antigo; }
  assert.ok(chamadas.some(([n, a]) => n === 'royal_match_outbox_concluir' && a.p_id === '1' && a.p_sucesso === false));
  assert.ok(chamadas.some(([n, a]) => n === 'royal_match_outbox_economia_legada' && a.p_id === '2'));
  assert.ok(!chamadas.some(([n, a]) => n === 'royal_match_outbox_concluir' && a.p_id === '2' && a.p_sucesso === true));
});

test('sem conexão Discord não reivindica; iniciar e parar são seguros', async () => {
  let chamadas = 0;
  const db = dbFalso(async () => { chamadas++; return ok(null); });
  const client = { isReady: () => false };
  await worker.processarLote(client, db);
  worker.iniciar(client, db); worker.iniciar(client, db); worker.parar();
  assert.equal(chamadas, 0);
});

test('log nunca vaza para canal de outra guild', async () => {
  let envios = 0;
  const db = dbFalso(async () => ok(true));
  const canal = { guildId: 'outra', isTextBased: () => true, async send() { envios++; } };
  await assert.rejects(() => worker.processarEvento(ready(canal), db,
    { id: '1', tipo: 'log', payload: { guild_id: 'g', acao: 'Resultado' } }, 'token'), /outro servidor/);
  assert.equal(envios, 0);
});
