BEGIN;

-- Apenas amplia os tipos existentes; não remove linhas, políticas RLS ou grants.
ALTER TABLE public.royal_roulette_prizes
  DROP CONSTRAINT IF EXISTS royal_roulette_prizes_reward_type_check;
ALTER TABLE public.royal_roulette_prizes
  ADD CONSTRAINT royal_roulette_prizes_reward_type_check
  CHECK (reward_type IN ('coins', 'spins', 'role', 'shop_item', 'pix'));
ALTER TABLE public.royal_reward_deliveries
  DROP CONSTRAINT IF EXISTS royal_reward_deliveries_reward_type_check;
ALTER TABLE public.royal_reward_deliveries
  ADD CONSTRAINT royal_reward_deliveries_reward_type_check
  CHECK (reward_type IN ('role', 'pix'));

-- NULL significa estoque ilimitado. O estoque do item da loja também é observado
-- para o tipo shop_item. Cada giro conserva o prêmio observado naquele momento.
ALTER TABLE public.royal_roulette_prizes
  ADD COLUMN IF NOT EXISTS stock bigint;
ALTER TABLE public.royal_roulette_prizes
  DROP CONSTRAINT IF EXISTS royal_roulette_prizes_stock_check;
ALTER TABLE public.royal_roulette_prizes
  ADD CONSTRAINT royal_roulette_prizes_stock_check CHECK (stock IS NULL OR stock >= 0);
ALTER TABLE public.royal_roulette_spins
  ADD COLUMN IF NOT EXISTS prize_name_snapshot text,
  ADD COLUMN IF NOT EXISTS reward_type_snapshot text,
  ADD COLUMN IF NOT EXISTS reward_value_snapshot text;

-- Só é possível congelar o estado atual dos registros legados: alterações feitas
-- antes desta migração não são recuperáveis, pois a versão anterior não guardava
-- snapshots. Os novos campos continuam anuláveis para compatibilidade com clientes.
UPDATE public.royal_roulette_spins AS s
   SET prize_name_snapshot = COALESCE(s.prize_name_snapshot, p.name),
       reward_type_snapshot = COALESCE(s.reward_type_snapshot, p.reward_type),
       reward_value_snapshot = COALESCE(s.reward_value_snapshot, p.reward_value)
  FROM public.royal_roulette_prizes AS p
 WHERE p.id = s.prize_id
   AND (s.prize_name_snapshot IS NULL OR s.reward_type_snapshot IS NULL OR s.reward_value_snapshot IS NULL);
CREATE INDEX IF NOT EXISTS royal_roulette_spins_profile_recent_idx
  ON public.royal_roulette_spins (guild_id, user_id, created_at DESC);

