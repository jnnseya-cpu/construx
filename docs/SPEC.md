# CONSTRUX — the specification, as given

The product owner's own words, recorded verbatim as they were given, with an
implementation state against each clause. This file is the requirement;
`docs/STATE.md` is what exists. Where the two disagree, this file wins and
`STATE.md` is behind.

Nothing here is paraphrased. A requirement rewritten in an engineer's words is a
requirement quietly renegotiated.

Status vocabulary, used strictly:

- **BUILT** — implemented, tested, and verified against a running system.
- **PARTIAL** — some of the clause is implemented; what is missing is named.
- **NOT BUILT** — nothing exists. Never written against something that half works.

---

## The standing principle

> THE MAIN PRINCIPLE FROM THE START IS NOTHING TO REMOVE, REPLACE OR DELETE,
> UNLESS A MORE ENHANCED REQUIREMENT IS SENT

Given by the product owner and binding on every change from here. It governs
this file and the code alike, and it is stronger than the operating directive's
rule 3 — which says *do not touch finished work without cause*. This says
something further: **a later specification adds to what came before unless it
explicitly supersedes it.**

Three consequences, stated so they are not rediscovered:

**A new section does not delete an old one.** The consolidated v1.0 document
arriving now sits alongside Parts A to H rather than replacing them. Where the
two describe the same thing, both are recorded and the difference is named. Where
the newer one is genuinely more specific it supersedes — and that is said out
loud, with the clause it supersedes quoted, never done silently.

**A capability the specification stops mentioning stays built.** Absence from a
later document is not an instruction to remove. `Reject` on the recommendation
panel is the live example: the Build Standard names four actions and does not
name it, and it stays, because a finding that is wrong has to be recordable as
wrong. Removing it would have destroyed the platform's only measure of its own
accuracy in order to match a list.

**A settled decision is not reopened by a document that does not mention it.**
The nine settled decisions in `STATE.md` and the recorded reasoning beside each
one hold until something explicitly overturns them.

What this does not protect: a defect. Correcting behaviour that was wrong —
a dead code path, a mis-scoped filter, a figure computed from the wrong record —
is not removal, and each one is recorded in `STATE.md` with what changed and why.

---

## PART A — WHAT WE ARE BUILDING

> CONSTRUX is an AI-agent-operated construction operating system that governs the
> complete asset lifecycle: Concept → Design → Tender → Construction →
> Commissioning → Handover, extending into 30+ years of O&M. It is not a
> dashboard product, not a document store, and not a project management app. It
> is the intelligent control layer through which a contractor, developer or
> delivery organisation runs the entire project — and inside which a fleet of
> specialist AI agents does the repetitive, analytical and administrative work
> that today consumes 40–60% of professional staff time.
>
> Every action is captured, time-stamped, versioned and traceable. Every module
> is connected. No data is re-entered anywhere in the lifecycle. No handoff is
> manual. No decision is unrecorded. The bid price becomes the contract sum; the
> contract sum drives the CVR; awarded packages become subcontracts and
> commitments; field records become commercial and claims evidence; commissioning
> records become the handover pack; the handover pack becomes the asset record.
> One golden thread, machine-enforced.

---

## THE BUILD STANDARD

Applies to every module. This is the acceptance test for "finished".

> One clear workflow entry point. Visible state progression at every stage. AI
> that performs a defined, specific job — never vague chat. Automatic downstream
> handoff with zero re-entry. Audit trail by default on every action. If a screen
> does not tell the user what is happening, what changed, what is at risk, what is
> costing money and what needs action today — it is not finished.

Six tests, applied per screen:

1. One clear workflow entry point
2. Visible state progression at every stage
3. AI that performs a defined, specific job — never vague chat
4. Automatic downstream handoff with zero re-entry
5. Audit trail by default on every action
6. The screen states: what is happening · what changed · what is at risk · what
   is costing money · what needs action today

---

## A1 — NON-NEGOTIABLE PLATFORM RULES

### RULE 1 — Autosave everything, lose nothing, learn from everything

> - Save every 2–5 seconds during active editing; instantly on field blur and
>   before any navigation event.
> - All AI conversations, prompts and outputs saved automatically; all drafts
>   retained even when incomplete.
> - All documents and structured records versioned with rollback; never overwrite
>   without a version-history entry.
> - Offline queue for field users with conflict-safe sync on reconnection;
>   autosave state visible in every module UI.

| Clause | State |
|---|---|
| Versioned records, rollback, never overwrite without history | **BUILT** — append-only ledger; every write is an event carrying a JSON Patch diff and before/after state hashes; replay reconstructs any point in time |
| Offline queue, conflict-safe sync on reconnection | **BUILT** — `frontend/lib/outbox.js`, IndexedDB, `baseStateHash` for conflict detection, `backend/src/field/sync.ts` for operation-id idempotency |
| AI outputs saved automatically | **BUILT** — `AI_REQUEST_QUEUED`, `AI_EXECUTION_COMPLETED`, `AI_EXECUTION_FAILED` |
| AI *conversations and prompts* saved | **PARTIAL** — executions are recorded with their input refs; conversational turns are not persisted |
| Save every 2–5 seconds during active editing | **NOT BUILT** |
| Instant save on field blur and before navigation | **NOT BUILT** |
| Incomplete drafts retained | **NOT BUILT** — closing a command panel discards it |
| Autosave state visible in every module UI | **NOT BUILT** |

### RULE 2 — Zero data re-entry

> - Bid data flows to main contract; contract values flow to CVR, applications and
>   procurement; tender awards flow to subcontracts and commitments; field records
>   feed commercial, programme and claims intelligence.
> - Every module produces structured outputs consumed by downstream modules.
>   Breaking the chain anywhere raises an exception alert to the Commercial Manager.

| Clause | State |
|---|---|
| Bid → contract → CVR/applications/procurement → subcontracts → commitments; field → commercial/programme/claims | **BUILT** — proven end to end by the eleven-stage chain test |
| Breaking the chain raises an exception alert to the Commercial Manager | **BUILT** — `consistencyReport` checks six links by reference (Contract←BidSubmissionPack, Subcontract←RFQ, Commitment←Subcontract, PaymentCycle←Contract, PaymentApplication←PaymentCycle, CVR←Contract); `escalateChainBreaks` records a `ChainException` and notifies `COMMERCIAL_MANAGER` / `PROJECT_DIRECTOR`. Raised once per break, closes itself when the link traces again |

Three things about that check are worth stating, because each was a defect
before it was a feature.

**The keys are the ones the engines write, not the ones the names suggest.** A
`Commitment` names its subcontract in a field called `contractId`; a
`Subcontract` names an `rfqId` and not a contract. The first draft asserted
`estimateId` and `subcontractId` — plausible names that exist nowhere — and would
have reported a total break on every correctly connected project on day one.

**A missing upstream skips the link rather than failing it.** A contract on a job
that was never tendered through CONSTRUX is negotiated or novated work, not a
broken chain. Flagging it would have taught people to ignore the check, which is
the same as not having one.

**The CVR now records the contract it was computed against.** It always knew —
`publishCVR` reads the contract to get the sum — and never wrote it down, so a
published CVR could not name the contract sum it started from. Worse,
`consistencyReport` reads the *latest* executed contract where `publishCVR` reads
the *first*, so on a project with a supplemental agreement the two were not
necessarily the same document. That is fixed at source rather than reported.

Detection and escalation are deliberately separate. The report stays read-only,
because opening a screen must never be the act that alerts somebody, or every
dashboard refresh becomes an escalation.

### RULE 3 — Human-in-the-loop for high-risk actions

> Agents may draft, recommend, compare, warn, simulate and pre-populate. Humans
> approve. Approval is system-enforced (not conventional) before: contractual
> notices, payment submissions, claims, programme baseline changes, design
> approvals, commercial forecasts used externally, HSE-critical decisions,
> regulatory submissions (including BSR gateway submissions), client-facing
> reports, and subcontractor instructions.

The enforcement mechanism is **BUILT** and is structural: `aiAllowed` defaults to
`false` in the closed event catalogue, so 153 of 201 event types are human-only by
construction rather than by a rule somebody applied. All twelve agents hold
`OBSERVE` or `PROPOSE`; **none holds `ACT`**, so no agent can execute anything
without a named human approving it.

| Category | State |
|---|---|
| Contractual notices | **BUILT** — `NOTICE_ISSUED`, `PAYMENT_NOTICE_ISSUED`, `PAY_LESS_NOTICE_ISSUED` all human-only |
| Payment submissions | **BUILT** — human-only |
| Claims | **BUILT** — `CLAIM_OPENED` human-only; `CLAIM_ASSESSED` and `CLAIM_EVIDENCEPACK_BUILT` are AI-writable, which the rule expressly permits ("draft, recommend, compare… pre-populate") |
| Programme baseline changes | **BUILT** — human-only |
| **Design approvals** | **NOT BUILT** — no design approval event exists in the catalogue |
| Commercial forecasts used externally | **PARTIAL** — production is AI-assisted and human-invoked; export is human-driven and audience-redacted. No separate approval gate on *external use* |
| HSE-critical decisions | **BUILT** — incidents and permits human-only; observations and forecasts AI-writable, which is drafting not deciding |
| **Regulatory submissions, incl. BSR gateway** | **NOT BUILT** — no Building Safety Act gateway events exist |
| Client-facing reports | **BUILT** — human-only |
| Subcontractor instructions | **BUILT** — human-only |

### RULE 4 — Every AI output must be traceable

> No agent output is accepted without evidence. Every agent answer carries:
> finding, supporting evidence, source links, confidence score, recommended
> action, commercial impact, programme impact, contract impact, risk level
> (Low/Medium/High/Critical), next step, and Approval Required: Yes/No. No vague
> answers. No unsupported conclusions. No generic advice.

Eleven required fields. Against `Finding` and `ProposedCommand`:

| Required field | State |
|---|---|
| Finding | **BUILT** — `summary` (what was observed) and `consequence` (why it matters) |
| Supporting evidence | **BUILT** — `evidence[]`, each with `refType`, `refId`, `note`. An agent that cannot name its source cannot raise a finding |
| Source links | **PARTIAL** — refs are resolvable through the lineage route; the finding does not carry a link |
| **Confidence score** | **NOT BUILT** |
| Recommended action | **BUILT** — `command` plus a plain-language `effect` |
| **Commercial impact** | **NOT BUILT** — `estimatedAcuMinor` is the cost of running the AI, not the commercial impact of the finding |
| **Programme impact** | **NOT BUILT** |
| **Contract impact** | **NOT BUILT** |
| Risk level (Low/Medium/High/Critical) | **PARTIAL** — `severity` exists as `INFO / ATTENTION / URGENT`, which is three levels against the four required and different words |
| Next step | **BUILT** — `command`, and `ifDeclined` for what happens if it is not done |
| Approval Required: Yes/No | **BUILT** — `autonomy`; `PROPOSE` always requires a human |

### RULE 5 — The immutable audit event

> Every user and agent action generates an append-only AuditEvent — the
> intelligence backbone of the platform.

| Required field | Type | CONSTRUX | State |
|---|---|---|---|
| `event_id` | uuid — ULID, monotonic, immutable | `eventId` (ULID) | **BUILT** |
| `actor_type` | HUMAN \| AGENT \| SYSTEM | `actor.refType`: `User` \| `AI` \| `System` | **BUILT** — same three, different words |
| `user_id` / `agent_id` | uuid | `actor.refId` | **BUILT** — agents are first-class actors |
| `org_id` | uuid | `tenantId` | **BUILT** |
| `project_id` | uuid | `projectId` | **BUILT** |
| **`role_at_action`** | string — role snapshot at the moment of action | — | **NOT BUILT** |
| `ts_utc` | timestamptz, server-authoritative | `timestamp` | **BUILT** — set by the ledger; no route can supply one, and offline capture preserves device time separately in `deviceTimestamp` rather than backdating |
| `module` | string | the catalogue's `group` per event type | **PARTIAL** — derivable from the code, not carried on the event |
| `object_type`, `object_id` | string | `entity.refType`, `entity.refId` | **BUILT** |
| `prev_value`, `new_value` | jsonb — full before/after diff | `diff` (JSON Patch) + `beforeHash` / `afterHash` | **PARTIAL** — the change is exactly reconstructible by replay, but the event does not carry the two documents |
| **`reason`** | text — user comment or agent rationale | — | **NOT BUILT** as a field; some commands require a reason in the body, which lands in the entity state rather than on the event |
| `ai_involved` | bool | presence of the `ai` block | **BUILT** |
| **`ai_confidence`** | float 0.00–1.00 | — | **NOT BUILT** |
| **`lifecycle_state`** | enum — project state when the event fired | `currentPhase()` exists and is used for authorisation | **NOT BUILT** — never written onto the event |
| `hash_prev`, `hash_self` | sha256, hash-chained | `previousChainHash`, `chainHash` | **BUILT** — tamper evidence verified by replay, not asserted |

---

## A2 — THE LIFECYCLE STATE ENGINE — THE SPINE OF THE ENTIRE PLATFORM

> The lifecycle is not navigation. It is a finite-state machine on the Project
> object. Each state activates specific data schemas, enables specific AI agents,
> changes dashboard KPIs, and adjusts permissions. State transitions are
> permission-controlled gate reviews that emit events and are impossible to
> bypass.

| State | RIBA Map | Entry Gate (machine-checked) | Exit Gate (machine-checked) | Agents Activated |
|---|---|---|---|---|
| CONCEPT | RIBA 0–1 | Project record created; client brief captured | Feasibility approved; budget envelope signed off; Go/No-Go = GO | Feasibility, Benchmark Cost, Consents, Carbon/ESG |
| DESIGN | RIBA 2–4 | Concept gate passed; design team appointed; EIR/BEP loaded | Stage 4 design frozen; DRM complete; cost plan within envelope; BSR Gateway 2 ready (HRB) | Design Coordination, Scope Gap, Spec Intelligence, Cost Plan, BIM/Twin |
| TENDER | RIBA 4–5 | Design freeze; tender docs complete; bid/no-bid = BID | Bid submitted & locked, or award received (contractor side); contract executed | Tender Intelligence, Estimating, Contract Risk, Procurement |
| CONSTRUCTION | RIBA 5 | Contract executed; baseline programme approved; F10 notified; construction phase plan live | PC readiness score ≥ threshold; commissioning plan approved | All delivery agents (see Part E) |
| COMMISSIONING | RIBA 5–6 | Systems mechanically complete per area; ITP closure ≥ threshold | All systems tested & witnessed; defects below PC threshold; O&M data ≥ 95% complete | Commissioning, Quality, Handover (pre-activated) |
| HANDOVER | RIBA 6 | Commissioning exit gate passed; PC certificate issued | Handover pack accepted; Golden Thread complete (HRB Gateway 3); asset records activated in FM | Handover, Golden Thread Compliance, FM Asset |
| OM | RIBA 7 | Handover accepted; DLP started | Never exits — 30+ year data horizon | FM Asset, Predictive Maintenance, Compliance |

### State of implementation

The spine exists. `backend/src/lifecycle/phases.ts` holds the seven states in
order, `PROJECT_PHASE_TRANSITIONED`, `GATE_REVIEW_SUBMITTED` and
`GATE_REVIEW_DECIDED` are all human-only events, and a transition is refused
unless the gate evaluates — so transitions are already impossible to bypass and
already emit events. Permissions and engine availability are already phase-bound.

What is missing is the *content* of the gates, and it is missing in a way that
matters: a gate with one weak criterion is a gate that always opens.

