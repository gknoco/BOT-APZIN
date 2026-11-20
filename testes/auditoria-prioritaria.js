'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { PermissionFlagsBits } = require('discord.js');
const supabase = require('../src/servicos/supabase');
const roomSales = require('../src/servicos/roomSalesSupabase');
const compras = require('../src/servicos/comprasSalas');
const recargas = require('../src/servicos/recargas');
const mercadoPago = require('../src/servicos/mercadoPago');
const nix = require('../src/servicos/nix');
const criarSalaComCredito = require('../src/servicos/criarSalaComCredito');
const automacoes = require('../src/servicos/automacoesDiscord');
const config = require('../src/config');
const seguranca = require('../src/util/seguranca');
const partidas = require('../src/servicos/partidas');
const fluxo = require('../src/servicos/fluxo');
const botoes = require('../src/interacoes/botoes');

const raiz = path.resolve(__dirname, '..');

test('worker só confirma webhook depois do RPC de recarga e reagenda se o crédito falhar', async () => {
  const configAntes = config.MP_ACCESS_TOKEN;
  const originais = {
    reivindicar: roomSales.reivindicarEventos,
    finalizar: roomSales.finalizarEvento,
    processarRecarga: recargas.processarPagamentoWebhook,
    processarCompra: compras.processarEventoWebhook,
    buscarPagamento: mercadoPago.buscarPagamento,
  };
  const caminhoWorker = require.resolve('../src/servicos/mercadoPagoWorker');
  delete require.cache[caminhoWorker];
  const worker = require(caminhoWorker);
  const chamadas = [];
  let persistido = false;
  config.MP_ACCESS_TOKEN = 'test-token';
  roomSales.reivindicarEventos = async () => [{ id: 'event-1', payment_id: 'payment-1' }];
  mercadoPago.buscarPagamento = async () => ({ id: 'payment-1' });
  compras.processarEventoWebhook = async () => { chamadas.push('compra'); persistido = true; return {}; };
  try {
    recargas.processarPagamentoWebhook = async () => {
      chamadas.push('rpc-recarga');
      persistido = true;
      return { identificado: true, resultado: { status: 'approved' } };
    };
    roomSales.finalizarEvento = async ({ success }) => {
      chamadas.push(success ? 'ack' : 'retry');
      assert.equal(persistido, true, 'o ACK exige RPC concluída');
    };
    await worker.processarLote();
    assert.deepEqual(chamadas, ['rpc-recarga', 'ack']);

    chamadas.length = 0;
    persistido = false;
    recargas.processarPagamentoWebhook = async () => { chamadas.push('rpc-recarga'); return { identificado: false }; };
    roomSales.finalizarEvento = async ({ success }) => {
      chamadas.push(success ? 'ack' : 'retry');
      assert.equal(persistido, true, 'o fallback de compras também precisa concluir antes do ACK');
    };
    await worker.processarLote();
    assert.deepEqual(chamadas, ['rpc-recarga', 'compra', 'ack']);

    chamadas.length = 0;
    persistido = false;
    recargas.processarPagamentoWebhook = async () => { chamadas.push('rpc-recarga'); throw new Error('Supabase indisponível'); };
    roomSales.finalizarEvento = async ({ success }) => {
      chamadas.push(success ? 'ack' : 'retry');
      assert.equal(success, false);
    };
    await worker.processarLote();
    assert.deepEqual(chamadas, ['rpc-recarga', 'retry']);
  } finally {
    config.MP_ACCESS_TOKEN = configAntes;
    roomSales.reivindicarEventos = originais.reivindicar;
    roomSales.finalizarEvento = originais.finalizar;
    recargas.processarPagamentoWebhook = originais.processarRecarga;
    compras.processarEventoWebhook = originais.processarCompra;
    mercadoPago.buscarPagamento = originais.buscarPagamento;
    delete require.cache[caminhoWorker];
  }
});

