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
6. **A2 — entry gates for all seven states, and the real exit criteria.** The
   CONSTRUCTION criteria move to where the specification puts them, and the
   thresholds (PC readiness, defect count, O&M completeness) become configured
   values rather than numbers in code.
