#!/usr/bin/env python3
"""Execute apenas em cluster temporário de pg_virtualenv, jamais no banco remoto."""
import concurrent.futures
import json
import os
from pathlib import Path
import re
import subprocess
import time

if os.environ.get('ROYAL_PRONTIDAO_TEST_ISOLATED') != '1':
    raise SystemExit('Use testes/prontidao-postgres.sh para criar um PostgreSQL temporário.')
ROOT = Path(__file__).resolve().parent.parent
BASE = ['psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1']

def run(sql, ok=True, env=None):
    p = subprocess.run(BASE + ['-c', sql], text=True, capture_output=True, env=env, timeout=30)
    if ok and p.returncode:
        raise AssertionError(f'SQL falhou: {sql}\n{p.stderr}')
    if not ok and not p.returncode:
        raise AssertionError(f'SQL deveria falhar: {sql}\n{p.stdout}')
    return p.stdout.strip() if ok else p.stderr

def check(sql, expected):
    value = run(sql)
    assert value == expected, (sql, value, expected)

def hold(name, sql):
    child = subprocess.Popen(BASE + ['-c', f'BEGIN; {sql}; SELECT pg_sleep(1.5); COMMIT'],
                             text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             env=dict(os.environ, PGAPPNAME=name))
    for _ in range(250):
        if child.poll() is not None:
            raise AssertionError(child.communicate())
        if run(f"SELECT count(*) FROM pg_stat_activity WHERE application_name='{name}' AND wait_event='PgSleep'") == '1':
            return child
        time.sleep(.02)
    child.kill()
    raise AssertionError('Transação não atingiu o marco')

def joined(child):
    out, err = child.communicate(timeout=10)
    assert child.returncode == 0, (out, err)
    return out

run('''
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE royal_partidas (
 id text PRIMARY KEY, guild_id text NOT NULL, canal_id text NOT NULL, status text NOT NULL,
 regras text,regras_por text,mediador_id text,comissao double precision DEFAULT 0,
 pago_em bigint,sala_id text,sala_senha text,nix_sessao text,liberada_em bigint,mensagem_id text
);
CREATE TABLE royal_partida_jogadores (
 partida_id text NOT NULL REFERENCES royal_partidas(id),user_id text NOT NULL,time integer NOT NULL,
 PRIMARY KEY(partida_id,user_id)
);
CREATE TABLE royal_partida_go (
 partida_id text NOT NULL,user_id text NOT NULL,criado_em bigint NOT NULL,
 PRIMARY KEY(partida_id,user_id),FOREIGN KEY(partida_id,user_id) REFERENCES royal_partida_jogadores(partida_id,user_id)
);
CREATE FUNCTION royal_operacional_agora() RETURNS bigint LANGUAGE SQL VOLATILE AS $$
 SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint $$;
''')
original = (ROOT / 'supabase/migrations/20261116060000_operational_supabase.sql').read_text()
for name in ('royal_operacional_alterar_partida', 'royal_operacional_dar_go'):
    func = re.search(rf'CREATE OR REPLACE FUNCTION public\.{name}\([\s\S]*?END \$\$;', original)
    assert func, name
    run(func.group(0))
migration = ROOT / 'supabase/migrations/20261120000400_match_readiness_manual_room.sql'
for _ in range(2):
    p = subprocess.run(BASE + ['-f', str(migration)], text=True, capture_output=True, timeout=30)
    assert p.returncode == 0, p.stderr
for func in ('royal_operacional_dar_go(text,text,text,text,text,bigint)', 'royal_operacional_publicar_sala_manual(text,text,text,text,text,bigint,text,text)', 'royal_operacional_alterar_partida(text,text,jsonb)'):
    for role, privilege in [('anon', 'f'), ('authenticated', 'f'), ('service_role', 't')]:
        check(f"SELECT has_function_privilege('{role}','{func}','EXECUTE')", privilege)
for role in ('anon', 'authenticated', 'service_role'):
    check(f"SELECT has_function_privilege('{role}','royal_operacional_proteger_sala()','EXECUTE')", 'f')
print('OK migração reaplicável e RPCs restritas a service_role')

def match(ident, status='sala_liberada'):
    run(f"INSERT INTO royal_partidas(id,guild_id,canal_id,status,mediador_id,mensagem_id) VALUES('{ident}','g','c','{status}','med','msg'); INSERT INTO royal_partida_jogadores VALUES('{ident}','a',1),('{ident}','b',2)")

def ready(ident, user, ok=True, message='msg', version=0):
    return run(f"SET ROLE service_role; SELECT royal_operacional_dar_go('{ident}','{user}','g','c','{message}',{version})", ok=ok)

