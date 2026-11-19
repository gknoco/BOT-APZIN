'use strict';

// Integração: registrar `comando` no índice de comandos e encaminhar os
// componentes `configeco:` a handleComponent ANTES de qualquer deferUpdate.
const {
  SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType,
} = require('discord.js');
const supabase = require('../servicos/supabase');
const royal = require('../servicos/royalSupabase');
const { EFEMERO, ehAdmin, exigirAdmin, responderPrivado } = require('../util/seguranca');

const PREFIXO = 'configeco:';
const SNOWFLAKE = /^\d{15,20}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIPOS = { r: ['coins', 'spins', 'role', 'shop_item', 'pix'], l: ['coins', 'spins', 'role', 'physical', 'pix'] };
const TABELAS = { r: 'royal_roulette_prizes', l: 'royal_shop_items' };
const COLUNAS = {
  r: 'id,guild_id,name,reward_type,reward_value,weight,active',
  l: 'id,guild_id,slug,name,description,price,reward_type,reward_value,stock,metadata,active,updated_at',
};
const MAX_TOTAL_PESO = 2147483647; // royal_spin usa integer para a soma.
const POR_PAGINA = 3;

class ErroUsuario extends Error {}
const falhar = (mensagem) => { throw new ErroUsuario(mensagem); };
const payload = (content, components = []) => ({ content, components, allowedMentions: { parse: [] } });
const encurtar = (v, max = 120) => String(v ?? '').replace(/[\r\n`]/g, ' ').slice(0, max);
const chaveCanal = (dom) => dom === 'r' ? 'roleta_canal' : 'lojinha_canal';
const idComponente = (i, dom, acao, extra) =>
  `${PREFIXO}${i.user.id}:${i.guildId}:${dom}:${acao}${extra === undefined ? '' : `:${extra}`}`;

function validoContexto(i) {
  return SNOWFLAKE.test(String(i.guildId || '')) && SNOWFLAKE.test(String(i.user?.id || '')) &&
    (!i.guild?.id || String(i.guild.id) === String(i.guildId));
}

function inteiro(texto, nome, minimo, maximo) {
  const s = String(texto ?? '').trim();
  if (!/^(0|[1-9]\d*)$/.test(s)) falhar(`${nome}: use um número inteiro não negativo, sem pontos ou sinais.`);
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n < minimo || n > maximo) falhar(`${nome}: permitido de ${minimo} a ${maximo}.`);
  return n;
}

function textoSimples(valor, nome, max, obrigatorio = true) {
  const s = String(valor ?? '').trim();
  if ((obrigatorio && !s) || s.length > max || /[\r\n\x00-\x1f\x7f]/.test(s)) {
    falhar(`${nome}: informe ${obrigatorio ? 'de 1 a' : 'até'} ${max} caracteres em uma linha.`);
  }
  return s;
}

function uuid(valor) {
  const s = String(valor || '').trim().toLowerCase();
  if (!UUID.test(s)) falhar('Informe o ID UUID completo do item exibido na lista.');
  return s;
}

function separar(valor, nome) {
  const partes = String(valor ?? '').split('|');
  if (partes.length !== 2) falhar(`${nome}: use exatamente um separador |.`);
  return partes.map((v) => v.trim());
}

function limiteExibido(metadata) {
  const v = metadata?.max_per_user;
  if (v == null || v === 0 || v === '0') return 'livre';
  if (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= 999999999) return String(v);
  if (typeof v === 'string' && /^[1-9]\d{0,8}$/.test(v)) return v;
  return 'inválido; revisar';
}

async function buscarRegistro(cliente, dom, guildId, id) {
  const { data, error } = await cliente.from(TABELAS[dom]).select(COLUNAS[dom])
    .eq('guild_id', guildId).eq('id', id).maybeSingle();
  if (error) throw new Error('consulta');
  if (!data) falhar('Item não encontrado neste servidor.');
  return data;
}

async function validarValor(i, cliente, dom, tipo, valor) {
  if (!TIPOS[dom].includes(tipo)) falhar(`Tipo inválido. Permitidos: ${TIPOS[dom].join(', ')}.`);
  if (tipo === 'coins' || tipo === 'spins') return String(inteiro(valor, 'Valor', 1, 1000000000));
  if (tipo === 'pix') {
    const s = String(valor || '').trim().replace(',', '.');
    if (!/^(?:0|[1-9]\d{0,4})(?:\.\d{1,2})?$/.test(s)) falhar('PIX: informe somente um valor em reais, por exemplo 5.00; não informe chave PIX.');
    const [reais, centavos = ''] = s.split('.');
    const n = Number(reais) * 100 + Number(centavos.padEnd(2, '0'));
    if (n < 1 || n > 1000000) falhar('PIX: valor permitido de R$ 0,01 a R$ 10.000,00.');
    return `${Math.floor(n / 100)}.${String(n % 100).padStart(2, '0')}`;
  }
  if (tipo === 'physical') return textoSimples(valor, 'Conteúdo do resgate físico', 120);
  if (tipo === 'shop_item') {
    const id = uuid(valor);
    const item = await buscarRegistro(cliente, 'l', i.guildId, id);
    if (!item.active) falhar('O item da loja vinculado deve estar ativo neste servidor.');
    return id;
  }
  const cargoId = String(valor || '').trim().replace(/^<@&(\d+)>$/, '$1');
  if (!SNOWFLAKE.test(cargoId) || cargoId === i.guildId) falhar('Cargo: informe um ID de cargo válido deste servidor.');
  let cargo;
  try {
    cargo = i.guild?.roles?.cache?.get(cargoId) || await i.guild?.roles?.fetch?.(cargoId);
  } catch { falhar('Não foi possível verificar o cargo neste servidor.'); }
  if (!cargo || (cargo.guild?.id && cargo.guild.id !== i.guildId) || cargo.managed || cargo.editable === false) {
    falhar('Cargo inexistente, gerenciado ou não atribuível pelo bot neste servidor.');
  }
  return cargoId;
}

async function verificarPeso(cliente, guildId, peso, excluirId) {
  let total = peso;
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await cliente.from(TABELAS.r).select('id,weight')
      .eq('guild_id', guildId).eq('active', true).order('id').range(offset, offset + 499);
    if (error) throw new Error('consulta peso');
    for (const linha of data || []) {
      if (linha.id !== excluirId) total += Number(linha.weight);
      if (!Number.isSafeInteger(total) || total > MAX_TOTAL_PESO) falhar('A soma dos pesos ativos ultrapassaria o limite da roleta.');
    }
    if (!data || data.length < 500) break;
  }
}

async function verificarDesativacaoLoja(cliente, guildId, id) {
  const { data, error } = await cliente.from(TABELAS.r).select('id')
    .eq('guild_id', guildId).eq('active', true).eq('reward_type', 'shop_item')
    .eq('reward_value', id).limit(1);
  if (error) throw new Error('consulta referências');
  if (data?.length) falhar('Este item é usado por prêmio ativo da roleta. Desative ou edite o prêmio antes.');
}

async function verificarHistorico(cliente, guildId, dom, antes, valores) {
  // Os registros de giro/compra referenciam a linha atual, não um snapshot.
  // Não reescrever a identidade/recompensa de algo já usado; cria-se outro item.
  const campos = dom === 'r' ? ['name', 'reward_type', 'reward_value']
    : ['name', 'description', 'reward_type', 'reward_value'];
  if (!campos.some((campo) => valores[campo] !== antes[campo])) return;
  const consultas = dom === 'r'
    ? [['royal_roulette_spins', 'prize_id', 'id']]
    : [['royal_purchases', 'item_id', 'id'], ['royal_inventory', 'item_id', 'item_id']];
  for (const [tabela, campo, selecionado] of consultas) {
    const { data, error } = await cliente.from(tabela).select(selecionado)
      .eq('guild_id', guildId).eq(campo, antes.id).limit(1);
    if (error) throw new Error('consulta histórico');
    if (data?.length) falhar('Este item possui histórico; nome, descrição e recompensa são imutáveis. Crie outro item e desative este. Preço, estoque e peso continuam editáveis.');
  }
  if (dom === 'l') await verificarDesativacaoLoja(cliente, guildId, antes.id);
}

// A auditoria não contém metadata arbitrário, chaves PIX nem mensagens de erro do banco.
function retrato(row) {
  if (!row) return null;
  const chaves = ['id', 'slug', 'name', 'description', 'price', 'reward_type', 'reward_value', 'stock', 'weight', 'active'];
  const dados = Object.fromEntries(chaves.filter((k) => row[k] !== undefined).map((k) => [k, row[k]]));
  if (row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)) {
    const limite = limiteExibido(row.metadata);
    dados.max_per_user = limite === 'livre' ? null : limite === 'inválido; revisar' ? 'inválido' : Number(limite);
  }
  return dados;
}

async function auditoria(cliente, i, acao, dom, entidade, antes, depois, detalhe) {
  const { error } = await cliente.from('royal_audit_events').insert({
    guild_id: i.guildId, actor_id: String(i.user.id), action: `config_economia.${acao}`,
    entity_type: dom === 'r' ? 'roulette_prize' : dom === 'l' ? 'shop_item' : 'configuration',
    entity_id: entidade || null, request_id: String(i.id || ''),
    before_data: antes, after_data: depois, detail: detalhe || null,
  });
  if (error) throw new Error('auditoria');
}

async function alterarComAuditoria(cliente, i, acao, dom, entidade, antes, depois, gravar) {
  // A intenção precisa estar persistida antes da mutação. Não há RPC transacional
  // para gravar mutação + evento; o resultado informa se a conclusão falhar.
  await auditoria(cliente, i, `${acao}.intent`, dom, entidade, antes, depois);
  const resultado = await gravar();
  try {
    await auditoria(cliente, i, `${acao}.complete`, dom, resultado?.id || entidade, antes, depois);
    return { resultado, aviso: '' };
  } catch {
    return { resultado, aviso: '\nA alteração foi salva, mas não foi possível registrar a conclusão da auditoria; a intenção foi registrada.' };
  }
}

function botao(i, dom, acao, rotulo, estilo = ButtonStyle.Secondary, extra) {
  return new ButtonBuilder().setCustomId(idComponente(i, dom, acao, extra)).setLabel(rotulo).setStyle(estilo);
}
function painel(i, dom) {
  const nome = dom === 'r' ? 'Roleta' : 'Lojinha';
  const nota = dom === 'r'
    ? 'O canal configurado é usado ao publicar; sem canal, usa-se o atual. Republique o painel após mudar o canal ou a lista de prêmios. Ajuste o cooldown e a duração da animação (3 a 20 segundos; padrão 8). Com a migração da economia, o cooldown padrão é 3 segundos (0 desativa); estoque de prêmio e PIX também dependem da migração. PIX requer processamento de entrega.'
    : 'O canal configurado e as instruções são usados ao publicar; sem canal, usa-se o atual. Republique o painel após alterar canal ou instruções. O limite por comprador depende da migração da economia; o estoque é global.';
  const componentes = [
    new ActionRowBuilder().addComponents(
      botao(i, dom, 'lista', 'Listar', ButtonStyle.Secondary, 0),
      botao(i, dom, 'criar', 'Criar', ButtonStyle.Success),
      botao(i, dom, 'editar', 'Editar', ButtonStyle.Primary),
      botao(i, dom, 'estado', 'Ativar/desativar'),
      botao(i, dom, 'config', 'Canal e opções'),
    ),
  ];
  if (dom === 'r') componentes.push(new ActionRowBuilder().addComponents(
    botao(i, dom, 'estoque', 'Estoque do prêmio'),
    botao(i, dom, 'giros', 'Ajustar giros', ButtonStyle.Primary),
  ));
  componentes.push(new ActionRowBuilder().addComponents(
    botao(i, dom, 'excluir', 'Excluir item', ButtonStyle.Danger),
  ));
  const ids = dom === 'r' ? '\nPara ajustar giros: ative o Modo Desenvolvedor no Discord, clique com o botão direito no usuário e escolha Copiar ID do usuário. Informe apenas os números; o ajuste vale somente neste servidor.' : '';
  return payload(`**Configuração · ${nome}**\nEscolha uma ação. Itens desativados são preservados e continuam no histórico. Após uso, nome e recompensa são imutáveis: crie outro item para alterá-los.\n${nota}${ids}`, componentes);
}

function campo(id, label, placeholder, max = 100, obrigatorio = true) {
  return new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId(id).setLabel(label)
    .setStyle(TextInputStyle.Short).setPlaceholder(placeholder).setMaxLength(max).setRequired(obrigatorio));
}
function modal(i, dom, acao) {
  const titulo = dom === 'r' ? 'roleta' : 'loja';
  const m = new ModalBuilder().setCustomId(idComponente(i, dom, `m-${acao}`));
  if (acao === 'config') {
    m.setTitle(`Opções da ${titulo}`).addComponents(
      campo('canal', 'Canal: ID, nenhum ou vazio para manter', 'ID do canal de texto deste servidor', 24, false),
      dom === 'r'
        ? campo('opcao', 'Cooldown em segundos (vazio mantém)', '0 a 86400; padrão 3, 0 desativa; exige migração', 5, false)
        : campo('opcao', 'Instruções (vazio mantém; - limpa)', 'Texto público de orientação, sem dados pessoais', 200, false),
    );
    if (dom === 'r') m.addComponents(
      campo('duracao', 'Duração do giro em segundos (vazio mantém)', '3 a 20 segundos; padrão 8', 2, false),
    );
  } else if (acao === 'estado') {
    m.setTitle(`Estado · ${titulo}`).addComponents(
      campo('id', 'ID completo do item', 'UUID exibido em Listar', 36),
      campo('estado', 'Novo estado', 'ativo ou inativo', 7),
    );
  } else if (acao === 'estoque' && dom === 'r') {
    m.setTitle('Estoque do prêmio').addComponents(
      campo('id', 'ID completo do prêmio', 'UUID exibido em Listar', 36),
      campo('estoque', 'Estoque global', 'livre ou um inteiro de 0 a 1000000', 7),
    );
  } else if (acao === 'giros' && dom === 'r') {
    m.setTitle('Ajustar giros do usuário').addComponents(
      campo('usuario', 'ID Discord do usuário (somente números)', 'Copie o ID com o Modo Desenvolvedor', 20),
      campo('operacao', 'Operação: adicionar ou remover', 'adicionar ou remover', 9),
      campo('quantidade', 'Quantidade de giros', 'Inteiro de 1 a 1000000000', 10),
      campo('motivo', 'Motivo para o registro', 'Motivo administrativo do ajuste', 120),
    );
  } else if (acao === 'excluir') {
    m.setTitle(`Excluir ${dom === 'r' ? 'prêmio' : 'produto'}`).addComponents(
      campo('id', 'ID completo do item', 'UUID exibido em Listar', 36),
      campo('confirmacao', 'Confirmação', 'EXCLUIR', 7),
    );
  } else if (dom === 'r') {
    m.setTitle(`${acao === 'criar' ? 'Criar prêmio' : 'Editar prêmio'}`);
    if (acao === 'editar') m.addComponents(campo('id', 'ID completo do prêmio', 'UUID exibido em Listar', 36));
    m.addComponents(
      campo('nome', 'Nome', 'Ex.: 50 coins', 80),
      campo('tipo', 'Tipo', 'coins, spins, role, shop_item ou pix', 10),
      campo('valor', 'Valor ou ID do cargo/item; PIX em R$', 'Ex.: 50, ID de cargo, UUID do item ou 5.00', 120),
      campo('peso', 'Peso probabilístico', '1 a 1000000; não é porcentagem', 7),
    );
  } else {
    m.setTitle(`${acao === 'criar' ? 'Criar produto' : 'Editar produto'}`).addComponents(
      acao === 'criar' ? campo('slug', 'Identificador único (slug)', 'letras minúsculas, números e hífens', 48)
        : campo('id', 'ID completo do produto', 'UUID exibido em Listar', 36),
      campo('nome', 'Nome', 'Ex.: Giro extra', 80),
      campo('recompensa', 'Tipo | valor', 'coins|50, spins|1, role|ID, physical|texto, pix|5.00', 150),
      campo('preco', 'Preço em coins', '1 a 1000000000', 10),
      campo('estoque', 'Estoque | limite por usuário | descrição', 'livre|livre|Descrição ou 10|2|Descrição', 200),
    );
  }
  return m;
}

async function listar(i, dom, pagina) {
  const cliente = supabase.obterCliente();
  const inicio = pagina * POR_PAGINA;
  const consultar = (colunas) => cliente.from(TABELAS[dom]).select(colunas).eq('guild_id', i.guildId)
    .order('id', { ascending: true }).range(inicio, inicio + POR_PAGINA);
  let { data, error } = await consultar(dom === 'r' ? `${COLUNAS.r},stock` : COLUNAS.l);
  if (dom === 'r' && ['42703', 'PGRST204'].includes(error?.code)) ({ data, error } = await consultar(COLUNAS.r));
  if (error) throw new Error('lista');
  const rows = (data || []).slice(0, POR_PAGINA);
  const linhas = rows.map((x) => {
    const base = `**${encurtar(x.name, 80)}** · ${x.active ? 'ativo' : 'inativo'}\nID: \`${x.id}\` · ${x.reward_type} · valor: \`${encurtar(x.reward_value, 120)}\``;
    return dom === 'r' ? `${base} · peso: ${x.weight}${x.stock === undefined ? '' : ` · estoque: ${x.stock === null ? 'livre' : x.stock}`}`
      : `${base}\nSlug: \`${encurtar(x.slug, 48)}\` · preço: ${x.price} · estoque: ${x.stock === null ? 'livre' : x.stock} · limite/usuário: ${limiteExibido(x.metadata)}\nDescrição: ${encurtar(x.description || '—', 160)}`;
  });
  const botoes = [];
  if (pagina > 0) botoes.push(botao(i, dom, 'lista', 'Anterior', ButtonStyle.Secondary, pagina - 1));
  if ((data || []).length > POR_PAGINA && pagina < 9999) botoes.push(botao(i, dom, 'lista', 'Próxima', ButtonStyle.Secondary, pagina + 1));
  botoes.push(botao(i, dom, 'painel', 'Voltar'));
  return payload(`**${dom === 'r' ? 'Prêmios' : 'Produtos'} · página ${pagina + 1}**\n\n${linhas.join('\n\n') || 'Nenhum item nesta página.'}`, [new ActionRowBuilder().addComponents(...botoes)]);
}

