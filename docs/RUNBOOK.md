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

**How long a boot takes is the tail, not the record.** Boot reads the whole
journal (every event has to be in memory) but rebuilds the state from
`<journal>.snapshot` where one exists and agrees with the journal — the same
event count, the same last event, every chain head where the journal's
prefix leaves it — and replays only what was written after it. The banner
says so: `N events restored (M from the snapshot taken …, K replayed)`. A
snapshot that is torn, edited or disagrees is refused with a `[snapshot]`
line on stderr and the whole journal is replayed; nothing depends on it. The
timer takes one every `LEDGER_SNAPSHOT_INTERVAL_MINUTES` (default 60) once
`LEDGER_SNAPSHOT_MIN_EVENTS` (default 1,000) have been written since the last;
*Take a snapshot now* on the Event Store screen takes one on demand, and the
screen shows what the next boot would replay. The backup ships the snapshot
with the journal; a restore without one is a full replay, which is slower
and equally correct.

### Backup

The record is four append-only files and two directories, all under `/data`:

| Path | What it is | Without it |
|---|---|---|
| `ledger.jsonl` | The hash chain — every governed event | There is no record |
| `ledger.jsonl.acu` | The ACU wallets: every grant, hold and charge | Wallets forget their debits and customers get AI the platform already paid for |
| `ledger.jsonl.views` | Blog page views | Counters restart at zero |
| `ledger.jsonl.revoked` | Sessions revoked before they expired | Every revoked refresh token works again for the rest of its seven days |
| `ledger.jsonl.snapshot` | The ledger's state as at an event count, so boot replays only the tail | Boot replays every event; slower, equally correct |
| `evidence/` | The files the chain's hashes point at | A record that proves documents nobody holds any more |
| `site-media/` | The landing page's own pictures | The public site loses its images |

`deploy/autodeploy.sh` takes all six from the running container before every
deploy, as one set stamped with the time, and keeps the newest
`CONSTRUX_BACKUP_KEEP` sets (default 14) on the host. It used to copy the
first two only, for ever, into a directory nothing pruned — on the same disk
the journal needed.

```bash
# The same set by hand, from the host, against the running container.
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
docker exec construx sh -c 'cat /data/ledger.jsonl' > ledger-$STAMP.jsonl
for SIDE in acu views revoked; do docker exec construx sh -c "cat /data/ledger.jsonl.$SIDE" > $SIDE-$STAMP.jsonl; done
docker exec construx sh -c 'cd /data && tar cf - evidence site-media' > files-$STAMP.tar
```

Because the journal files are append-only, a copy taken while the service is
running is a valid prefix of the record: it may miss events written during the
copy and cannot contain a half-written earlier one. A torn final line in a
backup is handled on load exactly as a torn line from a crash.

**A copy on the same host is not a backup.** It survives a bad deploy and
nothing else. The platform ships the record off the box itself where an
object store is configured (`OBJECT_STORE_*`): every `BACKUP_INTERVAL_MINUTES`
(default six hours) it writes one set under `BACKUP_PREFIX/<stamp>/` —
`ledger.jsonl`, `.acu`, `.views`, `.revoked`, `.snapshot` where one exists,
and `site-media/*` — each file in parts of `BACKUP_PART_MB` named
`<file>.part-0000`, `part-0001`, …, then `manifest.json` last, naming every
file, its size, its part count and its SHA-256. A set with a manifest is a
whole set. The newest `BACKUP_KEEP` sets (default 30) are kept there and
older ones pruned only after a new one lands. *Back up now* on Platform
operations makes the same run on demand; `GET /v1/admin/backups` is the
position; the watch rule `backup_offhost` fires when no set is younger than
two intervals, and in production when there is no object store at all.

Evidence is not in the set, deliberately: with an object store configured the
evidence store *is* that object store (the only store, never a cache in
front of the volume), so the evidence is off the host by construction. With
no object store there is nowhere to ship a backup either, and the readiness
screen says so under *Off-host backup*.

### Restore

