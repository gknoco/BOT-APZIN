'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const supabase = require('../src/servicos/supabase');
const { avisarStaff } = require('../src/servicos/avisosEconomia');

test('aviso usa somente canal da guild configurada e não envia menções', async () => {
  const anterior = supabase.obterConfig;
  let enviado;
  supabase.obterConfig = async () => 'canal';
  const canal = { guildId: 'guild', send: async (payload) => { enviado = payload; } };
  const i = { guildId: 'guild', user: { id: '123456789012345678' }, guild: { channels: { cache: new Map([['canal', canal]]) } } };
  try {
    assert.equal(await avisarStaff(i, { origem: 'loja', descricao: 'Pix pendente', protocolo: 'pedido-1' }), true);
    assert.deepEqual(enviado.allowedMentions, { parse: [] });
    assert.match(enviado.embeds[0].toJSON().description, /não comprova pagamento/);
    canal.guildId = 'outra-guild';
    assert.equal(await avisarStaff(i, { origem: 'loja', descricao: 'Pix', protocolo: 'pedido' }), false);
  } finally { supabase.obterConfig = anterior; }
});

test('falha de aviso não altera nem invalida o registro da transação', async () => {
  const anterior = supabase.obterConfig;
  supabase.obterConfig = async () => { throw new Error('offline'); };
  try {
    const i = { guildId: 'guild', user: { id: '123' }, guild: {} };
    assert.equal(await avisarStaff(i, { origem: 'roleta', descricao: 'pendente', protocolo: 'spin' }), false);
  } finally { supabase.obterConfig = anterior; }
});
