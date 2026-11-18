'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { test } = require('node:test');
const { PermissionFlagsBits, ChannelType } = require('discord.js');

const chamadas = [];
const base = { historico: [], entregas: [], premios: [], itens: [], perfis: new Map(), resultados: new Map() };
const fsFalso = { existe: false, existsSync() { return this.existe; } };
const supabase = {
  configs: [],
  erroConfig: null, erroLeitura: null, valores: new Map(),
  cliente: null,
  obterCliente() { chamadas.push('cliente'); return this.cliente; },
  async obterConfig(guild, chave, cliente) {
    chamadas.push('lerConfig'); assert.equal(cliente, this.cliente);
    if (this.erroLeitura) throw new Error('indisponível');
    return this.valores.get(`${guild}:${chave}`) ?? null;
  },
  async definirConfig(...args) {
    chamadas.push('config');
    if (this.erroConfig) throw new Error('indisponível');
    this.configs.push(args);
  },
};
const avisos = { chamados: [], falhar: false, async avisarStaff(interaction, dados) {
  chamadas.push('aviso'); this.chamados.push({ interaction, ...dados });
  if (this.falhar) throw new Error('falha no aviso');
} };
const royal = {
  resultado: { spin_id: 's-1', prize_name: 'Prêmio', reward_type: 'coins', reward_value: '50' },
  erroGiro: null,
  erroPerfil: null,
  erroMarca: null,
  auditados: [],
  marcados: [],
  async girar(args) {
    chamadas.push('girar');
    this.ultimoGiro = args;
    if (this.erroGiro) throw new Error(this.erroGiro);
    const key = `${args.guildId}:${args.request}`;
    if (!base.resultados.has(key)) {
      const perfil = base.perfis.get(`${args.guildId}:${args.userId}`) || { spins: 0 };
      if (perfil.spins < 1) throw new Error('Você não possui giros disponíveis');
      perfil.spins -= 1;
      if (this.resultado.reward_type === 'spins') perfil.spins += Number(this.resultado.reward_value);
      base.perfis.set(`${args.guildId}:${args.userId}`, perfil);
      base.resultados.set(key, { ...this.resultado });
    }
    return base.resultados.get(key);
  },
  async perfil(guildId, userId) {
    chamadas.push('perfil');
    if (this.erroPerfil) throw new Error('banco indisponível');
    return base.perfis.get(`${guildId}:${userId}`) || null;
  },
  async marcarRecompensaEntregue(args) {
    chamadas.push('marcar');
    this.marcados.push(args);
    if (this.erroMarca) throw new Error('não marcou');
  },
  async auditar(evento) { chamadas.push('auditar'); this.auditados.push(evento); },
};

function clienteMemoria() {
  const consultas = [];
  return {
    consultas,
    from(tabela) {
      const filtros = []; const ordens = [];
      const consulta = { tabela, filtros, ordens };
      consultas.push(consulta);
      const q = {
        select(colunas) { consulta.colunas = colunas; return q; },
        eq(campo, valor) { filtros.push([campo, valor]); return q; },
        order(campo, opts) { ordens.push([campo, opts]); return q; },
        async range(inicio, fim) { consulta.range = [inicio, fim]; return executar(inicio, fim); },
        async in(campo, valores) { consulta.in = [campo, valores]; return executar(); },
      };
      function executar(inicio, fim) {
        chamadas.push(`consulta:${tabela}`);
        if (tabela === 'royal_roulette_spins' && base.erroSnapshots && consulta.colunas.includes('prize_name_snapshot')) {
          return { data: null, error: { message: 'column prize_name_snapshot does not exist' } };
        }
        if (tabela === 'royal_reward_deliveries' && base.erroEntregas) return { data: null, error: { message: 'erro na entrega' } };
        const tabelas = {
          royal_roulette_spins: base.historico, royal_reward_deliveries: base.entregas,
          royal_roulette_prizes: base.premios, royal_shop_items: base.itens,
        };
        let dados = [...(tabelas[tabela] || [])];
        dados = dados.filter((item) => filtros.every(([campo, valor]) => item[campo] === valor));
        if (consulta.in) dados = dados.filter((item) => consulta.in[1].includes(item[consulta.in[0]]));
        if (tabela === 'royal_roulette_spins') dados.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
        if (tabela === 'royal_roulette_prizes') dados.sort((a, b) => a.id.localeCompare(b.id));
        if (inicio !== undefined) dados = dados.slice(inicio, fim + 1);
        return { data: dados, error: null };
      }
      return q;
    },
  };
}

