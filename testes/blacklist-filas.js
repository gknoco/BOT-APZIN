'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Collection } = require('discord.js');
const blacklist = require('../src/servicos/blacklist');
const filas = require('../src/servicos/filas');
const partidas = require('../src/servicos/partidas');
const paineis = require('../src/servicos/paineis');
const mediadores = require('../src/servicos/mediadores');
const auditoria = require('../src/servicos/auditoria');
const fluxo = require('../src/servicos/fluxo');
const nix = require('../src/servicos/nix');
const moderacao = require('../src/comandos/moderacao');
const { handleBotao } = require('../src/interacoes/botoes');
const config = require('../src/config');

async function mocks(alteracoes, executar) {
  const originais = alteracoes.map(([obj, chave, valor]) => { const antes = obj[chave]; obj[chave] = valor; return [obj, chave, antes]; });
  try { return await executar(); }
  finally { for (const [obj, chave, antes] of originais) obj[chave] = antes; }
}

test('adição usa uma RPC, valida motivo e propaga falhas', async () => {
  const chamadas = [];
  const db = { client: { rpc: async (nome, args) => {
    chamadas.push({ nome, args });
    return { data: { registro: { guild_id: 'g', user_id: 'u', motivo: 'motivo' }, filas_afetadas: [{ modo: 'solo', preco: 100 }] } };
  } } };
  const resultado = await blacklist.adicionar(db, { guildId: 'g', userId: 'u', motivo: '  motivo  ', autorId: 'a' });
  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0].nome, 'royal_operacional_adicionar_blacklist');
  assert.equal(chamadas[0].args.p_motivo, 'motivo');
  assert.equal(resultado.user_id, 'u');
  assert.deepEqual(resultado.filas_afetadas, [{ modo: 'solo', preco: 100 }]);
  await assert.rejects(blacklist.adicionar(db, { guildId: 'g', userId: 'u', motivo: ' x ', autorId: 'a' }), /pelo menos 3/);
  assert.equal(chamadas.length, 1);
  db.client.rpc = async () => ({ error: { message: 'banco indisponível' } });
  await assert.rejects(blacklist.adicionar(db, { guildId: 'g', userId: 'u', motivo: 'motivo', autorId: 'a' }), /banco indisponível/);
});

function interacao() {
  const respostas = [];
  return {
    guildId: 'g', deferred: true, user: { id: 'admin' }, member: { permissions: { has: () => true } },
    options: { getSubcommand: () => 'adicionar', getUser: () => ({ id: 'u' }), getString: () => 'motivo' },
    editReply: async (resposta) => respostas.push(resposta), respostas,
  };
}

test('comando atualiza cada painel afetado e confirma mesmo se Discord falhar', async () => {
  const inter = interacao(); const tentativas = []; let auditou = false;
  const comando = moderacao.comandos.find((item) => item.data.name === 'blacklist');
  await mocks([
    [blacklist, 'adicionar', async () => ({ filas_afetadas: [{ modo: 'm', preco: 50 }, { modo: 'n', preco: 100 }] })],
    [paineis, 'atualizar', async (_client, _db, dados) => { tentativas.push(dados); if (dados.modo === 'm') throw new Error('Discord indisponível'); return true; }],
    [auditoria, 'registrar', async () => { auditou = true; }],
    [console, 'error', () => {}],
  ], async () => comando.executar(inter, { db: {}, client: {} }));
  assert.deepEqual(tentativas, [{ guildId: 'g', modo: 'm', preco: 50 }, { guildId: 'g', modo: 'n', preco: 100 }]);
  assert.equal(auditou, true); assert.equal(inter.respostas.length, 1);
  assert.match(inter.respostas[0].embeds[0].toJSON().description, /bloqueado/);
});

