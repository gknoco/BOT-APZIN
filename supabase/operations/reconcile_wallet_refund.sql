-- PROCEDIMENTO MANUAL: não é migration e nunca é chamado pelo bot.
-- Use somente após conferir no Mercado Pago que o chargeback/estorno foi revertido
-- e que os fundos foram integralmente restituídos. Não use para um estorno confirmado.
-- Substitua TODOS os valores REPLACE_* pelos dados verificados antes de executar.
-- Execute no Supabase SQL Editor com uma conta administrativa autorizada.

BEGIN;

DO $reconcile_wallet_review$
DECLARE
  v_guild_id text := 'REPLACE_DISCORD_GUILD_ID';
  v_user_id text := 'REPLACE_DISCORD_USER_ID';
  v_review_request_id text := 'REPLACE_REFUND_REVIEW_REQUEST_ID';
  v_reviewed_by text := 'REPLACE_DISCORD_ADMIN_ID';
  v_provider_reference text := 'REPLACE_MP_CASE_OR_TICKET_REFERENCE';
  v_review_note text := 'REPLACE_WITH_AUDIT_NOTE';

  v_case public.royal_wallet_topup_ledger%ROWTYPE;
  v_case_topup_id uuid;
  v_topup_guild_id text;
  v_topup_user_id text;
  v_balance_cents bigint;
  v_wallet_frozen boolean;
  v_wallet_reason text;
  v_room_frozen boolean;
  v_room_reason text;
  v_resolution_request_id text;
  v_open_cases bigint;
  v_next_reason text;
  v_inserted integer;
