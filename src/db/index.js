'use strict';

const { obterCliente } = require('../servicos/supabase');
const { TABELAS, TABELAS_OPERACIONAIS } = require('./esquema');
const { cliente, executar } = require('./consultas');

async function abrirBanco() {
  return { client: obterCliente(), motor: 'supabase', close() {} };
}

/** Um registro com valor null é diferente de uma configuração ausente. */
async function obterConfig(db, guildId, chave, padrao = null) {
  const linha = await executar(cliente(db).from(TABELAS.configuracoes).select('valor')
    .eq('guild_id', String(guildId)).eq('chave', String(chave)).maybeSingle(), 'ler configuração');
  return linha ? linha.valor : padrao;
}

async function definirConfig(db, guildId, chave, valor) {
  await executar(cliente(db).from(TABELAS.configuracoes).upsert({
    guild_id: String(guildId), chave: String(chave),
    valor: valor == null ? null : String(valor), atualizado_em: new Date().toISOString(),
  }, { onConflict: 'guild_id,chave' }), 'salvar configuração');
}

module.exports = { abrirBanco, obterConfig, definirConfig, TABELAS, TABELAS_OPERACIONAIS };