test('erro no banco não confirma blacklist nem tenta atualizar painel', async () => {
  const inter = interacao(); let atualizou = false;
  const comando = moderacao.comandos.find((item) => item.data.name === 'blacklist');
  await mocks([
    [blacklist, 'adicionar', async () => { throw new Error('banco indisponível'); }],
    [paineis, 'atualizar', async () => { atualizou = true; }],
  ], async () => assert.rejects(comando.executar(inter, { db: {}, client: {} }), /banco indisponível/));
  assert.equal(atualizou, false); assert.equal(inter.respostas.length, 0);
});

function contextoFluxo() {
  const modo = config.MODOS[0]; const preco = config.PRECOS[0]; const gelo = config.variantesDoModo(modo)[0].id;
  const mensagens = []; const opcoesCanais = []; let exclusoes = 0;
  const canal = { id: 'c', name: 'fila', delete: async () => { exclusoes++; }, send: async (p) => { mensagens.push(p); return { id: 'msg' }; } };
  const guild = { id: 'g', roles: { everyone: { id: 'todos' } }, channels: {
    cache: new Collection(), create: async (opcoes) => { opcoesCanais.push(opcoes); return canal; },
  } };
  const client = { user: { id: 'bot' }, channels: { cache: new Map([['c', canal]]) } };
  const db = { client: { from: () => ({ select() { return this; }, eq() { return this; }, maybeSingle: async () => ({ data: null }) }) } };
  return { modo, preco, gelo, guild, client, db, canal, mensagens, opcoesCanais, exclusoes: () => exclusoes,
    entrar: () => fluxo.entrarNaFila(client, db, { guild, userId: 'b', modo: modo.id, preco, gelo }) };
}
function dadosReserva(dados, estado = 'reservada') {
  return { id: dados.reservaId, partida_id: dados.partidaId, guild_id: dados.guildId, modo: dados.modo,
    preco: dados.preco, gelo: dados.gelo, estado, jogadores: estado === 'reservada' ? ['a', 'b'] : [],
    filas_originais: estado === 'reservada' ? [{ guild_id: dados.guildId, modo: dados.modo, preco: dados.preco, gelo: dados.gelo, user_id: 'a' }] : [] };
}
function dadosPartida(dados) {
  return { id: dados.partidaId, guild_id: dados.guildId, modo: dados.modo, preco: dados.preco,
    gelo: dados.gelo, canal_id: dados.canalId, status: partidas.STATUS.CONFIRMANDO };
}
function padroes() {
  return [
    [blacklist, 'obter', async () => null], [filas, 'entrar', async () => ({ entrou: true, posicao: 2 })],
    [filas, 'contar', async () => 2], [paineis, 'atualizar', async () => true],
    [paineis, 'nomeSalaFila', () => 'fila'], [mediadores, 'cargos', async () => []],
    [partidas, 'jogadores', async () => [{ user_id: 'a', time: 1 }, { user_id: 'b', time: 2 }]],
    [partidas, 'definirMensagem', async () => {}], [auditoria, 'registrar', async () => {}],
    [console, 'info', () => {}], [console, 'error', () => {}],
  ];
}

test('respostas perdidas de reserva, vínculo e criação são repetidas com IDs e argumentos idênticos', async () => {
  const c = contextoFluxo(); const reservas = []; const vinculos = []; const criacoes = [];
  await mocks([...padroes(),
    [filas, 'reservar', async (_db, dados) => { reservas.push({ ...dados }); if (reservas.length === 1) throw new Error('HTTP timeout após commit'); return dadosReserva(dados); }],
    [filas, 'vincularCanal', async (_db, dados) => { vinculos.push({ ...dados }); if (vinculos.length === 1) throw new Error('HTTP timeout após commit'); return { id: dados.reservaId, guild_id: dados.guildId, canal_id: dados.canalId, estado: 'reservada' }; }],
    [partidas, 'criar', async (_db, dados) => { criacoes.push(structuredClone(dados)); if (criacoes.length === 1) throw new Error('HTTP timeout após commit'); return dadosPartida(dados); }],
  ], async () => assert.rejects(c.entrar(), (erro) => {
    assert.equal(erro.partidaConfirmada, true);
    assert.equal(erro.partidaId, criacoes[0].partidaId);
    assert.match(erro.message, /publicação do cartão não foi confirmada/);
    return true;
  }));
  assert.equal(reservas.length, 2); assert.deepEqual(reservas[0], reservas[1]);
  assert.equal(vinculos.length, 2); assert.deepEqual(vinculos[0], vinculos[1]);
  assert.equal(criacoes.length, 2); assert.deepEqual(criacoes[0], criacoes[1]);
  assert.equal(criacoes[0].reservaId, reservas[0].reservaId); assert.equal(criacoes[0].partidaId, reservas[0].partidaId);
  assert.match(c.opcoesCanais[0].topic, new RegExp(reservas[0].reservaId));
  assert.equal(c.exclusoes(), 0); assert.equal(c.mensagens.length, 0);
});

