# Going live

The first deploy, once. `docs/RUNBOOK.md` is how the system is operated after
this — build, release, rollback, backup, restore — and this does not repeat it.
Where a step has a runbook section, it links to it rather than restating it.

---

## Read this before anything else

**There is no frontend to deploy separately.** One Node process serves the
public site, the console and the API from a single origin. `frontend/` is plain
ES modules read off disk by the backend; it has no build, no bundle, no
`dist/`, and nowhere of its own to go. If you have been planning a static host
for the front end and a server for the API, delete that plan — it adds a second
origin, a second certificate, a CORS problem and a deploy that can half-succeed,
and buys nothing.

**One instance. Not two.** The ledger is held in memory and written to an
append-only journal on disk. Two containers on one volume interleave their
writes and break the hash chain, which is the one failure the whole design
exists to prevent. So: no autoscaling, no replica count above 1, no
load-balanced pool. Horizontal scale needs the Postgres design in
`docs/STATE.md`, not another container.

**The volume is the product.** Lose `/data` and you have lost every project,
every event and every signature. Nothing else in the system is stateful and
nothing else needs backing up.

**Memory is sized by the record, not by traffic.** The whole ledger is
reconstructed into memory at boot, so RAM grows with the number of events, not
with the number of users. Boot time grows with it too — readiness is what holds
traffic back while the journal replays.

---

## Where it runs

Your domain is registered at Hostinger. That is a **DNS** question, and it is
independent of where the container runs: the registrar keeps the name, and a
record points it at an address. Both options below leave the domain exactly
where it is.

| Option | Verdict | Why |
|---|---|---|
| Hostinger shared / Premium / Business / Cloud hosting | **Will not work** | No Docker, no root, no volume you control, no long-running process owning a port. Their Node support is for request-scoped apps, and this is a stateful daemon. |
| **Hostinger VPS (KVM)** | **Recommended** | Root, Docker, a real disk. One vendor, one bill, and the domain is already there. |
| Fly.io · Render · Railway | Also fine | TLS, restarts and health checks are handled for you. Point Hostinger's DNS at them. Costs more; saves the proxy step. |

The rest of this document takes the Hostinger VPS route, because it is the one
your existing account makes cheapest and it is the one with the most steps. If
you pick a managed platform instead, steps 2, 5 and 7 are done for you and the
rest is identical.

**Sizing for a pilot:** 2 vCPU, 8 GB RAM, 100 GB disk. The floor is 2 GB, but
the record lives in RAM and the evidence store accepts objects up to 50 MB
each, so headroom is cheaper than a migration. Disk is dominated by evidence,
not by the journal — the journal is JSON lines.

```
                     ┌───────────────────────────────────────┐
   yourdomain.com    │  Hostinger VPS                        │
   ──────────────►   │                                       │
        :443         │  Caddy  :80 :443   ── TLS, redirect    │
                     │     │                                 │
                     │     └──► construx :8080 (localhost)   │
                     │            ├── /            site      │
                     │            ├── /app         console   │
                     │            ├── /v1/*        API       │
                     │            └── frontend/    static    │
                     │                                       │
                     │  /srv/construx/data   ◄── the record  │
                     │     ledger.jsonl                      │
                     │     ledger.jsonl.acu                  │
                     │     evidence/                         │
                     └───────────────────────────────────────┘
```

---

## Step 1 — Generate the secrets

Do this first, on your own machine, and put the results in a password manager.
Two of them can never be regenerated without consequences.

```bash
# Signs every session token. Rotating it later just signs everybody out.
openssl rand -base64 48

# Witnesses every e-signature. Generate ONCE and keep it for ever: a new key
# makes every signature the platform has already made fail verification.
openssl genpkey -algorithm ed25519 -out signing.pem && cat signing.pem
```

You also need, before you finish:

- **SMTP credentials** on port 587 with a username and password. This is not
  optional — see step 8, the first account cannot be created without working
  email. Use a transactional provider or Hostinger's own mail hosting. Do not
  run your own mail server on the VPS; most providers block outbound port 25 and
  a fresh IP has no sending reputation.
- **AI provider keys**, only if you are going live with real AI. You do not have
  to. `AI_MODE=local` runs every engine deterministically with no provider
  spend, which is a legitimate soft-launch: the platform is fully usable and the
  AI answers are fixed rather than generated. Switch it on later by changing one
  variable and restarting.

---

## Step 2 — Provision the VPS

Create a KVM VPS in Hostinger's panel, Ubuntu 24.04, and note its IPv4 address.
Then, over SSH as root:

```bash
# A user that is not root, with sudo.
adduser construx && usermod -aG sudo construx

# Keys only. Set PermitRootLogin no and PasswordAuthentication no.
nano /etc/ssh/sshd_config && systemctl restart ssh

# Only SSH and the web.
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw enable

# Docker.
curl -fsSL https://get.docker.com | sh
usermod -aG docker construx
```

Log out and back in as `construx` so the docker group applies.

**Do not rely on `ufw` alone to keep the app port private.** Docker publishes
ports by writing its own iptables rules, and they are evaluated before ufw's —
a container published as `8080:8080` is reachable from the internet on a host
whose firewall allows only 80 and 443, and would serve the console over plain
http beside the https one. `deploy/compose.yaml` binds the loopback
(`127.0.0.1:8080:8080`) for exactly this reason. Confirm it from somewhere else
after step 4:

```bash
curl --max-time 5 http://<vps-ip>:8080/healthz    # must fail to connect
```

---

## Step 3 — Point the domain at it

Do this **now**, not at the end: DNS takes time to propagate, and the
certificate in step 5 cannot be issued until the name resolves to this machine.

In Hostinger's panel, open the DNS zone for the domain and set:

| Type | Name | Value | TTL |
|---|---|---|---|
| `A` | `@` | your VPS IPv4 | 300 |
| `A` | `www` | your VPS IPv4 | 300 |
| `AAAA` | `@` | your VPS IPv6, if it has one | 300 |

Use a 300-second TTL for the go-live so a mistake is five minutes from being
undone rather than a day. Raise it once you are settled.

**If the domain's nameservers point somewhere other than Hostinger** — Cloudflare
is the common case — then Hostinger's DNS zone is not being read, and you must
make this change wherever the nameservers point instead. Check first:

```bash
dig +short NS yourdomain.com
```

Then wait for it:

```bash
dig +short A yourdomain.com    # must return your VPS IP before step 5
```

---

## Step 4 — Deploy the container

```bash
sudo mkdir -p /srv/construx && sudo chown construx:construx /srv/construx
cd /srv/construx
git clone https://github.com/jnnseya-cpu/construx.git app && cd app
```

Create `/srv/construx/app/.env` — never commit it, `.gitignore` already refuses
it:

```bash
NODE_ENV=production

# The record. Both on the mounted volume, both backed up together.
LEDGER_JOURNAL_PATH=/data/ledger.jsonl
LEDGER_JOURNAL_FSYNC=true
EVIDENCE_STORE_PATH=/data/evidence

# From step 1.
GATEWAY_JWT_SECRET=<the openssl rand output>
SIGNING_PRIVATE_KEY_PEM=<the PEM, newlines as \n, on one line>

# The public origin. Every link sent by email is built from this, so it is the
# https address people will use — not the address the container binds to.
PUBLIC_BASE_URL=https://yourdomain.com

# Email. Required before the first account can be created.
SMTP_HOST=<host>
SMTP_PORT=587
SMTP_SECURE=false
SMTP_REQUIRE_TLS=true
SMTP_USER=<user>
SMTP_PASS=<pass>

# local = deterministic engines, no spend. Change to production when you are
# ready to pay providers, and set the two keys.
AI_MODE=local
```

`deploy/compose.yaml` reads these. Start it:

```bash
docker compose -f deploy/compose.yaml --env-file .env up -d --build
docker compose -f deploy/compose.yaml logs -f
```

**Read the boot block.** It states exactly what this deployment is, and it is
the fastest way to catch a wrong variable:

```
  Ledger       /data/ledger.jsonl — 0 events restored into 0 entities, …
  Evidence     /data/evidence — up to 50MB per object
  Signing      Ed25519 key loaded; signatures are witnessed by the platform …
  AI mode      local (deterministic engines, no provider spend)
```

Anything printed as `[config warning]` above that block is
`assertProductionSafety()` telling you this is not production yet. It warns
rather than exiting on purpose — a refusal to boot turns a wrong flag into an
outage — so **the warnings are yours to read, not the platform's to enforce.**
There should be none before you go on.

Confirm it is up, on the box only:

```bash
curl -fsS http://127.0.0.1:8080/readyz
```

---

## Step 5 — TLS and the reverse proxy

Caddy, because it obtains and renews the certificate itself and the whole
configuration is four lines. Create `/srv/construx/Caddyfile`:

```
yourdomain.com, www.yourdomain.com {
	encode zstd gzip
	reverse_proxy 127.0.0.1:8080
}
```

Nothing else. Do not add security headers here — the platform sets its own
content-security-policy, frame refusal and `nosniff` on both HTML responses, and
a second set from the proxy will either duplicate or contradict them.

