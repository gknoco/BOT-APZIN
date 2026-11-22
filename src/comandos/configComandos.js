'use strict';

const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  PermissionFlagsBits, RoleSelectMenuBuilder, SlashCommandBuilder, StringSelectMenuBuilder,
} = require('discord.js');
const { ehAdmin, responderErro, responderPrivado } = require('../util/seguranca');
const permissoes = require('../servicos/permissoesComandos');

const PREFIXO = 'cmdperm:';
const POR_PAGINA = 25;

function todosComandos() {
  return require('./index').comandos;
}

function nomeAmigavel(comando) {
  const nome = String(comando.data.name || '');
  const opcoes = comando.data.toJSON().options || [];
  const subcomandos = opcoes.filter((opcao) => opcao.type === 1 || opcao.type === 2).map((opcao) => opcao.name);
  return subcomandos.length ? `/${nome} · ${subcomandos.join(', ')}` : `/${nome}`;
}

function menuInicial(userId) {
  return {
    embeds: [new EmbedBuilder().setColor(0x6d5dfc).setTitle('🔐 Permissões de comandos por cargo')
      .setDescription('Escolha um cargo para visualizar e gerenciar os comandos permitidos.\n\nSem cargos vinculados, o comando continua sujeito apenas às permissões nativas do Discord. Administradores sempre podem executar os comandos.')],
    components: [new ActionRowBuilder().addComponents(
      new RoleSelectMenuBuilder().setCustomId(`${PREFIXO}${userId}:role`).setPlaceholder('Selecione um cargo para configurar…').setMinValues(1).setMaxValues(1),
    )],
    allowedMentions: { parse: [] },
  };
}

function idControle(userId, roleId, page, action) {
  return `${PREFIXO}${userId}:${roleId}:${page}:${action}`;
}

async function painelCargo(interaction, ctx, roleId, page = 0) {
  const client = ctx?.db?.client || ctx?.supabase;
  const comandos = todosComandos();
  const totalPaginas = Math.max(1, Math.ceil(comandos.length / POR_PAGINA));
  const pagina = Math.min(Math.max(Number(page) || 0, 0), totalPaginas - 1);
  const items = comandos.slice(pagina * POR_PAGINA, (pagina + 1) * POR_PAGINA);
  const permitidos = new Set(await permissoes.regrasPorCargo(interaction.guildId, roleId, client));
  const role = interaction.guild?.roles?.cache?.get?.(roleId) || await interaction.guild?.roles?.fetch?.(roleId).catch(() => null);
  const linhas = [...permitidos].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const resumo = linhas.length ? linhas.map((nome) => `• /${nome}`).join('\n').slice(0, 3500) : '_Nenhuma restrição configurada para este cargo._';
  const embed = new EmbedBuilder().setColor(0x6d5dfc).setTitle(`🔐 Acesso de comandos · ${role?.name || `<@&${roleId}>`}`)
    .setDescription(`**Comandos atualmente restritos a este cargo:**\n${resumo}\n\nMarque no menu abaixo todos os comandos que este cargo poderá executar. Os itens pré-selecionados já estão permitidos.\n**Página ${pagina + 1}/${totalPaginas}** · ${comandos.length} comandos no catálogo.`)
    .setFooter({ text: 'Sem regra = acesso conforme permissões nativas do Discord. Administradores têm acesso irrestrito.' });
  const select = new StringSelectMenuBuilder().setCustomId(idControle(interaction.user.id, roleId, pagina, 'commands'))
    .setPlaceholder('Comandos permitidos nesta página…').setMinValues(0).setMaxValues(Math.max(1, items.length));
  if (!items.length) select.addOptions({ label: 'Nenhum comando registrado', value: '_none', description: 'O catálogo está vazio.' });
  else select.addOptions(items.map((item) => ({
    label: nomeAmigavel(item).slice(0, 100),
    value: String(item.data.name),
    description: (item.data.description || 'Comando do bot').slice(0, 100),
    default: permitidos.has(String(item.data.name)),
  })));
  const controles = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(idControle(interaction.user.id, roleId, Math.max(0, pagina - 1), 'prev')).setLabel('← Anterior').setStyle(ButtonStyle.Secondary).setDisabled(pagina === 0),
    new ButtonBuilder().setCustomId(idControle(interaction.user.id, roleId, Math.min(totalPaginas - 1, pagina + 1), 'next')).setLabel('Próxima →').setStyle(ButtonStyle.Secondary).setDisabled(pagina >= totalPaginas - 1),
    new ButtonBuilder().setCustomId(idControle(interaction.user.id, roleId, pagina, 'clear')).setLabel('Limpar restrições do cargo').setStyle(ButtonStyle.Danger).setDisabled(permitidos.size === 0),
  );
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select), controles], allowedMentions: { parse: [] } };
}

