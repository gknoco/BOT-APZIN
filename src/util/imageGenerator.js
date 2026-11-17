'use strict';

const path = require('node:path');
const { createCanvas, loadImage } = require('canvas');
const { reais } = require('./embeds');

const BANNER_EXTRATO_PATH = path.join(__dirname, '../../assets/extrato-royal-ap.png');
let imagemExtratoPromise;

function formatarUsuario(username) {
  const limpo = String(username || 'usuário')
    .replace(/[^\p{L}\p{N}_.-]/gu, '')
    .slice(0, 28);
  return `@${limpo || 'usuário'}`;
}

function formatarData(valor) {
  const data = valor ? new Date(valor) : null;
  if (!data || Number.isNaN(data.getTime())) return 'data indisponível';
  return new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(data);
}

function rotuloMovimento(eventType) {
  if (eventType === 'topup') return 'Recarga Pix';
  if (eventType === 'refund_review') return 'Ajuste em análise';
  return 'Movimentação';
}

function formatarLinhaMovimento(movimento) {
  const delta = Number(movimento?.deltaCents) || 0;
  const sinal = delta < 0 ? '−' : '+';
  return `🛒 ${rotuloMovimento(movimento?.eventType)} · ${sinal}${reais(Math.abs(delta))} · ${formatarData(movimento?.createdAt)}`;
}

function corMediaDoFundo(ctx, x, y, width, height) {
  const dados = ctx.getImageData(x, y, width, height).data;
  let r = 0;
  let g = 0;
  let b = 0;
  let quantidade = 0;
  for (let i = 0; i < dados.length; i += 4) {
    r += dados[i];
    g += dados[i + 1];
    b += dados[i + 2];
    quantidade += 1;
  }
  if (!quantidade) return '#171615';
  return `rgb(${Math.round(r / quantidade)}, ${Math.round(g / quantidade)}, ${Math.round(b / quantidade)})`;
}

function cobrirTextoAnterior(ctx, retangulo) {
  const { x, y, width, height, sample } = retangulo;
  ctx.fillStyle = corMediaDoFundo(ctx, sample.x, sample.y, sample.width, sample.height);
  ctx.fillRect(x, y, width, height);
}

function texto(ctx, value, x, y, { font, color, maxWidth } = {}) {
  ctx.font = font || '16px Arial';
  ctx.fillStyle = color || '#eeeeee';
  ctx.textBaseline = 'alphabetic';
  if (maxWidth) ctx.fillText(String(value), x, y, maxWidth);
  else ctx.fillText(String(value), x, y);
}

async function carregarBannerExtrato() {
  if (!imagemExtratoPromise) imagemExtratoPromise = loadImage(BANNER_EXTRATO_PATH);
  return imagemExtratoPromise;
}

/**
 * Renderiza as informações do extrato sobre o banner original para envio
 * exclusivamente em uma resposta efêmera. Nenhum dado pessoal é desenhado no
 * banner público de /recarga.
 */
async function gerarBannerExtrato({ username, extrato }) {
  const modelo = await carregarBannerExtrato();
  const canvas = createCanvas(modelo.width, modelo.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(modelo, 0, 0, modelo.width, modelo.height);

  const saldo = Number(extrato?.balanceCents) || 0;
  const entradas = Number(extrato?.totalEntriesCents) || 0;
  const saidas = Number(extrato?.totalExitsCents) || 0;
  const status = String(extrato?.status || 'Normal').replace(/[\r\n]/g, ' ').slice(0, 24);
  const movimentos = Array.isArray(extrato?.movements) ? extrato.movements.slice(0, 3) : [];

  // Tapa apenas as inscrições de exemplo impressas no template. As cores de
  // cobertura são amostradas dos fundos escuros adjacentes de cada área.
  [
    { x: 48, y: 166, width: 510, height: 36, sample: { x: 570, y: 174, width: 70, height: 18 } },
    { x: 1137, y: 236, width: 220, height: 66, sample: { x: 1095, y: 264, width: 22, height: 18 } },
    { x: 407, y: 258, width: 164, height: 31, sample: { x: 580, y: 268, width: 30, height: 14 } },
    { x: 638, y: 258, width: 172, height: 31, sample: { x: 817, y: 268, width: 24, height: 14 } },
    { x: 64, y: 372, width: 268, height: 38, sample: { x: 422, y: 388, width: 32, height: 16 } },
    { x: 508, y: 372, width: 274, height: 38, sample: { x: 881, y: 388, width: 28, height: 16 } },
    { x: 956, y: 372, width: 273, height: 38, sample: { x: 1317, y: 388, width: 24, height: 16 } },
    { x: 61, y: 482, width: 1295, height: 50, sample: { x: 680, y: 504, width: 64, height: 12 } },
  ].forEach((retangulo) => cobrirTextoAnterior(ctx, retangulo));

  texto(ctx, formatarUsuario(username), 54, 190, {
    font: '16px Arial',
    color: '#c7c4c1',
    maxWidth: 475,
  });

  texto(ctx, `entradas ${reais(entradas)}`, 419, 278, {
    font: 'bold 14px Arial',
    color: '#53d29a',
    maxWidth: 154,
  });
  texto(ctx, `saídas ${reais(saidas)}`, 650, 278, {
    font: 'bold 14px Arial',
    color: '#e86c83',
    maxWidth: 164,
  });
  texto(ctx, reais(saldo), 1146, 287, {
    font: 'bold 44px Arial',
    color: '#f4c969',
    maxWidth: 205,
  });

  texto(ctx, `+ ${reais(entradas)}`, 70, 400, {
    font: 'bold 22px Arial',
    color: '#52d29a',
    maxWidth: 246,
  });
  texto(ctx, `− ${reais(saidas)}`, 514, 400, {
    font: 'bold 22px Arial',
    color: '#e86c83',
    maxWidth: 252,
  });
  texto(ctx, status, 961, 400, {
    font: 'bold 21px Arial',
    color: '#52d29a',
    maxWidth: 240,
  });

  if (movimentos.length === 0) {
    texto(ctx, 'Nenhuma movimentação ainda', 78, 518, {
      font: '17px Arial',
      color: '#797775',
      maxWidth: 1220,
    });
  } else {
    movimentos.forEach((movimento, indice) => {
      const delta = Number(movimento?.deltaCents) || 0;
      const linha = formatarLinhaMovimento(movimento);
      texto(ctx, linha, 78, 498 + indice * 17, {
        font: '14px Arial',
        color: delta < 0 ? '#e895a5' : '#d0cfcc',
        maxWidth: 1225,
      });
    });
  }

  return canvas.toBuffer('image/png');
}

module.exports = { gerarBannerExtrato, formatarUsuario, formatarData, rotuloMovimento, formatarLinhaMovimento };
