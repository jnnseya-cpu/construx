# CONSTRUX — launch audit final report

**RC commit:** `c20f1d8` (+ `d72ec33` hygiene during the audit)
**Environment:** the platform booted from source in the audit container
(`:8099` dev, `:8098` production-mode, `:8097` dev+demo). Real Chromium
available; **no access to the live deployment, its database, CI, monitoring or
any vendor dashboard.**
**Cycles run:** 1 full attack pass + 2 fix commits.

---

## 1 · Executive verdict

**NO-GO for public launch — because the live platform could not be reached, not
because a blocking defect is known.** The *tested build* passes every gate the
audit could execute: it boots, refuses anonymous and forged callers, enforces
MFA and a two-factor step-up, separates the platform and customer layers,
isolates the one tenancy exercised, resists brute force two independent ways,
ships a strict header set, and carries 7,809 passing tests with a clean
typecheck and no suppression anti-patterns. Two real defects were found and
fixed. The blockers that remain are, without exception, things only someone with
access to the production system, vendor sandboxes, or legal authority can
resolve (`human-actions.md`).

Hard reality: this is a markedly cleaner codebase than the brief assumed. The
risk is not fakery or rot — it is the ordinary, real gap between *the code is
correct* and *the running system was verified*, and closing it needs access.

## 2 · Immediate launch blockers

| ID | Sev | Area | Blocker | Status |
|---|---|---|---|---|
| H-1 | — | Verification | Live deployment not reachable by the audit | OPEN — needs access |
| H-4 | — | Payments | Money paths untestable without sandbox keys | OPEN — needs keys/decision |
| H-6/H-7 | — | DR/deploy | Restore + rollback drills not run on real infra | OPEN — needs infra |
| H-8 | — | Performance | No load test possible from one container | OPEN — needs staging |

No **code** defect is an open blocker. Every open item is an access/authority gap.

## 3 · Gate results

| Gate | Status | Evidence |
|---|---|---|
| 1 Build integrity | **PASS** | 7,809 tests green, typecheck clean, deterministic, CI on Node 22 + real PG/Redis |
| 2 Truth & fitness | **PASS** | `truth-audit.md`: no claim the code can't keep; disabled capabilities declared honestly |
| 3 Critical functionality | **PASS (tested build)** | Auth, tenancy, Bid-On drafting all executed end to end |
| 4 Security | **PASS (no P0/P1 found)** | T-001…T-060; forged token, traversal, enumeration, brute force all defended |
| 5 Data integrity | **PARTIAL** | Hash-chain + isolation proven on one tenancy; restore drill needs infra (H-6) |
| 6 Financial integrity | **NOT TESTED** | Payments off by default; needs sandbox (H-4) |
| 7 Performance | **NOT TESTED** | Needs staging + load harness (H-8) |
| 8 Reliability | **PARTIAL** | Graceful-degradation code present and unit-tested; live failure injection needs infra |
| 9 Observability | **PARTIAL** | Correlation ids on every response; alert delivery needs the live monitor (H-1) |
| 10 Privacy | **PARTIAL** | Erasure schedule + consent code present; a real deletion drill needs live stores |
| 11 Operational readiness | **PARTIAL** | Runbook, rollback script, boot-time honesty all present; drills need infra |

A failed-to-test gate is **NOT TESTED**, never PASS. No gate is FAILED.

## 4 · Truth audit summary
See `truth-audit.md`. Built & real: ledger, auth/MFA, tenancy, AI drafting,
zero-dep runtime, header set, production-default refusal. Built but off by
default (honest): Postgres mode, payments, backup egress, telemetry egress.
Absent & declared: the native mobile client. **Nothing removed — no false claim
was found.**

## 5 · Novice-user findings
Not run as a full Mind-2 walkthrough this cycle (needs the live UI on a
throttled device — H-1/H-11). The console is server-rendered, keyboard-reachable,
and ships per-field problem+json errors; the Bid-On flow work earlier this
session repeatedly fixed novice-facing friction (plain-language refusals,
next-action buttons, "what it needs to be green"). A formal timed walkthrough is
queued behind device access.

