#!/usr/bin/env python3
"""python3 testes/eco01_eco02_shop_postgres.py

Cria e destrói um PostgreSQL privado local via socket Unix (sem rede ou Supabase).
Requer pg_config, initdb, pg_ctl e psql e não pode ser executado como root.
"""
import concurrent.futures
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
TARGET = '20261120002002_eco01_eco02_shop_intentions.sql'
RESCUE = '20261120002003_eco03_rescue_claim.sql'


def executable(name):
    return str(Path(subprocess.check_output(['pg_config', '--bindir'], text=True).strip()) / name)


class ShopIntentions(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix='royal-price-pg-')
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
            cls.before = cls.security_snapshot()
            cls.create_data('legacy-before')
            cls.sql(cls.buy('legacy-before','legacy-request-1',fn='royal_buy_item'))
            cls.sql("UPDATE royal_shop_items SET name='Atual',price=12 WHERE guild_id='legacy-before'")
            cls.file(MIGRATIONS / TARGET)
            cls.file(MIGRATIONS / TARGET)  # reaplicação segura
            cls.file(MIGRATIONS / RESCUE)
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
    def run_psql(cls, *args):
        return subprocess.run([executable('psql'), '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', *args], env=cls.env, capture_output=True, text=True, timeout=20)

    @classmethod
    def sql(cls, command):
        p = cls.run_psql('-c', command)
        if p.returncode:
            raise AssertionError(f'SQL falhou: {p.stderr}\n{command}')
        return p.stdout.strip()

    @classmethod
    def file(cls, path):
        p = cls.run_psql('-f', str(path))
        if p.returncode:
            raise AssertionError(f'Migração {path.name} falhou: {p.stderr}')

    @classmethod
    def security_snapshot(cls):
        return cls.sql("""
          SELECT md5(pg_get_functiondef('public.royal_buy_item(text,text,uuid,text)'::regprocedure)) || ':' ||
                 coalesce((SELECT proacl::text FROM pg_proc WHERE oid='public.royal_buy_item(text,text,uuid,text)'::regprocedure),'') || ':' ||
                 (SELECT string_agg(c.relname||':'||c.relrowsecurity||':'||c.relforcerowsecurity||':'||coalesce(c.relacl::text,''), ',' ORDER BY c.relname)
                    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
                   WHERE n.nspname='public' AND c.relname IN ('royal_profiles','royal_shop_items','royal_purchases','royal_inventory','royal_wallet_ledger')) || ':' ||
                 coalesce((SELECT string_agg(p.tablename||':'||p.policyname||':'||coalesce(p.qual,'')||':'||coalesce(p.with_check,''), ',' ORDER BY p.tablename,p.policyname)
                    FROM pg_policies p WHERE p.schemaname='public' AND p.tablename IN ('royal_profiles','royal_shop_items','royal_purchases','royal_inventory','royal_wallet_ledger')), '');
        """)

    def fails(self, command, message):
        p = self.run_psql('-c', command)
        self.assertNotEqual(p.returncode, 0, p.stdout)
        self.assertIn(message, p.stderr)

    @classmethod
    def create_data(cls, guild, coins=100, price=10, stock=3):
        cls.sql(f"INSERT INTO royal_profiles(guild_id,user_id,coins) VALUES('{guild}','u',{coins}); INSERT INTO royal_shop_items(guild_id,slug,name,price,reward_type,reward_value,stock) VALUES('{guild}','x','Item', {price},'role','123',{stock});")

    @staticmethod
    def buy(guild, request, price='10', user='u', item=None, fn='royal_buy_item_confirmed'):
        item = item or f"(SELECT id FROM royal_shop_items WHERE guild_id='{guild}' AND slug='x')"
        suffix = '' if fn == 'royal_buy_item' else f',{price}'
        return f"SELECT purchase_id FROM public.{fn}('{guild}','{user}',{item},'{request}'{suffix})"

    @classmethod
    def state(cls, guild):
        return cls.sql(f"SELECT (SELECT coins FROM royal_profiles WHERE guild_id='{guild}' AND user_id='u')||':'||(SELECT stock FROM royal_shop_items WHERE guild_id='{guild}' AND slug='x')||':'||(SELECT count(*) FROM royal_purchases WHERE guild_id='{guild}')||':'||(SELECT count(*) FROM royal_wallet_ledger WHERE guild_id='{guild}')||':'||(SELECT coalesce(sum(quantity),0) FROM royal_inventory WHERE guild_id='{guild}')")

    @classmethod
    def start(cls, name, command):
        env = dict(cls.env, PGAPPNAME=name)
        return subprocess.Popen([executable('psql'), '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', "SET lock_timeout='7s'; SET statement_timeout='10s'; " + command], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    @classmethod
    def wait_event(cls, name, event, timeout=4):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if cls.sql(f"SELECT count(*) FROM pg_stat_activity WHERE application_name='{name}' AND wait_event='{event}'") == '1':
                return
            time.sleep(0.04)
        raise AssertionError(f'{name} não atingiu wait_event={event}')

    @staticmethod
    def finish(process):
        try:
            out, err = process.communicate(timeout=12)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate()
            raise AssertionError('Sessão PostgreSQL não terminou')
        return process.returncode, out.strip(), err

    @classmethod
    def intent(cls, guild, source='source-0001', user='u'):
        return cls.sql(f"SELECT nonce FROM royal_create_shop_intention('{guild}','{user}',(SELECT id FROM royal_shop_items WHERE guild_id='{guild}' AND slug='x'),'{source}')")

    @staticmethod
    def confirm(guild, nonce, user='u'):
        return f"SELECT purchase_id::text||':'||is_replay::text FROM royal_confirm_shop_intention('{guild}','{user}','{nonce}')"

    def test_01_replay_binding_and_new_intentions(self):
        self.create_data('nonce', stock=5)
        n = self.intent('nonce')
        self.assertEqual(self.intent('nonce'), n)
        self.fails("SELECT * FROM royal_create_shop_intention('nonce','outro',(SELECT id FROM royal_shop_items WHERE guild_id='nonce'),'source-0001')", 'outro usuário ou item')
        self.fails(self.confirm('nonce', n, user='outro'), 'Intenção inválida')
        self.fails(self.confirm('other', n), 'Intenção inválida')
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            out = list(pool.map(lambda _: self.run_psql('-c', self.confirm('nonce', n)), range(8)))
        self.assertTrue(all(x.returncode == 0 for x in out), [x.stderr for x in out])
        self.assertEqual(len({x.stdout.strip().split(':')[0] for x in out}), 1)
        self.assertEqual(sum(x.stdout.strip().endswith(':false') for x in out), 1)
        self.assertEqual(self.state('nonce'), '90:4:1:1:1')
        n2 = self.intent('nonce', 'source-0002')
        self.assertNotEqual(n, n2)
        self.sql(self.confirm('nonce', n2))
        self.assertEqual(self.state('nonce'), '80:3:2:2:2')

    def test_02_terms_and_rollback(self):
        for key, change, message in [('price', 'price=11', 'O preço mudou'),
              ('name', "name='Outro'", 'termos do item mudaram'),
              ('description', "description='Mudou'", 'termos do item mudaram'),
              ('reward', "reward_type='pix',reward_value='9.00'", 'termos do item mudaram'),
              ('metadata', "metadata='{\"max_per_user\":2}'", 'termos do item mudaram')]:
            guild = 'terms-' + key
            self.create_data(guild)
            n = self.intent(guild)
            self.sql(f"UPDATE royal_shop_items SET {change} WHERE guild_id='{guild}'")
            self.fails(self.confirm(guild, n), message)
            self.assertEqual(self.state(guild), '100:3:0:0:0')
            self.assertEqual(self.sql(f"SELECT purchase_id IS NULL FROM royal_shop_intentions WHERE nonce='{n}'"), 't')
        self.create_data('poor-intent', coins=5)
        n = self.intent('poor-intent')
        self.fails(self.confirm('poor-intent', n), 'Saldo insuficiente')
        self.assertEqual(self.sql(f"SELECT purchase_id IS NULL FROM royal_shop_intentions WHERE nonce='{n}'"), 't')
        self.sql("UPDATE royal_profiles SET coins=100 WHERE guild_id='poor-intent'")
        self.sql(self.confirm('poor-intent', n))
        self.assertEqual(self.state('poor-intent'), '90:2:1:1:1')

    def test_03_snapshot_guard_legacy_and_permissions(self):
        self.create_data('snap')
        n = self.intent('snap')
        self.sql(self.confirm('snap', n))
        self.assertEqual(self.sql("SELECT (terms_snapshot->>'name')||':'||(terms_snapshot->>'reward_type')||':'||(terms_snapshot->>'reward_value')||':'||(terms_snapshot->>'price')||':'||snapshot_source FROM royal_purchases WHERE guild_id='snap'"), 'Item:role:123:10:purchase')
        self.fails("UPDATE royal_purchases SET terms_snapshot='{}' WHERE guild_id='snap'", 'Termos da compra são imutáveis')
        self.fails("UPDATE royal_shop_items SET reward_value='different' WHERE guild_id='snap'", 'possui histórico')
        self.sql("UPDATE royal_shop_items SET price=20,stock=10 WHERE guild_id='snap'")
        self.assertEqual(self.sql("SELECT terms_snapshot->>'price' FROM royal_purchases WHERE guild_id='snap'"), '10')
        self.create_data('oldapi')
        self.sql(self.buy('oldapi','old-request-1',fn='royal_buy_item'))
        self.assertEqual(self.sql("SELECT (terms_snapshot->>'name')||':'||snapshot_source FROM royal_purchases WHERE guild_id='oldapi'"), 'Item:purchase')
        self.sql(self.buy('oldapi','old-request-2'))
        self.assertEqual(self.state('oldapi'), '80:1:2:2:2')
        fn = 'public.royal_confirm_shop_intention(text,text,uuid)'
        self.assertEqual(self.sql(f"SELECT has_function_privilege('anon','{fn}','EXECUTE')||':'||has_function_privilege('authenticated','{fn}','EXECUTE')||':'||has_function_privilege('service_role','{fn}','EXECUTE')"), 'false:false:true')
        self.fails(f"SET ROLE anon; {self.confirm('snap',n)}", 'permission denied')
        self.assertTrue(self.sql(f"SET ROLE service_role; {self.confirm('snap',n)}").endswith(':true'))

    def test_03b_legacy_backfill_and_expiry(self):
        self.assertEqual(self.sql("SELECT (terms_snapshot->>'name')||':'||(terms_snapshot->>'price')||':'||snapshot_source FROM royal_purchases WHERE guild_id='legacy-before'"), 'Atual:10:legacy_current')
        self.create_data('expired')
        self.sql("INSERT INTO royal_shop_intentions(guild_id,user_id,item_id,source_id,terms_snapshot,expires_at) SELECT 'expired','u',id,'expired-source',royal_shop_terms(i),clock_timestamp()-interval '1 second' FROM royal_shop_items i WHERE guild_id='expired'")
        nonce = self.sql("SELECT nonce FROM royal_shop_intentions WHERE guild_id='expired'")
        self.fails(self.confirm('expired',nonce), 'Intenção expirada')
        self.assertEqual(self.state('expired'), '100:3:0:0:0')
        self.fails("SET ROLE service_role; UPDATE royal_shop_intentions SET expires_at=now() WHERE guild_id='expired'", 'permission denied')

    def test_04_admin_before_and_after_purchase_lock(self):
        self.create_data('admin-first')
        n = self.intent('admin-first')
        admin = self.start('eco-admin-before', "BEGIN; UPDATE royal_shop_items SET reward_value='novo',price=12 WHERE guild_id='admin-first'; SELECT pg_sleep(2); COMMIT")
        self.wait_event('eco-admin-before', 'PgSleep')
        buyer = self.start('eco-buy-after', self.confirm('admin-first',n))
        self.wait_event('eco-buy-after', 'transactionid')
        a,_,ae = self.finish(admin); b,_,be = self.finish(buyer)
        self.assertEqual(a,0,ae); self.assertNotEqual(b,0); self.assertIn('O preço mudou',be)
        self.assertEqual(self.state('admin-first'), '100:3:0:0:0')
        self.create_data('buyer-first')
        n = self.intent('buyer-first')
        buyer = self.start('eco-buy-before', 'BEGIN; ' + self.confirm('buyer-first',n) + '; SELECT pg_sleep(2); COMMIT')
        self.wait_event('eco-buy-before', 'PgSleep')
        admin = self.start('eco-admin-after', "UPDATE royal_shop_items SET reward_value='novo' WHERE guild_id='buyer-first'")
        self.wait_event('eco-admin-after', 'transactionid')
        a,_,ae = self.finish(buyer); b,_,be = self.finish(admin)
        self.assertEqual(a,0,ae); self.assertNotEqual(b,0); self.assertIn('possui histórico',be)
        self.assertEqual(self.sql("SELECT reward_value||':'||(SELECT terms_snapshot->>'reward_value' FROM royal_purchases WHERE guild_id='buyer-first') FROM royal_shop_items WHERE guild_id='buyer-first'"), '123:123')

    def test_05_stock_and_roulette_concurrency(self):
        self.create_data('stock-intent', stock=1)
        self.sql("INSERT INTO royal_profiles(guild_id,user_id,coins) VALUES('stock-intent','v',100)")
        n1=self.intent('stock-intent','source-aaaa','u'); n2=self.intent('stock-intent','source-bbbb','v')
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            out=list(pool.map(lambda c:self.run_psql('-c',c), [self.confirm('stock-intent',n1,'u'),self.confirm('stock-intent',n2,'v')]))
        self.assertEqual(sum(x.returncode == 0 for x in out),1,[x.stderr for x in out])
        self.assertEqual(self.sql("SELECT stock FROM royal_shop_items WHERE guild_id='stock-intent'"),'0')
        self.assertEqual(self.sql("SELECT count(*) FROM royal_purchases WHERE guild_id='stock-intent'"),'1')
        self.create_data('spin-intent',stock=1)
        self.sql("UPDATE royal_profiles SET spins=1 WHERE guild_id='spin-intent'; INSERT INTO royal_roulette_prizes(guild_id,name,reward_type,reward_value,weight) SELECT 'spin-intent','Item','shop_item',id::text,1 FROM royal_shop_items WHERE guild_id='spin-intent'")
        n=self.intent('spin-intent')
        commands=[self.confirm('spin-intent',n),"SELECT * FROM royal_spin('spin-intent','u','request-spin-intent')"]
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            out=list(pool.map(lambda c:self.run_psql('-c',"SET statement_timeout='8s'; "+c), commands))
        self.assertEqual(sum(x.returncode == 0 for x in out),1,[x.stderr for x in out])
        self.assertTrue(all('deadlock' not in x.stderr.lower() and 'timeout' not in x.stderr.lower() for x in out))
        self.assertEqual(self.sql("SELECT stock FROM royal_shop_items WHERE guild_id='spin-intent'"),'0')

    def test_06_no_legacy_or_direct_access_for_backend(self):
        for fn in ['public.royal_buy_item(text,text,uuid,text)', 'public.royal_buy_item_confirmed(text,text,uuid,text,bigint)']:
            for role in ['anon', 'authenticated', 'service_role']:
                self.assertEqual(self.sql(f"SELECT has_function_privilege('{role}','{fn}','EXECUTE')"), 'f')
        for role in ['anon', 'authenticated', 'service_role']:
            self.fails(f"SET ROLE {role}; SELECT * FROM royal_buy_item('x','u','00000000-0000-4000-8000-000000000001','request-1234')", 'permission denied')
            self.fails(f"SET ROLE {role}; SELECT * FROM royal_buy_item_confirmed('x','u','00000000-0000-4000-8000-000000000001','request-1234',1)", 'permission denied')
        for table in ['royal_purchases', 'royal_shop_intentions']:
            for operation in [f'INSERT INTO {table} DEFAULT VALUES', f'UPDATE {table} SET guild_id=guild_id', f'DELETE FROM {table}', f'TRUNCATE {table}']:
                self.fails(f'SET ROLE service_role; {operation}', 'permission denied')
        # O SELECT e a execução da intenção seguem disponíveis para o backend.
        self.assertEqual(self.sql("SELECT has_table_privilege('service_role','royal_purchases','SELECT')"), 't')
        self.assertEqual(self.sql("SELECT has_function_privilege('service_role','public.royal_confirm_shop_intention(text,text,uuid)','EXECUTE')"), 't')

    def test_07_inherited_and_owner_privileges_fail_closed(self):
        scenarios = [
          ("CREATE ROLE shop_legacy_role; GRANT EXECUTE ON FUNCTION royal_buy_item(text,text,uuid,text) TO shop_legacy_role; GRANT shop_legacy_role TO service_role; ALTER ROLE service_role NOINHERIT",
           "REVOKE shop_legacy_role FROM service_role; REVOKE EXECUTE ON FUNCTION royal_buy_item(text,text,uuid,text) FROM shop_legacy_role; ALTER ROLE service_role INHERIT; DROP ROLE shop_legacy_role", 'SHOP_LEGACY_PURCHASE_PRIVILEGE_UNSAFE'),
          ("CREATE ROLE shop_writer_role; GRANT INSERT (guild_id) ON royal_purchases TO shop_writer_role; GRANT shop_writer_role TO service_role; ALTER ROLE service_role NOINHERIT",
           "REVOKE shop_writer_role FROM service_role; REVOKE INSERT (guild_id) ON royal_purchases FROM shop_writer_role; ALTER ROLE service_role INHERIT; DROP ROLE shop_writer_role", 'SHOP_DIRECT_PURCHASE_PRIVILEGE_UNSAFE'),
          ("ALTER FUNCTION royal_buy_item(text,text,uuid,text) OWNER TO service_role",
           f"ALTER FUNCTION royal_buy_item(text,text,uuid,text) OWNER TO \"{self.env['PGUSER']}\"", 'SHOP_LEGACY_PURCHASE_PRIVILEGE_UNSAFE'),
          ("ALTER FUNCTION royal_confirm_shop_intention(text,text,uuid) OWNER TO service_role",
           f"ALTER FUNCTION royal_confirm_shop_intention(text,text,uuid) OWNER TO \"{self.env['PGUSER']}\"", 'SHOP_LEGACY_PURCHASE_PRIVILEGE_UNSAFE'),
          ("ALTER TABLE royal_purchases OWNER TO service_role",
           f"ALTER TABLE royal_purchases OWNER TO \"{self.env['PGUSER']}\"", 'SHOP_DIRECT_PURCHASE_PRIVILEGE_UNSAFE'),
          ("ALTER TABLE royal_shop_items OWNER TO service_role",
           f"ALTER TABLE royal_shop_items OWNER TO \"{self.env['PGUSER']}\"", 'SHOP_DIRECT_PURCHASE_PRIVILEGE_UNSAFE'),
        ]
        for setup, cleanup, message in scenarios:
            self.sql(setup)
            try:
                p = self.run_psql('-f', str(MIGRATIONS / TARGET))
                self.assertNotEqual(p.returncode, 0, f'{setup}: {p.stdout} {p.stderr}')
                self.assertIn(message, p.stderr)
            finally:
                self.sql(cleanup)


if __name__ == '__main__':
    unittest.main(verbosity=2)
