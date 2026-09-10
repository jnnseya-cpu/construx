# Level 7 — ITT & Bid Engine

## Developer-ready technical specification v1.0

**Owner:** Groupe Nseya Digital / JNN Global Ltd — OS venture
**Status:** Build specification (developer handoff)
**Scope:** Opportunity discovery → ITT ingestion → scope intelligence → estimating → contract and risk → programme → bid composition → submission → award → delivery baseline handover

---

## How this document sits beside the rest

This is a **specification**, not a record of what is built. `docs/STATE.md`
remains the only record of what exists. Where this document and `STATE.md`
disagree about whether something is built, `STATE.md` is right.

It is merged here rather than filed apart because §18 of
[`docs/ai-os-blueprint.md`](ai-os-blueprint.md) already carries the six-level
maturity model this document extends. Read them in order: §18 says how deep
agents can go and where CONSTRUX sits; this says what a seventh level would
require and how to build it.

### The reference stack is a reference, not a decision

The specification names NestJS, Kafka, LangGraph, Next.js, GCP, Python workers,
Temporal and a Postgres event store. CONSTRUX is built on a different and
deliberate footing, recorded in `CLAUDE.md` and `docs/STATE.md` as settled:
**zero runtime dependencies**, Node type-stripping with `.ts` imports, an
in-process hash-chained ledger with a journal and snapshots, Postgres behind
`LEDGER_POSTGRES_MODE` rather than under everything, and no framework.

Those are not in conflict, because **L7.1 to L7.7 are properties, not products.**
A build satisfies them or it does not; the stack that satisfies them is a
separate question. Nothing in this document is a reason to rewrite the platform,
and §7's portability rule — zero business logic in adapters — is the same rule
CONSTRUX already follows by keeping every provider behind a port.

Where a CONSTRUX mechanism already satisfies a requirement, it is named in a
**CONSTRUX position** note under that section. Where nothing satisfies it, the
note says so plainly.

### Portability

Every external dependency sits behind a port and adapter. The engine must run on
the reference stack, on AWS or Azure, on-premise, and as an embedded module
inside third-party platforms — Procore, Aconex, Asite, Viewpoint, Autodesk
Construction Cloud, SAP, Oracle Unifier and bespoke common data environments.

---

## 0. What "Level 7" means

The six-level maturity model in §18.2 stops at *governed operational autonomy* —
executing approved low-risk actions. Level 7 adds a property none of the lower
levels have:

> **Level 7 — Self-improving, contract-native, evidence-bound bid organisation.**
> A network of specialist agents that (a) reason inside the *actual* contract and
> ITT rules of each tender, (b) can only assert what is bound to a verified
> evidence object, (c) run adversarial self-challenge before any human sees the
> output, (d) learn from every win, loss, clarification and post-award variance
> through a governed feedback loop, and (e) expose every conclusion with full
> provenance, cost lineage and time-travel state.

Level 7 is defined by seven hard properties. A build failing any one of them is
not Level 7.

| # | Property | Test |
|---|---|---|
| L7.1 | **Contract-native reasoning** | The same site event produces different outputs under NEC4 Option A, JCT D&B 2016, FIDIC Yellow and bespoke amendments. Agents load the tender's *actual* clause graph, never generic knowledge |
| L7.2 | **Evidence-bound assertion** | No sentence enters a submission unless it resolves to an `EvidenceObject` with `status = APPROVED`. Enforced by a hard gate, not a prompt |
| L7.3 | **Adversarial self-challenge** | Every material output — price, programme, response, assumption — is attacked by an independent red-team agent with a different model and prompt lineage before human review |
| L7.4 | **Time-travel state** | Any artefact can be reconstructed as known at time T. Required for clarification audit, claim defence and post-mortem |
| L7.5 | **Full lineage** | Every number in the price chains back to source, date, currency, quantity basis, productivity assumption, quote validity and approver |
| L7.6 | **Governed learning** | Outcomes update calibrated priors through a promotion pipeline with human approval. No agent output becomes institutional truth automatically |
| L7.7 | **Platform-agnostic core** | Zero business logic in adapters. Swapping the CDE, ERP, estimating tool, model provider or database is configuration plus an adapter, never a core change |

### CONSTRUX position against the seven properties

Measured, not asserted.

| # | Status | Mechanism |
|---|---|---|
| L7.1 | **Partial** | The clause register, obligation model and contract-form awareness exist and drive different outcomes per form. A versioned, packaged **clause graph per standard form** with amendment overlay does not — clauses are extracted per project rather than loaded from a library |
| L7.2 | **Partial** | Generated documents refuse to assert what they cannot source, and a finding that cannot name its evidence is not stored. A first-class `EvidenceObject` registry with approval state and expiry, gating a response's transition to approved, is **not built** |
| L7.3 | **Not built** | No red-team agent attacks another agent's output. The nearest existing thing is the machine check before issue, which refuses an incomplete bid response pack rather than challenging a complete one |
| L7.4 | **Partial** | The ledger is append-only and hash-chained, so any state is replayable to a point in the chain. The second time axis — *when the platform learned it*, distinct from *when it was true* — is not modelled, so "as known on the 14th about the 12th" cannot be asked |
| L7.5 | **Built in part** | Every price carries its source, date, assumptions and approval, and AI-authored content carries provider, model class, ACU settlement and prompt version. A materialised lineage DAG with a click-through "why is this number" view is **not built** |
| L7.6 | **Partial** | Lessons learned are corporate memory across projects and are human-approved before they become organisational memory, which is the promotion pipeline this asks for. Calibrated priors updated from win/loss and post-award variance are **not built** |
| L7.7 | **Built** | Every provider sits behind a port: AI providers behind the orchestrator, object storage behind the evidence store, Postgres behind a mode flag, payments behind a provider abstraction. Zero runtime dependencies is the strongest possible form of this rule |

Three of seven are genuinely absent: adversarial self-challenge, the evidence
registry as a gate, and bitemporal state. They are the work Level 7 would
require, and none of them is a rewrite.

---

## 1. Architecture

### 1.1 Layered architecture (hexagonal)

```
┌─────────────────────────────────────────────────────────────────┐
│  PRESENTATION  (web app · embedded widget SDK · CLI · API)       │
├─────────────────────────────────────────────────────────────────┤
│  ORCHESTRATION  (Bid Executive Orchestrator · agent runtimes)    │
├─────────────────────────────────────────────────────────────────┤
│  AGENT DOMAIN ENGINES                                            │
│  Opportunity · Intake · Scope · Estimating · Contract/Risk ·     │
│  Planning · Composer · Submission · Red-Team · Learning          │
├─────────────────────────────────────────────────────────────────┤
│  CORE KERNEL                                                     │
│  Bid State Store (bitemporal) · Event Spine · Evidence Registry ·│
│  Requirement Graph · Clause Graph · Lineage Service · Gate Engine│
│  · Policy Engine · ACU Meter · Provenance Ledger                 │
├─────────────────────────────────────────────────────────────────┤
│  PORTS (interfaces)                                              │
│  DocumentStore · CDE · Estimating · Scheduling · ERP · Portal ·  │
│  BIM · Email · Workflow · LLM · Embedding · OCR · Search · Bus   │
├─────────────────────────────────────────────────────────────────┤
│  ADAPTERS (swap per deployment)                                  │
│  Object store · CDE · estimating · scheduling · ERP · portal ·   │
│  BIM · mail · model provider · database · message bus            │
└─────────────────────────────────────────────────────────────────┘
```

**Rule.** Domain engines import only from the kernel and the ports. Adapters
import only from the ports. Presentation imports only from the orchestration API
contracts.

