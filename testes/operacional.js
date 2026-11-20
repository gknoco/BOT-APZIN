'use strict';

/**
 * node testes/operacional.js: contratos locais, sem credenciais e sem banco remoto.
 * PGLITE_MODULE=/caminho/node_modules/@electric-sql/pglite node testes/operacional.js
 * acrescenta execução SQL real em PostgreSQL/WASM isolado, sem emular SQLite.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
process.env.DISCORD_TOKEN ||= 'test.token.value';
const raiz = path.resolve(__dirname, '..');
const consultas = require('../src/db/consultas');
const banco = require('../src/db');
const filas = require('../src/servicos/filas');
const partidas = require('../src/servicos/partidas');
const blacklist = require('../src/servicos/blacklist');
const telagem = require('../src/servicos/telagem');
const migracao = require('../scripts/migrar-supabase');
const testes = [];
const teste = (nome, fn) => testes.push({ nome, fn });

/** Spy de transporte com respostas explícitas, não banco em memória ou parser SQL. */
function transporte(respostas) {
  const chamadas = [];
  let indice = 0;
  const client = {
    from(tabela) {
      const passos = [['from', tabela]];
      chamadas.push(passos);
      const resultado = respostas[indice++] || { data: null, error: null };
      const builder = { then(resolve, reject) { return Promise.resolve(resultado).then(resolve, reject); } };
      for (const metodo of ['select', 'eq', 'in', 'order', 'range', 'limit', 'maybeSingle', 'single', 'upsert', 'update', 'delete']) {
        builder[metodo] = (...args) => { passos.push([metodo, ...args]); return builder; };
      }
      return builder;
    },
    async rpc(nome, parametros) { chamadas.push(['rpc', nome, parametros]); return respostas[indice++] || { data: null, error: null }; },
  };
  return { db: { client, motor: 'supabase', close() {} }, chamadas };
}

