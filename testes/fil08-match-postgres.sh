#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v pg_virtualenv >/dev/null; then
  echo 'Instale PostgreSQL e pg_virtualenv para executar este teste isolado.' >&2
  exit 1
fi
# Nunca usar variáveis PG* herdadas do ambiente ou credenciais externas.
exec env -u PGHOST -u PGHOSTADDR -u PGPORT -u PGUSER -u PGDATABASE -u PGSERVICE -u PGSERVICEFILE -u PGPASSWORD -u PGOPTIONS -u PGPASSFILE \
  pg_virtualenv env ROYAL_FIL08_TEST_ISOLATED=1 python3 testes/fil08-match-postgres.py
