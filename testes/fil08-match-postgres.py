#!/usr/bin/env python3
"""Use testes/fil08-match-postgres.sh: somente cluster descartável local."""
import concurrent.futures
import json
import os
from pathlib import Path
import subprocess

if os.environ.get('ROYAL_FIL08_TEST_ISOLATED') != '1':
    raise SystemExit('Use testes/fil08-match-postgres.sh; nunca execute em banco remoto.')
ROOT = Path(__file__).resolve().parent.parent
BASE = ['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1']

def run(sql, ok=True):
    p = subprocess.run(BASE + ['-c', sql], text=True, capture_output=True, timeout=45)
    if ok and p.returncode:
        raise AssertionError(f'SQL falhou: {sql}\n{p.stderr}')
    if not ok and not p.returncode:
        raise AssertionError(f'SQL deveria falhar: {sql}\n{p.stdout}')
    return p.stdout.strip() if ok else p.stderr

def file(path):
    p = subprocess.run(BASE + ['-f', str(path)], text=True, capture_output=True, timeout=60)
    assert p.returncode == 0, (path, p.stderr)

def check(sql, expected):
    result = run(sql)
    assert result == str(expected), (sql, result, expected)

def match(ident, status='em_andamento'):
    run(f"""INSERT INTO royal_partidas(id,guild_id,modo,preco,gelo,canal_id,mensagem_id,status,criado_em)
      VALUES('{ident}','g','solo',50,'normal','c','msg','{status}',1);
      INSERT INTO royal_partida_jogadores(partida_id,user_id,time,confirmou,ordem)
      VALUES('{ident}','a-{ident}',1,1,1),('{ident}','b-{ident}',2,1,2)""")

def finish(ident, winner=1, reason='resultado', cancel=False):
    return f"SELECT royal_operacional_encerrar_partida('{ident}',{('NULL' if cancel else winner)},'med','{reason}',{str(cancel).lower()})"

def parallel(sqls):
    def execute(sql):
        return subprocess.run(BASE + ['-c', f'BEGIN; SELECT pg_sleep(0.2); {sql}; COMMIT'],
                              text=True, capture_output=True, timeout=45)
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(sqls)) as pool:
        return list(pool.map(execute, sqls))

run("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA auth; CREATE FUNCTION auth.role() RETURNS text LANGUAGE SQL AS $$ SELECT 'service_role'::text $$")
migrations = ROOT / 'supabase/migrations'
target = migrations / '20261120002004_fil08_match_outbox.sql'
for path in sorted(migrations.glob('*.sql')):
    if path.name < target.name:
        file(path)
# A antiga RPC deixa uma finalização sem aplicação econômica em caso de crash.
match('legacy-missing')
run(finish('legacy-missing'))
match('legacy-applied')
run(finish('legacy-applied'))
run("""SELECT royal_apply_match_result('g','legacy-applied',1,50,'resultado',
  '[{"user_id":"a-legacy-applied","team":1,"confirmed":true},{"user_id":"b-legacy-applied","team":2,"confirmed":true}]')""")
file(target)
file(target)
check("SELECT count(*) FROM royal_match_outbox WHERE partida_id='legacy-missing' AND tipo='economia_legada'", 1)
check("SELECT estado FROM royal_match_outbox WHERE partida_id='legacy-missing'", 'revisao')
assert 'revisão econômica' in run(finish('legacy-missing'), ok=False)
check("SELECT count(*) FROM royal_profiles WHERE user_id='a-legacy-missing'", 0)
# Liberação por operador após revisão comprovada da origem (simulada aqui).
run("UPDATE royal_match_outbox SET estado='pendente' WHERE partida_id='legacy-missing' AND tipo='economia_legada'")
check("SELECT count(*) FROM royal_match_outbox WHERE partida_id='legacy-applied'", 0)
for func in ('royal_operacional_encerrar_partida(text,integer,text,text,boolean)',
             'royal_match_outbox_reivindicar(uuid)', 'royal_match_outbox_concluir(bigint,uuid,boolean,text)',
             'royal_match_outbox_economia_legada(bigint,uuid)'):
    for role, expected in [('anon','f'), ('authenticated','f'), ('service_role','t')]:
        check(f"SELECT has_function_privilege('{role}','{func}','EXECUTE')", expected)
check("SELECT has_table_privilege('anon','royal_match_outbox','SELECT')", 'f')
check("SELECT relrowsecurity FROM pg_class WHERE oid='royal_match_outbox'::regclass", 't')
# A aplicação real executa como service_role sem acesso direto de escrita à outbox.
match('service-role')
run('SET ROLE service_role; ' + finish('service-role'))
check("SELECT count(*) FROM royal_match_outbox WHERE partida_id='service-role'", 2)
assert 'permission denied' in run("SET ROLE service_role; UPDATE royal_match_outbox SET estado='concluido' WHERE partida_id='service-role'", ok=False)
# Isola a recuperação legada como única elegível no próximo teste.
run("UPDATE royal_match_outbox SET disponivel_em=clock_timestamp()+interval '1 hour' WHERE partida_id='service-role'")
print('OK migração reaplicável, recuperação legada e permissões')