teste('runtime não depende de arquivo local ou SQLite', async () => {
  for (const arquivo of ['src/db/index.js', 'src/db/driver.js', 'src/db/esquema.js', 'src/db/consultas.js',
    'src/servicos/filas.js', 'src/servicos/partidas.js', 'src/servicos/blacklist.js',
    'src/servicos/telagem.js', 'src/servicos/usuarios.js', 'src/servicos/staff.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(raiz, arquivo), 'utf8'), /node:sqlite|better-sqlite3|\.prepare\(|\.transaction\(/, arquivo);
  }
  assert.equal(banco.abrirBanco.constructor.name, 'AsyncFunction');
  assert.equal(banco.TABELAS.configuracoes, 'discord_configuracoes');
  assert.equal(banco.TABELAS.auditoria, 'royal_audit_events');
  assert.equal(banco.TABELAS.partidas, 'royal_partidas');
});

teste('config distingue ausência, null e string, e não grava mirror', async () => {
  const { db, chamadas } = transporte([{ data: null }, { data: { valor: null } }, { data: { valor: 'canal' } }, {}]);
  assert.equal(await banco.obterConfig(db, 'g', 'k', 'padrão'), 'padrão');
  assert.equal(await banco.obterConfig(db, 'g', 'k', 'padrão'), null);
  assert.equal(await banco.obterConfig(db, 'g', 'k'), 'canal');
  await banco.definirConfig(db, 'g', 'k', undefined);
  assert.equal(chamadas[3][0][1], 'discord_configuracoes');
  assert.equal(chamadas[3].find((p) => p[0] === 'upsert')[1].valor, null);
});

teste('erros PostgREST e transporte propagam com contexto', async () => {
  await assert.rejects(consultas.executar(Promise.resolve({ error: { code: '42501', message: 'negado' } }), 'ler fila'), /ler fila: negado/);
  await assert.rejects(consultas.executar(Promise.reject(new Error('offline')), 'ler fila'), /offline/);
});

teste('paginação preserva todas as linhas acima do teto de 500', async () => {
  const intervalos = [];
  const primeira = Array.from({ length: 500 }, (_, id) => ({ id }));
  const segunda = [{ id: 500 }];
  const rows = await consultas.listarPaginado(() => ({ range(inicio, fim) {
    intervalos.push([inicio, fim]); return Promise.resolve({ data: inicio ? segunda : primeira });
  } }));
  assert.equal(rows.length, 501);
  assert.deepEqual(intervalos, [[0, 499], [500, 999]]);
});

teste('fila usa RPC para entrada/posição e seleção/remoção indivisíveis', async () => {
  const { db, chamadas } = transporte([{ data: { entrou: false, posicao: 2 } }, { data: { estado: 'reservada', jogadores: ['a', 'b'] } }, { data: { estado: 'insuficiente' } }]);
  const filtros = { reservaId: 'r', partidaId: 'p', guildId: 'g', modo: 'solo', preco: 100, gelo: 'normal', userId: 'a' };
  assert.deepEqual(await filas.entrar(db, filtros), { entrou: false, posicao: 2 });
  assert.deepEqual(await filas.reservar(db, { ...filtros, quantidade: 2 }), { estado: 'reservada', jogadores: ['a', 'b'] });
  assert.equal((await filas.reservar(db, { ...filtros, quantidade: 2 })).estado, 'insuficiente');
  assert.equal(chamadas[0][1], 'royal_operacional_entrar_fila');
  assert.equal(chamadas[1][1], 'royal_operacional_reservar_fila');
  await assert.rejects(filas.reservar(db, { ...filtros, quantidade: 0 }), /inteiro positivo/);
});

teste('remoções usam contagem exata, blacklist aguarda consulta', async () => {
  const { db, chamadas } = transporte([{ data: 1234 }, { data: null }, { data: { guild_id: 'g', user_id: 'a' } }]);
  assert.equal(await filas.limpar(db, { guildId: 'g' }), 1234);
  assert.equal(chamadas[0][1], 'royal_operacional_remover_filas');
  assert.equal(await blacklist.estaBloqueado(db, 'g', 'a'), false);
  assert.equal(await blacklist.estaBloqueado(db, 'g', 'a'), true);
});

teste('partida cria jogadores, confirma, dá GO e finaliza via RPC', async () => {
  const result = { partida: { id: 'm', status: 'finalizada', vencedor_time: 1, motivo_fim: 'resultado' }, jogadores: [] };
  const { db, chamadas } = transporte([{ data: { id: 'm' } }, { data: { completo: true } }, { data: { iniciou: true } }, { data: result }]);
  await partidas.criar(db, { reservaId: 'r', partidaId: 'm', guildId: 'g', modo: 'solo', preco: 100, gelo: 'normal', canalId: 'c', jogadores: [{ userId: 'a', time: 1 }] });
  assert.deepEqual(chamadas[0][2].p_jogadores, [{ user_id: 'a', time: 1 }]);
  assert.equal((await partidas.confirmar(db, 'm', 'a')).completo, true);
  assert.equal((await partidas.darGo(db, { partidaId: 'm', userId: 'a' })).iniciou, true);
  assert.deepEqual(await partidas.finalizar(db, { partidaId: 'm', vencedorTime: 1 }), result);
  assert.deepEqual(chamadas.map((c) => c[1]), ['royal_operacional_criar_partida', 'royal_operacional_confirmar_partida',
    'royal_operacional_dar_go', 'royal_operacional_encerrar_partida']);
});

teste('telagem mantém código determinístico e usa alocação RPC', async () => {
  const { db, chamadas } = transporte([{ data: { origem: 'pool' } }, { data: { origem: 'manual' } }]);
  assert.equal(telagem.codigoDoCanal('g', 'm'), telagem.codigoDoCanal('g', 'm'));
  assert.notEqual(telagem.codigoDoCanal('g', 'm'), telagem.codigoDoCanal('g', 'n'));
  assert.equal((await telagem.reservar(db, 'g', 'm')).origem, 'pool');
  assert.equal((await telagem.fixar(db, 'g', 'm', 'https://meet.google.com/abc-defg-hij')).origem, 'manual');
  assert.equal(chamadas[0][1], 'royal_operacional_reservar_telagem');
  assert.equal(chamadas[1][1], 'royal_operacional_fixar_telagem');
});

teste('importação exige caminho explícito e abre SQLite readOnly sem alterar original', async () => {
  assert.throws(() => migracao.argumentos([]), /explicitamente/);
  assert.deepEqual(migracao.argumentos(['--sqlite', '/tmp/a.db']), { sqlite: '/tmp/a.db' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'royal-operacional-'));
  const arquivo = path.join(dir, 'fixture.db');
  const { DatabaseSync } = require('node:sqlite');
  const fixture = new DatabaseSync(arquivo);
  fixture.exec("CREATE TABLE usuarios(guild_id TEXT,user_id TEXT,coins INTEGER); INSERT INTO usuarios VALUES('g','a',5)");
  fixture.close();
  const antes = fs.readFileSync(arquivo);
  const legado = migracao.abrirLegado(arquivo);
  try {
    assert.equal(migracao.lerTabela(legado, 'usuarios')[0].coins, 5);
    assert.throws(() => legado.exec('DELETE FROM usuarios'), /readonly/i);
    assert.throws(() => migracao.lerTabela(legado, 'nao_permitida'), /não permitida/);
  } finally { legado.close(); }
  assert.deepEqual(fs.readFileSync(arquivo), antes);
  fs.rmSync(dir, { recursive: true });
});

teste('todas as importações usam ignoreDuplicates sem overwrite', async () => {
  const { db, chamadas } = transporte([{ count: 1 }]);
  assert.deepEqual(await migracao.upsert(db.client, 'royal_filas', [{ guild_id: 'g' }], 'guild_id'), { considerados: 1, inseridos: 1 });
  assert.equal(chamadas[0].find((p) => p[0] === 'upsert')[2].ignoreDuplicates, true);
});

teste('reconciliação verifica todos os conflitos antes de gravar economia', async () => {
  const local = { guild_id: 'g', user_id: 'a', coins: 50 };
  const spy = transporte([{ data: [{ guild_id: 'g', user_id: 'a', coins: 40 }] }, { data: [] }]);
  await assert.rejects(migracao.reconciliarPerfis([local], spy.db.client), /Conflito entre SQLite e Supabase/);
  assert.equal(spy.chamadas.some((c) => c[0] === 'rpc'), false);
  const seguro = transporte([{ data: [{ guild_id: 'g', user_id: 'a', coins: 0 }] }, { data: [] }, { data: { reconciliado: true } }]);
  assert.equal((await migracao.reconciliarPerfis([local], seguro.db.client)).reconciled, 1);
  assert.equal(seguro.chamadas[2][1], 'royal_operacional_importar_perfil');
});

teste('importação completa conserva arquivo, metadados operacionais e fallback PIX', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'royal-importacao-'));
  const arquivo = path.join(dir, 'backup.db');
  const { DatabaseSync } = require('node:sqlite');
  const fixture = new DatabaseSync(arquivo);
  fixture.exec(`
    CREATE TABLE usuarios(guild_id TEXT,user_id TEXT,coins INTEGER,giros INTEGER,vitorias INTEGER,derrotas INTEGER,wos INTEGER,apostado INTEGER,ganho INTEGER);
    INSERT INTO usuarios VALUES('g','a',50,0,0,0,0,0,0);
    CREATE TABLE staff(guild_id TEXT,user_id TEXT,pix_chave TEXT,pix_titular TEXT,comissao REAL,ativo INTEGER,atualizado_em INTEGER);
    INSERT INTO staff VALUES('g','staff','pix@example.com','Titular',0.05,1,1700000000000);
    CREATE TABLE configuracoes(guild_id TEXT,chave TEXT,valor TEXT);
    INSERT INTO configuracoes VALUES('g','canal_logs',NULL);
    CREATE TABLE partidas(id TEXT,guild_id TEXT,modo TEXT,preco INTEGER,gelo TEXT,canal_id TEXT,status TEXT,comissao REAL,criado_em INTEGER,nix_sessao TEXT);
    INSERT INTO partidas VALUES('m','g','solo',100,'normal','canal','sala_liberada',0.05,1700000000000,'nix-sessao');
    CREATE TABLE partida_jogadores(partida_id TEXT,user_id TEXT,time INTEGER,confirmou INTEGER);
    INSERT INTO partida_jogadores VALUES('m','a',1,1);
    CREATE TABLE auditoria(id INTEGER,guild_id TEXT,autor_id TEXT,acao TEXT,detalhe TEXT,criado_em INTEGER);
    INSERT INTO auditoria VALUES(1,'g','staff','PIX enviado na sala','Sala m · pix@example.com',1700000000000);
    CREATE TABLE logs_dm(id INTEGER,guild_id TEXT,user_id TEXT,autor_id TEXT,mensagem TEXT,criado_em INTEGER);
    INSERT INTO logs_dm VALUES(1,'g','a','staff','mensagem',1700000000000);
  `);
  fixture.close();
  const antes = fs.readFileSync(arquivo);
  const { db, chamadas } = transporte([{ data: [] }, { data: [] }, { data: { reconciliado: true } }]);
  const consoleOriginal = console.log;
  try {
    console.log = () => {};
    const resultado = await migracao.main({ sqlite: arquivo, origem: 'backup-stable' }, db.client);
    assert.equal(resultado.profiles.reconciled, 1);
    const gravacoes = chamadas.filter((c) => Array.isArray(c[0]) && c.some((p) => p[0] === 'upsert'));
    for (const chamada of gravacoes) assert.equal(chamada.find((p) => p[0] === 'upsert')[2].ignoreDuplicates, true);
    const linhas = (tabela) => gravacoes.find((c) => c[0][1] === tabela).find((p) => p[0] === 'upsert')[1];
    assert.equal(linhas('royal_pix_keys')[0].registered_at, new Date(1700000000000).toISOString());
    assert.equal(linhas('discord_configuracoes')[0].valor, null);
    assert.equal(linhas('royal_partidas')[0].nix_sessao, 'nix-sessao');
    assert.equal(linhas('royal_partida_jogadores')[0].ordem, 1);
    assert.equal(linhas('royal_logs_dm')[0].legado_id, 'backup-stable:1');
    assert.doesNotMatch(linhas('royal_auditoria_legada')[0].detalhe, /pix@example/);
    assert.deepEqual(fs.readFileSync(arquivo), antes);
  } finally {
    console.log = consoleOriginal;
    fs.rmSync(dir, { recursive: true });
  }
});

