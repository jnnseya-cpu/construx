# Acceptance

What to test on a live deployment, in the order the dependencies run. Each test
says what to do, what result proves it, and what the failure looks like — because
several of the failures here are silent, and a test that cannot tell you which
one you are looking at is not a test.

Work through part A before letting anybody else near the platform. Part B is
what to check before taking money from a stranger. Part C is the security
behaviour: none of it should be reachable, and finding that out by trying is the
only way to know.

Every test writes to an **append-only ledger**. There is no undo. Use an
obviously-named tenancy (`ACCEPTANCE TEST LTD`) so the record reads honestly
later, rather than a real customer name you would rather not have in there.

---

## A · The platform works at all

### A1 · Sign in as the operator

Go to `https://construxvg.com/app`, enter the operator address, and submit.

- **Pass** — a one-time code arrives by email; entering it opens the console
- **No code arrives** — SMTP is configured but not working. Check
  `docker logs construx | grep -i smtp`; the notification is recorded either
  way, so the platform will *look* fine while nobody can get in
- **"Could not reach the platform"** — no operator exists. See Part 0 of
  `GO-LIVE.md`

There is no password anywhere in this platform. The address is the credential,
which is why a wrong or unreadable address is an account nobody can use.

### A2 · Create a tenancy

Console → the operator's tenancy view → onboard a tenant. Legal name, jurisdiction,
currency, tier.

- **Pass** — a tenancy, a subscription and a wallet appear together. The wallet
  opens with the free trial grant plus the plan's first-period AI allowance
- **Fail** — 403 means you are not signed in as the operator. Only
  `PLATFORM_ADMIN` may onboard

Check the boot line afterwards: `0 users across 0 tenancies` should have moved.

### A3 · Create a user in that tenancy

Give them a role from the tenant-grantable list — `PM`, `QS`, `OWNER`.

- **Pass** — the user is created and holds exactly the roles you gave
- **Now try to break it**: attempt the same call with `PLATFORM_ADMIN` in the
  roles. It must be refused (400). If it succeeds, stop and report it — that is
  the escalation that lets a customer credit their own wallet with any amount

### A4 · Sign in as that user

Sign out, sign in as the user you just created.

- **Pass** — the console shows their tenancy and nothing else
- The navigation should differ from the operator's. A platform operator sees
  tenancy, billing and system health and is barred from customer delivery data;
  a tenant user sees the opposite

### A5 · Create a project and do one piece of real work

Create a project. Then raise something that writes to the record — an RFI, a
task, an observation.

- **Pass** — the entity appears, and the audit view shows the event behind it
- **Check the chain**: the audit feed should show your event with a hash. That
  is the Golden Thread doing its job; an entity with no event behind it would
  mean the projection and the record have diverged

---

## B · The money works

### B1 · A top-up moves no money

Console → Billing → top up.

- **Pass** — the balance does **not** change, and the message says so. A top-up
  is a request; credit appears when money arrives
- **Fail** — if the balance jumps, the mint is back. Stop immediately

### B2 · A real payment credits exactly once

Use the smallest amount the console offers, and a real card.

Watch the server while you do it:

```bash
docker logs -f construx 2>&1 | grep --line-buffered webhooks
```

- **Pass** — a `status: 201` line appears, and the wallet balance rises by the
  amount paid
- **`400 STRIPE_SIGNATURE_INVALID`** — the webhook secret is from a different
  endpoint. **This is the dangerous failure**: the customer has paid, and
  nothing is credited. Fix the secret and Stripe will redeliver
- **Nothing appears** — the notification never arrived. Check the endpoint URL
  and Stripe's own delivery log

Then, as operator, `GET /v1/admin/payments`:

```json
"cardPayments": { "webhook": { "accepted": 1, "rejected": 0 } }
```

**Rejections climbing while accepted stays at zero has exactly one cause** and
it is the wrong signing secret.

### B3 · An AI run costs what it should