1. Stop the service.
2. Put the four files on the volume at `LEDGER_JOURNAL_PATH`,
   `LEDGER_JOURNAL_PATH.acu`, `.views` and `.revoked`, and unpack the tar into
   `EVIDENCE_STORE_PATH` and `SITE_MEDIA_PATH`.
3. Start it.

**From the object store.** Fetch the set and reassemble each file from its
parts in order; the manifest's hash says whether the reassembly is right
before the service is asked to replay it.

```bash
# Any S3 client. The AWS CLI against an S3-compatible endpoint:
STAMP=20260906T060000Z
aws --endpoint-url "$OBJECT_STORE_ENDPOINT" s3 cp --recursive "s3://$OBJECT_STORE_BUCKET/backups/$STAMP/" ./restore/
cd restore
for NAME in $(jq -r '.files[].name' manifest.json); do
  mkdir -p "$(dirname "$NAME")"
  cat "$NAME".part-* > "$NAME"
  echo "$(jq -r --arg n "$NAME" '.files[] | select(.name==$n) | .sha256' manifest.json)  $NAME" | sha256sum -c -
done
```

Then step 2 above: the `ledger.jsonl*` files onto the volume at
`LEDGER_JOURNAL_PATH`, `site-media/` into `SITE_MEDIA_PATH`. The evidence is
already in the object store under its tenancy prefixes and needs no restore.

**It has been drilled, and timed.** `backend/tests/restoredrill.test.ts` runs
the procedure below on every test run: a real backup goes to an object store,
comes back part by part, each file is reassembled in order and checked against
the manifest's hash, and a ledger boots from the result. It asserts the restored
record is the same record — same event count, same chain head, same entity state
hashes — and prints what it took:

```
# restore drill: 700 events, 2 files, 1277KB, reassembled and replayed in 146ms
```

That is the fetch, the reassembly, the hash check and the replay. It is not
the whole recovery: it does not include provisioning a host, pulling the image,
or the transfer time from a real object store across a real network, and a
production journal is larger than a seeded one. Treat 146ms as the *floor* the
platform contributes, and measure the rest on the host the first time the
script below is run. What it removes is the possibility that a set does not
restore at all, which is what an untested backup actually risks.

The same run asserts the two refusals an operator depends on: a journal with an
event removed from the middle does not replay, and a torn final line — a crash
between the write and the fsync — leaves everything before it intact.

**Drill the container too.** `deploy/restore-drill.sh` takes a backup set,
boots a second container from the live image against a throwaway volume on a
port of its own, waits for `/readyz`, reads how many events replayed, and
removes everything it made. The live container is never touched. Run it after
the first backup and then on a calendar; a set that does not restore is a
finding, and the drill is where it should be found. The script was written
against this compose deployment and has not been run in the build sandbox,
which has no Docker: the first run on the host is the first drill.

Boot verifies as it replays: every chain hash recomputed from its predecessor,
every state hash from the applied patch. **A journal that has been altered
refuses to load**, and refusing to start is the correct response — a platform
that boots on a broken chain is one that will be asked to prove something from
it later.

The errors are specific:

| Code | Boot | Meaning |
|---|---|---|
| `JOURNAL_CHAIN_BROKEN` | **refuses** | An event is missing, reordered, or the file was altered |
| `Journal … is corrupt at line N` | **refuses** | Unparseable line that is *not* the last one — real corruption, not a torn write |
| `records state hash … but its patch produces …` | continues | An event's recorded after-state hash disagrees with the state its own patch produces, *and its chain hash verifies*. See [State-hash discrepancies on replay](#state-hash-discrepancies-on-replay) — the platform boots, takes the patched state, and reports it |

The third row was tabled as JOURNAL_STATE_MISMATCH until the Gate 1 runbook
walk. Nothing raises that string, so an operator grepping a log for it would
have found nothing and concluded the failure was something else — and the row
sat beside two refusals, implying this one also stops the boot when it does
not.

### Clearing what testing left behind

Two situations, two answers, and neither is "delete the events". The record
is append-only by construction: nothing in the product removes an event, and
nothing should.

