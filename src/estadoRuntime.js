'use strict';

let falhaCritica = null;
let falhaDesde = null;

function marcarDegradado(motivo) {
  falhaCritica = String(motivo || 'falha crítica').slice(0, 160);
  falhaDesde = new Date().toISOString();
}

function estado() {
  return {
    saudavel: falhaCritica === null,
    motivo: falhaCritica,
    desde: falhaDesde,
  };
}

function estaSaudavel() {
  return falhaCritica === null;
}

module.exports = { marcarDegradado, estado, estaSaudavel };
