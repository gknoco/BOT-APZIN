BEGIN;

-- Extrato privado da carteira: agrega totais do ledger completo e retorna
-- somente as seis movimentações mais recentes do servidor/usuário solicitado.
CREATE OR REPLACE FUNCTION public.royal_wallet_statement(
  p_guild_id text,
  p_user_id text
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_balance bigint;
  v_entries bigint;
  v_exits bigint;
  v_movements jsonb;
BEGIN
  IF COALESCE(trim(p_guild_id), '') = '' OR COALESCE(trim(p_user_id), '') = '' THEN
    RAISE EXCEPTION 'WALLET_STATEMENT_IDENTITY_REQUIRED';
  END IF;

  SELECT COALESCE(balance_cents, 0)
    INTO v_balance
    FROM public.royal_wallet_balances
   WHERE guild_id = trim(p_guild_id) AND user_id = trim(p_user_id);
  v_balance := COALESCE(v_balance, 0);

  SELECT COALESCE(SUM(delta_cents) FILTER (WHERE delta_cents > 0), 0),
         COALESCE(SUM(-delta_cents) FILTER (WHERE delta_cents < 0), 0)
    INTO v_entries, v_exits
    FROM public.royal_wallet_topup_ledger
   WHERE guild_id = trim(p_guild_id) AND user_id = trim(p_user_id);

  SELECT COALESCE(jsonb_agg(to_jsonb(recentes)), '[]'::jsonb)
    INTO v_movements
    FROM (
      SELECT id, event_type, delta_cents, balance_after_cents, created_at
        FROM public.royal_wallet_topup_ledger
       WHERE guild_id = trim(p_guild_id) AND user_id = trim(p_user_id)
       ORDER BY created_at DESC, id DESC
       LIMIT 6
    ) AS recentes;

  RETURN jsonb_build_object(
    'balance_cents', v_balance,
    'total_entries_cents', COALESCE(v_entries, 0),
    'total_exits_cents', COALESCE(v_exits, 0),
    'wallet_status', 'Normal',
    'movements', v_movements
  );
END;
$$;

REVOKE ALL ON FUNCTION public.royal_wallet_statement(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.royal_wallet_statement(text, text) TO service_role;

COMMIT;
