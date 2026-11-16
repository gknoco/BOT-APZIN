'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.DISCORD_TOKEN = 'test.token.value';
process.env.DATABASE_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'royal-ap-')), 'royal.db');
const { abrirBanco } = require('../src/db');
const comandos = require('../src/comandos');
const { responderPrivado, ehComponente, EFEMERO } = require('../src/util/seguranca');
const { responderVerificacaoPix } = require('../src/interacoes/botoes');
const vendas = require('../src/comandos/vendas');
const modais = require('../src/interacoes/modais');
const mercadoPago = require('../src/servicos/mercadoPago');
const db = abrirBanco(process.env.DATABASE_PATH);
const testes = [];
function test(name, fn) { testes.push({ name, fn }); }

test('banco cria perfis e convites sem tabelas legadas', () => {
  const tables = db.prepare("select name from sqlite_master where type='table'").all().map((x) => x.name);
  assert.ok(tables.includes('usuarios'));
  assert.ok(tables.includes('convites'));
  assert.equal(tables.some((x) => /legado-impossivel/i.test(x)), false);
});

test('serviço de usuários mantém somente histórico local de partidas', () => {
  const servico = fs.readFileSync(path.join(__dirname, '../src/servicos/usuarios.js'), 'utf8');
  assert.match(servico, /historicoApostas/);
  assert.doesNotMatch(servico, /adicionarCoins|adicionarGiros|registrarVitoria|registrarDerrota|UPDATE usuarios|INSERT INTO usuarios/);
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

test('ROYAL SALA registra os comandos pedidos e o painel contém somente os dois botões oficiais', () => {
  for (const nome of ['painelcomprar', 'comprar', 'permicompras', 'cupomcompras', 'minhassalas', 'salasreconciliar']) {
    assert.ok(comandos.nomes.includes(nome), `comando ausente: ${nome}`);
  }
  const painel = vendas.componentesPainelCompra().flatMap((linha) => linha.components.map((componente) => componente.toJSON()));
  assert.deepEqual(painel.map((botao) => botao.label), ['Adquirir Sala', 'Ver pacotes de salas']);
  assert.deepEqual(vendas.PACOTES_SALAS.map((p) => [p.quantidade, p.totalCentavos]), [
    [1, 3], [5, 15], [10, 30], [20, 60], [50, 150], [100, 300],
  ]);
});

test('modal de compra preserva ordem de quantidade/cupom e inclui e-mail exigido pelo Pix', async () => {
  let modal;
  await modais.abrirModalCompra({ showModal: async (valor) => { modal = valor; return true; } });
  const json = modal.toJSON();
  assert.equal(json.title, 'Adquirir Salas');
  assert.deepEqual(json.components.map((row) => row.components[0].custom_id), ['quantidade', 'cupom', 'email']);
  assert.equal(json.components[0].components[0].required, false);
  assert.equal(json.components[1].components[0].required, false);
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

async function main() {
  let ok = 0;
  try {
    for (const { name, fn } of testes) {
      await fn();
      ok += 1;
      console.log(`OK ${name}`);
    }
    console.log(`✅ ${ok} testes offline concluídos.`);
  } finally {
    db.close();
  }
}

main().catch((erro) => {
  console.error('❌ Teste falhou:', erro);
  process.exitCode = 1;
});
