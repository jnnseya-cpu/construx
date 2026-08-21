# Runbook

How this system is built, released, operated and recovered. `docs/STATE.md`
says what exists; this says how to run it.

---

## Where things go

Three deployables in one repository, and one of them does not deploy anywhere
on its own.

| | What it is | Where it runs |
|---|---|---|
| `backend/` | The service — API, engines, ledger, AI control plane | One Node process in a container |
| `frontend/` | The browser application, plain ES modules | Served by the backend from the same origin |
| `shared/` | The canonical vocabulary | Imported by the backend, served to the browser |

**The frontend is served by the backend.** One origin, one certificate, one
deploy, no CORS, no API-origin configuration. That is a deployment decision, not
an architectural one: it lives in a single constant in
`backend/src/api/gateway.ts`, and moving the frontend to a CDN later changes
that constant and a DNS record rather than any code.

**Target: one container on a managed platform, with a persistent volume.**
Fly.io, Render and Railway all fit. One process, one port, one volume.

```
                    ┌──────────────────────────────┐
   TLS terminated   │  container                   │
   by the platform  │                              │
   ───────────────► │  node backend/src/main.ts    │
        :443        │    ├── / and /about …        │  server-rendered site
                    │    ├── /app                  │  console shell
                    │    ├── /v1/*                 │  API
                    │    └── static from frontend/ │
                    │                              │
                    │  /data  ◄── persistent volume│
                    │    ledger.jsonl              │  the record
                    │    ledger.jsonl.acu          │  ACU entries
                    └──────────────────────────────┘
```

---

## Processes

### Build

There is none. Node 22 strips the types at load, the frontend is plain ES
modules, and nothing is compiled or bundled. `npm ci --omit=dev` runs in the
image only to prove the production dependency set stays empty — if something
ever acquires a runtime dependency, the image gets it rather than failing at
3am.

```bash
docker build -f deploy/Dockerfile -t construx:$(git rev-parse --short HEAD) .
```

### Release

1. CI must be green: typecheck, the full suite, an image build, and a container
   boot that checks `/readyz` **and** that `/v1/console/session` answers 403.
2. Deploy the image. The platform starts the new container, waits for
   `/readyz`, then drains the old one.
3. Watch the first boot line. It states what was restored:
   `Ledger  /data/ledger.jsonl — 12,481 events restored into 3,902 entities,
   47 users across 6 tenancies, 918 ACU entries`.

**Readiness, not liveness, gates traffic.** `/healthz` answers as soon as the
process is up; `/readyz` answers when the platform is actually able to serve.
Between them sits the journal replay, and a container marked ready during a
replay answers "no such project" for projects that exist.

### Rollback

Redeploy the previous image. **The journal is forward-compatible and not
backward-compatible**: an older image replaying a journal containing an event
type it does not know refuses to start, which is correct — it is the closed
catalogue doing its job. So a rollback across a release that added an event type
needs the journal rolled back with it, from the backup taken before the deploy.

Take that backup before every deploy that changes the event catalogue. Check
with `git diff <previous>..HEAD -- backend/src/goldenthread/eventTypes.ts`.

### Restart

Safe at any time. `SIGTERM` stops the listener, then closes the journal. Every
acknowledged event is already flushed — the close is tidiness, not the thing
that made the data durable.

`tini` is PID 1 in the image for exactly this reason: without an init, Node's
default `SIGTERM` handling as PID 1 is to ignore it, the graceful shutdown never
runs, and every deploy looks like a crash.

### Backup

The record is two append-only files. Backing up is copying them.

```bash
# From the host, against the running container.
docker exec construx sh -c 'cat /data/ledger.jsonl' > ledger-$(date -u +%Y%m%dT%H%M%SZ).jsonl
docker exec construx sh -c 'cat /data/ledger.jsonl.acu' > acu-$(date -u +%Y%m%dT%H%M%SZ).jsonl
```