const loadOriginal = Module._load;
Module._load = function(request, parent, isMain) {
  if (parent?.filename === path.resolve(__dirname, '../src/comandos/roletaPro.js') && request === 'node:fs') return fsFalso;
  if (parent?.filename === path.resolve(__dirname, '../src/comandos/roletaPro.js') && request === '../servicos/avisosEconomia') return avisos;
  const filename = Module._resolveFilename(request, parent, isMain);
  if (filename === path.resolve(__dirname, '../src/servicos/royalSupabase.js')) return royal;
  if (filename === path.resolve(__dirname, '../src/servicos/supabase.js')) return supabase;
  return loadOriginal.call(this, request, parent, isMain);
};
let roleta;
try { roleta = require('../src/comandos/roletaPro'); }
finally { Module._load = loadOriginal; }

function preparar() {
  chamadas.length = 0;
  base.historico = []; base.entregas = []; base.premios = []; base.itens = []; base.erroSnapshots = false; base.erroEntregas = false; base.perfis = new Map(); base.resultados = new Map();
  base.perfis.set('guild-a:user-a', { spins: 5, coins: 0 });
  base.perfis.set('guild-a:user-b', { spins: 2, coins: 0 });
  supabase.configs = []; supabase.erroConfig = null; supabase.erroLeitura = null; supabase.valores = new Map(); supabase.cliente = clienteMemoria();
  avisos.chamados = []; avisos.falhar = false;
  royal.resultado = { spin_id: 's-1', prize_name: 'Prêmio', reward_type: 'coins', reward_value: '50' };
  royal.erroGiro = null; royal.erroPerfil = null; royal.erroMarca = null; royal.auditados = []; royal.marcados = [];
  fsFalso.existe = false;
}
function interacao({ id = 'interaction-001', usuario = 'user-a', guild = 'guild-a', componente = null, sub = 'girar', admin = false } = {}) {
  const i = {
    id, guildId: guild, user: { id: usuario }, customId: componente, deferred: false, replied: false,
    guild: { id: guild, ownerId: 'owner', members: { me: {} }, channels: { cache: new Map() } }, member: { roles: {} },
    memberPermissions: { has: (permission) => admin && permission === PermissionFlagsBits.Administrator },
    channel: { id: 'canal-1', guildId: guild, type: ChannelType.GuildText, permissionsFor: () => ({ has: () => true }), async send(payload) { chamadas.push('send'); i.publicados.push(payload); return { id: 'mensagem-1', async pin() { chamadas.push('pin'); } }; } },
    options: { getSubcommand: () => sub }, publicados: [], respostas: [],
    async deferReply(payload) { chamadas.push('defer'); i.deferPayload = payload; i.deferred = true; },
    async editReply(payload) { chamadas.push('edit'); i.respostas.push(payload); return payload; },
  };
  return i;
}
function corpo(interaction) { return interaction.respostas.at(-1).embeds[0].toJSON().description; }
function botoes(payload) { return payload.components.flatMap((row) => row.toJSON().components); }

function premiacao(id, usuario, guild, tipo, valor, status) {
  const request = `spin:req-${id}`;
  base.historico.push({
    id: String(id).padStart(4, '0'), guild_id: guild, user_id: usuario, request_id: request,
    created_at: `2026-11-${String(id).padStart(2, '0')}T12:00:00.000Z`,
    royal_roulette_prizes: { name: `Prêmio ${id}`, reward_type: tipo, reward_value: valor },
  });
  if (status) base.entregas.push({ guild_id: guild, user_id: usuario, request_id: request, status });
}

