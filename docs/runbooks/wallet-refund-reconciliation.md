# Reconciliação de carteira após estorno ou chargeback

Este procedimento é **manual**, exclusivo para administração autorizada e só deve ser usado depois de confirmar no Mercado Pago que o estorno/chargeback foi revertido e que os fundos foram restituídos. Não existe comando do bot nem desbloqueio automático.

Se o Mercado Pago confirmar que o estorno/chargeback continua válido, **não desbloqueie**: mantenha as carteiras congeladas e encaminhe o caso para a administração financeira. Este procedimento não calcula nem lança uma perda financeira.

## 1. Localize e confirme o caso

Use IDs de uma guild e usuário que você já tenha autorizado a consultar. A consulta mostra apenas casos abertos daquele par:

```sql
SELECT review.request_id, review.topup_id, review.created_at, review.detail
FROM public.royal_wallet_topup_ledger AS review
WHERE review.guild_id = 'DISCORD_GUILD_ID'
  AND review.user_id = 'DISCORD_USER_ID'
  AND review.event_type = 'refund_review'
  AND review.detail->>'wallet_frozen' = 'true'
  AND NOT EXISTS (
    SELECT 1
    FROM public.royal_wallet_topup_ledger AS resolution
    WHERE resolution.guild_id = review.guild_id
      AND resolution.user_id = review.user_id
      AND resolution.event_type = 'refund_review'
      AND resolution.detail->>'resolves_request_id' = review.request_id
  )
ORDER BY review.created_at, review.id
LIMIT 100;
```

Confira, fora do banco, a transação e o histórico no painel do Mercado Pago. Registre um identificador verificável do caso/ticket e o administrador Discord responsável. Não use somente o status salvo no banco como evidência de que os fundos retornaram.

## 2. Execute a resolução auditada

Use o arquivo [`reconcile_wallet_refund.sql`](../../supabase/operations/reconcile_wallet_refund.sql) no Supabase SQL Editor. Substitua **todos** os campos `REPLACE_*` com os dados verificados. O `REVIEW_REQUEST_ID` é o `request_id` exato do evento aberto consultado acima; `REVIEWED_BY` é o ID Discord do administrador; `PROVIDER_REFERENCE` deve apontar para a evidência no Mercado Pago/ticket; a nota precisa explicar por que os fundos foram considerados restituídos.

O script abre uma transação, valida que o evento é uma revisão de estorno/chargeback, confere guild/usuário, bloqueio atual nas duas carteiras e origem do `frozen_reason`, e grava uma linha de resolução com `delta_cents = 0` no ledger antes de alterar o bloqueio. Ele não repõe nem retira saldo. Se houver outros eventos de revisão abertos para a mesma carteira, a resolução fica registrada, mas as duas carteiras continuam bloqueadas; execute a conferência e resolução separadamente para cada caso aberto. A última resolução só libera ambas as carteiras quando não restar caso aberto.

Se uma validação falhar, a transação aborta e nenhuma liberação é feita. Não remova os `RAISE EXCEPTION` nem rode `UPDATE` avulso nas tabelas.

## 3. Verifique a conclusão

Depois do `COMMIT`, confirme os dois flags e a trilha de auditoria:

```sql
SELECT guild_id, user_id, balance_cents, is_frozen, frozen_reason, updated_at
FROM public.royal_wallet_balances
WHERE guild_id = 'DISCORD_GUILD_ID' AND user_id = 'DISCORD_USER_ID'
LIMIT 1;

SELECT guild_id, user_id, purchased_rooms, reserved_rooms, consumed_rooms,
       reversed_rooms, is_frozen, frozen_reason, updated_at
FROM public.royal_room_wallets
WHERE guild_id = 'DISCORD_GUILD_ID' AND user_id = 'DISCORD_USER_ID'
LIMIT 1;

SELECT request_id, event_type, delta_cents, topup_id, detail, created_at
FROM public.royal_wallet_topup_ledger
WHERE guild_id = 'DISCORD_GUILD_ID'
  AND user_id = 'DISCORD_USER_ID'
  AND (request_id = 'REFUND_REVIEW_REQUEST_ID'
       OR detail->>'resolves_request_id' = 'REFUND_REVIEW_REQUEST_ID')
ORDER BY created_at DESC
LIMIT 10;
```

Se outros casos ainda estiverem abertos, `is_frozen` precisa continuar `true` nas duas carteiras. A resolução não altera o status histórico da recarga nem afirma que o Mercado Pago recreditou fundos; essa evidência fica registrada em `provider_reference` e `review_note`.
