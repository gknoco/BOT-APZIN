'use strict';

// Chamado somente dentro de blacklist-filas-postgres.sh, nunca contra banco remoto.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const migracao = require('../scripts/migrar-supabase');

if (process.env.ROYAL_BLACKLIST_TEST_ISOLATED !== '1') throw new Error('Use o wrapper PostgreSQL isolado.');
function sql(comando) {
  return execFileSync('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', comando], { encoding: 'utf8' }).trim();
}
function literal(valor) { return `'${JSON.stringify(valor).replaceAll("'", "''")}'::jsonb`; }

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'royal-blacklist-import-'));
  const arquivo = path.join(dir, 'legado.db');
  const db = new DatabaseSync(arquivo);
  db.exec(`
    CREATE TABLE blacklist(guild_id TEXT,user_id TEXT,motivo TEXT,autor_id TEXT,criado_em INTEGER);
    INSERT INTO blacklist VALUES('script','remote','local nao substitui','a',1),('script','legacy','local','a',2);
    CREATE TABLE filas(guild_id TEXT,modo TEXT,preco INTEGER,gelo TEXT,user_id TEXT,entrou_em INTEGER);
    INSERT INTO filas VALUES('script','solo',100,'normal','remote',1),('script','solo',100,'normal','legacy',2),
      ('script','solo',100,'normal','livre',3),('script-outra','solo',100,'normal','remote',4);
    CREATE TABLE plantao(guild_id TEXT,user_id TEXT,entrou_em INTEGER);
    INSERT INTO plantao VALUES('script','staff',5);
    CREATE TABLE logs_dm(id INTEGER,guild_id TEXT,user_id TEXT,autor_id TEXT,mensagem TEXT,criado_em INTEGER);
    INSERT INTO logs_dm VALUES(11,'script','livre','staff','historico preservado',6);
  `);
  db.close();
  const antes = fs.readFileSync(arquivo);
  sql("INSERT INTO royal_blacklist VALUES('script','remote','motivo remoto','adm',1)");
  const outrasGravacoes = new Map();
  const chamadas = [];
  const supabase = {
    from(tabela) {
      return { async upsert(linhas, opcoes) {
        assert.equal(opcoes.ignoreDuplicates, true);
        chamadas.push(tabela);
        if (tabela === 'royal_blacklist') {
          const count = sql(`WITH inseridos AS (INSERT INTO royal_blacklist(guild_id,user_id,motivo,autor_id,criado_em)
            SELECT guild_id,user_id,motivo,autor_id,criado_em FROM jsonb_to_recordset(${literal(linhas)})
            AS x(guild_id text,user_id text,motivo text,autor_id text,criado_em bigint)
            ON CONFLICT(guild_id,user_id) DO NOTHING RETURNING 1) SELECT count(*) FROM inseridos`);
          return { count: Number(count), error: null };
        }
        outrasGravacoes.set(tabela, linhas);
        return { count: linhas.length, error: null };
      } };
    },
    async rpc(nome, args) {
      chamadas.push(nome);
      if (nome === 'royal_operacional_importar_filas') {
        return { data: JSON.parse(sql(`SELECT royal_operacional_importar_filas(${literal(args.p_filas)})`)), error: null };
      }
      if (nome === 'royal_operacional_reajustar_sequencias') return { data: null, error: null };
      throw new Error(`RPC inesperada: ${nome}`);
    },
  };
  const log = console.log;
  try {
    console.log = () => {};
    const primeira = await migracao.main({ sqlite: arquivo, origem: 'fixture' }, supabase);
    assert.deepEqual(primeira.royal_filas, { considerados: 4, inseridos: 2, bloqueados: 2 });
    assert.ok(chamadas.indexOf('royal_blacklist') < chamadas.indexOf('royal_operacional_importar_filas'));
    assert.equal(sql("SELECT motivo FROM royal_blacklist WHERE guild_id='script' AND user_id='remote'"), 'motivo remoto');
    assert.equal(sql("SELECT string_agg(user_id,',' ORDER BY user_id) FROM royal_filas WHERE guild_id='script'"), 'livre');
    assert.equal(sql("SELECT user_id FROM royal_filas WHERE guild_id='script-outra'"), 'remote');
    assert.equal(outrasGravacoes.get('royal_plantao')[0].user_id, 'staff');
    assert.equal(outrasGravacoes.get('royal_logs_dm')[0].mensagem, 'historico preservado');
    assert.equal(outrasGravacoes.get('royal_logs_dm')[0].legado_id, 'fixture:11');
    const repetida = await migracao.main({ sqlite: arquivo, origem: 'fixture' }, supabase);
    assert.deepEqual(repetida.royal_filas, { considerados: 4, inseridos: 0, bloqueados: 2 });
    assert.deepEqual(fs.readFileSync(arquivo), antes);
  } finally {
    console.log = log;
    fs.rmSync(dir, { recursive: true });
  }
  console.log('OK script real importa blacklist remota/legada, filas elegíveis e demais dados; replay seguro');
}

main().catch((erro) => { console.error(erro); process.exitCode = 1; });
