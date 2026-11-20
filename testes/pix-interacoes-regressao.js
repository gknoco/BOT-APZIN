'use strict';

// Execute com: node --test testes/pix-interacoes-regressao.js. Sem rede real.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { crc16Ccitt, montarTLV } = require('../src/servicos/pixPayload');
const mp = require('../src/servicos/mercadoPago');
const compras = require('../src/servicos/comprasSalas');
const vendasDb = require('../src/servicos/roomSalesSupabase');
const infinita = require('../src/servicos/salaInfinita');
const infinitaDb = require('../src/servicos/salaInfinitaSupabase');
const recargas = require('../src/servicos/recargas');
const mediadores = require('../src/servicos/mediadores');
const plantaoModalidade = require('../src/servicos/plantaoModalidade');
const vendasUI = require('../src/comandos/vendas');
const botoes = require('../src/interacoes/botoes');
const modais = require('../src/interacoes/modais');

const ID = '550e8400-e29b-41d4-a716-446655440000';
const ctx = { db: {}, client: {} };
const pagamento = { id: '123456', status: 'pending', qrCode: '000201PIX', qrBase64: Buffer.from('QR').toString('base64') };
const pedido = { id: ID, guild_id: 'guild-a', user_id: 'user-a', status: 'creating', amount_cents: 500, rooms_quantity: 5 };

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

function interacao(customId, fields = {}) {
  const calls = [];
  const interaction = {
    customId, id: 'request-a', guildId: 'guild-a', guild: { id: 'guild-a' },
    user: { id: 'user-a' }, member: { roles: { cache: new Map() } },
    fields: { getTextInputValue: (key) => fields[key] ?? '' },
    deferred: false, replied: false, calls,
    isMessageComponent: () => !customId.includes('modal'),
    deferUpdate: async () => { calls.push(['deferUpdate']); interaction.deferred = true; },
    deferReply: async (payload) => { calls.push(['deferReply', payload]); interaction.deferred = true; },
    reply: async (payload) => { calls.push(['reply', payload]); interaction.replied = true; },
    followUp: async (payload) => { calls.push(['followUp', payload]); },
    editReply: async (payload) => { calls.push(['editReply', payload]); },
    showModal: async (payload) => { calls.push(['showModal', payload]); },
  };
  return interaction;
}
const resposta = (i) => i.calls.at(-1)?.[1];
const texto = (p) => p?.content || p?.embeds?.map((e) => e.toJSON().description).join('\n') || '';
function brCode(nome = 'ROYAL AP') {
  const conta = montarTLV('00', 'BR.GOV.BCB.PIX') + montarTLV('01', 'pix@example.com');
  const semCrc = montarTLV('00', '01') + montarTLV('26', conta) + montarTLV('59', nome) + montarTLV('60', 'SAO PAULO') + '6304';
  return semCrc + crc16Ccitt(semCrc);
}

const variantes = [
  ['copiarpix', vendasDb, 'obterPixPedidoUsuario', (s) => ({ pix_copy_paste: s }), 'orderId'],
  ['copiarrecarga', recargas, 'codigoPixUsuario', (s) => s, 'topupId'],
  ['copiarinfinita', infinita, 'codigoPixUsuario', (s) => s, 'orderId'],
];

