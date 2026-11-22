'use strict';

/** Utilidades: ajuda, painel geral, suporte, status, integrações e regras de plataforma. */

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  StringSelectMenuBuilder,
  SlashCommandBuilder,
  PermissionFlagsBits,
} = require('discord.js');
const config = require('../config');
const persistenciaSupabase = require('../servicos/supabase');
const partidas = require('../servicos/partidas');
const paineis = require('../servicos/paineis');
const fluxoPartidas = require('../servicos/fluxo');
const roletaPro = require('./roletaPro');
const lojinhaPro = require('./lojinhaPro');
const { exigirStaff, exigirAdmin, responderPrivado, responderErro } = require('../util/seguranca');
const { embed, embedSucesso } = require('../util/embeds');

const CARGO_MEDIADOR_PEDIDO_SS = '1543684028719173732';

async function publicarPedidoSS(interaction, db, modalidade, checklist) {
  if (!interaction.member?.roles?.cache?.has?.(CARGO_MEDIADOR_PEDIDO_SS)) {
    return responderErro(interaction, `Somente mediadores com o cargo <@&${CARGO_MEDIADOR_PEDIDO_SS}> podem abrir pedidos SS.`);
  }
  if (!interaction.guildId || !interaction.guild?.channels?.fetch) {
    return responderErro(interaction, 'Este comando precisa ser usado dentro do servidor.');
  }
  const mobile = modalidade === 'ss_mobile';
  const partida = await partidas.porCanal(db, interaction.guildId, interaction.channelId);
  const modoPartida = partida && config.modoPorId(partida.modo);
  const plataformaEsperada = mobile ? 'mobile' : 'emu';
  if (!partida || partida.status !== 'aguardando_mediador' || partida.mediador_id || modoPartida?.plataforma !== plataformaEsperada) {
    return responderErro(interaction, `Use /${mobile ? 'ssmob' : 'ssemu'} somente dentro de uma sala de AP ativa ${mobile ? 'Mobile' : 'EMU'} que aguarda aceite do mediador.`);
  }
  const pedidoExistente = await fluxoPartidas.obterPedidoSS(db, interaction.guildId, partida.id);
  if (pedidoExistente) return responderErro(interaction, 'Já existe um pedido SS ativo para esta sala. Aguarde a equipe aceitar ou a sala ser encerrada.');
  const chave = mobile ? 'canal_filas_ss_mobile' : 'canal_filas_ss_emu';
  const comandoConfig = mobile ? '/configcanalfilasssmobile' : '/configcanalfilasssemu';
  const valor = await persistenciaSupabase.obterConfig(interaction.guildId, chave, db?.client);
  if (!valor) return responderErro(interaction, `Canal SS não configurado. Configure-o com ${comandoConfig} antes de abrir pedidos.`);

  let canal = null;
  try { canal = await interaction.guild.channels.fetch(String(valor)); } catch { /* resposta explícita abaixo */ }
  if (!canal || !canal.send || !canal.isTextBased?.() || String(canal.guildId || canal.guild?.id || '') !== String(interaction.guildId)) {
    return responderErro(interaction, `O canal SS configurado em ${comandoConfig} não existe, não é de texto ou não pertence a este servidor.`);
  }

  const customId = `ap:sspedido:${modalidade}:${partida.id}`;
  const payload = {
    embeds: [embed(`📨 Pedido de SS ${mobile ? 'Mobile' : 'EMU'}`,
      `**Sala de AP:** <#${partida.canal_id}>\n**Solicitado por:** ${interaction.user}\nA equipe SS pode aceitar este pedido pelo botão abaixo.`, {
        cor: config.CORES.aviso, rodape: `ORG Royal AP · Pedido ${interaction.id}`,
      })],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(customId).setLabel('Aceitar pedido').setEmoji('👑').setStyle(ButtonStyle.Success),
    )],
    allowedMentions: { users: [interaction.user.id] },
  };
  let mensagemEnviada = null;
  try {
    mensagemEnviada = await canal.send(payload);
    if (!mensagemEnviada?.id) throw new Error('Discord não confirmou a mensagem.');
    await fluxoPartidas.registrarPedidoSS(db, interaction.guildId, partida.id, {
      modalidade, channelId: canal.id, messageId: mensagemEnviada.id,
    });
  } catch (erro) {
    console.error(`[utilidades] falha ao publicar pedido ${modalidade} em ${valor}:`, erro);
    await Promise.resolve(mensagemEnviada?.delete?.()).catch(() => {});
    return responderErro(interaction, `Não consegui enviar/registrar o pedido no canal <#${valor}>. Verifique as permissões do bot e a conexão com o Supabase. (Detalhe: ${String(erro?.message || 'erro do Discord').slice(0, 140)})`);
  }
  return responderPrivado(interaction, {
    content: `✅ Pedido de SS ${mobile ? 'Mobile' : 'EMU'} enviado em <#${valor}>.`,
    embeds: [checklist],
  });
}

