'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const registro = require('../src/comandos');
const utilidades = require('../src/comandos/utilidades');

function textosDasPaginas(paginas) {
  return paginas.map((pagina) => pagina.toJSON().description).join('\n');
}

// A verificação caminha pela árvore registrada, inclusive grupos e opções.
function auditarDefinicao(definicao, texto) {
  assert.ok(texto.includes(`**/${definicao.name}** — ${definicao.description}`), `Falta /${definicao.name}`);
  function auditarOpcoes(opcoes, caminho) {
    for (const opcao of opcoes || []) {
      if (opcao.type === 1 || opcao.type === 2) {
        const nomeCompleto = `${caminho} ${opcao.name}`;
        const prefixo = opcao.type === 2 ? '  · Grupo' : '  ·';
        assert.ok(texto.includes(`${prefixo} /${nomeCompleto} — ${opcao.description}`), `Falta /${nomeCompleto}`);
        auditarOpcoes(opcao.options, nomeCompleto);
      } else {
        const obrigatoriedade = opcao.required ? 'obrigatória' : 'opcional';
        assert.ok(texto.includes(`  • \`${opcao.name}\` · ${obrigatoriedade} · `), `Falta opção /${caminho} ${opcao.name}`);
        assert.ok(texto.includes(` — ${opcao.description}`), `Falta descrição /${caminho} ${opcao.name}`);
        for (const escolha of opcao.choices || []) {
          assert.ok(texto.includes(`↳ \`${opcao.name}\`: \`${escolha.value}\` — ${escolha.name}`),
            `Falta escolha /${caminho} ${opcao.name}=${escolha.value}`);
        }
      }
    }
  }
  auditarOpcoes(definicao.options, definicao.name);
}

function verificarPayload(payload, indice) {
  assert.ok(payload.content.length <= 2000);
  assert.equal(payload.embeds.length, 1);
  const embed = payload.embeds[0].toJSON();
  assert.ok(embed.title.length <= 256);
  assert.ok(embed.description.length <= 4096);
  const caracteresEmbed = embed.title.length + embed.description.length + (embed.footer?.text || '').length;
  assert.ok(caracteresEmbed <= 6000);
  assert.ok(payload.components.length <= 5);
  const linhas = payload.components.map((linha) => linha.toJSON().components);
  assert.equal(linhas[0].length, 1);
  const menu = linhas[0][0];
  assert.ok(menu.options.length >= 1 && menu.options.length <= 25);
  assert.ok(menu.options.every((opcao) => opcao.label.length <= 100 && opcao.value.length <= 100));
  assert.equal(new Set(menu.options.map((opcao) => opcao.value)).size, menu.options.length);
  assert.equal(menu.options.filter((opcao) => opcao.default).length, 1);
  assert.equal(menu.options.find((opcao) => opcao.default).value, String(indice));
  assert.ok(linhas[1].length <= 5);
  assert.ok(linhas[1].every((botao) => botao.label.length <= 80 && botao.custom_id.length <= 100));
  assert.deepEqual(payload.allowedMentions, { parse: [] });
}

function definicaoEnorme() {
  return {
    name: 'supercomando', description: 'Teste de grupo com muitas opções', options: [{
      type: 2, name: 'grupo', description: 'Grupo de teste', options: [{
        type: 1, name: 'executar', description: 'Ação aninhada', options: Array.from({ length: 25 }, (_, n) => ({
          type: 3, name: `opcao_${n}`, description: `Descrição da opção ${n}`,
          required: n < 12, choices: Array.from({ length: 25 }, (_, escolha) => ({
            name: `Escolha ${n} ${escolha} ${'N'.repeat(65)}`,
            value: `valor_${n}_${escolha}_${'v'.repeat(65)}`,
          })),
        })),
      }],
    }],
  };
}

function comandosNumerosos() {
  return Array.from({ length: 180 }, (_, n) => ({
    name: `extra_${n}`, description: `Comando adicionado ${n}`, options: Array.from({ length: 8 }, (_, o) => ({
      type: 3, name: `opcao_${o}`, description: `Opção ${o} do comando ${n}; ${'descrição '.repeat(4)}`,
      required: o < 4, choices: Array.from({ length: 3 }, (_, escolha) => ({
        name: `Escolha ${escolha} do comando ${n}`, value: `valor_${n}_${o}_${escolha}`,
      })),
    })),
  }));
}

test('auditamos comandos, grupos, subcomandos, opções e escolhas do registro real', () => {
  const definicoes = registro.definicoes();
  assert.equal(new Set(definicoes.map((item) => item.name)).size, definicoes.length, 'Nomes duplicados no registro');
  const texto = textosDasPaginas(utilidades.ajudaEmbeds());
  for (const definicao of definicoes) {
    auditarDefinicao(definicao, texto);
    const formatado = utilidades.formatarComandoAjuda(definicao);
    for (const linha of formatado.split('\n')) assert.ok(texto.includes(linha), `Trecho ausente da ajuda: ${linha}`);
  }
  for (const nome of ['roleta', 'lojinha', 'loja', 'config', 'configroleta']) {
    assert.ok(definicoes.some((definicao) => definicao.name === nome), `Comando esperado não registrado: /${nome}`);
    assert.ok(texto.includes(`**/${nome}**`));
  }
  assert.ok(texto.includes('/config lojinha'));
  assert.ok(!texto.includes('/config roleta'));
});

