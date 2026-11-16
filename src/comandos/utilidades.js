'use strict';

/** Utilidades: ajuda, painel geral, suporte, status, integrações e regras de plataforma. */

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  StringSelectMenuBuilder,
  SlashCommandBuilder,
} = require('discord.js');
const config = require('../config');
const persistenciaSupabase = require('../servicos/supabase');
const partidas = require('../servicos/partidas');
const paineis = require('../servicos/paineis');
const { exigirStaff, exigirAdmin, responderPrivado } = require('../util/seguranca');
const { embed, embedSucesso } = require('../util/embeds');

const CATEGORIAS_AJUDA = [
  { titulo: '❓ Comece por aqui', nomes: ['ajuda', 'painel'] },
  { titulo: '🎮 Filas e partidas', nomes: [...config.MODOS.map((modo) => modo.comando), 'vencedor', 'wo', 'go', 'apostas', 'criar_telagem', 'telagem_links'] },
  { titulo: '👥 Mediação e PIX', nomes: ['mediadores', 'painel_mediadores', 'registrar_pix', 'pix', 'painel_mediador', 'receita_mediadores', 'analista'] },
  { titulo: '🏆 Perfil e economia', nomes: ['perfil', 'verp', 'ranking', 'convites', 'addgiros', 'addvitoria', 'vitoria', 'loja', 'roleta', 'lojinha', 'inventario'] },
  { titulo: '⚡ ROYAL SALA · compras', nomes: ['painelcomprar', 'comprar', 'permicompras', 'cupomcompras', 'minhassalas', 'salasreconciliar'] },
  { titulo: '🛠️ Salas Nix FF', nomes: ['nix'] },
  { titulo: '🛡️ Moderação e administração', nomes: ['blacklist', 'limpar', 'clear', 'clearall', 'anunciar', 'anunciar2', 'enviar_dm', 'envio_massa', 'limpardm', 'logs', 'conectarbotcall', 'tirarbotcall'] },
  { titulo: '⚙️ Configuração e comunidade', nomes: ['boombot', 'conectar', 'desconectar', 'configcanal1', 'configcanal2', 'versiculododia', 'ssmob', 'ssemu', 'temu', 'botperfil', 'setbot'] },
];

function formatarComandoAjuda(comando) {
  const json = comando.data.toJSON();
  const opcoes = Array.isArray(json.options) ? json.options : [];
  const subcomandos = opcoes.filter((opcao) => opcao.type === 1 || opcao.type === 2);
  const linhas = [`**/${json.name}** — ${json.description}`];
  for (const sub of subcomandos) {
    if (sub.type === 1) linhas.push(`  · /${json.name} ${sub.name} — ${sub.description}`);
    else for (const aninhado of sub.options || []) {
      if (aninhado.type === 1) linhas.push(`  · /${json.name} ${sub.name} ${aninhado.name} — ${aninhado.description}`);
    }
  }
  return linhas.join('\n');
}

// Uma descrição nunca ultrapassa 3.800 caracteres; cada resposta da ajuda
// contém apenas uma página, abaixo dos 6.000 caracteres totais do Discord.
function dividirAjuda(linhas, limite = 3800) {
  const paginas = [];
  let atual = '';
  for (const bloco of linhas) {
    for (const linha of String(bloco).split('\n')) {
      for (let inicio = 0; inicio < linha.length || inicio === 0; inicio += limite) {
        const parte = linha.slice(inicio, inicio + limite);
        if (atual && atual.length + parte.length + 1 > limite) {
          paginas.push(atual);
          atual = '';
        }
        atual += `${atual ? '\n' : ''}${parte}`;
      }
    }
    if (atual.length < limite) atual += '\n';
  }
  if (atual.trim()) paginas.push(atual.trim());
  return paginas;
}

function ajudaEmbeds(listaComandos = require('./index').comandos) {
  const porNome = new Map(listaComandos.map((comando) => [comando.data.name, comando]));
  const usados = new Set();
  const saida = [];
  const adicionarCategoria = (titulo, linhas, cor) => {
    const paginas = dividirAjuda(linhas);
    paginas.forEach((descricao, indice) => {
      const parte = paginas.length > 1 ? ` · ${indice + 1}/${paginas.length}` : '';
      saida.push(embed(`${titulo}${parte}`, descricao, { cor }));
    });
  };
  for (const categoria of CATEGORIAS_AJUDA) {
    const linhas = categoria.nomes
      .map((nome) => porNome.get(nome))
      .filter((comando) => {
        if (!comando || usados.has(comando.data.name)) return false;
        usados.add(comando.data.name);
        return true;
      })
      .map(formatarComandoAjuda);
    if (linhas.length) adicionarCategoria(categoria.titulo, linhas, config.CORES.principal);
  }
  const restantes = listaComandos.filter((comando) => !usados.has(comando.data.name));
  if (restantes.length) {
    adicionarCategoria('📚 Outros comandos', restantes.map(formatarComandoAjuda), config.CORES.neutro);
  }
  return saida;
}

