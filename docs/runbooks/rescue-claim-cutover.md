# ECO-03 — reservas de atendimento de resgates

## Corte obrigatório

1. Faça backup e pare **todas** as instâncias antigas e workers que processam resgates. Aguarde terminar os atendimentos humanos e as concessões automáticas já iniciados; verifique também integrações externas. O lock SQL não pode interromper um pagamento ou concessão já iniciado fora do banco.
2. Aplique as migrações anteriores e `20261120002003_eco03_rescue_claim.sql` numa janela controlada. A migração bloqueia as fontes, revoga a mutação direta do backend e fotografa **todas** as pendências existentes como revisão obrigatória. A reaplicação não fotografa pendências novas. Se houver permissões herdadas de escrita, a migração falha e reverte; remova-as por procedimento administrativo antes de repetir. Não inicie código antigo após o corte.
3. Atualize todas as instâncias para este código e registre novamente os comandos slash. A compra e a roleta continuam gerando pendências; uma entrega automática de cargo passa a disputar a mesma reserva com a equipe.

## Atendimento

Os slash commands administrativos de resgates foram retirados do registro do bot. A RPC `royal_rescue_action` e a reserva persistente continuam sendo usadas pelo fluxo de entrega automática de cargos; essa camada transacional não foi removida. Não há, nesta versão, listagem, reserva ou conclusão manual de pendências pelo Discord. PIX e itens físicos continuam exigindo atendimento externo e não são processados pelo bot.

Não repita pagamento, envio ou concessão em timeout, reinício, erro do Discord ou mudança de dados, nem suponha que uma operação externa falhou. A execução automática não repete uma concessão em replay. Reservas sem resolução permanecem bloqueadas; consulte os registros Supabase e reconcilie com um operador autorizado conforme os passos abaixo antes de qualquer ação manual.

## Reconciliação de legado ou de reserva travada

O corte não determina se uma pendência antiga foi paga, enviada ou concedida. Investigue comprovantes, Discord, trilhas e contato com o atendente, e registre o resultado e o responsável fora do banco; nunca libere por idade da reserva. Enquanto houver incerteza, mantenha o bloqueio. Para um titular ativo, primeiro assegure que seu atendimento parou e que nenhuma chamada externa pode continuar. Com múltiplas instâncias e pessoas, isso exige coordenação operacional; desligar apenas um processo não basta.

Depois de estabelecer com segurança que ninguém está processando e documentar o estado externo, um operador privilegiado pode remover **apenas** a reserva específica por transação administrativa auditada, mantendo todos os processadores e atendentes parados. Use parâmetros do cliente SQL, nunca concatene protocolo ou motivo. Exemplo para `psql`, substituindo os valores pelos apropriados (não inclua dados financeiros no motivo):

```sql
\set guild 'ID_DO_SERVIDOR'
\set origem 'loja'
\set protocolo 'PROTOCOLO_EXATO'
\set operador 'ID_OPERADOR'
\set motivo 'revisao documentada: referencia interna'
BEGIN;
WITH removida AS (
  DELETE FROM public.royal_rescue_claims
   WHERE guild_id = :'guild' AND source = :'origem' AND protocol = :'protocolo'
     AND state IN ('review','claimed')
   RETURNING guild_id, source, protocol, state, owner_id
)
INSERT INTO public.royal_audit_events(guild_id,actor_id,action,entity_type,entity_id,detail,before_data)
SELECT guild_id, :'operador', 'reward.delivery.reconciled_unlock', source, protocol,
       :'motivo', jsonb_build_object('state',state,'owner_id',owner_id)
FROM removida;
COMMIT;
```

Confirme que exatamente uma linha foi removida/auditada; se não, pare e investigue. Se a entrega já ocorreu, **não repita**. Como o handler de atendimento manual não está registrado no Discord, documente a evidência e faça a reconciliação transacional com um operador de banco autorizado, sem emitir um segundo efeito externo. Se foi comprovado que não ocorreu, siga o processo operacional aprovado para a organização antes de liberar ou atender a pendência. Este procedimento não oferece prova matemática sobre efeitos externos: depende de evidências e de todos os envolvidos respeitarem o protocolo.

Testes locais sem Supabase: `node --test testes/resgates.js testes/lojinha-pro.js testes/roleta-pro.js` e `python3 testes/rescue_claim_sql.py` (requer `pg_config`, `initdb`, `pg_ctl` e `psql`).