### 1.2 Reference deployment

| Concern | Reference | Portable alternative |
|---|---|---|
| Services | One module per engine, container-deployed | Any container runtime |
| Write model | PostgreSQL 16, event store schema | Any managed or self-hosted Postgres |
| Event bus | Kafka | Pub/Sub, SQS and SNS, NATS, Redpanda |
| Read models | Postgres projections plus a search index | Any search engine, or vectors only |
| Vectors | pgvector | Pinecone, Weaviate, Qdrant |
| Object store | Cloud object storage | S3, Azure Blob, MinIO |
| Agent runtime | A graph runtime satisfying `AgentRuntimePort` | Any equivalent |
| Model provider | A frontier provider primary, a second as fallback | Any provider, or a local model |
| OCR and layout | A document-understanding service | Textract, Azure DI, Tesseract with a layout model |
| Workflow | Durable execution | Any durable workflow engine |
| Auth | OIDC | Any OIDC provider |
| Billing | ACU meter behind `BillingPort` | Any payment provider adapter |
| Observability | OpenTelemetry | Any OTLP-compatible backend |

> **CONSTRUX position.** The layering is already how the platform is organised:
> engines under `backend/src/engines/`, domain commands above them, the API
> gateway above that, every provider behind a port. What differs is scale and
> substrate — one process rather than a service per engine, an in-process
> hash-chained ledger with a journal and snapshots rather than Kafka, and
> Postgres available behind `LEDGER_POSTGRES_MODE` in mirror, primary or
> follower rather than assumed underneath. Observability is already OTLP.
> Adopting the *rule* costs nothing; adopting the *substrate* is a separate
> decision with its own justification, and it is not made here.

### 1.3 Multi-tenancy and data residency

- A tenant is a contractor organisation. Every table carries `tenant_id`;
  row-level security is enforced; topics are partitioned by tenant; object
  storage is prefixed per tenant; a key per tenant.
- Residency profiles pin the region for the database, the bus, blobs and the
  model endpoint. A tender flagged `residency=uk` cannot route to a non-UK model
  endpoint — policy rule `PE-RES-01`.
- **Bid-team walls.** Within a tenant, `bid_id` is an isolation boundary.
  Cross-bid retrieval happens only through the learning engine's anonymised,
  approved lessons corpus.

> **CONSTRUX position.** Tenant isolation is enforced in `backend/src/identity/`
> and applied on every read including the generic entity route and the audit
> feed; per-tenant object-store prefixes and per-purpose derived keys with key
> ids exist. **Residency profiles do not exist**, and neither does a bid-team
> wall inside a tenancy — a tenancy is currently the smallest isolation
> boundary above a project. Both are real gaps for a customer bidding against
> itself in two teams.

---

## 2. Core kernel

### 2.1 Bid state store — bitemporal, event-sourced

Every aggregate is rebuilt from events. Every fact carries two time axes:

- `valid_from` and `valid_to` — when the fact was true in the world, for example
  drawing revision C current from 12 March.
- `recorded_at` — when the system learned it.

```
GET /bids/{bidId}/state?asOf=2026-03-12T10:00Z&recordedBy=2026-03-14T09:00Z
```

returns the bid exactly as it was known at that moment. This is non-negotiable
for L7.4.

**Aggregates**

| Aggregate | Key | Purpose |
|---|---|---|
| `Opportunity` | `opp_id` | Pre-bid record, scoring, decision |
| `Bid` | `bid_id` | Root of everything after bid/no-bid |
| `TenderPack` | `pack_id` | Document set, versions, addenda |
| `Requirement` | `req_id` | One obligation or question |
| `Clause` | `clause_id` | Contract clause node |
| `ScopeItem` | `scope_id` | WBS, asset or package node |
| `Discrepancy` | `disc_id` | Cross-document conflict |
| `Clarification` | `clar_id` | Question to or from the employer |
| `Assumption` | `asm_id` | Bid assumption or qualification |
| `Risk` | `risk_id` | Risk register item |
| `CostItem` | `cost_id` | Priced line with lineage |
| `Quotation` | `quote_id` | Supplier or subcontractor quote |
| `Programme` | `prog_id` | Schedule snapshot |
| `Activity` | `act_id` | Schedule activity |
| `Response` | `resp_id` | Answer to a quality or technical question |
| `EvidenceObject` | `ev_id` | Verified proof of a claim |
| `Submission` | `sub_id` | Assembled deliverable set |
| `Gate` | `gate_id` | Approval checkpoint |
| `Decision` | `dec_id` | Human decision record |
| `Lesson` | `les_id` | Approved learning |

> **CONSTRUX position.** Seventeen of these twenty aggregates already exist as
> entity types, under CONSTRUX names — `Opportunity`, `ITTAnalysis` and
> `BidResponsePack` for the bid root and pack, `Obligation`, `ContractClause`,
> `WorkPackage`, `Clarification`, `Risk`, `Quotation`, `Programme`, `Activity`,
> `Submission` and the decision record among them. Three do not:
> **`EvidenceObject`**, **`Discrepancy`** as a first-class record with a
> mandated treatment, and **`Lesson`** as a promoted prior rather than a stored
> lesson. The store is event-sourced and replayable; it is **not bitemporal**.

### 2.2 Event spine

Topic naming `os.bid.{aggregate}.{event}`, for example
`os.bid.requirement.extracted`.

Event envelope, CloudEvents 1.0 compatible:

```json
{
  "specversion": "1.0",
  "id": "evt_01J9…",
  "type": "os.bid.requirement.extracted",
  "source": "/engines/intake",
  "subject": "bid_01J8…/req_01J9…",
  "time": "2026-09-10T09:12:44.120Z",
  "tenantid": "ten_…",
  "bidid": "bid_…",
  "actor": {
    "kind": "agent",
    "id": "intake.requirement-extractor",
    "run_id": "run_…",
    "model": "…",
    "prompt_hash": "sha256:…"
  },
  "causationid": "evt_…",
  "correlationid": "cor_…",
  "validfrom": "2026-09-10T09:12:44Z",
  "acu_cost": 0.42,
  "datacontenttype": "application/json",
  "data": {}
}
```

**Required properties.** Immutable, append-only, hash-chained per bid via
`prev_hash` to produce a tamper-evident provenance ledger. Retention is the life
of the tenant plus twelve years, the UK limitation period for a deed, unless a
residency profile overrides it.

**Core event catalogue, minimum**

```
opportunity.discovered · opportunity.scored · opportunity.decided
tender.pack.received · tender.document.ingested · tender.addendum.received
requirement.extracted · requirement.classified · requirement.assigned
requirement.status_changed
clause.parsed · clause.obligation_derived · clause.risk_flagged
scope.item_created · scope.discrepancy_detected · scope.discrepancy_resolved
clarification.drafted · clarification.approved · clarification.sent
clarification.answered
assumption.proposed · assumption.approved · assumption.retired
quote.requested · quote.received · quote.normalised · quote.expired
cost.item_priced · cost.item_challenged · cost.item_approved · cost.scenario_run
programme.generated · programme.challenged · programme.scenario_run
programme.approved
response.drafted · response.evidence_bound · response.redteamed
response.approved
evidence.registered · evidence.verified · evidence.rejected · evidence.expired
submission.assembled · submission.validated · submission.gate_passed
submission.uploaded · submission.confirmed
gate.opened · gate.decision_recorded
outcome.recorded · lesson.proposed · lesson.approved · prior.updated
```