-- Reproduz o contrato e as regras de 202611150002. Um resultado já registrado
-- continua sendo apenas um replay: não há crédito retroativo para partidas antigas.
CREATE OR REPLACE FUNCTION public.royal_apply_match_result(
  p_guild_id text,
  p_match_id text,
  p_winner_time integer,
  p_stake bigint,
  p_reason text,
  p_players jsonb
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  player jsonb;
  uid text;
  team_no integer;
  seen_users text[] := ARRAY[]::text[];
  r public.royal_profiles%ROWTYPE;
  existing public.royal_match_stats_applied%ROWTYPE;
BEGIN
  IF NULLIF(trim(p_guild_id), '') IS NULL OR NULLIF(trim(p_match_id), '') IS NULL THEN
    RAISE EXCEPTION 'Servidor e partida são obrigatórios';
  END IF;
  IF p_winner_time IS NULL OR p_winner_time NOT IN (1, 2) THEN RAISE EXCEPTION 'Time vencedor inválido'; END IF;
  IF p_stake IS NULL OR p_stake < 0 THEN RAISE EXCEPTION 'Aposta inválida'; END IF;
  IF jsonb_typeof(p_players) IS DISTINCT FROM 'array' OR jsonb_array_length(p_players) = 0 THEN
    RAISE EXCEPTION 'Lista de jogadores inválida';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(trim(p_guild_id) || ':match:' || trim(p_match_id), 0));
  SELECT * INTO existing FROM public.royal_match_stats_applied
   WHERE guild_id = trim(p_guild_id) AND match_id = trim(p_match_id);
  IF FOUND THEN
    IF existing.winner_time IS DISTINCT FROM p_winner_time OR existing.stake IS DISTINCT FROM p_stake OR
       existing.reason IS DISTINCT FROM p_reason OR existing.players IS DISTINCT FROM p_players THEN
      RAISE EXCEPTION 'partida já registrada com resultado diferente';
    END IF;
    RETURN true;
  END IF;

  -- Uma pessoa não pode receber duas vitórias na mesma partida. A validação é
  -- posterior ao replay para não alterar o comportamento de resultados antigos.
  FOR player IN SELECT value FROM jsonb_array_elements(p_players) LOOP
    uid := NULLIF(trim(player->>'user_id'), '');
    team_no := (player->>'team')::integer;
    IF uid IS NULL OR team_no IS NULL OR team_no NOT IN (1, 2) THEN
      RAISE EXCEPTION 'Jogador ou time inválido no resultado';
    END IF;
    IF uid = ANY(seen_users) THEN RAISE EXCEPTION 'Jogador duplicado no resultado'; END IF;
    seen_users := array_append(seen_users, uid);
  END LOOP;

  INSERT INTO public.royal_match_stats_applied(guild_id, match_id, winner_time, stake, reason, players)
  VALUES (trim(p_guild_id), trim(p_match_id), p_winner_time, p_stake, p_reason, p_players);
  -- Inserção e bloqueios em ordem estável evitam inversão entre partidas e transferências.
  INSERT INTO public.royal_profiles(guild_id, user_id)
  SELECT trim(p_guild_id), x.uid FROM unnest(seen_users) AS x(uid) ORDER BY x.uid
  ON CONFLICT DO NOTHING;
  PERFORM 1 FROM public.royal_profiles
   WHERE guild_id = trim(p_guild_id) AND user_id = ANY(seen_users)
   ORDER BY user_id FOR UPDATE;

  FOR player IN SELECT value FROM jsonb_array_elements(p_players) LOOP
    uid := trim(player->>'user_id');
    team_no := (player->>'team')::integer;
    IF team_no = p_winner_time THEN
      UPDATE public.royal_profiles
         SET wins = wins + 1, coins = coins + 1, apostado = apostado + p_stake,
             ganho = ganho + p_stake, updated_at = now()
       WHERE guild_id = trim(p_guild_id) AND user_id = uid RETURNING * INTO r;
      INSERT INTO public.royal_wallet_ledger(guild_id, user_id, asset, amount, balance_after, reason, request_id)
      VALUES (trim(p_guild_id), uid, 'coins', 1, r.coins, 'vitória de partida', 'match-win:' || trim(p_match_id));
    ELSE
      UPDATE public.royal_profiles
         SET losses = losses + 1, apostado = apostado + p_stake,
             wos = wos + CASE WHEN p_reason = 'wo' THEN 1 ELSE 0 END, updated_at = now()
       WHERE guild_id = trim(p_guild_id) AND user_id = uid;
    END IF;
  END LOOP;
  RETURN true;
END $$;

