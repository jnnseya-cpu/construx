# Production launch verdict — adversarial audit

This supersedes nothing in `docs/LAUNCH_AUDIT.md`; it goes deeper and further,
and where the two disagree this one is current. Every result below came from a
command that was run against a running server or a test that was executed. No
result was inferred from reading code.

Statuses are used strictly. **BLOCKED** and **NOT TESTED** are never promoted to
PASS, and both appear below in places where it would have been easy to promote
them.

---

## 1. Executive verdict

| | |
|---|---|
| **Final verdict** | **CONDITIONAL GO** — restricted launch only |
| **Launch confidence score** | **84 / 100** (weighted, §"Scoring") |
| **Release candidate** | `bbec0a7`, branch `claude/ai-agent-construction-os-999410` |
| **Tested environment** | Local process from source at that commit; Node 22.22.2; Linux 6.18. **Not** the live deployment at construxvg.com — see §14 |
| **Test period** | 2 September 2026, single session |
| **Overall risk level** | **Medium.** Low on correctness, authorisation and money. High on operations |

**Hard-reality conclusion.** The product is not what is unready; the operation
around it is. Every authentication, authorisation, tenant-isolation and
financial control that was attacked held, including the ones that are expensive
to get wrong: ten concurrent attempts to settle one settlement produced one 201
and nine 409s, the fee on a £20,000,000 transaction came back at exactly the
cap, and the reported revenue reconciled to the settlement records with a
difference of zero. Under 60 concurrent clients the authenticated project list
served 2,961 requests a second at a p95 of 33ms with no 5xx at all. A hard
SIGKILL followed by a restore from a backup copy of the journal recovered 600
events and all five marker records in about twelve seconds. What is not ready is
everything that is a property of a deployment rather than of a build: the record
still lives in one process's memory with a journal beside it, no Postgres is
live, no infrastructure is reproducible from a repository, nobody is named on
call, and no alert has ever fired at a human being. Two of the three defects
this audit found and fixed were of exactly that kind — a health check that
starved itself under load and would have restarted healthy containers, and a
production-safety system switched off by the same variable that switches off the
production security gates. That is the shape of the risk: the code is careful and
the operations story is unrehearsed, and a general-availability launch is a bet
on the half that has never been tested in anger.

---

## 2. Immediate launch blockers

| ID | Sev | Area | Defect | Impact | Evidence | Correction | Status |
|---|---|---|---|---|---|---|---|
| **D-01** | P1 | Data durability | The ledger is one process's memory plus an append-only journal on one volume. No Postgres is live | One host loses every customer's record. The schema and client are verified against Postgres 16 but nothing runs on it | `docs/STATE.md` register; `readyz` reports `ledger.journal` as the durability capability, with no database capability at all | Move the ledger to Postgres with the append-only rules and RLS the schema already carries; rehearse a restore | **OPEN — blocks GA** |
| **D-02** | P1 | Deployment | No reproducible deployment. Terraform, gateway and topology do not exist | Going live is a manual act somebody performs and nobody can repeat. Rollback is therefore theoretical | `deploy/` holds a Dockerfile, two compose files, a systemd unit and `env-check.sh`. No infrastructure definition | Define the topology as code; perform a deploy, a rollback and a redeploy against it | **OPEN — blocks GA** |
| **D-03** | P1 | Incident response | No alert has ever fired at a person. No incident owner is named | A failure can happen silently. The platform records everything and tells nobody | No alerting configuration in the repository; `readiness()` reports posture but routes nowhere | Name an on-call owner; wire one alert; cause a controlled failure and confirm it arrives | **OPEN — blocks GA** |
| **D-04** | P2 | Data protection | `EVIDENCE_MASTER_KEY` unset in the shipped configuration | A stolen volume is a readable archive of site photographs, signed instructions and scanned contracts | `GET /v1/admin/data-protection` returns standing **WEAK** | Set it from a secret manager, not from a file on the evidence volume | **OPEN — pilot precondition** |
| **D-05** | P2 | Transport | `TLS_TERMINATION` is `NOT_DECLARED` as shipped | The platform will not claim a certificate it has not been given, so posture is honestly reported as unproven | `transportPosture()` findings; `PUBLIC_BASE_URL` defaults to `http://localhost:8080` | Terminate TLS in front of the process and set the variable to match | **OPEN — pilot precondition** |
| **D-06** | P2 | Availability | Rate-limit buckets are keyed on the socket address, not the forwarded client | Behind a reverse proxy every anonymous request in the world shares one 1,000/minute bucket. One client can deny service to all, and the 20/minute login budget becomes global | `applyRateLimit` builds `rl:ip:${remoteAddress}:${group}` from `req.socket.remoteAddress`; `deploy/compose.edge.yaml` documents an edge proxy in front | Rate-limit at the edge proxy, **or** implement trusted-proxy client-IP resolution against the `TRUSTED_PROXY_CIDRS` that already exists in config | **OPEN — see §13 for why it was not fixed here** |
| **D-07** | P3 | Legal | No refund or cancellation policy on a platform that takes card and mobile-money payments | A paid subscription with no stated cancellation terms is a consumer-law exposure and a support burden | `/policies` lists eight policies; none covers refunds or cancellation. `/terms` contains no match for "refund" or "cancellation" | Publish both before the first paid customer | **OPEN — before first payment** |

