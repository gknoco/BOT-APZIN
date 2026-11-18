#!/usr/bin/env python3
"""python3 testes/compra_preco_confirmado.py

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
TARGET = '20261118000200_confirmar_preco_loja.sql'


def executable(name):
    return str(Path(subprocess.check_output(['pg_config', '--bindir'], text=True).strip()) / name)


class CompraPrecoConfirmado(unittest.TestCase):
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
            cls.file(MIGRATIONS / TARGET)
            cls.file(MIGRATIONS / TARGET)  # reaplicação segura
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

    def test_01_sucesso_e_mudanca_sem_mutacao(self):
        self.create_data('ok')
        purchase = self.sql(self.buy('ok', 'request-ok'))
        self.assertTrue(purchase)
        self.assertEqual(self.state('ok'), '90:2:1:1:1')
        self.assertEqual(self.sql("SELECT price FROM royal_purchases WHERE guild_id='ok'"), '10')
        for guild, price in [('aumentou', 15), ('diminuiu', 5)]:
            self.create_data(guild, price=price)
            self.fails(self.buy(guild, 'request-mismatch'), 'O preço mudou')
            self.assertEqual(self.state(guild), '100:3:0:0:0')
        self.create_data('nullprice')
        self.fails(self.buy('nullprice', 'request-null', price='NULL'), 'Preço esperado obrigatório')
        self.assertEqual(self.state('nullprice'), '100:3:0:0:0')
        self.fails(self.buy('nullprice', 'request-other', item="'00000000-0000-0000-0000-000000000000'::uuid"), 'Item indisponível')

    def test_02_replay_entre_rpcs_com_preco_alterado(self):
        self.create_data('replay')
        original = self.sql(self.buy('replay', 'request-replay'))
        self.sql("UPDATE royal_shop_items SET price=99, active=false WHERE guild_id='replay'")
        self.assertEqual(self.sql(self.buy('replay', 'request-replay', price='10')), original)
        self.assertEqual(self.sql(self.buy('replay', 'request-replay', price='NULL')), original)
        self.assertEqual(self.sql(self.buy('replay', 'request-replay', price='99')), original)
        self.fails(self.buy('replay', 'request-replay', user='outro'), 'outro usuário ou item')
        self.fails(self.buy('replay', 'request-replay', item="'00000000-0000-0000-0000-000000000000'::uuid"), 'outro usuário ou item')
        self.fails(self.buy('replay', 'request-replay', item='NULL::uuid'), 'outro usuário ou item')
        self.assertEqual(self.state('replay'), '90:2:1:1:1')
        self.create_data('legacy')
        legacy = self.sql(self.buy('legacy', 'request-legacy', fn='royal_buy_item'))
        self.sql("UPDATE royal_shop_items SET price=50 WHERE guild_id='legacy'")
        self.assertEqual(self.sql(self.buy('legacy', 'request-legacy', price='10')), legacy)
        self.assertEqual(self.state('legacy'), '90:2:1:1:1')
        # A API legada continua utilizável independentemente do preço confirmado.
        self.sql(self.buy('legacy', 'request-another', fn='royal_buy_item'))
        self.assertEqual(self.state('legacy'), '40:1:2:2:2')
        # Um perfil removido não autoriza uma nova execução para o mesmo pedido.
        self.sql("DELETE FROM royal_profiles WHERE guild_id='legacy' AND user_id='u'")
        self.assertEqual(self.sql(self.buy('legacy', 'request-legacy', price='10')), legacy)
        self.assertEqual(self.sql("SELECT count(*) FROM royal_purchases WHERE guild_id='legacy'"), '2')

    def test_03_permissoes_rls_e_contrato_antigos(self):
        self.assertEqual(self.security_snapshot(), self.before)
        fn = 'public.royal_buy_item_confirmed(text,text,uuid,text,bigint)'
        self.assertEqual(self.sql(f"SELECT has_function_privilege('anon','{fn}','EXECUTE')||':'||has_function_privilege('authenticated','{fn}','EXECUTE')||':'||has_function_privilege('service_role','{fn}','EXECUTE')"), 'false:false:true')
        self.assertEqual(self.sql(f"SELECT prosecdef||':'||array_to_string(proconfig,',') FROM pg_proc WHERE oid='{fn}'::regprocedure"), 'true:search_path=pg_catalog, public, pg_temp')
        self.create_data('perms')
        command = self.buy('perms', 'request-perms')
        self.fails('SET ROLE anon; ' + command, 'permission denied')
        self.fails('SET ROLE authenticated; ' + command, 'permission denied')
        self.assertTrue(self.sql('SET ROLE service_role; ' + command))
        self.assertEqual(self.state('perms'), '90:2:1:1:1')

    def test_04_atualizacao_segura_antes_e_depois_do_lock(self):
        self.create_data('before')
        updater = self.start('price-updater-before', "BEGIN; UPDATE royal_shop_items SET price=20 WHERE guild_id='before'; SELECT pg_sleep(2); COMMIT")
        self.wait_event('price-updater-before', 'PgSleep')
        buyer = self.start('price-buyer-before', self.buy('before', 'request-before'))
        code_update, _, error_update = self.finish(updater)
        code_buy, _, error_buy = self.finish(buyer)
        self.assertEqual(code_update, 0, error_update)
        self.assertNotEqual(code_buy, 0)
        self.assertIn('O preço mudou', error_buy)
        self.assertEqual(self.state('before'), '100:3:0:0:0')

        self.create_data('after')
        buyer = self.start('price-buyer-after', 'BEGIN; ' + self.buy('after', 'request-after') + '; SELECT pg_sleep(2); COMMIT')
        self.wait_event('price-buyer-after', 'PgSleep')
        updater = self.start('price-updater-after', "UPDATE royal_shop_items SET price=20 WHERE guild_id='after'")
        self.wait_event('price-updater-after', 'transactionid')
        code_buy, _, error_buy = self.finish(buyer)
        code_update, _, error_update = self.finish(updater)
        self.assertEqual(code_buy, 0, error_buy)
        self.assertEqual(code_update, 0, error_update)
        self.assertEqual(self.state('after'), '90:2:1:1:1')
        self.assertEqual(self.sql("SELECT q.price||':'||i.price FROM royal_purchases q JOIN royal_shop_items i ON i.id=q.item_id WHERE q.guild_id='after'"), '10:20')

    def test_05_ordem_de_lock_e_replays_concorrentes_com_rpc_legada(self):
        self.create_data('locks')
        # A transação legada retém primeiro o advisory do request. Se a nova
        # bloquear o item ANTES desse advisory, o cenário produz deadlock.
        legacy = self.start('legacy-lock', "BEGIN; SELECT pg_advisory_xact_lock(hashtextextended('locks:buy:request-lock',0)); SELECT pg_sleep(2); " + self.buy('locks', 'request-lock', fn='royal_buy_item') + '; COMMIT')
        self.wait_event('legacy-lock', 'PgSleep')
        confirmed = self.start('confirmed-lock', self.buy('locks', 'request-lock'))
        self.wait_event('confirmed-lock', 'advisory')
        a, old_result, old_error = self.finish(legacy)
        b, new_result, new_error = self.finish(confirmed)
        self.assertEqual(a, 0, old_error)
        self.assertEqual(b, 0, new_error)
        self.assertEqual(old_result.strip(), new_result.strip())
        self.assertEqual(self.state('locks'), '90:2:1:1:1')
        self.create_data('many')
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda _: self.run_psql('-c', self.buy('many', 'request-many')), range(6)))
        self.assertTrue(all(p.returncode == 0 for p in results), [p.stderr for p in results])
        self.assertEqual(len({p.stdout.strip() for p in results}), 1)
        self.assertEqual(self.state('many'), '90:2:1:1:1')

    def test_06_ordem_compartilhada_com_roleta(self):
        self.create_data('mix', stock=1)
        self.sql("UPDATE royal_profiles SET spins=1 WHERE guild_id='mix'; INSERT INTO royal_roulette_prizes(guild_id,name,reward_type,reward_value,weight) SELECT 'mix','Item','shop_item',id::text,1 FROM royal_shop_items WHERE guild_id='mix'")
        commands = [self.buy('mix', 'request-mix-buy'), "SELECT * FROM royal_spin('mix','u','request-mix-spin')"]
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda c: self.run_psql('-c', "SET statement_timeout='8s'; BEGIN; SELECT pg_sleep(0.3); " + c + '; COMMIT'), commands))
        self.assertEqual(sum(p.returncode == 0 for p in results), 1, [p.stderr for p in results])
        self.assertTrue(all('deadlock' not in p.stderr.lower() and 'statement timeout' not in p.stderr.lower() for p in results), [p.stderr for p in results])
        self.assertEqual(self.sql("SELECT stock FROM royal_shop_items WHERE guild_id='mix'"), '0')

    def test_07_regras_e_rollback_da_rpc_delegada(self):
        self.create_data('limited')
        self.sql("UPDATE royal_shop_items SET metadata=jsonb_build_object('max_per_user',1) WHERE guild_id='limited'")
        self.sql(self.buy('limited', 'request-limit-1'))
        self.fails(self.buy('limited', 'request-limit-2'), 'Limite de compras')
        self.assertEqual(self.state('limited'), '90:2:1:1:1')

        self.create_data('insufficient', coins=5)
        self.fails(self.buy('insufficient', 'request-poor'), 'Saldo insuficiente')
        self.assertEqual(self.state('insufficient'), '5:3:0:0:0')
        self.create_data('no-stock', stock=0)
        self.fails(self.buy('no-stock', 'request-empty'), 'Item sem estoque')
        self.assertEqual(self.state('no-stock'), '100:0:0:0:0')

        self.create_data('bad-reward')
        self.sql("UPDATE royal_shop_items SET reward_type='spins',reward_value='-1' WHERE guild_id='bad-reward'")
        self.fails(self.buy('bad-reward', 'request-bad-reward'), 'Recompensa de saldo inválida')
        self.assertEqual(self.state('bad-reward'), '100:3:0:0:0')
        self.create_data('good-reward')
        self.sql("UPDATE royal_shop_items SET reward_type='spins',reward_value='2' WHERE guild_id='good-reward'")
        self.sql(self.buy('good-reward', 'request-reward'))
        self.assertEqual(self.state('good-reward'), '90:2:1:2:1')
        self.assertEqual(self.sql("SELECT spins FROM royal_profiles WHERE guild_id='good-reward'"), '2')


if __name__ == '__main__':
    unittest.main(verbosity=2)
