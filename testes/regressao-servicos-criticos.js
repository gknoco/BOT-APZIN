'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { test } = require('node:test');
const { createClient } = require('@supabase/supabase-js');
const supabase = require('../src/servicos/supabase');
const nix = require('../src/servicos/nix');
const partidas = require('../src/servicos/partidas');
const automacoes = require('../src/servicos/automacoesDiscord');
const versiculos = require('../src/servicos/versiculos');

async function servidor(handler, fn) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try { return await fn(url); }
  finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

const pausa = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('Supabase limita espera por cabeçalhos e corpo, aborta socket e não repete escrita', async () => {
  let chamadas = 0;
  let fechados = 0;
  await servidor((req, res) => {
    chamadas++;
    res.on('close', () => { fechados++; });
    req.resume();
    if (req.url === '/corpo') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{');
    }
    // Nunca devolve cabeçalhos na RPC e nunca conclui o corpo no outro teste.
  }, async (url) => {
    const client = createClient(url, 'test-key', {
      global: { fetch: (input, init) => supabase.fetchComPrazo(input, init, 100) },
      db: { retry: false },
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const inicio = Date.now();
    const resultado = await client.rpc('teste_escrita', { valor: 1 });
    assert.ok(resultado.error, 'falha de transporte não deve parecer sucesso');
    assert.equal(resultado.status, 0);
    assert.equal(chamadas, 1, 'uma escrita com resultado incerto não deve ser repetida');
    assert.ok(Date.now() - inicio < 1500);
    const resposta = await supabase.fetchComPrazo(`${url}/corpo`, {}, 100);
    await assert.rejects(resposta.text(), (erro) => erro.name === 'AbortError');
    assert.equal(chamadas, 2);
    for (let i = 0; i < 20 && fechados < 2; i++) await pausa(10);
    assert.equal(fechados, 2, 'as duas conexões abortadas devem fechar no servidor');
  });
});

test('Supabase preserva respostas normais, cancelamento externo e erros de rede', async () => {
  await servidor((req, res) => {
    if (req.url === '/ok') {
      res.writeHead(201, { 'content-type': 'application/json', 'x-teste': 'sim' });
      res.end(JSON.stringify({ salvo: true }));
    } else {
      res.writeHead(200); res.write('incompleto');
    }
  }, async (url) => {
    const resposta = await supabase.fetchComPrazo(`${url}/ok`, {}, 1000);
    assert.equal(resposta.status, 201);
    assert.equal(resposta.headers.get('x-teste'), 'sim');
    assert.equal(resposta.url, `${url}/ok`);
    assert.deepEqual(await resposta.json(), { salvo: true });
    const sinal = new AbortController();
    const pendente = await supabase.fetchComPrazo(`${url}/lento`, { signal: sinal.signal }, 1000);
    const leitura = pendente.text();
    sinal.abort();
    await assert.rejects(leitura, (erro) => erro.name === 'AbortError');
    const cancelado = new AbortController();
    cancelado.abort();
    await assert.rejects(supabase.fetchComPrazo(`${url}/ok`, { signal: cancelado.signal }, 1000), (erro) => erro.name === 'AbortError');
  });
  await assert.rejects(supabase.fetchComPrazo('http://127.0.0.1:1/', {}, 500));
});

test('Nix limita tempo de resposta mesmo após cabeçalhos e propaga erro de corpo', async () => {
  const chave = process.env.NIX_API_KEY;
  const base = process.env.NIX_API_URL;
  process.env.NIX_API_KEY = 'chave-teste';
  try {
    await servidor((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{');
      if (req.url === '/falha') setTimeout(() => res.destroy(), 20);
    }, async (url) => {
      process.env.NIX_API_URL = url;
      await assert.rejects(nix.requisitar('/lento', { tempoLimite: 100 }), (erro) =>
        erro instanceof nix.ErroNix && erro.status === 0 && /demorou demais/.test(erro.message));
      await assert.rejects(nix.requisitar('/falha', { tempoLimite: 500 }), (erro) =>
        erro instanceof nix.ErroNix && erro.status === 0 && /Não consegui falar/.test(erro.message));
    });
  } finally {
    if (chave === undefined) delete process.env.NIX_API_KEY; else process.env.NIX_API_KEY = chave;
    if (base === undefined) delete process.env.NIX_API_URL; else process.env.NIX_API_URL = base;
  }
});

function bancoPartidas(linhas) {
  const chamadas = [];
  const builder = {};
  for (const nome of ['select', 'eq', 'in', 'order']) builder[nome] = () => builder;
  builder.range = async () => ({ data: linhas, error: null });
  const client = {
    from: () => builder,
    async rpc(nome, args) {
      chamadas.push([nome, args]);
      return { data: { partida: { id: args.p_id, status: 'cancelada', motivo_fim: args.p_motivo }, jogadores: [] }, error: null };
    },
  };
  return { db: { client }, chamadas };
}

test('falha de acesso ao Discord nunca cancela partidas ativas', async () => {
  for (const falha of [
    Object.assign(new Error('Missing Access'), { code: 50001 }),
    Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }),
    null,
  ]) {
    const { db, chamadas } = bancoPartidas([{ id: 'p', canal_id: 'canal', guild_id: 'g', status: 'pago' }]);
    const client = { channels: { cache: new Map(), fetch: async () => { if (falha) throw falha; return null; } } };
    await assert.rejects(partidas.ativasReais(db, 'g', client), /Não foi possível verificar/);
    assert.equal(chamadas.length, 0);
  }
  const { db, chamadas } = bancoPartidas([{ id: 'p', canal_id: 'canal', guild_id: 'g', status: 'pago' }]);
  await assert.rejects(partidas.ativasReais(db, 'g', null), /cliente Discord indisponível/);
  assert.equal(chamadas.length, 0);
});

test('canal realmente desconhecido ainda permite limpeza; canal válido é preservado', async () => {
  const { db, chamadas } = bancoPartidas([
    { id: 'apagada', canal_id: 'ausente', guild_id: 'g', status: 'pago' },
    { id: 'ativa', canal_id: 'existente', guild_id: 'g', status: 'pago' },
  ]);
  const client = { channels: {
    cache: new Map([['existente', { guildId: 'g', isTextBased: () => true }]]),
    fetch: async () => { throw Object.assign(new Error('Unknown Channel'), { code: 10003 }); },
  } };
  const reais = await partidas.ativasReais(db, 'g', client);
  assert.deepEqual(reais.map((p) => p.id), ['ativa']);
  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0][1].p_id, 'apagada');
});