async function salvarFormulario(i, dom, acao) {
  const obter = (id) => i.fields.getTextInputValue(id);
  if (acao === 'giros' && dom === 'r') return ajustarGiros(i, obter);
  const cliente = supabase.obterCliente();
  if (acao === 'config') return salvarConfig(i, dom, cliente, obter);
  if (acao === 'estoque' && dom === 'r') return salvarEstoquePremio(i, cliente, obter);
  if (acao === 'excluir') return excluirItem(i, dom, cliente, obter);
  const id = acao === 'criar' ? null : uuid(obter('id'));
  const antes = id ? await buscarRegistro(cliente, dom, i.guildId, id) : null;
  let valores;
  if (acao === 'estado') {
    const estado = String(obter('estado')).trim().toLowerCase();
    if (!['ativo', 'inativo'].includes(estado)) falhar('Estado deve ser ativo ou inativo.');
    const ativo = estado === 'ativo';
    if (ativo === antes.active) falhar(`Este item já está ${estado}.`);
    if (dom === 'l' && !ativo) await verificarDesativacaoLoja(cliente, i.guildId, id);
    if (dom === 'r' && ativo) {
      await validarValor(i, cliente, dom, antes.reward_type, antes.reward_value);
      await verificarPeso(cliente, i.guildId, antes.weight, id);
    }
    valores = { active: ativo };
  } else {
    const nome = textoSimples(obter('nome'), 'Nome', 80);
    if (dom === 'r') {
      const tipo = String(obter('tipo')).trim().toLowerCase();
      const valor = await validarValor(i, cliente, dom, tipo, obter('valor'));
      const peso = inteiro(obter('peso'), 'Peso', 1, 1000000);
      if (!antes || antes.active) await verificarPeso(cliente, i.guildId, peso, id);
      valores = { name: nome, reward_type: tipo, reward_value: valor, weight: peso };
    } else {
      const [tipoInput, valorInput] = separar(obter('recompensa'), 'Recompensa');
      const tipo = tipoInput.toLowerCase();
      const valor = await validarValor(i, cliente, dom, tipo, valorInput);
      const preco = inteiro(obter('preco'), 'Preço', 1, 1000000000);
      const partesEstoque = String(obter('estoque') || '').split('|').map((v) => v.trim());
      if (partesEstoque.length !== 3) falhar('Estoque: use estoque | limite por usuário | descrição.');
      const [estoqueInput, limiteInput, descricaoInput] = partesEstoque;
      const estoque = estoqueInput.toLowerCase() === 'livre' ? null : inteiro(estoqueInput, 'Estoque', 0, 1000000);
      const limite = limiteInput.toLowerCase() === 'livre' ? null : inteiro(limiteInput, 'Limite por usuário', 1, 1000000);
      const descricao = textoSimples(descricaoInput, 'Descrição', 160, false) || null;
      if (antes && (!antes.metadata || typeof antes.metadata !== 'object' || Array.isArray(antes.metadata))) {
        falhar('Metadados existentes não são um objeto; revisão manual necessária antes da edição.');
      }
      const metadata = { ...(antes?.metadata || {}) };
      if (limite === null) delete metadata.max_per_user;
      else metadata.max_per_user = limite;
      valores = { name: nome, reward_type: tipo, reward_value: valor, price: preco, stock: estoque, description: descricao, metadata };
      if (!antes) {
        const slug = String(obter('slug')).trim();
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 48) falhar('Slug: use letras minúsculas, números e hífens internos, até 48 caracteres.');
        valores.slug = slug;
      }
    }
  }
  if (acao === 'editar') await verificarHistorico(cliente, i.guildId, dom, antes, valores);
  if (dom === 'l' && antes) valores.updated_at = new Date().toISOString();
  const depois = antes ? { ...retrato(antes), ...retrato(valores) } : { ...retrato(valores), active: true };
  const operacao = await alterarComAuditoria(cliente, i, acao, dom, id, retrato(antes), depois, async () => {
    if (!antes) {
      const { data, error } = await cliente.from(TABELAS[dom]).insert({ ...valores, guild_id: i.guildId, active: true })
        .select(COLUNAS[dom]).single();
      if (error || !data) throw new Error('inserção');
      return data;
    }
    let q = cliente.from(TABELAS[dom]).update(valores).eq('guild_id', i.guildId).eq('id', id)
      .eq('active', antes.active).eq('name', antes.name).eq('reward_type', antes.reward_type).eq('reward_value', antes.reward_value);
    if (dom === 'r') q = q.eq('weight', antes.weight);
    else {
      q = q.eq('updated_at', antes.updated_at).eq('price', antes.price);
      q = antes.stock === null ? q.is('stock', null) : q.eq('stock', antes.stock);
    }
    const { data, error } = await q.select(COLUNAS[dom]).maybeSingle();
    if (error) throw new Error('atualização');
    if (!data) falhar('O item mudou durante a operação. Consulte a lista e tente novamente.');
    return data;
  });
  const alertaCoins = dom === 'l' && valores.reward_type === 'coins' && Number(valores.reward_value) > Number(valores.price)
    ? '\nAtenção: a recompensa em coins excede o preço; compras repetidas podem criar saldo. O limite por usuário depende da migração.' : '';
  return payload(`Alteração salva. ID: \`${operacao.resultado.id}\`. O histórico não foi apagado.${operacao.aviso}${alertaCoins}`);
}