| Clause | State |
|---|---|
| Finite-state machine on the Project object | **BUILT** — seven states, ordered, `OPERATIONS` is this codebase's name for `OM` |
| Transitions are permission-controlled, emit events, cannot be bypassed | **BUILT** |
| Each state adjusts permissions and enables specific agents | **PARTIAL** — permissions and engine contracts are phase-bound; the per-state agent activation list in the table above is not modelled |
| Each state activates specific data schemas | **PARTIAL** — entity schemas are registered globally, not per phase |
| Each state changes dashboard KPIs | **PARTIAL** — screens are phase-aware; there is no per-state KPI set |
| **Entry gates** | **NOT BUILT** — no entry criteria exist for any state. Only exit criteria are modelled |
| **RIBA mapping** | **NOT BUILT** — no RIBA stage is recorded against a state |
| Exit gate — CONCEPT | **PARTIAL** — has "a scope package exists". Required: feasibility approved, budget envelope signed off, Go/No-Go = GO |
| Exit gate — DESIGN | **PARTIAL** — has "design maturity assessed". Required: Stage 4 frozen, DRM complete, cost plan within envelope, BSR Gateway 2 ready for a higher-risk building |
| Exit gate — TENDER | **BUILT** — estimate frozen and contract executed, which matches |
| Exit gate — CONSTRUCTION | **WRONG PLACE** — the two criteria modelled (baseline approved, budget approved) are *entry* conditions in the specification. The required exit gate is a PC readiness score above a threshold and an approved commissioning plan, and neither exists |
| Exit gate — COMMISSIONING | **PARTIAL** — has "one accepted commissioning test". Required: all systems tested and witnessed, defects below the PC threshold, O&M data at least 95% complete |
| Exit gate — HANDOVER | **PARTIAL** — has pack accepted and asset register populated. Missing: Golden Thread complete for HRB Gateway 3 |
| OM never exits | **BUILT** — no exit criteria, by construction |

### A2 continued — transitions, gates and the O&M horizon

> - Every Project has lifecycle_state; transitions emit PROJECT_STATE_CHANGED
>   with gate evidence bundle attached.
> - Gate checks are computed, not asserted: each gate is a checklist of
>   machine-verifiable conditions with an evidence link per condition. A human
>   chair approves the gate; the system blocks approval while any mandatory
>   condition is red.
> - Reverse transitions (e.g. COMMISSIONING → CONSTRUCTION on failed testing) are
>   permitted with authority level ≥ Project Director and mandatory reason; they
>   are rare, loud and fully audited.
> - O&M is a 30+ year data horizon, not a final page: asset twins persist
>   post-handover; maintenance logs, failures and upgrades accumulate; agents
>   learn longitudinally per asset.

| Clause | State |
|---|---|
| Every Project has `lifecycle_state` | **BUILT** — `phase` on the project record, driving authorisation and engine availability |
| Transitions emit an event | **BUILT** — `PROJECT_PHASE_TRANSITIONED`, human-only |
| Gate evidence bundle attached to the transition | **BUILT** — `applyPhaseChange` writes an `EvidenceItem` carrying the whole `gateEvaluation`, the justification and the gate review id, and attaches it as `evidenceRefs`. The catalogue *requires* evidence on `PROJECT_PHASE_TRANSITIONED`, so a transition with no bundle is refused by the ledger rather than by a caller remembering |
| Gate checks computed, not asserted | **BUILT** — each criterion is a predicate evaluated against materialised state; a gate that cannot be evaluated from the record is refused |
| Evidence link per condition | **PARTIAL** — each criterion reports `id`, `description`, `satisfied`, `found` and `required`, so the count of qualifying records is evidence of a kind. It does not name *which* records satisfied it, which is what a link would give an auditor |
| Human chair approves; system blocks while any mandatory condition is red | **BUILT** — `GATE_REVIEW_SUBMITTED` / `GATE_REVIEW_DECIDED`, both human-only, and the transition is refused while a criterion fails |
| Reverse transitions, mandatory reason, fully audited | **BUILT** — `reopenStage` exists precisely because "projects genuinely re-enter design and re-tender, and a system that cannot express it gets one that lies instead". It requires a `reason` and a `scope`, supersedes rather than edits the approved instance — the decision taken at the time was taken on the evidence available at the time — and the regression is recorded as `direction: REGRESSION` with `SUPERSEDED`, never `LOCKED`, so it can never be mistaken for an approval |
| Reverse transition authority ≥ Project Director | **PARTIAL** — gated on `PROJECT_SETUP` approve, held by `ENTERPRISE_ADMIN` and `OWNER` only. Whether those two are the intended equivalent of Project Director is a decision for the product owner; no role named Project Director exists |
| O&M persists post-handover, twins accumulate | **PARTIAL** — `DigitalTwinState`, `SensorReading`, `WorkOrder`, `OperatingCost` and `MaintenanceForecast` all exist and persist; longitudinal per-asset learning does not |

---

## A3 — TECHNICAL STACK (REQUIRED)

| Layer | Technology | Notes |
|---|---|---|
| Frontend | Next.js / React / TypeScript | Web + responsive PWA; React Native for iOS/Android field apps |
| Backend | NestJS (or Fastify) microservices | Domain services per module; gateway-fronted |
| Database | PostgreSQL + Prisma ORM | Row-level security for tenancy; partitioned event tables |
| Events / Queue | Kafka (or Pub/Sub) + BullMQ | Event sourcing backbone; outbox pattern mandatory |
| Realtime | WebSockets (Socket.IO) / Supabase Realtime | Live dashboards, presence, co-editing |
| Storage | GCS or S3 + Cloudinary proxy | Signed URLs only; document access validated per request |
| Search | OpenSearch | Full-text over documents, comms, records |
| Vector DB | pgvector (default) / Pinecone / Weaviate | All project knowledge embedded (see A6) |
| AI Gateway | Multi-model: Claude + OpenAI + Gemini/Vertex + OSS | Router by task, cost, risk, sensitivity, ACU balance |
| Auth | Auth0/Firebase + SAML 2.0 / OIDC SSO, MFA | Access 15 min / refresh 30 days; gateway introspection |
| AuthZ | RBAC + ABAC via OPA at gateway | Decision order: explicit deny → ABAC policy → RBAC role → scope → default deny |
| API Gateway | NGINX + OPA + Redis | Path-based routing /api/v1/{service}; tenant-aware rate limits; fail-closed; problem+json errors; correlation IDs |
| Observability | OpenTelemetry + Cloud Logging + Grafana | Structured logs with org/project/user/agent IDs |
| Billing | ACU Engine microservice (Part H) | Prepaid ledger; hard stop at zero balance |
| Deployment | GCP preferred; Docker + Terraform | Horizontal scalability; zero-trust posture |

### This section requires a decision, and it is the product owner's to make

This is the one part of the specification that cannot be delivered incrementally,
because it names the foundation rather than a feature. CONSTRUX today is a
**zero-runtime-dependency** platform: a Node HTTP server, an in-process
hash-chained ledger with a durable file journal, and a vanilla ES-module console.
That is a settled decision recorded in `STATE.md`, and it is why the platform
boots with no `node_modules` present.

Adopting A3 as written means replacing that foundation — NestJS, Prisma,
Postgres, Kafka, Redis, OpenSearch, NGINX, OPA — across roughly 55,000 lines that
currently work and are covered by 1,600 tests. That is a rebuild, not a change,
and doing it quietly would be reckless.

**What is worth separating: the behaviour A3 asks for is largely already met by
different technology.** Row by row:

| Layer | Required | CONSTRUX today | Contract met? |
|---|---|---|---|
| Frontend | Next.js/React + PWA + native field apps | Vanilla ES modules, installable PWA, offline outbox | **Behaviour yes, stack no.** No React Native app |
| Backend | NestJS/Fastify microservices | One Node process, domain modules per area | **Behaviour yes, stack no** |
| Database | Postgres + Prisma, RLS, partitioned event tables | In-process ledger + append-only file journal. Tenant isolation enforced in `identity/` on every read | **Isolation yes, durability class no.** Named in `STATE.md` as designed-for, not implemented |
| Events / Queue | Kafka + BullMQ, outbox mandatory | Append-only event log with replay; no broker | **Event sourcing yes, distribution no** |
| Realtime | Socket.IO / Supabase | Request/response only | **NOT BUILT** |
| Storage | S3/GCS, signed URLs, per-request validation | Tenant-scoped local object store, signed links with TTL, validated per request | **Behaviour yes, backend no.** B2/S3 driver is the named next step |
| Search | OpenSearch full-text | No full-text search | **NOT BUILT** |
| Vector DB | pgvector / Pinecone | No embeddings | **NOT BUILT** |
| AI Gateway | Multi-model router by task, cost, risk, sensitivity, balance | Built — routes by task and capability, falls back on unhealthy providers, refuses on an empty wallet | **BUILT** |
| Auth | SSO + MFA, access 15 min / refresh 30 days | Email one-time code + MFA challenge, access 15 min, **refresh 7 days**. No SAML/OIDC SSO | **PARTIAL** — the refresh window is a one-line divergence; SSO is not built |
| AuthZ | RBAC + ABAC, order: explicit deny → ABAC → RBAC → scope → default deny | RBAC + ABAC + scopes, fail-closed, order: **authenticate → RBAC → scopes → ABAC → decide** | **Behaviour yes, order differs.** Both are fail-closed and deny-wins, so no request is decided differently — but the stated order is not the specified one |
| API Gateway | Path routing, tenant-aware rate limits, fail-closed, problem+json, correlation IDs | All five, in `api/middleware.ts` and `api/gateway.ts` | **BUILT** — on Node rather than NGINX+OPA |
| Observability | OpenTelemetry, structured logs with org/project/user/agent IDs | Structured JSON logs carrying tenant, project, actor, route, correlation id; `x-correlation-id` on every response. No OTel exporter | **PARTIAL** |
| Billing | Prepaid ACU ledger, hard stop at zero | Built, and the hard stop is tested | **BUILT** — in-process rather than a microservice |
| Deployment | GCP, Docker + Terraform, zero-trust | Dockerfile + compose + autodeploy on a VPS. No Terraform, no GCP | **PARTIAL** |

Three things follow, and they are stated rather than assumed:

1. **The gaps that are real features, not stack choices** — realtime, full-text
   search, vector embeddings, SSO, and the 30-day refresh window — can be built
   on the current foundation and are listed in the implementation order below.
2. **The gaps that are genuinely stack** — Postgres, Kafka, NestJS, OPA, NGINX,
   Terraform — need an explicit decision to rebuild, with the cost understood.
   Until that decision is taken, this file records the divergence rather than
   hiding it.
3. **`STATE.md` already says** database safety, deployment reproducibility and
   caching are designed-for and not implemented. A3 is the requirement those
   entries were waiting for.

---

## A4 — CORE DATA MODEL

> Design the schema around these first-class objects. Every object carries
> org_id, project_id (where applicable), lifecycle_state_at_creation, created_by
> (human or agent), version, and soft-delete with tombstone.

| Domain | Objects |
|---|---|
| Identity & tenancy | User, Organisation, OrgRelationship (client↔contractor↔subcontractor), Role, Permission, Seat |
| Project spine | Project (lifecycle_state FSM), Portfolio, StageGate, GateCondition, DecisionRecord |
| Concept & design | Brief, FeasibilityStudy, OptionAppraisal, CostPlan (v0–v4), Drawing, Revision, Specification, SpecClause, DesignPackage, DRMEntry, Clash, RFI, Submittal, TQ |
| Tender & commercial | Tender, TenderPackage, ScheduleItem (BoQ), PricingRoute, TenderReturn, Clarification, Adjudication, BidPack, Contract, ContractClause, ObligationItem, Subcontract, Commitment, PurchaseOrder |
| Delivery | Programme, Baseline, Activity, Dependency, Resource, Variation, EarlyWarning, CompensationEvent, Application, PaymentNotice, Certificate, CVRSnapshot, LedgerEntry, Claim, DelayEvent |
| Field & HSE | SiteDiary, Inspection, ITP, Snag/Defect, NCR, Photo/Evidence, RAMS, ToolboxTalk, Permit, Incident, Observation |
| Commissioning & handover | CommissioningSystem, TestRecord, WitnessRecord, OMDocument, TrainingRecord, HandoverItem, COBieRow, GoldenThreadItem, Warranty, Retention, DLPDefect |
| Asset / FM | Asset, AssetTwin, MaintenanceTask, ConditionReading, ComplianceCert, FMRecord, LifecycleCostModel |
| AI & platform | Agent, AgentTask, AIInteraction, PromptTemplate (versioned), KnowledgeEmbedding, ACULedger, AuditEvent, Notification, Approval |

### Coverage

**86 of the 94 named objects exist**, across 122 classified entity types. Some
carry a different name for the same thing — `Tenant` for Organisation,
`InspectionPlan` for ITP, `AssetRegisterItem` for Asset, `WorkOrder` for
MaintenanceTask — which is a vocabulary difference, not a gap.

**Eight objects do not exist in any form:**

| Missing | Domain | Why it matters |
|---|---|---|
| `Brief` | Concept | The client brief A2 names as the CONCEPT entry gate |
| `FeasibilityStudy` | Concept | A2's CONCEPT exit gate requires "feasibility approved" — there is nothing to approve. This is *why* that gate is currently one weak criterion |
| `OptionAppraisal` | Concept | No option comparison exists before an option is chosen |
| `COBieRow` | Handover | COBie is the standard handover data exchange; without it the pack is documents, not structured asset data |
| `GoldenThreadItem` | Handover | A2's HANDOVER exit gate requires a complete Golden Thread for HRB Gateway 3 |
| `Retention` | Handover | Retention is money held and later released; it is currently not modelled at all |
| `PromptTemplate` (versioned) | AI | Prompts are composed in code, so a prompt change is a deploy and is not versioned as a record |
| `KnowledgeEmbedding` | AI | No vector store, so no project knowledge is embedded |

### Per-object required fields

| Required on every object | State |
|---|---|
| `org_id` | **BUILT** — `tenantId` on every event |
| `project_id` where applicable | **BUILT** |
| **`lifecycle_state_at_creation`** | **BUILT** — `lifecyclePhase` is now recorded on every event, including the creating one |
| `created_by` (human or agent) | **BUILT** — `actor`, with `AI` as a first-class actor type |
| `version` | **BUILT** — by construction; every change is an event and state is replayable to any point |
| **soft-delete with tombstone** | **NOT BUILT** — nothing is deletable at all. Append-only is stronger than a tombstone for the record, but there is no way to mark an object withdrawn or superseded as a *state*, which is what a tombstone gives a reader |

---

## THE THREE MEMORY LAYERS (MANDATORY)

> - **Project Memory** — everything known about one project: documents, actions,
>   decisions, AI interactions, event chronology. Retained through final account.
> - **Organisation Memory** — cost rates, productivity baselines, supplier
>   performance, claims outcomes, risk patterns, win/loss history. The org's
>   compounding intelligence asset; feeds benchmarks in Concept and Tender.
> - **Asset Memory** — 30+ years of FM records, maintenance history, condition
>   data, energy performance and safety-critical information. The Golden Thread's
>   permanent home.