test('resposta de reserva inconclusiva não cancela nem cria canal, e informa a chave antes do pedido', async () => {
  const c = contextoFluxo(); const chamadas = []; const logs = []; let cancelou = false;
  await mocks([...padroes(), [console, 'info', (s) => logs.push(s)],
    [filas, 'reservar', async (_db, dados) => { chamadas.push({ ...dados }); throw new Error('timeout'); }],
    [filas, 'cancelarReserva', async () => { cancelou = true; }],
  ], async () => assert.rejects(c.entrar(), (e) => { assert.match(e.message, new RegExp(chamadas[0].reservaId)); return true; }));
  assert.equal(chamadas.length, 2); assert.deepEqual(chamadas[0], chamadas[1]);
  assert.ok(logs.some((s) => s.includes(chamadas[0].reservaId) && s.includes(chamadas[0].partidaId)));
  assert.equal(cancelou, false); assert.equal(c.opcoesCanais.length, 0);
});

test('resposta de criação incerta não reinclui ou remove canal mesmo com commit tardio possível', async () => {
  const c = contextoFluxo(); const criacoes = []; let cancelou = false; let entrou = 0; let auditorias = 0;
  await mocks([...padroes(),
    [filas, 'entrar', async () => { entrou++; return { entrou: true, posicao: 2 }; }],
    [filas, 'reservar', async (_db, dados) => dadosReserva(dados)],
    [filas, 'vincularCanal', async (_db, d) => ({ id: d.reservaId, guild_id: d.guildId, canal_id: d.canalId, estado: 'reservada' })],
    [filas, 'cancelarReserva', async () => { cancelou = true; }],
    [partidas, 'criar', async (_db, dados) => { criacoes.push(structuredClone(dados)); throw new Error('timeout, servidor pode confirmar depois'); }],
    [auditoria, 'registrar', async () => { auditorias++; }],
  ], async () => assert.rejects(c.entrar(), /operação pode ainda estar em processamento/));
  assert.equal(criacoes.length, 2); assert.deepEqual(criacoes[0], criacoes[1]);
  assert.equal(entrou, 1); assert.equal(cancelou, false); assert.equal(c.exclusoes(), 0); assert.equal(auditorias, 0);
  assert.match(c.mensagens[0].content, /reconciliá-la/);
});

test('blacklist depois da reserva falha sem reinserção insegura', async () => {
  const c = contextoFluxo(); let chamadas = 0; let cancelou = false;
  await mocks([...padroes(),
    [filas, 'reservar', async (_db, d) => dadosReserva(d)],
    [filas, 'vincularCanal', async (_db, d) => ({ id: d.reservaId, guild_id: d.guildId, canal_id: d.canalId, estado: 'reservada' })],
    [filas, 'cancelarReserva', async () => { cancelou = true; }],
    [partidas, 'criar', async () => { chamadas++; throw Object.assign(new Error('blacklist'), { code: 'PBL01' }); }],
  ], async () => assert.rejects(c.entrar(), /recusada.*lista negra/));
  assert.equal(chamadas, 1); assert.equal(cancelou, false); assert.equal(c.exclusoes(), 0);
});

