# CONSTRUX AI Operating System — Production Blueprint

**Status legend used throughout.** `[BUILT]` exists in this repository and is
tested. `[EXTEND]` builds on something that exists. `[NEW]` is specified here
and not yet implemented. Nothing already built is removed by this document.

---

## 1. Executive product vision

CONSTRUX is an AI Operating System for the built environment: the layer that
governs how a physical asset is conceived, priced, procured, built, proven,
handed over and operated for thirty years — on one immutable data spine.

**The problem.** Construction does not fail for lack of software. It fails
because its systems report what already happened. Estimates are static, so risk
is guessed. Programmes have no probability, so delay is discovered rather than
predicted. Evidence is fragmented across email and spreadsheets, so entitlement
becomes a legal argument instead of an arithmetic one. Each stage hands the next
a lossy summary, and at handover the data dies entirely.

**What CONSTRUX is.** Not a suite of applications sharing a login. One event
ledger, seven domain engines and one governance model, where every state change
is an immutable, hash-chained event. Because the record is complete by
construction, three things become possible that are not possible on a
conventional stack:

1. **Forecasting instead of reporting.** Probability of completion, forecast
   final cost, delay exposure and safety risk are computed continuously from
   live state — not assembled monthly by hand.
2. **Arithmetic instead of argument.** Delay attribution with concurrency,
   entitlement scoring and a verifiable evidence chronology turn a claim into a
   calculation the other side can check.
3. **Continuity instead of handover loss.** The asset register in year twelve
   references the commissioning result, which references the installation
   record, which references the drawing revision it was built to.

**Why it can dominate.** Competitors sell modules. Whoever owns the
*authoritative record* of an asset owns the decisions made about it — and once
embedded at asset-owner or government level, a system of record with a
thirty-year evidentiary chain is not replaceable by a better-looking tool.

**Commercial engine.** Access is sold as subscription; intelligence is metered.
Every AI execution is reserved before it runs and debited only after its output
reaches the ledger, at a fixed disclosed multiplier over provider cost. Margin
is enforced by the architecture, not by pricing discipline. `[BUILT]`

---

## 2. Market gap analysis

| Category | Leaders | What they do well | Where they fail | CONSTRUX response |
|---|---|---|---|---|
| Project management | Procore, Autodesk Build | Field adoption, document control, breadth | No probabilistic forecasting; the record is documents, not events; commercial and programme live apart | Event ledger with hash chain; CPM + PERT; CVR wired to commitments `[BUILT]` |
| Planning | Primavera P6, Asta | Deep CPM, resource levelling | Seat-heavy licensing; schedules edited as dates; no link to cost or evidence | Programme recalculated from the network; cost-code-linked activities; seats cheap, intelligence metered `[BUILT]` |
| Commercial | CostX, Candy | Strong measurement and estimating | Estimating detached from execution; risk buried in percentages | Take-off → BoQ → estimate → contract with confidence carried through; risk priced as a line `[BUILT]` |
| Common data environment | Aconex, Viewpoint | Transmittals, workflow | Document-centric; supersession is manual convention; no state model | Revision supersession enforced; markup → RFI conversion; state is entities, documents are evidence `[BUILT]` |
| Contractor back office | Construction AI and similar | Guided workflows, tight sequencing, field usability | Shallow evidentiary model; no verifiable audit; single-tenant thinking | Guided sequence *plus* a court-grade record; multi-tenant governance `[BUILT]` |
| Enterprise platforms | SAP, Oracle | Finance and procurement at scale | No construction physics; no site reality; no AI metering | Domain engines with real maths; ACU economics `[BUILT]` |

**Underserved commercially:** the moment of *entitlement*. Every contractor
loses money on unevidenced change. The market sells document storage and calls
it evidence. A hash-chained chronology that an adjudicator can independently
verify is a category difference, not a feature. `[BUILT]`

**Underserved technically:** AI cost control. Platforms bolt AI on and absorb
provider cost until unit economics break. Reserve-before-execute with hard caps
is the difference between a feature and a business. `[BUILT]`

---

## 3. Complete user ecosystem

| User type | Layer | Sees | Cannot see |
|---|---|---|---|
| Platform operator | `PLATFORM_ADMIN` | Tenants, billing, ACU ledger, engine config, system health | Projects, packages, daily logs, portfolio operations |
| Enterprise admin | `ENTERPRISE_ADMIN` | Enterprise → portfolio → programme → project dashboards, users, policy | Platform administration |
| Asset owner / client | `OWNER` | Full project, approvals for baselines and handover | Platform administration |
| EPC / main contractor | `EPC` | Delivery, commercial, field, contracts | Other tenants |
| Quantity surveyor | `QS` | Measurement, estimating, valuation, claims | Budget baseline approval, award approval |
| Project manager | `PM` | Delivery, change, field, adjudication approval | Budget baseline approval |
| Planner | `PLANNER` | Programme, baselines, delay | Commercial detail |
| Safety manager | `SAFETY` | Risk, RAMS, observations, competency | Legal-L4 contract content |
| QA/QC engineer | `QAQC` | Inspections, commissioning, snagging | Commercial |
| Designer / BIM | `DESIGNER`, `BIM` | Drawings, models, clashes | Commercial, legal |
| Site supervisor | `SUPERVISOR` | Field capture, lookahead, RAMS briefing | Commercial, legal |
| FM operator | `FM` | Assets, defects, work orders, maintenance | Tender and commercial baselines |
| Supplier | `SUPPLIER` | Its own RFQ and submission only | Every other supplier, all buyer data |
| Regulator | `REGULATOR` | Approved and published records, read-only | Commercial-sensitive entities; no AI unless owner-enabled |
| Developer / API consumer | scoped token | Whatever scopes are granted | Anything outside scope |
| Merchant (BitriPay) | `MERCHANT` `[NEW]` | Its own payment configuration, transactions, settlements | Project delivery data |

