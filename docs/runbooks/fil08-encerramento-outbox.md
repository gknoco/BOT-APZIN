# FIL-08 — encerramento e outbox de partidas

## Corte e garantia

Pare **todas** as versões antigas do bot antes de aplicar `20261120002004_fil08_match_outbox.sql` e suba somente esta versão depois do corte. Não combine processos antigos e novos: o código antigo ainda executa uma RPC econômica separada e envia logs diretamente. A migração não deve ser aplicada durante uma importação SQLite; termine e confira a importação primeiro, com o bot parado. Este roteiro não executa implantação nem acessa produção.

A RPC `royal_operacional_encerrar_partida` bloqueia a partida, aplica `royal_apply_match_result` (chave `guild_id` + `match_id`), grava estado, auditoria e duas intenções (cartão e log) numa única transação. Qualquer erro reverte tudo. Repetir o mesmo vencedor e motivo é seguro; resultado, W.O. ou cancelamento divergentes são rejeitados. O autor do primeiro encerramento é preservado. O cancelamento não credita prêmio. Repetir exatamente o pedido após perda da resposta é seguro; uma resposta ainda incerta não é prova de falha. Consulte a partida antes de tentar outro resultado.

A regra econômica existente é mantida: cada vencedor recebe **1 coin**, `wins`, `apostado` e `ganho` são atualizados; os demais recebem `losses`, `apostado` e, no W.O., `wos`. O ledger registra o coin. O valor em reais da aposta/premiação exibido no cartão é tratado externamente pelo mediador; esta mudança **não transfere Pix nem cria pagamento em dinheiro**.

## Pendências e histórico

O consumidor inicia com o processo e trabalha quando o Discord está pronto. Reivindica um item por vez com lease de dois minutos, token de fencing e backoff até cinco minutos; erros continuam pendentes sem limite de tentativas. Uma instância morta não perde a intenção: outro trabalhador retoma após o lease. O fechamento da aplicação não espera a entrega externa; o estado fica no banco. O cartão só é editado usando o ID já salvo, nunca recriado automaticamente. Canal, mensagem ou permissões ausentes permanecem pendentes; configure/corrija-os e acompanhe `ultimo_erro`, `tentativas` e `disponivel_em`. Resultados de RPC e respostas interativas do Discord não são uma confirmação de que os avisos externos chegaram.

A migração identifica finalizações anteriores sem linha em `royal_match_stats_applied` e registra `economia_legada` em **revisao**, com snapshot recuperável. A ausência do marcador não prova que o prêmio não foi concedido/importado por outro meio. Antes de liberar, a administração deve comparar histórico, ledger, ajustes e backups e confirmar a integridade do vencedor, motivo, valor e jogadores do payload. Se faltarem evidências, mantenha em revisão. Para liberar uma linha comprovadamente não aplicada, um operador de banco autorizado pode, com o bot parado e após auditoria, executar uma atualização direcionada a seu ID:

```sql
UPDATE public.royal_match_outbox SET estado = 'pendente', disponivel_em = clock_timestamp()
 WHERE id = :id_revisado AND tipo = 'economia_legada' AND estado = 'revisao';
```

Depois de reiniciar o consumidor, a aplicação do snapshot e a conclusão do item ocorrem na mesma transação. Erros de consistência ficam pendentes; não apague ou marque concluído sem investigar. Se houver prova de pagamento anterior fora da RPC, não libere a linha como crédito novo: reconcilie com um procedimento administrativo auditado e preserve a evidência. Partidas históricas importadas **depois** da migração não entram automaticamente nessa varredura; reconcilie-as separadamente antes do corte. Reaplicar a migração as identifica, mas não recupera dados históricos que já não existam no banco. Replays sem marcador e sem item aprovado são bloqueados.

Consultas de operação (restritas a pessoal autorizado, sem dados sensíveis do canal da partida):

```sql
SELECT id, partida_id, tipo, estado, tentativas, disponivel_em, lease_ate, ultimo_erro
  FROM public.royal_match_outbox WHERE estado <> 'concluido'
  ORDER BY id LIMIT 100;
SELECT id, partida_id, payload FROM public.royal_match_outbox
  WHERE tipo = 'economia_legada' AND estado = 'revisao' ORDER BY id LIMIT 100;
```

Use paginação por `id` para examinar mais de 100 itens. A tabela tem RLS; acesso ao consumidor é por RPCs restritas ao `service_role`. Não use atualização direta para driblar leases, nem manipule eventos `cartao`/`log` enquanto um worker ativo os processa.

## Limite de entrega externa

A outbox proporciona **ao menos uma tentativa recuperável**, não uma transação distribuída ou entrega exatamente uma vez ao Discord. Uma edição repetida do cartão é normalmente idempotente, mas edições de outras instâncias/processos podem chegar fora de ordem, uma mensagem pode ser apagada ou uma permissão removida. O log é um envio de nova mensagem: um timeout, crash após envio ou lease vencido pode causar duplicata. O nonce estável com `enforceNonce` reduz duplicatas somente durante a janela curta de deduplicação do Discord; não elimina o risco após essa janela nem garante que a mensagem permaneça disponível. O mesmo pode ocorrer após um envio aceito cujo ACK no banco falhou. Examine mensagens e eventos antes de qualquer intervenção. Respostas efêmeras a botões/comandos são externas e não são outbox; podem falhar mesmo com o resultado confirmado.

Teste local: `npm test` e `npm run test:match:sql` (exige PostgreSQL e `pg_virtualenv`; cria cluster descartável, sem conexão remota). Não há teste de Discord real nem de produção.
