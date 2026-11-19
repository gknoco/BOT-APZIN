'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const animacao = require('../src/servicos/roletaAnimada');

const VOLTA = 2 * Math.PI;

test('o ponteiro para no centro exato do prêmio sorteado para qualquer quantidade e posição', () => {
  for (const quantidade of [1, 2, 3, 4, 7, 24, 25, 100, 201]) {
    for (let indice = 0; indice < quantidade; indice++) {
      const angulos = animacao.planejarGiro(indice, quantidade);
      assert.equal(angulos.length, 13);
      assert.equal(animacao.indiceNoPonteiro(angulos.at(-1), quantidade), indice);
      const largura = VOLTA / quantidade;
      const posicao = ((-angulos.at(-1) % VOLTA) + VOLTA) % VOLTA;
      assert.ok(Math.abs(posicao - (indice + 0.5) * largura) < 1e-10);
      const passos = angulos.slice(1).map((a, i) => a - angulos[i]);
      assert.ok(passos.every((passo) => passo > 0 && passo < Math.PI));
      assert.ok(passos.every((passo, i) => i === 0 || passo < passos[i - 1]));
    }
  }
});

test('o setor vencedor usa ID e snapshot da transação, inclusive com catálogo alterado ou indisponível', () => {
  const catalogo = [
    { id: 'a', name: 'Mesmo nome' },
    { id: 'b', name: 'Nome antigo' },
    { id: 'c', name: 'Mesmo nome' },
  ];
  const resultado = { prize_id: 'b', prize_name: 'Prêmio realmente creditado' };
  const escolhido = animacao.prepararPremios(catalogo, resultado);
  assert.equal(escolhido.indice, 1);
  assert.equal(escolhido.lista[escolhido.indice].name, resultado.prize_name);
  assert.equal(escolhido.lista[escolhido.indice].id, resultado.prize_id);
  assert.equal(catalogo[1].name, 'Nome antigo');
  const ausente = animacao.prepararPremios(catalogo, { prize_id: 'd', prize_name: 'Último estoque' });
  assert.deepEqual(ausente.lista[ausente.indice], { id: 'd', name: 'Último estoque' });
  const semCatalogo = animacao.prepararPremios(null, resultado);
  assert.deepEqual(semCatalogo.lista, [{ id: 'b', name: resultado.prize_name }]);
  assert.equal(semCatalogo.indice, 0);
});

test('renderiza PNGs diferentes e trata caracteres especiais dos prêmios', () => {
  const lista = [{ id: 'a', name: '<Coins & giros>' }, { id: 'b', name: 'PIX R$ 10,00' }];
  const primeiro = animacao.desenharQuadro(lista, 0);
  const ultimo = animacao.desenharQuadro(lista, animacao.planejarGiro(1, lista.length).at(-1));
  assert.deepEqual(primeiro.subarray(0, 8), Buffer.from('89504e470d0a1a0a', 'hex'));
  assert.notDeepEqual(primeiro, ultimo);
});
