'use strict';

const path = require('node:path');
const { setTimeout: esperar, setImmediate: proximoQuadro } = require('node:timers/promises');
const { Resvg } = require('@resvg/resvg-js');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');
const { AttachmentBuilder } = require('discord.js');

const VOLTA = 2 * Math.PI;
const GIROS_COMPLETOS = 5;
const INTERVALO_QUADRO_MS = 70;
const DURACAO_PADRAO_SEGUNDOS = 8;
const DURACAO_MINIMA_SEGUNDOS = 3;
const DURACAO_MAXIMA_SEGUNDOS = 20;
const FONTE = path.join(__dirname, '../../assets/fonts/DejaVuSans-Bold.ttf');
const CORES = ['#f05b73', '#fb9b58', '#f2cc62', '#42c7a5', '#45a6e8', '#7d83f6', '#b178e8', '#e975b0'];
const normalizar = (angulo) => ((angulo % VOLTA) + VOLTA) % VOLTA;

// As fatias são apenas identificação visual, não probabilidades. A RPC é a
// única responsável pelo sorteio e informa o ID e o snapshot do prêmio entregue.
function prepararPremios(catalogo, resultado) {
  const lista = (Array.isArray(catalogo) ? catalogo : []).map((p) => ({ id: String(p.id), name: String(p.name) }));
  const id = resultado.prize_id == null ? null : String(resultado.prize_id);
  let indice = id === null ? -1 : lista.findIndex((p) => p.id === id);
  if (indice < 0) {
    indice = lista.length;
    lista.push({ id, name: String(resultado.prize_name || 'Prêmio') });
  } else {
    // A configuração pode ter mudado entre a consulta e a transação.
    lista[indice] = { id, name: String(resultado.prize_name || 'Prêmio') };
  }
  return { lista, indice };
}

function indiceNoPonteiro(angulo, quantidade) {
  return Math.floor(normalizar(-angulo) / (VOLTA / quantidade)) % quantidade;
}

function validarDuracaoSegundos(valor = DURACAO_PADRAO_SEGUNDOS) {
  const numero = Number(valor);
  if (!Number.isInteger(numero) || numero < DURACAO_MINIMA_SEGUNDOS || numero > DURACAO_MAXIMA_SEGUNDOS) {
    return DURACAO_PADRAO_SEGUNDOS;
  }
  return numero;
}

function planejarGiro(indice, quantidade, duracaoSegundos = DURACAO_PADRAO_SEGUNDOS) {
  const duracao = validarDuracaoSegundos(duracaoSegundos);
  const quadros = Math.ceil(duracao * 1000 / INTERVALO_QUADRO_MS);
  const passos = Math.max(1, quadros - 1);
  const final = normalizar(-(indice + 0.5) * VOLTA / quantidade);
  const distancia = GIROS_COMPLETOS * VOLTA + final;
  return Array.from({ length: passos + 1 }, (_, i) => {
    const progresso = i / passos;
    return distancia * (1 - (1 - progresso) ** 4);
  });
}

