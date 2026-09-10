# Level 7 AI ITT and Bid Engines

**Developer-ready, platform-agnostic product and technical specification**
Version 1.0 · 10 September 2026 · Product architecture and implementation baseline

Prepared for implementation across construction, infrastructure, engineering,
professional services and complex project delivery platforms.

**Purpose.** Define a governed, end-to-end artificial intelligence system that
converts an invitation to tender into a validated submission, an executable
contract baseline and reusable organisational intelligence.

**Classification.** Developer build specification.

---

## Document control

| Field | Value |
|---|---|
| Product name | Level 7 AI ITT and Bid Engines |
| Document type | Product requirements, system architecture, data model, workflow, API and acceptance specification |
| Primary users | Bid directors, estimators, planners, commercial managers, technical leads, executives, reviewers and platform administrators |
| Implementation target | Any multi-tenant SaaS, private cloud or enterprise platform |
| Core principle | AI may execute controlled information work; authorised humans retain legal, commercial, technical and safety accountability |
| Normative language | **Must** is mandatory; **should** is recommended; **may** is optional |
| Owner | Groupe Nseya Digital / JNN Global Ltd — OS venture |

---

## How this document sits beside the rest

This is a **specification**, not a record of what is built. `docs/STATE.md`
remains the only record of what exists. Where this document and `STATE.md`
disagree about whether something is built, `STATE.md` is right.

It is merged here rather than filed apart because §18 of
[`docs/ai-os-blueprint.md`](ai-os-blueprint.md) already carries the maturity
model this document extends. Read them in order: §18 says how deep agents can go
and where CONSTRUX sits; this says what the top of that ladder requires and how
to build it.

Where a CONSTRUX mechanism already satisfies a requirement, it is named in a
**CONSTRUX position** note under that section. Where nothing satisfies it, the
note says so plainly.

### The document is in two parts, and neither replaces the other

| Part | Edition | Covers |
|---|---|---|
| **Part I** | Product and platform specification, v1.0 | Product definition, the L0–L7 operating model, action risk classes, reference architecture, canonical domain model, memory architecture, agent control plane |
| **Part II** | Engine and kernel handoff | The seven L7 properties, the bid kernel, agent-by-agent specifications, the lifecycle state machine, the reference schema, the ports, and the ordered cost of closing the gaps |

Part II arrived first and is unchanged. Part I is the wider frame around it.
Where they overlap — the agent contract, the ports, the evidence rules — Part I
states the requirement and Part II states the implementation.

### Three ladders, and how they reconcile

The word *level* is used three ways across these documents. They are not in
conflict, and confusing them would be easy, so they are set out together once.

| Ladder | Where | What it measures |
|---|---|---|
| Six depths of construction AI | Blueprint §18.2 | How deep the *behaviour* goes: retrieval to governed operational autonomy |
| **L0–L7 autonomy** | Part I §2.1 below | The same ladder with an L0 at the bottom and depth 5 split into goal pursuit (L5) and multi-agent coordination (L6). Governed operational autonomy is L7 |
| **L7.1–L7.7 properties** | Part II §0 | Not rungs at all. Seven *properties* a build must have to claim the top rung honestly |

So: **L7 is the rung. L7.1 to L7.7 are what earn it.** A system can sit at L7 on
the autonomy ladder and still fail Level 7, because the rung describes what the
system is allowed to do and the properties describe whether it can be trusted to.

CONSTRUX operates routinely at L3 and L4, selectively at L5 and L6, and reaches
L7 only inside a granted envelope — two agents of eighty-one. Against the seven
properties it holds four, partially holds three, and Part II §8 orders the work
that closes them.

### The reference stack is a reference, not a decision

The specification names a service-per-engine deployment, a message bus, workers
in a second language and a managed cloud. CONSTRUX is built on a different and
deliberate footing, recorded in `CLAUDE.md` and `docs/STATE.md` as settled:
**zero runtime dependencies**, Node type-stripping with `.ts` imports, an
in-process hash-chained ledger with a journal and snapshots, Postgres behind
`LEDGER_POSTGRES_MODE` rather than under everything, and no framework.

Those are not in conflict, because the mandatory rules in §3.2 and the ports in
Part II §7 are **properties, not products**. A build satisfies them or it does
not. Nothing here is a reason to rewrite the platform.

---

# Part I — Product and platform specification

## Contents and implementation map

| Part | Coverage |
|---|---|
| A | Product definition, Level 7 operating model and scope |
| B | Reference architecture and platform adaptation layer |
| C | Domain model, knowledge graph and event model |
| D | Agent organisation, orchestration and autonomy controls |
| E | End-to-end ITT and bid workflows |
| F | Estimating, planning, contract, technical and submission engines |
| G | User experience, permissions, APIs and integrations |
| H | Security, assurance, evaluation and observability |
| I | Functional requirements and acceptance tests |
| J | Implementation roadmap and definition of done |

---

## 1. Product definition and required outcome

The system shall receive an ITT or equivalent procurement package in any
supported channel, establish a controlled tender workspace, understand every
issued document and requirement, coordinate specialist agents and human
contributors, develop a priced and compliant offer, validate the submission,
preserve the evidence behind every material statement, and convert the accepted
bid into an executable delivery baseline after award.

**Level 7 means governed operational autonomy.** The system may plan work,
delegate to specialist agents, use approved tools, request missing information,
retry recoverable failures, monitor deadlines and complete low-risk actions
without step-by-step prompting. It **must not** make an irreversible
contractual, financial, technical, regulatory or safety decision outside an
explicit authority policy.

### 1.1 Required business outcomes

- Prevent administrative disqualification through complete, traceable coverage
  of mandatory submission requirements.
- Reduce tender mobilisation time by automatically creating the document
  register, requirement matrix, work breakdown, responsibility assignments and
  deadline plan.
- Improve bid quality by **challenging** scope, price, programme, risk, contract
  position and evidence rather than merely drafting prose.
- Protect margin by identifying missing scope, optimistic productivity, unpriced
  interfaces, cash exposure, securities, time bars and contract amendments.
- Create one controlled source of tender truth supporting concurrent
  contributors without losing revision, approval or evidence history.
- Convert bid commitments into live delivery controls so assumptions, prices,
  resources, risks, obligations and programme commitments survive award.
- Build reusable organisational intelligence from verified outcomes while
  preventing unapproved project content from contaminating corporate knowledge.

### 1.2 In scope

| Capability group | Mandatory scope |
|---|---|
| Opportunity | Capture, qualification, bid or no-bid, capacity, probability and pursuit governance |
| ITT ingestion | Files, portals, email, archives, spreadsheets, drawings, models, addenda and clarifications |
| Requirement control | Compliance matrix, obligation extraction, scoring, ownership, evidence and completeness |
| Solution development | Scope, methodology, design interfaces, logistics, resources, safety, quality, environment and social value |
| Commercial | Quantity, rate, estimate, supplier quote, risk allowance, mark-up, cash flow and reconciliation |
| Planning | WBS, logic, calendars, resources, procurement, commissioning, baseline and scenarios |
| Contract | Clause model, amendments, departures, notices, securities, liabilities, insurance and approval |
| Production | Response drafting, schedules, forms, CVs, case studies, graphics references and document assembly |
| Assurance | Red-team, compliance, arithmetic, contradiction, evidence, legal and executive review |
| Submission | Packaging, naming, limits, portal checks, approval, upload record and receipt |
| Award conversion | Tender-to-contract reconciliation and creation of the delivery control baseline |
| Learning | Win and loss analysis, estimate actuals, benchmark updates and controlled knowledge promotion |

### 1.3 Out of scope without separate authorisation

- Signing or accepting a contract.
- Submitting a legally binding offer without final authorised approval.
- Approving engineering design, temporary works or safety-critical methods.
- Committing expenditure or appointing a supplier.
- Changing approved company risk appetite or delegation of authority.
- Circumventing a procurement portal, access control, CAPTCHA, anti-bot measure
  or client restriction.
- Training foundation models on client-confidential information without an
  approved data agreement.

> **CONSTRUX position.** Every item in §1.3 is already refused, and by a
> mechanism stronger than a policy statement: signing, contract acceptance,
> design approval, safety closure, expenditure commitment, supplier appointment
> and role assignment are all `aiAllowed: false` on the event catalogue, so a
> model persuaded to attempt one still cannot write the event. Risk appetite and
> delegation live in the permission matrix, which no agent may change. Two items
> have no mechanism because they have no surface yet: **portal circumvention**
> (there is no portal integration to circumvent, which makes this a rule to
> write before the connector rather than after) and **training on client
> content** (the platform sends content to a provider and stores no training
> corpus, so the rule needs an explicit data agreement clause rather than code).

---

## 2. The Level 7 operating model

### 2.1 Autonomy definition

| Level | System behaviour | Permitted example | Required control | CONSTRUX |
|---|---|---|---|---|
| L0 | No AI execution | Manual workspace | Normal application controls | Every screen works without AI |
| L1 | Retrieval | Find a clause | Source citation | Routine |
| L2 | Generation | Draft a response | Human review | Routine, and marked as AI-authored |
| L3 | Analysis | Detect scope conflict | Evidence and confidence | Routine |
| L4 | Workflow execution | Create and route a clarification | Permission and audit | Routine |
| L5 | Goal pursuit | Complete a compliance matrix across documents | Bounded plan and stop conditions | Selective — the bid response pipeline is the clearest case |
| L6 | Multi-agent coordination | Coordinate estimate, programme and risk challenge | Orchestrator policy and reconciliation | Selective — the morning briefing coordinates; the reconciliation loop between agents does not exist |
| L7 | Governed operational autonomy | Continuously control tender completion and execute reversible approved actions | Authority envelope, deterministic gates, monitoring, rollback and accountable human approval | **Two agents of eighty-one**, and only inside a granted envelope |

### 2.2 The Level 7 execution contract

Every autonomous run shall be created as a typed agent run. The run shall define
the goal, permissible sources, permitted tools, budget, deadline, required
outputs, quality thresholds, escalation conditions and the actions that require
approval. **An agent shall not infer authority from a natural-language
instruction when the action policy requires explicit approval.**

```
AgentRun {
  id, tenant_id, tender_id, agent_definition_version,
  goal, input_object_refs[], allowed_tool_ids[],
  authority_policy_id, max_cost_acu, deadline_at,
  output_schema_id, minimum_confidence,
  status, checkpoints[], approvals[], evidence_refs[],
  started_at, completed_at, model_route, trace_id
}
```

> **CONSTRUX position.** The last sentence of §2.2 is the platform's own
> strongest safety property, and it is enforced structurally rather than by a
> policy check: authority comes from the permission matrix and the event
> catalogue, never from the text of a request, so an instruction embedded in an
> uploaded document cannot widen what the agent may write. That is the case the
> evaluation harness exists to prove.
>
> Of the run's eighteen fields, the platform carries the agent definition and
> version, the goal, the inputs, the outputs, the evidence, the confidence floor,
> the approvals, the timings and the correlation id, and it reserves and settles
> the ACU cost. Four are missing: **`tender_id`** as a run scope, so a run is not
> attributable to one bid; **`allowed_tool_ids`** as a per-run tool allowlist;
> **`deadline_at`** on the run itself; and **`checkpoints`**, which is what a
> resumable run needs and the bid response pipeline currently gets by writing
> one section per pass instead.

### 2.3 Action risk classification

| Class | Description | Examples | Default handling |
|---|---|---|---|
| A | Read only | Search, extract, compare, calculate a draft | Autonomous |
| B | Reversible internal write | Create a task, tag evidence, update a working forecast | Autonomous with full event log |
| C | Controlled internal state | Change owner, mark a requirement complete, promote knowledge | Rule validation plus role permission |
| D | External non-binding communication | Reminder, information request, meeting proposal | Template and recipient policy; approval configurable |
| E | Commercial or contractual commitment | Final price, tender submission, qualification withdrawal | Named human approval required |
| F | Technical, regulatory or safety acceptance | Design acceptance, safety closure, statutory statement | Competent authorised person only |

> **CONSTRUX position.** This is the platform's model expressed at a finer grain,
> and the mapping is exact enough to be worth stating. Classes **E and F** are
> the `aiAllowed: false` set — 646 of 766 event types — and no envelope may cover
> one. Classes **A and B** are the ordinary agent path, already fully event-logged.
> Class **C** is the capability matrix plus the phase gates. Class **D** is the
> gap: there is **no external communication surface** at all, so the recipient
> policy and template rules have nothing to govern yet, and they should be
> written with the connector rather than after it.
>
> The Site Services module already carries a three-class version of this — A
> autonomous, B assisted, C human — with a build-failing test that refuses an
> unclassified event so it cannot fall out of the automation denominator.
> Extending that to six classes across the whole catalogue is the concrete form
> of the platform-wide automation measure named in blueprint §18.14.

---

## 3. Reference architecture

The product shall use a modular architecture separating platform-specific
services from the tender domain. The domain engines must run against stable
interfaces, so the same engine can be embedded in an existing project platform,
sold as a standalone service, or deployed inside an enterprise-controlled
environment.

### 3.1 Logical layers

