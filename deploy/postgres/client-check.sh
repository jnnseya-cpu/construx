#!/usr/bin/env bash
#
# Prove the client can actually talk to Postgres.
#
# `verify.sh` proves the *schema* enforces what it claims. This proves the
# *client* — the zero-dependency wire-protocol implementation in
# `backend/src/store/` — can connect to a real server, authenticate with
# SCRAM-SHA-256, run parameterised statements, and be refused by the same
# triggers and policies verify.sh exercises through psql.
#
# The two are separate on purpose. A client tested against a fake server proves
# the fake; a schema tested through psql proves psql. Between them, the only
# untested edge left is the network.
#
# Stands up a throwaway cluster on an unused port, applies the schema, runs
# `backend/tests/postgres.live.test.ts` against it, and removes it. Touches no
# cluster you already have.
#
#   ./deploy/postgres/client-check.sh
#
# Requires the Postgres 16 server binaries and Node 22+. Set PGBIN if initdb is
# not on PATH — on Debian it lives in /usr/lib/postgresql/16/bin.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PGBIN="${PGBIN:-}"
if [[ -z "$PGBIN" ]]; then
  if command -v initdb >/dev/null 2>&1; then
    PGBIN="$(dirname "$(command -v initdb)")"
  elif [[ -d /usr/lib/postgresql/16/bin ]]; then
    PGBIN=/usr/lib/postgresql/16/bin
  else
    echo "postgres server binaries not found; set PGBIN" >&2
    exit 1
  fi
fi

# Postgres refuses to initdb as root, so re-exec as an unprivileged user the way
# verify.sh does. Same reason, same mechanism.
if [[ "$(id -u)" -eq 0 ]]; then
  for CANDIDATE in postgres nobody; do
    if id "$CANDIDATE" >/dev/null 2>&1; then
      WORK="$(mktemp -d)"
      chmod 777 "$WORK"
      exec setpriv --reuid "$CANDIDATE" --regid "$(id -g "$CANDIDATE")" --clear-groups \
        env HOME="$WORK" PGBIN="$PGBIN" WORKDIR="$WORK" "$0" "$@"
    fi
  done
  echo "running as root and no unprivileged user to drop to" >&2
  exit 1
fi

WORK="${WORKDIR:-$(mktemp -d)}"
DATA="$WORK/data"
SOCKET="$WORK/socket"
PORT="${PGPORT_OVERRIDE:-55433}"
PASSWORD='client-check-not-a-real-credential'

cleanup() {
  "$PGBIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$SOCKET"

echo "==> initialising a throwaway cluster"
# SCRAM by default, which is the whole point: this exercises the SCRAM-SHA-256
# path rather than falling back to trust or md5.
"$PGBIN/initdb" -D "$DATA" -U postgres --auth-host=scram-sha-256 --auth-local=trust \
  --pwfile=<(echo "$PASSWORD") >/dev/null

# Listen on TCP as well as the socket, because the client speaks TCP.
cat >> "$DATA/postgresql.conf" <<CONF
listen_addresses = '127.0.0.1'
port = $PORT
unix_socket_directories = '$SOCKET'
password_encryption = 'scram-sha-256'
CONF

"$PGBIN/pg_ctl" -D "$DATA" -l "$WORK/server.log" -w start >/dev/null

export PGHOST="$SOCKET" PGPORT="$PORT" PGUSER=postgres

echo "==> applying the schema"
"$PGBIN/psql" -v ON_ERROR_STOP=1 -q -d postgres -f "$ROOT/deploy/postgres/schema.sql" >/dev/null

# The application role the schema creates is NOLOGIN by design — nothing should
# be able to sign in as it by default. Give it a password for this check only,
# so RLS is exercised as the role that is actually subject to it.
"$PGBIN/psql" -v ON_ERROR_STOP=1 -q -d postgres \
  -c "ALTER ROLE construx_app LOGIN PASSWORD '$PASSWORD'" >/dev/null

echo "==> running the client against it, then the ledger store"
cd "$ROOT"
# Two files, in this order: the client's own checks first, then the ledger
# store shipping the whole demonstration record through the schema and
# replaying it. The store's file needs the client to be right; running it
# first would report a client fault as a store fault.
CONSTRUX_PG_LIVE=1 \
PGHOST=127.0.0.1 PGPORT="$PORT" \
PGDATABASE=postgres PGPASSWORD="$PASSWORD" \
  node --test backend/tests/postgres.live.test.ts backend/tests/pgstore.live.test.ts
