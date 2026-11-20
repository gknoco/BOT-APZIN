'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MessageFlags, PermissionFlagsBits } = require('discord.js');
process.env.DISCORD_TOKEN ||= 'test.token.value';
const partidas = require('../src/servicos/partidas');
const salas = require('../src/servicos/salas');
const criarSalaComCredito = require('../src/servicos/criarSalaComCredito');
const fluxo = require('../src/servicos/fluxo');
const auditoria = require('../src/servicos/auditoria');
const nix = require('../src/servicos/nix');
const staffSupabase = require('../src/servicos/staffSupabase');
const botoes = require('../src/interacoes/botoes');
const modais = require('../src/interacoes/modais');

const base = () => ({ id: 'm', guild_id: 'g', canal_id: 'c', mensagem_id: 'msg', status: 'sala_liberada', sala_versao: 0, modo: 'solo', preco: 100, gelo: 'normal', sala_id: '123', sala_senha: '456', mediador_id: 'med' });
function click({ user = 'a', guild = 'g', canal = 'c', mensagem = 'msg', id = 'm' } = {}) {
  const respostas = [], anuncios = [];
  const interaction = {
    customId: `ap:pronto:${id}:0`, guildId: guild, channelId: canal, message: { id: mensagem }, user: { id: user },
    channel: { send: async (payload) => anuncios.push(payload) }, deferred: false, replied: false,
    async deferUpdate() { this.deferred = true; }, isMessageComponent: () => true,
    async followUp(p) { respostas.push(p); }, async reply(p) { respostas.push(p); },
  };
  return { interaction, respostas, anuncios };
}
const texto = (respostas) => respostas.map((p) => `${p.content || ''} ${(p.embeds || []).map((e) => e.toJSON().description || '').join(' ')}`).join(' ');
async function comMocks(mocks, fn) {
  const anteriores = mocks.map(([obj, nome, funcao]) => { const old = obj[nome]; obj[nome] = funcao; return [obj, nome, old]; });
  try { await fn(); } finally { anteriores.reverse().forEach(([obj, nome, old]) => { obj[nome] = old; }); }
}

test('cartões explicitam prontidão e início externo e preservam vencedor e W.O.', () => {
  for (const status of ['pago', 'sala_liberada', 'em_andamento', 'finalizada', 'cancelada']) {
    const p = { ...base(), status };
    const ids = fluxo.componentesPartida(p).flatMap((r) => r.toJSON().components.map((c) => c.custom_id));
    assert.equal(ids.includes('ap:pronto:m:0'), status === 'sala_liberada');
    assert.equal(ids.includes('ap:liberar:m:0'), ['pago', 'sala_liberada'].includes(status));
    if (['sala_liberada', 'em_andamento'].includes(status)) {
      for (const id of ['ap:vencer:m:1', 'ap:vencer:m:2', 'ap:wo:m:1', 'ap:wo:m:2', 'ap:cancelar:m']) assert.ok(ids.includes(id));
      const descricao = fluxo.embedPartida(p, []).toJSON().description;
      assert.match(descricao, /extern/i);
      assert.doesNotMatch(descricao, /\/go\b|inicia em 3 segundos|partida iniciada/i);
    }
  }
});

test('guild, canal, cartão, estado e identidade bloqueiam cliques indevidos sem executar a RPC', async () => {
  let p = base(), chamadas = 0;
  await comMocks([
    [partidas, 'buscar', async (_db, id, g) => id === p.id && g === p.guild_id ? p : null],
    [partidas, 'darGo', async () => { chamadas++; throw new Error('não deveria chamar'); }],
  ], async () => {
    for (const params of [{ guild: null }, { guild: 'outra' }, { canal: 'errado' }, { mensagem: 'outra' }, { id: 'outra' }, { user: null }]) {
      const c = click(params); await botoes.handleBotao(c.interaction, { db: {}, client: {} });
      assert.ok(texto(c.respostas));
      assert.ok(c.respostas.every((r) => (r.flags & MessageFlags.Ephemeral) !== 0));
    }
    for (const status of ['confirmando', 'aguardando_mediador', 'aguardando_pagamento', 'pago', 'finalizada', 'cancelada']) {
      p = { ...base(), status }; const c = click();
      await botoes.handleBotao(c.interaction, { db: {}, client: {} });
      assert.match(texto(c.respostas), /prontidão/i);
    }
    assert.equal(chamadas, 0);
  });
});

