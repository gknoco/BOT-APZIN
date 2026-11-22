'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const { test } = require('node:test');
const { PermissionFlagsBits, ChannelType } = require('discord.js');
const animacaoReal = require('../src/servicos/roletaAnimada');

const chamadas = [];
const temporizacoes = [];
const girosAnimados = [];
const base = { historico: [], entregas: [], premios: [], itens: [], perfis: new Map(), resultados: new Map(), paineis: new Map() };
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
    this.valores.set(`${args[0]}:${args[1]}`, args[2]);
  },
};
const avisos = { chamados: [], falhar: false, async avisarStaff(interaction, dados) {
  chamadas.push('aviso'); this.chamados.push({ interaction, ...dados });
  if (this.falhar) throw new Error('falha no aviso');
} };
const animacaoFake = {
  ...animacaoReal,
  async animar(interaction, catalogo, resultado, payloadFinal, criarEmbedGiro, duracaoSegundos) {
    const duracao = this.validarDuracaoSegundos(duracaoSegundos);
    const { lista, indice } = this.prepararPremios(catalogo, resultado);
    const angulo = this.planejarGiro(indice, lista.length, duracao).at(-1);
    const nomeGiro = `roleta-${interaction.id}-giro.gif`;
    girosAnimados.push({ duracao, lista, premio: lista[indice], indice, angulo });
    await interaction.editReply({ embeds: [criarEmbedGiro().setImage(`attachment://${nomeGiro}`)],
      files: [{ name: nomeGiro, attachment: Buffer.from('GIF89a') }], attachments: [], allowedMentions: { parse: [] } });
    temporizacoes.push(duracao * 1000);
    const nomeFinal = `roleta-${interaction.id}-resultado.png`;
    payloadFinal.embeds[0].setImage(`attachment://${nomeFinal}`);
    return interaction.editReply({ ...payloadFinal,
      files: [{ name: nomeFinal, attachment: this.desenharQuadro(lista, angulo) }],
      attachments: [], allowedMentions: { parse: [] } });
  },
};
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
    async rpc(nome, args) {
      assert.equal(nome, 'royal_rescue_action');
      if (args.p_action === 'claim') return { data: { result: 'acquired', user_id: royal.ultimoGiro.userId,
        reward_type: royal.resultado.reward_type, reward_value: royal.resultado.reward_value }, error: null };
      try {
        await royal.marcarRecompensaEntregue({ guildId: args.p_guild_id, userId: royal.ultimoGiro.userId, request: args.p_request_id });
        return { data: { result: 'finished' }, error: null };
      } catch (error) { return { data: null, error }; }
    },
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
  if (parent?.filename === path.resolve(__dirname, '../src/comandos/roletaPro.js') && request === '../servicos/roletaAnimada') return animacaoFake;
  if (parent?.filename === path.resolve(__dirname, '../src/servicos/roletaAnimada.js') && request === 'node:timers/promises') return {
    setTimeout: async (ms) => { temporizacoes.push(ms); }, setImmediate: async () => {},
  };
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
  temporizacoes.length = 0;
  girosAnimados.length = 0;
  base.historico = []; base.entregas = []; base.premios = []; base.itens = []; base.erroSnapshots = false; base.erroEntregas = false; base.perfis = new Map(); base.resultados = new Map(); base.paineis = new Map();
  base.perfis.set('guild-a:user-a', { spins: 5, coins: 0 });
  base.perfis.set('guild-a:user-b', { spins: 2, coins: 0 });
  supabase.configs = []; supabase.erroConfig = null; supabase.erroLeitura = null; supabase.valores = new Map(); supabase.cliente = clienteMemoria();
  avisos.chamados = []; avisos.falhar = false;
  royal.resultado = { spin_id: 's-1', prize_name: 'Prêmio', reward_type: 'coins', reward_value: '50' };
  royal.erroGiro = null; royal.erroPerfil = null; royal.erroMarca = null; royal.auditados = []; royal.marcados = [];
  fsFalso.existe = false;
}
function interacao({ id = 'interaction-001', usuario = 'user-a', guild = 'guild-a', componente = null, sub = 'girar', admin = false, tipo = 'button', fields = {} } = {}) {
  const role = { id: '123456789012345678', position: 1, managed: false, editable: true };
  const mensagens = new Map();
  const membro = { roles: { cache: new Map(), async add(cargo) { this.cache.set(cargo.id, true); } } };
  let i;
  const canal = {
    id: 'canal-1', guildId: guild, type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => true }),
    messages: { async fetch(messageId) { const m = mensagens.get(String(messageId)) || base.paineis.get(`${guild}:canal-1:${messageId}`); if (!m) throw new Error('mensagem não encontrada'); return m; } },
    async send(payload) {
      chamadas.push('send'); i.publicados.push(payload);
      const m = { id: 'mensagem-1', author: { id: 'bot-a' }, embeds: payload.embeds.map((e) => e.toJSON()), components: payload.components,
        async pin() { chamadas.push('pin'); },
        async edit(atualizacao) {
          chamadas.push('editar-painel');
          Object.assign(m, atualizacao);
          if (atualizacao.embeds) m.embeds = atualizacao.embeds.map((e) => e.toJSON());
        },
      };
      mensagens.set(m.id, m);
      base.paineis.set(`${guild}:canal-1:${m.id}`, m);
      return m;
    },
  };
  i = {
    id, guildId: guild, user: { id: usuario }, customId: componente, deferred: false, replied: false,
    guild: { id: guild, ownerId: 'owner', client: { user: { id: 'bot-a' } }, members: { me: { permissions: { has: (p) => p === PermissionFlagsBits.ManageRoles }, roles: { highest: { position: 5 } } }, cache: new Map([[usuario, membro]]) }, roles: { cache: new Map([[role.id, role], ['role-1', { id: 'role-1', position: 1, managed: false, editable: true }]]) }, channels: { cache: new Map([['canal-1', canal]]), async fetch(id) { return id === 'canal-1' ? canal : null; } } }, member: membro,
    memberPermissions: { has: (permission) => admin && permission === PermissionFlagsBits.Administrator },
    channel: canal,
    options: { getSubcommand: () => sub }, publicados: [], respostas: [],
    fields: { getTextInputValue: (key) => fields[key] ?? '' },
    isButton: () => tipo === 'button', isModalSubmit: () => tipo === 'modal',
    async showModal(modal) { chamadas.push('showModal'); i.modal = modal.toJSON(); i.replied = true; },
    async reply(payload) { chamadas.push('reply'); i.respostas.push(payload); i.replied = true; },
    async deferReply(payload) { chamadas.push('defer'); i.deferPayload = payload; i.deferred = true; },
    async editReply(payload) { chamadas.push('edit'); i.respostas.push(payload); return payload; },
  };
  return i;
}
async function publicar(interaction, ctx = {}) {
  return roleta.comando.executar(interaction, ctx);
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
  assert.deepEqual(json.options.map((o) => o.name), ['painel']);
  const i = interacao({ componente: 'outro:botao' });
  assert.equal(await roleta.handleComponent(i), false);
  assert.deepEqual(chamadas, []);
});