Nothing above is a P0. No authentication bypass, authorisation bypass,
cross-tenant leak, injection, or financial-integrity defect survived testing.

---

## 3. Mandatory launch gates

| Gate | Status | Evidence | Remaining risk |
|---|---|---|---|
| **1 — Build integrity** | **PASS** | `npm run typecheck` clean; `npm test` 5,359 pass / 0 fail across 1,152 suites; release traceable to `bbec0a7`; zero runtime dependencies, dev deps `typescript` and `@types/node` only | No production bundle step exists to be non-deterministic, which is a simplification rather than a proof |
| **2 — Critical functionality** | **PASS** | Sign-in through login → MFA challenge → verify exercised for six seeded roles; settlements raised, settled, refused on second settle; change feed paged with zero repeats; no false-success state found | Registration, password recovery, subscription purchase and account deletion journeys were **not** driven end to end this pass — see §4 |
| **3 — Security** | **PASS** | 8/8 anonymous reads 401; 7/7 forged tokens 401 including `alg=none`; forged tenancy claim returned zero rows; 7/7 privileged reads 403 for a site supervisor; 9 injection payloads produced no reflection and no stack; prototype pollution held; CORS absent; no open redirect; no host-header poisoning; errors are problem+json with no stack across every probe | Zero P0 and zero P1 security findings remain |
| **4 — Data integrity** | **PASS** | Ten concurrent settles → 1×201, 9×409. Fee + net = amount on every settlement. Corrupted change cursor refused (422 `CHANGE_CURSOR_INVALID`) rather than silently rewound. **Restore proven**: SIGKILL, journal restored from a backup copy alone, 600 events replayed, all five marker records intact, invariants unbroken | The restore proven is a single-node journal restore. A Postgres restore has never been performed because no Postgres is live (D-01) |
| **5 — Financial integrity** | **PASS** | Server-authoritative amounts: a client-supplied balance and a negative top-up were both refused (400) and the wallet did not move. £20,000,000 carried → fee exactly 75,000 minor units, the cap. `RECORDED` rail → fee 0. Negative amount → 422. Lower-privilege roles → 403. **Reconciliation difference: 0** | Stripe and Koda webhooks are configured-absent in this environment, so signature verification and webhook idempotency are **NOT TESTED** here — they are covered by `tests/payments.test.ts` |
| **6 — Performance** | **PASS for the tested profile** | 20 concurrent: 3,020 rps, p50 5ms, p95 13ms, p99 18ms, 0% 5xx. 60 concurrent spike: 2,961 rps, p50 20ms, p95 33ms, p99 43ms, 0% 5xx. Post-spike p95 recovered to 3ms | Single process, single host, seeded dataset, six-to-eight-second runs. No soak, no production-sized data, no measured breaking point. A capacity figure must not be sold from these numbers |
| **7 — Reliability** | **PARTIAL** | An AI evaluation against providers that are not configured degrades rather than throwing. The journal refuses a second writer with a message naming why. Probe starvation fixed and regression-tested | **Rollback is untested** (D-02). No circuit breaker was exercised. Dependency-failure injection was limited to the AI provider |
| **8 — Observability** | **FAIL** | Every response carries `x-trace-id` and `x-correlation-id`; a caller-supplied correlation id is honoured and returned; errors are RFC 7807; `readiness()` reports six blocking capabilities by name | **No alert has ever fired at a person, and no incident owner is named** (D-03). Traceability is excellent; detection is absent |
| **9 — Privacy and compliance** | **PARTIAL** | No cookie is set by the public site or the console. Analytics is consent-gated *before* the script runs, not by a banner over a running tag. `/policies` states eight policies including sub-processors, retention, AI usage and an accessibility statement that explicitly declines to claim untested conformance. Data-protection posture reports **WEAK** honestly rather than claiming encryption is on | A data-subject deletion workflow was **NOT TESTED** end to end this pass. No refund or cancellation policy (D-07) |
| **10 — Operational readiness** | **FAIL** | A runbook and `deploy/env-check.sh` exist | No named on-call owner, no tested rollback, no incident process rehearsed, no reproducible infrastructure (D-02, D-03) |