> **CONSTRUX position.** The event spine exists and is stronger than this asks
> in one respect and weaker in another. Stronger: the catalogue is **closed** —
> 766 declared event types, each naming its entity, its operation, its
> capability area and whether an AI actor may write it, and an undeclared event
> cannot be written at all. The chain is hash-linked across the whole tenancy
> rather than per bid. Every event already carries actor, correlation id,
> evidence refs and, for AI writes, provider, model class, prompt version and
> ACU settlement. Weaker: there is **no `valid_from` distinct from the event
> time**, which is the same L7.4 gap; and roughly a third of the catalogue above
> has no CONSTRUX equivalent, chiefly the evidence, red-team and prior-update
> families.

### 2.3 Requirement graph

Requirements are nodes in a graph, not rows in a spreadsheet.

```ts
interface Requirement {
  id: string; bidId: string;
  text: string;                 // verbatim extraction
  normalisedText: string;       // agent paraphrase, never used for compliance
  sources: SourceRef[];         // { docId, version, page, bbox, clauseRef }
  classification:
    | 'TECHNICAL' | 'COMMERCIAL' | 'LEGAL' | 'SAFETY'
    | 'PROGRAMME' | 'SOCIAL_VALUE' | 'QUALITY' | 'ADMIN';
  mandatoryStatus: 'PASS_FAIL' | 'SCORED' | 'INFORMATIVE';
  scoring?: { weight: number; maxScore: number; method: string };
  ownerId?: string; departmentId?: string;
  evidenceRequired: EvidenceType[];
  destination: {
    kind: 'PORTAL_FIELD' | 'FORM' | 'SCHEDULE' | 'ATTACHMENT';
    ref: string;
    limits?: Limits;
  };
  status: 'MISSING' | 'IN_PROGRESS' | 'COMPLETE' | 'CHALLENGED' | 'NOT_APPLICABLE';
  conflicts: string[];          // Discrepancy ids
  dependsOn: string[];          // Requirement ids
  confidence: { extraction: number; interpretation: number };
  validFrom: string; validTo?: string; recordedAt: string;
}
```

Edges: `DEPENDS_ON`, `CONFLICTS_WITH`, `SATISFIED_BY` a response, cost item,
activity or evidence, `DERIVED_FROM` a clause, and `SUPERSEDED_BY` an addendum.

> **CONSTRUX position.** The compliance matrix carries requirement, source,
> classification, mandatory status, owner, evidence required, status, conflict
> status, submission destination and extraction confidence — the ten fields
> §18.4 names. It is a **table, not a graph**: `dependsOn` and `SUPERSEDED_BY`
> have no edge, so an addendum superseding a requirement is handled by
> re-analysis rather than by traversal. The verbatim-versus-paraphrase rule is
> already the platform's, and compliance is judged on the extracted text.

### 2.4 Clause graph — contract-native reasoning

Contract, to clause tree, to obligation objects. Bespoke amendments overlay the
standard form as `Amendment` nodes with `MODIFIES`, `DELETES` and `INSERTS`
edges.

```ts
interface Obligation {
  id: string; clauseId: string;
  party: 'CONTRACTOR' | 'EMPLOYER' | 'PM' | 'SUPERVISOR' | 'ENGINEER' | 'OTHER';
  trigger: TriggerSpec;         // event pattern plus optional condition
  action: string;
  noticePeriod?: Duration;
  timeBar?: { period: Duration; consequence: string };
  method: 'WRITING' | 'CDE' | 'PORTAL' | 'EMAIL' | 'FORM';
  approvalRequired: boolean;
  evidenceRequired: EvidenceType[];
  consequenceOfBreach: string;
  standardFormRef?: string;     // e.g. "NEC4 ECC 61.3"
  amendedBy?: string[];
  riskWeight: number;           // 0..1, set by the contract agent, human-reviewed
}
```

Contract libraries ship as versioned packages: `nec4-ecc`, `jct-db-2016`,
`fidic-yellow-2017`, `fidic-red-2017`, `nec3-ecc`, `jct-sbc-2016`, `ppc2000`,
`fac-1`, with DRC and OHADA public-works forms as a separate package. Each
package carries clause text, structure, standard obligations, known risk
patterns and its own evaluation set.

> **CONSTRUX position.** The obligation object is close to what exists: party,
> trigger, action, notice period, time bar, method, approval requirement,
> evidence, consequence and status are all carried, and the platform already
> distinguishes a reactive obligation with a time bar from a dated one with a
> due date. What is missing is the **library**: obligations are derived from the
> contract in front of the platform, not loaded from a versioned package per
> standard form with an amendment overlay. That is the substance of L7.1 and it
> is the single largest piece of work in this document.

### 2.5 Evidence registry — the L7.2 gate

```ts
interface EvidenceObject {
  id: string; tenantId: string;
  kind:
    | 'CERTIFICATE' | 'CASE_STUDY' | 'KPI' | 'CV' | 'POLICY'
    | 'ACCREDITATION' | 'INSURANCE' | 'FINANCIAL' | 'TEST_RESULT'
    | 'REFERENCE' | 'METHOD' | 'CALCULATION';
  claim: string;                // the sentence this proves
  source: {
    uri: string; hash: string;
    issuedBy?: string; issuedAt?: string; expiresAt?: string;
  };
  verifiedBy?: string; verifiedAt?: string;
  status: 'DRAFT' | 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
  scope: { bidIds?: string[]; global: boolean };
  reuseCount: number;
}
```

Gate rule `GE-EV-01`: a response cannot become `APPROVED` while any claim in its
body lacks an evidence id with `status = APPROVED` and an expiry after the
submission deadline.

> **CONSTRUX position. Not built, and it is the highest-value item here.** The
> platform holds evidence — hashed, retained, tenant-scoped, with a held-record
> concept — but evidence is attached to events rather than registered as an
> asserted claim with an approval state, an expiry and a reuse count. §18.4
> states the rule this implements: "We achieved 98% on-time delivery" needs an
> approved source before it may enter a submission. Today that rule is a
> discipline. `GE-EV-01` would make it a gate, and the bid response pipeline's
> existing refusal-before-issue is exactly where it belongs.

### 2.6 Lineage service — L7.5

Every cost item and every number in a programme narrative carries a chain:

```ts
interface LineageChain {
  nodeId: string;
  kind: 'SOURCE' | 'CALC' | 'ASSUMPTION' | 'ADJUSTMENT' | 'APPROVAL';
  ref: string;                  // quote id, rate library id, formula, assumption, decision
  value?: number; unit?: string; currency?: string;
  fxRate?: { pair: string; rate: number; date: string };
  quantityBasis?: string;
  productivity?: { rate: number; unit: string; source: string };
  validUntil?: string;
  confidence: number;
  parents: string[];
}
```

Lineage materialises into a directed acyclic graph per bid; the interface renders
"why is this number?" as a click-through. Export as JSON-LD and CSV for auditors.

> **CONSTRUX position.** The *data* largely exists — a price carries its source,
> date, currency, quantity basis, productivity assumption, quotation validity,
> exclusions, escalation basis, confidence and approval, and lineage traversal
> over the ledger is built. What does not exist is the **materialised DAG and
> the click-through view**. This is a projection over records the platform
> already holds, which makes it the cheapest of the three L7 gaps to close.

### 2.7 Gate engine

Gates are declarative state-machine guards, versioned per tenant:

```yaml
gate: G4_PRICE_RELEASE
appliesTo: Bid
from: PRICED
to: PRICE_RELEASED
requires:
  - all: CostItem.status == APPROVED
  - redteam: EstimatingRedTeam.openFindings(severity>=HIGH) == 0
  - scenario: Scenarios.P80.margin >= tenant.policy.minMarginP80
  - approval:
      roles: [COMMERCIAL_DIRECTOR]
      quorum: 1
      segregation: approver != author
onFail: notify(roles) ; block
```

Gate decisions are decision events, signed and retained for ever.

> **CONSTRUX position.** Stage gates exist with definitions of done and refuse
> rather than warn, and segregation of duties is enforced on the payment cycle
> and the signature ceremony. They are **written in code, not declared in
> configuration**, and they are per lifecycle stage rather than per tenant
> policy. Making them declarative is a real change and needs a reason beyond
> elegance — a tenant that must vary its own gate thresholds would be that
> reason.

### 2.8 Policy engine

A policy language evaluated on every agent action and every API call:

- `PE-RES-01` residency routing.
- `PE-AUT-01` agents may draft contractual communications; only humans may send.
- `PE-AUT-02` agents may not commit money — issuing an enquiry is allowed,
  issuing a purchase order is denied.
- `PE-EV-01` no unbound claim enters a submission.
- `PE-PII-01` CVs redacted at rest, unredacted only inside an approved
  submission build.
- `PE-ACU-01` bid budget cap; agents downgrade to cheaper models at 80% spent
  and halt at 100%.

> **CONSTRUX position.** `PE-AUT-01` and `PE-AUT-02` are already enforced, and
> more strongly than a policy file would: they are properties of the closed
> event catalogue, so a model persuaded to attempt them still cannot write the
> event. `PE-ACU-01` is partly there — a call is reserved before it runs and
> refused against an empty wallet — but there is **no per-bid budget cap and no
> automatic downgrade at a threshold**. `PE-RES-01`, `PE-EV-01` and `PE-PII-01`
> are not built. The platform's position is that a rule enforced by the
> catalogue beats the same rule written in a policy file, and that the rules
> the catalogue cannot express are the ones a policy engine should hold.

### 2.9 ACU meter

Every model, OCR, embedding and tool call emits a consumption event carrying the
bid, agent, run, model, input and output tokens and the ACU charge. The
conversion table is tenant-configurable. The projection is a per-bid, per-agent,
per-stage cost dashboard, with a prepaid balance behind `BillingPort`.

> **CONSTRUX position. Built, with one gap.** Every AI execution is reserved
> before it runs and debited only after its output reaches the ledger, at a
> fixed disclosed multiplier over provider cost, and no charge is raised without
> a ledger write. The missing dimension is **per-bid**: spend is attributed to
> the tenancy, the engine and the task type, not to a bid, so the per-bid cost
> dashboard cannot be drawn.

---

## 3. Agent runtime standard

### 3.1 Agent contract

Every agent implements the same interface, whatever engine it belongs to:

```python
class Agent(Protocol):
    id: str                    # "intake.requirement-extractor"
    version: str               # semver over prompt, graph and tool set
    inputs: type[BaseModel]
    outputs: type[BaseModel]
    tools: list[ToolSpec]      # declared, policy-checked
    autonomy: Literal["L1","L2","L3","L4","L5","L6"]
    evidence_policy: Literal["none","cite","bind"]
    def run(self, ctx: RunContext, inp: BaseModel) -> RunResult: ...
```

A run result always contains outputs, events, confidence, assumptions, open
questions, ACU cost and a trace id.

> **CONSTRUX position. Built, in a different language and with more fields.**
> Every agent declares its capability area, inputs, outputs, emitted event
> types, human-in-the-loop mode, confidence floor, ACU tier, memory access by
> layer, division, purpose and mandate ceiling. A finding carries its summary,
> consequence, evidence and — unusually — what the agent looked for and did not
> find, because an absence has no source record to cite. `evidence_policy` as a
> declared per-agent mode is **not** present; the platform applies one rule to
> every agent instead.

### 3.2 Graph pattern

Every agent graph has the same skeleton:

```
load_context → plan → (tool loop) → draft → self_check → emit_events → END
                                      ↑            |
                                      └── revise ──┘  (max N)
```

- `load_context` reads bid state as of now through the kernel, never raw files.
- `self_check` runs schema validation, policy and a structured critique; a
  failing output loops to `revise`.
- Agents never call other agents directly. They emit events and the orchestrator
  routes.

> **CONSTRUX position.** "Agents never call other agents; they emit and the
> orchestrator routes" is already the rule — an agent produces findings and
> proposals, and the runtime routes them. `load_context` through the kernel is
> already the rule: an engine reads the ledger, not a file. The **revise loop
> is not built**; a pass either produces its output or does not, which is why
> the bid response pipeline writes one section per pass and resumes rather than
> retrying inside a run.

### 3.3 Model routing

| Task class | Default | Fallback | Notes |
|---|---|---|---|
| `extract.structured` | Mid-tier, long context | Local model | JSON mode, temperature 0 |
| `reason.contract` | Frontier | Frontier, different vendor | Different vendor for red-team |
| `draft.prose` | Frontier | Mid-tier | House-style adapter |
| `classify` | Small | — | Batched |
| `embed` | Embedding model | — | 800-token chunks, 15% overlap |

Red-team agents **must** use a different prompt lineage and, where available, a
different vendor from the agent they attack.

> **CONSTRUX position.** Routing by capability with health-aware fallback exists,
> and the orchestrator refuses to call a provider on an empty wallet. Routing by
> **task class** with the vendor-diversity rule for red-teaming is not built,
> because red-teaming is not built.

### 3.4 Determinism and reproducibility

Every run records its prompt hash, model id, tool versions, seed where supported
and the input state version. A run can be replayed for audit, and divergence
beyond tolerance raises a non-determinism event.

> **CONSTRUX position.** Prompt version and model class are recorded on every AI
> event, and the whole chain is replayable with tamper detection. **Replaying a
> single agent run against its recorded inputs is not built**, and neither is a
> non-determinism alarm.

---

## 4. Engines and agents

Each agent lists purpose, inputs, tools, outputs, events, guardrails and
evaluation metrics.

### 4.1 Opportunity engine

#### 4.1.1 Opportunity scout

- **Purpose.** Discover, deduplicate and structure opportunities from portals,
  frameworks, client pipelines and inbound email.
- **Inputs.** Portal feeds — Find a Tender, Contracts Finder, TED, Jaggaer,
  ProContract, Delta, Ariba and client-specific — plus email ingestion and CRM
  sync.
- **Tools.** `portal.search`, `portal.fetch_notice`, `crm.lookup`,
  `dedupe.match`.
- **Outputs.** A draft opportunity with CPV or UNSPSC codes, geography, value
  band, contract form, procedure type, deadlines and lots.
- **Guardrails.** No automatic registration of interest on a portal. Level 6 is
  forbidden here.
- **Evaluation.** Recall against a manual scan at or above 0.95; duplicate rate
  at or below 2%.

#### 4.1.2 Capability match

- **Purpose.** Compare notice requirements to the tenant capability graph —
  accreditations, past projects, key staff, plant, financial thresholds,
  geographic reach.
- **Outputs.** Hard fails, soft gaps, partner needs and mandatory criteria.
- **Guardrails.** A hard fail — turnover threshold, missing mandatory
  accreditation — blocks "pursue" without a director override recorded as a
  decision.

#### 4.1.3 Bid/no-bid scoring

- **Purpose.** Produce a structured, explainable recommendation.
- **Model.**

```
EBV = P(win) × RAC − bid cost − capacity opportunity cost
RAC = Σ(margin scenario × probability) − E[downside exposure]
```