test('painel somente para admin é enviado realmente em canal e confirmação é efêmera', async () => {
  preparar();
  const negado = interacao({ sub: 'painel' });
  await publicar(negado);
  assert.equal(negado.deferPayload.flags & 64, 64);
  assert.equal(negado.publicados.length, 0);
  assert.match(corpo(negado), /Somente administradores/);
  assert.deepEqual(supabase.configs, []);

  const admin = interacao({ sub: 'painel', admin: true });
  await publicar(admin, { db: { client: supabase.cliente } });
  const painel = admin.publicados[0];
  assert.equal(admin.deferPayload.flags & 64, 64);
  assert.equal(painel.flags, undefined);
  assert.deepEqual(painel.allowedMentions, { parse: [] });
  assert.deepEqual(botoes(painel).map((b) => [b.custom_id, b.label]), [
    ['roletapro:girar', '🎰 Girar'], ['roletapro:premios', '🎁 Meus Prêmios'],
  ]);
  assert.equal(painel.embeds[0].toJSON().color, 0xb20d1c);
  assert.doesNotMatch(painel.embeds[0].toJSON().description, /5|2|Giros disponíveis/);
  assert.deepEqual(supabase.configs[0].slice(0, 3), ['guild-a', 'painel_roleta', '{"channel_id":"canal-1","message_id":"mensagem-1"}']);
  assert.match(corpo(admin), /publicado/);
  assert.deepEqual(botoes(admin.respostas.at(-1)).map((b) => [b.custom_id, b.label]), [
    ['roletapro:editarpainel:guild-a:user-a', 'editar msm painel'],
  ]);
});

