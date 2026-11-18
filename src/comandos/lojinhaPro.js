'use strict';

/** Lojinha Royal: sem collectors ou estado em memória; dados sempre por servidor/usuário. */
const fs = require('node:fs');
const path = require('node:path');
const {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, StringSelectMenuBuilder, AttachmentBuilder, ChannelType, PermissionFlagsBits,
} = require('discord.js');
const royal = require('../servicos/royalSupabase');
const supabase = require('../servicos/supabase');
const avisos = require('../servicos/avisosEconomia');
const { entregarCargo } = require('../servicos/entregaCargo');
const { EFEMERO, ehAdmin } = require('../util/seguranca');
const { numeroBR } = require('../util/embeds');

const PREFIXO = 'lojinhapro:';
const PAGINA = 25;
const COR = 0xd9a52f;
const ARTE = path.join(__dirname, '../../assets/lojinha-royal-ap.png');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIPOS = { pix: 'Pix', physical: 'Produto físico', role: 'Cargo', spins: 'Giros', coins: 'Moedas' };
const STATUS = { pending: 'Pendente', completed: 'Concluído', paid: 'Pago', delivered: 'Entregue', cancelled: 'Cancelado' };
const mencoesSeguras = { parse: [] };

function limitar(valor, tamanho) {
  const texto = String(valor ?? '').replace(/[\r\n]+/g, ' ').trim();
  return texto.length > tamanho ? `${texto.slice(0, tamanho - 1)}…` : texto;
}
function textoSeguro(valor, tamanho = 150) {
  return limitar(valor, tamanho).replace(/[`*_~|<>\\]/g, '\\$&');
}
function card(titulo, descricao) {
  return new EmbedBuilder().setColor(COR).setTitle(titulo).setDescription(descricao)
    .setFooter({ text: 'ROYAL AP  •  LOJINHA' });
}
function botao(id, label, style = ButtonStyle.Secondary, disabled = false) {
  return new ButtonBuilder().setCustomId(`${PREFIXO}${id}`).setLabel(label).setStyle(style).setDisabled(disabled);
}
function moeda(n) { return `${numeroBR(n)} COIN`; }
function estoque(item) {
  return item.stock == null ? 'Estoque livre' : Number(item.stock) > 0 ? `${numeroBR(item.stock)} em estoque` : 'Esgotado';
}
function tipo(item) { return TIPOS[item.reward_type] || 'Item'; }
function statusCompra(status) { return STATUS[status] || textoSeguro(status || 'Desconhecido', 30); }
function dadosObrigatorios(i) { return Boolean(i.guildId && i.user?.id && i.id); }

// O dispatcher de comandos pode já ter feito deferReply efêmero. Componentes devem
// entrar aqui antes de qualquer deferUpdate ou outro ACK do roteador.
async function adiar(i) {
  if (i.deferred || i.replied) return;
  await i.deferReply({ flags: EFEMERO });
}
async function editar(i, payload) {
  return i.editReply({ allowedMentions: mencoesSeguras, ...payload });
}
function mensagemErro(erro, compra = false) {
  const mensagem = String(erro?.message || '');
  if (/saldo insuficiente/i.test(mensagem)) return 'Saldo insuficiente para este item. Confira suas moedas antes de tentar novamente.';
  if (/o preço mudou/i.test(mensagem)) return 'O preço mudou. Abra o catálogo e confirme o valor atualizado antes de comprar.';
  if (/sem estoque/i.test(mensagem)) return 'Este item está sem estoque. Consulte o catálogo atualizado.';
  if (/item indispon[ií]vel/i.test(mensagem)) return 'Este item não está mais disponível. Consulte o catálogo atualizado.';
  if (/limite de compras por usu[aá]rio atingido/i.test(mensagem)) return 'Você já atingiu o limite de compras deste item.';
  return compra
    ? 'Não foi possível confirmar o resultado da compra. Consulte seu histórico antes de tentar novamente ou procure a administração.'
    : 'Não foi possível carregar os dados agora. Tente novamente em instantes.';
}
async function erroPrivado(i, mensagem) {
  return editar(i, { embeds: [card('LOJINHA  /  AVISO', mensagem)], components: [] });
}

function instrucoesSeguras(valor) {
  // Configurações existentes também podem ter sido gravadas fora do formulário.
  // A limitação precede o escape, mantendo a descrição bem abaixo de 4096 caracteres.
  return String(valor ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 200)
    .replace(/([\\`*_~|<>\[\]()#>])/g, '\\$1').replace(/@/g, '@\u200b');
}

function painel(instrucoes) {
  const textoInstrucoes = instrucoesSeguras(instrucoes);
  const destaque = card('ROYAL AP  |  LOJINHA',
    '**JOGUE. VENÇA. RESGATE.**\n' +
    'A cada WIN, você ganha 1 COIN\n\n' +
    'Acompanhe sua evolução e troque suas moedas por recompensas da comunidade.\n' +
    'Escolha uma opção abaixo para abrir sua área **privada**.' +
    (textoInstrucoes ? `\n\n**Instruções**\n${textoInstrucoes}` : ''));
  destaque.addFields(
    { name: '01  /  SUAS MOEDAS', value: 'Saldo, posição e estatísticas', inline: true },
    { name: '02  /  RANKING', value: 'Os líderes em COINS', inline: true },
    { name: '03  /  RESGATES', value: 'Inventário e histórico', inline: true },
    { name: '04  /  CATÁLOGO', value: 'Itens, preços e estoque', inline: true },
  );
  const componentes = new ActionRowBuilder().addComponents(
    botao('moedas', 'Suas Moedas', ButtonStyle.Primary),
    botao('ranking', 'Ranking'),
    botao('inventario', 'Seu Inventário/Resgates'),
    botao('catalogo', 'Catálogo de Itens', ButtonStyle.Success),
  );
  const payload = { embeds: [destaque], components: [componentes], allowedMentions: mencoesSeguras };
  try {
    fs.accessSync(ARTE, fs.constants.R_OK);
    if (fs.statSync(ARTE).isFile()) {
      payload.files = [new AttachmentBuilder(ARTE, { name: 'lojinha-royal-ap.png' })];
      destaque.setImage('attachment://lojinha-royal-ap.png');
    }
  } catch { /* Banner opcional: o painel permanece funcional sem o arquivo. */ }
  return payload;
}

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

async function publicarPainel(interaction, ctx = {}) {
  await adiar(interaction);
  if (!dadosObrigatorios(interaction)) return erroPrivado(interaction, 'Use este comando em um servidor.');
  if (!ehAdmin(interaction.member)) return erroPrivado(interaction, 'Somente a administração pode publicar o painel.');
  let cliente;
  let idCanal;
  let instrucoes;
  try {
    cliente = ctx.db?.client || supabase.obterCliente();
    [idCanal, instrucoes] = await Promise.all([
      supabase.obterConfig(interaction.guildId, 'lojinha_canal', cliente),
      supabase.obterConfig(interaction.guildId, 'lojinha_instrucoes', cliente),
    ]);
  } catch (erro) {
    console.error('[lojinhapro] falha ao consultar configuração:', erro.message);
    return erroPrivado(interaction, 'Não foi possível consultar a configuração da lojinha; nenhum painel foi publicado.');
  }
  let canal;
  try { canal = await canalPublicacao(interaction, idCanal); }
  catch (erro) {
    console.error('[lojinhapro] canal de publicação indisponível:', erro.message);
    return erroPrivado(interaction, 'O canal de publicação é inválido ou o bot não pode enviar mensagens nele. Verifique /config lojinha; nenhum painel foi publicado.');
  }
  let mensagem;
  try {
    mensagem = await canal.send(painel(instrucoes));
  } catch (erro) {
    console.error('[lojinhapro] envio do painel:', erro.message);
    return erroPrivado(interaction, 'Não consegui publicar o painel. Verifique as permissões do bot neste canal.');
  }
  let fixado = false;
  try { if (typeof mensagem.pin === 'function') { await mensagem.pin(); fixado = true; } }
  catch (erro) { console.warn('[lojinhapro] painel publicado sem fixação:', erro.message); }
  let salvo = false;
  try {
    await supabase.definirConfig(interaction.guildId, 'lojinhapro_painel', JSON.stringify({
      canal_id: String(canal.id), mensagem_id: String(mensagem.id),
    }), cliente);
    salvo = true;
  } catch (erro) {
    console.error('[lojinhapro] painel publicado, mas IDs não salvos:', erro.message);
  }
  const status = `O painel foi publicado em <#${canal.id}>${fixado ? ' e fixado' : ' (não fixado)'}. ` +
    (salvo ? 'Canal e mensagem registrados.' : 'Não consegui salvar seus IDs no Supabase. Não publique outro sem verificar o canal.');
  return editar(interaction, { embeds: [card('PAINEL PUBLICADO', status)], components: [] });
}

async function mostrarMoedas(i) {
  const [perfil, posicao] = await Promise.all([
    royal.resumo(i.guildId, i.user.id), royal.posicaoRanking(i.guildId, i.user.id, 'coins'),
  ]);
  const descricao = `**SALDO**\n# ${moeda(perfil.coins)}\n\n` +
    `**POSIÇÃO EM COINS**\n${posicao ? `#${numeroBR(posicao)}` : 'Fora do top 1.000 ou sem moedas'}\n\n` +
    `**ESTATÍSTICAS**\nVitórias: **${numeroBR(perfil.vitorias)}**  •  Derrotas: **${numeroBR(perfil.derrotas)}**\n` +
    `Aproveitamento: **${numeroBR(perfil.aproveitamento)}%**  •  Giros: **${numeroBR(perfil.giros)}**`;
  return editar(i, { embeds: [card('SUA CONTA  /  MOEDAS', descricao)], components: [] });
}
async function mostrarRanking(i) {
  const rows = await royal.topPerfis(i.guildId, 'coins', 10);
  const linhas = rows.map((row, n) => `**${String(n + 1).padStart(2, '0')}**  ·  <@${String(row.user_id).replace(/[^0-9]/g, '')}>  —  **${moeda(row.coins)}**`);
  return editar(i, { embeds: [card('PLACAR  /  TOP COINS', linhas.join('\n') || 'Ainda não há jogadores com COINS neste servidor.')], components: [] });
}

function linhasHistorico(rows) {
  return rows.map((linha) => {
    const data = Date.parse(linha.created_at);
    const dataTexto = Number.isFinite(data) ? `<t:${Math.floor(data / 1000)}:d>` : 'data desconhecida';
    return `• **${textoSeguro(linha.royal_shop_items?.name || 'Item', 55)}** · ${moeda(linha.price)} · **${statusCompra(linha.status)}**\n  ${dataTexto} · \`${textoSeguro(linha.id, 36)}\``;
  });
}
async function mostrarInventario(i) {
  const cliente = supabase.obterCliente();
  const [inventario, historico] = await Promise.all([
    cliente.from('royal_inventory').select('quantity,item_id,royal_shop_items(name,description,reward_type)')
      .eq('guild_id', String(i.guildId)).eq('user_id', String(i.user.id)).gt('quantity', 0)
      .order('updated_at', { ascending: false }).limit(10),
    cliente.from('royal_purchases').select('id,price,status,created_at,royal_shop_items(name,reward_type)')
      .eq('guild_id', String(i.guildId)).eq('user_id', String(i.user.id))
      .order('created_at', { ascending: false }).order('id', { ascending: false }).limit(10),
  ]);
  if (inventario.error) throw new Error(`inventário: ${inventario.error.message}`);
  if (historico.error) throw new Error(`histórico: ${historico.error.message}`);
  const itens = (inventario.data || []).map((linha) => `• **${textoSeguro(linha.royal_shop_items?.name || 'Item', 60)}** ×${numeroBR(linha.quantity)}`);
  const compras = linhasHistorico(historico.data || []);
  const descricao = `**INVENTÁRIO  /  até 10 itens**\n${itens.join('\n') || 'Seu inventário está vazio.'}\n\n` +
    `**HISTÓRICO DE RESGATES  /  10 mais recentes**\n${compras.join('\n') || 'Você ainda não fez resgates.'}\n\n` +
    'Pix e produtos físicos pendentes dependem da administração; não há pagamento ou envio automático.';
  const botoes = [];
  if (itens.length) botoes.push(botao(`meusitens:${i.user.id}:0`, 'Ver inventário completo', ButtonStyle.Primary));
  if (compras.length) botoes.push(botao(`historico:${i.user.id}:0`, 'Ver histórico completo', ButtonStyle.Primary));
  const components = botoes.length ? [new ActionRowBuilder().addComponents(botoes)] : [];
  return editar(i, { embeds: [card('SEU INVENTÁRIO  /  RESGATES', descricao)], components });
}

async function mostrarMeusItens(i, pagina = 0) {
  const inicio = pagina * 10;
  const resultado = await supabase.obterCliente().from('royal_inventory')
    .select('quantity,item_id,royal_shop_items(name,description,reward_type)', { count: 'exact' })
    .eq('guild_id', String(i.guildId)).eq('user_id', String(i.user.id)).gt('quantity', 0)
    .order('updated_at', { ascending: false }).order('item_id', { ascending: false }).range(inicio, inicio + 9);
  if (resultado.error) {
    if (pagina > 0 && (resultado.error.code === 'PGRST103' || resultado.status === 416)) return mostrarMeusItens(i, 0);
    throw new Error(`inventário: ${resultado.error.message}`);
  }
  if (pagina > 0 && !resultado.data?.length) return mostrarMeusItens(i, 0);
  const total = Number(resultado.count ?? resultado.data?.length ?? 0);
  const paginas = Math.max(1, Math.ceil(total / 10));
  const linhas = (resultado.data || []).map((linha) => `• **${textoSeguro(linha.royal_shop_items?.name || 'Item', 60)}** ×${numeroBR(linha.quantity)}`);
  const descricao = `**Página ${pagina + 1}/${paginas}**  •  ${numeroBR(total)} tipos de itens\n\n${linhas.join('\n') || 'Seu inventário está vazio.'}`;
  const components = paginas > 1 ? [new ActionRowBuilder().addComponents(
    botao(`meusitens:${i.user.id}:${Math.max(0, pagina - 1)}`, 'Anterior', ButtonStyle.Secondary, pagina === 0),
    botao(`meusitens:${i.user.id}:${pagina + 1}`, 'Próxima', ButtonStyle.Secondary, pagina >= paginas - 1),
  )] : [];
  return editar(i, { embeds: [card('SEU INVENTÁRIO  /  ITENS', descricao)], components });
}

async function mostrarHistorico(i, pagina = 0) {
  const inicio = pagina * 10;
  const resultado = await supabase.obterCliente().from('royal_purchases')
    .select('id,price,status,created_at,royal_shop_items(name,reward_type)', { count: 'exact' })
    .eq('guild_id', String(i.guildId)).eq('user_id', String(i.user.id))
    .order('created_at', { ascending: false }).order('id', { ascending: false }).range(inicio, inicio + 9);
  if (resultado.error) {
    if (pagina > 0 && (resultado.error.code === 'PGRST103' || resultado.status === 416)) return mostrarHistorico(i, 0);
    throw new Error(`histórico: ${resultado.error.message}`);
  }
  if (pagina > 0 && !resultado.data?.length) return mostrarHistorico(i, 0);
  const total = Number(resultado.count ?? resultado.data?.length ?? 0);
  const paginas = Math.max(1, Math.ceil(total / 10));
  const linhas = linhasHistorico(resultado.data || []);
  const descricao = `**Página ${pagina + 1}/${paginas}**  •  ${numeroBR(total)} resgates\n\n` +
    `${linhas.join('\n') || 'Você ainda não fez resgates.'}\n\n` +
    'Pix e produtos físicos pendentes dependem da administração; não há pagamento ou envio automático.';
  const components = paginas > 1 ? [new ActionRowBuilder().addComponents(
    botao(`historico:${i.user.id}:${Math.max(0, pagina - 1)}`, 'Anterior', ButtonStyle.Secondary, pagina === 0),
    botao(`historico:${i.user.id}:${pagina + 1}`, 'Próxima', ButtonStyle.Secondary, pagina >= paginas - 1),
  )] : [];
  return editar(i, { embeds: [card('RESGATES  /  HISTÓRICO', descricao)], components });
}

async function buscarPagina(guildId, pagina) {
  const inicio = pagina * PAGINA;
  const resultado = await supabase.obterCliente().from('royal_shop_items')
    .select('id,slug,name,description,price,reward_type,stock', { count: 'exact' })
    .eq('guild_id', String(guildId)).eq('active', true)
    .order('price', { ascending: true }).order('id', { ascending: true })
    .range(inicio, inicio + PAGINA - 1);
  if (resultado.error) {
    // Páginas podem deixar de existir enquanto o jogador navega.
    if (pagina > 0 && (resultado.error.code === 'PGRST103' || resultado.status === 416)) return buscarPagina(guildId, 0);
    throw new Error(`catálogo: ${resultado.error.message}`);
  }
  if (pagina > 0 && !resultado.data?.length) return buscarPagina(guildId, 0);
  return { itens: resultado.data || [], total: Number(resultado.count ?? resultado.data?.length ?? 0), pagina };
}
async function mostrarCatalogo(i, pagina = 0) {
  const dados = await buscarPagina(i.guildId, pagina);
  const paginas = Math.max(1, Math.ceil(dados.total / PAGINA));
  const descricao = dados.itens.length
    ? `**${numeroBR(dados.total)} itens ativos**  •  Página **${dados.pagina + 1}/${paginas}**\n` +
      'Escolha um item no menu para ver detalhes e confirmar o resgate. O saldo e o estoque são verificados na compra.'
    : 'Nenhum produto ativo foi cadastrado neste servidor.';
  const componentes = [];
  if (dados.itens.length) {
    const menu = new StringSelectMenuBuilder().setCustomId(`${PREFIXO}selecionar:${i.user.id}`)
      .setPlaceholder('Selecione um item para conferir e comprar').setMinValues(1).setMaxValues(1)
      .addOptions(dados.itens.map((item) => ({
        label: limitar(item.name || 'Item', 100) || 'Item',
        value: String(item.id),
        description: limitar(`${moeda(item.price)} • ${tipo(item)} • ${estoque(item)}`, 100),
      })));
    componentes.push(new ActionRowBuilder().addComponents(menu));
  }
  if (paginas > 1) {
    componentes.push(new ActionRowBuilder().addComponents(
      botao(`pagina:${i.user.id}:${Math.max(0, dados.pagina - 1)}`, 'Anterior', ButtonStyle.Secondary, dados.pagina === 0),
      botao(`pagina:${i.user.id}:${dados.pagina + 1}`, 'Próxima', ButtonStyle.Secondary, dados.pagina >= paginas - 1),
    ));
  }
  return editar(i, { embeds: [card('CATÁLOGO  /  RESGATES', descricao)], components: componentes });
}
async function buscarItem(guildId, chave, campo = 'id') {
  const resultado = await supabase.obterCliente().from('royal_shop_items')
    .select('id,slug,name,description,price,reward_type,reward_value,stock')
    .eq('guild_id', String(guildId)).eq('active', true).eq(campo, String(chave)).maybeSingle();
  if (resultado.error) throw new Error(`item: ${resultado.error.message}`);
  return resultado.data;
}
async function detalhesItem(i, item) {
  if (!item) return erroPrivado(i, 'Item não encontrado ou indisponível. Abra o catálogo novamente.');
  const descricao = `**${textoSeguro(item.name, 100)}**\n${textoSeguro(item.description || 'Sem descrição.', 600)}\n\n` +
    `**PREÇO**  ${moeda(item.price)}\n**TIPO**  ${tipo(item)}\n**ESTOQUE**  ${estoque(item)}\n\n` +
    'A confirmação registra uma compra. Pix e itens físicos são tratados pela administração.';
  const preco = String(item.price);
  const componentes = (item.stock != null && Number(item.stock) < 1) || !/^\d{1,19}$/.test(preco) ? [] : [
    new ActionRowBuilder().addComponents(botao(`comprar:${i.user.id}:${item.id}:${preco}`, 'Confirmar compra', ButtonStyle.Success)),
  ];
  return editar(i, { embeds: [card('CATÁLOGO  /  DETALHES', descricao)], components: componentes });
}
async function auditarSeguro(evento) {
  try { await royal.auditar(evento); } catch (erro) { console.error('[lojinhapro] auditoria:', erro.message); }
}
async function comprarItem(i, item, precoConfirmado = item?.price) {
  if (!item) return erroPrivado(i, 'Item não encontrado ou indisponível. Abra o catálogo novamente.');
  if (precoConfirmado === undefined || precoConfirmado === null) throw new Error('Preço esperado inválido');
  // O preço é validado no banco sob o mesmo lock que protege estoque e débito.
  const compra = await royal.comprar({
    guildId: i.guildId, userId: i.user.id, itemId: item.id, request: i.id, expectedPrice: precoConfirmado,
  });
  if (!compra?.purchase_id) throw new Error('A compra não retornou confirmação.');
  let entrega;
  let pendenciaAviso;
  if (item.reward_type === 'role' && compra.status === 'pending') {
    try {
      // Não conceder o cargo previamente consultado se o cadastro tiver mudado.
      const atual = await buscarItem(i.guildId, item.id);
      if (!atual || atual.reward_type !== 'role' || atual.reward_value !== item.reward_value) throw new Error('Cadastro do cargo alterado; requer revisão manual');
      await entregarCargo({ guild: i.guild, userId: i.user.id, roleId: atual.reward_value });
      const marcado = await royal.marcarCompraEntregue({ guildId: i.guildId, userId: i.user.id, purchaseId: compra.purchase_id });
      if (marcado === false) throw new Error('Não foi possível confirmar o registro da entrega');
      entrega = 'Cargo concedido e entrega registrada.';
    } catch (erro) {
      await auditarSeguro({ guildId: i.guildId, actorId: i.user.id, action: 'reward.delivery.pending',
        entityType: 'purchase', entityId: compra.purchase_id, requestId: i.id,
        detail: `Entrega de cargo requer revisão (${limitar(item.reward_value, 80)}): ${limitar(erro.message, 300)}` });
      entrega = 'Entrega do cargo requer revisão da administração. Verifique o status no histórico.';
      pendenciaAviso = 'Entrega de cargo da lojinha pendente ou requer revisão.';
    }
  } else if (compra.status === 'pending') {
    entrega = 'Resgate pendente: a administração deverá processar o pagamento ou a entrega. Nada é pago ou enviado automaticamente.';
    if (['pix', 'physical'].includes(item.reward_type)) {
      pendenciaAviso = item.reward_type === 'pix'
        ? 'Resgate PIX da lojinha pendente de atendimento; pagamento não confirmado.'
        : 'Resgate de produto físico da lojinha pendente de atendimento.';
      await auditarSeguro({ guildId: i.guildId, actorId: i.user.id, action: 'reward.delivery.pending',
        entityType: 'purchase', entityId: compra.purchase_id, requestId: i.id,
        detail: pendenciaAviso });
    }
  } else {
    entrega = `Status registrado: **${statusCompra(compra.status)}**.`;
  }
  await auditarSeguro({ guildId: i.guildId, actorId: i.user.id, action: 'shop.purchase', entityType: 'purchase',
    entityId: compra.purchase_id, requestId: i.id, detail: limitar(item.name, 150) });
  if (pendenciaAviso) {
    try { await avisos.avisarStaff(i, { origem: 'Lojinha', descricao: pendenciaAviso, protocolo: compra.purchase_id }); }
    catch (erro) { console.error('[lojinhapro] falha ao avisar staff:', erro.message); }
  }
  return editar(i, { embeds: [card('RESGATE  /  REGISTRADO',
    `**${textoSeguro(compra.item_name || item.name, 100)}**\nSaldo após a compra: **${moeda(compra.new_balance)}**\n` +
    `Protocolo: \`${textoSeguro(compra.purchase_id, 36)}\`\n\n${entrega}`)], components: [] });
}

const comando = {
  data: new SlashCommandBuilder().setName('lojinha').setDescription('Lojinha persistente da ORG Royal AP')
    .addSubcommand((s) => s.setName('listar').setDescription('Abre o catálogo de produtos disponíveis'))
    .addSubcommand((s) => s.setName('comprar').setDescription('Compra um produto pelo ID ou slug')
      .addStringOption((o) => o.setName('item').setDescription('ID ou slug do produto').setRequired(true))),
  async executar(i, ctx = {}) {
    await adiar(i);
    if (!dadosObrigatorios(i)) return erroPrivado(i, 'Use este comando em um servidor.');
    const sub = i.options.getSubcommand();
    try {
      if (sub === 'listar') return await mostrarCatalogo(i);
      if (sub === 'comprar') {
        const chave = String(i.options.getString('item') || '').trim();
        if (!chave || chave.length > 100) return erroPrivado(i, 'Informe o ID ou slug de um item válido.');
        let item = UUID.test(chave) ? await buscarItem(i.guildId, chave, 'id') : null;
        if (!item) item = await buscarItem(i.guildId, chave, 'slug');
        return await comprarItem(i, item);
      }
      return erroPrivado(i, 'Subcomando desconhecido.');
    } catch (erro) {
      console.error('[lojinhapro] comando:', erro.message);
      return erroPrivado(i, mensagemErro(erro, sub === 'comprar'));
    }
  },
};

async function handleComponent(i) {
  const customId = String(i.customId || '');
  if (!customId.startsWith(PREFIXO)) return false;
  // Nunca trabalhar sobre um componente previamente confirmado por outro roteador:
  // deferUpdate poderia transformar editReply em uma alteração do painel público.
  if (i.deferred || i.replied) {
    await i.followUp({ content: 'Esta interação já foi processada. Tente novamente.', flags: EFEMERO });
    return true;
  }
  await adiar(i);
  if (!dadosObrigatorios(i)) { await erroPrivado(i, 'Use este painel em um servidor.'); return true; }
  const [acao, dono, argumento, extra, ...resto] = customId.slice(PREFIXO.length).split(':');
  const privadas = ['pagina', 'historico', 'meusitens', 'selecionar', 'comprar'];
  if (privadas.includes(acao) && dono !== String(i.user.id)) {
    await erroPrivado(i, 'Este menu pertence a outro jogador. Abra seu próprio catálogo.');
    return true;
  }
  try {
    if (resto.length || (extra && acao !== 'comprar')) await erroPrivado(i, 'Interação inválida. Abra o catálogo novamente.');
    else if (acao === 'moedas' && !dono) await mostrarMoedas(i);
    else if (acao === 'ranking' && !dono) await mostrarRanking(i);
    else if (acao === 'inventario' && !dono) await mostrarInventario(i);
    else if (acao === 'catalogo' && !dono) await mostrarCatalogo(i);
    else if (acao === 'pagina' && /^\d{1,6}$/.test(argumento || '')) await mostrarCatalogo(i, Number(argumento));
    else if (acao === 'historico' && /^\d{1,6}$/.test(argumento || '')) await mostrarHistorico(i, Number(argumento));
    else if (acao === 'meusitens' && /^\d{1,6}$/.test(argumento || '')) await mostrarMeusItens(i, Number(argumento));
    else if (acao === 'selecionar' && !argumento && Array.isArray(i.values) && i.values.length === 1 && UUID.test(i.values[0])) {
      await detalhesItem(i, await buscarItem(i.guildId, i.values[0]));
    } else if (acao === 'comprar' && UUID.test(argumento || '') && /^\d{1,19}$/.test(extra || '')) {
      const item = await buscarItem(i.guildId, argumento);
      if (item && String(item.price) !== extra) await erroPrivado(i, 'O preço mudou. Abra o catálogo e confirme o valor atualizado antes de comprar.');
      else await comprarItem(i, item, extra);
    } else await erroPrivado(i, 'Interação inválida. Abra o catálogo novamente.');
  } catch (erro) {
    console.error('[lojinhapro] componente:', erro.message);
    await erroPrivado(i, mensagemErro(erro, acao === 'comprar'));
  }
  return true;
}

module.exports = { comando, publicarPainel, handleComponent };
