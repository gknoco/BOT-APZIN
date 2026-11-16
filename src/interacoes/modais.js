'use strict';

/** Modais: regra da partida e ID/senha da sala. */

const {
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  ActivityType,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const config = require('../config');
const partidas = require('../servicos/partidas');
const staffSupabase = require('../servicos/staffSupabase');
const mediadores = require('../servicos/mediadores');
const fluxo = require('../servicos/fluxo');
const comprasSalas = require('../servicos/comprasSalas');
const vendasUI = require('../comandos/vendas');
const { EFEMERO, responderPrivado, responderErro, ehMediador, ehAdmin } = require('../util/seguranca');
const { embed, embedSucesso, reais, dataBR } = require('../util/embeds');

async function abrirModalRegras(interaction, db, partidaId) {
  const partida = await partidas.buscar(db, partidaId);
  if (!partida) return responderErro(interaction, 'Sala não encontrada.');
  const jogadores = await partidas.jogadores(db, partidaId);
  if (!jogadores.some((linha) => linha.user_id === interaction.user.id)) {
    return responderErro(interaction, 'Só quem está jogando essa sala pode enviar a regra.');
  }

  const modal = new ModalBuilder()
    .setCustomId(`ap:modalregras:${partidaId}`)
    .setTitle('Regra da partida')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('regra')
          .setLabel('Escreva a regra combinada')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('Ex: 1x1 mobile, sem emulador, gelo infinito, 3 quedas, quem fizer mais pontos vence.')
          .setMinLength(5)
          .setMaxLength(config.LIMITES.REGRAS)
          .setRequired(true),
      ),
    );

  return interaction.showModal(modal);
}

async function abrirModalSala(interaction, db, partidaId) {
  if (!ehMediador(interaction.member)) {
    return responderErro(interaction, 'Só o mediador pode liberar a criação da sala.');
  }
  const partida = await partidas.buscar(db, partidaId);
  if (!partida) return responderErro(interaction, 'Sala não encontrada.');

  const modal = new ModalBuilder()
    .setCustomId(`ap:modalsala:${partidaId}`)
    .setTitle('Liberar sala')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('sala_id')
          .setLabel('ID da sala')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Ex: 12345678')
          .setMaxLength(40)
          .setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('sala_senha')
          .setLabel('Senha da sala (se tiver)')
          .setStyle(TextInputStyle.Short)
          .setMaxLength(40)
          .setRequired(false),
      ),
    );

  return interaction.showModal(modal);
}

/** Campos do painel /botperfil: o modal é montado a partir daqui. */
const CAMPOS_BOT = {
  nome: {
    id: 'modalbotnome',
    titulo: 'Nome do bot',
    label: 'Novo nome (2 a 32 caracteres)',
    placeholder: 'ORG Royal AP',
    min: 2,
    max: 32,
  },
  avatar: {
    id: 'modalbotavatar',
    titulo: 'Avatar do bot',
    label: 'Link direto da imagem (png, jpg ou gif)',
    placeholder: 'https://exemplo.com/foto.png',
    min: 10,
    max: 400,
  },
  descricao: {
    id: 'modalbotdescricao',
    titulo: 'Descrição do bot',
    label: 'Sobre mim / descrição (até 400 caracteres)',
    placeholder: 'A ORG Royal AP de filas e apostas de Free Fire.',
    style: TextInputStyle.Paragraph,
    min: 0,
    max: 400,
    required: false,
  },
  status: {
    id: 'modalbotstatus',
    titulo: 'Status do bot',
    label: 'Texto do status (até 128 caracteres)',
    placeholder: 'AP da ORG Royal AP',
    min: 1,
    max: 128,
  },
};

const CAMPO_POR_ID = new Map(Object.entries(CAMPOS_BOT).map(([campo, info]) => [info.id, campo]));

/** Abre o modal de um campo do perfil do bot (só ADM). */
async function abrirModalBotPerfil(interaction, campo) {
  const info = CAMPOS_BOT[String(campo)];
  if (!info) return responderErro(interaction, 'Opção inválida do painel do bot.');
  if (!ehAdmin(interaction.member)) return responderErro(interaction, 'Só ADMs podem mudar o perfil do bot.');

  const entrada = new TextInputBuilder()
    .setCustomId('valor')
    .setLabel(info.label)
    .setStyle(info.style ?? TextInputStyle.Short)
    .setMaxLength(info.max)
    .setRequired(info.required ?? true)
    .setPlaceholder(info.placeholder);
  if (info.min > 0) entrada.setMinLength(info.min);

  return interaction.showModal(
    new ModalBuilder()
      .setCustomId(`ap:${info.id}`)
      .setTitle(info.titulo)
      .addComponents(new ActionRowBuilder().addComponents(entrada)),
  );
}