test('banner usa AttachmentBuilder e attachment://; ausência tem fallback válido', async () => {
  preparar();
  let i = interacao({ sub: 'painel', admin: true });
  await publicar(i);
  assert.deepEqual(i.publicados[0].files, []);
  assert.equal(i.publicados[0].embeds[0].toJSON().image, undefined);
  fsFalso.existe = true;
  i = interacao({ id: 'interaction-002', sub: 'painel', admin: true });
  await publicar(i);
  assert.equal(i.publicados[0].files[0].name, 'roleta-royal-ap.png');
  assert.equal(i.publicados[0].embeds[0].toJSON().image.url, 'attachment://roleta-royal-ap.png');
});

test('editar msm painel abre modal preenchido, atualiza a mensagem existente e persiste a personalização', async () => {
  preparar();
  const publicador = interacao({ sub: 'painel', admin: true });
  await publicar(publicador);
  const publico = publicador.publicados[0];
  const botao = interacao({ id: 'edit-button', componente: 'roletapro:editarpainel:guild-a:user-a', admin: true });
  await roleta.handleComponent(botao);
  assert.equal(chamadas.includes('showModal'), true);
  assert.equal(botao.deferred, false);
  const input = botao.modal.components[0].components[0];
  assert.equal(input.custom_id, 'texto');
  assert.equal(input.value, publico.embeds[0].toJSON().description);
  assert.equal(botao.modal.title, 'Editar painel da roleta');

  const textoNovo = '🎰 **ROLETA ROYAL AP**\n\nTexto personalizado\nLinha final.';
  const modal = interacao({ id: 'edit-modal', componente: 'roletapro:editarpainel:guild-a:user-a:modal', admin: true, tipo: 'modal', fields: { texto: textoNovo } });
  await roleta.handleComponent(modal);
  assert.equal(modal.deferPayload.flags & 64, 64);
  assert.match(corpo(modal), /atualizado e salvo/);
  assert.equal(base.paineis.get('guild-a:canal-1:mensagem-1').embeds[0].description, textoNovo);
  assert.equal(base.paineis.get('guild-a:canal-1:mensagem-1').embeds[0].title, undefined);
  assert.equal(base.paineis.get('guild-a:canal-1:mensagem-1').components[0].components.length, 2);
  assert.equal(supabase.valores.get('guild-a:painel_roleta_texto'), textoNovo);

  const novaPublicacao = interacao({ id: 'republish', sub: 'painel', admin: true });
  await publicar(novaPublicacao);
  assert.equal(novaPublicacao.publicados[0].embeds[0].toJSON().description, textoNovo);
});

test('somente administradores podem abrir o modal de edição do painel', async () => {
  preparar();
  const i = interacao({ componente: 'roletapro:editarpainel:guild-a:user-a', admin: false });
  await roleta.handleComponent(i);
  assert.equal(i.modal, undefined);
  assert.match(i.respostas[0].embeds[0].toJSON().description, /Somente administradores/);
});

