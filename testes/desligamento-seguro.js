'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const executar = promisify(execFile);

// O encerramento substitui process.exit e instala listeners globais; isolá-lo
// em um subprocesso evita interferir com o protocolo do node:test.
async function exercitarDesligamento(rejeitar) {
  const programa = `
    const assert = require('node:assert/strict');
    const { ligarProcesso } = require('./src/eventos');
    (async () => {
      const eventos = [];
      let resolverSaida;
      const saida = new Promise((resolve) => { resolverSaida = resolve; });
      let liberar;
      const desconexao = new Promise((resolve, reject) => {
        liberar = () => ${rejeitar ? "reject(new Error('erro de desconexão'))" : 'resolve()'};
      });
      process.exit = (codigo) => { eventos.push('exit:' + codigo); resolverSaida(); };
      console.error = () => {};
      ligarProcesso({ close: async () => { eventos.push('banco'); } }, {
        pararWorker: () => eventos.push('worker'),
        client: { destroy: async () => { eventos.push('discord:inicio'); await desconexao; eventos.push('discord:fim'); } },
        servidorHttp: { listening: true, close: (cb) => { eventos.push('http'); cb(); } },
      });
      process.listeners('SIGTERM').at(-1)();
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(eventos, ['worker', 'discord:inicio']);
      liberar();
      await saida;
      assert.deepEqual(eventos, ${JSON.stringify(rejeitar
        ? ['worker', 'discord:inicio', 'http', 'banco', 'exit:0']
        : ['worker', 'discord:inicio', 'discord:fim', 'http', 'banco', 'exit:0'])});
    })().catch((erro) => { console.log(erro.stack); process.exitCode = 1; });
  `;
  const resultado = await executar(process.execPath, ['-e', programa], { cwd: require('node:path').resolve(__dirname, '..'), timeout: 5000 });
  assert.match(resultado.stdout, /encerrando recursos/);
}

test('desligamento aguarda a desconexão do Discord antes de fechar HTTP e banco', async () => {
  await exercitarDesligamento(false);
});

test('desligamento captura erro assíncrono do Discord e ainda fecha os demais recursos', async () => {
  await exercitarDesligamento(true);
});