test('falha do RPC de reserva nunca usa saldo RAM positivo como autorização para criar sala', async () => {
  const originalCliente = supabase.obterCliente;
  const chamadas = [];
  supabase.obterCliente = () => ({
    async rpc(nome, args) {
      chamadas.push([nome, args]);
      if (nome === 'royal_room_stats') return { data: { available_rooms: 4 }, error: null };
      return { data: null, error: { message: 'network unavailable' } };
    },
  });
  try {
    await roomSales.estatisticasSalas('guild-a', 'user-a');
    await assert.rejects(roomSales.reservarSala({
      guildId: 'guild-a', userId: 'user-a', requestId: 'reservation-1', source: 'nix_command', sourceRef: null,
    }), /royal_room_reserve_room: network unavailable/);
    assert.deepEqual(chamadas.map(([nome]) => nome), ['royal_room_stats', 'royal_room_reserve_room']);
  } finally {
    supabase.obterCliente = originalCliente;
  }
});

test('criação Nix não inicia sem reserva e não retorna sucesso se a liquidação persistida falhar', async () => {
  const originais = {
    configurado: nix.configurado,
    validar: nix.validarCriacaoSala,
    criar: nix.criarSala,
    reservar: roomSales.reservarSala,
    liquidar: roomSales.liquidarUsoSala,
  };
  let nixChamadas = 0;
  try {
    nix.configurado = () => true;
    nix.validarCriacaoSala = () => {};
    nix.criarSala = async () => { nixChamadas += 1; return { room_id: 123, session_id: 'session-a', password: '1234' }; };
    roomSales.reservarSala = async () => { throw new Error('Supabase indisponível'); };
    await assert.rejects(criarSalaComCredito.criar({
      guildId: 'g', userId: 'u', requestId: 'r1', source: 'nix_command', sala: {},
    }), /Supabase indisponível/);
    assert.equal(nixChamadas, 0);

    roomSales.reservarSala = async () => ({ available_rooms: 0 });
    roomSales.liquidarUsoSala = async () => { throw new Error('timeout Supabase'); };
    await assert.rejects(criarSalaComCredito.criar({
      guildId: 'g', userId: 'u', requestId: 'r2', source: 'nix_command', sala: {},
    }), /Não tente criar outra sala/);
    assert.equal(nixChamadas, 1);
  } finally {
    nix.configurado = originais.configurado;
    nix.validarCriacaoSala = originais.validar;
    nix.criarSala = originais.criar;
    roomSales.reservarSala = originais.reservar;
    roomSales.liquidarUsoSala = originais.liquidar;
  }
});

test('resolvedor de automações rejeita canal de outra guild e aceita canal da guild dona', async () => {
  const canal = {
    guildId: 'guild-b',
    isTextBased: () => true,
    send: async () => ({ id: 'msg' }),
  };
  const client = { channels: { cache: new Map([['channel-1', canal]]), fetch: async () => canal } };
  await assert.rejects(automacoes.buscarCanal(client, 'channel-1', 'guild-a'), /não pertence ao servidor/);
  assert.equal(await automacoes.buscarCanal(client, 'channel-1', 'guild-b'), canal);
});