BEGIN
  IF COALESCE(trim(v_guild_id), '') = '' OR COALESCE(trim(v_user_id), '') = '' OR
     COALESCE(trim(v_review_request_id), '') = '' OR COALESCE(trim(v_reviewed_by), '') = '' OR
     COALESCE(trim(v_provider_reference), '') = '' OR
     v_guild_id LIKE 'REPLACE_%' OR v_user_id LIKE 'REPLACE_%' OR
     v_review_request_id LIKE 'REPLACE_%' OR v_reviewed_by LIKE 'REPLACE_%' OR
     v_provider_reference LIKE 'REPLACE_%' OR v_review_note LIKE 'REPLACE_%' OR
     length(trim(v_review_note)) < 20 THEN
    RAISE EXCEPTION 'Preencha todos os valores REPLACE_* e informe uma nota de auditoria com ao menos 20 caracteres';
  END IF;

  -- Descubra a recarga sem lock e siga a mesma ordem do webhook: topup, saldo,
  -- carteira de salas e, por último, ledger. Isso reduz risco de deadlock.
  SELECT topup_id INTO v_case_topup_id
    FROM public.royal_wallet_topup_ledger
   WHERE request_id = v_review_request_id
     AND guild_id = v_guild_id
     AND user_id = v_user_id
     AND event_type = 'refund_review'
     AND detail->>'wallet_frozen' = 'true'
   LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Evento de revisão não encontrado para esta guild/usuário; nenhuma carteira foi alterada';
  END IF;
  IF v_case_topup_id IS NULL THEN
    RAISE EXCEPTION 'Evento de revisão sem recarga vinculada; nenhuma carteira foi alterada';
  END IF;

  SELECT guild_id, user_id INTO v_topup_guild_id, v_topup_user_id
    FROM public.royal_wallet_topups
   WHERE id = v_case_topup_id
   FOR UPDATE;
  IF NOT FOUND OR v_topup_guild_id <> v_guild_id OR v_topup_user_id <> v_user_id THEN
    RAISE EXCEPTION 'Recarga vinculada ao evento não corresponde à guild/usuário';
  END IF;

  SELECT balance_cents, is_frozen, frozen_reason
    INTO v_balance_cents, v_wallet_frozen, v_wallet_reason
    FROM public.royal_wallet_balances
   WHERE guild_id = v_guild_id AND user_id = v_user_id
   FOR UPDATE;
  IF NOT FOUND OR NOT COALESCE(v_wallet_frozen, false) THEN
    RAISE EXCEPTION 'A carteira monetária não está congelada; nenhuma alteração foi feita';
  END IF;

  SELECT is_frozen, frozen_reason INTO v_room_frozen, v_room_reason
    FROM public.royal_room_wallets
   WHERE guild_id = v_guild_id AND user_id = v_user_id
   FOR UPDATE;
  IF NOT FOUND OR NOT COALESCE(v_room_frozen, false) THEN
    RAISE EXCEPTION 'A carteira de salas não está congelada; nenhuma alteração foi feita';
  END IF;

  IF v_room_reason IS DISTINCT FROM v_wallet_reason OR NOT EXISTS (
    SELECT 1 FROM public.royal_wallet_topup_ledger open_case
     WHERE open_case.guild_id = v_guild_id AND open_case.user_id = v_user_id
       AND open_case.event_type = 'refund_review'
       AND open_case.detail->>'wallet_frozen' = 'true'
       AND COALESCE(open_case.detail->>'wallet_reason', 'refund_review') || ':' || open_case.topup_id::text = v_wallet_reason
       AND NOT EXISTS (
         SELECT 1 FROM public.royal_wallet_topup_ledger resolution
          WHERE resolution.guild_id = open_case.guild_id
            AND resolution.user_id = open_case.user_id
            AND resolution.event_type = 'refund_review'
            AND resolution.detail->>'resolves_request_id' = open_case.request_id
       )
  ) THEN
    RAISE EXCEPTION 'O bloqueio atual não corresponde a um caso de estorno ainda aberto; nenhuma liberação foi feita';
  END IF;

  SELECT * INTO v_case
    FROM public.royal_wallet_topup_ledger
   WHERE request_id = v_review_request_id
     AND guild_id = v_guild_id
     AND user_id = v_user_id
     AND event_type = 'refund_review'
     AND detail->>'wallet_frozen' = 'true'
   FOR UPDATE;
  IF NOT FOUND OR v_case.topup_id IS DISTINCT FROM v_case_topup_id THEN
    RAISE EXCEPTION 'O evento de revisão mudou durante a reconciliação; nenhuma liberação foi feita';
  END IF;
  IF v_case.topup_id IS NULL OR (
       COALESCE(v_case.detail->>'payment_status', '') NOT IN ('refunded', 'charged_back') AND
       COALESCE((v_case.detail->>'refunded_cents')::bigint, 0) <= 0
     ) THEN
    RAISE EXCEPTION 'O evento não é um estorno/chargeback reconhecido; nenhuma carteira foi alterada';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.royal_wallet_topup_ledger r
     WHERE r.guild_id = v_guild_id AND r.user_id = v_user_id
       AND r.event_type = 'refund_review'
       AND r.detail->>'resolves_request_id' = v_case.request_id
  ) THEN
    RAISE EXCEPTION 'Este evento já possui resolução auditada; confira o extrato antes de qualquer nova ação';
  END IF;

  v_resolution_request_id := 'refund_resolution:' || md5(v_case.request_id || ':' || v_provider_reference);
  INSERT INTO public.royal_wallet_topup_ledger
    (guild_id, user_id, request_id, event_type, delta_cents, topup_id, balance_after_cents, detail)
  VALUES
    (v_guild_id, v_user_id, v_resolution_request_id, 'refund_review', 0,
     v_case.topup_id, v_balance_cents,
     jsonb_build_object(
       'resolution', 'provider_reinstated',
       'resolves_request_id', v_case.request_id,
       'reviewed_by_discord_id', v_reviewed_by,
       'provider_reference', v_provider_reference,
       'review_note', v_review_note,
       'wallet_reason', v_case.detail->>'wallet_reason',
       'recorded_at', now()
     ))
  ON CONFLICT (request_id) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted <> 1 THEN
    RAISE EXCEPTION 'A chave de auditoria já existe; confira o ledger antes de tentar novamente';
  END IF;

  SELECT count(*) INTO v_open_cases
    FROM public.royal_wallet_topup_ledger r
   WHERE r.guild_id = v_guild_id AND r.user_id = v_user_id
     AND r.event_type = 'refund_review'
     AND r.detail->>'wallet_frozen' = 'true'
     AND NOT EXISTS (
       SELECT 1 FROM public.royal_wallet_topup_ledger resolution
        WHERE resolution.guild_id = r.guild_id
          AND resolution.user_id = r.user_id
          AND resolution.event_type = 'refund_review'
          AND resolution.detail->>'resolves_request_id' = r.request_id
     );

  IF v_open_cases = 0 THEN
    -- O trigger propaga congelamentos, não descongelamentos: atualize as duas
    -- carteiras explicitamente dentro da mesma transação.
    UPDATE public.royal_wallet_balances
       SET is_frozen = false, frozen_reason = NULL, updated_at = now()
     WHERE guild_id = v_guild_id AND user_id = v_user_id;
    UPDATE public.royal_room_wallets
       SET is_frozen = false, frozen_reason = NULL, updated_at = now()
     WHERE guild_id = v_guild_id AND user_id = v_user_id;
    RAISE NOTICE 'Todos os eventos de revisão foram resolvidos; ambas as carteiras foram desbloqueadas. Ledger: %', v_resolution_request_id;
  ELSE
    SELECT COALESCE(r.detail->>'wallet_reason', 'refund_review') || ':' || r.topup_id::text
      INTO v_next_reason
      FROM public.royal_wallet_topup_ledger r
     WHERE r.guild_id = v_guild_id AND r.user_id = v_user_id
       AND r.event_type = 'refund_review'
       AND r.detail->>'wallet_frozen' = 'true'
       AND NOT EXISTS (
         SELECT 1 FROM public.royal_wallet_topup_ledger resolution
          WHERE resolution.guild_id = r.guild_id
            AND resolution.user_id = r.user_id
            AND resolution.event_type = 'refund_review'
            AND resolution.detail->>'resolves_request_id' = r.request_id
       )
     ORDER BY r.created_at DESC, r.id DESC
     LIMIT 1;
    IF v_next_reason IS NULL THEN
      RAISE EXCEPTION 'Há casos abertos, mas não foi possível selecionar a razão de bloqueio; nenhuma liberação foi feita';
    END IF;
    UPDATE public.royal_wallet_balances
       SET frozen_reason = v_next_reason, updated_at = now()
     WHERE guild_id = v_guild_id AND user_id = v_user_id;
    UPDATE public.royal_room_wallets
       SET frozen_reason = v_next_reason, updated_at = now()
     WHERE guild_id = v_guild_id AND user_id = v_user_id;
    RAISE NOTICE 'Resolução registrada; % caso(s) ainda aberto(s). Ambas as carteiras continuam bloqueadas.', v_open_cases;
  END IF;
END;
$reconcile_wallet_review$;

COMMIT;