def room(ident, guild='g', canal='c', med='med', room_id='123', password='456', ok=True, message='msg', version=0):
    return run(f"SET ROLE service_role; SELECT royal_operacional_publicar_sala_manual('{ident}','{guild}','{canal}','{message}','{med}',{version},'{room_id}','{password}')", ok=ok)

def legacy_sql(ident, action='sala', **data):
    payload = json.dumps(data, ensure_ascii=False).replace("'", "''")
    return f"SELECT royal_operacional_alterar_partida('{ident}','{action}','{payload}'::jsonb)"

def legacy(ident, action='sala', ok=True, **data):
    # A regressão acontece com o papel que realmente pode executar a RPC.
    return run('SET ROLE service_role; ' + legacy_sql(ident, action, **data), ok=ok)

# Sem privilégios diretos na função de trigger, o service_role ainda pode
# acessar a tabela como na instalação real e o trigger executa como dono.
run('GRANT SELECT, UPDATE ON royal_partidas TO service_role')

match('outros-ramos', 'confirmando')
assert json.loads(legacy('outros-ramos', 'regras', regras=' regra válida ', autor_id='staff'))['regras'] == 'regra válida'
assert json.loads(legacy('outros-ramos', 'assumir', mediador_id='med', comissao=0.05))['status'] == 'aguardando_pagamento'
assert 'mediador responsável' in legacy('outros-ramos', 'assumir', ok=False, mediador_id='outro')
assert 'pagamento' in legacy('outros-ramos', ok=False, sala_id='123')
assert json.loads(legacy('outros-ramos', 'pago'))['status'] == 'pago'
assert 'inválida' in legacy('outros-ramos', 'desconhecida', ok=False)
check("SELECT sala_versao::text FROM royal_partidas WHERE id='outros-ramos'", '0')
print('OK regras, mediação, pagamento e erro de ação preservados')

match('legada', 'pago')
assert 'ID da sala' in legacy('legada', ok=False, sala_id=' ')
criada = json.loads(legacy('legada', sala_id=' 123 ', sala_senha=' 456 ', nix_sessao=' sessao '))
assert (criada['status'], criada['sala_id'], criada['sala_senha'], criada['nix_sessao'], criada['sala_versao']) == ('sala_liberada', '123', '456', 'sessao', 1)
assert 'credenciais foram alteradas' in ready('legada', 'a', version=0, ok=False)
# Nix preserva a sessão se o chamador não fornece outra; trocá-la também versiona.
assert json.loads(legacy('legada', sala_id='124', sala_senha='456', nix_sessao=None))['nix_sessao'] == 'sessao'
assert json.loads(legacy('legada', sala_id='124', sala_senha='456', nix_sessao='sessao2'))['sala_versao'] == 3
assert json.loads(ready('legada', 'a', version=3))['deram'] == 1
assert json.loads(legacy('legada', 'regras', regras='regras após go', autor_id='staff'))['sala_versao'] == 3
antes = json.loads(run("SELECT row_to_json(p) FROM royal_partidas p WHERE id='legada'"))
for dados in [dict(sala_id='125', sala_senha='456', nix_sessao='sessao2'),
              dict(sala_id='124', sala_senha='outra', nix_sessao='sessao2'),
              dict(sala_id='124', sala_senha='456', nix_sessao='sessao3')]:
    assert 'prontidão' in legacy('legada', ok=False, **dados)
# Replay igual não muda nem timestamp, sessão ou versão, e mantém prontidão.
assert json.loads(legacy('legada', sala_id='124', sala_senha='456')) == antes
check("SELECT sala_id||':'||sala_senha||':'||nix_sessao||':'||sala_versao::text FROM royal_partidas WHERE id='legada'", '124:456:sessao2:3')
check("SELECT count(*) FROM royal_partida_go WHERE partida_id='legada'", '1')
assert json.loads(ready('legada', 'b', version=3))['iniciou']
assert 'pagamento' in legacy('legada', ok=False, sala_id='outra', sala_senha='456')
print('OK Nix legado versiona e não altera sala ou sessão depois da primeira prontidão')