All roles and the enforceable matrix: `src/identity/roles.ts` `[BUILT]`

---

## 4. AI Command Centres

Each user type receives a command centre: a role-scoped surface combining live
state, the agents available to that role, and the actions the permission matrix
permits. The context-aware tool router already returns exactly the tools a role
may use at the current lifecycle phase (`src/ai/conversation.ts`) `[BUILT]`.

| Command centre | Live panels | Agents available | Autonomy ceiling |
|---|---|---|---|
| **Executive / Owner** | Portfolio value, forecast margin, delay exposure, safety index, gate status | Chief of Staff, Analyst, Research, Growth | Recommend only; approvals stay human |
| **Project manager** | Programme health, open constraints, change pipeline, field activity | Chief of Staff, Operations, Automation, Analyst | Auto-draft change requests; auto-escalate constraints |
| **Quantity surveyor** | CVR, valuation status, notice deadlines, variation exposure | Analyst, Revenue, Automation | Auto-produce valuations; never auto-submit |
| **Planner** | Critical path, near-critical, P80, what-if | Analyst, Operations | Auto-recalculate; baselines need approval |
| **Safety** | Leading indicators, RAMS status, competency expiry | Security/Safety, Knowledge, Automation | Auto-suspend on competency lapse |
| **Site supervisor (mobile)** | Today's tasks, RAMS to brief, capture queue, sync state | Automation, Knowledge | Offline capture; nothing approved on device |
| **FM operator** | Asset health, open defects, warranty cover, maintenance forecast | Operations, Analyst, Automation | Auto-raise work orders under threshold |
| **Supplier** | Its RFQ, clarifications, submission status | Onboarding, Support | Own lane only |
| **Regulator** | Approved records, audit replay, safety file | Knowledge (read-only) | Read-only; AI off by default |
| **Platform operator** | Tenant health, ACU consumption, provider status, incidents | System Health, Infrastructure, Governance, Security | Auto-remediate infrastructure; never touch tenant data |
| **Merchant** `[NEW]` | Payment volume, settlement, disputes, API keys | Payment, Fraud, Support | Auto-retry settlement; disputes escalate |

### Command centre contract `[NEW — extends `src/ai/conversation.ts`]`

```ts
type CommandCentre = {
  role: Role;
  panels: Panel[];                 // resolved from materialised ledger state
  agents: AgentBinding[];          // filtered by the permission matrix
  autonomyPolicy: {
    autoExecute: string[];         // commands the agent may run unattended
    proposeOnly: string[];         // commands requiring a human click
    forbidden: string[];           // never available to this role
  };
  acuBudget: { monthlyMinor: number; consumedMinor: number };
};
```

**Non-negotiable rule.** An agent may only invoke commands the human it acts for
could invoke. Agent permissions are derived from the operator's matrix entry —
never granted separately. This closes the standard multi-agent privilege
escalation path.

---

## 5. Agent catalogue

Seven domain engines exist today (`src/engines/`) `[BUILT]`. The agent layer
wraps them with memory, triggers and escalation.

### 5.1 Agent contract `[NEW]`

Every agent declares the same interface, so orchestration, budgeting and audit
are uniform:

```ts
type AgentDefinition = {
  id: string;
  category: 'DOMAIN' | 'EXECUTIVE' | 'PLATFORM' | 'SECURITY' | 'COMMERCIAL';
  purpose: string;
  /** Capability area + code the operator must hold. Derived, never granted. */
  requires: { area: CapabilityArea; code: PermissionCode };
  inputs: { entityTypes: string[]; externalFeeds?: string[] };
  outputs: { eventTypes: string[] };          // must exist in the catalogue
  triggers: AgentTrigger[];
  /** What the agent may do alone versus what it must propose. */
  autonomy: 'PROPOSE' | 'EXECUTE_BOUNDED' | 'EXECUTE';
  /** Bounds for EXECUTE_BOUNDED: exceeding any bound forces PROPOSE. */
  bounds?: { maxValueMinor?: number; maxScheduleImpactDays?: number };
  escalation: { to: Role; whenever: string };
  acuBudgetPerRunMinor: number;
};

type AgentTrigger =
  | { kind: 'EVENT'; eventType: string }
  | { kind: 'SCHEDULE'; cron: string }
  | { kind: 'THRESHOLD'; metric: string; comparator: '>' | '<'; value: number }
  | { kind: 'USER_REQUEST' };
```

### 5.2 Domain agents `[BUILT — engines exist; agent wrapper is [NEW]]`

| Agent | Wraps | Trigger | Output events | Autonomy |
|---|---|---|---|---|
| Take-off | `tender.runTakeoff` | Drawing registered | `TAKEOFF_COMPLETED`, `BOQITEM_CREATED_FROM_TAKEOFF` | EXECUTE_BOUNDED |
| Estimating | `tender.buildEstimate` | Take-off complete | `ESTIMATE_CREATED` | PROPOSE |
| Bid evaluation | `tender.evaluateSubmissions` | Return deadline passed | `BIDS_EVALUATED` | EXECUTE (deterministic) |
| Programme | `planning.recalculateProgramme` | Task or dependency changed | `PROGRAMME_RECALCULATED` | EXECUTE |
| Delay forecast | `planning.forecastDelay` | Daily; or slippage > 0 | `DELAY_RISK_FORECAST` | EXECUTE |
| Cost intelligence | `cost.publishCVR` | Monthly; or actuals posted | `CVR_PUBLISHED` | EXECUTE |
| Notice watchdog | `cost.noticePosition` | Daily | `PAYMENT_NOTICE_ISSUED` prompt | PROPOSE (escalates to QS) |
| Risk | `safety.registerRisk` | Change assessed | `RISK_REGISTERED` | PROPOSE |
| Safety forecast | `safety.forecastSafetyRisk` | Weekly; or incident | `SAFETY_FORECAST_PRODUCED` | EXECUTE |
| RAMS | `safety.draftRAMS` | Work package scheduled | `RAMS_DRAFTED` | PROPOSE (safety approves) |
| Clash | `bim.detectClashes` | Model ingested | `CLASH_DETECTED` | EXECUTE |
| Drawing control | `bim.registerDrawing` | Transmittal received | `DRAWING_REGISTERED`, `DRAWING_SUPERSEDED` | EXECUTE |
| Change impact | `claims.assessImpact` | Change submitted | `IMPACT_ASSESSED` | EXECUTE_BOUNDED |
| Claims | `claims.assessDelayClaim` | Delay events ≥ 1 | `CLAIM_ASSESSED` | PROPOSE |
| Handover | `handover.compileHandoverPack` | Commissioning accepted | `HANDOVER_PACK_COMPILED` | EXECUTE |
| Maintenance | `handover.forecastMaintenance` | Monthly | `MAINTENANCE_FORECAST_PRODUCED` | EXECUTE |

