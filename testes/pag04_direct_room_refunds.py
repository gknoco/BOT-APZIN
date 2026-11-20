#!/usr/bin/env python3
"""PAG-04: PostgreSQL temporário local, sem rede ou credenciais de produção.

Execute: python3 testes/pag04_direct_room_refunds.py (requer initdb/pg_ctl/psql).
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
TARGET = '20261120002001_pag04_direct_room_refunds.sql'


def executable(name):
    return str(Path(subprocess.check_output(['pg_config', '--bindir'], text=True).strip()) / name)


class DirectRefundSQL(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix='pag04-pg-')
        cls.data = Path(cls.tmp) / 'data'
        cls.pg_ctl = executable('pg_ctl')
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        cls.env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
        cls.env.update(PGHOST=cls.tmp, PGPORT=str(port), PGUSER=os.environ.get('USER', 'ubuntu'), PGDATABASE='postgres')
        try:
            subprocess.run([executable('initdb'), '-D', str(cls.data), '-A', 'trust', '-U', cls.env['PGUSER'], '--no-locale', '-E', 'UTF8'], env=cls.env, check=True, capture_output=True, text=True)
            subprocess.run([cls.pg_ctl, '-D', str(cls.data), '-l', str(Path(cls.tmp) / 'pg.log'), '-o', f"-F -k {cls.tmp} -p {port} -c listen_addresses=''", '-w', 'start'], env=cls.env, check=True, capture_output=True, text=True)
            cls.sql("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE FUNCTION auth.role() RETURNS text LANGUAGE SQL AS $$ SELECT 'service_role'::text $$;")
            for migration in sorted(MIGRATIONS.glob('*.sql')):
                if migration.name < TARGET:
                    cls.file(migration)
            legacy = cls.call("SELECT royal_room_create_purchase('legacy','u','legacy-order',10,NULL,'u@example.com')")
            cls.legacy = legacy['id']
            cls.call(cls.apply(cls.legacy, 'approved', 0, payment='legacy-pay'))
            # Estado que a versão antiga deixava após um estorno parcial.
            cls.sql(f"UPDATE royal_room_purchase_orders SET status='manual_review',mp_status='refunded',error_code='partial_refund_requires_review' WHERE id='{cls.legacy}'")
            cls.legacy_terminal = cls.call("SELECT royal_room_create_purchase('legacy-terminal','u','legacy-terminal-order',10,NULL,'u@example.com')")['id']
            cls.call(cls.apply(cls.legacy_terminal, 'approved', 0, payment='legacy-terminal-pay'))
            cls.sql(f"UPDATE royal_room_purchase_orders SET status='refunded',mp_status='refunded' WHERE id='{cls.legacy_terminal}'")
            cls.legacy_missing = cls.call("SELECT royal_room_create_purchase('legacy-missing','u','legacy-missing-order',10,NULL,'u@example.com')")['id']
            cls.call(cls.apply(cls.legacy_missing, 'approved', 0, payment='legacy-missing-pay'))
            cls.sql(f"DELETE FROM royal_room_ledger WHERE request_id='purchase:{cls.legacy_missing}'; UPDATE royal_room_purchase_orders SET status='refunded',mp_status='refunded' WHERE id='{cls.legacy_missing}'")
            cls.legacy_stale = cls.call("SELECT royal_room_create_purchase('legacy-stale','u','legacy-stale-order',10,NULL,'u@example.com')")['id']
            cls.call(cls.apply(cls.legacy_stale, 'approved', 0, payment='legacy-stale-pay'))
            cls.sql(f"UPDATE royal_room_purchase_orders SET mp_status='refunded' WHERE id='{cls.legacy_stale}'")
            cls.legacy_event = cls.call("SELECT royal_room_enqueue_payment_event('legacy-event','101','payment.updated')")['id']
            cls.sql(f"UPDATE royal_room_mp_webhook_events SET status='processed' WHERE id='{cls.legacy_event}'")
            cls.legacy_topup = cls.call("SELECT royal_wallet_create_topup('legacy-money','u','legacy-money',1000,'u@example.com')")['id']
            cls.call(cls.apply_topup(cls.legacy_topup, 'approved'))
            cls.call(cls.apply_topup(cls.legacy_topup, 'approved', 100))
            cls.call(cls.apply_topup(cls.legacy_topup, 'approved'))  # antiga troca status para manual_review
            cls.reconcile('legacy-money', cls.legacy_topup)
            cls.call(cls.apply_topup(cls.legacy_topup, 'approved'))  # bug anterior realmente duplica
            assert cls.sql("SELECT balance_cents FROM royal_wallet_balances WHERE guild_id='legacy-money'") == '2200'
            cls.file(MIGRATIONS / TARGET)
            cls.file(MIGRATIONS / TARGET)  # idempotência de corte
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
    def run_sql(cls, sql):
        return subprocess.run([executable('psql'), '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1', '-c', sql], env=cls.env, capture_output=True, text=True, timeout=25)

    @classmethod
    def sql(cls, sql):
        p = cls.run_sql(sql)
        if p.returncode:
            raise AssertionError(f'{p.stderr}\n{sql}')
        return p.stdout.strip()

    @classmethod
    def call(cls, sql):
        return json.loads(cls.sql(sql))

    @classmethod
    def file(cls, path):
        p = subprocess.run([executable('psql'), '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', str(path)], env=cls.env, capture_output=True, text=True, timeout=60)
        if p.returncode:
            raise AssertionError(f'{path.name}: {p.stderr}')

    def fails(self, sql, error):
        p = self.run_sql(sql)
        self.assertNotEqual(p.returncode, 0, p.stdout)
        self.assertIn(error, p.stderr)

    @staticmethod
    def apply(oid, status, refunded=0, payment=None, amount=30, reason=None, currency='BRL'):
        refund = 'NULL' if refunded is None else str(refunded)
        reason_sql = 'NULL' if reason is None else "'" + reason + "'"
        return f"SELECT royal_room_apply_payment('{oid}','{payment or 'pay-' + oid}','{status}',{amount},'{currency}','{oid}',{refund},{reason_sql})"

    @staticmethod
    def apply_topup(oid, status='approved', refunded=0):
        return f"SELECT royal_wallet_apply_topup_payment('{oid}','pay-{oid}','{status}',1000,'BRL','{oid}','pix',{refunded})"

    @classmethod
    def reconcile(cls, guild, oid):
        key = cls.sql(f"SELECT request_id FROM royal_wallet_topup_ledger WHERE topup_id='{oid}' AND event_type='refund_review' AND detail->>'wallet_frozen'='true' ORDER BY created_at DESC LIMIT 1")
        script = (ROOT / 'supabase' / 'operations' / 'reconcile_wallet_refund.sql').read_text()
        for old, new in [('REPLACE_DISCORD_GUILD_ID',guild),('REPLACE_DISCORD_USER_ID','u'),
                         ('REPLACE_REFUND_REVIEW_REQUEST_ID',key),('REPLACE_DISCORD_ADMIN_ID','admin'),
                         ('REPLACE_MP_CASE_OR_TICKET_REFERENCE','ticket-'+guild),
                         ('REPLACE_WITH_AUDIT_NOTE','provider restored funds and all cases reviewed')]:
            script = script.replace(old,new)
        cls.sql(script)

    def order(self, guild, qty=10):
        return self.call(f"SET ROLE service_role; SELECT royal_room_create_purchase('{guild}','u','order-{guild}',{qty},NULL,'u@example.com')")['id']

    def service(self, sql):
        return self.call('SET ROLE service_role; ' + sql)

    def wallet(self, guild):
        return self.call(f"SELECT to_jsonb(w) FROM royal_room_wallets w WHERE guild_id='{guild}' AND user_id='u'")

    def test_01_partial_approved_and_replay(self):
        oid = self.order('partial')
        self.assertEqual(self.service(self.apply(oid, 'approved'))['status'], 'approved')
        self.service("SELECT royal_room_reserve_room('partial','u','partial-use','nix_command',NULL)")
        self.service("SELECT royal_room_settle_room('partial-use','created','room',NULL,NULL)")
        partial = self.service(self.apply(oid, 'approved', 4))
        self.assertEqual((partial['status'], partial['direct_refunded_cents']), ('manual_review', 4))
        w = self.wallet('partial')
        self.assertEqual((w['purchased_rooms'],w['consumed_rooms'],w['reversed_rooms'],w['is_frozen'],w['direct_refund_review']), (10,1,0,True,True))
        for status, cents in [('approved',0),('pending',0),('approved',4),('refunded',2),('approved',9)]:
            self.assertEqual(self.service(self.apply(oid,status,cents))['status'], 'manual_review')
        self.assertEqual(self.wallet('partial')['purchased_rooms'],10)
        self.assertEqual(self.service("SELECT royal_room_stats('partial','u')")['available_rooms'],0)
        self.fails("SET ROLE service_role; SELECT royal_room_reserve_room('partial','u','partial-next','nix_command',NULL)", 'ROOM_WALLET_FROZEN_FOR_REVIEW')
        self.assertEqual(self.sql(f"SELECT direct_refunded_cents FROM royal_room_purchase_orders WHERE id='{oid}'"),'9')
        self.assertEqual(self.sql(f"SELECT count(*) FROM royal_room_ledger WHERE order_id='{oid}' AND event_type='purchase'"),'1')
        self.fails("UPDATE royal_room_wallets SET is_frozen=false WHERE guild_id='partial'", 'royal_room_direct_refund_hold_check')

    def test_02_partial_to_full_and_chargeback(self):
        oid = self.order('transition')
        self.service(self.apply(oid,'approved'))
        self.service("SELECT royal_room_reserve_room('transition','u','transition-use','nix_command',NULL)")
        self.service("SELECT royal_room_settle_room('transition-use','created','room',NULL,NULL)")
        self.service(self.apply(oid,'refunded',5))
        self.assertEqual(self.service(self.apply(oid,'refunded',30))['status'],'refunded')
        for status, cents in [('refunded',30),('approved',0),('refunded',4),('charged_back',0),('refunded',30)]:
            self.service(self.apply(oid,status,cents))
        w=self.wallet('transition')
        self.assertEqual((w['purchased_rooms'],w['consumed_rooms'],w['reversed_rooms'],w['is_frozen']),(10,1,10,True))
        self.assertEqual(self.sql(f"SELECT status FROM royal_room_purchase_orders WHERE id='{oid}'"),'charged_back')
        self.assertEqual(self.sql(f"SELECT count(*) FROM royal_room_ledger WHERE order_id='{oid}' AND event_type='reversed'"),'1')
        self.assertEqual(self.service(f"SELECT royal_room_mark_purchase_failure('{oid}','failed','stale')")['status'],'charged_back')

    def test_03_full_before_approval_no_credit(self):
        oid=self.order('before')
        self.assertEqual(self.service(self.apply(oid,'refunded',30))['status'],'refunded')
        self.assertEqual(self.service(self.apply(oid,'approved',0))['status'],'refunded')
        self.assertEqual(self.wallet('before')['purchased_rooms'],0)
        self.assertEqual(self.sql(f"SELECT count(*) FROM royal_room_ledger WHERE order_id='{oid}' AND event_type IN ('purchase','reversed')"),'0')
        oid2=self.order('partial-before')
        self.assertEqual(self.service(self.apply(oid2,'approved',2))['status'],'manual_review')
        self.assertEqual(self.service(self.apply(oid2,'approved',0))['status'],'manual_review')
        self.assertEqual(self.wallet('partial-before')['purchased_rooms'],0)
        self.assertTrue(self.wallet('partial-before')['is_frozen'])
        self.assertEqual(self.service(self.apply(oid2,'refunded',30))['status'],'refunded')
        self.assertEqual(self.wallet('partial-before')['reversed_rooms'],0)

    def test_04_unknown_or_invalid_amount_and_identity(self):
        for name,status,amount,reason in [('missing','refunded',0,None),('negative','approved',-1,None),('null','approved',None,None),('large','approved',31,None),('invalid','approved',None,'invalid_refunded_amount')]:
            oid=self.order('bad-'+name)
            self.service(self.apply(oid,'approved'))
            result=self.service(self.apply(oid,status,amount,reason=reason))
            self.assertEqual(result['status'],'manual_review')
            self.assertTrue(self.wallet('bad-'+name)['is_frozen'])
            self.assertEqual(self.wallet('bad-'+name)['reversed_rooms'],0)
        oid=self.order('wrong-currency')
        self.service(self.apply(oid,'approved'))
        self.assertEqual(self.service(self.apply(oid,'refunded',30,currency='USD'))['status'],'manual_review')
        self.assertTrue(self.wallet('wrong-currency')['is_frozen'])
        self.assertEqual(self.wallet('wrong-currency')['reversed_rooms'],0)

    def test_05_legacy_cutover_and_reversal(self):
        self.assertTrue(self.wallet('legacy')['direct_refund_review'])
        self.fails("SET ROLE service_role; SELECT royal_room_reserve_room('legacy','u','legacy-use','nix_command',NULL)",'ROOM_WALLET_FROZEN_FOR_REVIEW')
        self.assertEqual(self.service(self.apply(self.legacy,'approved',0,payment='legacy-pay'))['status'],'manual_review')
        self.assertEqual(self.wallet('legacy')['purchased_rooms'],10)
        self.assertEqual(self.service(self.apply(self.legacy,'refunded',30,payment='legacy-pay'))['status'],'refunded')
        self.assertEqual(self.wallet('legacy')['reversed_rooms'],10)
        self.assertTrue(self.wallet('legacy')['is_frozen'])
        self.assertTrue(self.wallet('legacy-terminal')['is_frozen'])
        self.assertEqual(self.service(self.apply(self.legacy_terminal,'refunded',30,payment='legacy-terminal-pay'))['status'],'refunded')
        self.assertEqual(self.wallet('legacy-terminal')['reversed_rooms'],10)
        self.assertTrue(self.wallet('legacy-missing')['is_frozen'])
        missing=self.service(self.apply(self.legacy_missing,'refunded',30,payment='legacy-missing-pay'))
        self.assertEqual(missing['error_code'],'purchase_ledger_missing')
        self.assertEqual(self.wallet('legacy-missing')['reversed_rooms'],0)
        self.assertTrue(self.wallet('legacy-stale')['is_frozen'])
        self.assertEqual(self.sql(f"SELECT status FROM royal_room_purchase_orders WHERE id='{self.legacy_stale}'"),'manual_review')

    def test_06_atomic_rollback(self):
        oid=self.order('rollback')
        self.service(self.apply(oid,'approved'))
        self.sql("CREATE FUNCTION pag04_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.guild_id='rollback' AND NEW.event_type='refund_review' THEN RAISE EXCEPTION 'INJECTED'; END IF; RETURN NEW; END $$; CREATE TRIGGER pag04_fail BEFORE INSERT ON royal_room_ledger FOR EACH ROW EXECUTE FUNCTION pag04_fail()")
        try:
            self.fails('SET ROLE service_role; '+self.apply(oid,'approved',1),'INJECTED')
            self.assertFalse(self.wallet('rollback')['is_frozen'])
            self.assertEqual(self.sql(f"SELECT status||':'||direct_refund_observed::text FROM royal_room_purchase_orders WHERE id='{oid}'"),'approved:false')
        finally:
            self.sql('DROP TRIGGER pag04_fail ON royal_room_ledger; DROP FUNCTION pag04_fail()')
        self.service(self.apply(oid,'approved',1))
        self.assertTrue(self.wallet('rollback')['is_frozen'])

    def test_07_parallel_replays(self):
        oid=self.order('parallel')
        self.service(self.apply(oid,'approved'))
        cmds=[self.apply(oid,'approved',5) for _ in range(16)]
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            results=list(pool.map(lambda c:self.run_sql("SET statement_timeout='10s'; SET ROLE service_role; "+c),cmds))
        self.assertTrue(all(p.returncode==0 for p in results),[p.stderr for p in results])
        self.assertEqual(self.sql(f"SELECT count(*) FROM royal_room_ledger WHERE order_id='{oid}' AND event_type='refund_review'"),'1')
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            results=list(pool.map(lambda _:self.run_sql("SET statement_timeout='10s'; SET ROLE service_role; "+self.apply(oid,'refunded',30)),range(16)))
        self.assertTrue(all(p.returncode==0 for p in results),[p.stderr for p in results])
        self.assertEqual(self.wallet('parallel')['reversed_rooms'],10)
        self.assertEqual(self.sql(f"SELECT count(*) FROM royal_room_ledger WHERE order_id='{oid}' AND event_type='reversed'"),'1')

    def test_08_refund_holds_wallet_against_reserve_and_settle(self):
        oid=self.order('race')
        self.service(self.apply(oid,'approved'))
        self.service("SELECT royal_room_reserve_room('race','u','race-before','nix_command',NULL)")
        # A primeira transação publica o freeze só no COMMIT; a reserva concorrente
        # espera o mesmo advisory lock/linha e não passa pelo saldo antigo.
        script="BEGIN; SET ROLE service_role; "+self.apply(oid,'approved',1)+"; SELECT pg_sleep(1.2); COMMIT;"
        proc=subprocess.Popen([executable('psql'),'-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-c',script],env=self.env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        time.sleep(.3)
        reserve=self.run_sql("SET statement_timeout='5s'; SET ROLE service_role; SELECT royal_room_reserve_room('race','u','race-after','nix_command',NULL)")
        out,err=proc.communicate(timeout=8)
        self.assertEqual(proc.returncode,0,err+out)
        self.assertNotEqual(reserve.returncode,0)
        self.assertIn('ROOM_WALLET_FROZEN_FOR_REVIEW',reserve.stderr)
        # Reservas anteriores podem terminar, inclusive falha, mas nunca voltam
        # a ficar disponíveis enquanto a revisão estiver aberta.
        self.service("SELECT royal_room_settle_room('race-before','failed',NULL,NULL,'failed')")
        self.assertEqual(self.wallet('race')['reserved_rooms'],0)
        self.assertEqual(self.service("SELECT royal_room_stats('race','u')")['available_rooms'],0)

    def test_09_access_controls(self):
        self.fails("SET ROLE service_role; UPDATE royal_room_purchase_orders SET direct_refund_observed=false WHERE guild_id='legacy'",'permission denied')
        self.fails("SET ROLE service_role; UPDATE royal_room_wallets SET direct_refund_review=false WHERE guild_id='legacy'",'permission denied')
        self.fails("SET ROLE anon; SELECT royal_room_apply_payment('00000000-0000-0000-0000-000000000000','x','approved',30,'BRL','x',0,NULL)",'permission denied')

    def test_10_reservation_wins_and_settlement_is_preserved(self):
        oid=self.order('race-reserve-first')
        self.service(self.apply(oid,'approved'))
        script="BEGIN; SET ROLE service_role; SELECT royal_room_reserve_room('race-reserve-first','u','reserved-first','nix_command',NULL); SELECT pg_sleep(1.2); COMMIT;"
        proc=subprocess.Popen([executable('psql'),'-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-c',script],env=self.env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        time.sleep(.3)
        partial=self.run_sql("SET statement_timeout='5s'; SET ROLE service_role; "+self.apply(oid,'approved',1))
        out,err=proc.communicate(timeout=8)
        self.assertEqual(proc.returncode,0,err+out)
        self.assertEqual(partial.returncode,0,partial.stderr)
        self.assertEqual(self.wallet('race-reserve-first')['reserved_rooms'],1)
        self.assertEqual(self.service("SELECT royal_room_settle_room('reserved-first','created','room',NULL,NULL)")['status'],'created')
        w=self.wallet('race-reserve-first')
        self.assertEqual((w['reserved_rooms'],w['consumed_rooms'],w['purchased_rooms'],w['is_frozen']),(0,1,10,True))
        self.fails("SET ROLE service_role; SELECT royal_room_reserve_room('race-reserve-first','u','too-late','nix_command',NULL)",'ROOM_WALLET_FROZEN_FOR_REVIEW')

    def test_11_two_orders_one_pool_and_refund_rollback(self):
        first=self.order('same-pool')
        second=self.service("SELECT royal_room_create_purchase('same-pool','u','second-same-pool',10,NULL,'u@example.com')")['id']
        self.service(self.apply(first,'approved'))
        self.service(self.apply(second,'approved'))
        self.service(self.apply(first,'approved',3))
        self.service(self.apply(second,'approved',5))
        self.assertEqual(self.wallet('same-pool')['purchased_rooms'],20)
        self.assertTrue(self.wallet('same-pool')['direct_refund_review'])
        self.sql("CREATE FUNCTION pag04_fail_reversal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.guild_id='same-pool' AND NEW.event_type='reversed' THEN RAISE EXCEPTION 'REVERSAL_INJECTED'; END IF; RETURN NEW; END $$; CREATE TRIGGER pag04_fail_reversal BEFORE INSERT ON royal_room_ledger FOR EACH ROW EXECUTE FUNCTION pag04_fail_reversal()")
        try:
            self.fails('SET ROLE service_role; '+self.apply(first,'refunded',30),'REVERSAL_INJECTED')
            self.assertEqual(self.wallet('same-pool')['reversed_rooms'],0)
            self.assertEqual(self.sql(f"SELECT status||':'||direct_refunded_cents FROM royal_room_purchase_orders WHERE id='{first}'"),'manual_review:3')
        finally:
            self.sql('DROP TRIGGER pag04_fail_reversal ON royal_room_ledger; DROP FUNCTION pag04_fail_reversal()')
        self.service(self.apply(first,'refunded',30))
        self.assertEqual(self.wallet('same-pool')['reversed_rooms'],10)
        self.assertTrue(self.wallet('same-pool')['is_frozen'])
        self.assertEqual(self.sql(f"SELECT status FROM royal_room_purchase_orders WHERE id='{second}'"),'manual_review')

    def test_12_inherited_order_writes_abort_reapplication(self):
        self.sql('CREATE ROLE pag04_writer NOLOGIN; GRANT UPDATE (direct_refund_observed) ON royal_room_purchase_orders TO pag04_writer; GRANT pag04_writer TO service_role; ALTER ROLE service_role NOINHERIT')
        try:
            p=subprocess.run([executable('psql'),'-X','-q','-v','ON_ERROR_STOP=1','-f',str(MIGRATIONS/TARGET)],env=self.env,capture_output=True,text=True,timeout=20)
            self.assertNotEqual(p.returncode,0)
            self.assertIn('ROOM_ORDER_DIRECT_WRITE_UNSAFE',p.stderr)
            self.assertEqual(self.sql("SELECT has_column_privilege('pag04_writer','royal_room_purchase_orders','direct_refund_observed','UPDATE')"),'t')
        finally:
            self.sql('REVOKE pag04_writer FROM service_role; REVOKE UPDATE (direct_refund_observed) ON royal_room_purchase_orders FROM pag04_writer; ALTER ROLE service_role INHERIT; DROP ROLE pag04_writer')

    def test_13_settlement_wins_before_partial_refund(self):
        oid=self.order('race-settle-first')
        self.service(self.apply(oid,'approved'))
        self.service("SELECT royal_room_reserve_room('race-settle-first','u','settle-first','nix_command',NULL)")
        script="BEGIN; SET ROLE service_role; SELECT royal_room_settle_room('settle-first','created','room',NULL,NULL); SELECT pg_sleep(1.2); COMMIT;"
        proc=subprocess.Popen([executable('psql'),'-X','-q','-A','-t','-v','ON_ERROR_STOP=1','-c',script],env=self.env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        time.sleep(.3)
        refund=self.run_sql("SET statement_timeout='5s'; SET ROLE service_role; "+self.apply(oid,'approved',1))
        out,err=proc.communicate(timeout=8)
        self.assertEqual(proc.returncode,0,err+out)
        self.assertEqual(refund.returncode,0,refund.stderr)
        w=self.wallet('race-settle-first')
        self.assertEqual((w['purchased_rooms'],w['reserved_rooms'],w['consumed_rooms'],w['reversed_rooms'],w['is_frozen']),(10,0,1,0,True))

    def test_14_full_refund_without_prior_partial_preserves_debt(self):
        oid=self.order('full-only')
        self.service(self.apply(oid,'approved'))
        self.service("SELECT royal_room_reserve_room('full-only','u','full-used','nix_command',NULL)")
        self.service("SELECT royal_room_settle_room('full-used','created','room',NULL,NULL)")
        self.service("SELECT royal_room_reserve_room('full-only','u','full-pending','nix_command',NULL)")
        self.assertEqual(self.service(self.apply(oid,'refunded',30))['status'],'refunded')
        self.service("SELECT royal_room_settle_room('full-pending','failed',NULL,NULL,'failed')")
        w=self.wallet('full-only')
        self.assertEqual((w['purchased_rooms'],w['reserved_rooms'],w['consumed_rooms'],w['reversed_rooms'],w['is_frozen']),(10,0,1,10,False))
        self.assertEqual(self.service("SELECT royal_room_stats('full-only','u')")['available_rooms'],-1)
        self.fails("SET ROLE service_role; SELECT royal_room_reserve_room('full-only','u','full-next','nix_command',NULL)",'INSUFFICIENT_ROOM_CREDITS')

    def test_15_cutover_quarantines_duplicate_and_requeues_legacy_processed(self):
        self.assertEqual(self.sql("SELECT balance_cents||':'||is_frozen||':'||frozen_reason FROM royal_wallet_balances WHERE guild_id='legacy-money'"), '2200:true:topup_ledger_cutover')
        self.assertTrue(self.wallet('legacy-money')['is_frozen'])
        self.assertEqual(self.service("SELECT royal_wallet_purchase_rooms('legacy-money','u','legacy-spend',1,3)")['status'],'wallet_frozen')
        self.assertEqual(self.sql(f"SELECT status FROM royal_room_mp_webhook_events WHERE id='{self.legacy_event}'"),'pending')

    def test_16_topup_replay_after_freeze_real_reconciliation_and_parallel_approval(self):
        oid=self.service("SELECT royal_wallet_create_topup('money-replay','u','money-replay',1000,'u@example.com')")['id']
        self.assertEqual(self.service(self.apply_topup(oid))['balance_cents'],1100)
        self.assertTrue(self.service(self.apply_topup(oid,'approved',100))['wallet_frozen'])
        self.assertEqual(self.service(self.apply_topup(oid))['status'],'manual_review')
        self.reconcile('money-replay',oid)
        calls=["SET ROLE service_role; "+self.apply_topup(oid) for _ in range(20)]
        # Ambas as assinaturas públicas devem compartilhar a mesma correção.
        calls += [f"SET ROLE service_role; SELECT royal_wallet_apply_topup_payment('{oid}','pay-{oid}','approved',1000,'BRL','{oid}','pix')"]
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            results=list(pool.map(self.run_sql,calls))
        self.assertTrue(all(p.returncode==0 for p in results),[p.stderr for p in results])
        self.assertEqual(self.sql("SELECT balance_cents||':'||is_frozen FROM royal_wallet_balances WHERE guild_id='money-replay'"),'1100:false')
        self.assertEqual(self.sql(f"SELECT count(*) FROM royal_wallet_topup_ledger WHERE request_id='topup:{oid}'"),'1')
        self.assertEqual(self.sql(f"SELECT sum(delta_cents) FROM royal_wallet_topup_ledger WHERE guild_id='money-replay'"),'1100')

    def test_17_topup_credit_and_ledger_rollback_together(self):
        oid=self.service("SELECT royal_wallet_create_topup('money-rollback','u','money-rollback',1000,'u@example.com')")['id']
        self.sql("CREATE FUNCTION fail_money() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.guild_id='money-rollback' AND NEW.balance_cents>0 THEN RAISE EXCEPTION 'MONEY_INJECTED'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_money BEFORE UPDATE ON royal_wallet_balances FOR EACH ROW EXECUTE FUNCTION fail_money()")
        try:
            self.fails('SET ROLE service_role; '+self.apply_topup(oid),'MONEY_INJECTED')
            self.assertEqual(self.sql(f"SELECT count(*) FROM royal_wallet_topup_ledger WHERE request_id='topup:{oid}'"),'0')
            self.assertEqual(self.sql(f"SELECT status FROM royal_wallet_topups WHERE id='{oid}'"),'creating')
            self.assertEqual(self.sql("SELECT count(*) FROM royal_wallet_balances WHERE guild_id='money-rollback'"),'0')
        finally:
            self.sql('DROP TRIGGER fail_money ON royal_wallet_balances; DROP FUNCTION fail_money()')
        self.assertEqual(self.service(self.apply_topup(oid))['balance_cents'],1100)

    def test_18_corrupt_or_missing_topup_ledger_never_grants_credit(self):
        oid=self.service("SELECT royal_wallet_create_topup('money-corrupt','u','money-corrupt',1000,'u@example.com')")['id']
        self.sql(f"INSERT INTO royal_wallet_topup_ledger(guild_id,user_id,request_id,event_type,delta_cents,topup_id,balance_after_cents) VALUES('money-corrupt','u','topup:{oid}','room_purchase',0,'{oid}',0)")
        result=self.service(self.apply_topup(oid))
        self.assertEqual((result['status'],result['error_code'],result['wallet_frozen']),('manual_review','topup_ledger_inconsistent',True))
        self.assertEqual(self.sql("SELECT balance_cents FROM royal_wallet_balances WHERE guild_id='money-corrupt'"),'0')
        oid2=self.service("SELECT royal_wallet_create_topup('money-missing','u','money-missing',1000,'u@example.com')")['id']
        self.sql(f"UPDATE royal_wallet_topups SET status='approved',approved_at=now() WHERE id='{oid2}'")
        result=self.service(self.apply_topup(oid2))
        self.assertEqual(result['error_code'],'topup_ledger_inconsistent')
        self.assertEqual(self.sql(f"SELECT count(*) FROM royal_wallet_topup_ledger WHERE request_id='topup:{oid2}'"),'0')

    def test_19_queue_repeated_keys_concurrency_leases_and_rollback(self):
        self.sql('DELETE FROM royal_room_mp_webhook_events')
        enqueue="SET ROLE service_role; SELECT royal_room_enqueue_payment_event('same-provider-id','123','payment.updated')"
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            results=list(pool.map(lambda _:self.run_sql(enqueue),range(24)))
        self.assertTrue(all(p.returncode==0 for p in results),[p.stderr for p in results])
        self.assertEqual(self.sql("SELECT count(*)||':'||count(DISTINCT event_key) FROM royal_room_mp_webhook_events"),'24:24')
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            claims=list(pool.map(lambda _:self.run_sql("SET ROLE service_role; SELECT row_to_json(e) FROM royal_room_claim_payment_events(1) e"),range(24)))
        self.assertTrue(all(p.returncode==0 for p in claims),[p.stderr for p in claims])
        ids=[json.loads(p.stdout)['id'] for p in claims]
        self.assertEqual(len(set(ids)),24)
        target=ids[0]
        new=self.service("SELECT royal_room_enqueue_payment_event('same-provider-id','123','payment.updated')")['id']
        self.service(f"SELECT to_jsonb(royal_room_finish_payment_event('{target}',true,NULL,1))")
        self.assertEqual(self.sql(f"SELECT status FROM royal_room_mp_webhook_events WHERE id='{new}'"),'pending')
        self.sql(f"UPDATE royal_room_mp_webhook_events SET lease_until=now()-interval '1 second' WHERE id='{ids[1]}'")
        claim=self.call("SET ROLE service_role; SELECT row_to_json(e) FROM royal_room_claim_payment_events(1) e")
        self.assertEqual((claim['id'],claim['attempts']),(ids[1],2))
        self.service(f"SELECT to_jsonb(royal_room_finish_payment_event('{ids[1]}',true,NULL,1))")
        self.assertEqual(self.sql(f"SELECT status||':'||attempts FROM royal_room_mp_webhook_events WHERE id='{ids[1]}'"),'processing:2')
        self.service(f"SELECT to_jsonb(royal_room_finish_payment_event('{ids[1]}',false,'test',2))")
        self.assertEqual(self.sql(f"SELECT status FROM royal_room_mp_webhook_events WHERE id='{ids[1]}'"),'pending')
        self.fails(f"SET ROLE service_role; SELECT royal_room_finish_payment_event('{ids[1]}',true,NULL)",'permission denied')
        self.sql("BEGIN; SELECT royal_room_enqueue_payment_event('rollback-key','999','payment.updated'); ROLLBACK")
        self.assertEqual(self.sql("SELECT count(*) FROM royal_room_mp_webhook_events WHERE payment_id='999'"),'0')
        self.fails("SET ROLE anon; SELECT royal_room_enqueue_payment_event('x','123','payment.updated')",'permission denied')

    def test_20_http_worker_against_real_postgres(self):
        self.sql('DELETE FROM royal_room_mp_webhook_events')
        p=subprocess.run(['node',str(ROOT/'testes'/'webhook-at-least-once-integration.js')],env=self.env,capture_output=True,text=True,timeout=60)
        self.assertEqual(p.returncode,0,p.stdout+'\n'+p.stderr)

    def test_21_concurrent_first_topup_credits_exactly_once(self):
        oid=self.service("SELECT royal_wallet_create_topup('money-first-race','u','money-first-race',1000,'u@example.com')")['id']
        with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
            results=list(pool.map(lambda _:self.run_sql('SET ROLE service_role; '+self.apply_topup(oid)),range(24)))
        self.assertTrue(all(p.returncode==0 for p in results),[p.stderr for p in results])
        self.assertEqual(self.sql("SELECT balance_cents FROM royal_wallet_balances WHERE guild_id='money-first-race'"),'1100')
        self.assertEqual(self.sql(f"SELECT count(*) FROM royal_wallet_topup_ledger WHERE request_id='topup:{oid}'"),'1')

    def test_22_same_refund_after_resolution_opens_a_new_review(self):
        oid=self.service("SELECT royal_wallet_create_topup('money-repeat','u','money-repeat',1000,'u@example.com')")['id']
        self.service(self.apply_topup(oid))
        self.service(self.apply_topup(oid,'approved',100))
        self.reconcile('money-repeat',oid)
        self.service(self.apply_topup(oid))
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            results=list(pool.map(lambda _:self.run_sql('SET ROLE service_role; '+self.apply_topup(oid,'approved',100)),range(12)))
        self.assertTrue(all(p.returncode==0 for p in results),[p.stderr for p in results])
        self.assertEqual(self.sql(f"SELECT count(*) FROM royal_wallet_topup_ledger WHERE topup_id='{oid}' AND detail->>'wallet_frozen'='true'"),'2')
        self.reconcile('money-repeat',oid)
        self.service(self.apply_topup(oid))
        self.assertEqual(self.sql("SELECT balance_cents||':'||is_frozen FROM royal_wallet_balances WHERE guild_id='money-repeat'"),'1100:false')

    def test_23_balance_quarantine_is_sticky_and_role_writes_are_denied(self):
        self.fails("UPDATE royal_wallet_balances SET is_frozen=false WHERE guild_id='legacy-money'",'royal_wallet_topup_ledger_review_check')
        self.fails("SET ROLE service_role; UPDATE royal_wallet_balances SET topup_ledger_review=false WHERE guild_id='legacy-money'",'permission denied')
        self.sql('CREATE ROLE money_writer NOLOGIN; GRANT UPDATE (topup_ledger_review) ON royal_wallet_balances TO money_writer; GRANT money_writer TO service_role; ALTER ROLE service_role NOINHERIT')
        try:
            p=subprocess.run([executable('psql'),'-X','-q','-v','ON_ERROR_STOP=1','-f',str(MIGRATIONS/TARGET)],env=self.env,capture_output=True,text=True,timeout=20)
            self.assertNotEqual(p.returncode,0)
            self.assertIn('WALLET_BALANCE_DIRECT_WRITE_UNSAFE',p.stderr)
        finally:
            self.sql('REVOKE money_writer FROM service_role; REVOKE UPDATE (topup_ledger_review) ON royal_wallet_balances FROM money_writer; ALTER ROLE service_role INHERIT; DROP ROLE money_writer')


if __name__ == '__main__':
    unittest.main(verbosity=2)