// Organiza os comandos e aplica o filtro opcional de categorias por cargo;
// nomes ainda não categorizados aparecem em "Outros comandos".
const CATEGORIAS_AJUDA = [
  { id: 'inicio', titulo: '❓ Comece por aqui', nomes: ['ajuda', 'painel'] },
  { id: 'filas', titulo: '🎮 Filas e partidas', nomes: ['painelfilas', 'vencedor', 'wo', 'apostas', 'criar_telagem', 'telagem_links'] },
  { id: 'mediacao', titulo: '👥 Mediação e PIX', avancada: true, nomes: ['mediadores', 'painelpixmediadores', 'painelbatepontomediadores', 'painelbatepontossmobile', 'painelbatepontossemu', 'painelpixss', 'pix'] },
  { id: 'perfil', titulo: '🏆 Perfil e economia', nomes: ['perfil', 'verp', 'ranking', 'rankingall', 'convites', 'meusconvites', 'addgiros', 'addvitoria', 'vitoria', 'addcoins', 'removercoins'] },
  { id: 'feedback', titulo: '💬 Comunidade e suporte', nomes: ['reportarbug', 'sugestao', 'versiculododia'] },
  { id: 'compras', titulo: '⚡ ROYAL SALA · compras', nomes: ['painelcomprar', 'permicompras', 'cupomcompras', 'minhassalas', 'painelrecarga'] },
  { id: 'salas', titulo: '🛠️ Salas Nix FF', nomes: ['nix'] },
  { id: 'moderacao', titulo: '🛡️ Moderação e administração', avancada: true, nomes: ['blacklist', 'clear', 'clearall', 'anunciar', 'anunciar2', 'enviar_dm', 'envio_massa', 'limpardm', 'logs', 'conectarbotcall', 'tirarbotcall'] },
  { id: 'configuracao', titulo: '⚙️ Configuração e comunidade', avancada: true, nomes: ['config', 'configentrada_saida', 'configcomandos', 'boombot', 'conectar', 'desconectar', 'setcargo', 'configpainelajuda', 'ssmob', 'ssemu', 'botperfil'] },
];

const GUIA_AJUDA = {
  ajuda: ['Abre esta central interativa com categorias, páginas e busca visual.', '`/ajuda`', 'Disponível para todos os membros.'],
  reportarbug: ['Envia um reporte estruturado para a equipe técnica, com passos de reprodução e print opcional.', '`/reportarbug bug:<descrição> passos:<passo a passo> print:<imagem opcional>`', 'Use o canal configurado de reportes; não exige cargo.'],
  sugestao: ['Publica uma sugestão para votação da comunidade com reações 👍 e 👎.', '`/sugestao ideia:<sua sugestão>`', 'Use o canal configurado de sugestões; não exige cargo.'],
  convites: ['Mostra o ranking de convites ou consulta os convites atribuídos a um membro.', '`/convites` ou `/convites usuario:<membro>`', 'Os dados dependem do rastreamento de convites configurado.'],
  meusconvites: ['Mostra em privado os convites atribuídos a você e quem o convidou, quando disponível.', '`/meusconvites`', 'Consulta seus dados no Supabase.'],
  painelpixmediadores: ['Publica o painel para cadastrar ou consultar a chave PIX usada pelo mediador.', '`/painelpixmediadores`', 'Exige o cargo de acesso dos mediadores e publicação em canal de texto.'],
  painel: ['Abre o painel geral ou publica os painéis da roleta e da lojinha.', '`/painel geral` · `/painel roleta` · `/painel lojinha`', 'A publicação da roleta e da lojinha exige acesso administrativo.'],
  painelbatepontomediadores: ['Publica o bate-ponto geral, com Entrar, Sair e Atualizar para mediadores.', '`/painelbatepontomediadores`', 'Exige o cargo de acesso dos mediadores; o PIX cadastrado é obrigatório para entrar.'],
  painelbatepontossmobile: ['Publica o plantão exclusivo da equipe SS Mobile.', '`/painelbatepontossmobile`', 'A publicação é administrativa; interação exige o cargo SS Mobile.'],
  painelbatepontossemu: ['Publica o plantão exclusivo da equipe SS EMU.', '`/painelbatepontossemu`', 'A publicação é administrativa; interação exige o cargo SS EMU.'],
  painelpixss: ['Publica o painel de cadastro e gestão de PIX para SS Mobile e SS EMU.', '`/painelpixss`', 'Exige o cargo SS Mobile ou SS EMU; os dados são vinculados ao servidor e usuário no Supabase.'],
  painelrecarga: ['Publica e fixa o painel principal da carteira digital.', '`/painelrecarga`', 'Exige Administrator ou proprietário do servidor.'],
  painelfilas: ['Gerencia a identidade visual e publica ou remove todas as filas nos canais oficiais configurados.', '`/painelfilas`', 'Exige Administrator; use os botões do painel para Banner, Avatar, Enviar todas as filas e Apagar filas.'],
  configpainelajuda: ['Define quais cargos podem visualizar categorias avançadas desta central.', '`/configpainelajuda acao:configurar categoria:<categoria> cargo:<cargo>`', 'Exige Administrator. Use `acao:listar` para consultar ou `acao:remover` para retirar um cargo.'],
  config: ['Configura os produtos e opções da lojinha.', '`/config lojinha`', 'Exige Administrator.'],
  configentrada_saida: ['Define os canais de entrada e saída de membros.', '`/configentrada_saida`', 'Exige Administrator. Abre um formulário para informar os IDs dos dois canais.'],
  configcomandos: ['Gerencia os comandos que cada cargo pode executar, com paginação, consulta e remoção de restrições.', '`/configcomandos`', 'Exige Administrator. Sem cargos vinculados, os comandos seguem as permissões nativas; administradores sempre podem executar.'],
  reportarbug: ['Envia um reporte estruturado para a equipe técnica, com passos de reprodução e print opcional.', '`/reportarbug bug:<descrição> passos:<passo a passo> print:<imagem opcional>`', 'Use o canal configurado de reportes; não exige cargo.'],
};