### 5.3 Executive agents `[NEW]`

| Agent | Purpose | Inputs | Escalation |
|---|---|---|---|
| Chief of Staff | Prioritises the operator's day from live exceptions | All panels for the role | Never — advisory |
| CEO | Portfolio-level trade-offs, capital allocation | Portfolio targets, project forecasts | Board pack to Owner |
| CFO | Cash, margin, working capital across projects | CVR, cashflow, ledger position | Owner on covenant breach |
| COO | Delivery capacity, resource conflicts across projects | Programmes, resource demand | PM on conflict |
| CRO | Commercial win rate, bid pipeline health | Bid evaluations, awards | Owner |
| Analyst | Answers questions from state | Materialised ledger | — |
| Research | Market, competitor, regulatory intelligence | External feeds `[NEW]` | — |
| Growth | Expansion within account, module adoption | Usage telemetry | — |

### 5.4 Platform agents `[NEW]`

| Agent | Watches | Acts |
|---|---|---|
| System Health | Uptime, p95 latency, error rate, queue depth | Alerts, auto-scales, opens incident |
| Bug Detection | Error clustering, regression signatures | Opens a defect with reproduction |
| Auto-Repair | Failed jobs, stuck sync sessions, dead letters | Retries with backoff, quarantines poison messages |
| Infrastructure Optimisation | Compute, storage, egress, provider spend | Right-sizes; reports saving |
| Release Management | Deploy health, error budget | Progressive rollout; auto-rollback on SLO burn |
| AI Governance | Agent behaviour, prompt drift, output schema failures | Suspends a misbehaving agent; forces PROPOSE mode |

**Boundary:** platform agents operate on infrastructure telemetry only. They
hold no tenant data permission, matching the operator's own restriction. `[BUILT — the restriction exists in ABAC]`

### 5.5 Security agents `[NEW]`

Threat Hunter, SOC, Fraud, Vulnerability, Identity — detailed in §13.

### 5.6 Compliance agents `[NEW]`

GDPR (subject access, retention, erasure-with-ledger-tombstone), AML/KYC
(supplier and merchant onboarding), Regulatory (jurisdiction rule packs:
Building Safety Act, CDM, Construction Act payment terms).

**Erasure vs immutability.** A right-to-erasure request cannot delete ledger
events without destroying the evidentiary chain. Resolution: personal data is
stored by reference; erasure redacts the referenced record and writes a
tombstone event. The chain stays intact, the personal data does not. `[NEW]`

---

## 6. Platform modules

| Module | Status | Location |
|---|---|---|
| Golden Thread ledger, replay, attestation | `[BUILT]` | `src/goldenthread/` |
| Identity, RBAC/ABAC/scopes, MFA, token rotation | `[BUILT]` | `src/identity/` |
| Enterprise → portfolio → programme → project → package | `[BUILT]` | `src/domain/structure.ts` |
| Lifecycle phase gates | `[BUILT]` | `src/lifecycle/phases.ts` |
| Seven engines | `[BUILT]` | `src/engines/` |
| Procurement and tender workflow | `[BUILT]` | `src/domain/procurement.ts` |
| ACU wallet, caps, alerts, attribution | `[BUILT]` | `src/billing/acu.ts` |
| Subscription and invoicing | `[BUILT]` | `src/billing/` |
| Offline field sync | `[BUILT]` | `src/field/sync.ts` |
| Branded, hashed exports | `[BUILT]` | `src/export/exporter.ts` |
| Gateway, rate limiting, validation, problem+json | `[BUILT]` | `src/api/` |
| Conversational copilot | `[BUILT]` | `src/ai/conversation.ts` |
| Command centre UI | `[BUILT]` (fifteen screens) / `[EXTEND]` (per role) | `web/pages/` |
| Agent runtime and memory | `[NEW]` | §5.1, §9 |
| Vector store and knowledge graph | `[NEW]` | §8 |
| Notification and webhook engine | `[NEW]` | §11 |
| BitriPay gateway | `[NEW]` | §7 |
| Connector framework | `[NEW]` | §8 |
| Admin super control centre | `[EXTEND]` | §14 |

---

## 7. BitriPay integration gateway `[NEW]`

Payments enter CONSTRUX at three points: ACU top-ups, subscription collection,
and project payment settlement (certified sums to subcontractors). BitriPay is
the first-class gateway; the abstraction below keeps it swappable, exactly as
AI providers are.

### 7.1 Architecture

```
Merchant / tenant
      │  API key (scoped, rotatable)
      ▼
BitriPay Integration Gateway ── idempotency store
      │                          webhook signer/verifier
      ├── Payment orchestrator ── provider adapter (BitriPay | Stripe | Adyen)
      ├── Settlement engine ───── ledger postings
      └── Reconciliation agent ── exception queue
```