- **Inputs.** Capability match, historic win and loss priors from the learning
  engine, resource calendar, pipeline load, client relationship score, contract
  risk pre-scan.
- **Outputs.** A recommendation of pursue, pursue conditionally, partner,
  clarify or decline, with a sensitivity table, unresolved risks and
  assumptions.
- **Guardrails.** The recommendation must show which inputs drove at least 80%
  of the score — attribution for the scoring model, rationale listing for the
  language components.
- **Evaluation.** Calibration of the win probability on a rolling 24-month
  window; decision reversal rate after review.

> **CONSTRUX position.** The ten-factor bid/no-bid algorithm, the tender radar
> and the five-way recommendation are built, and the decision is a governance
> event a machine may not write. Three things here are not: **portal feeds** of
> any kind, so discovery is not automated; the **capability graph** as a
> structured record to match against; and **calibrated priors** from historic
> win and loss, which is the L7.6 gap. The 80%-attribution guardrail is a good
> rule and the platform does not have it.

### 4.2 Tender intake engine

#### 4.2.1 Pack ingestion

- **Purpose.** Turn a raw upload — archive, portal download, email chain — into a
  structured tender pack.
- **Pipeline.** Unpack, classify each file, OCR and layout parse, detect version
  and revision, extract the drawing register, build the document graph.
- **Guardrails.** **Never discard a file.** An unclassifiable file goes to an
  unknown bucket with a human triage task.
- **Evaluation.** Classification accuracy at or above 0.97; revision detection at
  or above 0.98.

#### 4.2.2 Requirement extraction

- **Purpose.** Build the requirement graph.
- **Method.** Clause-aware chunking that never splits a numbered clause, then
  cross-document merge and dedupe by embedding similarity with model
  adjudication, then destination mapping to portal or form fields.
- **Outputs.** Requirements with confidence; anything below 0.75 creates a human
  review task.
- **Guardrails.** The text is verbatim; the paraphrase is stored separately;
  compliance is judged against the verbatim only.
- **Evaluation.** Requirement recall against gold sets at or above 0.98 — missing
  a mandatory requirement is the most expensive failure — and mandatory-status
  precision at or above 0.97.

#### 4.2.3 Addendum reconciliation

- **Purpose.** On each addendum or clarification bulletin, diff against the
  current pack, supersede affected requirements, quantities, drawings and
  deadlines, and notify owners.
- **Guardrails.** Old versions are never deleted. Superseded nodes get a
  `validTo`.

#### 4.2.4 Deadline and submission rules

- **Purpose.** Extract every date, format, page and word limit, file naming rule,
  signature requirement and portal rule into a machine-checkable rule set for the
  submission controller.

> **CONSTRUX position.** Ingestion, classification, native PDF text extraction,
> OCR, table recovery, IFC and ifcZIP parsing, the drawing register and the
> compliance matrix are built, and intake accepts any format or pasted text
> rather than only a multimodal PDF. Three gaps: **addendum reconciliation as a
> diff** — a new pack is analysed rather than differenced, which is where the
> missing `SUPERSEDED_BY` edge bites; the **submission rule set** as
> machine-checkable rules; and the **confidence-triggered review task** at a
> declared threshold.

### 4.3 Scope intelligence engine

#### 4.3.1 Scope decomposition

- **Purpose.** Employer's requirements, specification, drawings and model into a
  scope tree — systems, assets, packages, locations, disciplines, deliverables,
  temporary works, testing, interfaces, exclusions.
- **Outputs.** A coded work breakdown structure, an interface matrix and an
  exclusion list.

#### 4.3.2 Cross-document consistency

- **Purpose.** Pairwise and triangulated checks: drawing against drawing,
  drawing against specification, specification against bill, bill against
  programme, requirements against method, site constraints against resources, and
  model against drawing against pricing quantities.
- **Outputs.** A discrepancy carrying its kind, sources, severity and a suggested
  treatment — clarify, assume, qualify, provisional sum, risk or interface.
- **Guardrails.** **Never silently resolves.** Every discrepancy ends as a
  clarification, assumption, qualification, provisional allowance, risk or
  interface responsibility, enforced by gate `G2_SCOPE_FREEZE` requiring zero
  open discrepancies at medium severity or above.
- **Evaluation.** Detection recall on seeded-defect packs at or above 0.9; false
  positives at or below 15%.

#### 4.3.3 Quantity take-off

- **Purpose.** Derive quantities from the model's quantity sets, from measured
  drawings, and from the bill, then reconcile the three.
- **Outputs.** A quantity carrying its scope, value, unit, method, confidence and
  lineage.
- **Guardrails.** A quantity measured off a raster drawing requires human scale
  confirmation before it may be used in pricing.

> **CONSTRUX position.** Scope decomposition, cross-consistency validation, AI
> take-off from an ITT, quantities from IFC and measured items from a recovered
> table are built, and the platform's existing rule matches the guardrail: a
> reconciliation failure is raised as a record with an owner rather than
> corrected silently. What is missing is the **discrepancy as a first-class
> aggregate with a mandated treatment and a gate that counts open ones**, the
> **seeded-defect evaluation set**, and the **human scale confirmation** before
> a raster-measured quantity may be priced. The last of those is a real safety
> rule and the cheapest to add.

---
#### 4.3.4 Clarification

- **Purpose.** Convert discrepancies and ambiguities into well-formed,
  deadline-aware clarification questions; track answers; propagate answers back
  into requirements and scope.
- **Guardrails.** Drafts only. Sending is human, under `PE-AUT-01`. A strategic
  question — one that reveals pricing strategy — is flagged for the bid manager.

> **CONSTRUX position.** Clarifications, addenda and the tender return register
> are built, and raising a clarification is capability-gated. The **propagation
> of an answer back into the requirement it resolves** is not automatic, and the
> **strategic-question flag** does not exist. The second is a small rule with
> real commercial value: a clarification that tells the employer how you intend
> to price the job is not free.

### 4.4 Estimating and commercial engine

#### 4.4.1 Rate build

- **Purpose.** Build unit rates from labour constants, plant outputs, material
  prices, location factors, escalation indices and productivity assumptions;
  pull historic rates from the learning engine weighted by recency and
  geography.
- **Outputs.** Cost items with a full lineage chain.
- **Guardrails.** Every rate carries a validity date; expired components are
  flagged before price release.

#### 4.4.2 Supplier and subcontractor enquiry

- **Purpose.** Generate package enquiry documents from scope; issue enquiries
  through the procurement port; ingest and normalise quotes for currency, tax,
  exclusions, attendances, programme assumptions and validity.
- **Outputs.** Normalised quotations, a like-for-like comparison and an
  exclusion delta list.
- **Guardrails.** Issuing an enquiry is allowed at level 4. Appointing is denied
  under `PE-AUT-02`.

#### 4.4.3 Preliminaries and temporary works

- **Purpose.** Derive preliminaries from programme duration, staffing, site
  setup, logistics, welfare, security, the temporary works schedule, permits,
  insurances and bonds.
- **Guardrails.** Cross-checks every temporary-works item shown or implied in
  the method against preliminaries pricing.

#### 4.4.4 Commercial challenge — red-team, mandatory

- **Purpose.** Adversarial review of the price: double counting, missing scope,
  arithmetic drift between bill, model and pricing schedule, optimistic
  productivity against tenant benchmarks, expired quotes, insufficient
  supervision, currency mismatch, unpriced interfaces, misapplied mark-ups,
  cash-flow exposure, negative working capital, retention and bond cost,
  uncapped liability, delay damages and design-development exposure.
