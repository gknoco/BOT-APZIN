'use strict';

/** Auditoria: grava na nuvem e (se configurado) manda no canal de logs. */

const config = require('../config');
const { obterConfig } = require('../db');
const { embedLog } = require('../util/embeds');

function canalDesconhecido(erro) {
  return Number(erro?.code) === 10003 || erro?.name === 'UnknownChannel';
}

async function gravarNoBanco(db, { guildId, autorId, acao, detalhe }) {
  const { error } = await db.client.from('royal_audit_events').insert({
    guild_id: guildId ? String(guildId) : null,
    actor_id: autorId ? String(autorId) : null,
    action: String(acao),
    detail: detalhe ? String(detalhe).slice(0, 1800) : null,
  });
  if (error) throw new Error(`Não consegui gravar auditoria no Supabase: ${error.message}`);
}

async function registrar(db, client, { guildId, autorId = null, acao, detalhe = null }) {
  try {
    await gravarNoBanco(db, { guildId, autorId, acao, detalhe });
  } catch (erro) {
    console.error('[auditoria] falha ao gravar:', erro.message);
  }

  if (!client || !guildId) return;
  try {
    const canalId = await obterConfig(db, guildId, 'canal_logs', config.CANAL_LOGS_ID);
    if (!canalId) return;
    const canal = client.channels.cache.get(canalId) || (await client.channels.fetch(canalId));
    if (!canal?.isTextBased?.() || typeof canal.send !== 'function') return;
    await canal.send({ embeds: [embedLog(acao, detalhe || '—', autorId)] });
  } catch (erro) {
    // O registro já foi persistido. Canal apagado não deve poluir o console.
    if (canalDesconhecido(erro)) return;
    console.error('[auditoria] não consegui avisar no canal de logs:', erro.message);
  }
}

async function recentes(db, guildId, limite = 15) {
  const quantidade = Number.isFinite(Number(limite)) ? Math.max(1, Math.trunc(Number(limite))) : 15;
  const [atuais, legados] = await Promise.all([
    db.client.from('royal_audit_events').select('id,guild_id,actor_id,action,detail,created_at')
      .eq('guild_id', String(guildId)).order('created_at', { ascending: false })
      .order('id', { ascending: false }).limit(quantidade),
    db.client.from('royal_auditoria_legada').select('id,guild_id,autor_id,acao,detalhe,criado_em')
      .eq('guild_id', String(guildId)).order('criado_em', { ascending: false })
      .order('id', { ascending: false }).limit(quantidade),
  ]);
  for (const resultado of [atuais, legados]) {
    if (resultado.error) throw new Error(`Não consegui ler auditoria no Supabase: ${resultado.error.message}`);
  }
  const linhas = (atuais.data || []).map((linha) => ({
    id: linha.id,
    guild_id: linha.guild_id,
    autor_id: linha.actor_id,
    acao: linha.action,
    detalhe: linha.detail,
    criado_em: Date.parse(linha.created_at),
  }));
  linhas.push(...(legados.data || []).map((linha) => ({ ...linha, criado_em: Number(linha.criado_em) })));
  return linhas.sort((a, b) => b.criado_em - a.criado_em).slice(0, quantidade);
}

module.exports = { registrar, recentes, canalDesconhecido };
