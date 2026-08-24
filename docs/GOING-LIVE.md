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

### If the VPS already runs something

**Check before installing anything.** A VPS that has been up for weeks is not a
blank machine, and the collision is not obvious until Caddy refuses to start:

```bash
ss -tlnp | grep -E ':80 |:443 |:8080 ' || echo "PORTS FREE"
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}'
```

Anything holding 80 or 443 means **steps 5 and 7 below do not apply**. Do not
stop it and do not install Caddy beside it — one reverse proxy owns those ports
on a host, and the one already there is serving something somebody relies on.
Co-exist instead:

1. **Give this platform a free host port.** `CONSTRUX_HOST_PORT=8090` in `.env`.
   The container still binds `8080` internally and is still published only on
   `127.0.0.1`; only the host side moves. Never publish it on `0.0.0.0` to get
   around a clash — Docker's iptables rules are evaluated before ufw's, so that
   puts the console on the open internet over plain http.
2. **Add the domain to the reverse proxy that is already running.** That proxy
   already obtains certificates for the other sites; this is one more site
   block, not a second proxy.

   **How it reaches this container depends on how the proxy runs, and getting
   this wrong is the step that wastes an evening.** If the proxy is itself a
   container — check `docker ps` for published ports like `0.0.0.0:80->80`,
   which means it is on a bridge network — then `127.0.0.1` *inside* it means
   the proxy itself, not the host, and it can never reach the published loopback
   port. Put this container on the proxy's network instead and address it by
   name:

   ```bash
   docker network connect <the proxy's network> construx
   # then in the proxy config:   reverse_proxy construx:8080
   ```

   That is also the tighter arrangement: nothing needs publishing to the host at
   all for the route to work. `CONSTRUX_HOST_PORT` still earns its place, but as
   a diagnostic — it is what makes `curl 127.0.0.1:8090/readyz` work on the box
   without colliding with whatever already holds 8080.

   Only where the proxy runs with `--network host`, or directly on the machine,
   does `127.0.0.1:8090` work.
3. **Skip step 5 entirely.** There is no Caddy to install and no certificate to
   obtain here — the existing proxy does both.

Everything else — the secrets, `.env`, the compose command, backups, the first
account — is unchanged.

**Memory is the constraint when sharing, not disk or CPU.** The whole ledger is
replayed into memory at boot, so this platform's footprint grows with the size
of the record while its neighbours' stay flat. On a 4 GB box already running two
applications, that is a pilot rather than a business, and the upgrade is a resize
rather than a migration.

### What actually lands on the disk

Three classes of thing, and only one of them is big.

**BIM models do not land on it at all.** `ingestModel` records the file's hash,
its format, discipline, LOD and element count, and optionally a `fileUri`
pointing at where the file really lives. A 1.5 GB federated IFC therefore costs
the volume a few hundred bytes. The model stays in the common data environment
that versions and coordinates it, and the platform records *which* model was the
basis of a decision rather than becoming a second copy of it.

Say that out loud before anybody expects otherwise: **this is not a model
server.** There is no viewer, no upload path for an `.rvt`, and no route that
accepts one. If a model needs opening, it is opened where models are kept.

**Evidence and documents do land on it**, through the one upload route, capped
at `EVIDENCE_MAX_BYTES` (50 MB default). Drawings, photographs, certificates,
delivery tickets, test results, scanned O&M content. This is what fills a disk,
and photographs are most of it:

| Per active project, per month | At capture | As stored |
|---|---|---|
| Site photographs — 100/day, 22 days | 6.6 GB (3 MB each) | 1.3 GB (~600 KB each) |
| Drawings issued and revised — 60 at 5 MB | 300 MB | 300 MB |
| Certificates, tickets, test results — 200 at 1 MB | 200 MB | 200 MB |
| **Total** | **~7 GB** | **~1.8 GB** |

The second column is what actually lands, because `frontend/lib/capture.js`
re-encodes photographs at 1920px on the long edge before they leave the handset.
Only photographs move: a drawing, a PDF or an IFC is stored exactly as supplied,
which is why those two rows do not change.

So 100 GB is roughly four and a half years of one busy site, or eighteen months
of three — against fourteen months and four to five if nothing were re-encoded.
Plan against the stored column, but do not size the disk so tightly that a
browser falling back to the original bytes fills it.

**The ledger is negligible** beside either. It is JSON lines, and a project
generating a hundred thousand events writes tens of megabytes.

### Where the bytes live

**The destination is Backblaze B2, and the cutover belongs in days rather than
months.** That is a correction: an earlier version of this document proposed
Cloudflare R2 at a 60 GB trigger, and both halves were wrong.