test('RPC rejeita usuário estranho e oculta erro obsoleto de corrida de estado', async () => {
  let msg = 'Você não está nessa partida.'; let atualizacoes = 0;
  await comMocks([
    [partidas, 'buscar', async () => base()],
    [partidas, 'darGo', async () => { throw new Error(msg); }],
    [fluxo, 'atualizarPartida', async () => { atualizacoes++; }],
  ], async () => {
    const estranho = click({ user: 'intruso' }); await botoes.handleBotao(estranho.interaction, { db: {}, client: {} });
    assert.match(texto(estranho.respostas), /não está nessa partida/);
    msg = 'A sala ainda não foi liberada. O `/go` só vale depois.';
    const corrida = click(); await botoes.handleBotao(corrida.interaction, { db: {}, client: {} });
    assert.doesNotMatch(texto(corrida.respostas), /\/go\b/i);
    assert.equal(atualizacoes, 0);
  });
});

test('cliques simultâneos e repetidos usam RPC idempotente, com um único anúncio final e auditoria', async () => {
  let p = base(), lock = Promise.resolve(); const confirmados = new Set(); const audits = [], argsRpc = [];
  let atualizacoes = 0, chamadasNix = 0;
  const confirmar = ({ partidaId, userId }) => {
    const op = lock.then(async () => {
      await new Promise((r) => setTimeout(r, 2));
      assert.equal(partidaId, 'm');
      if (!['a', 'b'].includes(userId)) throw new Error('Você não está nessa partida.');
      const jaDeu = confirmados.has(userId); confirmados.add(userId);
      const iniciou = confirmados.size === 2 && p.status === 'sala_liberada';
      if (iniciou) p = { ...p, status: 'em_andamento' };
      argsRpc.push(userId);
      return { jaDeu, deram: confirmados.size, total: 2, iniciou, partida: { ...p } };
    });
    lock = op.catch(() => {}); return op;
  };
  await comMocks([
    [partidas, 'buscar', async () => ({ ...p })],
    [partidas, 'darGo', async (_db, args) => confirmar(args)],
    [fluxo, 'atualizarPartida', async () => { atualizacoes++; return true; }],
    [auditoria, 'registrar', async (_db, _client, a) => audits.push(a)],
    [nix, 'iniciarSala', async () => { chamadasNix++; }],
    [nix, 'criarSala', async () => { chamadasNix++; }],
  ], async () => {
    const cliques = ['a', 'a', 'b', 'b', 'a'].map((user) => click({ user }));
    await Promise.all(cliques.map((c) => botoes.handleBotao(c.interaction, { db: {}, client: {} })));
    assert.equal(confirmados.size, 2); assert.equal(p.status, 'em_andamento'); assert.equal(argsRpc.length, 5);
    assert.equal(atualizacoes, 5); assert.equal(audits.length, 1); assert.equal(audits[0].acao, 'Prontidão completa');
    const anuncios = cliques.flatMap((c) => c.anuncios);
    assert.equal(anuncios.length, 2); assert.equal(anuncios.filter((a) => /Todos sinalizaram/.test(a.content)).length, 1);
    assert.equal(cliques.filter((c) => /já estava registrada/.test(texto(c.respostas))).length, 3);
    assert.ok(cliques.every((c) => /início da sala é externo/i.test(texto(c.respostas))));
    assert.ok(anuncios.every((a) => !/partida iniciada|iniciar em 3 segundos|\/go\b/i.test(a.content)));
    assert.equal(chamadasNix, 0);
  });
});

test('falha ao anunciar ou atualizar cartão não desfaz ou duplica confirmação persistida', async () => {
  let calls = 0, audits = 0;
  await comMocks([
    [partidas, 'buscar', async () => base()],
    [partidas, 'darGo', async () => ({ jaDeu: calls++ > 0, deram: 2, total: 2, iniciou: calls === 1 })],
    [fluxo, 'atualizarPartida', async () => { throw new Error('Discord offline'); }],
    [auditoria, 'registrar', async () => { audits++; }],
  ], async () => {
    const primeiro = click(); primeiro.interaction.channel.send = async () => { throw new Error('offline'); };
    const repetido = click();
    await botoes.handleBotao(primeiro.interaction, { db: {}, client: {} });
    await botoes.handleBotao(repetido.interaction, { db: {}, client: {} });
    assert.match(texto(primeiro.respostas), /Prontidão registrada/);
    assert.match(texto(repetido.respostas), /já estava registrada/);
    assert.equal(audits, 1);
  });
});