/** Aplica o que o ADM escreveu no modal direto no perfil do bot. */
async function aplicarPerfilBot(interaction, client, tipo) {
  const campo = CAMPO_POR_ID.get(String(tipo));
  if (!campo) return false;
  if (!ehAdmin(interaction.member)) {
    await responderErro(interaction, 'Só ADMs podem mudar o perfil do bot.');
    return true;
  }
  if (!client?.user) {
    await responderErro(interaction, 'Sem conexão com o Discord agora. Tente de novo em instantes.');
    return true;
  }

  const valor = String(interaction.fields.getTextInputValue('valor') || '').trim();

  try {
    if (campo === 'nome') {
      if (valor.length < 2 || valor.length > 32) throw new Error('O nome precisa ter entre 2 e 32 caracteres.');
      await client.user.setUsername(valor);
      await responderPrivado(interaction, { embeds: [embedSucesso(`Nome do bot agora é **${valor}**.`)] });
      return true;
    }

    if (campo === 'avatar') {
      if (!/^https?:\/\/\S+$/i.test(valor)) throw new Error('Manda um link http(s) direto da imagem (png/jpg/gif).');
      await client.user.setAvatar(valor);
      await responderPrivado(interaction, { embeds: [embedSucesso('Avatar do bot atualizado.')] });
      return true;
    }

    if (campo === 'descricao') {
      if (typeof client.application?.edit !== 'function') {
        throw new Error('A API não liberou a descrição para este bot. Use o Developer Portal.');
      }
      await client.application.edit({ description: valor || null });
      await responderPrivado(interaction, { embeds: [embedSucesso('Descrição (sobre mim) do bot atualizada.')] });
      return true;
    }

    client.user.setPresence({ activities: [{ name: valor, type: ActivityType.Custom }], status: 'online' });
    await responderPrivado(interaction, { embeds: [embedSucesso(`Status do bot: **${valor}**.`)] });
    return true;
  } catch (erro) {
    console.error(`[modais] perfil do bot (${campo}):`, erro.message);
    await responderErro(interaction, erro.message);
    return true;
  }
}

/**
 * Modal do PIX individual do mediador (chave, nome completo e cidade).
 *
 * CUIDADO: o Discord limita label/título a 45 caracteres (o erro aparece como
 * "Invalid string length"). Por isso os textos abaixo são curtos e os limites
 * de cada campo ficam bem abaixo do máximo permitido (4000).
 */
async function abrirModalPix(interaction) {
  try {
    const modal = new ModalBuilder()
      .setCustomId('ap:modalpix')
      .setTitle('Registrar PIX de mediador')
      .addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('chave')
            .setLabel('Chave PIX (CPF, e-mail, telefone, aleat.)')
            .setStyle(TextInputStyle.Short)
            .setMinLength(3)
            .setMaxLength(200)
            .setRequired(true),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('titular')
            .setLabel('Nome completo do titular')
            .setStyle(TextInputStyle.Short)
            .setMinLength(3)
            .setMaxLength(120)
            .setRequired(true),
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder()
            .setCustomId('cidade')
            .setLabel('Cidade de registro da conta')
            .setStyle(TextInputStyle.Short)
            .setMinLength(2)
            .setMaxLength(80)
            .setRequired(true),
        ),
      );

    return await interaction.showModal(modal);
  } catch (erro) {
    console.error('[modais] não consegui abrir o cadastro PIX:', erro.message);
    return responderErro(interaction, 'Não consegui abrir o cadastro PIX agora. Tente de novo em instantes.');
  }
}

/** Modal de compra; pacotes fixos preenchem a quantidade no customId. */
async function abrirModalCompra(interaction, quantidadeFixa = null) {
  const quantidade = Number(quantidadeFixa);
  const fixo = Number.isInteger(quantidade) && quantidade >= 1 && quantidade <= 100;
  const modal = new ModalBuilder()
    .setCustomId(`ap:modalcompra:${fixo ? quantidade : 'custom'}`)
    .setTitle(fixo ? `Pacote de ${quantidade} ${quantidade === 1 ? 'sala' : 'salas'}` : 'Adquirir Salas');
  const campos = [];
  if (!fixo) {
    campos.push(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('quantidade')
        .setLabel('Quantidade de salas (R$ 0,03 cada)')
        .setStyle(TextInputStyle.Short)
        .setMinLength(1)
        .setMaxLength(4)
        .setPlaceholder('Ex: 5')
        .setRequired(false),
    ));
  }
  campos.push(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('cupom')
        .setLabel('Cupom de desconto (opcional)')
        .setStyle(TextInputStyle.Short)
        .setMaxLength(32)
        .setRequired(false),
    ),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('email')
        .setLabel('E-mail do pagador (exigido pelo Mercado Pago)')
        .setStyle(TextInputStyle.Short)
        .setMinLength(5)
        .setMaxLength(254)
        .setPlaceholder('voce@exemplo.com')
        .setRequired(true),
    ),
  );
  modal.addComponents(...campos);
  return interaction.showModal(modal);
}

