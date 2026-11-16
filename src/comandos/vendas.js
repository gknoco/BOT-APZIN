'use strict';

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  RoleSelectMenuBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  PermissionFlagsBits,
} = require('discord.js');
const config = require('../config');
const vendasDb = require('../servicos/roomSalesSupabase');
const { ehAdmin, responderPrivado, responderErro } = require('../util/seguranca');
const { embed, embedSucesso, reais, mencaoCargo } = require('../util/embeds');

const PRECO_SALA_CENTAVOS = 3;
const TEMPO_EXPIRACAO_PAINEL_MS = 30 * 60 * 1000;
const PACOTES_SALAS = [1, 5, 10, 20, 50, 100].map((quantidade) => ({
  quantidade,
  totalCentavos: quantidade * PRECO_SALA_CENTAVOS,
}));
const MAX_CARGOS_COMPRA = 10;

function embedPainelCompra() {
  return embed(
    '⚡ ROYAL SALA · Central de créditos',
    [
      'Créditos para criar salas automatizadas de Free Fire pela Nix FF, com liberação após confirmação segura do pagamento.',
      '',
      '**INVESTIMENTO**  ·  R$ 0,03 por sala',
      '**PAGAMENTO**  ·  Pix processado pelo Mercado Pago',
      '**CRÉDITOS**  ·  entram automaticamente após aprovação',
      '**USO**  ·  cada crédito libera uma criação de sala Nix',
      '',
      'Use **Adquirir Sala** para escolher a quantidade ou **Ver pacotes de salas** para comparar as opções disponíveis.',
    ].join('\n'),
    { cor: config.CORES.ouro, rodape: 'ORG ROYAL AP  ·  Seguro · Automático · Persistido no Supabase' },
  );
}

function componentesPainelCompra() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('ap:comprar').setLabel('Adquirir Sala').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('ap:verpacotes').setLabel('Ver pacotes de salas').setStyle(ButtonStyle.Primary),
    ),
  ];
}

function embedPacotes() {
  const linhas = PACOTES_SALAS.map((pacote) =>
    `🛒 **${pacote.quantidade} ${pacote.quantidade === 1 ? 'sala' : 'salas'}** — \`${reais(pacote.totalCentavos)}\``,
  ).join('\n');
  return embed('Pacotes de salas', linhas, {
    cor: config.CORES.principal,
  });
}

function embedMeuPainel(dados = {}) {
  const operacoesPendentes = Array.isArray(dados.pending_usages) ? dados.pending_usages : [];
  const pendentes = operacoesPendentes.length;
  const listaPendentes = operacoesPendentes.slice(0, 5)
    .map((item) => `• \`${item.request_id}\` — ${item.status}`).join('\n');
  const descricao = 'Seu saldo e seu histórico pessoal de créditos neste servidor.' +
    (pendentes ? `\n\n**Operações pendentes** (não tente novamente até confirmar):\n${listaPendentes}` : '');
  return embed('Seu painel | ROYAL SALA', descricao, {
    cor: config.CORES.ouro,
    campos: [
      { name: 'SALAS DISPONÍVEIS', value: `**${Number(dados.available_rooms || 0)}**`, inline: true },
      { name: 'SALAS ADQUIRIDAS', value: `**${Number(dados.purchased_rooms_total || 0)}**`, inline: true },
      { name: 'EM RESERVA', value: `**${Number(dados.reserved_rooms || 0)}**`, inline: true },
      { name: 'CRIADAS HOJE', value: `**${Number(dados.created_today || 0)}**`, inline: true },
      { name: 'CRIADAS NO TOTAL', value: `**${Number(dados.created_total || 0)}**`, inline: true },
      { name: 'COMPRAS APROVADAS', value: `**${Number(dados.approved_purchase_count || 0)}**`, inline: true },
    ],
    rodape: pendentes
      ? `${pendentes} operação(ões) pendente(s) · consulte a administração antes de tentar novamente · Supabase`
      : 'Dados pessoais consultados em tempo real no Supabase',
  });
}

function agendarExclusaoPainel(mensagem, agendar = setTimeout, atraso = TEMPO_EXPIRACAO_PAINEL_MS) {
  const timer = agendar(() => {
    Promise.resolve(mensagem?.delete?.()).catch((erro) => {
      if (Number(erro?.code) !== 10008) console.warn('[vendas] não consegui apagar painel temporário:', erro.message);
    });
  }, atraso);
  timer?.unref?.();
  return timer;
}