| Layer | Responsibilities |
|---|---|
| Experience | Web workspace, mobile review, dashboards, document viewer, comparison views, approvals and accessibility |
| Domain services | Opportunity, tender, compliance, estimating, planning, contract, response, assurance, submission and award conversion |
| Agent control plane | Registry, orchestrator, planner, scheduler, policy engine, tool gateway, memory, evaluation and model router |
| Project intelligence | Canonical domain model, knowledge graph, vector retrieval, rules, calculations, temporal state and evidence lineage |
| Content processing | OCR, layout extraction, spreadsheet parsing, CAD and BIM metadata, archive expansion, language detection and malware scanning |
| Integration | Identity, CDE, ERP, CRM, estimating, scheduling, BIM, email, storage, e-signature, portals and webhooks |
| Foundation | Tenant isolation, encryption, secrets, event bus, object store, database, observability, backup and disaster recovery |

### 3.2 Mandatory architecture rules

- The language model **shall not be the system of record.** Durable state shall
  reside in typed domain objects and immutable events.
- All material outputs shall carry provenance at sentence, field, calculation or
  cell level where practical.
- **Deterministic services shall perform** arithmetic, date calculation, rate
  build-up, unit conversion, file validation, permissions and approval
  enforcement.
- Model providers shall be replaceable through a model gateway. No domain
  service may depend directly on one provider's request format.
- Agent tools shall expose narrow, typed operations. Direct unrestricted
  database, shell, email or external API access is prohibited.
- Every content version shall be immutable. A new issue creates a new version
  and triggers impact analysis against dependent objects.
- Tenant, legal entity, client and project boundaries shall be enforced **before**
  retrieval, prompt construction and tool execution.
- Long-running workflows shall be resumable, idempotent and tolerant of model,
  integration or network failure.

> **CONSTRUX position — seven of eight are already the platform's rules, and
> they are the load-bearing ones.**
>
> The model is not the record: the ledger is, and the engine's arithmetic is what
> lands in it — a model returning a different risk index does not overwrite the
> computed one, and the evaluation harness tests exactly that. Provenance is
> carried at record level and, for AI-authored narrative, at section level with
> provider, model class and prompt version. Every calculation named in the third
> rule is deterministic and server-side; the browser holds no rule the API does
> not publish. Providers sit behind the orchestrator with health-aware fallback.
> Agents hold typed capability, not database or shell access. Tenant and project
> boundaries are enforced in `backend/src/identity/` before any read.
>
> Two gaps. **Immutable content versions with impact analysis on a new issue** is
> half-built: versions are immutable and superseding is recorded, but nothing
> propagates the impact to dependent objects, which is the targeted-invalidation
> gap Part II §5 names. **Resumable, idempotent long-running workflows** exist
> only where they were built by hand — field sync uses operation-id idempotency
> and the bid response pipeline resumes by writing one section per pass. There
> is no general workflow provider, so every long run that needs resumption has
> to invent it.

### 3.3 Platform adaptation interface

```ts
interface HostPlatformAdapter {
  identity(): IdentityProvider;
  objectStore(): ObjectStore;
  eventBus(): EventPublisher;
  workflow(): WorkflowProvider;
  notifications(): NotificationProvider;
  audit(): AuditSink;
  secrets(): SecretProvider;
  entitlement(): EntitlementProvider;
  integrationRegistry(): IntegrationRegistry;
}

interface BidEngineAPI {
  createTender(command): Tender;
  ingestContent(command): IngestionJob;
  executeAgent(command): AgentRun;
  requestApproval(command): Approval;
  exportSubmission(command): ExportJob;
  convertAward(command): ProjectBaseline;
}
```

> **CONSTRUX position.** Seven of the nine host services exist: identity, object
> store, notifications, audit, secrets with per-purpose derivation and key ids,
> entitlement as the module grant and package model, and an event publisher as
> the transactional outbox. **Workflow and the integration registry do not.**
> Five of the six engine commands exist as routes — tender creation, ingestion,
> agent execution, approval and award conversion — and `exportSubmission` does
> not, for the same reason the portal port does not: there is nothing to export
> to.

---

## 4. Canonical domain model

The canonical domain model is mandatory for adaptability. Each host platform maps
its local objects to the canonical types. Domain agents operate only on canonical
identifiers and may follow links back to the host object through external
references.

### 4.1 Core entities

| Entity | Key fields and relationships |
|---|---|
| Tenant | Legal entities, policies, data region, entitlements, identity realm |
| Opportunity | Client, source, sector, value, probability, pursuit decision, capacity impact |
| Tender | Opportunity, procurement route, contract form, deadlines, currency, status, participants |
| TenderIssue | Issue number, issued date, source, superseded issue, delta and acknowledgement |
| ContentObject | File, message, form field, portal page, model, drawing, spreadsheet or archive |
| DocumentVersion | Hash, MIME type, language, extracted layout, security result and revision status |
| Requirement | Exact text, source span, type, mandatory status, scoring, owner, response and evidence |
| Obligation | Actor, trigger, action, deadline rule, consequence, clause and phase |
| Deliverable | Format, due date, owner, approval route, dependencies and submission location |
| ScopeItem | System, asset, work package, location, discipline, quantity and interface |
| EstimateItem | Quantity, unit, rate build-up, source, escalation, risk, confidence and total |
| ScheduleActivity | WBS, duration, logic, calendar, resources, constraints and milestones |
| Risk | Cause, event, effect, likelihood, impact, owner, response and allowance link |
| Assumption | Statement, basis, price or programme effect, validation date and status |
| Clarification | Question, basis, proposed answer, client response and impact assessment |
| ResponseSection | Requirement links, draft, claims, evidence, approvals and export position |
| Evidence | Source object, source span, verification status, validity, owner and permitted uses |
| Approval | Object, action, authority role, decision, conditions, timestamp and signature evidence |
| Submission | Manifest, package hash, approvers, channel, receipt and immutable snapshot |
| ProjectBaseline | Awarded scope, budget, programme, risks, obligations, assumptions and commitments |

> **CONSTRUX position.** Sixteen of these twenty exist as entity types under
> CONSTRUX names, within a catalogue of 344. Four do not, and they are the same
> four Part II identified from a different angle: **`TenderIssue`** as an issue
> with a delta and an acknowledgement, **`Evidence`** as a first-class verified
> object with validity and permitted uses, **`Deliverable`** with its own
> approval route and submission location, and **`ResponseSection`** carrying its
> claims separately from its prose. The bid response pack has sections; they do
> not carry tagged claims.

### 4.2 Requirement lifecycle

```
DETECTED → NORMALISED → CLASSIFIED → ASSIGNED → IN_PROGRESS
  → READY_FOR_REVIEW → APPROVED → PACKAGED → SUBMITTED

Exception states: DUPLICATE, SUPERSEDED, NOT_APPLICABLE,
CLARIFICATION_REQUIRED, BLOCKED, REJECTED, WAIVED_WITH_AUTHORITY
```

A requirement may be marked complete **only when its completion rule passes.**
The default rule requires an approved response, all required evidence, satisfied
formatting constraints, resolved blockers and no open material contradiction.

> **CONSTRUX position.** The compliance matrix carries a status but not this
> lifecycle, and the completion rule is the important half. The bid response
> pipeline already refuses to issue a pack where a named deliverable has no
> response or a stated deadline has no date — two of the five conditions. The
> other three, **approved evidence, satisfied formatting constraints and no open
> contradiction**, each depend on something not built: the evidence registry, the
> submission rule set and the consistency agent. `WAIVED_WITH_AUTHORITY` is worth
> singling out: a waiver that is recorded with a name is the difference between a
> considered risk and a missed requirement, and the platform has no such state.

### 4.3 Evidence lineage

| Lineage component | Mandatory content |
|---|---|
| Source identity | Content object and immutable version |
| Location | Page, sheet, cell, paragraph, bounding box, model element or message segment |
| Extraction | Parser version, OCR confidence and extraction timestamp |
| Transformation | Normalisation, unit conversion, translation or calculation steps |
| Use | Requirement, claim, estimate, risk, activity or decision that consumes the evidence |
| Validation | Verifier, method, date, result and expiry |
| Access | Classification, tenant boundary, client restriction and permitted export |

> **CONSTRUX position.** Source identity, access classification and the tenant
> boundary are built; location is partly built, since a measured item names its
> document hash, page and table. **Extraction, transformation, validation and
> use are not recorded as lineage.** This table is the most precise statement of
> the L7.5 gap in either part, and it is worth reading beside Part II §2.6: that
> section says what to build, this one says what each node must carry.

---

## 5. Knowledge and memory architecture

### 5.1 Memory partitions

| Memory | Permitted contents | Promotion rule |
|---|---|---|
| Run memory | Temporary reasoning state, intermediate tool results | Destroyed or archived after the policy retention period |
| Tender memory | Issued content, decisions, drafts and tender-specific facts | Automatically retained within the tender |
| Project memory | Awarded baseline and delivery evidence | Created only after award conversion |
| Corporate knowledge | Approved case studies, methods, policies, rates and lessons | Named knowledge steward approval |
| User preference | Display and drafting preferences | User-managed; **never treated as project fact** |
| Model cache | Reusable non-sensitive embeddings or results | Scope, version and expiry required |

### 5.2 Retrieval requirements

- Hybrid retrieval shall combine metadata filters, keyword search, semantic
  retrieval and graph traversal.
- Retrieval shall apply access control **before** content is sent to a model.
- The retriever shall prefer current tender issues for current-state questions
  but include historic versions for change and claim analysis.
- Responses shall quote or paraphrase only evidence available within the
  requesting user's and agent's authority.
- Retrieval results shall return source span, version, confidence, relevance
  reason and supersession state.
- Agent prompts shall have explicit context budgets and shall summarise only
  through traceable derived artefacts.

> **CONSTRUX position.** Three of the six partitions exist as declared layers —
> project, organisation and asset — with read and write declared separately per
> agent, which is the promotion rule in §5.1 expressed as a capability rather
> than a process. The estimating agent reads the rate library and does not edit
> it; the lessons agent writes. **Run memory, user preference and the model cache
> are not partitions**, and the first of those matters most: an agent's
> intermediate state is not retained at all, which is why a cut-off pass leaves
> its section unwritten rather than resumable mid-work.
>
> On retrieval: access control before the model sees content is enforced, and
> the lexical index that finds near-duplicates works without vectors, so
> embeddings are optional and charged. **Graph traversal and supersession state
> are not available to the retriever** — the same missing edges as everywhere
> else in this document. The rule about preferring current issues while
> including historic versions for claim analysis is the retrieval face of the
> bitemporal gap: without a second time axis the retriever cannot distinguish
> *superseded* from *never true*.

---

## 6. Agent control plane

### 6.1 Required services

| Service | Developer requirement |
|---|---|
| Agent registry | Versioned definitions, goals, schemas, permissions, tools, evaluation suite and deployment status |
| Orchestrator | Build the dependency graph, schedule work, collect outputs, resolve conflicts and enforce stop conditions |
| Planner | Decompose goals into typed tasks; prohibit execution of unapproved action classes |
| Scheduler | Priorities, deadlines, retries, concurrency, rate limits and tenant quotas |
| Tool gateway | Schema validation, permissions, secrets, idempotency, timeout, redaction and audit |
| Policy engine | Attribute and role-based access, delegation limits, project rules, client restrictions and risk classes |
| Model router | Select by task, sensitivity, latency, cost, context and evaluation result |
| Memory service | Scoped retrieval, working memory, summarisation and approved promotion |
| Evaluation service | Offline benchmark, shadow tests, online sampling, regression and release gates |
| Trace service | Run graph, prompts or hashes where permitted, sources, calls, cost, latency, decisions and errors |
| Human task service | Review queues, SLA, escalation, substitution, delegation and decision capture |

> **CONSTRUX position.** Seven of eleven exist: the agent registry with versioned
> definitions and a deployment state, the orchestrator, the policy engine as the
> permission matrix with attribute-based rules, the model router with
> health-aware fallback and a wallet refusal, the memory service as the three
> declared layers, the evaluation service as the harness and gold set, and the
> trace service — every response carries a correlation id and every AI event
> carries provider, model class, prompt version and settlement.
>
> Four do not: the **planner** as a goal decomposer with an action-class
> prohibition, the **scheduler** with retries, concurrency and tenant quotas, the
> **tool gateway** with per-tool schema validation and redaction, and the **human
> task service** with service levels, escalation and delegation. The last is the
> most visible absence to a customer: proposals queue, and nobody is chased.

### 6.2 The agent output envelope

```
AgentOutput<T> {
  status: completed | partial | blocked | abstained | failed;
  result: T | null;
  evidence: EvidenceReference[];
  assumptions: Assumption[];
  uncertainties: Uncertainty[];
  contradictions: Contradiction[];
  confidence: { score, method, calibration_band };
  actions_taken: ToolAction[];
  actions_proposed: ProposedAction[];
  approvals_required: ApprovalRequest[];
  next_tasks: TaskProposal[];
}
```

> **CONSTRUX position.** A finding already carries its summary, its consequence,
> its evidence, its severity and — unusually — **what the agent looked for and
> did not find**, because an absence has no source record to cite. That last
> field is not in this envelope and should be: `uncertainties` covers doubt about
> what was read, not the thing that was missing.
>
> Missing from the platform: the **`abstained` status** as distinct from
> `blocked` or `failed`, which is what the stop rules in §6.3 need in order to be
> visible; `contradictions` as a typed output; and `calibration_band` on the
> confidence, which cannot be honest until there are outcomes to calibrate
> against — the L7.6 gap again.

### 6.3 Stop and abstention rules

An agent shall stop and abstain when:

- the required source is missing, corrupt, unreadable or outside the access
  boundary;
- two authoritative sources conflict and no precedence rule resolves them;
- the action exceeds financial, contractual, technical or safety authority;
- confidence falls below the configured threshold for the task class;
- a deterministic validator rejects the proposed output;
- the remaining ACU, time or tool budget cannot complete the run safely;
- a prompt injection, malicious attachment or unexpected instruction is
  detected;