async function ajustarGiros(i, obter) {
  const userId = String(obter('usuario') || '').trim();
  if (!/^[1-9]\d{14,19}$/.test(userId) || BigInt(userId) > 18446744073709551615n) {
    falhar('ID do usuário inválido: informe o ID Discord completo, somente números, sem menção.');
  }
  // Sem ID da interação, o serviço geraria uma chave aleatória e perderia a idempotência.
  if (!SNOWFLAKE.test(String(i.id || ''))) falhar('ID da interação inválido; abra o formulário novamente.');
  const operacao = String(obter('operacao') || '').trim().toLowerCase();
  if (!['adicionar', 'remover'].includes(operacao)) falhar('Operação: informe adicionar ou remover.');
  const quantidade = inteiro(obter('quantidade'), 'Quantidade', 1, 1000000000);
  const reason = textoSimples(obter('motivo'), 'Motivo', 120);
  let perfil;
  try {
    // A RPC atômica isola por guild, registra no livro-razão e rejeita saldo negativo.
    perfil = await royal.ajustarPerfil({ guildId: i.guildId, userId,
      deltas: { spins: operacao === 'adicionar' ? quantidade : -quantidade },
      reason, actorId: String(i.user.id), request: i.id });
  } catch (erro) {
    if (/o ajuste deixaria um saldo ou estatística abaixo de zero/i.test(String(erro?.message || ''))) {
      falhar('Não é possível remover essa quantidade: o saldo de giros ficaria negativo.');
    }
    return payload('Não foi possível confirmar o ajuste. Consulte o saldo e o histórico antes de tentar novamente.');
  }
  return payload(`Ajuste de giros registrado neste servidor para o usuário \`${userId}\`. Saldo após o ajuste: ${String(perfil.spins)}.`);
}

