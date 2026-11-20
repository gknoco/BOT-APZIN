'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Routes, ApplicationCommandType, MessageFlags } = require('discord.js');

process.env.DISCORD_TOKEN ||= 'test.token.value';
const comandos = require('../src/comandos');
const utilidades = require('../src/comandos/utilidades');
const fluxo = require('../src/servicos/fluxo');
const { registrarComandos, limparComandoGo } = require('../src/servicos/registroComandos');

const app = '123456789012345678';
const guildA = '223456789012345678';
const guildB = '323456789012345678';

function textoAjuda() {
  return utilidades.ajudaEmbeds().map((pagina) => pagina.toJSON().description || '').join('\n');
}

test('/go não é registrado, roteado ou exibido na ajuda; comandos vizinhos permanecem', async () => {
  assert.equal(fs.existsSync(path.join(__dirname, '../src/comandos/go.js')), false);
  assert.equal(comandos.buscar('go'), null);
  assert.equal(comandos.nomes.includes('go'), false);
  assert.equal(comandos.definicoes().some((definicao) => definicao.name === 'go'), false);
  for (const nome of ['ajuda', 'ranking', 'painelfilas', 'vencedor', 'wo']) {
    assert.ok(comandos.buscar(nome), `comando removido indevidamente: /${nome}`);
    assert.ok(comandos.definicoes().some((definicao) => definicao.name === nome));
    assert.ok(textoAjuda().includes(`**/${nome}**`));
  }
  assert.doesNotMatch(textoAjuda(), /\*\*\/go\*\*/);
  let respondeu = false;
  const resultado = await comandos.executar({ commandName: 'go', deferReply: async () => { respondeu = true; } }, {});
  assert.equal(resultado, null);
  assert.equal(respondeu, false);
});

test('outros comandos seguem despachados com o modo de resposta original', async () => {
  for (const [nome, flags] of [['ajuda', MessageFlags.Ephemeral], ['ranking', undefined]]) {
    const comando = comandos.buscar(nome);
    const executarOriginal = comando.executar;
    const chamadas = [];
    const contexto = { teste: true };
    try {
      comando.executar = async (interaction, ctx) => {
        chamadas.push(['executar', interaction.commandName, ctx]);
        return 'feito';
      };
      const resultado = await comandos.executar({
        commandName: nome,
        deferReply: async (payload) => chamadas.push(['defer', payload]),
      }, contexto);
      assert.equal(resultado, 'feito');
      assert.deepEqual(chamadas, [
        ['defer', flags === undefined ? {} : { flags }],
        ['executar', nome, contexto],
      ]);
    } finally {
      comando.executar = executarOriginal;
    }
  }
});

test('aviso de sala liberada não instrui o uso do comando removido', () => {
  const partida = {
    id: 'p', status: fluxo.STATUS.SALA_LIBERADA, modo: 'solo', gelo: 'normal',
    preco: 50, sala_id: '1234', sala_senha: '5678',
  };
  const embed = fluxo.embedPartida(partida, []).toJSON();
  assert.doesNotMatch(embed.description, /\/go\b/i);
  assert.match(embed.description, /ID e a senha/);
  assert.equal(embed.fields.find((campo) => campo.name === 'ID da sala').value, '`1234`');
  assert.equal(embed.fields.find((campo) => campo.name === 'Senha').value, '`5678`');
  const botoes = fluxo.componentesPartida(partida).flatMap((linha) => linha.toJSON().components);
  assert.ok(botoes.some((botao) => botao.custom_id === 'ap:vencer:p:1'));
  assert.ok(botoes.some((botao) => botao.custom_id === 'ap:wo:p:1'));
});

test('sincronização substitui apenas o escopo solicitado, com todos os outros comandos preservados no payload', async () => {
  for (const guildId of [null, guildA]) {
    const chamadas = [];
    const rest = { put: async (rota, payload) => { chamadas.push({ rota, payload }); } };
    const definicoes = comandos.definicoes();
    const resultado = await registrarComandos({ clientId: app, guildId, definicoes, rest });
    assert.equal(chamadas.length, 1);
    assert.equal(chamadas[0].rota, guildId ? Routes.applicationGuildCommands(app, guildId) : Routes.applicationCommands(app));
    assert.deepEqual(chamadas[0].payload.body, definicoes);
    assert.ok(definicoes.some((comando) => comando.name === 'ajuda'));
    assert.equal(definicoes.some((comando) => comando.name === 'go'), false);
    assert.equal(resultado.quantidade, definicoes.length);
  }
});

