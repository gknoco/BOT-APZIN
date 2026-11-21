'use strict';
// Regressões offline: node --test testes/auditoria-comandos-interacoes.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PermissionFlagsBits } = require('discord.js');
const registro = require('../src/comandos');
const utilidades = require('../src/comandos/utilidades');
const painelFilas = require('../src/comandos/painelFilas');
const selects = require('../src/interacoes/selects');
const vendasDb = require('../src/servicos/roomSalesSupabase');
const mediadores = require('../src/servicos/mediadores');
const persistencia = require('../src/servicos/supabase');
const telagem = require('../src/servicos/telagem');
const filas = require('../src/servicos/filas');
const paineis = require('../src/servicos/paineis');
const criarSalaComCredito = require('../src/servicos/criarSalaComCredito');
const addsalas = require('../src/comandos/addsalas');
const auditoria = require('../src/servicos/auditoria');

test('comandos oficiais e variações de configuração SS estão registrados', () => {
  const nomes = new Set(registro.definicoes().map((comando) => comando.name));
  assert.ok(nomes.has('configcanalfilasssmobile'));
  assert.ok(nomes.has('configcanalfilassmobile'));
  assert.ok(nomes.has('configcanalfilasssemu'));
  assert.ok(nomes.has('ssmob'));
  assert.ok(nomes.has('ssemu'));
});

async function substituir(alteracoes, fn) {
  const anteriores = alteracoes.map(([obj, chave, valor]) => {
    const anterior = obj[chave]; obj[chave] = valor; return [obj, chave, anterior];
  });
  try { return await fn(); } finally { for (const [obj, chave, anterior] of anteriores) obj[chave] = anterior; }
}
function interacao(nome, opcoes = {}) {
  const i = {
    commandName: nome, guildId: 'guild-a', channelId: 'canal-a', id: 'interaction-a',
    user: { id: 'user-a', username: 'user' }, deferred: false, replied: false,
    member: { permissions: { has: (p) => p === PermissionFlagsBits.Administrator }, roles: { cache: new Map() } },
    responses: [], options: {},
    async deferReply(payload) {
      if (this.deferred || this.replied) throw new Error('InteractionAlreadyReplied');
      this.deferred = true; this.responses.push(['deferReply', payload]);
    },
    async reply(payload) { this.replied = true; this.responses.push(['reply', payload]); },
    async editReply(payload) { this.responses.push(['editReply', payload]); return payload; },
    async followUp(payload) { this.responses.push(['followUp', payload]); return payload; },
    ...opcoes,
  };
  return i;
}
function descricao(i) { return i.responses.at(-1)[1].embeds[0].toJSON().description; }

test('/ssmob e /ssemu com cargo mediador publicam botão Aceitar nos canais SS configurados', async () => {
  const publicados = [];
  const canalBase = {
    guildId: 'guild-a', isTextBased: () => true,
    async send(payload) { publicados.push({ id: this.id, payload }); return { id: `msg-${publicados.length}` }; },
  };
  const makeInteraction = (name, id) => interacao(name, {
    id, guild: { channels: { fetch: async (channelId) => ({ ...canalBase, id: channelId }) } },
  });
  const iMobile = makeInteraction('ssmob', '111111111111111111');
  const iEmu = makeInteraction('ssemu', '222222222222222222');
  iMobile.member.roles.cache.set('1543684028719173732', {});
  iEmu.member.roles.cache.set('1543684028719173732', {});
  await substituir([[persistencia, 'obterConfig', async (_guildId, key) => key === 'canal_filas_ss_mobile' ? 'mobile-channel' : 'emu-channel']], async () => {
    await registro.executar(iMobile, { db: { client: {} } });
    await registro.executar(iEmu, { db: { client: {} } });
  });
  assert.deepEqual(publicados.map((item) => item.id), ['mobile-channel', 'emu-channel']);
  assert.match(publicados[0].payload.embeds[0].toJSON().title, /Mobile/);
  assert.match(publicados[1].payload.embeds[0].toJSON().title, /EMU/);
  for (const { payload } of publicados) {
    const button = payload.components[0].components[0].toJSON();
    assert.equal(button.label, 'Aceitar pedido');
    assert.match(button.custom_id, /^ap:sspedido:/);
  }
  assert.match(iMobile.responses.at(-1)[1].content, /mobile-channel/);
  assert.match(iEmu.responses.at(-1)[1].content, /emu-channel/);
});

test('/ssmob responde claramente quando o canal está ausente, inválido ou sem permissão', async () => {
  const cenarios = [
    { valor: null, fetch: async () => null, esperado: /não configurado/i },
    { valor: '123456789012345678', fetch: async () => null, esperado: /não existe, não é de texto/i },
    { valor: '123456789012345678', fetch: async (id) => ({ id, guildId: 'guild-a', isTextBased: () => true, send: async () => { throw new Error('Missing Permissions'); } }), esperado: /Ver canal, Enviar mensagens/i },
  ];
  for (const cenario of cenarios) {
    const i = interacao('ssmob', { guild: { channels: { fetch: cenario.fetch } } });
    i.member.roles.cache.set('1543684028719173732', {});
    await substituir([[persistencia, 'obterConfig', async () => cenario.valor]], async () => {
      await registro.executar(i, { db: { client: {} } });
    });
    assert.match(descricao(i), cenario.esperado);
  }
});

