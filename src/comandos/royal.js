'use strict';

const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const config = require('../config');
const royal = require('../servicos/royalSupabase');
const rescueClaim = require('../servicos/rescueClaim');
const { responder, responderPrivado, responderErro } = require('../util/seguranca');
const { embed, embedSucesso, numeroBR } = require('../util/embeds');

function precisaSupabase() {
  if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('O sistema persistente ainda não está configurado. Defina o Supabase na hospedagem.');
  }
}

async function entregarCargo(interaction, roleId) {
  if (!roleId || !interaction.member?.roles?.add) {
    throw new Error('Não foi possível localizar o cargo ou membro para entrega.');
  }
  await interaction.member.roles.add(String(roleId));
}

async function auditarEntregaPendente({ guildId, userId, requestId, tipo, valor, erro }) {
  await royal.auditar({
    guildId,
    actorId: userId,
    action: 'reward.delivery.pending',
    entityType: tipo,
    entityId: requestId,
    requestId,
    detail: `Entrega pendente (${valor}): ${String(erro?.message || 'falha Discord').slice(0, 300)}`,
  });
}

const comandos = [
  {
    data: new SlashCommandBuilder()
      .setName('roleta')
      .setDescription('Roleta persistente da ORG Royal AP')
      .addSubcommand((sub) => sub.setName('girar').setDescription('Gira a roleta usando um giro disponível'))
      .addSubcommand((sub) => sub.setName('painel').setDescription('Mostra o painel da roleta')),

    async executar(interaction) {
      precisaSupabase();
      const sub = interaction.options.getSubcommand();
      if (sub === 'painel') {
        return responder(interaction, {
          embeds: [
            embed(
              '🎰 Roleta Royal AP',
              'Use **/roleta girar** para sortear um prêmio. O giro, o resultado e os prêmios são registrados no Supabase.',
              { cor: config.CORES.principal },
            ),
          ],
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId('ap:roletagirar')
                .setLabel('Girar roleta')
                .setEmoji('🎰')
                .setStyle(ButtonStyle.Primary),
            ),
          ],
        });
      }

      const resultado = await royal.girar({
        guildId: interaction.guildId,
        userId: interaction.user.id,
        request: interaction.id,
      });
      if (!resultado) throw new Error('A roleta não retornou um resultado. Confira os prêmios ativos no Supabase.');

      let entrega = 'O giro foi debitado e o prêmio foi registrado com segurança.';
      if (resultado.reward_type === 'role') {
        try {
          await rescueClaim.entregaAutomatica({ guildId: interaction.guildId, tipo: 'roleta',
            protocolo: `spin:${interaction.id}`, interactionId: interaction.id, userId: interaction.user.id,
            roleId: resultado.reward_value, entregar: () => entregarCargo(interaction, resultado.reward_value),
          });
          entrega = 'O cargo foi concedido e a entrega foi marcada no Supabase.';
        } catch (erro) {
          await auditarEntregaPendente({
            guildId: interaction.guildId,
            userId: interaction.user.id,
            requestId: resultado.spin_id,
            tipo: 'roulette_spin',
            valor: resultado.reward_value,
            erro,
          });
          entrega = 'O prêmio foi registrado, mas a entrega do cargo requer revisão; não repita sem reconciliar.';
        }
      }

      await royal.auditar({
        guildId: interaction.guildId,
        actorId: interaction.user.id,
        action: 'roulette.spin',
        entityType: 'roulette_spin',
        entityId: resultado.spin_id,
        requestId: interaction.id,
        detail: resultado.prize_name,
      });
      return responderPrivado(interaction, {
        embeds: [
          embedSucesso(
            `🎰 Você ganhou **${resultado.prize_name}**!\n` +
              `Recompensa: **${resultado.reward_type} · ${resultado.reward_value}**\n\n${entrega}`,
          ),
        ],
      });
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('lojinha')
      .setDescription('Lojinha persistente da ORG Royal AP')
      .addSubcommand((sub) => sub.setName('listar').setDescription('Lista os produtos disponíveis'))
      .addSubcommand((sub) =>
        sub
          .setName('comprar')
          .setDescription('Compra um produto pelo ID')
          .addStringOption((opcao) => opcao.setName('item').setDescription('ID do produto').setRequired(true)),
      ),

    // Mantém exportação histórica sem reintroduzir a compra sem intenção.
    async executar(interaction) {
      return require('./lojinhaPro').comando.executar(interaction);
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('inventario')
      .setDescription('Mostra seus itens resgatados'),

    async executar(interaction) {
      precisaSupabase();
      const itens = await royal.inventario(interaction.guildId, interaction.user.id);
      const corpo = itens.length
        ? itens
            .map(
              (item) =>
                `**${item.royal_shop_items?.name || 'Item'}** ×${item.quantity}\n` +
                `${item.royal_shop_items?.description || ''}`,
            )
            .join('\n\n')
        : 'Seu inventário está vazio.';
      return responderPrivado(interaction, {
        embeds: [embed('🎒 Meu inventário', corpo, { cor: config.CORES.principal })],
      });
    },
  },
];

module.exports = { comandos };