- the agent identifies a material conflict of interest or a prohibited client
  condition.

> **CONSTRUX position.** Five of the eight are enforced. An unreadable or
> quarantined source stops ingestion with the reason on the record; an action
> beyond authority is refused by the matrix and the catalogue; a confidence floor
> is declared per agent and the finding is withheld below it; a deterministic
> validator rejecting the output is the whole design — the engine's arithmetic
> wins over the model's; and an empty wallet refuses the call rather than running
> it free. Prompt injection is defended structurally rather than detected, which
> is stronger for governed writes and weaker for a drafted response, and it is
> the case the evaluation harness was built for.
>
> Three are not: **unresolved source conflict with no precedence rule** — the
> platform records a discrepancy but has no precedence model to try first; a
> **time budget** on a run, since only cost is bounded; and **conflict of
> interest or a prohibited client condition**, which has no record to check
> against. The first of those is worth building with the clause library, because
> precedence between contract documents is usually stated in the contract.

---

## 7. Specialist agent organisation

| Agent | Purpose | Inputs | Outputs | Authority boundary |
|---|---|---|---|---|
| Opportunity director | Qualify the opportunity and prepare the bid or no-bid case | Opportunity, CRM, historic performance, capacity | Decision paper, score, conditions, risks | Cannot approve pursuit |
| Tender intake | Create controlled tender state | ITT content and channel metadata | Register, issues, deadlines, missing content | Cannot finally classify binding terms |
| Requirement control | Build and maintain the compliance matrix | All current issued documents | Requirements, owners, rules, completion state | Cannot waive a mandatory requirement |
| Scope intelligence | Decompose scope and detect gaps | Drawings, models, bill, specifications | Scope graph, interfaces, conflicts, clarifications | Cannot accept a design solution |
| Contract intelligence | Model obligations and commercial exposure | Contract, amendments, schedules | Clause matrix, departures, notices, risk flags | Cannot give final legal approval |
| Estimate | Build traceable cost and price | Quantities, rates, quotes, location and risk | Estimate, basis, confidence, reconciliations | Cannot approve the final price |
| Planning | Build and challenge the programme | WBS, quantities, outputs, access, procurement | Programme model, checks, scenarios | Cannot approve the baseline |
| Technical solution | Develop a compliant methodology | Requirements, constraints, corporate methods | Method, design basis, interfaces, deliverables | Cannot approve engineering |
| Procurement | Develop supply-chain evidence and comparisons | Packages, supplier data, quotations | Enquiry, comparison, exclusions, recommendation | Cannot appoint a supplier |
| Response composer | Create requirement-linked narrative | Approved solution facts and evidence | Response sections and schedules | Cannot invent claims or values |
| Red team | Challenge win strategy and weaknesses | The complete working bid | Findings, severity and recommended correction | Cannot alter an approved response directly |
| Submission controller | Validate and package the final response | Approved documents and portal rules | Manifest, checks, package, receipt record | Cannot submit without authority |
| Award conversion | Create the delivery baseline | Final submission and executed contract | Reconciliation, baseline and handover tasks | Cannot infer accepted departures |
| Learning | Capture outcome and verified lesson | Tender results and delivery actuals | Benchmark proposals and lessons | Cannot promote knowledge automatically |

> **CONSTRUX position.** Ten of the fourteen have a working counterpart in the
> eighty-one-agent fleet, and every authority boundary in the right-hand column
> is already enforced by the event catalogue rather than by the agent's own
> restraint — which is the difference between a boundary and a promise. Four have
> no counterpart: **red team**, **submission controller**, **award conversion**
> as one governed act, and **learning** in the sense of proposing a benchmark
> from delivery actuals. Those are the same four gaps Part II reached from the
> other direction, which is worth noting: two independent readings of the same
> product found the same holes.
>
> One boundary here is sharper than the platform's and worth adopting: *the red
> team cannot alter an approved response directly*. A challenge that can edit
> what it challenges is not a challenge.

---

## 8. End-to-end ITT workflow

### 8.1 Tender receipt and workspace creation

1. Capture the invitation through the API, email, upload, connected storage or
   authorised portal interaction.
2. Create a tender identifier, an immutable receipt event and an initial access
   policy.
3. Run malware, file integrity, encryption and duplicate checks **before**
   extraction.
4. Expand archives recursively while preserving the original path and container
   hash.
5. Classify each item and extract document metadata, layout, text, tables, form
   fields and embedded objects.
6. Identify the procurement timetable, submission channel, clarification
   deadline and time zone.
7. Create the tender issue register and require acknowledgement of client
   addenda.
8. Generate the initial requirement matrix, deliverable register, responsibility
   matrix and tender programme.
9. Escalate unreadable, password-protected, missing or contradictory content.

> **CONSTRUX position.** Steps 1 to 6 and step 9 are built: intake accepts any
> format or pasted text, the ingestion path looks at the bytes before trusting
> the extension, nothing is decompressed blindly and a file that should not have
> been accepted is quarantined with the reason on the record rather than deleted.
> The tender deadline is recorded in the zone it is read in, which is step 6 done
> properly. **Step 7 — the issue register with client acknowledgement — and the
> responsibility matrix half of step 8 do not exist.** Acknowledgement matters
> more than it looks: an addendum nobody acknowledged is the one a bid team
> misses.

### 8.2 Addendum and revision impact

Each new issue shall trigger semantic and structural differencing. The impact
engine shall identify requirements added, changed or removed; revised quantities;
changed contract wording; drawing changes; date changes; invalidated responses;
estimate dependencies; programme dependencies; and affected risks and
clarifications. It shall create review tasks and **prevent submission while a
material change remains unassessed.**

```
on TenderIssueReceived(issue):
  verify_integrity(issue)
  delta   = compare(issue, previous_issue)
  impacts = traverse_dependencies(delta.changed_objects)
  mark_stale(impacts.derived_outputs)
  create_review_tasks(impacts, by_severity_and_deadline)
  block_submission_if(impacts.material_unresolved > 0)
```

> **CONSTRUX position. Not built, and this is the clearest statement of the gap
> in either part.** Six lines of pseudocode name four things the platform lacks
> at once: the issue delta, the dependency traversal, the staleness mark and the
> submission block. Each of the first three needs the graph edges Part II §2.3
> called for. The fourth needs only the other three, and it is the one a bid
> director would notice first — a submission that proceeds while an addendum
> sits unassessed is the failure this whole engine exists to prevent.

### 8.3 Requirement extraction rules

- Split compound clauses into independently verifiable requirements when they
  have different owners, evidence or completion rules.
- Retain the exact source wording **and** a normalised interpretation.
- Classify *shall*, *must*, *required* and equivalent binding terms; **do not
  depend on keywords alone.**
- Extract pass or fail conditions, scoring weights, response limits and
  requested attachment formats.
- Connect cross-references and defined terms **before** assigning meaning.
- Detect negative conditions, exceptions and client-reserved discretion.
- Set low confidence where tables, scans, handwritten content or cross-document
  context reduce extraction reliability.

> **CONSTRUX position.** Verbatim text with a separate normalisation is already
> the rule, and compliance is judged on the verbatim. **Defined-term resolution
> before interpretation is not built** and is the most consequential of these
> seven: a requirement read without its definitions is read wrongly, quietly, and
> the error only surfaces at evaluation. Response limits and attachment formats
> also go unextracted, which is why there is no submission rule set.

---

## 9. Bid strategy and governance engine

### 9.1 Bid or no-bid score

The engine shall produce **both** a weighted score and an economic view. The
score is advisory and must expose factor weights, evidence, uncertainty and
sensitivity. **A high probability of winning shall not override** unacceptable
liability, insufficient capacity, negative cash exposure or a prohibited client
condition.

| Factor | Example measures | Hard stop capable |
|---|---|---|
| Strategic fit | Sector, geography, client, capability, reference value | No |
| Client quality | Payment history, behaviour, procurement credibility | **Yes** |
| Win probability | Competition, incumbent, relationship, differentiation | No |
| Commercial quality | Margin range, cash conversion, securities, inflation | **Yes** |
| Delivery capacity | People, plant, design, supplier and programme capacity | **Yes** |
| Contract exposure | Liability, damages, indemnity, termination and insurance | **Yes** |
| Bid investment | Cost, duration, opportunity cost and partner dependency | No |
| Information quality | Scope maturity, surveys, quantities and access | **Yes** |

> **CONSTRUX position.** The ten-factor algorithm covers these eight and the
> decision is a governance event a machine may not write. **The hard-stop column
> is the addition worth making.** Today a poor factor lowers a score; it cannot
> refuse. Five of the eight factors are marked hard-stop capable here, and the
> reason is the one §9.1 states in a single line: a dangerous project may be
> winnable. A scoring model that can only weigh cannot express *no, whatever the
> other factors say*.

### 9.2 Governance gates

| Gate | Entry condition | Approval | Exit artefact |
|---|---|---|---|
| G0 Register | Opportunity identified | Pursuit owner | Opportunity record |
| G1 Qualify | Minimum client and scope data | Bid director | Qualification decision |
| G2 Commit | Initial risk, capacity and economics complete | Executive authority | Bid budget and team |
| G3 Strategy | Win themes, solution and evidence mapped | Bid director | Approved bid plan |
| G4 Price | Estimate reconciled and risks priced | Commercial authority | Approved price |
| G5 Solution | Technical and programme reviews complete | Technical authority | Approved solution |
| G6 Submit | Compliance and packaging checks passed | Delegated signatory | Submission snapshot |
| G7 Award | Contract reconciliation complete | Executive and commercial authority | Accept, negotiate or decline |
| G8 Learn | Outcome and review captured | Knowledge steward | Approved lessons |

> **CONSTRUX position.** Stage gates with definitions of done exist and refuse
> rather than warn, and the tender stage gate is the direct equivalent of G4 and
> G6 combined. What differs is granularity and ownership: these nine gates each
> name an **approving authority and an exit artefact**, which is what makes a
> gate auditable rather than procedural. G2, G3 and G8 have no counterpart at
> all — there is no bid budget, no approved bid plan and no knowledge-steward
> promotion.

---

## 10. Compliance and requirements engine

### 10.1 Compliance matrix fields

| Field group | Fields |
|---|---|
| Identity | `requirement_id`, `tender_id`, `issue_id`, `source_ref`, `source_span` |
| Meaning | `exact_text`, `normalised_text`, `defined_terms`, `interpretation` |
| Control | `type`, `mandatory`, `score_weight`, `pass_fail`, `priority`, `sensitivity` |
| Delivery | `owner`, `contributors`, `due_at`, `dependencies`, `status`, `blockers` |
| Response | `response_section_id`, `answer`, `attachment_refs`, `portal_field` |
| Evidence | `required_evidence_types`, `evidence_refs`, validity and verification |
| Quality | `confidence`, contradiction state, `reviewer`, approval and comments |
| Change | `superseded_by`, `impacted_by_issue`, `stale_since` and revalidation state |

### 10.2 The deterministic completeness algorithm

```
complete(requirement) =
      current_source_version(requirement.source_ref)
  AND response.status == APPROVED
  AND all(required_evidence).verified_and_valid
  AND formatting_constraints.pass
  AND dependencies.all_resolved
  AND contradictions.material_open == 0
  AND waivers.have_required_authority
  AND export_manifest.includes(required_outputs)
```

### 10.3 Contradiction classes

| Class | Example | System response |
|---|---|---|
| Source conflict | Specification and drawing state different material | Create a conflict and a clarification |
| Response conflict | Programme says 20 weeks, narrative says 18 | Block approval |
| Commercial conflict | Price schedule differs from the estimate total | Block the price gate |
| Evidence conflict | Case study claim exceeds the evidence | Remove the claim or obtain evidence |
| Temporal conflict | Response uses a superseded drawing | Mark stale and re-review |
| Unit conflict | A square-metre quantity priced as a linear metre | Block the calculation |
| Responsibility conflict | Two parties both exclude the same interface | Escalate as a scope gap |

> **CONSTRUX position.** The matrix carries roughly two-thirds of §10.1 — the
> whole Identity and Control groups, most of Delivery and Response, and the
> confidence field. The **Change group is entirely absent**, which is the same
> staleness gap in a third guise, and the **Evidence group** waits on the
> registry.
>
> §10.2 is the sharpest specification in this document because it is executable.
> The platform enforces three of its eight conjuncts today. Four wait on things
> named elsewhere. The eighth, **`waivers.have_required_authority`**, waits on
> nothing: a waiver state with a named approver could be built this week, and it
> converts the most dangerous silent event in bidding — somebody decided not to
> answer a mandatory question — into a record with a name on it.
>
> §10.3 is worth building as written. The platform already detects the source,
> commercial and responsibility conflicts and raises them as records with owners.
> **Response, evidence, temporal and unit conflicts are undetected**, and the
> unit conflict is the one that quietly costs the most: a quantity priced in the
> wrong dimension is arithmetically perfect and commercially catastrophic.

---

## 11. Scope and technical solution engine

### 11.1 The scope graph

The scope graph shall connect requirement, system, asset, location, work
package, design deliverable, quantity, activity, estimate item, supplier package,
inspection, test and handover record. This connection is what lets the engine
identify an unpriced drawing item, an unscheduled commissioning requirement or an
obligation with no accountable owner.

### 11.2 Technical development workflow

1. Decompose the client outcome into systems, deliverables and acceptance
   criteria.
