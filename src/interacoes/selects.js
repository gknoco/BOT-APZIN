'use strict';

/**
 * Menus de seleção (texto, CARGO e CANAL).
 *
 * REGRA DE OURO: o Discord exige resposta em menos de 3 segundos. Por isso o
 * primeiro passo é SEMPRE confirmar o clique (deferUpdate); só depois o bot
 * grava no Supabase e redesenha o painel. Assim nenhum menu mostra
 * "O aplicativo não respondeu a tempo".
 */

const config = require('../config');
const filas = require('../servicos/filas');
const paineis = require('../servicos/paineis');
const mediadores = require('../servicos/mediadores');
const plantao = require('../servicos/plantao');
const vendasDb = require('../servicos/roomSalesSupabase');
const vendasUI = require('../comandos/vendas');
const { responderPrivado, responderErro, ehAdmin } = require('../util/seguranca');
const { embed, reais, listaUsuarios } = require('../util/embeds');

const ACOES = ['preco', 'medcargos', 'medfila', 'medpix', 'compraspacote', 'comprascargos', 'comprascanal', 'addsalasadm'];

/** Confirma o clique na hora (vale para string, cargo, canal, usuário…). */
async function confirmarClique(interaction) {
  if (interaction.deferred || interaction.replied) return;
  try {
    await interaction.deferUpdate();
  } catch (erro) {
    console.error('[selects] não consegui confirmar o clique:', erro.message);
  }
}

/**
 * Publica (e fixa) o painel do tipo escolhido no canal que o ADM acabou de
 * selecionar. É o "publicou na hora" do menu de canal.
 */
async function publicarNoCanal(ctx, interaction, canalId, tipo) {
  const client = ctx?.client;
  if (!client?.channels || !canalId) return false;
  try {
    const canal =
      client.channels.cache?.get?.(canalId) || (await client.channels.fetch(canalId).catch(() => null));
    if (!canal?.send) return false;

    const payload = tipo === 'medpix' ? plantao.painelRegistroPix() : await plantao.painel(ctx.db, interaction.guildId);
    const mensagem = await canal.send(payload);
    if (typeof mensagem?.pin === 'function') await mensagem.pin().catch(() => {});
    return true;
  } catch (erro) {
    console.error('[selects] não consegui publicar o painel no canal escolhido:', erro.message);
    return false;
  }
}

/** Redesenha o painel atual depois do deferUpdate. */
async function redesenhar(interaction, payload) {
  try {
    await interaction.editReply(payload);
    return true;
  } catch (erro) {
    console.error('[selects] não consegui redesenhar o painel:', erro.message);
    return false;
  }
}