| Layer | State |
|---|---|
| **Project Memory** | **BUILT** — the Golden Thread is exactly this. Every document, action, decision, AI interaction and the full event chronology, per project, append-only and replayable to any instant. Retention is unbounded: nothing is deleted |
| **Organisation Memory** | **PARTIAL** — cost rates and productivity are built (`LessonLearned`, cost intelligence from committed records, productivity against baseline), and supplier performance exists (`Supplier`, `SupplierSubmission`, `BidEvaluation`). Claims outcomes, risk patterns and win/loss history are recorded per project but **are not aggregated into an organisation-level benchmark that Concept and Tender read from**. The compounding half is the half that is missing |
| **Asset Memory** | **PARTIAL** — `AssetRegisterItem`, `DigitalTwinState`, `SensorReading`, `WorkOrder`, `Warranty`, `OperatingCost` and `MaintenanceForecast` all persist past handover on the same spine. Energy performance is not modelled, and no safety-critical flag distinguishes a record that must survive for the life of the asset from one that need not |

The architectural point worth stating: all three layers already share **one**
store. There is no separate project database, organisation warehouse or FM system
to reconcile — which is the hard part of this requirement, and it is done. What is
missing is aggregation across the layers, not the layers themselves.

---

## A5 — AI OPERATING MODEL — THREE VISIBLE LAYERS, NOT ONE CHATBOT

> - **Layer 1 · Workflow AI** — button-driven, deterministic, multi-step machines
>   that execute structured tasks (RAMS generation, scope writing, tender
>   analysis, WBS generation). Validated output at each step.
> - **Layer 2 · Copilot AI** — conversational drafting, querying and exploration
>   with full project context. Advisory only; every output requires review before
>   action.
> - **Layer 3 · Knowledge AI** — grounded retrieval over embedded project data
>   (drawings, specs, contracts, site records, commercial data). Answers always
>   cite sources with confidence scores; no answer without evidence.

The three-layer split is not only implemented, it is the model the code was
already written to — `ai/conversation.ts` opens by naming the same three layers
in the same order, and names itself as the second.

| Layer | State |
|---|---|
| **Layer 1 · Workflow AI** | **BUILT** — engines invoked from a named command, never from free text. Deterministic maths is computed in the engine and the model supplies judgement only; the model never writes state on its own. Output is validated at each step: the entity's registered JSON Schema is enforced after the patch is applied, so a malformed AI output is refused at the ledger rather than persisted |
| **Layer 2 · Copilot AI** | **BUILT** — answers from materialised Golden Thread state rather than from the model's memory of construction generally, carries full project and phase context, and is advisory by construction: it *proposes* the command and the user runs it. It performs no state change of its own |
| **Layer 3 · Knowledge AI** | **NOT BUILT** — there is no vector store and nothing is embedded. Retrieval over drawings, specs, contracts and site records does not exist. The `KnowledgeEmbedding` object named in A4 is one of the eight missing, and this is what it was for |

### Multi-model gateway routing inputs

> The model router selects a provider per call using: task type & complexity, cost
> per ACU, speed requirement, action risk level, data sensitivity, required
> accuracy, context window, user subscription tier, remaining ACU balance, and
> fallback availability. All routing decisions are logged.

Ten inputs are specified. **The router uses two of them.**

`adapterFor(capability)` selects on capability — `REASONING` or `PERCEPTION` —
then falls back on provider health and through the declared spares. Everything
else in the list is either recorded and unused, or not present at all.

| Routing input | State |
|---|---|
| Task type & complexity | **NOT USED** — `taskType` is recorded on every request and does not influence which provider serves it |
| Cost per ACU | **NOT USED** — cost is *quoted* before execution and *charged* after, and never routed on |
| Speed requirement | **NOT BUILT** — no latency requirement is expressed anywhere |
| Action risk level | **NOT BUILT** |
| **Data sensitivity** | **NOT BUILT** — and this is the one that matters most. `DataSensitivity` exists as a first-class concept in ABAC (`PUBLIC` … `LEGAL_L4`) and governs who may *read* a record. It does not govern which vendor a record may be *sent to* |
| Required accuracy | **NOT BUILT** |
| Context window | **NOT BUILT** |
| User subscription tier | **NOT USED** — the tier decides seats and allowance, not routing |
| Remaining ACU balance | **PARTIAL** — an empty wallet refuses the call outright, which is a hard stop rather than a routing decision. A low balance does not steer the call to a cheaper provider |
| Fallback availability | **BUILT** — an unhealthy primary fails over to the other capability's adapter and then through the configured spares |
| **All routing decisions logged** | **PARTIAL** — the provider that served each call is recorded on the request and the execution, so the *outcome* is auditable. The *inputs the decision was made on* are not recorded, so a routing choice cannot be re-derived from the record |

The gap is honest to state plainly: what exists is a **failover chain**, not a
router. Turning it into the specified router means the ten inputs become an
explicit, recorded decision — and the recording matters as much as the routing,
because "all routing decisions are logged" is what makes a vendor choice
auditable after a dispute.

---

## PART B — STAGE 1: CONCEPT (RIBA 0–1)

> Purpose: convert a client ambition into a governed, evidenced Go/No-Go decision
> in days, not months. The Concept stage is where 80% of an asset's lifecycle cost
> is committed with 5% of the information — CONSTRUX attacks that asymmetry with
> benchmark intelligence drawn from Organisation Memory and market data.
>
> **Personas:** Client/Developer Executive · Development Manager · Employer's
> Agent / PM Consultant · Cost Consultant (QS) · Pre-Construction Director
> (contractor, if ECI) · Planning Consultant.

**Concept is the least-built stage in the platform.** The lifecycle state exists
and the gate machinery exists; almost none of the work that happens inside the
state does. This is consistent with what the A2 and A4 audits already found — the
CONCEPT exit gate is one weak criterion precisely because the objects it would
test do not exist.

### B1 — Concept workflows

| Workflow | Clause | State |
|---|---|---|
| C-1 · Inception | Create Project → `lifecycle_state = CONCEPT` | **BUILT** |
| C-1 | Wizard captures client entity, sector, procurement intent, budget envelope, target dates, site address & title | **PARTIAL** — a project is created with a name, sector and jurisdiction; the rest is not captured |
| C-1 | **HRB flag** (Building Safety Act higher-risk building — triggers Golden Thread from day one) | **NOT BUILT** — nothing marks a project as an HRB, so nothing downstream can behave differently for one |
| C-1 | Structured Brief Builder: functional requirements, areas schedule, quality benchmarks, sustainability targets, constraints | **NOT BUILT** — no `Brief` object |
| C-1 | Voice or typed; agent cleans and structures the draft | **PARTIAL** — voice ingestion exists in the perception engine; there is no brief for it to write into |
| C-1 | Brief locked as v1 → `BRIEF_APPROVED`; every later scope change diffed against this baseline for ever | **NOT BUILT** |
| C-2 · Feasibility | Feasibility Agent assembles a site appraisal from planning history, flood zone, conservation, utilities, access, ground risk — each finding with a source link | **NOT BUILT** — no `FeasibilityStudy`, and no external data sources are integrated |
| C-2 | Option Appraisal workspace: 2–5 options with benchmark cost, duration, risk profile, compared side by side with sensitivity toggles | **NOT BUILT** — no `OptionAppraisal` |
| C-2 | Benchmark Cost Agent → Cost Plan v0 per option, £/m² by element, confidence per element, inclusions/exclusions register | **PARTIAL** — the twenty-cost-head estimate and cost intelligence from committed records both exist and are the hard half; there is no elemental v0 cost plan tied to an option, and no per-element confidence |
| C-2 | Concept Risk Register seeded automatically with owner, likelihood×impact, mitigation seed | **PARTIAL** — the risk register, scoring and named owners all exist; automatic seeding at CONCEPT does not |
| C-2 | Business Case Composer drafts the investment paper; HITL Development Manager edits, Executive approves | **NOT BUILT** |
| C-3 · Gate G1 | Machine-checked, human-chaired checklist; GO → `PROJECT_STATE_CHANGED` → DESIGN with the concept bundle handed forward untouched | **PARTIAL** — the gate mechanism, human chair, machine evaluation and evidence bundle are all built. The **G1 checklist itself is one criterion** where six are specified: brief approved · preferred option selected with rationale · Cost Plan v0 within envelope or variance justified · risk register reviewed · planning strategy defined · funding line evidenced |
| C-3 | NO-GO → project archived with complete decision record; Organisation Memory learns from killed projects too | **NOT BUILT** — there is no archive path and no learner |

### B2 — Concept AI agents

None of the five exists. The fleet is twelve agents built around bidding,
delivery and commercial control; the concept fleet is a different set.

| Agent | Triggers | HITL | ACU | State |
|---|---|---|---|---|
| `AGT-FEASIBILITY` | `BRIEF_APPROVED`; on-demand | REVIEW | HIGH | **NOT BUILT** |
| `AGT-BENCH-COST` | `OPTION_CREATED`; brief change | REVIEW | HIGH | **NOT BUILT** |
| `AGT-CONSENTS` | Feasibility complete | REVIEW | MED | **NOT BUILT** |
| `AGT-CARBON-ESG` | `OPTION_CREATED` | REVIEW | MED | **NOT BUILT** |
| `AGT-CONCEPT-RISK` | Continuous in CONCEPT | REVIEW | LOW | **NOT BUILT** |

The *mechanism* each of them needs is built: agents are first-class, declare a
mandate, propose rather than act, and are metered. What is missing is these five
agents and the concept objects they would read.

### B3 — Concept dashboard

> Rule for every dashboard in this platform: do NOT build dashboards — build
> real-time decision command centres. Every panel must answer, without scrolling
> or interpretation: what is happening, what changed, what is at risk, what is
> costing money, what needs action today, what will happen next, who owns the
> decision — plus AI Insight and AI Recommendation panels with Review / Accept /
> Mitigate / Assign actions on every item. Every KPI tile is clickable and drills
> to the exact source events ("this metric exists because these events occurred").

**This rule is now met on exactly one screen — the platform operator's command
centre — and on none of the delivery screens.** The two structural requirements
are both unmet across the product:

| Requirement | State |
|---|---|
| Every KPI tile clickable, drilling to the source events | **NOT BUILT** anywhere. The lineage traversal and the event chronology both exist, so the data is there; no tile links to them |
| AI Insight and AI Recommendation panels with Review / Accept / Mitigate / Assign on every item | **PARTIAL** — the agent proposal queue has Accept and Reject and is on its own screen. It is not a panel on each command centre, and Mitigate and Assign do not exist |

The seven Concept panels — decision countdown, option comparison, budget
envelope, constraint radar, risk heat, AI insights, AI recommendations — are
**NOT BUILT**, following from the objects being absent.

### B4 — Concept data, events and APIs

| Event | State |
|---|---|
| `PROJECT_CREATED` | **BUILT** |
| `BRIEF_APPROVED` | **NOT BUILT** |
| `OPTION_CREATED` | **NOT BUILT** |
| `COSTPLAN_V0_ISSUED` | **NOT BUILT** |
| `RISK_SEEDED` | **NOT BUILT** — `RISK_REGISTERED` exists and is the human act; automatic seeding is the missing half |
| `GATE_G1_PASSED` / `FAILED` | **PARTIAL** — `GATE_REVIEW_DECIDED` carries the result, and is generic across gates rather than named per gate |

Consumers — Design stage bootstrap, Organisation Memory learner, portfolio
aggregator, ACU meter: the portfolio aggregator and the ACU meter are **BUILT**;
the design bootstrap and the memory learner are **NOT BUILT**.

The API shapes differ (`/v1/...` rather than `/api/v1/...`, and command-named
rather than resource-named in places), which is a convention difference and not a
gap. The one substantive note: **`POST /api/v1/gates/G1:approve` requires
authority ≥ Executive, and there is no Executive role.** See the authority note
below.

### A note that spans Parts A, B and C: the authority vocabulary

The specification repeatedly names authority levels the platform's fifteen roles
do not express:

| Named in the spec | Where | CONSTRUX |
|---|---|---|
| **Executive** | B4 — G1 gate approval | No role. Gate approval is held by `ENTERPRISE_ADMIN` and `OWNER` |
| **Project Director** | A2 — reverse transitions | No role. Same two hold it |
| **Development Manager** | B1 — business case HITL | No role |
| **Principal Designer (CDM 2015)** | Part C personas | Exists as a *supply-chain accreditation code* (`CDM_PRINCIPAL_DESIGNER`), not as a platform role with duties. The CDM work built the Principal **Contractor** duty set; the Principal **Designer** duty set is a separate statutory role and is not built |
| **Commercial Manager** | A1 Rule 2 — chain-break escalation | No role. `QS` is the nearest |

**Settled: all five are roles in the permission matrix**, rather than a separate
authority-level concept layered over the existing fifteen. A second concept would
have meant two things to check on every decision and two places for them to
disagree; the matrix already resolves authority everywhere in the platform, and a
role is what `assertAccess` understands.

| Role | Shape | Seat |
|---|---|---|
| `EXECUTIVE` | Approves everywhere, authors nowhere — the gate, the baseline, the award, the forecast that goes outside | Executive, £120 |
| `DEVELOPMENT_MANAGER` | Authors the concept, approves nothing. The mirror of the Executive, which is why both exist rather than one | Executive, £120 |
| `PROJECT_DIRECTOR` | Contractor-side seniority; holds the `PROJECT_SETUP` approve a reverse transition is gated on. Creates almost nothing — not a second PM | Construction Manager, £180 |
| `COMMERCIAL_MANAGER` | Approves the four commercial areas the QS authors, and authors in none of them | Commercial Manager, £150 |
| `PRINCIPAL_DESIGNER` | CDM 2015 statutory duty holder. Approves design, owns design-risk elimination in the register and the RAMS, compiles the health and safety file. Holds no site authority — that is the Principal Contractor, a different duty holder | Principal Designer, £130 (new) |

**One open question this surfaced, for the product owner rather than for
engineering.** `DESIGNER` already held approve on design information, on the
recorded reasoning that "approval of design content stays with the designer".
There are now two design approvers: the lead designer signing off content, and
the CDM duty holder confirming design risk has been eliminated or reduced. Those
are genuinely different acts, so both may be right — but if a designer should no
longer approve their own design, that is a deliberate change to a settled
decision and has not been made here.

**A correction to an earlier reading in this file.** An earlier draft implied the
permission matrix is the platform's separation-of-duties mechanism. It is not:
twenty-six existing roles hold both create and approve in the same area,
deliberately, because separation is a rule about *two acts by one person* and a
capability area cannot express it. It is enforced per act — `lifecycle/stages.ts`
refuses a gate decision from whoever submitted it. The asymmetry in the three new
roles above models the specification's two-person split; it does not enforce it.

---

## PART C — STAGE 2: DESIGN (RIBA 2–4)

> Purpose: take the approved concept to a coordinated, buildable, priceable design
> — with cost certainty rising as design matures, and every design decision
> traceable. Design is where projects are silently lost: uncoordinated packages,
> drifting cost plans, unanswered RFIs and unallocated design responsibility
> surface later as claims. CONSTRUX makes design drift visible in real time and
> makes the Design Manager the best-informed person on the project.
>
> **Personas:** Design Manager · Architect / Lead Designer · Structural + MEP
> Engineers · BIM Manager / Information Manager (ISO 19650) · Cost Consultant ·
> Principal Designer (CDM 2015) · Client PM.

### C1 — Design mobilisation

