-- Segurança v4: as tabelas persistentes do bot são acessíveis pelo backend
-- autenticado com service_role; anon/authenticated não recebem privilégios.
-- service_role tem BYPASSRLS no Supabase, e a policy explicita a intenção caso
-- essa role seja usada por um cliente com RLS aplicado.

do $$
declare
  t record;
begin
  for t in
    select tablename
      from pg_tables
     where schemaname = 'public'
       and tablename in (
         'discord_configuracoes',
         'discord_versiculos',
         'discord_versiculos_usados',
         'royal_profiles',
         'royal_wallet_ledger',
         'royal_shop_items',
         'royal_purchases',
         'royal_inventory',
         'royal_roulette_prizes',
         'royal_roulette_spins',
         'royal_invites',
         'royal_audit_events',
         'royal_match_records',
         'royal_match_players',
         'royal_pix_keys',
         'royal_guild_configs',
         'royal_pix_mutations',
         'royal_economy_requests',
         'royal_match_stats_applied',
         'royal_reward_deliveries'
       )
  loop
    execute format('alter table public.%I enable row level security', t.tablename);
    if not exists (
      select 1
        from pg_policies
       where schemaname = 'public'
         and tablename = t.tablename
         and policyname = 'service_role_full_access'
    ) then
      execute format(
        'create policy service_role_full_access on public.%I for all to service_role using (auth.role() = ''service_role'') with check (auth.role() = ''service_role'')',
        t.tablename
      );
    end if;
  end loop;
end
$$;

revoke all privileges on all tables in schema public from anon, authenticated;
grant all privileges on all tables in schema public to service_role;
revoke all privileges on all sequences in schema public from anon, authenticated;
grant all privileges on all sequences in schema public to service_role;

alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public grant all on sequences to service_role;
