'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const utilidades = require('../src/comandos/utilidades');
const botoes = require('../src/interacoes/botoes');
const fluxo = require('../src/servicos/fluxo');
const partidas = require('../src/servicos/partidas');
const mediadores = require('../src/servicos/mediadores');
const plantaoModalidade = require('../src/servicos/plantaoModalidade');
const plantao = require('../src/servicos/plantao');

const PARTIDA = 'abcdef0123456789abcdef0123456789';
const MEDIADOR = '1543684028719173732';

async function comMocks(pares, fn) {
  const anteriores = [];
  for (const [objeto, mudancas] of pares) {
    for (const [chave, valor] of Object.entries(mudancas)) {
      anteriores.push([objeto, chave, objeto[chave]]);
      objeto[chave] = valor;
    }
  }
  try { return await fn(); }
  finally { for (const [objeto, chave, valor] of anteriores.reverse()) objeto[chave] = valor; }
}

function bancoConfig(store) {
  return { client: { from() {
    let chave;
    const builder = {
      select() { return builder; },
      eq(coluna, valor) { if (coluna === 'chave') chave = valor; return builder; },
      async maybeSingle() { return { data: store[chave] == null ? null : { valor: store[chave] }, error: null }; },
      async upsert(registro) { store[registro.chave] = registro.valor; return { data: null, error: null }; },
    };
    return builder;
  } } };
}

function makeInteraction(customId, fields = {}) {
  const calls = [];
  const interaction = {
    customId, id: 'i', guildId: 'guild-a', channelId: 'ss-channel',
    guild: { id: 'guild-a', channels: { fetch: async () => null } },
    user: { id: 'ss-user', tag: 'ss-user' }, member: { roles: { cache: new Map() } },
    message: { id: 'ss-message', delete: async () => { calls.push(['deleteMessage']); } },
    deferred: false, replied: false, calls,
    options: { getString: (name) => fields[name] ?? null },
    isMessageComponent: () => true,
    deferUpdate: async () => { calls.push(['deferUpdate']); interaction.deferred = true; },
    reply: async (payload) => { calls.push(['reply', payload]); interaction.replied = true; },
    followUp: async (payload) => { calls.push(['followUp', payload]); },
    editReply: async (payload) => { calls.push(['editReply', payload]); },
  };
  return interaction;
}
function output(i) { return i.calls.at(-1)?.[1]; }
function text(i) { return output(i)?.content || output(i)?.embeds?.map((e) => e.toJSON().description).join('\n') || ''; }

for (const [commandName, modalidade] of [['ssmob', 'ss_mobile'], ['ssemu', 'ss_emu']]) {
  test(`/${commandName}: bloqueia usuário sem cargo de mediador`, async () => {
    const command = utilidades.comandos.find((item) => item.data.name === commandName);
    const i = makeInteraction(`/${commandName}`);
    let consultas = 0;
    await comMocks([[partidas, { porCanal: async () => { consultas++; return null; } }]], async () => {
      await command.executar(i, { db: bancoConfig({}) });
    });
    assert.match(text(i), /Somente mediadores/);
    assert.equal(consultas, 0);
  });

  test(`/${commandName}: bloqueia fora de sala AP ou em plataforma incompatível`, async () => {
    const command = utilidades.comandos.find((item) => item.data.name === commandName);
    const i = makeInteraction(`/${commandName}`);
    i.member.roles.cache.set(MEDIADOR, true);
    let partida = null;
    await comMocks([[partidas, { porCanal: async () => partida }]], async () => {
      await command.executar(i, { db: bancoConfig({}) });
      assert.match(text(i), /somente dentro de uma sala de AP ativa/);
      i.calls.length = 0; i.deferred = false; i.replied = false;
      partida = { id: PARTIDA, canal_id: i.channelId, status: 'aguardando_mediador', mediador_id: null,
        modo: modalidade === 'ss_mobile' ? 'x1emu' : 'x1mobile' };
      await command.executar(i, { db: bancoConfig({}) });
      assert.match(text(i), /somente dentro de uma sala de AP ativa/);
    });
  });
}