| Clause | State |
|---|---|
| Auto-bootstrap from the Concept bundle — brief, option, Cost Plan v0, risk register carried forward untouched | **NOT BUILT** — blocked on the concept objects existing at all |
| **EIR loaded, BEP captured** | **NOT BUILT** — neither the Exchange Information Requirements nor the BIM Execution Plan is modelled |
| **CDE container structure per ISO 19650** (WIP / Shared / Published / Archive) | **PARTIAL** — a deliverable under review now carries a CDE state, and the review decision moves it (`SHARED` on submission, `PUBLISHED` on acceptance, back to `WORK_IN_PROGRESS` on revise-and-resubmit). The evidence store itself still has no containers, and suitability codes (S0–S7, A1–A5) are not modelled |
| **Naming convention validator; non-compliant uploads quarantined with a fix suggestion, never silently accepted** | **NOT BUILT** |
| **Design Responsibility Matrix as a first-class object** — every element assigned to a named organisation with a design level (concept / spatial / detailed / installation); unallocated elements glow red until owned | **PARTIAL, and thin** — a `designResponsibilityMatrix` exists only as an array of `{ element, responsibleParty }` *inside a tender package*, checked for presence when a bid pack is assembled. It has no design level, no unallocated tracking, and does not exist during the DESIGN stage where the specification puts it |
| Design programme with stage milestones (Stage 2 sign-off, Stage 3 coordination freeze, Stage 4 technical freeze) linked to the master programme | **PARTIAL** — programme, baselines, milestones and linkage all exist as machinery; the three named RIBA design freezes are not modelled as milestones |

What *is* built and load-bearing for this stage: the drawing register with
revisions and supersession, specification ingestion and clause extraction, clash
detection and resolution with evidence, RFIs with activity references, design
maturity assessment, and the design-delay cost-through-to-site chain. The
information-management layer around them — ISO 19650 containers, EIR/BEP, naming
validation — is the part that is absent.

### D-WF-03 — Design production, check, review and acceptance

**BUILT.** `backend/src/engines/designreview.ts`, seven routes, 23 tests.

The cycle is submit → comment → disposition → close → decide. It exists because
the specification's own words are that design is where projects are silently
lost, and the single mechanism by which that happens is a deliverable published
while a serious comment is still open.

| Clause | How it is enforced |
|---|---|
| Author's self-check before submission | A submission without ≥20 characters of self-check is refused. It is recorded on the cycle, not discarded |
| Independent check | The author cannot comment on their own submission (`REVIEW_SELF_CHECK`) |
| Independent acceptance | The submitter cannot decide their own review (`REVIEW_SELF_APPROVAL`) |
| Comment severity | `CRITICAL · MAJOR · MINOR · OBSERVATION`. Critical and major are blocking |
| Disposition is the author's, closure is not | Only the author may disposition a comment (`ACCEPTED · REJECTED · ALTERNATIVE_PROPOSED`, with ≥10 characters of response); only somebody other than the author may close it |
| **A blocking comment cannot be concealed** | `ACCEPTED` and `ACCEPTED_WITH_COMMENTS` are both refused while a critical or major is open, and the refusal names the comments. "Accepted with comments" is the status that otherwise hides them, which is why it is refused too |
| Revise and resubmit | Returns the deliverable to `WORK_IN_PROGRESS` and increments the revision count on the next submission |
| Lateness | `reviewPosition` reports duration, days overdue and who it is waiting on — the checker before a decision, the author while comments are open |

Verified against the running system rather than against the tests alone: the six
steps were driven through the real API as the real people — the PM submits, the
BIM Manager checks, the Design Manager decides — and the sequence refuses
self-comment, refuses accept-with-comments while blocked, refuses acceptance
after the author has answered but before the checker has agreed, and publishes
only once the checker closes the comment.

**Not built in this workflow:** suitability codes, model-federation checks as a
review input, and an automatic review trigger on drawing issue. A reviewer is
nominated on submission and there is no reviewer rota.

**One question for the product owner:** `DESIGNER` may still accept a design.
Now that `PRINCIPAL_DESIGNER` exists as a distinct role, that may be the wrong
authority — the engine enforces that the *submitter* cannot decide, which is the
per-act rule, but it does not require the decider to be the principal designer.

---

## PART E — STAGE 4: CONSTRUCTION (RIBA 5)

> Zero re-entry applies throughout: Bid → Contract → Subcontract → Commitment →
> Application → Ledger → CVR is one enforced data flow; any break raises an
> exception.

That clause is now **BUILT** — recorded under A1 Rule 2 above, which is where it
belongs, because it restates that rule rather than adding to it.

### E1 — Contract initialisation and contract intelligence

| Clause | State |
|---|---|
| Award push freezes the bid; contract sum initialised from the locked bid; exclusions and qualifications carried over | **BUILT** — `convertBidToContract` refuses a bid pack that is not `LOCKED`, takes the sum from the frozen assembly, and carries `qualifications` and `exclusions` onto the contract. They are the basis the price was given on, so they travel with it |
| Pricing baseline created | **BUILT** — the contract sum is the CVR's `contractValueMinor` baseline |
| Signed contract PDF uploaded → OCR → automatic clause extraction | **PARTIAL** — `ingestContract` takes contract *text* and a document hash and extracts clauses into the register. There is no OCR: a scanned PDF has to be transcribed before it reaches this. The perception module reads drawings and title blocks, not contracts |
| Clauses by category (commercial, legal, programme, insurance, payment, change, defects, notices) | **PARTIAL** — the clause register exists with categories; the eight named categories are not the closed set |
| Payment mechanism summary · LD caps and triggers · defects liability period · retention rules | **BUILT** — `contractTerms` publishes all four from the contract record |
| Notice obligation tracker with countdown to every deadline · obligations calendar | **BUILT** — `obligationCalendar` with time bars running |
| Insurance register · design responsibility allocation | **NOT BUILT** — neither is modelled on the contract |
| Contract risk dashboard | **PARTIAL** — the commercial term analysis scores contract risk at tender; there is no post-award risk dashboard |
| Grounded clause Q&A with citations | **PARTIAL** — clause search returns the clause and its reference; there is no grounded question-answering over it |
| Every contractual obligation becomes an actionable item with owner and due date | **BUILT** — `registerObligation` resolves a named owner |
| **NEC4 Early Warning and Compensation Event machinery natively (8-week CE quotation clocks, reply deadlines)** | **NOT BUILT** — `ContractSuite` knows `NEC4`, and nothing behaves differently because of it. There is no Early Warning record, no Compensation Event, and no quotation or reply clock |
| **JCT Relevant Event / Relevant Matter tracking** | **NOT BUILT** — the phrase appears nowhere in the codebase |
| **FIDIC Clause 20 claim clocks** | **NOT BUILT** |

The suite-specific machinery is the largest single gap in Part E. A generic
`Notice` and a generic obligation calendar are not the same thing as a
Compensation Event with its own statutory clock, and presenting them as
equivalent would be the kind of overstatement this file exists to prevent.

### E2 — Procurement-to-subcontract engine

| Clause | State |
|---|---|
| Winning bidder selected in Tender → automatic push to procurement | **BUILT** — `assembleSubcontract` refuses an RFQ that is not `AWARDED` and reads the awarded submission |
| Subcontract draft auto-created: pricing, scope and particulars pre-filled; correct standard form applied | **BUILT** — value, supplier, package, carried exclusions and contract exceptions all come from the submission; the form is recorded |
| Numbered document pack assembled with drawings and specs attached | **PARTIAL** — subcontracts are numbered (`SC-00001`); the document pack is not assembled |
| **Buyout target from tender adjudication as baseline; negotiation delta tracked live; buyout gain/loss feeds CVR** | **PARTIAL** — `buyoutTargetMinor` and `buyoutDeltaMinor` are recorded from the adjudication at assembly. The delta does not yet feed the CVR as a separate line |
| Commercial approval gate before issue (budget, compliance, insurance, authority) | **PARTIAL** — `executeSubcontract` refuses without `budgetCheckPassed` and requires `PROCUREMENT_AWARD` approve authority. Compliance and insurance checks are not part of the gate |
| E-signature workflow (send / viewed / signed / declined, automated chasing) | **PARTIAL** — signature is a governed ceremony with a witnessed record; there is no send/viewed/declined state machine and no chasing |
| **On execution, Commitment auto-created and linked to package and CVR** | **BUILT** — `executeSubcontract` writes the subcontract and the commitment together, so the ledger can never show one without the other. The chain check above now proves the link rather than assuming it |
| Downstream application cycle activated | **PARTIAL** — payment cycles are generated explicitly, not automatically on execution |
| Procurement schedule generated from programme milestones | **NOT BUILT** |
| **Long-lead items tracked with programme-impact forecasts** | **NOT BUILT** — no lead-time field exists anywhere |
| Supplier performance written to Organisation Memory | **PARTIAL** — supplier performance is scored; the organisation-level memory layer it should feed is itself not built |

### E3 — Variation and change control matrix

| Clause | State |
|---|---|
| Governed change record with origin, notice type, approval status and authority level | **BUILT** |
| Affected-package matrix with automatic notification to every affected subcontractor | **PARTIAL** — `affectedSubcontractIds` is carried on the change and the variation; the automatic notification is not wired |
| Downstream instruction creation, linked and traceable · upstream client valuation and cost-report impact | **BUILT** |
| **Upstream/downstream synchronisation: one change generates two linked records, status syncs bidirectionally** | **BUILT** — the variation reconciliation engine |
| **Blocks upstream claims without downstream cost capture; flags downstream exposure not recovered upstream** | **BUILT** — both directions |
| Domestic variation intake inside subcontractor payment applications, auto-flagged, evidence + cost effect + time effect mandatory | **PARTIAL** — domestic variations are modelled and linked; they are not submitted *inside* an application, and the three mandatory fields are not all enforced at intake |
| Variation Impact Engine: cost, programme, procurement and claims-risk recalculated instantly; CVR exposure updates | **PARTIAL** — cost and claims-risk are computed; programme impact is assessed but not recalculated from the change; procurement impact is not computed |
| Exposure dashboard: quoted/unquoted · instructed/uninstructed · approved/unapproved · upstream/downstream mismatch | **BUILT** — all four axes are on the commercial screen |

### E4 — Applications, payments and Construction Act compliance

| Clause | State |
|---|---|
| Application periods, submission dates, payment notice dates, pay-less dates, final dates for payment | **BUILT** — `generatePaymentCycle`, statute-aware under HGCRA 1996 as amended, with weekend and holiday rules |
| **On contract creation the full cycle auto-generates for upstream and every downstream subcontract** | **NOT BUILT** — cycles are generated on request, one at a time, per contract. Nothing fans out on contract creation |
| Reminder ladder | **PARTIAL** — deadlines are computed and surfaced; there is no escalating reminder sequence |
| Notice validity checker | **BUILT** — a pay-less notice without a basis of calculation is refused under s.111(4) |
| Late-notice risk alerts with commercial exposure estimate | **BUILT** |
| **Smash-and-grab risk flag on both sides of the chain** | **PARTIAL** — the missed-notice consequence (the notified sum becomes payable) is computed and warned about, which is the substance. It is not named as smash-and-grab and is not presented per side of the chain |
| Payment compliance dashboard | **BUILT** |
| Application Builder pulls contract value, variations, previous certified, retention and accruals | **BUILT** |
| Tracks application → payment notice → certificate → invoice → payment → ledger | **BUILT**, and the first two links of it are now checked by the chain check |
| Cashflow intelligence: forecast, scenario stress testing, funding-pressure alerts, margin-to-cash gap, working-capital pinch points | **PARTIAL** — live forward cashflow and the funding model are built; scenario stress testing and the pinch-point forecast are not |

### E5 — Live CVR and commercial ledger

| Clause | State |
|---|---|
| CVR driven automatically from contract value, variations, commitments, accruals, certified and paid-to-date, forecast final cost | **BUILT** — every input is read from the ledger, none is keyed |
| Margin-erosion alerts with configurable thresholds | **PARTIAL** — alerts fire; the thresholds are not configurable per tenant |
| Cost-code and package drill-down | **BUILT** |
| **Confidence score based on data completeness** | **BUILT** — the proportion of the CVR's eight inputs that are actually populated. A CVR built from two of eight is not presented with confidence |
| Earned value: AC, EV, PV, CV, SV, CPI, SPI, EAC (multiple methods) | **BUILT** — `maths/evm.ts`, with both a CPI-only and a CPI×SPI pessimistic EAC |
| Ledger bridge: committed vs certified vs paid per package, invoice/certificate linkage, exception queue, payment holds, retention, contras and backcharges | **PARTIAL** — the purchase ledger, retention and contra charges are built. There is no finance-system sync status and no unmatched-item exception queue |
| Commercial AI answers "what is killing margin", "what changed this week", "what should be claimed now", "what exposure is not protected" | **PARTIAL** — the CVR narrative and the what-changed window answer the first two; the last two are not asked as questions the platform answers |

### E6 — Programme and planning engine

| Clause | State |
|---|---|
| Critical path, dependencies, auto-schedule, baselines and comparison, constraints, date shifting with linked recalculation | **BUILT** — `maths/cpm.ts` and the planning engine |
| Contractual milestones distinguished · resource management with clash detection | **PARTIAL** — milestones exist; the contractual/non-contractual distinction and resource clash detection do not |
| **Drag-and-drop planner-grade Gantt** | **NOT BUILT** — the programme is rendered and editable through forms, not by dragging bars |
| Bulk progress updates by cost code or package | **NOT BUILT** |
| Export to PDF / MS Project / Excel | **PARTIAL** — PDF only |
| AI WBS generator with templates per project type | **PARTIAL** — WBS generation exists; the four named templates do not |
| **What-If scenario engine** — the flagship query ("three recovery options to regain four weeks within 3% cost") | **NOT BUILT** — Monte Carlo completion forecasting exists, which is a different question: it says how likely a date is, not what to do about it |
| Cross-module linkage to diaries, RFIs, variations, labour, procurement and delay events | **PARTIAL** — RFIs carry activity references and delay events link to activities; labour and procurement status do not |
| Auto-suggested EOT candidates from event chronology | **PARTIAL** — delay attribution and the claims chronology exist; EOT candidates are not proposed |
| Schedule analytics: health score, baseline drift with commentary, slippage heatmaps, float erosion, package criticality | **PARTIAL** — slippage and float are computed and the consistency report names un-absorbed slippage; there is no health score, drift commentary or heatmap |

### E7–E9 — Field, RAMS and correspondence

| Clause | State |
|---|---|
| Voice-to-field-record across diary, inspection, snag, observation, instruction | **PARTIAL** — voice capture and structured clean-up exist in the perception module; not every field module accepts it |
| Offline capture with sync queue, operation-id idempotency | **BUILT** |
| Trade-filtered snag dispatch; each contractor sees only their items | **BUILT** — enforced in the query, not in the interface |
| Evidence mandatory before closure · ageing analytics · recurring-defect clustering | **PARTIAL** — evidence is mandatory and ageing is reported; clustering is not |
| Template-driven inspections with mandatory evidence per item; failed items auto-create issues | **BUILT** — ITP, hold points and NCR |
| Field evidence library: timestamped, GPS-tagged, zone/package/cost-code tagged, chronology views, claim bundles | **PARTIAL** — tagging, chronology and claim evidence bundles are built; GPS tagging and AI classification are not |
| **Guided 8-step RAMS machine, deterministic, never freeform** | **PARTIAL** — RAMS exist with hazards, controls, residual risk scoring, approval and acknowledgement. They are not driven as eight sequenced steps with a button per step |
| Dual-source safety knowledge (organisation base fused with platform base: CDM 2015, HSE ACOPs, COSHH, CITB) | **NOT BUILT** — no platform hazard library exists |
| RAMS-to-resource bridge feeding permits and site readiness | **PARTIAL** — permits to work exist and RAMS gate them; PPE, plant and temporary works are not derived from the method |
| Site-readiness gatekeeping on competency and training expiry | **BUILT** |
| One correspondence engine with auto-sequential numbering per type, linked references, recipient matrix, response due-date logic, escalation ladder | **BUILT** |
| Notice templates bound to clause numbers and deadline logic | **PARTIAL** — obligations carry clause references and deadlines; notice *templates* bound to them do not exist |