test('contrato do comando e prefixo: IDs estranhos não são consumidos', async () => {
  preparar();
  const json = roleta.comando.data.toJSON();
  assert.equal(json.name, 'roleta');
  assert.deepEqual(json.options.map((o) => o.name), ['painel', 'girar']);
  const i = interacao({ componente: 'outro:botao' });
  assert.equal(await roleta.handleComponent(i), false);
  assert.deepEqual(chamadas, []);
});

test('painel somente para admin é enviado realmente em canal e confirmação é efêmera', async () => {
  preparar();
  const negado = interacao({ sub: 'painel' });
  await roleta.comando.executar(negado);
  assert.equal(negado.deferPayload.flags & 64, 64);
  assert.equal(negado.publicados.length, 0);
  assert.match(corpo(negado), /Somente administradores/);
  assert.deepEqual(supabase.configs, []);

  const admin = interacao({ sub: 'painel', admin: true });
  await roleta.comando.executar(admin, { db: { client: supabase.cliente } });
  const painel = admin.publicados[0];
  assert.equal(admin.deferPayload.flags & 64, 64);
  assert.equal(painel.flags, undefined);
  assert.deepEqual(painel.allowedMentions, { parse: [] });
  assert.deepEqual(botoes(painel).map((b) => [b.custom_id, b.label]), [
    ['roletapro:girar', 'Girar'], ['roletapro:premios', 'Meus Prêmios'],
  ]);
  assert.doesNotMatch(painel.embeds[0].toJSON().description, /5|2|Giros disponíveis/);
  assert.deepEqual(supabase.configs[0].slice(0, 3), ['guild-a', 'painel_roleta', '{"channel_id":"canal-1","message_id":"mensagem-1"}']);
  assert.match(corpo(admin), /publicado/);
});

test('banner usa AttachmentBuilder e attachment://; ausência tem fallback válido', async () => {
  preparar();
  let i = interacao({ sub: 'painel', admin: true });
  await roleta.comando.executar(i);
  assert.deepEqual(i.publicados[0].files, []);
  assert.equal(i.publicados[0].embeds[0].toJSON().image, undefined);
  fsFalso.existe = true;
  i = interacao({ id: 'interaction-002', sub: 'painel', admin: true });
  await roleta.comando.executar(i);
  assert.equal(i.publicados[0].files[0].name, 'roleta-royal-ap.png');
  assert.equal(i.publicados[0].embeds[0].toJSON().image.url, 'attachment://roleta-royal-ap.png');
});

test('painel calcula chances dos pesos elegíveis e avisa que é preciso republicar', async () => {
  preparar();
  base.premios = [
    { id: 'a', guild_id: 'guild-a', active: true, name: 'Coins', reward_type: 'coins', reward_value: '10', weight: 30, stock: null },
    { id: 'b', guild_id: 'guild-a', active: true, name: 'Item', reward_type: 'shop_item', reward_value: 'item-ok', weight: 10, stock: 1 },
    { id: 'c', guild_id: 'guild-a', active: true, name: 'Esgotado', reward_type: 'spins', reward_value: '1', weight: 60, stock: 0 },
    { id: 'd', guild_id: 'guild-a', active: true, name: 'Item indisponível', reward_type: 'shop_item', reward_value: 'item-out', weight: 10, stock: null },
    { id: 'e', guild_id: 'guild-b', active: true, name: 'Outro servidor', reward_type: 'coins', reward_value: '1', weight: 50, stock: null },
    { id: 'f', guild_id: 'guild-a', active: false, name: 'Inativo', reward_type: 'coins', reward_value: '1', weight: 50, stock: null },
  ];
  base.itens = [
    { id: 'item-ok', guild_id: 'guild-a', active: true, stock: 1 },
    { id: 'item-out', guild_id: 'guild-a', active: true, stock: 0 },
  ];
  const i = interacao({ sub: 'painel', admin: true });
  await roleta.comando.executar(i);
  const descricao = i.publicados[0].embeds[0].toJSON().description;
  assert.match(descricao, /Coins · \*\*75,00%\*\*/);
  assert.match(descricao, /Item · \*\*25,00%\*\*/);
  assert.doesNotMatch(descricao, /Esgotado|Item indisponível|Outro servidor|Inativo/);
  assert.match(descricao, /Imagem ilustrativa/);
  assert.match(descricao, /republique o painel/);
  assert.ok(chamadas.indexOf('defer') < chamadas.indexOf('consulta:royal_roulette_prizes'));
});

