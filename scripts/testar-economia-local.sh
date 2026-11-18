#!/usr/bin/env bash
# Cria um PostgreSQL efêmero exclusivamente local; nunca acessa o Supabase real.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if ! command -v pg_config >/dev/null; then
  echo 'Instale PostgreSQL (incluindo initdb e pg_ctl) para este teste opcional.' >&2
  exit 1
fi
PGBIN="$(pg_config --bindir)"
TEMP="$(mktemp -d)"
cleanup() {
  "$PGBIN/pg_ctl" -D "$TEMP/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$TEMP"
}
trap cleanup EXIT
"$PGBIN/initdb" -D "$TEMP/data" -A trust --no-locale -E UTF8 > /dev/null
"$PGBIN/pg_ctl" -D "$TEMP/data" -o "-F -k $TEMP -h ''" -l "$TEMP/postgres.log" -w start > /dev/null
PSQL=("$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$TEMP" -d postgres)
"${PSQL[@]}" -c 'create role anon; create role authenticated; create role service_role;' > /dev/null
"${PSQL[@]}" -c "create schema auth; create function auth.role() returns text language sql stable as \$\$ select current_user::text \$\$;" > /dev/null
for migration in \
  202611140001_discord_features.sql \
  202611140002_royal_ap_core.sql \
  202611150001_supabase_source_of_truth.sql \
  202611150002_economy_source_of_truth.sql \
  202611150003_service_role_security.sql \
  20261118000100_roulette_shop_pro.sql \
  20261118000200_confirmar_preco_loja.sql; do
  echo "Aplicando no banco temporário: $migration"
  "${PSQL[@]}" -q -f "$ROOT/supabase/migrations/$migration"
done
"${PSQL[@]}" -q -f "$ROOT/testes/economia-integracao.sql"
