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
const recargas = require('../servicos/recargas');
const salaInfinita = require('../servicos/salaInfinita');
const vendasDb = require('../servicos/roomSalesSupabase');
const vendasUI = require('../comandos/vendas');
const paineis = require('../servicos/paineis');
const automacoes = require('../servicos/automacoesDiscord');
const { EFEMERO, responderPrivado, responderErro, ehMediador, ehAdmin } = require('../util/seguranca');
const { embed, embedSucesso, reais, dataBR } = require('../util/embeds');

function abrirModalVisualFilas(interaction, tipo) {
  return interaction.showModal(new ModalBuilder().setCustomId(`ap:modalfilas:${tipo}`).setTitle(`Configurar ${tipo}`)
    .addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('url').setLabel('URL da imagem ou EXCLUSIR').setPlaceholder('https://... ou EXCLUSIR').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(500))));
}

async function responderPainelPrivadoTemporario(interaction, payload) {
  const mensagem = await responderPrivado(interaction, payload);
  const alvo = mensagem?.delete ? mensagem : { delete: () => interaction.deleteReply() };
  vendasUI.agendarExclusaoPainel(alvo);
  return mensagem;
}

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

async function abrirModalCompraSaldo(interaction) {
  return interaction.showModal(new ModalBuilder()
    .setCustomId('ap:modalcomprasaldo')
    .setTitle('Comprar salas com saldo')
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('valor')
        .setLabel('Valor a usar (múltiplos de R$ 0,03)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Ex.: 0,30 para 10 salas')
        .setMaxLength(12)
        .setRequired(true),
    )));
}

function calcularCompraSaldo(valor) {
  const centavos = recargas.valorEmCentavos(valor);
  if (centavos == null) throw new Error('Informe um valor maior que zero com até duas casas decimais, como 0,30.');
  const precoUnitario = vendasUI.PRECO_SALA_CENTAVOS;
  const limite = precoUnitario * 1000;
  if (centavos > limite) throw new Error(`O limite por compra é ${reais(limite)} (1.000 salas).`);
  if (centavos % precoUnitario !== 0) {
    throw new Error(`O valor precisa ser múltiplo exato de ${reais(precoUnitario)} por sala; isso evita cobrar saldo por salas fracionadas.`);
  }
  return { amountCents: centavos, quantity: centavos / precoUnitario };
}

async function abrirModalRecarga(interaction) {
  const modal = new ModalBuilder()
    .setCustomId('ap:modalrecarga')
    .setTitle('Gerar Pix de Recarga')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('valor')
          .setLabel('Valor da recarga')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('Ex: 10,00 ou 0.01')
          .setMaxLength(24)
          .setRequired(true),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('email')
          .setLabel('E-mail (Gmail)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('seuemail@gmail.com')
          .setMinLength(5)
          .setMaxLength(254)
          .setRequired(true),
      ),
    );
  return interaction.showModal(modal);
}

async function abrirModalPlanoInfinito(interaction, plan) {
  const plano = salaInfinita.PLANOS[String(plan || '')];
  if (!plano) return responderErro(interaction, 'Plano Sala Infinita inválido.');
  const titulo = plan === 'semanal' ? 'Sala Infinita · Semanal' : 'Sala Infinita · Mensal';
  return interaction.showModal(new ModalBuilder()
    .setCustomId(`ap:modalinfinita:${plan}`)
    .setTitle(titulo)
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId('email')
        .setLabel('E-mail do pagador para o Pix')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('seuemail@gmail.com')
        .setMinLength(5)
        .setMaxLength(254)
        .setRequired(true),
    )));
}