test('insuficiência reconta e não abre canal', async () => {
  const c = contextoFluxo(); let contagens = 0; let atualizacoes = 0;
  await mocks([...padroes(),
    [filas, 'contar', async () => (++contagens === 1 ? 2 : 1)],
    [filas, 'reservar', async (_db, d) => dadosReserva(d, 'insuficiente')],
    [paineis, 'atualizar', async () => { atualizacoes++; return true; }],
  ], async () => { const r = await c.entrar(); assert.equal(r.fechou, false); assert.equal(r.naFila, 1); assert.equal(r.faltam, 1); });
  assert.equal(atualizacoes, 2); assert.equal(c.opcoesCanais.length, 0);
});

test('serviços exigem IDs persistentes e retomada pós-reinício usa a mesma chave', async () => {
  const chamadas = []; const db = { client: { rpc: async (nome, args) => { chamadas.push({ nome, args }); return { data: { estado: 'reservada' } }; } } };
  const dados = { reservaId: 'reservada-antes-do-reinicio', partidaId: 'partida-estavel', guildId: 'g', modo: 'solo', preco: 100, gelo: 'normal', quantidade: 2 };
  await filas.reservar(db, dados); await filas.reservar(db, { ...dados });
  assert.deepEqual(chamadas[0], chamadas[1]);
  await partidas.criar(db, { ...dados, canalId: 'c', jogadores: [{ userId: 'a', time: 1 }] });
  await partidas.criar(db, { ...dados, canalId: 'c', jogadores: [{ userId: 'a', time: 1 }] });
  assert.deepEqual(chamadas[2], chamadas[3]); assert.equal(chamadas[2].args.p_id, dados.partidaId);
  await assert.rejects(filas.reservar(db, { ...dados, reservaId: null }), /IDs estáveis/);
  await assert.rejects(partidas.criar(db, { ...dados, partidaId: null, canalId: 'c', jogadores: [{ userId: 'a', time: 1 }] }), /IDs estáveis/);
});

test('importação de filas usa lotes, soma bloqueados e propaga erros sem ocultá-los', async () => {
  const { importarFilas } = require('../scripts/migrar-supabase');
  const linhas = Array.from({ length: 1001 }, (_, i) => ({ guild_id: 'g', user_id: String(i) }));
  const tamanhos = [];
  const cliente = { rpc: async (nome, { p_filas }) => {
    assert.equal(nome, 'royal_operacional_importar_filas');
    tamanhos.push(p_filas.length);
    return { data: { considerados: p_filas.length, inseridos: p_filas.length - 1, bloqueados: 1 } };
  } };
  assert.deepEqual(await importarFilas(cliente, linhas), { considerados: 1001, inseridos: 998, bloqueados: 3 });
  assert.deepEqual(tamanhos, [500, 500, 1]);
  await assert.rejects(importarFilas({ rpc: async () => ({ error: { message: 'erro real' } }) }, linhas), /erro real/);
  await assert.rejects(importarFilas({ rpc: async () => ({ data: null }) }, linhas), /Resposta inválida/);
});

