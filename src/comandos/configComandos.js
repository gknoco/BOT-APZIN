'use strict';

const { randomUUID } = require('node:crypto');
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  PermissionFlagsBits, RoleSelectMenuBuilder, SlashCommandBuilder, StringSelectMenuBuilder,
} = require('discord.js');
const { ehAdmin, responderErro, responderPrivado } = require('../util/seguranca');
const permissoes = require('../servicos/permissoesComandos');

const PREFIXO = 'cmdperm:';
const POR_PAGINA = 25;
const MAX_CARGOS = 25;
const sessoes = new Map();

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
      .setDescription('Escolha um ou mais cargos para visualizar e gerenciar os comandos permitidos. As alterações, paginação e limpeza serão aplicadas a todos os cargos selecionados.\n\nSem cargos vinculados, o comando continua sujeito apenas às permissões nativas do Discord. Administradores sempre podem executar os comandos.')],
    components: [new ActionRowBuilder().addComponents(
      new RoleSelectMenuBuilder().setCustomId(`${PREFIXO}${userId}:role`).setPlaceholder('Selecione até 25 cargos para configurar…').setMinValues(1).setMaxValues(MAX_CARGOS),
    )],
    allowedMentions: { parse: [] },
  };
}

function idControle(userId, token, page, action) {
  return `${PREFIXO}${userId}:${token}:${page}:${action}`;
}