test('catálogo é paginado integralmente, inclusive os prêmios não exibidos no limite visual', async () => {
  preparar();
  base.premios = Array.from({ length: 201 }, (_, indice) => ({
    id: String(indice).padStart(3, '0'), guild_id: 'guild-a', active: true, name: `Prêmio ${indice}`,
    reward_type: 'coins', reward_value: '1', weight: 1, stock: null,
  }));
  const i = interacao({ sub: 'painel', admin: true }); await roleta.comando.executar(i);
  const descricao = i.publicados[0].embeds[0].toJSON().description;
  assert.match(descricao, /\*\*0,50%\*\*/);
  assert.match(descricao, /outros 181 prêmio/);
  assert.equal(supabase.cliente.consultas.filter((q) => q.tabela === 'royal_roulette_prizes').length, 2);
});

test('valor inválido de prêmio não gera probabilidades falsas', async () => {
  preparar();
  base.premios = [{ id: 'a', guild_id: 'guild-a', active: true, name: 'Inválido', reward_type: 'coins', reward_value: '-1', weight: 1, stock: null }];
  const i = interacao({ sub: 'painel', admin: true }); await roleta.comando.executar(i);
  const descricao = i.publicados[0].embeds[0].toJSON().description;
  assert.match(descricao, /Não foi possível consultar os prêmios/);
  assert.doesNotMatch(descricao, /100,00%/);
  assert.match(corpo(i), /lista de prêmios não pôde ser carregada/);
});

test('se configuração falha, informa que o painel já foi publicado sem induzir a republicação', async () => {
  preparar(); supabase.erroConfig = true;
  const i = interacao({ sub: 'painel', admin: true });
  await roleta.comando.executar(i);
  assert.equal(i.publicados.length, 1);
  assert.match(corpo(i), /continua publicado/);
});

test('componente é adiado imediatamente, antes de qualquer acesso ao banco', async () => {
  preparar();
  const i = interacao({ componente: 'roletapro:premios' });
  let liberar;
  i.deferReply = async (payload) => {
    chamadas.push('defer'); i.deferPayload = payload;
    await new Promise((resolve) => { liberar = resolve; });
    i.deferred = true;
  };
  const promise = roleta.handleComponent(i);
  assert.deepEqual(chamadas, ['defer']);
  liberar();
  assert.equal(await promise, true);
  assert.equal(i.deferPayload.flags & 64, 64);
  assert.match(corpo(i), /Giros disponíveis:\*\* 5/);
});

test('giro do comando e botão usam RPC e respostas privadas, sem modificar painel', async () => {
  preparar();
  const slash = interacao({ id: 'command-001', sub: 'girar' });
  await roleta.comando.executar(slash);
  assert.equal(slash.deferPayload.flags & 64, 64);
  assert.deepEqual(royal.ultimoGiro, { guildId: 'guild-a', userId: 'user-a', request: 'command-001' });
  assert.match(corpo(slash), /Giros disponíveis:\*\* 4/);
  assert.match(corpo(slash), /coins foram creditadas/);
  const botao = interacao({ id: 'button-001', componente: 'roletapro:girar', usuario: 'user-b' });
  assert.equal(await roleta.handleComponent(botao), true);
  assert.deepEqual(royal.ultimoGiro, { guildId: 'guild-a', userId: 'user-b', request: 'button-001' });
  assert.match(corpo(botao), /Giros disponíveis:\*\* 1/);
  assert.equal(botao.publicados.length, 0);
  assert.equal(botao.deferPayload.flags & 64, 64);
  assert.match(botao.respostas[0].embeds[0].toJSON().title, /SORTEANDO/);
  assert.ok(chamadas.indexOf('defer') < chamadas.indexOf('edit'));
  assert.ok(chamadas.indexOf('edit') < chamadas.indexOf('girar'));
});