const CATEGORIA_POR_ID = new Map(CATEGORIAS_AJUDA.map((categoria) => [categoria.id, categoria]));
const chaveCargosAjuda = (id) => `ajuda:cargos:${id}`;

const TIPOS_OPCAO = {
  3: 'texto', 4: 'inteiro', 5: 'sim/não', 6: 'usuário', 7: 'canal',
  8: 'cargo', 9: 'usuário ou cargo', 10: 'número', 11: 'anexo',
};
const TIPOS_CANAL = {
  0: 'texto', 2: 'voz', 4: 'categoria', 5: 'anúncios', 10: 'tópico de anúncios',
  11: 'tópico público', 12: 'tópico privado', 13: 'palco', 14: 'diretório', 15: 'fórum', 16: 'mídia',
};
const LIMITE_DESCRICAO_AJUDA = 3800;
const TAMANHO_BLOCO_MENU = 25;

function definicaoAjuda(comando) {
  const dados = comando.data || comando;
  return typeof dados.toJSON === 'function' ? dados.toJSON() : dados;
}

function codigoAjuda(valor) {
  return `\`${String(valor).replace(/`/g, '\\`')}\``;
}

function linhasOpcaoAjuda(opcao) {
  const detalhes = [opcao.required ? 'obrigatória' : 'opcional', TIPOS_OPCAO[opcao.type] || `tipo ${opcao.type}`];
  if (opcao.min_value !== undefined) detalhes.push(`mín. ${opcao.min_value}`);
  if (opcao.max_value !== undefined) detalhes.push(`máx. ${opcao.max_value}`);
  if (opcao.min_length !== undefined) detalhes.push(`mín. ${opcao.min_length} caracteres`);
  if (opcao.max_length !== undefined) detalhes.push(`máx. ${opcao.max_length} caracteres`);
  if (opcao.autocomplete) detalhes.push('autocompletar');
  if (opcao.channel_types?.length) {
    detalhes.push(`canais: ${opcao.channel_types.map((tipo) => TIPOS_CANAL[tipo] || `tipo ${tipo}`).join(', ')}`);
  }
  const linhas = [`  • ${codigoAjuda(opcao.name)} · ${detalhes.join(' · ')} — ${opcao.description}`];
  for (const escolha of opcao.choices || []) {
    // Repetir o nome mantém a escolha identificável mesmo após uma quebra de página.
    linhas.push(`    ↳ ${codigoAjuda(opcao.name)}: ${codigoAjuda(escolha.value)} — ${escolha.name}`);
  }
  return linhas;
}

// Cada seção tem o caminho completo para que uma continuação nunca perca o
// contexto do comando, grupo ou subcomando ao mudar de página.
function secoesComandoAjuda(comando) {
  const json = definicaoAjuda(comando);
  const guia = GUIA_AJUDA[json.name];
  const secoes = [{
    cabecalho: `**/${json.name}** — ${json.description}`,
    linhas: guia ? [`> **O que faz:** ${guia[0]}`, `> **Requisitos:** ${guia[2]}`, `**Como usar:**\n\`\`\`\n${guia[1]}\n\`\`\``, '━━━━━━━━━━━━━━━━━━━━'] : [],
  }];
  function adicionarOpcoes(opcoes, caminho, secao) {
    for (const opcao of opcoes || []) {
      if (opcao.type === 1 || opcao.type === 2) {
        const caminhoCompleto = `${caminho} ${opcao.name}`;
        const prefixo = opcao.type === 2 ? '  · Grupo' : '  ·';
        const proxima = { cabecalho: `${prefixo} /${caminhoCompleto} — ${opcao.description}`, linhas: [] };
        secoes.push(proxima);
        adicionarOpcoes(opcao.options, caminhoCompleto, proxima);
      } else {
        secao.linhas.push(...linhasOpcaoAjuda(opcao));
      }
    }
  }
  adicionarOpcoes(json.options, json.name, secoes[0]);
  return secoes;
}

