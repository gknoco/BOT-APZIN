'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  PermissionFlagsBits,
  ChannelType,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const royal = require('../servicos/royalSupabase');
const supabase = require('../servicos/supabase');
const avisos = require('../servicos/avisosEconomia');
const roletaAnimada = require('../servicos/roletaAnimada');
const { entregarCargo } = require('../servicos/entregaCargo');
const rescueClaim = require('../servicos/rescueClaim');
const { EFEMERO, ehAdmin } = require('../util/seguranca');
const { numeroBR } = require('../util/embeds');

const PREFIXO = 'roletapro:';
const BANNER_NOME = 'roleta-royal-ap.png';
const BANNER = path.join(__dirname, '../../assets', BANNER_NOME);
const CHAVE_PAINEL = 'painel_roleta';
const CHAVE_TEXTO_PAINEL = 'painel_roleta_texto';
const CHAVE_DURACAO = 'roleta_duracao_segundos';
const COR = 0xfacc15;
const TEXTO_PADRAO_PAINEL = [
  '🎰 **ROLETA ROYAL AP**',
  '',
  'A sorte está na sua mão.',
  'Use seus **giros** para disputar os prêmios exclusivos da roleta.',
  '',
  '━━━━━━━━━━━━━━━━━━━━',
  '',
  '🎯 **Como funciona**',
  '• **Girar** — usa 1 giro e sorteia um prêmio',
  '• **Meus Prêmios** — veja seu saldo e histórico privado',
  '',
  '━━━━━━━━━━━━━━━━━━━━',
  '',
  '🏆 **Prêmios disponíveis**',
  '',
  '• Fiel da Royal Ap',
  '• AURA MAXIMA',
  '• BABA OVO DO DONO',
  '• Real Trem',
  '• Verdadeiro Gangster',
  '• Mira Chiclete',
  '• AURA + EGO',
  '• RAINHA DOS APS',
  '• Dono Do Cabaré',
  '• AS LAVA PATRO',
  '',
  '━━━━━━━━━━━━━━━━━━━━',
  '',
  '📌 *Os resultados e saldos são exibidos somente para você.*',
  '*Imagem ilustrativa. Os prêmios e estoques são definidos pela configuração da roleta.*',
].join('\n');
const POR_PAGINA = 8;
const girosEmAndamento = new Set();

