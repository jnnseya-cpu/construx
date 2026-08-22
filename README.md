# CONSTRUX.AI

An AI-agent Construction Operating System covering the full asset lifecycle:

```
Concept → Design → Tender → Construction → Commissioning → Handover → 30+ year O&M
```

One data spine, seven AI engines, one set of governance rules — for building
construction, civil infrastructure and specialised works alike. No sector
verticals, no duplicated logic.

**Before changing anything, read [`docs/STATE.md`](docs/STATE.md).** It is the
single source of truth for what is built, what is partial, what is deliberately
absent, and which decisions are settled. Keep it current in the same commit as
the change it describes.

[`CLAUDE.md`](CLAUDE.md) is the standing engineering directive — how work is
done here, and which existing mechanism to reuse rather than rebuild.

## Running it

Node 22.18 or later. There is nothing to build and no runtime dependencies.

```bash
npm install          # dev-only: TypeScript and @types/node
npm run demo         # takes one asset from concept to operations, then verifies itself
npm start            # gateway + application on http://localhost:8080
npm test             # see docs/STATE.md for the current count
npm run typecheck
```

`http://localhost:8080/` is the landing page, `/app` is the application. The
sign-in screen lists the seeded identities: choose the Project Manager to see
delivery, the Building Safety Regulator to watch write controls disappear, or
the Platform Operator to see the operator layer — a different product with no
access to project data at all.

`npm run demo` is the fastest way to see what the system does. It onboards a
tenant, assigns ten identities, runs a water-treatment project through every
lifecycle phase, then replays its own event log to prove nothing was altered —
including a deliberate tamper that the replay catches.

The default `AI_MODE=local` uses deterministic local engines, so the demo costs
nothing and produces identical results on every run. Set `AI_MODE=staging` or
`production` with provider keys to route to real models.

## What holds it together

### The Golden Thread

Every state change in the platform is an event. Nothing writes an entity
directly: a caller submits the state it wants, the ledger derives an RFC 6902
patch, validates it, hashes the result, and commits the event and the state
together or not at all.

- **Append-only and hash-chained.** Each event carries `beforeHash`,
  `afterHash`, and a chain hash over its predecessor. Deleting or reordering
  events breaks the chain.
- **Canonical hashing.** Keys sorted, no whitespace, audit and derived fields
  stripped, array order preserved. Two systems holding the same state compute
  the same hash.
- **Constrained patches.** Only `add`, `remove` and `replace`, ordered
  remove → add → replace. `move` and `copy` are rejected because the same end
  state can be reached several ways, which makes a replay ambiguous.
- **A closed event catalogue.** Unknown event types are rejected. Events marked
  as requiring evidence cannot be committed without it. Events reserved for
  humans cannot be produced by an AI actor.
- **Replay.** `POST /v1/projects/:id/audit/replay` reconstructs state from the
  log, verifies every event independently, and returns a project state root
  hash — one attestation value any party holding the log can reproduce.

### Seven AI engines

| Engine | Covers | Deterministic maths it owns |
|---|---|---|
| Tender & Commercial | Take-off → estimate → package → returns → adjudication → bid pack | Bid scoring, variance detection, cost build-up |
| Planning & Delivery | WBS, programme, progress, delay | CPM forward/backward pass, float, PERT probability |
| Resource & Cost | Budget, EVM, CVR, cashflow, payment cycle | Earned value, margin erosion, S-curve, statutory notice dates |
| Risk, Safety & Compliance | Risk register, RAMS, observations, competency | Expected value, P80 contingency, leading-indicator safety forecast |
| BIM & Digital Twin | Drawings, models, clashes, site reality, as-built | Revision supersession, clash triage by rework cost |
| Contracts, Change & Claims | Contracts, variations, delay events, claims, notices | Delay attribution with concurrency, entitlement scoring |
| Handover & O&M | Commissioning, handover, assets, defects, maintenance | Reliability-adjusted lifecycle forecasting |

The split between computed and inferred is deliberate and visible. Critical
paths, earned value, bid scores, contingency and delay attribution are
arithmetic — reproducible by hand and identical on every run. The models
contribute classification, narrative and judgement-shaped weightings, and never
write state on their own.

### Commercial enforcement

Every AI execution follows the same sequence:

```
route → reserve ACUs → execute → persist to Golden Thread → debit
```

If the wallet cannot fund the call, no provider is contacted. If the call fails,
the hold is released and nothing is charged. If persistence fails, the debit
does not happen — there is no billing without a ledger write, and no ledger
write without a funded execution.

- Prepaid only, no negative balances, automatic halt at zero
- Fixed markup over raw provider cost, with volume incentive bands
- Monthly, per-project and per-module caps; alerts at 50/80/100%
- Cost attributed to tenant, project, user, engine and feature
- Subscription (access, identity, governance, non-AI workflows) is billed
  separately from AI usage, which is metered strictly by consumption