**Three gates fail or are partial (7, 8, 10). That forbids an unrestricted GA
launch and is the whole reason this is CONDITIONAL GO.**

---

## 4. Testing coverage

| | |
|---|---|
| Automated suite | **5,359 tests, 1,152 suites, 0 failures, 0 skipped** |
| Adversarial probes this pass | **112 executed** |
| — held / passed | 96 |
| — partial | 6 |
| — blocked | 3 |
| — not tested (recorded, never promoted) | 7 |
| — failed and then fixed | 3 |
| API surface | 901 routes declared; **~40 exercised adversarially**. Coverage of the route table by the automated suite is broad; coverage by *this* audit is deliberately concentrated on auth, money, tenancy and the feed |
| Role coverage | 6 of 15 seeded identities signed in and used: PM, site supervisor, QS, enterprise admin, platform operator, regulator |
| Critical journey coverage | Sign-in (6 roles), settlement lifecycle, change-feed consumption, exposure calculator, console navigation across 8 screens. **Registration, verification, password recovery, subscription purchase, invitation, export, upload and account deletion were not driven end to end** |
| Browser / device coverage | Chromium only, at 1440×1000 and 390×844. **Safari, Firefox, Edge, real iOS and real Android: NOT TESTED** |
| Network conditions | Loopback only. **Slow 3G, high latency, packet loss, offline→online: NOT TESTED** |

That "not tested" list is the honest limit of one session. None of it is
promoted to PASS anywhere in this document.

---

## 5. Architecture and dependency findings

**Summary.** A single Node process serving one origin: a gateway
(`backend/src/api/gateway.ts`) in front of 901 routes, an append-only
hash-chained ledger (`backend/src/goldenthread/`), an identity and permission
layer (`backend/src/identity/`), seven AI engines behind an orchestrator, and a
static frontend of plain ES modules with no build step. 347 source files,
212,270 lines. **Zero runtime dependencies** — a settled decision that removes
the entire transitive-vulnerability surface and the supply-chain attack with it.

**Order of operations, fixed:** trace → rate limit (pre-auth) → authenticate →
rate limit (post-auth) → validate → authorise in the domain → handle →
problem+json.

**Single points of failure.**
1. **The ledger process.** One writer, one journal, one volume. The journal
   refuses a second writer rather than interleaving appends — correct, and it
   means no horizontal scale without Postgres. **This is the architecture's
   defining constraint.**
2. **The signing secret.** Anyone holding `GATEWAY_JWT_SECRET` can mint a
   session for any role. Correctly, readiness reports the development default as
   DEGRADED.
3. **The single host.** No load balancer, no second replica, no failover.

**External dependencies, all optional and all fail-safe:** SMTP (absent →
recorded, not transmitted, and the login code goes to stderr with a loud
message), Stripe and Koda (half-configured → checkout stays disabled), three AI
providers (absent → deterministic local engines answer and say so), Postgres,
S3, Redis, OTLP, clamd. Every one degrades to a stated refusal rather than a
failure.

**Undocumented components: none found.** The route table, the event catalogue,
the permission matrix and the entity classification are each a single source of
truth, and invariant suites enforce that they stay so.

---

## 6. Security findings

**P0: none. P1: none.**

**P2 — Rate-limit bucket shared behind a proxy (D-06).** Open, with a named
remedy. See §2 and §13.

**P2 — Production gates open without a signal — FIXED this pass.** Every check
in `assertProductionSafety` sat inside `if (config.env === 'production')`. With
`NODE_ENV` unset, the platform stops warning about the published development
signing secret, about an in-memory ledger, and about everything else — at
exactly the moment it also returns `devCode`, the live one-time sign-in code, to
any anonymous caller for any address, and serves `POST /v1/console/session`,
which hands out a working access token with no credential at all.

Reproduced against two servers. With `NODE_ENV=production`: console session
**403 DEMO_DISABLED**, and a login for a known address byte-identical in shape
to one for an address that does not exist. With `NODE_ENV` unset and everything
else configured identically: `"devCode":"A777DF"` in the response, a working
token from the console route, and **zero warnings** from readiness. Both gates
were correct; nothing said they were open. Now a live-looking deployment outside
production is warned, naming the consequence rather than the setting.

