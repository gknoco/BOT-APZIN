-- Consulta read-only para Supabase SQL Editor.
-- Cada linha deve retornar ok = true. O histórico da migration também deve
-- conter wallet_topup_refund_protection e royal_room_admin_grants.
WITH checks AS (
  SELECT 'royal_wallet_balances.is_frozen' AS check_name,
         EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='royal_wallet_balances' AND column_name='is_frozen') AS ok
  UNION ALL SELECT 'royal_wallet_balances.frozen_reason',
         EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='royal_wallet_balances' AND column_name='frozen_reason')
  UNION ALL SELECT 'royal_room_wallets.is_frozen',
         EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='royal_room_wallets' AND column_name='is_frozen')
  UNION ALL SELECT 'royal_room_wallets.frozen_reason',
         EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='royal_room_wallets' AND column_name='frozen_reason')
  UNION ALL SELECT 'RPC apply_topup 8 args',
         to_regprocedure('public.royal_wallet_apply_topup_payment(uuid,text,text,bigint,text,text,text,bigint)') IS NOT NULL
  UNION ALL SELECT 'RPC legacy apply_topup 7 args',
         to_regprocedure('public.royal_wallet_apply_topup_payment(uuid,text,text,bigint,text,text,text)') IS NOT NULL
  UNION ALL SELECT 'RPC purchase_rooms',
         to_regprocedure('public.royal_wallet_purchase_rooms(text,text,text,integer,bigint)') IS NOT NULL
  UNION ALL SELECT 'RPC wallet_balance',
         to_regprocedure('public.royal_wallet_balance(text,text)') IS NOT NULL
  UNION ALL SELECT 'RPC wallet_statement',
         to_regprocedure('public.royal_wallet_statement(text,text)') IS NOT NULL
  UNION ALL SELECT 'RPC reserve_room',
         to_regprocedure('public.royal_room_reserve_room(text,text,text,text,text)') IS NOT NULL
  UNION ALL SELECT 'RPC room_stats',
         to_regprocedure('public.royal_room_stats(text,text)') IS NOT NULL
  UNION ALL SELECT 'RPC room_admin_grant',
         to_regprocedure('public.royal_room_admin_grant(text,text,text,bigint,text)') IS NOT NULL
  UNION ALL SELECT 'freeze propagation trigger',
         EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='royal_wallet_propagate_freeze_to_rooms' AND tgrelid='public.royal_wallet_balances'::regclass AND NOT tgisinternal)
  UNION ALL SELECT 'wallet ledger supports refund_review',
         EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.royal_wallet_topup_ledger'::regclass AND conname='royal_wallet_topup_ledger_event_type_check' AND pg_get_constraintdef(oid) LIKE '%refund_review%')
  UNION ALL SELECT 'room ledger supports admin_grant',
         EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.royal_room_ledger'::regclass AND conname='royal_room_ledger_event_type_check' AND pg_get_constraintdef(oid) LIKE '%admin_grant%')
), function_acl AS (
  SELECT 'ACL service_role-only: ' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS check_name,
         p.prosecdef
         AND has_function_privilege('service_role', p.oid, 'EXECUTE')
         AND NOT has_function_privilege('anon', p.oid, 'EXECUTE')
         AND NOT has_function_privilege('authenticated', p.oid, 'EXECUTE') AS ok
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public'
     AND p.proname IN ('royal_wallet_apply_topup_payment','royal_wallet_purchase_rooms','royal_wallet_balance',
                       'royal_wallet_statement','royal_room_reserve_room','royal_room_stats','royal_room_admin_grant')
)
SELECT check_name, ok FROM checks
UNION ALL
SELECT check_name, ok FROM function_acl
ORDER BY check_name
LIMIT 40;