function textoSeguro(valor, limite = 100) {
  return String(valor ?? '').replace(/[\r\n\t]+/g, ' ').replace(/([\\*_~`|>])/g, '\\$1').slice(0, limite) || '—';
}

function painelPublico(texto = TEXTO_PADRAO_PAINEL) {
  const arteDisponivel = fs.existsSync(BANNER);
  const painel = new EmbedBuilder()
    .setColor(0xb20d1c)
    .setDescription(String(texto));
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

async function realizarGiro(interaction, ctx = {}) {
  const chave = `${interaction.guildId}:${interaction.user.id}`;
  if (girosEmAndamento.has(chave)) {
    return editarPrivado(interaction, { embeds: [card('ROLETA  •  AGUARDE', 'Você já possui um giro em andamento. Aguarde o resultado antes de girar novamente.')] });
  }
  girosEmAndamento.add(chave);
  try {
    return await executarGiro(interaction, ctx);
  } finally {
    girosEmAndamento.delete(chave);
  }
}

async function executarGiro(interaction, ctx) {
  const embedGiro = () => card('ROLETA  •  SORTEANDO', 'A roleta está girando... aguarde o resultado.');
  await editarPrivado(interaction, {
    embeds: [embedGiro()], components: [], attachments: [], files: [],
  });
  const cliente = ctx.db?.client || supabase.obterCliente();
  let catalogo = [];
  let duracaoSegundos = roletaAnimada.DURACAO_PADRAO_SEGUNDOS;
  const [catalogoConsultado, duracaoConsultada] = await Promise.allSettled([
    buscarCatalogo(cliente, interaction.guildId),
    supabase.obterConfig(interaction.guildId, CHAVE_DURACAO, cliente),
  ]);
  if (catalogoConsultado.status === 'fulfilled') catalogo = catalogoConsultado.value;
  else console.error('[roletapro] catálogo indisponível para animação:', catalogoConsultado.reason.message);
  if (duracaoConsultada.status === 'fulfilled' && duracaoConsultada.value != null) {
    duracaoSegundos = roletaAnimada.validarDuracaoSegundos(duracaoConsultada.value);
  } else if (duracaoConsultada.status === 'rejected') {
    console.error('[roletapro] duração não disponível; usando padrão:', duracaoConsultada.reason.message);
  }
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
      await rescueClaim.entregaAutomatica({ guildId: interaction.guildId, tipo: 'roleta',
        protocolo: `spin:${interaction.id}`, interactionId: interaction.id, userId: interaction.user.id,
        roleId: resultado.reward_value,
        entregar: () => entregarCargo({ guild: interaction.guild, userId: interaction.user.id, roleId: resultado.reward_value }),
      });
      entrega = 'Cargo concedido e entrega registrada.';
    } catch (erro) {
      await auditarSeguro({
        guildId: interaction.guildId, actorId: interaction.user.id,
        action: 'reward.delivery.pending', entityType: 'roulette_spin', entityId: resultado.spin_id,
        requestId: interaction.id,
        detail: `Entrega de cargo pendente (${String(resultado.reward_value).slice(0, 100)}): ${String(erro.message || 'falha Discord').slice(0, 300)}`,
      });
      entrega = 'O prêmio foi registrado; a entrega do cargo requer revisão. Não repita a concessão sem reconciliar.';
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
  const descricao = `Você ganhou **${textoSeguro(resultado.prize_name)}**!\n\n${entrega}\n\n${saldo}`;
  try {
    return await roletaAnimada.animar(interaction, catalogo, resultado, {
      embeds: [card('ROLETA  •  RESULTADO', descricao)],
    }, embedGiro, duracaoSegundos);
  } catch (erro) {
    // O sorteio já foi confirmado: nunca refazê-lo por falha de imagem/Discord.
    console.error('[roletapro] falha na animação:', erro.message);
    return editarPrivado(interaction, {
      embeds: [card('ROLETA  •  RESULTADO', `${descricao}\n\nA animação ficou indisponível; o prêmio acima continua registrado.`)],
      attachments: [], files: [],
    });
  }
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

async function obterMensagemPainel(guild, cliente) {
  const registro = await supabase.obterConfig(guild.id, CHAVE_PAINEL, cliente);
  if (!registro) throw new Error('O painel da roleta ainda não foi registrado. Publique-o com /roleta painel.');
  let referencia;
  try { referencia = JSON.parse(registro); } catch { throw new Error('A referência salva do painel é inválida.'); }
  const { channel_id: canalId, message_id: mensagemId } = referencia || {};
  if (!canalId || !mensagemId) throw new Error('A referência salva do painel está incompleta.');
  const canal = guild.channels?.cache?.get(String(canalId)) || await guild.channels?.fetch?.(String(canalId));
  if (!canal || String(canal.guildId || canal.guild?.id || '') !== String(guild.id) || !canal.messages?.fetch) {
    throw new Error('O canal do painel salvo não está disponível neste servidor.');
  }
  const mensagem = await canal.messages.fetch(String(mensagemId));
  if (!guild.client?.user?.id || String(mensagem?.author?.id || '') !== String(guild.client.user.id)) {
    throw new Error('A mensagem salva não pertence a este bot.');
  }
  const original = mensagem.embeds?.[0];
  if (!original || typeof original.description !== 'string') throw new Error('A mensagem salva não contém o painel da roleta.');
  return { mensagem, original };
}

async function textoSalvoPainel(guildId, cliente) {
  const salvo = await supabase.obterConfig(guildId, CHAVE_TEXTO_PAINEL, cliente);
  const texto = salvo == null ? TEXTO_PADRAO_PAINEL : String(salvo);
  return texto.length <= 4000 && texto.trim() ? texto : TEXTO_PADRAO_PAINEL;
}

function modalEditarPainel(guildId, userId, texto) {
  const entrada = new TextInputBuilder().setCustomId('texto').setLabel('Texto do painel')
    .setStyle(TextInputStyle.Paragraph).setRequired(true).setMinLength(1).setMaxLength(4000)
    .setValue(texto);
  return new ModalBuilder().setCustomId(`${PREFIXO}editarpainel:${guildId}:${userId}:modal`)
    .setTitle('Editar painel da roleta')
    .addComponents(new ActionRowBuilder().addComponents(entrada));
}

// Reaplica o texto persistido sem republicar, trocar botões ou perder a fixação.
async function restaurarPainelSalvo(guild, ctx = {}) {
  const cliente = ctx.db?.client || supabase.obterCliente();
  const registro = await supabase.obterConfig(guild.id, CHAVE_PAINEL, cliente);
  if (!registro) return false;
  const texto = await textoSalvoPainel(guild.id, cliente);
  const { mensagem, original } = await obterMensagemPainel(guild, cliente);
  if (original.title !== 'ROLETA ROYAL AP' && original.description !== texto &&
      !original.description.startsWith('🎰 **ROLETA ROYAL AP**')) return false;
  if (original.description === texto && original.title == null && original.footer == null && original.color === 0xb20d1c) return false;
  const painel = EmbedBuilder.from(original).setTitle(null).setColor(0xb20d1c)
    .setDescription(texto).setFooter(null);
  await mensagem.edit({ embeds: [painel], allowedMentions: { parse: [] } });
  return true;
}

async function publicarPainel(interaction, ctx = {}) {
  const dono = interaction.guild?.ownerId && String(interaction.guild.ownerId) === String(interaction.user.id);
  const administrador = interaction.memberPermissions?.has?.(PermissionFlagsBits.Administrator) || ehAdmin(interaction.member);
  if (!dono && !administrador) {
    return editarPrivado(interaction, { embeds: [card('ROLETA  •  ACESSO NEGADO', 'Somente administradores podem publicar o painel da roleta.')] });
  }
  let cliente;
  let idCanal;
  let textoPainel;
  try {
    cliente = ctx.db?.client || supabase.obterCliente();
    [idCanal, textoPainel] = await Promise.all([
      supabase.obterConfig(interaction.guildId, 'roleta_canal', cliente),
      textoSalvoPainel(interaction.guildId, cliente),
    ]);
  } catch (erro) {
    console.error('[roletapro] falha ao consultar configuração:', erro.message);
    return editarPrivado(interaction, { embeds: [card('ROLETA  •  ATENÇÃO', 'Não foi possível consultar a configuração da roleta; nenhum painel foi publicado.')] });
  }
  let canal;
  try { canal = await canalPublicacao(interaction, idCanal); }
  catch (erro) {
    console.error('[roletapro] canal de publicação indisponível:', erro.message);
    return editarPrivado(interaction, { embeds: [card('ROLETA  •  ATENÇÃO', 'O canal de publicação é inválido ou o bot não pode enviar mensagens nele. Verifique /configroleta; nenhum painel foi publicado.')] });
  }
  let mensagem;
  try { mensagem = await canal.send(painelPublico(textoPainel)); }
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
    (salvo ? 'Canal e mensagem registrados.' : 'Não foi possível salvar a referência no Supabase; o painel continua publicado.');
  const componentes = salvo
    ? [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${PREFIXO}editarpainel:${interaction.guildId}:${interaction.user.id}`)
        .setLabel('editar msm painel').setStyle(ButtonStyle.Primary),
    )]
    : [];
  return editarPrivado(interaction, { embeds: [card('ROLETA  •  PAINEL', status)], components: componentes });
}

