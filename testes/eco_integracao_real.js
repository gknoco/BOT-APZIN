'use strict';
// Chamado exclusivamente por rescue_claim_sql.py, usando o PostgreSQL local
// descartável já migrado. O adaptador só substitui o transporte PostgREST;
// as RPCs e as camadas de serviço de produção são executadas de verdade.
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const supabase = require('../src/servicos/supabase');
const royal = require('../src/servicos/royalSupabase');
const claims = require('../src/servicos/rescueClaim');

const guild = 'js-real', user = 'user-real', item = '00000000-0000-4000-8000-000000000080';
const role = '123456789012345678';
const quote = (v) => `'${String(v).replace(/'/g, "''")}'`;
async function sql(command) {
  const { stdout } = await exec(process.env.PSQL_PATH, ['-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', command], { timeout: 15000 });
  return stdout.trim();
}
const client = {
  async rpc(name, a) {
    try {
      let command;
      if (name === 'royal_create_shop_intention') {
        command = `SELECT row_to_json(x) FROM royal_create_shop_intention(${[a.p_guild_id, a.p_user_id, a.p_item_id, a.p_source_id].map(quote).join(',')}) x`;
      } else if (name === 'royal_confirm_shop_intention') {
        command = `SELECT row_to_json(x) FROM royal_confirm_shop_intention(${[a.p_guild_id, a.p_user_id, a.p_nonce].map(quote).join(',')}) x`;
      } else if (name === 'royal_rescue_action') {
        command = `SELECT royal_rescue_action(${[a.p_action, a.p_guild_id, a.p_source, a.p_protocol, a.p_actor_id, a.p_request_id].map(quote).join(',')})`;
      } else {
        throw new Error(`RPC inesperada: ${name}`);
      }
      const data = JSON.parse(await sql(`SET statement_timeout='10s'; SET ROLE service_role; ${command}`));
      return { data: name === 'royal_rescue_action' ? data : [data], error: null };
    } catch (error) { return { data: null, error }; }
  },
};

async function main() {
  supabase.obterCliente = () => client;
  const intentions = await Promise.all(Array.from({ length: 8 }, () => royal.criarIntencaoLoja({ guildId: guild, userId: user, itemId: item, sourceId: 'preview-js-real' })));
  assert.equal(new Set(intentions.map((x) => x.nonce)).size, 1);
  const nonce = intentions[0].nonce;
  const purchases = await Promise.all(Array.from({ length: 8 }, () => royal.confirmarIntencaoLoja({ guildId: guild, userId: user, nonce })));
  assert.equal(purchases.filter((x) => !x.is_replay).length, 1);
  assert.equal(new Set(purchases.map((x) => x.purchase_id)).size, 1);
  const protocolo = purchases[0].purchase_id;
  let effects = 0;
  let signal;
  const started = new Promise((resolve) => { signal = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const args = { guildId: guild, tipo: 'loja', protocolo, interactionId: 'same-interaction', userId: user, roleId: role,
    entregar: async () => { effects++; signal(); await gate; } };
  const first = claims.entregaAutomatica(args);
  await started; // claim já commitou; o efeito externo permanece em andamento.
  const attempts = await Promise.allSettled([
    ...Array.from({ length: 7 }, () => claims.entregaAutomatica(args)),
    claims.acao({ cliente: client, action: 'claim', guildId: guild, tipo: 'loja', protocolo, actorId: 'staff', requestId: 'staff-request' }),
  ]);
  assert.ok(attempts.slice(0, 7).every((x) => x.status === 'rejected'));
  assert.equal(attempts[7].status, 'fulfilled');
  assert.equal(attempts[7].value.result, 'owned');
  assert.equal(effects, 1);
  release();
  await first;
  await assert.rejects(claims.entregaAutomatica(args));
  assert.equal(effects, 1);
  assert.equal(await sql(`SELECT status||':'||(terms_snapshot->>'reward_value') FROM royal_purchases WHERE id=${quote(protocolo)}`), `delivered:${role}`);
  assert.equal(await sql(`SELECT count(*) FROM royal_audit_events WHERE guild_id=${quote(guild)} AND entity_id=${quote(protocolo)} AND action='reward.delivery.auto_marked'`), '1');
  assert.equal(await sql(`SELECT coins FROM royal_profiles WHERE guild_id=${quote(guild)} AND user_id=${quote(user)}`), '90');
  console.log('Camada JS + RPCs reais: nonce único, débito único, claim persistente e um único efeito externo.');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
