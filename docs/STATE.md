# Project state

**This file is the single source of truth for what exists.** Read it before
starting work. Update it in the same commit as the change it describes. Do not
re-derive project state by inspecting the code — if this file is wrong, fix it
here rather than working around it.

It exists because state was previously re-derived every session, which produced
contradictory answers about what was built, repeated work that was already done,
and claims of completion that did not hold.

---

## At a glance

| | |
|---|---|
| Tests | 260 passing, 0 failing, across 14 files |
| Typecheck | clean |
| Backend | 58 TypeScript files, 18,580 lines |
| Application | 24 ES modules, 5,205 lines (plus a service worker) |
| API routes | 117 |
| Event types | 143, closed catalogue |
| Entity types | 95, all classified for access |
| Runtime dependencies | none |

Run: `npm test`, `npm run typecheck`, `npm start` (landing at `/`, app at `/app`).

---

## What is built and verified

These are implemented, covered by tests, and exercised through the running
application. Do not rebuild them.

**Golden Thread.** Append-only hash-chained ledger. Canonical serialisation,
SHA-256, constrained RFC 6902 patches ordered remove→add→replace, closed event
catalogue, evidence requirements, AI-authorship rules. Deterministic replay with
per-event verification and a project state root hash. Tamper is detected.

**Seven engines with real arithmetic.** CPM forward/backward pass with float and
PERT probability. Earned value with three EAC scenarios. CVR with margin
erosion. S-curve cashflow. Deterministic bid scoring with penalty flags. Risk
expected value and P80 contingency. Delay attribution with concurrency. Statutory
payment cycle dates. Reliability-adjusted maintenance forecasting.

**Payment cycle, end to end.** Application → certification → payment notice →
settlement. The applicant cannot certify; the payer posts the payment. Refuses
over-certification, double certification and overpayment. Withheld sums carry a
reason.

**Access control.** Three account layers, RBAC, OAuth2-style scopes, ABAC, in a
fixed fail-closed order. Tenant isolation. Lifecycle phase gating on writes.
Data-sensitivity redaction. Regulator read-only with export. Supplier
confinement. Separation of duties enforced, not advised. Every entity type
declares its capability area and sensitivity, and the audit feed withholds the
patch for records the caller cannot read while keeping the envelope.

Proven over real HTTP rather than by calling handlers: `tests/api.test.ts`
stands the gateway up on a socket and pins the public-route list, the
operator/delivery separation, the tenant filter on the generic entity read, and
the problem+json contract. A route becoming public by accident is a one-word
edit, so the list is asserted rather than trusted.

**ACU economics.** Route → reserve → execute → persist → debit. Prepaid only,
hard caps, alerts, per-engine attribution. No provider call on an empty wallet;
no charge without a ledger write. `tests/ai.test.ts` proves each of those with a
stub provider that counts its own calls: failover, the empty-wallet refusal
before the request goes out, and a released hold when the provider throws.

**Commercial packaging.** Eight role-priced seats, three packages, three ACU
bundles. The operator and the regulator consume no seat.

**Application.** Seventeen screens against live endpoints, including Autopilot — the queue where a person approves or declines what the agents propose. Role-aware navigation
resolved from the API's permission matrix and phase gates, so the interface
refuses for the reason the platform would. Command surfaces on field, cost,
design, programme, change and handover. Daily site record. Canonical enum
dropdowns. Evidence hashed with SHA-256 in the browser. Denials are shown as
denials, never as empty records.

**Agent runtime — autopilot with a human gate.** Eight agents, one per engine,
each with a mandate naming what it may read, what it may propose in, and which
roles may decide. They run over materialised state, raise findings that name the
records they were read from, and propose the command they want run. Then they
stop.

Three rules hold it: an agent never writes project state; an agent cannot
propose outside its mandate, checked by the runtime rather than by the agent;
and an agent cannot decide. Approval needs both the capability the command
exercises *and* standing as a nominated approver — reading is not authorising.
The event catalogue refuses an AI actor authoring an approval, so the guard
holds even if the runtime one were bypassed. Approved commands run as the
approving human through the same engine path any manual command takes. A
rejection needs a reason and stays in the record. Repeat findings are suppressed
rather than raised again.