test('duas varreduras sobrepostas não publicam a mesma automação duas vezes', async () => {
  const configOriginal = supabase.obterConfig;
  const sortearOriginal = versiculos.sortear;
  let liberar;
  let avisar;
  const iniciou = new Promise((resolve) => { avisar = resolve; });
  const bloqueio = new Promise((resolve) => { liberar = resolve; });
  const horario = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
  let enviados = 0;
  const canal = { guildId: 'g-automacao', isTextBased: () => true, send: async () => { enviados++; avisar(); await bloqueio; } };
  const client = { guilds: { cache: new Map([['g-automacao', { id: 'g-automacao' }]]) }, channels: { cache: new Map([['c', canal]]) } };
  const db = { client: {} };
  supabase.obterConfig = async (_g, chave) => chave === 'versiculos_auto' ? JSON.stringify({ canal_id: 'c', horario }) : null;
  versiculos.sortear = async () => ({ versiculo: { texto: 'texto', referencia: 'referência' } });
  try {
    const primeira = automacoes.executarPendentes(client, db, true);
    await iniciou;
    const segunda = automacoes.executarPendentes(client, db, true);
    await pausa(30);
    assert.equal(enviados, 1);
    liberar();
    await Promise.all([primeira, segunda]);
  } finally {
    liberar();
    supabase.obterConfig = configOriginal;
    versiculos.sortear = sortearOriginal;
  }
});