test('repetir o mesmo ID de interação mantém a mesma chave e não consome outro giro', async () => {
  preparar();
  await roleta.comando.executar(interacao({ id: 'mesmo-001' }));
  const repeticao = interacao({ id: 'mesmo-001' });
  await roleta.comando.executar(repeticao);
  assert.equal(base.perfis.get('guild-a:user-a').spins, 4);
  assert.match(corpo(repeticao), /Prêmio/);
});

test('testa serviço real: ambas RPCs usam o mesmo request_id idempotente', async () => {
  const chamadasRpc = [];
  const fakeBase = { obterCliente: () => ({ rpc: async (nome, args) => { chamadasRpc.push({ nome, args }); return { data: [{ ok: true }], error: null }; } }) };
  const original = Module._load;
  Module._load = function(request, parent, isMain) {
    if (parent?.filename === path.resolve(__dirname, '../src/servicos/royalSupabase.js') && request === './supabase') return fakeBase;
    return original.call(this, request, parent, isMain);
  };
  let servico;
  try { servico = require('../src/servicos/royalSupabase'); }
  finally { Module._load = original; }
  await servico.girar({ guildId: 'guild-a', userId: 'user-a', request: 'discord-123' });
  await servico.marcarRecompensaEntregue({ guildId: 'guild-a', userId: 'user-a', request: 'discord-123' });
  assert.deepEqual(chamadasRpc.map((c) => c.nome), ['royal_spin', 'royal_mark_reward_delivered']);
  assert.ok(chamadasRpc.every((c) => c.args.p_request_id === 'spin:discord-123'));
});

test('cargo é concedido após giro e marcado somente após a conclusão da entrega', async () => {
  preparar(); royal.resultado = { spin_id: 'spin-role', prize_name: 'VIP', reward_type: 'role', reward_value: 'role-1' };
  let liberar;
  const i = interacao({ componente: 'roletapro:girar' });
  i.member.roles.add = async (id) => { assert.equal(id, 'role-1'); chamadas.push('role'); await new Promise((resolve) => { liberar = resolve; }); };
  const promise = roleta.handleComponent(i);
  while (!liberar) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(chamadas.indexOf('defer') < chamadas.indexOf('girar'));
  assert.ok(chamadas.indexOf('girar') < chamadas.indexOf('role'));
  assert.equal(royal.marcados.length, 0);
  liberar(); await promise;
  assert.equal(royal.marcados.length, 1);
  assert.deepEqual(royal.marcados[0], { guildId: 'guild-a', userId: 'user-a', request: 'interaction-001' });
  assert.match(corpo(i), /Cargo concedido/);
});

test('falha de cargo ou confirmação gera pendência auditada e não esconde o prêmio', async () => {
  for (const falha of ['cargo', 'marcacao']) {
    preparar(); royal.resultado = { spin_id: 'spin-role', prize_name: 'VIP', reward_type: 'role', reward_value: 'role-1' };
    royal.erroMarca = falha === 'marcacao';
    const i = interacao({ componente: 'roletapro:girar' });
    i.member.roles.add = async () => { if (falha === 'cargo') throw new Error('hierarquia'); };
    await roleta.handleComponent(i);
    assert.match(corpo(i), /VIP/);
    assert.match(corpo(i), /pendente para a staff/);
    assert.ok(royal.auditados.some((a) => a.action === 'reward.delivery.pending' && a.entityId === 'spin-role'));
    assert.equal(royal.marcados.length, falha === 'cargo' ? 0 : 1);
  }
});