-- O request_id conserva o replay da RPC anterior. Prêmios são bloqueados em
-- ordem e a mesma lista congelada é usada para pesos e escolha. Itens de loja
-- são bloqueados antes do perfil, na mesma ordem da RPC royal_buy_item.
CREATE OR REPLACE FUNCTION public.royal_spin(p_guild_id text, p_user_id text, p_request_id text)
RETURNS TABLE(spin_id uuid, prize_id uuid, prize_name text, reward_type text, reward_value text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  p public.royal_roulette_prizes%ROWTYPE;
  item public.royal_shop_items%ROWTYPE;
  r public.royal_profiles%ROWTYPE;
  existing record;
  prize_ids uuid[] := ARRAY[]::uuid[];
  eligible_ids uuid[] := ARRAY[]::uuid[];
  shop_ids uuid[] := ARRAY[]::uuid[];
  selected_id uuid;
  result_id uuid;
  total numeric := 0;
  pick numeric;
  acc numeric := 0;
  random_bytes bytea;
  random_integer numeric;
  random_ceiling numeric;
  crypto_schema name;
  byte_index integer;
  reward_amount bigint;
  new_balance bigint;
  cooldown_text text;
  cooldown_seconds integer := 3;
  last_spin timestamptz;
  spin_time timestamptz;
BEGIN
  IF NULLIF(trim(p_guild_id), '') IS NULL OR NULLIF(trim(p_user_id), '') IS NULL THEN
    RAISE EXCEPTION 'Servidor e usuário são obrigatórios';
  END IF;
  IF NULLIF(trim(p_request_id), '') IS NULL OR length(trim(p_request_id)) < 8 THEN
    RAISE EXCEPTION 'request_id inválido';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(trim(p_guild_id) || ':spin:' || trim(p_request_id), 0));
  SELECT s.id AS spin_id, s.user_id AS spin_user_id, s.prize_id,
         COALESCE(s.prize_name_snapshot, p0.name) AS prize_name,
         COALESCE(s.reward_type_snapshot, p0.reward_type) AS reward_type,
         COALESCE(s.reward_value_snapshot, p0.reward_value) AS reward_value
    INTO existing
    FROM public.royal_roulette_spins s JOIN public.royal_roulette_prizes p0 ON p0.id = s.prize_id
   WHERE s.guild_id = trim(p_guild_id) AND s.request_id = trim(p_request_id);
  IF FOUND THEN
    IF existing.spin_user_id <> trim(p_user_id) THEN RAISE EXCEPTION 'request_id pertence a outro usuário'; END IF;
    RETURN QUERY SELECT existing.spin_id, existing.prize_id, existing.prize_name, existing.reward_type, existing.reward_value;
    RETURN;
  END IF;

  FOR p IN SELECT rp.* FROM public.royal_roulette_prizes rp
            WHERE rp.guild_id = trim(p_guild_id) AND rp.active AND (rp.stock IS NULL OR rp.stock > 0)
            ORDER BY rp.id FOR UPDATE LOOP
    prize_ids := array_append(prize_ids, p.id);
    IF p.reward_type = 'shop_item' THEN
      BEGIN
        shop_ids := array_append(shop_ids, trim(p.reward_value)::uuid);
      EXCEPTION WHEN invalid_text_representation THEN
        RAISE EXCEPTION 'ID de item de prêmio da roleta inválido';
      END;
    END IF;
  END LOOP;
  -- Bloqueia todos os itens candidatos em ordem única para coordenar com a loja.
  PERFORM 1 FROM public.royal_shop_items i
   WHERE i.guild_id = trim(p_guild_id) AND i.id = ANY(shop_ids)
   ORDER BY i.id FOR UPDATE;
  FOR p IN SELECT rp.* FROM public.royal_roulette_prizes rp
            WHERE rp.id = ANY(prize_ids) ORDER BY rp.id LOOP
    IF p.reward_type = 'shop_item' THEN
      SELECT * INTO item FROM public.royal_shop_items i
       WHERE i.id = trim(p.reward_value)::uuid AND i.guild_id = trim(p_guild_id);
      IF NOT FOUND OR NOT item.active OR (item.stock IS NOT NULL AND item.stock < 1) THEN CONTINUE; END IF;
    END IF;
    eligible_ids := array_append(eligible_ids, p.id);
    total := total + p.weight;
  END LOOP;
  IF total <= 0 THEN RAISE EXCEPTION 'A roleta não tem prêmios ativos com estoque disponível'; END IF;
  IF total > 18446744073709551616::numeric THEN RAISE EXCEPTION 'Soma de pesos da roleta excede o limite'; END IF;

  INSERT INTO public.royal_profiles(guild_id, user_id) VALUES (trim(p_guild_id), trim(p_user_id)) ON CONFLICT DO NOTHING;
  SELECT * INTO r FROM public.royal_profiles
   WHERE guild_id = trim(p_guild_id) AND user_id = trim(p_user_id) FOR UPDATE;
  IF r.spins < 1 THEN RAISE EXCEPTION 'Você não possui giros disponíveis'; END IF;

  -- Padrão de três segundos evita spam; um administrador pode configurar 0.
  -- Uma configuração inválida falha sem consumir giro.
  SELECT valor INTO cooldown_text FROM public.discord_configuracoes
   WHERE guild_id = trim(p_guild_id) AND chave = 'roleta_cooldown_segundos';
  IF cooldown_text IS NOT NULL THEN
    cooldown_text := trim(cooldown_text);
    IF cooldown_text !~ '^[0-9]{1,6}$' THEN
      RAISE EXCEPTION 'roleta_cooldown_segundos deve ser inteiro entre 0 e 604800';
    END IF;
    IF cooldown_text::integer > 604800 THEN
      RAISE EXCEPTION 'roleta_cooldown_segundos deve ser inteiro entre 0 e 604800';
    END IF;
    cooldown_seconds := cooldown_text::integer;
  END IF;
  spin_time := clock_timestamp();
  IF cooldown_seconds > 0 THEN
    SELECT s.created_at INTO last_spin FROM public.royal_roulette_spins s
     WHERE s.guild_id = trim(p_guild_id) AND s.user_id = trim(p_user_id)
     ORDER BY s.created_at DESC LIMIT 1;
    IF last_spin IS NOT NULL AND spin_time < last_spin + cooldown_seconds * interval '1 second' THEN
      RAISE EXCEPTION 'Aguarde o cooldown da roleta antes de girar novamente';
    END IF;
  END IF;

  -- pgcrypto pode estar no schema public ou extensions no Supabase. A amostra
  -- criptográfica de 64 bits usa rejeição para eliminar viés de módulo.
  SELECT n.nspname INTO crypto_schema FROM pg_catalog.pg_extension e
  JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace WHERE e.extname = 'pgcrypto';
  IF crypto_schema IS NULL THEN RAISE EXCEPTION 'A extensão pgcrypto é necessária para a roleta'; END IF;
  random_ceiling := floor(18446744073709551616::numeric / total) * total;
  LOOP
    EXECUTE format('SELECT %I.gen_random_bytes(8)', crypto_schema) INTO random_bytes;
    random_integer := 0;
    FOR byte_index IN 0..7 LOOP
      random_integer := random_integer * 256 + get_byte(random_bytes, byte_index);
    END LOOP;
    EXIT WHEN random_integer < random_ceiling;
  END LOOP;
  -- Mesma amostra para todos os intervalos: P(prêmio) = peso / soma dos pesos.
  pick := mod(random_integer, total);
  FOR p IN SELECT rp.* FROM public.royal_roulette_prizes rp
            WHERE rp.id = ANY(eligible_ids) ORDER BY rp.id LOOP
    acc := acc + p.weight;
    IF pick < acc THEN selected_id := p.id; EXIT; END IF;
  END LOOP;
  IF selected_id IS NULL THEN RAISE EXCEPTION 'Falha ao selecionar prêmio da roleta'; END IF;
  SELECT * INTO p FROM public.royal_roulette_prizes rp WHERE rp.id = selected_id;
  IF p.reward_type IN ('coins', 'spins') THEN
    IF p.reward_value !~ '^[0-9]+$' THEN RAISE EXCEPTION 'Recompensa de saldo inválida'; END IF;
    reward_amount := p.reward_value::bigint;
  ELSIF p.reward_type = 'pix' THEN
    IF p.reward_value !~ '^[0-9]+([.][0-9]{1,2})?$' THEN
      RAISE EXCEPTION 'Valor PIX inválido';
    END IF;
    IF p.reward_value::numeric <= 0 THEN
      RAISE EXCEPTION 'Valor PIX inválido';
    END IF;
  ELSIF p.reward_type = 'role' AND NULLIF(trim(p.reward_value), '') IS NULL THEN
    RAISE EXCEPTION 'Cargo de prêmio inválido';
  ELSIF p.reward_type = 'shop_item' THEN
    -- A variável item usada no cálculo de elegibilidade pode apontar para outro
    -- candidato; recarrega o item escolhido, cujo lock já está adquirido.
    SELECT * INTO item FROM public.royal_shop_items i
     WHERE i.id = trim(p.reward_value)::uuid AND i.guild_id = trim(p_guild_id);
    IF NOT FOUND OR NOT item.active OR (item.stock IS NOT NULL AND item.stock < 1) THEN
      RAISE EXCEPTION 'Item de prêmio da roleta indisponível';
    END IF;
  END IF;

  UPDATE public.royal_profiles SET spins = spins - 1, updated_at = now()
   WHERE guild_id = trim(p_guild_id) AND user_id = trim(p_user_id) RETURNING * INTO r;
  INSERT INTO public.royal_wallet_ledger(guild_id, user_id, asset, amount, balance_after, reason, request_id)
  VALUES (trim(p_guild_id), trim(p_user_id), 'spins', -1, r.spins, 'roleta', trim(p_request_id) || ':debit');
  IF p.stock IS NOT NULL THEN
    UPDATE public.royal_roulette_prizes SET stock = stock - 1 WHERE id = p.id;
  END IF;
  INSERT INTO public.royal_roulette_spins(guild_id, user_id, prize_id, request_id, created_at,
                                          prize_name_snapshot, reward_type_snapshot, reward_value_snapshot)
  VALUES (trim(p_guild_id), trim(p_user_id), p.id, trim(p_request_id), spin_time,
          p.name, p.reward_type, p.reward_value) RETURNING id INTO result_id;

  IF p.reward_type = 'coins' THEN
    UPDATE public.royal_profiles SET coins = coins + reward_amount, updated_at = now()
     WHERE guild_id = trim(p_guild_id) AND user_id = trim(p_user_id) RETURNING coins INTO new_balance;
    INSERT INTO public.royal_wallet_ledger(guild_id,user_id,asset,amount,balance_after,reason,request_id)
    VALUES (trim(p_guild_id),trim(p_user_id),'coins',reward_amount,new_balance,'prêmio roleta',trim(p_request_id)||':reward');
  ELSIF p.reward_type = 'spins' THEN
    UPDATE public.royal_profiles SET spins = spins + reward_amount, updated_at = now()
     WHERE guild_id = trim(p_guild_id) AND user_id = trim(p_user_id) RETURNING spins INTO new_balance;
    INSERT INTO public.royal_wallet_ledger(guild_id,user_id,asset,amount,balance_after,reason,request_id)
    VALUES (trim(p_guild_id),trim(p_user_id),'spins',reward_amount,new_balance,'prêmio roleta',trim(p_request_id)||':reward');
  ELSIF p.reward_type = 'shop_item' THEN
    -- Este tipo continua concedendo inventário, como antes; não executa a compra.
    IF item.stock IS NOT NULL THEN
      UPDATE public.royal_shop_items SET stock = stock - 1, updated_at = now()
       WHERE id = item.id AND guild_id = trim(p_guild_id);
    END IF;
    INSERT INTO public.royal_inventory(guild_id,user_id,item_id,quantity)
    VALUES (trim(p_guild_id),trim(p_user_id),item.id,1)
    ON CONFLICT(guild_id,user_id,item_id) DO UPDATE
      SET quantity = public.royal_inventory.quantity + 1, updated_at = now();
  ELSIF p.reward_type IN ('role', 'pix') THEN
    -- PIX é apenas uma pendência para tratamento pela staff, não um pagamento.
    INSERT INTO public.royal_reward_deliveries(guild_id,request_id,user_id,reward_type,reward_value)
    VALUES (trim(p_guild_id),trim(p_request_id),trim(p_user_id),p.reward_type,p.reward_value);
  END IF;
  RETURN QUERY SELECT result_id, p.id, p.name, p.reward_type, p.reward_value;