function formatarComandoAjuda(comando) {
  return secoesComandoAjuda(comando)
    .map((secao) => [secao.cabecalho, ...secao.linhas].join('\n')).join('\n');
}

// Não dividir um par substituto UTF-16 (por exemplo, emoji) entre páginas.
function partesLinhaAjuda(linha, limite) {
  if (limite < 2) throw new RangeError('O limite de paginação deve ser de pelo menos 2 caracteres.');
  if (!linha.length) return [''];
  const partes = [];
  for (let inicio = 0; inicio < linha.length;) {
    let fim = Math.min(inicio + limite, linha.length);
    if (fim < linha.length && /[\uD800-\uDBFF]/.test(linha[fim - 1]) && /[\uDC00-\uDFFF]/.test(linha[fim])) fim -= 1;
    partes.push(linha.slice(inicio, fim));
    inicio = fim;
  }
  return partes;
}

// Cada resposta contém uma única página e fica abaixo dos limites do Discord.
function dividirAjuda(blocos, limite = LIMITE_DESCRICAO_AJUDA) {
  if (!Number.isInteger(limite) || limite < 2) throw new RangeError('Limite de paginação inválido.');
  const paginas = [];
  let atual = '';
  function adicionar(linha) {
    if (atual && atual.length + 1 + linha.length > limite) {
      paginas.push(atual);
      atual = '';
    }
    atual += `${atual ? '\n' : ''}${linha}`;
  }
  for (const bloco of blocos) {
    if (atual) adicionar('');
    for (const linha of String(bloco).split('\n')) {
      for (const parte of partesLinhaAjuda(linha, limite)) adicionar(parte);
    }
  }
  if (atual) paginas.push(atual);
  return paginas;
}

function dividirSecoesAjuda(secoes) {
  const paginas = [];
  let atual = '';
  for (const secao of secoes) {
    const cabecalho = secao.cabecalho;
    // Nomes e descrições registrados no Discord são muito menores que o limite.
    // Ainda assim, um cabeçalho artificialmente enorme não trava a paginação.
    if (cabecalho.length > LIMITE_DESCRICAO_AJUDA - 3) {
      if (atual) paginas.push(atual);
      paginas.push(...dividirAjuda([cabecalho, ...secao.linhas]));
      atual = '';
      continue;
    }
    const partes = [];
    let fragmento = cabecalho;
    const espacoLinha = LIMITE_DESCRICAO_AJUDA - cabecalho.length - 1;
    for (const linha of secao.linhas) {
      for (const parte of partesLinhaAjuda(linha, espacoLinha)) {
        if (fragmento.length + 1 + parte.length > LIMITE_DESCRICAO_AJUDA) {
          partes.push(fragmento);
          fragmento = cabecalho;
        }
        fragmento += `\n${parte}`;
      }
    }
    partes.push(fragmento);
    for (const parte of partes) {
      if (atual && atual.length + 2 + parte.length > LIMITE_DESCRICAO_AJUDA) {
        paginas.push(atual);
        atual = '';
      }
      atual += `${atual ? '\n\n' : ''}${parte}`;
    }
  }
  if (atual) paginas.push(atual);
  return paginas;
}

function ajudaEmbeds(listaComandos = require('./index').definicoes(), filtroCategorias = null) {
  const categorias = CATEGORIAS_AJUDA
    .filter((categoria) => !filtroCategorias || filtroCategorias.has(categoria.id))
    .map((categoria) => ({ ...categoria, secoes: [] }));
  const outras = { titulo: '📚 Outros comandos', secoes: [] };
  // O mesmo JSON usado no registro de slash commands é a fonte da ajuda.
  for (const comando of listaComandos) {
    const json = definicaoAjuda(comando);
    const categoriaOriginal = CATEGORIAS_AJUDA.find((item) => item.nomes.includes(json.name));
    if (categoriaOriginal && filtroCategorias && !filtroCategorias.has(categoriaOriginal.id)) continue;
    const categoria = categorias.find((item) => item.nomes.includes(json.name)) || outras;
    categoria.secoes.push(...secoesComandoAjuda(json));
  }
  const saida = [];
  for (const categoria of [...categorias, outras]) {
    const paginas = dividirSecoesAjuda(categoria.secoes);
    paginas.forEach((descricao, indice) => {
      const parte = paginas.length > 1 ? ` · ${indice + 1}/${paginas.length}` : '';
      saida.push(embed(`${categoria.titulo}${parte}`, descricao, {
        cor: categoria === outras ? config.CORES.neutro : config.CORES.principal,
      }));
    });
  }
  if (!saida.length) saida.push(embed('❓ Central de ajuda', 'Nenhum comando está registrado.'));
  return saida;
}

