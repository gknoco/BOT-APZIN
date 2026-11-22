'use strict';

/** Testes offline dos itens 5, 6, 7 e 10. Execute: node testes/comandos-polish.js */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EmbedBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');
const utilidades = require('../src/comandos/utilidades');
const comunidade = require('../src/comandos/comunidade');
const limpeza = require('../src/comandos/limpeza');
const moderacao = require('../src/comandos/moderacao');
const staffComandos = require('../src/comandos/staff');
const registro = require('../src/comandos');
const perfil = require('../src/comandos/perfil');
const royalSupabase = require('../src/servicos/royalSupabase');
const persistencia = require('../src/servicos/supabase');
const versiculos = require('../src/servicos/versiculos');
const partidas = require('../src/servicos/partidas');
const paineis = require('../src/servicos/paineis');
const blacklist = require('../src/servicos/blacklist');
const auditoria = require('../src/servicos/auditoria');
const staffServico = require('../src/servicos/staff');
const staffSupabase = require('../src/servicos/staffSupabase');
const fluxo = require('../src/servicos/fluxo');
const botPerfil = require('../src/comandos/botperfil');
const mestres = require('../src/comandos/comandosMestres');

const proximoTurno = () => new Promise((resolve) => setImmediate(resolve));
const erroDiscord = (code) => Object.assign(new Error(`Discord ${code}`), { code });
const comando = (modulo, nome) => modulo.comandos.find((item) => item.data.name === nome);

async function substituindo(alteracoes, executar) {
  const originais = alteracoes.map(([objeto, chave, valor]) => {
    const original = objeto[chave];
    objeto[chave] = valor;
    return [objeto, chave, original];
  });
  try { return await executar(); }
  finally { for (const [objeto, chave, original] of originais) objeto[chave] = original; }
}

test('/meusconvites mostra somente os dados de convite do usuário executante', async () => {
  const i = interaction();
  i.deferred = false;
  const chamadas = [];
  await substituindo([
    [royalSupabase, 'contarConvites', async (guildId, userId) => {
      chamadas.push(['contagem', guildId, userId]);
      return 4;
    }],
    [royalSupabase, 'conviteDoUsuario', async (guildId, userId) => {
      chamadas.push(['origem', guildId, userId]);
      return { convidador_id: 'quem-convidou' };
    }],
  ], async () => comando(perfil, 'meusconvites').executar(i));
  assert.deepEqual(chamadas, [
    ['contagem', 'guild-teste', 'executor-secreto'],
    ['origem', 'guild-teste', 'executor-secreto'],
  ]);
  const resposta = i.respostas[0];
  assert.match(resposta.embeds[0].toJSON().description, /convidou \*\*4\*\* pessoa/);
  assert.match(resposta.embeds[0].toJSON().description, /<@quem-convidou>/);
  assert.equal(resposta.flags & MessageFlags.Ephemeral, MessageFlags.Ephemeral);
});

function interaction(opcoes = {}) {
  const respostas = [];
  const i = {
    guildId: 'guild-teste', channelId: 'canal-teste', deferred: true, replied: false,
    user: { id: 'executor-secreto', username: 'nome-executor-secreto' },
    member: { permissions: { has: () => true } },
    memberPermissions: { has: () => true },
    options: {
      getSubcommand: () => null, getString: () => null, getNumber: () => null,
      getInteger: () => null, getBoolean: () => null, getChannel: () => null,
      getUser: () => null,
    },
    editReply: async (payload) => { respostas.push(payload); return payload; },
    reply: async (payload) => { respostas.push(payload); return payload; },
    followUp: async (payload) => { respostas.push(payload); return payload; },
    deleteReply: async () => {},
    respostas,
    ...opcoes,
  };
  return i;
}