- **Outputs.** Findings carrying severity, category, evidence, a suggested fix
  and the ACU cost to fix.
- **Guardrails.** A different model vendor and prompt lineage from the rate build
  agent. This is L7.3.

#### 4.4.5 Scenario and risk pricing

- **Purpose.** Monte Carlo over cost and duration distributions across the
  expected, optimistic and P80 cases, delayed mobilisation, supplier inflation,
  low productivity, accelerated completion, client payment delay and an exchange
  shock.
- **Outputs.** Margin distribution, cash-flow curves, a sensitivity tornado and a
  recommended risk allowance.
- **Method.** Distributions defined per risk, three-point or fitted from the
  learning engine, with a correlation matrix the estimator can edit.

#### 4.4.6 Cash flow and bonds

- **Purpose.** Build the S-curve from programme, payment terms, retention, bonds
  and guarantees and any advance payment; compute peak funding and interest cost
  and feed both into the price.

> **CONSTRUX position.** Rate build with full price anatomy, the twenty cost
> heads, supply-chain enquiry and self-delivery pricing, quote normalisation,
> preliminaries, Monte Carlo completion with corrected PERT merge bias, the
> bid cash-flow model, live forward cash flow and the cash reserve test are all
> built, and no bid may be made without a cash-flow model. Two gaps, and they
> are the two that matter here: **the commercial challenge agent does not exist**
> — no adversarial pass attacks a complete price — and **historic rates are not
> weighted by recency and geography** because the calibrated corpus behind that
> weighting is the L7.6 gap. The correlation matrix is also not editable.

### 4.5 Contract and risk engine

#### 4.5.1 Contract parsing

- **Purpose.** Identify the standard form and its amendments, build the clause
  graph and derive the obligations.
- **Guardrails.** The amendment overlay must show a diff against the standard
  form for every modified clause.

#### 4.5.2 Contract risk

- **Purpose.** Score obligations and amendments against tenant risk appetite —
  pay-when-paid, fitness for purpose, uncapped damages, unlimited liability,
  onerous time bars, design responsibility, ground risk allocation, currency
  risk, dispute forum, termination for convenience, set-off rights.
- **Outputs.** A contract risk register, a recommended qualifications and
  departures schedule, and walk-away flags.
- **Guardrails.** A legal-advice disclaimer object is attached, and a flagged
  item requires review by the legal role at gate `G3_CONTRACT_POSITION`.

#### 4.5.3 Qualifications and departures

- **Purpose.** Draft the tender qualifications and departures schedule from
  approved assumptions, discrepancies and contract risks, and keep it consistent
  with the pricing and the programme.

#### 4.5.4 Insurance, bond and compliance

- **Purpose.** Verify required insurances, bonds, guarantees and accreditations
  against the evidence registry and produce a gap list with lead times.

> **CONSTRUX position.** Clause extraction, the obligation register, the
> Construction Act compliance engine, the contract obligations calendar and the
> variation control matrix are built. Missing: the **standard-form library with
> an amendment diff** (L7.1 again), the **risk-appetite scoring model** as a
> tenant policy rather than a general assessment, the **walk-away flag**, and
> the insurance and bond verification, which cannot exist before the evidence
> registry does.

### 4.6 Planning engine

#### 4.6.1 Programme generation

- **Purpose.** Work breakdown, quantities, production rates, crews, calendars,
  logistics, design release, procurement lead times, access, testing and
  commissioning logic and sectional completions into a critical-path programme
  through the scheduling port.
- **Outputs.** A tender programme, its activity list, its logic and resource
  histograms.

#### 4.6.2 Programme challenge — red-team, mandatory

- **Checks.** Open ends, excessive constraints, missing logic, impossible
  sequences, procurement disconnected from installation, design disconnected
  from approvals, weak commissioning logic, hidden negative float, unrealistic
  calendars, resource over-allocation, unsupported productivity and
  critical-path fragility.
- **Outputs.** Findings, a DCMA-14-style report, and any custom tenant rules.

#### 4.6.3 Scenario and time-impact analysis

- **Purpose.** What-ifs for late possession, late design, supplier delay and
  acceleration; time-impact fragnets; resource-levelling options, feeding the
  cost scenarios.

#### 4.6.4 Programme narrative

- **Purpose.** Produce the narrative bound to programme data. Every stated
  duration and milestone must resolve to an activity — **evidence binding applies
  to numbers, not only to claims.**

> **CONSTRUX position.** Programme generation, critical path, PERT, Monte Carlo
> completion, the lookahead and PPC, recovery options and the cross-consistency
> check of contract against programme are built. The **programme challenge as an
> independent adversarial pass** is not, and neither is the **DCMA-14 report**.
> The last line of §4.6.4 is the sharpest sentence in this document and the
> platform already half-obeys it: a generated narrative is sourced to records
> rather than composed freely, but there is no gate refusing a narrative whose
> number does not resolve to an activity.

### 4.7 Bid composition engine

#### 4.7.1 Response planner

- **Purpose.** For each scored requirement produce a response plan: key
  messages, evidence needed, win themes, a mapping to the evaluator's scoring
  criteria, and a word budget.

#### 4.7.2 Response drafting

- **Purpose.** Draft in the tenant's house style, with every factual claim tagged
  to its evidence, and every unsupported claim emitted as an evidence request
  task.
- **Guardrails.** The L7.2 gate. No superlative without evidence. No content from
  another bid except approved lessons and case studies.

#### 4.7.3 Evaluator simulation — red-team

- **Purpose.** Score each response as the employer's evaluator would, using the
  published scoring criteria and evaluator guidance, and identify gaps, waffle,
  unanswered sub-questions and missing evidence.
- **Outputs.** A predicted score with its rationale, and an improvement list.
- **Evaluation.** Correlation between the predicted score and the actual
  feedback score, tracked by the learning engine.

#### 4.7.4 Consistency

- **Purpose.** Cross-check every response, the price, the programme, the
  organisation chart, the method statement, the risk schedule and the
  qualifications for contradiction — the programme says 52 weeks and the
  response says 48; the chart names a project manager whose CV is not in the
  pack; the method assumes a crane that is not in the preliminaries.

#### 4.7.5 Design support agents

Method statement, logistics and site layout with generated drawings,
organisation chart, social value against a TOMs framework, health and safety
response that is CDM 2015 aware and never claims to replace a competent person,
environmental and carbon aligned to PAS 2080 and estimated from quantities, and
the quality plan.

> **CONSTRUX position.** The bid response pipeline plans one section per
> deliverable needing prose, writes one section per pass so no single call
> carries a whole submission, resumes where a pass was cut off, numbers the pack
> under its own reference prefix and refuses to issue an incomplete pack. The
> document engine generates the safety, planning and quality documents with
> customer branding and marks AI-authored narrative with its provider, model
> class and prompt version. Missing: the **response plan with a word budget and
> a scoring-criteria mapping**, the **evaluator simulation** — which is the
> single highest-value red-team agent in this document, because it is the only
> one whose accuracy can be measured against real feedback — and the
> **cross-artefact consistency agent**. The last one is worth noting: the
> platform reconciles scope to price and contract to programme, but nothing
> checks a response's prose against the programme's arithmetic.

### 4.8 Submission engine

#### 4.8.1 Submission controller

- **Purpose.** Assemble deliverables against the submission rule set and validate
  every mandatory field, filename, page and word limit, format, signature,
  pricing reconciliation — bill total equals pricing schedule total equals the
  form of tender — certificate validity against the deadline, unapproved
  assumptions and contradictory answers, producing a readiness report.