### E10 — Construction AI agents

Ten agents are specified. The agent runtime is built — contracts, triggers,
mandates capped at `PROPOSE`, ACU metering, proposal queue scoped by capability
area — and a twelve-agent fleet exists for the contract-winning stage. The ten
construction agents named here are **PARTIAL**: several have a direct equivalent
(commercial, claims, quality, HSE, payment), and none of them is declared with
the trigger set, HITL mode and ACU tier this table specifies. The gap is the
declaration, not the runtime.

### E11 — Construction command centres

Three command centres are specified, each with four data panels and an **AI
Insight / Recommendation** panel carrying Review / Accept / Mitigate / Assign.

**The AI Insight panel is BUILT, on all ten delivery screens** — the three named
here and the seven in Parts C, D, F and G — with all four actions, plus Reject.
**The KPI drill is BUILT** on every one of them. Both are recorded in full under
the Build Standard below.

The data panels themselves remain **PARTIAL** against the exact tables in E11:
most of the content exists across the delivery screens and it is not arranged
into the named five-panel layout per persona.

---

## PART F — STAGE 5: COMMISSIONING (RIBA 5–6)

| Clause | State |
|---|---|
| System register with areas, dependencies, ITPs, witness requirements, acceptance criteria | **PARTIAL** — commissioning tests and system acceptance exist with mandatory evidence. There is no system *register* with power-on dependencies |
| Register auto-seeded from the specification's testing obligations | **NOT BUILT** — specification intelligence extracts clauses; it does not seed a commissioning register |
| Commissioning programme linked to the construction programme; mechanical completion per area drives test-start logic | **NOT BUILT** |
| Test and witness records with role-verified sign-off; failed tests auto-create defects with a re-test loop | **PARTIAL** — tests are recorded and accepted with evidence and authority; failure does not auto-create a defect |
| Defect and snag convergence in one engine with a PC-blocking flag on category-A items | **PARTIAL** — one defect engine exists; there is no severity category and no PC-blocking flag |
| O&M data collection in parallel with an information-delivery schedule per subcontract, chased automatically with completeness scoring | **PARTIAL** — O&M manuals, warranties and completeness exist at handover; the per-package delivery schedule and automated chase do not |
| **COBie validation against the schema and the EIR** | **NOT BUILT** — `COBieRow` is one of the eight missing A4 objects, and the string `COBie` appears nowhere in the backend |
| Client training: sessions, attendance, recordings filed into the pack | **NOT BUILT** |
| **PC Readiness Score per system and per area**, drillable to every record | **PARTIAL** — a handover readiness assessment exists and is narrative. It is not a computed score over the eight named inputs, and it is not per system or per area |
| Exit Gate G5 with its six conditions; pass emits `COMMISSIONING_COMPLETE` | **NOT BUILT** — no such gate and no such event |

---

## PART G — STAGE 6: HANDOVER (RIBA 6 → 7)

| Clause | State |
|---|---|
| Handover pack compiler assembling from data that already exists; locked and hashed on issue | **BUILT** — `HANDOVER_PACK_COMPILED` requires evidence, and the pack is content-hashed |
| Pack includes as-builts, O&M, test records, certificates, warranties, training records, RAMS/permit history, fire safety information, decision chronology | **PARTIAL** — O&M, warranties, test records and the decision chronology are in; COBie, training records and RRO Article 38 fire safety information are not |
| Golden Thread finalisation: safety-critical tracker, accountability matrix, change history, Gateway 3 evidence bundle, visible completeness score | **PARTIAL** — the ledger *is* the change history with a hash chain, and lineage traversal is built. `GoldenThreadItem` as a tracked object is one of the eight missing A4 objects, and there is no Gateway 3 bundle |
| Client sign-off per pack section with comments loop and digital signature | **PARTIAL** — `HANDOVER_ACCEPTED` requires evidence and is authority-gated; acceptance is whole-pack, not per section, and there is no comments loop |
| **Acceptance starts the Defects Liability Period clock and the retention release schedule automatically** | **NOT BUILT** — the DLP months and the retention percentage are both recorded on the contract, and nothing starts a clock or a schedule from acceptance. `DLP_STARTED` and `RETENTION_RELEASED` do not exist as events |
| Asset activation into FM with full history, maintenance regime seeded from O&M | **PARTIAL** — `ASSET_REGISTERED` and the FM operating position are built; the maintenance regime is not seeded from the O&M data |
| DLP defects flow to the responsible subcontractor with contractual response clocks; end-of-DLP inspection scheduled; retention release tied to defect closure evidence | **NOT BUILT** |
| Final account convergence tracked | **PARTIAL** — the payment cycle refuses over-certification and overpayment; there is no final account convergence view |
| Lessons-learned harvest into Organisation Memory | **PARTIAL** — `LESSON_CAPTURED` exists and lessons are corporate memory across projects. Agents do not mine the record to write them, and the organisation-level benchmark layer is not built |
| Events `DLP_STARTED`, `RETENTION_RELEASED`, `GATEWAY3_SUBMITTED`, `ASSET_ACTIVATED`, `LESSON_RECORDED` | **NOT BUILT** — none of the five is in the closed catalogue. `LESSON_CAPTURED` and `ASSET_REGISTERED` are the nearest equivalents and are not the same events |

---

## PART H — CROSS-CUTTING

### H1 — Commercial model

The three MUSTs — **£1 = 100 ACU · 100% minimum profit · ×4 provider markup** —
all hold, and are configured rather than written into code:
`ACU_MARKUP_MULTIPLIER=4`, `ACU_MINIMUM_PROFIT_PERCENT=100`, and one ACU is one
minor unit by construction.

Every seat price in the table matches: Construction Manager £180, Commercial
Manager / QS £150, Project Manager £140, Director / Executive £120, Planner £110,
Design / Document Controller £90, Site Manager / Supervisor £70, Subcontractor
£25. So does every package: Core Project £950 / 10 seats, Professional Delivery
£2,200 / 25 seats, Enterprise £6,500 / unlimited under fair use. So does every
bundle price: £300, £1,000, £2,500.

**One addition beyond the table**, for the product owner to confirm or remove: a
ninth seat, **Principal Designer (CDM 2015) at £130**, added when the statutory
duty holder became a role. The specification names the persona in Part C and does
not price it, and a role with no seat is a role nobody can be assigned.

**One conflict inside the specification itself, and it is a real one.** The
bundle table states ~10,000 / ~40,000 / ~110,000 usable ACUs. Those are the
figures a **×3** markup produces. At the ×4 the same document requires, £300 buys
7,500 ACUs, £1,000 buys 25,000 and £2,500 buys 62,500 — every bundle a third
smaller than advertised.

The platform resolves it in favour of ×4 and **derives** the yield from the
multiplier rather than storing it, so the two can never disagree again. Nothing
is misposted either way — a top-up credits the price and spend is billed at the
effective multiplier, so the stale figure would only ever have appeared on a
pricing page. But it is a promise a customer would find out about when the bundle
ran out a third early, so the published figures are the derived ones. **If the
~10,000 / ~40,000 / ~110,000 numbers are the commitment, the markup has to come
down to ×3 and that is a pricing decision, not an engineering one.**

| Clause | State |
|---|---|
| Subscription = platform access; ACUs metered separately, prepaid only | **BUILT**, and a settled decision |
| Hard stop at zero balance, graceful "top up to continue", never silent failure | **BUILT** — the orchestrator refuses to call a provider on an empty wallet, and no charge occurs without a ledger write |
| No AI activity = no ACU consumption | **BUILT** |
| Per-task transparency for auditors: agent, model, tokens, tier, multiplier, £-equivalent | **BUILT** — every AI request writes a metered entry |
| Balance checks precede execution | **BUILT** — held, then consumed or released |
| Enterprise budget caps and alerts per project | **PARTIAL** — caps and 50/80/100% alerts are per wallet, not per project |
| **Four ACU tiers (LOW / MED / HIGH / PREMIUM) by task intensity** | **PARTIAL** — cost varies by task and model; the four named tiers are not a declared vocabulary, and the agent tables in Parts D–G reference them |
| Markup ×3–×10 by task intensity | **DELIBERATELY NOT BUILT** — flat ×4. Recorded as a decision: a variable markup and a 100% profit floor are two rules that can contradict each other, and the flat rate is the one that cannot be got wrong. Raising it per tier is a config change, not a rebuild |

### H2 — Security, governance and tenancy

| Clause | State |
|---|---|
| RBAC + ABAC, decision order explicit deny → ABAC → RBAC → scopes → default deny | **BUILT** — and default deny is proven by the unmapped-entity refusal |
| Project-level and company-level partitioning enforced in queries, not UI | **BUILT** — tenant isolation on every read including the generic entity route and the audit feed |
| TLS 1.3 in transit · AES-256 at rest | **PARTIAL** — transport is the deployment's; there is no database, so encryption at rest is a property of the volume rather than of the platform |
| SSO (SAML 2.0 / OIDC) | **NOT BUILT** |
| MFA enforceable per org | **PARTIAL** — MFA is enforced; it is not per-organisation policy |
| Document access validated on every request, no naked URLs | **BUILT** — signed, tenant-scoped, time-limited |
| Admin-override logging | **BUILT** |
| **Private knowledge boundaries, embeddings partitioned per org** | **NOT BUILT** — there is no vector store, so there is nothing to partition. Stated rather than claimed |
| **Prompt-injection defence: input sanitisation, tool allow-lists, output schema validation** | **PARTIAL** — outputs are schema-validated and tool access is bounded by the mandate; there is no input sanitisation layer |
| Permissioned tool access by role and module | **BUILT** — no agent mandate exceeds `PROPOSE` |
| Every AI interaction logged with user, model, prompt version, cost | **PARTIAL** — user, model and cost are logged; prompt version is not |
| **Data-residency options** | **NOT BUILT**, and now partly addressed from the other side: provider clearance decides which vendor may receive which sensitivity |
| Tenant-aware rate limiting, fail-closed | **BUILT** |
| problem+json errors, correlation IDs end to end | **BUILT** — every response carries `x-correlation-id` |
| **Idempotency keys on all mutating endpoints** | **PARTIAL** — field sync uses operation-id idempotency and the payment cycle is idempotent at the domain level (it refuses double certification and overpayment). There is no general idempotency-key header |

### H3 — Definition of Done

Stated here as the standard to be measured against, not as something met.

| Clause | State |
|---|---|
| Autosave verified (2–5s, blur, pre-navigation, offline queue) | **NOT BUILT** — Rule 1 remains the largest unbuilt platform rule. The offline queue exists for field sync |
| Zero re-entry proven by tracing one datum end to end | **BUILT** — the eleven-stage chain test, and now the chain check that proves the links rather than assuming them |
| Every state change emits its event and appears in the audit log with the hash chain intact | **BUILT** |
| Every agent passes a contract test: triggers, schema-valid output, confidence floor, HITL gate unbypassable, ACU metered, run logged | **PARTIAL** — the gate, metering and logging are proven; the confidence floor is not, because Rule 4's confidence score is not yet on the output contract |
| **Every dashboard KPI drills to source events** | **BUILT** on all ten delivery screens |
| **AI Insight and Recommendation panels present with Review / Accept / Mitigate / Assign** | **BUILT** on all ten delivery screens |

#### The KPI drill

A figure nobody can open is an assertion rather than a report, and on a
commercial screen that is the difference. Every headline tile on every delivery
screen now opens to the Golden Thread events behind it.

**A tile names the records it was computed from, not a query.** The refs handed
to the drill are the same array the tile added up. A query would be a second
description of the calculation, and the day somebody changes the sum without
changing the query the drill starts lying.

**Content the reader may not see is withheld and said to be withheld.** The
events route applies the entity classification per event, the same decision the
audit feed makes. A drill that silently omitted those rows would be a way round
the capability model.

**A figure with no sources gets no drill.** Four tiles across the ten screens
are deliberately plain, and each for a stated reason: the Golden Thread event
count on the command centre would open the whole ledger, which is what the audit
screen is; and the control screen's Gaps, Not-at-this-size and Not-tracked tiles
all count the *absence* of records, so there is nothing to open. Dressing one of
those in an affordance that opens empty is the placeholder rule 9 forbids.

**One defect fixed at source.** The control report evaluated each item by
filtering the ledger and keeping only `.length`. It now carries the refs it
found, capped at 25 with the truncation stated, so "4 of 5 in place" can be
opened rather than believed.

#### The AI Insight / Recommendation panel

Every part of this existed and lived on one screen — the autopilot queue, which
is where somebody goes once they have already decided to look at what the agents
found. That is backwards: a recommendation is worth something at the moment
somebody is looking at the number it is about.

**Scoped by capability area, filtered by the server**, so the narrowing is one
rule the whole product shares and a screen cannot quietly widen it. A proposal
with a command is placed by the area that command exercises. An observation —
which is most of what the fleet produces — is placed by the areas of the records
in its own evidence, read from `ENTITY_ACCESS`. Placing observations by the
raising agent's *read mandate* was the first attempt and it is far too loose: an
agent that reads eight areas appears on eight screens, and a handover finding
landed on the field command centre because the handover agent reads quality data.
An agent reading something is not the same as a finding being about it.

**An item that is not the reader's is marked, not hidden**, so a design decision
sitting for a week is visible to somebody other than the person already not
acting on it.

Two of the four actions had to be built:

- **Mitigate** closes a finding that was right and is being handled another way.
  Deliberately not a softer rejection — rejecting says the finding was *wrong* —
  and the statement of what is being done instead is mandatory, because
  "mitigated" with nothing behind it reads as a control and is a shrug. Keeping
  the two apart is what leaves the fleet's own accuracy measurable.
- **Assign** names who will decide it and leaves the proposal **open**, because
  moving something to somebody's name is not dealing with it. The assignee must
  actually be able to decide it: an item assigned to somebody who cannot act
  looks owned and cannot move, which is worse than an unassigned one.

**Reject is kept**, though the specification's four do not include it. A finding
that is simply wrong has to be recordable as wrong, or every incorrect finding is
closed as "mitigated" and the platform loses the only signal it has about whether
its own findings are any good.

Emphasis follows what the item offers: where there is a command to run, Accept is
the primary action; where there is not, the card says so and Review is primary
instead. Making Accept the loudest button on an item that runs nothing teaches
people the emphasis means nothing.
| No mocked data behind a project-scoped view | **BUILT** — and enforced by rule 9 of the operating directive |
| A subcontractor seat can never read another trade's snags, another org's data, or unfiltered commercial records | **BUILT** — all three tested |

---
## THE CONSOLIDATED SPECIFICATION v1.0

Arriving now, alongside Parts A to H rather than replacing them, per the standing
principle above. Recorded section by section as it lands.

### 5.4 — Role command centres

Ten are specified (5.4.1 to 5.4.10). Six have been audited against the rendered
screens item by item; **four arrived after that audit and are not yet audited** —
HSE (5.4.7), Information / BIM (5.4.8), Commissioning (5.4.9) and Handover /
Asset (5.4.10). They are named here so their absence is not read as a pass.

Judged on what each screen actually renders, not on whether the data exists
somewhere. Counting the six audited: **13 of 36 KPIs, 8 of 36 widgets and 8 of 30
quick actions** are BUILT or PARTIAL at the named place.

