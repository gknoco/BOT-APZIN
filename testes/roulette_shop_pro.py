#!/usr/bin/env python3
"""Teste isolado: python3 testes/roulette_shop_pro.py

Requer binários locais de PostgreSQL (pg_config, initdb, pg_ctl e psql).
Cria cluster temporário privado, somente socket Unix, sem DATABASE_URL nem rede.
"""
import concurrent.futures
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / 'supabase' / 'migrations'
TARGET = '20261118000100_roulette_shop_pro.sql'
LAST_BASE = '20261117120228_royal_wallet_room_purchases.sql'


def executable(name):
    bindir = subprocess.check_output(['pg_config', '--bindir'], text=True).strip()
    return str(Path(bindir) / name)


class RouletteShopPro(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix='royal-test-pg-')
        cls.data = Path(cls.tmp) / 'data'
        cls.pg_ctl = executable('pg_ctl')
        with socket.socket() as s:
            s.bind(('127.0.0.1', 0))
            port = s.getsockname()[1]
        cls.env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
        cls.env.update(PGHOST=cls.tmp, PGPORT=str(port), PGUSER=os.environ.get('USER', 'ubuntu'), PGDATABASE='postgres')
        subprocess.run([executable('initdb'), '-D', str(cls.data), '-A', 'trust', '-U', cls.env['PGUSER'], '--no-locale'],
                       env=cls.env, check=True, capture_output=True, text=True)
        subprocess.run([cls.pg_ctl, '-D', str(cls.data), '-l', str(Path(cls.tmp) / 'server.log'),
                        '-o', f"-F -k {cls.tmp} -p {port} -c listen_addresses=''", '-w', 'start'],
                       env=cls.env, check=True, capture_output=True, text=True)
        try:
            cls.sql("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; "
                    "CREATE SCHEMA auth; CREATE FUNCTION auth.role() RETURNS text LANGUAGE SQL AS $$ SELECT 'service_role'::text $$;")
            for path in sorted(MIGRATIONS.glob('*.sql')):
                if path.name <= LAST_BASE:
                    cls.file(path)
            # Gera histórico com as funções antigas, antes de aplicar a migração alvo.
            cls.sql("""
                SELECT royal_apply_match_result('old','m',1,4,'normal',
                  '[{"user_id":"v","team":1},{"user_id":"l","team":2}]');
                INSERT INTO royal_profiles(guild_id,user_id,spins) VALUES ('old','spin',1);
                INSERT INTO royal_roulette_prizes(guild_id,name,reward_type,reward_value,weight)
                  VALUES('old','Inicial','coins','2',1);
                INSERT INTO royal_roulette_spins(guild_id,user_id,prize_id,request_id)
                  SELECT 'old','spin',id,'old-request' FROM royal_roulette_prizes WHERE guild_id='old';
                UPDATE royal_roulette_prizes SET name='Estado na migração' WHERE guild_id='old';
            """)
            cls.file(MIGRATIONS / TARGET)
            cls.file(MIGRATIONS / TARGET)  # aplicação repetida não destrói dados
        except Exception:
            cls.tearDownClass()
            raise

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls, 'pg_ctl') and hasattr(cls, 'data') and cls.data.exists():
            subprocess.run([cls.pg_ctl, '-D', str(cls.data), '-m', 'immediate', '-w', 'stop'],
                           env=cls.env, capture_output=True, text=True)
        if hasattr(cls, 'tmp'):
            shutil.rmtree(cls.tmp, ignore_errors=True)

    @classmethod
    def run_psql(cls, *args):
        return subprocess.run([executable('psql'), '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', *args],
                              env=cls.env, capture_output=True, text=True, timeout=60)

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

    def fails(self, command, text):
        p = self.run_psql('-c', command)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn(text, p.stderr)

    def parallel(self, commands):
        # Espera comum dentro de transações para aproximar o início das disputas.
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(commands)) as pool:
            return list(pool.map(lambda c: self.run_psql('-c', 'BEGIN; SELECT pg_sleep(0.25); ' + c + '; COMMIT'), commands))

    def test_01_historico_e_sem_retroatividade(self):
        self.sql("UPDATE royal_roulette_prizes SET name='Editado depois' WHERE guild_id='old'")
        self.assertEqual(self.sql("SELECT prize_name FROM royal_spin('old','spin','old-request')"), 'Estado na migração')
        self.sql("SELECT royal_apply_match_result('old','m',1,4,'normal','[{\"user_id\":\"v\",\"team\":1},{\"user_id\":\"l\",\"team\":2}]')")
        self.assertEqual(self.sql("SELECT coins||':'||wins FROM royal_profiles WHERE guild_id='old' AND user_id='v'"), '0:1')
        self.assertEqual(self.sql("SELECT count(*) FROM royal_wallet_ledger WHERE guild_id='old' AND reason='vitória de partida'"), '0')

    def test_02_partida_wo_replay_e_rollback(self):
        result = "SELECT royal_apply_match_result('match','new',1,10,'wo','[{\"user_id\":\"a\",\"team\":1},{\"user_id\":\"b\",\"team\":1},{\"user_id\":\"c\",\"team\":2}]')"
        self.sql(result); self.sql(result)
        self.assertEqual(self.sql("SELECT string_agg(user_id||':'||coins||':'||wins||':'||losses||':'||wos,',' ORDER BY user_id) FROM royal_profiles WHERE guild_id='match'"), 'a:1:1:0:0,b:1:1:0:0,c:0:0:1:1')
        self.assertEqual(self.sql("SELECT count(*) FROM royal_wallet_ledger WHERE guild_id='match' AND amount=1 AND reason='vitória de partida'"), '2')
        self.fails(result.replace("'wo'", "'normal'"), 'resultado diferente')
        self.fails("SELECT royal_apply_match_result('match','dup',1,1,'normal','[{\"user_id\":\"a\",\"team\":1},{\"user_id\":\"a\",\"team\":1}]')", 'duplicado')
        self.sql("INSERT INTO royal_wallet_ledger(guild_id,user_id,asset,amount,balance_after,reason,request_id) VALUES('match','a','coins',1,1,'choque','match-win:collision')")
        self.fails("SELECT royal_apply_match_result('match','collision',1,0,'normal','[{\"user_id\":\"a\",\"team\":1}]')", 'duplicate key')
        self.assertEqual(self.sql("SELECT count(*) FROM royal_match_stats_applied WHERE guild_id='match' AND match_id='collision'"), '0')
        self.assertEqual(self.sql("SELECT coins FROM royal_profiles WHERE guild_id='match' AND user_id='a'"), '1')

    def test_03_pix_role_snapshot_cooldown_e_negativos(self):
        self.sql("INSERT INTO royal_profiles(guild_id,user_id,spins) VALUES('pix','u',3); INSERT INTO royal_roulette_prizes(guild_id,name,reward_type,reward_value,weight) VALUES('pix','Pix 5','pix','5.00',1)")
        self.assertEqual(self.sql("SELECT prize_name||':'||reward_type||':'||reward_value FROM royal_spin('pix','u','request-pix-1')"), 'Pix 5:pix:5.00')
        self.sql("UPDATE royal_roulette_prizes SET name='Outro',reward_type='coins',reward_value='100' WHERE guild_id='pix'")
        self.assertEqual(self.sql("SELECT prize_name||':'||reward_type||':'||reward_value FROM royal_spin('pix','u','request-pix-1')"), 'Pix 5:pix:5.00')
        self.assertEqual(self.sql("SELECT reward_type||':'||reward_value||':'||status FROM royal_reward_deliveries WHERE guild_id='pix'"), 'pix:5.00:pending')
        self.fails("SELECT * FROM royal_spin('pix','other','request-pix-1')", 'outro usuário')
        self.sql("INSERT INTO discord_configuracoes(guild_id,chave,valor) VALUES('pix','roleta_cooldown_segundos','60')")
        self.fails("SELECT * FROM royal_spin('pix','u','request-pix-2')", 'cooldown')
        self.assertEqual(self.sql("SELECT spins FROM royal_profiles WHERE guild_id='pix' AND user_id='u'"), '2')
        self.sql("UPDATE discord_configuracoes SET valor='-1' WHERE guild_id='pix'")
        self.fails("SELECT * FROM royal_spin('pix','u','request-pix-2')", 'roleta_cooldown_segundos')
        self.sql("INSERT INTO royal_profiles(guild_id,user_id,spins) VALUES('neg','u',1); INSERT INTO royal_roulette_prizes(guild_id,name,reward_type,reward_value,weight) VALUES('neg','Ruim','coins','-99',1)")
        self.fails("SELECT * FROM royal_spin('neg','u','negative-1')", 'Recompensa de saldo inválida')
        self.assertEqual(self.sql("SELECT coins||':'||spins FROM royal_profiles WHERE guild_id='neg' AND user_id='u'"), '0:1')
        self.assertEqual(self.sql("SELECT count(*) FROM royal_roulette_spins WHERE guild_id='neg'"), '0')
        self.sql("INSERT INTO royal_profiles(guild_id,user_id,spins) VALUES('role','u',1); INSERT INTO royal_roulette_prizes(guild_id,name,reward_type,reward_value,weight) VALUES('role','Cargo','role','123',1); SELECT * FROM royal_spin('role','u','role-request')")
        self.assertEqual(self.sql("SELECT status FROM royal_reward_deliveries WHERE guild_id='role'"), 'pending')
        self.assertEqual(self.sql("SELECT royal_mark_reward_delivered('role','role-request','u')"), 't')
        self.sql("INSERT INTO royal_profiles(guild_id,user_id,spins) VALUES('spin-reward','u',1); INSERT INTO royal_roulette_prizes(guild_id,name,reward_type,reward_value,weight) VALUES('spin-reward','Extra','spins','2',1); SELECT * FROM royal_spin('spin-reward','u','extra-request')")
        self.assertEqual(self.sql("SELECT spins FROM royal_profiles WHERE guild_id='spin-reward'"), '2')
        self.assertEqual(self.sql("SELECT string_agg(amount::text,',' ORDER BY amount) FROM royal_wallet_ledger WHERE guild_id='spin-reward'"), '-1,2')

    def test_04_pesos_e_estoque_item(self):
        self.sql("INSERT INTO discord_configuracoes(guild_id,chave,valor) VALUES('weight','roleta_cooldown_segundos','0'); INSERT INTO royal_profiles(guild_id,user_id,spins) VALUES('weight','u',1600); INSERT INTO royal_roulette_prizes(guild_id,name,reward_type,reward_value,weight) VALUES('weight','leve','coins','0',1),('weight','pesado','coins','0',3)")
        self.sql("SELECT count(*) FROM generate_series(1,1600) n CROSS JOIN LATERAL royal_spin('weight','u','weighted-'||n::text)")
        fraction = float(self.sql("SELECT count(*) FILTER (WHERE prize_name_snapshot='pesado')::numeric/count(*) FROM royal_roulette_spins WHERE guild_id='weight'"))
        self.assertGreater(fraction, 0.68); self.assertLess(fraction, 0.82)
        self.assertEqual(self.sql("SELECT spins FROM royal_profiles WHERE guild_id='weight' AND user_id='u'"), '0')
        self.sql("INSERT INTO royal_profiles(guild_id,user_id,spins) VALUES('item','u',2); INSERT INTO royal_shop_items(guild_id,slug,name,price,reward_type,reward_value,stock) VALUES('item','one','Item',1,'role','1',1); INSERT INTO royal_roulette_prizes(guild_id,name,reward_type,reward_value,weight,stock) SELECT 'item','Item sorteado','shop_item',id::text,1,2 FROM royal_shop_items WHERE guild_id='item'")
        self.sql("SELECT * FROM royal_spin('item','u','item-spin-1')")
        self.assertEqual(self.sql("SELECT stock FROM royal_shop_items WHERE guild_id='item'"), '0')
        self.assertEqual(self.sql("SELECT stock FROM royal_roulette_prizes WHERE guild_id='item'"), '1')
        self.assertEqual(self.sql("SELECT quantity FROM royal_inventory WHERE guild_id='item'"), '1')
        self.fails("SELECT * FROM royal_spin('item','u','item-spin-2')", 'estoque disponível')
        self.assertEqual(self.sql("SELECT spins FROM royal_profiles WHERE guild_id='item'"), '1')

    def test_05_compras_limite_replay_e_cancelamento(self):
        self.sql("INSERT INTO royal_profiles(guild_id,user_id,coins) VALUES('limit','u',100); INSERT INTO royal_shop_items(guild_id,slug,name,price,reward_type,reward_value,stock,metadata) VALUES('limit','x','X',10,'role','x',5,'{\"max_per_user\":1}')")
        buy = "SELECT * FROM royal_buy_item('limit','u',(SELECT id FROM royal_shop_items WHERE guild_id='limit'),'purchase-1')"
        self.sql(buy); self.sql(buy)
        self.fails(buy.replace('purchase-1', 'purchase-2'), 'Limite de compras')
        self.assertEqual(self.sql("SELECT coins FROM royal_profiles WHERE guild_id='limit'"), '90')
        self.sql("UPDATE royal_purchases SET status='cancelled' WHERE guild_id='limit'")
        self.sql(buy.replace('purchase-1', 'purchase-2'))
        self.assertEqual(self.sql("SELECT stock FROM royal_shop_items WHERE guild_id='limit'"), '3')
        self.sql("INSERT INTO royal_profiles(guild_id,user_id,coins) VALUES('bad-buy','u',10); INSERT INTO royal_shop_items(guild_id,slug,name,price,reward_type,reward_value,stock) VALUES('bad-buy','x','X',1,'spins','-1',1)")
        self.fails("SELECT * FROM royal_buy_item('bad-buy','u',(SELECT id FROM royal_shop_items WHERE guild_id='bad-buy'),'bad-buy-request')", 'Recompensa de saldo inválida')
        self.assertEqual(self.sql("SELECT coins||':'||spins FROM royal_profiles WHERE guild_id='bad-buy'"), '10:0')
        self.assertEqual(self.sql("SELECT stock FROM royal_shop_items WHERE guild_id='bad-buy'"), '1')
        self.assertEqual(self.sql("SELECT count(*) FROM royal_purchases WHERE guild_id='bad-buy'"), '0')

    def test_06_replays_e_disputas_concorrentes(self):
        self.sql("INSERT INTO royal_profiles(guild_id,user_id,spins) VALUES('conc','u',6); INSERT INTO royal_roulette_prizes(guild_id,name,reward_type,reward_value,weight) VALUES('conc','Pix','pix','1.00',1); INSERT INTO discord_configuracoes(guild_id,chave,valor) VALUES('conc','roleta_cooldown_segundos','60')")
        rs = self.parallel([f"SELECT * FROM royal_spin('conc','u','conc-request-{n}')" for n in range(6)])
        self.assertEqual(sum(r.returncode == 0 for r in rs), 1, [r.stderr for r in rs])
        self.assertEqual(self.sql("SELECT spins FROM royal_profiles WHERE guild_id='conc'"), '5')
        self.assertEqual(self.sql("SELECT count(*) FROM royal_reward_deliveries WHERE guild_id='conc'"), '1')
        self.sql("INSERT INTO royal_profiles(guild_id,user_id,spins) VALUES('replay-conc','u',1); INSERT INTO royal_roulette_prizes(guild_id,name,reward_type,reward_value,weight) VALUES('replay-conc','Pix','pix','1.00',1)")
        replay = "SELECT * FROM royal_spin('replay-conc','u','same-request')"
        rs = self.parallel([replay] * 5)
        self.assertTrue(all(r.returncode == 0 for r in rs), [r.stderr for r in rs])
        self.assertEqual(self.sql("SELECT spins FROM royal_profiles WHERE guild_id='replay-conc'"), '0')
        self.assertEqual(self.sql("SELECT count(*) FROM royal_roulette_spins WHERE guild_id='replay-conc'"), '1')
        self.sql("INSERT INTO royal_profiles(guild_id,user_id,spins) VALUES('stock','a',1),('stock','b',1); INSERT INTO royal_roulette_prizes(guild_id,name,reward_type,reward_value,weight,stock) VALUES('stock','Único','coins','1',1,1)")
        rs = self.parallel([f"SELECT * FROM royal_spin('stock','{u}','stock-request-{u}')" for u in ('a','b')])
        self.assertEqual(sum(r.returncode == 0 for r in rs), 1, [r.stderr for r in rs])
        self.assertEqual(self.sql("SELECT sum(spins)||':'||sum(coins) FROM royal_profiles WHERE guild_id='stock'"), '1:1')
        self.sql("INSERT INTO royal_profiles(guild_id,user_id,coins) VALUES('limit-conc','u',100); INSERT INTO royal_shop_items(guild_id,slug,name,price,reward_type,reward_value,stock,metadata) VALUES('limit-conc','x','X',10,'role','x',5,'{\"max_per_user\":1}')")
        rs = self.parallel([f"SELECT * FROM royal_buy_item('limit-conc','u',(SELECT id FROM royal_shop_items WHERE guild_id='limit-conc'),'buy-conc-{n}')" for n in range(4)])
        self.assertEqual(sum(r.returncode == 0 for r in rs), 1, [r.stderr for r in rs])
        self.assertEqual(self.sql("SELECT coins FROM royal_profiles WHERE guild_id='limit-conc'"), '90')
        self.sql("INSERT INTO royal_profiles(guild_id,user_id,spins,coins) VALUES('mixed','u',1,30); INSERT INTO royal_shop_items(guild_id,slug,name,price,reward_type,reward_value,stock) VALUES('mixed','x','X',10,'role','x',1); INSERT INTO royal_roulette_prizes(guild_id,name,reward_type,reward_value,weight) SELECT 'mixed','Item','shop_item',id::text,1 FROM royal_shop_items WHERE guild_id='mixed'")
        rs = self.parallel(["SELECT * FROM royal_buy_item('mixed','u',(SELECT id FROM royal_shop_items WHERE guild_id='mixed'),'mixed-buy')", "SELECT * FROM royal_spin('mixed','u','mixed-spin')"])
        self.assertEqual(sum(r.returncode == 0 for r in rs), 1, [r.stderr for r in rs])
        self.assertTrue(all('deadlock' not in r.stderr for r in rs), [r.stderr for r in rs])
        self.assertEqual(self.sql("SELECT stock FROM royal_shop_items WHERE guild_id='mixed'"), '0')
        match = "SELECT royal_apply_match_result('conc-match','same',1,1,'wo','[{\"user_id\":\"v\",\"team\":1},{\"user_id\":\"l\",\"team\":2}]')"
        rs = self.parallel([match] * 5)
        self.assertTrue(all(r.returncode == 0 for r in rs), [r.stderr for r in rs])
        self.assertEqual(self.sql("SELECT coins||':'||wins FROM royal_profiles WHERE guild_id='conc-match' AND user_id='v'"), '1:1')
        self.assertEqual(self.sql("SELECT count(*) FROM royal_wallet_ledger WHERE guild_id='conc-match' AND reason='vitória de partida'"), '1')

    def test_07_seguranca(self):
        for fn in ['royal_spin(text,text,text)', 'royal_buy_item(text,text,uuid,text)', 'royal_apply_match_result(text,text,integer,bigint,text,jsonb)']:
            self.assertEqual(self.sql(f"SELECT has_function_privilege('anon','public.{fn}','EXECUTE')||':'||has_function_privilege('authenticated','public.{fn}','EXECUTE')||':'||has_function_privilege('service_role','public.{fn}','EXECUTE')"), 'false:false:true')
        self.assertEqual(self.sql("SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid IN ('royal_roulette_prizes'::regclass,'royal_roulette_spins'::regclass,'royal_reward_deliveries'::regclass)"), 't')

    def test_08_pgcrypto_no_schema_extensions(self):
        self.sql("CREATE SCHEMA extensions; ALTER EXTENSION pgcrypto SET SCHEMA extensions; INSERT INTO royal_profiles(guild_id,user_id,spins) VALUES('ext','u',1); INSERT INTO royal_roulette_prizes(guild_id,name,reward_type,reward_value,weight) VALUES('ext','Premio','coins','1',1)")
        self.assertEqual(self.sql("SELECT prize_name FROM royal_spin('ext','u','extension-test')"), 'Premio')

    def test_09_cooldown_padrao_nao_debita(self):
        self.sql("INSERT INTO royal_profiles(guild_id,user_id,spins) VALUES('padrao','u',2); INSERT INTO royal_roulette_prizes(guild_id,name,reward_type,reward_value,weight) VALUES('padrao','Premio','coins','1',1)")
        self.sql("SELECT * FROM royal_spin('padrao','u','padrao-spin-1')")
        self.fails("SELECT * FROM royal_spin('padrao','u','padrao-spin-2')", 'cooldown')
        self.assertEqual(self.sql("SELECT coins||':'||spins FROM royal_profiles WHERE guild_id='padrao' AND user_id='u'"), '1:1')


if __name__ == '__main__':
    unittest.main(verbosity=2)
