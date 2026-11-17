'use strict';

/** Execute com: node --test testes/vendas.js. Nenhuma API real é acionada. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { test, after } = require('node:test');

const fetchOriginal = global.fetch;
global.fetch = async () => { throw new Error('Rede proibida nos testes isolados de vendas.'); };
after(() => { global.fetch = fetchOriginal; });

const mpReal = require('../src/servicos/mercadoPago');
const bloqueado = () => { throw new Error('Dependência remota não simulada.'); };
const modulos = {};
const criarMock = (nome, metodos) => {
  const objeto = Object.fromEntries(metodos.map((metodo) => [metodo, bloqueado]));
  modulos[path.resolve(__dirname, `../src/servicos/${nome}.js`)] = objeto;
  return objeto;
};
const mp = criarMock('mercadoPago', ['exigirAmbiente', 'criarPix', 'buscarPagamento']);
Object.assign(mp, { validarEmailPix: mpReal.validarEmailPix, centavos: mpReal.centavos });
const supabase = criarMock('supabase', ['obterCliente', 'definirConfig']);
const partidas = criarMock('partidas', ['buscar', 'jogadores', 'confirmar', 'assumir', 'marcarPago', 'ativas', 'definirRegras', 'liberarSala']);
const filas = criarMock('filas', ['listar', 'sair']);
const paineis = criarMock('paineis', ['mensagemPreco', 'atualizar']);
const plantao = criarMock('plantao', ['entrar', 'sair', 'painel', 'posicao', 'limpar']);
const mediadores = criarMock('mediadores', ['cargos', 'temCargoMediador', 'podeUsarSalas', 'ehMediador', 'mencoes', 'painelConfig', 'modo', 'definirModo']);
Object.assign(mediadores, { AVISO_CARGO: 'Cargo de mediação exigido.', MODOS: { rodizio: 'Rodízio', fila: 'Fila' } });
const fluxo = criarMock('fluxo', ['entrarNaFila', 'atualizarPartida', 'anunciarPix']);
const staff = criarMock('staffSupabase', ['obter', 'temCargoMediador', 'listar']);
const extratoCarteira = criarMock('extratoCarteira', ['obterExtrato']);
criarMock('auditoria', ['registrar']);
const salas = criarMock('salas', ['criarSalaDaPartida']);
criarMock('royalSupabase', ['girar', 'topPerfis']);

const carregarOriginal = Module._load;
Module._load = function carregarIsolado(request, parent, isMain) {
  const arquivo = Module._resolveFilename(request, parent, isMain);
  return modulos[arquivo] || carregarOriginal.call(this, request, parent, isMain);
};
let vendas;
let compras;
let vendasDb;
let botoes;
let modais;
try {
  vendas = require('../src/comandos/vendas');
  compras = require('../src/servicos/comprasSalas');
  vendasDb = require('../src/servicos/roomSalesSupabase');
  botoes = require('../src/interacoes/botoes');
  modais = require('../src/interacoes/modais');
} finally {
  Module._load = carregarOriginal;
}
const { EFEMERO } = require('../src/util/seguranca');
const config = require('../src/config');
const { reais } = require('../src/util/embeds');
const ctx = { db: {}, client: { channels: { cache: new Map() } } };
const ID_PEDIDO = '550e8400-e29b-41d4-a716-446655440000';
const mensagemEmail = '❌ E-mail inválido. Por favor, insira um endereço de e-mail válido para continuar.';

async function comMocks(alteracoes, executar) {
  const originais = [];
  for (const [objeto, valores] of alteracoes) {
    for (const [chave, valor] of Object.entries(valores)) {
      originais.push([objeto, chave, objeto[chave]]);
      objeto[chave] = valor;
    }
  }
  try { return await executar(); }
  finally { for (const [objeto, chave, valor] of originais.reverse()) objeto[chave] = valor; }
}

function interacao(customId, campos = {}) {
  const chamadas = [];
  const interaction = {
    customId, chamadas, guildId: 'guild-a', guild: { id: 'guild-a' },
    user: { id: 'user-a', tag: 'teste' }, id: 'request-a', deferred: false, replied: false,
    member: { roles: { cache: new Map() }, permissions: { has: () => false } },
    fields: { getTextInputValue: (campo) => campos[campo] ?? '' },
    isMessageComponent: () => !customId.includes('modal'),
    isModalSubmit: () => customId.includes('modal'),
    deferReply: async (payload) => { chamadas.push(['deferReply', payload]); interaction.deferred = true; },
    deferUpdate: async () => { chamadas.push(['deferUpdate']); interaction.deferred = true; },
    reply: async (payload) => { chamadas.push(['reply', payload]); interaction.replied = true; },
    followUp: async (payload) => { chamadas.push(['followUp', payload]); },
    editReply: async (payload) => {
      assert.equal(typeof payload?.then, 'undefined', 'builder deve resolver antes de editReply');
      chamadas.push(['editReply', payload]);
    },
    showModal: async (payload) => { chamadas.push(['showModal', payload]); },
  };
  return interaction;
}
const ultimoPayload = (interaction) => interaction.chamadas.at(-1)?.[1];
const texto = (payload) => payload?.content || payload?.embeds?.map((item) => item.toJSON().description).join('\n') || '';

// O cliente simulado aplica todos os filtros, permitindo testar o isolamento
// real da consulta em roomSalesSupabase sem depender de credenciais.
function clientePedidos(pedidos, consultas) {
  return {
    from(tabela) {
      const filtros = [];
      const query = {
        select(colunas) { consultas.push({ tabela, colunas, filtros }); return query; },
        eq(coluna, valor) { filtros.push([coluna, valor]); return query; },
        async maybeSingle() {
          const data = pedidos.find((pedido) => filtros.every(([coluna, valor]) => String(pedido[coluna]) === valor));
          return { data: data || null, error: null };
        },
      };
      return query;
    },
  };
}

test('painel principal mantém o desenho original e os dois botões originais', () => {
  const card = vendas.embedPainelCompra().toJSON();
  assert.equal(card.title, '⚡ ROYAL SALA · Central de créditos');
  assert.match(card.description, /R\$ 0,03 por sala/);
  assert.match(card.description, /Adquirir Sala/);
  assert.match(card.description, /Ver pacotes de salas/);
  assert.doesNotMatch(card.description, /━{3,}|-{3,}/);
  assert.match(card.description, /automaticamente/);
  assert.equal(card.fields, undefined);
  const componentes = vendas.componentesPainelCompra().flatMap((row) => row.toJSON().components);
  assert.deepEqual(componentes.map((item) => [item.custom_id, item.label]), [
    ['ap:comprar', 'Adquirir Sala'], ['ap:verpacotes', 'Ver pacotes de salas'],
  ]);
  assert.deepEqual(vendas.comandos.map((item) => item.data.name), [
    'painelcomprar', 'comprar', 'setcargo', 'permicompras', 'cupomcompras', 'minhassalas', 'salasreconciliar',
  ]);
});

test('embed de pacotes usa carrinho e contém somente quantidade/total; o select é minimalista e mantém placeholder exato', () => {
  assert.equal(vendas.PRECO_SALA_CENTAVOS, 3);
  assert.deepEqual(vendas.PACOTES_SALAS.map((item) => [item.quantidade, item.totalCentavos]), [
    [1, 3], [5, 15], [10, 30], [20, 60], [50, 150], [100, 300],
  ]);
  const menu = vendas.componentesPacotes()[0].toJSON().components[0];
  assert.equal(menu.custom_id, 'ap:compraspacote');
  assert.equal(menu.placeholder, 'Escolha seu pacote de salas...');
  const cardPacotes = vendas.embedPacotes().toJSON();
  assert.equal(cardPacotes.title, 'Escolha seu pacote');
  assert.equal(cardPacotes.description, 'Selecione a quantidade de salas no menu abaixo para continuar.');
  assert.doesNotMatch(cardPacotes.description, /🛒|R\$|\d+ salas?/);
  assert.equal(cardPacotes.fields, undefined);
  assert.equal(cardPacotes.footer, undefined);
  for (const [i, item] of menu.options.entries()) {
    const pacote = vendas.PACOTES_SALAS[i];
    assert.equal(item.value, String(pacote.quantidade));
    assert.equal(item.label, `🛒 ${pacote.quantidade} ${pacote.quantidade === 1 ? 'sala' : 'salas'} - ${reais(pacote.totalCentavos)}`);
    assert.equal(item.description, undefined);
    assert.equal(item.emoji, undefined);
  }
  assert.deepEqual(menu.options.map((item) => item.label), [
    '🛒 1 sala - R$ 0,03',
    '🛒 5 salas - R$ 0,15',
    '🛒 10 salas - R$ 0,30',
    '🛒 20 salas - R$ 0,60',
    '🛒 50 salas - R$ 1,50',
    '🛒 100 salas - R$ 3,00',
  ]);
});

test('Ver pacotes responde somente com embed e select, sem botões, e agenda exclusão em 30 minutos', async () => {
  const tarefas = [];
  const timeoutOriginal = global.setTimeout;
  global.setTimeout = (callback, atraso) => { tarefas.push({ callback, atraso }); return { unref() {} }; };
  const mensagem = { delete: async () => { mensagem.apagada = true; } };
  const interaction = interacao('ap:verpacotes');
  interaction.followUp = async (payload) => { interaction.chamadas.push(['followUp', payload]); return mensagem; };
  try {
    await botoes.handleBotao(interaction, ctx);
    const payload = ultimoPayload(interaction);
    assert.equal(payload.embeds.length, 1);
    assert.equal(payload.components.length, 1);
    const componentes = payload.components[0].toJSON().components;
    assert.equal(componentes.length, 1);
    assert.equal(componentes[0].type, 3);
    assert.equal(componentes[0].placeholder, 'Escolha seu pacote de salas...');
    assert.equal(payload.flags & EFEMERO, EFEMERO);
    assert.equal(tarefas.length, 1);
    assert.equal(tarefas[0].atraso, 30 * 60 * 1000);
    await tarefas[0].callback();
    assert.equal(mensagem.apagada, true);
  } finally {
    global.setTimeout = timeoutOriginal;
  }
});

test('Gerar Pix abre modal e Sala Infinita responde em painel efêmero sem editar o painel público', async () => {
  const gerarPix = interacao('ap:recargapix');
  await botoes.handleBotao(gerarPix, ctx);
  const modal = gerarPix.chamadas.find(([metodo]) => metodo === 'showModal')?.[1]?.toJSON();
  assert.equal(modal.custom_id, 'ap:modalrecarga');
  assert.equal(modal.title, 'Gerar Pix de Recarga');
  assert.deepEqual(modal.components.flatMap((row) => row.components).map((campo) => campo.custom_id), ['valor', 'email']);

  const salaInfinita = interacao('ap:recargasalainfinita');
  salaInfinita.update = async (payload) => { salaInfinita.chamadas.push(['update', payload]); };
  await botoes.handleBotao(salaInfinita, ctx);
  assert.equal(salaInfinita.chamadas.at(-1)[0], 'reply');
  assert.equal(ultimoPayload(salaInfinita).flags & EFEMERO, EFEMERO);
  assert.equal(ultimoPayload(salaInfinita).embeds[0].toJSON().image.url, 'attachment://sala-infinita-royal-ap.png');
  assert.deepEqual(ultimoPayload(salaInfinita).components.flatMap((row) => row.toJSON().components).map((button) => button.label), [
    'Voltar', 'Semanal R$ 5,00', 'Mensal R$ 13,00',
  ]);

});

test('Extrato abre em privado com imagem Canvas personalizada e botões, sem texto ou embed', async () => {
  let filtro;
  const expiracoes = [];
  const agendarOriginal = vendas.agendarExclusaoPainel;
  const dados = {
    balanceCents: 2510,
    totalEntriesCents: 4000,
    totalExitsCents: 1490,
    status: 'Normal',
    movements: [{ eventType: 'topup', deltaCents: 500, balanceAfterCents: 2510, createdAt: '2026-11-16T18:30:00.000Z' }],
  };
  const extrato = interacao('ap:recargaextrato');
  await comMocks([
    [mediadores, { podeUsarSalas: async () => true }],
    [extratoCarteira, { obterExtrato: async (args) => { filtro = args; return dados; } }],
    [vendas, { agendarExclusaoPainel: (...args) => {
      const timer = agendarOriginal(...args);
      expiracoes.push(timer._idleTimeout);
      return timer;
    } }],
  ], async () => {
    await botoes.handleBotao(extrato, ctx);
    assert.deepEqual(filtro, { guildId: 'guild-a', userId: 'user-a' });
    assert.deepEqual(extrato.chamadas.map(([nome]) => nome), ['deferReply', 'editReply']);
    assert.equal(extrato.chamadas[0][1].flags & EFEMERO, EFEMERO);
    const payload = ultimoPayload(extrato);
    assert.equal(payload.content, '');
    assert.deepEqual(payload.embeds, []);
    assert.equal(payload.files[0].name, 'extrato-royal-ap.png');
    assert.equal(payload.files[0].attachment.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.deepEqual(payload.components.flatMap((row) => row.toJSON().components).map((button) => button.label), ['Voltar', 'Atualizar extrato']);
    assert.deepEqual(expiracoes, [30 * 60 * 1000]);
  });
});

test('Atualizar extrato gera imagem Canvas com dados atuais e membro sem cargo não consulta a carteira', async () => {
  let consultas = 0;
  await comMocks([
    [mediadores, { podeUsarSalas: async () => true }],
    [extratoCarteira, { obterExtrato: async () => { consultas += 1; return { balanceCents: 100, totalEntriesCents: 100, totalExitsCents: 0, status: 'Normal', movements: [] }; } }],
  ], async () => {
    const atualizar = interacao('ap:extratoatualizar');
    atualizar.message = { flags: { has: (flag) => flag === EFEMERO } };
    await botoes.handleBotao(atualizar, ctx);
    assert.deepEqual(atualizar.chamadas.map(([nome]) => nome), ['deferUpdate', 'editReply']);
    assert.equal(consultas, 1);
  });

  await comMocks([
    [mediadores, { podeUsarSalas: async () => false, AVISO_CARGO: 'Cargo autorizado necessário.' }],
    [extratoCarteira, { obterExtrato: async () => { consultas += 1; throw new Error('não deveria consultar'); } }],
  ], async () => {
    const negar = interacao('ap:recargaextrato');
    await botoes.handleBotao(negar, ctx);
    assert.deepEqual(negar.chamadas.map(([nome]) => nome), ['deferReply', 'editReply']);
    assert.match(texto(ultimoPayload(negar)), /Cargo autorizado necessário/);
    assert.equal(consultas, 1);
  });
});

test('Voltar do Extrato restaura o painel de recarga somente na mensagem efêmera do autor', async () => {
  const voltar = interacao('ap:extratovoltar');
  voltar.update = async (payload) => { voltar.chamadas.push(['update', payload]); };
  voltar.message = { flags: { has: (flag) => flag === EFEMERO } };
  await botoes.handleBotao(voltar, ctx);
  assert.deepEqual(voltar.chamadas.map(([nome]) => nome), ['update']);
  const payload = ultimoPayload(voltar);
  assert.equal(payload.embeds[0].toJSON().image.url, 'attachment://recarga-royal-ap.jpg');
  assert.deepEqual(payload.components.flatMap((row) => row.toJSON().components).map((button) => button.label), [
    'Gerar Pix', 'Sala Infinita', 'Extrato',
  ]);
});

test('validador compartilhado aceita endereços comuns e rejeita estruturas inválidas', () => {
  const validos = ['a@b.com', 'jogador@example.com', 'Nome.Sobrenome+ap@gmail.com', 'nome_123@sub.exemplo.com.br', 'nome-ap@meu-dominio.org', ' contato@example.com '];
  const invalidos = ['', 'sem-arroba.com', '@example.com', 'nome@', 'nome@@example.com',
    '.nome@example.com', 'nome.@example.com', 'nome..duplo@example.com', 'nome @example.com',
    'nome@example..com', 'nome@-example.com', 'nome@example-.com', 'nome@exemplo.c',
    'nome@exemplo.123', 'nome@localhost', 'nome@exa_mple.com', 'nome@exam\nple.com',
    `${'n'.repeat(65)}@example.com`, `nome@${'d'.repeat(64)}.com`, `nome@${'d'.repeat(250)}.com`];
  for (const email of validos) assert.equal(compras.validarEmailPix(email), true, email);
  for (const email of invalidos) assert.equal(compras.validarEmailPix(email), false, email);
  for (const email of [...validos, ...invalidos]) assert.equal(compras.validarEmailPix(email), mpReal.validarEmailPix(email));
});

test('e-mail inválido responde com texto exato antes do defer e de toda operação remota', async () => {
  for (const customId of ['ap:modalcompra:custom', 'ap:modalcompra:10']) {
    const interaction = interacao(customId, { email: 'nome..invalido@example.com', quantidade: '5' });
    // Os métodos remotos ainda estão bloqueados; sequer as permissões podem ser consultadas.
    assert.equal(await modais.handleModal(interaction, ctx), true);
    assert.deepEqual(interaction.chamadas.map(([metodo]) => metodo), ['reply']);
    assert.equal(ultimoPayload(interaction).content, mensagemEmail);
    assert.equal(ultimoPayload(interaction).flags & EFEMERO, EFEMERO);
  }
});

test('serviço também rejeita e-mail antes de exigir ambiente, criar pedido ou Pix', async () => {
  await assert.rejects(compras.criarPedidoPix({ guildId: 'guild-a', userId: 'user-a', requestId: 'request-a', quantity: 5, payerEmail: 'invalido' }), (erro) => erro.message === mensagemEmail);
});

test('serviço mantém normalização e vinculação do pagamento sem mudar preço ou cupom', async () => {
  const ordem = [];
  const pedido = { id: ID_PEDIDO, rooms_quantity: 5, amount_cents: 14, status: 'creating' };
  const pagamento = { id: '123456', status: 'pending', qrCode: '000201TESTE', qrBase64: 'cXI=', ticketUrl: null, expiresAt: '2026-12-01T00:00:00.000Z' };
  await comMocks([
    [mp, { exigirAmbiente: () => { ordem.push('ambiente'); }, criarPix: async (args) => {
      ordem.push('pix');
      assert.equal(args.order, pedido);
      assert.equal(args.payerEmail, 'nome+ap@example.com');
      return pagamento;
    } }],
    [vendasDb, { criarPedido: async (args) => {
      ordem.push('pedido');
      assert.deepEqual(args, { guildId: 'guild-a', userId: 'user-a', requestId: 'request-a', quantity: 5, couponCode: 'ROYAL10', payerEmail: 'nome+ap@example.com' });
      return pedido;
    }, anexarPagamento: async (args) => {
      ordem.push('vincular');
      assert.deepEqual(args, { orderId: ID_PEDIDO, paymentId: '123456', qrCode: '000201TESTE', qrBase64: 'cXI=', ticketUrl: null, expiresAt: pagamento.expiresAt });
    } }],
  ], async () => {
    const resultado = await compras.criarPedidoPix({ guildId: 'guild-a', userId: 'user-a', requestId: 'request-a', quantity: 5, couponCode: 'ROYAL10', payerEmail: ' Nome+AP@Example.com ' });
    assert.equal(resultado.order.amount_cents, 14);
    assert.equal(resultado.order.status, 'pending');
    assert.equal(resultado.payment, pagamento);
    assert.deepEqual(ordem, ['ambiente', 'pedido', 'pix', 'vincular']);
  });
});

test('pedido Pix já vinculado é reutilizado e quantidade continua limitada a 1–1000', async () => {
  await comMocks([
    [mp, { exigirAmbiente: () => {} }],
    [vendasDb, { criarPedido: async () => ({ id: ID_PEDIDO, status: 'pending', mp_payment_id: '123456', pix_copy_paste: '000201TESTE' }) }],
  ], async () => {
    const args = { guildId: 'guild-a', userId: 'user-a', requestId: 'request-a', payerEmail: 'nome@example.com' };
    for (const quantity of [1, 1000]) {
      const resultado = await compras.criarPedidoPix({ ...args, quantity });
      assert.equal(resultado.payment.id, '123456');
      assert.equal(resultado.payment.qrCode, '000201TESTE');
    }
    for (const quantity of [0, -1, 1.5, 1001]) {
      await assert.rejects(compras.criarPedidoPix({ ...args, quantity }), /inteiro entre 1 e 1\.000/);
    }
  });
});

test('compra válida preserva quantidade e cupom, defer privado e somente botão Copia e Cola', async () => {
  const interaction = interacao('ap:modalcompra:custom', { email: 'nome+ap@example.com', quantidade: '5', cupom: 'ROYAL10' });
  await comMocks([
    [vendas, { exigirCargoCompra: async () => { assert.equal(interaction.chamadas[0][0], 'deferReply'); return true; } }],
    [compras, { criarPedidoPix: async (args) => {
      assert.deepEqual(args, { guildId: 'guild-a', userId: 'user-a', requestId: 'request-a', quantity: 5, couponCode: 'ROYAL10', payerEmail: 'nome+ap@example.com' });
      return { order: { id: ID_PEDIDO, rooms_quantity: 5, amount_cents: 14, discount_cents: 1, status: 'pending' }, payment: { qrBase64: Buffer.from('qr-simulado').toString('base64'), ticketUrl: 'https://link-externo.invalid' } };
    } }],
  ], async () => {
    assert.equal(await modais.handleModal(interaction, ctx) !== false, true);
    const payload = ultimoPayload(interaction);
    assert.equal(interaction.chamadas[0][1].flags & EFEMERO, EFEMERO);
    assert.equal(interaction.chamadas.at(-1)[0], 'editReply');
    const componentes = payload.components.flatMap((row) => row.toJSON().components);
    assert.equal(componentes.length, 2);
    assert.equal(componentes[0].custom_id, `ap:copiarpix:${ID_PEDIDO}`);
    assert.equal(`${componentes[0].emoji.name} ${componentes[0].label}`, '📋 Copia e Cola');
    assert.equal(componentes[0].url, undefined);
    assert.equal(componentes[1].custom_id, `ap:verificarcompra:${ID_PEDIDO}`);
    assert.equal(componentes[1].label, 'Verificar pagamento');
    assert.equal(JSON.stringify(payload.embeds).includes('link-externo'), false);
    assert.match(payload.embeds[0].toJSON().description, /R\$ 0,14/);
    assert.equal(payload.files.length, 1);
  });
});

test('saldo aprovado imediatamente não pede novo Pix e usa texto singular/plural exato', async () => {
  for (const quantidade of [1, 5]) {
    const esperado = `✅ Pagamento aprovado! O saldo de ${quantidade} ${quantidade === 1 ? 'sala' : 'salas'} já caiu na sua conta para criar salas. Use /minhassalas para ver suas salas.`;
    assert.equal(compras.textoPagamentoAprovado(quantidade), esperado);
    assert.equal(botoes.textoPagamentoAprovado(quantidade), esperado);
    const interaction = interacao(`ap:modalcompra:${quantidade}`, { email: 'jogador@example.com' });
    await comMocks([
      [vendas, { exigirCargoCompra: async () => true }],
      [compras, { criarPedidoPix: async () => ({ order: { status: 'approved', rooms_quantity: quantidade }, payment: {} }) }],
    ], async () => {
      await modais.handleModal(interaction, ctx);
      assert.equal(ultimoPayload(interaction).content, esperado);
      assert.equal(ultimoPayload(interaction).components, undefined);
    });
  }
});

test('handler antigo de verificação permanece compatível com pagamentos pendentes/aprovados', async () => {
  for (const status of ['pending', 'approved']) {
    const interaction = interacao(`ap:verificarcompra:${ID_PEDIDO}`);
    await comMocks([[compras, { verificarPedido: async (args) => {
      assert.deepEqual(args, { orderId: ID_PEDIDO, guildId: 'guild-a', userId: 'user-a' });
      return { status, rooms_quantity: 1 };
    } }]], async () => {
      await botoes.handleBotao(interaction, ctx);
      assert.equal(ultimoPayload(interaction).flags & EFEMERO, EFEMERO);
      assert.match(texto(ultimoPayload(interaction)), status === 'approved' ? /O saldo de 1 sala já caiu/ : /ainda não aprovado/);
    });
  }
});

test('Copia e Cola consulta pedido por ID, guild e dono e entrega somente o código bruto em bloco efêmero', async () => {
  const pedidos = [{ id: ID_PEDIDO, guild_id: 'guild-a', user_id: 'user-a', pix_copy_paste: '000201CODIGO_PIX_TESTE', status: 'pending' }];
  const consultas = [];
  await comMocks([[supabase, { obterCliente: () => clientePedidos(pedidos, consultas) }]], async () => {
    const interaction = interacao(`ap:copiarpix:${ID_PEDIDO}`);
    await botoes.handleBotao(interaction, ctx);
    assert.equal(ultimoPayload(interaction).content, '```\n000201CODIGO_PIX_TESTE\n```');
    assert.equal(ultimoPayload(interaction).flags & EFEMERO, EFEMERO);
    assert.deepEqual(consultas[0].filtros, [['id', ID_PEDIDO], ['guild_id', 'guild-a'], ['user_id', 'user-a']]);
    for (const alteracao of [{ user: { id: 'user-b' } }, { guildId: 'guild-b' }]) {
      const negada = Object.assign(interacao(`ap:copiarpix:${ID_PEDIDO}`), alteracao);
      await botoes.handleBotao(negada, ctx);
      assert.equal(texto(ultimoPayload(negada)).includes('000201CODIGO_PIX_TESTE'), false);
      assert.equal(ultimoPayload(negada).flags & EFEMERO, EFEMERO);
    }
  });
});

test('Copia e Cola sanitiza quebra de bloco e limita tamanho seguro', async () => {
  for (const codigo of ['00`01\r\n02', 'a'.repeat(1701)]) {
    await comMocks([[vendasDb, { obterPixPedidoUsuario: async () => ({ pix_copy_paste: codigo }) }]], async () => {
      const interaction = interacao(`ap:copiarpix:${ID_PEDIDO}`);
      await botoes.handleBotao(interaction, ctx);
      const payload = ultimoPayload(interaction);
      if (codigo.length > 1700) assert.match(texto(payload), /limite seguro/);
      else assert.equal(payload.content, '```\n000102\n```');
      assert.equal(payload.flags & EFEMERO, EFEMERO);
    });
  }
});

test('/comprar expira em 30 minutos e /painelcomprar fixa no canal atual e salva a configuração Supabase', async () => {
  const tarefas = [];
  const timeoutOriginal = global.setTimeout;
  global.setTimeout = (callback, atraso) => { tarefas.push({ callback, atraso }); return { unref() {} }; };
  const temporaria = { delete: async () => { temporaria.apagada = true; } };
  let fixado = false;
  const permanente = { pin: async () => { fixado = true; } };
  const interaction = interacao('comando');
  interaction.editReply = async (payload) => { interaction.chamadas.push(['editReply', payload]); return temporaria; };
  interaction.deleteReply = async () => { temporaria.apagada = true; };
  interaction.guild.ownerId = interaction.user.id;
  let enviadoNoCanal = false;
  interaction.channel = {
    id: 'canal-atual', guildId: 'guild-a',
    send: async (payload) => {
      enviadoNoCanal = true;
      assert.equal(payload.embeds[0].toJSON().title, '⚡ ROYAL SALA · Central de créditos');
      assert.deepEqual(payload.components[0].toJSON().components.map((item) => item.label), ['Adquirir Sala', 'Ver pacotes de salas']);
      return permanente;
    },
  };
  let configSalva;
  try {
    await comMocks([
      [vendasDb, {
        obterConfiguracao: async () => ({ allowed_role_ids: ['role-a'], panel_channel_id: 'canal-anterior' }),
        salvarConfiguracao: async (args) => { configSalva = args; },
      }],
    ], async () => {
      interaction.member.roles.cache.set('role-a', {});
      await vendas.comandos.find((item) => item.data.name === 'comprar').executar(interaction);
      assert.equal(tarefas.length, 1);
      assert.equal(tarefas[0].atraso, 30 * 60 * 1000);
      assert.equal(interaction.chamadas.at(-1)[1].embeds[0].toJSON().title, '⚡ ROYAL SALA · Central de créditos');
      await vendas.comandos.find((item) => item.data.name === 'painelcomprar').executar(interaction);
      assert.equal(tarefas.length, 1);
      assert.equal(enviadoNoCanal, true);
      assert.equal(fixado, true);
      assert.deepEqual(configSalva, { guildId: 'guild-a', roleIds: ['role-a'], channelId: 'canal-atual', actorId: 'user-a' });
      await tarefas[0].callback();
      assert.equal(temporaria.apagada, true);
      assert.equal(fixado, true);
      assert.match(texto(ultimoPayload(interaction)), /registrado com sucesso no Supabase/);
    });
  } finally { global.setTimeout = timeoutOriginal; }
});

test('exclusão temporária tolera Discord Unknown Message sem log', async () => {
  let callback;
  const avisos = [];
  const original = console.warn;
  console.warn = (...args) => avisos.push(args);
  try {
    vendas.agendarExclusaoPainel({ delete: async () => { throw Object.assign(new Error('Unknown Message'), { code: 10008 }); } }, (fn, atraso) => {
      callback = fn;
      assert.equal(atraso, 30 * 60 * 1000);
      return { unref() {} };
    });
    callback();
    await Promise.resolve();
    assert.equal(avisos.length, 0);
  } finally { console.warn = original; }
});

test('/minhassalas e Ver meu Painel liberam somente os próprios dados a qualquer comprador', async () => {
  const dados = { available_rooms: 3, purchased_rooms_total: 5, reserved_rooms: 1, created_today: 2, created_total: 9, approved_purchase_count: 2, pending_usages: [] };
  const interaction = interacao('comando');
  let identidade;
  await comMocks([
    [vendasDb, { estatisticasSalas: async (guildId, userId) => { identidade = { guildId, userId }; return dados; } }],
  ], async () => {
    await vendas.comandos.find((item) => item.data.name === 'minhassalas').executar(interaction);
    assert.deepEqual(identidade, { guildId: 'guild-a', userId: 'user-a' });
    assert.equal(ultimoPayload(interaction).embeds[0].toJSON().fields[0].name, 'SALAS DISPONÍVEIS');
    assert.equal(ultimoPayload(interaction).embeds[0].toJSON().fields[0].value, '**3**');
    const botao = interacao('ap:meupainel');
    await botoes.handleBotao(botao, ctx);
    assert.deepEqual(identidade, { guildId: 'guild-a', userId: 'user-a' });
    assert.equal(ultimoPayload(botao).embeds[0].toJSON().fields[0].name, 'SALAS DISPONÍVEIS');
    assert.equal(ultimoPayload(botao).flags & EFEMERO, EFEMERO);
  });
});

test('/setcargo atribui cargo a humanos e bots e informa resultados agregados', async () => {
  const atribuicoes = [];
  const criador = (id, bot, jaTem = false) => ({
    id, user: { bot },
    roles: { cache: new Map(jaTem ? [['role-all', {}]] : []), add: async () => { atribuicoes.push(id); } },
  });
  const membros = new Map([
    ['human', criador('human', false)], ['bot', criador('bot', true)], ['existing', criador('existing', false, true)],
  ]);
  const cargo = { id: 'role-all', name: 'Equipe', position: 2, managed: false, guild: { id: 'guild-a' }, toString: () => '<@&role-all>' };
  const interaction = interacao('comando');
  interaction.guild = { id: 'guild-a', ownerId: 'someone-else', members: { me: { roles: { highest: { position: 10 } } }, fetch: async () => membros } };
  interaction.memberPermissions = { has: () => true };
  interaction.options = { getRole: () => cargo };
  await vendas.comandos.find((item) => item.data.name === 'setcargo').executar(interaction);
  assert.deepEqual(atribuicoes, ['human', 'bot']);
  assert.match(texto(ultimoPayload(interaction)), /Atribuído:\*\* 2/);
  assert.match(texto(ultimoPayload(interaction)), /Já possuíam:\*\* 1/);
  assert.match(texto(ultimoPayload(interaction)), /Total verificado:\*\* 3/);
});

test('plantão e modo de mediação aguardam consultas, mutações e builders async', async () => {
  const painel = { content: 'Painel atualizado' };
  let modoDefinido;
  await comMocks([
    [mediadores, { cargos: async () => ['med-a'], temCargoMediador: async () => true, painelConfig: async () => painel, modo: async () => 'rodizio', definirModo: async (_db, _guild, modo) => { modoDefinido = modo; } }],
    [plantao, { entrar: async () => {}, sair: async () => false, painel: async () => painel, posicao: async () => 3, limpar: async () => 2 }],
    [supabase, { definirConfig: async () => {} }],
  ], async () => {
    for (const acao of ['plantaoentrar', 'plantaosair', 'plantaostatus', 'medlimpar', 'medmodo', 'medreenviar']) {
      const interaction = interacao(`ap:${acao}`);
      interaction.member.permissions.has = () => true;
      interaction.channel = { send: async (payload) => assert.equal(payload, painel) };
      await botoes.handleBotao(interaction, ctx);
      if (acao === 'plantaoentrar') assert.match(texto(ultimoPayload(interaction)), /posição 3/);
      if (acao === 'plantaosair') assert.match(texto(ultimoPayload(interaction)), /não estava no plantão/);
      if (acao === 'medlimpar') assert.match(texto(ultimoPayload(interaction)), /2 mediador/);
      if (acao === 'medmodo') assert.equal(modoDefinido, 'fila');
      for (const [metodo, payload] of interaction.chamadas) if (metodo === 'editReply') assert.equal(payload, painel);
    }
  });
});

test('plantão e criação de sala não tratam Promise de autorização false como true', async () => {
  await comMocks([
    [mediadores, { cargos: async () => ['med-a'], temCargoMediador: async () => false, ehMediador: async () => false }],
    [partidas, { buscar: async () => ({ mediador_id: 'user-a' }) }],
  ], async () => {
    for (const acao of ['plantaoentrar', 'criarsala:partida-a']) {
      const interaction = interacao(`ap:${acao}`);
      await botoes.handleBotao(interaction, ctx);
      assert.match(texto(ultimoPayload(interaction)), /cargos configurados|Só o mediador/);
    }
  });
});

test('confirmação aguarda lista async de jogadores e menções antes do aviso público', async () => {
  let aviso;
  const canal = { send: async (payload) => { aviso = payload; } };
  await comMocks([
    [partidas, { confirmar: async () => ({ partida: { canal_id: 'canal-a', guild_id: 'guild-a' }, completo: false, confirmados: 1, total: 2 }), jogadores: async () => [{ confirmou: 1, user_id: 'user-a' }, { confirmou: 0, user_id: 'user-b' }] }],
    [fluxo, { atualizarPartida: async () => {} }],
    [mediadores, { mencoes: async () => ['med-a'] }],
  ], async () => {
    const interaction = interacao('ap:confirmar:partida-a');
    await botoes.handleBotao(interaction, { db: {}, client: { channels: { cache: new Map([['canal-a', canal]]) } } });
    assert.match(aviso.content, /user-b/);
    assert.deepEqual(aviso.allowedMentions.roles, ['med-a']);
    assert.match(texto(ultimoPayload(interaction)), /1\/2/);
  });
});

test('saída de fila aguarda retorno false e não atualiza painéis indevidamente', async () => {
  await comMocks([[filas, { sair: async () => 0 }]], async () => {
    const interaction = interacao('ap:sair:x1mobile:50');
    await botoes.handleBotao(interaction, ctx);
    assert.match(texto(ultimoPayload(interaction)), /não está nessa fila/);
  });
});

test('modais de regras e sala aguardam consulta/mutação antes de construir e atualizar', async () => {
  const ordem = [];
  await comMocks([
    [partidas, { buscar: async () => ({ id: 'partida-a' }), jogadores: async () => [{ user_id: 'user-a' }], definirRegras: async () => { ordem.push('regras'); }, liberarSala: async () => { ordem.push('sala'); } }],
    [fluxo, { atualizarPartida: async () => { ordem.push('atualizar'); } }],
  ], async () => {
    const abrir = interacao('ap:regras:partida-a');
    await modais.abrirModalRegras(abrir, {}, 'partida-a');
    assert.equal(abrir.chamadas.at(-1)[0], 'showModal');
    const abrirSala = interacao('ap:liberar:partida-a');
    abrirSala.member.permissions.has = () => true;
    await modais.abrirModalSala(abrirSala, {}, 'partida-a');
    assert.equal(abrirSala.chamadas.at(-1)[0], 'showModal');
    const regra = interacao('ap:modalregras:partida-a', { regra: 'Regra combinada' });
    await modais.handleModal(regra, ctx);
    const sala = interacao('ap:modalsala:partida-a', { sala_id: '12345', sala_senha: 'senha' });
    sala.member.permissions.has = () => true;
    await modais.handleModal(sala, ctx);
    assert.deepEqual(ordem, ['regras', 'atualizar', 'sala', 'atualizar']);
  });
});

test('todas as chamadas operacionais destes arquivos são diretamente aguardadas', () => {
  const arquivos = ['src/comandos/vendas.js', 'src/servicos/comprasSalas.js', 'src/interacoes/botoes.js', 'src/interacoes/modais.js', 'src/servicos/roomSalesSupabase.js'];
  const chamadas = /\b(?:(?:filas|partidas|plantao|mediadores|paineis|blacklist|telagem)\.\w+|(?:staff|usuarios)\.obterOuCriar|(?:persistenciaSupabase\.)?(?:obterConfig|definirConfig))\s*\(/g;
  for (const arquivo of arquivos) {
    const fonte = fs.readFileSync(path.resolve(__dirname, '..', arquivo), 'utf8');
    for (const match of fonte.matchAll(chamadas)) {
      assert.match(fonte.slice(Math.max(0, match.index - 20), match.index), /await\s*$/, `${arquivo}: chamada sem await: ${match[0]}`);
    }
  }
});