**A test tenancy on a deployment that is otherwise real.** Somebody signed up
to try the product — a trial tenancy with a couple of identities, a few
unsettled top-up requests, a trial grant — and the Command Center now reports
it as the business. Close it from Tenants & Users (**Close** on its row,
`POST /v1/admin/tenants/:tenantId/close`). Closure cancels the subscription,
deactivates and schedules erasure for every identity, empties the wallet,
raises whatever refund is owed (nothing, for a trial that paid nothing in), and
**cancels every top-up still awaiting payment** (`TOPUP_CANCELLED`). From that
moment the closed tenancy is counted in nothing on the Command Center — not the
tenancy total, not the identities, not the money awaited, not "What lands
next" — and its row stays on the register marked closed, which is where the
record of it lives. The trial credit it was given still counts against the
month's trial budget, because it was given.

**Everything, before launch.** A deployment that has only ever been tested and
is about to take its first customer should start from an empty record rather
than a closed one. With the service stopped:

```bash
# Keep what was there. Moving, not deleting: the files are the record of the
# testing, and a fresh start is not a reason to lose it.
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
mv "$LEDGER_JOURNAL_PATH"        "$LEDGER_JOURNAL_PATH.pre-launch-$STAMP"
mv "$LEDGER_JOURNAL_PATH.acu"    "$LEDGER_JOURNAL_PATH.acu.pre-launch-$STAMP"
mv "$LEDGER_JOURNAL_PATH.views"  "$LEDGER_JOURNAL_PATH.views.pre-launch-$STAMP"   # if present
```

Then start the service. Boot finds no journal, writes a new one, and seeds only
what the environment says to seed: the platform tenancy and the operator named
by `PLATFORM_OPERATOR_EMAIL`, and the demonstration if `DEMO_TENANCY_ENABLED`
is not `false`. Set it to `false` on a deployment that should show no
demonstration at all. Every operator will need to enrol their authenticator
again, because the enrolment is on the record that was moved aside.

With `LEDGER_POSTGRES_MODE` set to `mirror` or `primary`, the database holds
the same record and must start fresh too, or boot in `primary` mode will
replay the testing back in: point `POSTGRES_DATABASE` at a new database with
`deploy/postgres/schema.sql` applied, or restore the existing one from the
backup taken before testing began. Site media under `SITE_MEDIA_PATH` is not
part of the record and stays.

### The ledger store: the record in Postgres

Off by default. With `LEDGER_POSTGRES_MODE` set and the `POSTGRES_*` variables
pointing at a database that has had `deploy/postgres/schema.sql` applied, every
event the ledger commits is shipped to Postgres in commit order, one transaction
each, behind the commit. The journal on the volume stays the write-ahead log in
every mode: a commit is on the volume before it is acknowledged, and the
database is brought up to date behind it. The lag is on the Event Store screen
and in `/v1/admin/events` under `store`, never hidden.

**Bringing a deployment onto it, in order.**

1. Apply `deploy/postgres/schema.sql` to the database (idempotent; it adds the
   store's columns and tables to a database already holding the log). Give
   `construx_app` a login and set `POSTGRES_PASSWORD`. `POSTGRES_TLS=require`
   unless the database is on loopback.
2. Set `LEDGER_POSTGRES_MODE=mirror` and restart. Boot probes the database
   before it reads the journal and refuses to start if the schema is missing or
   the database is unreachable. The banner says `Postgres mirror: came up from
   the journal, N events shipping now`; the Event Store screen shows the count
   in Postgres climbing to the count in the ledger. Nothing about the restart
   changes: it still replays the journal.
3. When the screen says the two agree, set `LEDGER_POSTGRES_MODE=primary` and
   restart. Boot now replays the **database**, ships whatever the journal holds
   beyond it (the tail a crash left unshipped), and — on a host whose journal is
   shorter than the database — rewrites the journal from the database so a boot
   without the database can still replay.

**Failover to a new host.** Give it an empty volume, the same `POSTGRES_*` and
`LEDGER_POSTGRES_MODE=primary`, and start it. It replays the whole record from
the database and writes itself a journal. Two things do **not** come from the
database and must be copied from the old volume: `LEDGER_JOURNAL_PATH.acu`, the
ACU wallet's own ledger (a separate double-entry ledger by a settled decision —
without it every wallet starts at zero, which hands customers AI the platform has
paid for), and the blog view counts. Stop the old process first; two processes
extending the chain is the one thing this does not make safe, and the database
will refuse the second's events rather than fork.

