#!/usr/bin/env python3
"""ECO-03: banco PostgreSQL temporário, isolado e sem credenciais externas."""
import concurrent.futures
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
MIG = ROOT / 'supabase' / 'migrations'
TARGET = '20261120002003_eco03_rescue_claim.sql'
SHOP = '20261120002002_eco01_eco02_shop_intentions.sql'


def binary(name):
    return str(Path(subprocess.check_output(['pg_config', '--bindir'], text=True).strip()) / name)


class RescueClaimSQL(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix='eco03-pg-')
        cls.data = Path(cls.tmp) / 'data'
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        cls.env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
        cls.env.update(PGHOST=cls.tmp, PGPORT=str(port), PGUSER=os.environ.get('USER', 'ubuntu'), PGDATABASE='postgres')
        try:
            subprocess.run([binary('initdb'), '-D', str(cls.data), '-A', 'trust', '-U', cls.env['PGUSER'], '--no-locale', '-E', 'UTF8'], env=cls.env, check=True, capture_output=True, text=True)
            subprocess.run([binary('pg_ctl'), '-D', str(cls.data), '-l', str(Path(cls.tmp) / 'server.log'), '-o', f"-F -k {cls.tmp} -p {port} -c listen_addresses=''", '-w', 'start'], env=cls.env, check=True, capture_output=True, text=True)
            cls.sql("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE FUNCTION auth.role() RETURNS text LANGUAGE SQL AS $$ SELECT 'service_role'::text $$")
            for path in sorted(MIG.glob('*.sql')):
                if path.name < TARGET:
                    if path.name == SHOP:
                        # Legado inconsistente que existia antes do novo trigger de snapshot.
                        cls.sql("""INSERT INTO royal_shop_items(id,guild_id,slug,name,price,reward_type,reward_value)
                          VALUES ('00000000-0000-4000-8000-000000000002','other','x','X',1,'pix','5.00');
                          INSERT INTO royal_purchases(id,guild_id,user_id,item_id,price,status,request_id)
                          VALUES ('00000000-0000-4000-8000-000000000103','g','u','00000000-0000-4000-8000-000000000002',1,'pending','cross');""")
                    cls.file(path)
            cls.sql("""
              INSERT INTO royal_shop_items(id,guild_id,slug,name,price,reward_type,reward_value)
                VALUES ('00000000-0000-4000-8000-000000000001','g','p','P',1,'pix','5.00');
              INSERT INTO royal_purchases(id,guild_id,user_id,item_id,price,status,request_id)
                VALUES ('00000000-0000-4000-8000-000000000101','g','u','00000000-0000-4000-8000-000000000001',1,'pending','old');
              INSERT INTO royal_reward_deliveries(guild_id,request_id,user_id,reward_type,reward_value)
                VALUES ('g','legacy','u','pix','5.00');
            """)
            cls.file(MIG / TARGET)
            cls.file(MIG / TARGET)
        except Exception:
            cls.tearDownClass()
            raise

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls, 'data') and cls.data.exists():
            subprocess.run([binary('pg_ctl'), '-D', str(cls.data), '-m', 'immediate', '-w', 'stop'], env=cls.env, capture_output=True, text=True)
        if hasattr(cls, 'tmp'):
            shutil.rmtree(cls.tmp, ignore_errors=True)

    @classmethod
    def run_sql(cls, command):
        return subprocess.run([binary('psql'), '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', command], env=cls.env, capture_output=True, text=True, timeout=20)

    @classmethod
    def sql(cls, command):
        p = cls.run_sql(command)
        if p.returncode:
            raise AssertionError(f'SQL falhou: {p.stderr}\n{command}')
        return p.stdout.strip()

    @classmethod
    def file(cls, path):
        p = subprocess.run([binary('psql'), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', str(path)], env=cls.env, capture_output=True, text=True, timeout=40)
        if p.returncode:
            raise AssertionError(f'{path.name}: {p.stderr}')

    @staticmethod
    def action(action, source, protocol, owner='adm', guild='g', request='req'):
        values = [action, guild, source, protocol, owner, request]
        return "SELECT public.royal_rescue_action(" + ','.join("'" + v.replace("'", "''") + "'" for v in values) + ")"

    def call(self, action, source, protocol, owner='adm', guild='g', request='req'):
        return json.loads(self.sql('SET ROLE service_role; ' + self.action(action, source, protocol, owner, guild, request)))

    def add_reward(self, protocol, kind='pix', guild='g', value='5.00'):
        self.sql(f"INSERT INTO royal_reward_deliveries(guild_id,request_id,user_id,reward_type,reward_value) VALUES ('{guild}','{protocol}','u','{kind}','{value}')")

    def test_01_legacy_and_reapply(self):
        for source, protocol in [('loja', '00000000-0000-4000-8000-000000000101'), ('roleta', 'legacy')]:
            self.assertEqual(self.call('claim', source, protocol)['result'], 'review')
            self.assertEqual(self.call('finish', source, protocol)['result'], 'review')
        self.add_reward('after-cut')
        self.file(MIG / TARGET)
        self.assertEqual(self.call('claim', 'roleta', 'after-cut')['result'], 'acquired')

    def test_02_parallel_distinct_attendants_and_completion(self):
        for source, proto in [('roleta', 'race'), ('loja', '00000000-0000-4000-8000-000000000102')]:
            if source == 'roleta':
                self.add_reward(proto)
            else:
                self.sql(f"INSERT INTO royal_purchases(id,guild_id,user_id,item_id,price,status,request_id) VALUES ('{proto}','g','u','00000000-0000-4000-8000-000000000001',1,'pending','race-shop')")
            def attempt(i):
                p = self.run_sql("SET statement_timeout='10s'; SET ROLE service_role; " + self.action('claim', source, proto, f'adm-{i}', request=f'req-{i}'))
                self.assertEqual(p.returncode, 0, p.stderr)
                return json.loads(p.stdout.strip())
            with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
                results = list(pool.map(attempt, range(16)))
            self.assertEqual(sum(r['result'] == 'acquired' for r in results), 1, results)
            owner = next(r['owner_id'] for r in results if r['result'] == 'acquired')
            self.assertTrue(all(r['result'] in ('acquired', 'owned') for r in results))
            self.assertEqual(self.call('claim', source, proto, owner)['result'], 'already_owned')
            self.assertEqual(self.call('finish', source, proto, 'intruder')['result'], 'owned')
            self.assertEqual(self.call('finish', source, proto, owner)['result'], 'finished')
            self.assertEqual(self.call('finish', source, proto, owner)['result'], 'delivered')
            self.assertEqual(self.sql(f"SELECT count(*) FROM royal_audit_events WHERE guild_id='g' AND entity_id='{proto}' AND action='reward.delivery.manual_marked'"), '1')

    def test_03_scope_eligibility_and_changed_snapshot(self):
        self.add_reward('scope')
        self.assertEqual(self.call('claim', 'roleta', 'scope', guild='other')['result'], 'not_found')
        self.assertEqual(self.call('finish', 'roleta', 'scope')['result'], 'unclaimed')
        self.assertEqual(self.call('claim', 'roleta', 'scope')['result'], 'acquired')
        self.sql("UPDATE royal_reward_deliveries SET reward_value='9.00' WHERE guild_id='g' AND request_id='scope'")
        self.assertEqual(self.call('finish', 'roleta', 'scope')['result'], 'changed')
        self.assertEqual(self.sql("SELECT status FROM royal_reward_deliveries WHERE guild_id='g' AND request_id='scope'"), 'pending')
        self.assertEqual(self.call('claim', 'loja', '00000000-0000-4000-8000-000000000103')['result'], 'not_found')

    def test_04_failures_rollback_and_fail_closed(self):
        self.add_reward('fail-claim')
        self.sql("""CREATE FUNCTION inject_rescue_audit() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN IF NEW.entity_id IN ('fail-claim','fail-finish') THEN RAISE EXCEPTION 'TEST_AUDIT_FAILURE'; END IF; RETURN NEW; END $$;
          CREATE TRIGGER inject_rescue_audit BEFORE INSERT ON royal_audit_events FOR EACH ROW EXECUTE FUNCTION inject_rescue_audit();""")
        try:
            p = self.run_sql('SET ROLE service_role; ' + self.action('claim', 'roleta', 'fail-claim'))
            self.assertIn('TEST_AUDIT_FAILURE', p.stderr)
            self.assertEqual(self.sql("SELECT count(*) FROM royal_rescue_claims WHERE protocol='fail-claim'"), '0')
        finally:
            self.sql('DROP TRIGGER inject_rescue_audit ON royal_audit_events')
        self.add_reward('fail-finish')
        self.assertEqual(self.call('claim', 'roleta', 'fail-finish')['result'], 'acquired')
        self.sql('CREATE TRIGGER inject_rescue_audit BEFORE INSERT ON royal_audit_events FOR EACH ROW EXECUTE FUNCTION inject_rescue_audit()')
        try:
            p = self.run_sql('SET ROLE service_role; ' + self.action('finish', 'roleta', 'fail-finish'))
            self.assertIn('TEST_AUDIT_FAILURE', p.stderr)
            self.assertEqual(self.sql("SELECT status FROM royal_reward_deliveries WHERE request_id='fail-finish'"), 'pending')
            self.assertEqual(self.sql("SELECT state FROM royal_rescue_claims WHERE protocol='fail-finish'"), 'claimed')
        finally:
            self.sql('DROP TRIGGER inject_rescue_audit ON royal_audit_events; DROP FUNCTION inject_rescue_audit()')
        self.assertEqual(self.call('finish', 'roleta', 'fail-finish')['result'], 'finished')

    def test_05_legacy_update_and_permissions_blocked(self):
        self.add_reward('guard', kind='role', value='role-id')
        for command in ["UPDATE royal_reward_deliveries SET status='delivered' WHERE request_id='guard'", "SELECT royal_mark_reward_delivered('g','guard','u')"]:
            p = self.run_sql('SET ROLE service_role; ' + command)
            self.assertTrue('RESCUE_CLAIM_REQUIRED' in p.stderr or 'permission denied' in p.stderr, p.stderr)
        for role in ['anon', 'authenticated']:
            p = self.run_sql('SET ROLE ' + role + '; ' + self.action('claim', 'roleta', 'guard'))
            self.assertIn('permission denied', p.stderr)
        p = self.run_sql("SET ROLE service_role; DELETE FROM royal_rescue_claims")
        self.assertIn('permission denied', p.stderr)
        self.assertEqual(self.call('claim', 'roleta', 'guard', 'auto:interaction')['result'], 'acquired')
        self.assertEqual(self.call('claim', 'roleta', 'guard', 'staff')['result'], 'owned')
        self.assertEqual(self.call('finish', 'roleta', 'guard', 'staff')['result'], 'owned')
        self.assertEqual(self.call('finish', 'roleta', 'guard', 'auto:interaction')['result'], 'finished')

    def test_06_auto_manual_and_same_owner_races(self):
        self.add_reward('auto-manual', kind='role', value='role-id')
        self.add_reward('same-owner')
        def run(owner, protocol):
            p = self.run_sql("SET ROLE service_role; " + self.action('claim', 'roleta', protocol, owner, request=owner))
            self.assertEqual(p.returncode, 0, p.stderr)
            return json.loads(p.stdout.strip())['result']
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda owner: run(owner, 'auto-manual'), ['staff', 'auto:interaction']))
        self.assertEqual(sorted(results), ['acquired', 'owned'])
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: run('same-adm', 'same-owner'), range(8)))
        self.assertEqual(results.count('acquired'), 1)
        self.assertEqual(results.count('already_owned'), 7)
        def finish(_):
            p = self.run_sql("SET ROLE service_role; " + self.action('finish', 'roleta', 'same-owner', 'same-adm'))
            self.assertEqual(p.returncode, 0, p.stderr)
            return json.loads(p.stdout.strip())['result']
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            finished = list(pool.map(finish, range(8)))
        self.assertEqual(finished.count('finished'), 1)
        self.assertEqual(finished.count('delivered'), 7)
        self.assertEqual(self.sql("SELECT count(*) FROM royal_audit_events WHERE entity_id='same-owner' AND action='reward.delivery.manual_marked'"), '1')

    def test_07_existing_source_rpcs_still_create_pending(self):
        self.sql("INSERT INTO royal_profiles(guild_id,user_id,coins,spins) VALUES ('source','u',10,1); INSERT INTO royal_shop_items(id,guild_id,slug,name,price,reward_type,reward_value) VALUES ('00000000-0000-4000-8000-000000000010','source','p','P',1,'pix','5.00'); INSERT INTO royal_roulette_prizes(guild_id,name,reward_type,reward_value,weight) VALUES ('source','Cargo','role','role-id',1)")
        nonce = self.sql("SET ROLE service_role; SELECT nonce FROM royal_create_shop_intention('source','u','00000000-0000-4000-8000-000000000010','preview-source')")
        purchase = json.loads(self.sql(f"SET ROLE service_role; SELECT row_to_json(x) FROM royal_confirm_shop_intention('source','u','{nonce}') x"))
        self.assertEqual(purchase['status'], 'pending')
        self.assertEqual(self.call('claim','loja',purchase['purchase_id'],guild='source')['result'], 'acquired')
        self.sql("SET ROLE service_role; SELECT * FROM royal_spin('source','u','spin:actual')")
        self.assertEqual(self.call('claim','roleta','spin:actual',owner='auto:actual',guild='source')['result'], 'acquired')
        self.assertEqual(self.call('finish','roleta','spin:actual',owner='auto:actual',guild='source')['result'], 'finished')

    def test_07b_intention_to_claim_auto_manual_real_concurrency(self):
        guild = 'integrated-race'
        item = '00000000-0000-4000-8000-000000000070'
        self.sql(f"INSERT INTO royal_profiles(guild_id,user_id,coins) VALUES ('{guild}','u',100); "
                 f"INSERT INTO royal_shop_items(id,guild_id,slug,name,price,reward_type,reward_value,stock) "
                 f"VALUES ('{item}','{guild}','r','Cargo',10,'role','original-role',1)")
        def create(_):
            p = self.run_sql(f"SET ROLE service_role; SELECT nonce FROM royal_create_shop_intention('{guild}','u','{item}','preview-unique')")
            self.assertEqual(p.returncode, 0, p.stderr)
            return p.stdout.strip()
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            nonces = list(pool.map(create, range(8)))
        self.assertEqual(len(set(nonces)), 1)
        nonce = nonces[0]
        def confirm(_):
            p = self.run_sql(f"SET statement_timeout='10s'; SET ROLE service_role; SELECT row_to_json(x) FROM royal_confirm_shop_intention('{guild}','u','{nonce}') x")
            self.assertEqual(p.returncode, 0, p.stderr)
            return json.loads(p.stdout)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(confirm, range(8)))
        self.assertEqual(sum(not x['is_replay'] for x in results), 1)
        self.assertEqual(len({x['purchase_id'] for x in results}), 1)
        purchase = results[0]['purchase_id']
        self.assertTrue(all(x['reward_value'] == 'original-role' for x in results))
        self.assertEqual(self.sql(f"SELECT coins FROM royal_profiles WHERE guild_id='{guild}' AND user_id='u'"), '90')
        self.assertEqual(self.sql(f"SELECT stock FROM royal_shop_items WHERE id='{item}'"), '0')
        self.assertEqual(self.sql(f"SELECT count(*) FROM royal_purchases WHERE guild_id='{guild}'"), '1')
        self.assertEqual(self.sql(f"SELECT count(*) FROM royal_wallet_ledger WHERE guild_id='{guild}'"), '1')
        p = self.run_sql(f"SET ROLE service_role; SELECT royal_mark_purchase_delivered('{guild}','{purchase}','u')")
        self.assertNotEqual(p.returncode, 0)
        self.assertIn('RESCUE_CLAIM_REQUIRED', p.stderr)
        # Simula desvio administrativo de dados, para provar que o claim não relê o cadastro.
        self.sql(f"ALTER TABLE royal_shop_items DISABLE TRIGGER royal_shop_guard_item; "
                 f"UPDATE royal_shop_items SET reward_value='changed-role' WHERE id='{item}'; "
                 f"ALTER TABLE royal_shop_items ENABLE TRIGGER royal_shop_guard_item")
        actors = ['auto:interaction-1'] + [f'staff-{i}' for i in range(7)]
        def claim(actor):
            p = self.run_sql("SET statement_timeout='10s'; SET ROLE service_role; " + self.action('claim','loja',purchase,actor,guild,actor))
            self.assertEqual(p.returncode, 0, p.stderr)
            return json.loads(p.stdout)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            claims = list(pool.map(claim, actors))
        winners = [x for x in claims if x['result'] == 'acquired']
        self.assertEqual(len(winners), 1, claims)
        self.assertEqual(sum(x['result'] == 'owned' for x in claims), 7)
        winner = winners[0]
        self.assertEqual((winner['user_id'], winner['reward_type'], winner['reward_value']), ('u','role','original-role'))
        self.assertEqual(self.call('claim','loja',purchase,winner['owner_id'],guild)['result'], 'already_owned')
        self.assertEqual(self.call('finish','loja',purchase,'intruder',guild)['result'], 'owned')
        self.assertEqual(self.call('finish','loja',purchase,winner['owner_id'],guild)['result'], 'finished')
        self.assertEqual(self.call('finish','loja',purchase,winner['owner_id'],guild)['result'], 'delivered')
        self.assertTrue(confirm(0)['is_replay'])
        self.assertEqual(self.sql(f"SELECT status||':'||(terms_snapshot->>'reward_value') FROM royal_purchases WHERE id='{purchase}'"), 'delivered:original-role')
        self.assertEqual(self.sql(f"SELECT count(*) FROM royal_audit_events WHERE guild_id='{guild}' AND entity_id='{purchase}' AND action IN ('reward.delivery.manual_marked','reward.delivery.auto_marked')"), '1')

    def test_07c_javascript_services_use_real_concurrent_rpcs(self):
        self.sql("INSERT INTO royal_profiles(guild_id,user_id,coins) VALUES ('js-real','user-real',100); "
                 "INSERT INTO royal_shop_items(id,guild_id,slug,name,price,reward_type,reward_value,stock) "
                 "VALUES ('00000000-0000-4000-8000-000000000080','js-real','r','Cargo',10,'role','123456789012345678',1)")
        env = dict(self.env, PSQL_PATH=binary('psql'))
        p = subprocess.run(['node', str(ROOT / 'testes' / 'eco_integracao_real.js')], env=env,
                           capture_output=True, text=True, timeout=30)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn('RPCs reais', p.stdout)

    def test_08_inherited_privilege_aborts_reapply(self):
        self.sql("CREATE ROLE rescue_writer; GRANT UPDATE (status) ON royal_reward_deliveries TO rescue_writer; GRANT rescue_writer TO service_role; ALTER ROLE service_role NOINHERIT")
        try:
            p = subprocess.run([binary('psql'), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', str(MIG / TARGET)], env=self.env, capture_output=True, text=True, timeout=20)
            self.assertNotEqual(p.returncode, 0)
            self.assertIn('RESCUE_DIRECT_WRITE_PRIVILEGE_UNSAFE', p.stderr)
            self.assertEqual(self.sql("SELECT has_column_privilege('rescue_writer','royal_reward_deliveries','status','UPDATE')"), 't')
            self.assertEqual(self.sql("SELECT has_table_privilege('service_role','royal_rescue_claims','DELETE')"), 'f')
        finally:
            self.sql("REVOKE rescue_writer FROM service_role; REVOKE UPDATE (status) ON royal_reward_deliveries FROM rescue_writer; ALTER ROLE service_role INHERIT; DROP ROLE rescue_writer")

    def test_09_owner_privilege_aborts_reapply(self):
        owner = self.env['PGUSER']
        scenarios = [
            ("ALTER TABLE royal_reward_deliveries OWNER TO service_role",
             f'ALTER TABLE royal_reward_deliveries OWNER TO "{owner}"', 'RESCUE_DIRECT_WRITE_PRIVILEGE_UNSAFE'),
            ("ALTER FUNCTION royal_rescue_guard_status() OWNER TO service_role",
             f'ALTER FUNCTION royal_rescue_guard_status() OWNER TO "{owner}"', 'RESCUE_FUNCTION_OWNER_UNSAFE'),
        ]
        for setup, cleanup, message in scenarios:
            self.sql(setup)
            try:
                p = subprocess.run([binary('psql'), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', str(MIG / TARGET)], env=self.env, capture_output=True, text=True, timeout=20)
                self.assertNotEqual(p.returncode, 0, setup)
                self.assertIn(message, p.stderr)
            finally:
                self.sql(cleanup)


if __name__ == '__main__':
    unittest.main(verbosity=2)