test('exclusões usam RPC com filtros, contagens, escopo e erros preservados', async () => {
  const chamadas = [];
  const db = { client: { rpc: async (nome, args) => { chamadas.push({ nome, args }); return { data: 2 }; } } };
  assert.equal(await filas.sair(db, { guildId: 'g', modo: 'solo', preco: 101.9, gelo: 'normal', userId: 42 }), 2);
  assert.deepEqual(chamadas[0], { nome: 'royal_operacional_remover_filas', args: {
    p_guild_id: 'g', p_modo: 'solo', p_preco: 101, p_gelo: 'normal', p_user_id: '42', p_user_ids: null,
  } });
  assert.equal(await filas.remover(db, { guildId: 'g', modo: 'duo', ids: [1, '2'] }), 2);
  assert.deepEqual(chamadas[1].args, { p_guild_id: 'g', p_modo: 'duo', p_preco: null, p_gelo: null, p_user_id: null, p_user_ids: ['1', '2'] });
  assert.equal(await filas.remover(db, { guildId: 'g', ids: [] }), 0);
  assert.equal(chamadas.length, 2);
  await assert.rejects(filas.sair(db, { guildId: 'g', preco: NaN }), /Preço inválido/);
  await assert.rejects(filas.remover(db, { guildId: 'g', preco: Infinity, ids: ['u'] }), /Preço inválido/);
  assert.equal(chamadas.length, 2);
  assert.equal(await filas.limpar(db, { guildId: 'g' }), 2);
  assert.deepEqual(chamadas[2].args, { p_guild_id: 'g', p_modo: null, p_preco: null, p_gelo: null, p_user_id: null, p_user_ids: null });
  assert.equal(await blacklist.remover(db, { guildId: 'g', userId: 'u' }), 2);
  assert.deepEqual(chamadas[3], { nome: 'royal_operacional_remover_blacklist', args: { p_guild_id: 'g', p_user_id: 'u' } });
  db.client.rpc = async () => ({ error: { code: '42501', message: 'negado' } });
  for (const operacao of [() => filas.sair(db, { guildId: 'g' }), () => filas.remover(db, { guildId: 'g', ids: ['u'] }),
    () => filas.limpar(db, { guildId: 'g' }), () => blacklist.remover(db, { guildId: 'g', userId: 'u' })]) {
    await assert.rejects(operacao(), (e) => e.code === '42501' && /negado/.test(e.message));
  }
});

function vinculoPadrao(_db, d) {
  return { id: d.reservaId, guild_id: d.guildId, canal_id: d.canalId, estado: 'reservada' };
}

test('timeout da criação seguido de PBL01 continua incerto e preserva as três referências', async () => {
  const c = contextoFluxo(); const criacoes = []; let cancelou = 0, entradas = 0;
  await mocks([...padroes(),
    [filas, 'entrar', async () => { entradas++; return { entrou: true, posicao: 2 }; }],
    [filas, 'reservar', async (_db, d) => dadosReserva(d)],
    [filas, 'vincularCanal', vinculoPadrao],
    [filas, 'cancelarReserva', async () => { cancelou++; }],
    [partidas, 'criar', async (_db, d) => {
      criacoes.push(structuredClone(d));
      if (criacoes.length === 1) throw new Error('timeout; pedido ainda pode chegar');
      throw Object.assign(new Error('bloqueio'), { code: 'PBL01' });
    }],
  ], async () => assert.rejects(c.entrar(), (e) => {
    assert.match(e.message, /não confirmado.*pode ainda estar em processamento/i);
    assert.doesNotMatch(e.message, /criação recusada/i);
    assert.equal(e.reservaId, criacoes[0].reservaId);
    assert.equal(e.partidaId, criacoes[0].partidaId);
    assert.equal(e.canalId, 'c');
    for (const id of [e.reservaId, e.partidaId, e.canalId]) assert.ok(e.message.includes(id));
    return true;
  }));
  assert.equal(criacoes.length, 2); assert.deepEqual(criacoes[0], criacoes[1]);
  assert.equal(entradas, 1); assert.equal(cancelou, 0); assert.equal(c.exclusoes(), 0);
});

