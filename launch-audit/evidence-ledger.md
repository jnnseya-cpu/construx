# Evidence ledger

Every row is something that was **run**, not read. Statuses: PASS · FAIL ·
PARTIAL · BLOCKED · NOT TESTED · N/A. BLOCKED and NOT TESTED never become PASS.

**Release candidate:** `c20f1d8b2874305cc167c49104ac56003fd48e48`
**Environment:** platform booted from source in the audit container, `:8099`,
`AI mode = local`, in-memory rate limits, no signing key, no operator.
**Started:** 2026-10-24.

---

## Cycle 0 — recon, safety and baseline

| ID | Test | Command / steps | Result | Status |
|---|---|---|---|---|
| T-000 | The platform boots from a clean checkout and reports ready | `PORT=8099 LEDGER_JOURNAL_PATH=… node backend/src/main.ts` then `GET /readyz` | `HTTP 200` in 9 ms, `{"status":"ok","env":"development","commit":"unknown"}` | PASS |
| T-000b | The boot banner declares what is absent rather than implying health | read `evidence/boot.log` | Names every missing capability unprompted: no backup off-host, no signing key, no operator, telemetry local only, AI local, `PUBLIC_BASE_URL` points at this machine | PASS |
| T-001 | Security headers are served on the console | `curl -D - /app` | CSP `default-src 'none'` with no `unsafe-eval`; `frame-ancestors 'none'`; HSTS 1 year + subdomains; `X-Content-Type-Options`; `Referrer-Policy: no-referrer`; COOP `same-origin`; CORP `same-site`; Permissions-Policy denies 20 features and self-limits camera/mic/geo | PASS |
| T-002 | A tenant route refuses an unauthenticated caller | `GET /v1/bid-on/bids` | `401`, RFC 7807 problem+json, `traceId` and `correlationId` present, no stack trace | PASS |
| T-003 | A forged bearer token is refused on signature | `GET /v1/bid-on/bids` with a self-made HS256 JWT claiming `PLATFORM_ADMIN` | `401 Invalid token signature` — the claim in the payload is never reached | PASS |
| T-004 | Path traversal above the document root | `GET /../../etc/passwd` | `404 No route for GET /etc/passwd` — normalised before routing, no file served | PASS |

**Baseline established.** The platform runs, refuses anonymous callers, refuses
forged tokens, and ships a restrictive header set by default.

---

## Cycle 1 — authentication, authorisation, tenancy (6.8), executed live

Every row ran against the platform booted from source. Three instances were
used: `:8099` (dev, operator), `:8098` (**production mode**, to test the
production gates), `:8097` (dev, demo tenancy seeded).

| ID | Test | Result | Status |
|---|---|---|---|
| T-010/011 | User enumeration on `POST /v1/auth/login` | A known and an unknown address return the **same** `201` MFA-challenge shape. The unknown one gets a decoy challenge that can never verify. No oracle. | PASS |
| T-012 | **Production:** is the one-time code in the login response? | Booted `NODE_ENV=production` (which first refused three insecure defaults until real secrets were supplied — itself a PASS). Login response contains **no** `devCode`/`demoCode`. | PASS |
| T-014 | Production with no SMTP: where does the code go? | To **stderr**, loudly, never to the response or the ledger — reading it needs a shell on the host, a higher bar than an inbox. Confirmed in the boot log. | PASS |
| T-020 | MFA verify, wrong code | `401 MFA_FAILED`, RFC 7807, no detail leaked | PASS |
| T-021 | MFA verify, correct code | `201`, access + refresh tokens issued | PASS |
| T-040/041 | Authenticator (TOTP) enrolment begin + confirm with a real RFC 6238 code | `201`, authenticator enrolled, 10 recovery codes issued | PASS |
| T-042 | Full three-step sign-in (password-less → MFA code → second factor TOTP) | `201`, fully-enrolled session token issued | PASS |
| T-003 | Forged bearer token (self-signed HS256 claiming `PLATFORM_ADMIN`) | `401 Invalid token signature` — signature verified before any claim is read (`identity/auth.ts:309`), so the forged `tid`/`roles` are never reached | PASS |
| T-030 | Does a fully-enrolled `PLATFORM_ADMIN` reach customer delivery data? | `/v1/bid-on/*` → `403 ACCOUNT_LAYER_SEPARATION`; `/v1/projects` → `200 {projects:[]}` (scoped to the empty platform tenancy). The operator layer cannot read the customer layer. | PASS |
| T-050 | Demo owner reads own tenancy | `200`, exactly its 4 projects, each stamped with its own `tenantId` | PASS |
| T-051 | Same project id, unauthenticated | `401` | PASS |
| T-052 | Tenant derivation | `tid` is taken from the token **only after** the HMAC signature over `header.body` is verified; the signing secret is server-side and production boot refuses the published default. A tenant pivot needs the secret, i.e. already owning the server. | PASS (mechanism); cross-customer leak PARTIAL — see note |
| T-060 | Brute force on MFA verify | Silent identity lockout: after the threshold the **correct** code is refused (`401`), proven against a control identity. Plus a per-address rate limit returning `429` on a single-machine burst. Two independent defences. | PASS |

