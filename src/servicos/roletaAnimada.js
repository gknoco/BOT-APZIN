'use strict';

const path = require('node:path');
const { setTimeout: esperar, setImmediate: proximoQuadro } = require('node:timers/promises');
const { Resvg } = require('@resvg/resvg-js');
const { GIFEncoder, quantize, applyPalette } = require('gifenc');
const { AttachmentBuilder } = require('discord.js');

const VOLTA = 2 * Math.PI;
const PASSOS = 12;
const INTERVALO_QUADRO_MS = 80;
const DURACAO_MS = 1000;
const FONTE = path.join(__dirname, '../../assets/fonts/DejaVuSans-Bold.ttf');
const CORES = ['#a42b37', '#d39819', '#533481', '#176c77', '#b84f24', '#335b94', '#8b315e', '#3c7951'];
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

function planejarGiro(indice, quantidade, passos = PASSOS) {
  const final = normalizar(-(indice + 0.5) * VOLTA / quantidade);
  const distancia = VOLTA + final;
  return Array.from({ length: passos + 1 }, (_, i) => {
    const progresso = i / passos;
    return distancia * (1 - (1 - progresso) ** 3);
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
  const cx = 400, cy = 390, raio = 280;
  const tamanho = VOLTA / lista.length;
  const fatias = lista.map((premio, indice) => {
    const inicio = -Math.PI / 2 + angulo + indice * tamanho;
    const fim = inicio + tamanho;
    const cor = CORES[indice % CORES.length];
    const setor = lista.length === 1
      ? `<circle cx="${cx}" cy="${cy}" r="${raio}" fill="${cor}"/>`
      : `<path d="M ${cx} ${cy} L ${cx + raio * Math.cos(inicio)} ${cy + raio * Math.sin(inicio)} A ${raio} ${raio} 0 ${tamanho > Math.PI ? 1 : 0} 1 ${cx + raio * Math.cos(fim)} ${cy + raio * Math.sin(fim)} Z" fill="${cor}" stroke="#15132b" stroke-width="1.5"/>`;
    // O nome completo sob o ponteiro permanece legível mesmo em catálogos grandes.
    if (lista.length > 24) return setor;
    const centro = (inicio + tamanho / 2) * 180 / Math.PI;
    const tamanhoFonte = Math.max(10, Math.min(20, 210 / lista.length));
    return `${setor}<text transform="translate(${cx} ${cy}) rotate(${centro})" x="${raio * 0.66}" y="5" text-anchor="middle" font-size="${tamanhoFonte}" fill="#fff">${xml(abreviar(premio.name, 19))}</text>`;
  }).join('');
  const atual = indiceNoPonteiro(angulo, lista.length);
  const nome = linhasNome(lista[atual].name).map((linha, i) =>
    `<text x="400" y="${740 + i * 22}" text-anchor="middle" font-size="19" fill="#ffffff">${xml(linha)}</text>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="820" viewBox="0 0 800 820">
    <rect width="800" height="820" rx="24" fill="#111124"/>
    <text x="400" y="50" text-anchor="middle" font-size="26" fill="#f8d665">ROLETA ROYAL AP</text>
    <circle cx="${cx}" cy="${cy}" r="${raio + 9}" fill="#d9ae42"/>
    ${fatias}
    <circle cx="${cx}" cy="${cy}" r="27" fill="#15132b" stroke="#f8d665" stroke-width="5"/>
    <path d="M 383 86 L 417 86 L 400 133 Z" fill="#fff2bb" stroke="#6b4a10" stroke-width="3"/>
    <text x="400" y="709" text-anchor="middle" font-size="16" fill="#f8d665">PONTEIRO · SETOR ${atual + 1} / ${lista.length}</text>
    ${nome}
  </svg>`;
  return new Resvg(svg, {
    fitTo: { mode: 'width', value: 600 },
    font: { fontFiles: [FONTE], loadSystemFonts: false, defaultFontFamily: 'DejaVu Sans' },
  }).render();
}

function desenharQuadro(lista, angulo) {
  return renderizarQuadro(lista, angulo).asPng();
}

async function gerarAnimacao(lista, indice) {
  const angulos = planejarGiro(indice, lista.length);
  const gif = GIFEncoder();
  let imagemFinal;
  for (let i = 0; i < angulos.length; i++) {
    const imagem = renderizarQuadro(lista, angulos[i]);
    const palette = quantize(imagem.pixels, 256);
    const indices = applyPalette(imagem.pixels, palette);
    gif.writeFrame(indices, imagem.width, imagem.height, {
      palette,
      delay: i === angulos.length - 1 ? DURACAO_MS - PASSOS * INTERVALO_QUADRO_MS : INTERVALO_QUADRO_MS,
      repeat: -1,
    });
    if (i === angulos.length - 1) imagemFinal = imagem.asPng();
    // Permite ao bot reconhecer outras interações durante a geração dos quadros.
    await proximoQuadro();
  }
  gif.finish();
  return { gif: Buffer.from(gif.bytes()), imagemFinal };
}

async function animar(interaction, catalogo, resultado, payloadFinal, criarEmbedGiro) {
  const { lista, indice } = prepararPremios(catalogo, resultado);
  const { gif, imagemFinal } = await gerarAnimacao(lista, indice);
  const nomeGiro = `roleta-${interaction.id}-giro.gif`;
  await interaction.editReply({
    embeds: [criarEmbedGiro().setImage(`attachment://${nomeGiro}`)],
    files: [new AttachmentBuilder(gif, { name: nomeGiro })], attachments: [], allowedMentions: { parse: [] },
  });
  // Um único GIF evita os limites de edição do Discord e desacelera em 1 s.
  await esperar(DURACAO_MS);
  const nomeFinal = `roleta-${interaction.id}-resultado.png`;
  payloadFinal.embeds[0].setImage(`attachment://${nomeFinal}`);
  return interaction.editReply({
    ...payloadFinal, files: [new AttachmentBuilder(imagemFinal, { name: nomeFinal })],
    attachments: [], allowedMentions: { parse: [] },
  });
}

module.exports = { prepararPremios, indiceNoPonteiro, planejarGiro, desenharQuadro, gerarAnimacao, animar };
