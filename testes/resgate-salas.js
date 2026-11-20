'use strict';

// node --test testes/resgate-salas.js — sem qualquer acesso à rede.
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const { test } = require('node:test');
const { EFEMERO } = require('../src/util/seguranca');

const supabase = { obterCliente: () => { throw new Error('cliente não configurado'); } };
const alvo = path.resolve(__dirname, '../src/servicos/supabase.js');
const carregar = Module._load;
Module._load = function (request, parent, main) {
  if (Module._resolveFilename(request, parent, main) === alvo) return supabase;
  return carregar.call(this, request, parent, main);
};
let vendas;
let comando;
let legado;
try {
  vendas = require('../src/servicos/roomSalesSupabase');
  comando = require('../src/comandos/resgatarSalas').comandos[0];
  legado = require('./fixtures/resgate-legado');
} finally { Module._load = carregar; }

function interacao(autorizado = true) {
  const chamadas = [];
  const i = {
    guildId: 'guild', user: { id: 'user' }, chamadas, deferred: false, replied: false,
    member: { roles: { cache: new Map(autorizado ? [['1543684028719173732', {}]] : []) } },
    deferReply: async (dados) => { chamadas.push(['deferReply', dados]); i.deferred = true; },
    reply: async (dados) => { chamadas.push(['reply', dados]); i.replied = true; },
    editReply: async (dados) => { chamadas.push(['editReply', dados]); },
  };
  return i;
}
const descricao = (i) => i.chamadas.at(-1)[1].embeds[0].toJSON().description;

async function comCliente(cliente, executar) {
  const original = supabase.obterCliente;
  supabase.obterCliente = () => cliente;
  try { return await executar(); } finally { supabase.obterCliente = original; }
}

test('resgate usa somente a RPC com chave estável; cada replay consulta a fonte de verdade', async () => {
  const chamadas = [];
  const cliente = {
    from: () => { throw new Error('escrita ou consulta direta proibida'); },
    rpc: async (nome, args) => {
      chamadas.push({ nome, args });
      return { data: { redeemed: chamadas.length === 1, available_rooms: chamadas.length === 1 ? 10 : -2 }, error: null };
    },
  };
  await comCliente(cliente, async () => {
    assert.deepEqual(await vendas.resgatarSalasIniciais({ guildId: ' guild ', userId: 'user' }), { redeemed: true, available_rooms: 10 });
    assert.deepEqual(await vendas.resgatarSalasIniciais({ guildId: 'guild', userId: 'user' }), { redeemed: false, available_rooms: -2 });
    assert.equal(chamadas.length, 2);
    for (const chamada of chamadas) assert.deepEqual(chamada, {
      nome: 'royal_room_credit_initial_redemption',
      args: { p_guild_id: 'guild', p_user_id: 'user', p_request_id: 'initial-redeem:guild:user', p_rooms_quantity: 10 },
    });
  });
});

test('erro ou resposta perdida nunca provoca crédito paralelo nem sucesso de memória; retry usa a mesma chave', async () => {
  const chamadas = [];
  const cliente = {
    from: () => { throw new Error('fallback direto proibido'); },
    rpc: async (nome, args) => {
      chamadas.push(args.p_request_id);
      if (chamadas.length === 1) return { data: null, error: { message: 'connection lost after COMMIT' } };
      return { data: { redeemed: false, idempotent: true, available_rooms: 10 }, error: null };
    },
  };
  await comCliente(cliente, async () => {
    await assert.rejects(vendas.resgatarSalasIniciais({ guildId: 'g', userId: 'u' }), /connection lost/);
    const resposta = await vendas.resgatarSalasIniciais({ guildId: 'g', userId: 'u' });
    assert.equal(resposta.redeemed, false);
    assert.deepEqual(chamadas, ['initial-redeem:g:u', 'initial-redeem:g:u']);
  });
});

test('resposta incompleta ou malformada não é interpretada como sucesso', async () => {
  for (const data of [null, {}, { redeemed: true }, { redeemed: true, available_rooms: null },
    { redeemed: true, available_rooms: true }, { redeemed: true, available_rooms: '  ' }, { redeemed: 'true', available_rooms: 10 },
    { redeemed: true, available_rooms: '9007199254740992' }]) {
    await comCliente({ rpc: async () => ({ data, error: null }) }, async () => {
      await assert.rejects(vendas.resgatarSalasIniciais({ guildId: 'g', userId: 'u' }), /não confirmou/);
    });
  }
  await assert.rejects(vendas.resgatarSalasIniciais({ guildId: '', userId: 'u' }), /Dados inválidos/);
  await assert.rejects(vendas.resgatarSalasIniciais({ guildId: 'g', userId: 'u', quantidade: 1.5 }), /Dados inválidos/);
});

test('comando responde em privado após confirmação, reconhece repetição e não concede sem cargo', async () => {
  let chamadas = 0;
  await comCliente({ rpc: async () => ({ data: { redeemed: ++chamadas === 1, available_rooms: 10 }, error: null }) }, async () => {
    const sucesso = interacao();
    await comando.executar(sucesso, {});
    assert.equal(sucesso.chamadas[0][1].flags & EFEMERO, EFEMERO);
    assert.match(descricao(sucesso), /resgatou.*10 salas/);
    const repetido = interacao();
    await comando.executar(repetido, {});
    assert.match(descricao(repetido), /já resgatou/);
    const negado = interacao(false);
    await comando.executar(negado, {});
    assert.match(descricao(negado), /Apenas mediadores/);
    assert.equal(chamadas, 2);
  });
});

test('comando informa falha incerta e revisão histórica, nunca sucesso falso', async () => {
  const logOriginal = console.error;
  console.error = () => {};
  try {
    for (const [msg, padrao] of [['timeout', /Não foi possível confirmar/], ['INITIAL_ROOM_REDEMPTION_REVIEW_REQUIRED', /histórico de salas precisa de revisão/]]) {
      await comCliente({ rpc: async () => ({ error: { message: msg } }) }, async () => {
        const i = interacao();
        await comando.executar(i, {});
        assert.deepEqual(i.chamadas.map(([nome]) => nome), ['deferReply', 'editReply']);
        assert.match(descricao(i), padrao);
        assert.doesNotMatch(descricao(i), /resgatou \*\*10/);
      });
    }
  } finally { console.error = logOriginal; }
});

test('fixture histórica: revisão e INSERT negado ainda produzem sucesso falso em memória', async () => {
  let escritasNegadas = 0;
  const cliente = {
    rpc: async () => ({ data: null, error: { message: 'INITIAL_ROOM_REDEMPTION_REVIEW_REQUIRED' } }),
    from: (tabela) => {
      const consulta = {
        select: () => consulta,
        eq: () => consulta,
        maybeSingle: async () => ({ data: tabela === 'royal_room_wallets'
          ? { purchased_rooms: 10, reserved_rooms: 0, consumed_rooms: 0, reversed_rooms: 0 } : null, error: null }),
        upsert: async () => { escritasNegadas++; return { error: { message: 'permission denied for table royal_room_wallets' } }; },
      };
      return consulta;
    },
  };
  const logOriginal = console.warn;
  console.warn = () => {};
  try {
    await comCliente(cliente, async () => {
      const resultado = await legado.resgatarSalasIniciais({ guildId: 'legacy-memory', userId: 'u' });
      assert.equal(escritasNegadas, 2);
      assert.equal(resultado.redeemed, true);
      assert.equal(resultado.memory_fallback, true);
      assert.equal(resultado.available_rooms, 10);
    });
  } finally { console.warn = logOriginal; }
});