# Lease e aplicação legada em uma única transação; replay concorrente não premia duas vezes.
token1 = '00000000-0000-4000-8000-000000000001'
token2 = '00000000-0000-4000-8000-000000000002'
event = json.loads(run(f"SELECT royal_match_outbox_reivindicar('{token1}')"))
assert event['tipo'] == 'economia_legada' and event['partida_id'] == 'legacy-missing'
check(f"SELECT royal_match_outbox_concluir({event['id']},'{token1}',true,NULL)", 'f')
result = parallel([f"SELECT royal_match_outbox_economia_legada({event['id']},'{token1}')", finish('legacy-missing')])
assert result[0].returncode == 0, result[0].stderr
assert result[1].returncode == 0 or 'revisão econômica' in result[1].stderr
check("SELECT coins||':'||wins FROM royal_profiles WHERE guild_id='g' AND user_id='a-legacy-missing'", '1:1')
run(finish('legacy-missing'))
check("SELECT count(*) FROM royal_wallet_ledger WHERE guild_id='g' AND user_id='a-legacy-missing' AND request_id='match-win:legacy-missing'", 1)
check(f"SELECT estado FROM royal_match_outbox WHERE id={event['id']}", 'concluido')
print('OK reconciliação legada concorrente e replay econômico')

# ROLLBACK simula crash antes do commit: absolutamente nada deve sobreviver.
match('rollback')
run('BEGIN; ' + finish('rollback') + '; ROLLBACK')
check("SELECT status FROM royal_partidas WHERE id='rollback'", 'em_andamento')
for table, where in [('royal_match_stats_applied', "match_id='rollback'"), ('royal_match_outbox', "partida_id='rollback'"), ('royal_audit_events', "entity_id='rollback'"), ('royal_wallet_ledger', "user_id='a-rollback'")]:
    check(f'SELECT count(*) FROM {table} WHERE {where}', 0)

# Um erro no ledger reverte resultado, estatísticas, auditoria e outbox.
match('colisao')
run("INSERT INTO royal_wallet_ledger(guild_id,user_id,asset,amount,balance_after,reason,request_id) VALUES('g','a-colisao','coins',1,1,'teste','match-win:colisao')")
assert 'duplicate key' in run(finish('colisao'), ok=False)
check("SELECT status FROM royal_partidas WHERE id='colisao'", 'em_andamento')
check("SELECT count(*) FROM royal_match_stats_applied WHERE match_id='colisao'", 0)
check("SELECT count(*) FROM royal_match_outbox WHERE partida_id='colisao'", 0)
check("SELECT count(*) FROM royal_profiles WHERE user_id='a-colisao'", 0)
check("SELECT count(*) FROM royal_audit_events WHERE entity_id='colisao'", 0)
# Falha ao inserir outbox após as mudanças econômicas também reverte tudo.
match('outbox-falha')
run("INSERT INTO royal_match_outbox(partida_id,tipo,payload) VALUES('outbox-falha','cartao','{}')")
assert 'duplicate key' in run(finish('outbox-falha'), ok=False)
check("SELECT status FROM royal_partidas WHERE id='outbox-falha'", 'em_andamento')
check("SELECT count(*) FROM royal_match_stats_applied WHERE match_id='outbox-falha'", 0)
check("SELECT count(*) FROM royal_profiles WHERE user_id='a-outbox-falha'", 0)
check("SELECT count(*) FROM royal_wallet_ledger WHERE user_id='a-outbox-falha'", 0)
check("SELECT count(*) FROM royal_audit_events WHERE entity_id='outbox-falha'", 0)
run("DELETE FROM royal_match_outbox WHERE partida_id='outbox-falha'")
print('OK rollback e erro econômico não deixam encerramento parcial')

match('concorrente')
results = parallel([finish('concorrente')] * 8)
assert all(p.returncode == 0 for p in results), [(p.stdout, p.stderr) for p in results]
check("SELECT coins||':'||wins||':'||apostado||':'||ganho FROM royal_profiles WHERE user_id='a-concorrente'", '1:1:50:50')
check("SELECT losses||':'||apostado FROM royal_profiles WHERE user_id='b-concorrente'", '1:50')
check("SELECT count(*) FROM royal_wallet_ledger WHERE user_id='a-concorrente'", 1)
check("SELECT count(*) FROM royal_audit_events WHERE entity_id='concorrente'", 1)
check("SELECT count(*) FROM royal_match_outbox WHERE partida_id='concorrente'", 2)
assert 'outro resultado' in run(finish('concorrente', 2), ok=False)
assert 'outro resultado' in run(finish('concorrente', 1, 'wo'), ok=False)
assert 'outro resultado' in run(finish('concorrente', reason='cancelada', cancel=True), ok=False)

