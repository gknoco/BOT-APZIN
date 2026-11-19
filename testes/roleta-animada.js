'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const animacao = require('../src/servicos/roletaAnimada');

const VOLTA = 2 * Math.PI;

test('o ponteiro para no centro exato do prêmio sorteado para qualquer quantidade e posição', () => {
  for (const quantidade of [1, 2, 3, 4, 7, 24, 25, 100, 201]) {
    for (let indice = 0; indice < quantidade; indice++) {
      const angulos = animacao.planejarGiro(indice, quantidade, 3);
      assert.equal(angulos.length, 43);
      assert.equal(animacao.indiceNoPonteiro(angulos.at(-1), quantidade), indice);
      const largura = VOLTA / quantidade;
      const posicao = ((-angulos.at(-1) % VOLTA) + VOLTA) % VOLTA;
      assert.ok(Math.abs(posicao - (indice + 0.5) * largura) < 1e-10);
      const passos = angulos.slice(1).map((a, i) => a - angulos[i]);
      assert.ok(passos.every((passo) => passo > 0 && passo < Math.PI * 1.2));
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


test('GIF usa a duração configurada e termina no mesmo quadro PNG do resultado', async () => {
  const { parseGIF, decompressFrames } = require('gifuct-js');
  const { PNG } = require('pngjs');
  const lista = [
    { id: 'a', name: 'Coins' },
    { id: 'b', name: 'PIX sorteado' },
    { id: 'c', name: 'Cargo VIP' },
  ];
  const indice = 1;
  const { gif, imagemFinal } = await animacao.gerarAnimacao(lista, indice, 3);
  const quadros = decompressFrames(parseGIF(gif), true);
  assert.equal(quadros.length, 43);
  assert.equal(quadros.reduce((soma, quadro) => soma + quadro.delay, 0), 3000);
  assert.ok(!gif.includes(Buffer.from('NETSCAPE2.0')));
  assert.notDeepEqual(quadros[0].patch, quadros.at(-1).patch);
  const angulo = animacao.planejarGiro(indice, lista.length, 3).at(-1);
  assert.equal(animacao.indiceNoPonteiro(angulo, lista.length), indice);
  assert.deepEqual(imagemFinal, animacao.desenharQuadro(lista, angulo));
  const png = PNG.sync.read(imagemFinal);
  const ultimo = quadros.at(-1);
  assert.equal(ultimo.dims.width, png.width);
  assert.equal(ultimo.dims.height, png.height);
  let diferenca = 0;
  for (let i = 0; i < ultimo.patch.length; i += 4) {
    diferenca += Math.abs(ultimo.patch[i] - png.data[i]);
    diferenca += Math.abs(ultimo.patch[i + 1] - png.data[i + 1]);
    diferenca += Math.abs(ultimo.patch[i + 2] - png.data[i + 2]);
  }
  assert.ok(diferenca / (png.width * png.height * 3) < 2, 'o último quadro do GIF deve coincidir visualmente com o PNG final');
});

test('valida duração padrão e limites configuráveis', () => {
  assert.equal(animacao.validarDuracaoSegundos(undefined), 8);
  assert.equal(animacao.validarDuracaoSegundos('3'), 3);
  assert.equal(animacao.validarDuracaoSegundos('20'), 20);
  for (const valor of ['2', '21', '3.5', 'x', null]) assert.equal(animacao.validarDuracaoSegundos(valor), 8);
  assert.equal(animacao.planejarGiro(0, 3, 20).length, 286);
});

test('o resultado substitui a animação conforme a duração solicitada', async () => {
  const { EmbedBuilder } = require('discord.js');
  const instantes = [];
  const respostas = [];
  const interaction = { id: '123', async editReply(payload) { instantes.push(performance.now()); respostas.push(payload); } };
  await animacao.animar(interaction, [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    { prize_id: 'b', prize_name: 'B' }, { embeds: [new EmbedBuilder().setTitle('RESULTADO')] },
    () => new EmbedBuilder().setTitle('GIRANDO'), 3);
  assert.equal(respostas.length, 2);
  assert.match(respostas[0].files[0].name, /\.gif$/);
  assert.match(respostas[1].files[0].name, /\.png$/);
  assert.ok(instantes[1] - instantes[0] >= 2850);
  assert.ok(instantes[1] - instantes[0] < 5000);
});