With `AI_MODE=production`, run an engine from the console.

- **Pass** — the wallet balance falls, and the ACU ledger shows a hold followed
  by a debit
- **Check the arithmetic**: the amount charged should be roughly four times the
  provider's raw cost. The entry records both, so this is checkable rather than
  a matter of trust
- **`AI_UNAVAILABLE`** — no provider is healthy. Check the keys
- **`ACU_EXHAUSTED`** — the wallet ran out, which is the control working

### B4 · An empty wallet stops AI rather than running it free

Spend the balance down, or set a low cap, then run an engine.

- **Pass** — refused before any provider is contacted. **No provider call, no
  charge, no output**
- **Fail** — if the engine runs, real compute is being bought against credit
  that does not exist

---

## C · The gates hold

None of this should be possible. Trying it is how you know.

### C1 · One tenancy cannot see another

Create a second tenancy and a user in it. Sign in as that user and try to open
the first tenancy's project by its id.

- **Pass** — 404, not 403. A tenancy should not learn that another one's project
  exists
- **Fail** — any data from the other tenancy is a P0. Stop and report it

### C2 · A cancelled subscription cannot write

As operator, set the test tenancy's subscription to `CANCELLED`. Then sign in as
that tenancy's user and try to create something.

- **Pass** — **402**, not 403. The message should say the account owes money,
  not that permission was denied
- **Reads keep working** — deliberately. A billing failure must not hide the
  evidence somebody needs to resolve it
- **AI is refused** whatever the wallet holds. Credit buys AI; it does not buy
  the platform
- **Top-ups are refused** — taking money for unspendable credit is worse than
  the loophole it closes

Set it back to `ACTIVE` afterwards and confirm writes resume.

### C3 · The webhooks refuse everything unsigned

```bash
curl -sS -X POST https://construxvg.com/v1/webhooks/stripe -H 'content-type: application/json' -d '{}'
curl -sS -X POST https://construxvg.com/v1/webhooks/koda -H 'content-type: application/json' -d '{}'
```

- **Pass** — `STRIPE_SIGNATURE_MISSING` / `KODA_SIGNATURE_MISSING`, both 400
- **`UNCONFIGURED`** — the keys are not loaded
- **Anything crediting a wallet** — a P0. These are public URLs

### C4 · The demonstration surface is off

```bash
curl -sS -X POST https://construxvg.com/v1/console/session -H 'content-type: application/json' -d '{}'
```

- **Pass** — refused, `DEMO_DISABLED`. This route hands a working session to
  anonymous callers and must never answer in production

---

## D · The customer journey

### D1 · Public signup, end to end

From a private browser window, register at `https://construxvg.com` with an
address you control and can read.

- **Pass** — a confirmation email arrives; the link opens a page; confirming
  provisions a tenancy and you can then sign in
- **Nothing arrives** — SMTP. The registration is recorded regardless, so the
  form will report success either way
- **Try registering the same address twice** — the second attempt must return
  a **byte-identical** receipt. A public endpoint that distinguishes the two
  tells an attacker which addresses on a leaked list are customers

### D2 · The trial grant is not farmable

Register `you+test1@` and `you+test2@` at the same free-mail domain.

- **Pass** — the second tenancy is created but receives **no trial grant**. Both
  are the same mailbox, and each grant is real provider spend
- The account is still provisioned. A spend control that refuses the signup
  would be a lost sale

### D3 · The installed app updates

Install the PWA on a phone, then push a change and wait for autodeploy.

- **Pass** — the installed app picks up the new version rather than serving the
  build it was installed with for ever

---

## Recording what you find

A defect here is worth writing down with: what you did, what happened, what you
expected, and the `traceId` from the response. Every error carries one, and
every log line carries the same id — so a trace id turns "it broke" into the
exact request.

Anything in part C is a stop-the-line finding. Everything in C is a control that
something else in the platform is relying on being true.