**Weekly newsletter.** A role-targeted issue about what the platform does,
composed from the real feature set and linking only to screens that exist — a
test fails if a link resolves to no page. Consent is a ledger record rather than
a flag, so what a person decided and through which route survives. Unsubscribe
links are HMAC-signed, work without signing in, and are refused when forged; the
GET only ever shows the confirmation, so a mail scanner prefetching links cannot
unsubscribe anybody. One-click unsubscribe (RFC 8058) is honoured.

Campaigns are keyed by ISO week, so a scheduler firing twice, a restart inside
the send window and an operator pressing the button all resolve to one issue.
Delivery is recorded per recipient with what actually happened: a message
composed but not transmitted is `RECORDED`, never `SENT`. SMTP is spoken
directly over `node:net`/`node:tls` — verified in the suite against a real
socket, including STARTTLS refusal and dot-stuffing.

**Installable application with a launch screen.** Web app manifest, generated
icon set (standard and maskable), twelve exactly-sized iOS launch images, and an
in-document splash that paints before `app.js` parses so the handover from the
operating system's own launch screen is invisible. One background colour is
asserted across the manifest, the `theme-color` meta and the CSS, because a
mismatch shows as a flash.

The service worker exists to make the application installable, which is what
makes a launch screen appear at all. **It never touches `/v1/`** — caching an
authorised response would put one identity's project data outside the platform's
access control and serve it to whoever opens the app on that device next.
Offline field work is the sync protocol's job, not a cache's. Shell only,
network-first for navigation, verified by test and in a browser.

Regenerate the assets with `node tools/icons.mjs` after any brand change. The
PNG encoder is in that file: `node:zlib` is built in, so it was shorter than the
argument for a dependency.

**Offline field sync.** Device timestamps preserved, operation-id idempotency,
deterministic conflict resolution, monotonic cursors, governance actions refused
from devices.

**Branded exports.** Refuse without branding. Audience-based redaction. Recorded
as Golden Thread events. A document stamped "commercial detail withheld" is now
tested to contain no figures anywhere — including the risk table, which used to
carry priced exposure into a redacted copy.

---

## What is partial

Implemented in a form that works, with a stated part missing. The missing part is
named so it is not mistaken for finished.

| Area | Built | Missing |
|---|---|---|
| Take-off | Governs, evidences and prices measured items, traced to sheet and revision | Quantities are supplied by the caller, not read from a drawing |
| Drawing register | Title-block structuring from supplied text, supersession, markup→RFI | OCR from the image |
| Model ingestion | Records the model, hash, discipline, LOD, element count as a governed event | IFC parsing, geometry hash, model diffing |
| Digital twin | Reconciles observed against expected element status | Observations are structured input, not derived from imagery |
| Evidence capture | Real SHA-256 over the real file, recorded against the event | No object store for the file itself |
| Clause extraction | From supplied text | OCR and table extraction |
| Knowledge graph | Entities cross-reference by id; the ledger reconstructs lineage | No graph store or traversal API |
| Lookahead planning | Entities in the catalogue | PPC metrics not computed |
| 4D scheduling | Twin states link to task ids | No visualisation |
| PDF export | Structured document model and HTML rendering | PDF rendering |
| Newsletter delivery | SMTP submission verified against a socket, per-recipient outcomes recorded | No bounce processing or suppression list; DKIM belongs at the relay, where the key should live |

---

## What is not built

Specified in the source documents, deliberately absent, and **not to be claimed
as present**. Most of it is perception and ingestion infrastructure — real ML and
parsing work, not wiring.

- **File ingestion pipeline** — presigned upload, virus scan, MIME validation, ML
  file classifier with confidence, OCR, table extraction, vector embedding,
  `FILE_EXTRACTED`