async function aplicarPlanoInfinito(interaction, db, plan) {
  if (!interaction.guildId) {
    await responderErro(interaction, 'O plano Sala Infinita funciona somente dentro do servidor.');
    return true;
  }
  if (!(await mediadores.podeUsarSalas(db, interaction.guildId, interaction.member))) {
    await responderErro(interaction, mediadores.AVISO_CARGO);
    return true;
  }
  const email = String(interaction.fields.getTextInputValue('email') || '').trim().toLowerCase();
  if (!comprasSalas.validarEmailPix(email)) {
    await responderPrivado(interaction, { content: comprasSalas.MENSAGEM_EMAIL_INVALIDO });
    return true;
  }
  const resultado = await salaInfinita.criarPixPlano({
    guildId: interaction.guildId,
    userId: interaction.user.id,
    requestId: interaction.id,
    plan,
    payerEmail: email,
  });
  const plano = salaInfinita.PLANOS[plan];
  if (resultado.order.status === 'approved') {
    return responderPrivado(interaction, {
      embeds: [embedSucesso(`Pagamento aprovado. Sala Infinita ${plano.nome} ativa até **${dataBR(Date.parse(resultado.order.premium_until_after))}**. O privilégio está vinculado somente à sua conta Discord neste servidor.`)],
    });
  }
  const payment = resultado.payment;
  if (!payment?.qrBase64 || !payment?.qrCode) {
    throw new Error('O pedido foi salvo, mas o Mercado Pago não retornou o QR Code. Não faça outro Pix; procure a administração.');
  }
  const base64 = String(payment.qrBase64).replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
  if (base64.length > 6 * 1024 * 1024 || !/^[A-Za-z0-9+/=]+$/.test(base64)) throw new Error('O Mercado Pago retornou um QR Code inválido. O pedido permanece salvo; procure a administração.');
  const qr = Buffer.from(base64, 'base64');
  if (!qr.length || qr.length > 4 * 1024 * 1024) throw new Error('O QR Code excede o limite seguro. O pedido permanece salvo; procure a administração.');
  const codigo = String(payment.qrCode).replace(/[\r\n]/g, '').trim();
  if (!codigo || codigo.length > 3000) throw new Error('O código Pix retornado não pode ser exibido com segurança. Procure a administração.');
  const expiraEm = payment.expiresAt || resultado.order.expires_at;
  const card = embed(`Pix · Sala Infinita ${plano.nome}`,
    `**Plano:** ${plano.dias} dias · **Valor:** ${reais(plano.amountCents)}${expiraEm ? `\n**Expira:** ${dataBR(Date.parse(expiraEm))}` : ''}`,
    { cor: config.CORES.neutro, rodape: 'ROYAL AP SALA · Mercado Pago' })
    .setImage('attachment://royal-infinite-qr.png');
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`ap:copiarinfinita:${resultado.order.id}`).setLabel('Copia e Cola').setEmoji('📋').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`ap:verificarinfinita:${resultado.order.id}`).setLabel('Verificar pagamento').setEmoji('🔄').setStyle(ButtonStyle.Success),
  );
  return responderPainelPrivadoTemporario(interaction, {
    embeds: [card],
    files: [new AttachmentBuilder(qr, { name: 'royal-infinite-qr.png' })],
    components: [row],
  });
}