test('atualizações concorrentes do cartão leem a versão nova depois da edição anterior', async () => {
  let estado = 'sala_liberada', leitura = 0, liberarPrimeira;
  const gate = new Promise((r) => { liberarPrimeira = r; });
  const editadas = [];
  const message = { async edit(payload) { if (!editadas.length) await gate; editadas.push(payload.embeds[0].toJSON().description); } };
  const canal = { messages: { fetch: async () => message } };
  const client = { channels: { cache: new Map([['c', canal]]) } };
  await comMocks([
    [partidas, 'buscar', async () => { leitura++; return { ...base(), status: estado }; }],
    [partidas, 'jogadores', async () => []],
  ], async () => {
    const primeira = fluxo.atualizarPartida(client, {}, 'm');
    while (!leitura) await new Promise((r) => setImmediate(r));
    estado = 'em_andamento';
    const segunda = fluxo.atualizarPartida(client, {}, 'm');
    await new Promise((r) => setImmediate(r)); assert.equal(leitura, 1);
    liberarPrimeira(); await Promise.all([primeira, segunda]);
    assert.match(editadas.at(-1), /estado interno está em andamento/);
  });
});

test('restauração atualiza apenas cartões das etapas que precisaram mudar', async () => {
  const statuses = ['pago', 'sala_liberada', 'em_andamento', 'confirmando', 'aguardando_mediador'];
  const editadas = [];
  const canal = { messages: { fetch: async () => ({ edit: async (p) => editadas.push(p) }) } };
  await comMocks([
    [partidas, 'ativas', async () => statuses.map((status) => ({ ...base(), id: status, status }))],
    [partidas, 'buscar', async (_db, id) => ({ ...base(), id, status: id })],
    [partidas, 'jogadores', async () => []],
  ], async () => {
    assert.equal(await fluxo.restaurarCartoesPartida({ channels: { cache: new Map([['c', canal]]) } }, {}, 'g'), 3);
    assert.equal(editadas.length, 3);
  });
});

function modalInteraction({ guild = 'g', canal = 'c', user = 'med', status = 'pago' } = {}) {
  const respostas = [];
  const i = { customId: 'ap:modalsala:m:msg:0', guildId: guild, channelId: canal, user: { id: user },
    member: { permissions: { has: (permission) => permission === PermissionFlagsBits.Administrator }, roles: { cache: new Map() } },
    fields: { getTextInputValue: (k) => k === 'sala_id' ? ' 1234 ' : ' 4321 ' },
    deferred: false, replied: false, isMessageComponent: () => false,
    async deferReply() { this.deferred = true; }, async editReply(p) { respostas.push(p); }, async reply(p) { respostas.push(p); },
  };
  return { i, respostas, status };
}

test('registro manual exige responsável, guild, canal, cartão atual e status pago', async () => {
  let p = { ...base(), status: 'pago' }, gravacoes = [];
  await comMocks([
    [partidas, 'buscar', async (_db, id, guild) => id === p.id && guild === p.guild_id ? p : null],
    [staffSupabase, 'temCargoMediador', async () => true],
    [partidas, 'publicarSalaManual', async (_db, args) => { gravacoes.push(args); p = { ...p, sala_versao: 1, status: 'sala_liberada', sala_id: args.salaId.trim(), sala_senha: args.senha.trim() }; return { ...p }; }],
    [fluxo, 'atualizarPartida', async () => true],
  ], async () => {
    const abrir = modalInteraction().i; abrir.message = { id: 'msg' }; let exibido = null; abrir.showModal = async (m) => { exibido = m.toJSON(); };
    await modais.abrirModalSala(abrir, {}, 'm', 0); assert.equal(exibido.custom_id, 'ap:modalsala:m:msg:0');
    const errado = modalInteraction().i; errado.message = { id: 'outro' }; errado.reply = async () => {}; errado.showModal = async () => { throw new Error('não devia abrir'); };
    await modais.abrirModalSala(errado, {}, 'm', 0);
    for (const attrs of [{ guild: 'outro' }, { canal: 'outro' }, { user: 'outro' }]) {
      const c = modalInteraction(attrs); await modais.handleModal(c.i, { db: {}, client: {} });
      assert.equal(gravacoes.length, 0); assert.ok(texto(c.respostas));
    }
    p = { ...p, status: 'finalizada' };
    const ja = modalInteraction(); await modais.handleModal(ja.i, { db: {}, client: {} }); assert.equal(gravacoes.length, 0);
    p = { ...p, status: 'pago' };
    const valido = modalInteraction(); await modais.handleModal(valido.i, { db: {}, client: {} });
    assert.equal(gravacoes.length, 1);
    assert.deepEqual(gravacoes[0], { partidaId: 'm', guildId: 'g', canalId: 'c', mensagemId: 'msg', mediadorId: 'med', salaVersao: 0, salaId: ' 1234 ', senha: ' 4321 ' });
    assert.match(texto(valido.respostas), /início da sala é externo/);
  });
});