2. Identify design responsibility and the information required from each party.
3. Map interfaces between permanent works, temporary works, enabling works,
   utilities, logistics and operations.
4. Select **only approved corporate methods**, or create a clearly labelled
   project-specific draft.
5. Test the method against access, sequence, resources, safety constraints,
   permits, weather and working hours.
6. Create assumptions and clarifications where information is insufficient.
7. Link each method statement claim to its governing requirement and supporting
   evidence.
8. Route discipline-specific parts to competent reviewers.

### 11.3 Drawing and model controls

- Support PDF and raster drawings at minimum; support IFC and common model
  metadata through an adapter.
- Extract title block, revision, status, scale where reliable, discipline and
  drawing references.
- **Do not derive quantities from a raster drawing** unless scale and measurement
  calibration pass configured checks.
- Preserve model element identifiers and property sets used in quantity or
  compliance results.
- Flag coordination findings as candidate issues until validated by a competent
  user.
- **Track design maturity and prevent a concept quantity from appearing as a
  definitive construction quantity.**

> **CONSTRUX position.** §11.3 is nearly all built: PDF and raster ingestion,
> IFC and ifcZIP parsing with geometry hashing and model diff, title-block
> extraction, drawing revision and supersession, preserved model element
> identifiers, and clashes raised as candidate findings rather than facts. Two
> are not, and both are refusals rather than features: **raster measurement
> without calibration** is permitted, and **design maturity is not tracked**, so
> nothing stops a concept quantity being read as a construction quantity. The
> second is the more dangerous, because the number looks identical either way.
>
> §11.2's fourth step — only approved corporate methods, or a clearly labelled
> draft — is already the document engine's rule, and AI-authored narrative is
> marked with its provider and prompt version. Step 8, routing to competent
> reviewers, resolves to a named owner today but has no review queue behind it.

---

## 12. Estimating and commercial engine

### 12.1 Estimate hierarchy

```
Tender estimate
  Work breakdown structure
    Control account
      Work package
        Cost item
          Quantity × resource rate
          Quote line
          Allowance
          Risk event
  Preliminaries
  Escalation
  Contingency or risk allowance
  Overhead
  Profit
  Tax and duties
  Client price schedule mapping
```

### 12.2 Rate build-up

| Component | Mandatory controls |
|---|---|
| Labour | Trade, grade, base rate, burden, overtime, shift, travel, lodging, productivity |
| Plant | Type, capacity, hire basis, mobilisation, fuel, operator, utilisation and standby |
| Material | Specification, quantity, waste, supplier, delivery, currency, duty and escalation |
| Subcontract | Scope coverage, quotation version, exclusions, qualifications and payment terms |
| Preliminaries | Time-related, fixed, activity-related and demobilisation |
| Risk | Identified event, probability, impact distribution, owner and treatment |
| Mark-up | Approved sequence, compounding rule, inclusion base and authority |

### 12.3 Commercial controls

- Every value shall carry currency, unit, price base date and tax treatment.
- The engine shall **prevent mark-up being applied twice** through different
  estimate layers.
- Supplier quotes shall be normalised **without deleting** original exclusions or
  qualifications.
- The final client price schedule shall reconcile **exactly** to the approved
  estimate, subject only to recorded rounding rules.
- A manual override requires reason, role, old value, new value and timestamp.
- Cash flow shall model client payment, supplier payment, retention, bonds,
  advance payment, mobilisation, tax and working capital.
- Sensitivity runs shall include productivity, programme duration, inflation,
  exchange rate, late payment and key supplier failure.
- **Risk allowance release shall follow policy and must not be used to conceal
  known base cost.**

### 12.4 Estimate assurance tests

| Test | Failure condition |
|---|---|
| Quantity coverage | A scope item has no estimate item and no approved exclusion |
| Rate freshness | A rate or quote exceeds its validity threshold |
| Arithmetic | The calculated total differs from the stored total beyond tolerance |
| Unit consistency | Incompatible dimensions or conversions |
| Programme consistency | Time-related cost duration differs from the approved programme |
| Resource consistency | The planned crew differs materially from the rate build-up |
| Quote coverage | Supplier exclusions create an unpriced scope item |
| Price reconciliation | The submission price differs from the approved tender price |
| Cash exposure | Peak funding exceeds the approved threshold |

> **CONSTRUX position.** The hierarchy and the seven rate components are built,
> across twenty cost heads, and the scope-to-price reconciliation already
> implements the first assurance test. Of the eight commercial controls, six hold:
> currency, unit and base date travel with every value; quote normalisation
> preserves exclusions; overrides carry reason, role and both values; cash flow
> models the full set; and no bid may be made without one. **Double mark-up
> prevention and exact price-schedule reconciliation are not enforced**, and both
> are deterministic checks that need no model.
>
> §12.4 is the most directly implementable table in Part I: **nine tests, one
> built.** Each is arithmetic over records the platform already holds, and each
> failure is refusable rather than advisory. Read beside §10.2, these two tables
> are the strongest argument in this document that Level 7 is mostly
> determinism, not mostly intelligence.
>
> The last commercial control deserves its own line. *Risk allowance must not be
> used to conceal known base cost* is a governance rule about honesty, not a
> calculation, and the platform has no equivalent. It is the estimating version
> of the rule the whole platform is built on: a denial shown as a denial, never
> as zero.

---

## 13. Planning and delivery method engine

### 13.1 Programme generation inputs

Deliverables and contractual milestones; the work breakdown and scope
quantities; production rates and crew calendars; design, review and approval
periods; procurement, manufacture, inspection, shipping and customs durations;
access, possession, outages, permits and environmental windows; temporary works,
enabling works and logistics; testing, commissioning, training and handover; and
client, statutory and third-party dependencies.

### 13.2 Schedule quality rules

| Rule | Required response |
|---|---|
| Open ends | Flag every unauthorised activity with no predecessor or successor |
| Hard constraints | Require a reason and approval for a constraint overriding logic |
| Negative float | Identify the driving path and the contractual cause |
| Excessive duration | Decompose or justify above the configured threshold |
| Missing procurement | Block installation readiness where the long-lead chain is absent |
| Resource overload | Propose levelling choices and their impact |
| Calendar mismatch | Explain inconsistent work patterns across linked activities |
| Commissioning gap | Require the inspection and test sequence before the completion milestone |
| Unsupported productivity | Link duration to quantity and approved output, or classify as an assumption |

### 13.3 Scenario engine

The planner shall preserve the approved scenario and create **immutable
alternatives**. Each scenario shall state its changed assumptions, schedule
effect, cost effect, resource effect, risk movement, contractual implications and
confidence. **It shall never overwrite the baseline to demonstrate a preferred
result.**

> **CONSTRUX position.** Programme generation from these inputs is built, as are
> the critical path, PERT, Monte Carlo completion with corrected merge bias, the
> lookahead and recovery options. The **nine schedule quality rules are the
> programme challenge agent Part II §4.6.2 called for**, stated as checks rather
> than as an agent — which is the more useful form, because each is testable on
> its own. None is implemented as a refusal today.
>
> §13.3's closing sentence is a rule the platform already obeys structurally: the
> ledger is append-only, so a scenario cannot overwrite a baseline even if
> somebody wanted it to. That is worth saying plainly, because it is one of the
> few places where the platform's architecture gives a Level 7 requirement for
> free.

---

## 14. Contract intelligence engine

### 14.1 The contract model

| Object | Required attributes |
|---|---|
| Clause | Identifier, heading, text, source, amendment chain and defined terms |
| Obligation | Actor, trigger, action, deadline, form, recipient and consequence |
| Right | Beneficiary, condition, notice, limitation and evidence |
| Liability | Type, cap, exclusions, duration and insurance relationship |
| Payment term | Valuation, due date, notice, final date, retention, set-off and currency |
| Change mechanism | Instruction, quotation, assessment, time effect and approval |
| Time rule | Completion, access, programme, delay damages, extension and prevention |
| Security | Bond, guarantee, parent support, amount, expiry and form |
| Departure | Client term, proposed position, rationale, risk and approval status |

### 14.2 Contract review priorities

Order of precedence and the complete amendment chain; fitness for purpose and
design responsibility; uncapped, indirect or consequential liability; delay
damages, caps and concurrent delay treatment; indemnities and third-party
exposure; ground, utilities, contamination and information reliance; change,
notice and time-bar mechanisms; payment, retention, set-off and pay-when-paid
exposure where applicable; termination, suspension, step-in and intellectual
property; insurance requirements and gaps; and data, cybersecurity, model
reliance and AI restrictions.

Contract output **must be labelled as decision support** unless approved by
qualified legal or commercial authority. **The engine shall not describe its
analysis as legal advice.**

> **CONSTRUX position.** Four of the nine objects are built — clause, obligation,
> payment term and change mechanism, the last two carried by the Construction Act
> compliance engine and the variation control matrix. **Right, liability,
> security and departure are not**, and the amendment chain on a clause is the
> L7.1 gap in its most concrete form.
>
> Two items in §14.2 are newer than the rest of this specification and worth
> flagging: **order of precedence** is what §6.3's unresolved-conflict stop rule
> needs in order to try something before abstaining, and **data, cybersecurity,
> model reliance and AI restrictions** is a review priority that did not exist a
> few years ago. A client term forbidding AI processing of its tender is a hard
> stop this platform cannot currently detect, and it belongs in the §9.1
> hard-stop column.
>
> The labelling rule is already the platform's, expressed structurally: no agent
> mandate exceeds propose, and issuing a contractual communication is
> `aiAllowed: false`, so the analysis reaches a person as support rather than as
> a position. The prohibition on describing it as legal advice is not written
> anywhere and should be.

---

## 15. Response composition engine

### 15.1 The grounded drafting contract

The composer may use only approved facts, tender-specific decisions and evidence
the requesting user may access. **It must not invent** project results, staff
experience, accreditations, dates, commitments, equipment ownership or supplier
capacity. A sentence containing a material factual claim shall retain one or more
evidence references.

### 15.2 The section object

```
ResponseSection {
  id, requirement_ids[], title, response_limit,
  evaluation_criteria[], win_theme_ids[],
  approved_fact_ids[], evidence_ids[],
  draft_versions[], current_version_id,
  author, reviewers[], approval_status,
  contradiction_status, export_template_slot
}
```

> **CONSTRUX position.** The bid response pack's sections carry the requirement
> link, the title, the author, the version and the approval state, and the
> pipeline refuses to issue a pack where a named deliverable has no response.
> Seven fields are missing, and they cluster: **`response_limit`,
> `evaluation_criteria` and `export_template_slot`** wait on the submission rule
> set; **`approved_fact_ids` and `evidence_ids`** wait on the evidence registry;
> `win_theme_ids` and `contradiction_status` wait on the response planner and the
> consistency agent.
>
> §15.1's prohibition list is the most specific in either document and is worth
> lifting verbatim into the drafting path when the evidence registry lands. The
> seven things named — results, experience, accreditations, dates, commitments,
> equipment ownership, supplier capacity — are exactly the claims that lose
> tenders when they turn out to be untrue, and they are all checkable against a
> registry.

---

### 15.3 Composition sequence

1. Restate the evaluator's need internally, without spending submission words on
   it.
2. Identify the response structure that maps directly to the scoring criteria.
3. Retrieve approved solution facts and evidence.
4. Draft at the required level of detail and **within the exact limit**.
5. Validate every material claim and value.
6. Check consistency against the price, programme, risk and contract positions.
7. Run clarity, compliance and evaluator-orientation reviews.
8. Route the section to the required technical, commercial or executive
   approver.
9. **Lock the approved version for packaging; a subsequent source change marks
   it stale.**

> **CONSTRUX position.** Steps 3, 4 and 8 are the bid response pipeline as built,
> minus the limit — one pass writes one section from records already on file and
> routes it under the capability that owns it. Step 9's second clause is the
> staleness rule again, and it is the one that makes locking safe: a locked
> version that cannot be marked stale is worse than no lock, because it looks
> current.

---

## 16. Assurance and red-team engine

### 16.1 The independent review model

**The same agent run that authored content shall not provide the final automated
assurance result.** The assurance service shall use an independently versioned
prompt, separate context selection and, for high-risk checks, a different model
route or a deterministic validator.

### 16.2 Review lenses

| Lens | Questions |
|---|---|
| Compliance | Did the response answer every requested element and attach the required evidence? |
| Evaluator | Can a scorer find the answer and award marks without inference? |
| Commercial | Do the commitments create unpriced scope or conflict with the qualifications? |
| Technical | Is the method feasible, coordinated and consistent with design maturity? |
| Programme | Can the sequence achieve the milestones using the stated resources and access? |
| Contract | Does the wording concede a departure, create a warranty or waive a right? |
| Evidence | Are the claims current, valid, permitted and traceable? |
| Adversarial | What would a competitor, a client reviewer or a claims specialist attack? |
| Executive | Is the risk-adjusted return within authority and appetite? |

### 16.3 Finding severity

| Severity | Definition | Submission effect |
|---|---|---|
| Critical | Likely disqualification, unlawful content, unapproved price or material binding exposure | **Hard block** |
| High | Material score, margin, delivery or contractual risk | Block unless authorised disposition |
| Medium | Material quality weakness or manageable inconsistency | Review required |
| Low | Clarity, presentation or minor completeness improvement | May proceed with recorded disposition |

