'use strict';

const path = require('node:path');
const { createCanvas, loadImage } = require('canvas');
const { reais } = require('./embeds');

const BANNER_EXTRATO_PATH = path.join(__dirname, '../../assets/extrato-royal-ap.png');
let modeloPromise;

function limparUsername(username) {
  return String(username || 'usuário').replace(/[\r\n<>@]/g, '').slice(0, 32) || 'usuário';
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

function descreverMovimento(movimento) {
  const delta = Number(movimento?.deltaCents) || 0;
  const sinal = delta < 0 ? '−' : '+';
  const tipo = movimento?.eventType === 'topup'
    ? 'Recarga Pix'
    : movimento?.eventType === 'refund_review' ? 'Ajuste em análise' : 'Movimentação';
  return `• ${tipo} · ${sinal}${reais(Math.abs(delta))} · ${formatarData(movimento?.createdAt)}`;
}

async function carregarModelo() {
  if (!modeloPromise) modeloPromise = loadImage(BANNER_EXTRATO_PATH);
  return modeloPromise;
}

function copiarArea(ctx, modelo, { sourceX, sourceY, x, y, width, height }) {
  // Clona pixels não textuais da própria faixa/painel. Assim se preserva a
  // textura, gradiente e iluminação local; não se pinta nenhum retângulo plano.
  ctx.drawImage(modelo, sourceX, sourceY, width, height, x, y, width, height);
}

function desenharTexto(ctx, value, x, y, options = {}) {
  ctx.font = options.font || '16px Arial';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = options.color || '#eeeeee';
  ctx.fillText(String(value), x, y, options.maxWidth);
}

function ajustaTexto(ctx, value, maxWidth, font) {
  ctx.font = font;
  let result = String(value);
  if (ctx.measureText(result).width <= maxWidth) return result;
  while (result.length > 1 && ctx.measureText(`${result}…`).width > maxWidth) result = result.slice(0, -1);
  return `${result}…`;
}

/**
 * Personaliza somente as caixas de dados do banner de Extrato. O arquivo
 * original nunca é sobrescrito; cada execução parte do mesmo modelo imutável.
 */
async function gerarBannerExtrato({ username, extrato }) {
  const modelo = await carregarModelo();
  const canvas = createCanvas(modelo.width, modelo.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(modelo, 0, 0);

  // Área do usuário sob o título. Fonte: trecho limpo da mesma linha texturizada.
  copiarArea(ctx, modelo, { sourceX: 52, sourceY: 198, x: 52, y: 174, width: 390, height: 13 });
  copiarArea(ctx, modelo, { sourceX: 52, sourceY: 198, x: 52, y: 187, width: 390, height: 13 });
  // Os dois valores pequenos usam um trecho vazio da barra de saldo.
  copiarArea(ctx, modelo, { sourceX: 820, sourceY: 260, x: 410, y: 260, width: 155, height: 26 });
  copiarArea(ctx, modelo, { sourceX: 820, sourceY: 260, x: 640, y: 260, width: 140, height: 26 });
  // Saldo à direita dentro do painel escuro superior.
  copiarArea(ctx, modelo, { sourceX: 800, sourceY: 239, x: 1138, y: 239, width: 220, height: 68 });
  // Totais/status: clone apenas dentro das caixas correspondentes.
  copiarArea(ctx, modelo, { sourceX: 270, sourceY: 376, x: 64, y: 376, width: 170, height: 34 });
  copiarArea(ctx, modelo, { sourceX: 710, sourceY: 376, x: 508, y: 376, width: 210, height: 34 });
  copiarArea(ctx, modelo, { sourceX: 1180, sourceY: 376, x: 956, y: 376, width: 145, height: 34 });
  // A caixa de histórico reserva espaço para três linhas.
  copiarArea(ctx, modelo, { sourceX: 650, sourceY: 486, x: 60, y: 486, width: 610, height: 48 });

  const entradas = Number(extrato?.totalEntriesCents) || 0;
  const saidas = Number(extrato?.totalExitsCents) || 0;
  const saldo = Number(extrato?.balanceCents) || 0;
  const status = String(extrato?.status || 'Normal').replace(/[\r\n]/g, ' ').slice(0, 24);

  desenharTexto(ctx, `@${limparUsername(username)}`, 54, 190, {
    font: '16px Arial', color: '#c7c4c1', maxWidth: 485,
  });
  desenharTexto(ctx, `entradas ${reais(entradas)}`, 419, 278, {
    font: 'bold 14px Arial', color: '#53d29a', maxWidth: 145,
  });
  desenharTexto(ctx, `saídas ${reais(saidas)}`, 650, 278, {
    font: 'bold 14px Arial', color: '#e86c83', maxWidth: 132,
  });

  let saldoFontSize = 44;
  const valorSaldo = reais(saldo).replace(/^R\$\s*/, '');
  do {
    ctx.font = `bold ${saldoFontSize}px Arial`;
    if (ctx.measureText(`R$ ${valorSaldo}`).width <= 202) break;
    saldoFontSize -= 1;
  } while (saldoFontSize > 28);
  desenharTexto(ctx, 'R$', 1146, 287, {
    font: `bold ${saldoFontSize}px Arial`, color: '#f4f4f4',
  });
  ctx.font = `bold ${saldoFontSize}px Arial`;
  const larguraPrefixo = ctx.measureText('R$ ').width;
  desenharTexto(ctx, valorSaldo, 1146 + larguraPrefixo, 287, {
    font: `bold ${saldoFontSize}px Arial`, color: '#f4c969', maxWidth: Math.max(20, 202 - larguraPrefixo),
  });

  desenharTexto(ctx, `+ ${reais(entradas)}`, 70, 400, {
    font: 'bold 22px Arial', color: '#52d29a', maxWidth: 155,
  });
  desenharTexto(ctx, `− ${reais(saidas)}`, 514, 400, {
    font: 'bold 22px Arial', color: '#e86c83', maxWidth: 195,
  });
  desenharTexto(ctx, status, 961, 400, {
    font: 'bold 21px Arial', color: '#52d29a', maxWidth: 135,
  });

  const movimentos = Array.isArray(extrato?.movements) ? extrato.movements.slice(0, 3) : [];
  const linhas = movimentos.length ? movimentos.map(descreverMovimento) : ['Nenhuma movimentação ainda'];
  linhas.forEach((linha, index) => {
    const font = '14px Arial';
    desenharTexto(ctx, ajustaTexto(ctx, linha, 1260, font), 78, 500 + index * 16, {
      font, color: linha.startsWith('•') && (Number(movimentos[index]?.deltaCents) || 0) < 0 ? '#e895a5' : '#d0cfcc',
      maxWidth: 1260,
    });
  });

  return canvas.toBuffer('image/png');
}

module.exports = {
  gerarBannerExtrato,
  limparUsername,
  formatarData,
  descreverMovimento,
};