**A warm standby: follower mode.** A second process on another host with the
same `POSTGRES_*`, `LEDGER_POSTGRES_MODE=follower` and no journal. It replays
the whole record from the database at boot, then polls the database every
`LEDGER_FOLLOW_INTERVAL_MS` (default 2000) for what the primary has shipped and
applies each batch — verifying every hash exactly as a boot does — and rebuilds
the identities, API keys and branding behind it. It answers every read; a
token minted by the primary works on it because the two share `GATEWAY_JWT_SECRET`.
(It was written here as AUTH_JWT_SECRET until the Gate 1 runbook walk — no
backticks on that one, deliberately: it is a variable the platform has never
read, and the walk asserts that every name in backticks resolves to something
real. Naming a dead variable as though it were live is the defect, not the
cure: an operator who set it would have
stood up a follower on a *different* signing key and every session token from
the primary would have been refused on it — the exact opposite of what this
sentence promises, discovered during a failover.)
It refuses every command with `503 LEDGER_FOLLOWER`, sign-ins included (a
sign-in records the device it came from), and the ledger itself refuses too, so
no scheduler on the standby can extend the chain. Its banner says `FOLLOWER`;
the Event Store screen shows how far behind the database it is and when it
last applied; `/readyz` says the same under `ledger.store`. The ACU wallets are
not in Postgres and read as empty on a follower — it cannot quote or run an AI
action, which it could not do anyway, being unable to write.

**Failover with a follower.** Stop the primary — the database refuses a second
writer's events rather than forking, but stopping it first is what keeps the
last unshipped events from being lost; check the primary's Event Store screen
says `Postgres holds every event the ledger holds` before it goes, or accept
that its unshipped tail stays in its journal for later. Then restart the
follower with `LEDGER_POSTGRES_MODE=primary` and a `LEDGER_JOURNAL_PATH` on its
volume. It replays the database (already loaded, so the boot is a boot and not
a migration), writes itself a journal, and takes the writes. Copy
`LEDGER_JOURNAL_PATH.acu` and the view counts from the old host as for any
failover. Point traffic at it.

**A follower halted.** The screen says *Following has stopped* and the position
carries `halted`. The database's record no longer follows what the follower
holds — a gap in the sequence, an event with no body, or a chain that does not
verify from where the follower stands, which happens when something wrote to
the follower's ledger locally (it should not be able to) or the database was
edited. Nothing is wrong on the primary. Restart the follower; it replays the
database afresh.

**The ledger store halted.** The screen says *Shipping to Postgres has stopped*
and the position carries `halted`. The database refused an event for a reason a
retry cannot change — SQLSTATE 23xxx is the chain trigger or a unique index
(another process has extended this chain in the database, or it has been
edited), 42501 is the tenant trigger, 22xxx is a value a column would not take.
Nothing is dropped: every unshipped event is in the journal. Find and stop the
other writer, or restore the database from its own backup to the position the
journal agrees with, then restart; the boot ships the tail.

**The journal and the store diverge.** Boot in primary mode refuses with
`the journal on this volume and the database diverge at event N`. The two
records share a prefix and then differ, which means two processes extended the
record separately. Decide which record is the true one — the one whose events
were acknowledged to people — and either replace the journal with the database's
(delete the journal, boot in primary) or replace the database's tail with the
journal's (restore the database to a backup taken before event N, boot in
mirror, which ships the journal forward). Do not edit either file.

**Retries.** A database that is down does not stop the platform. Commits carry
on into the journal, the queue grows, the screen shows it, and shipping resumes
with backoff when the database answers. `[ledger-store] shipping failed and will
be retried` is logged once per distinct failure.

### Secrets

Injected as environment variables by the platform. Never in the image, never in
the repository. `.env` is gitignored; `.env.example` carries names and safe
defaults and never a value.