### 7.2 Provider abstraction

```ts
interface PaymentProviderAdapter {
  readonly name: 'BITRIPAY' | 'STRIPE' | 'ADYEN' | 'CHECKOUT';
  createIntent(input: PaymentIntentInput): Promise<PaymentIntent>;
  capture(intentId: string, amountMinor: number): Promise<PaymentResult>;
  refund(paymentId: string, amountMinor: number, reason: string): Promise<RefundResult>;
  createPaymentLink(input: PaymentLinkInput): Promise<{ url: string; expiresAt: string }>;
  createQr(input: QrInput): Promise<{ payload: string; imageDataUri: string }>;
  settlementReport(from: string, to: string): Promise<SettlementLine[]>;
  verifyWebhook(rawBody: Buffer, signature: string, secret: string): boolean;
}
```

### 7.3 Merchant onboarding

| Step | Control |
|---|---|
| Register merchant | KYB: company number, beneficial owners, sanctions screen |
| Assign API keys | Separate sandbox and live; live keys blocked until KYB passes |
| Configure webhooks | HTTPS only; endpoint ownership proven by challenge response |
| Set settlement account | Bank verification (penny check or open-banking confirmation) |
| Go live | Requires KYB pass **and** a successful sandbox transaction |

### 7.4 Endpoints

```
POST   /v1/pay/merchants                      Register a merchant (KYB triggered)
GET    /v1/pay/merchants/{id}                 Merchant status and limits
POST   /v1/pay/merchants/{id}/keys            Mint an API key (returned once)
DELETE /v1/pay/merchants/{id}/keys/{keyId}    Revoke immediately
POST   /v1/pay/intents                        Create a payment intent
POST   /v1/pay/intents/{id}/capture           Capture
POST   /v1/pay/links                          Payment link
POST   /v1/pay/qr                             QR payload
POST   /v1/pay/refunds                        Refund (reason mandatory)
GET    /v1/pay/transactions                   Filterable ledger
GET    /v1/pay/settlements                    Settlement batches
POST   /v1/pay/disputes/{id}/evidence         Submit dispute evidence
POST   /v1/pay/webhooks/bitripay              Inbound provider callback
```

### 7.5 Money rules

1. **Integer minor units only.** No floating point touches money, anywhere.
2. **Idempotency mandatory.** Every mutating call requires `Idempotency-Key`;
   replays return the original result. `[BUILT — gateway-wide]`
3. **Double-entry postings.** Every movement writes balanced entries; a
   settlement that does not balance is an incident, not a rounding difference.
4. **Webhook verification.** HMAC-SHA256 over the raw body, constant-time
   compare, five-minute replay window, delivery id de-duplicated.
5. **Commission split at authorisation**, not settlement, so a platform fee is
   never stranded by a partial capture.
6. **Every payment event enters the Golden Thread**, so the payment record and
   the certification it settles share one chain.

### 7.6 New event types `[NEW — extends `src/goldenthread/eventTypes.ts`]`

`MERCHANT_REGISTERED`, `MERCHANT_KYB_PASSED`, `PAYMENT_INTENT_CREATED`,
`PAYMENT_CAPTURED`, `PAYMENT_FAILED`, `REFUND_ISSUED`, `SETTLEMENT_BATCH_CREATED`,
`SETTLEMENT_RECONCILED`, `DISPUTE_OPENED`, `DISPUTE_RESOLVED`,
`COMMISSION_SPLIT_APPLIED` — all `requiresEvidence: true` for money movement.

---

## 8. Connector ecosystem `[NEW]`

### 8.1 Connector framework

```ts
interface Connector<TConfig, TIn, TOut> {
  readonly id: string;
  readonly category: ConnectorCategory;
  readonly dataClassification: 'PUBLIC' | 'INTERNAL' | 'PERSONAL' | 'FINANCIAL';
  healthy(): Promise<boolean>;
  configure(config: TConfig): void;
  execute(input: TIn): Promise<TOut>;
  /** Cost per call in minor units — folds into ACU accounting where metered. */
  estimateCostMinor(input: TIn): number;
}
```

Every connector is rate-limited, circuit-broken, retried with jittered backoff,
and its outbound payload is classified so personal and financial data cannot
leave through a connector not cleared for it.

### 8.2 Required categories