const comando = {
  data: new SlashCommandBuilder().setName('configcomandos').setDescription('Gerencia permissões de comandos por cargo')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator).setDMPermission(false),
  async executar(interaction) {
    if (!interaction.guildId || !ehAdmin(interaction.member)) return responderErro(interaction, 'Somente administradores deste servidor podem configurar permissões de comandos.');
    return responderPrivado(interaction, menuInicial(interaction.user.id));
  },
};

async function handleComponent(interaction, ctx) {
  if (!String(interaction.customId || '').startsWith(PREFIXO)) return false;
  const partes = interaction.customId.slice(PREFIXO.length).split(':');
  try {
    if (!interaction.guildId || partes[0] !== String(interaction.user.id) || !ehAdmin(interaction.member)) {
      await responderErro(interaction, 'Este painel é privado e só pode ser usado pelo administrador que o abriu.');
      return true;
    }
    if (interaction.isRoleSelectMenu?.() && partes.length === 2 && partes[1] === 'role') {
      await interaction.deferUpdate();
      const roleId = String(interaction.values?.[0] || '');
      const role = interaction.guild?.roles?.cache?.get?.(roleId) || await interaction.guild?.roles?.fetch?.(roleId).catch(() => null);
      if (!role || role.id === interaction.guildId || role.managed) {
        await responderErro(interaction, 'Selecione um cargo válido e gerenciável deste servidor.');
        return true;
      }
      await interaction.editReply(await painelCargo(interaction, ctx, roleId));
      return true;
    }
    if (partes.length !== 4 || !/^\d{15,20}$/.test(partes[1]) || !/^\d+$/.test(partes[2])) {
      await responderErro(interaction, 'Este painel expirou. Execute /configcomandos novamente.');
      return true;
    }
    const roleId = partes[1];
    const page = Number(partes[2]);
    const action = partes[3];
    if (interaction.isButton?.()) {
      await interaction.deferUpdate();
      if (action === 'clear') await permissoes.limparCargo(interaction.guildId, roleId, ctx?.db?.client || ctx?.supabase);
      if (!['clear', 'prev', 'next'].includes(action)) throw new Error('Ação inválida.');
      await interaction.editReply(await painelCargo(interaction, ctx, roleId, page));
      if (action === 'clear') await responderPrivado(interaction, { content: '✅ Todas as restrições deste cargo foram removidas no Supabase.' });
      return true;
    }
    if (interaction.isStringSelectMenu?.() && action === 'commands') {
      await interaction.deferUpdate();
      const comandos = todosComandos();
      const itens = comandos.slice(page * POR_PAGINA, (page + 1) * POR_PAGINA);
      const selecionados = (interaction.values || []).map(String).filter((nome) => itens.some((item) => item.data.name === nome));
      await permissoes.salvarPagina({
        guildId: interaction.guildId, roleId,
        commandNames: itens.map((item) => item.data.name), allowedNames: selecionados,
        client: ctx?.db?.client || ctx?.supabase,
      });
      await interaction.editReply(await painelCargo(interaction, ctx, roleId, page));
      await responderPrivado(interaction, { content: '✅ Permissões atualizadas e salvas no Supabase.' });
      return true;
    }
    await responderErro(interaction, 'Tipo de controle inválido. Execute /configcomandos novamente.');
    return true;
  } catch (erro) {
    console.error('[configcomandos] falha no painel:', erro.message);
    await responderPrivado(interaction, { content: '❌ Não foi possível salvar/carregar as permissões. Verifique a conexão com o Supabase e tente novamente.' }).catch(() => {});
    return true;
  }
}

module.exports = { comando, handleComponent, menuInicial, painelCargo, POR_PAGINA, PREFIXO };