test('webhook responde 413 antes do fim de um upload acima do limite e fecha a conexão', async () => {
  const webhook = require('../src/servicos/mercadoPagoWebhook');
  const config = require('../src/config');
  const anterior = config.MP_WEBHOOK_SECRET;
  config.MP_WEBHOOK_SECRET = 'segredo-teste';
  try {
    await servidor((req, res) => { void webhook.tratar(req, res); }, async (url) => {
      let req;
      try {
        const resposta = new Promise((resolve, reject) => {
          req = http.request(`${url}${webhook.ROTA}`, { method: 'POST', headers: { 'transfer-encoding': 'chunked' } }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (parte) => { body += parte; });
            res.on('end', () => resolve({ status: res.statusCode, connection: res.headers.connection, body }));
          });
          req.on('error', reject);
          req.write('x'.repeat(webhook.MAX_BODY + 1));
          // Intencionalmente não chamamos req.end().
        });
        let guard;
        const limite = new Promise((_, reject) => { guard = setTimeout(() => reject(new Error('413 não chegou antes do fim do upload')), 2000); });
        try {
          const resultado = await Promise.race([resposta, limite]);
          assert.equal(resultado.status, 413);
          assert.equal(resultado.connection, 'close');
          assert.deepEqual(JSON.parse(resultado.body), { error: 'payload_too_large' });
        } finally { clearTimeout(guard); }
      } finally { req?.destroy(); }
    });
  } finally { config.MP_WEBHOOK_SECRET = anterior; }
});

test('cliente Supabase configurado usa signal e não repete GET diante de 503', async () => {
  const config = require('../src/config');
  const antigaUrl = config.SUPABASE_URL;
  const antigaChave = config.SUPABASE_SERVICE_ROLE_KEY;
  const fetchOriginal = globalThis.fetch;
  let chamadas = 0;
  let signal;
  try {
    await servidor((req, res) => {
      chamadas++;
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'indisponível' }));
    }, async (url) => {
      config.SUPABASE_URL = url;
      config.SUPABASE_SERVICE_ROLE_KEY = 'test-key';
      globalThis.fetch = (input, init) => { signal = init.signal; return fetchOriginal(input, init); };
      const cliente = supabase.obterCliente();
      const resultado = await cliente.from('teste').select('id');
      assert.equal(resultado.status, 503);
      assert.ok(resultado.error);
      assert.ok(signal instanceof AbortSignal);
      assert.equal(chamadas, 1);
    });
  } finally {
    globalThis.fetch = fetchOriginal;
    config.SUPABASE_URL = antigaUrl;
    config.SUPABASE_SERVICE_ROLE_KEY = antigaChave;
  }
});

test('ID e senha de uma partida nunca são enviados a outra guild ou DM', async () => {
  const salas = require('../src/servicos/salas');
  const buscarOriginal = partidas.buscar;
  const jogadoresOriginal = partidas.jogadores;
  let enviados = 0;
  const canal = { id: 'c', guildId: 'outra-guild', send: async () => { enviados++; } };
  const client = { channels: { cache: new Map([['c', canal]]) } };
  partidas.buscar = async () => ({ id: 'p', guild_id: 'guild-correta', canal_id: 'c', modo: 'x1mobile', preco: 10 });
  partidas.jogadores = async () => [{ user_id: '1', time: 1 }];
  const dados = { room_id: '123', password: 'segredo', session_id: 'sessao' };
  try {
    assert.equal(await salas.publicarSalaLiberada(client, {}, 'p', dados), null);
    canal.guildId = null;
    assert.equal(await salas.publicarSalaLiberada(client, {}, 'p', dados), null);
    assert.equal(enviados, 0);
    canal.guildId = 'guild-correta';
    assert.equal(await salas.publicarSalaLiberada(client, {}, 'p', dados), 'c');
    assert.equal(enviados, 1);
  } finally {
    partidas.buscar = buscarOriginal;
    partidas.jogadores = jogadoresOriginal;
  }
});