test('painel apresenta exatamente a mensagem padrão e os dez prêmios informados', async () => {
  preparar();
  const i = interacao({ sub: 'painel', admin: true });
  await publicar(i);
  const painel = i.publicados[0].embeds[0].toJSON();
  assert.equal(painel.title, undefined);
  assert.equal(painel.description, [
    '🎰 **ROLETA ROYAL AP**', '', 'A sorte está na sua mão.',
    'Use seus **giros** para disputar os prêmios exclusivos da roleta.', '',
    '━━━━━━━━━━━━━━━━━━━━', '', '🎯 **Como funciona**',
    '• **Girar** — usa 1 giro e sorteia um prêmio',
    '• **Meus Prêmios** — veja seu saldo e histórico privado', '',
    '━━━━━━━━━━━━━━━━━━━━', '', '🏆 **Prêmios disponíveis**', '',
    '• Fiel da Royal Ap', '• AURA MAXIMA', '• BABA OVO DO DONO', '• Real Trem',
    '• Verdadeiro Gangster', '• Mira Chiclete', '• AURA + EGO', '• RAINHA DOS APS',
    '• Dono Do Cabaré', '• AS LAVA PATRO', '', '━━━━━━━━━━━━━━━━━━━━', '',
    '📌 *Os resultados e saldos são exibidos somente para você.*',
    '*Imagem ilustrativa. Os prêmios e estoques são definidos pela configuração da roleta.*',
  ].join('\n'));
  assert.equal(painel.footer, undefined);
  assert.equal(supabase.cliente.consultas.some((q) => q.tabela === 'royal_roulette_prizes'), false);
});

test('se configuração falha, informa que o painel já foi publicado sem induzir a republicação', async () => {
  preparar(); supabase.erroConfig = true;
  const i = interacao({ sub: 'painel', admin: true });
  await publicar(i);
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

test('botão do painel usa RPC e resposta privada, sem modificar o painel público', async () => {
  preparar();
  const botao = interacao({ id: 'button-001', componente: 'roletapro:girar', usuario: 'user-a' });
  assert.equal(await roleta.handleComponent(botao), true);
  assert.equal(botao.deferPayload.flags & 64, 64);
  assert.deepEqual(royal.ultimoGiro, { guildId: 'guild-a', userId: 'user-a', request: 'button-001' });
  assert.match(corpo(botao), /Giros disponíveis:\*\* 4/);
  assert.match(corpo(botao), /coins foram creditadas/);
  assert.equal(botao.publicados.length, 0);
  assert.equal(botao.deferPayload.flags & 64, 64);
  assert.match(botao.respostas[0].embeds[0].toJSON().title, /SORTEANDO/);
  assert.ok(chamadas.indexOf('defer') < chamadas.indexOf('edit'));
  assert.ok(chamadas.indexOf('edit') < chamadas.indexOf('girar'));
});

test('repetir o mesmo ID de interação mantém a mesma chave e não consome outro giro', async () => {
  preparar();
  await roleta.handleComponent(interacao({ id: 'mesmo-001', componente: 'roletapro:girar' }));
  const repeticao = interacao({ id: 'mesmo-001', componente: 'roletapro:girar' });
  await roleta.handleComponent(repeticao);
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
  preparar(); royal.resultado = { spin_id: 'spin-role', prize_name: 'VIP', reward_type: 'role', reward_value: '123456789012345678' };
  let liberar;
  const i = interacao({ componente: 'roletapro:girar' });
  i.member.roles.add = async (role) => { assert.equal(role.id, '123456789012345678'); chamadas.push('role'); await new Promise((resolve) => { liberar = resolve; }); };
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
    preparar(); royal.resultado = { spin_id: 'spin-role', prize_name: 'VIP', reward_type: 'role', reward_value: '123456789012345678' };
    royal.erroMarca = falha === 'marcacao';
    const i = interacao({ componente: 'roletapro:girar' });
    i.member.roles.add = async () => { if (falha === 'cargo') throw new Error('hierarquia'); };
    await roleta.handleComponent(i);
    assert.match(corpo(i), /VIP/);
    assert.match(corpo(i), /requer revisão/);
    assert.ok(royal.auditados.some((a) => a.action === 'reward.delivery.pending' && a.entityId === 'spin-role'));
    assert.equal(royal.marcados.length, falha === 'cargo' ? 0 : 1);
  }
});

test('PIX é pendente para staff e nunca é anunciado como pago', async () => {
  preparar(); royal.resultado = { spin_id: 'spin-pix', prize_name: 'PIX R$ 10', reward_type: 'pix', reward_value: '10.00' };
  const i = interacao({ componente: 'roletapro:girar' }); await roleta.handleComponent(i);
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
  i = interacao({ componente: 'roletapro:girar' }); await roleta.handleComponent(i);
  assert.match(corpo(i), /Você ganhou/); assert.match(corpo(i), /temporariamente indisponível/);
  preparar(); royal.erroGiro = 'erro de rede';
  i = interacao({ componente: 'roletapro:girar' }); await roleta.handleComponent(i);
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
  await publicar(i, { db: { client: supabase.cliente } });
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
    await publicar(i);
    assert.equal(i.publicados.length, 0, falha); assert.equal(supabase.configs.length, 0, falha);
    assert.match(corpo(i), /nenhum painel foi publicado/i, falha);
    assert.equal(i.deferPayload.flags & 64, 64);
  }
});