test('PIX é pendente para staff e nunca é anunciado como pago', async () => {
  preparar(); royal.resultado = { spin_id: 'spin-pix', prize_name: 'PIX R$ 10', reward_type: 'pix', reward_value: '10.00' };
  const i = interacao(); await roleta.comando.executar(i);
  assert.match(corpo(i), /pendente.*staff/);
  assert.match(corpo(i), /Nenhum pagamento foi confirmado/);
  assert.doesNotMatch(corpo(i), /pagamento (foi )?realizado|pix pago/i);
  assert.ok(royal.auditados.some((a) => a.action === 'reward.delivery.pending'));
});

test('histórico inclui coins, giros, PIX e cargo, filtra servidor e usuário e pagina todos', async () => {
  preparar();
  for (let n = 1; n <= 11; n++) premiacao(n, 'user-a', 'guild-a', n === 10 ? 'role' : n === 11 ? 'pix' : n === 9 ? 'spins' : 'coins', n === 9 ? '3' : '50', n === 10 || n === 11 ? 'pending' : null);
  premiacao(12, 'user-b', 'guild-a', 'coins', '999');
  premiacao(13, 'user-a', 'guild-b', 'coins', '777');
  const primeira = interacao({ componente: 'roletapro:premios' });
  await roleta.handleComponent(primeira);
  assert.match(corpo(primeira), /Prêmio 11/);
  assert.match(corpo(primeira), /PIX · pendente/);
  assert.match(corpo(primeira), /Cargo · entrega pendente/);
  assert.match(corpo(primeira), /3 giro\(s\)/);
  assert.match(corpo(primeira), /50 coins/);
  assert.doesNotMatch(corpo(primeira), /Prêmio 12|Prêmio 13|999|777/);
  assert.deepEqual(botoes(primeira.respostas[0]).map((b) => b.custom_id), ['roletapro:premios:1']);
  const proxima = interacao({ componente: 'roletapro:premios:1' });
  await roleta.handleComponent(proxima);
  assert.match(corpo(proxima), /Prêmio 1\*\*/);
  assert.deepEqual(botoes(proxima.respostas[0]).map((b) => b.custom_id), ['roletapro:premios:0']);
  const busca = supabase.cliente.consultas.find((q) => q.tabela === 'royal_roulette_spins');
  assert.deepEqual(busca.filtros, [['guild_id', 'guild-a'], ['user_id', 'user-a']]);
  assert.deepEqual(busca.range, [0, 8]);
  const entrega = supabase.cliente.consultas.find((q) => q.tabela === 'royal_reward_deliveries');
  assert.deepEqual(entrega.filtros, [['guild_id', 'guild-a'], ['user_id', 'user-a']]);
});

test('histórico usa snapshot do sorteio mesmo que a configuração do prêmio mude', async () => {
  preparar();
  premiacao(1, 'user-a', 'guild-a', 'coins', '999');
  Object.assign(base.historico[0], {
    prize_name_snapshot: 'Cargo original', reward_type_snapshot: 'role', reward_value_snapshot: 'id-antigo',
    royal_roulette_prizes: { name: 'Prêmio modificado', reward_type: 'coins', reward_value: '999' },
  });
  base.entregas.push({ guild_id: 'guild-a', user_id: 'user-a', request_id: 'spin:req-1', status: 'delivered' });
  const i = interacao({ componente: 'roletapro:premios' });
  await roleta.handleComponent(i);
  assert.match(corpo(i), /Cargo original/);
  assert.match(corpo(i), /Cargo · entrega registrada/);
  assert.doesNotMatch(corpo(i), /Prêmio modificado|999 coins/);
});

test('histórico continua acessível no esquema antigo sem colunas de snapshot', async () => {
  preparar(); base.erroSnapshots = true;
  premiacao(1, 'user-a', 'guild-a', 'coins', '20');
  const i = interacao({ componente: 'roletapro:premios' }); await roleta.handleComponent(i);
  assert.match(corpo(i), /Prêmio 1/);
  assert.match(corpo(i), /20 coins/);
  const consultas = supabase.cliente.consultas.filter((q) => q.tabela === 'royal_roulette_spins');
  assert.equal(consultas.length, 2);
  assert.ok(consultas[0].colunas.includes('prize_name_snapshot'));
  assert.ok(!consultas[1].colunas.includes('prize_name_snapshot'));
});