const comando = {
  data: new SlashCommandBuilder()
    .setName('roleta')
    .setDescription('Painel e sorteios da Roleta Royal AP')
    .addSubcommand((sub) => sub.setName('painel').setDescription('Publica o painel da roleta no canal configurado ou atual (admin)')),
  async executar(interaction, ctx = {}) {
    await adiarPrivado(interaction);
    if (!contextoValido(interaction)) {
      return editarPrivado(interaction, { embeds: [card('ROLETA  •  ATENÇÃO', 'Use este comando dentro de um servidor.')] });
    }
    if (interaction.options.getSubcommand() === 'painel') return publicarPainel(interaction, ctx);
    return editarPrivado(interaction, { embeds: [card('ROLETA  •  ATENÇÃO', 'Use o botão Girar roleta no painel publicado para sortear um prêmio.')] });
  },
};

async function responderErroEdicao(interaction, mensagem, modalSubmit) {
  const resposta = { embeds: [card('ROLETA  •  ATENÇÃO', mensagem)], allowedMentions: { parse: [] } };
  if (modalSubmit) {
    await adiarPrivado(interaction);
    return editarPrivado(interaction, resposta);
  }
  return interaction.reply({ ...resposta, flags: EFEMERO });
}

async function handleEditarPainel(interaction, ctx = {}) {
  const partes = String(interaction.customId || '').split(':');
  const modalSubmit = Boolean(interaction.isModalSubmit?.());
  const idValido = partes[0] === 'roletapro' && partes[1] === 'editarpainel' &&
    ((modalSubmit && partes.length === 5 && partes[4] === 'modal') ||
      (!modalSubmit && interaction.isButton?.() && partes.length === 4));
  if (!idValido || partes[2] !== String(interaction.guildId) || partes[3] !== String(interaction.user?.id) ||
      !contextoValido(interaction)) {
    await responderErroEdicao(interaction, 'Este controle pertence a outra pessoa ou servidor.', modalSubmit);
    return true;
  }
  const dono = interaction.guild?.ownerId && String(interaction.guild.ownerId) === String(interaction.user.id);
  const administrador = interaction.memberPermissions?.has?.(PermissionFlagsBits.Administrator) || ehAdmin(interaction.member);
  if (!dono && !administrador) {
    await responderErroEdicao(interaction, 'Somente administradores podem editar o painel da roleta.', modalSubmit);
    return true;
  }

  if (!modalSubmit) {
    try {
      const cliente = ctx.db?.client || supabase.obterCliente();
      const texto = await textoSalvoPainel(interaction.guildId, cliente);
      await interaction.showModal(modalEditarPainel(interaction.guildId, interaction.user.id, texto));
    } catch (erro) {
      console.error('[roletapro] falha ao abrir edição do painel:', erro.message);
      await responderErroEdicao(interaction, 'Não foi possível abrir a edição. Tente novamente.', false);
    }
    return true;
  }

  await adiarPrivado(interaction);
  const texto = String(interaction.fields?.getTextInputValue?.('texto') ?? '');
  if (!texto.trim() || texto.length > 4000) {
    await editarPrivado(interaction, { embeds: [card('ROLETA  •  ATENÇÃO', 'Informe um texto de 1 a 4.000 caracteres.')] });
    return true;
  }
  const cliente = ctx.db?.client || supabase.obterCliente();
  try {
    const { mensagem, original } = await obterMensagemPainel(interaction.guild, cliente);
    const embed = EmbedBuilder.from(original).setTitle(null).setColor(0xb20d1c)
      .setDescription(texto).setFooter(null);
    await supabase.definirConfig(interaction.guildId, CHAVE_TEXTO_PAINEL, texto, cliente);
    try {
      await mensagem.edit({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch (erro) {
      console.error('[roletapro] texto salvo, mas a mensagem ainda não atualizou:', erro.message);
      return editarPrivado(interaction, { embeds: [card('ROLETA  •  ATENÇÃO', 'O texto foi salvo, mas não consegui atualizar a mensagem agora. Ele será reaplicado ao restaurar o painel.')] });
    }
    return editarPrivado(interaction, { embeds: [card('ROLETA  •  PAINEL', 'O texto do painel existente foi atualizado e salvo. Republicações e reinicializações manterão esta versão.')] });
  } catch (erro) {
    console.error('[roletapro] falha ao salvar edição do painel:', erro.message);
    return editarPrivado(interaction, { embeds: [card('ROLETA  •  ATENÇÃO', 'Não consegui atualizar o painel salvo. Confira se a mensagem continua disponível e tente novamente.')] });
  }
}

async function handleComponent(interaction, ctx = {}) {
  const id = String(interaction.customId || '');
  if (!id.startsWith(PREFIXO) && id !== 'ap:roletagirar') return false;
  if (id.startsWith(`${PREFIXO}editarpainel:`)) return handleEditarPainel(interaction, ctx);
  // Primeira operação assíncrona: o ACK privado chega antes de qualquer consulta.
  await adiarPrivado(interaction);
  try {
    if (!contextoValido(interaction)) {
      await editarPrivado(interaction, { embeds: [card('ROLETA  •  ATENÇÃO', 'Use este botão dentro de um servidor.')] });
    } else if (id === `${PREFIXO}girar` || id === 'ap:roletagirar') {
      await realizarGiro(interaction, ctx);
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

module.exports = { comando, publicarPainel, restaurarPainelSalvo, handleComponent, painelPublico, TEXTO_PADRAO_PAINEL };