| Category | Why CONSTRUX needs it | Connects at | Data out / in | Providers |
|---|---|---|---|---|
| AI models | Every engine execution | AI orchestrator `[BUILT]` | Structured payload / structured JSON | OpenAI, Anthropic, Gemini, Vertex, Mistral |
| Payments | ACU top-up, subscription, settlement | BitriPay gateway | Amount, merchant ref / status | BitriPay, Stripe, Adyen |
| Banking / open banking | Settlement verification, cash position | Settlement engine | Account ref / balance, transactions | TrueLayer, Plaid |
| KYC / KYB | Supplier and merchant onboarding | Onboarding agent | Company and officer data / verdict | Sumsub, Persona, Veriff |
| AML screening | Sanctions, PEP on counterparties | Compliance agent | Name, DOB, jurisdiction / hits | ComplyAdvantage |
| Fraud | Payment and account risk | Fraud agent | Device, behaviour signals / score | Sift, Seon |
| Email | Notices, reports, invitations | Notification engine | Recipient, template / delivery | SendGrid, Brevo |
| SMS / WhatsApp | Site alerts, MFA, safety stand-downs | Notification engine | Number, message / delivery | Twilio |
| Push | Mobile field alerts | Notification engine | Device token / receipt | FCM, APNs |
| Maps / geospatial | Site boundaries, logistics, geofenced capture | Field, twin | Coordinates / geometry | Mapbox, Ordnance Survey |
| Weather | Delay causation, safety forecasting | Planning, safety engines | Location, window / forecast + historical | Met Office, Meteomatics |
| Commodity pricing | Live material rates for estimating | Tender engine | Commodity, region / index | Trading Economics, MEPS |
| Accounting / ERP | Actual cost, commitments, invoices | Cost engine | Cost codes, postings / actuals | Xero, Sage, SAP, D365 |
| Tax | VAT/CIS on payments and certificates | Settlement | Amount, jurisdiction / treatment | Avalara |
| E-signature | Subcontracts, handover certificates | Procurement, handover | Document / signed artefact + audit | SignWell, DocuSign |
| Document generation | Branded PDF rendering | Export service `[BUILT — model exists]` | Document model / PDF | Internal renderer |
| Cloud storage | Media, BIM, exports | Object storage | File / URI + hash | S3, Cloudflare R2 |
| Authentication | Enterprise SSO | Gateway `[BUILT — verification layer]` | Assertion / claims | Entra ID, Okta |
| CRM | Bid pipeline, client relationships | Executive agents | Opportunity / status | Salesforce, HubSpot |
| Analytics | Product telemetry | Observability | Events / dashboards | Snowflake, ClickHouse |
| Support | Ticketing and escalation | Support agent | Ticket / status | Zendesk, Intercom |
| Data enrichment | Supplier financial health | Procurement | Company number / credit, accounts | Creditsafe, Dun & Bradstreet |
| FX | Multi-currency portfolios | Billing, portfolio rollup | Pair / rate | ECB, OpenExchange |

---

## 9. Production architecture

### 9.1 Runtime topology

```
Cloudflare (WAF, DDoS, bot management)
        │
   API Gateway  ── Redis (rate limit, idempotency, sessions-free cache)
        │
  ┌─────┴───────────────────────────────────────────┐
  │  Domain services (stateless, horizontally scaled) │
  │  identity · delivery · commercial · contracts     │
  │  field · handover · export · payments             │
  └─────┬───────────────────────────────────────────┘
        │
   Kafka (partitioned by tenantId:projectId)
        │
  ┌─────┴──────────┬──────────────┬─────────────────┐
Golden Thread    Read models   Agent runtime    Search / vector
(Postgres,       (Postgres,    (workers,        (pgvector or
 append-only)     projections)  ACU-budgeted)    dedicated store)
        │
   Object storage (media, BIM, exports) — referenced by hash
```

**Partitioning.** `partitionKey = tenantId:projectId` guarantees per-project
ordering and tenant isolation, and makes replay deterministic.

### 9.2 Agent runtime `[NEW]`

```
Trigger (event | schedule | threshold | request)
   → Policy check   : does the operator hold the required permission?
   → Budget check   : ACU budget for this agent, this period
   → Memory load    : episodic (this project) + semantic (org knowledge)
   → Plan           : bounded step list, no open-ended loops
   → Execute        : each step is an existing engine command
   → Verify         : output schema + domain invariants
   → Commit         : Golden Thread write, then ACU debit  [BUILT sequence]
   → Escalate       : if bounds exceeded or verification failed
```

**Three hard limits.** Maximum steps per run; maximum ACU per run; no agent may
trigger another agent more than one level deep. Unbounded agent recursion is the
most common way an autonomous system burns a budget overnight.

### 9.3 Memory `[NEW]`

| Layer | Store | Contents | Retention |
|---|---|---|---|
| Working | In-process | Current run context | Run lifetime |
| Episodic | Postgres | Prior runs, outcomes, corrections | Project lifetime |
| Semantic | Vector | Specifications, contracts, standards, prior claims | Tenant lifetime |
| Organisational | Knowledge graph | Entities and relations across the portfolio | Tenant lifetime |
| Procedural | Config | Prompts, tools, bounds — versioned and diffable | Versioned |

**Retrieval is tenant-scoped at the index level, not by filter.** A shared index
with a tenant predicate is one bug away from cross-tenant disclosure.

### 9.4 Knowledge graph `[NEW]`

Nodes: Project, Asset, Package, Task, Drawing, Model element, Contract, Clause,
Variation, Delay event, Risk, RAMS, Operative, Supplier, Defect, Work order.
Edges: `CAUSED_BY`, `EVIDENCED_BY`, `SUPERSEDES`, `AFFECTS`, `INSTRUCTED_BY`,
`INSTALLED_AS`, `MAINTAINED_BY`, `PRICED_FROM`.

This is what lets a defect in year twelve resolve to the drawing revision it was
built to, through installation, commissioning and as-built.

---

## 10. Database schema

Two schemas: an append-only ledger and derived read models. Read models are
disposable — they can always be rebuilt by replay.

### 10.1 Ledger (authoritative) `[BUILT — in-memory; Postgres DDL below is `[NEW]`]`