async function aplicarCompraSalas(interaction, partes) {
  if (!interaction.guildId) {
    await responderErro(interaction, 'O sistema de compra funciona somente dentro do servidor.');
    return true;
  }
  if (!(await vendasUI.exigirCargoCompra(interaction))) return true;
  const quantidadeFixa = String(partes[2] || 'custom');
  const quantidade = quantidadeFixa === 'custom'
    ? Number(String(interaction.fields.getTextInputValue('quantidade') || '').trim())
    : Number(quantidadeFixa);
  if (!Number.isInteger(quantidade) || quantidade < 1) {
    await responderErro(interaction, 'O preenchimento da quantidade de salas é obrigatório e precisa ser um número inteiro maior que zero.');
    return true;
  }
  const email = String(interaction.fields.getTextInputValue('email') || '').trim();
  const cupom = String(interaction.fields.getTextInputValue('cupom') || '').trim();
  if (!comprasSalas.validarEmailPix(email)) {
    await responderPrivado(interaction, { content: comprasSalas.MENSAGEM_EMAIL_INVALIDO });
    return true;
  }

  const { order, payment } = await comprasSalas.criarPedidoPix({
    guildId: interaction.guildId,
    userId: interaction.user.id,
    requestId: interaction.id,
    quantity: quantidade,
    couponCode: cupom,
    payerEmail: email,
  });

  if (order.status === 'approved') {
    return responderPrivado(interaction, { content: comprasSalas.textoPagamentoAprovado(order.rooms_quantity) });
  }

  const expiracao = payment.expiresAt || order.expires_at || new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const expiracaoTexto = dataBR(Date.parse(expiracao));
  const detalheCupom = Number(order.discount_cents) > 0 ? `**Desconto aplicado:** ${reais(order.discount_cents)}` : null;
  const card = embed(
    'PIX GERADO',
    [
      `**Pacote selecionado:** ${Number(order.rooms_quantity || quantidade)} ${Number(order.rooms_quantity || quantidade) === 1 ? 'sala' : 'salas'}`,
      `**Valor exato:** ${reais(order.amount_cents)}`,
      detalheCupom,
      `**Expiração:** ${expiracaoTexto}`,
      '',
      'O saldo é liberado automaticamente assim que o Mercado Pago aprovar o pagamento.',
      `**Pedido:** \`${order.id}\``,
    ].filter(Boolean).join('\n'),
    { cor: config.CORES.ouro, rodape: 'ROYAL SALA · Pix Mercado Pago' },
  );
  const arquivos = [];
  const base64 = String(payment.qrBase64 || '').replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
  if (base64 && base64.length <= 6 * 1024 * 1024 && /^[A-Za-z0-9+/=]+$/.test(base64)) {
    const imagem = Buffer.from(base64, 'base64');
    if (imagem.length > 0 && imagem.length <= 4 * 1024 * 1024) {
      card.setImage('attachment://royal-sala-qr.png');
      arquivos.push(new AttachmentBuilder(imagem, { name: 'royal-sala-qr.png' }));
    }
  }
  if (!arquivos.length) throw new Error('O Mercado Pago não retornou a imagem do QR Code. O pedido ficou registrado; não gere outro Pix e procure a administração.');

  const botoes = [new ButtonBuilder()
    .setCustomId(`ap:copiarpix:${order.id}`)
    .setLabel('Copia e Cola')
    .setEmoji('📋')
    .setStyle(ButtonStyle.Secondary)];
  return responderPrivado(interaction, {
    embeds: [card],
    files: arquivos,
    components: [new ActionRowBuilder().addComponents(...botoes)],
  });
}

