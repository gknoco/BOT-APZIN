'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { test } = require('node:test');

let rpcResult = { data: null, error: null };
const chamadas = [];
const supabase = {
  obterCliente() {
    return {
      async rpc(nome, args) {
        chamadas.push({ nome, args });
        return rpcResult;
      },
    };
  },
};
const carregarOriginal = Module._load;
Module._load = function carregarComSupabaseFalso(request, parent, isMain) {
  const arquivo = Module._resolveFilename(request, parent, isMain);
  if (arquivo === path.resolve(__dirname, '../src/servicos/supabase.js')) return supabase;
  return carregarOriginal.call(this, request, parent, isMain);
};
let carteira;
try {
  carteira = require('../src/servicos/extratoCarteira');
} finally {
  Module._load = carregarOriginal;
}

const arquivoMigration = path.resolve(__dirname, '../supabase/migrations/20261117014100_royal_wallet_statement.sql');

test('consulta o extrato por RPC no Supabase com servidor e usuário da interação', async () => {
  chamadas.length = 0;
  rpcResult = {
    data: {
      balance_cents: 2510,
      total_entries_cents: 4000,
      total_exits_cents: 1490,
      wallet_status: 'Normal',
      movements: [{ event_type: 'topup', delta_cents: 500, balance_after_cents: 2510, created_at: '2026-11-16T18:30:00Z' }],
    },
    error: null,
  };
  const resultado = await carteira.obterExtrato({ guildId: 'guild-01', userId: 'user-02' });
  assert.deepEqual(chamadas, [{ nome: 'royal_wallet_statement', args: { p_guild_id: 'guild-01', p_user_id: 'user-02' } }]);
  assert.deepEqual(resultado, {
    balanceCents: 2510,
    totalEntriesCents: 4000,
    totalExitsCents: 1490,
    status: 'Normal',
    movements: [{ eventType: 'topup', deltaCents: 500, balanceAfterCents: 2510, createdAt: '2026-11-16T18:30:00Z' }],
  });
});

test('rejeita identidade incompleta antes de chamar a fonte de dados', async () => {
  chamadas.length = 0;
  await assert.rejects(carteira.obterExtrato({ guildId: 'guild-01', userId: '' }), /identificar sua conta/);
  assert.equal(chamadas.length, 0);
});

test('normaliza valores e limita movimentações retornadas pelo RPC', async () => {
  chamadas.length = 0;
  rpcResult = { data: {
    balance_cents: -50,
    total_entries_cents: '120',
    total_exits_cents: 'valor-inválido',
    wallet_status: 'N'.repeat(100),
    movements: Array.from({ length: 9 }, (_, i) => ({ event_type: 'topup', delta_cents: String(i), balance_after_cents: i, created_at: null })),
  }, error: null };
  const resultado = await carteira.obterExtrato({ guildId: 'guild-01', userId: 'user-02' });
  assert.equal(resultado.balanceCents, 0);
  assert.equal(resultado.totalEntriesCents, 120);
  assert.equal(resultado.totalExitsCents, 0);
  assert.equal(resultado.status.length, 40);
  assert.equal(resultado.movements.length, 6);
});

test('propaga falha do Supabase para feedback privado sem mascarar o motivo', async () => {
  rpcResult = { data: null, error: { message: 'database unavailable' } };
  await assert.rejects(carteira.obterExtrato({ guildId: 'guild-01', userId: 'user-02' }), /database unavailable/);
});

test('migration retorna totais globais do usuário, últimas seis linhas e restringe RPC ao service_role', () => {
  const sql = fs.readFileSync(arquivoMigration, 'utf8');
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.royal_wallet_statement\(\s*p_guild_id text,\s*p_user_id text/s);
  assert.match(sql, /SUM\(delta_cents\) FILTER \(WHERE delta_cents > 0\)/);
  assert.match(sql, /SUM\(-delta_cents\) FILTER \(WHERE delta_cents < 0\)/);
  assert.match(sql, /guild_id = trim\(p_guild_id\) AND user_id = trim\(p_user_id\)/);
  assert.match(sql, /LIMIT 6/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.royal_wallet_statement\(text, text\) FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.royal_wallet_statement\(text, text\) TO service_role/);
});

test('embed privado de Extrato mostra identidade, saldos Supabase, histórico e não usa Canvas/banner', () => {
  const ui = require('../src/comandos/recarga');
  const packageJson = JSON.parse(fs.readFileSync(require.resolve('../package.json'), 'utf8'));
  const extrato = {
    balanceCents: 2510,
    totalEntriesCents: 4000,
    totalExitsCents: 1490,
    status: 'Normal',
    movements: [{ eventType: 'topup', deltaCents: 500, createdAt: '2026-11-16T18:30:00Z' }],
  };
  const usuario = {
    username: 'staff_teste',
    globalName: 'Staff Teste',
    displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/user-a/avatar.png',
  };
  const card = ui.embedExtratoCarteira(extrato, usuario).toJSON();
  assert.equal(card.title, '✦ CARTEIRA DIGITAL · EXTRATO');
  assert.equal(card.author.name, '@Staff Teste');
  assert.equal(card.author.icon_url, 'https://cdn.discordapp.com/avatars/user-a/avatar.png');
  assert.equal(card.color, 0x4B2E5D);
  assert.match(card.fields[0].value, /R\$ 25,10/);
  assert.match(card.fields[1].value, /R\$ 40,00/);
  assert.match(card.fields[1].value, /R\$ 14,90/);
  assert.equal(card.fields[2].value, '**Normal**');
  assert.match(card.fields[3].value, /Recarga Pix.*\+R\$ 5,00/);
  assert.equal(card.footer.text, 'ROYAL AP  ·  CARTEIRA DIGITAL  ·  PRIVADO');
  assert.ok(card.timestamp);
  assert.equal(card.image, undefined);
  assert.equal(card.thumbnail, undefined);
  assert.equal(packageJson.dependencies.canvas, undefined);
  assert.equal(fs.existsSync(path.resolve(__dirname, '../src/util/imageGenerator.js')), false);
  assert.equal(fs.existsSync(path.resolve(__dirname, '../assets/extrato-royal-ap.png')), false);
  assert.equal(ui.BANNER_NOME, 'recarga-royal-ap.jpg');
  assert.equal(ui.BANNER_EXTRATO_PATH, undefined);
  const buttons = ui.componentesExtrato().flatMap((row) => row.toJSON().components);
  assert.deepEqual(buttons.map((button) => button.custom_id), ['ap:extratovoltar', 'ap:extratoatualizar']);
});