END $$;

-- metadata.max_per_user ausente/null/0 significa ilimitado. Um inteiro positivo
-- limita compras não canceladas deste item por usuário. O lock do item precede
-- a contagem, serializando chamadas concorrentes da própria RPC; replay não
-- reavalia o limite nem debita novamente.
CREATE INDEX IF NOT EXISTS royal_purchases_item_user_status_idx
  ON public.royal_purchases (guild_id, item_id, user_id, status);
CREATE OR REPLACE FUNCTION public.royal_buy_item(p_guild_id text,p_user_id text,p_item_id uuid,p_request_id text)
RETURNS TABLE(purchase_id uuid,item_name text,new_balance bigint,status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  i public.royal_shop_items%ROWTYPE;
  r public.royal_profiles%ROWTYPE;
  q public.royal_purchases%ROWTYPE;
  already record;
  reward_amount bigint;
  new_balance_value bigint;
  purchase_status text;
  max_text text;
  max_per_user bigint;
  purchase_count bigint;
BEGIN
  IF NULLIF(trim(p_guild_id), '') IS NULL OR NULLIF(trim(p_user_id), '') IS NULL THEN
    RAISE EXCEPTION 'Servidor e usuário são obrigatórios';
  END IF;
  IF NULLIF(trim(p_request_id), '') IS NULL OR length(trim(p_request_id)) < 8 THEN
    RAISE EXCEPTION 'request_id inválido';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(trim(p_guild_id)||':buy:'||trim(p_request_id),0));
  SELECT q0.id AS purchase_id, i0.name AS item_name, r0.coins AS new_balance,
         q0.status, q0.user_id, q0.item_id
    INTO already FROM public.royal_purchases q0
    JOIN public.royal_shop_items i0 ON i0.id=q0.item_id
    JOIN public.royal_profiles r0 ON r0.guild_id=q0.guild_id AND r0.user_id=q0.user_id
   WHERE q0.guild_id=trim(p_guild_id) AND q0.request_id=trim(p_request_id);
  IF FOUND THEN
    IF already.user_id <> trim(p_user_id) OR already.item_id <> p_item_id THEN
      RAISE EXCEPTION 'request_id reutilizado para outro usuário ou item';
    END IF;
    RETURN QUERY SELECT already.purchase_id,already.item_name,already.new_balance,already.status;
    RETURN;
  END IF;

  SELECT * INTO i FROM public.royal_shop_items
   WHERE id=p_item_id AND guild_id=trim(p_guild_id) AND active FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Item indisponível'; END IF;
  max_text := i.metadata->>'max_per_user';
  IF max_text IS NOT NULL THEN
    max_text := trim(max_text);
    IF max_text !~ '^[0-9]{1,9}$' THEN RAISE EXCEPTION 'Limite por usuário inválido'; END IF;
    max_per_user := max_text::bigint;
    IF max_per_user > 0 THEN
      SELECT count(*) INTO purchase_count FROM public.royal_purchases q0
       WHERE q0.guild_id=trim(p_guild_id) AND q0.user_id=trim(p_user_id)
         AND q0.item_id=i.id AND q0.status <> 'cancelled';
      IF purchase_count >= max_per_user THEN RAISE EXCEPTION 'Limite de compras por usuário atingido'; END IF;
    END IF;
  END IF;
  INSERT INTO public.royal_profiles(guild_id,user_id) VALUES(trim(p_guild_id),trim(p_user_id)) ON CONFLICT DO NOTHING;
  SELECT * INTO r FROM public.royal_profiles WHERE guild_id=trim(p_guild_id) AND user_id=trim(p_user_id) FOR UPDATE;
  IF r.coins<i.price THEN RAISE EXCEPTION 'Saldo insuficiente'; END IF;
  IF i.stock IS NOT NULL AND i.stock<1 THEN RAISE EXCEPTION 'Item sem estoque'; END IF;
  UPDATE public.royal_profiles SET coins=coins-i.price,updated_at=now()
   WHERE guild_id=trim(p_guild_id) AND user_id=trim(p_user_id) RETURNING * INTO r;
  IF i.stock IS NOT NULL THEN UPDATE public.royal_shop_items SET stock=stock-1,updated_at=now() WHERE id=i.id; END IF;
  purchase_status := CASE WHEN i.reward_type IN ('pix','physical','role') THEN 'pending' ELSE 'completed' END;
  INSERT INTO public.royal_purchases(guild_id,user_id,item_id,price,request_id,status)
  VALUES(trim(p_guild_id),trim(p_user_id),i.id,i.price,trim(p_request_id),purchase_status) RETURNING * INTO q;
  INSERT INTO public.royal_inventory(guild_id,user_id,item_id,quantity)
  VALUES(trim(p_guild_id),trim(p_user_id),i.id,1)
  ON CONFLICT(guild_id,user_id,item_id) DO UPDATE SET quantity=public.royal_inventory.quantity+1,updated_at=now();
  INSERT INTO public.royal_wallet_ledger(guild_id,user_id,asset,amount,balance_after,reason,request_id)
  VALUES(trim(p_guild_id),trim(p_user_id),'coins',-i.price,r.coins,'compra:'||i.slug,trim(p_request_id)||':debit');
  IF i.reward_type IN ('coins','spins') THEN
    reward_amount := i.reward_value::bigint;
    IF reward_amount < 0 THEN RAISE EXCEPTION 'Recompensa de saldo inválida'; END IF;
    IF i.reward_type='coins' THEN
      UPDATE public.royal_profiles SET coins=coins+reward_amount,updated_at=now()
       WHERE guild_id=trim(p_guild_id) AND user_id=trim(p_user_id) RETURNING coins INTO new_balance_value;
      INSERT INTO public.royal_wallet_ledger(guild_id,user_id,asset,amount,balance_after,reason,request_id)
      VALUES(trim(p_guild_id),trim(p_user_id),'coins',reward_amount,new_balance_value,'recompensa loja:'||i.slug,trim(p_request_id)||':reward');
    ELSE
      UPDATE public.royal_profiles SET spins=spins+reward_amount,updated_at=now()
       WHERE guild_id=trim(p_guild_id) AND user_id=trim(p_user_id) RETURNING spins INTO new_balance_value;
      INSERT INTO public.royal_wallet_ledger(guild_id,user_id,asset,amount,balance_after,reason,request_id)
      VALUES(trim(p_guild_id),trim(p_user_id),'spins',reward_amount,new_balance_value,'recompensa loja:'||i.slug,trim(p_request_id)||':reward');
    END IF;
    SELECT * INTO r FROM public.royal_profiles WHERE guild_id=trim(p_guild_id) AND user_id=trim(p_user_id);
  END IF;
  RETURN QUERY SELECT q.id,i.name,r.coins,q.status;
END $$;

REVOKE EXECUTE ON FUNCTION public.royal_apply_match_result(text,text,integer,bigint,text,jsonb) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.royal_spin(text,text,text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.royal_buy_item(text,text,uuid,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.royal_apply_match_result(text,text,integer,bigint,text,jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.royal_spin(text,text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.royal_buy_item(text,text,uuid,text) TO service_role;

COMMIT;