R2 was wrong on the numbers. B2 is cheaper until a tenancy reads back more than
**3.9× what it stores, every month** — R2's zero-egress guarantee is insurance
costing £78 a month against a risk that does not arrive at document-platform read
volumes:

| read ÷ stored | B2 | R2 | |
|---|---|---|---|
| 1× | £52 | £130 | B2 by £78 |
| 2× — realistic | **£52** | £130 | **B2 by £78** |
| 3× | £52 | £130 | B2 by £78 |
| 4× | £139 | £130 | R2 by £9 |
| 8× | £487 | £130 | R2 by £356 |

The 60 GB trigger was wrong on the migration. Every object has to be copied,
re-hashed and verified, because a content-addressed store that does not check the
hash is not one — so the cost of moving is measured in objects and only ever
rises:

| Move at | Objects to copy and verify |
|---|---|
| **before the first customer** | **~0** |
| 60 GB held | ~20,500 |
| the first Professional Delivery tenancy | ~170,700 |

So: go live on the volume because it is built and works, and **cut over before
the first paying customer**, not at a capacity threshold. At that point the
migration is a script that runs in minutes. `GET /v1/admin/tenants` reports every
tenancy's meter and the estate totals, so the position is visible either way.

The full comparison, at a year-two book of 11 TB held and 22 TB read per month:

| Backend | Storage | Egress | Total | Markup on a £15 block |
|---|---|---|---|---|
| **Backblaze B2** | £52 | £0 | **£52** | 31.6× |
| Cloudflare R2 | £130 | £0 | £130 | 12.7× |
| VPS block volume | £968 | £0 | £968 | 1.7× |
| AWS S3 | £200 | £1,564 | £1,764 | 8.3× |
| Firebase Storage | £226 | £2,086 | £2,312 | 7.3× |

**Firebase is the wrong answer here, and the price is the weaker reason.** It is
the dearest of the five, but it also fights three settled decisions at once: the
SDK ends zero runtime dependencies; Firebase Auth would be a second identity
model beside the RBAC/ABAC that already enforces every permission; and its
value — client-direct upload — bypasses the server-side re-hash that stops a
client storing arbitrary bytes under a hash the ledger already trusts. That guard
is what makes the evidence chain worth having.

One copy is enough on object storage and two are needed on the volume. Not a
shortcut: the store is content-addressed, so objects are immutable and never
overwritten, versioning therefore costs nothing, and object lock gives the
logical protection a second copy would otherwise buy.

**Retention will not save you.** Nothing the ledger names is deletable, by
policy: an evidence record can be argued over for as long as the contract can be
sued on. The only removable bytes are objects no record names, and the upload
path cannot create those.

### What the B2 driver needs, when it is written

Not built. Stated so the shape is known before somebody starts.

`EvidenceStore` already separates policy from bytes in everything but its type:
the hash whitelist, the re-hash on write and on read, tenant path scoping, the
size ceiling, the signed-link HMAC and the usage meter are all backend-agnostic
and must stay written once. What swaps is six byte-level operations.

Three things make it more than a driver:

- **B2 speaks the S3 API, and the S3 API is HTTP plus SigV4** — HMAC-SHA256
  chains, all of it in `node:crypto`. No dependency, the same argument that put
  SMTP and RESP in this repo by hand.
- **`projectRegister` calls `has()` once per evidence record.** On a volume that
  is a `stat`; against object storage it is a network round trip each. It has to
  become one `LIST` into an index, which is better on the volume too.
- **It cannot be tested against B2 from here.** A fake S3 server over `node:http`
  proves the signing and the protocol, the way the fake SMTP and RESP servers
  already do — it does not prove B2's implementation agrees. That check happens
  on first deploy.

### Memory, and why it is a different question

The whole ledger is rebuilt into memory at boot, so RAM tracks the number of
events rather than the number of users or the size of the documents. Events are
small; 8 GB is comfortable well past the point the disk becomes the problem.
What grows with the record is **boot time**, because every event is replayed and
every hash reverified on the way up — which is why readiness, not liveness,
gates traffic.

```
                     ┌───────────────────────────────────────┐
   construxvg.com    │  Hostinger VPS                        │
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

## The whole thing, as a list

Every command in order, for someone who wants to follow rather than read. The
sections after this explain each one and say where the order is load-bearing.

```
ON YOUR OWN MACHINE
  1  openssl rand -base64 48                      -> save as GATEWAY_JWT_SECRET
  2  openssl genpkey -algorithm ed25519 \
       -out signing.pem && cat signing.pem        -> save as SIGNING_PRIVATE_KEY_PEM
  3  get SMTP host, user, password on port 587    -> required, see step 8
                                                    the Hostinger mailbox on
                                                    construxvg.com already works

