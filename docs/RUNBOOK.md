# Runbook

How this system is built, released, operated and recovered. `docs/STATE.md`
says what exists; this says how to run it.

**First deploy?** `docs/GOING-LIVE.md` is the one-time path: choosing a host,
pointing a domain, TLS, and the first account. This document is everything
after that.

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

`/readyz` also carries the **commit the running container was built from**, so
"is the live site on the latest?" is a question anybody can answer from a
browser:

```
curl -sS https://construxvg.com/readyz | grep -o '"commit":"[^"]*"'
```

Compare it against `git rev-parse origin/claude/ai-agent-construction-os-999410`.

- **They match** — the deploy has run and the site is current.
- **They differ** — the deployer has not picked the push up. Check
  `systemctl status construx-deploy.timer` and
  `journalctl -u construx-deploy -n 50` on the host.
- **`unknown`** — the container was started by hand rather than by
  `autodeploy.sh`, which is the only thing that sets `BUILD_COMMIT`. It is
  serving, but nothing knows what it is serving.

This exists because of a real failure recorded in `docs/STATE.md`: every commit
passed CI, none of it was running, and the box sat eleven commits behind for a
day. Nothing noticed, because CI answers "does this build" and nothing was
answering "is this running".
Between them sits the journal replay, and a container marked ready during a
replay answers "no such project" for projects that exist.

### Automatic deploy

A push to the tracked branch goes live within a minute, without anybody logging
in. `deploy/autodeploy.sh` runs on the host from a systemd timer:

```
fetch → nothing new? exit quietly
      → back up the journal
      → fast-forward, build, up
      → wait for /readyz
      → ready? done.   not ready? put the previous commit back and rebuild.
```

**It pulls; nothing pushes to it.** That is the security argument for this shape
rather than a GitHub Actions deploy. No inbound port is opened, and no machine
outside this host holds a credential that reaches the Docker socket. An Actions
deploy would mean storing an SSH key with root-equivalent access to a VPS that
also hosts two other live sites, reachable by anybody who can push to the
repository or compromise a third-party action. The cost is latency: a push is
live within the timer interval instead of instantly, which on a deploy that
takes minutes to build is not the part worth optimising.

**The rollback window is deliberately narrow.** It reverts only when the new
build never reached `/readyz`. See the section below for why that is the only
window where an automatic rollback is safe — replay finishes before readiness
and appends nothing, so a container that never became ready never wrote an
event, and the previous image can replay the same journal it could before. A
failure *after* readiness is left to a person with this document open.

**It does not check that CI was green**, and cannot: the repository is private
and this host holds no GitHub credential, on purpose. The boot check catches
anything that stops the container starting; a change that boots fine and breaks
a page will deploy. That is the same exposure as a manual deploy, arriving
sooner — so watch the CI badge, not the site.

#### Installing it, once

```bash
sudo cp /srv/construx/app/deploy/construx-deploy.service /etc/systemd/system/
sudo cp /srv/construx/app/deploy/construx-deploy.timer   /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now construx-deploy.timer
```

To point it at a different branch or checkout, drop an override rather than
editing the unit — `systemctl edit construx-deploy.service`:

```ini
[Service]
Environment=CONSTRUX_DEPLOY_BRANCH=main
Environment=CONSTRUX_APP_DIR=/srv/construx/app
```

#### Watching it

```bash
systemctl list-timers construx-deploy.timer   # when it last ran and next runs
journalctl -t construx-deploy -n 50           # the deploy history
journalctl -t construx-deploy -f              # follow a deploy as it happens
systemctl --failed                            # a failed deploy shows up here
sudo systemctl start construx-deploy.service  # deploy now, without waiting
```

A run with nothing to do prints nothing. That is deliberate: this fires 1,440
times a day, and a line per check would bury the deploys that matter.

A failed deploy that rolled back successfully still exits non-zero, so the unit
shows as failed. The site is up on the previous commit and the branch no longer
matches what is live — which is exactly the state somebody needs to be told
about rather than left to discover.

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
| `NODE_ENV` | `production` | The demonstration routes stay open and the MFA challenge code is returned in the login response for **every** account, not only the seeded ones |
| `DEMO_TENANCY_ENABLED` | your call — `false` unless you want a public demonstration | See below. It is the one setting here that is a product decision rather than a correctness one |
| `LEDGER_JOURNAL_PATH` | a path on a mounted volume | **Every record is lost on restart** |
| `LEDGER_JOURNAL_FSYNC` | `true` | Events can be acknowledged before reaching the disk |
| `GATEWAY_JWT_SECRET` | a real secret | Every token is forgeable |
| `PUBLIC_BASE_URL` | the https origin | Signed links in email go out over cleartext |
| `AI_MODE` | `production` | Engines run deterministically with no provider spend |

`assertProductionSafety()` checks all of these at boot and writes each failure
to stderr. It warns rather than exits, deliberately: a platform that refuses to
start on a misconfiguration converts a wrong flag into an outage. Read the boot
log on every deploy.

### The demonstration tenancy

`DEMO_TENANCY_ENABLED=true` seeds the Meridian lifecycle at boot as a real
tenancy with twelve identities. Know exactly what it does before setting it:

- **Those twelve accounts become public.** Their addresses are
  `@meridian.example` and belong to nobody, so their one-time code comes back
  in the login response rather than by email — anybody may sign in as any of
  them. That is what a demonstration is. It reaches those twelve accounts and
  nothing else: a customer's account is unaffected, and no operator is
  reachable this way under any setting.
- **Anyone signed in as one of them can write to that tenancy.** It is a
  sandbox in a real ledger, separated from every other tenancy by the same
  isolation that separates two customers.
- **It spends AI budget.** Seeding runs a full lifecycle's AI steps against
  whichever providers `AI_MODE` selects — once per deployment, not per visitor,
  because a restart adopts the tenancy already on disk rather than seeding a
  second one. Visitors then spend from the same wallet.
  `DEMO_ACU_CREDIT_MINOR` caps it. When it empties the platform refuses to call
  a provider, which is normal behaviour and reads correctly on screen.
- **It does not reopen `POST /v1/console/session`.** That route hands an
  anonymous caller a working token with no challenge at all, and stays refused
  in production whatever this is set to. The two are deliberately not on the
  same switch.

The boot banner's `Demo` line reports which tenancy is serving, whether it was
seeded or adopted, and what is left in the wallet. Read it after switching this
on.

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