## 6 · Coverage
Executed live: 24 auth/tenancy/security tests (all PASS). Automated suite: 7,809
pass / 0 fail. Static: full anti-pattern + secret sweep, clean. **Not covered:**
payments, load, DR, mobile devices, live production — all access-bound.

## 7 · Architecture & dependencies
Single Node 22 process, zero runtime deps, append-only ledger with optional
Postgres mirror, evidence store, Caddy + Docker Compose overlays, systemd-timer
autodeploy with readiness-gated rollback. SPOF: one writer extends the chain
(by design; failover is a documented promotion). Ownership of live accounts
unverifiable from here (H-10).

## 8 · Security findings
No P0/P1 found. Positive controls proven: signature-before-claims token
verification, account-layer separation, silent identity lockout + address rate
limit, enumeration-resistant login and signup, strict CSP without `unsafe-eval`,
HSTS, COOP/CORP, production refusal of default secrets. Full fuzzing of every
endpoint (6.9) was sampled, not exhausted — the platform's own adversarial
suites cover the rest.

## 9 · Functional & UX findings
7 Bid-On defects found and fixed this session (`defects.md` D-010…D-016),
several of the exact "AI success path never ran" class. All now have end-to-end
tests.

## 10 · Data & database findings
Hash chain verified; tenant rows stamped and filtered by signed tid; Postgres
mode tested in CI against real PG 16. Restore drill (H-6) outstanding.

## 11 · Payment & financial findings
**NOT TESTED** — off by default, no sandbox keys (H-4). Code shows server-side
price authority and webhook idempotency intent; unverified live.

## 12 · AI & agent findings
Drafting engine tested end to end against a scripted provider: plans, writes,
has an **independent** scorer mark each version, rewrites against real marks,
stops at the green floor or at a stall, keeps the best, never invents citations,
never scores its own work, asks for missing evidence before spending. Live
multi-provider failover (OpenAI→Anthropic/Gemini) implemented; real-vendor
quality is a deployment measurement.

## 13 · Performance findings
**NOT TESTED** (H-8).

## 14 · Observability & incident response
Correlation id on every response; structured boot banner declares every absent
capability. Live alerting/tracing needs the monitor (H-1).

## 15 · Fixes implemented
D-001 (non-text files → `sourcehygiene.test.ts`, `d72ec33`), D-002 (engine-strict,
`c20f1d8`), plus D-010…D-016 earlier in the session, each with a regression test.

## 16 · Unresolved risks
All access-bound (H-1…H-11). No accepted code risk.

## 17 · Human action list
See `human-actions.md` — 11 items, each with why-it-blocks and what-the-audit-does.

## 18 · Pre-launch action plan
- **Before any launch:** H-1, H-2, H-5 (reach prod, confirm secrets, confirm mail).
- **Before beta:** H-3, H-6, H-7 (second tenancy, restore drill, rollback drill).
- **Before public:** H-4, H-8, H-9, H-11 (payments, load, legal, mobile).
- **Within 7 days:** formal Mind-2 walkthrough on devices.
- **Within 30 days:** H-10 ownership audit.

## 19 · Launch configuration (recommended)
Enabled: ledger, auth/MFA, Bid-On, console. Disabled until their human action
clears: payments, newsletter/marketing sends, telemetry egress. Rollback
trigger: `/readyz` not green within the deploy window (already wired).

## 20 · Final decision

**This release is not approved for public launch.** The tested build is sound and
no blocking code defect is open; the verdict is NO-GO solely because the live
platform, its payment sandbox, its infrastructure drills and its device matrix
were not reachable by this audit. Supply H-1 (live access) and the loop resumes
immediately; most gates are expected to clear quickly once their evidence can be
gathered.