function clienteFake(resolver = () => ({ data: [], count: 0, error: null })) {
  const chamadas = [];
  const client = {
    from(tabela) {
      const chamada = { tabela, operacoes: [] };
      chamadas.push(chamada);
      const query = {};
      for (const metodo of ['select', 'eq', 'in', 'like', 'order', 'range', 'limit', 'insert', 'upsert', 'delete', 'maybeSingle']) {
        query[metodo] = (...args) => { chamada.operacoes.push([metodo, ...args]); return query; };
      }
      query.then = (resolve, reject) => Promise.resolve().then(async () => {
        await proximoTurno();
        return resolver(chamada);
      }).then(resolve, reject);
      return query;
    },
  };
  return { client, chamadas };
}

function banco(client) {
  return { client, motor: 'supabase', prepare() { throw new Error('SQL local proibido'); } };
}

function tamanhoPayload(payload) {
  return (payload.content || '').length + (payload.embeds || []).reduce((total, item) => {
    const e = item.toJSON();
    return total + (e.title || '').length + (e.description || '').length + (e.footer?.text || '').length +
      (e.author?.name || '').length + (e.fields || []).reduce((soma, f) => soma + f.name.length + f.value.length, 0);
  }, 0);
}

test('aliases intencionais usam roteamento único e não duplicam definições', () => {
  assert.ok(botPerfil.comandos.some((c) => c.data.name === 'botperfil'));
  assert.deepEqual(mestres.comandos.map((c) => c.data.name), ['configroleta']);
  assert.equal(new Set(registro.nomes).size, registro.nomes.length);
});

test('/clear e /clearall compartilham permissões e tratam mensagens antigas', () => {
  assert.deepEqual(limpeza.comandos.map((c) => c.data.name), ['clearall', 'clear']);
  const clear = comando(limpeza, 'clear').data.toJSON();
  assert.equal(clear.options[0].max_value, 100000);
  assert.equal(limpeza.podeLimpar({ memberPermissions: { has: (p) => p === PermissionFlagsBits.Administrator } }), true);
});

test('anúncios preservam diferença de menção e rejeitam canal de outra guild', () => {
  const anuncio = comando(moderacao, 'anunciar').data.toJSON();
  assert.deepEqual(anuncio.options.find((o) => o.name === 'canal').channel_types, [0, 5, 10, 11, 12]);
  assert.throws(() => moderacao.validarCanalAnuncio(
    { guildId: 'guild-a' },
    { id: 'canal-b', guildId: 'guild-b', type: 0, send: async () => {} },
  ), /pertencer a este servidor/);
  assert.equal(comando(moderacao, 'anunciar2').data.toJSON().options[0].max_length, 1800);
});