async function excluirItem(i, dom, cliente, obter) {
  const id = uuid(obter('id'));
  if (String(obter('confirmacao') || '').trim().toUpperCase() !== 'EXCLUIR') {
    falhar('Digite EXCLUIR para confirmar a remoção permanente.');
  }
  const antes = await buscarRegistro(cliente, dom, i.guildId, id);
  const referencias = dom === 'r'
    ? [['royal_roulette_spins', 'prize_id', id, 'Este prêmio já possui giros registrados; desative-o para preservar o histórico.']]
    : [
      ['royal_purchases', 'item_id', id, 'Este produto já possui compras; desative-o para preservar o histórico.'],
      ['royal_inventory', 'item_id', id, 'Este produto já está no inventário de usuários; desative-o para preservar o histórico.'],
      ['royal_roulette_prizes', 'reward_value', id, 'Este produto está vinculado a uma premiação ativa da roleta; remova o vínculo antes.'],
    ];
  for (const [tabela, campo, valor, mensagem] of referencias) {
    let consulta = cliente.from(tabela).select('guild_id').eq('guild_id', i.guildId).eq(campo, valor).limit(1);
    if (tabela === 'royal_roulette_prizes' && dom === 'l') consulta = consulta.eq('active', true);
    const { data, error } = await consulta;
    if (error) throw new Error('consulta referências');
    if (data?.length) falhar(mensagem);
  }
  const res = await alterarComAuditoria(cliente, i, 'excluir', dom, id, retrato(antes), null, async () => {
    const { data, error } = await cliente.from(TABELAS[dom]).delete()
      .eq('guild_id', i.guildId).eq('id', id).eq('active', antes.active).select('id').maybeSingle();
    if (error) throw new Error('exclusão');
    if (!data) falhar('O item mudou durante a operação. Consulte a lista e tente novamente.');
    return data;
  });
  return payload(`Item excluído permanentemente. ID: \`${id}\`${res.aviso}`);
}

