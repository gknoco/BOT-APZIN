'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  ChannelType,
  SlashCommandBuilder,
} = require('discord.js');
const royal = require('../servicos/royalSupabase');
const supabase = require('../servicos/supabase');
const avisos = require('../servicos/avisosEconomia');
const { EFEMERO, ehAdmin } = require('../util/seguranca');
const { numeroBR } = require('../util/embeds');

const PREFIXO = 'roletapro:';
const BANNER_NOME = 'roleta-royal-ap.png';
const BANNER = path.join(__dirname, '../../assets', BANNER_NOME);
const CHAVE_PAINEL = 'painel_roleta';
const COR = 0xb20d1c;
const POR_PAGINA = 8;

function textoSeguro(valor, limite = 100) {
  return String(valor ?? '').replace(/[\r\n\t]+/g, ' ').replace(/([\\*_~`|>])/g, '\\$1').slice(0, limite) || '—';
}

function painelPublico(catalogo) {
  const arteDisponivel = fs.existsSync(BANNER);
  const linhas = catalogo === null
    ? 'Não foi possível consultar os prêmios. Consulte a staff.'
    : !catalogo.length
      ? 'Não há prêmios disponíveis no momento da publicação.'
      : catalogo.slice(0, 20).map((premio) => {
        const porcentagem = 100 * premio.weight / catalogo.totalPeso;
        const chance = porcentagem < 0.01 ? '<0,01%' : `${porcentagem.toFixed(2).replace('.', ',')}%`;
        return `• ${textoSeguro(premio.name, 70)} · **${chance}**`;
      }).join('\n') + (catalogo.length > 20 ? `\n... e outros ${catalogo.length - 20} prêmio(s).` : '');
  const painel = new EmbedBuilder()
    .setColor(COR)
    .setTitle('ROLETA ROYAL AP')
    .setDescription(
      '**A sorte está na sua mão.**\n' +
      'Use seus giros para disputar os prêmios disponíveis na roleta.\n\n' +
      '**Girar** · realiza um sorteio com um dos seus giros.\n' +
      '**Meus Prêmios** · veja seu saldo e o histórico privado de prêmios.\n\n' +
      `**Prêmios e chances na publicação**\n${linhas}\n\n` +
      'Imagem ilustrativa; os prêmios e seus pesos são definidos pela configuração da roleta.\n' +
      'Chances reais dependem dos pesos e estoques no momento do giro. Após alterações, republique o painel para atualizar a lista.\n' +
      'Os resultados e saldos são exibidos somente para você.',
    )
    .setFooter({ text: 'ROYAL AP  •  ROLETA  •  SORTEIOS REGISTRADOS' });
  if (arteDisponivel) painel.setImage(`attachment://${BANNER_NOME}`);
  return {
    embeds: [painel],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${PREFIXO}girar`).setLabel('🎰 Girar').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`${PREFIXO}premios`).setLabel('🎁 Meus Prêmios').setStyle(ButtonStyle.Secondary),
    )],
    files: arteDisponivel ? [new AttachmentBuilder(BANNER, { name: BANNER_NOME })] : [],
    allowedMentions: { parse: [] },
  };
}

async function buscarCatalogo(cliente, guildId) {
  const premios = [];
  const tamanho = 200;
  for (let inicio = 0; ; inicio += tamanho) {
    const { data, error } = await cliente.from('royal_roulette_prizes')
      .select('id,name,reward_type,reward_value,weight,stock')
      .eq('guild_id', String(guildId)).eq('active', true)
      .order('id', { ascending: true }).range(inicio, inicio + tamanho - 1);
    if (error) throw new Error(`Catálogo da roleta: ${error.message}`);
    const lote = data || [];
    premios.push(...lote);
    if (lote.length < tamanho) break;
  }
  const disponiveis = premios.filter((premio) => premio.stock == null || Number(premio.stock) > 0);
  const ids = [...new Set(disponiveis.filter((p) => p.reward_type === 'shop_item').map((p) => String(p.reward_value).trim()))];
  const itensAtivos = new Set();
  for (let inicio = 0; inicio < ids.length; inicio += 100) {
    const { data, error } = await cliente.from('royal_shop_items')
      .select('id,stock').eq('guild_id', String(guildId)).eq('active', true).in('id', ids.slice(inicio, inicio + 100));
    if (error) throw new Error(`Itens da roleta: ${error.message}`);
    for (const item of data || []) if (item.stock == null || Number(item.stock) > 0) itensAtivos.add(String(item.id));
  }
  const elegiveis = disponiveis.filter((p) => p.reward_type !== 'shop_item' || itensAtivos.has(String(p.reward_value).trim()));
  for (const premio of elegiveis) {
    premio.weight = Number(premio.weight);
    if (!Number.isSafeInteger(premio.weight) || premio.weight <= 0) throw new Error('Peso de prêmio inválido.');
    const valor = String(premio.reward_value ?? '');
    if (['coins', 'spins'].includes(premio.reward_type) &&
        (!/^\d+$/.test(valor) || BigInt(valor) > 9223372036854775807n)) throw new Error('Recompensa de saldo inválida.');
    if (premio.reward_type === 'pix' && (!/^\d+(?:\.\d{1,2})?$/.test(valor) || Number(valor) <= 0)) {
      throw new Error('Valor PIX inválido.');
    }
    if (premio.reward_type === 'role' && !valor.trim()) throw new Error('Cargo de prêmio inválido.');
  }
  const total = elegiveis.reduce((soma, premio) => soma + premio.weight, 0);
  if (!Number.isSafeInteger(total)) throw new Error('Soma dos pesos inválida.');
  elegiveis.sort((a, b) => b.weight - a.weight || String(a.id).localeCompare(String(b.id)));
  elegiveis.totalPeso = total;
  return elegiveis;
}

async function adiarPrivado(interaction) {
  if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ flags: EFEMERO });
}

async function editarPrivado(interaction, payload) {
  // O ACK foi feito com deferReply efêmero, inclusive em botões. Não edita o painel.
  return interaction.editReply({ ...payload, allowedMentions: { parse: [] } });
}

function card(titulo, descricao) {
  return new EmbedBuilder().setColor(COR).setTitle(titulo).setDescription(descricao)
    .setFooter({ text: 'ROYAL AP  •  VISÃO PRIVADA' });
}

function contextoValido(interaction) {
  return Boolean(interaction.guildId && interaction.user?.id && interaction.id);
}

async function auditarSeguro(evento) {
  try { await royal.auditar(evento); }
  catch (erro) { console.error('[roletapro] falha ao auditar:', erro.message); }
}

async function avisarPendente(interaction, descricao, protocolo) {
  try { await avisos.avisarStaff(interaction, { origem: 'Roleta', descricao, protocolo }); }
  catch (erro) { console.error('[roletapro] falha ao avisar staff:', erro.message); }
}

// Nunca recuar para o canal de origem quando um destino configurado é inválido.
async function canalPublicacao(interaction, idConfigurado) {
  const guild = interaction.guild;
  if (!guild || String(guild.id) !== String(interaction.guildId)) throw new Error('Servidor indisponível');
  const id = String(idConfigurado || '').trim();
  const canal = id
    ? (guild.channels?.cache?.get(id) || await guild.channels?.fetch?.(id))
    : interaction.channel;
  const tipos = [ChannelType.GuildText, ChannelType.GuildAnnouncement,
    ChannelType.AnnouncementThread, ChannelType.PublicThread, ChannelType.PrivateThread];
  if (!canal || !canal.id || (id && String(canal.id) !== id) ||
      String(canal.guildId || canal.guild?.id || '') !== String(interaction.guildId) ||
      !tipos.includes(canal.type) || typeof canal.send !== 'function') throw new Error('Canal inválido');
  const membroBot = guild.members?.me || interaction.client?.user;
  const permissoes = membroBot && canal.permissionsFor?.(membroBot);
  const thread = [ChannelType.AnnouncementThread, ChannelType.PublicThread, ChannelType.PrivateThread].includes(canal.type);
  if (!permissoes?.has?.(PermissionFlagsBits.ViewChannel) ||
      !permissoes.has(thread ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages)) {
    throw new Error('Permissões de envio indisponíveis');
  }
  return canal;
}

async function saldoPrivado(guildId, userId) {
  try {
    const perfil = await royal.perfil(guildId, userId);
    return `**Giros disponíveis:** ${numeroBR(perfil?.spins ?? 0)}`;
  } catch (erro) {
    console.error('[roletapro] falha ao consultar saldo:', erro.message);
    return '**Giros disponíveis:** temporariamente indisponível';
  }
}

async function entregarCargo(interaction, roleId) {
  if (!roleId) throw new Error('Cargo de prêmio não configurado.');
  let membro = interaction.member;
  if (!membro?.roles?.add && interaction.guild?.members?.fetch) {
    membro = await interaction.guild.members.fetch(interaction.user.id);
  }
  if (!membro?.roles?.add) throw new Error('Não foi possível localizar o membro para entrega.');
  await membro.roles.add(String(roleId));
}

async function realizarGiro(interaction) {
  // Feedback privado sem animação nem atraso artificial; o resultado vem apenas da RPC.
  await editarPrivado(interaction, {
    embeds: [card('ROLETA  •  SORTEANDO', 'Aguarde, estamos confirmando o resultado do seu giro...')],
  });
  let resultado;
  try {
    // O ID da interação é a chave de idempotência da RPC; nunca sorteamos localmente.
    resultado = await royal.girar({ guildId: interaction.guildId, userId: interaction.user.id, request: interaction.id });
    if (!resultado) throw new Error('A roleta não retornou um resultado.');
  } catch (erro) {
    console.error('[roletapro] falha no giro:', erro.message);
    const motivo = /não possui giros disponíveis/i.test(String(erro.message))
      ? 'Você não possui giros disponíveis.'
      : /roleta ainda não foi configurada|roleta não tem prêmios ativos/i.test(String(erro.message))
        ? 'Não há prêmios ativos disponíveis na roleta. Consulte a staff.'
        : /aguarde o cooldown da roleta/i.test(String(erro.message))
          ? 'Aguarde o intervalo configurado antes de girar novamente.'
          : 'Não foi possível confirmar o resultado. Confira **Meus Prêmios** antes de tentar novamente.';
    const saldo = await saldoPrivado(interaction.guildId, interaction.user.id);
    return editarPrivado(interaction, { embeds: [card('ROLETA  •  ATENÇÃO', `${motivo}\n\n${saldo}`)] });
  }

  let entrega;
  let pendenciaAviso;
  if (resultado.reward_type === 'role') {
    try {
      // A transação já registrou a pendência; a chamada Discord é externa à RPC.
      await entregarCargo(interaction, resultado.reward_value);
      await royal.marcarRecompensaEntregue({
        guildId: interaction.guildId, userId: interaction.user.id, request: interaction.id,
      });
      entrega = 'Cargo concedido e entrega registrada.';
    } catch (erro) {
      await auditarSeguro({
        guildId: interaction.guildId, actorId: interaction.user.id,
        action: 'reward.delivery.pending', entityType: 'roulette_spin', entityId: resultado.spin_id,
        requestId: interaction.id,
        detail: `Entrega de cargo pendente (${String(resultado.reward_value).slice(0, 100)}): ${String(erro.message || 'falha Discord').slice(0, 300)}`,
      });
      entrega = 'O prêmio foi registrado, mas a entrega do cargo está pendente para a staff.';
      pendenciaAviso = 'Entrega de cargo da roleta pendente ou requer revisão.';
    }
  } else if (resultado.reward_type === 'pix') {
    entrega = 'Prêmio PIX registrado como pendente para atendimento pela staff. Nenhum pagamento foi confirmado.';
    await auditarSeguro({
      guildId: interaction.guildId, actorId: interaction.user.id,
      action: 'reward.delivery.pending', entityType: 'roulette_spin', entityId: resultado.spin_id,
      requestId: interaction.id, detail: 'Prêmio PIX pendente de atendimento pela staff.',
    });
    pendenciaAviso = 'Prêmio PIX da roleta pendente de atendimento; pagamento não confirmado.';
  } else if (resultado.reward_type === 'coins') {
    entrega = 'As coins foram creditadas pela roleta.';
  } else if (resultado.reward_type === 'spins') {
    entrega = 'Os giros foram creditados pela roleta.';
  } else if (resultado.reward_type === 'shop_item') {
    entrega = 'O item foi adicionado ao seu inventário.';
  } else {
    entrega = 'Prêmio registrado; consulte a staff sobre a entrega.';
  }

  await auditarSeguro({
    guildId: interaction.guildId, actorId: interaction.user.id, action: 'roulette.spin',
    entityType: 'roulette_spin', entityId: resultado.spin_id, requestId: interaction.id,
    detail: String(resultado.prize_name || 'Prêmio').slice(0, 300),
  });
  if (pendenciaAviso) await avisarPendente(interaction, pendenciaAviso, `spin:${interaction.id}`);
  const saldo = await saldoPrivado(interaction.guildId, interaction.user.id);
  return editarPrivado(interaction, {
    embeds: [card('ROLETA  •  RESULTADO', `Você ganhou **${textoSeguro(resultado.prize_name)}**!\n\n${entrega}\n\n${saldo}`)],
  });
}

function premioDaLinha(linha) {
  const atual = (Array.isArray(linha.royal_roulette_prizes)
    ? linha.royal_roulette_prizes[0] : linha.royal_roulette_prizes) || {};
  return {
    name: linha.prize_name_snapshot ?? atual.name,
    reward_type: linha.reward_type_snapshot ?? atual.reward_type,
    reward_value: linha.reward_value_snapshot ?? atual.reward_value,
  };
}

function descricaoPremio(linha, entregas) {
  const premio = premioDaLinha(linha);
  const tipo = premio?.reward_type;
  const valor = textoSeguro(premio?.reward_value, 50);
  let detalhe;
  if (tipo === 'coins') detalhe = `${valor} coins · crédito automático`;
  else if (tipo === 'spins') detalhe = `${valor} giro(s) · crédito automático`;
  else if (tipo === 'role') {
    const status = entregas?.get(linha.request_id);
    detalhe = status === 'delivered' ? 'Cargo · entrega registrada' : status === 'pending'
      ? 'Cargo · entrega pendente para a staff' : 'Cargo · status de entrega indisponível';
  } else if (tipo === 'pix') {
    const status = entregas?.get(linha.request_id);
    detalhe = status === 'delivered' ? 'PIX · entrega registrada pela staff' : status === 'pending'
      ? 'PIX · pendente para atendimento pela staff; pagamento não confirmado'
      : 'PIX · status de entrega desconhecido; pagamento não confirmado';
  }
  else if (tipo === 'shop_item') detalhe = 'Item · registrado no inventário';
  else detalhe = 'Prêmio registrado';
  const instante = Date.parse(linha.created_at);
  const data = Number.isFinite(instante) ? `<t:${Math.floor(instante / 1000)}:d>` : 'Data indisponível';
  return `**${textoSeguro(premio?.name || 'Prêmio')}**\n${detalhe} · ${data}`;
}

async function buscarHistorico(guildId, userId, pagina, cliente) {
  const inicio = pagina * POR_PAGINA;
  async function consultar(comSnapshots) {
    const colunas = 'id,request_id,created_at,' +
      (comSnapshots ? 'prize_name_snapshot,reward_type_snapshot,reward_value_snapshot,' : '') +
      'royal_roulette_prizes(name,reward_type,reward_value)';
    return cliente.from('royal_roulette_spins').select(colunas)
      .eq('guild_id', String(guildId)).eq('user_id', String(userId))
      .order('created_at', { ascending: false }).order('id', { ascending: false })
      .range(inicio, inicio + POR_PAGINA);
  }
  let { data, error } = await consultar(true);
  // Compatibilidade com banco anterior à migração: o histórico antigo não possui snapshots.
  if (error && /(?:prize_name|reward_type|reward_value)_snapshot/i.test(String(error.message || ''))) {
    ({ data, error } = await consultar(false));
  }
  if (error) throw new Error(`Histórico da roleta: ${error.message}`);
  const registros = data || [];
  const paginaAtual = registros.slice(0, POR_PAGINA);
  const ids = paginaAtual.filter((linha) => ['role', 'pix'].includes(premioDaLinha(linha).reward_type))
    .map((linha) => linha.request_id).filter(Boolean);
  const entregas = new Map();
  if (ids.length) {
    try {
      const resposta = await cliente.from('royal_reward_deliveries').select('request_id,status')
        .eq('guild_id', String(guildId)).eq('user_id', String(userId)).in('request_id', ids);
      if (resposta.error) throw new Error(resposta.error.message);
      for (const row of resposta.data || []) entregas.set(row.request_id, row.status);
    } catch (erro) { console.error('[roletapro] falha ao consultar entregas:', erro.message); }
  }
  return { registros: paginaAtual, entregas, temProxima: registros.length > POR_PAGINA };
}

async function mostrarPremios(interaction, pagina = 0, ctx = {}) {
  const cliente = ctx.db?.client || supabase.obterCliente();
  const historico = await buscarHistorico(interaction.guildId, interaction.user.id, pagina, cliente);
  const saldo = await saldoPrivado(interaction.guildId, interaction.user.id);
  const lista = historico.registros.length
    ? historico.registros.map((linha) => descricaoPremio(linha, historico.entregas)).join('\n\n')
    : pagina ? 'Não há prêmios nesta página. Volte para a anterior.' : 'Você ainda não ganhou prêmios na roleta.';
  const botoes = [];
  if (pagina > 0) botoes.push(new ButtonBuilder().setCustomId(`${PREFIXO}premios:${pagina - 1}`).setLabel('Anterior').setStyle(ButtonStyle.Secondary));
  if (historico.temProxima) botoes.push(new ButtonBuilder().setCustomId(`${PREFIXO}premios:${pagina + 1}`).setLabel('Próxima').setStyle(ButtonStyle.Secondary));
  return editarPrivado(interaction, {
    embeds: [card('ROLETA  •  MEUS PRÊMIOS', `${saldo}\n\n**Histórico de prêmios · página ${pagina + 1}**\n\n${lista}`)],
    components: botoes.length ? [new ActionRowBuilder().addComponents(...botoes)] : [],
  });
}

async function publicarPainel(interaction, ctx = {}) {
  const dono = interaction.guild?.ownerId && String(interaction.guild.ownerId) === String(interaction.user.id);
  const administrador = interaction.memberPermissions?.has?.(PermissionFlagsBits.Administrator) || ehAdmin(interaction.member);
  if (!dono && !administrador) {
    return editarPrivado(interaction, { embeds: [card('ROLETA  •  ACESSO NEGADO', 'Somente administradores podem publicar o painel da roleta.')] });
  }
  let cliente;
  let idCanal;
  try {
    cliente = ctx.db?.client || supabase.obterCliente();
    idCanal = await supabase.obterConfig(interaction.guildId, 'roleta_canal', cliente);
  } catch (erro) {
    console.error('[roletapro] falha ao consultar configuração:', erro.message);
    return editarPrivado(interaction, { embeds: [card('ROLETA  •  ATENÇÃO', 'Não foi possível consultar a configuração da roleta; nenhum painel foi publicado.')] });
  }
  let canal;
  try { canal = await canalPublicacao(interaction, idCanal); }
  catch (erro) {
    console.error('[roletapro] canal de publicação indisponível:', erro.message);
    return editarPrivado(interaction, { embeds: [card('ROLETA  •  ATENÇÃO', 'O canal de publicação é inválido ou o bot não pode enviar mensagens nele. Verifique /config roleta; nenhum painel foi publicado.')] });
  }
  let catalogo = null;
  try { catalogo = await buscarCatalogo(cliente, interaction.guildId); }
  catch (erro) { console.error('[roletapro] catálogo indisponível para painel:', erro.message); }
  let mensagem;
  try { mensagem = await canal.send(painelPublico(catalogo)); }
  catch (erro) {
    console.error('[roletapro] falha ao publicar:', erro.message);
    return editarPrivado(interaction, { embeds: [card('ROLETA  •  ATENÇÃO', 'Não consegui publicar o painel. Confira as permissões de envio e anexos do bot.')] });
  }
  let fixado = false;
  try { if (typeof mensagem.pin === 'function') { await mensagem.pin(); fixado = true; } }
  catch (erro) { console.warn('[roletapro] painel publicado sem fixação:', erro.message); }
  let salvo = false;
  try {
    await supabase.definirConfig(interaction.guildId, CHAVE_PAINEL, JSON.stringify({
      channel_id: String(canal.id), message_id: String(mensagem.id),
    }), cliente);
    salvo = true;
  } catch (erro) { console.error('[roletapro] painel publicado sem salvar configuração:', erro.message); }
  const status = `Painel publicado em <#${canal.id}>${fixado ? ' e fixado' : ' (não fixado)'}. ` +
    (salvo ? 'Canal e mensagem registrados.' : 'Não foi possível salvar a referência no Supabase; o painel continua publicado.') +
    (catalogo === null ? ' A lista de prêmios não pôde ser carregada.' : '');
  return editarPrivado(interaction, { embeds: [card('ROLETA  •  PAINEL', status)] });
}

const comando = {
  data: new SlashCommandBuilder()
    .setName('roleta')
    .setDescription('Painel e sorteios da Roleta Royal AP')
    .addSubcommand((sub) => sub.setName('painel').setDescription('Publica o painel da roleta no canal configurado ou atual (admin)'))
    .addSubcommand((sub) => sub.setName('girar').setDescription('Gira a roleta usando um giro disponível')),
  async executar(interaction, ctx = {}) {
    await adiarPrivado(interaction);
    if (!contextoValido(interaction)) {
      return editarPrivado(interaction, { embeds: [card('ROLETA  •  ATENÇÃO', 'Use este comando dentro de um servidor.')] });
    }
    if (interaction.options.getSubcommand() === 'painel') return publicarPainel(interaction, ctx);
    return realizarGiro(interaction);
  },
};

async function handleComponent(interaction, ctx = {}) {
  const id = String(interaction.customId || '');
  if (!id.startsWith(PREFIXO)) return false;
  // Primeira operação assíncrona: o ACK privado chega antes de qualquer consulta.
  await adiarPrivado(interaction);
  try {
    if (!contextoValido(interaction)) {
      await editarPrivado(interaction, { embeds: [card('ROLETA  •  ATENÇÃO', 'Use este botão dentro de um servidor.')] });
    } else if (id === `${PREFIXO}girar`) {
      await realizarGiro(interaction);
    } else if (id === `${PREFIXO}premios`) {
      await mostrarPremios(interaction, 0, ctx);
    } else if (new RegExp(`^${PREFIXO}premios:[0-9]{1,12}$`).test(id)) {
      await mostrarPremios(interaction, Number(id.slice(`${PREFIXO}premios:`.length)), ctx);
    } else {
      await editarPrivado(interaction, { embeds: [card('ROLETA  •  ATENÇÃO', 'Este botão da roleta não é válido.')] });
    }
  } catch (erro) {
    console.error('[roletapro] falha na interação:', erro.message);
    await editarPrivado(interaction, { embeds: [card('ROLETA  •  ATENÇÃO', 'Não foi possível consultar a roleta agora. Tente novamente em instantes.')] });
  }
  return true;
}

module.exports = { comando, publicarPainel, handleComponent };