- **Gate.** `G5_SUBMISSION_RELEASE` requires every mandatory requirement
  complete, a readiness score of 100 on the hard rules, and approval by the bid
  manager and the commercial director, plus legal where the contract is flagged.
- **Upload.** Through the portal port only after the gate, then confirm receipt
  and store the confirmation artefact's hash.
- **Guardrails.** A human starts the upload; the agent performs and verifies it.
  It refuses to start inside a configured buffer before the deadline — four hours
  by default — without a director override.

#### 4.8.2 Post-submission

Clarification handling, best-and-final-offer and negotiation pack preparation,
presentation preparation, outcome capture and feedback ingestion.

> **CONSTRUX position.** The machine check before issue exists and refuses
> rather than warns, which is the shape of `G5`. What is missing is everything
> that depends on the **submission rule set** — filenames, page and word limits,
> formats — and the **portal port**, so there is no upload, no receipt and no
> confirmation artefact. The four-hour buffer is a good rule with a real failure
> behind it and costs almost nothing to add once an upload exists.

### 4.9 Award and handover-to-delivery engine

#### 4.9.1 Bid-to-baseline conversion

On award, transform approved bid objects into delivery objects and publish them
to the delivery engines through the shared event spine.

| Bid object | Delivery object | Event |
|---|---|---|
| Tender programme | Contract baseline programme | `delivery.baseline.programme_set` |
| Bid risk | Live risk | `delivery.risk.opened` |
| Price build-up | Cost budget and control accounts | `delivery.budget.set` |
| Assumption | Validation task or change trigger | `delivery.assumption.to_validate` |
| Qualification | Contract reconciliation item | `delivery.contract.reconcile` |
| Quotation | Procurement package | `delivery.procurement.package_created` |
| Method statement | Controlled method | `delivery.method.registered` |
| Employer requirement | Compliance obligation | `delivery.obligation.registered` |
| Promised KPI | Performance commitment | `delivery.kpi.committed` |
| Resource plan | Mobilisation demand | `delivery.mobilisation.demand` |
| Cash-flow model | Cash baseline | `delivery.cash.baseline_set` |

- **Guardrails.** Only approved objects convert. An unapproved assumption becomes
  a blocking task.

> **CONSTRUX position.** The eleven-stage chain runs end to end and the bid
> feeds delivery, which is §18.5's continuity claim. What does not exist is this
> as **one governed conversion with a guardrail**: today the objects flow because
> the engines share a ledger, not because an award event converts an approved
> set and blocks on the unapproved ones. Making it explicit would close the gap
> between "the data is there" and "the conversion is a decision somebody made".

### 4.10 Learning engine — L7.6

#### 4.10.1 Outcome capture

Records win and loss, scores, feedback, competitor pricing where disclosed,
clarification patterns and evaluator comments.

#### 4.10.2 Post-award variance

Compares tender assumptions, rates and durations against delivery actuals and
produces calibration deltas per rate library item, productivity assumption, risk
distribution and win-probability model.

#### 4.10.3 Lesson promotion

Proposes anonymised, tenant-scoped lessons requiring human approval at gate
`G7_LESSON_PROMOTE` before entering the priors corpus or the rate library.

- **Guardrails.** Unverified agent output never becomes institutional truth. A
  promoted lesson carries its source bids and its approver.

> **CONSTRUX position.** Lessons learned as corporate memory across projects,
> the cost intelligence database built from committed records, and forecast
> accuracy measured by comparing estimate-at-completion snapshots against the
> final account are all built — and the human-approval rule is already the
> platform's, expressed as memory write access declared per layer per agent.
> What is missing is the **loop closing on the bid**: nothing feeds delivery
> variance back into a tender rate or a win probability. This is the whole of
> L7.6 and it is the property that makes the system *self-improving* rather than
> merely thorough.

### 4.11 Bid executive orchestrator

- Maintains a consolidated bid position: readiness percentage, open findings,
  gate status, ACU spend, deadline risk and the top five decisions needed.
- Routes events to engines and resolves routine cross-engine coordination — an
  addendum triggers a consistency re-run, a re-price of affected items and a
  re-challenge.
- Escalates to humans through the decision queue. **Never makes gate decisions.**
- Runs a configurable daily standup brief per bid.

> **CONSTRUX position.** The morning briefing is this, at estate level rather
> than per bid, and the rule that the orchestrator never decides is already
> enforced by the catalogue rather than by convention. **Targeted re-run on an
> addendum** does not exist, for the same reason as §4.2.3: without the graph
> edges there is nothing to invalidate selectively.

---

## 5. Bid lifecycle state machine

```
DISCOVERED → QUALIFIED → [G0] DECIDED_PURSUE
  → PACK_INGESTED → REQUIREMENTS_MAPPED → [G1 compliance baseline]
  → SCOPE_DECOMPOSED → [G2 scope freeze]
  → CONTRACT_POSITIONED → [G3]
  → PROGRAMMED → PRICED → [G4 price release]
  → COMPOSED → CONSISTENT → [G5 submission release]
  → SUBMITTED → CLARIFYING → (BAFO) → OUTCOME_RECORDED
  → [G6 award] → BASELINE_HANDED_OVER → [G7 lessons promoted] → CLOSED
```

An addendum re-opens affected downstream states by **targeted invalidation** —
only nodes with an edge to a changed node are marked stale — never by a full
rerun.

> **CONSTRUX position.** The lifecycle exists as stages with gates and
> definitions of done, and the tender stage gate refuses rather than warns. The
> **targeted invalidation** rule is the one genuinely new idea in this section
> and the reason the requirement graph needs to be a graph. Without edges, an
> addendum forces either a full re-analysis or a judgement call about what to
> redo, and the second is how a bid team misses a superseded requirement.

---

## 6. Data model

A reference schema for the event store and its bitemporal projections.

```sql
-- Event store, append-only
CREATE TABLE bid_events (
  seq BIGSERIAL PRIMARY KEY,
  event_id UUID NOT NULL UNIQUE,
  tenant_id UUID NOT NULL,
  bid_id UUID,
  aggregate_type TEXT NOT NULL,
  aggregate_id UUID NOT NULL,
  aggregate_version INT NOT NULL,
  type TEXT NOT NULL,
  actor JSONB NOT NULL,
  causation_id UUID, correlation_id UUID,
  valid_from TIMESTAMPTZ NOT NULL,
  valid_to TIMESTAMPTZ,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  acu_cost NUMERIC(12,4) DEFAULT 0,
  prev_hash BYTEA, hash BYTEA NOT NULL,
  data JSONB NOT NULL,
  UNIQUE (aggregate_id, aggregate_version)
);
CREATE INDEX ON bid_events (tenant_id, bid_id, recorded_at);
CREATE INDEX ON bid_events USING GIN (data jsonb_path_ops);
ALTER TABLE bid_events ENABLE ROW LEVEL SECURITY;

-- Bitemporal projection
CREATE TABLE requirements_current (
  req_id UUID, tenant_id UUID NOT NULL, bid_id UUID NOT NULL,
  text TEXT NOT NULL, normalised_text TEXT,
  classification TEXT, mandatory_status TEXT,
  owner_id UUID, status TEXT,
  confidence_extraction REAL, confidence_interpretation REAL,
  destination JSONB, sources JSONB,
  valid_from TIMESTAMPTZ NOT NULL, valid_to TIMESTAMPTZ,
  recorded_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (req_id, valid_from, recorded_at)
);

-- Evidence
CREATE TABLE evidence_objects (
  ev_id UUID PRIMARY KEY, tenant_id UUID NOT NULL,
  kind TEXT NOT NULL, claim TEXT NOT NULL,
  source_uri TEXT NOT NULL, source_hash BYTEA NOT NULL,
  issued_by TEXT, issued_at DATE, expires_at DATE,
  status TEXT NOT NULL, verified_by UUID, verified_at TIMESTAMPTZ,
  scope JSONB NOT NULL, reuse_count INT DEFAULT 0
);

-- Lineage DAG
CREATE TABLE lineage_nodes (
  node_id UUID PRIMARY KEY, tenant_id UUID, bid_id UUID,
  kind TEXT, ref TEXT, value NUMERIC, unit TEXT, currency CHAR(3),
  fx JSONB, valid_until DATE, confidence REAL, meta JSONB
);
CREATE TABLE lineage_edges (
  child UUID REFERENCES lineage_nodes,
  parent UUID REFERENCES lineage_nodes,
  PRIMARY KEY (child, parent)
);

-- Chunks and vectors
CREATE TABLE doc_chunks (
  chunk_id UUID PRIMARY KEY, tenant_id UUID, bid_id UUID,
  doc_id UUID, doc_version INT,
  page INT, bbox JSONB, clause_ref TEXT, text TEXT,
  embedding vector(1024)
);
CREATE INDEX ON doc_chunks USING hnsw (embedding vector_cosine_ops);
```

