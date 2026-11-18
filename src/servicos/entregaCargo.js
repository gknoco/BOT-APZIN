'use strict';

const { PermissionFlagsBits } = require('discord.js');

const SNOWFLAKE = /^\d{15,20}$/;

async function entregarCargo({ guild, userId, roleId }) {
  const cargoId = String(roleId || '').trim();
  if (!SNOWFLAKE.test(cargoId)) throw new Error('ID do cargo inválido.');
  if (!guild) throw new Error('Servidor indisponível para entrega do cargo.');
  const bot = guild.members?.me || (await guild.members?.fetchMe?.());
  if (!bot?.permissions?.has?.(PermissionFlagsBits.ManageRoles)) {
    throw new Error('O bot não possui a permissão Gerenciar Cargos.');
  }
  const role = guild.roles?.cache?.get(cargoId) || await guild.roles?.fetch?.(cargoId);
  if (!role || role.managed) throw new Error('Cargo inexistente ou gerenciado por integração.');
  if (role.position >= bot.roles.highest.position || role.editable === false) {
    throw new Error('O cargo está acima ou no mesmo nível do cargo do bot.');
  }
  const membro = guild.members?.cache?.get(String(userId)) || await guild.members?.fetch?.(String(userId));
  if (!membro?.roles?.add) throw new Error('Membro indisponível para entrega do cargo.');
  if (!membro.roles.cache?.has?.(cargoId)) await membro.roles.add(role, 'Recompensa automática da Roleta/Lojinha');
  return { roleId: cargoId, userId: String(userId), alreadyHad: membro.roles.cache?.has?.(cargoId) || false };
}

module.exports = { entregarCargo };