test('limpeza de outros escopos remove somente /go por ID, não substitui nem apaga os demais', async () => {
  const global = Routes.applicationCommands(app);
  const guild1 = Routes.applicationGuildCommands(app, guildA);
  const guild2 = Routes.applicationGuildCommands(app, guildB);
  const listas = new Map([
    [global, [
      { id: '1', name: 'go', type: ApplicationCommandType.ChatInput },
      { id: '2', name: 'go', type: ApplicationCommandType.User },
      { id: '3', name: 'ajuda', type: ApplicationCommandType.ChatInput },
    ]],
    [guild1, [
      { id: '4', name: 'go', type: ApplicationCommandType.ChatInput },
      { id: '5', name: 'go', type: ApplicationCommandType.Message },
      { id: '6', name: 'gosto', type: ApplicationCommandType.ChatInput },
    ]],
    [guild2, [{ id: '7', name: 'ranking', type: ApplicationCommandType.ChatInput }]],
  ]);
  const lidas = [];
  const apagadas = [];
  const rest = {
    get: async (rota) => { lidas.push(rota); return listas.get(rota); },
    delete: async (rota) => { apagadas.push(rota); },
    put: async () => assert.fail('não deve substituir comandos de outros escopos'),
  };
  const resultado = await limparComandoGo({ clientId: app, incluirGlobal: true, guildIds: [guildA, guildA, guildB, 'invalido'], rest });
  assert.deepEqual(lidas, [global, guild1, guild2]);
  assert.deepEqual(apagadas, [Routes.applicationCommand(app, '1'), Routes.applicationGuildCommand(app, guildA, '4')]);
  assert.deepEqual(resultado, { removidos: 2, erros: [] });
});

test('falhas de listagem ou exclusão são registradas e não impedem limpeza dos outros escopos', async () => {
  const global = Routes.applicationCommands(app);
  const guild1 = Routes.applicationGuildCommands(app, guildA);
  const guild2 = Routes.applicationGuildCommands(app, guildB);
  const apagadas = [];
  const rest = {
    get: async (rota) => {
      if (rota === global) throw new Error('global indisponível');
      if (rota === guild1) return [{ id: '11', name: 'go', type: ApplicationCommandType.ChatInput }];
      if (rota === guild2) return [{ id: '22', name: 'go', type: ApplicationCommandType.ChatInput }];
      assert.fail(`rota inesperada: ${rota}`);
    },
    delete: async (rota) => {
      if (rota === Routes.applicationGuildCommand(app, guildA, '11')) throw new Error('sem permissão');
      apagadas.push(rota);
    },
  };
  const resultado = await limparComandoGo({ clientId: app, incluirGlobal: true, guildIds: [guildA, guildB], rest });
  assert.deepEqual(apagadas, [Routes.applicationGuildCommand(app, guildB, '22')]);
  assert.equal(resultado.removidos, 1);
  assert.deepEqual(resultado.erros.map((erro) => erro.escopo), ['global', guildA]);
  assert.match(resultado.erros[0].mensagem, /global indisponível/);
  assert.match(resultado.erros[1].mensagem, /sem permissão/);
});

test('manifesto, lockfile e deploy exigem Node mínimo alinhado às dependências', () => {
  const pacote = require('../package.json');
  const lock = require('../package-lock.json');
  assert.equal(pacote.engines.node, '>=22.12.0');
  assert.equal(lock.packages[''].engines.node, pacote.engines.node);
  assert.equal(lock.packages['node_modules/@discordjs/voice'].engines.node, '>=22.12.0');
  assert.match(fs.readFileSync(path.join(__dirname, '../nixpacks.toml'), 'utf8'), /npm ci[^\n]*--engine-strict/);
  assert.match(pacote.scripts['migrate:supabase'], /--experimental-sqlite/);
});