for (const [acao, servico, metodo, retorno, idCampo] of variantes) {
  test(`${acao}: EMV com espaços e CRC é entregue byte a byte em mensagem privada`, async () => {
    const codigo = brCode();
    assert.match(codigo, /ROYAL AP/);
    assert.equal(codigo.slice(-4), crc16Ccitt(codigo.slice(0, -4)));
    let consulta;
    await comMocks([[servico, { [metodo]: async (args) => { consulta = args; return retorno(codigo); } }]], async () => {
      const i = interacao(`ap:${acao}:${ID}`);
      await botoes.handleBotao(i, ctx);
      const out = resposta(i);
      assert.deepEqual(consulta, { [idCampo]: ID, guildId: 'guild-a', userId: 'user-a' });
      assert.deepEqual(Buffer.from(out.content), Buffer.from(codigo));
      assert.equal(out.files[0].name, 'pix-copia-e-cola.txt');
      assert.deepEqual(out.files[0].attachment, Buffer.from(codigo, 'utf8'));
      assert.deepEqual(out.allowedMentions, { parse: [] });
      assert.equal(out.flags & 64, 64);
    });
  });

  test(`${acao}: não remove espaços, quebras, acentos, crases ou menções`, async () => {
    const codigo = ' 00`01\r\n@everyone  AÇÚCAR ';
    await comMocks([[servico, { [metodo]: async () => retorno(codigo) }]], async () => {
      const i = interacao(`ap:${acao}:${ID}`);
      await botoes.handleBotao(i, ctx);
      assert.deepEqual(Buffer.from(resposta(i).content), Buffer.from(codigo));
      assert.deepEqual(resposta(i).allowedMentions, { parse: [] });
    });
  });

  test(`${acao}: código acima do limite Discord é entregue íntegro em arquivo privado`, async () => {
    const codigo = `${brCode()}${'a'.repeat(2001)} @everyone \` fim`;
    await comMocks([[servico, { [metodo]: async () => retorno(codigo) }]], async () => {
      const i = interacao(`ap:${acao}:${ID}`);
      await botoes.handleBotao(i, ctx);
      const out = resposta(i);
      assert.match(out.content, /limite seguro/);
      assert.equal(out.files[0].name, 'pix-copia-e-cola.txt');
      assert.deepEqual(out.files[0].attachment, Buffer.from(codigo, 'utf8'));
      assert.equal(out.flags & 64, 64);
      assert.deepEqual(out.allowedMentions, { parse: [] });
    });
  });

  test(`${acao}: não consulta fora do servidor nem revela código de outro usuário`, async () => {
    let consultas = 0;
    await comMocks([[servico, { [metodo]: async ({ guildId, userId }) => {
      consultas += 1;
      return guildId === 'guild-a' && userId === 'user-a' ? retorno(brCode()) : null;
    } }]], async () => {
      const dm = interacao(`ap:${acao}:${ID}`); dm.guildId = null;
      await botoes.handleBotao(dm, ctx);
      assert.equal(consultas, 0);
      assert.match(texto(resposta(dm)), /servidor/);
      for (const alteracao of [{ guildId: 'guild-b' }, { user: { id: 'user-b' } }]) {
        const i = Object.assign(interacao(`ap:${acao}:${ID}`), alteracao);
        await botoes.handleBotao(i, ctx);
        assert.match(texto(resposta(i)), /Não encontrei/);
        assert.doesNotMatch(texto(resposta(i)), /ROYAL AP/);
      }
    });
  });
}

test('plano aprovado imediatamente consulta o pagamento completo antes de creditar', async () => {
  let buscou, aplicado;
  const full = { id: '123456', status: 'approved', transaction_amount: 5, currency_id: 'BRL', payment_method_id: 'pix', external_reference: ID };
  await comMocks([
    [mp, { exigirAmbiente: () => {}, criarPix: async () => ({ ...pagamento, status: 'approved' }), buscarPagamento: async (id) => { buscou = id; return full; } }],
    [infinitaDb, { criarPedido: async () => ({ ...pedido }), anexarPagamento: async () => ({ ...pedido, mp_payment_id: '123456', status: 'pending' }), aplicarPagamento: async (args) => { aplicado = args; return { ...pedido, status: 'approved' }; } }],
  ], async () => {
    const result = await infinita.criarPixPlano({ guildId: 'guild-a', userId: 'user-a', requestId: 'r', plan: 'semanal', payerEmail: 'a@b.com' });
    assert.equal(buscou, '123456');
    assert.equal(aplicado.status, 'approved');
    assert.equal(aplicado.amountCents, 500);
    assert.equal(aplicado.externalReference, ID);
    assert.equal(result.order.status, 'approved');
  });
});

test('plano de aprovação imediata divergente não libera a assinatura', async () => {
  let status;
  await comMocks([
    [mp, { exigirAmbiente: () => {}, criarPix: async () => ({ ...pagamento, status: 'approved' }), buscarPagamento: async () => ({ id: '123456', status: 'approved', transaction_amount: 4, currency_id: 'BRL', payment_method_id: 'pix', external_reference: ID }) }],
    [infinitaDb, { criarPedido: async () => ({ ...pedido }), anexarPagamento: async () => ({ ...pedido, mp_payment_id: '123456', status: 'pending' }), aplicarPagamento: async (args) => { status = args.status; return { ...pedido, status: args.status }; } }],
  ], async () => {
    const result = await infinita.criarPixPlano({ guildId: 'guild-a', userId: 'user-a', requestId: 'r', plan: 'semanal', payerEmail: 'a@b.com' });
    assert.equal(status, 'manual_review');
    assert.equal(result.order.status, 'manual_review');
  });
});