# Uma alteração direta, inclusive somente de sessão, também passa pelo trigger.
match('direta', 'pago')
run("SET ROLE service_role; UPDATE royal_partidas SET sala_id='111', sala_senha='222', nix_sessao='s1', sala_versao=900 WHERE id='direta'")
check("SELECT sala_versao::text FROM royal_partidas WHERE id='direta'", '1')
publicada = json.loads(room('direta', version=1, room_id='111', password='222'))
assert publicada['sala_versao'] == 2  # publicação mesmo com credenciais já existentes
run("SET ROLE service_role; UPDATE royal_partidas SET nix_sessao='s2', sala_versao=0 WHERE id='direta'")
check("SELECT sala_versao::text FROM royal_partidas WHERE id='direta'", '3')
run("SET ROLE service_role; UPDATE royal_partidas SET sala_versao=0, regras='outras' WHERE id='direta'")
check("SELECT sala_versao::text FROM royal_partidas WHERE id='direta'", '3')
assert 'credenciais foram alteradas' in ready('direta', 'a', version=2, ok=False)
ready('direta', 'a', version=3)
assert 'prontidão' in run("SET ROLE service_role; UPDATE royal_partidas SET sala_senha='mudou' WHERE id='direta'", ok=False)
assert 'prontidão' in run("SET ROLE service_role; UPDATE royal_partidas SET nix_sessao='s3' WHERE id='direta'", ok=False)
check("SELECT sala_id||':'||sala_senha||':'||nix_sessao||':'||sala_versao::text FROM royal_partidas WHERE id='direta'", '111:222:s2:3')
check("SELECT count(*) FROM royal_partida_go WHERE partida_id='direta'", '1')
print('OK escrita direta protegida e versão não pode ser forjada')

match('pre', 'pago')
error = ready('pre', 'a', ok=False)
assert 'prontidão' in error and '/go' not in error
for values in [dict(guild='outra'), dict(canal='outro'), dict(med='outro')]:
    room('pre', ok=False, **values)
check("SELECT status FROM royal_partidas WHERE id='pre'", 'pago')
assert json.loads(room('pre'))['status'] == 'sala_liberada'
assert json.loads(room('pre'))['sala_versao'] == 1  # retentativa idêntica
assert 'desatualizado' in room('pre', room_id='999', ok=False)
assert json.loads(room('pre', room_id='999', version=1))['sala_versao'] == 2
check("SELECT sala_id||':'||sala_senha FROM royal_partidas WHERE id='pre'", '999:456')
assert 'não está' in ready('pre', 'intruso', ok=False, version=2)
print('OK sala manual protegida e sem acionamento externo, status e jogador verificados')

match('corrida')
users = ['a', 'b'] * 12
with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
    results = list(pool.map(lambda u: json.loads(ready('corrida', u)), users))
assert sum(r['iniciou'] for r in results) == 1
assert sum(not r['jaDeu'] for r in results) == 2
assert all(r['deram'] <= 2 and r['total'] == 2 for r in results)
check("SELECT count(*) FROM royal_partida_go WHERE partida_id='corrida'", '2')
check("SELECT status FROM royal_partidas WHERE id='corrida'", 'em_andamento')
print('OK 24 cliques concorrentes: duas confirmações, uma transição')

match('cancelada')
child = hold('cancel_lock', "UPDATE royal_partidas SET status='cancelada' WHERE id='cancelada'")
assert 'encerrada' in ready('cancelada', 'a', ok=False)
joined(child)
check("SELECT count(*) FROM royal_partida_go WHERE partida_id='cancelada'", '0')
print('OK encerramento concorrente prevalece quando adquire o lock primeiro')

match('manual', 'pago')
child = hold('manual_lock', "SELECT royal_operacional_publicar_sala_manual('manual','g','c','msg','med',0,'111','222')")
assert 'desatualizado' in room('manual', room_id='999', ok=False)
joined(child)
check("SELECT sala_id||':'||sala_senha||':'||status FROM royal_partidas WHERE id='manual'", '111:222:sala_liberada')
print('OK dois formulários manuais concorrentes não sobrescrevem credenciais')

# A versão e a mensagem são checadas depois de aguardar o mesmo FOR UPDATE.
match('card-ready')
child = hold('troca_ready', "UPDATE royal_partidas SET mensagem_id='nova' WHERE id='card-ready'")
assert 'cartão atual' in ready('card-ready', 'a', ok=False)
joined(child)
check("SELECT count(*) FROM royal_partida_go WHERE partida_id='card-ready'", '0')

match('card-modal', 'pago')
child = hold('troca_modal', "UPDATE royal_partidas SET mensagem_id='nova' WHERE id='card-modal'")
assert 'cartão atual' in room('card-modal', ok=False)
joined(child)
check("SELECT status FROM royal_partidas WHERE id='card-modal'", 'pago')

