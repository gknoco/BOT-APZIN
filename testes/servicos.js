'use strict';

/** node testes/servicos.js — contratos Supabase isolados, sem rede ou banco remoto. */
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Collection, Events, PermissionFlagsBits } = require('discord.js');
process.env.DISCORD_TOKEN ||= 'test.token.value';
const plantao = require('../src/servicos/plantao');
const paineis = require('../src/servicos/paineis');
const mediadores = require('../src/servicos/mediadores');
const auditoria = require('../src/servicos/auditoria');
const fluxo = require('../src/servicos/fluxo');
const filas = require('../src/servicos/filas');
const partidas = require('../src/servicos/partidas');
const blacklist = require('../src/servicos/blacklist');
const royal = require('../src/servicos/royalSupabase');
const comandos = require('../src/comandos');
const registro = require('../src/servicos/registroComandos');
const convites = require('../src/servicos/convites');
const config = require('../src/config');
const { handleSelect } = require('../src/interacoes/selects');
const testes = [];
const test = (nome, executar) => testes.push({ nome, executar });
const turno = () => new Promise((resolve) => setImmediate(resolve));

function bancoFalso(inicial = {}) {
  const tabelas = structuredClone(inicial);
  const chamadas = [];
  let sequencia = 0;
  const client = {
    chamadas, tabelas, erro: null, errosPorTabela: {}, rpcErro: null,
    from(tabela) {
      const chamada = { tabela, operacao: 'select', filtros: [], ordens: [] };
      const q = {
        select(colunas, opcoes = {}) { chamada.colunas = colunas; chamada.opcoes = opcoes; return q; },
        eq(campo, valor) { chamada.filtros.push((linha) => linha[campo] === valor); return q; },
        in(campo, valores) { chamada.filtros.push((linha) => valores.includes(linha[campo])); return q; },
        order(campo, opcoes = {}) { chamada.ordens.push([campo, opcoes.ascending !== false]); return q; },
        range(inicio, fim) { chamada.inicio = inicio; chamada.fim = fim; return q; },
        limit(limite) { chamada.limite = limite; return q; },
        maybeSingle() { chamada.unico = true; return q; },
        insert(dados) { chamada.operacao = 'insert'; chamada.dados = dados; return q; },
        upsert(dados, opcoes) { chamada.operacao = 'upsert'; chamada.dados = dados; chamada.conflito = opcoes; return q; },
        update(dados) { chamada.operacao = 'update'; chamada.dados = dados; return q; },
        delete(opcoes = {}) { chamada.operacao = 'delete'; chamada.opcoes = opcoes; return q; },
        then(resolve, reject) {
          return Promise.resolve().then(() => {
            chamadas.push(chamada);
            const erro = client.errosPorTabela[tabela] || client.erro;
            if (erro) return { data: null, count: null, error: erro };
            const todas = tabelas[tabela] ||= [];
            let linhas = todas.filter((linha) => chamada.filtros.every((filtro) => filtro(linha)));
            if (chamada.operacao === 'insert' || chamada.operacao === 'upsert') {
              const dados = structuredClone(chamada.dados);
              const chaves = (chamada.conflito?.onConflict || '').split(',');
              const existe = chamada.operacao === 'upsert' && todas.find((linha) => chaves.every((chave) => linha[chave] === dados[chave]));
              if (existe && chamada.conflito.ignoreDuplicates) linhas = [];
              else if (existe) { Object.assign(existe, dados); linhas = [existe]; }
              else {
                const nova = { id: ++sequencia, created_at: new Date().toISOString(), ...dados };
                todas.push(nova); linhas = [nova];
              }
            } else if (chamada.operacao === 'delete') {
              tabelas[tabela] = todas.filter((linha) => !linhas.includes(linha));
            } else if (chamada.operacao === 'update') {
              linhas.forEach((linha) => Object.assign(linha, chamada.dados));
            }
            const count = linhas.length;
            linhas.sort((a, b) => {
              for (const [campo, asc] of chamada.ordens) {
                if (a[campo] !== b[campo]) return (a[campo] > b[campo] ? 1 : -1) * (asc ? 1 : -1);
              }
              return 0;
            });
            const inicio = chamada.inicio || 0;
            const quantidade = Math.min(1000, chamada.limite ?? (chamada.fim == null ? 1000 : chamada.fim - inicio + 1));
            linhas = linhas.slice(inicio, inicio + quantidade);
            if (chamada.colunas && chamada.colunas !== '*') {
              const campos = chamada.colunas.split(',');
              linhas = linhas.map((linha) => Object.fromEntries(campos.map((campo) => [campo, linha[campo]])));
            }
            return { data: chamada.opcoes?.head ? null : chamada.unico ? linhas[0] || null : linhas, count, error: null };
          }).then(resolve, reject);
        },
      };
      return q;
    },
    async rpc(nome, parametros) {
      await Promise.resolve();
      chamadas.push({ rpc: nome, parametros });
      return client.rpcErro ? { error: client.rpcErro, data: null } : { error: null, data: null };
    },
  };
  return { client, motor: 'supabase', close: async () => {} };
}

