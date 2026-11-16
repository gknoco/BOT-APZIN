'use strict';

const { obterCliente } = require('../servicos/supabase');

/** O runtime não abre arquivos locais nem executa DDL. */
async function abrirMotor() {
  return { client: obterCliente(), motor: 'supabase', close() {} };
}

module.exports = { abrirMotor };