test('envio ambíguo após commit informa partida confirmada e nunca reenvia, inclusive no cancelamento', async () => {
  const c = contextoFluxo(); let partida, envios = 0, cancelamentosReserva = 0;
  c.canal.send = async (payload) => { envios++; c.mensagens.push(payload); throw new Error('timeout depois do envio'); };
  await mocks([...padroes(),
    [filas, 'reservar', async (_db, d) => dadosReserva(d)],
    [filas, 'vincularCanal', vinculoPadrao],
    [filas, 'cancelarReserva', async () => { cancelamentosReserva++; }],
    [partidas, 'criar', async (_db, d) => { partida = dadosPartida(d); return partida; }],
    [partidas, 'buscar', async () => partida],
    [partidas, 'cancelar', async () => ({ ...partida, status: partidas.STATUS.CANCELADA })],
  ], async () => {
    await assert.rejects(c.entrar(), (e) => {
      assert.equal(e.partidaConfirmada, true); assert.equal(e.publicacaoConfirmada, false);
      assert.equal(e.partidaId, partida.id); assert.equal(e.canalId, 'c');
      assert.match(e.message, /foi confirmada no banco/); assert.match(e.message, /pode já ter ocorrido/);
      assert.match(e.message, /Não entre novamente/);
      for (const id of [e.reservaId, e.partidaId, e.canalId]) assert.ok(e.message.includes(id));
      return true;
    });
    assert.equal(await fluxo.atualizarPartida(c.client, c.db, partida.id), false);
    await fluxo.cancelarPartida(c.client, c.db, { partidaId: partida.id, autorId: 'admin', motivo: 'teste' });
    assert.equal(envios, 1);
  });
  assert.equal(cancelamentosReserva, 0); assert.equal(c.exclusoes(), 0);
});

test('persistência ambígua do ID só reconcilia editando a mensagem salva, sem novo envio', async () => {
  const c = contextoFluxo(); let partida, envios = 0, edicoes = 0, escritas = 0;
  c.canal.send = async () => { envios++; return { id: 'msg' }; };
  c.canal.messages = { fetch: async (id) => { assert.equal(id, 'msg'); return { edit: async () => { edicoes++; } }; } };
  await mocks([...padroes(),
    [filas, 'reservar', async (_db, d) => dadosReserva(d)],
    [filas, 'vincularCanal', vinculoPadrao],
    [partidas, 'criar', async (_db, d) => { partida = dadosPartida(d); return { ...partida }; }],
    [partidas, 'definirMensagem', async () => { escritas++; partida.mensagem_id = 'msg'; throw new Error('timeout após gravar'); }],
    [partidas, 'buscar', async () => partida],
  ], async () => {
    const r = await c.entrar();
    assert.equal(r.fechou, true); assert.equal(r.partidaId, partida.id);
  });
  assert.equal(envios, 1); assert.equal(escritas, 1); assert.equal(edicoes, 1);
});

test('ID não gravado após envio gera incerteza sem tentar publicar outra mensagem', async () => {
  const c = contextoFluxo(); let partida, envios = 0;
  c.canal.send = async () => { envios++; return { id: 'msg' }; };
  await mocks([...padroes(),
    [filas, 'reservar', async (_db, d) => dadosReserva(d)],
    [filas, 'vincularCanal', vinculoPadrao],
    [partidas, 'criar', async (_db, d) => { partida = dadosPartida(d); return partida; }],
    [partidas, 'definirMensagem', async () => { throw new Error('não confirmou gravação'); }],
    [partidas, 'buscar', async () => partida],
  ], async () => assert.rejects(c.entrar(), (e) => {
    assert.equal(e.partidaConfirmada, true); assert.equal(e.publicacaoConfirmada, false);
    assert.match(e.message, /pode já ter ocorrido/); return true;
  }));
  assert.equal(envios, 1);
});

test('replay de criação com cartão salvo edita o mesmo cartão, sem enviar outro', async () => {
  const c = contextoFluxo(); let partida, criacoes = 0, envios = 0, edicoes = 0;
  c.canal.send = async () => { envios++; return { id: 'nova' }; };
  c.canal.messages = { fetch: async (id) => { assert.equal(id, 'existente'); return { edit: async () => { edicoes++; } }; } };
  await mocks([...padroes(),
    [filas, 'reservar', async (_db, d) => dadosReserva(d)], [filas, 'vincularCanal', vinculoPadrao],
    [partidas, 'criar', async (_db, d) => {
      if (++criacoes === 1) throw new Error('timeout');
      partida = { ...dadosPartida(d), mensagem_id: 'existente' }; return partida;
    }],
    [partidas, 'buscar', async () => partida],
  ], async () => assert.equal((await c.entrar()).fechou, true));
  assert.equal(criacoes, 2); assert.equal(envios, 0); assert.equal(edicoes, 1);
});

