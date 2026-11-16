'use strict';

const { obterCliente } = require('../servicos/supabase');
const TAMANHO_PAGINA = 500;

function cliente(db) {
  return db?.client || obterCliente();
}

/** Centraliza erros devolvidos pelo PostgREST e falhas de transporte. */
async function executar(consulta, operacao = 'consultar Supabase') {
  try {
    const { data, error } = await consulta;
    if (error) throw error;
    return data;
  } catch (causa) {
    const erro = new Error(`Não consegui ${operacao}: ${causa?.message || 'erro de conexão'}`, { cause: causa });
    if (causa?.code) erro.code = causa.code;
    throw erro;
  }
}

async function rpc(db, nome, parametros) {
  return executar(cliente(db).rpc(nome, parametros), nome);
}

/** Cada página recria o builder, respeitando o teto de linhas do PostgREST. */
async function listarPaginado(criarConsulta, operacao = 'listar registros', limite = Infinity) {
  const linhas = [];
  for (let inicio = 0; inicio < limite; inicio += TAMANHO_PAGINA) {
    const quantidade = Math.min(TAMANHO_PAGINA, limite - inicio);
    const pagina = await executar(criarConsulta().range(inicio, inicio + quantidade - 1), operacao) || [];
    linhas.push(...pagina);
    if (pagina.length < quantidade) break;
  }
  return linhas;
}

async function contar(consulta, operacao = 'contar registros') {
  try {
    const { count, error } = await consulta;
    if (error) throw error;
    return count || 0;
  } catch (causa) {
    throw new Error(`Não consegui ${operacao}: ${causa?.message || 'erro de conexão'}`, { cause: causa });
  }
}

/** Contagem exata evita truncamento dos registros removidos pelo PostgREST. */
async function excluir(consulta, operacao = 'remover registros') {
  return contar(consulta, operacao);
}

function limitePositivo(valor, padrao = 50) {
  const numero = Number(valor);
  return Number.isFinite(numero) ? Math.max(1, Math.trunc(numero)) : padrao;
}

module.exports = { cliente, executar, rpc, listarPaginado, contar, excluir, limitePositivo };