```sql
CREATE TABLE golden_thread_event (
  event_id            CHAR(26) PRIMARY KEY,               -- ULID, sortable
  tenant_id           CHAR(26) NOT NULL,
  project_id          TEXT     NOT NULL,
  occurred_at         TIMESTAMPTZ NOT NULL,               -- server receipt
  device_timestamp    TIMESTAMPTZ,                        -- time on site
  actor_type          TEXT NOT NULL CHECK (actor_type IN ('User','System','AI')),
  actor_id            TEXT NOT NULL,
  source              TEXT NOT NULL CHECK (source IN ('WEB','ANDROID','IOS','SYSTEM','AI')),
  event_type          TEXT NOT NULL REFERENCES event_type_catalogue(code),
  entity_type         TEXT NOT NULL,
  entity_id           TEXT NOT NULL,
  action              TEXT NOT NULL,
  before_hash         TEXT NOT NULL,
  after_hash          TEXT NOT NULL,
  diff                JSONB NOT NULL,                     -- constrained RFC 6902
  evidence_refs       JSONB,
  ai_block            JSONB,                              -- provider, model, ACU
  policy_block        JSONB,
  correlation_id      TEXT NOT NULL,
  causation_id        TEXT,
  previous_chain_hash TEXT NOT NULL,
  chain_hash          TEXT NOT NULL
);

-- Append-only enforced in the database, not only in the application.
CREATE RULE gt_no_update AS ON UPDATE TO golden_thread_event DO INSTEAD NOTHING;
CREATE RULE gt_no_delete AS ON DELETE TO golden_thread_event DO INSTEAD NOTHING;

CREATE INDEX gt_project_time ON golden_thread_event (tenant_id, project_id, occurred_at, event_id);
CREATE INDEX gt_entity       ON golden_thread_event (entity_type, entity_id, occurred_at);
CREATE INDEX gt_correlation  ON golden_thread_event (correlation_id);
CREATE INDEX gt_type_time    ON golden_thread_event (event_type, occurred_at);
CREATE UNIQUE INDEX gt_chain ON golden_thread_event (project_id, chain_hash);

CREATE TABLE entity_state (
  tenant_id   CHAR(26) NOT NULL,
  project_id  TEXT     NOT NULL,
  entity_type TEXT     NOT NULL,
  entity_id   TEXT     NOT NULL,
  state       JSONB    NOT NULL,
  state_hash  TEXT     NOT NULL,
  version     INTEGER  NOT NULL,
  last_event_id CHAR(26) NOT NULL REFERENCES golden_thread_event(event_id),
  PRIMARY KEY (entity_type, entity_id)
);
CREATE INDEX es_project ON entity_state (tenant_id, project_id, entity_type);
CREATE INDEX es_state   ON entity_state USING GIN (state jsonb_path_ops);

CREATE TABLE evidence_item (
  evidence_id CHAR(26) PRIMARY KEY,
  tenant_id   CHAR(26) NOT NULL,
  project_id  TEXT NOT NULL,
  type        TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  uri         TEXT,
  description TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL,
  captured_by TEXT NOT NULL
);
CREATE UNIQUE INDEX ev_hash ON evidence_item (tenant_id, content_hash);
```

**Row-level security.** Every tenant-scoped table carries an RLS policy on
`tenant_id` bound to the connection's tenant claim, so a query without a tenant
predicate returns nothing rather than everything.

### 10.2 Commercial `[BUILT — in-memory]`

```sql
CREATE TABLE acu_entry (
  entry_id      CHAR(26) PRIMARY KEY,
  tenant_id     CHAR(26) NOT NULL,
  project_id    TEXT,
  user_id       TEXT,
  module        TEXT,                    -- the engine
  feature       TEXT,                    -- the task type
  provider      TEXT,
  entry_type    TEXT NOT NULL CHECK (entry_type IN ('TOP_UP','HOLD','DEBIT','RELEASE','GRANT','REFUND')),
  raw_cost_minor  BIGINT NOT NULL,
  acu_units       BIGINT NOT NULL,
  billed_minor    BIGINT NOT NULL,
  effective_multiplier NUMERIC(4,2) NOT NULL,
  ai_request_id CHAR(26),
  invoice_id    CHAR(26),
  created_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX acu_tenant_month ON acu_entry (tenant_id, date_trunc('month', created_at));
CREATE INDEX acu_attribution  ON acu_entry (tenant_id, module, created_at);
```

### 10.3 Payments `[NEW]`

```sql
CREATE TABLE merchant (
  merchant_id CHAR(26) PRIMARY KEY,
  tenant_id   CHAR(26) NOT NULL,
  legal_name  TEXT NOT NULL,
  kyb_status  TEXT NOT NULL CHECK (kyb_status IN ('PENDING','PASSED','FAILED','SUSPENDED')),
  live_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  settlement_account_ref TEXT,
  created_at  TIMESTAMPTZ NOT NULL
);

CREATE TABLE payment_transaction (
  payment_id     CHAR(26) PRIMARY KEY,
  merchant_id    CHAR(26) NOT NULL REFERENCES merchant(merchant_id),
  provider       TEXT NOT NULL,
  provider_ref   TEXT NOT NULL,
  amount_minor   BIGINT NOT NULL CHECK (amount_minor > 0),
  currency       CHAR(3) NOT NULL,
  commission_minor BIGINT NOT NULL DEFAULT 0,
  status         TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX pay_idem     ON payment_transaction (merchant_id, idempotency_key);
CREATE UNIQUE INDEX pay_provider ON payment_transaction (provider, provider_ref);

CREATE TABLE ledger_posting (         -- double entry; must balance per txn
  posting_id  CHAR(26) PRIMARY KEY,
  payment_id  CHAR(26) NOT NULL REFERENCES payment_transaction(payment_id),
  account     TEXT NOT NULL,
  debit_minor  BIGINT NOT NULL DEFAULT 0,
  credit_minor BIGINT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL,
  CHECK ((debit_minor = 0) <> (credit_minor = 0))
);
```

### 10.4 Agent runtime `[NEW]`

```sql
CREATE TABLE agent_run (
  run_id        CHAR(26) PRIMARY KEY,
  tenant_id     CHAR(26) NOT NULL,
  project_id    TEXT,
  agent_id      TEXT NOT NULL,
  triggered_by  JSONB NOT NULL,
  operator_id   TEXT NOT NULL,        -- whose permissions were used
  status        TEXT NOT NULL CHECK (status IN ('RUNNING','SUCCEEDED','FAILED','ESCALATED','BUDGET_EXCEEDED')),
  steps         JSONB NOT NULL,
  acu_consumed_minor BIGINT NOT NULL DEFAULT 0,
  events_written TEXT[],
  started_at    TIMESTAMPTZ NOT NULL,
  ended_at      TIMESTAMPTZ
);
```

---

## 11. API specification