| Command centre | Screen | KPIs | Widgets | Quick actions |
|---|---|---|---|---|
| 5.4.1 Enterprise Client | `enterprise.js` | 1 built, 2 partial, 3 absent | 1 built, 2 partial, 3 absent | 0 of 5 — the two commands present are Create portfolio and Create project |
| 5.4.2 Project Director / CM | `overview.js` | 1 built, 4 partial, 1 absent | 0 built, 2 partial, 4 absent | 0 built, 2 partial (both via the shared insight panel), 3 absent |
| 5.4.3 Design Manager | `design.js` | 2 built, 2 partial, 2 absent | 1 built, 2 partial, 3 absent | 0 built, 2 partial, 3 absent |
| 5.4.4 Commercial Director / QS | `commercial.js` | 4 built, 1 partial, 1 absent | 0 built, 2 partial, 4 absent — three of the four are built, on `contracts.js` and `procurement.js` | 1 built, 3 partial, 1 absent |
| 5.4.5 Planner | `programme.js` | 1 built, 2 partial, 3 absent | 0 built, 5 partial, 1 absent | 2 built, 3 absent |
| 5.4.6 Site Manager (mobile) | `field.js` | 0 built, 1 partial, 5 absent | 1 built, 2 partial, 3 absent | 2 built, 1 partial, 2 absent |

Six findings from that audit worth stating rather than leaving in a table.

**Several widgets are built, on the wrong screen.** Upstream/downstream variation
mismatch, claims evidence strength and package buyout are all real and complete —
on `contracts.js` and `procurement.js` rather than on the commercial command
centre where 5.4.4 puts them. That is a composition problem, not a build one, and
it is much cheaper to fix than the genuinely absent items.

**There is no distinct mobile route.** 5.4.6 names
`/mobile/projects/{projectId}/today`; `field.js` is one screen at every size,
adapted by CSS alone (`.g4`/`.g5` collapse at 1200px and 900px). The ten-field
daily form and the five-to-seven-column registers render as-is on a phone. The
service worker precaches the shell only and explicitly refuses to cache `/v1/`,
so no project data is ever held offline; the offline **queue** for captured work
is real (`lib/outbox.js`, IndexedDB, device id, flush) and is surfaced on the
screen.

**Voice-first did not exist in the interface, and now does.** No microphone,
audio, speech or dictation code existed anywhere in `frontend/` — the
transcription path existed server-side with nothing at the front of it.

Now: **Walk and record** on the field screen, first in the command bar and the
only one carrying the accent, because a button placed fifth is a convenience and
the specification calls voice-first an adoption requirement. Record, file the
audio as evidence on its own, transcribe, review the draft, confirm. And
"Dictate instead" beside every evidence file input across every command panel,
so a note that is sometimes a photograph and sometimes a sentence can be either.

`MediaRecorder` and `getUserMedia`, native, no library. Recorded in full under
the Build Standard in `STATE.md`, including the one thing that had to be built
on the server — a recording is filable *before anything is said about it*,
because on a walk nobody knows the category, the location or the owner until it
has been listened to.

Still **PARTIAL** against E7 in two respects, and neither is capture: segmented
capture (one recording per note rather than a continuous walk split into
several), and the subcontractor / cost-code / package tags on the resulting
record. The location, category, action flag and owner are extracted and
confirmed; the commercial tags are not.

**Commercial data is absent from the field screen rather than hidden from it.**
`field.js` makes no `money()` call and loads no CVR, budget, contract or claim.
That is composition, not policy — the same person navigating to `commercial.js`
sees everything their role permits. 5.4.6's restriction says mobile actions are
package- and location-scoped with sensitive data hidden; the redaction that
exists is role-based, not device-based.

**Aging is the most consistently missing thing across all six.** RFIs, site
observations, obligations and notices all carry days-open or days-overdue. Agent
recommendations, enterprise decision ownership, stage gates, overview actions,
constraint rows, drawings, applications and variations carry none. Four of the
six command centres ask for aging explicitly.

**Decision ownership is on six screens and absent from five.** Present on
enterprise ownership, every insight panel, constraints, site walks and the
obligations calendar. Absent from the command centre's own "Requires attention"
list, and from commercial, design, handover and control.

### The defect this audit found

**Every published CVR carried two invented numbers.** `commercial.js` posted
`costToCompleteMinor: 1_193_000_000` and `accrualsMinor: 47_000_000` — £11.93M
and £470,000 — hardcoded, on every publish, on every project, for every customer.
The EVM snapshot did the same with `plannedValueMinor: 590_000_000`.

The forecast final cost is the number that decides whether a job is making money.
It was being computed from a cost-to-complete that came from nowhere, and the
result was written to an append-only ledger. CPI and SPI were computed against a
planned value belonging to a different project, and they render on three screens.
Nothing on any of them said so.

This is operating-directive rule 9 — no hardcoded demo response inside anything
presented as complete — and it is the exact failure that rule names: *a screen
showing invented numbers is not a finished feature*.

Both are now entered by the person publishing. Cost to complete opens at the
approved budget less cost to date, derived from records the screen already holds,
and the hint says in terms that this is a starting point rather than a forecast.
Accruals start blank, because a default of zero flatters the margin. Planned
value is entered from the baseline. The ACU quote still appears before the button
is pressed.

---

### 8.3 T-WF-01 — Tender intake, compliance matrix and bid/no-bid

**BUILT.** `backend/src/domain/tenderintake.ts`, seven routes, 42 tests.

Most of the workflow already existed and is reused rather than rebuilt: the
compliance matrix is `analyseITT`, the scoring is the ten-factor qualification,
the decision is `decideBidNoBid`, the calendar is the Construction Act
business-day calendar. Three things did not exist and now do — the zoned
deadline, the deliverable register, and the back-planned bid programme — plus
the conditions, dissent and delegated authority on the decision.

| Clause | State |
|---|---|
| Register the immutable invitation issue and deadline in the tender's time zone | **BUILT** — a local reading plus a named IANA zone, resolved to one instant. The issue is immutable; addenda append |
| Extract deliverables, forms, channels, page/file limits, signatures and bonds | **BUILT** as a register with all of those fields. What is **not** built is reading them out of the invitation *file* — they are supplied structured, by a person one at a time or by an agent in bulk |
| Compliance matrix with owner, internal due date, status and source clause/page | **BUILT** — `analyseITT` already gave every line a role owner and a status; the deliverable register adds the internal date and the source anchor (document, clause, page) |
| Score strategic fit, capacity, financial, delivery, contract and win risk | **BUILT** — the ten-factor qualification and the commercial-term assessment, each against the company's own recorded profile |
| Bid/no-bid with conditions, authority and re-review triggers | **BUILT** — conditions, dissent and delegated authority are on the record, and an addendum that moves the deadline or adds a mandatory deliverable makes the decision stale |
| Bid → tender programme and work packages | **BUILT** — eight stages back-planned across the working calendar, and work packages by owner role from the deliverables and the matrix together |
| Deadline conflict or unclear time zone is a Critical clarification | **BUILT** — five of them: no zone stated, a reading that occurs twice, a reading that never occurs, a question deadline at or after the return, and an internal date past the return. A site visit after the return is Major |
| Mandatory pass/fail requirement without an owner blocks Bid approval | **BUILT** — and it is a refusal, not a warning. Source, owner and internal date, on every mandatory deliverable |
| Addendum triggers bid/no-bid re-review | **BUILT** — derived from ledger order, so nothing can clear it except deciding again |
| **AC-T-WF-01-01** all mandatory deliverables have source, owner and internal date | **BUILT** — enforced at the gate in front of a decision to bid |
| **AC-T-WF-01-02** decision shows scoring, dissent/conditions and delegated authority | **BUILT** — and an override with no authority named is refused |
| **AC-T-WF-01-03** no-bid stays searchable and cannot proceed to pricing | **BUILT** — the rationale is preserved, the opportunity stays in the pipeline, and both `convertToProject` and the tender programme refuse it |

**Three decisions worth recording.**

**The deadline is a wall-clock reading and a zone, never an instant on its own.**
An ITT says "12:00 noon on 14 October"; whose noon is a question almost nobody
asks, and a portal that closes at noon in Dublin has closed an hour before noon
in London. Where the invitation did not state a zone, the assumption is recorded
*and raised as a Critical clarification* rather than defaulted. Twice a year a
local reading is not one instant at all — 01:30 happens twice on the night the
clocks go back and never on the night they go forward — and both are named, with
the earlier instant taken, because a deadline resolved early is a bid submitted
early.

**Staleness is derived from the order of the ledger, not from timestamps.** Both
records stamp `new Date().toISOString()`, and two events written milliseconds
apart can carry the same millisecond; `>` misses a real addendum and `>=`
invents one. The append-only log already knows what came after what.

**The programme is refused rather than compressed.** The eight stages scale
proportionally to the window with a floor of ten business days. Below that the
platform says how many days remain and how many the spine needs, because a
programme that reads as achievable and is not is a worse answer than "this is
not enough time".

**Not built, and not to be claimed:** reading deliverables or requirements out
of the invitation file itself (they are supplied structured), a bid-team
resource model behind the programme, and any link from the bid programme to the
delivery programme engine.

**The event names.** `TENDER_RECEIVED`, `TENDER_REQUIREMENTS_EXTRACTED`,
`TENDER_ADDENDUM_ISSUED` and `TENDER_PROGRAMME_CREATED` are new. The
specification's `COMPLIANCE_MATRIX_CREATED` and `BID_DECISION_RECORDED` are
`ITT_ANALYSED` and `BID_NO_BID_DECIDED`, already written to an append-only
ledger under those names. **These are not renamed** — renaming an event orphans
every record already carrying the old name, and the standing principle is that
nothing is removed or replaced. The mapping is asserted by a test so it stays
readable against the ledger.

### 8.3 (continued) — the eight tender workflows, and 8.4

All eight of section 8.3 are built. Each is described below. The stage gate at
8.4 is not declared and is the only thing outstanding in this section.

| Workflow | State |
|---|---|
| ~~**T-WF-02** documents, scope gap, contract risk~~ | **BUILT** — see below |
| ~~**T-WF-03** measurement, BoQ, estimate schedule~~ | **BUILT** — see below |
| ~~**T-WF-04** package strategy, enquiry, bidder issue~~ | **BUILT** — see below |
| ~~**T-WF-05** supply-chain and self-delivery pricing routes~~ | **BUILT** — see below |
| ~~**T-WF-06** clarifications, addenda, return intelligence~~ | **BUILT** — see below |
| ~~**T-WF-07** commercial adjudication and governance~~ | **BUILT** — see below |
| ~~**T-WF-08** submission, award, zero-re-entry conversion~~ | **BUILT** — see below |
| **8.4** stage gate Definition of Done | The lifecycle gate machinery and the replayable ledger. The seven-point tender gate itself is not declared, and it depends on the A2 gate work at item 6 below |

### 8.3 (continued) T-WF-02 — Tender information, scope gap and contract risk review

**BUILT.** `backend/src/domain/tenderreview.ts`, nine routes, 24 tests.

This is the review that happens between deciding to bid and starting to price:
what is in the pack, whether it can be relied on, which package carries each
obligation, what the contract actually says, and what the price is *not*
covering. Everything it produces is frozen into one snapshot, because the price
has to be built on a stated version of the information.

| Clause | State |
|---|---|
| Register every tender document with revision, date and the packages it informs | **BUILT** — and the register is what everything else keys off |
| Validate the pack: unreadable files, missing citations, contradictory revisions | **BUILT** — three checks. Unreadable and missing-citation are Critical and block the packages that document informs; the same document at two revisions is Major and blocks nothing, because a superseded sheet in a pack is common and only sometimes wrong |
| Identify the contract form, edition and amendments | **BUILT** — a standard form stated "as amended" with no schedule of amendments in the pack is Critical and blocks **every** package |
| Map scope to packages and surface gaps and overlaps | **BUILT** — no package is a gap, more than one is an overlap, and both are reported with the source clause |
| Extract contract obligations with clause, verbatim wording and owner | **BUILT** — the wording is held verbatim, because the executed wording is what binds and a paraphrase is a second document |
| Reviewer accepts or rejects each extraction | **BUILT** — and the reviewer is not the extractor: the permission matrix already separates reading a contract (`RCUIX`) from accepting an interpretation (`RA`) |
| Record qualifications and exclusions, each traceable to a finding | **BUILT** — `QUALIFICATION_UNTRACEABLE` refuses one that names no scope gap or obligation |
| Freeze the review as the basis the price is built on | **BUILT** — a content hash over form, documents, scope, obligations and qualifications, registered as evidence |
| Addendum impact after the freeze | **BUILT** — derived, not asserted |
| **AC-T-WF-02-01** every obligation links to a clause or page and carries a reviewer status | **BUILT** — and the freeze is refused while any obligation is still `DRAFT` |
| **AC-T-WF-02-02** every qualification traces to a gap or an obligation | **BUILT** — refused at the point of entry, not reported afterwards |
| **AC-T-WF-02-03** addendum impact names the affected packages, scope, obligations and qualifications | **BUILT** — computed from the frozen review's own mapping |

**Three decisions worth recording.**

**A missing schedule of amendments blocks everything.** A standard form "as
amended" with the amendments absent is not a contract form. The amendments are
where the fitness-for-purpose obligation, the uncapped damages and the payment
terms live, so pricing the standard form prices a different contract. Every
other document finding blocks only the packages that document informs; this one
blocks the lot, and the freeze refuses while it stands.

**A gap and an overlap fail in opposite directions.** A gap is built and nobody
priced it, which costs the job. An overlap is priced twice, which loses the bid
— and that is the quieter failure, because nobody ever finds out why. Both are
reported, neither is auto-resolved.

**The extractor does not accept their own extraction.** An interpretation nobody
independently signed is one person's reading of a contract. This is not a new
control: the matrix already gives the QS extraction rights and the acceptance
right to the person carrying commercial authority, and the freeze simply refuses
while an obligation sits unreviewed.

**Not built, and not to be claimed:** reading obligations out of the contract
*file* (they are supplied structured, as with T-WF-01), a risk score or
likelihood/impact rating on an obligation, and any automatic link from a
qualification into the submitted bid pack's qualifications schedule.

**The event names.** `SCOPE_GAP_IDENTIFIED`, `CONTRACT_INTERPRETED` and
`TENDER_REVIEW_FROZEN` are new and take the specification's names.
`TENDER_DOCUMENT_VALIDATED` is an `UPDATE` that may create, so re-validating a
register after a document arrives appends rather than being refused as "already
exists". Addendum impact is written as `ADDENDUM_IMPACT_ASSESSED`, which is the
name T-WF-06 gives the same act — one event, not two.

---

### 8.3 (continued) T-WF-05 — Supply-chain and self-delivery pricing routes

**BUILT.** `backend/src/domain/pricingroute.ts`, eight routes, 35 tests, and a
panel on the Tender & Procurement screen with six commands.