function componentesPacotes() {
  return [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('ap:compraspacote')
        .setPlaceholder('Escolha seu pacote de salas...')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(PACOTES_SALAS.map(({ quantidade, totalCentavos }) => ({
          label: `🛒 ${quantidade} ${quantidade === 1 ? 'sala' : 'salas'} - ${reais(totalCentavos)}`,
          value: String(quantidade),
        }))),
    ),
  ];
}

function embedPainelPermissoes(settings = {}) {
  const roles = Array.isArray(settings.allowed_role_ids) ? settings.allowed_role_ids.map(String) : [];
  const canal = settings.panel_channel_id ? `<#${settings.panel_channel_id}>` : '`não definido`';
  const textoRoles = roles.length ? roles.map(mencaoCargo).join(', ') : '`nenhum cargo autorizado`';
  return {
    embeds: [embed('Configurações de compra | ROYAL SALA', 'Gerencie o acesso à Central de Compras. As alterações são gravadas no Supabase.', {
      cor: config.CORES.principal,
      campos: [
        { name: 'CARGOS AUTORIZADOS', value: textoRoles, inline: false },
        { name: 'CANAL REGISTRADO', value: canal, inline: false },
      ],
      rodape: 'Apenas DEV_OWNER_ID pode alterar os cargos · /painelcomprar publica no canal atual',
    })],
    components: [
      new ActionRowBuilder().addComponents(
        new RoleSelectMenuBuilder()
          .setCustomId('ap:comprascargos')
          .setPlaceholder('Cargos de Administrador/Mediador autorizados…')
          .setMinValues(0)
          .setMaxValues(MAX_CARGOS_COMPRA),
      ),
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ap:compraslimparcargos').setLabel('Remover todos os cargos autorizados').setStyle(ButtonStyle.Danger),
      ),
    ],
  };
}

async function ehDonoConfigurado(interaction) {
  if (!config.DEV_OWNER_ID) {
    await responderErro(interaction, 'DEV_OWNER_ID ainda não foi definido nas variáveis de ambiente do Railway.');
    return false;
  }
  if (String(interaction.user.id) !== String(config.DEV_OWNER_ID)) {
    await responderErro(interaction, 'Somente o dono configurado em DEV_OWNER_ID pode usar esta ferramenta.');
    return false;
  }
  return true;
}

async function ehCargoCompra(interaction) {
  if (!interaction.guildId) return false;
  const settings = await vendasDb.obterConfiguracao(interaction.guildId);
  const permitidos = Array.isArray(settings.allowed_role_ids) ? settings.allowed_role_ids.map(String) : [];
  const cache = interaction.member?.roles?.cache;
  return permitidos.length > 0 && Boolean(cache?.has) && permitidos.some((id) => cache.has(id));
}

async function exigirCargoCompra(interaction) {
  if (await ehCargoCompra(interaction)) return true;
  await responderErro(interaction, 'Seu cargo não está autorizado para comprar salas. Peça ao dono do bot para configurar /permicompras com os cargos administrativos/mediadores corretos.');
  return false;
}