test('sem giros e falhas posteriores à transação apresentam resposta privada honesta', async () => {
  preparar(); base.perfis.get('guild-a:user-a').spins = 0;
  let i = interacao({ componente: 'roletapro:girar' }); await roleta.handleComponent(i);
  assert.match(corpo(i), /não possui giros/); assert.match(corpo(i), /Giros disponíveis:\*\* 0/);
  preparar(); royal.erroPerfil = true;
  i = interacao(); await roleta.comando.executar(i);
  assert.match(corpo(i), /Você ganhou/); assert.match(corpo(i), /temporariamente indisponível/);
  preparar(); royal.erroGiro = 'erro de rede';
  i = interacao(); await roleta.comando.executar(i);
  assert.match(corpo(i), /Confira \*\*Meus Prêmios\*\* antes de tentar/);
});

test('IDs desconhecidos do prefixo são reconhecidos e respondidos privadamente', async () => {
  preparar(); const i = interacao({ componente: 'roletapro:naoexiste' });
  assert.equal(await roleta.handleComponent(i), true);
  assert.equal(i.deferPayload.flags & 64, 64);
  assert.match(corpo(i), /não é válido/);
  assert.ok(!chamadas.includes('girar'));
});


test('canal configurado prevalece, usa fetch e salva IDs do destino efetivo', async () => {
  preparar();
  supabase.valores.set('guild-a:roleta_canal', 'canal-configurado');
  const i = interacao({ sub: 'painel', admin: true });
  const destino = { ...i.channel, id: 'canal-configurado', async send(payload) {
    i.destino = payload; return { id: 'msg-destino', async pin() { i.pin = true; } };
  } };
  i.guild.channels.fetch = async (id) => { assert.equal(id, destino.id); return destino; };
  await roleta.comando.executar(i, { db: { client: supabase.cliente } });
  assert.ok(i.destino); assert.equal(i.publicados.length, 0); assert.equal(i.pin, true);
  assert.match(corpo(i), /canal-configurado.*fixado/);
  assert.deepEqual(JSON.parse(supabase.configs[0][2]), { channel_id: destino.id, message_id: 'msg-destino' });
  assert.equal(supabase.configs[0][3], supabase.cliente);
});

test('não publica em canal errado se leitura, resolução, guild, tipo ou permissões falharem', async () => {
  for (const falha of ['leitura', 'ausente', 'guild', 'tipo', 'ver', 'enviar', 'fetch']) {
    preparar(); const i = interacao({ sub: 'painel', admin: true });
    supabase.valores.set('guild-a:roleta_canal', 'config');
    if (falha === 'leitura') supabase.erroLeitura = true;
    if (falha === 'fetch') i.guild.channels.fetch = async () => { throw new Error('negado'); };
    if (!['ausente', 'leitura', 'fetch'].includes(falha)) {
      i.guild.channels.cache.set('config', {
        ...i.channel, id: 'config', guildId: falha === 'guild' ? 'guild-b' : 'guild-a',
        type: falha === 'tipo' ? ChannelType.GuildVoice : ChannelType.GuildText,
        permissionsFor: () => ({ has: (p) => p !== (falha === 'ver' ? PermissionFlagsBits.ViewChannel : falha === 'enviar' ? PermissionFlagsBits.SendMessages : 0n) }),
        async send() { throw new Error('não deve enviar'); },
      });
    }
    await roleta.comando.executar(i);
    assert.equal(i.publicados.length, 0, falha); assert.equal(supabase.configs.length, 0, falha);
    assert.match(corpo(i), /nenhum painel foi publicado/i, falha);
    assert.equal(i.deferPayload.flags & 64, 64);
  }
});

