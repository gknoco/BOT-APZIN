'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const base = require('../src/servicos/supabase');
const compras = require('../src/servicos/roomSalesSupabase');
const recargas = require('../src/servicos/recargasSupabase');
const infinita = require('../src/servicos/salaInfinitaSupabase');

const fluxos = [
  { tabela: 'royal_room_purchase_orders', chamar: () => compras.obterPixPedidoUsuario({ orderId: 'p', guildId: 'g', userId: 'u' }), codigo: (r) => r?.pix_copy_paste ?? null },
  { tabela: 'royal_wallet_topups', chamar: () => recargas.obterCodigoPixUsuario({ topupId: 'p', guildId: 'g', userId: 'u' }), codigo: (r) => r },
  { tabela: 'royal_infinite_orders', chamar: () => infinita.obterCodigoPixUsuario({ orderId: 'p', guildId: 'g', userId: 'u' }), codigo: (r) => r },
];

for (const fluxo of fluxos) {
  test(`${fluxo.tabela}: somente o dono acessa Pix pendente, intacto`, async () => {
    const original = base.obterCliente;
    const codigo = '000201 código `sem alterações`  ';
    let linha = { id: 'p', guild_id: 'g', user_id: 'u', status: 'pending', pix_copy_paste: codigo };
    base.obterCliente = () => ({ from(tabela) {
      assert.equal(tabela, fluxo.tabela);
      const filtros = [];
      return {
        select() { return this; },
        eq(chave, valor) { filtros.push([chave, valor]); return this; },
        async maybeSingle() { return { data: filtros.every(([k, v]) => linha[k] === v) ? linha : null, error: null }; },
      };
    } });
    try {
      assert.equal(fluxo.codigo(await fluxo.chamar()), codigo);
      for (const status of ['creating', 'approved', 'manual_review', 'failed', 'rejected', 'cancelled', 'expired', 'refunded', 'charged_back']) {
        linha = { ...linha, status };
        assert.equal(fluxo.codigo(await fluxo.chamar()), null, status);
      }
      for (const dados of [{ guild_id: 'outra' }, { user_id: 'outro' }]) {
        linha = { id: 'p', guild_id: 'g', user_id: 'u', status: 'pending', pix_copy_paste: codigo, ...dados };
        assert.equal(fluxo.codigo(await fluxo.chamar()), null);
      }
    } finally {
      base.obterCliente = original;
    }
  });
}