match('disputa')
results = parallel([finish('disputa', 1), finish('disputa', 2), finish('disputa', reason='cancelada', cancel=True)])
assert sum(p.returncode == 0 for p in results) == 1, [(p.stdout, p.stderr) for p in results]
check("SELECT count(*) FROM royal_match_outbox WHERE partida_id='disputa'", 2)
check("SELECT count(*) FROM royal_audit_events WHERE entity_id='disputa'", 1)
check("SELECT count(*) FROM royal_match_stats_applied WHERE match_id='disputa'", run("SELECT CASE WHEN status='finalizada' THEN 1 ELSE 0 END FROM royal_partidas WHERE id='disputa'"))
match('wo')
run(finish('wo', 2, 'wo'))
run(finish('wo', 2, 'wo'))
check("SELECT losses||':'||wos FROM royal_profiles WHERE user_id='a-wo'", '1:1')
match('cancelada')
run(finish('cancelada', reason='motivo', cancel=True))
run(finish('cancelada', reason='motivo', cancel=True))
check("SELECT count(*) FROM royal_match_stats_applied WHERE match_id='cancelada'", 0)
check("SELECT count(*) FROM royal_match_outbox WHERE partida_id='cancelada'", 2)
# Múltiplos jogadores vencedores recebem exatamente um coin cada.
match('multijogador')
run("INSERT INTO royal_partida_jogadores(partida_id,user_id,time,confirmou,ordem) VALUES('multijogador','terceiro',1,1,3)")
run(finish('multijogador'))
run(finish('multijogador'))
check("SELECT count(*) FROM royal_wallet_ledger WHERE guild_id='g' AND request_id='match-win:multijogador'", 2)
check("SELECT coins||':'||wins FROM royal_profiles WHERE user_id='terceiro'", '1:1')
print('OK concorrência, replay, divergências, WO e cancelamento')

# Vários consumidores disputam apenas os dois eventos elegíveis.
match('claims')
run(finish('claims'))
run("UPDATE royal_match_outbox SET disponivel_em=clock_timestamp()+interval '1 hour' WHERE estado='pendente'")
run("UPDATE royal_match_outbox SET disponivel_em=clock_timestamp()-interval '1 second' WHERE partida_id='claims'")
claims = parallel([f"SELECT royal_match_outbox_reivindicar('00000000-0000-4000-8000-{i:012d}')" for i in range(10, 16)])
assert all(p.returncode == 0 for p in claims), [p.stderr for p in claims]
claimed = [json.loads(p.stdout.strip()) if p.stdout.strip() else None for p in claims]
ids = [e['id'] for e in claimed if e]
assert len(ids) == len(set(ids)) == 2, claimed
print('OK reivindicações concorrentes não compartilham eventos')

# Expiração simula morte do trabalhador; token anterior não confirma nem reagenda.
run("UPDATE royal_match_outbox SET disponivel_em=clock_timestamp()+interval '1 hour' WHERE estado='pendente'")
run("UPDATE royal_match_outbox SET disponivel_em=clock_timestamp()-interval '1 second' WHERE partida_id='concorrente' AND tipo='cartao'")
event = json.loads(run(f"SELECT royal_match_outbox_reivindicar('{token1}')"))
assert isinstance(event['id'], str) and event['tipo'] == 'cartao'
run(f"UPDATE royal_match_outbox SET lease_ate=clock_timestamp()-interval '1 second' WHERE id={event['id']}")
assert json.loads(run(f"SELECT royal_match_outbox_reivindicar('{token2}')"))['id'] == event['id']
check(f"SELECT royal_match_outbox_concluir({event['id']},'{token1}',true,NULL)", 'f')
check(f"SELECT royal_match_outbox_concluir({event['id']},'{token1}',false,'erro')", 'f')
check(f"SELECT royal_match_outbox_concluir({event['id']},'{token2}',false,'erro')", 't')
check(f"SELECT estado||':'||tentativas FROM royal_match_outbox WHERE id={event['id']}", 'pendente:2')
run(f"UPDATE royal_match_outbox SET disponivel_em=clock_timestamp()-interval '1 second' WHERE id={event['id']}")
assert json.loads(run(f"SELECT royal_match_outbox_reivindicar('{token1}')"))['id'] == event['id']
check(f"SELECT royal_match_outbox_concluir({event['id']},'{token1}',true,NULL)", 't')
# ID bigint acima da precisão do JavaScript é devolvido como string.
match('bigid')
run("INSERT INTO royal_match_outbox(id,partida_id,tipo,payload) VALUES(9007199254740993,'bigid','cartao','{}')")
event = json.loads(run(f"SELECT royal_match_outbox_reivindicar('{token2}')"))
assert event['id'] == '9007199254740993'
check(f"SELECT royal_match_outbox_concluir({event['id']},'{token2}',true,NULL)", 't')
print('OK recuperação de lease, fencing e reagendamento')
