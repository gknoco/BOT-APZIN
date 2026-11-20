# ECO-03 — reservas de atendimento de resgates

## Corte obrigatório

1. Faça backup e pare **todas** as instâncias antigas e workers que processam resgates. Aguarde terminar os atendimentos humanos e as concessões automáticas já iniciados; verifique também integrações externas. O lock SQL não pode interromper um pagamento ou concessão já iniciado fora do banco.
2. Aplique as migrações anteriores e `20261120002003_eco03_rescue_claim.sql` numa janela controlada. A migração bloqueia as fontes, revoga a mutação direta do backend e fotografa **todas** as pendências existentes como revisão obrigatória. A reaplicação não fotografa pendências novas. Se houver permissões herdadas de escrita, a migração falha e reverte; remova-as por procedimento administrativo antes de repetir. Não inicie código antigo após o corte.
3. Atualize todas as instâncias para este código e registre novamente os comandos slash. A compra e a roleta continuam gerando pendências; uma entrega automática de cargo passa a disputar a mesma reserva com a equipe.

## Atendimento

- `/resgates pendentes` mostra loja e roleta, o protocolo e o responsável ou a indicação de revisão. A página é informativa, não é uma reserva e pode desatualizar.
- Antes de **qualquer** pagamento, envio ou concessão manual, execute `/resgates iniciar tipo:... protocolo:...`. Só a resposta de reserva recém-obtida permite começar. A aquisição é por servidor, origem e protocolo e fica vinculada à identidade Discord do atendente; as reservas automáticas pertencem a `auto:<id da interação>`.
- Mesmo com reserva, confira evidências e dados atuais: um status pendente não prova que nada aconteceu no passado. Se o mesmo atendente repetir `iniciar`, a resposta informa que já é titular mas **não** autoriza repetir um efeito externo. Outro atendente não pode iniciar nem concluir. Não compartilhe a conta nem execute atendimentos paralelos com a mesma identidade.
- Após confirmar a entrega externa, o titular usa `/resgates concluir`. A conclusão confere titular, situação e dados da pendência fotografados na reserva, e grava status, conclusão da reserva e auditoria na mesma transação. Ela não paga, envia, concede nem verifica o efeito externo. A loja registra o horário na reserva (`completed_at`); a roleta também registra `delivered_at` na origem.
- Reservas não têm expiração, liberação ou transferência automáticas. Em timeout, reinício, erro do Discord ou mudança de dados, não repita a operação nem suponha que falhou. A execução automática nunca repete uma concessão em replay. A reserva permanece bloqueada, inclusive se a falha ocorreu antes da concessão.

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

Confirme que exatamente uma linha foi removida/auditada; se não, pare e investigue. Se a entrega já ocorreu, **não repita**: após o corte operacional, o responsável usa `iniciar` e em seguida `concluir` para registrar a entrega comprovada, sem outro efeito externo. Se foi comprovado que não ocorreu, um responsável pode reservar e atender normalmente. Este procedimento não oferece prova matemática sobre efeitos externos: ele depende de evidências e de todos os envolvidos respeitarem o protocolo.

Testes locais sem Supabase: `node --test testes/resgates.js testes/lojinha-pro.js testes/roleta-pro.js` e `python3 testes/rescue_claim_sql.py` (requer `pg_config`, `initdb`, `pg_ctl` e `psql`).