async function salvarEstoquePremio(i, cliente, obter) {
  const id = uuid(obter('id'));
  const entrada = String(obter('estoque') || '').trim().toLowerCase();
  const estoque = entrada === 'livre' ? null : inteiro(entrada, 'Estoque', 0, 1000000);
  const { data: antes, error } = await cliente.from(TABELAS.r).select(`${COLUNAS.r},stock`)
    .eq('guild_id', i.guildId).eq('id', id).maybeSingle();
  if (error && ['42703', 'PGRST204'].includes(error.code)) falhar('Estoque de prêmio exige a migração da economia, ainda não disponível.');
  if (error) throw new Error('consulta estoque');
  if (!antes) falhar('Item não encontrado neste servidor.');
  const res = await alterarComAuditoria(cliente, i, 'estoque', 'r', id, retrato(antes),
    { ...retrato(antes), stock: estoque }, async () => {
      let q = cliente.from(TABELAS.r).update({ stock: estoque }).eq('guild_id', i.guildId).eq('id', id);
      q = antes.stock === null ? q.is('stock', null) : q.eq('stock', antes.stock);
      const { data, error: erro } = await q.select(`${COLUNAS.r},stock`).maybeSingle();
      if (erro) throw new Error('atualização estoque');
      if (!data) falhar('O estoque mudou durante a operação. Consulte novamente e tente outra vez.');
      return data;
    });
  return payload(`Estoque do prêmio salvo. ID: \`${id}\`.${res.aviso}`);
}