async function semConsole(executar) {
  const originais = { error: console.error, warn: console.warn, log: console.log };
  const mensagens = { error: [], warn: [], log: [] };
  for (const tipo of Object.keys(originais)) console[tipo] = (...args) => mensagens[tipo].push(args.join(' '));
  try { await executar(mensagens); } finally { Object.assign(console, originais); }
}

async function substituir(alteracoes, executar) {
  const originais = alteracoes.map(([objeto, chave]) => objeto[chave]);
  alteracoes.forEach(([objeto, chave, valor]) => { objeto[chave] = valor; });
  try { await executar(); } finally {
    alteracoes.forEach(([objeto, chave], indice) => { objeto[chave] = originais[indice]; });
  }
}

const configuracao = (chave, valor, guild = 'g') => ({ guild_id: guild, chave, valor });
const membro = (ids = [], admin = false) => ({
  roles: { cache: new Set(ids) },
  permissions: { has: (permissao) => permissao === PermissionFlagsBits.Administrator && admin },
});

test('plantão é idempotente e nunca reposiciona quem já entrou', async () => {
  const db = bancoFalso();
  assert.equal(await plantao.entrar(db, { guildId: 'g', userId: 'u' }), true);
  const entrou = db.client.tabelas.royal_plantao[0].entrou_em;
  assert.equal(await plantao.entrar(db, { guildId: 'g', userId: 'u' }), false);
  assert.equal(db.client.tabelas.royal_plantao[0].entrou_em, entrou);
  assert.equal(await plantao.total(db, 'g'), 1);
  assert.equal(await plantao.total(db, 'outra'), 0);
});

test('plantão desempata pelo ID, isola servidores e mantém retornos antigos', async () => {
  const db = bancoFalso({ royal_plantao: [
    { id: 8, guild_id: 'g', user_id: 'b', entrou_em: 10 },
    { id: 2, guild_id: 'g', user_id: 'a', entrou_em: 10 },
    { id: 1, guild_id: 'outra', user_id: 'a', entrou_em: 1 },
  ] });
  assert.deepEqual((await plantao.listar(db, 'g')).map((linha) => linha.user_id), ['a', 'b']);
  assert.equal(await plantao.proximo(db, 'g'), 'a');
  assert.equal(await plantao.posicao(db, { guildId: 'g', userId: 'b' }), 2);
  assert.equal(await plantao.posicao(db, { guildId: 'g', userId: 'ausente' }), null);
  assert.equal(await plantao.sair(db, { guildId: 'g', userId: 'a' }), 1);
  assert.equal(await plantao.sair(db, { guildId: 'g', userId: 'a' }), 0);
  assert.equal(await plantao.total(db, 'outra'), 1);
  assert.equal(await plantao.limpar(db, 'g'), 1);
  assert.equal(await plantao.proximo(db, 'g'), null);
});

test('plantão pagina leituras acima de mil linhas e devolve painel resolvido', async () => {
  const db = bancoFalso({ royal_plantao: Array.from({ length: 1203 }, (_, id) => ({
    id, guild_id: 'g', user_id: String(id), entrou_em: 1,
  })) });
  assert.equal((await plantao.listar(db, 'g')).length, 1203);
  assert.equal(await plantao.total(db, 'g'), 1203);
  const painel = await plantao.painel(bancoFalso(), 'g');
  assert.equal(typeof painel.embeds[0].toJSON, 'function');
  assert.match(painel.embeds[0].toJSON().description, /0 mediador/);
});

test('erros de Supabase no plantão são propagados', async () => {
  const db = bancoFalso(); db.client.erro = { code: 'XX', message: 'falha simulada' };
  for (const operar of [
    () => plantao.entrar(db, { guildId: 'g', userId: 'u' }),
    () => plantao.sair(db, { guildId: 'g', userId: 'u' }),
    () => plantao.listar(db, 'g'), () => plantao.total(db, 'g'),
    () => plantao.limpar(db, 'g'), () => plantao.proximo(db, 'g'),
  ]) await assert.rejects(operar, /falha simulada/);
});

test('painéis usam upsert por servidor/modo e lista permanece compatível', async () => {
  const db = bancoFalso();
  await paineis.salvar(db, { guildId: 'g', modo: 'm', canalId: 'c', mensagemId: '1' });
  await paineis.salvar(db, { guildId: 'g', modo: 'm', canalId: 'd', mensagemId: '2' });
  assert.equal(db.client.tabelas.royal_paineis.length, 1);
  assert.equal((await paineis.obter(db, { guildId: 'g', modo: 'm' })).mensagem_id, '2');
  assert.equal(await paineis.obter(db, { guildId: 'g', modo: 'ausente' }), null);
  assert.equal((await paineis.todos(db, 'g')).length, 1);
});