async function aplicarRecarga(interaction) {
  if (!interaction.guildId) {
    await responderErro(interaction, 'A carteira de recarga funciona somente dentro do servidor.');
    return true;
  }
  const amountCents = recargas.valorEmCentavos(interaction.fields.getTextInputValue('valor'));
  if (amountCents == null) {
    await responderErro(interaction, 'Informe um valor maior que zero, com até duas casas decimais (ex.: 10,00 ou 0.01).');
    return true;
  }
  const email = String(interaction.fields.getTextInputValue('email') || '').trim().toLowerCase();
  if (!comprasSalas.validarEmailPix(email)) {
    await responderPrivado(interaction, { content: comprasSalas.MENSAGEM_EMAIL_INVALIDO });
    return true;
  }

  const { order, payment } = await recargas.criarRecargaPix({
    guildId: interaction.guildId,
    userId: interaction.user.id,
    requestId: interaction.id,
    amountCents,
    payerEmail: email,
  });
  if (order.status === 'approved') {
    const bonusAprovado = Number(order.bonus_cents || 0);
    const creditoAprovado = Number(order.credit_cents || order.amount_cents);
    return responderPrivado(interaction, {
      embeds: [embedSucesso(`Recarga aprovada! **${reais(creditoAprovado)}** foram adicionados à sua carteira${bonusAprovado > 0 ? `, incluindo **${reais(bonusAprovado)}** de bônus` : ''}.\n**Saldo disponível:** ${reais(order.balance_cents)}.`)],
    });
  }
  if (!payment?.qrBase64 || !payment?.qrCode) {
    throw new Error('O pedido foi registrado, mas o Mercado Pago não retornou o QR Code. Não gere outra recarga para esta tentativa; procure a administração.');
  }
  const base64 = String(payment.qrBase64).replace(/^data:image\/[a-zA-Z0-9.+-]+;base64,/, '');
  if (base64.length > 6 * 1024 * 1024 || !/^[A-Za-z0-9+/=]+$/.test(base64)) {
    throw new Error('O Mercado Pago retornou um QR Code inválido. A recarga permanece salva; procure a administração antes de tentar novamente.');
  }
  const qr = Buffer.from(base64, 'base64');
  if (!qr.length || qr.length > 4 * 1024 * 1024) {
    throw new Error('O QR Code retornado excede o limite seguro. A recarga permanece salva; procure a administração.');
  }
  const codigo = String(payment.qrCode).replace(/[\r\n]/g, '').trim();
  if (!codigo || codigo.length > 3000) {
    throw new Error('O código Pix retornado está fora do limite seguro de exibição. Use o atendimento da administração.');
  }
  const expiracao = payment.expiresAt || order.expires_at;
  const bonus = Number(order.bonus_cents || 0);
  const credito = Number(order.credit_cents || order.amount_cents);
  const corpo = `**Valor do Pix:** ${reais(order.amount_cents)}${bonus > 0 ? `\n**Bônus Royal AP (10%):** +${reais(bonus)}` : ''}\n**Crédito na carteira:** ${reais(credito)}${expiracao ? `\n**Expira:** ${dataBR(Date.parse(expiracao))}` : ''}`;
  const card = embed('Pix de recarga', corpo, {
    cor: config.CORES.ouro,
    rodape: 'Carteira Digital · Mercado Pago · Crédito após aprovação',
  }).setImage('attachment://royal-wallet-topup-qr.png');
  const botoes = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`ap:copiarrecarga:${order.id}`)
      .setLabel('Copia e Cola')
      .setEmoji('📋')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(`ap:verificarrecarga:${order.id}`)
      .setLabel('Verificar pagamento')
      .setEmoji('🔄')
      .setStyle(ButtonStyle.Success),
  );
  return responderPainelPrivadoTemporario(interaction, {
    embeds: [card],
    files: [new AttachmentBuilder(qr, { name: 'royal-wallet-topup-qr.png' })],
    components: [botoes],
  });
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
  const descricaoQuantidade = quantidadeFixa === 'custom' ? '**quantidade:**' : '**Pacote selecionado:**';
  const card = embed(
    'PIX GERADO',
    [
      `${descricaoQuantidade} ${Number(order.rooms_quantity || quantidade)} ${Number(order.rooms_quantity || quantidade) === 1 ? 'sala' : 'salas'}`,
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
    .setStyle(ButtonStyle.Secondary),
  new ButtonBuilder()
    .setCustomId(`ap:verificarcompra:${order.id}`)
    .setLabel('Verificar pagamento')
    .setStyle(ButtonStyle.Success)];
  return responderPrivado(interaction, {
    embeds: [card],
    files: arquivos,
    components: [new ActionRowBuilder().addComponents(...botoes)],
  });
}