match('corrige', 'pago')
assert json.loads(room('corrige'))['sala_versao'] == 1
child = hold('corrige_lock', "SELECT royal_operacional_publicar_sala_manual('corrige','g','c','msg','med',1,'999','456')")
assert 'credenciais foram alteradas' in ready('corrige', 'a', ok=False, version=1)
joined(child)
check("SELECT count(*) FROM royal_partida_go WHERE partida_id='corrige'", '0')
# Uma correção antes da primeira prontidão é permitida; cartão antigo não regrava.
assert 'desatualizado' in room('corrige', version=1, room_id='987', ok=False)
assert json.loads(room('corrige', version=2, room_id='987'))['sala_versao'] == 3
assert json.loads(ready('corrige', 'a', version=3))['deram'] == 1
error = room('corrige', version=3, room_id='outra', ok=False)
assert 'prontidão' in error and 'cancel' in error and 'refa' in error
check("SELECT count(*) FROM royal_partida_go WHERE partida_id='corrige'", '1')
assert json.loads(room('corrige', version=2, room_id='987'))['sala_versao'] == 3
assert json.loads(ready('corrige', 'b', version=3))['iniciou']
assert json.loads(room('corrige', version=1, room_id='987'))['status'] == 'em_andamento'
assert 'prontidão' in room('corrige', version=3, room_id='outro', ok=False)
check("SELECT sala_id||':'||sala_versao::text FROM royal_partidas WHERE id='corrige'", '987:3')
print('OK correções antes da primeira prontidão e replay idêntico após prontidão')

# A prontidão retorna sucesso enquanto ainda segura o lock: a correção concorrente
# precisa esperar e ser recusada sem apagar a confirmação que acabou de persistir.
match('ready-first', 'pago')
room('ready-first')
child = hold('ready_lock', "SELECT royal_operacional_dar_go('ready-first','a','g','c','msg',1)")
error = room('ready-first', version=1, room_id='outro', ok=False)
assert 'prontidão' in error and 'cancel' in error and 'refa' in error
assert json.loads(joined(child).splitlines()[0])['deram'] == 1
check("SELECT sala_id FROM royal_partidas WHERE id='ready-first'", '123')
check("SELECT count(*) FROM royal_partida_go WHERE partida_id='ready-first'", '1')
assert json.loads(ready('ready-first', 'a', version=1))['jaDeu']
print('OK primeira prontidão concorrente impede correção sem apagar confirmação')

# A última prontidão pode iniciar enquanto um formulário está aberto.
match('last-ready', 'pago')
room('last-ready')
ready('last-ready', 'a', version=1)
child = hold('last_ready_lock', "SELECT royal_operacional_dar_go('last-ready','b','g','c','msg',1)")
assert 'prontidão' in room('last-ready', version=1, room_id='outro', ok=False)
joined(child)
check("SELECT sala_id FROM royal_partidas WHERE id='last-ready'", '123')
check("SELECT count(*) FROM royal_partida_go WHERE partida_id='last-ready'", '2')
print('OK última prontidão impede correção após início')

# Um replay devolve snapshot v1, mas pode chegar uma correção v2 em seguida.
# Isso demonstra por que o handler precisa reler depois da edição do Discord.
match('replay-corrige', 'pago')
room('replay-corrige')
child = hold('replay_lock', "SELECT royal_operacional_publicar_sala_manual('replay-corrige','g','c','msg','med',0,'123','456')")
corrigida = json.loads(room('replay-corrige', version=1, room_id='999'))
replay = json.loads(joined(child).splitlines()[0])
assert replay['sala_versao'] == 1 and replay['sala_id'] == '123'
assert corrigida['sala_versao'] == 2 and corrigida['sala_id'] == '999'
check("SELECT sala_id||':'||sala_versao::text FROM royal_partidas WHERE id='replay-corrige'", '999:2')
print('OK replay pode retornar snapshot anterior à correção concorrente')

# Os dois lados da corrida usam o lock da mesma linha, inclusive o papel Nix.
match('go-antes-legada', 'pago')
legacy('go-antes-legada', sala_id='123', sala_senha='456', nix_sessao='s1')
child = hold('go_antes_legada', "SELECT royal_operacional_dar_go('go-antes-legada','a','g','c','msg',1)")
assert 'prontidão' in legacy('go-antes-legada', sala_id='999', sala_senha='456', nix_sessao='s1', ok=False)
joined(child)
check("SELECT sala_id||':'||sala_versao::text FROM royal_partidas WHERE id='go-antes-legada'", '123:1')
check("SELECT count(*) FROM royal_partida_go WHERE partida_id='go-antes-legada'", '1')