test('mensagens dos painéis são lidas em preço descendente', async () => {
  const db = bancoFalso({ royal_mensagens_painel: [
    { guild_id: 'g', modo: 'm', preco: 50, mensagem_id: 'barata' },
    { guild_id: 'g', modo: 'm', preco: 100, mensagem_id: 'cara' },
    { guild_id: 'outra', modo: 'm', preco: 999, mensagem_id: 'outra' },
  ] });
  assert.deepEqual((await paineis.mensagensSalvas(db, { guildId: 'g', modo: 'm' })).map((x) => x.mensagem_id), ['cara', 'barata']);
});

test('salvarFila usa uma única RPC para substituir mensagens e painel atomicamente', async () => {
  const db = bancoFalso();
  await paineis.salvarFila(db, { guildId: 'g', modo: 'm', canalId: 'c', mensagens: [
    { preco: 100, mensagemId: '1' }, { preco: 50, mensagemId: '2' },
  ] });
  assert.equal(db.client.chamadas.length, 1);
  const chamada = db.client.chamadas[0];
  assert.equal(chamada.rpc, 'royal_registrar_mensagens_painel');
  assert.deepEqual(chamada.parametros.p_mensagens, [{ preco: 100, mensagem_id: '1' }, { preco: 50, mensagem_id: '2' }]);
  db.client.rpcErro = { message: 'transação falhou' };
  await assert.rejects(() => paineis.salvarFila(db, { guildId: 'g', modo: 'm', canalId: 'c', mensagens: [] }), /transação falhou/);
});

test('publicação só apaga mensagens anteriores depois de confirmar persistência', async () => {
  const modo = config.MODOS[0];
  const db = bancoFalso({ royal_mensagens_painel: [{ guild_id: 'g', modo: modo.id, preco: 50, canal_id: 'c', mensagem_id: 'antiga' }] });
  let apagadas = 0;
  let enviadas = 0;
  const canal = { id: 'c', send: async () => ({ id: String(++enviadas) }), messages: {
    fetch: async () => ({ delete: async () => {
      assert.equal(db.client.chamadas.at(-1).rpc, 'royal_registrar_mensagens_painel'); apagadas++;
    } }),
  } };
  assert.equal((await paineis.publicarFila(db, canal, { guildId: 'g', modo })).length, config.PRECOS.length);
  assert.equal(apagadas, 1);
  db.client.rpcErro = { message: 'sem commit' };
  await assert.rejects(() => paineis.publicarFila(db, canal, { guildId: 'g', modo }), /sem commit/);
  assert.equal(apagadas, 1);
});

test('mediadores lê configuração atual sem snapshot e hidratação não escreve nada', async () => {
  const db = bancoFalso({ discord_configuracoes: [configuracao('cargos_mediadores', '["r1"]'), configuracao('modo_mediadores', 'fila')] });
  assert.deepEqual(await mediadores.cargos(db, 'g'), ['r1']);
  assert.deepEqual(await mediadores.hidratarConfiguracaoRemota(db, 'g'), { cargos_mediadores: '["r1"]', modo_mediadores: 'fila' });
  assert.ok(db.client.chamadas.every((x) => x.operacao === 'select'));
  db.client.tabelas.discord_configuracoes[0].valor = '["r2"]';
  assert.deepEqual(await mediadores.cargos(db, 'g'), ['r2']);
  assert.equal(await mediadores.modo(db, 'g'), 'fila');
});

test('permissões assíncronas preservam cargos e exceção de administrador', async () => {
  const db = bancoFalso({ discord_configuracoes: [configuracao('cargos_mediadores', '["r1"]')] });
  assert.equal(await mediadores.temCargoMediador(db, 'g', membro(['r1'])), true);
  assert.equal(await mediadores.temCargoMediador(db, 'g', membro([], true)), false);
  assert.equal(await mediadores.podeUsarSalas(db, 'g', membro([], true)), false);
  assert.equal(await mediadores.ehMediador(db, 'g', membro([], true)), true);
  assert.equal(await mediadores.ehMediador(db, 'g', membro()), false);
  assert.equal(await mediadores.podeUsarSalas(db, 'g', membro(['r1'])), true);
});