test('/resgatarsalas passa pelo dispatcher com um único defer e concede apenas após confirmação', async () => {
  const i = interacao('resgatarsalas');
  i.member.roles.cache.set('1543684028719173732', {});
  let chamadas = 0;
  await substituir([[vendasDb, 'resgatarSalasIniciais', async () => { chamadas++; return { redeemed: true, available_rooms: 10 }; }]], async () => {
    await registro.executar(i, { db: {} });
  });
  assert.equal(chamadas, 1);
  assert.deepEqual(i.responses.map(([nome]) => nome), ['deferReply', 'editReply']);
  assert.match(descricao(i), /resgatou.*10 salas/);
});

test('seleção de administradores busca membros após ACK privado e não inclui bots', async () => {
  const elegivel = (id, bot) => ({ id, user: { username: id, bot }, roles: { cache: new Map([[addsalas.CARGO_ADM, {}]]) } });
  const i = interacao(null, { isMessageComponent: () => true, guild: { members: {
    cache: new Map(),
    fetch: async () => { assert.equal(i.deferred, true); return new Map([['bot', elegivel('bot', true)], ['humano', elegivel('humano', false)]]); },
  } } });
  await addsalas.selectAdm(i);
  assert.deepEqual(i.responses.map(([nome]) => nome), ['deferReply', 'editReply']);
  assert.equal(i.responses[0][1].flags & 64, 64);
  const opcoes = i.responses[1][1].components[0].toJSON().components[0].options;
  assert.deepEqual(opcoes.map((opcao) => opcao.value), ['humano']);
});

test('/configpainelajuda responde erro útil quando categoria ou cargo não são informados', async () => {
  for (const categoria of [null, 'moderacao']) {
    const i = interacao('configpainelajuda', { options: {
      getString: (campo) => campo === 'acao' ? 'configurar' : categoria,
      getRole: () => null,
    } });
    await registro.executar(i, { db: {} });
    assert.match(descricao(i), categoria ? /Informe o cargo/ : /categoria avançada válida/);
  }
});

test('ajuda não realoca comandos de categorias protegidas para Outros comandos', () => {
  const definitions = [
    { name: 'blacklist', description: 'Moderação' },
    { name: 'ajuda', description: 'Ajuda' },
    { name: 'inovacao', description: 'Novo comando' },
  ];
  const texto = utilidades.ajudaEmbeds(definitions, new Set(['inicio']))
    .map((item) => item.toJSON().description).join('\n');
  assert.doesNotMatch(texto, /\/blacklist/);
  assert.match(texto, /\/ajuda/);
  assert.match(texto, /\/inovacao/);
});

function clienteConsultaUso(registro, erro = null) {
  const filtros = [];
  return {
    filtros,
    from(tabela) {
      assert.equal(tabela, 'royal_room_usages');
      const q = {
        select: () => q,
        eq: (campo, valor) => { filtros.push([campo, valor]); return q; },
        limit: () => q,
        maybeSingle: async () => ({ data: registro && filtros.some(([k, v]) => k === 'guild_id' && v === registro.guild_id) ? registro : null, error: erro }),
      };
      return q;
    },
  };
}
test('publicação de filas não escreve em canais fixos de outra guild', async () => {
  let envios = 0;
  const canalAlheio = { guildId: 'guild-b', send: async () => { envios++; } };
  const client = { channels: { cache: new Map(), fetch: async () => canalAlheio } };
  let dados;
  await substituir([
    [persistencia, 'obterConfig', async () => '[]'],
    [persistencia, 'definirConfig', async (_g, _k, valor) => { dados = valor; }],
    [filas, 'listar', async () => []],
    [paineis, 'publicarFila', async (_db, canal) => { await canal.send(); return [{ mensagemId: '1' }]; }],
  ], async () => {
    const result = await painelFilas.enviarTodasAsFilas({ db: { client: {} }, client, guildId: 'guild-a' });
    assert.equal(result.enviadas.length, 0);
    assert.ok(result.falhas.length > 0);
  });
  assert.equal(envios, 0);
  assert.equal(dados, '[]');
});

test('nova publicação com falhas mantém referências do lote anterior', async () => {
  const anterior = { channelId: 'antigo', messageId: 'mensagem-antiga' };
  let salvo;
  await substituir([
    [persistencia, 'obterConfig', async () => JSON.stringify([anterior])],
    [persistencia, 'definirConfig', async (_g, _k, valor) => { salvo = JSON.parse(valor); }],
  ], async () => {
    const client = { channels: { cache: new Map(), fetch: async () => { throw new Error('indisponível'); } } };
    await painelFilas.enviarTodasAsFilas({ db: { client: {} }, client, guildId: 'guild-a' });
  });
  assert.deepEqual(salvo, [anterior]);
});

