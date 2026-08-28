#!/usr/bin/env bash
#
# Prove the schema enforces what it claims.
#
# `schema.sql` states four properties: append-only, tenant isolation, chain
# integrity under concurrency, and evidence. A schema file that says so is a
# design document; this stands up a real Postgres, applies it, and then tries to
# break each one. If a property is not enforced the corresponding check fails
# loudly rather than the file quietly claiming it.
#
# Self-contained: it initialises a throwaway cluster in a temporary directory on
# a port nothing else is using, and removes it afterwards. It touches no cluster
# you already have and needs no superuser beyond the one it creates.
#
#   ./deploy/postgres/verify.sh
#
# Requires the Postgres 16 server binaries (initdb, pg_ctl) and psql. If they
# are not on PATH, set PGBIN — on Debian they live in /usr/lib/postgresql/16/bin.

set -euo pipefail

# Postgres refuses to initialise a cluster as root, and rightly: the server
# would run as root. Re-run as an unprivileged user rather than telling the
# operator to work it out — `postgres` where the packages created one, otherwise
# `nobody`, which owns nothing and is enough for a throwaway cluster.
if [[ "$(id -u)" -eq 0 && -z "${CONSTRUX_PG_REEXEC:-}" ]]; then
  as="$(id -u postgres >/dev/null 2>&1 && echo postgres || echo nobody)"
  work="$(mktemp -d)"
  chmod 777 "$work"
  echo "› running as root; re-running as $as (Postgres will not initialise a cluster as root)"
  export CONSTRUX_PG_REEXEC=1
  exec setpriv --reuid="$as" --regid="$(id -g "$as")" --clear-groups \
    env HOME="$work" TMPDIR="$work" CONSTRUX_PG_REEXEC=1 PGBIN="${PGBIN:-}" \
    bash "${BASH_SOURCE[0]}" "$@"
fi

PGBIN="${PGBIN:-}"
if [[ -z "$PGBIN" ]]; then
  if command -v initdb >/dev/null 2>&1; then PGBIN="$(dirname "$(command -v initdb)")"
  elif [[ -x /usr/lib/postgresql/16/bin/initdb ]]; then PGBIN=/usr/lib/postgresql/16/bin
  else
    echo "Postgres server binaries not found. Install postgresql-16 or set PGBIN." >&2
    exit 1
  fi
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
PORT="${PGPORT_OVERRIDE:-55432}"
export PGHOST="$WORK/socket" PGPORT="$PORT" PGDATABASE=construx PGUSER=construx
mkdir -p "$PGHOST"