test('configuração de mediadores salva uma vez e builder aguarda os dados', async () => {
  const db = bancoFalso();
  assert.deepEqual(await mediadores.definirCargos(db, 'g', ['r1', 'r1', 'r2']), ['r1', 'r2']);
  await mediadores.definirCanalBatePonto(db, 'g', 'canal');
  await mediadores.definirCanalConfigPix(db, 'g', 'pix');
  await mediadores.definirModo(db, 'g', 'fila');
  await mediadores.definirLimparFilaAuto(db, 'g', true);
  const painel = await mediadores.painelConfig(db, 'g');
  const texto = painel.embeds[0].toJSON().description;
  assert.match(texto, /<@&r1>/); assert.match(texto, /<#canal>/); assert.match(texto, /<#pix>/); assert.match(texto, /Ativado/); assert.match(texto, /Modo Atual:\*\* Fila/);
  assert.equal(db.client.chamadas.filter((x) => x.operacao === 'upsert').length, 5);
});

test('auditoria persiste antes de buscar canal e Unknown Channel não emite console', async () => {
  const db = bancoFalso({ discord_configuracoes: [configuracao('canal_logs', 'apagado')] });
  const client = { channels: { cache: new Map(), fetch: async () => {
    assert.equal(db.client.tabelas.royal_audit_events.length, 1);
    throw Object.assign(new Error('Unknown Channel'), { code: 10003 });
  } } };
  await semConsole(async (mensagens) => {
    await auditoria.registrar(db, client, { guildId: 'g', autorId: 'u', acao: 'Ação', detalhe: 'x'.repeat(1900) });
    assert.equal(mensagens.warn.length, 0); assert.equal(mensagens.error.length, 0);
  });
  assert.equal(db.client.tabelas.royal_audit_events[0].detail.length, 1800);
});

test('auditoria ignora Unknown Channel no envio, mas revela erros de permissão', async () => {
  const db = bancoFalso({ discord_configuracoes: [configuracao('canal_logs', 'logs')] });
  let codigo = 10003;
  const canal = { isTextBased: () => true, send: async () => { throw Object.assign(new Error(`falha ${codigo}`), { code: codigo }); } };
  const client = { channels: { cache: new Map([['logs', canal]]) } };
  await semConsole(async (mensagens) => {
    await auditoria.registrar(db, client, { guildId: 'g', acao: 'A' });
    assert.equal(mensagens.error.length, 0);
    codigo = 50013;
    await auditoria.registrar(db, client, { guildId: 'g', acao: 'B' });
    assert.equal(mensagens.error.length, 1); assert.match(mensagens.error[0], /50013/);
  });
  assert.equal(db.client.tabelas.royal_audit_events.length, 2);
});

test('auditoria retorna nomes e timestamp legados, em ordem recente', async () => {
  const db = bancoFalso({ royal_audit_events: [
    { id: 1, guild_id: 'g', actor_id: 'u', action: 'primeira', detail: null, created_at: '2026-01-01T00:00:00Z' },
    { id: 2, guild_id: 'g', actor_id: 'u2', action: 'segunda', detail: 'd', created_at: '2026-01-02T00:00:00Z' },
  ] });
  const recentes = await auditoria.recentes(db, 'g', 1);
  assert.deepEqual(recentes, [{ id: 2, guild_id: 'g', autor_id: 'u2', acao: 'segunda', detalhe: 'd', criado_em: Date.parse('2026-01-02T00:00:00Z') }]);
});

test('auditoria mescla nuvem e legado por milissegundos, isola guild e limita após mesclar', async () => {
  const dia = (n) => Date.parse(`2026-01-0${n}T00:00:00Z`);
  const legado = (id, guild, n) => ({ origem: 'sqlite', id, guild_id: guild, autor_id: 'antigo', acao: `legado ${n}`, detalhe: null, criado_em: String(dia(n)) });
  const db = bancoFalso({
    royal_audit_events: [
      { id: 99, guild_id: 'g', actor_id: 'u', action: 'atual 1', detail: null, created_at: '2026-01-01T00:00:00Z' },
      { id: 1, guild_id: 'g', actor_id: 'u', action: 'atual 3', detail: 'd', created_at: '2026-01-03T00:00:00Z' },
      { id: 100, guild_id: 'outra', created_at: '2026-01-09T00:00:00Z' },
    ],
    royal_auditoria_legada: [legado(1, 'g', 4), legado(2, 'g', 2), legado(3, 'outra', 8)],
  });
  const recentes = await auditoria.recentes(db, 'g', 3);
  assert.deepEqual(recentes.map((x) => x.acao), ['legado 4', 'atual 3', 'legado 2']);
  assert.deepEqual(recentes[0], { id: 1, guild_id: 'g', autor_id: 'antigo', acao: 'legado 4', detalhe: null, criado_em: dia(4) });
  assert.ok(db.client.chamadas.every((x) => x.limite === 3));
  assert.deepEqual(await auditoria.recentes(db, 'ausente'), []);
  assert.equal((await auditoria.recentes(db, 'g', 'inválido')).length, 4);
  assert.equal((await auditoria.recentes(db, 'g', 0)).length, 1);
});

test('auditoria histórica legada funciona sozinha e falha de qualquer fonte é propagada', async () => {
  const linha = { id: 9, guild_id: 'g', autor_id: null, acao: 'importada', detalhe: 'histórico', criado_em: 1234 };
  assert.deepEqual(await auditoria.recentes(bancoFalso({ royal_auditoria_legada: [linha] }), 'g'), [linha]);
  for (const tabela of ['royal_audit_events', 'royal_auditoria_legada']) {
    const db = bancoFalso(); db.client.errosPorTabela[tabela] = { message: `falha ${tabela}` };
    await assert.rejects(() => auditoria.recentes(db, 'g'), new RegExp(`falha ${tabela}`));
  }
});

test('falha de persistência de auditoria continua visível', async () => {
  const db = bancoFalso(); db.client.erro = { message: 'nuvem indisponível' };
  await semConsole(async (mensagens) => {
    await auditoria.registrar(db, null, { guildId: 'g', acao: 'A' });
    assert.equal(mensagens.error.length, 1); assert.match(mensagens.error[0], /nuvem indisponível/);
  });
});

test('select de cargos confirma primeiro e faz somente uma gravação', async () => {
  const db = bancoFalso(); let ack = false; let redesenhado = false;
  const interaction = {
    customId: 'ap:medcargos', guildId: 'g', values: ['r1'], member: membro([], true),
    deferUpdate: async () => { ack = true; interaction.deferred = true; },
    editReply: async (painel) => { assert.ok(ack); assert.equal(typeof painel.embeds[0].toJSON, 'function'); redesenhado = true; },
  };
  assert.equal(await handleSelect(interaction, { db }), true);
  assert.ok(redesenhado);
  assert.equal(db.client.chamadas.filter((x) => x.operacao === 'upsert').length, 1);
});

test('fluxo aguarda blacklist, entrada e contagem na fila', async () => {
  let entrou = false; const modo = config.MODOS[0];
  await substituir([
    [blacklist, 'obter', async () => null],
    [filas, 'entrar', async () => { await turno(); entrou = true; return { entrou: true, posicao: 1 }; }],
    [filas, 'contar', async () => { assert.ok(entrou); return 1; }],
    [paineis, 'atualizar', async () => true],
  ], async () => {
    const resultado = await fluxo.entrarNaFila({}, bancoFalso(), {
      guild: { id: 'g' }, userId: 'u', modo: modo.id, preco: config.PRECOS[0], gelo: config.variantesDoModo(modo)[0].id,
    });
    assert.equal(resultado.fechou, false); assert.equal(resultado.naFila, 1);
  });
});

test('resposta perdida na seleção da fila não provoca compensação ou sucesso', async () => {
  const modo = config.MODOS[0]; const entradas = []; let criacoes = 0;
  await substituir([
    [blacklist, 'obter', async () => null],
    [filas, 'entrar', async (_db, dados) => { entradas.push(dados.userId); return { entrou: true, posicao: 2 }; }],
    [filas, 'contar', async () => 2],
    [filas, 'reservar', async () => { throw new Error('resposta perdida após possível remoção'); }],
    [partidas, 'criar', async () => { criacoes++; }],
    [paineis, 'atualizar', async () => true],
  ], async () => semConsole(async (mensagens) => {
    await assert.rejects(fluxo.entrarNaFila({}, bancoFalso(), {
      guild: { id: 'g' }, userId: 'u', modo: modo.id, preco: config.PRECOS[0], gelo: config.variantesDoModo(modo)[0].id,
    }), /confirmar a reserva.*ADM reconciliá-la/);
    assert.deepEqual(entradas, ['u']); assert.equal(criacoes, 0);
    assert.ok(mensagens.error.some((x) => /reserva incerta .*guild g/.test(x)));
  }));
});

async function comCriacaoDePartida(opcoes, executar) {
  const modo = config.MODOS[0];
  const estado = { entradas: [], criacoes: 0, consultas: 0, canais: 0, apagados: 0, mensagens: 0, payloads: [], auditorias: 0 };
  const partida = { id: 'p', guild_id: 'g', canal_id: 'c', modo: modo.id, gelo: config.variantesDoModo(modo)[0].id,
    preco: config.PRECOS[0], status: partidas.STATUS.CONFIRMANDO };
  const canal = { id: 'c', name: 'fila-teste',
    send: async (payload) => { estado.mensagens++; estado.payloads.push(payload); if (opcoes.erroAviso) throw new Error('Discord indisponível'); return { id: 'mensagem' }; },
    delete: async () => { estado.apagados++; },
  };
  const client = { user: { id: 'bot' }, channels: { cache: new Map([['c', canal]]) } };
  const guild = { id: 'g', roles: { everyone: { id: 'everyone' } }, channels: {
    cache: new Collection(), create: async () => {
      estado.canais++;
      if (opcoes.erroCanal) throw new Error('Discord sem permissão');
      return canal;
    },
  } };
  await substituir([
    [blacklist, 'obter', async () => null],
    [filas, 'entrar', async (_db, dados) => { estado.entradas.push(dados); return { entrou: true, posicao: 2 }; }],
    [filas, 'contar', async () => config.CAPITAES_POR_PARTIDA],
    [filas, 'reservar', async (_db, d) => { partida.id = d.partidaId; return { id: d.reservaId, partida_id: d.partidaId, guild_id: d.guildId, modo: d.modo, preco: d.preco, gelo: d.gelo, estado: 'reservada', jogadores: ['u1', 'u2'], filas_originais: [{ guild_id: d.guildId, modo: d.modo, preco: d.preco, gelo: d.gelo, user_id: 'u1' }] }; }],
    [filas, 'vincularCanal', async (_db, d) => ({ id: d.reservaId, guild_id: d.guildId, canal_id: d.canalId, estado: 'reservada' })],
    [paineis, 'atualizar', async () => true],
    [paineis, 'nomeSalaFila', () => canal.name],
    [mediadores, 'mencoes', async () => []],
    [mediadores, 'cargos', async () => []],
    [partidas, 'criar', async (_db, dados) => {
      estado.criacoes++;
      assert.equal(dados.guildId, 'g'); assert.equal(dados.canalId, 'c');
      assert.deepEqual(dados.jogadores, [{ userId: 'u1', time: 1 }, { userId: 'u2', time: 2 }]);
      if (opcoes.erroCriar) throw new Error('resposta RPC perdida');
      if (Object.hasOwn(opcoes, 'resposta')) return opcoes.resposta;
      return partida;
    }],
    [partidas, 'porCanal', async (_db, guildId, canalId) => {
      estado.consultas++; assert.equal(guildId, 'g'); assert.equal(canalId, 'c');
      if (opcoes.erroConsulta) throw new Error('consulta indisponível');
      return opcoes.recuperar ? { ...partida, ...opcoes.recuperar } : null;
    }],
    [partidas, 'jogadores', async () => [{ user_id: 'u1', time: 1 }, { user_id: 'u2', time: 2 }]],
    [partidas, 'definirMensagem', async () => {}],
    [auditoria, 'registrar', async () => { estado.auditorias++; }],
  ], async () => {
    await semConsole(async (mensagens) => {
      const entrar = () => fluxo.entrarNaFila(client, bancoFalso(), {
        guild, userId: 'u2', modo: modo.id, preco: partida.preco, gelo: partida.gelo,
      });
      await executar({ estado, partida, entrar, mensagens });
    });
  });
}

test('fluxo cria canal e partida uma vez e publica somente após persistência', async () => {
  await comCriacaoDePartida({}, async ({ estado, entrar }) => {
    const resultado = await entrar();
    assert.equal(resultado.fechou, true); assert.ok(resultado.partida.id); assert.equal(resultado.canalId, 'c');
    assert.equal(estado.criacoes, 1); assert.equal(estado.consultas, 0);
    assert.equal(estado.mensagens, 1); assert.equal(estado.auditorias, 1);
    assert.equal(estado.apagados, 0); assert.equal(estado.entradas.length, 1);
  });
});

test('falha antes da RPC não compensa capitães que podem ter reentrado', async () => {
  await comCriacaoDePartida({ erroCanal: true }, async ({ estado, entrar }) => {
    await assert.rejects(entrar, /operação pode ainda estar em processamento.*ADM reconciliá-la/);
    assert.equal(estado.entradas.length, 1);
    assert.equal(estado.criacoes, 0); assert.equal(estado.consultas, 0);
    assert.equal(estado.apagados, 0); assert.equal(estado.mensagens, 0);
  });
});

test('erro RPC sempre falha fechado mesmo se uma consulta hipotética retornasse partida', async () => {
  for (const recuperar of [null, {}, { guild_id: 'outra' }, { canal_id: 'outro' }]) {
    await comCriacaoDePartida({ erroCriar: true, recuperar }, async ({ estado, entrar, mensagens }) => {
      await assert.rejects(entrar, /operação pode ainda estar em processamento.*ADM reconciliá-la/);
      assert.equal(estado.entradas.length, 1); assert.equal(estado.apagados, 0);
      assert.equal(estado.criacoes, 2); assert.equal(estado.consultas, 0); assert.equal(estado.mensagens, 1);
      assert.equal(estado.auditorias, 0);
      assert.doesNotMatch(estado.payloads[0].content, /sala de AP criada|recolocados/i);
      assert.ok(mensagens.error.some((x) => /guild g, canal c, capitães u1, u2/.test(x)));
    });
  }
});

test('resposta de criação ausente ou incompatível nunca é anunciada como sucesso', async () => {
  const modo = config.MODOS[0];
  const outraResposta = { id: 'p', guild_id: 'g', canal_id: 'c', modo: modo.id, preco: config.PRECOS[0],
    gelo: config.variantesDoModo(modo)[0].id, status: partidas.STATUS.FINALIZADA };
  for (const resposta of [null, {}, { id: 'p', guild_id: 'outra', canal_id: 'c' }, outraResposta]) {
    await comCriacaoDePartida({ resposta }, async ({ estado, entrar }) => {
      await assert.rejects(entrar, /operação pode ainda estar em processamento/i);
      assert.equal(estado.criacoes, 2); assert.equal(estado.consultas, 0); assert.equal(estado.entradas.length, 1);
      assert.equal(estado.apagados, 0); assert.equal(estado.auditorias, 0);
      assert.equal(estado.mensagens, 1); assert.doesNotMatch(estado.payloads[0].content, /sala de AP criada/i);
    });
  }
});

test('falha ao avisar no canal preserva erro e log para verificação manual', async () => {
  await comCriacaoDePartida({ erroCriar: true, erroAviso: true }, async ({ estado, entrar, mensagens }) => {
    await assert.rejects(entrar, /ADM reconciliá-la/);
    assert.equal(estado.entradas.length, 1); assert.equal(estado.apagados, 0); assert.equal(estado.auditorias, 0);
    assert.ok(mensagens.error.some((x) => /não consegui avisar no canal c/.test(x)));
  });
});

test('fluxo aguarda jogadores e persistência da mensagem', async () => {
  let persistiu = false;
  const partida = { id: 'p', canal_id: 'c', modo: config.MODOS[0].id, gelo: 'normal', preco: 50, status: partidas.STATUS.CONFIRMANDO };
  const canal = { send: async (payload) => {
    assert.match(payload.content, /<@u>/); return { id: 'mensagem' };
  } };
  await substituir([
    [partidas, 'jogadores', async () => { await turno(); return [{ user_id: 'u', time: 1, confirmou: 0 }]; }],
    [partidas, 'definirMensagem', async () => { await turno(); persistiu = true; }],
  ], async () => {
    assert.equal(await fluxo.publicarSala({ channels: { cache: new Map([['c', canal]]) } }, bancoFalso(), partida), true);
    assert.ok(persistiu);
  });
});

test('fluxo usa somente a finalização transacional inclusive em replay e conflito', async () => {
  const partida = { id: 'p', guild_id: 'g', status: partidas.STATUS.FINALIZADA, vencedor_time: 1, motivo_fim: 'resultado' };
  let chamadas = 0;
  await substituir([
    [partidas, 'finalizar', async (_db, dados) => {
      chamadas++;
      if (dados.vencedorTime !== 1) throw new Error('outro resultado');
      return { partida, jogadores: [{ user_id: 'u', time: 1 }], replay: true };
    }],
    [royal, 'registrarResultadoPartida', async () => { throw new Error('RPC econômica separada não deve ser chamada'); }],
    [auditoria, 'registrar', async () => { throw new Error('auditoria separada não deve ser chamada'); }],
  ], async () => {
    assert.equal((await fluxo.encerrarPartida({}, bancoFalso(), { partidaId: 'p', vencedorTime: 1, autorId: 'u' })).partida.id, 'p');
    await assert.rejects(() => fluxo.encerrarPartida({}, bancoFalso(), { partidaId: 'p', vencedorTime: 2 }), /outro resultado/);
    assert.equal(chamadas, 2);
  });
});

test('ready aguarda preparação antes de liberar handlers e preserva deduplicação', async () => {
  let liberar; let executadas = 0;
  const bloqueio = new Promise((resolve) => { liberar = resolve; });
  await substituir([
    [mediadores, 'hidratarConfiguracaoRemota', async () => bloqueio],
    [comandos, 'executar', async () => { executadas++; }],
    [registro, 'registrarComandos', async () => ({ guildId: null })],
    [convites, 'atualizarCache', async () => {}],
  ], async () => {
    delete require.cache[require.resolve('../src/eventos')];
    const { montar } = require('../src/eventos');
    const client = new EventEmitter();
    client.guilds = { cache: new Map([['g', { id: 'g' }]]) };
    client.user = { tag: 'teste', setActivity() {} }; client.application = { id: 'app' };
    montar(client, bancoFalso());
    await semConsole(async () => {
      const ready = client.listeners(Events.ClientReady)[0](client);
      const handler = client.listeners(Events.InteractionCreate)[0];
      let aviso = false;
      await handler({ id: 'antes', reply: async () => { aviso = true; }, isChatInputCommand: () => true });
      assert.ok(aviso); assert.equal(executadas, 0);
      liberar(); await ready;
      const interaction = { id: 'depois', isChatInputCommand: () => true };
      await handler(interaction); await handler(interaction);
      assert.equal(executadas, 1);
    });
  });
});

test('ready recupera falhas transitórias com backoff sem montar ou executar jobs duplicados', async () => {
  const db = bancoFalso(); const esperas = [];
  let hidratacoes = 0; let registros = 0; let caches = 0; let executadas = 0;
  await substituir([
    [global, 'setTimeout', (resolver, ms) => { esperas.push(ms); queueMicrotask(resolver); }],
    [mediadores, 'hidratarConfiguracaoRemota', async () => {
      hidratacoes++;
      if (hidratacoes === 1) throw new Error('rede na hidratação');
      db.client.errosPorTabela.royal_paineis = hidratacoes === 2 ? { message: 'rede na contagem' } : null;
    }],
    [comandos, 'executar', async () => { executadas++; }],
    [registro, 'registrarComandos', async () => { registros++; return { guildId: null }; }],
    [convites, 'atualizarCache', async () => { caches++; }],
  ], async () => {
    delete require.cache[require.resolve('../src/eventos')];
    const { montar } = require('../src/eventos');
    const client = new EventEmitter();
    client.guilds = { cache: new Map([['g', { id: 'g' }]]) };
    client.user = { tag: 'teste', setActivity() {} }; client.application = { id: 'app' };
    const ctx = montar(client, db);
    assert.equal(montar(client, db), ctx);
    assert.equal(client.listenerCount(Events.ClientReady), 1);
    assert.equal(client.listenerCount(Events.InteractionCreate), 1);
    await semConsole(async (mensagens) => {
      const ready = client.listeners(Events.ClientReady)[0];
      const handler = client.listeners(Events.InteractionCreate)[0];
      const tarefa = ready(client);
      assert.equal(ready(client), tarefa);
      let avisos = 0;
      await handler({ id: 'bloqueada', reply: async () => { avisos++; }, isChatInputCommand: () => true });
      assert.equal(avisos, 1); assert.equal(executadas, 0);
      await tarefa;
      assert.deepEqual(esperas, [1000, 2000]); assert.equal(hidratacoes, 3);
      assert.equal(db.client.chamadas.filter((x) => x.tabela === 'royal_paineis').length, 2);
      assert.equal(registros, 1); assert.equal(caches, 1);
      await ready(client);
      assert.equal(registros, 1); assert.equal(caches, 1);
      const interaction = { id: 'recuperada', isChatInputCommand: () => true };
      await Promise.all([handler(interaction), handler(interaction)]);
      assert.equal(executadas, 1);
      assert.equal(mensagens.error.filter((x) => /preparação Supabase falhou/.test(x)).length, 2);
    });
  });
});

test('ready encerra após tentativas finitas sem liberar handlers nem deixar retentativas pendentes', async () => {
  const db = bancoFalso(); const esperas = []; const saidas = [];
  let hidratacoes = 0; let fechado = false; let destruido = false; let registros = 0;
  db.close = async () => { fechado = true; };
  await substituir([
    [global, 'setTimeout', (resolver, ms) => { esperas.push(ms); queueMicrotask(resolver); }],
    [process, 'exit', (codigo) => { assert.ok(fechado); assert.ok(destruido); saidas.push(codigo); }],
    [mediadores, 'hidratarConfiguracaoRemota', async () => { hidratacoes++; throw new Error('Supabase indisponível'); }],
    [comandos, 'executar', async () => { assert.fail('não pode liberar handlers sem banco'); }],
    [registro, 'registrarComandos', async () => { registros++; }],
  ], async () => {
    delete require.cache[require.resolve('../src/eventos')];
    const { montar } = require('../src/eventos');
    const client = new EventEmitter();
    client.guilds = { cache: new Map([['g', { id: 'g' }]]) };
    client.user = { tag: 'teste' };
    client.destroy = async () => { destruido = true; throw new Error('falha ao desconectar'); };
    montar(client, db);
    await semConsole(async (mensagens) => {
      const ready = client.listeners(Events.ClientReady)[0];
      await ready(client); await ready(client); await turno();
      assert.equal(hidratacoes, 6); assert.equal(registros, 0);
      assert.deepEqual(esperas, [1000, 2000, 4000, 8000, 16000]); assert.deepEqual(saidas, [1]);
      let avisos = 0;
      await client.listeners(Events.InteractionCreate)[0]({ id: 'sem-banco', reply: async () => { avisos++; }, isChatInputCommand: () => true });
      assert.equal(avisos, 1);
      assert.ok(mensagens.error.some((x) => /falha no encerramento/.test(x)));
    });
  });
});

async function main() {
  for (const { nome, executar } of testes) { await executar(); console.log(`OK ${nome}`); }
  console.log(`✅ ${testes.length} testes isolados de serviços concluídos, sem rede.`);
}
if (require.main === module) main().catch((erro) => { console.error(erro); process.exitCode = 1; });
module.exports = { main };