function ajudaPagina(paginas, indice = 0, desativado = false) {
  const pagina = Math.max(0, Math.min(paginas.length - 1, indice));
  const inicioMenu = Math.floor(pagina / 25) * 25;
  const menu = new StringSelectMenuBuilder()
    .setCustomId('ajuda:categoria')
    .setPlaceholder('Selecione uma categoria')
    .setDisabled(desativado)
    .addOptions(paginas.slice(inicioMenu, inicioMenu + 25).map((item, deslocamento) => ({
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
  return {
    content: `**Central de ajuda · ORG Royal AP**\nPágina ${pagina + 1} de ${paginas.length}. Selecione uma categoria ou navegue pelos botões.\nComandos administrativos continuam sujeitos às permissões da equipe.`,
    embeds: [paginas[pagina]],
    components: [new ActionRowBuilder().addComponents(menu), botoes],
    allowedMentions: { parse: [] },
  };
}

async function mostrarAjuda(interaction) {
  const paginas = ajudaEmbeds();
  let pagina = 0;
  const mensagem = await responderPrivado(interaction, ajudaPagina(paginas, pagina));
  if (typeof mensagem?.createMessageComponentCollector !== 'function') return mensagem;
  const coletor = mensagem.createMessageComponentCollector({
    time: 10 * 60 * 1000,
    filter: (clique) => String(clique.user.id) === String(interaction.user.id) &&
      ['ajuda:categoria', 'ajuda:anterior', 'ajuda:proxima'].includes(clique.customId),
  });
  coletor.on('collect', async (clique) => {
    try {
      if (clique.customId === 'ajuda:categoria') {
        const escolhida = Number(clique.values?.[0]);
        if (Number.isInteger(escolhida) && escolhida >= 0 && escolhida < paginas.length) pagina = escolhida;
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

    async executar(interaction) {
      return mostrarAjuda(interaction);
    },
  },

  {
    data: new SlashCommandBuilder().setName('painel').setDescription('Painel geral de controle da ORG'),

    async executar(interaction, { db }) {
      if (!(await exigirStaff(interaction))) return;
      const guildId = interaction.guildId;
      const [ativas, publicados, naFila] = await Promise.all([
        partidas.ativas(db, guildId), paineis.todos(db, guildId), contarTabela(db, 'royal_filas', guildId),
      ]);
      const emAndamento = ativas.length;
      const paineisPublicados = publicados.length;

      const botoes = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ap:minhasalas').setLabel('Salas ativas').setEmoji('📋').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('ap:ranking').setLabel('Ranking').setEmoji('🏆').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('ap:ajuda').setLabel('Ajuda').setEmoji('❓').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('ap:central').setLabel('Central de atendimento').setEmoji('🎫').setStyle(ButtonStyle.Secondary),
      );

      return responderPrivado(interaction, {
        embeds: [
          embed('🎛️ Painel geral · ORG Royal AP', 'Controle rápido do servidor. Use os botões abaixo.', {
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
            embed('🤖 Status do bot', 'Tudo certo por aqui.', {
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
        return responderPrivado(interaction, { content: `✅ Canal de logs: ${canal}.` });
      }


      const categoria = interaction.options.getChannel('categoria');
      await persistenciaSupabase.definirConfig(interaction.guildId, 'categoria_filas', categoria.id, db.client);
      return responderPrivado(interaction, { content: `✅ Salas de AP serão criadas em **${categoria.name}**.` });
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
      return responderPrivado(interaction, { embeds: [embedSucesso(`Integração **${nome}** salva.`)] });
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

    async executar(interaction) {
      return responderPrivado(interaction, {
        embeds: [
          embed(
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
          ),
        ],
      });
    },
  },

  {
    data: new SlashCommandBuilder().setName('ssemu').setDescription('Regras e checklist de emulador'),

    async executar(interaction) {
      return responderPrivado(interaction, {
        embeds: [
          embed(
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
          ),
        ],
      });
    },
  },

  {
    data: new SlashCommandBuilder().setName('temu').setDescription('Ferramentas rápidas para jogadores de emulador'),

    async executar(interaction) {
      const botoes = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ap:aux').setLabel('Falar com a staff').setEmoji('🎫').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('ap:como').setLabel('Como funciona o AP').setEmoji('❓').setStyle(ButtonStyle.Secondary),
      );
      return responderPrivado(interaction, {
        embeds: [
          embed(
            '🧰 Ferramentas · Emulador',
            [
              '**Antes de entrar na fila emu:**',
              '1. Teste o ping: `Configurações → Rede → Ping` no emulador.',
              '2. Resolução recomendada: 1280x720 (60 FPS).',
              '3. Feche macros/scripts e reinicie o emulador.',
              '4. Deixe a gravação pronta antes do AP começar.',
              '',
              '**Travou no meio do AP?** Avise a staff imediatamente com print — sem print, vale W.O.',
            ].join('\n'),
            { cor: config.CORES.neutro, rodape: 'ORG Royal AP' },
          ),
        ],
        components: [botoes],
      });
    },
  },
];

module.exports = { comandos, ajudaEmbeds, formatarComandoAjuda, ajudaPagina, mostrarAjuda, dividirAjuda, contarTabela };