| Clause | State |
|---|---|
| Maintain independent supplier and self-perform routes per package | **BUILT** — and the self-perform estimate is a first-class option beside the returns, not a fallback |
| Normalise quotations to a common scope, unit, tax, currency, base date and commercial basis | **BUILT, in the comparison** — `ReturnComparison` (T-WF-06) already holds the raw return immutably and every adjustment against it, each citing a return line or an issued clarification. Its figure is read here as the **normalised** one rather than rebuilt |
| Map inclusions, exclusions, qualifications and provisional sums to the scope matrix | **PARTIAL** — every exclusion must be disposed as priced, clarified or a project exclusion. Mapping onto the T-WF-02 scope-matrix item is **not built** |
| Calculate evaluated cost including risk, interface, management and programme impacts | **BUILT** — four heads, signed, each with a basis an adjudication can test |
| Preserve the raw return and the adjustment bridge; no overwriting a supplier value | **BUILT, already** — the raw return refuses a second write |
| Select a route provisionally for master pricing, subject to adjudication | **BUILT** — with the four bases, and whether it was the cheapest evaluated option |
| Currency conversion and tax treatment must be explicit | **BUILT** — as a `TAX_OR_CURRENCY` adjustment naming both rates, which is where it belongs: it is a normalisation, not an evaluation |
| Non-comparable returns stay flagged; ranking suppressed if material data is missing | **BUILT** — an undisposed exclusion makes that route not comparable and withholds the ranking |
| Related-party or conflict declaration mandatory where configured | **BUILT** — declared before the selection, and the person who declared it cannot then choose that firm |
| **AC-T-WF-05-01** raw, normalised and evaluated reconcile through visible adjustments | **BUILT** — asserted arithmetically for every option |
| **AC-T-WF-05-02** each exclusion maps to a priced allowance, clarification or accepted project exclusion | **BUILT** — and an undisposed one blocks the selection |
| **AC-T-WF-05-03** the selected route shows cost, risk, programme and capacity basis | **BUILT** — all four required, named in the refusal when missing |

**Three decisions worth recording.**

**Normalisation and evaluation are different acts and are kept apart.** Getting
a quotation onto the common basis is a *correction* — the same scope, differently
priced. What choosing that firm costs us is an *addition*. Mixing them produces
a number nobody can defend, because half of it is arithmetic and half of it is
judgement. The comparison holds the first and this holds the second, and the
three figures reconcile.

**The self-perform estimate is kept independent of the quotations.** An estimate
built after seeing them is not an estimate, it is a reaction to them, and it
will land just under the cheapest one every time. It also has to state peak
labour: capacity is what constrains a self-perform route, and a route chosen
without it was chosen on price alone.

**An evaluation adder may be negative.** A firm that takes single-point design
responsibility off us genuinely costs less than its price. Refusing negatives
would push that saving into a fudge somewhere nobody can see it.

**Not built, and not to be claimed:** mapping each exclusion onto the T-WF-02
scope-matrix item it belongs to; any automatic currency conversion — the rate
and the restatement are recorded as an adjustment by a person, deliberately;
and any link from a selected route into `consolidateMasterPricing`, which
remains a separate act.

**The event names.** `SELF_PERFORM_PRICED`, `RETURN_NORMALISED` and
`PRICING_ROUTE_SELECTED` are the specification's own. `TENDER_RETURN_RECEIVED`
is `SUBMISSION_RECEIVED` and the comparison's own raw-return record, both
already on the ledger and mapped rather than renamed.

**One correction made on the way.** `compareReturns` authorised
`PROCUREMENT_AWARD` `X`. The commercial roles who decide between buying a
package and self-performing it hold `R` and `A`, not `X` — so the person who
adjudicates could not read what they were adjudicating. It computes and writes
nothing, so it is a read; it is `R` now, with the `COMMERCIAL_L3` sensitivity
gate unchanged, and a test asserts the deciding roles can read it.

---

### 8.3 (continued) T-WF-04 — Package strategy, enquiry composition and bidder issue

**BUILT.** `backend/src/domain/enquiry.ts`, ten routes, 41 tests, and a panel on
the Tender & Procurement screen with eight commands.

The RFQ already existed and is not rebuilt: eligibility against the supplier
register, design maturity governing the pricing basis, acknowledgements, and the
reconciliation of who was asked against who answered. What did not exist is the
part that decides whether a comparison is defensible at all.

| Clause | State |
|---|---|
| Create the package and a completeness checklist from dependency rules | **BUILT** — six mandatory document kinds, checked at every composition |
| Generate scope, interface/attendance and design responsibility schedules | **BUILT, already** — `composeTenderPackage` takes the design responsibility matrix and the attendances, and scores completeness. Not rebuilt |
| Assemble a numbered, versioned enquiry pack from controlled documents | **BUILT** — revisions 1, 2, 3, each with a content hash over its documents and its exception |
| Approve bidders and issue with confidentiality and access controls | **BUILT** — approval is a separate act from composing and never by the composer; access is per-firm and revocable |
| Track sent, delivered, opened, acknowledged, declined and clarification participation | **BUILT** for the five states, with the whole history kept. Clarification participation is already on the RFQ reconciliation and is not duplicated |
| Close the return at the deadline; late return follows configured acceptance authority | **BUILT** — the close names who returned and who went silent, and a late return costs an approval and a named authority |
| Package cannot issue below full mandatory completeness unless an authorised exception is included | **BUILT** — both halves. The exception names what is missing, why, and who accepted the risk, and it is carried to every recipient |
| Revoked bidder access does not delete prior issue evidence | **BUILT** — asserted against the ledger, not merely against the read model |
| Addendum creates a new pack revision and an acknowledgement requirement | **BUILT** — and re-issuing does not discharge it: being sent an addendum is not agreeing to price it |
| **AC-T-WF-04-01** recipient-specific issue evidence shows the exact pack revision | **BUILT** — revision number and content hash per firm |
| **AC-T-WF-04-02** a bidder sees only authorised package data | **BUILT** — a domain refusal rather than a rendering filter, and the return type carries no other firm and no count of them |
| **AC-T-WF-04-03** the return workspace locks at the deadline, preserving an authorised late path | **BUILT** |

**Three decisions worth recording.**

**Incomplete does not mean blocked, it means authorised.** Refusing a short pack
outright would be simpler and wrong: packages go out missing a document
constantly, and a platform that only says no teaches people to route around it —
into a spreadsheet, where nothing is recorded at all. The exception is refused
if it names no reason or nobody behind it, and refused again if it excepts a
document that is actually in the pack, which is what stops one being attached
out of habit.

**A bidder cannot infer the size of the field.** `bidderView` returns one firm's
own pack and nothing else — no other firm, no count, no acknowledgement rate.
A field of two is priced differently from a field of six. It is a refusal in the
domain rather than a filter applied when rendering, because a filter is
something a later screen forgets to apply, and "never invited" and "removed"
return the identical answer so nothing can be learned from the difference.

**Revoking access does not delete the evidence.** That firm did receive revision
2 on the Thursday and did open it, and both stay true. The revocation is an
additional fact. Re-inviting a removed firm is then refused: it has to be a
deliberate decision rather than a side effect of a distribution list.

**Not built, and not to be claimed:** any actual transport — the recipients and
times are recorded, and sending is somebody else's system; a bidder-facing
portal; and per-recipient watermarking of the documents themselves.

**The event names.** `ENQUIRY_PACK_APPROVED`, `ENQUIRY_ISSUED`,
`BIDDER_ACKNOWLEDGED` and `RETURN_PERIOD_CLOSED` are the specification's own.
`TENDER_PACKAGE_CREATED` is `TENDER_PACKAGE_COMPOSED`, already on the ledger and
mapped rather than renamed. Three are beyond the list because each is a distinct
fact that would otherwise be hidden inside another event:
`ENQUIRY_PACK_REVISED`, `BIDDER_ACCESS_REVOKED` and `LATE_RETURN_ACCEPTED`.

---

### 8.3 (continued) T-WF-03 — Measurement, BoQ and estimate schedule builder

**BUILT.** `backend/src/domain/measurement.ts`, nine routes, 58 tests, and a
panel on the Tender & Procurement screen with six commands.

The estimate above this already existed and is not rebuilt: twenty cost heads,
time-related costs by the week, contingency from the risk register at P80,
margin on the cost beneath it. What did not exist is the layer underneath — the
measured items, and where each quantity came from.

| Clause | State |
|---|---|
| Import or create measurable rows with stable item IDs and hierarchy | **BUILT** — a stable reference per item and a `parent` link; a parent that is not in the schedule is reported. Importing from a **file** is **not built**: items arrive structured, as with every other workflow |
| Validate units, formulas, duplicates, omissions and quantity-source links | **BUILT** — all five. A reference at two units, a reference twice, a formula that does not produce its own quantity, a measured zero, and an item naming no source |
| Create take-off overlays or model object sets as evidence | **PARTIAL** — a named model object set is a valid source in place of a drawing. Graphical overlays are **not built** |
| Build unit-rate components and separate direct cost, preliminaries, risk and OH&P | **BUILT** — the build-up holds labour, material, plant and subcontract as constants times costs, and produces **direct cost only**. Preliminaries, risk and OH&P are priced once at the estimate and deliberately not spread across item rates |
| Create estimate versions and reconciliation from a prior estimate | **BUILT** — schedule-to-schedule, naming every movement as added, removed, remeasured or repriced |
| Freeze the pricing snapshot before supplier returns and adjudication | **BUILT** — a content hash over items, rates and currency, registered as evidence |
| Unit conflict or formula error blocks the freeze | **BUILT** — as a refusal naming each error |
| Provisional quantity or rate is tagged and included in an uncertainty report | **BUILT** — four bases, and a report saying what share of the direct cost is not firm and why each line is not |
| A revised drawing invalidates the linked quantity until reviewed | **BUILT** — every item measured from the superseded revision is named, and the freeze is refused until each is answered |
| **AC-T-WF-03-01** every priced item has a quantity source or an authorised allowance basis | **BUILT** — enforced at the freeze, and a drawing named without its revision counts as no source |
| **AC-T-WF-03-02** totals reconcile across item, package and currency | **BUILT** — item to schedule by construction; schedule to schedule through a reconciliation that reports when the movements do not account for the difference. Cross-currency reconciliation is **refused** rather than guessed |
| **AC-T-WF-03-03** revision impact identifies the quantities needing remeasurement | **BUILT** |

**Three decisions worth recording.**

**The formula is re-evaluated, not trusted.** `12.4 × 3.85 × 2` is 95.48 and the
line says 94.58. It is a transposition, it happens constantly, and it is
invisible in a spreadsheet because the spreadsheet computed the wrong cell too.
The evaluator is a small recursive-descent parser over numbers, `+ - * /` and
parentheses — deliberately not a general expression language and deliberately
not `eval`, because this parses text arriving over an API and the only safe
evaluator for that is one that cannot express anything else. Anything it cannot
read is reported as unreadable rather than run, and the comparison carries a
0.1% tolerance so written-down rounding does not produce a finding on every line.

**A reissued drawing flags every item measured from it, not the ones that
changed.** Most will not have changed. *Which* ones did is exactly the question
nobody can answer three weeks later, and pricing on through a reissue is how a
bid goes out against a drawing that no longer exists. "Unchanged" is a first-
class answer and has to be recorded — otherwise there is no way to tell an item
somebody checked from one nobody opened.

**Preliminaries, risk and OH&P are not spread across item rates.** The
specification asks for them to be *separated*, and the separation the platform
already has is the right one: they are priced once at the estimate, on the basis
each actually has. Adding a percentage to every rate would have satisfied the
words and destroyed the property that makes a slipped programme a known number
here rather than a surprise at final account.

**Not built, and not to be claimed:** importing a bill from a file; graphical
take-off overlays; and any link from a frozen measurement schedule into the
twenty-head estimate — the two are separate records today and combining them is
a decision, not a wiring job.

**The event names.** `BOQ_IMPORTED` and `RATE_BUILDUP_CREATED` are the
specification's own. `TAKEOFF_CAPTURED` is `TAKEOFF_COMPLETED`, already on the
ledger under that name, and `ESTIMATE_FROZEN` already exists on the `Estimate`
entity — the schedule's freeze is `MEASUREMENT_FROZEN` because it freezes a
different record, not because the old name was wrong.
`QUANTITY_REMEASURE_REQUIRED` is beyond the specification's list, because a
drawing invalidating a quantity is a fact in its own right.

---

### 8.3 (continued) T-WF-06 — Clarifications, addenda and tender return intelligence

**BUILT.** `backend/src/domain/tenderintel.ts`, ten routes, 51 tests, and a
panel on the Tender & Procurement screen with seven commands.

| Clause | State |
|---|---|
| Number and classify a clarification as internal, client-side or bidder-side | **BUILT** — and on the **same** `Clarification` entity and `TQ-nnn` sequence as the RFQ-scoped supplier question that already existed, so the register is one register rather than two with colliding references |
| Link question and response to the exact controlled information and the impacted records | **BUILT** — a document, clause, drawing, package or scope item, and a question naming none of them is refused |
| Issue the approved response consistently to entitled recipients, with read evidence | **BUILT** — recipients and the issue time are the record, the issue is registered as evidence, and each recipient's read is recorded separately |
| On addendum, calculate the impact on compliance, quantity, estimate, supplier returns and programme | **PARTIAL** — the addendum register is T-WF-01 and the impact on the frozen review (packages, scope, obligations, qualifications) is T-WF-02, both already built and reused. Impact on **quantities and the estimate** is **not built**: it depends on T-WF-03's measured items, which do not exist |
| Normalise returns and detect variance, outliers and missing scope | **PARTIAL** — the comparison normalises through the adjustment bridge, and `analyseReturns` already detects variance and generates bidder-specific questions. Automatic outlier detection across the comparison is **not built** |
| Reconcile clarification responses and update the comparison without changing the raw return | **BUILT** — the raw return is written once and refuses a second write; every adjustment sits beside it |
| **AC-T-WF-06-01** every adjustment links to a raw return or a clarification | **BUILT** — a refusal at the point of entry, and a clarification that has been raised but not answered is refused too |
| **AC-T-WF-06-02** recipients and issue times are auditable | **BUILT** — plus who acknowledged and when |
| **AC-T-WF-06-03** completeness/confidence falls when material queries remain open | **BUILT** — and the ranking is withheld rather than footnoted |
| Commercially confidential bidder data cannot leak across bidders | **BUILT** — refused in both directions: a confidential answer to a competitor, and an open answer that misses an entitled bidder |
| Late addendum may trigger a deadline review and a decision record | **BUILT, already** — T-WF-01's addendum makes the bid decision stale and only deciding again clears it |
| Unresolved material variance carries priced risk to adjudication | **BUILT** — the close records what is being carried and what it is worth |

**Three decisions worth recording.**

**The register is one register.** `procurement.raiseClarification` already wrote
`CLARIFICATION_RAISED` for the RFQ-scoped supplier question. The tender-level
register writes the same event against the same entity and continues the same
`TQ-nnn` sequence, so a reference on a piece of paper still identifies exactly
one thing. What was added is the two sides that had nowhere to go — the internal
question and the question to the client — and the link into the controlled
information.

**Completeness is a count, not two proportions multiplied.** The first version
multiplied coverage by answered-queries, and on a real case — both firms
returned, one query open — the screen said **0% settled**. Nobody believes a
number that claims nothing is known about a comparison holding two complete
priced returns, and a measure nobody believes is worse than none. It now counts
what the comparison needs to know (one return per firm, one answer per material
query) against what it has. Confidence is stated from the facts rather than from
a threshold on the percentage.

**Closing is not refused while a query is open.** A bid deadline does not wait
for an answer, and refusing here would only teach people to mark queries
immaterial — destroying the one signal that matters. What the close records is
exactly what is being carried and what it is worth.

**Not built, and not to be claimed:** the quantity and estimate halves of the
addendum impact (they need T-WF-03); automatic outlier detection across a
comparison; and any bidder-facing portal — the recipients are recorded, and
sending is somebody else's system.

**The event names.** `CLARIFICATION_RAISED` and `ADDENDUM_IMPACT_ASSESSED`
already existed and are reused. `CLARIFICATION_ISSUED` and
`RETURN_COMPARISON_UPDATED` are new and take the specification's names;
`ADDENDUM_RECEIVED` is `TENDER_ADDENDUM_ISSUED`, already on the ledger under
that name from T-WF-01 and mapped rather than renamed. One name is beyond the
specification's list — `CLARIFICATION_ACKNOWLEDGED` — because read evidence is a
different fact from issue and folding it into the issue record would have made
the issue event mean two things.