> **CONSTRUX position. The engine is not built, and §16.1 explains why it cannot
> be faked.** The platform's existing checks are deterministic validators run by
> the engine rather than by a second model, which satisfies the last clause of
> §16.1 for arithmetic but not for judgement. Nothing reviews a drafted response.
>
> Three things here are worth taking as written even before the engine exists.
> The **independence rule** — a different prompt lineage and context selection —
> is what makes an automated review more than a second opinion from the same
> mind. The **four severities with an explicit submission effect** turn findings
> into a gate rather than a list; the platform's three severities carry no
> submission consequence. And a **recorded disposition** on a finding somebody
> chose not to act on is the same principle as the authorised waiver in §10.2: it
> converts a silent decision into a named one.
>
> Of the nine lenses, the platform covers commercial, technical and programme
> partially through existing reconciliations. Compliance, evaluator, contract,
> evidence, adversarial and executive have no equivalent.

---

## 17. Submission engine

### 17.1 The submission manifest

| Manifest field | Purpose |
|---|---|
| Submission id and snapshot | Immutable identity of exactly what was approved |
| Document list | Filename, format, size, hash, revision and required destination |
| Requirement coverage | Each mandatory requirement and the exported location satisfying it |
| Approval record | Approver, role, decision, conditions and time |
| Price reconciliation | Approved total, schedule totals, currency and rounding |
| Known exceptions | Approved waivers, outstanding client-controlled items and conditions |
| Channel record | Portal, email, API or physical method, and the authorised operator |
| Receipt | Portal confirmation, email acknowledgement, timestamp and reference |

### 17.2 Pre-submission hard gates

- No unresolved critical finding.
- No mandatory requirement without approved satisfaction or an authorised waiver.
- All exported values reconcile to the approved commercial baseline.
- All documents use the required format, name, size and page or word limit.
- Every signature and declaration is present and authorised.
- The latest acknowledged tender issue has completed impact review.
- No expired mandatory evidence at the submission deadline.
- **The signatory has explicit authority for the tender value and risk class.**

### 17.3 Portal automation policy

Portal automation may populate fields and stage uploads where the portal permits
it. The system must preserve screenshots or receipts where permitted, respect
terms and access controls, and **stop before any binding submission action**
unless an authorised human approves that exact snapshot. Credentials shall be
handled only by the approved identity and secrets services.

> **CONSTRUX position.** The bid response pack's refusal before issue is the
> second gate in §17.2, and it is the only one built. The other seven are each
> blocked on something named elsewhere: findings, the commercial baseline
> reconciliation, the submission rule set, the signature ceremony's coverage of a
> declaration, the impact review, evidence expiry, and a value-and-risk authority
> check on the signatory.
>
> That last one is worth separating out, because it is nearly free. The
> signature ceremony already resolves who may sign under a capability area, and
> the seat model already carries value thresholds. **Checking the signatory's
> authority against the tender's value and risk class is a join between two
> things that already exist**, and it prevents the specific failure where a
> correctly-approved submission is signed by somebody whose delegation does not
> reach it.
>
> §17.3's stop rule is already the platform's posture — issuing is
> `aiAllowed: false` — and its credentials rule matches how secrets are handled
> today. Neither has a portal to apply to yet.

---

## 18. Award conversion engine

### 18.1 Reconciliation before conversion

The engine shall compare the final tender submission, post-tender
clarifications, negotiation records, the letter of intent, the contract documents
and the executed schedules. **It must not assume that a tender qualification was
accepted merely because the contract was awarded.**

### 18.2 The conversion map

| Tender object | Delivery object | Conversion control |
|---|---|---|
| Requirement | Contract or project obligation | Confirm retained, changed or removed |
| Tender programme | Contract baseline candidate | Reconcile milestones and accepted changes |
| Estimate | Project budget and control accounts | Separate price, cost, risk and margin |
| Risk | Live project risk | Update ownership and treatment |
| Assumption | Validation action or change trigger | Set a deadline and evidence |
| Qualification | Contract reconciliation item | **Confirm express acceptance** |
| Supplier quote | Procurement package baseline | Refresh validity and scope |
| Response commitment | Project deliverable or KPI | Assign an accountable owner |
| Method | Controlled work method draft | Complete project and safety approvals |
| Evidence schedule | Handover information requirement | Create asset and commissioning tasks |

### 18.3 The no-loss handover test

Award conversion passes only when **every material tender commitment is mapped to
a delivery owner or explicitly classified as superseded.** The system shall
produce an exception register for unmapped commitments, unresolved negotiations,
changed price assumptions and unaccepted departures.

> **CONSTRUX position.** The eleven-stage chain carries bid objects into delivery
> and the platform now names an accountable manager on a project, which is the
> owner half of §18.3. What does not exist is **the conversion as a single
> governed act with a test that can fail.**
>
> §18.1's second sentence is the most commercially valuable line in Part I. A
> qualification is not accepted by silence, and a platform that carries tender
> qualifications forward as though they were agreed has manufactured a position
> the contract does not support. The conversion control column says the fix
> exactly: **confirm express acceptance**, qualification by qualification, and
> put the ones nobody confirmed on an exception register rather than into the
> baseline.
>
> This is buildable now. It needs no model, no connector and no new store — it
> is a reconciliation between records the platform already holds, and its output
> is a register, not a decision.

---

## 19. User experience requirements

### 19.1 Core workspaces

| Workspace | Mandatory views |
|---|---|
| Command centre | Readiness, deadline, blockers, gate status, agent activity, decisions and forecast completion |
| ITT library | Issue register, document tree, version comparison, extraction status and source viewer |
| Compliance | Requirement matrix, filters, owners, evidence, response and completion rule |
| Solution | Scope graph, interfaces, methods, clarifications, deliverables and technical reviews |
| Commercial | Estimate, quotes, reconciliation, risk, cash flow and authority |
| Programme | WBS, schedule quality, resources, procurement and scenarios |
| Contract | Clause, obligation, departure, exposure and approval |
| Response studio | Evaluator criteria, grounded drafting, evidence, comments, limits and approval |
| Assurance | Findings, severity, disposition, retest and gate effect |
| Submission | Manifest, packaging validation, approvals, channel and receipt |
| Award handover | Reconciliation, baseline mapping, exceptions and project creation |
| Agent operations | Run graph, status, evidence, cost, approvals, errors and replay |

### 19.2 The explainability pattern

Every agent-generated result shall expose **what** the system concluded, **why**
it concluded it, **which sources** support it, **what assumptions** remain, **how
confident** it is, **what action** it took or proposes, and **who must approve**
the next controlled step.

Raw hidden chain-of-thought is neither required nor displayed. The system
presents concise decision evidence and reproducible calculations.

### 19.3 High-risk interaction requirements

- Approval screens shall show the exact object version and the **material
  differences** from the previously approved version.
- **Bulk approval shall be disabled** for the final price, submission, contract
  departure and safety-critical content.
- The user shall see the financial value, liability, deadline and affected
  objects before approving.
- Approval shall require an **explicit decision**, not mere navigation or opening
  a notification.
- A rejected agent action shall preserve the proposed action and its reason, for
  audit and for learning.

> **CONSTRUX position.** Seven of the twelve workspaces exist as console screens
> — command centre, compliance, solution, commercial, programme, contract and
> agent operations — and the console's design system already carries the panel
> vocabulary the rest would use. The ITT library's **version comparison**, the
> response studio, assurance and submission have no screen.
>
> §19.2 is close to what the platform already does: a finding states its summary,
> its consequence, its evidence and what the agent looked for and did not find,
> and a denial is shown as a denial rather than as zero. Two of the seven are
> missing — **remaining assumptions** and **who must approve next** — and the
> second is the more useful, because a proposal that does not name its approver
> sits in a queue nobody owns.
>
> §19.3 is the section where the platform is furthest ahead. Every material write
> carries an expected version and returns a conflict with the current version and
> the permitted resolutions rather than overwriting. AI-authored change is shown
> with a **field-level diff**, its owner, its date and its authority, and the cost
> of an AI run is disclosed before it runs. Approval is an explicit act with a
> reason, not a navigation. **Two rules are not enforced: bulk approval is not
> specifically disabled** for the four high-risk classes, and **a rejected agent
> proposal is not preserved with its reason** — a refused proposal simply does
> not become a record, which loses exactly the signal §4.10 wants to learn from.

---

## 20. Roles, permissions and delegated authority

| Role | Default scope |
|---|---|
| Platform administrator | Tenant provisioning and platform policy; **no implicit access to client tender content** |
| Enterprise administrator | Identity, integrations, retention, policies and entitlements |
| Executive sponsor | Pursuit, risk appetite, award and high-value approval |
| Bid director | Tender plan, team, strategy, readiness and submission recommendation |
| Commercial authority | Estimate, price, cash, qualifications and commercial risk |
| Technical authority | Technical solution and engineering review |
| Planner | Programme, logic, resources and scenario review |
| Estimator | Quantities, rates, quotes and estimate preparation |
| Legal reviewer | Contract departures and legal risk review |
| Contributor | Assigned requirements and response sections only |
| External partner | Explicitly shared work packages and documents only |
| Auditor | Read-only evidence, decision and event access |
| Submission signatory | Final approval and the authorised submission action |

### 20.1 The permission model

Use role-based access for normal bundles and attribute-based access for tenant,
legal entity, tender, client, work package, content classification, geographic
region, action risk, value threshold and time-limited delegation.

**A user who can edit a response does not automatically gain access to the price
or the contract departure. Agent identity must be distinct from the user identity
that authorised the run.**

> **CONSTRUX position. Built, and this is the platform's strongest section.**
> The permission matrix is closed and published at runtime, attribute-based rules
> carry tenant, project, lifecycle phase, data sensitivity and value, delegation
> is time-bounded, and the operator holds no implicit access to customer content
> — the first row of this table is a restriction the platform already enforces on
> its own staff.
>
> The two sentences in bold are both true here. Capability areas are separate, so
> editing a response confers nothing over price or contract. And an agent acts
> under its own identity with its own mandate, never as the person who started
> it, which is what makes the audit trail readable three years later.
>
> Two roles have no seat: **legal reviewer** and **auditor** as a read-only
> evidence-and-decision role. The second is worth adding for a customer whose
> insurer or funder wants to look without being able to touch. **Content
> classification and geographic region** are not attributes the matrix carries;
> region is the residency gap from §1.3.

---

## 21. API and event specification

### 21.1 The minimum API surface

| Method and path | Purpose |
|---|---|
| `POST /v1/tenders` | Create a tender |
| `POST /v1/tenders/{id}/issues` | Register an ITT issue or addendum |
| `POST /v1/content/ingestions` | Ingest one or more content objects |
| `GET /v1/tenders/{id}/requirements` | Query compliance requirements |
| `PATCH /v1/requirements/{id}` | Update controlled fields with an optimistic lock |
| `POST /v1/agent-runs` | Start a bounded agent run |
| `GET /v1/agent-runs/{id}` | Retrieve run state and trace summary |
| `POST /v1/agent-runs/{id}/cancel` | Cancel safely |
| `POST /v1/approvals` | Request approval |
| `POST /v1/approvals/{id}/decisions` | Record a decision |
| `POST /v1/estimates/{id}/reconcile` | Execute deterministic reconciliation |
| `POST /v1/submissions/validate` | Validate a submission snapshot |
| `POST /v1/submissions/{id}/approve` | Approve that exact snapshot |
| `POST /v1/submissions/{id}/execute` | Execute the authorised submission action |
| `POST /v1/tenders/{id}/award-conversion` | Create the controlled delivery baseline |

### 21.2 API rules

- Use tenant-scoped opaque identifiers.
- All mutating requests shall accept idempotency keys.
- Controlled objects shall use version numbers or entity tags for optimistic
  concurrency.
- Errors shall return a machine-readable code, the affected object and
  remediation where safe.
- Large jobs shall be asynchronous and expose status plus webhooks.
- Pagination shall use stable cursors.
- Exports shall be generated from immutable snapshots.
- API and event schemas shall be versioned with a backward-compatibility policy.

### 21.3 Core events

| Event family | Events |
|---|---|
| Lifecycle | `OpportunityRegistered`, `PursuitApproved`, `TenderCreated`, `TenderIssueReceived`, `ContentIngested`, `ExtractionCompleted`, `RequirementDetected`, `RequirementChanged`, `RequirementBlocked`, `EvidenceVerified`, `ClarificationIssued`, `ClarificationAnswered`, `EstimateChanged` |
| Controls | `PriceApproved`, `ProgrammeApproved`, `DepartureApproved`, `ResponseApproved`, `FindingRaised`, `FindingClosed`, `SubmissionSnapshotCreated`, `SubmissionApproved`, `SubmissionExecuted` |
| Learning and agents | `AwardRecorded`, `BaselineConverted`, `LessonProposed`, `KnowledgePromoted`, `AgentRunStarted`, `AgentRunBlocked`, `AgentRunCompleted`, `PolicyViolationDetected` |

> **CONSTRUX position.** Seven of the eight API rules are already the platform's,
> and they were built for their own reasons rather than to satisfy this list:
> opaque tenant-scoped identifiers, idempotency on the sync path, expected
> versions returning a conflict with the current version and the permitted
> resolutions, problem+json errors carrying the code and the affected field,
> asynchronous jobs with webhooks, and exports built from an immutable snapshot
> with a verifiable hash. **Stable cursor pagination** is the one that is not
> uniform.
>
> Of the fifteen routes, nine have a direct counterpart. The six that do not are
> the ones whose objects do not exist: tender issues, submission validate,
> approve and execute, and agent-run cancellation — a run cannot be cancelled
> because a run is not an object with a lifecycle.
>
> Of the thirty core events, roughly two-thirds map onto the 766 already
> declared. The missing third clusters exactly where every other gap in this
> document sits: evidence, findings, submission snapshots, knowledge promotion
> and agent-run lifecycle. **`PolicyViolationDetected` is worth calling out** —
> the platform refuses violations but does not record the attempt as a security
> event, so a pattern of attempts is invisible.