async function handleSelect(interaction, ctx) {
  const partes = String(interaction.customId || '').split(':');
  if (partes[0] !== 'ap') return false;

  const acao = partes[1];
  if (!ACOES.includes(acao)) return false;

  // Selecionar pacote abre um modal; showModal deve ser o primeiro ACK deste select.
  if (acao === 'compraspacote') {
    const quantidade = Number(interaction.values?.[0]);
    const pacoteValido = vendasUI.PACOTES_SALAS.some((pacote) => pacote.quantidade === quantidade);
    if (!pacoteValido) {
      await responderErro(interaction, 'Pacote inválido. Abra novamente o menu ROYAL SALA.');
      return true;
    }
    const { abrirModalCompra } = require('./modais');
    await abrirModalCompra(interaction, quantidade);
    return true;
  }

  if (acao === 'addsalasadm') {
    const { modalQuantidade } = require('../comandos/addsalas');
    await interaction.showModal(modalQuantidade(String(interaction.values?.[0] || '')));
    return true;
  }

  // 1) Confirma o clique ANTES de qualquer acesso ao banco (evita o timeout).
  await confirmarClique(interaction);

  if (acao === 'comprascargos' || acao === 'comprascanal') {
    if (!config.DEV_OWNER_ID || String(interaction.user.id) !== String(config.DEV_OWNER_ID)) {
      await responderErro(interaction, 'Somente DEV_OWNER_ID pode alterar as permissões de compras.');
      return true;
    }
    if (!interaction.guildId) {
      await responderErro(interaction, 'Use a configuração de compras dentro de um servidor.');
      return true;
    }
    const atual = await vendasDb.obterConfiguracao(interaction.guildId);
    const selecionados = (interaction.values || []).map(String).filter((id) => /^\d{17,20}$/.test(id));
    const cargos = [...new Set(selecionados.filter((id) => id !== String(interaction.guildId)))].slice(0, vendasUI.MAX_CARGOS_COMPRA);
    const salvo = await vendasDb.salvarConfiguracao({
      guildId: interaction.guildId,
      roleIds: acao === 'comprascargos' ? cargos : (Array.isArray(atual.allowed_role_ids) ? atual.allowed_role_ids : []),
      channelId: acao === 'comprascanal' ? selecionados[0] : atual.panel_channel_id,
      actorId: interaction.user.id,
    });
    await redesenhar(interaction, vendasUI.embedPainelPermissoes(salvo));
    await responderPrivado(interaction, {
      content: acao === 'comprascargos'
        ? `✅ Permissões salvas com sucesso no banco de dados (Supabase) (${cargos.length} cargo(s)).`
        : `✅ Canal do painel de vendas salvo com sucesso no banco de dados (Supabase): <#${selecionados[0]}>.`,
    }).catch(() => {});
    return true;
  }

  // 2) Menus do /mediadores: cargos, canal do plantão e canal do PIX.
  if (acao.startsWith('med')) {
    if (!ehAdmin(interaction.member)) {
      await responderErro(interaction, 'Só ADM configura o módulo de mediadores.');
      return true;
    }

    // Pode vir mais de um cargo (ex.: Mediador + Administrador juntos).
    const valores = (interaction.values || []).map(String).filter(Boolean);
    try {
      if (acao === 'medcargos') {
        await mediadores.definirCargos(ctx.db, interaction.guildId, valores);
      }
      if (acao === 'medfila') {
        await mediadores.definirCanalBatePonto(ctx.db, interaction.guildId, valores[0]);
      }
      if (acao === 'medpix') {
        await mediadores.definirCanalConfigPix(ctx.db, interaction.guildId, valores[0]);
      }
    } catch (erro) {
      console.error(`[selects] não consegui salvar ${acao}:`, erro.message);
      await responderErro(interaction, 'Não consegui salvar essa escolha. Tente de novo.').catch(() => {});
      return true;
    }

    // Canal escolhido → publica (e fixa) o painel lá na mesma hora.
    let aviso = null;
    if (acao === 'medfila' || acao === 'medpix') {
      const publicou = await publicarNoCanal(ctx, interaction, valores[0], acao);
      aviso = publicou
        ? '✅ Painel publicado e fixado no canal escolhido.'
        : '⚠️ Canal salvo, mas não consegui publicar o painel nele. Confira as permissões do bot.';
    }

    // Painel novo, já com a escolha gravada.
    await redesenhar(interaction, await mediadores.painelConfig(ctx.db, interaction.guildId));
    await responderPrivado(interaction, { content: `✅ Configuração ${acao === 'medcargos' ? 'de cargos' : 'de canal'} salva com sucesso no banco de dados (Supabase).${aviso ? ` ${aviso}` : ''}` }).catch(() => {});
    return true;
  }

  // 3) Menu de preço do painel de fila.
  const modo = config.modoPorId(partes[2]);
  if (!modo) {
    await responderErro(interaction, 'Painel antigo. Peça para a staff publicar de novo.');
    return true;
  }

  const preco = Number(interaction.values?.[0]);
  if (!config.PRECOS.includes(preco)) {
    await responderErro(interaction, 'Faixa de aposta inválida.');
    return true;
  }

  const entradas = await filas.listar(ctx.db, { guildId: interaction.guildId, modo: modo.id, preco });
  const linhas = config.variantesDoModo(modo).map((variante) => {
    const ids = entradas.filter((linha) => linha.gelo === variante.id).map((linha) => linha.user_id);
    return `${variante.emoji} **${variante.nome}** (${ids.length}/${config.CAPITAES_POR_PARTIDA} capitães): ${listaUsuarios(ids)}`;
  });

  const descricao = [
    `**Modo:** ${modo.titulo}`,
    `**Aposta:** ${reais(preco)} por capitão (1 por time)`,
    `**Abre com:** ${config.CAPITAES_POR_PARTIDA} capitães (1 por time) · formato ${modo.time}x${modo.time}`,
    '',
    ...linhas,
    '',
    'Cada capitão pega o ID/senha na sala privada e leva o time dele.',
    '',
    'Escolha o botão da sua categoria para entrar:',
  ].join('\n');

  await responderPrivado(interaction, {
    embeds: [embed(`🎯 AP ${modo.titulo} · ${reais(preco)}`, descricao, { cor: config.CORES.gelo })],
    components: paineis.componentesEntrada(modo, preco),
  });
  return true;
}

module.exports = { handleSelect, confirmarClique };