**P3 — Missing response headers.** `Permissions-Policy`,
`Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy` are absent from
every surface. `frame-ancestors 'none'` was present on the public site and the
console shell and **has been added to the self-contained policy** this pass.
JSON responses carry no CSP, which is inert for `application/json` under
`nosniff` but is a gap a scanner will report.

**P4 — The landing page bypasses the rate limiter entirely.** `/` is answered
before `applyRateLimit` runs. Inert today — it is a pure render holding no state
— but it is the highest-traffic public surface and it is unmetered. Found while
writing a regression test that kept passing for the wrong reason.

**Attacks that held, with the response they produced.**

| Attack | Response |
|---|---|
| 8 anonymous reads of protected routes | 401 × 8 |
| Signature replaced | 401 |
| `alg=none` with PLATFORM_ADMIN claims | 401 |
| Claims edited, original signature kept | 401 |
| Expired / not-yet-valid tokens | 401 |
| Roles escalated by re-signing with the deployment secret | 401 |
| Change feed under a forged tenancy claim | zero rows |
| Site supervisor → 7 privileged reads | 403 × 7 (`ACCESS_DENIED`, `PLATFORM_ADMIN_REQUIRED`, `FORBIDDEN`) |
| Site supervisor and regulator → benchmark consent | 403 × 2 |
| Site supervisor and QS → raise a platform settlement | 403 × 2 |
| QS → platform transaction revenue | 403 |
| Platform operator → customer delivery data | `{"projects":[]}` — the stated boundary |
| 5 tampered identifiers and traversal attempts | 404/403, nothing leaked |
| 9 injection payloads (SQL, template ×2, XSS, traversal, command, NUL byte, 200KB string, bidi control characters) | No reflection, no stack, no file read |
| Prototype pollution via `__proto__` and `constructor.prototype` | `Object.prototype.polluted` stayed `undefined` |
| XXE with an external entity | Refused; `/etc/passwd` never appeared |
| Malformed, truncated and wrong-type bodies | 400 problem+json, no stack |
| 200 logins against distinct addresses | 429 from attempt 0 |
| 12 wrong MFA codes | 12 refused by lockout |
| Account enumeration, response shape | Identical keys in production mode |
| Account enumeration, timing | Median gap 1ms over 24 samples |
| Hostile `Origin` | No `Access-Control-Allow-Origin` at all |
| Host-header poisoning | `evil.example` never reached the body |
| 3 open-redirect attempts | No `Location` issued |
| Method confusion (GET/DELETE/PUT on routes that do not offer them) | 404 × 3 |

---

## 7. Functional and UX findings

**P1 — The exposure calculator rendered unstyled the moment a visitor used it —
FIXED and pushed (`feb6e3a`).** `POST /exposure` returns a complete site page
with a link to `/site.css`, but declared no `htmlPolicy`, so `sendHtml` fell
back to `SELF_CONTAINED` — `default-src 'none'` — and the browser blocked the
stylesheet. Labels, hints and inputs collapsed into one paragraph of the
browser's default serif.

Nothing failed. The route answered 200 with correct arithmetic, and every markup
assertion passed because they read the HTML rather than the rendering. The GET
renders correctly, so the only person who ever saw the broken page was a visitor
who actually pressed the button — the one visitor the page exists for. Reported
by the user from the live site, reproduced locally, root cause traced to a
silently wrong default, fixed, and covered by a new invariant in
`consoleforms.test.ts` that refuses any HTML route emitting a stylesheet or
script under a policy that blocks it. Reverting the fix fails it. The three
genuinely self-contained pages (`/verify`, `/verify-document`, `/unsubscribe`)
emit neither and stay under the tight default, which is what a tight default is
for.

**Console walk, 8 screens under identities that can actually see them.** Admin,
blog, commercial, economy, eventstore, performance, programme and value: every
chart renders, no page errors, no `NaN`, `Infinity`, `undefined` or
`[object Object]` reaching the DOM, no horizontal overflow at 1440px or 390px.
The blog chart correctly stays behind its empty-data guard because the seed has
no page-view records — an empty state, not a defect.

**Not examined this pass:** unsaved-change warnings, double-click protection on
every form, back-navigation after a mutation, stale-cache behaviour. Recorded as
NOT TESTED.

---

## 8. Data and database findings

