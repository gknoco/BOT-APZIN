'use strict';

/** Catálogo operacional. A criação do schema é feita pelas migrações SQL, nunca no runtime. */
const TABELAS = Object.freeze({
  configuracoes: 'discord_configuracoes',
  filas: 'royal_filas',
  partidas: 'royal_partidas',
  partida_jogadores: 'royal_partida_jogadores',
  partida_go: 'royal_partida_go',
  blacklist: 'royal_blacklist',
  auditoria: 'royal_audit_events',
  auditoria_legada: 'royal_auditoria_legada',
  paineis: 'royal_paineis',
  mensagens_painel: 'royal_mensagens_painel',
  plantao: 'royal_plantao',
  logs_dm: 'royal_logs_dm',
  telagem_links: 'royal_telagem_links',
  telagens: 'royal_telagens',
  transacoes: 'royal_transacoes',
  usuarios: 'royal_profiles',
  staff: 'royal_pix_keys',
  convites: 'royal_invites',
  cotas_mediadores: 'royal_mediator_room_quotas',
  versiculos_usados: 'discord_versiculos_usados',
});
const TABELAS_OPERACIONAIS = Object.freeze(Object.values(TABELAS).filter((nome) =>
  !['royal_profiles', 'royal_pix_keys', 'royal_invites', 'discord_versiculos_usados', 'discord_configuracoes'].includes(nome)));

module.exports = { TABELAS, TABELAS_OPERACIONAIS };
