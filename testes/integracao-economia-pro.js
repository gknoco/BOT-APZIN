'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const registro = require('../src/comandos');
const economia = require('../src/comandos/economia');
const royal = require('../src/servicos/royalSupabase');
const { registrarComandos } = require('../src/servicos/registroComandos');

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
  assert.deepEqual(subs('painel'), ['geral', 'roleta', 'lojinha']);
  assert.deepEqual(subs('addcoins'), ['usuario', 'quantidade']);
  assert.deepEqual(subs('removercoins'), ['usuario', 'quantidade']);
  assert.deepEqual(subs('config'), ['lojinha']);
  for (const nome of ['registrar_pix', 'resgates', 'roleta', 'lojinhapainel', 'loja']) {
    assert.equal(nomes.includes(nome), false, `/${nome} não deve estar registrado`);
  }
  for (const nome of ['addcoins', 'removercoins']) assert.equal(nomes.filter((item) => item === nome).length, 1);
  assert.equal(nomes.filter((item) => item === 'configroleta').length, 1);
});

test('sincronização envia a configuração atual em escopos global e de servidor', async () => {
  for (const guildId of [null, '456']) {
    let requisicao;
    const rest = { put: async (rota, payload) => { requisicao = { rota, payload }; } };
    const resultado = await registrarComandos({ clientId: '123', guildId, definicoes: registro.definicoes(), rest });
    assert.equal(requisicao.rota, guildId ? '/applications/123/guilds/456/commands' : '/applications/123/commands');
    assert.equal(resultado.guildId, guildId);
    assert.deepEqual(requisicao.payload.body.find((c) => c.name === 'config').options.map((o) => o.name), ['lojinha']);
    assert.equal(requisicao.payload.body.filter((c) => c.name === 'configroleta').length, 1);
  }
});

test('/painel lojinha encaminha à publicação profissional', async () => {
  const i = interacao('lojinha', null);
  i.guildId = null;
  let resposta;
  i.editReply = async (payload) => { resposta = payload; };
  await registro.buscar('painel').executar(i, {});
  assert.match(resposta.embeds[0].toJSON().description, /Use este comando em um servidor/);
});

test('/painel roleta encaminha para o publisher da roleta', async () => {
  const i = interacao('roleta', null);
  i.guildId = null;
  let resposta;
  i.editReply = async (payload) => { resposta = payload; };
  await registro.buscar('painel').executar(i, {});
  assert.match(resposta.embeds[0].toJSON().description, /Use este comando dentro de um servidor/);
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

test('/addcoins e /removercoins mantêm os ajustes e eventos de auditoria existentes', async () => {
  const ajustar = royal.ajustarPerfil;
  const auditar = royal.auditar;
  const ajustes = [], auditorias = [];
  royal.ajustarPerfil = async (args) => { ajustes.push(args); return { coins: args.deltas.coins === 5 ? 15 : 5 }; };
  royal.auditar = async (args) => auditorias.push(args);
  try {
    for (const name of ['addcoins', 'removercoins']) {
      const command = economia.comandos.find((item) => item.data.name === name);
      await command.executar(interacao(null, 5));
    }
    assert.deepEqual(ajustes.map((item) => item.deltas.coins), [5, -5]);
    assert.deepEqual(auditorias.map((item) => item.action), ['wallet.coins.credit', 'wallet.coins.debit']);
    assert.deepEqual(ajustes.map((item) => item.reason), ['crédito da staff', 'débito da staff']);
  } finally {
    royal.ajustarPerfil = ajustar;
    royal.auditar = auditar;
  }
});