match('legada-antes-go', 'pago')
legacy('legada-antes-go', sala_id='123', sala_senha='456', nix_sessao='s1')
child = hold('legada_antes_go', 'SET ROLE service_role; ' + legacy_sql('legada-antes-go', sala_id='999', sala_senha='456', nix_sessao='s1'))
assert 'credenciais foram alteradas' in ready('legada-antes-go', 'a', version=1, ok=False)
joined(child)
check("SELECT sala_id||':'||sala_versao::text FROM royal_partidas WHERE id='legada-antes-go'", '999:2')
check("SELECT count(*) FROM royal_partida_go WHERE partida_id='legada-antes-go'", '0')
assert json.loads(ready('legada-antes-go', 'a', version=2))['deram'] == 1
print('OK corrida entre prontidão e alteração legada em ambas as ordens')

match('go-antes-direta', 'pago')
room('go-antes-direta')
child = hold('go_antes_direta', "SELECT royal_operacional_dar_go('go-antes-direta','a','g','c','msg',1)")
assert 'prontidão' in run("SET ROLE service_role; UPDATE royal_partidas SET sala_id='999' WHERE id='go-antes-direta'", ok=False)
joined(child)
check("SELECT sala_id||':'||sala_versao::text FROM royal_partidas WHERE id='go-antes-direta'", '123:1')
check("SELECT count(*) FROM royal_partida_go WHERE partida_id='go-antes-direta'", '1')

match('direta-antes-go', 'pago')
room('direta-antes-go')
child = hold('direta_antes_go', "SET ROLE service_role; UPDATE royal_partidas SET sala_id='999' WHERE id='direta-antes-go'")
assert 'credenciais foram alteradas' in ready('direta-antes-go', 'a', version=1, ok=False)
joined(child)
check("SELECT sala_id||':'||sala_versao::text FROM royal_partidas WHERE id='direta-antes-go'", '999:2')
check("SELECT count(*) FROM royal_partida_go WHERE partida_id='direta-antes-go'", '0')
print('OK escrita direta e prontidão concorrentes protegidas nas duas ordens')

match('legada-antes-modal', 'pago')
room('legada-antes-modal')
child = hold('legada_antes_modal', 'SET ROLE service_role; ' + legacy_sql('legada-antes-modal', sala_id='999', sala_senha='456', nix_sessao='s1'))
assert 'desatualizado' in room('legada-antes-modal', version=1, room_id='777', ok=False)
joined(child)
check("SELECT sala_id||':'||sala_versao::text FROM royal_partidas WHERE id='legada-antes-modal'", '999:2')

# O contrato Nix legado não tem versão esperada. Antes da prontidão ele ainda
# pode substituir uma publicação manual; o cartão resultante é invalidado.
match('modal-antes-legada', 'pago')
room('modal-antes-legada')
child = hold('modal_antes_legada', "SELECT royal_operacional_publicar_sala_manual('modal-antes-legada','g','c','msg','med',1,'777','456')")
assert json.loads(legacy('modal-antes-legada', sala_id='999', sala_senha='456', nix_sessao='s1'))['sala_versao'] == 3
joined(child)
assert 'credenciais foram alteradas' in ready('modal-antes-legada', 'a', version=2, ok=False)
check("SELECT sala_id||':'||sala_versao::text FROM royal_partidas WHERE id='modal-antes-legada'", '999:3')

match('legadas-concorrentes', 'pago')
legacy('legadas-concorrentes', sala_id='inicio', sala_senha='456')
with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
    results = list(pool.map(lambda i: json.loads(legacy('legadas-concorrentes', sala_id=f'id-{i}', sala_senha='456')), range(10)))
assert sorted(r['sala_versao'] for r in results) == list(range(2, 12))
check("SELECT sala_versao::text FROM royal_partidas WHERE id='legadas-concorrentes'", '11')
assert 'credenciais foram alteradas' in ready('legadas-concorrentes', 'a', version=1, ok=False)
ready('legadas-concorrentes', 'a', version=11)
print('OK formulário obsoleto e incrementos atômicos em dez escritas legadas concorrentes')

match('rollback', 'pago')
room('rollback')
run('BEGIN; SET ROLE service_role; ' + legacy_sql('rollback', sala_id='999', sala_senha='456') + '; ROLLBACK')
check("SELECT sala_id||':'||sala_versao::text FROM royal_partidas WHERE id='rollback'", '123:1')
run("BEGIN; SET ROLE service_role; SELECT royal_operacional_dar_go('rollback','a','g','c','msg',1); ROLLBACK")
check("SELECT count(*) FROM royal_partida_go WHERE partida_id='rollback'", '0')
assert json.loads(legacy('rollback', sala_id='999', sala_senha='456'))['sala_versao'] == 2
print('OK rollback não persiste versão nem prontidão')