function ajudaPagina(paginas, indice = 0, desativado = false) {
  const pagina = Math.max(0, Math.min(paginas.length - 1, Number.isInteger(indice) ? indice : 0));
  const inicioMenu = Math.floor(pagina / TAMANHO_BLOCO_MENU) * TAMANHO_BLOCO_MENU;
  const menu = new StringSelectMenuBuilder()
    .setCustomId('ajuda:categoria')
    .setPlaceholder('Selecione uma categoria ou página')
    .setDisabled(desativado)
    .addOptions(paginas.slice(inicioMenu, inicioMenu + TAMANHO_BLOCO_MENU).map((item, deslocamento) => ({
      label: item.toJSON().title.slice(0, 100),
      value: String(inicioMenu + deslocamento),
      default: inicioMenu + deslocamento === pagina,
    })));
  const botoes = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ajuda:anterior').setLabel('Anterior').setStyle(ButtonStyle.Secondary)
      .setDisabled(desativado || pagina === 0),
    new ButtonBuilder().setCustomId('ajuda:proxima').setLabel('Próxima').setStyle(ButtonStyle.Secondary)
      .setDisabled(desativado || pagina === paginas.length - 1),
  );
  if (paginas.length > TAMANHO_BLOCO_MENU) {
    botoes.addComponents(
      new ButtonBuilder().setCustomId('ajuda:bloco_anterior').setLabel('Categorias anteriores').setStyle(ButtonStyle.Secondary)
        .setDisabled(desativado || inicioMenu === 0),
      new ButtonBuilder().setCustomId('ajuda:bloco_proximo').setLabel('Mais categorias').setStyle(ButtonStyle.Secondary)
        .setDisabled(desativado || inicioMenu + TAMANHO_BLOCO_MENU >= paginas.length),
    );
  }
  const faixaMenu = paginas.length > TAMANHO_BLOCO_MENU
    ? `\nMenu: páginas ${inicioMenu + 1}–${Math.min(inicioMenu + TAMANHO_BLOCO_MENU, paginas.length)}.` : '';
  return {
    content: `**Central de ajuda · ORG Royal AP**\nPágina ${pagina + 1} de ${paginas.length}. Selecione uma categoria ou navegue pelos botões.${faixaMenu}\nAs opções indicam se são obrigatórias ou opcionais. Comandos administrativos dependem das permissões da equipe.`,
    embeds: [paginas[pagina]],
    components: [new ActionRowBuilder().addComponents(menu), botoes],
    allowedMentions: { parse: [] },
  };
}

async function filtroAjudaPorCargo(interaction, db) {
  const filtro = new Set(CATEGORIAS_AJUDA.filter((categoria) => !categoria.avancada).map((categoria) => categoria.id));
  const configuracoes = await persistenciaSupabase.listarConfigs(interaction.guildId, 'ajuda:cargos:', db?.client);
  for (const categoria of CATEGORIAS_AJUDA.filter((item) => item.avancada)) {
    const registro = configuracoes.find((item) => item.chave === chaveCargosAjuda(categoria.id));
    let cargos = [];
    try { cargos = JSON.parse(registro?.valor || '[]'); } catch { cargos = []; }
    if (!cargos.length || cargos.some((id) => interaction.member?.roles?.cache?.has(String(id)))) filtro.add(categoria.id);
  }
  return filtro;
}

async function mostrarAjuda(interaction, db) {
  const paginas = ajudaEmbeds(undefined, await filtroAjudaPorCargo(interaction, db));
  let pagina = 0;
  const mensagem = await responderPrivado(interaction, ajudaPagina(paginas, pagina));
  if (typeof mensagem?.createMessageComponentCollector !== 'function') return mensagem;
  const coletor = mensagem.createMessageComponentCollector({
    time: 10 * 60 * 1000,
    filter: (clique) => String(clique.user.id) === String(interaction.user.id) &&
      ['ajuda:categoria', 'ajuda:anterior', 'ajuda:proxima', 'ajuda:bloco_anterior', 'ajuda:bloco_proximo'].includes(clique.customId),
  });
  coletor.on('collect', async (clique) => {
    try {
      if (clique.customId === 'ajuda:categoria') {
        const escolhida = Number(clique.values?.[0]);
        if (Number.isInteger(escolhida) && escolhida >= 0 && escolhida < paginas.length) pagina = escolhida;
      } else if (clique.customId === 'ajuda:bloco_anterior') {
        pagina = Math.max(0, (Math.floor(pagina / TAMANHO_BLOCO_MENU) - 1) * TAMANHO_BLOCO_MENU);
      } else if (clique.customId === 'ajuda:bloco_proximo') {
        pagina = Math.min(paginas.length - 1, (Math.floor(pagina / TAMANHO_BLOCO_MENU) + 1) * TAMANHO_BLOCO_MENU);
      } else {
        pagina = Math.max(0, Math.min(paginas.length - 1, pagina + (clique.customId === 'ajuda:proxima' ? 1 : -1)));
      }
      await clique.update(ajudaPagina(paginas, pagina));
    } catch (erro) {
      if (![10008, 10062].includes(Number(erro?.code))) console.error('[ajuda] falha ao navegar:', erro);
    }
  });
  coletor.on('end', () => {
    interaction.editReply(ajudaPagina(paginas, pagina, true)).catch((erro) => {
      if (![10008, 10062, 50027].includes(Number(erro?.code))) console.error('[ajuda] falha ao encerrar navegação:', erro);
    });
  });
  return mensagem;
}