test('registro manual usa apenas a nova RPC com parâmetros limpos', async () => {
  const calls = [];
  const db = { client: { rpc: async (nome, args) => { calls.push([nome, args]); return { data: { status: 'sala_liberada' }, error: null }; } } };
  await partidas.publicarSalaManual(db, { partidaId: 'm', guildId: 'g', canalId: 'c', mensagemId: 'msg', mediadorId: 'med', salaVersao: 2, salaId: ' 123 ', senha: ' 456 ' });
  assert.deepEqual(calls, [['royal_operacional_publicar_sala_manual', { p_id: 'm', p_guild_id: 'g', p_canal_id: 'c', p_mensagem_id: 'msg', p_mediador_id: 'med', p_sala_versao: 2, p_sala_id: '123', p_senha: '456' }]]);
  await assert.rejects(partidas.publicarSalaManual(db, { salaId: '  ' }), /Informe o ID/);
});

test('liberarSala mantém o contrato legado Nix e propaga rejeição de prontidão', async () => {
  const calls = [];
  let erro = null;
  const db = { client: { rpc: async (nome, args) => {
    calls.push([nome, args]); return { data: erro ? null : { sala_versao: 1 }, error: erro };
  } } };
  assert.deepEqual(await partidas.liberarSala(db, 'm', { salaId: ' 123 ', senha: ' 456 ', sessao: ' sessao ' }), { sala_versao: 1 });
  assert.deepEqual(calls[0], ['royal_operacional_alterar_partida', {
    p_id: 'm', p_acao: 'sala', p_dados: { sala_id: '123', sala_senha: '456', nix_sessao: 'sessao' },
  }]);
  await partidas.liberarSala(db, 'm', { salaId: '123', senha: null });
  assert.deepEqual(calls[1][1].p_dados, { sala_id: '123', sala_senha: null, nix_sessao: null });
  await assert.rejects(partidas.liberarSala(db, 'm', { salaId: '   ' }), /Informe o ID/);
  erro = { message: 'Já existe prontidão registrada. Cancele e refaça a partida.', code: 'P0001' };
  await assert.rejects(partidas.liberarSala(db, 'm', { salaId: '999', senha: '456' }), /prontidão.*[Cc]ancele/);
});

test('criação Nix existente libera e anuncia sala pelo contrato legado', async () => {
  let p = { ...base(), status: 'pago', sala_id: null, sala_senha: null, nix_sessao: null };
  const criacoes = [], chamadas = [], enviadas = [];
  const dados = { room_id: '1234', password: '4321', session_id: 'nix-session', start_delay_minutes: 10 };
  const db = { client: { rpc: async (nome, args) => {
    chamadas.push([nome, args]);
    p = { ...p, ...args.p_dados, status: 'sala_liberada', sala_versao: 1 };
    return { data: { ...p }, error: null };
  } } };
  const channel = { id: 'c', send: async (payload) => { enviadas.push(payload); } };
  const client = { channels: { cache: new Map([['c', channel]]) } };
  await comMocks([
    [partidas, 'buscar', async () => ({ ...p })],
    [partidas, 'jogadores', async () => [{ user_id: 'a', time: 1 }, { user_id: 'b', time: 2 }]],
    [criarSalaComCredito, 'criar', async (args) => { criacoes.push(args); return { dados, creditoLiquidado: true }; }],
  ], async () => {
    const resultado = await salas.criarSalaDaPartida(client, db, { partidaId: 'm', actorId: 'med', requestId: 'req' });
    assert.equal(criacoes.length, 1);
    assert.deepEqual([criacoes[0].guildId, criacoes[0].userId, criacoes[0].requestId, criacoes[0].source, criacoes[0].sourceRef], ['g', 'med', 'req', 'match', 'm']);
    assert.match(criacoes[0].sala.senha, /^\d{4}$/);
    assert.deepEqual(chamadas, [['royal_operacional_alterar_partida', {
      p_id: 'm', p_acao: 'sala', p_dados: { sala_id: '1234', sala_senha: '4321', nix_sessao: 'nix-session' },
    }]]);
    assert.equal(resultado.canalId, 'c'); assert.equal(resultado.partida.sala_versao, 1);
    assert.equal(resultado.creditoLiquidado, true); assert.equal(enviadas.length, 1);
    assert.match(enviadas[0].embeds[0].toJSON().description, /1234/);
    await assert.rejects(salas.criarSalaDaPartida(client, db, { partidaId: 'm', actorId: 'med', requestId: 'req' }), /já possui uma sala/);
    assert.equal(criacoes.length, 1);
  });
});


