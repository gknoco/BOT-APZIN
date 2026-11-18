-- Executado exclusivamente em um banco PostgreSQL temporário e vazio.
\set ON_ERROR_STOP on
begin;
insert into public.royal_profiles(guild_id,user_id,coins,spins)
values ('teste','jogador',20,2), ('outro','jogador',99,9);
insert into public.discord_configuracoes(guild_id,chave,valor)
values ('teste','roleta_cooldown_segundos','0');

-- Uma vitória rende um coin uma única vez, inclusive em caso de repetição da entrega.
select public.royal_apply_match_result('teste','partida-1',1,500,'normal',
  '[{"user_id":"jogador","team":1,"confirmed":true},{"user_id":"adversario","team":2,"confirmed":true}]'::jsonb);
select public.royal_apply_match_result('teste','partida-1',1,500,'normal',
  '[{"user_id":"jogador","team":1,"confirmed":true},{"user_id":"adversario","team":2,"confirmed":true}]'::jsonb);
do $$ begin
  if not exists (select 1 from public.royal_profiles where guild_id='teste' and user_id='jogador' and coins=21 and spins=2 and wins=1) then
    raise exception 'Vitória não creditou exatamente um coin ou não foi idempotente';
  end if;
  if not exists (select 1 from public.royal_profiles where guild_id='outro' and user_id='jogador' and coins=99 and spins=9) then
    raise exception 'Carteira de outra guild foi modificada';
  end if;
end $$;

-- Sorteio de peso único: transação, extrato e repetição não podem duplicar.
insert into public.royal_roulette_prizes(id,guild_id,name,reward_type,reward_value,weight)
values ('11111111-1111-4111-8111-111111111111','teste','Prêmio moedas','coins','3',1);
select * from public.royal_spin('teste','jogador','spin:teste-0001');
select * from public.royal_spin('teste','jogador','spin:teste-0001');
do $$ begin
  if not exists (select 1 from public.royal_profiles where guild_id='teste' and user_id='jogador' and coins=24 and spins=1) then
    raise exception 'Roleta não debitou um giro e creditou três coins exatamente uma vez';
  end if;
  if (select count(*) from public.royal_roulette_spins where guild_id='teste' and user_id='jogador') <> 1 then
    raise exception 'Repetição registrou sorteio duplicado';
  end if;
end $$;

-- Compra transacional: estoque, saldo, giros e inventário se movem juntos.
insert into public.royal_shop_items(id,guild_id,slug,name,price,reward_type,reward_value,stock)
values ('22222222-2222-4222-8222-222222222222','teste','giro','Giro extra',5,'spins','1',1);
select * from public.royal_buy_item('teste','jogador','22222222-2222-4222-8222-222222222222','buy:teste-0001');
select * from public.royal_buy_item('teste','jogador','22222222-2222-4222-8222-222222222222','buy:teste-0001');
do $$ begin
  if not exists (select 1 from public.royal_profiles where guild_id='teste' and user_id='jogador' and coins=19 and spins=2) then
    raise exception 'Compra debitou/creditou valores incorretos ou duplicados';
  end if;
  if not exists (select 1 from public.royal_shop_items where id='22222222-2222-4222-8222-222222222222' and stock=0) then
    raise exception 'Estoque não foi reduzido exatamente uma vez';
  end if;
  if not exists (select 1 from public.royal_inventory where guild_id='teste' and user_id='jogador' and quantity=1) then
    raise exception 'Inventário não registrado';
  end if;
  begin
    perform * from public.royal_buy_item('teste','jogador','22222222-2222-4222-8222-222222222222','buy:teste-0002');
    raise exception 'Compra de item esgotado deveria falhar';
  exception when raise_exception then
    if sqlerrm = 'Compra de item esgotado deveria falhar' then raise; end if;
  end;
end $$;

-- PIX é obrigação pendente, nunca um pagamento automaticamente comprovado.
update public.royal_roulette_prizes set active=false where guild_id='teste';
insert into public.royal_roulette_prizes(id,guild_id,name,reward_type,reward_value,weight)
values ('33333333-3333-4333-8333-333333333333','teste','PIX pendente','pix','5.00',1);
select * from public.royal_spin('teste','jogador','spin:teste-0002');
do $$ begin
  if not exists (select 1 from public.royal_reward_deliveries where guild_id='teste' and user_id='jogador' and reward_type='pix' and status='pending') then
    raise exception 'PIX não foi registrado como pendente';
  end if;
  if has_function_privilege('anon','public.royal_spin(text,text,text)','execute') or
     has_function_privilege('authenticated','public.royal_buy_item(text,text,uuid,text)','execute') then
    raise exception 'RPC financeira acessível indevidamente a usuários anônimos/autenticados';
  end if;
end $$;
rollback;
\echo 'Testes de economia no PostgreSQL isolado concluídos.'