IN HOSTINGER'S PANEL
  4  create a KVM VPS, Ubuntu 24.04               -> note the IPv4 AND the IPv6
  5  DNS zone: CHANGE A @   194.36.185.146 -> that IP, TTL 300
  6  DNS zone: CHANGE A www 194.36.185.146 -> that IP, TTL 300
  6a DNS zone: CHANGE AAAA @ -> the VPS IPv6, or DELETE the record
                                                 -> leaving the old one sends
                                                    every mobile visitor to the
                                                    parking page
  6b DNS zone: leave MX and TXT exactly as they are

ON THE VPS, AS root
  7  adduser construx
  8  usermod -aG sudo construx
  9  nano /etc/ssh/sshd_config                    -> PermitRootLogin no
                                                     PasswordAuthentication no
 10  systemctl restart ssh
 11  ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw enable
 12  curl -fsSL https://get.docker.com | sh
 13  usermod -aG docker construx
 14  exit                                          -> log back in as construx

ON THE VPS, AS construx
 15  sudo mkdir -p /srv/construx
 16  sudo chown construx:construx /srv/construx
 17  cd /srv/construx
 18  git clone https://github.com/jnnseya-cpu/construx.git app
 19  cd app
 20  nano .env                                     -> the block in step 4 below
 21  docker compose -f deploy/compose.yaml --env-file .env up -d --build
 22  docker logs -f construx                       -> read it, no [config warning]
 23  curl -fsS http://127.0.0.1:8080/readyz        -> expect 200

 24  dig +short A construxvg.com                   -> must return this VPS's IP
                                                     before going on
 24a dig +short AAAA construxvg.com                -> the VPS IPv6, or nothing.
                                                     NOT 2a02:4780:...
 25  nano /srv/construx/Caddyfile                  -> the three lines in step 5
 26  docker run -d --name caddy --restart unless-stopped --network host \
       -v /srv/construx/Caddyfile:/etc/caddy/Caddyfile:ro \
       -v caddy_data:/data -v caddy_config:/config caddy:2
 27  docker logs caddy                             -> certificate obtained

FROM ANYWHERE ELSE
 28  curl -I http://construxvg.com                 -> 301 to https
 29  curl -fsS https://construxvg.com/readyz       -> 200
 30  curl -sI -X POST \
       https://construxvg.com/v1/console/session   -> 403
 31  curl --max-time 5 http://<vps-ip>:8080/healthz-> must NOT connect

ON THE VPS
 32  nano /srv/construx/backup.sh                  -> the script in step 7
 33  chmod +x /srv/construx/backup.sh
 34  crontab -e                                    -> 0 * * * * /srv/construx/backup.sh
 35  arrange to copy /srv/construx/backups OFF this machine

IN A BROWSER
 36  https://construxvg.com/signup                 -> register the company
 37  confirm from the email                        -> this is why step 3 mattered
 38  https://construxvg.com/app                    -> sign in
