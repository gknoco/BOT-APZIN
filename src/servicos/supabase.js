'use strict';

/** Acesso privado ao Supabase. Nunca registre nem envie a chave service-role. */

const { createClient } = require('@supabase/supabase-js');
const config = require('../config');
const PRAZO_SUPABASE_MS = 15000;
let cliente;

// Abortar limita a espera, mas não prova que uma escrita não foi confirmada.
// Chamadores devem tratar timeouts de escrita como resultados incertos.
async function fetchComPrazo(input, init = {}, prazoMs = PRAZO_SUPABASE_MS) {
  const controlador = new AbortController();
  const sinalOriginal = init.signal === undefined && input instanceof Request ? input.signal : init.signal;
  const limpar = () => {
    clearTimeout(relogio);
    sinalOriginal?.removeEventListener('abort', aoAbortar);
  };
  const aoAbortar = () => { controlador.abort(sinalOriginal.reason); limpar(); };
  const relogio = setTimeout(() => { controlador.abort(); limpar(); }, prazoMs);
  relogio.unref?.();
  if (sinalOriginal?.aborted) aoAbortar();
  else sinalOriginal?.addEventListener('abort', aoAbortar, { once: true });

  let resposta;
  try {
    resposta = await fetch(input, { ...init, signal: controlador.signal });
  } catch (erro) {
    limpar();
    throw erro;
  }
  if (!resposta.body) {
    limpar();
    return resposta;
  }
  // fetch resolve com os cabeçalhos; o prazo também cobre a leitura do corpo.
  const leitor = resposta.body.getReader();
  const corpo = new ReadableStream({
    async pull(destino) {
      try {
        const parte = await leitor.read();
        if (parte.done) { limpar(); destino.close(); }
        else destino.enqueue(parte.value);
      } catch (erro) { limpar(); destino.error(erro); }
    },
    cancel(motivo) { limpar(); return leitor.cancel(motivo); },
  });
  const protegida = new Response(corpo, {
    status: resposta.status, statusText: resposta.statusText, headers: resposta.headers,
  });
  for (const propriedade of ['url', 'redirected', 'type']) {
    Object.defineProperty(protegida, propriedade, { value: resposta[propriedade] });
  }
  return protegida;
}

function obterCliente() {
  if (cliente) return cliente;
  if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      'Supabase não configurado. Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY nas variáveis do ambiente; não compartilhe a chave service-role.',
    );
  }
  cliente = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    global: { fetch: fetchComPrazo },
    // Não introduzir novas tentativas automáticas; o chamador decide a recuperação.
    db: { retry: false },
  });
  return cliente;
}

function falha(operacao, erro) {
  const codigo = erro?.code ? ` (${erro.code})` : '';
  return new Error(`${operacao}${codigo}: ${erro?.message || 'erro sem detalhes retornados pelo Supabase'}`);
}

async function definirConfig(guildId, chave, valor, clienteOverride) {
  if (!guildId || !chave) throw new Error('Servidor e chave da configuração são obrigatórios.');
  const supabase = clienteOverride || obterCliente();
  const { error } = await supabase.from('discord_configuracoes').upsert(
    {
      guild_id: String(guildId),
      chave: String(chave),
      valor: String(valor),
      atualizado_em: new Date().toISOString(),
    },
    { onConflict: 'guild_id,chave' },
  );
  if (error) throw falha('Não consegui salvar a configuração no Supabase', error);
}

async function obterConfig(guildId, chave, clienteOverride) {
  if (!guildId || !chave) return null;
  const supabase = clienteOverride || obterCliente();
  const { data, error } = await supabase
    .from('discord_configuracoes')
    .select('valor')
    .eq('guild_id', String(guildId))
    .eq('chave', String(chave))
    .maybeSingle();
  if (error) throw falha('Não consegui ler a configuração do Supabase', error);
  return data?.valor ?? null;
}

async function listarConfigs(guildId, prefixo, clienteOverride) {
  if (!guildId || !prefixo) return [];
  const supabase = clienteOverride || obterCliente();
  const { data, error } = await supabase
    .from('discord_configuracoes')
    .select('chave,valor')
    .eq('guild_id', String(guildId))
    .like('chave', `${String(prefixo)}%`)
    .order('chave', { ascending: true })
    .limit(100);
  if (error) throw falha('Não consegui listar configurações do Supabase', error);
  return data || [];
}

async function removerConfig(guildId, chave, clienteOverride) {
  if (!guildId || !chave) throw new Error('Servidor e chave da configuração são obrigatórios.');
  const supabase = clienteOverride || obterCliente();
  const { error } = await supabase
    .from('discord_configuracoes')
    .delete()
    .eq('guild_id', String(guildId))
    .eq('chave', String(chave));
  if (error) throw falha('Não consegui remover a configuração do Supabase', error);
}

async function sortearVersiculo(guildId, userId, clienteOverride) {
  const supabase = clienteOverride || obterCliente();
  const { data, error } = await supabase.rpc('discord_sortear_versiculo', {
    p_guild_id: guildId == null ? null : String(guildId),
    p_user_id: userId == null ? null : String(userId),
  });
  if (error) throw falha('Não consegui sortear o versículo no Supabase', error);
  const registro = Array.isArray(data) ? data[0] : data;
  if (!registro?.id || !registro?.texto || !registro?.referencia) {
    throw new Error('O Supabase não retornou um versículo. Execute a migração SQL e o seed de versículos.');
  }
  return {
    versiculo: { id: registro.id, texto: registro.texto, referencia: registro.referencia },
    cicloReiniciado: Boolean(registro.ciclo_reiniciado),
  };
}

module.exports = { obterCliente, fetchComPrazo, definirConfig, obterConfig, listarConfigs, removerConfig, sortearVersiculo };
