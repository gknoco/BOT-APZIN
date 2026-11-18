'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { PermissionFlagsBits } = require('discord.js');
const { entregarCargo } = require('../src/servicos/entregaCargo');

function guild({ permission = true, rolePosition = 1, botPosition = 5, managed = false } = {}) {
  const membro = { id: '123456789012345678', roles: { cache: new Map(), async add(role) { this.cache.set(role.id, true); } } };
  const role = { id: '987654321098765432', position: rolePosition, managed, editable: rolePosition < botPosition };
  return {
    members: { me: { permissions: { has: (p) => permission && p === PermissionFlagsBits.ManageRoles }, roles: { highest: { position: botPosition } } }, cache: new Map([[membro.id, membro]]), async fetch(id) { return id === membro.id ? membro : null; } },
    roles: { cache: new Map([[role.id, role]]), async fetch(id) { return id === role.id ? role : null; } },
  };
}

test('entrega automática exige Gerenciar Cargos', async () => {
  await assert.rejects(() => entregarCargo({ guild: guild({ permission: false }), userId: '123456789012345678', roleId: '987654321098765432' }), /Gerenciar Cargos/);
});

test('entrega automática rejeita cargo acima do bot', async () => {
  await assert.rejects(() => entregarCargo({ guild: guild({ rolePosition: 8, botPosition: 5 }), userId: '123456789012345678', roleId: '987654321098765432' }), /acima|mesmo nível/);
});

test('entrega automática adiciona cargo válido', async () => {
  const g = guild();
  const resultado = await entregarCargo({ guild: g, userId: '123456789012345678', roleId: '987654321098765432' });
  assert.equal(resultado.roleId, '987654321098765432');
});
