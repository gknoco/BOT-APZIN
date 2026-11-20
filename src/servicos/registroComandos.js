'use strict';

const { REST, Routes, ApplicationCommandType } = require('discord.js');

async function registrarComandos({ token, clientId, guildId, definicoes, rest }) {
  if (!clientId) throw new Error('CLIENT_ID é obrigatório para registrar comandos slash.');
  if (!Array.isArray(definicoes)) throw new Error('A lista de definições slash precisa ser um array.');
  if (!rest && !token) throw new Error('DISCORD_TOKEN é obrigatório para registrar comandos slash.');

  const clienteRest = rest || new REST({ version: '10' }).setToken(token);
  const escopoGuild = guildId ? String(guildId) : null;
  const rota = escopoGuild
    ? Routes.applicationGuildCommands(String(clientId), escopoGuild)
    : Routes.applicationCommands(String(clientId));

  await clienteRest.put(rota, { body: definicoes });
  return {
    rota,
    guildId: escopoGuild,
    quantidade: definicoes.length,
  };
}

/** Remove apenas o antigo /go nos escopos informados, sem sobrescrever suas listas. */
async function limparComandoGo({ token, clientId, incluirGlobal = false, guildIds = [], rest }) {
  if (!clientId) throw new Error('CLIENT_ID é obrigatório para verificar comandos slash.');
  if (!rest && !token) throw new Error('DISCORD_TOKEN é obrigatório para verificar comandos slash.');
  const clienteRest = rest || new REST({ version: '10' }).setToken(token);
  const app = String(clientId);
  const escopos = [
    ...(incluirGlobal ? [null] : []),
    ...new Set(Array.from(guildIds, String).filter((id) => /^\d+$/.test(id))),
  ];
  const resultado = { removidos: 0, erros: [] };
  for (const guildId of escopos) {
    const rota = guildId ? Routes.applicationGuildCommands(app, guildId) : Routes.applicationCommands(app);
    try {
      const comandos = await clienteRest.get(rota);
      if (!Array.isArray(comandos)) throw new Error('Lista de comandos retornada pelo Discord é inválida.');
      for (const comando of comandos) {
        // Comandos de usuário/mensagem também podem ter o nome "go"; não removê-los.
        if (comando.name !== 'go' || comando.type !== ApplicationCommandType.ChatInput || !/^\d+$/.test(String(comando.id))) continue;
        const destino = guildId
          ? Routes.applicationGuildCommand(app, guildId, String(comando.id))
          : Routes.applicationCommand(app, String(comando.id));
        await clienteRest.delete(destino);
        resultado.removidos += 1;
      }
    } catch (erro) {
      resultado.erros.push({ escopo: guildId || 'global', mensagem: String(erro?.message || erro) });
    }
  }
  return resultado;
}

module.exports = { registrarComandos, limparComandoGo };
