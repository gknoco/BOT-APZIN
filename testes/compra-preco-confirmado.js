'use strict';

// node --test testes/compra-preco-confirmado.js — cliente simulado, sem rede.
const test = require('node:test');
const assert = require('node:assert/strict');
const supabase = require('../src/servicos/supabase');
const royal = require('../src/servicos/royalSupabase');

const entrada = { guildId: 123, userId: 456, itemId: 'item-uuid', request: 'req-12345' };
let chamadas = [];
let resposta = { data: [{ purchase_id: 'compra-1', item_name: 'Item', new_balance: 90, status: 'pending' }], error: null };
const obterOriginal = supabase.obterCliente;
supabase.obterCliente = () => ({
  rpc: async (nome, args) => { chamadas.push({ nome, args }); return resposta; },
});
test.after(() => { supabase.obterCliente = obterOriginal; });
test.beforeEach(() => {
  chamadas = [];
  resposta = { data: [{ purchase_id: 'compra-1', item_name: 'Item', new_balance: 90, status: 'pending' }], error: null };
});

test('sem expectedPrice mantém RPC, argumentos e retorno antigos', async () => {
  assert.deepEqual(await royal.comprar(entrada), resposta.data[0]);
  assert.deepEqual(chamadas, [{ nome: 'royal_buy_item', args: {
    p_guild_id: '123', p_user_id: '456', p_item_id: 'item-uuid', p_request_id: 'buy:req-12345',
  } }]);
});

test('com expectedPrice usa somente a RPC confirmada, inclusive zero', async () => {
  for (const valor of [10, 0, '9007199254740993', 9223372036854775807n]) {
    chamadas = [];
    assert.deepEqual(await royal.comprar({ ...entrada, expectedPrice: valor }), resposta.data[0]);
    assert.equal(chamadas.length, 1);
    assert.equal(chamadas[0].nome, 'royal_buy_item_confirmed');
    assert.deepEqual(chamadas[0].args, {
      p_guild_id: '123', p_user_id: '456', p_item_id: 'item-uuid', p_request_id: 'buy:req-12345',
      p_expected_price: typeof valor === 'number' ? valor : valor.toString(),
    });
  }
});

test('valor nulo, não inteiro, impreciso ou fora do bigint falha sem fallback inseguro', async () => {
  for (const valor of [null, NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '', '1.2', 'abc', '-1', '9223372036854775808', 9223372036854775808n, {}]) {
    await assert.rejects(royal.comprar({ ...entrada, expectedPrice: valor }), /Preço esperado inválido/);
  }
  assert.deepEqual(chamadas, []);
});

test('erro de preço do banco é propagado sem chamar RPC antiga', async () => {
  resposta = { data: null, error: { message: 'O preço mudou' } };
  await assert.rejects(royal.comprar({ ...entrada, expectedPrice: 10 }), /royal_buy_item_confirmed: O preço mudou/);
  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0].nome, 'royal_buy_item_confirmed');
});

test('request ausente continua gerando id prefixado para ambas as rotas', async () => {
  await royal.comprar({ ...entrada, request: undefined });
  await royal.comprar({ ...entrada, request: undefined, expectedPrice: 10 });
  assert.match(chamadas[0].args.p_request_id, /^buy:[0-9a-f-]{36}$/);
  assert.match(chamadas[1].args.p_request_id, /^buy:[0-9a-f-]{36}$/);
  assert.notEqual(chamadas[0].args.p_request_id, chamadas[1].args.p_request_id);
});