```bash
docker run -d --name caddy --restart unless-stopped --network host \
  -v /srv/construx/Caddyfile:/etc/caddy/Caddyfile:ro \
  -v caddy_data:/data -v caddy_config:/config \
  caddy:2
```

The certificate is issued within a few seconds of the container starting,
provided step 3 has propagated. Watch `docker logs caddy` if it does not.

---

## Step 6 — Verify before you tell anyone

| Check | Expected |
|---|---|
| `curl -I http://yourdomain.com` | `301` to https |
| `curl -fsS https://yourdomain.com/readyz` | `200` |
| `curl -sI https://yourdomain.com/v1/console/session -X POST` | `403` — the console is not open to strangers |
| `https://yourdomain.com/` | the landing page, valid certificate |
| `https://yourdomain.com/app` | the console sign-in |
| `docker compose logs \| grep 'config warning'` | nothing |

The 403 matters and CI checks it on every build for a reason: it is the one
route that, left open, would let anyone in the world take a session.

---

## Step 7 — Backups, on day one

The record is two append-only files plus the evidence directory. There is no
database, so there is no dump — backing up is copying.

Both files must be copied **together**. Restoring the ledger without the `.acu`
file gives you a complete project record whose wallets have forgotten what they
spent, which hands customers AI you have already paid a provider for.

```bash
cat > /srv/construx/backup.sh <<'SH'
#!/bin/sh
set -e
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT=/srv/construx/backups/$STAMP
mkdir -p "$OUT"
docker exec construx sh -c 'cat /data/ledger.jsonl'     > "$OUT/ledger.jsonl"
docker exec construx sh -c 'cat /data/ledger.jsonl.acu' > "$OUT/acu.jsonl"
docker exec construx tar -C /data -cf - evidence        > "$OUT/evidence.tar"
SH
chmod +x /srv/construx/backup.sh
crontab -e   # 0 * * * * /srv/construx/backup.sh
```

Because the files are append-only, a copy taken while the service is running is
a valid prefix of the record — it may miss events written during the copy and
cannot contain a half-written earlier one.

**Then get them off the machine.** A copy sitting on the same disk as the
original is not a backup, and a VPS snapshot is not one either if the volume is
the VPS disk. Ship them to object storage or pull them down on a schedule.

Restore, and what the platform refuses to load, are in the runbook.

---

## Step 8 — The first account

A fresh deployment has an empty ledger: no tenants, no users, nobody who can
sign in. The first account is created through the public signup on the site,
the same route every later customer uses.

**This is why SMTP had to work first.** Signup emails a confirmation link, and
that link is built from `PUBLIC_BASE_URL`. With no SMTP host the platform
records the message and transmits nothing, so the link is never delivered and
the account can never be confirmed — and the screen will not tell you that,
because to a caller a real registration and a duplicate one answer identically
by design.

1. Go to `https://yourdomain.com/signup`.
2. Register the operating company. Confirm from the email.
3. Sign in at `/app` and check the identity you have.

One operational quirk worth knowing: pending registrations are held in memory,
not in the ledger. A restart between signing up and clicking the link discards
the pending registration — harmless, but sign up again rather than hunting for
the cause.

---

## Step 9 — Deciding when AI goes on

You can run live on `AI_MODE=local` indefinitely. Every engine answers
deterministically, no provider is called, and no money is spent. It is the
honest way to soft-launch: nothing is faked, the answers are simply fixed.

To turn it on, set `AI_MODE=production`, add `OPENAI_API_KEY` and
`GEMINI_API_KEY`, and restart. From that point every AI call debits the
tenant's ACU wallet, the orchestrator falls back between providers, and it
refuses to call a provider at all on an empty wallet. The commercial rules —
markup, minimum profit, unit value — are the `ACU_*` variables in
`.env.example`, and they are business decisions rather than deployment ones.

---

## What you are choosing to live without

Stated plainly so none of it is discovered during an incident.

- **No horizontal scale and no failover.** One node. Recovery is restart or
  restore, and both are manual.
- **Recovery granularity is the backup interval.** Hourly cron means up to an
  hour of events at risk.
- **No log shipping, metrics store or alerting.** The process writes structured
  JSON to stdout with a correlation id on every response, and nothing collects
  it. `docker compose logs` is your observability until something does.
- **Rate limits are per-process.** Correct for one instance, which is what you
  are running. `GATEWAY_RATE_LIMIT_REDIS_URL` exists for the day that changes.
- **No CDN.** One origin serves the application and its assets.

None of these are hard to add. None of them are claimed to exist.