---

## 22. Integration framework

| Integration | Minimum operations |
|---|---|
| Identity | OIDC or SAML, SCIM, MFA context, groups and user lifecycle |
| Email | Authorised ingest, draft, a send gate, thread and attachment preservation |
| Storage and CDE | Read, version, metadata, permission mapping, link and controlled write |
| CRM | Opportunity, client, contacts, value, stage and outcome |
| ERP and finance | Cost codes, rates, suppliers, currency, tax and project creation |
| Estimating | Import and export the estimate hierarchy, rates, quantities and versions |
| Scheduling | Import and export activities, logic, calendars, resources and baselines |
| BIM and CAD | Model metadata, elements, quantities, revisions and issue links |
| E-signature | Signature request and completed evidence; **never fabricate a signature** |
| Procurement portals | Authorised field mapping, staging, validation and receipt |
| Collaboration | Tasks, notifications, comments, mentions and decision capture |

### 22.1 The connector contract

```
ConnectorOperation {
  connector_id, tenant_id, acting_identity,
  operation_type, input_schema_version,
  requested_scope, data_classification,
  idempotency_key, timeout, retry_policy,
  result_ref, audit_event_id
}
```

> **CONSTRUX position.** Three of the eleven exist: identity, e-signature as a
> governed ceremony that refuses to sign where no key is configured rather than
> signing with something nothing can verify, and BIM and CAD through native IFC
> parsing. The other eight are the connector ecosystem blueprint §18.14 named.
>
> `ConnectorOperation` is a better contract than a connector list, because it is
> the thing that makes eight adapters safe rather than eight adapters risky.
> Every field on it is a control the platform already applies somewhere — acting
> identity, schema version, requested scope, data classification, idempotency,
> timeout and an audit event — and none of them is applied *at a connector
> boundary*, because there is no boundary yet. **Building this record before the
> first connector is the difference between an integration layer and a set of
> holes.**

---

## 23. Security, privacy and AI safety

### 23.1 Mandatory controls

- Encrypt data in transit and at rest using enterprise-approved cryptography.
- Use tenant-specific access boundaries in primary data, object storage,
  retrieval indexes, caches **and logs**.
- Store secrets in a dedicated secrets service and issue short-lived credentials
  where supported.
- Scan attachments before parsing and isolate active content.
- **Treat all ingested content as untrusted**; detect and neutralise prompt
  injection instructions contained in tender documents.
- Apply data loss prevention before model calls, tool actions and exports.
- Support configurable data residency, retention, legal hold and deletion.
- **Prohibit model-provider training on tenant data** unless the tenant
  explicitly enables it under contract.
- Record privileged access and require just-in-time elevation for support access.
- Run threat modelling for agent tool abuse, confused deputy, cross-tenant
  retrieval, data exfiltration and approval spoofing.

### 23.2 Prompt injection policy

Document text may describe contractual instructions but **cannot change system
policy, agent permissions, tool access or approval rules.** The parser shall
label source content as data. If content attempts to direct the model to ignore
rules, reveal secrets, contact third parties or execute tools, the run shall
quarantine that instruction and create a **security finding**.

### 23.3 The audit record

| Field | Requirement |
|---|---|
| Identity | User, agent, service and delegated authority |
| Action | Requested, attempted, permitted, denied and completed operations |
| Object | Tenant, tender, object id and object version |
| Evidence | Input references and output hash |
| Decision | Policy evaluated, result, approver and conditions |
| Technology | Agent definition, model route, tool version and validator version |
| Economics | Tokens, ACUs, processing time and external service cost |
| Time | Trusted timestamps and sequence |

> **CONSTRUX position.** Seven of the ten mandatory controls hold. Encryption in
> transit and at rest with per-purpose derived keys and key ids; tenant
> boundaries on data, object storage and the lexical index; a secrets service
> with rotation and old-key verification; bytes inspected before parsing with
> quarantine rather than deletion; retention, legal hold and deletion with a
> tombstone that keeps the chain intact; privileged access recorded, with the
> operator holding no implicit access to customer content; and an adversarial
> audit already run against a live server.
>
> Three do not. **Logs are not tenant-partitioned** in the sense this asks —
> correlation ids are per request, not per tenant boundary. **Data loss
> prevention before a model call** does not exist as a step. **Residency** is the
> same gap as §1.3, and the **training prohibition** is a contract term without a
> technical control behind it.
>
> §23.2 is the section this platform can answer best, and the answer is
> structural rather than detective. A tender document that tells the model to
> approve a variation fails not because the instruction was spotted but because
> the event type refuses an AI actor, no agent mandate exceeds propose, and no
> model may dispose of its own output. The evaluation harness exists chiefly to
> hold that line. **What is missing is the second half: the security finding.**
> The platform neutralises the attempt and does not record it, so a tenderer
> repeatedly probing a bidder's AI leaves no trace. That is a small change with a
> real security return.
>
> §23.3 is met almost field for field. Identity, action, object with version,
> evidence references and output hash, policy decision with approver, agent
> definition and model route, ACU settlement and processing time, and a
> hash-chained sequence rather than a trusted timestamp service. Two fields are
> absent: **tool version and validator version**, which cannot be recorded until
> tools are versioned objects rather than functions.

---

## 24. Model routing and cost control

### 24.1 Routing policy

| Task class | Preferred capability | Additional control |
|---|---|---|
| OCR and layout | Specialised document model | Page-level confidence |
| Classification | Fast structured-output model | Schema and sample audit |
| Contract interpretation | High-reasoning model | Clause retrieval and expert review |
| Arithmetic | **Deterministic service** | No model arithmetic as authority |
| Response drafting | Long-context generation model | Grounding and a claim validator |
| Red-team review | Independent high-reasoning route | Separate prompt and context |
| Image or drawing analysis | Vision model | Competent validation |
| Sensitive client data | Approved private route | Residency and retention policy |

### 24.2 ACU controls

- Estimate cost before a run and require approval above tenant thresholds.
- Set per-run, tender, team and tenant budgets.
- Cache only results whose source versions and permissions match.
- Use smaller models for extraction and classification **after benchmark
  qualification**.
- Stop recursive planning at a configured depth and task count.
- Show cost by tender phase, agent, model and successful output.
- **Budget exhaustion must not produce an apparently complete but partial
  submission.**

> **CONSTRUX position.** The fourth row of §24.1 is already the platform's
> settled position and its most important one: the engine's arithmetic is what
> lands in the record, a model returning a different figure does not overwrite
> it, and the evaluation harness tests exactly that. Routing by capability with
> health-aware fallback and a wallet refusal is built; routing by **task class**,
> the independent red-team route and the private route for sensitive data are
> not.
>
> On §24.2, cost is estimated and disclosed before a run and settled after, which
> covers the first control. **Per-tender and per-team budgets do not exist** —
> the wallet is per tenancy — and neither does recursive-depth limiting, because
> there is no planner to recurse. The last control is the one to design for now
> rather than later: the bid response pipeline writes one section per pass
> precisely so a stopped run leaves an obviously unfinished pack rather than a
> plausible one, which is this rule obeyed by construction. That property should
> survive whatever budgeting is added on top.

---

## 25. Reliability and non-functional requirements

| ID | Category | Requirement |
|---|---|---|
| NFR-001 | Availability | Core tender workspace 99.9% monthly, excluding agreed maintenance |
| NFR-002 | Durability | No acknowledged content or approval loss; multi-zone storage where the deployment supports it |
| NFR-003 | Recovery | Configurable recovery point up to 15 minutes and recovery time up to 4 hours for the enterprise tier |
| NFR-004 | Performance | Interactive filtered views under 2 seconds at the 95th percentile for normal tenant volumes |
| NFR-005 | Ingestion | A 1,000-page mixed tender pack begins visible processing within 60 seconds |
| NFR-006 | Scalability | Process independent documents and agent tasks horizontally with tenant fairness |
| NFR-007 | Idempotency | A repeated event or command does not create a duplicate controlled object |
| NFR-008 | Accessibility | Meet WCAG 2.2 AA for core workflows |
| NFR-009 | Localisation | Unicode, locale dates, currencies, units and multilingual content |
| NFR-010 | Observability | End-to-end trace across request, run, tool, validator, object and event |
| NFR-011 | Portability | Deploy through documented containers and replace provider adapters |
| NFR-012 | Data export | Tenant-controlled export of documents, metadata, events and decisions |
| NFR-013 | Explainability | Material outputs expose evidence, assumptions, uncertainty and approval need |
| NFR-014 | Concurrency | Optimistic locking and visible conflict resolution for controlled objects |
| NFR-015 | Degradation | Read-only access and queued processing during a non-critical model outage |

> **CONSTRUX position.** Seven hold and are tested: durability through the
> hash-chained journal with snapshots and a scheduled off-host copy; idempotency
> on the sync path; localisation of language, currency, tax and units;
> observability with a correlation id on every response and OTLP egress;
> portability through documented containers; tenant-controlled export with a
> verifiable hash; and optimistic locking that returns the current version and
> the permitted resolutions rather than overwriting.
>
> Four are honestly unproven rather than absent. **Availability, recovery point
> and recovery time have no measured figure** — the runbook documents the
> procedure, nobody has timed a restore against a target, and claiming 99.9%
> without an error budget would be inventing a number. **Performance at the 95th
> percentile is unmeasured**, and `CLAUDE.md` says not to tune without a measured
> bottleneck, so the honest position is that the figure is unknown rather than
> met.
>
> Three are not built. **Horizontal processing with tenant fairness** cannot be,
> while one process extends the chain. **WCAG 2.2 AA** is not claimed: semantic
> markup and keyboard focus are in place and no audit against the standard has
> been run, and `docs/STATE.md` says so rather than implying compliance.
> **Read-only degradation during a model outage** partly exists — the
> orchestrator falls back and refuses rather than failing open — but there is no
> queue to hold the work.

---

## 26. Functional requirements

### 26.1 ITT capture and content control

| ID | Title | Requirement | Acceptance |
|---|---|---|---|
| ITT-001 | Multi-channel capture | Accept uploads, connected storage, authorised email and API input | Each source creates the same canonical content object with channel metadata |
| ITT-002 | Immutable originals | Retain original bytes and a cryptographic hash | An exported audit proves no mutation of received content |
| ITT-003 | Recursive archives | Expand nested archives within security limits | All safe children appear with the parent path preserved |
| ITT-004 | Issue register | Group documents into tender issues and addenda | The user can identify the current and superseded issue |
| ITT-005 | Deadline extraction | Identify deadlines and time zones | A low-confidence or conflicting deadline creates a blocking review |
| ITT-006 | Layout extraction | Retain paragraphs, tables, coordinates and reading order | The source viewer highlights the exact extracted span |
| ITT-007 | Spreadsheet integrity | Preserve formulas, values, sheets and merged structures | The commercial import reports unsupported or hidden content |
| ITT-008 | Change detection | Compare new issues to prior issues | Material dependent outputs become stale automatically |
| ITT-009 | Malware and active content | Scan and isolate unsafe content | Unsafe content cannot reach parsers or agent tools |
| ITT-010 | Language handling | Detect and process supported languages without losing the original | Translation is stored as derived evidence, **not** as a replacement |

### 26.2 Requirement control

| ID | Title | Requirement | Acceptance |
|---|---|---|---|
| REQ-001 | Atomic requirements | Decompose compound requirements when independently verifiable | Each atom has one completion rule and one source span |
| REQ-002 | Mandatory classification | Identify mandatory and pass-fail requirements | A reviewer can approve or correct the classification with audit |
| REQ-003 | Scoring model | Capture evaluation weights and criteria | The response studio shows mapped criteria and available score |
| REQ-004 | Assignment | Every active requirement has an owner before the strategy gate | Unowned mandatory requirements block the gate |
| REQ-005 | Evidence rule | Requirements may define required evidence types and validity | Completion fails when evidence is absent or expired |
| REQ-006 | Dependency | Requirements link to prerequisite requirements and outputs | A blocked dependency prevents false completion |
| REQ-007 | Status control | Status transitions follow the configured state machine | Invalid direct transitions are rejected |
| REQ-008 | Contradiction | Detect cross-response and cross-domain contradictions | A material contradiction blocks the relevant approval |
| REQ-009 | Waiver | Only authorised roles may waive configured requirements | The waiver stores authority, reason, scope and expiry |
| REQ-010 | Coverage export | Prove where each requirement is satisfied | The submission manifest maps each mandatory requirement to its export location |

### 26.3 Agent control

| ID | Title | Requirement | Acceptance |
|---|---|---|---|
| AGT-001 | Typed run | Every agent task uses a versioned input and output schema | A malformed result fails without changing controlled state |
| AGT-002 | Authority envelope | Every run defines allowed tools and actions | An attempt outside the envelope is denied and logged |
| AGT-003 | Source restriction | Agents retrieve only authorised tender and corporate sources | A cross-tenant retrieval penetration test returns no data |
| AGT-004 | Abstention | Agents return blocked or abstained when evidence is insufficient | The test suite confirms no fabricated completion |
| AGT-005 | Checkpoint | Long runs persist resumable checkpoints | A worker restart resumes without duplicate actions |
| AGT-006 | Budget | Runs respect ACU, token, tool and elapsed-time budgets | A budget breach stops safely and reports partial state |
| AGT-007 | Approval pause | A run requiring a controlled action pauses for approval | No action occurs before decision for classes E and F |
| AGT-008 | Independent assurance | Author and assurance run definitions are separable | Release records show an independent review route |
| AGT-009 | Trace | Each run exposes sources, actions, validators, costs and result | An auditor reconstructs the run without hidden mutable state |
| AGT-010 | Version pinning | A controlled output identifies agent, prompt policy, model and tool versions | Regression and audit can reproduce the configuration |