test('opções de primeiro nível mostram obrigatoriedade, tipo, escolhas e limites', () => {
  const comando = {
    name: 'exemplo', description: 'Comando de teste', options: [
      { type: 4, name: 'quantidade', description: 'Quanto', required: true, min_value: 1, max_value: 50 },
      { type: 3, name: 'tipo', description: 'Qual', required: false, autocomplete: true, max_length: 32,
        choices: [{ name: 'Nome amigável', value: 'valor_real' }] },
      { type: 11, name: 'arquivo', description: 'Enviar arquivo', required: false },
      { type: 7, name: 'canal', description: 'Onde publicar', required: false, channel_types: [0, 5] },
    ],
  };
  const texto = textosDasPaginas(utilidades.ajudaEmbeds([comando]));
  assert.match(texto, /`quantidade` · obrigatória · inteiro · mín\. 1 · máx\. 50 — Quanto/);
  assert.match(texto, /`tipo` · opcional · texto · máx\. 32 caracteres · autocompletar — Qual/);
  assert.match(texto, /`tipo`: `valor_real` — Nome amigável/);
  assert.match(texto, /`arquivo` · opcional · anexo — Enviar arquivo/);
  assert.match(texto, /`canal` · opcional · canal · canais: texto, anúncios — Onde publicar/);
});

test('grupo extenso preserva todas as escolhas e repete o caminho ao mudar de página', () => {
  const definicao = definicaoEnorme();
  const paginas = utilidades.ajudaEmbeds([definicao]);
  assert.ok(paginas.length > 25, `Esperadas mais de 25 páginas; obtidas ${paginas.length}`);
  const texto = textosDasPaginas(paginas);
  auditarDefinicao(definicao, texto);
  for (const [indice, pagina] of paginas.entries()) {
    const descricao = pagina.toJSON().description;
    assert.ok(descricao.length <= 3800);
    assert.ok(descricao.includes('/supercomando grupo executar'), `Caminho ausente da página ${indice + 1}`);
    verificarPayload(utilidades.ajudaPagina(paginas, indice), indice);
  }
});

test('muitos comandos novos aparecem automaticamente e todas as páginas são navegáveis', () => {
  const definicoes = comandosNumerosos();
  const paginas = utilidades.ajudaEmbeds(definicoes);
  assert.ok(paginas.length > 25);
  const texto = textosDasPaginas(paginas);
  for (const definicao of definicoes) auditarDefinicao(definicao, texto);
  for (const [indice] of paginas.entries()) {
    const payload = utilidades.ajudaPagina(paginas, indice);
    verificarPayload(payload, indice);
    const botoes = payload.components[1].toJSON().components;
    assert.equal(botoes[0].disabled, indice === 0);
    assert.equal(botoes[1].disabled, indice === paginas.length - 1);
    assert.equal(botoes[2].disabled, indice < 25);
    assert.equal(botoes[3].disabled, Math.floor(indice / 25) * 25 + 25 >= paginas.length);
  }
  assert.match(utilidades.ajudaPagina(paginas, 25).content, /Menu: páginas 26–50/);
});

test('navegação privada troca de bloco, seleciona páginas e desativa controles ao expirar', async () => {
  const definicoesOriginais = registro.definicoes;
  registro.definicoes = comandosNumerosos;
  try {
    const eventos = {};
    let filtro;
    const respostas = [];
    const mensagem = { createMessageComponentCollector(opcoes) {
      filtro = opcoes.filter;
      return { on(nome, callback) { eventos[nome] = callback; } };
    } };
    const interaction = {
      user: { id: 'dono' }, deferred: true,
      editReply: async (payload) => { respostas.push(payload); return mensagem; },
    };
    await utilidades.mostrarAjuda(interaction);
    assert.equal(filtro({ user: { id: 'outra' }, customId: 'ajuda:bloco_proximo' }), false);
    assert.equal(filtro({ user: interaction.user, customId: 'ajuda:bloco_proximo' }), true);
    let resposta;
    const clicar = async (customId, values) => eventos.collect({ customId, values, update: async (payload) => { resposta = payload; } });
    await clicar('ajuda:bloco_proximo');
    assert.match(resposta.content, /Página 26 de/);
    await clicar('ajuda:categoria', ['30']);
    assert.match(resposta.content, /Página 31 de/);
    await clicar('ajuda:categoria', ['999999']);
    assert.match(resposta.content, /Página 31 de/);
    await clicar('ajuda:bloco_anterior');
    assert.match(resposta.content, /Página 1 de/);
    eventos.end();
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(respostas.at(-1).components.every((linha) => linha.toJSON().components.every((componente) => componente.disabled)));
  } finally {
    registro.definicoes = definicoesOriginais;
  }
});

test('registro vazio produz um cartão válido e paginação não separa pares de emoji', () => {
  const paginas = utilidades.ajudaEmbeds([]);
  assert.equal(paginas.length, 1);
  assert.match(paginas[0].toJSON().description, /Nenhum comando/);
  verificarPayload(utilidades.ajudaPagina(paginas), 0);
  const linha = `${'a'.repeat(3799)}😀${'b'.repeat(3801)}😀`;
  const partes = utilidades.dividirAjuda([linha]);
  assert.equal(partes.join(''), linha);
  assert.ok(partes.every((parte) => parte.length <= 3800 && !/[\uD800-\uDBFF]$/.test(parte) && !/^[\uDC00-\uDFFF]/.test(parte)));
  assert.throws(() => utilidades.dividirAjuda(['abc'], 0), RangeError);
});