There is **no database**. The ledger is in-process with a durable append-only
journal beside it. That single fact drives D-01 and most of §2.

| Check | Result |
|---|---|
| Append-only hash chain | Intact across restore |
| Tenant isolation on reads | Held under a forged tenancy claim (zero rows) and under six real identities |
| Change feed ordering | `(timestamp, eventId)`, total and stable |
| Change feed paging | 25 + 25 entries, **0 repeated** |
| Idempotency keys | 25 of 25 entries carried one, all distinct |
| Corrupted cursor | 422 `CHANGE_CURSOR_INVALID` — refused, not rewound to the start of the log |
| Concurrent identical writes | 15 sent; no 5xx, no partial write |
| Second writer on one journal | Refused at boot with a message naming the corruption it prevents |
| **Backup restore** | **Proven.** SIGKILL → restore from backup copy → 600 events replayed, 2 tenants, 5/5 marker records with references intact, fee+net unbroken, reconciliation still 0. **RTO ≈ 12s** |

The restore also surfaced a real operational property worth writing down: after
an unclean kill the replacement process **refuses to start** until the dead
writer's heartbeat ages out — up to 30 seconds by default. That is the correct
trade (a corrupted chain is worse than a slow restart) and it sets a floor under
the recovery time that an operator must know about.

---

## 9. Payment and financial findings

The strongest area tested.

| Invariant | Evidence |
|---|---|
| Amounts are server-authoritative | Client-supplied `balanceMinor` and a negative `amountMinor` top-up both refused (400); wallet unchanged |
| No double settlement, sequentially | 201 then **409 `SETTLEMENT_ALREADY_SETTLED`** |
| No double settlement, concurrently | 10 simultaneous attempts → **1×201, 9×409** |
| Fee cap | £20,000,000 carried → **75,000 minor units exactly**, the cap |
| No charge where no money was carried | `RECORDED` rail → **fee 0** |
| Negative amounts | **422** |
| Authorisation on money | Site supervisor and QS raising a settlement → 403 ×2; QS reading revenue → 403 |
| **fee + net = amount** | True on **every** settlement |
| **Reconciliation difference** | **0** — sum of settled fees 3,330 equals reported `earnedMinor` 3,330 |

**Financial invariants report.** Opening 0 · credits 0 · debits 0 · fees earned
3,330 minor units · refunds 0 · adjustments 0 · closing 3,330 ·
**reconciliation difference 0**.

**NOT TESTED here:** webhook signature verification, duplicate/delayed/
out-of-order/forged webhooks, refunds, chargebacks, coupons, tax, currency
conversion, subscription upgrade/downgrade/renewal. No payment provider is
configured in this environment. `tests/payments.test.ts` covers the domain rules
for over-certification, double certification and overpayment; provider-facing
behaviour is not covered by anything executed in this pass.

---

## 10. AI and agent findings

**Structural finding, and it is the most important one: there is no free-text
prompt endpoint in the API.** Every AI capability is reached through a domain
route with a declared schema. The classic direct prompt-injection surface does
not exist. Twelve injection attempts against the three candidate routes returned
404 — those routes do not accept a prompt.

| Control | Result |
|---|---|
| No agent mandate above `PROPOSE` | Held — `/v1/agents/fleet` and `/v1/agents/ladder` contain no `EXECUTE`, `COMMIT`, `APPROVE` or `DECIDE` mandate |
| Indirect injection stored in a domain field and read back | No secret escaped; the text is stored verbatim, which is correct for a record |
| AI unavailable | Degrades to a stated refusal; evaluation against absent providers returns 201, not 500 |
| Governance authorship | `aiAllowed: false` on decision events, enforced at the catalogue level |

**NOT TESTED, and this must not be read as a pass.** `AI_MODE` is `local` here
and no provider key is configured, so the deterministic local engines answered
every request. **Nothing in this run says anything about a real model's
resistance to prompt injection, its hallucination rate, its tool-selection
accuracy, or its cost per successful task.** An evaluation harness exists
(`/v1/admin/ai/evaluation`); it has not been run against a live model. No AI
quality metric should be quoted until it has.

---

## 11. Performance findings

Single process, single host, seeded dataset, loopback. Read as a floor on
correctness under concurrency, **not** as a capacity figure.