function xml(valor) {
  return String(valor).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function abreviar(valor, maximo) {
  const letras = Array.from(String(valor).replace(/\s+/g, ' ').trim());
  return letras.length > maximo ? `${letras.slice(0, maximo - 1).join('')}…` : letras.join('');
}

function linhasNome(valor) {
  const letras = Array.from(String(valor).replace(/\s+/g, ' ').trim());
  const linhas = [];
  while (letras.length && linhas.length < 3) linhas.push(letras.splice(0, 35).join(''));
  if (letras.length) linhas[2] = `${Array.from(linhas[2]).slice(0, 34).join('')}…`;
  return linhas.length ? linhas : ['Prêmio'];
}

function renderizarQuadro(lista, angulo) {
  if (!lista.length) throw new Error('A roleta visual precisa de ao menos um prêmio.');
  const cx = 400, cy = 347, raio = 266;
  const tamanho = VOLTA / lista.length;
  const fatias = lista.map((premio, indice) => {
    const inicio = -Math.PI / 2 + angulo + indice * tamanho;
    const fim = inicio + tamanho;
    const cor = CORES[indice % CORES.length];
    const setor = lista.length === 1
      ? `<circle cx="${cx}" cy="${cy}" r="${raio}" fill="${cor}"/>`
      : `<path d="M ${cx} ${cy} L ${cx + raio * Math.cos(inicio)} ${cy + raio * Math.sin(inicio)} A ${raio} ${raio} 0 ${tamanho > Math.PI ? 1 : 0} 1 ${cx + raio * Math.cos(fim)} ${cy + raio * Math.sin(fim)} Z" fill="${cor}" stroke="#ffffff" stroke-opacity=".52" stroke-width="2"/>`;
    const centroRad = (inicio + tamanho / 2);
    const centro = centroRad * 180 / Math.PI;
    const x = cx + raio * 0.56 * Math.cos(centroRad);
    const y = cy + raio * 0.56 * Math.sin(centroRad);
    const rotacao = centro > 90 && centro < 270 ? centro + 180 : centro;
    const tamanhoFonte = Math.max(7, Math.min(18, 300 / Math.max(lista.length, 1)));
    const maxCaracteres = Math.max(6, Math.min(22, Math.floor(300 / Math.max(lista.length, 1))));
    return `${setor}<text x="${x}" y="${y}" transform="rotate(${rotacao} ${x} ${y})" text-anchor="middle" dominant-baseline="central" font-size="${tamanhoFonte}" font-weight="700" fill="#ffffff" stroke="#111827" stroke-opacity=".26" stroke-width="2" paint-order="stroke">${xml(abreviar(premio.name, maxCaracteres))}</text>`;
  }).join('');
  const atual = indiceNoPonteiro(angulo, lista.length);
  const nome = linhasNome(lista[atual].name).map((linha, i) =>
    `<text x="400" y="${689 + i * 21}" text-anchor="middle" font-size="18" font-weight="700" fill="#f8fafc">${xml(linha)}</text>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="740" viewBox="0 0 800 740">
    <defs>
      <radialGradient id="bg"><stop offset="0" stop-color="#17243a"/><stop offset="1" stop-color="#080d18"/></radialGradient>
      <linearGradient id="rim" x1="0" x2="1" y1="0" y2="1"><stop stop-color="#fff0bc"/><stop offset=".45" stop-color="#e9bd61"/><stop offset="1" stop-color="#9a632c"/></linearGradient>
      <linearGradient id="pointer" x1="0" x2="1"><stop stop-color="#fff5ce"/><stop offset="1" stop-color="#eac46f"/></linearGradient>
    </defs>
    <rect width="800" height="740" rx="32" fill="url(#bg)"/>
    <circle cx="400" cy="35" r="5" fill="#f4ce77"/>
    <text x="400" y="43" text-anchor="middle" font-size="19" font-weight="700" letter-spacing="5" fill="#e8edf7">ROYAL AP</text>
    <circle cx="${cx}" cy="${cy}" r="${raio + 13}" fill="#050914" stroke="url(#rim)" stroke-width="8"/>
    <circle cx="${cx}" cy="${cy}" r="${raio + 6}" fill="none" stroke="#fff5d9" stroke-opacity=".42" stroke-width="2"/>
    ${fatias}
    <circle cx="${cx}" cy="${cy}" r="53" fill="#101a2b" stroke="#fff1c2" stroke-width="5"/>
    <circle cx="${cx}" cy="${cy}" r="43" fill="none" stroke="#e7c276" stroke-opacity=".55" stroke-width="1.5"/>
    <text x="${cx}" y="${cy + 8}" text-anchor="middle" font-size="25" font-weight="800" letter-spacing="2" fill="#fff0bf">RA</text>
    <path d="M 382 57 Q 400 47 418 57 L 400 111 Z" fill="url(#pointer)" stroke="#714e28" stroke-width="3" stroke-linejoin="round"/>
    <rect x="130" y="642" width="540" height="74" rx="22" fill="#142138" stroke="#e9c56d" stroke-opacity=".75" stroke-width="2"/>
    <circle cx="162" cy="679" r="5" fill="#65e0b8"/>
    ${nome}
  </svg>`;
  return new Resvg(svg, {
    fitTo: { mode: 'width', value: 360 },
    font: { fontFiles: [FONTE], loadSystemFonts: false, defaultFontFamily: 'DejaVu Sans' },
  }).render();
}

function desenharQuadro(lista, angulo) {
  return renderizarQuadro(lista, angulo).asPng();
}

async function gerarAnimacao(lista, indice, duracaoSegundos = DURACAO_PADRAO_SEGUNDOS) {
  const duracao = validarDuracaoSegundos(duracaoSegundos);
  const angulos = planejarGiro(indice, lista.length, duracao);
  const gif = GIFEncoder();
  let imagemFinal;
  let palette;
  const tempoTotal = duracao * 1000;
  for (let i = 0; i < angulos.length; i++) {
    const imagem = renderizarQuadro(lista, angulos[i]);
    if (!palette) palette = quantize(imagem.pixels, 128);
    const indices = applyPalette(imagem.pixels, palette);
    gif.writeFrame(indices, imagem.width, imagem.height, {
      ...(i === 0 ? { palette } : {}),
      delay: i === angulos.length - 1
        ? tempoTotal - (angulos.length - 1) * INTERVALO_QUADRO_MS
        : INTERVALO_QUADRO_MS,
      repeat: -1,
    });
    if (i === angulos.length - 1) imagemFinal = imagem.asPng();
    // Permite ao bot reconhecer outras interações durante a geração dos quadros.
    await proximoQuadro();
  }
  gif.finish();
  return { gif: Buffer.from(gif.bytes()), imagemFinal };
}

async function animar(interaction, catalogo, resultado, payloadFinal, criarEmbedGiro, duracaoSegundos = DURACAO_PADRAO_SEGUNDOS) {
  const { lista, indice } = prepararPremios(catalogo, resultado);
  const duracao = validarDuracaoSegundos(duracaoSegundos);
  const { gif, imagemFinal } = await gerarAnimacao(lista, indice, duracao);
  const nomeGiro = `roleta-${interaction.id}-giro.gif`;
  await interaction.editReply({
    embeds: [criarEmbedGiro().setImage(`attachment://${nomeGiro}`)],
    files: [new AttachmentBuilder(gif, { name: nomeGiro })], attachments: [], allowedMentions: { parse: [] },
  });
  // Um único GIF evita os limites de edição do Discord e desacelera até a duração configurada.
  await esperar(duracao * 1000);
  const nomeFinal = `roleta-${interaction.id}-resultado.png`;
  payloadFinal.embeds[0].setImage(`attachment://${nomeFinal}`);
  return interaction.editReply({
    ...payloadFinal, files: [new AttachmentBuilder(imagemFinal, { name: nomeFinal })],
    attachments: [], allowedMentions: { parse: [] },
  });
}

module.exports = {
  DURACAO_PADRAO_SEGUNDOS, DURACAO_MINIMA_SEGUNDOS, DURACAO_MAXIMA_SEGUNDOS,
  validarDuracaoSegundos, prepararPremios, indiceNoPonteiro, planejarGiro,
  desenharQuadro, gerarAnimacao, animar,
};