### 11.1 Conventions `[BUILT]`

- Path-based versioning, `/v1/...`; `/v2` runs in parallel, never in place
- `Authorization: Bearer <access token>`, 15-minute expiry, no grace window
- `Idempotency-Key` on every mutating call
- Errors as `application/problem+json` with `traceId` and `correlationId`
- `GET /v1/routes` is the live self-describing index

### 11.2 Error codes

| HTTP | Code | Meaning |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Schema violation; every field error returned at once |
| 401 | `UNAUTHENTICATED` | Missing, malformed, expired or revoked token |
| 402 | `ACU_EXHAUSTED` | Insufficient prepaid credit; AI halted |
| 403 | `ACCESS_DENIED` | RBAC, scope or ABAC denial with the reason |
| 404 | `NOT_FOUND` / `ENTITY_NOT_FOUND` | Unknown route or entity |
| 409 | `STALE_STATE` / `ENTITY_EXISTS` / `CURSOR_REGRESSION` | Concurrency conflict |
| 422 | `PHASE_GATE_FAILED`, `EVIDENCE_REQUIRED`, `AI_NOT_PERMITTED`, … | Domain invariant violated |
| 429 | `RATE_LIMITED` | With `Retry-After` |
| 502 | `AI_PROVIDER_ERROR` | Upstream provider failure; nothing charged |
| 503 | `AI_UNAVAILABLE` | No healthy adapter |

### 11.3 Rate limits `[BUILT]`

| Group | Steady | Burst | Key |
|---|---|---|---|
| Auth | 20/min | 5 | IP (pre-auth) |
| AI execution | 100/min | 20 | tenant:actor |
| General | 1000/min | 200 | tenant:actor |

Fail-closed: if the limiter backend is unavailable, requests are denied.

### 11.4 Webhooks `[NEW]`

```
POST {subscriber_url}
X-Construx-Event: PROGRAMME_BASELINE_APPROVED
X-Construx-Delivery: 01J...           # unique; de-duplicate on this
X-Construx-Timestamp: 1770000000       # reject if older than 300s
X-Construx-Signature: sha256=<hmac over timestamp + "." + raw body>
```

Retries at 1s, 5s, 25s, 2m, 10m, 1h, 6h. Consumers acknowledge with 2xx within
5s. After the final attempt the delivery moves to a dead-letter queue with a
replay endpoint. Subscriptions are per tenant, per event type, and filtered by
the subscriber's own permission scopes — a webhook cannot exfiltrate data the
subscriber could not read through the API.

---

## 12. Monetisation

### 12.1 Live model `[BUILT]`

| Stream | Basis | Enforcement |
|---|---|---|
| Platform subscription | Tier with named identity seats | Seat limits enforced at assignment |
| AI usage (ACU) | Fixed multiplier over provider cost | Reserve → execute → persist → debit |
| Volume incentive | Multiplier steps down at scale | Applied at reserve and settle |
| Free trial | Fixed AI grant, no payment method | Same enforcement as paid credit |

### 12.2 Extensions `[NEW]`

| Stream | Basis | Notes |
|---|---|---|
| API / integration | Metered calls beyond a tier allowance | Same wallet, distinct module attribution |
| White-label licensing | Per deployment plus usage | Tenant isolation already supports it |
| Enterprise / sovereign | Negotiated, isolated tenancy | `SOVEREIGN` tier exists `[BUILT]` |
| Premium automation | Per-agent subscription | Agent runtime enforces per-agent budgets |
| Data intelligence | Anonymised, aggregated benchmarking | Opt-in per tenant; k-anonymity ≥ 20; never raw records |
| Payment gateway | Commission split on processed volume | §7 |
| Marketplace | Verified supplier and professional access | Subscription, not referral, by default |

### 12.3 Optimisation engines `[NEW]`

Dynamic pricing (elasticity by tier and region), CLV, churn prediction (usage
decay, seat under-assignment, support signals), upsell (tier limits repeatedly
hit), cross-sell (engines never activated). All read telemetry, never project
content — commercial models must not see client commercial data.

---

## 13. Security, compliance and risk

### 13.1 Zero trust `[BUILT in part]`

| Control | Status |
|---|---|
| No implicit trust; every request authenticated and authorised | `[BUILT]` |
| Tenant isolation enforced twice (ABAC and ledger) | `[BUILT]` |
| Fail-closed authorisation | `[BUILT]` |
| Short-lived access tokens, rotating refresh | `[BUILT]` |
| MFA with exposure control | `[BUILT]` |
| Service-to-service mTLS | `[NEW]` |
| Device fingerprinting and risk-based step-up | `[NEW]` |
| Biometric unlock on mobile | `[NEW]` |

### 13.2 Attack surface

| Threat | Control | Status |
|---|---|---|
| DDoS | Edge mitigation, tenant-aware limits | `[EXTEND]` |
| SQL injection | Parameterised queries; no dynamic SQL | `[NEW — DB layer]` |
| XSS | No untrusted HTML rendering; escaped export output | `[BUILT]` |
| CSRF | Bearer tokens only, no ambient cookies | `[BUILT]` |
| Session hijacking | No server sessions; short TTL; revocation list | `[BUILT]` |
| Account takeover | MFA, anomaly detection, notified changes | `[EXTEND]` |
| Credential stuffing | Tight auth limits, breached-password checks | `[EXTEND]` |
| API abuse | Scopes, per-route limits, quotas | `[BUILT]` |
| Bot traffic | Edge bot management | `[NEW]` |
| Privilege escalation via agents | Agent permissions derived from operator | `[BUILT — principle]` |
| Cross-tenant leakage via vector search | Per-tenant indexes, not filtered shared indexes | `[NEW]` |
| Prompt injection through ingested documents | Documents are data, never instructions; structured output only; no tool invocation from document content | `[BUILT — principle]` |
| Evidence tampering | Hash chain and replay verification | `[BUILT]` |

