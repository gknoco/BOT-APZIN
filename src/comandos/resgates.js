'use strict';

// Central administrativa: não realiza pagamentos, envios ou concessões de cargo.
const { SlashCommandBuilder } = require('discord.js');
const supabase = require('../servicos/supabase');
const claims = require('../servicos/rescueClaim');
const { EFEMERO, exigirAdmin, responderPrivado } = require('../util/seguranca');

const TIPOS_LOJA = ['role', 'pix', 'physical'];
const TIPOS_ROLETA = ['role', 'pix'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AVISO = 'Marque somente após o pagamento, envio ou concessão do cargo ter sido feito manualmente. Este comando não processa pagamentos nem realiza envios ou concede cargos.';
const AVISO_RESERVA = 'Antes de qualquer atendimento, use /resgates iniciar. A reserva não expira. Em caso de dúvida ou falha, não repita o pagamento, envio ou concessão; reconcilie com a administração.';
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

function linhaLoja(row, reserva) {
  if (!row) return 'Nenhuma compra nesta página.';
  const id = identificador(row.id);
  const usuario = identificador(row.user_id);
  const item = row.terms_snapshot || {};
  const legado = row.snapshot_source === 'legacy_current' ? ' · termos legados aproximados' : '';
  if (!id || !usuario) return 'Registro com identificador incompatível com esta tela; consulte a administração por outro meio.';
  return `• ${textoNome(item?.name)} (${item?.reward_type})${legado}\n  ${detalheRecompensa(item?.reward_type, item?.reward_value)}\n  Protocolo: \`${id}\` · user_id: \`${usuario}\`\n  ${reserva}`;
}

function linhaRoleta(row, reserva) {
  if (!row) return 'Nenhuma entrega nesta página.';
  const id = identificador(row.request_id);
  const usuario = identificador(row.user_id);
  if (!id || !usuario) return 'Registro com identificador incompatível com esta tela; consulte a administração por outro meio.';
  return `• ${row.reward_type}\n  ${detalheRecompensa(row.reward_type, row.reward_value)}\n  Protocolo: \`${id}\` · user_id: \`${usuario}\`\n  ${reserva}`;
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
      .select('id,user_id,terms_snapshot,snapshot_source,royal_shop_items!inner(guild_id)')
      .eq('guild_id', guild).eq('status', 'pending').eq('royal_shop_items.guild_id', guild)
      .in('terms_snapshot->>reward_type', TIPOS_LOJA)
      .order('created_at', { ascending: true }).order('id', { ascending: true })
      .range(posicao, posicao),
    cliente.from('royal_reward_deliveries').select('request_id,user_id,reward_type,reward_value')
      .eq('guild_id', guild).eq('status', 'pending').in('reward_type', TIPOS_ROLETA)
      .order('created_at', { ascending: true }).order('request_id', { ascending: true })
      .range(posicao, posicao),
  ]);
  const loja = lancarErro(compras) || [];
  const roleta = lancarErro(entregas) || [];
  const [claimLoja, claimRoleta] = await Promise.all([consultarReserva(cliente, guild, 'loja', loja[0]?.id), consultarReserva(cliente, guild, 'roleta', roleta[0]?.request_id)]);
  let texto = `**Resgates pendentes · página ${pagina}**\n` +
    `**Loja**\n${linhaLoja(loja[0], claimLoja)}\n\n**Roleta**\n${linhaRoleta(roleta[0], claimRoleta)}\n\n` +
    'Até 1 registro por origem por página; use /resgates pendentes pagina:<número> para navegar. ' +
    'A ordem pode mudar após conclusões; volte à página 1.\n\n' + AVISO_RESERVA + '\n\n' + AVISO;
  // Em dados legados anormalmente grandes, nunca dividir ou truncar um protocolo.
  if (texto.length > 2000) {
    texto = `Página ${pagina}: registro(s) excedem o limite de exibição; consulte a administração por outro meio.\n\n${AVISO_RESERVA}\n\n${AVISO}`;
  }
  return responder(i, texto);
}

async function consultarReserva(cliente, guild, tipo, protocolo) {
  if (!protocolo) return '';
  const row = lancarErro(await cliente.from('royal_rescue_claims').select('state,owner_id,claimed_at')
    .eq('guild_id', guild).eq('source', tipo).eq('protocol', protocolo).limit(1).maybeSingle());
  if (!row) return 'Sem reserva registrada; verifique o histórico antes de atender.';
  if (row.state === 'review') return 'Revisão obrigatória; não atender até reconciliação.';
  const dono = identificador(row.owner_id);
  return dono ? `Reserva: \`${dono}\` (${row.state === 'completed' ? 'concluída' : 'em atendimento'}).`
    : 'Reserva incompatível; requer revisão.';
}

