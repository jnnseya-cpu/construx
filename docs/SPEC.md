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
| Breaking the chain raises an exception alert to the Commercial Manager | **NOT BUILT** — nothing detects or escalates a broken link |

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
5. **Rule 2 — chain-break detection and escalation to the Commercial Manager.**
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