test('fixação falha sem impedir publicação e informa não fixado', async () => {
  preparar(); const i = interacao({ sub: 'painel', admin: true });
  i.channel.send = async (payload) => { i.publicados.push(payload); return { id: 'msg', async pin() { throw new Error('sem permissão'); } }; };
  await roleta.comando.executar(i);
  assert.match(corpo(i), /não fixado/); assert.equal(supabase.configs.length, 1);
});

test('histórico PIX apresenta status consultado, desconhecido ao faltar registro ou falhar consulta', async () => {
  preparar();
  premiacao(1, 'user-a', 'guild-a', 'pix', '5.00', 'pending');
  premiacao(2, 'user-a', 'guild-a', 'pix', '5.00', 'delivered');
  premiacao(3, 'user-a', 'guild-a', 'pix', '5.00', null);
  const i = interacao({ componente: 'roletapro:premios' }); await roleta.handleComponent(i);
  assert.match(corpo(i), /PIX · pendente.*pagamento não confirmado/);
  assert.match(corpo(i), /PIX · entrega registrada pela staff/);
  assert.match(corpo(i), /PIX · status de entrega desconhecido/);
  const consulta = supabase.cliente.consultas.find((q) => q.tabela === 'royal_reward_deliveries');
  assert.deepEqual(new Set(consulta.in[1]), new Set(['spin:req-1', 'spin:req-2', 'spin:req-3']));
  base.erroEntregas = true;
  const erro = interacao({ componente: 'roletapro:premios' }); await roleta.handleComponent(erro);
  assert.equal((corpo(erro).match(/status de entrega desconhecido/g) || []).length, 3);
  assert.doesNotMatch(corpo(erro), /entrega registrada|PIX · pendente/);
});

test('aviso de pendência vem após auditoria, usa protocolo do giro e não altera resultado se falhar', async () => {
  for (const tipo of ['pix', 'role']) {
    preparar(); royal.resultado = { spin_id: 'spin-interno', prize_name: 'Prêmio', reward_type: tipo, reward_value: 'chave-PIX-nao-divulgar' };
    avisos.falhar = true;
    const i = interacao({ componente: 'roletapro:girar' });
    i.member.roles.add = async () => { throw new Error('sem cargo'); };
    await roleta.handleComponent(i);
    assert.match(corpo(i), /pendente/);
    assert.equal(avisos.chamados.length, 1);
    assert.equal(avisos.chamados[0].protocolo, 'spin:interaction-001');
    assert.doesNotMatch(avisos.chamados[0].descricao, /chave-PIX-nao-divulgar/);
    assert.ok(chamadas.lastIndexOf('auditar') < chamadas.indexOf('aviso'));
    assert.doesNotMatch(corpo(i), /staff avisada|aviso enviado/i);
  }
  preparar(); royal.resultado.reward_type = 'role'; const i = interacao({ componente: 'roletapro:girar' });
  i.member.roles.add = async () => {};
  await roleta.handleComponent(i); assert.equal(avisos.chamados.length, 0);
});


test('canal atual exige permissão apropriada em thread e falha de envio não tenta outro canal', async () => {
  for (const modo of ['thread-permitida', 'thread-negada', 'envio']) {
    preparar(); const i = interacao({ sub: 'painel', admin: true });
    i.channel.type = modo.startsWith('thread') ? ChannelType.PublicThread : ChannelType.GuildText;
    i.channel.permissionsFor = () => ({ has: (p) => !(modo === 'thread-negada' && p === PermissionFlagsBits.SendMessagesInThreads) });
    if (modo === 'envio') i.channel.send = async () => { throw new Error('falha de envio'); };
    await roleta.comando.executar(i);
    if (modo === 'thread-permitida') { assert.equal(i.publicados.length, 1); assert.match(corpo(i), /publicado/); }
    else { assert.equal(i.publicados.length, 0); assert.equal(supabase.configs.length, 0); assert.match(corpo(i), /não pode enviar|Não consegui publicar/i); }
  }
});
