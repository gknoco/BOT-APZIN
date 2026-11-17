'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
process.env.DISCORD_TOKEN = 'test.token.value';
const comandos = require('../src/comandos');
const utilidades = require('../src/comandos/utilidades');
const comunidade = require('../src/comandos/comunidade');
const limpeza = require('../src/comandos/limpeza');
const { responderPrivado, ehComponente, EFEMERO } = require('../src/util/seguranca');
const { responderVerificacaoPix, textoPagamentoAprovado } = require('../src/interacoes/botoes');
const vendas = require('../src/comandos/vendas');
const modais = require('../src/interacoes/modais');
const mercadoPago = require('../src/servicos/mercadoPago');
const comprasSalas = require('../src/servicos/comprasSalas');
const auditoria = require('../src/servicos/auditoria');
const testes = [];
function test(name, fn) { testes.push({ name, fn }); }

test('runtime usa exclusivamente Supabase sem abrir banco local', () => {
  const fonte = fs.readFileSync(path.join(__dirname, '../src/db/index.js'), 'utf8');
  const driver = fs.readFileSync(path.join(__dirname, '../src/db/driver.js'), 'utf8');
  assert.match(fonte, /async function abrirBanco/);
  assert.match(driver, /obterCliente/);
  assert.match(driver, /motor: 'supabase'/);
  assert.doesNotMatch(fonte + driver, /\.prepare\(|node:sqlite|better-sqlite3/);
  const pacote = require('../package.json');
  assert.equal(pacote.optionalDependencies?.['better-sqlite3'], undefined);
});

test('serviço de usuários consulta histórico de partidas no Supabase', () => {
  const servico = fs.readFileSync(path.join(__dirname, '../src/servicos/usuarios.js'), 'utf8');
  assert.match(servico, /historicoApostas/);
  assert.doesNotMatch(servico, /adicionarCoins|adicionarGiros|registrarVitoria|registrarDerrota|\.prepare\(/);
});

test('convites de runtime são gravados no Supabase, não no SQLite', () => {
  const eventos = fs.readFileSync(path.join(__dirname, '../src/eventos/index.js'), 'utf8');
  const servico = fs.readFileSync(path.join(__dirname, '../src/servicos/convites.js'), 'utf8');
  assert.match(eventos, /royalSupabase\.registrarInvite/);
  assert.doesNotMatch(eventos, /convites\.registrar\(/);
  assert.doesNotMatch(servico, /db\.prepare|\.prepare\(/);
});

test('novos comandos estão registrados e comandos legados não existem', () => {
  assert.ok(comandos.nomes.includes('roleta'));
  assert.ok(comandos.nomes.includes('lojinha'));
  assert.ok(comandos.nomes.includes('inventario'));
  for (const nome of comandos.nomes) assert.equal(/legado-impossivel/i.test(nome), false, nome);
});

test('ROYAL SALA registra os comandos pedidos e o painel inclui Usar Saldo junto aos botões oficiais', () => {
  for (const nome of ['painelcomprar', 'comprar', 'setcargo', 'permicompras', 'cupomcompras', 'minhassalas', 'salasreconciliar']) {
    assert.ok(comandos.nomes.includes(nome), `comando ausente: ${nome}`);
  }
  const painel = vendas.componentesPainelCompra().flatMap((linha) => linha.components.map((componente) => componente.toJSON()));
  assert.deepEqual(painel.map((botao) => botao.label), ['Adquirir Sala', 'Ver pacotes de salas', 'Usar Saldo']);
  assert.deepEqual(vendas.PACOTES_SALAS.map((p) => [p.quantidade, p.totalCentavos]), [
    [1, 3], [5, 15], [10, 30], [20, 60], [50, 150], [100, 300],
  ]);
});

test('/ajuda lista todos os comandos e subcomandos registrados', () => {
  const embeds = utilidades.ajudaEmbeds(comandos.comandos);
  const texto = embeds.map((item) => item.toJSON().description || '').join('\n');
  assert.ok(embeds.length <= 10, 'Discord permite no máximo dez embeds por resposta');
  for (const comando of comandos.comandos) {
    const json = comando.data.toJSON();
    assert.ok(texto.includes(`**/${json.name}**`), `comando ausente da ajuda: /${json.name}`);
    for (const opcao of json.options || []) {
      if (opcao.type === 1) assert.ok(texto.includes(`/${json.name} ${opcao.name}`), `subcomando ausente: /${json.name} ${opcao.name}`);
      if (opcao.type === 2) for (const sub of opcao.options || []) {
        if (sub.type === 1) assert.ok(texto.includes(`/${json.name} ${opcao.name} ${sub.name}`));
      }
    }
  }
});

test('expiração configurável de painéis mantém o padrão de trinta minutos', () => {
  let callback;
  let atraso;
  let apagamentos = 0;
  vendas.agendarExclusaoPainel({ delete: async () => { apagamentos += 1; } }, (fn, ms) => {
    callback = fn;
    atraso = ms;
    return { unref() {} };
  });
  assert.equal(atraso, 30 * 60 * 1000);
  callback();
  assert.equal(apagamentos, 1);
  const fonte = fs.readFileSync(path.join(__dirname, '../src/comandos/vendas.js'), 'utf8');
  assert.match(fonte, /30 \* 60 \* 1000/);
});

test('modal de compra preserva ordem de quantidade/cupom e inclui e-mail exigido pelo Pix', async () => {
  let modal;
  await modais.abrirModalCompra({ showModal: async (valor) => { modal = valor; return true; } });
  const json = modal.toJSON();
  assert.equal(json.title, 'Adquirir Salas');
  assert.deepEqual(json.components.map((row) => row.components[0].custom_id), ['quantidade', 'cupom', 'email']);
  assert.equal(json.components[0].components[0].required, false);
  assert.equal(json.components[1].components[0].required, false);
  await modais.abrirModalCompra({ showModal: async (valor) => { modal = valor; return true; } }, 10);
  assert.equal(modal.toJSON().title, 'Pacote de 10 salas');
});

test('e-mail Pix tem validação única e alinhada à API/SQL', () => {
  for (const email of ['jogador@example.com', 'nome.sobrenome+ap@gmail.com']) assert.equal(comprasSalas.validarEmailPix(email), true, email);
  for (const email of ['', 'sem-arroba.com', 'x@dominio.c', 'nome..duplo@example.com', 'nome @example.com']) {
    assert.equal(comprasSalas.validarEmailPix(email), false, email);
  }
  for (const email of ['jogador@example.com', 'nome+ap@gmail.com', 'invalido@dominio.c']) {
    assert.equal(comprasSalas.validarEmailPix(email), mercadoPago.validarEmailPix(email), email);
  }
  const source = fs.readFileSync(path.join(__dirname, '../src/interacoes/modais.js'), 'utf8');
  assert.match(source, /comprasSalas\.MENSAGEM_EMAIL_INVALIDO/);
  assert.equal(comprasSalas.MENSAGEM_EMAIL_INVALIDO, '❌ E-mail inválido. Por favor, insira um endereço de e-mail válido para continuar.');
});

test('criações Nix passam pela reserva Supabase e exigem reconciliação quando o resultado é incerto', () => {
  const nixCommand = fs.readFileSync(path.join(__dirname, '../src/comandos/nix.js'), 'utf8');
  const matchService = fs.readFileSync(path.join(__dirname, '../src/servicos/salas.js'), 'utf8');
  const wrapper = fs.readFileSync(path.join(__dirname, '../src/servicos/criarSalaComCredito.js'), 'utf8');
  assert.match(nixCommand, /criarSalaComCredito\.criar/);
  assert.match(matchService, /criarSalaComCredito\.criar/);
  assert.doesNotMatch(nixCommand, /nix\.criarSala\(/);
  assert.match(wrapper, /vendas\.reservarSala/);
  assert.match(wrapper, /const estado = conclusiva \? 'failed' : 'unknown'/);
  assert.match(wrapper, /vendas\.liquidarUsoSala/);
});

test('migração ROYAL SALA usa RLS service_role e contém ledger/wallet/webhook persistentes', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261116044000_royal_room_sales.sql'), 'utf8');
  for (const tabela of ['royal_room_purchase_orders', 'royal_room_coupons', 'royal_room_wallets', 'royal_room_usages', 'royal_room_ledger', 'royal_room_mp_webhook_events']) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${tabela}`));
  }
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(sql, /GRANT ALL PRIVILEGES ON TABLE public\.%I TO service_role/i);
  assert.match(sql, /royal_room_apply_payment/);
  assert.match(sql, /payment_id_already_linked/);
  assert.match(sql, /v_order\.status = 'manual_review' AND v_status = 'approved'/);
  assert.match(sql, /royal_room_reserve_room/);
  assert.match(sql, /royal_room_resolve_usage/);
});

test('diretório de serviços não contém o módulo removido', () =>
  assert.equal(fs.readdirSync(path.join(__dirname, '../src/servicos')).some((name) => /legacy-service/i.test(name)), false),
);

test('rotas críticas de PIX apontam para Supabase e não persistem snapshots locais', () => {
  const arquivos = ['src/interacoes/modais.js', 'src/interacoes/botoes.js', 'src/comandos/staff.js'];
  for (const arquivo of arquivos) {
    const texto = fs.readFileSync(path.join(__dirname, '..', arquivo), 'utf8');
    assert.match(texto, /staffSupabase/);
  }
  const fluxo = fs.readFileSync(path.join(__dirname, '../src/servicos/fluxo.js'), 'utf8');
  const staff = fs.readFileSync(path.join(__dirname, '../src/comandos/staff.js'), 'utf8');
  assert.doesNotMatch(fluxo, /partidas\.salvarPix/);
  assert.doesNotMatch(staff, /detalhe: `Sala \$\{partida\.id\} · \$\{registro\.pix_chave\}`/);
  const sqlPix = fs.readFileSync(path.join(__dirname, '../supabase/migrations/202611150001_supabase_source_of_truth.sql'), 'utf8');
  assert.match(sqlPix, /royal_upsert_pix_key/);
  assert.match(sqlPix, /primary key\(guild_id,request_id\)/i);
});

test('migração final ativa RLS e restringe acesso da aplicação ao service_role', () => {
  const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/202611150003_service_role_security.sql'), 'utf8');
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /create policy service_role_full_access/i);
  assert.match(sql, /revoke all privileges on all tables in schema public from anon, authenticated/i);
  assert.match(sql, /grant all privileges on all tables in schema public to service_role/i);
});

test('economia, perfil, placar e rankings usam serviço Supabase, sem chamadas aos métodos SQLite', () => {
  const economia = fs.readFileSync(path.join(__dirname, '../src/comandos/economia.js'), 'utf8');
  const perfil = fs.readFileSync(path.join(__dirname, '../src/comandos/perfil.js'), 'utf8');
  const verp = fs.readFileSync(path.join(__dirname, '../src/comandos/verp.js'), 'utf8');
  const botoes = fs.readFileSync(path.join(__dirname, '../src/interacoes/botoes.js'), 'utf8');
  assert.match(economia, /royal\.ajustarPerfil/);
  assert.match(economia, /royal\.transferirCoins/);
  assert.doesNotMatch(economia, /require\(['"]\.\.\/servicos\/usuarios['"]\)|usuarios\./);
  assert.match(perfil, /royalSupabase\.ranking/);
  assert.doesNotMatch(perfil, /usuarios\.(resumo|top|posicaoNoRanking)\(/);
  assert.match(verp, /royalSupabase\.resumo/);
  assert.doesNotMatch(verp, /require\(['"]\.\.\/servicos\/usuarios['"]\)|usuarios\./);
  assert.match(botoes, /royalSupabase\.topPerfis/);
  assert.doesNotMatch(botoes, /usuarios\.top/);
  const fluxo = fs.readFileSync(path.join(__dirname, '../src/servicos/fluxo.js'), 'utf8');
  assert.match(fluxo, /royalSupabase\.registrarResultadoPartida/);
  const sql = fs.readFileSync(path.join(__dirname, '../supabase/migrations/202611150002_economy_source_of_truth.sql'), 'utf8');
  for (const rpc of [
    'royal_adjust_profile',
    'royal_transfer_coins',
    'royal_apply_match_result',
    'royal_spin',
    'royal_buy_item',
    'royal_invite_ranking',
    'royal_mark_reward_delivered',
    'royal_mark_purchase_delivered',
  ]) {
    assert.match(sql, new RegExp(`function public\\.${rpc}`));
  }
});

test('resposta de interação usa followUp após Discord 40060 e nunca repete reply', async () => {
  const chamadas = [];
  const interaction = {
    deferred: false,
    replied: false,
    reply: async () => {
      chamadas.push('reply');
      throw Object.assign(new Error('Interaction has already been acknowledged'), { code: 40060 });
    },
    followUp: async (payload) => {
      chamadas.push(['followUp', payload]);
      return payload;
    },
  };
  await responderPrivado(interaction, { content: 'PIX salvo.' });
  await responderPrivado(interaction, { content: 'Resultado atualizado.' });
  assert.deepEqual(chamadas.map((item) => Array.isArray(item) ? item[0] : item), ['reply', 'followUp', 'followUp']);
  assert.equal(chamadas[1][1].flags & EFEMERO, EFEMERO);
});

test('dispatcher deduplica por ID antes de despachar handlers assíncronos', () => {
  const eventos = fs.readFileSync(path.join(__dirname, '../src/eventos/index.js'), 'utf8');
  assert.match(eventos, /interacoesVistasPorCliente = new WeakMap\(\)/);
  assert.match(eventos, /if \(!primeiraEntrega\(client, interaction\)\)/);
});

test('componente já adiado responde com followUp, sem segundo ACK inicial', async () => {
  const chamadas = [];
  const interaction = {
    deferred: true,
    replied: false,
    isButton: () => true,
    reply: async () => chamadas.push('reply'),
    editReply: async () => chamadas.push('editReply'),
    followUp: async () => chamadas.push('followUp'),
  };
  await responderPrivado(interaction, { content: 'Cadastro PIX.' });
  assert.deepEqual(chamadas, ['followUp']);
});

test('ap:pixverificar usa followUp quando o botão já foi reconhecido ou deferido', async () => {
  for (const estado of [
    { deferred: true, replied: false },
    { deferred: false, replied: true },
  ]) {
    const chamadas = [];
    const interaction = {
      ...estado,
      reply: async () => chamadas.push('reply'),
      update: async () => chamadas.push('update'),
      followUp: async (payload) => chamadas.push(['followUp', payload]),
    };
    await responderVerificacaoPix(interaction, { content: 'Cadastro PIX.' });
    assert.equal(chamadas.length, 1);
    assert.equal(chamadas[0][0], 'followUp');
    assert.equal(chamadas[0][1].flags & EFEMERO, EFEMERO);
  }

  const chamadas = [];
  const ackPerdido = {
    deferred: false,
    replied: false,
    reply: async () => {
      chamadas.push('reply');
      throw Object.assign(new Error('Interaction has already been acknowledged'), { code: 40060 });
    },
    followUp: async () => chamadas.push('followUp'),
  };
  await responderVerificacaoPix(ackPerdido, { content: 'Cadastro PIX.' });
  assert.deepEqual(chamadas, ['reply', 'followUp']);
});

test('modal/context menu não são componentes e resposta deferida usa editReply', async () => {
  assert.equal(ehComponente({ isModalSubmit: () => true }), false);
  assert.equal(ehComponente({ isContextMenuCommand: () => true }), false);
  const chamadas = [];
  const interaction = {
    deferred: true,
    replied: false,
    isModalSubmit: () => true,
    editReply: async (payload) => chamadas.push(['editReply', payload]),
    followUp: async () => chamadas.push('followUp'),
  };
  await responderPrivado(interaction, { content: 'PIX salvo.' });
  assert.equal(chamadas[0][0], 'editReply');
  assert.equal(Object.hasOwn(chamadas[0][1], 'flags'), false);
  const modais = fs.readFileSync(path.join(__dirname, '../src/interacoes/modais.js'), 'utf8');
  const handler = modais.slice(modais.indexOf('async function handleModal'));
  assert.ok(handler.indexOf('interaction.deferReply') < handler.indexOf('aplicarPix(interaction, db)'));
});

test('Pix usa centavos exatos e webhook exige assinatura HMAC íntegra', () => {
  assert.equal(mercadoPago.centavos('0.03'), 3);
  assert.equal(mercadoPago.centavos('1.50'), 150);
  assert.equal(mercadoPago.centavos('1.001'), null);
  const secret = 'offline-test-secret';
  const dataId = '123456789';
  const requestId = 'req-offline-test';
  const ts = '1700000000';
  const manifesto = `id:${dataId};request-id:${requestId};ts:${ts};`;
  const v1 = crypto.createHmac('sha256', secret).update(manifesto).digest('hex');
  const signature = `ts=${ts},v1=${v1}`;
  assert.equal(mercadoPago.assinaturaValida({ signature, requestId, dataId, secret }), true);
  assert.equal(mercadoPago.assinaturaValida({ signature, requestId: 'wrong', dataId, secret }), false);
});

test('aprovação do Pix informa saldo, quantidade e consulta de salas', () => {
  assert.equal(textoPagamentoAprovado(1), '✅ Pagamento aprovado! O saldo de 1 sala já caiu na sua conta para criar salas. Use /minhassalas para ver suas salas.');
  assert.equal(textoPagamentoAprovado(5), '✅ Pagamento aprovado! O saldo de 5 salas já caiu na sua conta para criar salas. Use /minhassalas para ver suas salas.');
});

test('botão Copia e Cola busca código Pix pelo pedido, servidor e dono e envia resposta privada', () => {
  const modalSource = fs.readFileSync(path.join(__dirname, '../src/interacoes/modais.js'), 'utf8');
  const buttonSource = fs.readFileSync(path.join(__dirname, '../src/interacoes/botoes.js'), 'utf8');
  const dbSource = fs.readFileSync(path.join(__dirname, '../src/servicos/roomSalesSupabase.js'), 'utf8');
  assert.match(modalSource, /setCustomId\(`ap:copiarpix:\$\{order\.id\}`\)/);
  assert.match(modalSource, /setLabel\('Copia e Cola'\)/);
  assert.match(buttonSource, /case 'copiarpix'/);
  assert.match(buttonSource, /vendasDb\.obterPixPedidoUsuario/);
  assert.doesNotMatch(buttonSource, /Copie o código Pix abaixo/);
  assert.match(dbSource, /\.eq\('user_id', String\(userId\)\)/);
  assert.match(buttonSource, /responderPrivado\(interaction, \{\s*content: `/);
});

test('versículo público não revela quem chamou o comando nem inclui avatar/menção', () => {
  const card = comunidade.embedVersiculo({ texto: 'Texto de teste', referencia: 'Livro 1:1' }).toJSON();
  assert.match(card.description, /Livro 1:1/);
  assert.doesNotMatch(JSON.stringify(card), /Pedido por|@usuario_teste|avatar/);
});

test('/clearall ignora mensagens já removidas com Discord 10008 sem mascarar outros erros', async () => {
  const velha = (deleteFn) => ({ createdTimestamp: Date.now(), delete: deleteFn });
  const ausente = Object.assign(new Error('Unknown Message'), { code: 10008 });
  assert.equal(await limpeza.apagarLote({}, [velha(async () => { throw ausente; })]), 0);
  const mensagens = [velha(async () => { throw ausente; }), velha(async () => {})];
  assert.equal(await limpeza.apagarLote({ bulkDelete: async () => { throw ausente; } }, mensagens), 1);
  assert.equal(auditoria.canalDesconhecido({ code: 10003 }), true);
  assert.equal(auditoria.canalDesconhecido({ code: 10008 }), false);
});

test('configurações de canais importantes são persistidas e restauradas pelo Supabase', () => {
  const comunidadeSource = fs.readFileSync(path.join(__dirname, '../src/comandos/comunidade.js'), 'utf8');
  const membrosSource = fs.readFileSync(path.join(__dirname, '../src/eventos/membros.js'), 'utf8');
  const utilSource = fs.readFileSync(path.join(__dirname, '../src/comandos/utilidades.js'), 'utf8');
  const flowSource = fs.readFileSync(path.join(__dirname, '../src/servicos/fluxo.js'), 'utf8');
  const mediadoresSource = fs.readFileSync(path.join(__dirname, '../src/servicos/mediadores.js'), 'utf8');
  const supabaseSource = fs.readFileSync(path.join(__dirname, '../src/servicos/supabase.js'), 'utf8');
  assert.match(comunidadeSource, /'canal_boas_vindas'/);
  assert.match(comunidadeSource, /'canal_saida'/);
  assert.match(membrosSource, /persistenciaSupabase\.obterConfig/);
  assert.match(utilSource, /definirConfig\(interaction\.guildId, 'canal_logs'/);
  assert.match(utilSource, /definirConfig\(interaction\.guildId, 'categoria_filas'/);
  assert.match(utilSource, /persistenciaSupabase\.listarConfigs/);
  assert.match(utilSource, /persistenciaSupabase\.removerConfig/);
  assert.match(flowSource, /await obterConfig\(db, guild\.id, chave, envId\)/);
  assert.match(mediadoresSource, /hidratarConfiguracaoRemota/);
  assert.match(supabaseSource, /\.limit\(100\)/);
});

async function main() {
  let ok = 0;
  for (const { name, fn } of testes) {
    await fn();
    ok += 1;
    console.log(`OK ${name}`);
  }
  console.log(`✅ ${ok} testes offline concluídos.`);
}

main().catch((erro) => {
  console.error('❌ Teste falhou:', erro);
  process.exitCode = 1;
});