test('fixação falha sem impedir publicação e informa não fixado', async () => {
  preparar(); const i = interacao({ sub: 'painel', admin: true });
  i.channel.send = async (payload) => { i.publicados.push(payload); return { id: 'msg', async pin() { throw new Error('sem permissão'); } }; };
  await publicar(i);
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
    assert.match(corpo(i), /pendente|revisão/);
    assert.equal(avisos.chamados.length, 1);
    assert.equal(avisos.chamados[0].protocolo, 'spin:interaction-001');
    assert.doesNotMatch(avisos.chamados[0].descricao, /chave-PIX-nao-divulgar/);
    assert.ok(chamadas.lastIndexOf('auditar') < chamadas.indexOf('aviso'));
    assert.doesNotMatch(corpo(i), /staff avisada|aviso enviado/i);
  }
  preparar(); royal.resultado.reward_type = 'role'; royal.resultado.reward_value = '123456789012345678'; const i = interacao({ componente: 'roletapro:girar' });
  i.member.roles.add = async () => {};
  await roleta.handleComponent(i); assert.equal(avisos.chamados.length, 0);
});


test('canal atual exige permissão apropriada em thread e falha de envio não tenta outro canal', async () => {
  for (const modo of ['thread-permitida', 'thread-negada', 'envio']) {
    preparar(); const i = interacao({ sub: 'painel', admin: true });
    i.channel.type = modo.startsWith('thread') ? ChannelType.PublicThread : ChannelType.GuildText;
    i.channel.permissionsFor = () => ({ has: (p) => !(modo === 'thread-negada' && p === PermissionFlagsBits.SendMessagesInThreads) });
    if (modo === 'envio') i.channel.send = async () => { throw new Error('falha de envio'); };
    await publicar(i);
    if (modo === 'thread-permitida') { assert.equal(i.publicados.length, 1); assert.match(corpo(i), /publicado/); }
    else { assert.equal(i.publicados.length, 0); assert.equal(supabase.configs.length, 0); assert.match(corpo(i), /não pode enviar|Não consegui publicar/i); }
  }
});


