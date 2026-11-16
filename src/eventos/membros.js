'use strict';

/** Mensagens de entrada e saída nos canais configurados por servidor. */

const { EmbedBuilder, Events } = require('discord.js');
const persistenciaSupabase = require('../servicos/supabase');

const CARGO_AUTO_ROLE_ID = '1543684013968064614';

const COR_ESCURO = 0x2b2d31;
const avisosCanalDesconhecido = new Set();

function avisarFalhaCanal(chave, erro, operacao) {
  if (Number(erro?.code) === 10003 || erro?.name === 'UnknownChannel') {
    if (avisosCanalDesconhecido.has(chave)) return;
    avisosCanalDesconhecido.add(chave);
    console.warn(`[membros] canal configurado não existe (${operacao}); ajuste em /configcanal1 ou /configcanal2.`);
    return;
  }
  console.error(`[membros] ${operacao}: ${erro.message}`);
}

function urlAvatar(member) {
  return member.user.displayAvatarURL({ dynamic: true, size: 256 });
}

function embedEntrada(member) {
  const criado = Math.floor(member.user.createdTimestamp / 1000);
  return new EmbedBuilder()
    .setColor(COR_ESCURO)
    .setTitle('👋 Novo Jogador')
    .setDescription(
      `<@${member.id}> • \`${member.user.username}\`\n\n` +
        `**Conta criada:** <t:${criado}:R>\n` +
        `**Jogadores agora:** ${member.guild.memberCount}`,
    )
    .setThumbnail(urlAvatar(member));
}

function embedSaida(member) {
  const criado = Math.floor(member.user.createdTimestamp / 1000);
  return new EmbedBuilder()
    .setColor(COR_ESCURO)
    .setTitle('👋 Jogador saiu')
    .setDescription(
      `<@${member.id}> • ${member.user.username}\n` +
        `**Conta criada:** <t:${criado}:R>\n` +
        `**Jogadores agora:** ${member.guild.memberCount}`,
    )
    .setThumbnail(urlAvatar(member));
}

async function publicar(member, chave, montarEmbed, clienteSupabase) {
  let canalId;
  try {
    canalId = await persistenciaSupabase.obterConfig(member.guild.id, chave, clienteSupabase);
  } catch (erro) {
    console.error(`[membros] não consegui ler ${chave} no Supabase: ${erro.message}`);
    return null;
  }
  if (!canalId) return null;

  let canal;
  try {
    canal = await member.guild.channels.fetch(canalId);
  } catch (erro) {
    avisarFalhaCanal(`${member.guild.id}:${canalId}`, erro, 'falha ao buscar canal');
    return null;
  }
  if (!canal?.isTextBased?.() || typeof canal.send !== 'function') return null;

  try {
    return await canal.send({
      embeds: [montarEmbed(member)],
      allowedMentions: { parse: [], users: [member.id] },
    });
  } catch (erro) {
    avisarFalhaCanal(`${member.guild.id}:${canalId}`, erro, 'falha ao enviar mensagem');
    return null;
  }
}

function registrar(client, db) {
  const enviar = async (member, chave, montarEmbed) => {
    try {
      await publicar(member, chave, montarEmbed, db?.client);
    } catch (erro) {
      console.error('[membros] falha no evento:', erro.message);
    }
  };
  client.on(Events.GuildMemberAdd, (member) => {
    void member.roles.add(CARGO_AUTO_ROLE_ID, 'Cargo automático para novos membros da ORG Royal AP').catch((erro) => {
      console.error(`[membros] não consegui atribuir o cargo automático a ${member.id}: ${erro.message}`);
    });
    void enviar(member, 'canal_boas_vindas', embedEntrada);
  });
  client.on(Events.GuildMemberRemove, (member) => {
    void enviar(member, 'canal_saida', embedSaida);
  });
}

module.exports = { registrar, publicar, embedEntrada, embedSaida, CARGO_AUTO_ROLE_ID };