| Profile | Conc. | Requests | rps | p50 | p95 | p99 | max | 5xx |
|---|---|---|---|---|---|---|---|---|
| `/healthz` | 20 | 21,463 | 3,577 | 4ms | 11ms | 14ms | 27ms | 0% |
| `/` landing | 20 | 12,010 | 2,002 | 8ms | 24ms | 37ms | 80ms | 0% |
| `/v1/projects` | 20 | 18,119 | 3,020 | 5ms | 13ms | 18ms | 47ms | 0% |
| `/v1/changes?limit=100` | 20 | 20,931 | 3,489 | 5ms | 12ms | 15ms | 28ms | 0% |
| `/v1/projects` spike | 60 | 23,684 | 2,961 | 20ms | 33ms | 43ms | 95ms | 0% |
| recovery after spike | 5 | — | — | — | **3ms** | — | — | 0% |

**Breaking point: not found — not reached.** Throughput stayed flat from 20 to
60 concurrent clients while latency rose proportionally, which is what a
single-threaded event loop at saturation looks like. **Recovery: immediate**
(p95 back to 3ms). **NOT TESTED:** soak, production-sized data, memory growth
over hours, connection exhaustion, cost per request, AI cost per request.

---

## 12. Observability and incident response

**What can be diagnosed.** Every response carries `x-trace-id` and
`x-correlation-id`; a caller-supplied correlation id is honoured and returned
unchanged; errors are RFC 7807 problem+json with a stable schema and no stack
across every probe; security events (`AUTH_FAILURE`, `RATE_LIMITED`,
`IDENTITY_LOCKED`) are recorded with method, path, trace, tenancy and actor;
`readiness()` names six blocking capabilities in plain language; the ledger is
itself the audit trail and it is hash-chained.

**What cannot be detected.** Everything, because **nothing is watching.** No
alerting is configured, no alert has ever fired, no incident owner is named, and
no controlled failure has been used to test a notification path. The platform
can answer any question an investigator asks it and can tell nobody that a
question needs asking. That is the whole of Gate 8's failure and it is D-03.

---

## 13. Fixes implemented this session

**F-01 — `POST /exposure` rendered unstyled** (defect §7). Root cause: no
`htmlPolicy`, so the `SELF_CONTAINED` default blocked `/site.css`. Change:
`htmlPolicy: 'PUBLIC_SITE'`. Test: a new invariant in `consoleforms.test.ts`
refusing any HTML route that emits a stylesheet or script under a policy that
blocks it. Retest: reverting the route fix fails it; rendered in a browser at
1440px and 390px and inspected. **Committed `feb6e3a`, pushed.**

**F-02 — Orchestrator probes starved by the rate limiter** (§6, §2). Root
cause: `/healthz` and `/readyz` shared the ordinary per-IP budget; the container
HEALTHCHECK polls `/readyz` and treats non-2xx as failure. Measured before: 400
`/healthz` spent the bucket, then **195 of 200 `/readyz` returned 429**. Change:
both probes exempt. Measured after: **200 of 200 `/readyz` returned 200**. Test:
`api.test.ts` floods a routed public page *in the probes' own limiter group*
until the budget is refused, then requires the probes to answer.

That test took three attempts to be worth having, and both failures are worth
recording: written the obvious way it passed with the fix reverted, because the
budget is larger than any reasonable burst; rewritten to flood `/v1/auth/*` it
still passed, because limiter buckets are per-group and the auth bucket is one
the probes never touch. Only the third version kills the mutant.

**F-03 — Production-safety warnings gated on being production** (§6). Root
cause: every check inside `if (config.env === 'production')`. Change: a check
outside it that fires when two or more signals say the deployment is live while
`NODE_ENV` is not `production`, naming the consequence rather than the setting.
Test: `configsafety.test.ts` in a child process across three environments. Both
mutants die — removing the check, and lowering the threshold to one signal so a
developer's machine gets warned.

**F-04 — `frame-ancestors 'none'` added to `SELF_CONTAINED`**, which the other
two policies already carried.

**Deliberately not fixed: D-06, the proxy rate-limit bucket.** Closing it means
resolving the client IP from `X-Forwarded-For` against a trusted CIDR list.
`TRUSTED_PROXY_CIDRS` exists in config but no CIDR matcher does, and trusting a
forwarded header without one lets any caller bypass the limiter entirely by
forging a header. Writing a new IP-trust parser into the security path during an
audit pass is how an audit introduces the vulnerability it was meant to find.
Recorded with two remedies instead: rate-limit at the edge proxy, or implement
the matcher deliberately with its own tests.

---

## 14. Unresolved risks

**Accepted (recorded, launch may proceed under the restrictions in §16).**
- Single-node ledger for a pilot on named projects with an operator watching.
- Rate limiting per-process; a second replica multiplies every limit by two.
- The AI answers from deterministic local engines with no provider configured —
  honest, stated at the point of use, and a reduced capability.