test('quadros e resultado final usam o prêmio exato retornado pela RPC, mesmo após mudança no catálogo', async () => {
  preparar();
  base.premios = [
    { id: 'a', guild_id: 'guild-a', active: true, name: 'Outro prêmio', reward_type: 'coins', reward_value: '5', weight: 2, stock: null },
    { id: 'b', guild_id: 'guild-a', active: true, name: 'Nome antigo', reward_type: 'coins', reward_value: '50', weight: 1, stock: 1 },
    { id: 'c', guild_id: 'guild-a', active: true, name: 'Esgotado', reward_type: 'coins', reward_value: '1', weight: 1, stock: 0 },
  ];
  royal.resultado = { spin_id: 's-ganho', prize_id: 'b', prize_name: 'Prêmio confirmado', reward_type: 'coins', reward_value: '50' };
  supabase.valores.set('guild-a:roleta_duracao_segundos', '12');
  const i = interacao({ componente: 'roletapro:girar' });
  await roleta.handleComponent(i);
  const quadros = i.respostas.filter((r) => r.files?.length);
  assert.equal(quadros.length, 2);
  assert.match(quadros[0].files[0].name, /-giro\.gif$/);
  assert.match(quadros[1].files[0].name, /-resultado\.png$/);
  assert.deepEqual(temporizacoes, [12000]);
  assert.equal(girosAnimados.at(-1).duracao, 12);
  assert.deepEqual(girosAnimados.at(-1).lista.map((premio) => premio.id), ['a', 'b']);
  assert.deepEqual(i.respostas[0].files, []);
  assert.deepEqual(i.respostas[0].attachments, []);
  assert.deepEqual(i.respostas[0].components, []);
  assert.equal(i.respostas[0].embeds[0].toJSON().image, undefined);
  assert.match(corpo(i), /Você ganhou \*\*Prêmio confirmado\*\*/);
  assert.match(corpo(i), /coins foram creditadas/);
  assert.equal(royal.ultimoGiro.request, i.id);
  assert.equal(base.resultados.get(`guild-a:${i.id}`).prize_id, 'b');
  const { lista, indice } = animacaoReal.prepararPremios(base.premios.filter((p) => p.stock !== 0), royal.resultado);
  const angulo = animacaoReal.planejarGiro(indice, lista.length, 12).at(-1);
  assert.equal(animacaoReal.indiceNoPonteiro(angulo, lista.length), indice);
  assert.deepEqual(quadros.at(-1).files[0].attachment, animacaoReal.desenharQuadro(lista, angulo));
  assert.equal(quadros.at(-1).embeds[0].toJSON().image.url, `attachment://${quadros.at(-1).files[0].name}`);
});

test('bloqueia o mesmo usuário durante a animação sem bloquear outro jogador', async () => {
  preparar();
  const primeira = interacao({ id: 'primeira', componente: 'roletapro:girar' });
  let liberar;
  primeira.editReply = async (payload) => {
    primeira.respostas.push(payload);
    if (payload.files?.length && !liberar) await new Promise((resolve) => { liberar = resolve; });
  };
  const executando = roleta.handleComponent(primeira);
  while (!liberar) await new Promise((resolve) => setImmediate(resolve));
  const repetida = interacao({ id: 'segunda', componente: 'roletapro:girar' });
  await roleta.handleComponent(repetida);
  assert.match(corpo(repetida), /giro em andamento/i);
  assert.equal(chamadas.filter((x) => x === 'girar').length, 1);
  const outro = interacao({ id: 'outro', usuario: 'user-b', componente: 'ap:roletagirar' });
  await roleta.handleComponent(outro);
  assert.match(corpo(outro), /Você ganhou/);
  assert.equal(chamadas.filter((x) => x === 'girar').length, 2);
  liberar();
  await executando;
  assert.equal(base.perfis.get('guild-a:user-a').spins, 4);
  const depois = interacao({ id: 'depois', componente: 'roletapro:girar' });
  await roleta.handleComponent(depois);
  assert.match(corpo(depois), /Você ganhou/);
  assert.equal(base.perfis.get('guild-a:user-a').spins, 3);
});