test('health check passa a responder 503 depois de uma falha crítica do runtime', async () => {
  const estadoRuntime = require('../src/estadoRuntime');
  const { criarServidor } = require('../src/servidor');
  const server = criarServidor();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/health`;
  try {
    assert.equal((await fetch(url)).status, 200);
    estadoRuntime.marcarDegradado('uncaught_exception');
    const resposta = await fetch(url);
    assert.equal(resposta.status, 503);
    assert.match(await resposta.text(), /uncaught_exception/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  const eventos = fs.readFileSync(path.join(raiz, 'src/eventos/index.js'), 'utf8');
  assert.match(eventos, /process\.once\('uncaughtException'/);
  assert.match(eventos, /process\.exit\(1\)/);
  assert.match(eventos, /erro\.stack \|\| erro/);
});

test('busca de partida por ID aplica filtro da guild e permissões restringem o encerramento ao responsável ou staff/admin', async () => {
  const filtros = [];
  const builder = {
    select() { return this; },
    eq(chave, valor) { filtros.push([chave, valor]); return this; },
    maybeSingle() { return Promise.resolve({ data: null, error: null }); },
  };
  await partidas.buscar({ client: { from: () => builder } }, 'partida-1', 'guild-a');
  assert.deepEqual(filtros, [['id', 'partida-1'], ['guild_id', 'guild-a']]);

  const antes = { admin: config.CARGO_ADMIN_ID, staff: config.CARGO_STAFF_ID, mediador: config.CARGO_MEDIADOR_ID };
  config.CARGO_ADMIN_ID = 'admin-role';
  config.CARGO_STAFF_ID = 'staff-role';
  config.CARGO_MEDIADOR_ID = 'mediator-role';
  const membro = (id, cargos = [], permissoes = []) => ({
    id,
    roles: { cache: new Map(cargos.map((cargo) => [cargo, {}])) },
    permissions: { has: (permissao) => permissoes.includes(permissao) },
  });
  try {
    assert.equal(seguranca.podeFinalizarPartida(membro('mediator-a', ['mediator-role']), 'mediator-a'), true);
    assert.equal(seguranca.podeFinalizarPartida(membro('mediator-b', ['mediator-role']), 'mediator-a'), false);
    assert.equal(seguranca.podeFinalizarPartida(membro('admin-a', ['admin-role']), 'mediator-a'), true);
    assert.equal(seguranca.podeFinalizarPartida(membro('staff-a', ['staff-role']), 'mediator-a'), true);
    assert.equal(seguranca.podeFinalizarPartida(membro('manager-a', [], [PermissionFlagsBits.ManageGuild]), 'mediator-a'), true);
  } finally {
    config.CARGO_ADMIN_ID = antes.admin;
    config.CARGO_STAFF_ID = antes.staff;
    config.CARGO_MEDIADOR_ID = antes.mediador;
  }

  const fila = fs.readFileSync(path.join(raiz, 'src/comandos/fila.js'), 'utf8');
  assert.equal((fila.match(/exigirResponsavelDaPartida\(interaction, partida\)/g) || []).length, 3);
});

test('botões de vencedor e W.O. também bloqueiam mediador não atribuído e escopam a guild', async () => {
  const antes = config.CARGO_MEDIADOR_ID;
  const originalBuscar = partidas.buscar;
  const originalVencedor = fluxo.encerrarPartida;
  const originalWo = fluxo.aplicarWO;
  const consultas = [];
  let mutacoes = 0;
  config.CARGO_MEDIADOR_ID = 'mediator-role';
  partidas.buscar = async (_db, id, guildId) => {
    consultas.push([id, guildId]);
    return { id, guild_id: guildId, mediador_id: 'mediator-a' };
  };
  fluxo.encerrarPartida = async () => { mutacoes += 1; };
  fluxo.aplicarWO = async () => { mutacoes += 1; };
  const interaction = (customId) => ({
    customId, guildId: 'guild-a', deferred: false, replied: false,
    user: { id: 'mediator-b' },
    member: { id: 'mediator-b', roles: { cache: new Map([['mediator-role', {}]]) }, permissions: { has: () => false } },
    deferUpdate: async () => {}, followUp: async () => {}, reply: async () => {},
  });
  try {
    assert.equal(await botoes.handleBotao(interaction('ap:vencer:partida-1:1'), { db: {}, client: {} }), true);
    assert.equal(await botoes.handleBotao(interaction('ap:wo:partida-2:1'), { db: {}, client: {} }), true);
    assert.deepEqual(consultas, [['partida-1', 'guild-a'], ['partida-2', 'guild-a']]);
    assert.equal(mutacoes, 0);
  } finally {
    config.CARGO_MEDIADOR_ID = antes;
    partidas.buscar = originalBuscar;
    fluxo.encerrarPartida = originalVencedor;
    fluxo.aplicarWO = originalWo;
  }
});

test('RPC administrativa restringe execução a service_role na migration original e na correção forward', () => {
  const arquivoBase = fs.readFileSync(path.join(raiz, 'supabase/migrations/20261118010000_royal_room_admin_grants.sql'), 'utf8');
  const arquivoForward = fs.readFileSync(path.join(raiz, 'supabase/migrations/20261120000100_wallet_topup_refund_protection.sql'), 'utf8');
  assert.match(arquivoForward, /royal_wallet_propagate_freeze_to_rooms/);
  assert.match(arquivoForward, /ROOM_WALLET_FROZEN_FOR_REVIEW/);
  assert.match(arquivoForward, /'wallet_frozen', COALESCE\(v_wallet\.is_frozen, false\)/);
  for (const sql of [arquivoBase, arquivoForward]) {
    assert.match(sql, /REVOKE ALL ON FUNCTION public\.royal_room_admin_grant\(text,\s*text,\s*text,\s*bigint,\s*text\)[\s\S]*FROM PUBLIC, anon, authenticated/);
    assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.royal_room_admin_grant\(text,\s*text,\s*text,\s*bigint,\s*text\)[\s\S]*TO service_role/);
  }
});
