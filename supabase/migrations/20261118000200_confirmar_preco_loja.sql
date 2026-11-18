BEGIN;

-- A assinatura e as regras da compra legada permanecem intactas. O mesmo lock
-- consultivo protege o replay entre chamadas da RPC antiga e desta nova RPC.
CREATE OR REPLACE FUNCTION public.royal_buy_item_confirmed(
  p_guild_id text,
  p_user_id text,
  p_item_id uuid,
  p_request_id text,
  p_expected_price bigint
)
RETURNS TABLE(purchase_id uuid, item_name text, new_balance bigint, status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  existing record;
  item_price bigint;
BEGIN
  IF NULLIF(trim(p_guild_id), '') IS NULL OR NULLIF(trim(p_user_id), '') IS NULL THEN
    RAISE EXCEPTION 'Servidor e usuário são obrigatórios';
  END IF;
  IF NULLIF(trim(p_request_id), '') IS NULL OR length(trim(p_request_id)) < 8 THEN
    RAISE EXCEPTION 'request_id inválido';
  END IF;

  -- Ordem igual à royal_buy_item: request, item e finalmente perfil.
  PERFORM pg_advisory_xact_lock(hashtextextended(trim(p_guild_id)||':buy:'||trim(p_request_id), 0));
  SELECT q.id AS purchase_id, q.user_id, q.item_id, q.status,
         i.name AS item_name, r.coins AS new_balance
    INTO existing
    FROM public.royal_purchases q
    JOIN public.royal_shop_items i ON i.id = q.item_id
    LEFT JOIN public.royal_profiles r ON r.guild_id = q.guild_id AND r.user_id = q.user_id
   WHERE q.guild_id = trim(p_guild_id) AND q.request_id = trim(p_request_id);
  IF FOUND THEN
    IF existing.user_id IS DISTINCT FROM trim(p_user_id) OR existing.item_id IS DISTINCT FROM p_item_id THEN
      RAISE EXCEPTION 'request_id reutilizado para outro usuário ou item';
    END IF;
    -- Como na RPC original, devolve o nome e o saldo atuais. Se um perfil foi
    -- removido, o saldo é NULL: nunca se tenta debitar uma compra já registrada.
    RETURN QUERY SELECT existing.purchase_id, existing.item_name, existing.new_balance, existing.status;
    RETURN;
  END IF;

  IF p_expected_price IS NULL THEN RAISE EXCEPTION 'Preço esperado obrigatório'; END IF;
  SELECT i.price INTO item_price FROM public.royal_shop_items i
   WHERE i.id = p_item_id AND i.guild_id = trim(p_guild_id) AND i.active FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Item indisponível'; END IF;
  IF item_price IS DISTINCT FROM p_expected_price THEN
    RAISE EXCEPTION 'O preço mudou';
  END IF;

  -- A linha continua bloqueada até o fim da transação, inclusive durante a
  -- RPC existente: não há janela entre a verificação de preço e o débito.
  RETURN QUERY SELECT b.purchase_id, b.item_name, b.new_balance, b.status
    FROM public.royal_buy_item(p_guild_id, p_user_id, p_item_id, p_request_id) AS b;
END $$;

REVOKE EXECUTE ON FUNCTION public.royal_buy_item_confirmed(text,text,uuid,text,bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.royal_buy_item_confirmed(text,text,uuid,text,bigint) TO service_role;

COMMIT;