test('falha da imagem não refaz o sorteio e remove o quadro antigo antes de informar o prêmio', async () => {
  preparar();
  royal.resultado = { spin_id: 's-1', prize_id: 'a', prize_name: 'Prêmio salvo', reward_type: 'coins', reward_value: '50' };
  const i = interacao({ componente: 'roletapro:girar' });
  i.editReply = async (payload) => {
    if (payload.files?.length) throw new Error('falha no anexo');
    i.respostas.push(payload);
  };
  await roleta.handleComponent(i);
  assert.equal(chamadas.filter((x) => x === 'girar').length, 1);
  assert.match(corpo(i), /Prêmio salvo/);
  assert.match(corpo(i), /animação ficou indisponível/i);
  assert.deepEqual(i.respostas.at(-1).attachments, []);
  assert.deepEqual(i.respostas.at(-1).files, []);
  assert.equal(base.perfis.get('guild-a:user-a').spins, 4);
});


test('o despachante do botão legado também usa a roleta animada e resposta privada', async () => {
  preparar();
  const i = interacao({ id: 'legado', componente: 'ap:roletagirar' });
  i.deferUpdate = async () => { throw new Error('não deve atualizar o painel público'); };
  const { handleBotao } = require('../src/interacoes/botoes');
  assert.equal(await handleBotao(i, {}), true);
  assert.equal(i.deferPayload.flags & 64, 64);
  assert.equal(i.respostas.filter((r) => r.files?.length).length, 2);
  assert.match(corpo(i), /Você ganhou/);
  assert.equal(chamadas.filter((x) => x === 'girar').length, 1);
});


test('restaura o painel salvo na inicialização sem substituir imagem, botões ou mensagem', async () => {
  preparar();
  supabase.valores.set('guild-a:painel_roleta', JSON.stringify({ channel_id: 'canal-1', message_id: 'painel-1' }));
  const i = interacao({ sub: 'painel', admin: true });
  i.guild.client = { user: { id: 'bot-a' } };
  const descricao = 'Texto original\nNa animação, os setores identificam os prêmios e não representam suas chances.\nFinal original.';
  const original = { title: 'ROLETA ROYAL AP', description: descricao, color: 0xfacc15,
    image: { url: 'https://cdn.discordapp.com/attachments/canal/painel/roleta-royal-ap.png' },
    footer: { text: 'ROYAL AP  •  ROLETA  •  SORTEIOS REGISTRADOS' } };
  let alteracao;
  const mensagem = { author: { id: 'bot-a' }, embeds: [original], async edit(payload) { alteracao = payload; } };
  i.guild.channels.cache.set('canal-1', { guildId: 'guild-a', messages: { async fetch(id) { assert.equal(id, 'painel-1'); return mensagem; } } });
  assert.equal(await roleta.restaurarPainelSalvo(i.guild, { db: { client: supabase.cliente } }), true);
  assert.equal(alteracao.embeds[0].toJSON().description, roleta.TEXTO_PADRAO_PAINEL);
  assert.equal(alteracao.embeds[0].toJSON().color, 0xb20d1c);
  assert.deepEqual(alteracao.embeds[0].toJSON().image, original.image);
  assert.equal(alteracao.embeds[0].toJSON().title, undefined);
  assert.equal(alteracao.embeds[0].toJSON().footer, undefined);
  assert.equal(alteracao.components, undefined);
  assert.equal(alteracao.files, undefined);
  assert.equal(alteracao.attachments, undefined);
  assert.equal(supabase.configs.length, 0);
  const personalizado = '🎰 **ROLETA ROYAL AP**\n\nVersão persistida.';
  supabase.valores.set('guild-a:painel_roleta_texto', personalizado);
  original.description = roleta.TEXTO_PADRAO_PAINEL;
  original.title = undefined;
  original.footer = undefined;
  alteracao = null;
  assert.equal(await roleta.restaurarPainelSalvo(i.guild, { db: { client: supabase.cliente } }), true);
  assert.equal(alteracao.embeds[0].toJSON().description, personalizado);
  mensagem.author.id = 'outro-bot';
  alteracao = null;
  await assert.rejects(roleta.restaurarPainelSalvo(i.guild, { db: { client: supabase.cliente } }), /não pertence a este bot/);
  assert.equal(alteracao, null);
});