Full schema: 41 tables, with **one migration owner** so the two runtimes cannot
drift.

> **CONSTRUX position.** The Postgres ledger schema behind `LEDGER_POSTGRES_MODE`
> already carries event id, tenant, aggregate, type, actor, correlation,
> recorded time, previous hash and hash, with row-level security and append-only
> rules, verified against a live Postgres 16 in continuous integration. The four
> columns it does not have are **`bid_id`**, **`valid_from` and `valid_to`**, and
> **`acu_cost`** — spend is settled in its own ledger rather than carried on the
> event. Adding the two time columns is the concrete form of closing L7.4, and it
> is a migration plus a read path, not a rewrite. The evidence, lineage and
> chunk tables have no equivalent; the lexical index that finds near-duplicates
> works without vectors today, and embeddings are charged and optional.

---

## 7. Ports — the adapter contract

All ports are interfaces. Excerpt:

```ts
export interface DocumentStorePort {
  put(tenant: string, key: string, body: Buffer, meta: Record<string, string>):
    Promise<{ uri: string; hash: string }>;
  get(uri: string): Promise<Buffer>;
  signedUrl(uri: string, ttlSec: number): Promise<string>;
}

export interface CDEPort {
  listDocuments(project: string, filter: DocFilter): AsyncIterable<CDEDoc>;
  download(docRef: string): Promise<Buffer>;
  subscribe(project: string, handler: (e: CDEEvent) => void): Unsubscribe;
  upload(project: string, doc: UploadSpec): Promise<CDEDoc>;
}

export interface PortalPort {
  searchNotices(q: NoticeQuery): Promise<Notice[]>;
  fetchPack(noticeId: string): Promise<PackManifest>;
  getSchema(noticeId: string): Promise<SubmissionSchema>;
  upload(noticeId: string, bundle: SubmissionBundle): Promise<UploadReceipt>;
  confirmReceipt(receiptId: string): Promise<Confirmation>;
}

export interface EstimatingPort {
  importBoQ(file: Buffer): Promise<BoQ>;
  pushRates(bidId: string, items: CostItem[]): Promise<void>;
  pullRates(bidId: string): Promise<CostItem[]>;
}

export interface SchedulingPort {
  buildProgramme(spec: ProgrammeSpec): Promise<Programme>;
  runCPM(prog: Programme): Promise<CPMResult>;
  export(prog: Programme, fmt: 'XER' | 'MPP' | 'PP' | 'XML'): Promise<Buffer>;
}

export interface LLMPort {
  complete(taskClass: TaskClass, req: LLMRequest): Promise<LLMResponse>;
  embed(texts: string[]): Promise<number[][]>;
}

export interface EventBusPort {
  publish(e: Envelope): Promise<void>;
  subscribe(topic: string, h: Handler): Unsubscribe;
}

export interface WorkflowPort {
  start(def: string, input: unknown): Promise<RunHandle>;
  signal(run: RunHandle, sig: string, payload: unknown): Promise<void>;
}

export interface BillingPort {
  reserve(tenant: string, acu: number): Promise<Reservation>;
  settle(res: Reservation, actual: number): Promise<void>;
  balance(tenant: string): Promise<number>;
}

export interface IdentityPort {
  verify(token: string): Promise<Principal>;
  sign(principal: Principal, payload: unknown): Promise<Signature>;
}
```

**Adapter conformance.** Each port ships with a contract test suite. An adapter
is accepted only when the suite passes. In embedded mode the engine is packaged
so a third-party platform can host it inside its own authentication, database
and bus.

> **CONSTRUX position.** Four of these nine ports exist under different names and
> pass their own tests: the document store is the tenant-scoped evidence store
> with an S3-compatible object store behind it; the model port is the
> orchestrator with health-aware routing and a wallet refusal; billing is
> reserve-then-settle against the ACU wallet, which is exactly this interface;
> identity is the token verifier and the signature ceremony. Five do not exist
> at all: **CDE, portal, estimating, scheduling and workflow**. Those five are
> the connector ecosystem §18.14 already named as the largest `[NEW]` item, and
> the portal port is the one that unlocks the most: without it, discovery,
> upload, receipt and confirmation are all manual.
>
> **On the adapter conformance suite** — this is the right discipline and the
> platform already has its shape. A port with no contract test is a port that
> works with exactly one adapter.

---

## 8. What Level 7 would cost, in order

Ordered by value per unit of work, from the CONSTRUX position notes above.

1. **The evidence registry and its gate** (`EvidenceObject`, `GE-EV-01`).
   Closes L7.2. Turns the platform's existing discipline into a refusal, and it
   lands where the bid response pipeline already refuses to issue an incomplete
   pack. Nothing else on this list is worth more per line of code.
2. **The lineage DAG projection and the click-through view.** Closes L7.5 over
   records the platform already stores. A projection, not a new write path.
3. **Bitemporal columns on the ledger** — `valid_from`, `valid_to` — plus the
   as-known-at read path. Closes L7.4. A migration and a read path.
4. **The requirement graph's edges** — `dependsOn`, `SUPERSEDED_BY`,
   `CONFLICTS_WITH` — and targeted invalidation on an addendum. Makes §4.2.3 and
   §4.11 possible and stops a superseded requirement being missed.
5. **The evaluator simulation red-team agent.** The only red-team agent whose
   accuracy can be measured against real feedback, which makes it the right one
   to build first and the right one to prove L7.3 with.
6. **The portal port.** Unlocks discovery, upload, receipt and confirmation in
   one adapter, and it is the connector with the clearest commercial return.
7. **The standard-form clause library with amendment overlay.** Closes L7.1.
   The largest single piece of work here, and the one that most needs a
   construction professional rather than an engineer.
8. **The learning loop** — post-award variance feeding tender rates and win
   probability. Closes L7.6 and is what makes the system self-improving. It
   needs the lineage DAG first, because a calibration delta with no lineage is a
   number nobody can defend.

Three of the seven properties are absent today: adversarial self-challenge, the
evidence registry as a gate, and bitemporal state. Items 1, 3 and 5 close them.
The rest deepen properties the platform already has.

**None of this is in `docs/STATE.md` as built, and none of it is claimed there.**
This document is a specification. `STATE.md` is the record.