test('timeout após commit e falha ou timeout da edição permitem repetição idêntica sem nova sala', async () => {
  let p = { ...base(), status: 'pago' }, commits = 0, rpcCalls = 0, edits = 0, nixCalls = 0;
  await comMocks([
    [staffSupabase, 'temCargoMediador', async () => true],
    [partidas, 'buscar', async () => ({ ...p })],
    [partidas, 'publicarSalaManual', async (_db, args) => {
      rpcCalls++;
      if (p.status === 'pago') {
        commits++; p = { ...p, status: 'sala_liberada', sala_versao: 1, sala_id: args.salaId.trim(), sala_senha: args.senha.trim() };
        throw new Error('timeout depois do commit');
      }
      assert.equal(args.salaId.trim(), p.sala_id); assert.equal(args.senha.trim(), p.sala_senha);
      return p;
    }],
    [fluxo, 'atualizarPartida', async (_client, _db, _id, options) => {
      assert.equal(options.somenteEditar, true);
      edits++; if (edits === 1) return false; if (edits === 2) throw new Error('timeout da edição'); return true;
    }],
    [nix, 'criarSala', async () => { nixCalls++; }], [nix, 'iniciarSala', async () => { nixCalls++; }],
  ], async () => {
    const primeiro = modalInteraction(); await modais.handleModal(primeiro.i, { db: {}, client: {} });
    assert.match(texto(primeiro.respostas), /podem já ter sido registrados/i);
    for (let i = 0; i < 3; i++) {
      const tentativa = modalInteraction(); tentativa.i.customId = 'ap:modalsala:m:msg:1';
      await modais.handleModal(tentativa.i, { db: {}, client: {} });
      if (i < 2) { assert.match(texto(tentativa.respostas), /não foi possível confirmar.*edição/i); assert.doesNotMatch(texto(tentativa.respostas), /salvos e cartão atualizado/i); }
      else { assert.match(texto(tentativa.respostas), /Discord aceitou a edição/i); assert.match(texto(tentativa.respostas), /Confira o cartão atual/i); }
    }
    assert.equal(commits, 1); assert.equal(rpcCalls, 4); assert.equal(nixCalls, 0);
  });
});

test('recuperação nunca envia nova mensagem após falha de busca ou edição do Discord', async () => {
  let sends = 0;
  const message = { edit: async () => { throw new Error('timeout depois de editar'); } };
  let falhaBusca = true;
  const canal = { send: async () => { sends++; }, messages: { fetch: async () => { if (falhaBusca) throw new Error('timeout'); return message; } } };
  const client = { channels: { cache: new Map([['c', canal]]) } };
  await comMocks([[partidas, 'buscar', async () => base()], [partidas, 'jogadores', async () => []]], async () => {
    assert.equal(await fluxo.atualizarPartida(client, {}, 'm', { somenteEditar: true }), false);
    falhaBusca = false;
    assert.equal(await fluxo.atualizarPartida(client, {}, 'm', { somenteEditar: true }), false);
    assert.equal(sends, 0);
  });
});

