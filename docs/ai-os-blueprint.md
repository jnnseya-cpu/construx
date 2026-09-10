# CONSTRUX AI Operating System — Production Blueprint

> **Superseded in scope, not withdrawn.** `docs/AI-OS.html` is the current and
> larger version of this blueprint — twenty sections, with the platform inventory
> measured from the repository at the time of writing rather than estimated. This
> file is kept for its section-by-section reasoning; nothing in it is removed.
> Where the two disagree on a *count*, take the figure from `docs/STATE.md`.

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

### 2.1 The beachhead, named

"Construction" is too wide to win from a standing start, and a platform that
addresses everybody is bought by nobody first.

**UK water framework contractors under AMP8.** The frameworks are named and
finite, so the total addressable set is countable rather than estimated. The
duty-holder regime is at its heaviest, which makes the evidentiary argument land
rather than sound abstract. The payment regime is the one this platform computes.
And the flagship demonstration project is a water treatment works, so a
prospective customer walks through their own kind of job on their first visit
instead of a generic one.

Expansion from there is by adjacency of contract form rather than by sector
noun: highways and rail frameworks share the notice regime, the duty-holder
position and the assurance culture. Selling to housebuilding next would be
selling to a different buyer with a different problem.

### 2.2 Where CONSTRUX loses

Stated because a market analysis with no losing column is marketing. Each of
these is a real reason a real contractor picks somebody else, and none of them
is answered by building harder.

| Situation | Who wins, and why |
|---|---|
| **The team already lives in Procore or Autodesk Build** | They do. Switching a working document control system mid-framework is a cost with no offsetting benefit until a dispute arrives, and disputes are not scheduled. CONSTRUX wins here on a *new* project or after a loss, not by displacement. |
| **The buyer wants document management** | They do. This platform is a governed record with documents attached to it, not a document store, and a buyer whose actual problem is "where is the latest drawing" is better served elsewhere and will say so. |
| **Deep resource levelling and multi-project resource optimisation** | P6 does. The programme engine here does CPM, float, PERT and Monte Carlo honestly; it does not level resources across a portfolio, and pretending otherwise would be found out in the first month. |
| **The buyer needs finance, payroll and plant hire in one system** | SAP or an ERP does. This is deliberately not a general ledger, and the integration story is a change feed and an API rather than a module. |
| **The buyer has no reference to call** | Every incumbent does. This is the largest single obstacle and it is not technical. It is answered by founding-partner terms and by the exit guarantee, not by another feature. |
| **Procurement requires an ISO 27001 certificate on the day** | Certified competitors do. The controls exist and are tested; the certificate does not, and a framework client's assurance gate does not accept "the controls exist". |

### 2.3 The three honest weaknesses

1. **The record's value is back-loaded.** Everything that makes this platform
   worth more than its competitors — a chronology that survives an adjudication,
   thirty years of asset provenance, a document a stranger can verify — pays out
   at the moment of a dispute, an insurance renewal or a handover. The costs are
   all in month one. That is the wrong shape for an easy sale and the right shape
   for a durable one, and the pricing has to survive the gap.

2. **The refusals will cost deals.** The platform declines to approve a plan with
   gaps, declines to sign in a name that is not competent, declines to invent a
   figure. Every one of those is a moment where a competitor's product says yes
   and this one says no, and some buyers will choose the one that says yes. That
   is the position, taken deliberately, and it should not be quietly softened
   under sales pressure — the day it is, there is nothing left worth buying.

3. **One process holds the record today.** The store is in-process with a durable
   journal beside it. The Postgres schema and the wire client are both verified
   against a real database, so this is wiring rather than design — but it is not
   done, and it is the reason `docs/LAUNCH_AUDIT.md` says GO for a controlled
   pilot and NO-GO for general availability.

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

All roles and the enforceable matrix: `backend/src/identity/roles.ts` `[BUILT]`

---

## 4. AI Command Centres

Each user type receives a command centre: a role-scoped surface combining live
state, the agents available to that role, and the actions the permission matrix
permits. The context-aware tool router already returns exactly the tools a role
may use at the current lifecycle phase (`backend/src/ai/conversation.ts`) `[BUILT]`.

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

### Command centre contract `[NEW — extends `backend/src/ai/conversation.ts`]`

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

