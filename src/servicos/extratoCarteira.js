'use strict';

const supabaseBase = require('./supabase');

function inteiroNaoNegativo(valor) {
  const n = Number(valor);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

async function obterExtrato({ guildId, userId }) {
  const guild = String(guildId || '').trim();
  const user = String(userId || '').trim();
  if (!guild || !user) throw new Error('Não consegui identificar sua conta neste servidor.');

  const { data, error } = await supabaseBase.obterCliente().rpc('royal_wallet_statement', {
    p_guild_id: guild,
    p_user_id: user,
  });
  if (error) throw new Error(`consulta do extrato no Supabase: ${error.message}`);

  const registro = Array.isArray(data) ? data[0] : data;
  if (!registro || typeof registro !== 'object') throw new Error('O Supabase não retornou os dados do extrato.');
  const movimentos = Array.isArray(registro.movements) ? registro.movements : [];

  return {
    balanceCents: inteiroNaoNegativo(registro.balance_cents),
    totalEntriesCents: inteiroNaoNegativo(registro.total_entries_cents),
    totalExitsCents: inteiroNaoNegativo(registro.total_exits_cents),
    status: String(registro.wallet_status || 'Normal').slice(0, 40),
    movements: movimentos.slice(0, 6).map((item) => ({
      eventType: String(item?.event_type || 'movement').slice(0, 40),
      deltaCents: Number.isSafeInteger(Number(item?.delta_cents)) ? Number(item.delta_cents) : 0,
      balanceAfterCents: inteiroNaoNegativo(item?.balance_after_cents),
      createdAt: item?.created_at ? String(item.created_at) : null,
    })),
  };
}

module.exports = { obterExtrato, inteiroNaoNegativo };
