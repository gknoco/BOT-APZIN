#!/usr/bin/env python3
"""Testa resgate em PostgreSQL temporário local; não usa credenciais ou rede externa.

Requer PostgreSQL com pg_config, initdb, pg_ctl e psql. Executar como não-root:
    python3 testes/resgate_salas_sql.py
"""
import concurrent.futures
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / 'supabase' / 'migrations'
TARGET = '20261120000200_atomic_initial_room_redemption.sql'


def executable(name):
    return str(Path(subprocess.check_output(['pg_config', '--bindir'], text=True).strip()) / name)


class ResgateSalasSQL(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix='royal-redeem-pg-')
        cls.data = Path(cls.tmp) / 'data'
        cls.pg_ctl = executable('pg_ctl')
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        cls.env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
        cls.env.update(PGHOST=cls.tmp, PGPORT=str(port), PGUSER=os.environ.get('USER', 'ubuntu'), PGDATABASE='postgres')
        try:
            subprocess.run([executable('initdb'), '-D', str(cls.data), '-A', 'trust', '-U', cls.env['PGUSER'], '--no-locale', '-E', 'UTF8'], env=cls.env, check=True, capture_output=True, text=True)
            subprocess.run([cls.pg_ctl, '-D', str(cls.data), '-l', str(Path(cls.tmp) / 'server.log'), '-o', f"-F -k {cls.tmp} -p {port} -c listen_addresses=''", '-w', 'start'], env=cls.env, check=True, capture_output=True, text=True)
            cls.sql("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE FUNCTION auth.role() RETURNS text LANGUAGE SQL AS $$ SELECT 'service_role'::text $$;")
            for path in sorted(MIGRATIONS.glob('*.sql')):
                if path.name < TARGET:
                    cls.file(path)
            # Estados produzidos pelas versões anteriores, ANTES do corte.
            cls.sql("""
              INSERT INTO royal_room_wallets(guild_id,user_id,purchased_rooms) VALUES
                ('legacy-direct','u',10),('legacy-marker','u',10),('legacy-ambiguous','u',10),
                ('legacy-purchase','u',5),('legacy-rpc','u',10);
              INSERT INTO royal_room_ledger(guild_id,user_id,request_id,event_type,delta_rooms,detail) VALUES
                ('legacy-direct','u','old-direct','admin_grant',10,'{"source":"initial_redemption_direct_fallback","rooms_quantity":10}'),
                ('legacy-rpc','u','old-rpc','admin_grant',10,'{"source":"initial_redemption","rooms_quantity":10}'),
                ('legacy-invalid-ledger','u','old-invalid','admin_grant',0,'{"source":"initial_redemption_direct_fallback"}'),
                ('legacy-purchase','u','old-purchase','purchase',5,'{}');
              INSERT INTO royal_room_initial_redemptions(guild_id,user_id,request_id,rooms_quantity)
                VALUES ('legacy-marker','u','marker-without-ledger',10),
                       ('legacy-marker-no-wallet','u','marker-without-wallet',10);
              INSERT INTO royal_mediator_room_quotas(guild_id,user_id,salas_disponiveis,resgate_inicial_realizado)
                VALUES ('legacy-quota','u',4,true);
              -- Privilégios por coluna sobrevivem ao REVOKE da tabela.
              GRANT UPDATE (purchased_rooms) ON royal_room_wallets TO service_role;
              GRANT INSERT (guild_id) ON royal_room_ledger TO PUBLIC;
            """)
            cls.file(MIGRATIONS / TARGET)
            cls.file(MIGRATIONS / TARGET)
        except Exception:
            cls.tearDownClass()
            raise

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls, 'data') and cls.data.exists():
            subprocess.run([cls.pg_ctl, '-D', str(cls.data), '-m', 'immediate', '-w', 'stop'], env=cls.env, capture_output=True, text=True)
        if hasattr(cls, 'tmp'):
            shutil.rmtree(cls.tmp, ignore_errors=True)

    @classmethod
    def run_psql(cls, *args, database='postgres'):
        env = dict(cls.env, PGDATABASE=database)
        return subprocess.run([executable('psql'), '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', *args], env=env, capture_output=True, text=True, timeout=20)

    @classmethod
    def sql(cls, command, database='postgres'):
        p = cls.run_psql('-c', command, database=database)
        if p.returncode:
            raise AssertionError(f'SQL falhou: {p.stderr}\n{command}')
        return p.stdout.strip()

    @classmethod
    def file(cls, path, database='postgres'):
        p = cls.run_psql('-f', str(path), database=database)
        if p.returncode:
            raise AssertionError(f'Migração {path.name} falhou: {p.stderr}')

    def fails(self, command, message):
        p = self.run_psql('-c', command)
        self.assertNotEqual(p.returncode, 0, p.stdout)
        self.assertIn(message, p.stderr)

    @staticmethod
    def redeem(guild, request=None, qty=10, user='u'):
        return f"SELECT public.royal_room_credit_initial_redemption('{guild}','{user}','{request or 'initial-redeem:' + guild + ':' + user}',{qty})"

    @staticmethod
    def grant(guild, request, qty=10, user='u', actor='adm'):
        return f"SELECT public.royal_room_admin_grant('{guild}','{user}','{request}',{qty},'{actor}')"

    def call(self, command):
        return json.loads(self.sql(command))

    def service(self, command):
        return json.loads(self.sql('SET ROLE service_role; ' + command))

    def state(self, guild):
        return self.sql(f"""SELECT COALESCE((SELECT purchased_rooms::text FROM royal_room_wallets WHERE guild_id='{guild}' AND user_id='u'),'none') || ':' ||
          (SELECT count(*) FROM royal_room_ledger WHERE guild_id='{guild}' AND user_id='u') || ':' ||
          (SELECT count(*) FROM royal_room_initial_redemptions WHERE guild_id='{guild}' AND user_id='u')""")

    def test_01_success_replay_and_sign(self):
        first = self.call(self.redeem('normal'))
        self.assertEqual((first['redeemed'], first['available_rooms']), (True, 10))
        second = self.call(self.redeem('normal', 'different-request', 99))
        self.assertEqual((second['redeemed'], second['idempotent'], second['available_rooms']), (False, True, 10))
        self.assertEqual(self.state('normal'), '10:1:1')
        self.sql("UPDATE royal_room_wallets SET reserved_rooms=1,consumed_rooms=2,reversed_rooms=4 WHERE guild_id='normal'")
        self.assertEqual(self.call(self.redeem('normal'))['available_rooms'], 3)
        self.assertEqual(self.call("SELECT royal_room_stats('normal','u')")['available_rooms'], 3)
        self.sql("UPDATE royal_room_wallets SET reversed_rooms=12 WHERE guild_id='normal'")
        self.assertEqual(self.call(self.redeem('normal'))['available_rooms'], -5)
        self.assertEqual(self.call("SELECT royal_room_stats('normal','u')")['available_rooms'], -5)
        self.fails("SELECT royal_room_reserve_room('normal','u','usage-negative','nix_command',NULL)", 'INSUFFICIENT_ROOM_CREDITS')
        self.sql("UPDATE royal_room_wallets SET is_frozen=true WHERE guild_id='normal'")
        self.assertEqual(self.call(self.redeem('normal'))['available_rooms'], 0)
        self.assertEqual(self.call("SELECT royal_room_stats('normal','u')")['available_rooms'], 0)
        self.fails("SELECT royal_room_reserve_room('normal','u','usage-frozen','nix_command',NULL)", 'ROOM_WALLET_FROZEN_FOR_REVIEW')
        # O primeiro resgate também subtrai estornos e preserva resultado negativo.
        self.call(self.grant('new-negative', 'new-negative-grant', 5))
        self.sql("UPDATE royal_room_wallets SET reserved_rooms=1,consumed_rooms=2,reversed_rooms=20 WHERE guild_id='new-negative'")
        self.assertEqual(self.call(self.redeem('new-negative'))['available_rooms'], -8)
        self.assertEqual(self.call("SELECT royal_room_stats('new-negative','u')")['available_rooms'], -8)

    def test_02_grant_sign_replay_and_collisions(self):
        self.assertEqual(self.call(self.grant('admin', 'grant-1', 20))['balance_rooms'], 20)
        self.sql("UPDATE royal_room_wallets SET reserved_rooms=2,consumed_rooms=3,reversed_rooms=5 WHERE guild_id='admin'")
        self.assertEqual(self.call(self.grant('admin', 'grant-1', 20))['balance_rooms'], 10)
        self.assertEqual(self.call(self.grant('admin', 'grant-2', 5))['balance_rooms'], 15)
        self.assertEqual(self.call("SELECT royal_room_stats('admin','u')")['available_rooms'], 15)
        reserved = self.call("SELECT royal_room_reserve_room('admin','u','usage-admin','nix_command',NULL)")
        self.assertEqual(reserved['available_rooms'], 14)
        self.assertEqual(self.call(self.grant('admin', 'grant-2', 5))['balance_rooms'], 14)
        self.fails(self.grant('admin', 'grant-2', 6), 'ADMIN_GRANT_REQUEST_CONFLICT')
        self.fails(self.grant('other', 'grant-2', 5), 'ADMIN_GRANT_REQUEST_CONFLICT')
        self.fails(self.redeem('other', 'grant-2'), 'INITIAL_ROOM_REQUEST_CONFLICT')
        self.sql("UPDATE royal_room_wallets SET is_frozen=true WHERE guild_id='admin'")
        self.assertEqual(self.call(self.grant('admin', 'grant-3', 1))['balance_rooms'], 0)
        self.assertEqual(self.call(self.grant('admin', 'grant-3', 1))['balance_rooms'], 0)

    def test_03_failure_after_wallet_before_ledger_rolls_back(self):
        self.sql("""CREATE FUNCTION pg_temp_dummy() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.guild_id = 'fail-ledger' THEN RAISE EXCEPTION 'INJECTED_LEDGER_FAILURE'; END IF; RETURN NEW; END $$;
          CREATE TRIGGER inject_ledger_failure BEFORE INSERT ON royal_room_ledger FOR EACH ROW EXECUTE FUNCTION pg_temp_dummy();""")
        try:
            self.fails(self.redeem('fail-ledger'), 'INJECTED_LEDGER_FAILURE')
            self.assertEqual(self.state('fail-ledger'), 'none:0:0')
        finally:
            self.sql('DROP TRIGGER inject_ledger_failure ON royal_room_ledger; DROP FUNCTION pg_temp_dummy()')
        self.assertTrue(self.call(self.redeem('fail-ledger'))['redeemed'])
        self.assertEqual(self.state('fail-ledger'), '10:1:1')
        # Erro na inserção do marcador também não deve mudar carteira nem ledger.
        self.fails(self.redeem('collision', 'initial-redeem:fail-ledger:u'), 'INITIAL_ROOM_REQUEST_CONFLICT')
        self.assertEqual(self.state('collision'), 'none:0:0')

    def test_04_many_parallel_replays_and_distinct_requests(self):
        commands = [self.redeem('parallel', f'parallel-{i}') for i in range(16)]
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            results = list(pool.map(lambda c: self.run_psql('-c', "SET statement_timeout='10s'; " + c), commands))
        self.assertTrue(all(p.returncode == 0 for p in results), [p.stderr for p in results])
        data = [json.loads(p.stdout.strip()) for p in results]
        self.assertEqual(sum(int(d['redeemed']) for d in data), 1)
        self.assertEqual(self.state('parallel'), '10:1:1')
        commands = [self.grant('parallel-grant', 'grant-parallel', 5) for _ in range(12)]
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            results = list(pool.map(lambda c: self.run_psql('-c', "SET statement_timeout='10s'; " + c), commands))
        self.assertTrue(all(p.returncode == 0 for p in results), [p.stderr for p in results])
        self.assertEqual(sum(not json.loads(p.stdout.strip())['idempotent'] for p in results), 1)
        self.assertEqual(self.state('parallel-grant'), '5:1:0')

        # Mesmo request entre identidades distintas: uma única transação vence;
        # se a constraint global falhar na outra, nenhum saldo parcial permanece.
        commands = [self.redeem('cross-a', 'cross-request'), self.redeem('cross-b', 'cross-request')]
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda c: self.run_psql('-c', "SET statement_timeout='10s'; " + c), commands))
        self.assertEqual(sum(p.returncode == 0 for p in results), 1, [p.stderr for p in results])
        self.assertEqual(self.sql("SELECT count(*) FROM royal_room_initial_redemptions WHERE guild_id IN ('cross-a','cross-b')"), '1')
        self.assertEqual(self.sql("SELECT coalesce(sum(purchased_rooms),0) FROM royal_room_wallets WHERE guild_id IN ('cross-a','cross-b')"), '10')
        self.assertEqual(self.sql("SELECT count(*) FROM royal_room_ledger WHERE guild_id IN ('cross-a','cross-b')"), '1')

        # Grant e resgate para a mesma carteira coexistem sem sobrescrever saldo.
        commands = [self.grant('parallel-mixed', 'parallel-mixed-grant', 5), self.redeem('parallel-mixed')]
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda c: self.run_psql('-c', "SET statement_timeout='10s'; " + c), commands))
        self.assertTrue(all(p.returncode == 0 for p in results), [p.stderr for p in results])
        self.assertEqual(self.state('parallel-mixed'), '15:2:1')

    def test_05_legacy_is_conservative_and_does_not_recredit(self):
        for guild in ['legacy-direct', 'legacy-rpc', 'legacy-marker']:
            self.assertFalse(self.call(self.redeem(guild))['redeemed'])
            self.assertEqual(self.state(guild).split(':')[0], '10')
        self.assertEqual(self.state('legacy-direct'), '10:1:1')
        self.assertEqual(self.state('legacy-marker'), '10:0:1')
        self.assertEqual(self.call(self.redeem('legacy-marker-no-wallet'))['available_rooms'], 0)
        self.assertEqual(self.state('legacy-marker-no-wallet'), 'none:0:1')
        for guild in ['legacy-ambiguous', 'legacy-purchase', 'legacy-quota', 'legacy-invalid-ledger']:
            self.fails(self.redeem(guild), 'INITIAL_ROOM_REDEMPTION_REVIEW_REQUIRED')
        self.assertEqual(self.state('legacy-ambiguous'), '10:0:0')
        self.assertEqual(self.state('legacy-purchase'), '5:1:0')
        self.assertEqual(self.state('legacy-quota'), 'none:0:0')
        # As carteiras criadas após o corte não são colocadas em revisão na reaplicação.
        self.call(self.grant('post-cutover', 'post-cutover-grant', 5))
        self.file(MIGRATIONS / TARGET)
        self.assertTrue(self.call(self.redeem('post-cutover'))['redeemed'])
        self.assertEqual(self.state('post-cutover'), '15:2:1')

    def test_06_rls_and_privileges(self):
        self.assertEqual(self.sql("SELECT relrowsecurity FROM pg_class WHERE oid='public.royal_room_initial_redemptions'::regclass"), 't')
        self.assertEqual(self.sql("SELECT relrowsecurity FROM pg_class WHERE oid='public.royal_room_initial_redemption_reviews'::regclass"), 't')
        fn = 'public.royal_room_credit_initial_redemption(text,text,text,bigint)'
        self.assertEqual(self.sql(f"SELECT has_function_privilege('anon','{fn}','EXECUTE')||':'||has_function_privilege('authenticated','{fn}','EXECUTE')||':'||has_function_privilege('service_role','{fn}','EXECUTE')"), 'false:false:true')
        self.assertEqual(self.sql(f"SELECT prosecdef||':'||array_to_string(proconfig,',') FROM pg_proc WHERE oid='{fn}'::regprocedure"), 'true:search_path=pg_catalog, public, pg_temp')
        for role in ['anon', 'authenticated']:
            self.fails('SET ROLE ' + role + '; ' + self.redeem('no-perms'), 'permission denied')
            self.fails('SET ROLE ' + role + '; SELECT * FROM royal_room_initial_redemptions', 'permission denied')
            self.fails('SET ROLE ' + role + '; SELECT * FROM royal_room_initial_redemption_reviews', 'permission denied')
            self.fails('SET ROLE ' + role + '; SELECT * FROM royal_room_wallets', 'permission denied')
            self.fails('SET ROLE ' + role + '; SELECT * FROM royal_room_ledger', 'permission denied')
        self.fails("SET ROLE service_role; INSERT INTO royal_room_initial_redemptions(guild_id,user_id,request_id) VALUES ('x','x','x')", 'permission denied')
        self.fails("SET ROLE service_role; DELETE FROM royal_room_initial_redemption_reviews", 'permission denied')
        self.assertTrue(json.loads(self.sql('SET ROLE service_role; ' + self.redeem('perms')))['redeemed'])
        self.assertEqual(self.sql("SET ROLE service_role; SELECT count(*) FROM royal_room_initial_redemptions WHERE guild_id='perms'"), '1')
        for table in ['royal_room_wallets', 'royal_room_ledger', 'royal_room_initial_redemptions', 'royal_room_initial_redemption_reviews']:
            for privilege in ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']:
                self.assertEqual(self.sql(f"SELECT has_table_privilege('service_role','public.{table}','{privilege}')"), 'f')
            for privilege in ['INSERT', 'UPDATE', 'REFERENCES']:
                self.assertEqual(self.sql(f"SELECT count(*) FROM pg_attribute WHERE attrelid='public.{table}'::regclass AND attnum>0 AND NOT attisdropped AND has_column_privilege('service_role',attrelid,attnum,'{privilege}')"), '0')
        for command in [
            "INSERT INTO royal_room_wallets(guild_id,user_id) VALUES ('deny','u')",
            "UPDATE royal_room_wallets SET purchased_rooms=100 WHERE guild_id='perms'",
            "DELETE FROM royal_room_wallets WHERE guild_id='perms'",
            "TRUNCATE royal_room_wallets",
            "INSERT INTO royal_room_ledger(guild_id,user_id,request_id,event_type,delta_rooms) VALUES ('deny','u','deny-ledger','admin_grant',10)",
            "UPDATE royal_room_ledger SET delta_rooms=100 WHERE guild_id='perms'",
            "DELETE FROM royal_room_ledger WHERE guild_id='perms'",
            "TRUNCATE royal_room_ledger",
        ]:
            self.fails('SET ROLE service_role; ' + command, 'permission denied')

    def test_07_optional_legacy_table_and_migration_repeat(self):
        self.sql('CREATE DATABASE no_legacy_quotas')
        self.sql("CREATE SCHEMA auth; CREATE FUNCTION auth.role() RETURNS text LANGUAGE SQL AS $$ SELECT 'service_role'::text $$", database='no_legacy_quotas')
        for path in sorted(MIGRATIONS.glob('*.sql')):
            if path.name < TARGET:
                self.file(path, database='no_legacy_quotas')
        self.sql('DROP TABLE public.royal_mediator_room_quotas', database='no_legacy_quotas')
        self.file(MIGRATIONS / TARGET, database='no_legacy_quotas')
        self.file(MIGRATIONS / TARGET, database='no_legacy_quotas')
        self.assertTrue(json.loads(self.sql(self.redeem('no-legacy'), database='no_legacy_quotas'))['redeemed'])

    def test_08_quarantine_precedes_late_ledger_without_losing_anti_recredit(self):
        self.assertEqual(self.state('legacy-ambiguous'), '10:0:0')
        self.fails('SET ROLE service_role; ' + self.redeem('legacy-ambiguous'), 'INITIAL_ROOM_REDEMPTION_REVIEW_REQUIRED')
        # Exatamente os dois passos de escrita do fallback antigo: ambos negados.
        self.fails("""SET ROLE service_role; INSERT INTO royal_room_wallets
          (guild_id,user_id,purchased_rooms,reserved_rooms,consumed_rooms,reversed_rooms)
          VALUES ('legacy-ambiguous','u',20,0,0,0)
          ON CONFLICT (guild_id,user_id) DO UPDATE SET purchased_rooms=EXCLUDED.purchased_rooms""", 'permission denied')
        self.fails("""SET ROLE service_role; INSERT INTO royal_room_ledger
          (guild_id,user_id,request_id,event_type,delta_rooms,detail)
          VALUES ('legacy-ambiguous','u','old-late','admin_grant',10,
                  '{"source":"initial_redemption_direct_fallback"}')""", 'permission denied')
        self.assertEqual(self.state('legacy-ambiguous'), '10:0:0')

        # Mesmo se uma importação privilegiada inserir ledger depois do corte,
        # a RPC não pode considerar replay e esconder a revisão aberta.
        self.sql("""INSERT INTO royal_room_ledger(guild_id,user_id,request_id,event_type,delta_rooms,detail)
          VALUES ('legacy-ambiguous','u','import-after-cut','admin_grant',10,
                  '{"source":"initial_redemption_direct_fallback"}')""")
        self.fails('SET ROLE service_role; ' + self.redeem('legacy-ambiguous'), 'INITIAL_ROOM_REDEMPTION_REVIEW_REQUIRED')
        self.assertEqual(self.state('legacy-ambiguous'), '10:1:0')
        # Simula conclusão administrativa após conferência de lastro; não ajusta
        # saldo. Quando liberado, o ledger impede uma segunda concessão.
        self.sql("DELETE FROM royal_room_initial_redemption_reviews WHERE guild_id='legacy-ambiguous' AND user_id='u'")
        result = self.service(self.redeem('legacy-ambiguous'))
        self.assertFalse(result['redeemed'])
        self.assertEqual(self.state('legacy-ambiguous'), '10:1:1')
        self.sql("INSERT INTO royal_room_initial_redemption_reviews(guild_id,user_id,reason) VALUES ('legacy-marker','u','manual')")
        self.fails('SET ROLE service_role; ' + self.redeem('legacy-marker'), 'INITIAL_ROOM_REDEMPTION_REVIEW_REQUIRED')

    def test_09_service_role_purchase_refund_reserve_and_freeze(self):
        order = self.service("SELECT royal_room_create_purchase('pix-rpc','u','pix-order',6,NULL,'u@example.com')")
        oid = order['id']
        approved = f"SELECT royal_room_apply_payment('{oid}','pay-pix','approved',18,'BRL','{oid}',0,NULL)"
        self.assertEqual(self.service(approved)['status'], 'approved')
        self.assertEqual(self.service(approved)['status'], 'approved')
        self.assertEqual(self.state('pix-rpc'), '6:1:0')
        self.assertEqual(self.service("SELECT royal_room_reserve_room('pix-rpc','u','use-1','nix_command',NULL)")['available_rooms'], 5)
        self.assertEqual(self.service("SELECT royal_room_settle_room('use-1','created','room',NULL,NULL)")['status'], 'created')
        self.assertEqual(self.service("SELECT royal_room_reserve_room('pix-rpc','u','use-2','nix_command',NULL)")['available_rooms'], 4)
        self.assertEqual(self.service("SELECT royal_room_settle_room('use-2','failed',NULL,NULL,'error')")['status'], 'failed')
        reversal = f"SELECT royal_room_apply_payment('{oid}','pay-pix','refunded',18,'BRL','{oid}',18,NULL)"
        self.assertEqual(self.service(reversal)['status'], 'refunded')
        self.assertEqual(self.service(reversal)['status'], 'refunded')
        self.assertEqual(self.service("SELECT royal_room_stats('pix-rpc','u')")['available_rooms'], -1)
        self.assertEqual(self.sql("SELECT purchased_rooms||':'||reserved_rooms||':'||consumed_rooms||':'||reversed_rooms FROM royal_room_wallets WHERE guild_id='pix-rpc'"), '6:0:1:6')
        self.assertEqual(self.sql("SELECT count(*) FROM royal_room_ledger WHERE guild_id='pix-rpc' AND event_type='reversed'"), '1')

        topup = self.service("SELECT royal_wallet_create_topup('wallet-rpc','u','topup-req',1000,'u@example.com')")
        tid = topup['id']
        self.assertEqual(self.service(f"SELECT royal_wallet_apply_topup_payment('{tid}','pay-topup','approved',1000,'BRL','{tid}','pix',0)")['balance_cents'], 1100)
        bought = self.service("SELECT royal_wallet_purchase_rooms('wallet-rpc','u','wallet-order',10,30)")
        self.assertEqual((bought['status'], bought['balance_cents']), ('approved', 1070))
        self.assertTrue(self.service("SELECT royal_wallet_purchase_rooms('wallet-rpc','u','wallet-order',10,30)")['idempotent'])
        self.assertEqual(self.state('wallet-rpc'), '10:1:0')
        self.service("SELECT royal_room_reserve_room('wallet-rpc','u','wallet-manual','nix_command',NULL)")
        self.assertEqual(self.service("SELECT royal_room_settle_room('wallet-manual','unknown',NULL,NULL,'timeout')")['status'], 'unknown')
        self.assertEqual(self.service("SELECT royal_room_resolve_usage('wallet-manual','created','operator','room',NULL,'confirmado')")['status'], 'created')
        refunded = self.service(f"SELECT royal_wallet_apply_topup_payment('{tid}','pay-topup','refunded',1000,'BRL','{tid}','pix',1000)")
        self.assertTrue(refunded['wallet_frozen'])
        self.assertEqual(self.sql("SELECT is_frozen FROM royal_room_wallets WHERE guild_id='wallet-rpc' AND user_id='u'"), 't')
        self.fails("SET ROLE service_role; SELECT royal_room_reserve_room('wallet-rpc','u','wallet-usage','nix_command',NULL)", 'ROOM_WALLET_FROZEN_FOR_REVIEW')

    def test_10_inherited_and_column_grants_fail_closed_without_revoking_others(self):
        self.sql("CREATE ROLE third_party_writer NOLOGIN; GRANT UPDATE (purchased_rooms) ON royal_room_wallets TO third_party_writer; GRANT third_party_writer TO service_role; ALTER ROLE service_role NOINHERIT")
        try:
            # Mesmo NOINHERIT pode usar SET ROLE; a migração não deve alterar
            # os privilégios do terceiro e deve reverter todos os seus passos.
            p = self.run_psql('-f', str(MIGRATIONS / TARGET))
            self.assertNotEqual(p.returncode, 0)
            self.assertIn('ROOM_DIRECT_WRITE_PRIVILEGE_UNSAFE', p.stderr)
            self.assertEqual(self.sql("SELECT has_column_privilege('third_party_writer','royal_room_wallets','purchased_rooms','UPDATE')"), 't')
            self.assertEqual(self.sql("SELECT has_table_privilege('service_role','royal_room_wallets','INSERT')"), 'f')
        finally:
            self.sql("REVOKE third_party_writer FROM service_role; REVOKE UPDATE (purchased_rooms) ON royal_room_wallets FROM third_party_writer; ALTER ROLE service_role INHERIT; DROP ROLE third_party_writer")

    def test_11_cutover_drains_inflight_and_rejects_queued_fallback(self):
        database = 'cutover_race'
        self.sql('CREATE DATABASE cutover_race')
        self.sql("CREATE SCHEMA auth; CREATE FUNCTION auth.role() RETURNS text LANGUAGE SQL AS $$ SELECT 'service_role'::text $$", database=database)
        for path in sorted(MIGRATIONS.glob('*.sql')):
            if path.name < TARGET:
                self.file(path, database=database)
        env = dict(self.env, PGDATABASE=database)
        base = [executable('psql'), '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1']
        writer = subprocess.Popen(base, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        migration = late = None
        try:
            # Simula o upsert antigo em transação ainda não confirmada.
            writer.stdin.write("BEGIN; SET ROLE service_role; INSERT INTO royal_room_wallets(guild_id,user_id,purchased_rooms) VALUES ('race','u',10); SELECT 'writer-ready';\n")
            writer.stdin.flush()
            self.assertEqual(writer.stdout.readline().strip(), 'writer-ready')
            migration = subprocess.Popen(base + ['-f', str(MIGRATIONS / TARGET)], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                waiting = self.sql("SELECT count(*) FROM pg_locks WHERE relation='public.royal_room_wallets'::regclass AND mode='AccessExclusiveLock' AND NOT granted", database=database)
                if waiting != '0':
                    break
                time.sleep(0.05)
            self.assertNotEqual(waiting, '0', 'a migração deveria estar aguardando o escritor em andamento')
            late = subprocess.Popen(base + ['-c', "SET ROLE service_role; INSERT INTO royal_room_wallets(guild_id,user_id,purchased_rooms) VALUES ('race-late','u',10)"], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                late_waiting = self.sql("SELECT count(*) FROM pg_locks WHERE relation='public.royal_room_wallets'::regclass AND mode='RowExclusiveLock' AND NOT granted", database=database)
                if late_waiting != '0':
                    break
                time.sleep(0.05)
            self.assertNotEqual(late_waiting, '0', 'o segundo escritor deveria aguardar o corte')
            writer.stdin.write('COMMIT;\n\\q\n')
            writer.stdin.flush()
            self.assertEqual(writer.wait(timeout=10), 0, writer.stderr.read())
            _, migration_err = migration.communicate(timeout=15)
            self.assertEqual(migration.returncode, 0, migration_err)
            _, late_err = late.communicate(timeout=10)
            self.assertNotEqual(late.returncode, 0)
            self.assertIn('permission denied', late_err)
            self.assertEqual(self.sql("SELECT purchased_rooms FROM royal_room_wallets WHERE guild_id='race'", database=database), '10')
            self.assertEqual(self.sql("SELECT count(*) FROM royal_room_initial_redemption_reviews WHERE guild_id='race' AND user_id='u'", database=database), '1')
            self.assertEqual(self.sql("SELECT count(*) FROM royal_room_wallets WHERE guild_id='race-late'", database=database), '0')
            p = self.run_psql('-c', 'SET ROLE service_role; ' + self.redeem('race'), database=database)
            self.assertIn('INITIAL_ROOM_REDEMPTION_REVIEW_REQUIRED', p.stderr)
            p = self.run_psql('-c', "SET ROLE service_role; INSERT INTO royal_room_ledger(guild_id,user_id,request_id,event_type,delta_rooms) VALUES ('race','u','race-ledger','admin_grant',10)", database=database)
            self.assertIn('permission denied', p.stderr)
        finally:
            for process in [writer, migration, late]:
                if process and process.poll() is None:
                    process.kill()
                    process.wait(timeout=5)
                if process:
                    for stream in [process.stdin, process.stdout, process.stderr]:
                        if stream:
                            stream.close()

    def test_12_unsafe_definer_owner_aborts_migration(self):
        self.sql("CREATE ROLE room_bad_definer; GRANT CREATE ON SCHEMA public TO room_bad_definer; ALTER FUNCTION public.royal_room_reserve_room(text,text,text,text,text) OWNER TO room_bad_definer")
        try:
            p = self.run_psql('-f', str(MIGRATIONS / TARGET))
            self.assertNotEqual(p.returncode, 0)
            self.assertIn('ROOM_DEFINER_UNSAFE', p.stderr)
            self.assertEqual(self.sql("SELECT has_table_privilege('service_role','royal_room_wallets','INSERT')"), 'f')
        finally:
            self.sql(f"ALTER FUNCTION public.royal_room_reserve_room(text,text,text,text,text) OWNER TO \"{self.env['PGUSER']}\"; REVOKE CREATE ON SCHEMA public FROM room_bad_definer; DROP ROLE room_bad_definer")

    def test_13_concurrent_service_purchase_grant_redeem_and_use(self):
        self.service(self.grant('mixed-service', 'mixed-seed', 8))
        self.sql("INSERT INTO royal_wallet_balances(guild_id,user_id,balance_cents) VALUES ('mixed-service','u',100)")
        commands = [
            self.grant('mixed-service', 'mixed-grant', 5),
            self.redeem('mixed-service'),
            "SELECT royal_wallet_purchase_rooms('mixed-service','u','mixed-buy-a',2,6)",
            "SELECT royal_wallet_purchase_rooms('mixed-service','u','mixed-buy-b',3,9)",
            "SELECT royal_room_reserve_room('mixed-service','u','mixed-use','nix_command',NULL); SELECT royal_room_settle_room('mixed-use','created','room',NULL,NULL)",
        ]
        with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
            results = list(pool.map(lambda c: self.run_psql('-c', "SET statement_timeout='10s'; SET ROLE service_role; " + c), commands))
        self.assertTrue(all(p.returncode == 0 for p in results), [p.stderr for p in results])
        self.assertEqual(self.service("SELECT royal_room_stats('mixed-service','u')")['available_rooms'], 27)
        self.assertEqual(self.sql("SELECT purchased_rooms||':'||reserved_rooms||':'||consumed_rooms||':'||reversed_rooms FROM royal_room_wallets WHERE guild_id='mixed-service'"), '28:0:1:0')
        self.assertEqual(self.sql("SELECT balance_cents FROM royal_wallet_balances WHERE guild_id='mixed-service'"), '85')
        self.assertEqual(self.sql("SELECT count(*) FROM royal_room_ledger WHERE guild_id='mixed-service'"), '7')
        self.assertEqual(self.sql("SELECT count(*) FROM royal_room_initial_redemptions WHERE guild_id='mixed-service'"), '1')


if __name__ == '__main__':
    unittest.main(verbosity=2)