### 26.4 Estimating

| ID | Title | Requirement | Acceptance |
|---|---|---|---|
| EST-001 | Estimate hierarchy | Support work breakdown to item-level cost | Totals roll up deterministically |
| EST-002 | Quantity lineage | Every quantity links to a source or an approved manual basis | Click-through reveals source and transformation |
| EST-003 | Rate lineage | Every rate includes effective date, location, currency and source | A stale-rate warning triggers by policy |
| EST-004 | Quote normalisation | Compare supplier scope, exclusions and terms | The comparison retains the original quote wording |
| EST-005 | Unit engine | Validate dimensions and conversions | Incompatible units cannot calculate silently |
| EST-006 | Mark-up control | Apply the approved mark-up order and bases | A test estimate shows no duplication |
| EST-007 | Risk allowance | Risk value links to identified risks or approved allowance policy | Unlinked contingency is separately visible |
| EST-008 | Cash flow | Model receipts, payments, retention and securities | Peak funding and timing are reproducible |
| EST-009 | Scenario | Create immutable commercial scenarios | The baseline remains unchanged |
| EST-010 | Reconciliation | Client price schedules reconcile to the approved tender total | Unexplained variance blocks G4 and G6 |

### 26.5 Planning

| ID | Title | Requirement | Acceptance |
|---|---|---|---|
| PLN-001 | WBS mapping | Activities map to scope and control accounts | Unmapped material scope is reported |
| PLN-002 | Logic validation | Detect open ends and invalid logic | The quality report identifies the exact activities |
| PLN-003 | Duration basis | Material durations reference quantity and productivity, or an assumption | An unsupported duration is visible |
| PLN-004 | Procurement chain | Long-lead installation links to procurement and design | A missing chain creates a high finding |
| PLN-005 | Calendars | Calendar differences are explicit | Calculated dates reproduce the source schedule |
| PLN-006 | Resources | Test resource demand against availability | Overloads appear by period and resource |
| PLN-007 | Commissioning | Completion includes testing and handover logic | Missing logic blocks technical approval where mandatory |
| PLN-008 | Scenario | Recovery options preserve the approved baseline | The scenario delta shows time, cost and risk |
| PLN-009 | Milestones | Contract milestones map to clauses or requirements | The milestone source is visible |
| PLN-010 | Export adapter | The programme maps to supported scheduling systems | A round trip preserves identifiers, dates and logic within declared limits |

### 26.6 Contract

| ID | Title | Requirement | Acceptance |
|---|---|---|---|
| CON-001 | Clause graph | Clauses retain definitions, references and the amendment chain | The viewer shows operative and superseded text |
| CON-002 | Obligation | Structure actor, trigger, action, deadline and consequence | Sample obligations calculate dates correctly |
| CON-003 | Departure | Proposed departures require owner, rationale, risk and approval | An unapproved departure cannot enter the final schedule |
| CON-004 | Time bar | Identify tender and delivery notice deadlines | The calculation exposes its rule and source |
| CON-005 | Liability | Identify caps, exclusions and uncapped categories | Executive review lists unresolved exposure |
| CON-006 | Payment | Model payment dates, retention and set-off | The cash model uses approved terms |
| CON-007 | Security | Capture bonds and guarantees with amount and expiry | The estimate includes the approved cost treatment |
| CON-008 | Conflict | A bespoke amendment takes precedence only through an approved order rule | The operative clause is selected reproducibly |
| CON-009 | Disclaimer | Automated analysis is labelled decision support | The interface and exports do not claim legal approval |
| CON-010 | Approval | A legal or commercial gate is required by configured risk | A high-risk contract cannot progress without a decision |

### 26.7 Response

| ID | Title | Requirement | Acceptance |
|---|---|---|---|
| RSP-001 | Grounded claims | Material factual claims reference approved evidence | The claim validator rejects an unsupported test sentence |
| RSP-002 | Word limit | Calculate limits according to the portal rule | The export stays within configured tolerance |
| RSP-003 | Evaluator mapping | Each response maps to criteria and requirement | A reviewer can navigate both directions |
| RSP-004 | Controlled values | Price, duration and performance values come from approved objects | A draft cannot override through free text unnoticed |
| RSP-005 | Corporate content | Only current approved knowledge may be reused | An expired case study is blocked or warned |
| RSP-006 | Collaborative versioning | Response edits retain version and author history | Concurrent edits resolve without silent loss |
| RSP-007 | Approval | An approved response is locked to its source versions | A source change marks the response stale |
| RSP-008 | Translation | A translated response retains source and reviewer status | Both language versions are linked |
| RSP-009 | Export slot | Each response maps to a template or portal position | Packaging locates it deterministically |
| RSP-010 | Tone and clarity | Quality checks may propose edits **without changing facts** | An accepted edit preserves evidence links |

### 26.8 Submission

| ID | Title | Requirement | Acceptance |
|---|---|---|---|
| SUB-001 | Snapshot | The submission is generated from an immutable snapshot | The hash remains stable through approval and execution |
| SUB-002 | Manifest | The package includes a machine-readable manifest internally | All files and coverage are enumerated |
| SUB-003 | Format | Validate permitted types, size, name, page and word limits | An invalid test file blocks submission |
| SUB-004 | Signature | Required signatures are present and authorised | An unsigned declaration blocks G6 |
| SUB-005 | Final price | All presented totals match the approved price | A one-unit mismatch blocks validation |
| SUB-006 | Issue status | The latest acknowledged issue has been assessed | An unassessed addendum blocks validation |
| SUB-007 | Exact approval | The signatory approves the exact snapshot hash | Modification after approval requires new approval |
| SUB-008 | Execution | A binding submit action requires delegated authority | An unauthorised API call returns a denial |
| SUB-009 | Receipt | Retain the confirmation and a trusted timestamp | Submission history shows the receipt |
| SUB-010 | Retention | The snapshot is immutable under the retention policy | A deletion attempt follows hold and authority rules |

### 26.9 Award

| ID | Title | Requirement | Acceptance |
|---|---|---|---|
| AWD-001 | Document reconciliation | Compare the executed contract to the final bid and negotiations | Differences produce classified exceptions |
| AWD-002 | Qualification acceptance | **No qualification is treated as accepted without evidence** | An ambiguous item remains unresolved |
| AWD-003 | Commitment mapping | Each bid commitment maps to an owner or a superseded status | The no-loss test reports zero unexplained items |
| AWD-004 | Budget conversion | Price, cost, risk and margin remain distinct | The delivery budget reconciles to the approved estimate |
| AWD-005 | Programme conversion | The baseline candidate retains tender logic and accepted changes | Milestone variance is explained |
| AWD-006 | Risk conversion | Tender risks transfer with updated owner and status | No material risk is dropped |
| AWD-007 | Assumption validation | Assumptions create dated validation actions | An overdue material assumption escalates |
| AWD-008 | Procurement conversion | Quoted packages create sourcing records **without appointment** | No supplier commitment is generated |
| AWD-009 | Project creation | The host adapter creates the project only after approval | Failure rolls back or resumes idempotently |
| AWD-010 | Knowledge isolation | Tender content does not enter corporate knowledge automatically | Promotion requires steward approval |

> **CONSTRUX position on the hundred requirements.** Counted honestly against the
> repository: **41 are met, 24 are partly met, and 35 are not built.**
>
> The strongest group is **agent control**: eight of ten hold, and the two that
> do not — `AGT-005` checkpoints and `AGT-008` independent assurance — are the
> resumability and red-team gaps named throughout. `AGT-003`'s acceptance test
> has actually been run: a cross-tenant retrieval attempt against a live server
> was part of the adversarial audit and returned nothing.
>
> The weakest is **submission**: one of ten, because nine of them need a channel
> that does not exist. Close behind is **response**, at three of ten, because
> seven need either the evidence registry or the submission rule set.
>
> **Estimating and contract sit in the middle at six and five**, and in both the
> misses are deterministic checks rather than intelligence: unit validation,
> mark-up duplication, price reconciliation to the schedule, the amendment chain
> and the precedence rule. `EST-005` deserves its own mention — *incompatible
> units cannot calculate silently* is one line to specify, cheap to build, and
> prevents an error that is arithmetically invisible and commercially fatal.
>
> Three requirements are worth building before anything larger, because each is
> a refusal over records the platform already holds and none needs a model:
> **`REQ-009`** the authorised waiver, **`EST-005`** the unit engine, and
> **`AWD-002`** qualification acceptance requiring evidence.

---

## 27. Data contracts and example payloads

### 27.1 Requirement payload

```json
{
  "id": "req_01J...",
  "tender_id": "tdr_01J...",
  "source": { "document_version_id": "dv_...", "page": 42, "span": "3.2.1" },
  "exact_text": "Provide a fully resource-loaded programme...",
  "classification": { "type": "programme", "mandatory": true, "pass_fail": true },
  "completion_rule_id": "rule_programme_01",
  "owner_role": "planner",
  "status": "READY_FOR_REVIEW",
  "response_refs": ["rsp_..."],
  "evidence_refs": ["ev_..."],
  "confidence": { "score": 0.96, "band": "high" },
  "version": 7
}
```

### 27.2 Approval payload

```json
{
  "action": "APPROVE_SUBMISSION_SNAPSHOT",
  "object_ref": { "type": "submission", "id": "sub_...", "version": 4 },
  "snapshot_hash": "sha256:...",
  "risk_class": "E",
  "required_authority": { "role": "submission_signatory", "value_limit": 25000000 },
  "decision": "APPROVED",
  "conditions": [],
  "decided_by": "usr_...",
  "decided_at": "2026-09-10T16:30:00Z"
}
```

### 27.3 Event envelope

```json
{
  "event_id": "evt_...",
  "event_type": "TenderIssueReceived",
  "schema_version": "1.0",
  "tenant_id": "ten_...",
  "aggregate_type": "Tender",
  "aggregate_id": "tdr_...",
  "aggregate_version": 18,
  "occurred_at": "2026-09-10T10:00:00Z",
  "actor": { "type": "integration", "id": "con_..." },
  "correlation_id": "cor_...",
  "causation_id": "cmd_...",
  "data": {},
  "classification": "client_confidential"
}
```

> **CONSTRUX position.** The event envelope is met field for field except
> `classification`, and that one field is worth adding: a per-event data
> classification is what §23.1's export and data-loss controls would read, and
> retrofitting it later means backfilling 766 declarations.
>
> The approval payload is the more interesting of the three, because it carries
> **`required_authority.value_limit` beside `risk_class`** — the same join §17.2
> asks for, expressed as data rather than as a rule. The platform records who
> approved and under which capability; it does not record the limit that made
> them competent to. Adding it turns an approval into something an auditor can
> check without knowing the delegation table as it stood that day.

---

## 28. Agent evaluation framework

### 28.1 Benchmark suites

| Suite | Core measures | Release threshold principle |
|---|---|---|
| Requirement extraction | Recall, precision, atomicity, source accuracy | Mandatory recall prioritised; critical misses prohibited |
| Contract | Clause retrieval, obligation accuracy, deadline logic, abstention | No high-risk unsupported conclusion |
| Estimate | Quantity lineage, unit accuracy, arithmetic and reconciliation | Deterministic totals exact within the rounding rule |
| Planning | Logic-defect detection, duration basis and scenario fidelity | Known critical defects found |
| Drafting | Requirement coverage, grounded claim rate and value consistency | No unsupported material claim |
| Submission | Format, coverage, price, issue and signature checks | All seeded disqualifiers detected |
| Security | Prompt injection, exfiltration, cross-tenant and tool abuse | **Zero successful critical attack in the release suite** |
| Calibration | Confidence against observed correctness | Published bands meet the error tolerance |

### 28.2 Production monitoring

- Sample high-risk agent outputs for expert review.
- Monitor acceptance, rejection, correction and override rates by agent version.
- Track false-negative rates for mandatory requirements and critical findings.
- Detect drift by client type, document type, language and contract family.
- Stop or roll back an agent release when a guardrail or quality threshold fails.
- **Separate model quality from retrieval, parser, tool and user-data failures.**

### 28.3 The golden tender corpus

Maintain a permission-cleared corpus containing scanned documents, complex
tables, addenda, bespoke contracts, conflicting drawings, pricing schedules,
portal instructions, multilingual text and seeded adversarial instructions.
Expected requirements, risks, calculations and submission defects shall be
annotated by qualified construction and commercial reviewers.

> **CONSTRUX position.** Two of the eight suites exist in substance. The
> **estimate** suite is the gold set: cases whose right answer is fixed by
> statute, standard or arithmetic — the notified sum under section 111 with no
> pay-less notice, a PERT mean, an adjudicator's 28 days — each stating the
> authority it comes from and deriving it by hand so a quantity surveyor can
> check the expectation rather than trust it. The **security** suite exists as
> the injection case and the adversarial audit.
>
> The other six do not, and §28.3 says why they are hard rather than merely
> unbuilt: they need a corpus annotated by qualified reviewers. The platform's
> harness deliberately refuses to score judgement, on the grounds that a number
> nobody can check is worse than no number. **§28.3 is the answer to that
> refusal.** With an annotated corpus, requirement recall and defect detection
> stop being judgement and become measurable, which is what would let CONSTRUX
> publish the quality targets blueprint §18.14 listed as unbuilt.
>
> §28.2's last line is a discipline the platform has learned the hard way and
> should keep: most apparent model failures are parser, retrieval or data
> failures wearing a model's clothes.