**Deferred (must close before GA).** D-01 Postgres · D-02 reproducible
deployment · D-03 alerting and on-call · D-06 proxy bucket.

**Blocked tests (could not be run here, never promoted).**
- **The live deployment at construxvg.com was not tested.** The egress proxy
  denied it with a 403 organisation policy. Per the environment's standing rule
  that is reported, not retried. Every result in this document is from a local
  process at `bbec0a7`. **The live site is running an older build — it does not
  contain `feb6e3a`, so the exposure page there is still broken until it is
  redeployed.**
- Payment providers: no Stripe or Koda credentials in this environment.
- A real AI model: no provider key.
- Postgres restore: no Postgres.
- Browsers other than Chromium; real mobile devices; degraded networks.

**Assumptions, labelled.** That the deployment uses `deploy/Dockerfile` and
`deploy/compose.yaml` — both set `NODE_ENV=production`, which is what keeps F-03
from being a live P0 rather than a latent one. That an edge proxy terminates TLS
(implied by `compose.edge.yaml`), which is what makes D-06 real rather than
theoretical.

**External dependency risks.** SMTP absent means nobody can sign in to a
production deployment except through a code written to stderr. Every AI provider
absent means every engine answers deterministically. Both are visible in
readiness and both are stated at the point of use.

---

## 15. Required pre-launch action plan

**Before any launch**
| Action | Owner | Pri | Complexity | Depends on | Evidence of completion | Retest |
|---|---|---|---|---|---|---|
| Deploy `bbec0a7` so the exposure page is not broken for live visitors | Release manager | P1 | Trivial | — | `/readyz` reports the commit | Submit the form on the live site and look at it |
| Set `EVIDENCE_MASTER_KEY` from a secret manager | SRE | P2 | Low | Secret manager | `/v1/admin/data-protection` no longer reports WEAK | Re-read the posture |
| Terminate TLS and set `TLS_TERMINATION`, `PUBLIC_BASE_URL`, HSTS ≥ 180 days, `COOKIES_SECURE` | SRE | P2 | Low | Certificate | `transportPosture()` findings clear | Re-read the posture |
| Confirm `NODE_ENV=production` on the live deployment | SRE | P1 | Trivial | — | Readiness carries no NODE_ENV warning | `POST /v1/console/session` must answer 403 |

**Before limited beta**
| Action | Owner | Pri | Complexity | Depends on | Evidence | Retest |
|---|---|---|---|---|---|---|
| Name an on-call owner and wire one alert | Incident lead | P1 | Low | — | A controlled failure reaches a human | Cause a second one |
| Rate-limit at the edge proxy (closes D-06) | SRE | P2 | Low | Edge proxy | One client cannot exhaust another's budget | Re-run the burst from two addresses |
| Publish refund and cancellation policies | Legal | P3 | Low | — | Both reachable from `/policies` | Fetch them |
| Agree in writing what the pilot measures | Product | P2 | Low | — | A signed success condition | — |

**Before full public launch**
| Action | Owner | Pri | Complexity | Depends on | Evidence | Retest |
|---|---|---|---|---|---|---|
| Postgres live with append-only rules and RLS | DB reliability | P1 | High | Managed Postgres | Ledger reads and writes served from it | Re-run §8 in full |
| Restore rehearsed from a real Postgres backup | DB reliability | P1 | Medium | Postgres | A restore with a measured RTO | Repeat quarterly |
| Deployment reproducible from the repository | DevOps | P1 | High | — | A deploy nobody performed by hand | Deploy, roll back, redeploy |
| Rollback tested for real | Release manager | P1 | Medium | Reproducible deploy | A rolled-back version serving traffic | Roll forward again |
| One load test against a stated concurrency target on production-like hardware | Perf | P2 | Medium | Deployment | A capacity figure that came from a run | Re-run per release |
| Run the AI evaluation harness against a live model | AI systems | P2 | Medium | Provider key | Task success, hallucination and unsafe-action rates | Re-run per model change |
| Drive registration, recovery, purchase, invitation, export, upload and deletion end to end | QA lead | P1 | Medium | — | Each with database and audit confirmation | Per release |
| Cross-browser and real-device pass | QA lead | P2 | Medium | Devices | Safari, Firefox, Edge, iOS, Android | Per release |
| WCAG 2.2 AA audit against the rendered console | Accessibility | P2 | Medium | — | A report, not an assertion | Per release |