for (const [nome, servico, banco, criar, falhar, args] of [
  ['salas', compras, vendasDb, 'criarPedido', 'marcarFalhaPedido', { guildId: 'guild-a', userId: 'user-a', requestId: 'r', quantity: 5, payerEmail: 'a@b.com' }],
  ['plano', infinita, infinitaDb, 'criarPedido', 'marcarFalha', { guildId: 'guild-a', userId: 'user-a', requestId: 'r', plan: 'semanal', payerEmail: 'a@b.com' }],
]) {
  test(`${nome}: falha definitiva após criar Pix permanece em revisão, nunca autoriza repetir`, async () => {
    let falha;
    const executar = nome === 'salas' ? servico.criarPedidoPix : servico.criarPixPlano;
    await comMocks([
      [mp, { exigirAmbiente: () => {}, criarPix: async () => pagamento }],
      [banco, { [criar]: async () => ({ ...pedido }), anexarPagamento: async () => { throw Object.assign(new Error('falha de persistência'), { definitive: true }); }, [falhar]: async (args) => { falha = args; } }],
      [console, { error: () => {} }],
    ], async () => {
      await assert.rejects(executar(args), /incerto/i);
      assert.equal(falha.status, 'manual_review');
    });
  });

  test(`${nome}: nunca reapresenta Pix de solicitação já revisada ou encerrada`, async () => {
    const executar = nome === 'salas' ? servico.criarPedidoPix : servico.criarPixPlano;
    for (const status of ['manual_review', 'failed', 'rejected', 'cancelled', 'expired', 'refunded', 'charged_back']) {
      let chamadasPix = 0;
      await comMocks([
        [mp, { exigirAmbiente: () => {}, criarPix: async () => { chamadasPix += 1; return pagamento; } }],
        [banco, { [criar]: async () => ({ ...pedido, status, mp_payment_id: '123456', pix_copy_paste: 'pix', pix_qr_base64: 'cXI=' }) }],
      ], async () => {
        await assert.rejects(executar(args));
        assert.equal(chamadasPix, 0);
      });
    }
  });
}

test('status atualizado no anexo de compra é respeitado, mesmo se aprovação concorrer', async () => {
  const order = { ...pedido, status: 'approved' };
  await comMocks([
    [mp, { exigirAmbiente: () => {}, criarPix: async () => pagamento }],
    [vendasDb, { criarPedido: async () => ({ ...pedido }), anexarPagamento: async () => order }],
  ], async () => {
    const resultado = await compras.criarPedidoPix({ guildId: 'guild-a', userId: 'user-a', requestId: 'r', quantity: 5, payerEmail: 'a@b.com' });
    assert.equal(resultado.order.status, 'approved');
  });
});

test('checkout em revisão ou encerrado não mostra QR nem orienta pagamento', async () => {
  const qr = { ...pagamento, qrCode: brCode() };
  for (const [tipo, objeto, metodo, fields] of [
    ['modalcompra:custom', compras, 'criarPedidoPix', { email: 'a@b.com', quantidade: '5' }],
    ['modalrecarga', recargas, 'criarRecargaPix', { email: 'a@b.com', valor: '5,00' }],
    ['modalinfinita:semanal', infinita, 'criarPixPlano', { email: 'a@b.com' }],
  ]) {
    for (const status of ['manual_review', 'rejected']) {
      await comMocks([
        [objeto, { [metodo]: async () => ({ order: { ...pedido, status }, payment: qr }) }],
        [vendasUI, { exigirCargoCompra: async () => true }],
        [mediadores, { podeUsarSalas: async () => true }],
        [console, { error: () => {} }],
      ], async () => {
        const i = interacao(`ap:${tipo}`, fields);
        await modais.handleModal(i, ctx);
        assert.match(texto(resposta(i)), /Não pague|não pague/);
        assert.equal(resposta(i).components, undefined);
        assert.equal(resposta(i).files, undefined);
      });
    }
  }
});

test('checkout de Sala Infinita explica a verificação necessária à ativação', async () => {
  await comMocks([
    [infinita, { criarPixPlano: async () => ({ order: { ...pedido, status: 'pending' }, payment: { ...pagamento, qrCode: brCode() } }) }],
    [mediadores, { podeUsarSalas: async () => true }],
  ], async () => {
    const i = interacao('ap:modalinfinita:semanal', { email: 'a@b.com' });
    await modais.handleModal(i, ctx);
    assert.match(texto(resposta(i)), /Após pagar, clique em \*\*Verificar pagamento\*\* para confirmar e ativar/);
  });
});

test('falha de exibição após criação informa risco de cobrança duplicada', async () => {
  await comMocks([
    [compras, { criarPedidoPix: async () => ({ order: { ...pedido, status: 'pending' }, payment: pagamento }) }],
    [vendasUI, { exigirCargoCompra: async () => true }],
    [console, { error: () => {} }],
  ], async () => {
    const i = interacao('ap:modalcompra:custom', { email: 'a@b.com', quantidade: '5' });
    let tentativas = 0;
    i.editReply = async (p) => { if (!tentativas++) throw new Error('falha temporária Discord'); i.calls.push(['editReply', p]); };
    await modais.handleModal(i, ctx);
    assert.match(texto(resposta(i)), /Não gere outro Pix/);
  });
});