test('remoção de filas conta somente exclusões confirmadas e preserva falhas para nova tentativa', async () => {
  const linhas = ['ok', 'negada', 'ausente', 'outraguild'].map((messageId) => ({ channelId: messageId, messageId }));
  let registroSalvo;
  const canais = new Map(linhas.map(({ channelId }) => [channelId, {
    guildId: channelId === 'outraguild' ? 'guild-b' : 'guild-a',
    messages: { fetch: async () => {
      if (channelId === 'ausente') throw Object.assign(new Error('Unknown Message'), { code: 10008 });
      return { delete: async () => { if (channelId === 'negada') throw Object.assign(new Error('Missing Permissions'), { code: 50013 }); } };
    } },
  }]));
  await substituir([
    [persistencia, 'obterConfig', async () => JSON.stringify(linhas)],
    [persistencia, 'definirConfig', async (_g, _k, valor) => { registroSalvo = JSON.parse(valor); }],
    [persistencia, 'removerConfig', async () => { registroSalvo = []; }],
  ], async () => {
    const resultado = await painelFilas.apagarTodasAsFilas({ db: { client: {} }, client: { channels: { cache: canais } }, guildId: 'guild-a' });
    assert.equal(resultado.apagadas, 1);
    assert.equal(resultado.encontradas, 4);
  });
  assert.deepEqual(registroSalvo.map((x) => x.messageId).sort(), ['negada', 'outraguild']);
});

test('menu de canal de bate-ponto impede usar o canal reservado para partidas', async () => {
  let salvou = false;
  const i = interacao(null, {
    customId: 'ap:medfila', values: ['canal-partidas'], isMessageComponent: () => true,
    deferUpdate: async function () { this.deferred = true; },
  });
  const db = { client: { from: () => {
    const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { valor: 'canal-partidas' }, error: null }) };
    return q;
  } } };
  await substituir([[mediadores, 'definirCanalBatePonto', async () => { salvou = true; }]], async () => {
    await selects.handleSelect(i, { db, client: {} });
  });
  assert.equal(salvou, false);
  assert.match(descricao(i), /canal de partidas formadas/i);
});

test('/nix não anuncia sucesso de divulgação se o envio falhou após criar a sala', async () => {
  let criacoes = 0;
  const i = interacao('nix', {
    channel: {
      id: 'canal-a', type: 0, isTextBased: () => true,
      permissionOverwrites: { cache: new Map([['guild-a', { deny: { has: () => true } }]]) },
      send: async () => { throw new Error('Missing Permissions'); },
    },
    options: {
      getSubcommand: () => 'criarsala', getString: (campo) => ({ senha: '1234', avisar: 'canal' })[campo] || null,
      getInteger: () => null, getBoolean: () => null,
    },
  });
  i.member.roles.cache.set('1543684028719173732', {});
  await substituir([
    [mediadores, 'podeUsarSalas', async () => true],
    [criarSalaComCredito, 'criar', async () => { criacoes++; return { creditoLiquidado: true, dados: { room_id: '123', password: '1234', session_id: 'abc' } }; }],
  ], async () => { await registro.executar(i, { db: {} }); });
  const card = i.responses.at(-1)[1].embeds[0].toJSON();
  assert.equal(criacoes, 1);
  assert.equal(card.title, '🎮 Sala Nix criada');
  assert.match(card.fields.find((campo) => campo.name === 'Aviso').value, /não consegui confirmar.*divulgação/i);
});

test('/anunciar reserva espaço no embed para o prefixo do título', async () => {
  const comando = registro.buscar('anunciar');
  const max = comando.data.toJSON().options.find((opcao) => opcao.name === 'titulo').max_length;
  assert.equal(max, 253);
  let anunciado;
  const i = interacao('anunciar', {
    options: { getString: (campo) => campo === 'titulo' ? 'a'.repeat(max) : 'mensagem', getChannel: () => null },
    channel: { id: 'canal', guildId: 'guild-a', type: 0, name: 'canal', send: async (payload) => { anunciado = payload; return { id: 'msg' }; } },
  });
  await substituir([[auditoria, 'registrar', async () => {}]], async () => { await registro.executar(i, { db: {}, client: {} }); });
  assert.equal(anunciado.embeds[0].toJSON().title.length, 256);
});

test('/telagem_links listar respeita limite dos campos Discord com muitos links', async () => {
  const links = Array.from({ length: 50 }, (_, n) => `https://meet.google.com/abc-defg-${String(n).padStart(3, '0')}`);
  const i = interacao('telagem_links', { options: { getSubcommand: () => 'listar' } });
  await substituir([
    [telagem, 'linksDoAmbiente', () => []], [telagem, 'pool', async () => links],
    [telagem, 'atribuicoes', async () => links.slice(0, 15).map((url, n) => ({ chave: `partida:${n}`, url }))],
  ], async () => { await registro.executar(i, { db: {} }); });
  const card = i.responses.at(-1)[1].embeds[0].toJSON();
  assert.equal(card.title, '🔗 Links da telagem · Google Meet');
  for (const campo of card.fields) assert.ok(campo.value.length <= 1024, campo.name);
  assert.match(card.fields[0].value, /mais|omitid/i);
});
