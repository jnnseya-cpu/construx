# Going live

From nothing to taking payments and running real AI, in order.

Every command here uses absolute paths, so it does not matter which directory
your shell is in — the Hostinger web console resets to `/root` on every
reconnect, and that has already cost an afternoon.

Nothing in this document asks you to paste a secret anywhere except into the
server itself.

---

## Before you start

Check where the deployment actually is. This is the single most useful command
in this document and it changes nothing:

```bash
/srv/construx/app/deploy/env-check.sh
```

It reports, per setting: `ok`, or what is missing and whether to **append** a new
line or **edit** an existing blank one. It never prints a value.

Two things it cannot tell you, so check them by eye:

- **`AI_MODE` shows `ok` when it is set to `local`.** The script checks that a
  key is present, not what it says. Local means mock engines and no spend.
- Whether a key is *correct*. Only a real request can establish that, which is
  what Part 5 is for.

---

## Part 0 — The first operator

A deployment with no operator cannot be administered: every admin route demands
`PLATFORM_ADMIN`, and nothing on the network can create the first one. Check
which state you are in — the boot banner says so directly:

```bash
docker logs --tail=40 construx | grep Operator
```

- `NONE — nobody can sign in` — do this part
- `created …` or `N on record` — already done, go to Part 1

Set the address, restart, and one operator is created:

```bash
grep -q '^PLATFORM_OPERATOR_EMAIL' /srv/construx/app/.env || \
  printf 'PLATFORM_OPERATOR_EMAIL=\nPLATFORM_OPERATOR_NAME=Platform operator\n' >> /srv/construx/app/.env
nano /srv/construx/app/.env      # fill in an address you can read
cd /srv/construx/app && docker compose -f deploy/compose.yaml -f deploy/compose.edge.yaml --env-file .env up -d
sleep 15 && docker logs --tail=40 construx | grep Operator
```

There is no password anywhere in this platform — sign-in is a one-time code sent
by email — so **that address is the credential**. Use a mailbox you can actually
read, and make sure SMTP is configured first or the code has no way to reach
you.

Then sign in at `https://construxvg.com/app`, enter the address, and type the
code from your inbox. Add colleagues afterwards with `POST /v1/operators` rather
than by editing this file again.

---

## Part 1 — Collect the keys

Do this part in a browser, before touching the server. Each secret is shown
once; put it somewhere safe as you go.

### Stripe — card payments

1. <https://dashboard.stripe.com> → **Developers → API keys**
2. Copy the **Secret key**. Live keys start `sk_live_`, test keys `sk_test_`.
   A test key on a production deployment cannot take real money, and the boot
   log will say so.
3. **Developers → Webhooks → Add endpoint**
   - URL: `https://construxvg.com/v1/webhooks/stripe`
   - Events: `checkout.session.completed` and
     `checkout.session.async_payment_succeeded`
4. Open the endpoint you just created and copy its **Signing secret**
   (`whsec_…`).

> Take the signing secret from **that endpoint's own page**, not from anywhere
> else in the dashboard. Each endpoint has its own. Using the wrong one is the
> failure this platform is built to make visible rather than silent: checkout
> works, customers pay, every delivery fails verification, and nothing is
> credited. Part 5 shows you where to see it.

### KODA — mobile money

1. Sign in to KODA → **Developers → Create API key**
2. Copy the **secret key** (`sk_live_…`). Use the secret key, not a publishable
   `pk_` one — this platform creates intents from the server, so a
   browser-safe key would be both unnecessary and weaker.
3. Add a webhook endpoint pointing at
   `https://construxvg.com/v1/webhooks/koda` and copy its webhook secret.

### AI providers

Any provider with a key joins the failover chain, whether or not it is a
primary. One key is enough to start; three means a vendor outage does not stop
the platform.

| Provider | Where | Key looks like |
|---|---|---|
| OpenAI | <https://platform.openai.com> → API keys | `sk-…` |
| Google Gemini | <https://aistudio.google.com/apikey> | `AIza…` |
| Anthropic | <https://console.anthropic.com> → API keys | `sk-ant-…` |

Dashboard wording changes from time to time; the section is always called API
keys or Developers.

---

## Part 2 — Put them on the server

### 2.1 Back up first

```bash
mkdir -p /srv/construx/backups
cp /srv/construx/app/.env /srv/construx/backups/env-$(date +%F-%H%M)
docker exec construx sh -c 'cat /data/ledger.jsonl' > /srv/construx/backups/ledger-$(date +%F-%H%M).jsonl
```

`.env` holds secrets that cannot be regenerated without consequence. The JWT
secret signs live sessions. The Ed25519 signing key is the key **every
signature the platform has ever witnessed** was made with — replace it and they
all stop verifying, silently, with nothing raised anywhere. Never rewrite this
file wholesale; append to it.

### 2.2 Add the empty keys

Only if `env-check` said `append it` for them. If it said *edit the existing
blank line*, skip this and go straight to 2.3 — appending a duplicate does
nothing, because the parser keeps the **first** occurrence of a key and ignores
every later one.

```bash
cat >> /srv/construx/app/.env <<'EOF'

# --- Payments ---
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
KODA_SECRET_KEY=
KODA_WEBHOOK_SECRET=
KODA_USD_PER_GBP=1.27

# --- AI providers ---
OPENAI_API_KEY=
GEMINI_API_KEY=
ANTHROPIC_API_KEY=
EOF
```

### 2.3 Fill in the values

```bash
nano /srv/construx/app/.env
```

`Alt+/` jumps to the end. Type each value after its `=`. Save `Ctrl+O`, `Enter`,
exit `Ctrl+X`.

