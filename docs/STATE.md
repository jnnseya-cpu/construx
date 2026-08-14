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
| Tests | 165 passing, 8 suites |
| Typecheck | clean |
| Backend | 50 TypeScript files, ~15.7k lines |
| Application | 21 ES modules, ~4.5k lines |
| API routes | 105 |
| Event types | 135, closed catalogue |
| Entity types | 90, all classified for access |
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

**ACU economics.** Route → reserve → execute → persist → debit. Prepaid only,
hard caps, alerts, per-engine attribution. No provider call on an empty wallet;
no charge without a ledger write.

**Commercial packaging.** Eight role-priced seats, three packages, three ACU
bundles. The operator and the regulator consume no seat.

**Application.** Fifteen screens against live endpoints. Role-aware navigation
resolved from the API's permission matrix and phase gates, so the interface
refuses for the reason the platform would. Command surfaces on field, cost,
design, programme, change and handover. Daily site record. Canonical enum
dropdowns. Evidence hashed with SHA-256 in the browser. Denials are shown as
denials, never as empty records.

**Offline field sync.** Device timestamps preserved, operation-id idempotency,
deterministic conflict resolution, monotonic cursors, governance actions refused
from devices.

**Branded exports.** Refuse without branding. Audience-based redaction. Recorded
as Golden Thread events.

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
8. **Screenshots are gitignored.** Regenerate with
   `node tools/walk.mjs "<role>" "" shots`.

---

## Working notes

- The seeded demo project sits in the **Operations** phase, so field-execution
  and tender writes are correctly phase-gated. This is not a bug; commands show
  as locked with that reason.
- One server instance is enough. `PORT=8123 node src/main.ts`. Seed with
  `POST /v1/console/identities`. Restarting reseeds and changes all ids.
- `tools/walk.mjs` verifies every page renders for a role. `tools/inputs.mjs`
  counts command surfaces per page.