cleanup() {
  "$PGBIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "› initialising a throwaway cluster in $WORK"
"$PGBIN/initdb" -D "$WORK/data" -U construx --auth=trust >"$WORK/initdb.log" 2>&1
"$PGBIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $PGHOST -c listen_addresses=''" -l "$WORK/pg.log" -w start >/dev/null
createdb construx

echo "› applying schema.sql"
psql -v ON_ERROR_STOP=1 -q -f "$HERE/schema.sql"

# Everything from here connects as the application role, never as the owner.
#
# This is the finding that made the first run of this script worth writing.
# Connected as the bootstrap superuser, every isolation check passed — because
# row-level security does not apply to a superuser whatever FORCE says, so each
# tenancy saw the other's events and the cross-tenant write succeeded. The
# policies were right and the connection was wrong, which is precisely the
# mistake a deployment makes and a schema file cannot show.
psql -v ON_ERROR_STOP=1 -q -c "ALTER ROLE construx_app WITH LOGIN" \
  -c "INSERT INTO goldenthread.event_type_requiring_evidence VALUES ('PROGRESS_REPORTED')"
export PGUSER=construx_app

pass=0
fail=0

# Run SQL that is expected to fail, and check that it does. `psql` exits
# non-zero on error under ON_ERROR_STOP, which is the signal being tested.
refuses() {
  local what="$1" sql="$2" expect="${3:-}"
  local output
  if output=$(psql -v ON_ERROR_STOP=1 -q -t -c "$sql" 2>&1); then
    echo "  ✗ $what — the database ALLOWED it"
    fail=$((fail + 1))
    return
  fi
  if [[ -n "$expect" && "$output" != *"$expect"* ]]; then
    echo "  ✗ $what — refused, but not for the stated reason: ${output//$'\n'/ }"
    fail=$((fail + 1))
    return
  fi
  echo "  ✓ $what"
  pass=$((pass + 1))
}

# Run SQL and compare its single-value output.
yields() {
  local what="$1" sql="$2" expect="$3"
  local got
  got=$(psql -v ON_ERROR_STOP=1 -q -t -A -c "$sql" 2>&1 || true)
  if [[ "$got" == "$expect" ]]; then
    echo "  ✓ $what"
    pass=$((pass + 1))
  else
    echo "  ✗ $what — expected '$expect', got '$got'"
    fail=$((fail + 1))
  fi
}

echo "› seeding two tenancies, as the application role"
psql -v ON_ERROR_STOP=1 -q <<'SQL'
SET search_path TO goldenthread, public;
SET construx.tenant_id = 'tenant-a';
INSERT INTO event (event_id, tenant_id, project_id, occurred_at, actor_type, actor_id, source,
                   event_type, entity_type, entity_id, action, before_hash, after_hash, diff,
                   correlation_id, chain_hash, previous_chain_hash)
VALUES ('evt-a1', 'tenant-a', 'proj-a', now(), 'User', 'user-1', 'WEB',
        'PROJECT_CREATED', 'Project', 'proj-a', 'CREATE', 'sha256:0', 'sha256:1', '[]'::jsonb,
        'corr-1', 'sha256:aaa', NULL);
INSERT INTO event (event_id, tenant_id, project_id, occurred_at, actor_type, actor_id, source,
                   event_type, entity_type, entity_id, action, before_hash, after_hash, diff,
                   correlation_id, chain_hash, previous_chain_hash)
VALUES ('evt-a2', 'tenant-a', 'proj-a', now(), 'User', 'user-1', 'WEB',
        'TASK_CREATED', 'Task', 'task-1', 'CREATE', 'sha256:1', 'sha256:2', '[]'::jsonb,
        'corr-2', 'sha256:bbb', 'sha256:aaa');

SET construx.tenant_id = 'tenant-b';
INSERT INTO event (event_id, tenant_id, project_id, occurred_at, actor_type, actor_id, source,
                   event_type, entity_type, entity_id, action, before_hash, after_hash, diff,
                   correlation_id, chain_hash, previous_chain_hash)
VALUES ('evt-b1', 'tenant-b', 'proj-b', now(), 'User', 'user-9', 'WEB',
        'PROJECT_CREATED', 'Project', 'proj-b', 'CREATE', 'sha256:0', 'sha256:9', '[]'::jsonb,
        'corr-9', 'sha256:zzz', NULL);
SQL

echo
echo "1. Append-only"
# A rule rewrites the statement away, so this "succeeds" and changes nothing.
# The property is that the row is unchanged, not that the statement errored.
yields "an UPDATE changes nothing" \
  "SET search_path TO goldenthread; SET construx.tenant_id = 'tenant-a';
   UPDATE event SET after_hash = 'sha256:tampered' WHERE event_id = 'evt-a1';
   SELECT after_hash FROM event WHERE event_id = 'evt-a1';" \
  "sha256:1"
yields "a DELETE removes nothing" \
  "SET search_path TO goldenthread; SET construx.tenant_id = 'tenant-a';
   DELETE FROM event WHERE event_id = 'evt-a1';
   SELECT count(*) FROM event WHERE event_id = 'evt-a1';" \
  "1"
yields "a TRUNCATE is refused to the application role" \
  "SET search_path TO goldenthread;
   SELECT has_table_privilege('construx_app', 'goldenthread.event', 'TRUNCATE');" \
  "f"
yields "the application role is not granted UPDATE" \
  "SELECT has_table_privilege('construx_app', 'goldenthread.event', 'UPDATE');" "f"
yields "the application role is not granted DELETE" \
  "SELECT has_table_privilege('construx_app', 'goldenthread.event', 'DELETE');" "f"
yields "the application role is not a superuser, or RLS would not apply to it" \
  "SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = 'construx_app';" "f"

echo
echo "2. Tenant isolation"
yields "tenant A sees only its own events" \
  "SET search_path TO goldenthread; SET construx.tenant_id = 'tenant-a';
   SELECT count(*) FROM event;" "2"
yields "tenant B sees only its own" \
  "SET search_path TO goldenthread; SET construx.tenant_id = 'tenant-b';
   SELECT count(*) FROM event;" "1"
yields "tenant B cannot read A's event by id" \
  "SET search_path TO goldenthread; SET construx.tenant_id = 'tenant-b';
   SELECT count(*) FROM event WHERE event_id = 'evt-a1';" "0"
yields "a connection that set no tenancy sees nothing at all" \
  "SET search_path TO goldenthread; SELECT count(*) FROM event;" "0"
refuses "writing into another tenancy is refused" \
  "SET search_path TO goldenthread; SET construx.tenant_id = 'tenant-b';
   INSERT INTO event (event_id, tenant_id, project_id, occurred_at, actor_type, actor_id, source,
                      event_type, entity_type, entity_id, action, before_hash, after_hash, diff,
                      correlation_id, chain_hash, previous_chain_hash)
   VALUES ('evt-x', 'tenant-a', 'proj-a', now(), 'User', 'user-9', 'WEB',
           'TASK_CREATED', 'Task', 't', 'CREATE', 'sha256:2', 'sha256:3', '[]'::jsonb,
           'c', 'sha256:ccc', 'sha256:bbb');" \
  "tenant mismatch"
yields "the owner is subject to the policy too, because it is FORCEd" \
  "SELECT relforcerowsecurity FROM pg_class WHERE relname = 'event';" "t"

echo
echo "3. Chain integrity"
refuses "an event built on a stale head is refused" \
  "SET search_path TO goldenthread; SET construx.tenant_id = 'tenant-a';
   INSERT INTO event (event_id, tenant_id, project_id, occurred_at, actor_type, actor_id, source,
                      event_type, entity_type, entity_id, action, before_hash, after_hash, diff,
                      correlation_id, chain_hash, previous_chain_hash)
   VALUES ('evt-a3', 'tenant-a', 'proj-a', now(), 'User', 'user-1', 'WEB',
           'TASK_UPDATED', 'Task', 'task-1', 'UPDATE', 'sha256:2', 'sha256:3', '[]'::jsonb,
           'c', 'sha256:ccc', 'sha256:aaa');" \
  "chain break"
refuses "a second first-event on an existing project is refused" \
  "SET search_path TO goldenthread; SET construx.tenant_id = 'tenant-a';
   INSERT INTO event (event_id, tenant_id, project_id, occurred_at, actor_type, actor_id, source,
                      event_type, entity_type, entity_id, action, before_hash, after_hash, diff,
                      correlation_id, chain_hash, previous_chain_hash)
   VALUES ('evt-a4', 'tenant-a', 'proj-a', now(), 'User', 'user-1', 'WEB',
           'TASK_UPDATED', 'Task', 'task-1', 'UPDATE', 'sha256:2', 'sha256:3', '[]'::jsonb,
           'c', 'sha256:ddd', NULL);" \
  "chain break"
yields "an event on the true head is accepted" \
  "SET search_path TO goldenthread; SET construx.tenant_id = 'tenant-a';
   INSERT INTO event (event_id, tenant_id, project_id, occurred_at, actor_type, actor_id, source,
                      event_type, entity_type, entity_id, action, before_hash, after_hash, diff,
                      correlation_id, chain_hash, previous_chain_hash)
   VALUES ('evt-a5', 'tenant-a', 'proj-a', now(), 'User', 'user-1', 'WEB',
           'TASK_UPDATED', 'Task', 'task-1', 'UPDATE', 'sha256:2', 'sha256:3', '[]'::jsonb,
           'c', 'sha256:eee', 'sha256:bbb');
   SELECT chain_hash FROM chain_head WHERE project_id = 'proj-a';" \
  "sha256:eee"

echo
echo "4. Evidence"
refuses "an event whose type requires evidence is refused without any" \
  "SET search_path TO goldenthread; SET construx.tenant_id = 'tenant-a';
   INSERT INTO event (event_id, tenant_id, project_id, occurred_at, actor_type, actor_id, source,
                      event_type, entity_type, entity_id, action, before_hash, after_hash, diff,
                      correlation_id, chain_hash, previous_chain_hash)
   VALUES ('evt-a6', 'tenant-a', 'proj-a', now(), 'User', 'user-1', 'WEB',
           'PROGRESS_REPORTED', 'ProgressSubmission', 'p1', 'CREATE', 'sha256:3', 'sha256:4', '[]'::jsonb,
           'c', 'sha256:fff', 'sha256:eee');" \
  "requires evidence"
yields "the same event with evidence is accepted" \
  "SET search_path TO goldenthread; SET construx.tenant_id = 'tenant-a';
   INSERT INTO event (event_id, tenant_id, project_id, occurred_at, actor_type, actor_id, source,
                      event_type, entity_type, entity_id, action, before_hash, after_hash, diff,
                      evidence_refs, correlation_id, chain_hash, previous_chain_hash)
   VALUES ('evt-a7', 'tenant-a', 'proj-a', now(), 'User', 'user-1', 'WEB',
           'PROGRESS_REPORTED', 'ProgressSubmission', 'p1', 'CREATE', 'sha256:3', 'sha256:4', '[]'::jsonb,
           '[{\"refType\":\"EvidenceItem\",\"refId\":\"ev-1\"}]'::jsonb, 'c', 'sha256:ggg', 'sha256:eee');
   SELECT count(*) FROM event WHERE event_id = 'evt-a7';" \
  "1"

echo
echo "5. Concurrency — two writers, one head"
# The property the whole design turns on. Both transactions read the same head
# and try to extend it; the row lock serialises them and exactly one wins.
psql -v ON_ERROR_STOP=1 -q -c "SET search_path TO goldenthread; SET construx.tenant_id='tenant-a';
  SELECT chain_hash FROM chain_head WHERE project_id='proj-a'" >/dev/null
head=$(psql -q -t -A -c "SET search_path TO goldenthread; SET construx.tenant_id='tenant-a';
  SELECT chain_hash FROM chain_head WHERE project_id='proj-a'")

race_sql() {
  cat <<SQL
SET search_path TO goldenthread;
SET construx.tenant_id = 'tenant-a';
BEGIN;
SELECT pg_sleep(0.2) \\g /dev/null
INSERT INTO event (event_id, tenant_id, project_id, occurred_at, actor_type, actor_id, source,
                   event_type, entity_type, entity_id, action, before_hash, after_hash, diff,
                   correlation_id, chain_hash, previous_chain_hash)
VALUES ('$1', 'tenant-a', 'proj-a', now(), 'User', 'user-1', 'WEB',
        'TASK_UPDATED', 'Task', 'task-1', 'UPDATE', 'sha256:4', 'sha256:5', '[]'::jsonb,
        'c', '$2', '$head');
COMMIT;
SQL
}

race_sql writer-one sha256:race1 | psql -v ON_ERROR_STOP=1 -q >"$WORK/race1.log" 2>&1 &
one=$!
race_sql writer-two sha256:race2 | psql -v ON_ERROR_STOP=1 -q >"$WORK/race2.log" 2>&1 &
two=$!
set +e
wait $one; r1=$?
wait $two; r2=$?
set -e

winners=0
[[ $r1 -eq 0 ]] && winners=$((winners + 1))
[[ $r2 -eq 0 ]] && winners=$((winners + 1))
if [[ $winners -eq 1 ]]; then
  echo "  ✓ exactly one of two concurrent writers extended the chain"
  pass=$((pass + 1))
else
  echo "  ✗ both writers were allowed (r1=$r1 r2=$r2) — the chain would have forked"
  cat "$WORK/race1.log" "$WORK/race2.log"
  fail=$((fail + 1))
fi
yields "the loser's event is not in the log" \
  "SET search_path TO goldenthread; SET construx.tenant_id='tenant-a';
   SELECT count(*) FROM event WHERE event_id IN ('writer-one','writer-two');" "1"

echo
echo "──────────────────────────────────────────────"
echo "$pass passed, $fail failed"
[[ $fail -eq 0 ]] || exit 1
