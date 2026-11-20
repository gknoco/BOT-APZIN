'use strict';

// node --test testes/compra-preco-confirmado.js — cliente simulado, sem rede.
const test = require('node:test');
const assert = require('node:assert/strict');
const supabase = require('../src/servicos/supabase');
const royal = require('../src/servicos/royalSupabase');

let chamadas = [];
let resposta = { data: [{ purchase_id: 'compra-1', item_name: 'Item', new_balance: '90', status: 'pending' }], error: null };
const obterOriginal = supabase.obterCliente;
supabase.obterCliente = () => ({ rpc: async (nome, args) => { chamadas.push({ nome, args }); return resposta; } });
test.after(() => { supabase.obterCliente = obterOriginal; });
test.beforeEach(() => {
  chamadas = [];
  resposta = { data: [{ purchase_id: 'compra-1', item_name: 'Item', new_balance: '90', status: 'pending' }], error: null };
});

test('não exporta compra legada sem nonce', () => {
  assert.equal(royal.comprar, undefined);
});

test('intenção e confirmação usam o nonce persistido, sem fallback à compra legada', async () => {
  await royal.criarIntencaoLoja({ guildId: 123, userId: 456, itemId: 'item-uuid', sourceId: 'source-123' });
  await royal.confirmarIntencaoLoja({ guildId: 123, userId: 456, nonce: 'nonce-uuid' });
  assert.deepEqual(chamadas, [
    { nome: 'royal_create_shop_intention', args: { p_guild_id: '123', p_user_id: '456', p_item_id: 'item-uuid', p_source_id: 'source-123' } },
    { nome: 'royal_confirm_shop_intention', args: { p_guild_id: '123', p_user_id: '456', p_nonce: 'nonce-uuid' } },
  ]);
  await assert.rejects(royal.criarIntencaoLoja({ guildId: 123, userId: 456, itemId: 'item-uuid' }), /obrigatória/);
  await assert.rejects(royal.confirmarIntencaoLoja({ guildId: 123, userId: 456 }), /obrigatório/);
});

test('erro da RPC de intenção é propagado sem qualquer fallback', async () => {
  resposta = { data: null, error: { message: 'O preço mudou' } };
  await assert.rejects(royal.confirmarIntencaoLoja({ guildId: 123, userId: 456, nonce: 'nonce-uuid' }), /royal_confirm_shop_intention: O preço mudou/);
  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0].nome, 'royal_confirm_shop_intention');
});