Seven domain engines exist today (`backend/src/engines/`) `[BUILT]`. The agent layer
wraps them with memory, triggers and escalation.

> **The `[NEW]` markers below are stale and are kept for the reasoning, not the
> status.** The agent layer was built: `backend/src/agents/registry.ts` holds 81
> agents across nine divisions, each declaring its capability area, memory
> access, ACU tier, human-in-the-loop mode and mandate ceiling. See
> [§18](#18-agent-depth-autonomy-and-the-automation-boundary) for what is
> actually built, measured from the repository, and `docs/STATE.md` for counts.

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
| Golden Thread ledger, replay, attestation | `[BUILT]` | `backend/src/goldenthread/` |
| Identity, RBAC/ABAC/scopes, MFA, token rotation | `[BUILT]` | `backend/src/identity/` |
| Enterprise → portfolio → programme → project → package | `[BUILT]` | `backend/src/domain/structure.ts` |
| Lifecycle phase gates | `[BUILT]` | `backend/src/lifecycle/phases.ts` |
| Seven engines | `[BUILT]` | `backend/src/engines/` |
| Procurement and tender workflow | `[BUILT]` | `backend/src/domain/procurement.ts` |
| ACU wallet, caps, alerts, attribution | `[BUILT]` | `backend/src/billing/acu.ts` |
| Subscription and invoicing | `[BUILT]` | `backend/src/billing/` |
| Offline field sync | `[BUILT]` | `backend/src/field/sync.ts` |
| Branded, hashed exports | `[BUILT]` | `backend/src/export/exporter.ts` |
| Gateway, rate limiting, validation, problem+json | `[BUILT]` | `backend/src/api/` |
| Conversational copilot | `[BUILT]` | `backend/src/ai/conversation.ts` |
| Command centre UI | `[BUILT]` (fifteen screens) / `[EXTEND]` (per role) | `frontend/pages/` |
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

### 7.6 New event types `[NEW — extends `backend/src/goldenthread/eventTypes.ts`]`

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
| **1 — Domain MVP** | Seven engines, lifecycle gates, procurement, offline sync, branded exports, fifteen-screen web application | **Complete** `[BUILT]` |
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

### 17.1 How a well-funded competitor attacks this

An incumbent with a large engineering team and an existing customer base does not
copy the ledger. They do three cheaper things:

1. **Ship "audit trail" as a feature and call it equivalent.** An append-only
   table with a timestamp column satisfies most procurement checklists. The
   difference — that the chain can be recomputed by a third party holding the log
   and that a document verifies without the vendor existing — is real and is a
   sentence long, and a sentence is what has to win the meeting.
2. **Bundle.** Give the record away inside a suite the customer already pays for.
   Nothing here can outprice a free feature attached to a system already deployed.
3. **Wait.** The value is back-loaded, so a competitor can watch which customers
   have a dispute and approach the rest.

The answers are: a beachhead where the evidentiary argument is not optional, a
demonstration a prospect can run themselves in ten minutes, and reference
customers who have been through an adjudication with it. Two of the three are
built; the third cannot be built.

### 17.2 What the moat does not cover

- **It is not a moat on day one.** A customer three weeks in has a record worth
  little more than a folder. The moat accrues; it does not arrive.
- **It does not stop a customer leaving.** By design — the record exports whole,
  verifies without us, and the log replays wherever it is held. That is the
  reason to trust the platform and it is also the reason nobody is locked in. It
  is a deliberate trade of retention for credibility.
- **It is not a patent, a dataset or a network effect.** Nothing here gets better
  because another customer joined. The cross-company benchmark is the one
  exception and it is deliberately k-anonymous, consented and refusable, which
  caps how much of a network effect it can ever be.

**The defensible position.** Features are copyable. A thirty-year, cryptographically
verifiable record of how an asset came to exist is not — because it cannot be
back-filled. Every month a project runs on CONSTRUX, the cost of leaving rises,
and the value of the record to owners, insurers and regulators compounds.

---

## 18. Agent depth, autonomy and the automation boundary

> **Where this section came from.** An external assessment of how deep AI agents
> can genuinely go across end-to-end construction and project management. It is
> merged here rather than filed separately, and every claim in it is annotated
> against what this repository actually contains. Where the assessment proposes
> something CONSTRUX already has, the mechanism is named. Where it proposes
> something CONSTRUX does not have, it is marked `[NEW]` and is not claimed.
> Counts in this section were measured from the repository, not estimated.

### 18.1 The conclusion, and why it is not "an AI project manager"

AI agents can become exceptionally deep across end-to-end construction and
project management — but they should not be designed as digital assistants that
answer questions and draft documents.

The strongest model is an **agentic project operating system** in which
specialist agents continuously: understand the contract and the employer's
requirements; structure the scope; develop and challenge the bid; create the
baseline; monitor live delivery evidence; detect deviation; quantify time, cost,
risk and contractual consequence; initiate controlled workflows; produce
decision-ready recommendations; and learn from the final outcome.

The critical distinction is one line:

> **AI may perform most of the information work. Accountable people must retain
> control of irreversible decisions.**

That is not an aspiration here. It is enforced in three independent places, and
each of them is tested:

| The rule | Where it lives | Measured today |
|---|---|---|
| A governance act may not be performed by a machine | `aiAllowed: false` on the event type, `backend/src/goldenthread/eventTypes.ts` | **646 of 766** event types refuse an AI actor outright |
| An agent may not act unattended beyond its declared ceiling | `mandate.maxUnattended`, `backend/src/agents/registry.ts` | **70** agents stop at OBSERVE, **9** at PROPOSE, **2** are ACT-*eligible* |
| ACT-eligibility confers nothing until a human grants a bounded envelope | `backend/src/agents/mandate.ts` | Grants are command-listed, value-capped and time-bounded; `MAX_ENVELOPE_DAYS = 366` |

`[BUILT]`

### 18.2 Six depths of construction AI, and where CONSTRUX sits

| Level | AI behaviour | Construction example | CONSTRUX |
|---|---|---|---|
| 1. Retrieval | Finds and explains information | "Show all clauses governing delay notices" | `[BUILT]` — clause register, obligation calendar |
| 2. Production | Creates a requested output | Draft method statement, programme narrative, tender response | `[BUILT]` — document engine, bid response pipeline |
| 3. Analysis | Compares evidence and identifies issues | Discrepancy between BoQ, drawings and specification | `[BUILT]` — scope-to-price reconciliation, cross-consistency validation |
| 4. Workflow execution | Performs several controlled actions | Create RFI, assign owner, set deadline, monitor response | `[BUILT]` — agent findings raise proposals with owners and deadlines |
| 5. Autonomous coordination | Pursues an objective across systems | Investigate slippage, obtain evidence, propose recovery | `[BUILT in part]` — the morning briefing coordinates across engines; external systems are `[NEW]` (§8 connectors) |
| 6. Governed operational autonomy | Executes approved low-risk decisions | Issue reminders, update forecasts, release approved information | `[BUILT — narrow]` — 2 of 81 agents are ACT-eligible, and only inside a granted envelope |

Most construction software sits between levels 1 and 2. CONSTRUX operates
routinely at 3 and 4, selectively at 5, and uses 6 only for tightly bounded,
reversible actions. That last sentence is a design commitment, not a limit
waiting to be lifted: **autonomy increases through demonstrated reliability, not
by making the model more verbally confident.**

#### The real ceiling

An agent can become extremely good at reading, cross-referencing, calculating,
monitoring, checking completeness, tracing causation, drafting, forecasting,
coordinating, escalating and preserving evidence.

It remains fundamentally limited where success requires physical inspection that
has not been digitally captured, professional engineering judgement, subjective
negotiation, leadership under uncertainty, statutory appointment, acceptance of
legal liability, safety-critical intervention, commercial authority to commit
money, or the signing of certificates and binding contractual communications.

Under CDM 2015 the principal contractor must possess the necessary skills,
knowledge, experience and organisational capability, and must plan, manage,
monitor and coordinate the construction phase. An AI system can support those
duties. It cannot inherit the statutory appointment or the accountability that
comes with it. ([HSE — principal contractors](https://www.hse.gov.uk/construction/cdm/2015/principal-contractors.htm))

This is why `PRINCIPAL_CONTRACTOR_APPOINTED`, `HANDOVER_ACCEPTED`,
`PAYMENT_CERTIFIED`, `VARIATION_APPROVED`, `NCR_CLOSED`, `GATE_DECIDED` and
`USER_ROLE_ASSIGNED` are all `aiAllowed: false`, and why a grant naming one of
them is refused at grant time as well as at commit time.

### 18.3 Realistic automation, stated as a range and not a promise

With high-quality integrations and disciplined project data, agents could
realistically automate or materially accelerate:

| Work | Realistic range |
|---|---|
| Tender administration and first-draft production | 75–90% |
| Routine project-control work | 60–80% |
| Commercial administration | 50–70% |
| Reporting, evidence classification and document control | 60–85% |
| Planning analysis and recovery-option development | 40–60% |
| Safety administration — **not** safety accountability | 20–40% |
| Final commercial, contractual, technical and safety decisions | 10–30% |

The achievable destination is roughly **70–85% automation of project information
work** — not 70–85% removal of project professionals. The human organisation
becomes smaller, faster and more accountable; people move from chasing
information and compiling reports toward judgement, leadership, negotiation,
assurance and authorised decisions.

**How CONSTRUX may quote these numbers.** It may not, yet, except as a range
labelled as an estimate. The platform already computes a real automation
measure — `automationMeasure` in `backend/src/domain/etablix/commandcentre.ts`,
classifying every activity as A (autonomous), B (assisted) or C (human), with a
catalogue-level test that fails the build if an event is added without a class
so it cannot quietly fall out of the denominator. That measure is scoped to the
Site Services module. **A platform-wide equivalent is `[NEW]`.** Until it
exists, the table above is an estimate and is presented as one, because a
percentage without a denominator is the failure mode that turns an automation
metric into marketing.

### 18.4 End-to-end agent coverage, stage by stage

#### Stage 1 — Opportunity discovery and bid/no-bid `[BUILT]`

Monitor portals, frameworks and target clients; classify by geography, sector,
value, scope and contract; compare against capability; examine previous wins,
losses and margins; identify pass/fail criteria; assess capacity and conflicting
commitments; identify partners required; estimate bid cost and probability of
winning; recommend.

The score must not be "likelihood of winning" alone. A dangerous project may be
winnable and commercially undesirable:

```
Expected bid value
  = P(win) × risk-adjusted contribution
  − bid cost
  − capacity opportunity cost
```

Output: pursue, pursue conditionally, partner, seek clarification, or decline —
each showing evidence, assumptions, unresolved risks and a sensitivity range.
The ten-factor bid/no-bid algorithm and the tender radar carry this.

#### Stage 2 — Tender ingestion and requirement decomposition `[BUILT]`

Not a PDF summary — a structured tender model over instructions to tenderers,
employer's requirements, specifications, drawings and revisions, BoQ and
schedules, contract conditions and amendments, programme constraints, site
information, surveys, pricing templates, quality questions, social-value
requirements, bonds and insurance, and submission rules.

It produces a **Requirements Compliance Matrix**, which becomes the bid's
control spine: requirement, source (document, clause, page), classification,
mandatory status, owner, evidence required, status, conflict status, submission
destination, and extraction confidence.

The bid response pipeline plans one response section per deliverable that needs
prose off exactly this matrix, and refuses to issue a pack where a named
deliverable has no response or a stated deadline has no date.

#### Stage 3 — Scope intelligence and design coordination `[BUILT]`

Decompose the employer's requirements into systems, assets, work packages,
locations, disciplines, deliverables, temporary works, testing, interfaces,
exclusions and assumptions. Then compare drawing against drawing, drawing
against specification, specification against BoQ, BoQ against programme, design
requirement against proposed method, and site constraint against planned
resource.

Valuable findings look like: an item on the drawings and absent from the BoQ;
testing required by specification and missing from the programme; temporary
works assumed and not priced; access restrictions incompatible with the proposed
plant; a long-lead item scheduled after its required-on-site date; different
quantities across model, drawing and pricing schedule.

**The system must never silently resolve these.** Each becomes a clarification
question, a bid assumption, a pricing qualification, a design risk, a provisional
allowance or an interface responsibility — a record with an owner, not a
correction nobody sees.

#### Stage 4 — Estimating and commercial bid development `[BUILT]`

Quantities and rates from BoQ, BIM objects, drawings, historic projects,
supplier quotations, labour constants, plant outputs, location factors,
escalation, logistics, duration and risk allowance — preserving the anatomy of
every price:

```
Tender price = direct cost + preliminaries + temporary works
             + risk allowance + overhead + profit + tax
```

Every number carries lineage: source, date, currency, location, quantity basis,
productivity assumption, quotation validity, exclusions, escalation basis,
confidence and human approval.

**The agent must challenge the bid**, searching for double counting, missing
scope, arithmetic inconsistency, optimistic productivity, expired quotations,
insufficient supervision, mismatched currencies, unpriced interfaces,
misapplied mark-ups, cash-flow exposure, negative working-capital periods,
retention and bond cost, uncapped liability, delay damages and design-development
exposure. Then run the expected case, the optimistic case, the P80 risk case,
delayed mobilisation, supplier inflation, low productivity, acceleration and
client-payment delay.

#### Stage 5 — Contract and risk intelligence `[BUILT]`

The contract stops being a document and becomes an executable obligation model.
Each obligation is a controlled object: responsible party, trigger event,
required action, notice period, time bar, communication method, approval
requirement, evidence, consequence of non-compliance, current status.

Monitored events include late information, instructed change, restricted access,
differing site conditions, delayed possession, non-conforming work, employer
prevention, subcontractor default, force majeure and testing failure. On each,
the agent determines what happened, which evidence supports it, which clauses may
apply, whether notice is required, the deadline, the likely time and cost effect,
what evidence is still missing, and who must approve the communication.

It may draft a notice. Issuing one is `aiAllowed: false` and passes through an
authorised commercial gate.

#### Stage 6 — Programme generation and challenge `[BUILT]`

Generating a programme is the easy half. The deeper capability is
**interrogation**: open-ended activities, excessive constraints, missing
predecessors or successors, impossible sequencing, procurement disconnected from
installation, design disconnected from approval, inadequate commissioning logic,
hidden negative float, unrealistic calendars, resource over-allocation,
unsupported productivity and excessive critical-path sensitivity.

Modelled: baseline, tender programme, contract programme, look-ahead, update,
recovery programme, what-if scenarios and time-impact analysis.

#### Stage 7 — Tender production and submission control `[BUILT]`

The composer develops the executive summary, technical solution, methodology,
mobilisation, logistics, design management, procurement strategy, programme
narrative, quality plan, health and safety response, environmental and
social-value response, risk schedule, qualifications and assumptions,
organisation chart, responsibility matrix, case studies and CVs.

It must not simply generate persuasive text. Every claim needs a verified
evidence object behind it. "We achieved 98% on-time delivery" requires an
approved source before it may enter a submission.

Before submission, validate every mandatory field, filename convention, page and
word limit, file format, signature, pricing reconciliation, contradictory
answer, expired certificate, unapproved assumption, portal completeness and
upload confirmation. This is where AI prevents expensive administrative
disqualification.

### 18.5 From winning the bid to delivering it `[BUILT]`

The bid must not die as a collection of PDFs. On award, approved bid objects
convert directly into the delivery baseline:

| Bid object | Delivery object |
|---|---|
| Tender programme | Contract baseline programme |
| Bid risk | Live project risk |
| Price build-up | Cost budget and control account |
| Assumption | Validation or change trigger |
| Qualification | Contract reconciliation item |
| Supplier quotation | Procurement package |
| Method statement | Controlled delivery method |
| Employer requirement | Compliance obligation |
| Promised KPI | Performance commitment |
| Resource plan | Mobilisation demand |
| Cash-flow model | Project cash baseline |

This bid-to-delivery continuity is the strongest competitive advantage available
to CONSTRUX, and it is the one thing a competitor cannot back-fill. The UK
Construction Playbook treats assessment, procurement and delivery as connected
concerns for exactly this reason.
([UK Government Construction Playbook](https://www.gov.uk/government/publications/the-construction-playbook))

### 18.6 Live construction-stage agents

**Project controls** `[BUILT]` — continuously reconciles baseline against actual,
planned against earned, cost incurred against value earned, forecast against
budget, labour planned against deployed, quantities planned against installed,
procurement required against delivered, and risk allowance against exposure.
It raises an event when a tolerance is breached rather than waiting for the
monthly report.

**Field evidence** `[BUILT]` — turns diaries, voice notes, photographs, video,
delivery tickets, labour returns, weather records, inspection forms, geolocation
and timestamps into structured evidence connected to location, work package,
activity, asset, contractor, defect, progress quantity, delay event and payment
item. Drone data and equipment telemetry are `[NEW]`.

**Progress verification** `[BUILT in part]` — triangulates rather than trusting a
self-reported percentage:

```
Verified progress = f(installed quantity, visual evidence, inspection acceptance,
                      labour deployment, materials consumed, programme logic)
```

A contractor reporting 80% while inspections show 50%, material consumption
supports 55% and photographs support 60% should trigger a confidence-weighted
challenge. Productivity against baseline and design readiness are built; the
full six-input weighting is `[NEW]`.

**Change and variation** `[BUILT]` — detects potential change from instructions,
RFIs, drawing revisions and site events; compares revised scope against the
contractual baseline; identifies affected quantities and activities; reserves
rights; opens a change record; requests missing substantiation; estimates time
and cost consequence; monitors quotation and determination deadlines; and
updates the forecast only after defined approval.

**Payment** `[BUILT]` — ingests applications, compares claimed work against
verified progress, validates rates, checks materials on and off site, applies
retention, reconciles previous certificates, identifies disputed items, drafts
the assessment and forecasts cash. Certification stays with the authorised
professional; the payment cycle refuses over-certification, double certification
and overpayment at the domain level.

**Procurement** `[BUILT]` — generates package scope, identifies qualified
suppliers, issues controlled enquiries, compares bids like for like, detects
exclusions, normalises currencies and commercial terms, analyses capacity and
risk, prepares the recommendation and tracks design, manufacture, inspection,
shipping and delivery. Appointment and contractual commitment stay
approval-gated.

**Safety and compliance** `[BUILT]` — reviews RAMS completeness, monitors permit
expiry, identifies training gaps, detects recurring observations, cross-checks
method statements against planned activities, escalates missing inspections and
prepares briefings. Hazard detection from photographs is `[NEW]`.

> It must never be marketed as replacing competent safety professionals or
> direct site supervision. Closing a safety-critical defect is `aiAllowed:
> false`, and no envelope may cover it.

### 18.7 Commissioning, handover and O&M `[BUILT]`

Handover control begins at mobilisation, not at practical completion. For every
asset and system: required submittals, design approval, installation evidence,
inspection, testing, commissioning, defect closure, training, certification,
warranty, spare parts, operating procedure, asset data and final model status —
with a live completeness score that forecasts whether handover will fail before
the contractual date.

After completion the same project knowledge becomes the operational asset twin:
warranty monitoring, maintenance scheduling, failure prediction, document
retrieval, energy-performance comparison, defect trends, lifecycle-cost
forecasting and replacement planning. This is how concept-through-thirty-year
O&M is covered credibly rather than by adding an O&M chatbot.

### 18.8 The agent organisation

Not dozens of independent agents competing with one another. Seven domain
engines with controlled sub-agents, which is what
`backend/src/agents/registry.ts` holds today — **81 agents across nine
divisions**, each declaring its capability area, memory access, ACU tier,
human-in-the-loop mode and mandate ceiling:

1. **Tender and commercial** — opportunity, compliance, estimating, bid
   composer, submission control
2. **Planning and delivery** — programme, progress, recovery, constraint
3. **Resource and cost** — resource, cost, cash-flow, productivity
4. **Risk, safety and compliance** — risk, safety assurance, regulatory, audit
5. **BIM and digital twin** — model validation, quantity, asset, spatial
   coordination
6. **Contracts and claims** — obligation, notice, change, entitlement and quantum
7. **Handover and O&M** — commissioning, handover, asset information, lifecycle

Above them sits one executive orchestrator — `morningBriefing` in
`backend/src/agents/briefing.ts`. It does not replace the project director. It
consolidates the project position, resolves routine cross-engine coordination
and presents the decisions that need human authority.

### 18.9 What makes an agent deep rather than superficial

Nine foundations, each with its status here measured rather than asserted:

| # | Foundation | Status |
|---|---|---|
| 1 | **Structured project state** — organisations, people, contracts, clauses, projects, locations, assets, packages, activities, costs, risks, documents, communications, decisions, approvals | `[BUILT]` — **344 entity types**. Without this, AI is only searching documents |
| 2 | **Event spine** — every significant action an immutable event, giving causation, chronology and auditability | `[BUILT]` — **766 event types**, hash-chained, one write path |
| 3 | **Temporal reasoning** — what was known, when it became known, which revision was current, what decision used it, what changed after | `[BUILT]` — a chatbot that always reads the latest file destroys the historic position a claim depends on |
| 4 | **Provenance** — verified fact, extracted fact, calculation, assumption, prediction, recommendation and human decision kept distinct | `[BUILT]` — a finding that cannot name its source is an opinion, and opinions are not stored as facts |
| 5 | **Contract awareness** — reasoning within the project's actual contract, not generic construction knowledge | `[BUILT]` — the same site event produces different rights, processes and time bars under different forms and bespoke amendments |
| 6 | **Tool execution** — document management, CDE, BIM, estimating, scheduling, ERP, accounting, procurement, email, workflow, field applications, sensors | `[BUILT in part]` — internal engines and the field application are live; the external connector ecosystem is `[NEW]` (§8) |
| 7 | **Memory** — project facts, organisational policy, approved lessons, user preference, working context, kept apart | `[BUILT]` — three layers, `PROJECT`, `ORGANISATION`, `ASSET`, with read and write declared separately per agent. The estimating agent reads the rate library and does not edit it |
| 8 | **Evaluation** — tested against a specialist benchmark | `[BUILT]` — the gold set grades only what has a right answer fixed by statute, standard or arithmetic, and the harness refuses to score judgement rather than printing a number nobody can check |
| 9 | **Permission and approval control** — authority depending on action type, value, contractual consequence, safety consequence, reversibility, confidence, role and stage | `[BUILT]` — permission matrix, ABAC attributes, phase gates, mandate ceilings and envelope grants |

**Unverified AI output must never become institutional truth automatically.** An
agent writing organisation memory is changing what every future project on every
other job will be told, which is why write access is declared per layer and per
agent rather than assumed.

### 18.10 The autonomy model

| Action class | AI authority | Enforced by |
|---|---|---|
| Read, extract, organise | Autonomous | Capability area read codes |
| Calculate using approved rules | Autonomous with audit log | Engine arithmetic; the model does not overwrite it |
| Draft documents | Autonomous drafting | Draft state; nothing issued |
| Send routine reminders | Autonomous within policy | Alert routing |
| Create internal workflow records | Autonomous | `aiAllowed: true` events |
| Update unapproved forecast | Permitted and clearly labelled | AI authorship marked on the record |
| Issue RFI | Human approval initially; conditional autonomy later | Proposal queue, then an envelope |
| Issue contractual notice | Authorised human approval | `aiAllowed: false` |
| Approve variation | Human only | `aiAllowed: false` |
| Commit supplier expenditure | Human only | `aiAllowed: false` |
| Certify payment | Human only | `aiAllowed: false` |
| Change approved baseline | Human only | `aiAllowed: false` |
| Approve design or temporary works | Competent authorised person only | `aiAllowed: false` |
| Close safety-critical defect | Competent authorised person only | `aiAllowed: false` |
| Stop work | AI may urgently recommend and escalate; formal authority follows site arrangements | Finding severity `URGENT` |

`[BUILT]`. The ladder is `OBSERVE → DRAFT → PROPOSE → ACT`, and only the last
rung needs a mechanism, because only the last rung removes the human.
Revocation takes effect on the next tick: an act already executing completes and
is recorded. Claiming the platform can interrupt a command mid-write would be a
safety story that is not true, and a narrow true one is worth more.

### 18.11 Quality targets, measured operationally

Performance is measured by operational result, not by response quality.

**Bidding.** Mandatory-requirement recall above 99%; zero unapproved commercial
figures; zero unsupported corporate claims; 100% traceability for material
pricing assumptions; tender reconciliation variance inside a defined tolerance;
complete submission validation before upload.

**Delivery.** Notice-deadline recall above 99%; progress-forecast calibration by
package; early-warning precision; reduction in aged RFIs; reduction in
unrecorded change; reduction in payment-assessment cycle time; improved handover
completeness trajectory; measurable reduction in manual reporting hours.

**A lower-confidence agent must abstain and escalate rather than invent
certainty.** `confidenceFloor` is declared per agent and the finding is withheld
below it.

Status: the refusal behaviours are `[BUILT]`; the *published* target dashboard
against these figures is `[NEW]`, and no figure above is claimed as achieved.

### 18.12 The failure modes

The system fails if CONSTRUX relies on:

- one general-purpose agent;
- document chat without structured data;
- uncontrolled access to email and contractual communication;
- progress percentages entered without evidence;
- current documents without historic revision context;
- AI-generated estimates without source lineage;
- automatic learning from unverified project records;
- many agents with no common project state;
- confidence scores produced only by the model itself;
- promises of replacing project managers.

**The most dangerous error is not hallucinated prose. It is a plausible but
incorrect action entering the live contractual, commercial or safety process.**
That is the failure the closed event catalogue, the mandate ceiling and the
envelope grant exist to prevent, and it is why the injection case is the one the
evaluation harness was built for.

NIST's AI Risk Management Framework, and its generative-AI profile, put
trustworthiness into design, development, use and evaluation rather than into a
disclaimer. That governance thinking applies directly here, particularly for
critical infrastructure.
([NIST AI Risk Management Framework](https://www.nist.gov/itl/ai-risk-management-framework))

### 18.13 The assessment

CONSTRUX can become one of the deepest agentic construction platforms if it is
positioned as:

> **A contract-aware, evidence-driven, multi-agent operating system that controls
> the continuity between tender promise, delivery reality and asset
> performance.**

The differentiator is not "we have more AI agents". It is that:

- every tender requirement becomes a controlled obligation;
- every bid assumption becomes a monitored delivery condition;
- every price becomes a live cost-control basis;
- every programme commitment becomes measurable;
- every site event is connected to time, cost, risk and contract;
- every decision retains its source evidence and approval history;
- every installed asset becomes part of the operational digital twin.

| Area | Potential depth | Recommended autonomy |
|---|---|---|
| Opportunity qualification | Very high | High |
| Tender compliance | Very high | High |
| Bid drafting | Very high | Medium-high |
| Estimating | High | Medium |
| Contract analysis | High | Medium |
| Programme analysis | High | Medium |
| Procurement administration | High | Medium |
| Progress intelligence | High with field evidence | Medium |
| Change administration | Very high | Medium |
| Commercial approval | Moderate | Low |
| Safety administration | High | Low |
| Engineering approval | Supportive only | Very low |
| Handover control | Very high | High |
| O&M intelligence | Very high | Medium-high |

**AI agents perform the project-control labour. Competent humans exercise
project authority.**

### 18.14 What this section adds to the build queue

Everything above marked `[NEW]`, gathered so it is not mistaken for built:

1. **A platform-wide automation measure.** `automationMeasure` exists and is
   honest, and covers Site Services only. Extending the A/B/C classification
   across the whole event catalogue — with the same build-failing test that
   refuses an unclassified event — is what would let CONSTRUX quote an
   automation percentage at all.
2. **The external connector ecosystem** (§8). Internal engines and the field
   application are live; ERP, accounting, external CDE, email and sensor feeds
   are not.
3. **Six-input progress triangulation.** Productivity against baseline and design
   readiness are built. The confidence-weighted challenge across all six inputs
   is not.
4. **Drone data, equipment telemetry and photographic hazard detection.**
5. **A published quality-target dashboard** against §18.11, so recall and
   calibration are reported rather than asserted.

None of these blocks a paying customer. Each is a named gap rather than an
implied capability, which is the only way this document stays worth reading.

---

## Appendix — verifying the claims in this document

```bash
npm run demo    # full lifecycle, replay verification, deliberate tamper detection
npm test        # see docs/STATE.md
npm start       # gateway, landing page, application at /app, API at /v1/routes
```

Requirement-by-requirement mapping, including what is deliberately not built:
[`docs/traceability.md`](traceability.md).

The adversarial audit — sixteen attacks against a running server, what held, what
did not, and the GO/NO-GO verdict that follows from it:
[`docs/LAUNCH_AUDIT.md`](LAUNCH_AUDIT.md). Its conclusion is **GO for a
controlled pilot, NO-GO for general availability**, and the blocking item is the
storage layer rather than anything in this document.