async function aplicarPix(interaction, db) {
  if (!(await staffSupabase.temCargoMediador(interaction.guildId, interaction.member))) {
    await responderErro(interaction, 'Só mediadores/ADM registram PIX de recebimento.');
    return true;
  }

  try {
    // Normaliza e limita cada campo antes de gravar (nada de string gigante).
    const limpar = (valor, max) =>
      String(valor ?? '')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, max);
    const chave = limpar(interaction.fields.getTextInputValue('chave'), 200);
    const titular = limpar(interaction.fields.getTextInputValue('titular'), 120);
    const cidade = limpar(interaction.fields.getTextInputValue('cidade'), 80);
    if (chave.length < 3) throw new Error('A chave PIX precisa ter pelo menos 3 caracteres.');
    if (titular.length < 3) throw new Error('Informe o nome completo do titular do PIX.');
    if (cidade.length < 2) throw new Error('Informe a cidade de registro da conta.');

    const registro = await staffSupabase.registrarPix({
      guildId: interaction.guildId,
      userId: interaction.user.id,
      chave,
      titular,
      cidade,
    });

    await responderPrivado(interaction, {
      embeds: [
        embedSucesso(
          `PIX salvo! ✅\n**Chave:** \`${registro.pix_chave}\`\n**Titular:** ${registro.pix_titular || '—'}\n` +
            `**Cidade:** ${registro.pix_cidade || '—'}\n\n_Ao assumir uma sala, é essa chave que vai para os jogadores._`,
        ),
      ],
    });
  } catch (erro) {
    await responderErro(interaction, erro.message);
  }
  return true;
}

async function handleModal(interaction, { db, client }) {
  const partes = String(interaction.customId || '').split(':');
  if (partes[0] !== 'ap') return false;

  const tipo = partes[1];
  const partidaId = partes[2];
  const reconhecido = String(tipo || '').startsWith('modalbot') ||
    ['modalpix', 'modalregras', 'modalsala', 'modalcompra'].includes(tipo);
  if (!reconhecido) return false;

  // E-mail inválido é rejeitado localmente antes do defer e de qualquer
  // autorização/consulta remota ou criação de cobrança. O serviço repete a
  // mesma validação para proteger também chamadas fora deste handler.
  if (tipo === 'modalcompra') {
    const email = String(interaction.fields.getTextInputValue('email') || '').trim();
    if (!comprasSalas.validarEmailPix(email)) {
      await responderPrivado(interaction, { content: comprasSalas.MENSAGEM_EMAIL_INVALIDO });
      return true;
    }
  }

  // Submit de modal é uma interação nova. Confirmar imediatamente e depois
  // editar a resposta deferida após as validações/gravações remotas.
  if (!interaction.deferred && !interaction.replied) {
    try {
      await interaction.deferReply({ flags: EFEMERO });
    } catch (erro) {
      const jaReconhecida = Number(erro?.code) === 40060 || erro?.name === 'InteractionAlreadyReplied';
      if (!jaReconhecida) {
        console.error(`[modais] deferReply falhou em ${interaction.customId}:`, erro.message);
        return true;
      }
    }
  }

  try {
    // Modais do /botperfil (nome, avatar, descrição e status do bot).
    if (String(tipo || '').startsWith('modalbot')) return await aplicarPerfilBot(interaction, client, tipo);
    if (tipo === 'modalpix') return await aplicarPix(interaction, db);
    if (tipo === 'modalcompra') return await aplicarCompraSalas(interaction, partes);

    if (tipo === 'modalregras') {
      const texto = interaction.fields.getTextInputValue('regra');
      await partidas.definirRegras(db, partidaId, texto, interaction.user.id);
      await fluxo.atualizarPartida(client, db, partidaId);
      await responderPrivado(interaction, {
        embeds: [embedSucesso('Regra registrada na sala! Agora todos clicam em **Confirmar Partida**.')],
      });
      return true;
    }

    if (tipo === 'modalsala') {
      if (!ehMediador(interaction.member)) {
        await responderErro(interaction, 'Só o mediador pode liberar a sala.');
        return true;
      }
      const salaId = interaction.fields.getTextInputValue('sala_id');
      const senha = interaction.fields.getTextInputValue('sala_senha');
      await partidas.liberarSala(db, partidaId, { salaId, senha });
      await fluxo.atualizarPartida(client, db, partidaId);
      await responderPrivado(interaction, {
        embeds: [embedSucesso(`Sala liberada para os jogadores: ID \`${salaId}\`${senha ? ` · Senha \`${senha}\`` : ''}.`)],
      });
      return true;
    }

    return false;
  } catch (erro) {
    console.error(`[modais] erro em ${interaction.customId}:`, erro);
    await responderErro(interaction, erro.message || 'Deu um erro aqui. Tente de novo.');
    return true;
  }
}

module.exports = {
  abrirModalRegras,
  abrirModalSala,
  abrirModalBotPerfil,
  abrirModalPix,
  abrirModalCompra,
  CAMPOS_BOT,
  handleModal,
};