async function aplicarCompraSaldo(interaction) {
  if (!interaction.guildId) {
    await responderErro(interaction, 'A compra com saldo funciona somente dentro do servidor.');
    return true;
  }
  if (!(await vendasUI.exigirCargoCompra(interaction))) return true;
  const { amountCents, quantity } = calcularCompraSaldo(interaction.fields.getTextInputValue('valor'));
  const resultado = await vendasDb.comprarComSaldo({
    guildId: interaction.guildId,
    userId: interaction.user.id,
    requestId: `wallet-room:${interaction.id}`,
    amountCents,
    quantity,
  });
  if (resultado.status === 'insufficient_funds') {
    await responderErro(interaction,
      `Saldo insuficiente para esta compra. Seu saldo é **${reais(resultado.balance_cents)}** e o total é **${reais(amountCents)}**. Use **/recarga** para adicionar saldo à carteira.`);
    return true;
  }
  if (resultado.status !== 'approved') {
    throw new Error('O Supabase não confirmou a compra com saldo. Nenhuma sala foi liberada; confira o extrato antes de tentar novamente.');
  }
  await responderPrivado(interaction, {
    embeds: [embedSucesso(
      `Compra aprovada e registrada na carteira.\n**Valor debitado:** ${reais(resultado.amount_cents)}\n` +
      `**Salas liberadas:** ${Number(resultado.rooms_quantity)}\n**Saldo restante:** ${reais(resultado.balance_cents)}\n\n` +
      'Os créditos já estão disponíveis para criar salas. Use **/minhassalas** para consultar seu saldo de salas.',
    )],
  });
  return true;
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
    ['modalpix', 'modalregras', 'modalsala', 'modalcompra', 'modalcomprasaldo', 'modalrecarga', 'modalinfinita', 'modalanuncioauto', 'modalfilas', 'modaladdsalas'].includes(tipo);
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
  if (tipo === 'modalcomprasaldo') {
    try {
      calcularCompraSaldo(interaction.fields.getTextInputValue('valor'));
    } catch (erro) {
      await responderErro(interaction, erro.message);
      return true;
    }
  }
  if (tipo === 'modalrecarga') {
    const valor = recargas.valorEmCentavos(interaction.fields.getTextInputValue('valor'));
    if (valor == null) {
      await responderErro(interaction, 'Informe um valor maior que zero, com até duas casas decimais (ex.: 10,00 ou 0.01).');
      return true;
    }
    const email = String(interaction.fields.getTextInputValue('email') || '').trim();
    if (!comprasSalas.validarEmailPix(email)) {
      await responderPrivado(interaction, { content: comprasSalas.MENSAGEM_EMAIL_INVALIDO });
      return true;
    }
  }
  if (tipo === 'modalinfinita') {
    if (!salaInfinita.PLANOS[String(partidaId || '')]) {
      await responderErro(interaction, 'Plano Sala Infinita inválido.');
      return true;
    }
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
    if (tipo === 'modalfilas') {
      if (!ehAdmin(interaction.member)) { await responderErro(interaction, 'Somente administradores podem alterar as filas.'); return true; }
      const tipoVisual = String(partes[2]);
      const valor = String(interaction.fields.getTextInputValue('url') || '').trim();
      if (!['avatar', 'banner'].includes(tipoVisual) || (!/^https?:\/\/\S+$/i.test(valor) && valor !== 'EXCLUSIR')) throw new Error('Informe uma URL http(s) válida ou EXCLUSIR.');
      const salvo = await paineis.salvarVisual(db, interaction.guildId, tipoVisual, valor === 'EXCLUSIR' ? null : valor);
      await responderPrivado(interaction, { content: `✅ ${tipoVisual} das filas ${valor === 'EXCLUSIR' ? 'removido' : 'salvo'} com sucesso.` });
      return true;
    }
    if (tipo === 'modaladdsalas') {
      if (!ehAdmin(interaction.member)) { await responderErro(interaction, 'Somente administradores podem distribuir salas.'); return true; }
      const quantidade = Number(interaction.fields.getTextInputValue('quantidade'));
      const admId = String(partes[2] || '');
      if (!/^\d{13,20}$/.test(admId) || !Number.isInteger(quantidade) || quantidade < 1 || quantidade > 100000) throw new Error('Informe uma quantidade inteira entre 1 e 100000.');
      const resultado = await vendasDb.concederSalas({ guildId: interaction.guildId, userId: admId, requestId: `admin-grant:${interaction.id}`, quantity: quantidade, actorId: interaction.user.id });
      const membro = await interaction.guild.members.fetch(admId).catch(() => null);
      await membro?.send(`✅ Você recebeu **${quantidade} sala(s)** para criação de salas Nix no servidor **${interaction.guild.name}**.`).catch(() => {});
      await responderPrivado(interaction, { content: `✅ ${quantidade} sala(s) creditada(s) para <@${admId}>. Saldo atual: **${resultado?.balance_rooms ?? 'atualizado'}**.` });
      return true;
    }
    // Modais do /botperfil (nome, avatar, descrição e status do bot).
    if (String(tipo || '').startsWith('modalbot')) return await aplicarPerfilBot(interaction, client, tipo);
    if (tipo === 'modalpix') return await aplicarPix(interaction, db);
    if (tipo === 'modalcompra') return await aplicarCompraSalas(interaction, partes);
    if (tipo === 'modalcomprasaldo') return await aplicarCompraSaldo(interaction);
    if (tipo === 'modalrecarga') return await aplicarRecarga(interaction);
    if (tipo === 'modalinfinita') return await aplicarPlanoInfinito(interaction, db, partidaId);
    if (tipo === 'modalanuncioauto') {
      if (!automacoes.ehAdmin(interaction)) {
        await responderErro(interaction, 'Somente administradores podem configurar automações.');
        return true;
      }
      const obter = (id) => interaction.fields.getTextInputValue(id);
      const salvo = await automacoes.salvarAnuncios(db, interaction.guildId, {
        canal_principal_id: obter('canal_principal_id'),
        link: obter('link'),
        canais_divulgacao: obter('canais_divulgacao'),
        horario: obter('horario'),
      });
      await responderPrivado(interaction, { content: `✅ Anúncio automático salvo para **${salvo.horario}** (horário de Brasília), com ${salvo.canais_divulgacao.length} canal(is) de divulgação. O link será enviado como mensagem limpa para renderizar o convite do Discord.` });
      return true;
    }

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
  abrirModalCompraSaldo,
  abrirModalRecarga,
  abrirModalPlanoInfinito,
  abrirModalVisualFilas,
  aplicarPlanoInfinito,
  aplicarRecarga,
  CAMPOS_BOT,
  handleModal,
};
