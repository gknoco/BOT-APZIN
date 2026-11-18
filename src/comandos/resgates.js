'use strict';

// Central administrativa: não realiza pagamentos, envios ou concessões de cargo.
const { SlashCommandBuilder } = require('discord.js');
const supabase = require('../servicos/supabase');
const royal = require('../servicos/royalSupabase');
const { EFEMERO, exigirAdmin, responderPrivado } = require('../util/seguranca');

const TIPOS_LOJA = ['role', 'pix', 'physical'];
const TIPOS_ROLETA = ['role', 'pix'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AVISO = 'Marque somente após o pagamento, envio ou concessão do cargo ter sido feito manualmente. Este comando não processa pagamentos nem realiza envios ou concede cargos.';
const AVISO_AUDITORIA = 'A atualização e a auditoria são operações separadas: a auditoria pode falhar mesmo após a atualização; confira o registro de auditoria.';
const mencoesSeguras = { parse: [] };

async function adiarPrivado(i) {
  // O dispatcher já faz defer efêmero, mas o módulo também pode ser usado isoladamente.
  if (!i.deferred && !i.replied) await i.deferReply({ flags: EFEMERO });
}

function responder(i, content) {
  return responderPrivado(i, { content, allowedMentions: mencoesSeguras });
}

function textoNome(valor) {
  return String(valor || 'Item').replace(/[\r\n\t]+/g, ' ').slice(0, 60)
    .replace(/([\\`*_~|<>])/g, '\\$1');
}

// Os identificadores não são truncados. Protocolos excepcionais que não cabem
// no campo do Discord não são exibidos parcialmente nem aceitos pelo comando.
function identificador(valor) {
  const texto = String(valor ?? '');
  if (!texto || texto.length > 1000 || /[\r\n\x00-\x1f\x7f]/.test(texto)) return null;
  return texto.replace(/([\\`])/g, '\\$1');
}

function detalheRecompensa(tipo, valor) {
  if (valor == null || valor === '') return 'Valor indisponível; confira o cadastro.';
  const detalhe = textoNome(valor);
  if (tipo === 'pix') return /^\d+(?:\.\d{1,2})?$/.test(String(valor))
    ? `Valor PIX: R$ ${detalhe}` : 'Valor PIX indisponível; confira o cadastro.';
  if (tipo === 'role') return `ID do cargo: ${detalhe}`;
  return `Recompensa: ${detalhe}`;
}

function linhaLoja(row) {
  if (!row) return 'Nenhuma compra nesta página.';
  const id = identificador(row.id);
  const usuario = identificador(row.user_id);
  const item = Array.isArray(row.royal_shop_items) ? row.royal_shop_items[0] : row.royal_shop_items;
  if (!id || !usuario) return 'Registro com identificador incompatível com esta tela; consulte a administração por outro meio.';
  return `• ${textoNome(item?.name)} (${item?.reward_type})\n  ${detalheRecompensa(item?.reward_type, item?.reward_value)}\n  Protocolo: \`${id}\` · user_id: \`${usuario}\``;
}

function linhaRoleta(row) {
  if (!row) return 'Nenhuma entrega nesta página.';
  const id = identificador(row.request_id);
  const usuario = identificador(row.user_id);
  if (!id || !usuario) return 'Registro com identificador incompatível com esta tela; consulte a administração por outro meio.';
  return `• ${row.reward_type}\n  ${detalheRecompensa(row.reward_type, row.reward_value)}\n  Protocolo: \`${id}\` · user_id: \`${usuario}\``;
}

function lancarErro(resposta) {
  if (resposta.error) throw resposta.error;
  return resposta.data;
}

async function pendentes(i, cliente) {
  const pagina = i.options.getInteger('pagina') ?? 1;
  if (!Number.isInteger(pagina) || pagina < 1 || pagina > 1000000) {
    return responder(i, 'Página inválida. Informe um número entre 1 e 1000000.');
  }
  const posicao = pagina - 1;
  const guild = String(i.guildId);
  const [compras, entregas] = await Promise.all([
    cliente.from('royal_purchases')
      .select('id,user_id,royal_shop_items!inner(name,reward_type,reward_value)')
      .eq('guild_id', guild).eq('status', 'pending')
      .eq('royal_shop_items.guild_id', guild).in('royal_shop_items.reward_type', TIPOS_LOJA)
      .order('created_at', { ascending: true }).order('id', { ascending: true })
      .range(posicao, posicao),
    cliente.from('royal_reward_deliveries').select('request_id,user_id,reward_type,reward_value')
      .eq('guild_id', guild).eq('status', 'pending').in('reward_type', TIPOS_ROLETA)
      .order('created_at', { ascending: true }).order('request_id', { ascending: true })
      .range(posicao, posicao),
  ]);
  const loja = lancarErro(compras) || [];
  const roleta = lancarErro(entregas) || [];
  let texto = `**Resgates pendentes · página ${pagina}**\n` +
    `**Loja**\n${linhaLoja(loja[0])}\n\n**Roleta**\n${linhaRoleta(roleta[0])}\n\n` +
    'Até 1 registro por origem por página; use /resgates pendentes pagina:<número> para navegar. ' +
    'A ordem pode mudar após conclusões; volte à página 1.\n\n' + AVISO;
  // Em dados legados anormalmente grandes, nunca dividir ou truncar um protocolo.
  if (texto.length > 2000) {
    texto = `Página ${pagina}: registro(s) excedem o limite de exibição; consulte a administração por outro meio.\n\n${AVISO}`;
  }
  return responder(i, texto);
}

function tabela(tipo) {
  return tipo === 'loja' ? 'royal_purchases' : 'royal_reward_deliveries';
}

async function buscarRegistro(cliente, guild, tipo, protocolo) {
  if (tipo === 'loja') {
    return lancarErro(await cliente.from(tabela(tipo))
      .select('id,user_id,item_id,status,royal_shop_items!inner(name,reward_type)')
      .eq('guild_id', guild).eq('id', protocolo).eq('royal_shop_items.guild_id', guild)
      .in('royal_shop_items.reward_type', TIPOS_LOJA).limit(1).maybeSingle());
  }
  return lancarErro(await cliente.from(tabela(tipo)).select('request_id,user_id,reward_type,status')
    .eq('guild_id', guild).eq('request_id', protocolo).in('reward_type', TIPOS_ROLETA)
    .limit(1).maybeSingle());
}

function colunaAusente(erro) {
  // Apenas um erro explícito de coluna ausente prova que o primeiro UPDATE não ocorreu.
  return ['PGRST204', '42703'].includes(String(erro?.code || '')) &&
    /\bdelivered_at\b/i.test(String(erro?.message || ''));
}

async function atualizar(cliente, guild, tipo, protocolo, registro, comData) {
  const valores = { status: 'delivered' };
  if (comData) valores.delivered_at = new Date().toISOString();
  let consulta = cliente.from(tabela(tipo)).update(valores)
    .eq('guild_id', guild).eq(tipo === 'loja' ? 'id' : 'request_id', protocolo)
    .eq('user_id', registro.user_id).eq('status', 'pending');
  if (tipo === 'loja') consulta = consulta.eq('item_id', registro.item_id);
  else consulta = consulta.in('reward_type', TIPOS_ROLETA);
  return consulta.select(tipo === 'loja' ? 'id,user_id,status' : 'request_id,user_id,status')
    .maybeSingle();
}

async function concluir(i, cliente) {
  const tipo = i.options.getString('tipo');
  const protocolo = i.options.getString('protocolo');
  if (!['loja', 'roleta'].includes(tipo) || typeof protocolo !== 'string' ||
      !protocolo.trim() || protocolo.length > 1000 || /[\r\n\x00-\x1f\x7f]/.test(protocolo) ||
      (tipo === 'loja' && !UUID.test(protocolo))) {
    return responder(i, 'Informe o tipo e o protocolo completo: UUID para loja ou request_id completo para roleta. Não informe dados financeiros.');
  }
  const guild = String(i.guildId);
  let registro = await buscarRegistro(cliente, guild, tipo, protocolo);
  if (!registro) return responder(i, `Resgate não encontrado ou não elegível neste servidor.\n\n${AVISO}`);
  if (registro.status === 'delivered') return responder(i, `Este resgate já consta como entregue. Não repita pagamento ou envio.\n\n${AVISO}`);
  if (registro.status !== 'pending') return responder(i, `Este resgate não está pendente; nenhuma conclusão foi feita.\n\n${AVISO}`);

  let resultado = await atualizar(cliente, guild, tipo, protocolo, registro, true);
  let semData = false;
  if (resultado.error && colunaAusente(resultado.error)) {
    semData = true;
    resultado = await atualizar(cliente, guild, tipo, protocolo, registro, false);
  }
  if (resultado.error) throw resultado.error;
  if (!resultado.data || resultado.data.status !== 'delivered') {
    // Atualização condicional perdeu uma corrida ou não encontrou a linha. Consulte
    // apenas a guild atual; nunca reporte sucesso com base em uma linha ausente.
    registro = await buscarRegistro(cliente, guild, tipo, protocolo);
    if (!registro) return responder(i, `Resgate não encontrado ou não elegível neste servidor.\n\n${AVISO}`);
    if (registro.status === 'delivered') return responder(i, `Este resgate já consta como entregue. Não repita pagamento ou envio.\n\n${AVISO}`);
    return responder(i, `Nenhuma conclusão foi confirmada: o resgate não pôde ser alterado. Confira o estado antes de tentar novamente.\n\n${AVISO}`);
  }

  // royal.auditar faz outra requisição e pode suprimir erros; não há garantia
  // transacional nem confirmação de auditoria pelo serviço atual.
  try {
    await royal.auditar({
      guildId: guild, actorId: String(i.user.id), action: 'reward.delivery.manual_marked',
      entityType: tipo === 'loja' ? 'purchase' : 'reward_delivery', entityId: protocolo,
      requestId: String(i.id), beforeData: { status: 'pending' }, afterData: { status: 'delivered' },
      detail: 'Registro de entrega marcado manualmente; pagamento ou envio não processado pelo comando.',
    });
  } catch {
    console.error('[resgates] não foi possível solicitar a auditoria da alteração.');
  }
  const avisoTipo = tipo === 'loja'
    ? '\nO tipo do item é verificado separadamente e pode mudar se a configuração for alterada ao mesmo tempo.' : '';
  return responder(i, `Status registrado como entregue; o comando não verifica se o pagamento ou envio ocorreu.${semData ? ' A coluna delivered_at está indisponível; o horário não foi registrado.' : ''}\n\n${AVISO}\n\n${AVISO_AUDITORIA}${avisoTipo}`);
}

const comando = {
  data: new SlashCommandBuilder().setName('resgates')
    .setDescription('Central administrativa privada de resgates')
    .setDMPermission(false)
    .addSubcommand((s) => s.setName('pendentes').setDescription('Lista pendências deste servidor')
      .addIntegerOption((o) => o.setName('pagina').setDescription('Página da lista; um registro por origem')
        .setMinValue(1).setMaxValue(1000000)))
    .addSubcommand((s) => s.setName('concluir').setDescription('Registra entrega após atendimento manual')
      .addStringOption((o) => o.setName('tipo').setDescription('Origem do resgate').setRequired(true)
        .addChoices({ name: 'Loja', value: 'loja' }, { name: 'Roleta', value: 'roleta' }))
      .addStringOption((o) => o.setName('protocolo').setDescription('UUID da loja ou request_id completo da roleta; sem dados financeiros')
        .setRequired(true).setMaxLength(1000))),
  async executar(i) {
    await adiarPrivado(i);
    if (!i.guildId || !i.user?.id || !i.id) return responder(i, 'Use este comando em um servidor válido.');
    if (!(await exigirAdmin(i, 'Somente administradores podem gerenciar resgates.'))) return;
    const sub = i.options.getSubcommand();
    if (!['pendentes', 'concluir'].includes(sub)) return responder(i, 'Subcomando inválido.');
    try {
      const cliente = supabase.obterCliente();
      return sub === 'pendentes' ? await pendentes(i, cliente) : await concluir(i, cliente);
    } catch {
      // Um erro de transporte após UPDATE pode ter resultado indeterminado.
      console.error('[resgates] falha ao consultar ou atualizar um resgate.');
      return responder(i, sub === 'concluir'
        ? `Não foi possível confirmar o estado. Confira o registro antes de tentar novamente; não repita pagamento ou envio. A auditoria e a atualização são separadas e podem divergir.\n\n${AVISO}`
        : 'Não foi possível consultar as pendências agora. Tente novamente mais tarde.');
    }
  },
};

module.exports = { comandos: [comando] };