const comandos = [
  {
    data: new SlashCommandBuilder().setName('painelcomprar').setDescription('Publica e fixa o painel ROYAL SALA neste canal'),
    async executar(interaction) {
      if (!interaction.guildId) return responderErro(interaction, 'Use /painelcomprar dentro do servidor.');
      const autorizado = String(interaction.user.id) === String(config.DEV_OWNER_ID) ||
        (interaction.guild?.ownerId && String(interaction.user.id) === String(interaction.guild.ownerId)) ||
        config.CARGOS_SUPER_ADMIN_IDS.some((id) => interaction.member?.roles?.cache?.has?.(id));
      if (!autorizado) return responderErro(interaction, 'Só cargos administrativos superiores podem publicar o painel de vendas.');
      const canal = interaction.channel;
      if (!canal?.send || String(canal.guildId) !== String(interaction.guildId)) return responderErro(interaction, 'Use /painelcomprar em um canal de texto deste servidor onde o bot possa enviar mensagens.');
      const settings = await vendasDb.obterConfiguracao(interaction.guildId);
      const mensagem = await canal.send({ embeds: [embedPainelCompra()], components: componentesPainelCompra(), allowedMentions: { parse: [] } });
      let fixado = false;
      try {
        if (typeof mensagem.pin === 'function') {
          await mensagem.pin();
          fixado = true;
        }
      } catch (erro) {
        console.warn('[vendas] painel público enviado, mas não foi possível fixá-lo:', erro.message);
      }
      try {
        await vendasDb.salvarConfiguracao({
          guildId: interaction.guildId,
          roleIds: Array.isArray(settings.allowed_role_ids) ? settings.allowed_role_ids : [],
          channelId: canal.id,
          actorId: interaction.user.id,
        });
      } catch (erro) {
        console.error('[vendas] painel enviado, mas não foi possível salvar o canal no Supabase:', erro.message);
        return responderErro(interaction, `O painel foi publicado em <#${canal.id}>, mas não consegui salvar a configuração no Supabase. Confira o acesso ao banco antes de publicar outro painel.`);
      }
      const statusFixado = fixado ? 'publicado e fixado' : 'publicado, mas não foi possível fixá-lo (confira a permissão Gerenciar Mensagens do bot)';
      return responderPrivado(interaction, { embeds: [embedSucesso(`Painel ${statusFixado} em <#${canal.id}>. Canal registrado com sucesso no Supabase. A mensagem é pública e permanente.`)] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('comprar').setDescription('Abre em privado o painel ROYAL SALA por 30 minutos'),
    async executar(interaction) {
      if (!interaction.guildId) return responderErro(interaction, 'Use /comprar dentro do servidor.');
      if (!(await exigirCargoCompra(interaction))) return;
      const mensagem = await interaction.editReply({ embeds: [embedPainelCompra()], components: componentesPainelCompra(), allowedMentions: { parse: [] } });
      agendarExclusaoPainel({ delete: () => interaction.deleteReply() });
      return mensagem;
    },
  },
  {
    data: new SlashCommandBuilder().setName('setcargo').setDescription('Atribui um cargo a todos os membros, inclusive bots')
      .addRoleOption((opcao) => opcao.setName('cargo').setDescription('Cargo que será atribuído a todos').setRequired(true)),
    async executar(interaction) {
      const ehDono = interaction.guild?.ownerId && String(interaction.user.id) === String(interaction.guild.ownerId);
      if (!ehDono && !interaction.memberPermissions?.has?.(PermissionFlagsBits.Administrator)) {
        return responderErro(interaction, 'Somente o dono do servidor ou um Administrador pode usar /setcargo.');
      }
      const cargo = interaction.options.getRole('cargo');
      if (!cargo || String(cargo.guild.id) !== String(interaction.guildId)) return responderErro(interaction, 'Selecione um cargo válido deste servidor.');
      const posicaoBot = interaction.guild.members.me?.roles?.highest?.position;
      if (cargo.managed || !Number.isFinite(posicaoBot) || cargo.position >= posicaoBot) return responderErro(interaction, 'O bot não pode atribuir esse cargo: verifique se não é gerenciado e se está abaixo do cargo mais alto do bot.');
      const membros = await interaction.guild.members.fetch();
      let atribuidos = 0;
      let jaPossuiam = 0;
      let falhas = 0;
      for (const membro of membros.values()) {
        if (membro.roles.cache.has(cargo.id)) { jaPossuiam += 1; continue; }
        try { await membro.roles.add(cargo, 'Comando administrativo /setcargo'); atribuidos += 1; }
        catch { falhas += 1; }
      }
      return responderPrivado(interaction, { embeds: [embedSucesso(`**Cargo:** ${cargo}\n**Atribuído:** ${atribuidos}\n**Já possuíam:** ${jaPossuiam}\n**Falhas:** ${falhas}\n**Total verificado:** ${membros.size}`)] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('permicompras').setDescription('Configura os cargos autorizados para a Central de Compras'),
    async executar(interaction) {
      if (!interaction.guildId) return responderErro(interaction, 'Use /permicompras dentro do servidor.');
      if (!(await ehDonoConfigurado(interaction))) return;
      const settings = await vendasDb.obterConfiguracao(interaction.guildId);
      return responderPrivado(interaction, embedPainelPermissoes(settings));
    },
  },
  {
    data: new SlashCommandBuilder().setName('cupomcompras').setDescription('Cria ou desativa cupons da Central ROYAL SALA')
      .addSubcommand((sub) => sub.setName('criar').setDescription('Cria/atualiza um cupom percentual')
        .addStringOption((o) => o.setName('codigo').setDescription('Código de 3 a 32 letras/números').setRequired(true).setMaxLength(32))
        .addIntegerOption((o) => o.setName('desconto').setDescription('Percentual (1 a 99%)').setRequired(true).setMinValue(1).setMaxValue(99)))
      .addSubcommand((sub) => sub.setName('desativar').setDescription('Desativa um cupom existente')
        .addStringOption((o) => o.setName('codigo').setDescription('Código do cupom').setRequired(true).setMaxLength(32))),
    async executar(interaction) {
      if (!interaction.guildId) return responderErro(interaction, 'Use /cupomcompras dentro do servidor.');
      if (!(await ehDonoConfigurado(interaction))) return;
      const sub = interaction.options.getSubcommand();
      const code = interaction.options.getString('codigo');
      if (sub === 'criar') {
        const percent = interaction.options.getInteger('desconto');
        const cupom = await vendasDb.salvarCupom({ guildId: interaction.guildId, code, discountPercent: percent, active: true, actorId: interaction.user.id });
        return responderPrivado(interaction, { embeds: [embedSucesso(`Cupom **${cupom.code}** salvo no Supabase e ativo com **${cupom.discount_percent}%** de desconto.`)] });
      }
      const cupom = await vendasDb.salvarCupom({ guildId: interaction.guildId, code, active: false, actorId: interaction.user.id });
      return responderPrivado(interaction, { embeds: [embedSucesso(`Cupom **${cupom.code}** desativado com sucesso no Supabase.`)] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('minhassalas').setDescription('Mostra saldo e histórico das salas da sua conta'),
    async executar(interaction) {
      if (!interaction.guildId) return responderErro(interaction, 'Use /minhassalas dentro do servidor.');
      const dados = await vendasDb.estatisticasSalas(interaction.guildId, interaction.user.id);
      return responderPrivado(interaction, { embeds: [embedMeuPainel(dados)] });
    },
  },
  {
    data: new SlashCommandBuilder().setName('salasreconciliar').setDescription('Concilia uma criação Nix cujo resultado ficou incerto')
      .addStringOption((o) => o.setName('codigo').setDescription('Código da operação mostrado em /minhassalas').setRequired(true).setMaxLength(128))
      .addStringOption((o) => o.setName('resultado').setDescription('Resultado confirmado na API Nix').setRequired(true)
        .addChoices({ name: 'A sala foi criada (consumir 1 crédito)', value: 'created' }, { name: 'A sala não foi criada (devolver reserva)', value: 'failed' }))
      .addStringOption((o) => o.setName('id_sala').setDescription('ID da sala criada, se houver').setMaxLength(64))
      .addStringOption((o) => o.setName('sessao').setDescription('session_id retornado pela Nix, se houver').setMaxLength(64))
      .addStringOption((o) => o.setName('observacao').setDescription('Motivo/registro da conciliação').setMaxLength(300)),
    async executar(interaction) {
      if (!interaction.guildId) return responderErro(interaction, 'Use /salasreconciliar dentro do servidor.');
      const dono = config.DEV_OWNER_ID && String(interaction.user.id) === String(config.DEV_OWNER_ID);
      if (!dono && !ehAdmin(interaction.member)) return responderErro(interaction, 'Somente o dono do bot ou um Administrador pode reconciliar créditos.');
      const resultado = interaction.options.getString('resultado');
      const registro = await vendasDb.reconciliarUso({
        requestId: interaction.options.getString('codigo'),
        outcome: resultado,
        actorId: interaction.user.id,
        roomId: interaction.options.getString('id_sala'),
        sessionId: interaction.options.getString('sessao'),
        note: interaction.options.getString('observacao'),
      });
      return responderPrivado(interaction, { embeds: [embedSucesso(`Operação conciliada e registrada no Supabase como **${registro.status}**. ${resultado === 'created' ? 'Um crédito foi consumido.' : 'A reserva foi devolvida.'}`)] });
    },
  },
];

module.exports = {
  PRECO_SALA_CENTAVOS,
  TEMPO_EXPIRACAO_PAINEL_MS,
  PACOTES_SALAS,
  MAX_CARGOS_COMPRA,
  embedPainelCompra,
  componentesPainelCompra,
  embedPacotes,
  embedMeuPainel,
  componentesPacotes,
  agendarExclusaoPainel,
  embedPainelPermissoes,
  ehDonoConfigurado,
  ehCargoCompra,
  exigirCargoCompra,
  comandos,
};