test('mediador responsável deve ter cargo configurado para a guild, inclusive no pagamento; administrador continua autorizado', async () => {
  const persistencia = require('../src/servicos/supabase');
  const modulePath = require.resolve('../src/servicos/staffSupabase');
  const savedModule = require.cache[modulePath], obterAnterior = persistencia.obterCliente;
  const rolesByGuild = { g: ['cargo-g'], outra: ['cargo-outra'] };
  persistencia.obterCliente = () => ({ from() {
    let guild;
    return { select() { return this; }, eq(campo, valor) { if (campo === 'guild_id') guild = valor; return this; },
      async maybeSingle() { return { data: { valor: JSON.stringify(rolesByGuild[guild] || []) }, error: null }; } };
  } });
  delete require.cache[modulePath];
  const autorizacaoReal = require('../src/servicos/staffSupabase').temCargoMediador;
  require.cache[modulePath] = savedModule; persistencia.obterCliente = obterAnterior;
  let p = { ...base(), status: 'pago' }, writes = 0, pagos = 0;
  await comMocks([
    [staffSupabase, 'temCargoMediador', autorizacaoReal],
    [partidas, 'buscar', async (_db, _id, guild) => guild === p.guild_id ? p : null],
    [partidas, 'publicarSalaManual', async (_db, args) => { writes++; return { ...p, status: 'sala_liberada', sala_id: args.salaId.trim(), sala_senha: args.senha.trim() }; }],
    [partidas, 'marcarPago', async () => { pagos++; }],
    [fluxo, 'atualizarPartida', async () => true], [auditoria, 'registrar', async () => {}],
  ], async () => {
    const member = (role, admin = false) => ({ permissions: { has: () => admin }, roles: { cache: new Map(role ? [[role, {}]] : []) } });
    const valido = modalInteraction(); valido.i.member = member('cargo-g');
    await modais.handleModal(valido.i, { db: {}, client: {} }); assert.equal(writes, 1);
    const semCargo = modalInteraction(); semCargo.i.member = member('cargo-outra');
    await modais.handleModal(semCargo.i, { db: {}, client: {} }); assert.equal(writes, 1);
    const intruso = modalInteraction({ user: 'intruso' }); intruso.i.member = member('cargo-g');
    await modais.handleModal(intruso.i, { db: {}, client: {} }); assert.equal(writes, 1);
    const admin = modalInteraction(); admin.i.member = member(null, true);
    await modais.handleModal(admin.i, { db: {}, client: {} }); assert.equal(writes, 2);
    p = { ...p, status: 'aguardando_pagamento' };
    for (const [role, esperado] of [['cargo-g', 1], ['cargo-outra', 1]]) {
      const c = click({ user: 'med' }); c.interaction.customId = 'ap:pago:m'; c.interaction.member = member(role);
      await botoes.handleBotao(c.interaction, { db: {}, client: {} }); assert.equal(pagos, esperado);
    }
  });
});

test('prontidão transmite a identidade e a versão que estavam no cartão clicado', async () => {
  let enviados;
  await comMocks([
    [partidas, 'buscar', async () => ({ ...base(), sala_versao: 4 })],
    [partidas, 'darGo', async (_db, args) => { enviados = args; throw new Error('cartão trocado'); }],
  ], async () => {
    const c = click(); c.interaction.customId = 'ap:pronto:m:3';
    await botoes.handleBotao(c.interaction, { db: {}, client: {} });
    assert.deepEqual(enviados, { partidaId: 'm', userId: 'a', guildId: 'g', canalId: 'c', mensagemId: 'msg', salaVersao: 3 });
    assert.match(texto(c.respostas), /cartão trocado/);
  });
});

test('retorno vazio ou inconsistente da RPC não é tratado como persistência confirmada', async () => {
  let resposta = null, edicoes = 0;
  await comMocks([
    [staffSupabase, 'temCargoMediador', async () => true],
    [partidas, 'buscar', async () => ({ ...base(), status: 'pago' })],
    [partidas, 'publicarSalaManual', async () => resposta],
    [fluxo, 'atualizarPartida', async () => { edicoes++; return true; }],
  ], async () => {
    for (resposta of [null, { ...base(), sala_id: 'outro' }, { ...base(), mensagem_id: 'outro', sala_id: '1234', sala_senha: '4321' }, { ...base(), sala_id: '1234', sala_senha: '4321', sala_versao: null }]) {
      const c = modalInteraction(); await modais.handleModal(c.i, { db: {}, client: {} });
      assert.match(texto(c.respostas), /não foi possível confirmar se os dados foram salvos/i);
      assert.doesNotMatch(texto(c.respostas), /cartão atualizado/i);
    }
    assert.equal(edicoes, 0);
  });
});