### 13.3 Data protection

Encryption in transit (TLS 1.3), at rest (AES-256, per-tenant keys under a KMS),
and tokenisation of payment instruments — the platform stores no PAN. Personal
data is referenced, not embedded in ledger state, which is what makes erasure
possible without breaking the chain (§5.6).

### 13.4 Compliance mapping

| Regime | Requirement | Mechanism |
|---|---|---|
| GDPR | Lawful basis, minimisation, erasure, portability | Reference-based personal data; tombstone erasure; export service `[BUILT/NEW]` |
| Building Safety Act | Golden thread of information | The ledger is the golden thread `[BUILT]` |
| CDM | Health and safety file | RAMS, competency, safety file in handover pack `[BUILT]` |
| Construction Act | Payment and pay-less notice timing | Payment cycle engine `[BUILT]` |
| PCI-DSS | Cardholder data | Never stored; provider-hosted fields `[NEW]` |
| AML / KYC / KYB | Counterparty screening | Compliance agents `[NEW]` |
| SOC 2 / ISO 27001 | Control evidence | Immutable audit log is the primary evidence `[BUILT]` |

---

## 14. Admin super control centre `[EXTEND]`

Two distinct surfaces, matching the account-layer separation that already exists:

**Platform operator console** — tenants, subscriptions, ACU consumption and
margin by tenant, provider health and spend, incidents, error budgets, agent
governance (suspend a misbehaving agent globally), feature flags, connector
health. Explicitly excludes project delivery data.
`[BUILT — the tenant estate, API surface, permission matrix and gateway
activity; provider health, incidents and feature flags are EXTEND]`

Signing in as the seeded Platform Operator shows this surface and nothing else:
the delivery navigation is locked, `projectContext` refuses the token, and ABAC
denies every delivery capability area independently of the permission matrix.

**Enterprise admin console** — users and seats, roles and policy, portfolio and
project structure, AI budget allocation per project, export history, audit
replay, compliance status. `[BUILT — partially, in the application]`

Every administrative action is itself a Golden Thread event. There is no
back door: an operator who changes a tenant's cap leaves a record with the same
weight as a site supervisor recording a pour.

---

## 15. Build roadmap

| Phase | Scope | Status |
|---|---|---|
| **0 — Foundations** | Ledger, hashing, patches, catalogue, replay, identity, RBAC/ABAC, ACU wallet, gateway | **Complete** `[BUILT]` |
| **1 — Domain MVP** | Seven engines, lifecycle gates, procurement, offline sync, branded exports, fifteen-screen web application, 157 tests | **Complete** `[BUILT]` |
| **2 — Persistence & scale** | Postgres ledger with RLS and append-only rules, Kafka, read-model projections, object storage, Terraform | 6–8 weeks |
| **3 — Agent runtime** | Agent contract, memory layers, vector store, per-role command centres, bounded autonomy, governance agent | 8–10 weeks |
| **4 — Payments** | BitriPay gateway, merchant onboarding with KYB, settlement, reconciliation, disputes | 8 weeks |
| **5 — Connectors** | Framework, then ERP, KYC/AML, comms, e-signature, weather, commodity pricing | 10 weeks |
| **6 — Mobile** | Native Android and iOS on the existing sync protocol; biometric unlock; voice capture | 12 weeks |
| **7 — Enterprise hardening** | SSO, mTLS, SOC 2 evidence, DR drills, chaos testing, load testing, runbooks | 8 weeks |
| **8 — Global scale** | Multi-region, data residency, sovereign tenancy, white-label, jurisdiction rule packs | Ongoing |

Phases 2 and 3 can run in parallel; 4 and 5 depend on 2.

---

## 16. Reliability and operations `[NEW]`

**Service levels.** Gateway availability 99.9%; read p95 < 300ms; command p95 <
800ms; AI execution p95 < 20s; sync push p95 < 2s for a 100-operation batch.

**Disaster recovery.** RPO 5 minutes, RTO 1 hour. The ledger is the only
truly irreplaceable store: it is replicated synchronously within region and
asynchronously cross-region, and its integrity is provable after restore by
replaying the chain. Read models are rebuilt, not restored.

**Chaos testing.** Broker loss, database failover, provider outage, reconnect
storms after site-wide signal loss, export backlog, ACU exhaustion under load.

**Runbooks.** Incident response, event replay, ACU dispute resolution, AI
provider outage, export recovery, suspected tamper (isolate, replay, report).

---

## 17. Competitive position

| Dimension | Conventional platform | CONSTRUX |
|---|---|---|
| Record | Documents in folders | Hash-chained event ledger, independently verifiable |
| Forecasting | Reports the past | P80 durations, forecast final cost, delay and safety prediction |
| Claims | Assembled retrospectively | Attribution with concurrency, computed continuously |
| AI economics | Absorbed until margin breaks | Reserved before execution, capped, attributed per engine |
| Governance | Role dropdowns | Fail-closed RBAC + scopes + ABAC with enforced separation of duties |
| Lifecycle | Ends at handover | Same spine through thirty years of operation |
| Trust | Asserted | Demonstrated: run the demo and it tampers with its own record to prove detection |

**The defensible position.** Features are copyable. A thirty-year, cryptographically
verifiable record of how an asset came to exist is not — because it cannot be
back-filled. Every month a project runs on CONSTRUX, the cost of leaving rises,
and the value of the record to owners, insurers and regulators compounds.

---

## Appendix — verifying the claims in this document

```bash
npm run demo    # full lifecycle, replay verification, deliberate tamper detection
npm test        # 157 tests
npm start       # gateway, landing page, application at /app, API at /v1/routes
```

Requirement-by-requirement mapping, including what is deliberately not built:
[`docs/traceability.md`](traceability.md).