async function canalValido(i, entrada) {
  if (entrada.toLowerCase() === 'nenhum') return '';
  const id = entrada.replace(/^<#(\d+)>$/, '$1');
  if (!SNOWFLAKE.test(id)) falhar('Canal: informe o ID de um canal de texto deste servidor ou nenhum.');
  let canal;
  try { canal = i.guild?.channels?.cache?.get(id) || await i.guild?.channels?.fetch?.(id); }
  catch { falhar('Não foi possível verificar o canal neste servidor.'); }
  if (!canal || (canal.guildId && canal.guildId !== i.guildId) ||
      ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(canal.type)) {
    falhar('Canal deve ser um canal de texto ou anúncios deste servidor.');
  }
  return id;
}

async function salvarConfig(i, dom, cliente, obter) {
  const canal = String(obter('canal') || '').trim();
  const opcao = String(obter('opcao') || '').trim();
  const duracao = dom === 'r' ? String(obter('duracao') || '').trim() : '';
  const alteracoes = [];
  if (canal) alteracoes.push([chaveCanal(dom), await canalValido(i, canal)]);
  if (opcao) {
    const valor = dom === 'r' ? String(inteiro(opcao, 'Cooldown', 0, 86400))
      : (opcao === '-' ? '' : textoSimples(opcao, 'Instruções', 200));
    alteracoes.push([dom === 'r' ? 'roleta_cooldown_segundos' : 'lojinha_instrucoes', valor]);
  }
  if (duracao) alteracoes.push(['roleta_duracao_segundos', String(inteiro(duracao, 'Duração da roleta', 3, 20))]);
  if (!alteracoes.length) falhar('Nenhuma alteração informada.');
  const concluidas = [];
  let aviso = '';
  for (const [chave, valor] of alteracoes) {
    try {
      const anterior = await supabase.obterConfig(i.guildId, chave, cliente);
      const res = await alterarComAuditoria(cliente, i, 'config', null, chave,
        { chave, valor: anterior }, { chave, valor },
        async () => { await supabase.definirConfig(i.guildId, chave, valor, cliente); return null; });
      concluidas.push(chave);
      aviso += res.aviso;
    } catch {
      if (!concluidas.length) throw new Error('configuração');
      return payload(`Salvo: ${concluidas.join(', ')}. Não foi possível salvar as demais alterações; tente novamente.${aviso}\nMudanças de canal ou instruções exigem republicar o painel. O cooldown da roleta depende da migração da economia.`);
    }
  }
  return payload(`Salvo: ${concluidas.join(', ')}.${aviso}\nMudanças de canal ou instruções exigem republicar o painel. O cooldown da roleta depende da migração da economia.`);
}

async function abrirConfiguracao(i, dominio) {
  if (!validoContexto(i)) return responderPrivado(i, payload('Use este comando em um servidor válido.'));
  if (!(await exigirAdmin(i, 'Somente administradores podem gerenciar a economia.'))) return;
  if (!['roleta', 'lojinha'].includes(dominio)) return responderPrivado(i, payload('Subcomando inválido.'));
  return responderPrivado(i, painel(i, dominio === 'roleta' ? 'r' : 'l'));
}

const comando = {
  data: new SlashCommandBuilder().setName('config').setDescription('Configura a lojinha deste servidor').setDMPermission(false)
    .addSubcommand((s) => s.setName('lojinha').setDescription('Gerencia os produtos e opções da loja')),
  async executar(i) {
    if (i.options.getSubcommand() !== 'lojinha') {
      return responderPrivado(i, payload('Subcomando inválido. Para configurar a roleta, use /configroleta.'));
    }
    return abrirConfiguracao(i, 'lojinha');
  },
};

async function handleComponent(i) {
  if (!String(i.customId || '').startsWith(PREFIXO)) return false;
  const partes = i.customId.split(':');
  const [, dono, guild, dom, acao, extra] = partes;
  const modalSubmit = Boolean(i.isModalSubmit?.());
  // Modal: reconhecer imediatamente antes de qualquer consulta ou validação assíncrona.
  if (modalSubmit && !i.deferred && !i.replied) await i.deferReply({ flags: EFEMERO });
  try {
    if (!validoContexto(i) || guild !== i.guildId || dono !== String(i.user.id)) {
      await responderPrivado(i, payload('Este controle pertence a outro usuário ou servidor.')); return true;
    }
    if (!ehAdmin(i.member)) {
      await responderPrivado(i, payload('Somente administradores podem gerenciar a economia.')); return true;
    }
    if (!['r', 'l'].includes(dom) || partes.length < 5 || partes.length > 6) falhar('Controle inválido. Abra /configroleta ou /config lojinha novamente.');
    if (modalSubmit) {
      if (partes.length !== 5 || !['m-criar', 'm-editar', 'm-estado', 'm-config', 'm-excluir', ...(dom === 'r' ? ['m-estoque', 'm-giros'] : [])].includes(acao)) falhar('Formulário inválido.');
      const resposta = await salvarFormulario(i, dom, acao.slice(2));
      await responderPrivado(i, resposta);
    } else if (i.isButton?.()) {
      if (['criar', 'editar', 'estado', 'config', 'excluir', ...(dom === 'r' ? ['estoque', 'giros'] : [])].includes(acao) && partes.length === 5) {
        // showModal precisa ser a primeira resposta ao clique, sem defer ou I/O.
        await i.showModal(modal(i, dom, acao));
      } else if (acao === 'lista' && partes.length === 6 && /^(0|[1-9]\d{0,3})$/.test(extra)) {
        await i.deferReply({ flags: EFEMERO });
        await responderPrivado(i, await listar(i, dom, Number(extra)));
      } else if (acao === 'painel' && partes.length === 5) {
        await responderPrivado(i, painel(i, dom));
      } else falhar('Controle inválido. Abra /configroleta ou /config lojinha novamente.');
    } else falhar('Tipo de interação inválido.');
  } catch (erro) {
    const mensagem = erro instanceof ErroUsuario ? erro.message : 'Não foi possível concluir a operação. Verifique a configuração e tente novamente; nenhum detalhe sensível foi exposto.';
    await responderPrivado(i, payload(mensagem));
  }
  return true;
}

module.exports = { comando, abrirConfiguracao, handleComponent };