- **Vision pipeline** — progress estimation, PPE compliance, equipment
  recognition, defect detection, `PROGRESS_EXTRACTED_FROM_IMAGES`
- **Audio and communication intelligence** — transcription, commitment and
  deadline extraction, `COMMITMENT_REGISTERED`, `DEADLINE_TRACKED`
- **Guided project creation form** with canonical enums (projects are created
  through the API)
- **Deployment topology** — Terraform, Kong, MSK, RDS, S3
- **Native Android and iOS clients** — the sync protocol and `ANDROID`/`IOS`
  event sources are built and tested server-side
- **External data feeds** — commodity pricing, weather, credit reference
- **Persistence** — the ledger is in-process; Postgres with RLS and append-only
  rules is designed for, not implemented

---

## Decisions already made — do not revisit

Re-opening these is what caused churn before.

1. **No property-deal marketplace.** Revenue engines, Buy Box, Funding Box and
   DEAL EQUITY belong to a different product. Explicitly excluded by the user.
2. **Zero runtime dependencies.** Node 22 native type stripping. Dev
   dependencies are `typescript` and `@types/node` only.
3. **No frontend framework and no build step.** Plain ES modules, tagged-template
   HTML escaping by default.
4. **The package, not the seat sum, is charged.** Legacy tiers remain and map to
   packages so existing contracts resolve.
5. **Money is in minor units everywhere.** No floating point in the billing path.
6. **The interface never holds a rule the API does not publish.** Permission
   matrix and phase gates are fetched, not duplicated.
7. **A denial is displayed as a denial.** Never as zero, never as empty.
8. **No agent acts unattended.** Every mandate caps at `PROPOSE`. The `ACT`
   level exists in the model but granting it to an agent is a product decision
   that must be made explicitly; a test fails if one grants it to itself.
9. **Screenshots are gitignored.** Regenerate with
   `node tools/walk.mjs "<role>" "" shots` (`WALK_BASE` overrides the origin).
10. **The newsletter carries no project data.** It is role-targeted, not
    data-personalised. An email leaves the platform's access controls behind
    the moment it is sent, so it contains capability descriptions and links —
    never figures, never commercial or safety content.
11. **The newsletter sender is off by default.** `NEWSLETTER_ENABLED=false`
    everywhere until an operator arms it in one environment deliberately.

---

## Working notes

- The seeded demo project sits in the **Operations** phase, so field-execution
  and tender writes are correctly phase-gated. This is not a bug; commands show
  as locked with that reason.
- One server instance is enough. `PORT=8123 node src/main.ts`. Seed with
  `POST /v1/console/identities`. Restarting reseeds and changes all ids.
- The browser tools need `playwright-core`, which is deliberately **not** a
  project dependency — dev dependencies are TypeScript and `@types/node` only.
  Both tools now say so and print the install line rather than failing with a
  module-not-found stack.
- The go-to-market plan lives in `docs/go-to-market/`, generated by
  `tools/gtm/`. It quotes the platform's own pricing, so it is kept in the
  repository rather than beside it.
- A project id that does not exist, and one belonging to another tenancy, both
  answer `200` with an empty list on the generic entity read. That is
  deliberate: a `404` for unknown and a `403` for forbidden would together tell
  a caller which project ids exist. Tested, so nobody "fixes" it.
- `tools/walk.mjs` verifies every page renders for a role. `tools/inputs.mjs`
  counts command surfaces per page.
- `tools/walk.mjs` used to take ~30s per page: `locator.textContent()` auto-waits
  and only rejects at the 30s default, so probing for an error notice that was
  legitimately absent cost the full timeout on every healthy page. It reads
  through `count()` now. A full walk is well under a minute.
- The newsletter's weekly timer polls hourly rather than computing a delay, so
  a restart cannot skip a send. Week-keyed campaigns make the polling safe.
- With no `SMTP_HOST`, the Newsletter screen states plainly that nothing is
  being transmitted. That is the configured state in development, not a fault.
