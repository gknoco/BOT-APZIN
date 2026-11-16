'use strict';

const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const supabase = require('../src/servicos/supabase');
const staffPath = require.resolve('../src/servicos/staffSupabase');
const originalClient = supabase.obterCliente;
const originalSetter = supabase.definirConfig;
const chamadas = [];
let resposta = { data: { valor: '["cargo-atual"]' }, error: null };
supabase.obterCliente = () => ({
  from(tabela) {
    chamadas.push(['from', tabela]);
    const q = {
      select(colunas) { chamadas.push(['select', colunas]); return this; },
      eq(campo, valor) { chamadas.push(['eq', campo, valor]); return this; },
      async maybeSingle() { return resposta; },
    };
    return q;
  },
});
delete require.cache[staffPath];
const staff = require(staffPath);
after(() => {
  supabase.obterCliente = originalClient;
  supabase.definirConfig = originalSetter;
  delete require.cache[staffPath];
});

test('autorização PIX usa o cargo atual de discord_configuracoes, não um espelho desatualizado', async () => {
  const membro = (id) => ({ permissions: { has: () => false }, roles: { cache: new Map([[id, {}]]) } });
  assert.equal(await staff.temCargoMediador('guild-a', membro('cargo-atual')), true);
  assert.equal(await staff.temCargoMediador('guild-a', membro('cargo-removido')), false);
  assert.ok(chamadas.some((c) => c[0] === 'eq' && c[1] === 'chave' && c[2] === 'cargos_mediadores'));
  assert.ok(chamadas.filter((c) => c[0] === 'from').every((c) => c[1] === 'discord_configuracoes'));
});

test('permissão administrativa existente é preservada sem consulta remota', async () => {
  const antes = chamadas.length;
  assert.equal(await staff.temCargoMediador('guild-a', { permissions: { has: (p) => p === 'Administrator' } }), true);
  assert.equal(chamadas.length, antes);
});

test('falha de consulta de cargos não autoriza por estado obsoleto', async () => {
  resposta = { data: null, error: { message: 'indisponível' } };
  await assert.rejects(staff.cargos('guild-a'), /indisponível/);
});

test('setter de compatibilidade grava na mesma fonte de configuração', async () => {
  let args;
  supabase.definirConfig = async (...valores) => { args = valores; };
  await staff.definirConfig('guild-a', 'cargos_mediadores', '["novo"]');
  assert.deepEqual(args, ['guild-a', 'cargos_mediadores', '["novo"]']);
});