async function alterar(i, cliente, action) {
  const tipo = i.options.getString('tipo');
  let protocolo = i.options.getString('protocolo');
  if (!['loja', 'roleta'].includes(tipo) || typeof protocolo !== 'string' ||
      !protocolo.trim() || protocolo.length > 1000 || /[\r\n\x00-\x1f\x7f]/.test(protocolo) ||
      (tipo === 'loja' && !UUID.test(protocolo))) {
    return responder(i, 'Informe o tipo e o protocolo completo: UUID para loja ou request_id completo para roleta. Não informe dados financeiros.');
  }
  if (tipo === 'loja') protocolo = protocolo.toLowerCase();
  const resultado = await claims.acao({ cliente, action, guildId: i.guildId, tipo, protocolo,
    actorId: i.user.id, requestId: i.id });
  switch (resultado.result) {
    case 'acquired':
      return responder(i, `Reserva obtida por você. Confira histórico e dados antes de iniciar; a reserva não prova que a entrega externa ainda não ocorreu.\n\n${AVISO_RESERVA}`);
    case 'already_owned':
      return responder(i, `Você já detém esta reserva. Uma retentativa não autoriza repetir pagamento, envio ou concessão: confira o estado externo antes de agir.\n\n${AVISO_RESERVA}`);
    case 'owned': {
      const dono = identificador(resultado.owner_id) || 'identidade indisponível';
      return responder(i, `Reserva pertence a \`${dono}\`; não inicie nem processe este protocolo.\n\n${AVISO_RESERVA}`);
    }
    case 'review':
      return responder(i, `Resgate em revisão obrigatória (inclusive legado); não atenda até reconciliação administrativa.\n\n${AVISO_RESERVA}`);
    case 'delivered': return responder(i, `Este resgate já consta como entregue. Não repita pagamento ou envio.\n\n${AVISO}`);
    case 'not_pending': return responder(i, `Este resgate não está pendente; nenhuma alteração foi feita.\n\n${AVISO}`);
    case 'not_found': return responder(i, `Resgate não encontrado ou não elegível neste servidor.\n\n${AVISO}`);
    case 'unclaimed': return responder(i, `Sem reserva: use /resgates iniciar antes de atender ou concluir.\n\n${AVISO_RESERVA}`);
    case 'changed': return responder(i, `Dados da pendência mudaram desde a reserva. Não prossiga; solicite reconciliação.\n\n${AVISO_RESERVA}`);
    case 'finished': return responder(i, `Status registrado como entregue e auditoria gravada na mesma transação; o comando não verifica a entrega externa.\n\n${AVISO}`);
    default: throw new Error('Resultado desconhecido da reserva');
  }

}

const comando = {
  data: new SlashCommandBuilder().setName('resgates')
    .setDescription('Central administrativa privada de resgates')
    .setDMPermission(false)
    .addSubcommand((s) => s.setName('pendentes').setDescription('Lista pendências deste servidor')
      .addIntegerOption((o) => o.setName('pagina').setDescription('Página da lista; um registro por origem')
        .setMinValue(1).setMaxValue(1000000)))
    .addSubcommand((s) => s.setName('iniciar').setDescription('Reserva o atendimento antes de processar')
      .addStringOption((o) => o.setName('tipo').setDescription('Origem do resgate').setRequired(true)
        .addChoices({ name: 'Loja', value: 'loja' }, { name: 'Roleta', value: 'roleta' }))
      .addStringOption((o) => o.setName('protocolo').setDescription('UUID da loja ou request_id completo da roleta; sem dados financeiros')
        .setRequired(true).setMaxLength(1000)))
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
    if (!['pendentes', 'iniciar', 'concluir'].includes(sub)) return responder(i, 'Subcomando inválido.');
    try {
      const cliente = supabase.obterCliente();
      return sub === 'pendentes' ? await pendentes(i, cliente) : await alterar(i, cliente, sub === 'iniciar' ? 'claim' : 'finish');
    } catch {
      // Um erro de transporte pode ter ocorrido depois do commit.
      console.error('[resgates] falha ao consultar ou atualizar um resgate.');
      return responder(i, sub === 'pendentes'
        ? 'Não foi possível consultar as pendências agora. Tente novamente mais tarde.'
        : `Não foi possível confirmar a reserva ou conclusão. Não inicie nem repita pagamento, envio ou concessão; confira o registro e reconcilie antes de agir.\n\n${AVISO_RESERVA}`);
    }
  },
};

module.exports = { comandos: [comando] };