### Governance

Three account layers that never blur:

- **Platform operator** — tenants, billing, global config. Cannot see projects,
  packages or daily logs.
- **Enterprise admin** — users, portfolios, programmes, projects, packages.
- **Tenant users** — the delivery team. Never see platform controls.

Access is decided in a fixed, fail-closed order: authenticate → RBAC → scopes →
ABAC. Any missing attribute, any evaluation error and any explicit deny results
in a deny. On top of that: tenant isolation, lifecycle phase gating, data
sensitivity redaction, regulator read-only with no AI unless the owner enables
it, and supplier confinement to their own tender lane.

Separation of duties is enforced rather than advised. The QS authors the
estimate and runs the evaluation but cannot approve the budget baseline or the
award; the PM approves the adjudication; the Owner approves the cost baseline
and accepts handover.

### Lifecycle gates

A project advances only when the current phase's exit criteria are satisfied by
materialised state — an approved baseline, a frozen estimate, an executed
contract, accepted commissioning results. Gates are evaluated from the ledger,
never asserted. Regression to an earlier phase is permitted, because projects
genuinely re-tender, but it is recorded explicitly as a regression.

## Layout

Three deployables, not three folders. `backend/` and `frontend/` share no code
and no build; `shared/` is the only thing both read, and it holds vocabulary
rather than logic.

```
backend/                 the service — one Node process, no dependencies
  src/
    core/                canonical hashing, constrained JSON Patch, ULID, validation, errors
    goldenthread/        event catalogue, ledger, journal, replay and verification
    identity/            roles, permission matrix, RBAC/ABAC/scopes, tokens and MFA
    billing/             ACU wallet, subscription tiers, invoicing
    ai/                  orchestrator, provider adapters, conversational copilot
    engines/             the seven engines and the maths they own
    domain/              governance structure, lifecycle phases, procurement
    lifecycle/           phase definitions and gate evaluation
    export/              document model, HTML and the hand-written PDF writer
    api/                 gateway, middleware, routing table
    cli/                 demo
  tests/                 unit and integration suites

frontend/                the browser application — plain ES modules, no build
  landing.html           marketing page
  index.html             application shell
  app.js                 router, session, role-aware navigation
  lib/                   API client and the HTML/escaping helpers
  pages/                 one module per screen, each reading live endpoints

shared/                  read by both, owned by neither
  vocabulary.js          the canonical enumerations

deploy/                  Dockerfile, compose, environment template
docs/                    state, architecture, traceability, going live, runbook
tools/                   browser walker used to verify every page renders
```

**Why the frontend is a sibling and not a subdirectory.** They are separate
deployables that one process happens to serve from one origin. Serving is a
deployment choice — `backend/src/api/gateway.ts` resolves `../frontend` — and
moving the frontend to a CDN later is a deployment change rather than a
rewrite.

**Why `shared/` is `.js` and not `.ts`.** The browser has to run it unmodified
and the backend has to import it without a build. Plain ES modules are the only
form both can read, which is the same constraint that produced settled
decisions 2 and 3.

The application is plain ES modules with no build step and no framework: the
same constraint as the backend, for the same reason — nothing to compile means
nothing that can drift from what is actually served.

## API

`GET /v1/routes` lists every endpoint. The shape is command-and-query over
project resources:

```
POST /v1/projects/:id/tender/takeoff        run a take-off, create BoQ items
POST /v1/projects/:id/tender/evaluate       score bids deterministically
GET  /v1/projects/:id/programme             recalculate from the activity network
POST /v1/projects/:id/programme/delay-forecast
POST /v1/projects/:id/cost/cvr              publish the live CVR
POST /v1/projects/:id/cost/application/:id/certify   certify and issue the payment notice
POST /v1/projects/:id/claims                assess a delay claim with concurrency
POST /v1/projects/:id/audit/replay          verify the record
POST /v1/projects/:id/ask                   conversational copilot
```

Errors are `application/problem+json` with a trace id and correlation id.
Commands accept an `Idempotency-Key`.

## Configuration

Every flag is environment-driven; see `.env.example`. The gateway is stateless
and holds no secrets of its own. `NODE_ENV=production` with a default JWT
secret, disabled auth, or a non-production AI mode produces startup warnings.

## Where the boundaries are

The platform is honest about what it does not know. Confidence scores travel
with machine-measured quantities. A CVR built from partial data reports low
completeness. A claim with thin evidence is scored down and the system says so
rather than inflating it. AI classifications of safety observations are marked
as requiring human review, and extracted contract clauses as requiring legal
review. The copilot answers from project state and says the record is empty
rather than answering from general construction knowledge.

See [`docs/traceability.md`](docs/traceability.md) for how each documented
requirement maps to the build, including what is specified but not yet
implemented.