async function painelCargo(interaction, ctx, roleIds, page = 0, token) {
  const client = ctx?.db?.client || ctx?.supabase;
  const comandos = todosComandos();
  const totalPaginas = Math.max(1, Math.ceil(comandos.length / POR_PAGINA));
  const pagina = Math.min(Math.max(Number(page) || 0, 0), totalPaginas - 1);
  const items = comandos.slice(pagina * POR_PAGINA, (pagina + 1) * POR_PAGINA);
  const regras = await Promise.all(roleIds.map((roleId) => permissoes.regrasPorCargo(interaction.guildId, roleId, client)));
  const permitidos = new Set(regras.flat());
  const roles = await Promise.all(roleIds.map(async (roleId) => {
    const cached = interaction.guild?.roles?.cache?.get?.(roleId);
    if (cached) return cached;
    try { return await interaction.guild?.roles?.fetch?.(roleId) || null; } catch { return null; }
  }));
  const mencoes = roleIds.map((roleId, index) => `${roles[index]?.name || `<@&${roleId}>`}`).join(', ');
  const linhas = [...permitidos].sort((a, b) => a.localeCompare(b, 'pt-BR'));
  const resumo = linhas.length ? linhas.map((nome) => `•  /${nome}`).join('\n').slice(0, 3500) : '_Nenhuma restrição configurada para os cargos selecionados._';
  const embed = new EmbedBuilder().setColor(0x6d5dfc).setTitle(`🔐 Acesso de comandos · ${roleIds.length} cargo(s)`)
    .setDescription(`**Cargos selecionados:** ${mencoes}\n\n**Comandos atualmente permitidos por pelo menos um cargo selecionado:**\n${resumo}\n\nMarque no menu abaixo os comandos que serão permitidos para todos os cargos selecionados. Os itens pré-selecionados já estão permitidos para pelo menos um deles.\n**Página ${pagina + 1}/${totalPaginas}** · ${comandos.length} comandos no catálogo.`)
    .setFooter({ text: 'Sem regra = acesso conforme permissões nativas do Discord. Administradores têm acesso irrestrito.' });
  const select = new StringSelectMenuBuilder().setCustomId(idControle(interaction.user.id, token, pagina, 'commands'))
    .setPlaceholder('Comandos permitidos nesta página…').setMinValues(0).setMaxValues(Math.max(1, items.length));
  if (!items.length) select.addOptions({ label: 'Nenhum comando registrado', value: '_none', description: 'O catálogo está vazio.' });
  else select.addOptions(items.map((item) => ({
    label: nomeAmigavel(item).slice(0, 100),
    value: String(item.data.name),
    description: (item.data.description || 'Comando do bot').slice(0, 100),
    default: permitidos.has(String(item.data.name)),
  })));
  const controles = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(idControle(interaction.user.id, token, Math.max(0, pagina - 1), 'prev')).setLabel('← Anterior').setStyle(ButtonStyle.Secondary).setDisabled(pagina === 0),
    new ButtonBuilder().setCustomId(idControle(interaction.user.id, token, Math.min(totalPaginas - 1, pagina + 1), 'next')).setLabel('Próxima →').setStyle(ButtonStyle.Secondary).setDisabled(pagina >= totalPaginas - 1),
    new ButtonBuilder().setCustomId(idControle(interaction.user.id, token, pagina, 'clear')).setLabel('Limpar restrições do cargo').setStyle(ButtonStyle.Danger).setDisabled(permitidos.size === 0),
    new ButtonBuilder().setCustomId(idControle(interaction.user.id, token, pagina, 'back')).setLabel('Voltar').setStyle(ButtonStyle.Secondary),
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
      const roleIds = [...new Set((interaction.values || []).map(String))];
      if (roleIds.length < 1 || roleIds.length > MAX_CARGOS) {
        await responderErro(interaction, `Selecione entre 1 e ${MAX_CARGOS} cargos.`);
        return true;
      }
      for (const roleId of roleIds) {
        const role = interaction.guild?.roles?.cache?.get?.(roleId) || await interaction.guild?.roles?.fetch?.(roleId).catch(() => null);
        if (!role || role.id === interaction.guildId || role.managed) {
          await responderErro(interaction, 'Selecione somente cargos válidos e gerenciáveis deste servidor.');
          return true;
        }
      }
      const token = randomUUID().replaceAll('-', '');
      sessoes.set(token, { ownerId: String(interaction.user.id), guildId: String(interaction.guildId), roleIds });
      await interaction.editReply(await painelCargo(interaction, ctx, roleIds, 0, token));
      return true;
    }
    if (partes.length !== 4 || !/^\d{15,20}$/.test(partes[0]) || !/^[a-f0-9]{32}$/.test(partes[1]) || !/^\d+$/.test(partes[2])) {
      await responderErro(interaction, 'Este painel expirou. Execute /configcomandos novamente.');
      return true;
    }
    const token = partes[1];
    const page = Number(partes[2]);
    const action = partes[3];
    const session = sessoes.get(token);
    if (!session || session.ownerId !== String(interaction.user.id) || session.guildId !== String(interaction.guildId)) {
      await responderErro(interaction, 'Este painel expirou. Execute /configcomandos novamente.');
      return true;
    }
    if (interaction.isButton?.()) {
      await interaction.deferUpdate();
      if (action === 'back') {
        sessoes.delete(token);
        await interaction.editReply(menuInicial(interaction.user.id));
        return true;
      }
      if (action === 'clear') {
        for (const roleId of session.roleIds) await permissoes.limparCargo(interaction.guildId, roleId, ctx?.db?.client || ctx?.supabase);
      }
      if (!['clear', 'prev', 'next'].includes(action)) throw new Error('Ação inválida.');
      await interaction.editReply(await painelCargo(interaction, ctx, session.roleIds, page, token));
      if (action === 'clear') await responderPrivado(interaction, { content: `✅ Todas as restrições foram removidas para ${session.roleIds.length} cargo(s) no Supabase.` });
      return true;
    }
    if (interaction.isStringSelectMenu?.() && action === 'commands') {
      await interaction.deferUpdate();
      const comandos = todosComandos();
      const itens = comandos.slice(page * POR_PAGINA, (page + 1) * POR_PAGINA);
      const selecionados = (interaction.values || []).map(String).filter((nome) => itens.some((item) => item.data.name === nome));
      for (const roleId of session.roleIds) {
        await permissoes.salvarPagina({
          guildId: interaction.guildId, roleId,
          commandNames: itens.map((item) => item.data.name), allowedNames: selecionados,
          client: ctx?.db?.client || ctx?.supabase,
        });
      }
      await interaction.editReply(await painelCargo(interaction, ctx, session.roleIds, page, token));
      await responderPrivado(interaction, { content: `✅ Permissões atualizadas e salvas no Supabase para ${session.roleIds.length} cargo(s).` });
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