test('status da resposta é validado pelo campo status, não pela presença ou valor do ID', async () => {
  for (const status of [undefined, null, 'inexistente']) {
    const c = contextoFluxo(); let tentativas = 0;
    await mocks([...padroes(),
      [filas, 'reservar', async (_db, d) => dadosReserva(d)], [filas, 'vincularCanal', vinculoPadrao],
      [partidas, 'criar', async (_db, d) => { tentativas++; return { ...dadosPartida(d), status }; }],
    ], async () => assert.rejects(c.entrar(), /operação pode ainda estar em processamento/));
    assert.equal(tentativas, 2);
    assert.ok(c.mensagens.every((p) => !p.content.includes('sala de AP criada')));
  }
  const c = contextoFluxo(); let tentativas = 0, partida;
  await mocks([...padroes(),
    [filas, 'reservar', async (_db, d) => dadosReserva(d)], [filas, 'vincularCanal', vinculoPadrao],
    [partidas, 'criar', async (_db, d) => { tentativas++; partida = { ...dadosPartida(d), status: partidas.STATUS.CANCELADA }; return partida; }],
    [partidas, 'buscar', async () => partida],
  ], async () => assert.rejects(c.entrar(), (e) => {
    assert.equal(e.partidaConfirmada, true); assert.match(e.message, /estado retornado é cancelada/); return true;
  }));
  assert.equal(tentativas, 1); assert.equal(c.mensagens.length, 0);
});

test('painéis de todas as filas suspensas são atualizados mesmo com false e erro após a partida', async () => {
  const c = contextoFluxo(); const m2 = config.MODOS[1].id; const p2 = config.PRECOS[1]; const chamadas = [];
  let criada = false, auditorias = 0;
  await mocks([...padroes(),
    [filas, 'reservar', async (_db, d) => ({ ...dadosReserva(d), filas_originais: [
      { guild_id: 'g', modo: d.modo, preco: d.preco, user_id: 'a' },
      { guild_id: 'g', modo: m2, preco: p2, user_id: 'a' },
      { guild_id: 'g', modo: m2, preco: p2, user_id: 'b', gelo: 'outra' },
      { guild_id: 'g', modo: d.modo, preco: p2, user_id: 'b' },
    ] })],
    [filas, 'vincularCanal', vinculoPadrao],
    [partidas, 'criar', async (_db, d) => { criada = true; return dadosPartida(d); }],
    [paineis, 'atualizar', async (_client, _db, d) => {
      chamadas.push({ ...d, criada });
      if (criada && d.modo === m2) return false;
      if (criada && d.modo === c.modo.id && d.preco === p2) throw new Error('timeout');
      return true;
    }],
    [auditoria, 'registrar', async () => { auditorias++; }],
  ], async () => assert.rejects(c.entrar(), (e) => {
    assert.equal(e.partidaConfirmada, true); assert.equal(e.publicacaoConfirmada, true);
    assert.deepEqual(new Set(e.paineisPendentes), new Set([`${m2}/${p2}`, `${c.modo.id}/${p2}`]));
    assert.match(e.message, /Não entre novamente/); return true;
  }));
  const depois = chamadas.filter((x) => x.criada).map(({ guildId, modo, preco }) => ({ guildId, modo, preco }));
  assert.deepEqual(depois, [
    { guildId: 'g', modo: c.modo.id, preco: c.preco }, { guildId: 'g', modo: m2, preco: p2 },
    { guildId: 'g', modo: c.modo.id, preco: p2 },
  ]);
  assert.equal(auditorias, 1); assert.equal(c.mensagens.length, 1); assert.equal(c.exclusoes(), 0);
});