test('aceite SS exclui pedido, concede acesso individual e a disputa concorrente informa o vencedor', async () => {
  const store = { [fluxo.chavePedidoSS(PARTIDA)]: JSON.stringify({ modalidade: 'ss_mobile', channelId: 'ss-channel', messageId: 'ss-message' }) };
  const db = bancoConfig(store);
  let aceitoPor = null;
  const acesso = [];
  const sala = { guildId: 'guild-a', send: async () => {} };
  const mensagemPedido = { id: 'ss-message', delete: async () => { acesso.push(['pedido-apagado']); } };
  const canalSS = { messages: { fetch: async () => mensagemPedido } };
  const client = { channels: { cache: new Map([['match-channel', sala], ['ss-channel', canalSS]]) } };
  const ss = makeInteraction(`ap:sspedido:ss_mobile:${PARTIDA}`);
  ss.user.id = 'ss-user';
  ss.member.roles.cache.set(plantaoModalidade.MODALIDADES.ss_mobile.cargoAcesso, true);
  ss.message.delete = mensagemPedido.delete;
  const mediador = makeInteraction(`ap:assumirnotificacao:${PARTIDA}`);
  mediador.user.id = 'mediador-user';
  mediador.guild.channels.fetch = async () => sala;
  mediador.message = { id: 'painel-mediador', delete: async () => {} };
  const interacoes = [ss, mediador];
  await comMocks([
    [partidas, {
      buscar: async () => ({ id: PARTIDA, guild_id: 'guild-a', canal_id: 'match-channel', status: aceitoPor ? 'aguardando_pagamento' : 'aguardando_mediador', mediador_id: aceitoPor }),
      assumir: async (_db, id, userId) => {
        assert.equal(id, PARTIDA);
        if (aceitoPor) throw new Error('Partida já assumida.');
        aceitoPor = userId;
        return { id, guild_id: 'guild-a', canal_id: 'match-channel', status: 'aguardando_pagamento', mediador_id: userId };
      },
    }],
    [plantaoModalidade, { ativo: async () => true }],
    [fluxo, {
      removerPainelNotificacao: async () => true,
      atualizarPartida: async () => true,
      concederAcessoPartida: async (_client, _db, id, userId) => { acesso.push(['acesso', id, userId]); return true; },
    }],
    [mediadores, { cargos: async () => [] }],
    [plantao, { autorizado: async () => true, ativo: async () => true }],
    [require('../src/servicos/staffSupabase'), { temCargoMediador: async () => true, obter: async () => ({ pix_chave: 'pix' }) }],
    [require('../src/servicos/auditoria'), { registrar: async () => true }],
  ], async () => {
    // Ambos validam o pedido pendente antes da RPC; a RPC compartilhada decide
    // atomicamente quem assume e o segundo recebe uma resposta explícita.
    const resultados = await Promise.all(interacoes.map((i) => botoes.handleBotao(i, { db, client })));
    assert.deepEqual(resultados, [true, true]);
  });
  assert.ok(aceitoPor === 'ss-user' || aceitoPor === 'mediador-user', JSON.stringify(interacoes.map((i) => i.calls)));
  assert.equal(interacoes.filter((i) => /aceito por você|assumiu a sala/.test(text(i))).length, 1);
  assert.equal(interacoes.filter((i) => /já foi aceita por/.test(text(i))).length, 1);
  assert.equal(acesso.filter(([tipo]) => tipo === 'pedido-apagado').length, 1);
  assert.equal(acesso.filter(([tipo]) => tipo === 'acesso').length, 1);
  assert.equal(store[fluxo.chavePedidoSS(PARTIDA)], null);
});

test('aceite bloqueia quem não está no plantão SS específico para a modalidade', async () => {
  for (const [modalidade, nome, painel] of [
    ['ss_emu', 'SS EMU', '/painelbatepontossemu'],
    ['ss_mobile', 'SS Mobile', '/painelbatepontossmobile'],
  ]) {
    const store = { [fluxo.chavePedidoSS(PARTIDA)]: JSON.stringify({ modalidade, channelId: 'ss-channel', messageId: 'ss-message' }) };
    const i = makeInteraction(`ap:sspedido:${modalidade}:${PARTIDA}`);
    i.member.roles.cache.set(plantaoModalidade.MODALIDADES[modalidade].cargoAcesso, true);
    let tentativasAceite = 0;
    await comMocks([
      [partidas, {
        buscar: async () => ({ id: PARTIDA, guild_id: 'guild-a', canal_id: 'match-channel', status: 'aguardando_mediador', mediador_id: null }),
        assumir: async () => { tentativasAceite++; },
      }],
      [plantaoModalidade, { ativo: async (_db, _guild, _user, consultada) => consultada !== modalidade }],
    ], async () => {
      await botoes.handleBotao(i, { db: bancoConfig(store), client: {} });
    });
    assert.match(text(i), new RegExp(`plantão ${nome}.*${painel}`));
    assert.equal(tentativasAceite, 0, `${modalidade} não deve usar o aceite quando falta seu próprio plantão`);
  }
});