`GATEWAY_JWT_SECRET` is the one that matters most: leave it at the development
default and every token the platform has ever signed is forgeable. A production
boot refuses to start on the default (`[boot refused]`); anything else is a
warning on the readiness screen.

**One secret, a key per purpose, each with an id.** Sessions, evidence links,
export verification tags, unsubscribe links and sign-up links each sign under
a key derived from the secret with HKDF under the purpose's own label
(`backend/src/identity/secrets.ts`). A key recovered from one purpose proves
nothing about another. Every signature is made under a key the platform can
name — the first eight hex characters of the SHA-256 of the secret — which a
session token carries in its header as `kid` and the readiness screen shows
under *Session signing secret*.

**Rotating it is two deploys, and signs nobody out.**

1. Generate the new value. Set `GATEWAY_JWT_SECRET` to it and
   `GATEWAY_JWT_SECRET_PREVIOUS` to the old one (several old ones are
   comma-separated). Deploy. From now everything is signed under the new key
   and verified against the new key, then the old: live sessions carry on,
   links in mails already sent still work, verification tags on documents
   already issued still verify. The readiness detail says a rotation is in
   progress and names the key ids.
2. When nothing signed under the old secret is still in circulation, clear
   `GATEWAY_JWT_SECRET_PREVIOUS` and deploy. Sessions last seven days
   (`GATEWAY_AUTH_REFRESH_TTL_DAYS`); sign-up and evidence links minutes; an
   **export verification tag lasts as long as the document does**, so a tag
   handed to a third party under the old secret stops verifying the day the
   old secret is dropped. Keep it in `_PREVIOUS` for as long as you honour
   those, or re-issue the documents.

The boot warns when `_PREVIOUS` still contains the current secret (the
rotation has not happened) or the published development default (anything
signed under it verifies until it is dropped). Signatures accepted under a
previous secret since boot, and under the pre-derivation form, are counted
on `GET /v1/admin/readiness` so you can see whether the old key is still
being relied on before dropping it.

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

## The site answers 502

A 502 is the reverse proxy saying it cannot reach the container. It is never
the application answering; the application answers 4xx and 5xx with a
problem+json body and a correlation id. Three causes, checked in this order
on the host:

```bash
# 1. Is the container running, or restarting in a loop?
docker ps -a --filter name=construx
# 2. What did it say on the way up? A crash loop shows the reason here.
docker logs --tail 100 construx
# 3. Does it answer on the host port compose published (CONSTRUX_HOST_PORT in .env)?
curl -sS http://127.0.0.1:${CONSTRUX_HOST_PORT:-8080}/readyz
# 4. Is it attached to the proxy's network? The proxy reaches it by name.
docker network inspect ${CONSTRUX_EDGE_NETWORK:-construx-edge} --format '{{range .Containers}}{{.Name}} {{end}}'
# 5. What did the last deploy do?
journalctl -u construx-deploy --since "2 hours ago" --no-pager | tail -60
```

- **Restarting, and the log ends in `[journal] …`** — another process holds
  the writer lock on the volume (a previous container that was not stopped),
  or the chain did not verify. Stop the other container; a chain failure is
  handled with the backup under "Restore".
- **Running, `/readyz` answers on the host port, but not in the inspect
  output** — the container was recreated and lost its attachment to the
  proxy's network. `docker network connect construx-edge construx` fixes it
  now; deploying with `-f deploy/compose.edge.yaml` makes the attachment part
  of the deployment so the next rebuild keeps it.
- **Running, `/readyz` does not answer on the host port** — the port in
  `.env` and the port the proxy points at have drifted. Both read
  `CONSTRUX_HOST_PORT`.
- **The deploy log says it rolled back** — the new image never reached
  `/readyz`; the reason is in step 2 of the container it tried.

## State-hash discrepancies on replay