---

## 29. Observability, operations and support

| Metric group | Measures |
|---|---|
| Tender readiness | Mandatory completion, weighted completion, blockers, stale outputs and forecast finish |
| Agent reliability | Success, partial, blocked, abstained, retry, validator failure and correction rate |
| Quality | Requirement recall, grounded claims, reconciliation errors and escaped defects |
| Performance | Queue time, run time, tool latency, retrieval latency and export time |
| Cost | ACU by tender, agent, phase, output and model route |
| Security | Policy denial, injection detection, anomalous retrieval and privileged access |
| Integrations | Availability, authentication failure, throttling, schema error and replay backlog |

### 29.1 Operational runbooks

Model provider outage and routing failover · parser failure on a critical tender
file · addendum received close to the deadline · submission portal unavailable ·
an incorrect approved price discovered before and after submission · cross-tenant
access alert · compromised connector credential · agent release regression ·
event backlog and duplicate delivery · library or object-store recovery.

> **CONSTRUX position.** `docs/RUNBOOK.md` covers provider outage and failover,
> object-store and journal recovery, ledger promotion and the on-call rota with a
> named first responder. The eight remaining scenarios have no runbook, and two
> of them are worth writing before the capability exists rather than after:
> **an incorrect approved price discovered after submission** is a commercial
> emergency with a legal clock on it, and **a compromised connector credential**
> is the first incident an integration layer will produce.
>
> On metrics, cost and security denials are collected; **abstention, correction
> and override rates by agent version are not**, and those three are the ones
> that would show an agent getting worse before a customer notices.

---

## 30. Implementation architecture decisions

| Decision | Required direction | Reason |
|---|---|---|
| System of record | Relational domain store plus immutable object storage and an event log | Transactions, audit and version control |
| Knowledge relationships | Graph projection over canonical identifiers | Cross-domain impact analysis |
| Semantic retrieval | Tenant-partitioned vector index with metadata enforcement | Evidence discovery without losing access control |
| Workflow | Durable workflow engine | Long-running, resumable human and agent processes |
| Agent execution | Stateless workers with checkpointed run state | Scale and safe recovery |
| Calculations | Versioned deterministic calculation services | Reproducibility and approval integrity |
| Model access | Central model gateway | Provider portability, policy, cost and audit |
| Tools | Typed narrow capabilities through a gateway | Least privilege and validation |
| Exports | Snapshot-based document generation | Exact approval and reproducible submission |

> **CONSTRUX position.** Four of the nine directions are already taken: the event
> log as the system of record with immutable object storage beside it,
> deterministic calculation as the authority, a central model gateway, and
> snapshot-based export with a verifiable hash. **Typed narrow capabilities**
> exist as capability areas but not behind a gateway that validates each call.
>
> Four are not taken and each is a real decision rather than an oversight. The
> **graph projection** is the single most repeated gap in this document — it
> appears as missing edges in §2.3, missing traversal in §8.2, missing
> supersession in §5.2 and missing impact analysis in §3.2 — and building it once
> closes all four. **Durable workflow** and **checkpointed stateless workers**
> are the same decision seen twice. The **vector index** is deliberately absent:
> the lexical index finds near-duplicates without one, embeddings are charged and
> optional, and `CLAUDE.md` says not to build for a bottleneck nobody has
> measured.

---

## 31. Delivery roadmap

| Release | Scope | Exit criteria |
|---|---|---|
| R1 Controlled ITT foundation | Tender workspace, ingestion, issue register, requirement matrix, evidence and basic drafting | A traceable current-state ITT with human-controlled workflow |
| R2 Bid production | Solution, estimate, programme, contract, response and review integrations | A cross-domain controlled bid with reconciliations |
| R3 Multi-agent coordination | Orchestrator, typed tools, budgets, checkpoints, independent assurance and agent operations | L5 and L6 operation passes the benchmarks |
| R4 Level 7 governance | Risk-class actions, delegated authority, exact snapshot approval, continuous monitoring and recovery | Governed reversible autonomy with no critical guardrail failure |
| R5 Award and learning | Contract reconciliation, delivery baseline, actuals and controlled knowledge promotion | End-to-end continuity proven on pilot tenders |

### 31.1 Recommended build sequence

1. Canonical domain model, tenant boundary and immutable content and version
   model.
2. Ingestion pipeline, source viewer and issue register.
3. Requirement and evidence services with deterministic completeness.
4. Durable workflow, approval and audit services.
5. Agent registry, tool gateway, model router and run tracing.
6. Compliance, contract, estimating and programme engines.
7. Response studio, assurance engine and submission snapshots.
8. Award conversion and host-platform adapters.
9. Evaluation corpus, red-team security and controlled production rollout.

> **CONSTRUX position — the sequence does not start here, because most of it is
> done.** Steps 1, 2, 5 and 6 are substantially built, and step 4's approval and
> audit halves are built without the durable workflow. Starting a nine-step
> sequence from step 1 would rebuild working software, which `CLAUDE.md` forbids
> for good reason.
>
> Read as a *dependency order* rather than a schedule, it is right, and it agrees
> with Part II §8 on what comes first: the **evidence service with deterministic
> completeness** (step 3) before the response studio and the assurance engine
> (step 7), because a claim validator with nothing to validate against is
> theatre. The one place it differs from Part II is that it puts **durable
> workflow** at step 4, ahead of the agent work — and on reflection that ordering
> is better, because checkpoints, budgets and approval pauses all need it, and
> retrofitting resumability into agents written without it is how the current
> one-section-per-pass workaround came about.

---

## 32. System acceptance scenarios

| ID and scenario | Test | Expected result |
|---|---|---|
| AS-01 Complete tender intake | Upload a mixed 1,000-page pack with PDFs, scans, spreadsheets and nested archives | A controlled register is created, content extracted, deadlines identified and unreadable items flagged, without losing originals |
| AS-02 Addendum impact | Issue an addendum changing a drawing, a completion date and a liability clause | The dependent estimate, programme, contract review and response become stale with assigned review tasks |
| AS-03 Mandatory requirement miss | Seed a pass-fail insurance attachment in a footnote | The requirement is detected, owned, and blocks submission until valid evidence is present |
| AS-04 Price contradiction | Set a narrative price different from the approved schedule | Assurance finds the contradiction and the validator blocks G6 |
| AS-05 Unsupported claim | Draft a case-study performance value with no evidence | The claim validator removes or blocks the claim and requests evidence |
| AS-06 Agent overreach | An agent attempts to email the final price without permission | The tool gateway denies the action and creates a policy-violation event |
| AS-07 Prompt injection | A tender attachment instructs the model to reveal secrets | Content is treated as untrusted, the instruction is quarantined, and no secret is accessed |
| AS-08 Contract ambiguity | A bespoke amendment and a standard clause conflict with no clear precedence | The agent abstains, records both sources and requests authorised review |
| AS-09 Exact submission approval | Modify one file after the signatory's approval | The snapshot hash changes and execution requires new approval |
| AS-10 Award conversion | The executed contract rejects two qualifications and changes a milestone | Conversion creates exceptions and prevents silent reuse of tender assumptions |
| AS-11 Tenant isolation | Search for another tenant's project name through agent and API paths | No object, embedding, cache, trace or metadata leaks |
| AS-12 Recovery | Terminate a worker during a multi-step agent run | The run resumes from its checkpoint without a duplicate external action |

> **CONSTRUX position.** Two pass today. **AS-11** has been run against a live
> server as part of the adversarial audit and returned nothing. **AS-07** passes
> for governed writes by construction rather than by detection — the instruction
> cannot reach an event the catalogue refuses — though the second half, the
> security finding, is not recorded.
>
> **AS-01 passes in substance** but not against the specific test: a mixed pack
> with nested archives ingests, classifies and quarantines correctly, and no
> original is lost, but nothing groups the result into an issue register.
>
> The other nine fail, and they fail in exactly three clusters: **the staleness
> graph** (AS-02, AS-10), **the evidence registry and assurance** (AS-03, AS-04,
> AS-05), and **the submission channel with its tool gateway** (AS-06, AS-08,
> AS-09, AS-12). That is the same three-way split every section of this document
> has produced from a different angle, which is the strongest evidence that the
> gap analysis is right.
>
> These twelve should be written as executable tests when the capabilities land.
> The platform already keeps its acceptance scenarios as tests rather than as
> prose — the ten ETABLIX scenarios are executable — and prose acceptance
> criteria rot.

---

## 33. Definition of done

- All functional requirements have automated or documented acceptance evidence.
- All controlled objects are versioned and all material outputs have evidence
  lineage.
- The system passes cross-tenant, prompt-injection, tool-abuse and
  approval-bypass security tests.
- Critical calculations are deterministic and reproducible.
- Agent benchmark results meet the approved release thresholds across
  representative tender types.
- A complete pilot runs from ITT receipt through an authorised submission
  snapshot to award conversion.
- **An independent reviewer can reconstruct who or what made each material
  change, using which evidence and authority.**
- A provider or host-platform adapter can be replaced without rewriting tender
  domain logic.
- Operational runbooks, monitoring, backup, recovery and rollback have been
  tested.
- Competent construction, commercial, planning, technical, security and legal
  reviewers approve production release within their areas of responsibility.

> **CONSTRUX position.** Four of the ten hold today: cross-tenant and injection
> testing, deterministic and reproducible calculation, adapter replaceability,
> and the seventh — an independent reviewer can already reconstruct who or what
> made each material change, with which evidence and under which authority,
> because that is what the hash-chained ledger with actor and capability on every
> event is for. That one is the hardest to retrofit and it is done.
>
> The last item is the one no engineering effort can satisfy. **Competent
> construction, commercial, planning, technical, security and legal reviewers
> approving within their areas of responsibility** is a human process, and it is
> the correct final gate for a system whose whole argument is that people keep
> authority over irreversible decisions. It should be run before any Level 7
> claim is made externally.

---

## 34. Final product position

The completed engine shall operate as a **controlled digital bid organisation.**
It shall understand the procurement package, coordinate specialist analysis, keep
price, programme, contract and technical commitments consistent, preserve the
evidence behind the offer, and carry accepted commitments into delivery.

**Its value depends on dependable controls and project truth rather than on the
number of agents or the fluency of generated text.**

The implementation target is **70 to 85 percent automation of repeatable tender
information work**, with people retaining approval of the final price, the
contractual position, technical acceptance, safety-critical content and the
submission itself. Achieved automation shall be measured from completed
controlled tasks, time saved, defects prevented and decisions improved — **not
from model activity volume.**

> **CONSTRUX position.** The second sentence in bold is the same argument
> blueprint §18.13 makes: the differentiator is not "we have more AI agents".
> Eighty-one agents is a fact about the platform, not a claim about its worth,
> and this document is right that the worth is in the controls.
>
> The measurement rule closes a loop opened in blueprint §18.3. That section
> stated the 70 to 85 percent range and immediately said CONSTRUX may not quote
> it, because a percentage without a denominator is marketing. §34 supplies the
> denominator: **completed controlled tasks, time saved, defects prevented and
> decisions improved.** Extending the Site Services A/B/C classification across
> the whole event catalogue — with its build-failing test — is how that
> denominator gets built, and only then does the figure become quotable.

---

## 35. What this document changes about the build order

Part II §8 ordered eight items. Part I adds a hundred functional requirements,
twelve acceptance scenarios and a build sequence, and three things in it change
that order.

**One thing moves up.** Part I puts **durable workflow, approval and audit**
before the agent work, and that is right. Checkpointed runs, run budgets, elapsed
time limits and approval pauses all depend on it, and the platform already shows
what its absence costs: the bid response pipeline writes one section per pass
because there was no other way to make a long run survive being cut off.

**One thing is cheaper than it looked.** Three refusals need no model, no
connector and no new store, and each converts a silent failure into a named
record:

| Requirement | What it prevents |
|---|---|
| `REQ-009` authorised waiver | Somebody quietly deciding not to answer a mandatory question |
| `EST-005` unit engine | A quantity priced in the wrong dimension — arithmetically perfect, commercially fatal |
| `AWD-002` qualification acceptance | Carrying a tender qualification into delivery that the client never accepted |

**One thing is confirmed.** Both parts, reached independently and from opposite
ends, name the same three clusters: the **staleness and impact graph**, the
**evidence registry with its gate**, and the **submission channel with a tool
gateway**. Part I's twelve acceptance scenarios fail in exactly those three
groups. That agreement is the most useful output of merging the two documents,
and it is the order the work should follow.

Everything above remains a specification. `docs/STATE.md` is the record.

---

# Part II — Engine and kernel specification

*The developer-handoff edition, unchanged. Part I above states the requirements;
this part states the implementation, agent by agent.*

**Scope:** Opportunity discovery → ITT ingestion → scope intelligence →
estimating → contract and risk → programme → bid composition → submission →
award → delivery baseline handover.

**Portability.** Every external dependency sits behind a port and adapter. The
engine must run on the reference stack, on any major cloud, on-premise, and as an
embedded module inside third-party platforms — Procore, Aconex, Asite,
Viewpoint, Autodesk Construction Cloud, SAP, Oracle Unifier and bespoke common
data environments.

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