Because the files are append-only, a copy taken while the service is running is
a valid prefix of the record: it may miss events written during the copy and
cannot contain a half-written earlier one. A torn final line in a backup is
handled on load exactly as a torn line from a crash.

Copy `.acu` **with** the ledger, always. Restoring one without the other gives a
complete project record whose wallets have forgotten their debits — which hands
customers AI the platform has already paid a provider for.

### Restore

1. Stop the service.
2. Put both files on the volume at `LEDGER_JOURNAL_PATH` and
   `LEDGER_JOURNAL_PATH.acu`.
3. Start it.

Boot verifies as it replays: every chain hash recomputed from its predecessor,
every state hash from the applied patch. **A journal that has been altered
refuses to load**, and refusing to start is the correct response — a platform
that boots on a broken chain is one that will be asked to prove something from
it later.

The errors are specific:

| Code | Meaning |
|---|---|
| `JOURNAL_CHAIN_BROKEN` | An event is missing, reordered, or the file was altered |
| `JOURNAL_STATE_MISMATCH` | An event's recorded state hash disagrees with its own patch |
| `Journal … is corrupt at line N` | Unparseable line that is *not* the last one — real corruption, not a torn write |

### Secrets

Injected as environment variables by the platform. Never in the image, never in
the repository. `.env` is gitignored; `.env.example` carries names and safe
defaults and never a value.

`GATEWAY_JWT_SECRET` is the one that matters most: leave it at the development
default and every token the platform has ever signed is forgeable. The service
warns at boot rather than refusing, because refusing to start on a bad secret
turns a misconfiguration into an outage — but treat the warning as a page.

Rotating it invalidates every live session. Users sign in again; nothing in the
record is affected.

---

## Configuration that decides whether this is production

| Variable | Production value | What goes wrong otherwise |
|---|---|---|
| `NODE_ENV` | `production` | The demonstration routes stay open and the MFA challenge code is returned in the login response |
| `LEDGER_JOURNAL_PATH` | a path on a mounted volume | **Every record is lost on restart** |
| `LEDGER_JOURNAL_FSYNC` | `true` | Events can be acknowledged before reaching the disk |
| `GATEWAY_JWT_SECRET` | a real secret | Every token is forgeable |
| `PUBLIC_BASE_URL` | the https origin | Signed links in email go out over cleartext |
| `AI_MODE` | `production` | Engines run deterministically with no provider spend |

`assertProductionSafety()` checks all of these at boot and writes each failure
to stderr. It warns rather than exits, deliberately: a platform that refuses to
start on a misconfiguration converts a wrong flag into an outage. Read the boot
log on every deploy.

---

## Health and observability

| Endpoint | Purpose |
|---|---|
| `GET /healthz` | Liveness. The process is up |
| `GET /readyz` | Readiness. The platform can serve, including AI control-plane state |
| `GET /v1/routes` | Every endpoint, its method and whether it needs a credential |
| `GET /status` | The public status page, read from the running process |

Every response carries `x-trace-id` and `x-correlation-id`. Errors are RFC 7807
`application/problem+json`. Metrics are grouped by route *pattern*, never by
path, so an id in a URL cannot produce one series per project.

---

## What this deployment does not have

Stated so it is not mistaken for an omission somebody can fix with a flag.

- **No horizontal scale.** One process owns the journal file. Two containers
  writing to one volume would interleave events and break the chain. Scaling
  out needs the Postgres design in `docs/STATE.md`, not another replica.
- **No automatic failover.** A single node with a volume. Recovery is restart
  or restore, and both are manual.
- **No point-in-time recovery beyond the backup interval.** Recovery granularity
  is however often the files are copied.
- **No log shipping, metrics store or alerting.** The process writes structured
  JSON to stdout and exposes counters; nothing collects them yet.
- **No CDN.** The frontend is served by the backend from one origin.

None of these are hard to add, and none of them are claimed.