test('snapshot ausente de filas removidas e falha na auditoria são reportados após confirmação', async () => {
  const c = contextoFluxo();
  await mocks([...padroes(),
    [filas, 'reservar', async (_db, d) => ({ ...dadosReserva(d), filas_originais: null })],
    [filas, 'vincularCanal', vinculoPadrao], [partidas, 'criar', async (_db, d) => dadosPartida(d)],
    [auditoria, 'registrar', async () => { throw new Error('indisponível'); }],
  ], async () => assert.rejects(c.entrar(), (e) => {
    assert.equal(e.partidaConfirmada, true); assert.equal(e.publicacaoConfirmada, true);
    assert.match(e.message, /lista de filas removidas incompleta/); assert.match(e.message, /auditoria não confirmada/);
    return true;
  }));
  assert.equal(c.mensagens.length, 1);
});

test('botão comunica em privado a partida confirmada e orienta a não repetir após falha de publicação', async () => {
  const c = contextoFluxo(); const respostas = []; let partida, envios = 0;
  c.canal.send = async () => { envios++; throw new Error('resposta perdida'); };
  const interaction = {
    customId: `ap:entrar:${c.modo.id}:${c.preco}:${c.gelo}`, guild: c.guild, guildId: 'g', user: { id: 'b' },
    deferred: false, replied: false, isMessageComponent: () => true,
    async deferUpdate() { this.deferred = true; }, async followUp(payload) { respostas.push(payload); },
  };
  await mocks([...padroes(),
    [filas, 'reservar', async (_db, d) => dadosReserva(d)], [filas, 'vincularCanal', vinculoPadrao],
    [partidas, 'criar', async (_db, d) => { partida = dadosPartida(d); return partida; }],
    [partidas, 'buscar', async () => partida],
  ], async () => assert.equal(await handleBotao(interaction, { db: c.db, client: c.client }), true));
  assert.equal(respostas.length, 1); const texto = respostas[0].embeds[0].toJSON().description;
  assert.match(texto, /foi confirmada no banco/); assert.match(texto, /Não entre novamente/);
  assert.ok(texto.includes(partida.id)); assert.ok(texto.includes('canal c'));
  assert.equal(envios, 1);
});

test('envio sem ID retornado é ambíguo, não grava ID inválido nem reenvia', async () => {
  const c = contextoFluxo(); let partida, envios = 0, gravacoes = 0;
  c.canal.send = async () => { envios++; return {}; };
  await mocks([...padroes(),
    [filas, 'reservar', async (_db, d) => dadosReserva(d)], [filas, 'vincularCanal', vinculoPadrao],
    [partidas, 'criar', async (_db, d) => { partida = dadosPartida(d); return partida; }],
    [partidas, 'buscar', async () => partida],
    [partidas, 'definirMensagem', async () => { gravacoes++; }],
  ], async () => assert.rejects(c.entrar(), (e) => {
    assert.equal(e.partidaConfirmada, true); assert.equal(e.publicacaoConfirmada, false); return true;
  }));
  assert.equal(envios, 1); assert.equal(gravacoes, 0);
});

test('falha de atualização de painel não é repetida automaticamente após possível publicação parcial', async () => {
  const c = contextoFluxo(); const m2 = config.MODOS[1].id; let tentativasM2 = 0, criada = false;
  await mocks([...padroes(),
    [filas, 'reservar', async (_db, d) => ({ ...dadosReserva(d), filas_originais: [
      ...dadosReserva(d).filas_originais, { guild_id: 'g', modo: m2, preco: d.preco, user_id: 'b' },
    ] })],
    [filas, 'vincularCanal', vinculoPadrao],
    [partidas, 'criar', async (_db, d) => { criada = true; return dadosPartida(d); }],
    [paineis, 'atualizar', async (_client, _db, d) => {
      if (d.modo === m2) { tentativasM2++; throw new Error('timeout após publicação parcial'); }
      return true;
    }],
  ], async () => assert.rejects(c.entrar(), (e) => {
    assert.equal(e.partidaConfirmada, true); assert.match(e.message, /painéis não confirmada/); return true;
  }));
  assert.equal(criada, true); assert.equal(tentativasM2, 1); assert.equal(c.mensagens.length, 1);
});