test('botão de cartão antigo transmite ao modal a versão exibida, não a versão posterior do banco', async () => {
  let p = { ...base(), sala_versao: 2, sala_id: 'novo' }, modal, recebido;
  await comMocks([
    [staffSupabase, 'temCargoMediador', async () => true],
    [partidas, 'buscar', async () => ({ ...p })],
    [partidas, 'publicarSalaManual', async (_db, args) => {
      recebido = args;
      const erro = new Error('Este formulário está desatualizado.'); erro.code = 'P0001'; throw erro;
    }],
  ], async () => {
    const c = modalInteraction(); c.i.customId = 'ap:liberar:m:1'; c.i.message = { id: 'msg' };
    c.i.showModal = async (m) => { modal = m.toJSON(); };
    await botoes.handleBotao(c.i, { db: {}, client: {} });
    assert.equal(modal.custom_id, 'ap:modalsala:m:msg:1');
    const envio = modalInteraction(); envio.i.customId = modal.custom_id;
    await modais.handleModal(envio.i, { db: {}, client: {} });
    assert.equal(recebido.salaVersao, 1);
    assert.match(texto(envio.respostas), /desatualizado/i);
    assert.equal(p.sala_id, 'novo');
  });
});

test('botão de sala sem versão ou com versão inválida não abre modal', async () => {
  await comMocks([[staffSupabase, 'temCargoMediador', async () => true], [partidas, 'buscar', async () => base()]], async () => {
    for (const id of ['ap:liberar:m', 'ap:liberar:m:-1', 'ap:liberar:m:NaN', 'ap:liberar:m:1:2', 'ap:liberar:m:9007199254740992']) {
      const c = modalInteraction(); c.i.customId = id; c.i.message = { id: 'msg' };
      c.i.showModal = async () => { throw new Error('não deveria abrir'); };
      await botoes.handleBotao(c.i, { db: {}, client: {} });
      assert.match(texto(c.respostas), /antigo|inválido/i);
    }
  });
});

test('replay e correção concorrente não confirmam credenciais que deixaram de ser atuais após edição', async () => {
  for (const modo of ['replay', 'correcao', 'aba', 'conteudo']) {
    let p = { ...base(), sala_versao: 1, sala_id: '1234', sala_senha: '4321' };
    await comMocks([
      [staffSupabase, 'temCargoMediador', async () => true],
      [partidas, 'buscar', async () => ({ ...p })],
      [partidas, 'publicarSalaManual', async () => {
        if (modo === 'correcao') p = { ...p, sala_versao: 2 };
        return { ...p };
      }],
      [fluxo, 'atualizarPartida', async () => {
        p = modo === 'aba' ? { ...p, sala_versao: 3 } : { ...p, sala_versao: p.sala_versao + (modo === 'conteudo' ? 0 : 1), sala_id: 'outra', sala_senha: 'outra' };
        return true;
      }],
    ], async () => {
      const c = modalInteraction(); c.i.customId = 'ap:modalsala:m:msg:1';
      await modais.handleModal(c.i, { db: {}, client: {} });
      assert.match(texto(c.respostas), /alterad|não.*atual|mudou/i, modo);
      assert.match(texto(c.respostas), /confira|verifique/i, modo);
      assert.doesNotMatch(texto(c.respostas), /salvos e cartão atualizado/i, modo);
    });
  }
});

test('falha na revalidação ou edição do cartão não promete sucesso para entrega ambígua', async () => {
  for (const modo of ['consulta', 'edicao']) {
    let leituras = 0; const p = { ...base(), sala_versao: 1, sala_id: '1234', sala_senha: '4321' };
    await comMocks([
      [staffSupabase, 'temCargoMediador', async () => true],
      [partidas, 'buscar', async () => { if (++leituras > 1 && modo === 'consulta') throw new Error('timeout de consulta'); return { ...p }; }],
      [partidas, 'publicarSalaManual', async () => ({ ...p })],
      [fluxo, 'atualizarPartida', async () => { if (modo === 'edicao') throw new Error('timeout depois de editar'); return true; }],
    ], async () => {
      const c = modalInteraction(); c.i.customId = 'ap:modalsala:m:msg:1';
      await modais.handleModal(c.i, { db: {}, client: {} });
      assert.match(texto(c.respostas), /não.*confirm|incert/i, modo);
      assert.match(texto(c.respostas), /confira|verifique/i, modo);
      assert.doesNotMatch(texto(c.respostas), /salvos e cartão atualizado/i, modo);
    });
  }
});