Every event carries three hashes: the state before, the state after, and
the chain hash over the whole event including both. Replay recomputes all
three. Builds before 4 September 2026 could record an after-state hash the
patch beside it cannot reproduce, in two ways. A restarted process held the
ledger's own state objects in its working maps, and a routine in-place
change (`user.status = 'SUSPENDED'` on seat revocation) rewrote the
before-state the next commit diffed against — so the patch omitted the
change and the hash included it (seen on
construxvg.com at events 3634–3638, a tenancy closure on a restored
process). And the hash was taken over the object in memory rather than the
JSON written, so a `Date` or a `Buffer` in a proposal was hashed as one
thing and written as another. The ledger now freezes every state it holds,
the platform copies what it restores, and the commit path hashes the JSON
that is written — no new event can disagree with itself.

An event already written that way is not rewritten. On replay, where the
chain hash verifies — proving the event is as written — and the recorded
after-state hash still disagrees with the state its own patch produces, the
platform boots, takes the patched state as the state, and reports the
discrepancy on stderr and on the boot line:

```
[journal] event 3634 (01M1PH…, CLIENT_BRANDING_SET on ClientBrandingRecord …) records state hash sha256:e881… but its patch produces sha256:d4a1…. The chain hash verifies; the replayed state is the one its patch produces.
Ledger   /data/ledger.jsonl — 4,102 events restored into 1,207 entities, … — 1 STATE-HASH DISCREPANCY (see stderr)
```

An event whose chain hash does not verify is still refused, whatever its
state hash says: that is an altered record, not a writer's arithmetic. The
discrepancy stays on every boot as a matter of record; `docs/STATE.md`
names the build that wrote it.

The same events are named on the operator's screens, and the wording is
deliberate. Audit logs shows the chain **intact** with a warning notice
"Recorded state hashes that the events' own patches do not reproduce —
Etablix: 4 events"; the Golden Thread replay panel counts them as
"recorded-hash discrepancies (chain verified)". Neither says BROKEN or
altered, because nothing was: an event that verifies against the chain is
the event as written. A chain reported BROKEN is a different finding and a
different section of this runbook.

**If the estate screens answer `INTERNAL_ERROR` after a boot with
discrepancies** (Tenants & users, Onboarding queue, Customer value,
Predictive intel; the security stream shows `GET /v1/admin/tenants` and
`/v1/admin/forecast` as 500): the journal was written by a build whose
seat-revocation event dropped the subscription's package, and the restart
rehydrated a subscription with none. Builds from 4 September 2026 derive
the package from the tier on restore and write the package on every seat
event; deploy the current build. Nothing in the journal needs editing.

## The chain-break sweep and the newsletter suppression list

Two background behaviours an operator should know are running.

**`OPS_CONSISTENCY_SWEEP_MINUTES`** (default 60) runs the commercial
escalation over every open customer project on that interval: a break in the
bid-to-CVR data flow is raised as an exception to the tenancy's Commercial
Manager and Project Director without anybody opening the position. Platform
operations shows when it last ran, what it raised and what it skipped, and
"Sweep chain breaks" runs it now. Set it to 0 to leave escalation to the
people opening the screen. It never touches the platform tenancy or a closed
one.

**A newsletter address the relay refuses permanently is suppressed.** The
Newsletter screen lists it under "Who does not, and why" with the relay's own
reply; nothing is sent to it again until an operator presses "Try this
address again" on that row. A 4xx refusal is not suppression — the next issue
tries it again.

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

### The external monitor

Every watch rule runs inside the process it watches, so a dead process
alerts nobody. Two things outside it, both needed:

1. **An HTTP check on `PUBLIC_BASE_URL/readyz`** from an uptime service, on a
   minute or two. It answers `503 NOT_READY` with the reasons when the
   process is up and cannot extend the record (journal refusing writes, the
   volume nearly full, mid-shutdown), and it proves the front door — the
   proxy's route to the container — which nothing inside can.
2. **The heartbeat.** Set `OPS_HEARTBEAT_URL` to a dead-man's-switch URL
   (healthchecks.io, Cronitor, Better Stack, Grafana OnCall's heartbeat, or
   your own). The process POSTs it every `OPS_HEARTBEAT_INTERVAL_SECONDS`
   (default 60) **only while the platform is live** — so the monitor raises
   on a dead process, a hung one, and a live one that cannot write. Set the
   monitor's grace to two or three intervals. `GET /v1/admin/watch` shows
   `heartbeat`: beats sent, ticks withheld and why, the last error.

