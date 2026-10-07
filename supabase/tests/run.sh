#!/usr/bin/env bash
# Runs the migrations + SQL tests against a throwaway local Postgres 16.
# Requires Postgres 16 server binaries (initdb/pg_ctl). No Docker needed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/16/bin 2>/dev/null || dirname "$(command -v initdb)")}"
WORK="$(mktemp -d)"
PORT="${PGPORT_TEST:-54329}"

as_pg() { if [ "$(id -u)" = "0" ]; then runuser -u postgres -- "$@"; else "$@"; fi; }
if [ "$(id -u)" = "0" ]; then chown postgres "$WORK"; fi

cleanup() { as_pg "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

as_pg "$PGBIN/initdb" -D "$WORK/data" -U postgres -A trust >/dev/null
as_pg "$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $WORK -c listen_addresses=''" -l "$WORK/log" -w start >/dev/null

PSQL=(psql -h "$WORK" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q -X)
"${PSQL[@]}" -f "$HERE/auth_stub.sql" >/dev/null
for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "migrate: $(basename "$f")"
  "${PSQL[@]}" -f "$f" >/dev/null
done
echo "seed: seed.sql"
"${PSQL[@]}" -f "$ROOT/supabase/seed.sql" >/dev/null

status=0
for t in "$HERE"/*.test.sql; do
  if "${PSQL[@]}" -f "$t" >"$WORK/out" 2>&1; then
    echo "PASS $(basename "$t")"
  else
    echo "FAIL $(basename "$t")"; cat "$WORK/out"; status=1
  fi
done
exit $status
