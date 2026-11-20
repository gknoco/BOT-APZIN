'use strict';

/**
 * Servidor HTTP mínimo ("health check").
 *
 * Bots de Discord não abrem porta nenhuma, e o Render — que hospeda Web Services —
 * derruba quem não responde em uma porta. Este servidor roda junto com o bot,
 * escuta na porta que o ambiente mandar (process.env.PORT) e responde 200
 * em qualquer requisição. Não interfere em nada do Discord.
 */

const http = require('http');
const mercadoPagoWebhook = require('./servicos/mercadoPagoWebhook');
const estadoRuntime = require('./estadoRuntime');

const TEXTO = 'Bot Royal AP Online e Operante!';

function corpoResposta() {
  const estado = estadoRuntime.estado();
  if (!estado.saudavel) return `Bot degradado: ${estado.motivo}\nFalha desde ${estado.desde}\n`;
  return `${TEXTO}\nAtivo desde ${new Date().toISOString()}\n`;
}

function criarServidor() {
  return http.createServer(async (req, res) => {
    try {
      if (await mercadoPagoWebhook.tratar(req, res)) return;
      const caminho = new URL(req.url || '/', 'http://localhost').pathname;
      if (!['/', '/health'].includes(caminho) || !['GET', 'HEAD'].includes(req.method)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('Not found\n');
        return;
      }
      const corpo = corpoResposta();
      res.writeHead(estadoRuntime.estaSaudavel() ? 200 : 503, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': Buffer.byteLength(corpo),
        'Cache-Control': 'no-store',
      });
      res.end(req.method === 'HEAD' ? undefined : corpo);
    } catch (erro) {
      console.error('[http] erro ao processar requisição:', erro?.message || erro);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('Internal server error\n');
      }
    }
  });
}

/**
 * Sobe o servidor em paralelo ao bot.
 * Uma falha no bind degrada a instância para não reportar saúde normal.
 */
function iniciarServidor(porta = Number(process.env.PORT) || 3000) {
  const servidor = criarServidor();

  servidor.on('error', (erro) => {
    console.error(`⚠️  Servidor HTTP não subiu na porta ${porta}: ${erro.message}`);
    estadoRuntime.marcarDegradado(`http_listen_failed:${erro.code || 'unknown'}`);
    process.exitCode = 1;
    process.kill(process.pid, 'SIGTERM');
  });

  servidor.listen(porta, '0.0.0.0', () => {
    console.log(`🌐 Servidor HTTP de saúde aberto na porta ${porta} (Render/Docker ok)`);
  });

  return servidor;
}

module.exports = { TEXTO, criarServidor, iniciarServidor };
