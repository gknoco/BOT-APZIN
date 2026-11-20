'use strict';

const config = require('../src/config');
const comandos = require('../src/comandos');
const { registrarComandos, limparComandoGo } = require('../src/servicos/registroComandos');

async function main() {
  const erroToken = config.validarToken();
  if (erroToken) throw new Error(erroToken);
  if (!config.CLIENT_ID) {
    throw new Error('Defina CLIENT_ID nas variáveis do ambiente antes de sincronizar os comandos.');
  }

  const resultado = await registrarComandos({
    token: config.TOKEN,
    clientId: config.CLIENT_ID,
    guildId: config.GUILD_ID,
    definicoes: comandos.definicoes(),
  });
  const destino = resultado.guildId ? `guild ${resultado.guildId}` : 'escopo global';
  console.log(`✅ ${resultado.quantidade} slash commands sincronizados no ${destino}.`);
  if (resultado.guildId) {
    const limpeza = await limparComandoGo({ token: config.TOKEN, clientId: config.CLIENT_ID, incluirGlobal: true });
    if (limpeza.removidos) console.log(`✅ ${limpeza.removidos} /go antigo(s) removido(s) do escopo global.`);
    for (const erro of limpeza.erros) console.warn(`⚠️ Não foi possível verificar /go em ${erro.escopo}: ${erro.mensagem}`);
  } else {
    console.log('A publicação global pode levar até uma hora para aparecer em todos os servidores.');
    console.log('Registros antigos de servidores serão verificados ao iniciar o bot conectado a eles.');
  }
  return resultado;
}

if (require.main === module) {
  main().catch((erro) => {
    console.error('❌ Falha ao sincronizar slash commands:', erro.message);
    process.exitCode = 1;
  });
}

module.exports = { main };