test('instalação Nixpacks remove variáveis npm legadas e omite apenas dependências de desenvolvimento', () => {
  const nixpacks = fs.readFileSync(path.join(__dirname, '../nixpacks.toml'), 'utf8');
  const secoes = nixpacks.split(/^\[/m);
  const instalacao = secoes.find((secao) => secao.startsWith('phases.install]'));
  const inicio = secoes.find((secao) => secao.startsWith('start]'));
  const comando = instalacao?.match(/^cmds\s*=\s*\[\s*"([^"\n]+)"\s*\]\s*$/m)?.[1];
  assert.ok(comando, 'comando de instalação Nixpacks ausente');
  assert.doesNotMatch(instalacao, /^cmd\s*=/m);
  assert.match(comando, /\bnpm\s+ci\b/);
  assert.match(comando, /(?:^|\s)--omit=dev(?:\s|$)/);
  assert.match(comando, /(?:^|\s)--engine-strict(?:\s|$)/);
  assert.doesNotMatch(comando, /(?:^|\s)--production(?:[=\s]|$)/);
  assert.match(inicio || '', /^cmd\s*=\s*"node index\.js"\s*$/m);
  assert.equal(require('../package.json').scripts.start, 'node index.js');

  // Projeto local sem rede: comprova o comando real sem apagar node_modules do projeto.
  const diretorio = fs.mkdtempSync(path.join(os.tmpdir(), 'royal-nixpacks-'));
  const escreverJson = (arquivo, dados) => fs.writeFileSync(path.join(diretorio, arquivo), JSON.stringify(dados));
  try {
    for (const [pasta, nome] of [['prod', 'production-example'], ['dev', 'development-example']]) {
      fs.mkdirSync(path.join(diretorio, 'packages', pasta), { recursive: true });
      escreverJson(`packages/${pasta}/package.json`, { name: nome, version: '1.0.0' });
      fs.writeFileSync(path.join(diretorio, 'packages', pasta, 'index.js'), 'module.exports = true;\n');
    }
    const dependencies = { 'production-example': 'file:packages/prod' };
    const devDependencies = { 'development-example': 'file:packages/dev' };
    escreverJson('package.json', { name: 'fixture', version: '1.0.0', dependencies, devDependencies });
    escreverJson('package-lock.json', {
      name: 'fixture', version: '1.0.0', lockfileVersion: 3, requires: true,
      packages: {
        '': { name: 'fixture', version: '1.0.0', dependencies, devDependencies },
        'node_modules/development-example': { resolved: 'packages/dev', link: true },
        'node_modules/production-example': { resolved: 'packages/prod', link: true },
        'packages/dev': { name: 'development-example', version: '1.0.0', dev: true },
        'packages/prod': { name: 'production-example', version: '1.0.0' },
      },
    });

    const ambiente = { ...process.env, HOME: diretorio };
    for (const chave of Object.keys(ambiente)) if (/^npm_config_/i.test(chave)) delete ambiente[chave];
    delete ambiente.NODE_ENV;
    Object.assign(ambiente, {
      npm_config_userconfig: path.join(diretorio, 'user.npmrc'),
      npm_config_globalconfig: path.join(diretorio, 'global.npmrc'),
      npm_config_cache: path.join(diretorio, 'cache'),
      npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false',
      NPM_CONFIG_PRODUCTION: 'true', npm_config_production: 'true',
    });
    const producao = spawnSync('sh', ['-c', comando], { cwd: diretorio, env: ambiente, encoding: 'utf8', timeout: 30000 });
    assert.equal(producao.status, 0, producao.stderr || producao.error?.message);
    assert.doesNotMatch(producao.stdout + producao.stderr, /npm warn config production/i);
    assert.equal(fs.existsSync(path.join(diretorio, 'node_modules/production-example')), true);
    assert.equal(fs.existsSync(path.join(diretorio, 'node_modules/development-example')), false);

    // Testes locais continuam podendo instalar devDependencies, inclusive sob NODE_ENV=production.
    delete ambiente.NPM_CONFIG_PRODUCTION;
    delete ambiente.npm_config_production;
    ambiente.NODE_ENV = 'production';
    const desenvolvimento = spawnSync('npm', ['ci', '--include=dev'], { cwd: diretorio, env: ambiente, encoding: 'utf8', timeout: 30000 });
    assert.equal(desenvolvimento.status, 0, desenvolvimento.stderr || desenvolvimento.error?.message);
    assert.equal(fs.existsSync(path.join(diretorio, 'node_modules/production-example')), true);
    assert.equal(fs.existsSync(path.join(diretorio, 'node_modules/development-example')), true);
  } finally {
    fs.rmSync(diretorio, { recursive: true, force: true });
  }
});

test('SQLite funciona com a flag compatível com Node 22.12 e Voice carrega sem flag', () => {
  const sqlite = spawnSync(process.execPath, ['--experimental-sqlite', '-e',
    "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');if(db.prepare('SELECT 42 AS resposta').get().resposta!==42)process.exit(1);db.close();"],
  { encoding: 'utf8' });
  assert.equal(sqlite.status, 0, sqlite.stderr || sqlite.error?.message);
  assert.equal(typeof require('@discordjs/voice').joinVoiceChannel, 'function');
});

test('inicialização solicita limpeza somente nos outros escopos e prossegue mesmo se ela falhar', async () => {
  const { EventEmitter } = require('node:events');
  const { Events } = require('discord.js');
  const registro = require('../src/servicos/registroComandos');
  const mediadores = require('../src/servicos/mediadores');
  const convites = require('../src/servicos/convites');
  const automacoes = require('../src/servicos/automacoesDiscord');
  const roleta = require('../src/comandos/roletaPro');
  const moduloEventos = require.resolve('../src/eventos');
  const anteriorEventos = require.cache[moduloEventos];
  const alteracoes = [
    [registro, 'registrarComandos'], [registro, 'limparComandoGo'],
    [mediadores, 'hidratarConfiguracaoRemota'], [convites, 'atualizarCache'],
    [automacoes, 'iniciar'], [roleta, 'restaurarPainelSalvo'],
    [comandos, 'executar'], [console, 'log'], [console, 'warn'],
  ];
  const originais = alteracoes.map(([objeto, chave]) => objeto[chave]);
  const avisos = [];
  console.log = () => {};
  console.warn = (...argumentos) => avisos.push(argumentos.join(' '));
  mediadores.hidratarConfiguracaoRemota = async () => {};
  convites.atualizarCache = async () => {};
  automacoes.iniciar = () => {};
  roleta.restaurarPainelSalvo = async () => {};
  let despachos = 0;
  comandos.executar = async () => { despachos += 1; };
  try {
    for (const escopo of [guildA, null]) {
      let rejeitarLimpeza;
      let parametrosLimpeza;
      registro.registrarComandos = async () => ({ guildId: escopo });
      registro.limparComandoGo = (parametros) => {
        parametrosLimpeza = parametros;
        return new Promise((_, reject) => { rejeitarLimpeza = reject; });
      };
      delete require.cache[moduloEventos];
      const { montar } = require('../src/eventos');
      const client = new EventEmitter();
      client.guilds = { cache: new Map([[guildA, { id: guildA }], [guildB, { id: guildB }]]) };
      client.user = { tag: 'teste', setActivity() {} };
      client.application = { id: app };
      const db = { client: { from: () => ({ select: async () => ({ count: 0, error: null }) }) } };
      montar(client, db);
      // O ready resolve apesar da limpeza ainda estar pendente.
      await client.listeners(Events.ClientReady)[0](client);
      assert.equal(parametrosLimpeza.clientId, app);
      assert.equal(parametrosLimpeza.incluirGlobal, Boolean(escopo));
      assert.deepEqual(parametrosLimpeza.guildIds, escopo ? [guildB] : [guildA, guildB]);
      await client.listeners(Events.InteractionCreate)[0]({ id: `interacao-${escopo}`, isChatInputCommand: () => true });
      rejeitarLimpeza(new Error('falha simulada'));
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(despachos, 2);
    assert.equal(avisos.filter((aviso) => aviso.includes('falha simulada')).length, 2);
  } finally {
    alteracoes.forEach(([objeto, chave], indice) => { objeto[chave] = originais[indice]; });
    if (anteriorEventos) require.cache[moduloEventos] = anteriorEventos;
    else delete require.cache[moduloEventos];
  }
});

test('sincronização manual verifica o escopo global quando publica em servidor', async () => {
  const registro = require('../src/servicos/registroComandos');
  const config = require('../src/config');
  const moduloScript = require.resolve('../scripts/registrar-comandos');
  const anteriorScript = require.cache[moduloScript];
  const alteracoes = [
    [registro, 'registrarComandos'], [registro, 'limparComandoGo'],
    [config, 'CLIENT_ID'], [config, 'GUILD_ID'], [config, 'validarToken'],
    [console, 'log'], [console, 'warn'],
  ];
  const originais = alteracoes.map(([objeto, chave]) => objeto[chave]);
  const logs = [];
  console.log = (...argumentos) => logs.push(argumentos.join(' '));
  console.warn = (...argumentos) => logs.push(argumentos.join(' '));
  config.CLIENT_ID = app;
  config.validarToken = () => null;
  try {
    for (const escopo of [guildA, null]) {
      config.GUILD_ID = escopo;
      let pedidoRegistro;
      const pedidosLimpeza = [];
      registro.registrarComandos = async (parametros) => {
        pedidoRegistro = parametros;
        return { guildId: escopo, quantidade: parametros.definicoes.length };
      };
      registro.limparComandoGo = async (parametros) => {
        pedidosLimpeza.push(parametros);
        return { removidos: 0, erros: [{ escopo: 'global', mensagem: 'falha simulada' }] };
      };
      delete require.cache[moduloScript];
      await require('../scripts/registrar-comandos').main();
      assert.equal(pedidoRegistro.guildId, escopo);
      assert.equal(pedidoRegistro.definicoes.some((comando) => comando.name === 'go'), false);
      assert.equal(pedidosLimpeza.length, escopo ? 1 : 0);
      if (escopo) assert.equal(pedidosLimpeza[0].incluirGlobal, true);
    }
    assert.ok(logs.some((linha) => linha.includes('falha simulada')));
    assert.ok(logs.some((linha) => linha.includes('Registros antigos de servidores')));
  } finally {
    alteracoes.forEach(([objeto, chave], indice) => { objeto[chave] = originais[indice]; });
    if (anteriorScript) require.cache[moduloScript] = anteriorScript;
    else delete require.cache[moduloScript];
  }
});