Leave anything you do not have yet blank — that rail simply stays off. What you
must not do is set a payment **secret key without its webhook secret**: that is
the state where money can be taken and never credited, and the boot log warns
about it by name.

### 2.4 Apply

```bash
/srv/construx/app/deploy/env-check.sh
cd /srv/construx/app && docker compose -f deploy/compose.yaml -f deploy/compose.edge.yaml --env-file .env up -d
sleep 15 && docker logs --tail=25 construx | grep -E 'config warning|AI mode|Ledger'
```

A restart is required: configuration is read once at boot, so nothing you
change takes effect until the container restarts.

---

## Part 3 — Turn AI on

Do this only once at least one provider key is filled in. Otherwise every AI
request fails.

```bash
sed -i 's/^AI_MODE=local/AI_MODE=production/' /srv/construx/app/.env
grep '^AI_MODE' /srv/construx/app/.env
cd /srv/construx/app && docker compose -f deploy/compose.yaml -f deploy/compose.edge.yaml --env-file .env up -d
```

The boot log should now read `AI mode  production` and the warning
`AI_MODE is "local" in a production environment` should be gone.

Optionally choose which vendor serves which capability. Two brains, not two
vendors: `REASONING` is the analytical engines, `PERCEPTION` reads drawings,
photographs and audio.

```
AI_REASONING_PROVIDER=OPENAI      # OPENAI | GEMINI | ANTHROPIC
AI_PERCEPTION_PROVIDER=GEMINI
```

An unrecognised name falls back to the default and warns at boot rather than
resolving to whichever vendor a conditional happened to reach.

---

## Part 4 — What each state looks like

| Boot log line | Meaning |
|---|---|
| `AI mode  local` | Mock engines. No provider called, no spend, no real output |
| `AI_MODE is "local" in a production environment` | You have not done Part 3 |
| `STRIPE_SECRET_KEY is set but STRIPE_WEBHOOK_SECRET is not` | **Fix now** — payments could be taken and never credited. The rail stays off until both are set |
| `STRIPE_SECRET_KEY is a test key on a production deployment` | No real payment can be taken |
| `KODA_USD_PER_GBP is 0` | Mobile-money payments will be refused at settlement |
| `LEDGER_JOURNAL_PATH is unset` | **Stop** — the ledger is in memory and every record is lost on restart |
| `GATEWAY_RATE_LIMIT_REDIS_URL is unset` | Fine for one container. With two, each enforces its own bucket, so the login limit doubles |

---

## Part 5 — Prove it works

Configuration being present does not mean it is correct. Only a real payment
establishes that.

### 5.1 The operator view

Sign in as the platform operator and fetch:

```
GET /v1/admin/payments
```

It reports both rails:

```json
{
  "cardPayments":  { "configured": true, "webhook": { "accepted": 0, "rejected": 0 } },
  "mobileMoney":   { "configured": true, "webhook": { "accepted": 0, "rejected": 0 }, "usdPerGbp": 1.27 }
}
```

`configured: true` means both of that rail's secrets are present. It does not
mean they are the right ones.

### 5.2 Make one real payment

Buy the smallest top-up the console offers, with a real card, and watch
`/v1/admin/payments`.

- **`accepted` goes to 1** — the whole path works. Money in, wallet credited.
- **`rejected` climbing while `accepted` stays 0** — the webhook secret is
  wrong. This is the failure worth rehearsing for: checkout works, the customer
  pays, every notification fails verification, and nothing is credited. Go back
  to Part 1 and take the signing secret from the endpoint's own page.
- **Neither moves** — the notification is not arriving at all. Check the
  endpoint URL in the provider's dashboard and its own delivery log.

A redelivered notification is safe by design: the payment reference is spent
exactly once, so the second one credits nothing and answers success rather than
an error.

### 5.3 One real signup

The signup journey has never run end to end on a deployment with no users. Test
it: register an address you control, confirm the verification email arrives, and
complete it. Watch the boot line `0 users across 0 tenancies` become `1 user`.

---

## Part 6 — Keeping it deployed

Autodeploy polls the tracked branch every minute, backs up the journal, rebuilds,
waits for `/readyz`, and rolls back if that fails.

```bash
systemctl status construx-deploy.timer      # is it armed
journalctl -u construx-deploy.service -n 40 --no-pager   # what it did last
```

If it is not installed:

```bash
cp /srv/construx/app/deploy/construx-deploy.service /srv/construx/app/deploy/construx-deploy.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now construx-deploy.timer
```

### Rolling back

Forward is safe: new code reads old events. **Backward is not.** Once the new
code has written an event type an older build does not know, that older build
refuses to start rather than silently misreading the record. That is deliberate.
The journal backups in `/srv/construx/backups/` are the way out, and it is a
task for a console and a clear head, not something to automate.

---

## Reference

| Thing | Value |
|---|---|
| App directory | `/srv/construx/app` |
| Configuration | `/srv/construx/app/.env` |
| Backups | `/srv/construx/backups/` |
| Container | `construx`, host port `127.0.0.1:8090` → `8080` |
| Health | `https://construxvg.com/readyz` |
| Stripe webhook | `https://construxvg.com/v1/webhooks/stripe` |
| KODA webhook | `https://construxvg.com/v1/webhooks/koda` |

```bash
docker logs --tail=40 construx                  # boot log and requests
docker compose -f /srv/construx/app/deploy/compose.yaml \
  -f /srv/construx/app/deploy/compose.edge.yaml \
  --env-file /srv/construx/app/.env ps          # is it healthy
```

Related: `docs/ACCEPTANCE.md` for what to test once this is done,
`docs/RUNBOOK.md` for operating the ledger, `docs/STATE.md` for what is built
and what is deliberately not.
