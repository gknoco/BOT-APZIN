'use strict';

// Nenhum acesso remoto: node --test testes/pag04-direct-room-refunds.js
const assert = require('node:assert/strict');
const { test } = require('node:test');
const mp = require('../src/servicos/mercadoPago');
const db = require('../src/servicos/roomSalesSupabase');
const compras = require('../src/servicos/comprasSalas');
const id = '550e8400-e29b-41d4-a716-446655440000';
const order = { id, amount_cents: 30, mp_payment_id: 'pay', status: 'approved' };
const base = { id: 'pay', external_reference: id, status: 'approved', transaction_amount: 0.30, currency_id: 'BRL', payment_method_id: 'pix' };

test('estorno positivo é enviado mesmo com status approved e sem coerção de dados', async () => {
  const orig = db.aplicarPagamento;
  let args;
  db.aplicarPagamento = async value => { args = value; return value; };
  try {
    await compras.aplicarPagamentoVerificado(order, { ...base, transaction_amount_refunded: 0.05 });
    assert.equal(args.status, 'approved');
    assert.equal(args.refundedCents, 5);
    assert.equal(args.manualReason, null);
    for (const bad of ['invalido', '-0.01', '0.001', '9999999999999999999999']) {
      await compras.aplicarPagamentoVerificado(order, { ...base, transaction_amount_refunded: bad });
      assert.equal(args.refundedCents, null);
      assert.equal(args.manualReason, 'invalid_refunded_amount');
    }
    await compras.aplicarPagamentoVerificado(order, { ...base, status: 'refunded', currency_id: 'USD', transaction_amount_refunded: 0.05 });
    assert.equal(args.status, 'refunded');
    assert.equal(args.manualReason, 'currency_mismatch');
  } finally { db.aplicarPagamento = orig; }
});

test('verificar compra aprovada novamente consulta o pagamento e aplica estorno atual', async () => {
  const original = { obterPedidoUsuario: db.obterPedidoUsuario, obterPedidoInterno: db.obterPedidoInterno, aplicarPagamento: db.aplicarPagamento, buscarPagamento: mp.buscarPagamento };
  let chamada;
  db.obterPedidoUsuario = async () => order;
  db.obterPedidoInterno = async () => order;
  db.aplicarPagamento = async args => { chamada = args; return { status: 'manual_review' }; };
  mp.buscarPagamento = async () => ({ ...base, transaction_amount_refunded: 0.03 });
  try {
    const atual = await compras.verificarPedido({ orderId: id, guildId: 'g', userId: 'u' });
    assert.equal(atual.status, 'manual_review');
    assert.equal(chamada.refundedCents, 3);
  } finally {
    db.obterPedidoUsuario = original.obterPedidoUsuario;
    db.obterPedidoInterno = original.obterPedidoInterno;
    db.aplicarPagamento = original.aplicarPagamento;
    mp.buscarPagamento = original.buscarPagamento;
  }
});