**One security correction made on the way.** The `Clarification` entity was
classified `DESIGN_INFORMATION` with no sensitivity. It holds nothing but
procurement acts, so that was wrong before; it would have been a leak after,
because the register now carries commercial-in-confidence bidder questions and
anyone holding `DESIGN_INFORMATION` read could have listed them. It is now
`PROCUREMENT_AWARD` / `COMMERCIAL_L3`, asserted by a test.

---

### 8.3 (continued) T-WF-07 — Commercial adjudication, bid programme and governance

**BUILT** as `backend/src/domain/settlement.ts`, six routes, 23 tests.

Named *settlement* rather than *adjudication*: `adjudicate` in the tender engine
already means choosing a subcontractor from an evaluation, and two different
acts sharing a word in one codebase is how somebody eventually calls the wrong
one. Settlement is what the industry calls this meeting anyway.

| Clause | State |
|---|---|
| Freeze the pre-adjudication snapshot | **BUILT** — taken at the moment the meeting opens, because "what did the estimate say before we started moving numbers" is exactly what cannot be recovered afterwards |
| Reconcile cost to scope and benchmark; review abnormal rates | **PARTIAL** — the bridge reconciles; automatic abnormal-rate detection is **not built** |
| Review programme logic, resources, lead times, milestones | **PARTIAL** — the programme is approved at the price's cut-off; the logic review itself is the planning engine's and is not driven from here |
| Set allowances, margin and qualifications with reason and owner | **BUILT** — eight adjustment categories, every one carrying a reason and a named decision-maker |
| Record action decisions and the post-adjudication snapshot | **BUILT** |
| Route to approvals under delegated authority | **BUILT** — an approval above the authority held is refused, and the person who ran the settlement cannot approve it |
| Every manual adjustment requires reason and evidence | **BUILT, and split** — see below |
| Programme and price share one scope/addendum cut-off | **BUILT** — a mismatch is refused, not reported |
| **AC-T-WF-07-01** pre/post snapshots and the bridge reconcile exactly | **BUILT** — to the penny, and the refusal shows the arithmetic |
| **AC-T-WF-07-02** all actions closed or carried as submission conditions | **BUILT** — and the carried ones become conditions on the bid |
| **AC-T-WF-07-03** price, programme, risk and qualifications share one cut-off | **BUILT** for price and programme |

**Evidence is required where a document exists, and not where one does not.** A
supplier price, a scope correction and a benchmark correction all point at a
document and are refused without one. Margin, contingency and risk allowance are
judgements taken in a room. A platform that demanded a file for a margin decision
would get one — the agenda, re-attached eight times — and the register would look
evidenced while proving nothing. That is a deliberate departure from the clause
as written, and this is the reason.

**A fifth event beyond the four named.** `SETTLEMENT_ACTION_RECORDED`, because an
action is not a price adjustment and riding it on the adjustment event would put
two different acts under one name.

**Not built:** automatic abnormal-rate and coverage detection, resource and
lead-time review driven from the settlement, and the risk and qualification
registers sharing the cut-off explicitly (price and programme do).

---

### 8.3 (continued) T-WF-08 — Submission, award and zero-re-entry conversion

**BUILT.** `backend/src/domain/award.ts`, five routes, 22 tests.

The bid pack was already compiled and locked with a content hash, and a contract
could already be converted from it carrying the qualifications and exclusions
forward. What was missing sat either side of that, and both halves are where
money is lost.

| Clause | State |
|---|---|
| Compile an ordered submission pack with completeness checks | **PARTIAL** — `compileBidPack` already assembles and locks it in a fixed order. Deterministic file-name, size and page-limit checks against the deliverable register are **not built** |
| Lock the pack with a hash and exact source versions | **BUILT, already** — `BID_PACK_LOCKED` is a `FREEZE` carrying the content hash |
| Submit via the configured channel; capture receipt, portal id and evidence | **BUILT** — and the receipt is bound to the pack's content hash at the moment it is recorded |
| Post-tender clarifications as separate controlled cycles | **NOT BUILT** |
| On award, compare award terms to the submission and raise departures | **BUILT** — computed, never typed |
| Create budget and package buyout targets from accepted data ids | **BUILT** — the budget's cost codes are the estimate's own priced cost heads |
| Main contract baseline, procurement records, mobilisation tasks | **PARTIAL** — `convertBidToContract` already creates the contract carrying qualifications and exclusions. Procurement records and mobilisation tasks are **not built** |
| **AC-T-WF-08-01** the receipt identifies the exact immutable pack hash | **BUILT** — and the position reports `hashMatches`, so a pack re-locked after submission is visible rather than silent |
| **AC-T-WF-08-02** contract sum, budget and buyout targets reconcile without re-entry | **BUILT** — asserted arithmetically in the tests |
| **AC-T-WF-08-03** award departures are visible before contract execution | **BUILT** — and blocking: conversion is refused while one is open |
| Unsuccessful bid preserves market and lessons data | **BUILT** — a loss records who won and at what, and stays searchable |

**Three decisions worth recording.**

**A departure is a difference, not an opinion.** Every one compares two recorded
values and names both. Nothing here judges whether a departure is *acceptable* —
a person does that, and the acceptance carries their reason, because the
question a year later is never whether the sum differed but who agreed it could.

**Silence is not a change.** A letter of intent names two terms and nothing else.
Reporting the unstated ones as departures would bury the real ones, so a term the
award does not mention is left alone.

**Converting needs two authorities.** It approves a cost baseline as well as
accepting an award, so a project manager who can do the second cannot do the
first. Both are checked before anything is written.

**The event names.** `TENDER_SUBMITTED`, `AWARD_RECEIVED`,
`AWARD_DEPARTURE_IDENTIFIED` and `BID_CONVERTED_TO_CONTRACT` are new and take the
specification's names. `TENDER_SUBMISSION_LOCKED` is `BID_PACK_LOCKED` here,
already on an append-only ledger under that name and mapped rather than renamed.

**Not built:** the deterministic file-name / size / page-limit checks against the
deliverable register, post-tender clarification cycles, and the procurement
records and mobilisation tasks the conversion could also seed.

---

## The site visit — walk to handover

Not from the numbered workflow specifications; requested directly. Recorded here
because it cuts across Concept, Design, Tender and Construction rather than
sitting in one of them.

**BUILT.** `backend/src/engines/sitevisit.ts`, six routes, 46 tests, a panel on
the field screen, and a PDF report with the photographs in it.

| Asked for | State |
|---|---|
| Site visit recorded with who attended | **BUILT** — purpose, date walked, attendees, weather |
| Site design and constraints | **BUILT** as a findings register over twelve site categories, each finding declaring what it obliges |
| Site logistics | **PARTIAL by design** — elements, cranes, routes and the largest delivery are recorded and seven checks run against them. The platform does **not** draw a logistics plan, and says so rather than producing a picture with no geometry behind it |
| Ongoing planning from the visit to handover | **BUILT** — every finding carries the stage it is discharged at (`MOBILISATION · CONSTRUCTION · COMPLETION · HANDOVER`), and one that sequences work raises a real `Constraint` in the planning engine so the lookahead refuses to commit that activity |
| Automated reports | **BUILT** — the report is rendered from the ledger on demand, so one pulled today reflects what has been discharged since the walk. Branded, hashed and recorded as an export like every other document |
| Pictures from the site visit | **BUILT** — mandatory on anything observed on site, embedded in the PDF as `DCTDecode`, captioned with the finding they belong to, each embedded once however many times referenced |

**The mechanism that makes it different from a PDF.** A permission carries the
lead time the authority itself quotes and the date the work it unlocks starts.
Those two facts and today's date answer the only question that matters — *is this
already late* — in days rather than adjectives, and it is answered the day the
finding is raised rather than the day somebody notices.

**Not built:** a drawn logistics plan; a bid-stage walk (tenant-scoped, belongs
with tender intake); multi-crane and multi-route plans through the console;
photographs in the HTML export.

---

## Implementation order

Set against dependency rather than against the order the clauses arrived in.

1. **Rule 5 — the audit event fields.** `role_at_action`, `reason`,
   `lifecycle_state`, `ai_confidence`. Everything downstream reads this record,
   and a field added later cannot be backfilled onto events already written to an
   append-only journal. It has to be right before volume accrues.
2. **Rule 4 — the agent output contract.** Confidence, commercial, programme and
   contract impact; risk level to four levels. Every approval screen renders it.
3. **Rule 1 — autosave, drafts, conversation persistence, visible save state.**
4. **Rule 3 — the two missing event families:** design approval, and Building
   Safety Act gateway submissions.
5. ~~Rule 2 — chain-break detection and escalation to the Commercial Manager.~~
   **Done.** Six links checked by reference; the exception is recorded, raised
   once, closes itself, and is addressed to the role the rule names. A background
   sweep is the part not built.
6. **A2 — entry gates for all seven states, and the real exit criteria**, with a
   gate evidence bundle on the transition and an evidence link per condition, plus
   reverse transitions at Project Director authority with a mandatory reason.
7. **A4 — the eight missing objects.** `Brief`, `FeasibilityStudy` and
   `OptionAppraisal` first, because A2's CONCEPT gate cannot be written without
   them; then `Retention`, `COBieRow` and `GoldenThreadItem` for handover.
8. **A3's feature gaps** — realtime, full-text search, embeddings, SSO, and the
   refresh window — which do not need a stack decision.
9. **Memory layers — organisation-level benchmarks** aggregated from project outcomes and
   read by Concept and Tender, which is the compounding-asset half of the
   requirement.
10. **A5 — the model router.** The ten declared inputs, and the decision
    recorded alongside its inputs. Data sensitivity first: `DataSensitivity`
    already exists and already governs who may read a record; extending it to
    govern which vendor a record may be sent to is the highest-value single
    change in this section, and it is a data-protection control, not a
    performance one.
11. **A5 — Layer 3, Knowledge AI.** Blocked behind the vector store, which is
    blocked behind the A3 stack decision.
12. **A3's stack decision** — Postgres, Kafka, NestJS, OPA, Terraform. Blocked on
   the product owner, not on engineering.

Superseded ordering note, kept for honesty: The
   CONSTRUCTION criteria move to where the specification puts them, and the
   thresholds (PC readiness, defect count, O&M completeness) become configured
   values rather than numbers in code.

### What Parts E to H add to that order

Recorded separately because they are stage work rather than platform work, and
because the order above has to be finished first — every item below reads the
audit event, the agent contract or the lifecycle gate.

12a00. ~~T-WF-07 — the settlement meeting.~~ **Done.** The adjustment bridge
    reconciles to the penny or the approval is refused, every adjustment names
    who decided and why, actions are closed or carried as conditions, and the
    price and programme share one cut-off.

12a0. ~~T-WF-08 — submission, award and conversion.~~ **Done.** The receipt
    binds to the pack hash, the departures are computed rather than noticed, and
    the budget and buyout targets come off the estimate. The submission
    completeness checks are the part not built.

12a0000000. ~~T-WF-05 — buy it or do it.~~ **Done.** Raw, normalised and
    evaluated as three reconciling figures, the self-perform estimate kept
    independent of the quotations, every exclusion disposed before anything is
    ranked, and a route chosen on cost, risk, programme and capacity together.
    That completes all eight workflows of section 8.3; only the 8.4 stage gate
    remains. Mapping each exclusion onto its scope-matrix item is the part not
    built.

12a000000. ~~T-WF-04 — the enquiry pack and who holds it.~~ **Done.** Numbered
    revisions with a content hash, per-firm issue evidence naming which one they
    hold, an addendum that makes every acknowledgement stale by name, an
    authorised exception where a pack goes out short, revocation that preserves
    the evidence, and a return period that closes with a named authority for the
    late one. The transport itself is the part not built.

12a00000. ~~T-WF-03 — measurement and the bill.~~ **Done.** Every quantity
    names the drawing and revision it came off or the person who authorised the
    allowance, the formula is re-evaluated against the quantity beside it, rates
    are built from constants and costs rather than typed, a reissued drawing
    flags what was measured from it, and the freeze refuses all three failures.
    Importing a bill from a file and graphical take-off overlays are the parts
    not built.

12a0000. ~~T-WF-06 — clarifications and the return comparison.~~ **Done.** One
    clarification register across all three sides, issued to entitled recipients
    with the reads recorded, the confidentiality fence in both directions, and a
    comparison whose raw returns are never edited and whose every adjustment
    cites a return line or an issued clarification. The quantity and estimate
    halves of the addendum impact are the part not built; they need T-WF-03.

12a000. ~~T-WF-02 — the tender information review.~~ **Done.** The document
    register with its three validation checks, the scope matrix with gaps and
    overlaps, the contract obligations held verbatim and accepted by somebody
    other than the extractor, qualifications that must trace to a finding, and
    one frozen snapshot the price is built on. Reading obligations out of the
    contract file is the part not built.

12a. ~~T-WF-01 — tender intake.~~ **Done.** The zoned deadline, the deliverable
    register with source/owner/internal date, the addendum that appends, the
    back-planned bid programme, and the authority on an override. Reading
    deliverables out of the invitation file is the part not built.

12b. ~~D-WF-03 — the design review cycle.~~ **Done.** Submit, comment,
    disposition, close, decide, with a blocking-comment rule that "accepted with
    comments" cannot get round. Suitability codes and a review trigger on
    drawing issue are the parts not built.

13. ~~The Build Standard on the delivery screens.~~ **Done.** Both clauses now
    hold on all ten delivery screens. What remains of E11, F3 and G3 is the exact
    per-persona panel layout, which is arrangement rather than capability.
14. **Suite-specific contract machinery** — NEC4 Early Warning and Compensation
    Events with their quotation and reply clocks, JCT Relevant Events, FIDIC
    Clause 20. `ContractSuite` already knows the names and nothing behaves
    differently because of it, which is the gap. It is the highest-value item in
    Part E: a missed CE notification is a lost entitlement, and that is money.
15. **Declare the ten construction agents against the existing runtime**, with
    their triggers, HITL mode and ACU tier. The runtime is built; the declaration
    is not. This depends on Rule 4's output contract, which is item 2.
16. **The four ACU tiers (LOW / MED / HIGH / PREMIUM)** as a declared vocabulary,
    since every agent table in Parts D to G references them.
17. **Handover clocks** — acceptance starts the Defects Liability Period and the
    retention release schedule. Both figures are already on the contract and
    nothing starts from them. Five events are missing: `DLP_STARTED`,
    `RETENTION_RELEASED`, `GATEWAY3_SUBMITTED`, `ASSET_ACTIVATED`,
    `LESSON_RECORDED`.
18. **The PC Readiness Score** as a computed, drillable score over its eight
    named inputs, replacing the narrative assessment, plus Exit Gate G5. Depends
    on item 6, the gate machinery.
19. **COBie validation.** Blocked on `COBieRow`, which is item 7.
20. **What-If scenario modelling** — the flagship query in E6. Monte Carlo answers
    how likely a date is; this answers what to do about it, and they are different
    engines.
21. **Long-lead tracking, procurement schedule from milestones, and automatic
    cycle fan-out on contract creation** — three E2/E4 items that are small
    individually and each remove a re-entry point.

**One pricing decision for the product owner, blocking nothing but worth
settling**: the ACU bundle table advertises figures a ×3 markup produces, and the
same document requires ×4. The platform derives the yield from the multiplier, so
it publishes the ×4 figures. If the advertised numbers are the commitment, the
multiplier has to move.