test('notificação de partida não duplica painel após erro de busca nem usa canal de outra guild', async () => {
  const fluxo = require('../src/servicos/fluxo');
  const plantao = require('../src/servicos/plantao');
  const plantaoOriginal = plantao.listar;
  const jogadoresOriginal = partidas.jogadores;
  const configs = { canal_partidas_formadas: 'c', canal_bateponto: null, partida_aceite_mensagem_p: 'msg' };
  const db = { client: { from() {
    let chave;
    return {
      select() { return this; },
      eq(nome, valor) { if (nome === 'chave') chave = valor; return this; },
      async maybeSingle() { return { data: configs[chave] == null ? null : { valor: configs[chave] }, error: null }; },
      async upsert(valor) { configs[valor.chave] = valor.valor; return { error: null }; },
    };
  } } };
  let enviados = 0;
  let modo = 'erro-salvo';
  const canal = {
    guildId: 'g',
    messages: { async fetch(id) {
      if (modo === 'erro-salvo') throw Object.assign(new Error('sem permissão'), { code: 50013 });
      if (modo === 'erro-historico' && typeof id === 'object') throw new Error('rede indisponível');
      if (typeof id === 'string') throw Object.assign(new Error('apagada'), { code: 10008 });
      return new Map();
    } },
    async send() { enviados++; return { id: 'nova-msg' }; },
  };
  const client = { channels: { cache: new Map([['c', canal]]) }, guilds: { cache: new Map() } };
  const partida = { id: 'p', guild_id: 'g', modo: 'x1mobile', gelo: 'normal', preco: 10, status: 'aguardando_mediador' };
  plantao.listar = async () => [{ user_id: 'med' }];
  partidas.jogadores = async () => [{ user_id: 'j', time: 1 }];
  try {
    assert.equal(await fluxo.notificarPartidaFormada(client, db, partida), false);
    assert.equal(enviados, 0);
    modo = 'erro-historico';
    assert.equal(await fluxo.notificarPartidaFormada(client, db, partida), false);
    assert.equal(enviados, 0);
    canal.guildId = 'outra';
    modo = 'ok';
    assert.equal(await fluxo.notificarPartidaFormada(client, db, partida), false);
    assert.equal(enviados, 0);
    canal.guildId = 'g';
    assert.equal(await fluxo.notificarPartidaFormada(client, db, partida), true);
    assert.equal(enviados, 1);
    assert.equal(configs.partida_aceite_mensagem_p, 'nova-msg');
  } finally {
    plantao.listar = plantaoOriginal;
    partidas.jogadores = jogadoresOriginal;
  }
});

test('não altera permissões em canal de outra guild', async () => {
  const fluxo = require('../src/servicos/fluxo');
  const original = partidas.buscar;
  let alteracoes = 0;
  const canal = { guildId: 'outra', permissionOverwrites: { edit: async () => { alteracoes++; } } };
  const client = { channels: { cache: new Map([['c', canal]]) } };
  partidas.buscar = async () => ({ id: 'p', guild_id: 'g', canal_id: 'c' });
  try {
    assert.equal(await fluxo.concederAcessoPartida(client, {}, 'p', 'u'), false);
    assert.equal(alteracoes, 0);
  } finally { partidas.buscar = original; }
});

test('timeout na reserva comunica resultado incerto e não cria sala nem libera crédito', async () => {
  const criar = require('../src/servicos/criarSalaComCredito');
  const vendas = require('../src/servicos/roomSalesSupabase');
  const originais = {
    configurado: nix.configurado, validar: nix.validarCriacaoSala, criar: nix.criarSala,
    reservar: vendas.reservarSala, liquidar: vendas.liquidarUsoSala,
  };
  let chamadasNix = 0, liquidacoes = 0;
  nix.configurado = () => true;
  nix.validarCriacaoSala = () => {};
  nix.criarSala = async () => { chamadasNix++; };
  vendas.reservarSala = async () => { throw new Error('resposta perdida após commit'); };
  vendas.liquidarUsoSala = async () => { liquidacoes++; };
  try {
    await assert.rejects(criar.criar({ guildId: 'g', userId: 'u', requestId: 'r', source: 'nix_command', sala: {} }),
      (erro) => /crédito pode ter sido reservado/.test(erro.message) && /não tente novamente/.test(erro.message));
    assert.equal(chamadasNix, 0);
    assert.equal(liquidacoes, 0);
  } finally {
    nix.configurado = originais.configurado;
    nix.validarCriacaoSala = originais.validar;
    nix.criarSala = originais.criar;
    vendas.reservarSala = originais.reservar;
    vendas.liquidarUsoSala = originais.liquidar;
  }
});
