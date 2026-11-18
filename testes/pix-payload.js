'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { crc16Ccitt, montarTLV, normalizarPixPayload, validarPixPayload } = require('../src/servicos/pixPayload');

function payload() {
  const conta = montarTLV('00', '01') + montarTLV('26', montarTLV('00', 'BR.GOV.BCB.PIX') + montarTLV('01', 'chave@example.com')) + montarTLV('52', '0000') + montarTLV('53', '986') + montarTLV('58', 'BR') + montarTLV('59', 'TESTE') + montarTLV('60', 'SAO PAULO');
  return `${conta}6304${crc16Ccitt(`${conta}6304`)}`;
}
test('CRC16 e payload EMV válido', () => assert.equal(validarPixPayload(payload()), payload()));
test('CRC inválido é recalculado', () => {
  const valor = payload();
  const corrigido = normalizarPixPayload(`${valor.slice(0, -1)}0`);
  assert.equal(validarPixPayload(corrigido), corrigido);
  assert.notEqual(corrigido, `${valor.slice(0, -1)}0`);
});
test('TLV inválido é rejeitado', () => assert.equal(validarPixPayload('0002012603ABC'), false));
test('montarTLV respeita comprimento', () => assert.equal(montarTLV('59', 'TESTE'), '5905TESTE'));
