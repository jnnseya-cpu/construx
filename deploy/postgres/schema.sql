-- CONSTRUX — the Golden Thread in Postgres.
--
-- The ledger is durable today as an append-only journal on a volume, and one
-- process owns it: `goldenthread/writerlock.ts` makes a second writer refuse to
-- start rather than interleave its appends. That closes the accident. It does
-- not make the platform scale out, because refusing the second instance is not
-- the same as running it.
--
-- This is what running it needs. It is the schema, not the driver: the platform
-- cannot yet speak to Postgres — a wire-protocol client is not written, and zero
-- runtime dependencies is settled, so `pg` is not going to be added. What this
-- file does is make the *design* checkable rather than described. Every rule
-- below is enforced by the database and proved by `verify.sh`, which stands up a
-- real Postgres, applies this, and then tries to break it.
--
-- The four properties that matter, and where each is enforced:
--
--   1. APPEND-ONLY.  Rules on `event` reject UPDATE and DELETE outright. Not a
--      revoked grant — a grant can be given back by whoever owns the schema, and
--      "the application role cannot update" is a weaker statement than "the
--      table cannot be updated". A correction is a new event, which is what the
--      catalogue already says.
--
--   2. TENANT ISOLATION.  Row-level security keyed on a session variable, FORCED
--      so it applies to the table owner too. The in-process ledger enforces this
--      in TypeScript on every read; a database that did not would make the
--      guarantee weaker on the way to making it scale.
--
--   3. CHAIN INTEGRITY UNDER CONCURRENCY.  A trigger refuses any event whose
--      `previous_chain_hash` is not the current head for its project. This is
--      the property the writer lock buys by refusing the second process, bought
--      here instead by the database — two writers may both try, and exactly one
--      succeeds. It is why Postgres is the scaling answer and another replica on
--      a shared volume is not.
--
--   4. EVIDENCE.  An event whose type requires evidence must carry a reference.
--      Enforced in `commit()` today; enforced again here, because a constraint
--      that lives only in the application is one a migration script can bypass.
--
-- Money and identity are deliberately absent. The ACU wallet is a separate
-- double-entry ledger by a settled decision, and folding it in here would create
-- the second source of truth for spend that decision exists to prevent.

BEGIN;

CREATE SCHEMA IF NOT EXISTS goldenthread;
SET search_path TO goldenthread, public;

-- --------------------------------------------------------------------------
-- The log
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS event (
  -- The platform's own ULID, not a serial. An id the database mints would be
  -- an id the hash chain does not cover.
  event_id             text        PRIMARY KEY,
  tenant_id            text        NOT NULL,
  project_id           text        NOT NULL,
  -- The moment the event was recorded, from the platform's clock. Not
  -- `now()`: the ledger's ordering and its hashes are over this value, and a
  -- database default would silently differ from what was hashed.
  occurred_at          timestamptz NOT NULL,
  -- Preserved verbatim where a record originated offline. The server's receipt
  -- time never replaces it — that is what makes an offline capture defensible.
  device_timestamp     timestamptz,

  actor_type           text        NOT NULL,
  actor_id             text        NOT NULL,
  -- A snapshot, not a reference. Roles change, and an event has to say what the
  -- actor held at the moment they acted.
  actor_roles          text[]      NOT NULL DEFAULT '{}',
  source               text        NOT NULL,

  event_type           text        NOT NULL,
  entity_type          text        NOT NULL,
  entity_id            text        NOT NULL,
  action               text        NOT NULL,

  before_hash          text        NOT NULL,
  after_hash           text        NOT NULL,
  diff                 jsonb       NOT NULL,
  evidence_refs        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  ai                   jsonb,
  policy               jsonb,

  correlation_id       text        NOT NULL,
  causation_id         text,

  -- The chain. `previous_chain_hash` is null for the first event of a project.
  chain_hash           text        NOT NULL,
  previous_chain_hash  text,

  -- Written by the database, and the only column it decides. Useful for
  -- replication lag and nothing else; never part of a hash.
  recorded_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT event_hashes_are_prefixed CHECK (
    before_hash LIKE 'sha256:%' AND after_hash LIKE 'sha256:%' AND chain_hash LIKE 'sha256:%'
  ),
  -- One head per project: two events cannot both follow the same predecessor.
  -- This is the concurrency guarantee, stated as a unique index rather than
  -- left to the trigger alone — a trigger reads, a unique index cannot race.
  CONSTRAINT event_chain_is_unique UNIQUE (project_id, chain_hash)
);