test('perfil privado não expõe seus campos sensíveis no placar público', () => {
  const perfil = fs.readFileSync(path.join(__dirname, '../src/comandos/perfil.js'), 'utf8');
  const verp = fs.readFileSync(path.join(__dirname, '../src/comandos/verp.js'), 'utf8');
  assert.match(perfil, /responderPrivado\(interaction/);
  assert.match(perfil, /resumo\.coins/);
  assert.match(perfil, /resumo\.giros/);
  assert.match(verp, /defer: 'publico'/);
  assert.doesNotMatch(verp, /resumo\.coins|resumo\.giros|pix_chave|historicoApostas/);
});

test('/addgiros e o botão Ajustar giros usam o mesmo contrato de auditoria', () => {
  const economia = fs.readFileSync(path.join(__dirname, '../src/comandos/economia.js'), 'utf8');
  const configuracao = fs.readFileSync(path.join(__dirname, '../src/comandos/configEconomia.js'), 'utf8');
  assert.equal((economia.match(/royal\.auditarAjusteGiros/g) || []).length, 1);
  assert.equal((configuracao.match(/royal\.auditarAjusteGiros/g) || []).length, 1);
  const royal = fs.readFileSync(path.join(__dirname, '../src/servicos/royalSupabase.js'), 'utf8');
  assert.match(royal, /action: 'wallet\.spins\.adjust'/);
  assert.match(royal, /entityType: 'profile'/);
});

test('/ajuda inclui todos os nomes e subcomandos reais, sem aliases inventados', () => {
  const paginas = utilidades.ajudaEmbeds(registro.comandos);
  const texto = paginas.map((e) => e.toJSON().description).join('\n');
  for (const item of registro.comandos) {
    const json = item.data.toJSON();
    assert.ok(texto.includes(`**/${json.name}**`), `Ausente: /${json.name}`);
    for (const sub of json.options || []) {
      if (sub.type === 1) assert.ok(texto.includes(`/${json.name} ${sub.name}`));
      if (sub.type === 2) for (const aninhado of sub.options || []) {
        if (aninhado.type === 1) assert.ok(texto.includes(`/${json.name} ${sub.name} ${aninhado.name}`));
      }
    }
  }
  for (const nome of ['minhassalas', 'painelcomprar', 'setcargo', 'permicompras', 'cupomcompras', 'meusconvites', 'painelpixss', 'painelrecarga']) {
    assert.ok(texto.includes(`**/${nome}**`));
  }
  assert.ok(!texto.includes('**/configcanal**'), 'O nome real é configcanal1');
  assert.ok(paginas.some((e) => /compras/.test(e.toJSON().title)));
});

test('/painelrecarga publica, fixa e registra no Supabase o painel com banner e três botões oficiais', async () => {
  const fake = clienteFake();
  let publicado;
  let fixado = false;
  const canal = {
    id: 'canal-recarga',
    send: async (payload) => {
      publicado = payload;
      return { pin: async () => { fixado = true; } };
    },
  };
  const i = interaction({
    guild: { ownerId: 'id-dono' },
    channel: canal,
    memberPermissions: { has: () => true },
  });

  await comando(registro, 'painelrecarga').executar(i, { db: banco(fake.client) });

  const banner = path.join(__dirname, '../assets/recarga-royal-ap.png');
  assert.ok(fs.existsSync(banner));
  const bytes = fs.readFileSync(banner);
  assert.equal(bytes.toString('hex', 0, 8), '89504e470d0a1a0a');
  assert.equal(bytes.readUInt32BE(16), 1514);
  assert.equal(bytes.readUInt32BE(20), 704);
  assert.equal(publicado.files.length, 1);
  assert.equal(publicado.files[0].name, 'recarga-royal-ap.png');
  const embed = publicado.embeds[0].toJSON();
  assert.equal(embed.image.url, 'attachment://recarga-royal-ap.png');
  assert.equal(embed.description, undefined);
  assert.equal(embed.fields, undefined);
  assert.equal(embed.footer, undefined);
  assert.equal(publicado.components.length, 1);
  const botoes = publicado.components[0].toJSON().components;
  assert.deepEqual(botoes.map((botao) => [botao.label, botao.emoji.name, botao.style]), [
    ['Gerar Pix', '➕', 3],
    ['Sala Infinita', '♾️', 2],
    ['Extrato', '🧾', 2],
  ]);
  assert.equal(fixado, true);
  const salvar = fake.chamadas.find((chamada) => chamada.tabela === 'discord_configuracoes');
  assert.ok(salvar);
  const upsert = salvar.operacoes.find(([nome]) => nome === 'upsert');
  assert.deepEqual(upsert[1], {
    guild_id: 'guild-teste',
    chave: 'canal_recarga',
    valor: 'canal-recarga',
    atualizado_em: upsert[1].atualizado_em,
  });
  assert.ok(Number.isFinite(Date.parse(upsert[1].atualizado_em)));
  assert.match(i.respostas.at(-1).embeds[0].toJSON().description, /registrado no Supabase/);
});

test('cada página da ajuda respeita os limites totais de embeds e seleção', () => {
  const paginas = utilidades.ajudaEmbeds();
  for (let n = 0; n < paginas.length; n += 1) {
    const payload = utilidades.ajudaPagina(paginas, n);
    assert.equal(payload.embeds.length, 1);
    assert.ok(tamanhoPayload(payload) <= 6000);
    assert.ok(payload.embeds[0].toJSON().description.length <= 4096);
    const menu = payload.components[0].toJSON().components[0];
    assert.ok(menu.options.length >= 1 && menu.options.length <= 25);
    assert.equal(menu.options.find((o) => o.default).value, String(n));
    assert.ok(menu.options.every((o) => o.label.length <= 100));
  }
  const primeiro = utilidades.ajudaPagina(paginas, 0).components[1].toJSON();
  const ultimo = utilidades.ajudaPagina(paginas, paginas.length - 1).components[1].toJSON();
  assert.equal(primeiro.components[0].disabled, true);
  assert.equal(ultimo.components[1].disabled, true);
});

test('ajuda extensa continua navegável, sem limite de 25 páginas nem perda de texto', () => {
  const blocos = Array.from({ length: 80 }, (_, n) => `Comando ${n}: ${'x'.repeat(700)}`);
  const descricoes = utilidades.dividirAjuda(blocos);
  assert.ok(descricoes.every((p) => p.length <= 3800));
  for (let n = 0; n < 80; n += 1) assert.ok(descricoes.join('\n').includes(`Comando ${n}:`));
  const paginas = Array.from({ length: 61 }, (_, n) => new EmbedBuilder().setTitle(`Categoria ${n}`).setDescription('Ajuda'));
  for (const n of [0, 24, 25, 49, 50, 60]) {
    const menu = utilidades.ajudaPagina(paginas, n).components[0].toJSON().components[0];
    assert.ok(menu.options.length <= 25);
    assert.ok(menu.options.some((o) => o.value === String(n) && o.default));
  }
});

test('/ajuda responde uma página e mantém seletor e botões privados operantes', async () => {
  const eventos = {};
  let filtro;
  const mensagem = {
    createMessageComponentCollector: (config) => {
      filtro = config.filter;
      return { on: (nome, callback) => { eventos[nome] = callback; } };
    },
  };
  const i = interaction({ editReply: async (payload) => { i.respostas.push(payload); return mensagem; } });
  const fake = clienteFake();
  await comando(utilidades, 'ajuda').executar(i, { db: banco(fake.client) });
  assert.equal(fake.chamadas[0].tabela, 'discord_configuracoes');
  assert.ok(fake.chamadas[0].operacoes.some(([metodo, campo, valor]) => metodo === 'eq' && campo === 'guild_id' && valor === i.guildId));
  assert.ok(fake.chamadas[0].operacoes.some(([metodo, campo, valor]) => metodo === 'like' && campo === 'chave' && valor === 'ajuda:cargos:%'));
  assert.equal(i.respostas[0].embeds.length, 1);
  assert.ok(filtro({ user: i.user, customId: 'ajuda:proxima' }));
  assert.equal(filtro({ user: { id: 'outra-pessoa' }, customId: 'ajuda:proxima' }), false);
  let atual;
  await eventos.collect({ customId: 'ajuda:proxima', update: async (payload) => { atual = payload; } });
  assert.match(atual.content, /Página 2 de/);
  await eventos.collect({ customId: 'ajuda:categoria', values: ['4'], update: async (payload) => { atual = payload; } });
  assert.match(atual.content, /Página 5 de/);
  eventos.end();
  await proximoTurno();
  assert.ok(i.respostas.at(-1).components.every((linha) => linha.toJSON().components.every((c) => c.disabled)));
});

test('/versiculododia usa ACK privado e envio público separado sem nome ou menção', async () => {
  const cmd = comando(comunidade, 'versiculododia');
  assert.equal(registro.modoDefer(cmd), 'privado');
  const publicos = [];
  const fakeClient = {};
  const i = interaction({
    deferred: false,
    channel: { isTextBased: () => true, send: async (payload) => { publicos.push(payload); } },
  });
  await substituindo([[versiculos, 'sortear', async (opcoes) => {
    assert.equal(opcoes.cliente, fakeClient);
    await proximoTurno();
    return { versiculo: { texto: 'Texto de teste', referencia: 'Livro 1:1' } };
  }]], async () => cmd.executar(i, { db: banco(fakeClient) }));
  assert.equal(publicos.length, 1);
  assert.deepEqual(publicos[0].allowedMentions, { parse: [] });
  const texto = JSON.stringify(publicos[0]);
  assert.doesNotMatch(texto, /executor-secreto|nome-executor-secreto|<@|interaction|author|avatar/);
  assert.equal(i.respostas[0].flags, MessageFlags.Ephemeral);
  assert.ok(!i.respostas[0].embeds);
});

test('boas-vindas, saída, logs e categoria salvam somente no Supabase e aguardam a escrita', async () => {
  const fake = clienteFake();
  const db = banco(fake.client);
  const canal = { id: 'canal-config', name: 'config', isTextBased: () => true, send: async () => {}, toString: () => '<#canal-config>' };
  const opcoes = [
    [comunidade, 'configcanal1', null, 'canal_boas_vindas'],
    [comunidade, 'configcanal2', null, 'canal_saida'],
    [moderacao, 'logs', null, 'canal_logs'],
    [utilidades, 'boombot', 'setlog', 'canal_logs'],
    [utilidades, 'boombot', 'setcategoria', 'categoria_filas'],
  ];
  for (const [modulo, nome, sub, chave] of opcoes) {
    const i = interaction();
    i.options.getChannel = () => canal;
    i.options.getSubcommand = () => sub;
    const inicio = fake.chamadas.length;
    await comando(modulo, nome).executar(i, { db });
    assert.equal(fake.chamadas.length, inicio + 1, 'Não deve existir espelho ou segunda gravação');
    const chamada = fake.chamadas.at(-1);
    assert.equal(chamada.tabela, 'discord_configuracoes');
    const upsert = chamada.operacoes.find(([m]) => m === 'upsert');
    assert.equal(upsert[1].chave, chave);
    assert.equal(upsert[1].valor, canal.id);
    assert.equal(upsert[2].onConflict, 'guild_id,chave');
    assert.equal(i.respostas.length, 1);
  }
});

test('falha na persistência de canal não confirma sucesso nem usa fallback local', async () => {
  const fake = clienteFake(() => ({ error: { message: 'indisponível' } }));
  const i = interaction({ channel: { id: 'config', isTextBased: () => true, send: async () => {} } });
  await assert.rejects(comando(comunidade, 'configcanal1').executar(i, { db: banco(fake.client) }), /indisponível/);
  assert.equal(i.respostas.length, 0);
});

test('/painel aguarda serviços de partidas e painéis e conta filas remotas', async () => {
  const fake = clienteFake(() => ({ count: 7, error: null }));
  const db = banco(fake.client);
  const client = {};
  const i = interaction({ client });
  await substituindo([
    [partidas, 'ativasReais', async (bancoAtual, guildId, clienteAtual) => {
      assert.equal(bancoAtual, db);
      assert.equal(guildId, i.guildId);
      assert.equal(clienteAtual, client);
      await proximoTurno();
      return [{ id: 'p1' }, { id: 'p2' }];
    }],
    [paineis, 'todos', async () => { await proximoTurno(); return [{ modo: 'x1' }]; }],
  ], async () => comando(utilidades, 'painel').executar(i, { db }));
  const campos = i.respostas[0].embeds[0].toJSON().fields;
  assert.equal(campos[0].value, '2');
  assert.equal(campos[1].value, '7');
  assert.equal(campos[2].value, '1/15');
  assert.equal(fake.chamadas[0].tabela, 'royal_filas');
});

test('/boombot status consulta tabelas operacionais e auditoria reais', async () => {
  const fake = clienteFake(() => ({ count: 3, error: null }));
  const i = interaction();
  i.options.getSubcommand = () => 'status';
  await comando(utilidades, 'boombot').executar(i, { db: banco(fake.client), client: { ws: { ping: 20 }, guilds: { cache: { size: 1 } } } });
  assert.deepEqual(fake.chamadas.map((c) => c.tabela).sort(), ['royal_audit_events', 'royal_paineis', 'royal_partidas', 'royal_profiles']);
  assert.match(JSON.stringify(i.respostas[0]), /Supabase/);
});

test('/logs aguarda canal remoto e eventos sem configuração local', async () => {
  const fake = clienteFake(() => ({ data: { valor: 'canal-logs' }, error: null }));
  const i = interaction();
  await substituindo([[auditoria, 'recentes', async () => {
    await proximoTurno();
    return [{ criado_em: Date.now(), acao: 'Ação de teste', detalhe: 'Persistente' }];
  }]], async () => comando(moderacao, 'logs').executar(i, { db: banco(fake.client) }));
  const json = i.respostas[0].embeds[0].toJSON();
  assert.match(json.description, /Persistente/);
  assert.equal(json.fields[0].value, '<#canal-logs>');
});

test('/blacklist aguarda adicionar/listar/remover antes de confirmar', async () => {
  const db = banco({});
  let persistiu = false;
  await substituindo([
    [blacklist, 'listar', async () => { await proximoTurno(); return [{ user_id: 'alvo', autor_id: 'admin', motivo: 'teste', criado_em: Date.now() }]; }],
    [blacklist, 'adicionar', async () => { await proximoTurno(); persistiu = true; }],
    [blacklist, 'remover', async () => { await proximoTurno(); return false; }],
    [auditoria, 'registrar', async () => { assert.equal(persistiu, true); }],
  ], async () => {
    for (const sub of ['listar', 'adicionar', 'remover']) {
      const i = interaction();
      i.options.getSubcommand = () => sub;
      i.options.getUser = () => ({ id: 'alvo' });
      i.options.getString = () => 'teste';
      await comando(moderacao, 'blacklist').executar(i, { db });
      assert.equal(i.respostas.length, 1);
      if (sub === 'remover') assert.match(JSON.stringify(i.respostas[0]), /não estava na lista negra/);
    }
  });
});

test('/enviar_dm grava royal_logs_dm e /limpardm apaga só o histórico do alvo/servidor', async () => {
  const fake = clienteFake((c) => ({ count: c.operacoes.some(([m]) => m === 'delete') ? 4 : null, error: null }));
  let entregou = false;
  const alvo = { id: 'destinatario', send: async () => { entregou = true; } };
  const i = interaction();
  i.options.getUser = () => alvo;
  i.options.getString = () => 'Mensagem auditável';
  await substituindo([[auditoria, 'registrar', async () => {}]], async () => {
    await comando(moderacao, 'enviar_dm').executar(i, { db: banco(fake.client) });
  });
  assert.equal(entregou, true);
  const insercao = fake.chamadas[0].operacoes.find(([m]) => m === 'insert')[1];
  assert.equal(fake.chamadas[0].tabela, 'royal_logs_dm');
  assert.equal(insercao.guild_id, i.guildId);
  assert.equal(insercao.user_id, alvo.id);
  assert.equal(insercao.autor_id, i.user.id);
  assert.ok(Number.isInteger(insercao.criado_em));
  await comando(moderacao, 'limpardm').executar(i, { db: banco(fake.client) });
  const apagar = fake.chamadas.at(-1);
  assert.ok(apagar.operacoes.some(([m, campo, valor]) => m === 'eq' && campo === 'guild_id' && valor === i.guildId));
  assert.ok(apagar.operacoes.some(([m, campo, valor]) => m === 'eq' && campo === 'user_id' && valor === alvo.id));
  assert.match(i.respostas.at(-1).content, /\*\*4\*\*/);
});

test('consultas staff paginam além de 500 registros e não escondem falhas Supabase', async () => {
  const fake = clienteFake((c) => {
    const intervalo = c.operacoes.find(([m]) => m === 'range');
    return { data: Array.from({ length: intervalo[1] === 0 ? 500 : 7 }, (_, n) => ({ id: intervalo[1] + n })), error: null };
  });
  const todos = await staffComandos.lerPaginado(banco(fake.client), 'royal_partidas', 'id', (q) => q.eq('guild_id', 'g').order('id'));
  assert.equal(todos.length, 507);
  assert.equal(fake.chamadas.length, 2);
  const falha = clienteFake(() => ({ error: { message: 'erro de leitura' } }));
  await assert.rejects(staffComandos.lerPaginado(banco(falha.client), 'royal_partidas', 'id', (q) => q), /erro de leitura/);
});

test('/pix busca salas no Supabase e aguarda anúncio sem alterar geração financeira', async () => {
  const fake = clienteFake(() => ({ data: [{ id: 'pix-partida', canal_id: 'canal-teste', mediador_id: 'executor-secreto', status: 'pago' }], error: null }));
  let anunciou = false;
  await substituindo([
    [staffSupabase, 'temCargoMediador', async () => true],
    [staffSupabase, 'obter', async () => ({ pix_chave: 'chave-privada', pix_titular: 'titular' })],
    [fluxo, 'anunciarPix', async (_client, _db, dados) => { await proximoTurno(); assert.equal(dados.partidaId, 'pix-partida'); anunciou = true; }],
    [auditoria, 'registrar', async () => { assert.equal(anunciou, true); }],
  ], async () => comando(staffComandos, 'pix').executar(interaction(), { db: banco(fake.client) }));
  assert.equal(anunciou, true);
  assert.equal(fake.chamadas[0].tabela, 'royal_partidas');
});

test('/clearall trata 10008 em exclusões individuais e em massa', async () => {
  const mensagem = (id, apagar) => ({ id, createdTimestamp: Date.now(), delete: apagar });
  assert.equal(await limpeza.apagarSeExiste(mensagem('a', async () => { throw erroDiscord(10008); })), false);
  const mensagens = [mensagem('a', async () => { throw erroDiscord(10008); }), mensagem('b', async () => {})];
  assert.equal(await limpeza.apagarLote({ bulkDelete: async () => { throw erroDiscord(10008); } }, mensagens), 1);
  assert.equal(await limpeza.apagarLote({ bulkDelete: async () => new Map([['b', mensagens[1]]]) }, mensagens), 1);
  await assert.rejects(limpeza.apagarSeExiste(mensagem('a', async () => { throw erroDiscord(50013); })), /50013/);
});

test('/clearall trata Unknown Channel durante fetch e delete, sem esconder outros erros', async () => {
  const canal = (fetch) => ({ isTextBased: () => true, messages: { fetch }, bulkDelete: async () => new Map() });
  assert.equal(await limpeza.apagarTudo(canal(async () => { throw erroDiscord(10003); })), 0);
  assert.equal(await limpeza.apagarTudo(canal(async () => new Map([['a', { id: 'a', createdTimestamp: Date.now(), delete: async () => { throw erroDiscord(10003); } }]]))), 0);
  await assert.rejects(limpeza.apagarTudo(canal(async () => { throw erroDiscord(50013); })), /50013/);
  const permissao = interaction({ deleteReply: async () => { throw erroDiscord(50013); } });
  await assert.rejects(limpeza.removerResposta(permissao), /50013/);
  for (const code of [10008, 10003, 10015, 10062, 50027]) {
    await limpeza.removerResposta(interaction({ deleteReply: async () => { throw erroDiscord(code); } }));
  }
});

test('nenhum dos cinco arquivos autorizados usa SQL local ou CAMINHO_BANCO', () => {
  for (const nome of ['utilidades', 'comunidade', 'limpeza', 'moderacao', 'staff']) {
    const fonte = fs.readFileSync(path.join(__dirname, `../src/comandos/${nome}.js`), 'utf8');
    assert.doesNotMatch(fonte, /\.prepare\(|\.transaction\(|CAMINHO_BANCO|fallback local|configuração local/);
  }
});