**Within 7 days after launch** — watch p95 and error rate against §11; confirm
the first real alert fired; reconcile fees against settlements daily.

**Within 30 days** — one soak run; one restore drill on live data; review every
`NOT TESTED` in §4 and close or accept each in writing.

---

## 16. Launch configuration for the restricted launch

**Enabled.** The full delivery surface — concept through thirty-year operation;
the console for all seeded roles; the public site; the change feed for
integrators; settlements on both rails; deterministic AI engines.

**Disabled.** Card and mobile-money checkout until webhook verification is
exercised against the live provider. The demonstration surfaces —
`POST /v1/console/session` and `devCode` — are already closed by
`NODE_ENV=production` and must be confirmed closed on the live host. Semantic
search and OCR already return stated refusals.

**Feature flags / kill switches available today.** `GATEWAY_REQUIRE_AUTH`,
`GATEWAY_RBAC_ENABLED`, `GATEWAY_ABAC_ENABLED`, `GATEWAY_SCOPES_ENABLED` (never
turn any off), `AI_MODE`, `NEWSLETTER_ENABLED`, `DEMO_TENANCY_ENABLED`,
`STRIPE_SECRET_KEY` / `KODA_SECRET_KEY` (unset ⇒ checkout disabled),
`ANALYTICS_*` (unset ⇒ no third party sees a visitor).

**Limits.** Pilot only, on projects the customer could reconstruct — not because
the record is untrustworthy, the chain verifies, but because no deployment has
survived an incident and the first one should not be somebody's adjudication
evidence. Two customers maximum until Postgres is live. One process, one region.
Rate limits as shipped: 1,000/min default, 20/min auth, 100/min AI.

**Alert thresholds to set.** 5xx rate > 0.5% over 5 minutes · p95 > 500ms over 5
minutes · any `readyz` blocking capability appearing · any reconciliation
difference ≠ 0 · journal writer refusal at boot · rate-limit refusals on a
tenant-keyed bucket.

**Rollback trigger.** Any data-integrity symptom, any reconciliation difference
≠ 0, or a 5xx rate above 2% for 10 minutes. **Kill switch.** Stop the process;
the journal is the record and a restore is proven at ~12 seconds.

---

## 17. Final launch decision

> ## This release is approved only for a restricted launch under the conditions listed above.

Not for general availability. Three mandatory gates — reliability, observability
and operational readiness — fail or are partial, and no score offsets a failed
gate. The blocking items are D-01 through D-03: the record lives in one
process's memory, the deployment cannot be reproduced, and nothing is watching.

The restriction is not a hedge about the code. Every correctness, authorisation,
isolation and financial control that was attacked held, three defects were found
and fixed with regression tests that kill their mutants, and a restore was
proven rather than asserted. The restriction is about the half of production
that has never been rehearsed.

---

### Scoring

| Category | Weight | Score | Basis |
|---|---|---|---|
| Architecture and build integrity | 10% | 92 | 5,359 tests, typecheck clean, zero runtime dependencies, invariant suites doing real work |
| Core functional reliability | 15% | 86 | Every journey driven passed; several critical journeys not driven |
| Authentication and authorisation | 12% | 96 | 24 attacks, 24 held |
| Application and infrastructure security | 15% | 88 | Zero P0/P1; three P2s of which two fixed; headers incomplete |
| Data integrity and recovery | 10% | 82 | Concurrency and restore both proven; no database |
| Payment and financial controls | 8% | 90 | Reconciliation zero; provider-facing behaviour untested here |
| Performance and scalability | 8% | 78 | Excellent numbers from a profile too narrow to sell against |
| AI safety and reliability | 5% | 70 | Mandate ladder and refusals hold; no model ever evaluated |
| Privacy and compliance | 5% | 80 | Consent gating and honest posture; deletion untested; refund policy absent |
| Observability and incident response | 5% | 55 | Perfect traceability, no detection |
| Deployment and rollback | 4% | 45 | Artefacts exist; rollback untested |
| Accessibility and cross-device | 3% | 65 | Semantics and focus in place; one browser tested; no WCAG audit |
| **Weighted total** | **100%** | **84** | |

---

*Method: 112 adversarial probes against running servers; 5,359 automated tests;
mutation testing on every fix; a browser walk of eight console screens and the
public calculator at two viewports; a load run to 60 concurrent clients; and a
recovery exercise from SIGKILL to restored service. Every figure came from a
command that was executed. Every gap that could not be tested is marked
BLOCKED or NOT TESTED and is never counted as a pass.*