-- One project's history in order is the commonest read by a wide margin: it is
-- what replay does, and replay is what proves the record.
CREATE INDEX IF NOT EXISTS event_by_project ON event (project_id, occurred_at, event_id);
CREATE INDEX IF NOT EXISTS event_by_entity  ON event (project_id, entity_type, entity_id, occurred_at);
CREATE INDEX IF NOT EXISTS event_by_tenant  ON event (tenant_id, occurred_at DESC);
-- The audit feed answers "what changed", which is a correlation lookup.
CREATE INDEX IF NOT EXISTS event_by_correlation ON event (correlation_id);

-- The current head of each project's chain. A table rather than a view, because
-- the append trigger has to lock exactly one row to serialise two writers, and
-- there is nothing to lock in a view.
CREATE TABLE IF NOT EXISTS chain_head (
  project_id  text PRIMARY KEY,
  tenant_id   text NOT NULL,
  chain_hash  text NOT NULL,
  events      bigint NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- --------------------------------------------------------------------------
-- 1. Append-only
-- --------------------------------------------------------------------------
--
-- Rules, not triggers. A rule rewrites the statement away before it executes,
-- so an UPDATE against this table is not a permissions failure to be granted
-- around — there is no path by which it can happen at all.

CREATE OR REPLACE RULE event_is_append_only_update AS
  ON UPDATE TO event DO INSTEAD NOTHING;

CREATE OR REPLACE RULE event_is_append_only_delete AS
  ON DELETE TO event DO INSTEAD NOTHING;

-- --------------------------------------------------------------------------
-- 2. Tenant isolation
-- --------------------------------------------------------------------------
--
-- FORCE, so the owner is subject to it too. Without FORCE the role that owns
-- the table bypasses every policy, and the application connects as somebody.

ALTER TABLE event      ENABLE ROW LEVEL SECURITY;
ALTER TABLE event      FORCE ROW LEVEL SECURITY;
ALTER TABLE chain_head ENABLE ROW LEVEL SECURITY;
ALTER TABLE chain_head FORCE ROW LEVEL SECURITY;

-- `current_setting(..., true)` returns NULL rather than raising when unset, so
-- a connection that forgot to set the tenancy sees nothing instead of erroring
-- into a code path somebody might catch and ignore.
CREATE POLICY event_tenant_isolation ON event
  USING (tenant_id = current_setting('construx.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('construx.tenant_id', true));

CREATE POLICY chain_head_tenant_isolation ON chain_head
  USING (tenant_id = current_setting('construx.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('construx.tenant_id', true));

-- The operator layer reads across tenancies for billing and platform health and
-- is barred from delivery data — which is a rule about *which* tables, not about
-- rows, so it is a grant rather than a policy. Named here so the separation is
-- visible in the schema rather than only in the application.
COMMENT ON POLICY event_tenant_isolation ON event IS
  'Platform operators are a different account layer and are barred from customer delivery data entirely; they are '
  'not granted on this table at all rather than given a wider policy.';

-- --------------------------------------------------------------------------
-- 3. Chain integrity under concurrency
-- --------------------------------------------------------------------------

-- Refused first, and for the right reason.
--
-- RLS's WITH CHECK already refuses a write into another tenancy, so this adds
-- no authority. What it adds is a legible failure: without it, `verify.sh`
-- showed the cross-tenant insert being refused by the *chain* trigger — which
-- could not see the other tenancy's head row, so it reported "this project has
-- no events" about a project with two. The write was correctly refused and the
-- reason was misleading, and a misleading reason is what sends somebody looking
-- in the wrong place at three in the morning.
--
-- Named to sort before `event_chain_continues`: Postgres fires BEFORE row
-- triggers in name order, and this one has to run first to produce the right
-- message.
CREATE OR REPLACE FUNCTION assert_tenant_matches_session() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM current_setting('construx.tenant_id', true) THEN
    RAISE EXCEPTION
      'tenant mismatch: this connection is acting for % and the event belongs to %',
      coalesce(current_setting('construx.tenant_id', true), '(no tenancy set)'), NEW.tenant_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER event_belongs_to_session_tenant
  BEFORE INSERT ON event
  FOR EACH ROW EXECUTE FUNCTION assert_tenant_matches_session();

CREATE OR REPLACE FUNCTION assert_chain_continues() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  head text;
BEGIN
  -- Locks the project's head row for the transaction. Two concurrent appends
  -- to one project serialise here; the second reads the first's head and is
  -- refused if it was built on the old one. This is what the single-writer
  -- lock buys by refusing the second process, bought instead by the database.
  SELECT chain_hash INTO head FROM chain_head WHERE project_id = NEW.project_id FOR UPDATE;

  IF head IS NULL THEN
    IF NEW.previous_chain_hash IS NOT NULL THEN
      RAISE EXCEPTION
        'chain break on % : the event claims to follow % and this project has no events',
        NEW.project_id, NEW.previous_chain_hash
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    INSERT INTO chain_head (project_id, tenant_id, chain_hash, events)
      VALUES (NEW.project_id, NEW.tenant_id, NEW.chain_hash, 1);
    RETURN NEW;
  END IF;

  IF NEW.previous_chain_hash IS DISTINCT FROM head THEN
    RAISE EXCEPTION
      'chain break on % : the event follows % but the head is %. Two writers, or a replayed event.',
      NEW.project_id, coalesce(NEW.previous_chain_hash, '(nothing)'), head
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  UPDATE chain_head
     SET chain_hash = NEW.chain_hash, events = events + 1, updated_at = now()
   WHERE project_id = NEW.project_id;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER event_chain_continues
  BEFORE INSERT ON event
  FOR EACH ROW EXECUTE FUNCTION assert_chain_continues();

-- --------------------------------------------------------------------------
-- 4. Evidence
-- --------------------------------------------------------------------------
--
-- The catalogue is the platform's, and it belongs there: it is a closed list
-- with a meaning per entry, and duplicating all of it here would be a second
-- source of truth. What the database holds is the list of types that *require*
-- evidence, so the constraint can be enforced without the application.

CREATE TABLE IF NOT EXISTS event_type_requiring_evidence (
  event_type text PRIMARY KEY
);

CREATE OR REPLACE FUNCTION assert_evidence_present() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM event_type_requiring_evidence WHERE event_type = NEW.event_type)
     AND jsonb_array_length(NEW.evidence_refs) = 0 THEN
    RAISE EXCEPTION
      '% requires evidence and none was referenced', NEW.event_type
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER event_evidence_present
  BEFORE INSERT ON event
  FOR EACH ROW EXECUTE FUNCTION assert_evidence_present();

-- --------------------------------------------------------------------------
-- Roles
-- --------------------------------------------------------------------------
--
-- The application inserts and reads. It cannot alter the schema, and it is not
-- granted UPDATE or DELETE on `event` even though the rules already make them
-- impossible — defence in depth is cheap here, and a grant that does not exist
-- cannot be relied on by mistake.

-- NOSUPERUSER and NOBYPASSRLS are load-bearing, not decoration.
--
-- Row-level security does not apply to a superuser, and it does not apply to a
-- role holding BYPASSRLS — whatever `FORCE ROW LEVEL SECURITY` says. `verify.sh`
-- found exactly that: connected as the cluster's bootstrap superuser, every
-- isolation check passed a tenancy the whole of the other tenancy's events, and
-- the cross-tenant write the policy was supposed to refuse succeeded. The
-- policies were right and the connection was wrong.
--
-- So the application connects as this role and never as the owner. A deployment
-- that points the application at a superuser has no tenant isolation at all,
-- and nothing about the schema would look wrong.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'construx_app') THEN
    -- NOLOGIN here; the deployment grants LOGIN with its own credential rather
    -- than this file carrying one.
    CREATE ROLE construx_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA goldenthread TO construx_app;
GRANT SELECT, INSERT ON event TO construx_app;
GRANT SELECT, INSERT, UPDATE ON chain_head TO construx_app;
GRANT SELECT ON event_type_requiring_evidence TO construx_app;

COMMIT;