```

Four places the order is not a preference:

- **6 before 25.** Caddy cannot be issued a certificate until the name resolves
  to the machine asking for it.
- **3 before 36.** No SMTP, no confirmation email, no account — ever.
- **20 before 21.** `PUBLIC_BASE_URL` is baked into every link the platform
  emails, so it has to be the https origin before anybody signs up.
- **32 before you get busy.** The first week is when a backup is least likely to
  exist and most likely to be needed.

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
  email. Do not run your own mail server on the VPS; most providers block
  outbound port 25 and a fresh IP has no sending reputation.

  **For launch, use the Hostinger mailbox the domain already has.**
  `construxvg.com` already delivers through `mx1.hostinger.com` and its SPF
  record already authorises Hostinger to send. Using that mailbox's SMTP means
  no new account, no domain verification wait and **no DNS change at all** —
  which is why it is the right choice on day one.

  Move to a transactional provider (Postmark, Resend, SES) when volume or
  deliverability justifies it, not before. When you do, the SPF record must be
  extended to authorise them as well:

  ```
  v=spf1 include:_spf.mail.hostinger.com include:<provider> ~all
  ```

  One `v=spf1` record, both includes. A second TXT record beginning `v=spf1` is
  a permanent error and fails *both* senders — it is the usual way this breaks.
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

**The nameservers are Hostinger's**, so Hostinger's panel is the right place to
make this change — the zone is live and being read:

```
NS   pixel.dns-parking.com, byte.dns-parking.com
```

`dns-parking.com` is Hostinger's own parking pair. Nothing needs moving.

**The zone is not empty, and that changes this from adding records to editing
them.** What it holds today:

| Type | Name | Currently | Do |
|---|---|---|---|
| `A` | `@` | `194.36.185.146` — the parking page | **Change** to the VPS IPv4 |
| `A` | `www` | `194.36.185.146` — the parking page | **Change** to the VPS IPv4 |
| `AAAA` | `@` | `2a02:4780:a:1577:0:17dd:b1da:10` — parking | **Change** to the VPS IPv6, or **delete** |
| `MX` | `@` | `mx1`/`mx2.hostinger.com` | **Leave alone** |
| `TXT` | `@` | `v=spf1 include:_spf.mail.hostinger.com ~all` | **Leave alone for now** — see step 8 |

Three things about that table matter more than they look.

**Do not delete the `AAAA` record and forget it.** If `A` points at the VPS and
`AAAA` still points at the parking address, every visitor on an IPv6 connection
— most phones on mobile data — reaches the parking page while the site looks
perfectly fine from your desk. It is the single most common way a cutover
appears to half-work. Either set it to the VPS's own IPv6 or remove it; do not
leave the old one.

**Do not touch the `MX` records.** Mail for `construxvg.com` is already
delivered by Hostinger, and changing the `A` record does not affect it — mail
follows `MX`, not `A`. Deleting or "tidying" them stops your email that
afternoon.

**The `TXT` SPF record is Hostinger-only**, which is exactly right if the
platform sends through the Hostinger mailbox this domain already has — and that
is what step 1 recommends for launch, precisely because it needs no DNS change.
It only has to be edited if you move to a transactional provider later.

Use a 300-second TTL for the go-live so a mistake is five minutes from being
undone rather than a day. Raise it once you are settled.

Then wait for it — the old parking address is cached, so this is not instant:

```bash
dig +short A construxvg.com       # must return your VPS IP before step 5
dig +short AAAA construxvg.com    # must return the VPS IPv6, or nothing at all
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
PUBLIC_BASE_URL=https://construxvg.com

# Email. Required before the first account can be created.
# Hostinger already carries mail for this domain, so this is its own SMTP:
# the user is the FULL mailbox address, not a short name. Confirm the host in
# Hostinger's panel under Emails -> configuration settings before pasting it.
SMTP_HOST=smtp.hostinger.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_REQUIRE_TLS=true
SMTP_USER=contact@construxvg.com
SMTP_PASS=<the mailbox password>

# Who the mail says it is from. Despite the NEWSLETTER_ prefix this is the from
# address on EVERY outbound email, the signup confirmation included, and its
# default is hello@construx.ai — the wrong domain for this deployment. Left as
# the default, Hostinger is being asked to send as a domain it does not carry
# and whose SPF record does not authorise it, so the confirmation email is
# rejected or filtered and nobody can finish signing up. Make it the mailbox
# that is actually authenticating above.
#
# Deliberately the monitored inbox rather than a no-reply address. Every one
# of these emails invites a reply somebody will eventually send - a question
# about a confirmation link, a bounce, a person who cannot sign in - and a
# no-reply mailbox turns each of those into silence on both sides.
NEWSLETTER_FROM_NAME=CONSTRUX.AI
NEWSLETTER_FROM_ADDRESS=contact@construxvg.com

# local = deterministic engines, no spend. Change to production when you are
# ready to pay providers, and set the two keys.
AI_MODE=local
```

`deploy/compose.yaml` reads these. Start it:

```bash
docker compose -f deploy/compose.yaml --env-file .env up -d --build
docker logs -f construx
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
construxvg.com, www.construxvg.com {
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
| `curl -I http://construxvg.com` | `301` to https |
| `curl -fsS https://construxvg.com/readyz` | `200` |
| `curl -sI https://construxvg.com/v1/console/session -X POST` | `403` — the console is not open to strangers |
| `https://construxvg.com/` | the landing page, valid certificate |
| `https://construxvg.com/app` | the console sign-in |
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
# `mkdir -p` first, because the evidence directory is created lazily on the
# first upload. On a fresh deployment it does not exist yet, and `tar` exits
# non-zero on a missing directory — which `set -e` turns into a backup script
# that fails every hour until somebody uploads a photograph.
docker exec construx sh -c 'mkdir -p /data/evidence && tar -C /data -cf - evidence' > "$OUT/evidence.tar"
SH
chmod +x /srv/construx/backup.sh
/srv/construx/backup.sh          # run it once by hand before trusting the cron
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

1. Go to `https://construxvg.com/signup`.
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
