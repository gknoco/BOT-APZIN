'use strict';

/**
 * Ferramenta MANUAL, nunca importada pelo runtime.
 * Uso: node scripts/migrar-supabase.js --sqlite /caminho/backup.db [--origem servidor-backup]
 * O arquivo é aberto readOnly; nenhuma higienização/alteração é feita no original.
 * Execute as migrações SQL ANTES. Todas as importações usam ignoreDuplicates.
 * Sem --origem, usa SHA-256 do arquivo. Use a mesma origem ao importar snapshots
 * sucessivos do mesmo banco para não duplicar seu histórico de DMs/transações.
 * Perfis: verifica todos os conflitos antes da primeira alteração, e revalida
 * campos sob lock numa RPC que somente preenche valores zero, com extrato/replay.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { obterCliente } = require('../src/servicos/supabase');
const { executar, listarPaginado } = require('../src/db/consultas');
const CAMPOS_PERFIL = ['coins', 'spins', 'wins', 'losses', 'wos', 'apostado', 'ganho'];
const TAMANHO_LOTE = 500;
const TABELAS_LEGADAS = new Set(['usuarios', 'staff', 'convites', 'partidas', 'partida_jogadores',
  'partida_go', 'configuracoes', 'filas', 'blacklist', 'paineis', 'mensagens_painel', 'plantao',
  'logs_dm', 'telagem_links', 'telagens', 'transacoes', 'auditoria', 'versiculos_usados']);

function argumentos(argv = process.argv.slice(2)) {
  const opcoes = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--sqlite' || argv[i] === '--origem') {
      const chave = argv[i].slice(2);
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Informe o valor de --${chave}.`);
      opcoes[chave] = argv[++i];
    } else if (argv[i] === '--help') opcoes.help = true;
    else throw new Error(`Argumento desconhecido: ${argv[i]}. Use --sqlite /caminho/backup.db.`);
  }
  if (!opcoes.help && !opcoes.sqlite) throw new Error('Forneça explicitamente --sqlite /caminho/backup.db. O runtime não possui banco local.');
  return opcoes;
}

function abrirLegado(caminho) {
  if (!caminho) throw new Error('O caminho explícito do SQLite é obrigatório.');
  const absoluto = path.resolve(caminho);
  if (!fs.statSync(absoluto).isFile()) throw new Error('O caminho informado não é um arquivo regular.');
  // Única dependência SQLite do projeto: esta ferramenta manual e somente leitura.
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(absoluto, { readOnly: true });
}

function lerTabela(db, tabela) {
  if (!TABELAS_LEGADAS.has(tabela)) throw new Error('Tabela legada não permitida.');
  const existe = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=? LIMIT 1").get(tabela);
  if (!existe) return [];
  const linhas = [];
  const consulta = db.prepare(`SELECT rowid AS _ordem_legada,* FROM "${tabela}" ORDER BY rowid LIMIT ? OFFSET ?`);
  for (let inicio = 0; ; inicio += TAMANHO_LOTE) {
    const pagina = consulta.all(TAMANHO_LOTE, inicio);
    linhas.push(...pagina);
    if (pagina.length < TAMANHO_LOTE) return linhas;
  }
}

async function upsert(supabase, tabela, linhas, conflito) {
  let inseridos = 0;
  for (let i = 0; i < linhas.length; i += TAMANHO_LOTE) {
    const { count, error } = await supabase.from(tabela).upsert(linhas.slice(i, i + TAMANHO_LOTE), {
      onConflict: conflito, ignoreDuplicates: true, count: 'exact',
    });
    if (error) throw new Error(`Importar ${tabela}: ${error.message}`);
    inseridos += count || 0;
  }
  return { considerados: linhas.length, inseridos };
}

async function reconciliarPerfis(perfis, clienteOverride) {
  const supabase = clienteOverride || obterCliente();
  const grupos = new Map();
  for (const perfil of perfis) {
    const guildId = String(perfil.guild_id);
    if (!grupos.has(guildId)) grupos.set(guildId, []);
    grupos.get(guildId).push(perfil);
  }
  const conflitos = [];
  const planos = [];
  let jaImportados = 0;
  for (const [guildId, locais] of grupos) {
    for (let i = 0; i < locais.length; i += TAMANHO_LOTE) {
      const lote = locais.slice(i, i + TAMANHO_LOTE);
      const ids = lote.map((perfil) => String(perfil.user_id));
      const remotos = await listarPaginado(() => supabase.from('royal_profiles')
        .select(`guild_id,user_id,${CAMPOS_PERFIL.join(',')}`).eq('guild_id', guildId).in('user_id', ids).order('user_id'), 'verificar perfis legados');
      const requests = await listarPaginado(() => supabase.from('royal_economy_requests')
        .select('request_id').eq('guild_id', guildId)
        .in('request_id', ids.map((id) => `legacy-migration:${guildId}:${id}`)).order('request_id'), 'verificar importações anteriores');
      const porUser = new Map(remotos.map((row) => [String(row.user_id), row]));
      const importados = new Set(requests.map((row) => row.request_id));
      for (const local of lote) {
        if (importados.has(`legacy-migration:${guildId}:${local.user_id}`)) { jaImportados += 1; continue; }
        const remoto = porUser.get(String(local.user_id));
        const camposConflito = CAMPOS_PERFIL.filter((campo) => {
          const valor = Math.trunc(Number(local[campo]) || 0);
          const atual = Math.trunc(Number(remoto?.[campo]) || 0);
          return valor < 0 || (valor !== 0 && atual !== 0 && valor !== atual);
        });
        if (camposConflito.length) conflitos.push(`${guildId}/${local.user_id} (${camposConflito.join(', ')})`);
        else planos.push({ guildId, userId: String(local.user_id), dados: Object.fromEntries(CAMPOS_PERFIL
          .map((campo) => [campo, Math.trunc(Number(local[campo]) || 0)])) });
      }
    }
  }
  if (conflitos.length) throw new Error(`Conflito entre SQLite e Supabase em ${conflitos.length} perfil(is). Nenhum saldo foi sobrescrito; reconcilie manualmente.\n- ${conflitos.slice(0, 20).join('\n- ')}`);
  let reconciled = 0;
  for (const plano of planos) {
    const resposta = await executar(supabase.rpc('royal_operacional_importar_perfil', {
      p_guild_id: plano.guildId, p_user_id: plano.userId, p_dados: plano.dados,
    }), `reconciliar perfil ${plano.guildId}/${plano.userId}`);
    if (resposta?.reconciliado) reconciled += 1;
  }
  return { reconciled, conflicts: 0, alreadyImported: jaImportados };
}

const campos = (linha, nomes) => Object.fromEntries(nomes.split(',').map((nome) => [nome, linha[nome] ?? null]));
const iso = (valor) => valor == null ? null : new Date(Number(valor)).toISOString();

async function main(opcoes = argumentos(), clienteOverride) {
  if (opcoes.help) {
    console.log('Uso: node scripts/migrar-supabase.js --sqlite /caminho/backup.db [--origem servidor-backup]\nArquivo sempre readOnly; dados remotos existentes nunca são sobrescritos.');
    return;
  }
  const db = abrirLegado(opcoes.sqlite);
  try {
    const supabase = clienteOverride || obterCliente();
    const origem = opcoes.origem || crypto.createHash('sha256').update(fs.readFileSync(path.resolve(opcoes.sqlite))).digest('hex');
    const legado = Object.fromEntries([...TABELAS_LEGADAS].map((nome) => [nome, lerTabela(db, nome)]));
    const perfis = legado.usuarios.map((row) => ({
      guild_id: row.guild_id, user_id: row.user_id, coins: row.coins, spins: row.giros,
      wins: row.vitorias, losses: row.derrotas, wos: row.wos, apostado: row.apostado, ganho: row.ganho,
    }));
    // Abortamos antes das gravações se o backup já contém links compartilhados.
    const urls = new Set();
    for (const row of legado.telagens) {
      const chave = JSON.stringify([row.guild_id, row.url]);
      if (urls.has(chave)) throw new Error('O backup contém um link de telagem reservado para mais de uma sala. Reconcilie uma cópia do backup; o original não será alterado.');
      urls.add(chave);
    }
    const resultado = { profiles: await reconciliarPerfis(perfis, supabase) };
    async function importar(tabela, linhas, conflito) {
      resultado[tabela] = await upsert(supabase, tabela, linhas, conflito);
      console.log(`[migração] ${tabela}: ${resultado[tabela].considerados} considerados; ${resultado[tabela].inseridos} novos.`);
    }
    await importar('discord_configuracoes', legado.configuracoes.map((row) => ({
      guild_id: String(row.guild_id), chave: String(row.chave), valor: row.valor == null ? null : String(row.valor),
    })), 'guild_id,chave');
    await importar('royal_invites', legado.convites.map((row) => ({
      guild_id: row.guild_id, invited_user_id: row.convidado_id, inviter_user_id: row.convidador_id,
      code: row.codigo, created_at: iso(row.criado_em),
    })), 'guild_id,invited_user_id');
    await importar('royal_pix_keys', legado.staff.filter((row) => row.pix_chave != null).map((row) => ({
      guild_id: row.guild_id, user_id: row.user_id, pix_key: row.pix_chave, pix_holder: row.pix_titular,
      pix_city: row.pix_cidade ?? null, commission: Number(row.comissao ?? 0.05), active: Boolean(row.ativo),
      registered_at: iso(row.registrado_em) || iso(row.atualizado_em) || iso(row.criado_em) || new Date().toISOString(),
      updated_at: iso(row.atualizado_em) || new Date().toISOString(),
    })), 'guild_id,user_id');
    const camposPartida = 'id,guild_id,modo,preco,gelo,canal_id,mensagem_id,status,regras,regras_por,mediador_id,sala_id,sala_senha,vencedor_time,motivo_fim,comissao,criado_em,pago_em,liberada_em,finalizada_em,nix_sessao';
    await importar('royal_partidas', legado.partidas.map((row) => ({ ...campos(row, camposPartida),
      comissao: Number(row.comissao ?? 0), pix_chave: null, pix_titular: null,
    })), 'id');
    await importar('royal_partida_jogadores', legado.partida_jogadores.map((row) => ({
      ...campos(row, 'partida_id,user_id,time,confirmou'), ordem: row._ordem_legada,
    })), 'partida_id,user_id');
    await importar('royal_partida_go', legado.partida_go.map((row) => campos(row, 'partida_id,user_id,criado_em')), 'partida_id,user_id');
    // Mantém também os registros econômicos históricos já consumidos pelo perfil.
    await importar('royal_match_records', legado.partidas.map((row) => ({
      id: row.id, guild_id: row.guild_id, mode: row.modo, price: row.preco, status: row.status,
      mediator_id: row.mediador_id, winner_team: row.vencedor_time, reason: row.motivo_fim,
      created_at: iso(row.criado_em), finished_at: iso(row.finalizada_em),
    })), 'id');
    await importar('royal_match_players', legado.partida_jogadores.map((row) => ({
      match_id: row.partida_id, user_id: row.user_id, team: row.time, confirmed: Boolean(row.confirmou),
    })), 'match_id,user_id');
    const mapeamentos = [
      ['filas', 'royal_filas', 'guild_id,modo,preco,gelo,user_id,entrou_em', 'guild_id,modo,preco,gelo,user_id'],
      ['blacklist', 'royal_blacklist', 'guild_id,user_id,motivo,autor_id,criado_em', 'guild_id,user_id'],
      ['paineis', 'royal_paineis', 'guild_id,modo,canal_id,mensagem_id,criado_em', 'guild_id,modo'],
      ['mensagens_painel', 'royal_mensagens_painel', 'guild_id,modo,preco,canal_id,mensagem_id,atualizado_em', 'guild_id,modo,preco'],
      ['plantao', 'royal_plantao', 'guild_id,user_id,entrou_em', 'guild_id,user_id'],
      ['telagem_links', 'royal_telagem_links', 'guild_id,url,criado_em', 'guild_id,url'],
      ['telagens', 'royal_telagens', 'guild_id,chave,codigo,url,criado_em', 'guild_id,chave'],
    ];
    for (const [local, remoto, nomes, conflito] of mapeamentos) await importar(remoto, legado[local].map((row) => campos(row, nomes)), conflito);
    await importar('royal_logs_dm', legado.logs_dm.map((row) => ({
      ...campos(row, 'guild_id,user_id,autor_id,mensagem,criado_em'), legado_id: `${origem}:${row.id}`,
    })), 'legado_id');
    await importar('royal_transacoes', legado.transacoes.map((row) => ({
      ...campos(row, 'guild_id,user_id,tipo,valor,motivo,autor_id,criado_em'), legado_id: `${origem}:${row.id}`,
    })), 'legado_id');
    // Preserva IDs da auditoria local sem colidir com a identidade de royal_audit_events.
    const chavesPix = legado.staff.map((row) => row.pix_chave).filter(Boolean).map(String);
    await importar('royal_auditoria_legada', legado.auditoria.map((row) => {
      let detalhe = row.detalhe == null ? null : String(row.detalhe);
      for (const chave of chavesPix) if (detalhe) detalhe = detalhe.split(chave).join('[chave PIX omitida]');
      if (row.acao === 'PIX enviado na sala' && detalhe?.includes(' · ')) detalhe = `${detalhe.split(' · ')[0]} · [chave PIX omitida]`;
      return { ...campos(row, 'id,guild_id,autor_id,acao,criado_em'), detalhe, origem };
    }), 'origem,id');
    // FK do catálogo de versículos: não descarta IDs históricos desconhecidos silenciosamente.
    await importar('discord_versiculos_usados', legado.versiculos_usados.map((row) => ({
      versiculo_id: row.versiculo_id, usado_em: iso(row.usado_em), guild_id: row.guild_id, user_id: row.user_id,
    })), 'versiculo_id');
    await executar(supabase.rpc('royal_operacional_reajustar_sequencias'), 'avançar sequências operacionais');
    console.log(`Migração concluída sem alterar o arquivo original: ${JSON.stringify(resultado)}`);
    return resultado;
  } finally { db.close(); }
}

if (require.main === module) main().catch((erro) => {
  console.error('Migração falhou:', erro.message);
  process.exitCode = 1;
});

module.exports = { main, argumentos, abrirLegado, lerTabela, reconciliarPerfis, upsert };
