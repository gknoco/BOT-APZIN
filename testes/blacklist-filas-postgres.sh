#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if ! command -v pg_virtualenv >/dev/null; then
  echo 'Instale PostgreSQL e pg_virtualenv para executar este teste isolado.' >&2
  exit 1
fi
exec pg_virtualenv env ROYAL_BLACKLIST_TEST_ISOLATED=1 python3 testes/blacklist-filas-postgres.py