Both can page the same place `OPS_ALERT_WEBHOOK_URL` does.

### Who is on call

Set the rota on *Risk & alerts* (`POST /v1/admin/oncall`: operators in
handover order, days each holds the pager, when period one starts). Time
decides the handover — period *n* since the start goes to operator *n* —
so nothing has to run at midnight. *Hand the pager to one person* is an
override with an end date and a reason; it lapses on its own. The rota and
every override are events on the platform's own chain (`ONCALL_ROTA_SET`,
`ONCALL_OVERRIDE_SET`), so "who was on call when it fired" is answerable
later. Every alert reaches the person on call first with the other
operators copied, names them in the mail body, and carries `onCall` in the
webhook JSON and `— on call: <name>` in its `text` line, which a PagerDuty
or Grafana OnCall events URL can route on.

### A guest's licence, a pass, and who pays for their AI

A person invited onto a project from another organisation never takes one
of the host's package seats. What the host may need to act on:

- **"Controller — Licence Required"** on the members table (Enterprise &
  Portfolio): the person was invited with Controller roles and no seat covers
  them. Their Controller roles are withheld and they hold participant access.
  The host's two acts are *Sponsor a pass* (`POST
  /v1/controller-passes/purchase`, needs `BILLING_ACU:U`, priced at
  `CONTROLLER_PASS.monthlyPriceMinor` a month and on the invoice as its own
  line) or *Reduce to participant*. The third option — the person's own
  organisation buying them a seat — needs nobody at the host: the hourly
  sweep re-checks and grants the withheld roles when a seat appears.
- **"Controller — Licence Expired"**: the seat at home was released or the
  pass ran out. The same two acts apply; the roles are already withheld.
- **A guest cannot run AI** (`ACU_SPONSOR_REQUIRED`, `ACU_SPONSOR_APPROVAL_
  REQUIRED`, `ACU_LIMIT_EXCEEDED`, all 402): nobody has agreed to pay, the
  home organisation has not yet approved, or the allowance is used up. *AI
  sponsor* on the member's row asks the home organisation (their
  administrators decide on Team & Access, under *Our people on other
  organisations' projects*) or sponsors from the host's own wallet.
- **A membership past its end date** is ended by the hourly consistency
  sweep (`memberships` on its position), which also expires passes and
  lapses licences. Nothing waits for a request.

---

## What this deployment does not have

Stated so it is not mistaken for an omission somebody can fix with a flag.

- **No horizontal scale.** One process extends the chain at a time, whether the
  record is in the journal alone or shipped to Postgres as well: two processes
  would each hold a different in-memory record. The ledger store makes the
  record recoverable off the box and a new host able to come up from it; it
  does not make two hosts able to write at once. The database's chain trigger
  is what catches the second writer, by refusing it.
- **No automatic failover.** A new host comes up from Postgres in `primary`
  mode (see *The ledger store*), but somebody starts it, and the ACU wallet
  file still has to be copied from the old volume.
- **Point-in-time recovery is the ship lag, not the backup interval, once the
  store is on.** Without it, recovery granularity is the off-host backup
  interval (`BACKUP_INTERVAL_MINUTES`, default six hours) — and with no object
  store configured, however often the files are copied by hand.
- **No log shipping or metrics store.** The process writes structured JSON to
  stdout and exposes counters; an OTLP collector receives them only where
  `OTEL_EXPORTER_OTLP_ENDPOINT` is set, and the last 5,000 request logs are all
  the process keeps. Alerting exists — eight watch rules, told to the operators
  through the outbox and, where `OPS_ALERT_WEBHOOK_URL` is set, posted as JSON
  to a channel that is not the mail relay being watched. The monitor *outside*
  this process is still yours to run: the platform sends a heartbeat to
  `OPS_HEARTBEAT_URL` and answers `/readyz`, and a service you point at both
  is what notices a dead process (see *The external monitor*).
- **No CDN.** The frontend is served by the backend from one origin.

None of these are hard to add, and none of them are claimed.