test('replay e correção de versões diferentes disputam entre dois handlers de modal', async () => {
  let p = { ...base(), sala_versao: 1, sala_id: '1234', sala_senha: '4321' };
  let liberarEdicao, avisarEdicao;
  const aguardandoEdicao = new Promise((r) => { avisarEdicao = r; });
  const gate = new Promise((r) => { liberarEdicao = r; });
  let edicoes = 0;
  const argsRpc = [];
  await comMocks([
    [staffSupabase, 'temCargoMediador', async () => true],
    [partidas, 'buscar', async () => ({ ...p })],
    [partidas, 'publicarSalaManual', async (_db, args) => {
      argsRpc.push(args);
      const salaId = args.salaId.trim(), senha = args.senha.trim();
      if (p.sala_id !== salaId || p.sala_senha !== senha) {
        assert.equal(args.salaVersao, p.sala_versao);
        p = { ...p, sala_versao: p.sala_versao + 1, sala_id: salaId, sala_senha: senha };
      }
      return { ...p };
    }],
    [fluxo, 'atualizarPartida', async () => {
      if (++edicoes === 1) { avisarEdicao(); await gate; }
      return true;
    }],
  ], async () => {
    const replay = modalInteraction(); replay.i.customId = 'ap:modalsala:m:msg:0';
    const replayPendente = modais.handleModal(replay.i, { db: {}, client: {} });
    await aguardandoEdicao; // RPC de replay retornou v1; a edição ficou pendente.
    const correcao = modalInteraction(); correcao.i.customId = 'ap:modalsala:m:msg:1';
    correcao.i.fields.getTextInputValue = (k) => k === 'sala_id' ? '999' : '888';
    await modais.handleModal(correcao.i, { db: {}, client: {} });
    assert.equal(p.sala_versao, 2);
    liberarEdicao(); await replayPendente;
    assert.deepEqual(argsRpc.map((a) => a.salaVersao), [0, 1]);
    assert.match(texto(replay.respostas), /mudaram.*confira/i);
    assert.doesNotMatch(texto(replay.respostas), /Discord aceitou a edição/i);
    assert.match(texto(correcao.respostas), /Discord aceitou a edição/i);
  });
});

test('primeira prontidão pendente impede handler concorrente de confirmar uma correção', async () => {
  let p = { ...base(), sala_versao: 1, sala_id: '1234', sala_senha: '4321' };
  let prontidao = false, liberarPronto, avisarPronto;
  const gravada = new Promise((r) => { avisarPronto = r; });
  const gate = new Promise((r) => { liberarPronto = r; });
  await comMocks([
    [staffSupabase, 'temCargoMediador', async () => true],
    [partidas, 'buscar', async () => ({ ...p })],
    [partidas, 'darGo', async (_db, args) => {
      assert.equal(args.salaVersao, 1); prontidao = true; avisarPronto(); await gate;
      return { jaDeu: false, deram: 1, total: 2, iniciou: false, partida: { ...p } };
    }],
    [partidas, 'publicarSalaManual', async () => {
      assert.equal(prontidao, true);
      const erro = new Error('Já existe prontidão registrada. Não é possível corrigir ID ou senha; cancele e refaça a partida, se necessário.');
      erro.code = 'P0001'; throw erro;
    }],
    [fluxo, 'atualizarPartida', async () => true],
  ], async () => {
    const pronto = click(); pronto.interaction.customId = 'ap:pronto:m:1';
    const prontoPendente = botoes.handleBotao(pronto.interaction, { db: {}, client: {} });
    await gravada;
    const correcao = modalInteraction(); correcao.i.customId = 'ap:modalsala:m:msg:1';
    correcao.i.fields.getTextInputValue = (k) => k === 'sala_id' ? '999' : '888';
    await modais.handleModal(correcao.i, { db: {}, client: {} });
    liberarPronto(); await prontoPendente;
    assert.equal(p.sala_id, '1234'); assert.equal(p.sala_versao, 1); assert.equal(prontidao, true);
    assert.match(texto(pronto.respostas), /Prontidão registrada/);
    assert.match(texto(correcao.respostas), /prontidão.*cancele.*refaça/i);
    assert.doesNotMatch(texto(correcao.respostas), /Discord aceitou a edição/i);
  });
});
