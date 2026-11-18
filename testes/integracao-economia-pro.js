'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const registro = require('../src/comandos');
const economia = require('../src/comandos/economia');
const royal = require('../src/servicos/royalSupabase');
const lojinha = require('../src/comandos/lojinhaPro');

function interacao(sub, numero) {
  return {
    guildId: 'servidor', id: 'interacao-123456789',
    user: { id: 'staff' },
    member: { permissions: { has: () => true } },
    options: {
      getSubcommand: () => sub,
      getUser: () => ({ id: 'jogador' }),
      getInteger: () => numero,
      getNumber: () => numero,
    },
    deferred: true,
    editReply: async () => ({}),
  };
}

test('as definições registradas são únicas e contêm os painéis solicitados', () => {
  const definicoes = registro.definicoes();
  const nomes = definicoes.map((c) => c.name);
  assert.equal(nomes.length, new Set(nomes).size);
  const subs = (nome) => definicoes.find((c) => c.name === nome).options.map((o) => o.name);
  assert.ok(subs('roleta').includes('painel'));
  assert.ok(subs('roleta').includes('girar'));
  assert.ok(subs('loja').includes('painel'));
  assert.ok(subs('loja').includes('addcoins'));
  assert.ok(subs('config').includes('roleta'));
  assert.ok(subs('config').includes('lojinha'));
});

test('/loja painel encaminha à publicação profissional', async () => {
  const original = lojinha.publicarPainel;
  let publicou = false;
  lojinha.publicarPainel = async () => { publicou = true; };
  try {
    const comando = economia.comandos.find((c) => c.data.name === 'loja');
    await comando.executar(interacao('painel', null), {});
    assert.equal(publicou, true);
  } finally { lojinha.publicarPainel = original; }
});

test('vitórias manuais acrescentam um coin por vitória na mesma transação', async () => {
  const ajustar = royal.ajustarPerfil;
  const auditar = royal.auditar;
  const chamadas = [];
  royal.ajustarPerfil = async (argumentos) => {
    chamadas.push(argumentos);
    return { wins: 3, losses: 0, coins: 3 };
  };
  royal.auditar = async () => {};
  try {
    await economia.comandos.find((c) => c.data.name === 'addvitoria').executar(interacao(null, 3), {});
    await economia.comandos.find((c) => c.data.name === 'vitoria').executar(interacao(null, 5), {});
    assert.deepEqual(chamadas[0].deltas, { wins: 3, coins: 3 });
    assert.deepEqual(chamadas[1].deltas, { wins: 1, coins: 1, apostado: 500, ganho: 500 });
  } finally {
    royal.ajustarPerfil = ajustar;
    royal.auditar = auditar;
  }
});