test('fechar sala invalida e apaga a mensagem SS associada antes de apagar o canal', async () => {
  const store = { [fluxo.chavePedidoSS(PARTIDA)]: JSON.stringify({ modalidade: 'ss_emu', channelId: 'ss-channel', messageId: 'ss-message' }) };
  const db = bancoConfig(store);
  let apagouMensagem = 0;
  const canalSala = { guildId: 'guild-a', delete: async () => {} };
  const client = { channels: { cache: new Map([['match-channel', canalSala]]) } };
  const i = makeInteraction(`ap:fechar:${PARTIDA}`);
  i.member.permissions = { has: () => true };
  i.channel = canalSala;
  const setTimeoutOriginal = global.setTimeout;
  global.setTimeout = (callback) => { void callback(); return 0; };
  try {
    await comMocks([[partidas, { buscar: async () => ({ id: PARTIDA, guild_id: 'guild-a', canal_id: 'match-channel' }) }]], async () => {
      await comMocks([[client.channels, { cache: new Map([['ss-channel', {
        messages: { fetch: async () => ({ id: 'ss-message', delete: async () => { apagouMensagem++; } }) },
      }]]) }]], async () => {
        await botoes.handleBotao(i, { db, client });
      });
    });
  } finally { global.setTimeout = setTimeoutOriginal; }
  assert.equal(apagouMensagem, 1);
  assert.equal(store[fluxo.chavePedidoSS(PARTIDA)], null);
});

test('resultado, W.O. e cancelamento removem o pedido SS vinculado', async () => {
  for (const operacao of ['resultado', 'wo', 'cancelamento']) {
    const store = { [fluxo.chavePedidoSS(PARTIDA)]: JSON.stringify({ modalidade: 'ss_emu', channelId: 'ss-channel', messageId: `msg-${operacao}` }) };
    let apagadas = 0;
    const db = bancoConfig(store);
    const client = { channels: { cache: new Map([['ss-channel', { messages: { fetch: async (id) => ({ id, delete: async () => { apagadas++; } }) } }]]) } };
    const partida = { id: PARTIDA, guild_id: 'guild-a', status: 'finalizada' };
    await comMocks([[partidas, {
      buscar: async () => partida,
      finalizar: async () => ({ partida }),
      cancelar: async () => partida,
    }]], async () => {
      if (operacao === 'resultado') await fluxo.encerrarPartida(client, db, { partidaId: PARTIDA, vencedorTime: 1 });
      else if (operacao === 'wo') await fluxo.aplicarWO(client, db, { partidaId: PARTIDA, timeAusente: 2 });
      else await fluxo.cancelarPartida(client, db, { partidaId: PARTIDA, motivo: 'teste' });
    });
    assert.equal(apagadas, 1, `${operacao} deve apagar a mensagem SS`);
    assert.equal(store[fluxo.chavePedidoSS(PARTIDA)], null, `${operacao} deve invalidar o vínculo SS`);
  }
});

test('overwrite de sala nega cargos SS genéricos e permite somente SS que aceitou', async () => {
  const edits = [];
  const channel = { guildId: 'guild-a', permissionOverwrites: { edit: async (id, config) => { edits.push([String(id), config]); } } };
  const client = { channels: { cache: new Map([['match-channel', channel]]) } };
  await comMocks([
    [partidas, {
      buscar: async () => ({ id: PARTIDA, guild_id: 'guild-a', canal_id: 'match-channel' }),
      jogadores: async () => [{ user_id: 'player-a', time: 1 }, { user_id: 'player-b', time: 2 }],
    }],
    [mediadores, { cargos: async () => [] }],
  ], async () => {
    assert.equal(await fluxo.concederAcessoPartida(client, {}, PARTIDA, 'ss-aceitou'), true);
  });
  for (const modalidade of Object.values(plantaoModalidade.MODALIDADES)) {
    for (const cargo of [modalidade.cargoAcesso, modalidade.cargoPlantao]) {
      const deny = edits.find(([id]) => id === cargo)?.[1];
      assert.equal(deny?.ViewChannel, false, `cargo SS ${cargo} deve ficar sem acesso`);
    }
  }
  assert.equal(edits.find(([id]) => id === 'ss-aceitou')?.[1]?.ViewChannel, true);
  assert.equal(edits.find(([id]) => id === 'player-a')?.[1]?.ViewChannel, true);
  assert.equal(edits.find(([id]) => id === 'player-b')?.[1]?.ViewChannel, true);
  assert.equal(edits.some(([id]) => id === 'ss-outro'), false);
});