async function validarSQL() {
  const { PGlite } = require(process.env.PGLITE_MODULE);
  const pg = new PGlite();
  try {
    await pg.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE FUNCTION auth.role() RETURNS text LANGUAGE SQL AS $$ SELECT 'service_role'::text $$;");
    for (const nome of fs.readdirSync(path.join(raiz, 'supabase/migrations')).sort()) {
      if (nome >= '20261116000000') continue;
      const sql = fs.readFileSync(path.join(raiz, 'supabase/migrations', nome), 'utf8').replace(/create extension if not exists pgcrypto;/gi, '');
      await pg.exec(sql);
    }
    await pg.exec("INSERT INTO discord_configuracoes(guild_id,chave,valor) VALUES('config','atual','preservado'); INSERT INTO royal_guild_configs(guild_id,key,value) VALUES('config','atual','antigo'),('config','legado','importado')");
    const sql = fs.readFileSync(path.join(raiz, 'supabase/migrations/20261116060000_operational_supabase.sql'), 'utf8');
    await pg.exec(sql);
    await pg.exec(sql); // DDL idempotente sem destruir dados existentes.
    const complemento = path.join(raiz, 'supabase/migrations/20261116060001_operational_panels.sql');
    if (fs.existsSync(complemento)) {
      const sqlPainel = fs.readFileSync(complemento, 'utf8');
      await pg.exec(sqlPainel);
      await pg.exec(sqlPainel);
    }
    const chamar = async (nome, valores = []) => {
      const parametros = valores.map((_, i) => `$${i + 1}`).join(',');
      const res = await pg.query(`SELECT public.${nome}(${parametros}) AS resultado`, valores);
      return res.rows[0].resultado;
    };
    const q = async (sql, valores = []) => (await pg.query(sql, valores)).rows;
    const criar = async (id) => chamar('royal_operacional_criar_partida', [id, 'g', 'solo', 100, 'normal', 'canal', JSON.stringify([{ user_id: 'a', time: 1 }, { user_id: 'b', time: 2 }])]);
    let numero = 0;
    async function caso(nome, fn) { await fn(); numero += 1; console.log(`  SQL OK ${nome}`); }
    await caso('config aceita null preservando a tabela existente', async () => {
      await pg.exec("INSERT INTO discord_configuracoes(guild_id,chave,valor) VALUES('g','k',NULL)");
      assert.equal((await q("SELECT valor FROM discord_configuracoes WHERE guild_id='g'"))[0].valor, null);
      assert.equal((await q("SELECT valor FROM discord_configuracoes WHERE guild_id='config' AND chave='atual'"))[0].valor, 'preservado');
      assert.equal((await q("SELECT valor FROM discord_configuracoes WHERE guild_id='config' AND chave='legado'"))[0].valor, 'importado');
    });
    await caso('entrada idempotente e reserva insuficiente não consome fila', async () => {
      assert.deepEqual(await chamar('royal_operacional_entrar_fila', ['g', 'solo', 100, 'normal', 'a']), { entrou: true, posicao: 1 });
      assert.deepEqual(await chamar('royal_operacional_entrar_fila', ['g', 'solo', 100, 'normal', 'a']), { entrou: false, posicao: 1 });
      assert.equal(await chamar('royal_operacional_reservar_fila', ['g', 'solo', 100, 'normal', 2]), null);
      assert.equal((await q('SELECT count(*)::integer AS n FROM royal_filas'))[0].n, 1);
      await chamar('royal_operacional_entrar_fila', ['g', 'solo', 100, 'normal', 'b']);
      assert.deepEqual(await chamar('royal_operacional_reservar_fila', ['g', 'solo', 100, 'normal', 2]), ['a', 'b']);
      assert.equal((await q('SELECT count(*)::integer AS n FROM royal_filas'))[0].n, 0);
    });
    await caso('criação + jogadores é atômica e preserva ordem', async () => {
      await criar('m');
      assert.equal((await q("SELECT count(*)::integer AS n FROM royal_partida_jogadores WHERE partida_id='m'"))[0].n, 2);
      await assert.rejects(chamar('royal_operacional_criar_partida', ['duplicada', 'g', 'solo', 100, 'normal', 'c', JSON.stringify([{ user_id: 'a', time: 1 }, { user_id: 'a', time: 2 }])]), /duplicate key/);
      assert.equal((await q("SELECT count(*)::integer AS n FROM royal_partidas WHERE id='duplicada'"))[0].n, 0);
    });
    await caso('confirmações idempotentes avançam somente quando todos confirmam', async () => {
      const primeiro = await chamar('royal_operacional_confirmar_partida', ['m', 'a']);
      assert.equal(primeiro.completo, false);
      assert.equal((await chamar('royal_operacional_confirmar_partida', ['m', 'a'])).jaConfirmou, true);
      assert.equal((await chamar('royal_operacional_confirmar_partida', ['m', 'b'])).partida.status, 'aguardando_mediador');
      assert.equal((await chamar('royal_operacional_confirmar_partida', ['m', 'a'])).motivo, 'status');
    });
    await caso('mediação concorrente não pode ser roubada e sala exige pagamento', async () => {
      await chamar('royal_operacional_alterar_partida', ['m', 'assumir', JSON.stringify({ mediador_id: 'staff', comissao: 0.05 })]);
      await assert.rejects(chamar('royal_operacional_alterar_partida', ['m', 'assumir', JSON.stringify({ mediador_id: 'outro' })]), /mediador responsável/);
      await assert.rejects(chamar('royal_operacional_alterar_partida', ['m', 'sala', JSON.stringify({ sala_id: '123' })]), /pagamento/);
      await chamar('royal_operacional_alterar_partida', ['m', 'pago', '{}']);
      await chamar('royal_operacional_alterar_partida', ['m', 'sala', JSON.stringify({ sala_id: '123', sala_senha: '456', nix_sessao: 'sessao' })]);
    });
    await caso('GO inicia uma única vez e usuário estranho não entra', async () => {
      await assert.rejects(chamar('royal_operacional_dar_go', ['m', 'estranho']), /não está/);
      assert.equal((await chamar('royal_operacional_dar_go', ['m', 'a'])).iniciou, false);
      assert.equal((await chamar('royal_operacional_dar_go', ['m', 'b'])).iniciou, true);
      const repetido = await chamar('royal_operacional_dar_go', ['m', 'b']);
      assert.equal(repetido.iniciou, false); assert.equal(repetido.jaDeu, true);
    });
    await caso('pool não reaproveita partida em andamento; manual também é protegido', async () => {
      const url = 'https://meet.google.com/abc-defg-hij';
      const primeira = await chamar('royal_operacional_reservar_telagem', ['g', 'partida:m', 'abc', [url]]);
      assert.equal(primeira.origem, 'pool');
      assert.equal((await chamar('royal_operacional_reservar_telagem', ['g', 'partida:m', 'outro', [url]])).codigo, 'abc');
      await criar('n');
      await assert.rejects(chamar('royal_operacional_reservar_telagem', ['g', 'partida:n', 'def', [url]]), /Todos os links/);
      await assert.rejects(chamar('royal_operacional_fixar_telagem', ['g', 'partida:n', url, 'def']), /outra partida ativa/);
    });
    await caso('finalização + auditoria são atômicas e resultado não se duplica', async () => {
      const fim = await chamar('royal_operacional_encerrar_partida', ['m', 1, 'staff', 'resultado', false]);
      assert.equal(fim.partida.status, 'finalizada'); assert.equal(fim.jogadores.length, 2);
      assert.deepEqual(fim.jogadores.map((p) => Object.keys(p).sort()), [
        ['confirmou', 'partida_id', 'time', 'user_id'], ['confirmou', 'partida_id', 'time', 'user_id']]);
      await assert.rejects(chamar('royal_operacional_encerrar_partida', ['m', 1, 'staff', 'resultado', false]), /encerrada/);
      assert.equal((await q("SELECT count(*)::integer AS n FROM royal_audit_events WHERE entity_id='m'"))[0].n, 1);
      const receita = await chamar('royal_operacional_receita', ['g', 0]);
      assert.deepEqual(receita, [{ mediador_id: 'staff', partidas: 1, movimentado: 200, comissao: 10 }]);
      const historico = await chamar('royal_operacional_historico_apostas', ['g', 'a', 10]);
      assert.equal(historico.length, 1);
      assert.equal(historico[0].meu_time, 1);
      assert.equal(historico[0].id, 'm');
      assert.equal(Object.hasOwn(historico[0], 'ordem'), false);
    });
    await caso('falha na auditoria reverte também a finalização', async () => {
      await pg.exec("ALTER TABLE royal_audit_events ADD CONSTRAINT rejeitar_n CHECK(entity_id IS DISTINCT FROM 'n')");
      await assert.rejects(chamar('royal_operacional_encerrar_partida', ['n', 2, 'staff', 'wo', false]), /rejeitar_n/);
      assert.equal((await q("SELECT status FROM royal_partidas WHERE id='n'"))[0].status, 'confirmando');
      await pg.exec('ALTER TABLE royal_audit_events DROP CONSTRAINT rejeitar_n');
    });
    await caso('link da partida finalizada pode ser reciclado e limpeza é atômica', async () => {
      assert.equal((await chamar('royal_operacional_reservar_telagem', ['g', 'partida:n', 'def', ['https://meet.google.com/abc-defg-hij']])).origem, 'pool');
      const limpo = await chamar('royal_operacional_limpar_telagem', ['g']);
      assert.deepEqual(limpo, { removidos: 0, atribuicoes: 1 });
    });
    await caso('importação segura preserva saldo remoto e é idempotente', async () => {
      await pg.exec("INSERT INTO royal_profiles(guild_id,user_id,coins) VALUES('g','legado',40)");
      await assert.rejects(chamar('royal_operacional_importar_perfil', ['g', 'legado', JSON.stringify({ coins: 50 })]), /Conflito/);
      assert.equal((await q("SELECT coins::integer AS n FROM royal_profiles WHERE user_id='legado'"))[0].n, 40);
      const novo = await chamar('royal_operacional_importar_perfil', ['g', 'novo', JSON.stringify({ coins: 50 })]);
      assert.equal(novo.reconciliado, true);
      await pg.exec("UPDATE royal_profiles SET coins=80 WHERE user_id='novo'");
      assert.equal((await chamar('royal_operacional_importar_perfil', ['g', 'novo', JSON.stringify({ coins: 50 })])).jaImportado, true);
      assert.equal((await q("SELECT coins::integer AS n FROM royal_profiles WHERE user_id='novo'"))[0].n, 80);
    });
    await caso('funções e tabelas operacionais negam anon/authenticated', async () => {
      const roles = await q("SELECT has_function_privilege('anon','royal_operacional_confirmar_partida(text,text)','EXECUTE') AS anon,has_table_privilege('authenticated','royal_partidas','SELECT') AS autenticado");
      assert.deepEqual(roles[0], { anon: false, autenticado: false });
      assert.equal((await q("SELECT relrowsecurity AS rls FROM pg_class WHERE oid='royal_partidas'::regclass"))[0].rls, true);
      await chamar('royal_operacional_reajustar_sequencias');
    });
    if (fs.existsSync(complemento)) {
      await caso('complemento de painéis aplica junto ao core e preserva substituição atômica', async () => {
        const mensagens = [{ preco: 100, mensagem_id: 'primeira' }, { preco: 200, mensagem_id: 'segunda' }];
        await chamar('royal_registrar_mensagens_painel', ['g', 'solo', 'canal', JSON.stringify(mensagens), 1700000000000]);
        assert.equal((await q("SELECT count(*)::integer AS n FROM royal_mensagens_painel WHERE guild_id='g'"))[0].n, 2);
        assert.equal((await q("SELECT mensagem_id FROM royal_paineis WHERE guild_id='g'"))[0].mensagem_id, 'primeira');
        await assert.rejects(chamar('royal_registrar_mensagens_painel', ['g', 'solo', 'novo', JSON.stringify([mensagens[0], mensagens[0]]), 1700000000001]), /duplicate key/);
        assert.equal((await q("SELECT count(*)::integer AS n FROM royal_mensagens_painel WHERE guild_id='g'"))[0].n, 2);
        assert.equal((await q("SELECT canal_id FROM royal_paineis WHERE guild_id='g'"))[0].canal_id, 'canal');
        await pg.exec("INSERT INTO royal_plantao(guild_id,user_id,entrou_em) VALUES('g','staff',1700000000000)");
        assert.ok((await q("SELECT id FROM royal_plantao WHERE guild_id='g'"))[0].id);
      });
    }
    console.log(`${numero} cenários SQL PostgreSQL isolados aprovados.`);
  } finally { await pg.close(); }
}

async function main() {
  let falhas = 0;
  for (const { nome, fn } of testes) {
    try { await fn(); console.log(`OK ${nome}`); }
    catch (erro) { falhas += 1; console.error(`FALHOU ${nome}:`, erro.stack); }
  }
  if (process.env.PGLITE_MODULE) {
    try { await validarSQL(); }
    catch (erro) { falhas += 1; console.error('FALHOU validação PostgreSQL isolada:', erro.message, erro.stack); }
  } else console.log('SQL isolado opcional não executado; informe PGLITE_MODULE para validar as RPCs PostgreSQL.');
  console.log(`${testes.length - falhas}/${testes.length} contratos JS aprovados; nenhum banco remoto foi acessado.`);
  if (falhas) process.exitCode = 1;
}
if (require.main === module) main();
module.exports = { main, validarSQL };