test('autorização SS assíncrona negativa bloqueia cadastro, leitura e submissão', async () => {
  let autorizacoes = 0;
  await comMocks([[plantaoModalidade, { autorizado: async () => { autorizacoes += 1; return false; } }]], async () => {
    for (const acao of ['pixsssregistrar', 'pixsssverificar']) {
      const i = interacao(`ap:${acao}`);
      await botoes.handleBotao(i, ctx);
      assert.match(texto(resposta(i)), /Apenas membros/);
      assert.equal(i.calls.some(([nome]) => nome === 'showModal'), false);
    }
    const i = interacao('ap:modalpixss', { chave: 'pix@example.com', titular: 'Nome Teste', cidade: 'Cidade' });
    await modais.handleModal(i, ctx);
    assert.match(texto(resposta(i)), /Apenas membros/);
    assert.equal(autorizacoes, 6);
  });
});

test('erro assíncrono do plantão SS é capturado pelo handler e respondido', async () => {
  await comMocks([
    [plantaoModalidade, { obterModalidade: () => { throw new Error('falha do plantão'); } }],
    [console, { error: () => {} }],
  ], async () => {
    const i = interacao('ap:ssmobileentrar');
    assert.equal(await botoes.handleBotao(i, ctx), true);
    assert.match(texto(resposta(i)), /falha do plantão/);
  });
});

test('limite de 2.000 caracteres usa texto integral e 2.001 usa arquivo integral', async () => {
  for (const tamanho of [2000, 2001]) {
    const codigo = 'x'.repeat(tamanho);
    await comMocks([[recargas, { codigoPixUsuario: async () => codigo }]], async () => {
      const i = interacao(`ap:copiarrecarga:${ID}`);
      await botoes.handleBotao(i, ctx);
      const out = resposta(i);
      if (tamanho === 2000) {
        assert.deepEqual(Buffer.from(out.content), Buffer.from(codigo));
        assert.deepEqual(out.files[0].attachment, Buffer.from(codigo));
      } else {
        assert.deepEqual(out.files[0].attachment, Buffer.from(codigo));
      }
    });
  }
});

test('verificações de Pix rejeitado ou estornado não orientam pagamento', async () => {
  for (const [acao, objeto, metodo] of [
    ['verificarcompra', compras, 'verificarPedido'],
    ['verificarrecarga', recargas, 'verificarRecarga'],
    ['verificarinfinita', infinita, 'verificarPlano'],
  ]) {
    for (const status of ['rejected', 'expired', 'refunded', 'charged_back']) {
      await comMocks([[objeto, { [metodo]: async () => ({ status }) }]], async () => {
        const i = interacao(`ap:${acao}:${ID}`);
        await botoes.handleBotao(i, ctx);
        assert.match(texto(resposta(i)), /Não pague este Pix/);
        assert.doesNotMatch(texto(resposta(i)), /após pagar/i);
      });
    }
  }
});

test('plano em revisão sem identificador de pagamento não orienta criar novo Pix', async () => {
  await comMocks([[infinitaDb, { obterPedidoUsuario: async () => ({ ...pedido, status: 'manual_review', mp_payment_id: null }) }]], async () => {
    await assert.rejects(infinita.verificarPlano({ orderId: ID, guildId: 'guild-a', userId: 'user-a' }), /revisão.*Não gere outro Pix/);
  });
});

test('autoriza SS assíncrono quando apenas a segunda modalidade concede acesso', async () => {
  await comMocks([[plantaoModalidade, { autorizado: async (_member, modalidade) => modalidade === 'ss_emu' }]], async () => {
    const i = interacao('ap:pixsssregistrar');
    await botoes.handleBotao(i, ctx);
    assert.equal(i.calls.at(-1)[0], 'showModal');
  });
});

for (const [nome, executar, banco, args] of [
  ['salas', compras.criarPedidoPix, vendasDb, { guildId: 'guild-a', userId: 'user-a', requestId: 'r', quantity: 5, payerEmail: 'a@b.com' }],
  ['plano', infinita.criarPixPlano, infinitaDb, { guildId: 'guild-a', userId: 'user-a', requestId: 'r', plan: 'semanal', payerEmail: 'a@b.com' }],
]) {
  test(`${nome}: criação anexa e retorna EMV e CRC fornecidos pelo provedor sem alteração`, async () => {
    const codigo = brCode();
    let anexado;
    await comMocks([
      [mp, { exigirAmbiente: () => {}, criarPix: async () => ({ ...pagamento, qrCode: codigo }) }],
      [banco, { criarPedido: async () => ({ ...pedido }), anexarPagamento: async (dados) => { anexado = dados.qrCode; return { ...pedido, status: 'pending' }; } }],
    ], async () => {
      const resultado = await executar(args);
      assert.deepEqual(Buffer.from(anexado), Buffer.from(codigo));
      assert.deepEqual(Buffer.from(resultado.payment.qrCode), Buffer.from(codigo));
      assert.equal(anexado.slice(-4), crc16Ccitt(anexado.slice(0, -4)));
    });
  });
}