async function contarTabela(db, tabela, guildId) {
  const colunas = { royal_profiles: 'user_id', royal_partidas: 'id', royal_paineis: 'modo', royal_filas: 'id', royal_audit_events: 'id' };
  if (!colunas[tabela]) throw new Error('Tabela de status inválida.');
  const { count, error } = await db.client.from(tabela).select(colunas[tabela], { count: 'exact', head: true })
    .eq('guild_id', String(guildId));
  if (error) throw new Error(`Não consegui consultar ${tabela} no Supabase: ${error.message}`);
  return count ?? 0;
}

const comandos = [
  {
    data: new SlashCommandBuilder().setName('ajuda').setDescription('Explica como o bot funciona e todos os comandos'),

    async executar(interaction, { db }) {
      return mostrarAjuda(interaction, db);
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('configpainelajuda')
      .setDescription('Configura cargos autorizados para categorias avançadas da ajuda')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption((opcao) => opcao
        .setName('acao')
        .setDescription('Operação da configuração')
        .setRequired(true)
        .addChoices(
          { name: 'Configurar/adicionar cargo', value: 'configurar' },
          { name: 'Remover cargo', value: 'remover' },
          { name: 'Listar configurações', value: 'listar' },
        ))
      .addStringOption((opcao) => opcao
        .setName('categoria')
        .setDescription('Categoria avançada da central de ajuda')
        .addChoices(...CATEGORIAS_AJUDA.filter((item) => item.avancada).map((item) => ({ name: item.titulo.slice(0, 100), value: item.id }))))
      .addRoleOption((opcao) => opcao.setName('cargo').setDescription('Cargo que poderá visualizar a categoria')),

    async executar(interaction, { db }) {
      if (!(await exigirAdmin(interaction, 'Somente administradores podem configurar o painel de ajuda.'))) return;
      const acao = interaction.options.getString('acao', true);
      if (acao === 'listar') {
        const registros = await persistenciaSupabase.listarConfigs(interaction.guildId, 'ajuda:cargos:', db.client);
        const linhas = CATEGORIAS_AJUDA.filter((item) => item.avancada).map((categoria) => {
          const registro = registros.find((item) => item.chave === chaveCargosAjuda(categoria.id));
          let ids = [];
          try { ids = JSON.parse(registro?.valor || '[]'); } catch { ids = []; }
          return `**${categoria.titulo}**\n${ids.length ? ids.map((id) => `<@&${id}>`).join(', ') : '_Visível para todos até ser configurada._'}`;
        });
        return responderPrivado(interaction, { embeds: [embed('🔐 Acesso por cargo · Central de ajuda', linhas.join('\n\n'), { cor: config.CORES.principal, rodape: 'Configuração persistida no Supabase' })] });
      }

      const categoriaId = interaction.options.getString('categoria');
      const cargo = interaction.options.getRole('cargo');
      const categoria = CATEGORIA_POR_ID.get(categoriaId);
      if (!categoria?.avancada) return responderErro(interaction, 'Escolha uma categoria avançada válida.');
      if (!cargo) return responderErro(interaction, 'Informe o cargo que será autorizado.');

      const atual = await persistenciaSupabase.obterConfig(interaction.guildId, chaveCargosAjuda(categoria.id), db.client);
      let cargos = [];
      try { cargos = JSON.parse(atual || '[]'); } catch { cargos = []; }
      cargos = [...new Set(cargos.map(String))];
      if (acao === 'configurar') {
        if (!cargos.includes(cargo.id)) cargos.push(cargo.id);
      } else {
        cargos = cargos.filter((id) => id !== cargo.id);
      }
      if (cargos.length) await persistenciaSupabase.definirConfig(interaction.guildId, chaveCargosAjuda(categoria.id), JSON.stringify(cargos), db.client);
      else await persistenciaSupabase.removerConfig(interaction.guildId, chaveCargosAjuda(categoria.id), db.client);
      return responderPrivado(interaction, { embeds: [embedSucesso(`${acao === 'configurar' ? 'Cargo autorizado' : 'Cargo removido'} para **${categoria.titulo}**: ${cargo}.`)] });
    },
  },

  {
    data: new SlashCommandBuilder().setName('painel').setDescription('Painéis gerais e publicações da ORG')
      .addSubcommand((sub) => sub.setName('geral').setDescription('Mostra o painel geral de controle da ORG'))
      .addSubcommand((sub) => sub.setName('roleta').setDescription('Publica o painel da roleta'))
      .addSubcommand((sub) => sub.setName('lojinha').setDescription('Publica o painel público da lojinha')),

    async executar(interaction, ctx = {}) {
      const sub = interaction.options.getSubcommand(false) || 'geral';
      if (sub === 'roleta' && !interaction.guildId) {
        return responderErro(interaction, 'Use este comando dentro de um servidor.');
      }
      if (sub === 'roleta') return roletaPro.publicarPainel(interaction, ctx);
      if (sub === 'lojinha') return lojinhaPro.publicarPainel(interaction, ctx);
      const { db } = ctx;
      if (!(await exigirStaff(interaction))) return;
      const guildId = interaction.guildId;
      const [ativas, publicados, naFila] = await Promise.all([
        partidas.ativasReais(db, guildId, interaction.client), paineis.todos(db, guildId), contarTabela(db, 'royal_filas', guildId),
      ]);
      const emAndamento = ativas.length;
      const paineisPublicados = publicados.length;

      const botoes = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ap:minhasalas').setLabel('Salas ativas').setEmoji('📋').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('ap:ranking').setLabel('Ranking').setEmoji('🏆').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('ap:ajuda').setLabel('Ajuda').setEmoji('❓').setStyle(ButtonStyle.Secondary),
      );

      return responderPrivado(interaction, {
        embeds: [
          embed('🎛️ Painel geral · ORG Royal AP', 'Acompanhe a operação do servidor e acesse os atalhos abaixo.', {
            cor: config.CORES.principal,
            campos: [
              { name: 'Salas em andamento', value: String(emAndamento), inline: true },
              { name: 'Jogadores na fila', value: String(naFila), inline: true },
              { name: 'Painéis publicados', value: `${paineisPublicados}/15`, inline: true },
            ],
            rodape: 'ORG Royal AP',
          }),
        ],
        components: [botoes],
      });
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('boombot')
      .setDescription('Status e configurações do bot')
      .addSubcommand((sub) => sub.setName('status').setDescription('Mostra a saúde do bot'))
      .addSubcommand((sub) =>
        sub
          .setName('setlog')
          .setDescription('Define o canal de auditoria')
          .addChannelOption((o) => o.setName('canal').setDescription('Canal de logs').setRequired(true)),
      )
      .addSubcommand((sub) =>
        sub
          .setName('setcategoria')
          .setDescription('Define a categoria das salas de AP')
          .addChannelOption((o) =>
            o
              .setName('categoria')
              .setDescription('Categoria onde as salas serão criadas')
              .setRequired(true)
              .addChannelTypes(ChannelType.GuildCategory),
          ),
      ),

    async executar(interaction, { db, client }) {
      const sub = interaction.options.getSubcommand();

      if (sub === 'status') {
        const guildId = interaction.guildId;
        const [totalUsuarios, totalPartidas, totalPaineis, totalAuditoria] = await Promise.all([
          contarTabela(db, 'royal_profiles', guildId), contarTabela(db, 'royal_partidas', guildId),
          contarTabela(db, 'royal_paineis', guildId), contarTabela(db, 'royal_audit_events', guildId),
        ]);
        const memoria = Math.round(process.memoryUsage().rss / 1024 / 1024);
        const horas = (process.uptime() / 3600).toFixed(1);

        return responderPrivado(interaction, {
          embeds: [
            embed('🤖 Status do bot', 'Indicadores atuais do bot e do servidor.', {
              cor: config.CORES.sucesso,
              campos: [
                { name: 'Latência', value: `${Math.round(client.ws.ping)} ms`, inline: true },
                { name: 'Online há', value: `${horas}h`, inline: true },
                { name: 'Memória', value: `${memoria} MB`, inline: true },
                { name: 'Usuários', value: String(totalUsuarios), inline: true },
                { name: 'Partidas', value: String(totalPartidas), inline: true },
                { name: 'Painéis', value: `${totalPaineis}/15`, inline: true },
                { name: 'Auditoria', value: String(totalAuditoria), inline: true },
                { name: 'Banco', value: 'Supabase · PostgreSQL', inline: true },
                { name: 'Node.js', value: process.version, inline: true },
                { name: 'Servidores', value: String(client.guilds.cache.size), inline: true },
              ],
              rodape: 'ORG Royal AP',
            }),
          ],
        });
      }

      if (!(await exigirAdmin(interaction))) return;

      if (sub === 'setlog') {
        const canal = interaction.options.getChannel('canal');
        await persistenciaSupabase.definirConfig(interaction.guildId, 'canal_logs', canal.id, db.client);
        return responderPrivado(interaction, { content: `✅ Canal de logs salvo com sucesso no banco de dados (Supabase): ${canal}.` });
      }


      const categoria = interaction.options.getChannel('categoria');
      await persistenciaSupabase.definirConfig(interaction.guildId, 'categoria_filas', categoria.id, db.client);
      return responderPrivado(interaction, { content: `✅ Categoria de salas salva com sucesso no banco de dados (Supabase): **${categoria.name}**.` });
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('conectar')
      .setDescription('Gerencia conexões/APIs externas usadas pela ORG')
      .addStringOption((opcao) => opcao.setName('nome').setDescription('Nome da integração (ex: webhook_vendas)'))
      .addStringOption((opcao) => opcao.setName('url').setDescription('URL ou token da integração')),

    async executar(interaction, { db }) {
      if (!(await exigirAdmin(interaction))) return;
      const nome = interaction.options.getString('nome');
      const url = interaction.options.getString('url');

      if (!nome) {
        const linhas = await persistenciaSupabase.listarConfigs(interaction.guildId, 'integracao:', db.client);
        const corpo = linhas.length
          ? linhas
              .map((linha) => `• **${linha.chave.replace('integracao:', '')}** → \`${linha.valor ? 'configurada' : 'vazia'}\``)
              .join('\n')
          : 'Nenhuma integração cadastrada.\nUse `/conectar nome:webhook_vendas url:https://...`.';
        return responderPrivado(interaction, { embeds: [embed('🔌 Integrações', corpo)] });
      }

      if (!url) {
        const atual = await persistenciaSupabase.obterConfig(interaction.guildId, `integracao:${nome}`, db.client);
        return responderPrivado(interaction, {
          content: `**${nome}**: ${atual ? 'configurada' : 'não configurada'}. O valor privado não é exibido no Discord.`,
        });
      }

      await persistenciaSupabase.definirConfig(interaction.guildId, `integracao:${nome}`, url, db.client);
      return responderPrivado(interaction, { embeds: [embedSucesso(`Integração **${nome}** salva com sucesso no banco de dados (Supabase).`)] });
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('desconectar')
      .setDescription('Remove uma integração/API cadastrada')
      .addStringOption((opcao) => opcao.setName('nome').setDescription('Nome da integração').setRequired(true)),

    async executar(interaction, { db }) {
      if (!(await exigirAdmin(interaction))) return;
      const nome = interaction.options.getString('nome');
      const atual = await persistenciaSupabase.obterConfig(interaction.guildId, `integracao:${nome}`, db.client);
      if (!atual) {
        return responderPrivado(interaction, { content: `Não achei a integração **${nome}**.` });
      }
      await persistenciaSupabase.removerConfig(interaction.guildId, `integracao:${nome}`, db.client);
      return responderPrivado(interaction, {
        content: `🔌 Integração **${nome}** removida.`,
      });
    },
  },

  {
    data: new SlashCommandBuilder().setName('ssmob').setDescription('Regras e checklist de mobile (anti-trapaça)'),

    async executar(interaction, { db }) {
      return publicarPedidoSS(interaction, db, 'ss_mobile', embed(
            '📱 Verificação · Mobile',
            [
              '**Obrigatório no AP mobile:**',
              '• Jogar no celular, sem emulador ou controle externo.',
              '• Gravar a tela do AP inteiro quando o mediador pedir.',
              '• Print do placar final enviado na sala do AP.',
              '• Estar no mesmo servidor/região combinada (Brasil).',
              '',
              '_Suspeita de emulador = W.O. imediato, com print enviado para a staff._',
            ].join('\n'),
            { cor: config.CORES.gelo, rodape: 'ORG Royal AP' },
          ));
    },
  },

  {
    data: new SlashCommandBuilder().setName('ssemu').setDescription('Regras e checklist de emulador'),

    async executar(interaction, { db }) {
      return publicarPedidoSS(interaction, db, 'ss_emu', embed(
            '🖥️ Verificação · Emulador',
            [
              '**Obrigatório no AP emu:**',
              '• Emulador permitido: apenas os liberados pela ORG (BlueStacks 5 / LDPlayer 9).',
              '• Print da configuração do emulador (CPU, RAM, resolução) antes da sala.',
              '• Gravação de tela do AP inteiro, sem cortes.',
              '• Teclas mapeadas devem aparecer na gravação.',
              '',
              '_Macro, script ou tecla automática = banimento da ORG._',
            ].join('\n'),
            { cor: config.CORES.principal, rodape: 'ORG Royal AP' },
          ));
    },
  },


];

module.exports = { comandos, ajudaEmbeds, formatarComandoAjuda, ajudaPagina, mostrarAjuda, dividirAjuda, contarTabela };