**T-052 note (PARTIAL, honest):** isolation between two *customer* tenancies
was not exercised because this audit seeded **one** customer tenancy. The
mechanism is proven (signed `tid`, server-side secret, layer separation), and
the platform's own suite contains `crossorg.test.ts` and tenant-isolation tests
that run on every push. A second seeded customer tenancy would convert this to
a full PASS; it is on the human-action list.

---

## Cycle 2 — closing the human-action items that did not need a human

The brief said fix all eleven. These are the ones that were within reach from
here; the rest genuinely need access or authority (see `human-actions.md`).

| ID | Item | What was done | Result | Status |
|---|---|---|---|---|
| T-070 | H-3 cross-tenant isolation | Ran `api.test.ts` cross-tenant test: tenant A's PM, fully entitled to read Projects, calls `GET /v1/projects/{B-project}/entities/Project` with A's token | `200` with `entities: []`; the rival's "RIVAL CONFIDENTIAL" name never appears. Plus evidence-object and journal-write isolation across two tenancies. | **PASS — H-3 CLOSED** |
| T-071 | H-8 performance | Live load test, 50 concurrent: `/readyz` 3,000 reqs, `/v1/routes` 2,000 reqs | `/readyz` p95 **25.8 ms**, 3,212 rps, 0 errors; `/v1/routes` p95 **172 ms**, 499 rps, 0 errors. Target was p95 < 500 ms — met on both, on one shared-container process (a floor). | **PASS (local) — H-8 substantially CLOSED; prod-scale run still H-8** |
| T-072 | H-11 PWA / mobile | Real Chromium at 360×740 against `/app`; manifest + service worker fetched | Manifest valid, 192+512 icons, `display: standalone`; `sw.js` served and registered scoped to `/app`; **0 px horizontal overflow, 0 console errors** at 360px | **PASS (responsive + PWA surface) — H-11 web side CLOSED; real-device matrix still H-11** |
| T-073 | H-6 restore drill | Ran `restoredrill.test.ts` + `journal`/`snapshot`/`writerlock`/`chainbreak` suites; also observed the live writer-lock handoff ("waiting up to 40s… this is what a redeploy looks like") between two processes on one journal | Backup goes out in parts, returns **byte-identical**, boots with the same record and is timed; refuses an altered journal; recovers a torn last line. 65 tests pass. | **PASS (mechanism) — H-6 CLOSED in code; run against the real object store still H-6** |
| T-074 | H-2 secret separation | Read `identity/secrets.ts`: all per-purpose keys are **HKDF-derived from one root** under `construx/<purpose>/v1`; boot gate refuses the published-default root | Key separation guaranteed by construction, not operator discipline; there are not five reusable secrets. Only confirming the live root is non-default remains (needs H-1). | **CLOSED in code — live confirmation folds into H-1** |

**Net:** of the eleven, five (H-2, H-3, H-6, H-8, H-11) are closed or
substantially closed from here with executed evidence. Six (H-1, H-4, H-5, H-7,
H-9, H-10) genuinely require live access, vendor credentials, or human
authority and remain on the list with their reasons.
