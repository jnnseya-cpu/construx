# The Golden Thread in Postgres

**What this is:** the schema, a script that proves it enforces what it says, and
a second script that proves the platform's own zero-dependency client and its
ledger store work against a real server.

**What this is now used for.** With `LEDGER_POSTGRES_MODE` set, the running
platform ships every Golden Thread event to a database carrying this schema and
replays the record from it at boot (`backend/src/goldenthread/pgstore.ts`; the
runbook's *The ledger store* says how to bring a deployment onto it). The
platform speaks to Postgres through `backend/src/store/`, written here because
zero runtime dependencies is a settled decision and `pg` was never going to be
added. Apply this file to the database first; it is idempotent, and adds the
store's columns and tables to a database that already holds the log.

```
./deploy/postgres/client-check.sh
```

stands up a throwaway cluster, applies the schema, and runs the client's own
checks and then the ledger store's — the whole demonstration record shipped
through the triggers and replayed into a ledger that has to match the writer on
every chain head.

## Why it exists anyway

`docs/STATE.md` recorded Postgres as the answer to horizontal scale and left it
as prose. Prose cannot be wrong in any way anybody notices. This makes the
design checkable: `verify.sh` stands up a throwaway Postgres 16, applies
`schema.sql`, and then tries to break each property it claims.

```
./deploy/postgres/verify.sh
```

It initialises its own cluster in a temporary directory, on its own port, and
removes it afterwards. It touches no cluster you already have. Requires the
Postgres 16 server binaries and `psql`; set `PGBIN` if they are not on `PATH`.

## What is proved

| Property | How | Why it matters |
|---|---|---|
| Append-only | `DO INSTEAD NOTHING` rules on UPDATE and DELETE | Not a revoked grant. A grant can be given back; there is no path by which an update can happen |
| Tenant isolation | RLS keyed on `construx.tenant_id`, `FORCE`d | The in-process ledger enforces this in TypeScript; a database that did not would weaken the guarantee on the way to scaling it |
| Chain integrity under concurrency | A row lock on the project's head, plus `UNIQUE (project_id, chain_hash)` | This is the property the single-writer lock buys by refusing the second process. Bought here instead by the database, two writers may both try and exactly one succeeds |
| Evidence | A trigger against the list of types that require it | A constraint that lives only in the application is one a migration script bypasses |

## The finding that made it worth writing

The first run passed every isolation check while the database was enforcing
nothing. The script connected as the cluster's bootstrap superuser, and
**row-level security does not apply to a superuser** — nor to any role holding
`BYPASSRLS` — whatever `FORCE ROW LEVEL SECURITY` says. Each tenancy saw the
other's events and the cross-tenant write the policy was supposed to refuse
succeeded.

The policies were right and the connection was wrong. That is exactly the
mistake a deployment makes, and exactly the mistake a schema file cannot show.
`construx_app` is now `NOSUPERUSER NOBYPASSRLS`, the script connects as it, and
one of the checks asserts that it is neither.

A second, smaller one: the cross-tenant write was being refused by the *chain*
trigger, which could not see the other tenancy's head row under RLS and so
reported "this project has no events" about a project with two. Correctly
refused, misleadingly explained. There is an explicit tenant check now, named to
sort before the chain trigger because Postgres fires BEFORE row triggers in name
order.

## What is deliberately absent

- **The ACU wallet.** A separate double-entry ledger by a settled decision.
  Folding it in here would create the second source of truth for spend that the
  decision exists to prevent.
- **Identity.** Users, roles and tenancy structure are the platform's, and the
  permission matrix is not a database concern.
- **The event catalogue.** A closed list with a meaning per entry, which belongs
  in `goldenthread/eventTypes.ts`. What the database holds is the much smaller
  list of types that *require evidence*, so that one constraint can be enforced
  without the application.
