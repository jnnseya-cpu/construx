# Group & Company tenancy — how CONSTRUX implements GN-SPEC-TENANCY-001

CONSTRUX side only, as instructed. Wherever the specification says "both
products" or "VERYX", read CONSTRUX. The spec is the standard; this file
says, section by section, what is built, what is built differently and why,
and what is not built. `docs/STATE.md` carries the same in its running form.

## The one structural decision

**A Company is a tenancy.** That is the isolation boundary every read on this
platform already applies, and it is never shared between legal entities. The
**Group** sits above tenancies. It owns the billing account, holds one cost
centre per company, carries the group-level roles, and is where consolidated
figures are read. Nothing operational lives at group level.

The stack the spec assumes (NestJS, PostgreSQL with RLS, Kafka, LangGraph,
GCP, BitriPay) is not this platform's. CONSTRUX has zero runtime
dependencies, an in-process event-sourced ledger with a durable journal, and
Postgres designed for but not wired. The domain model, the entitlement
enforcement, the document contract and the consolidated billing are built
inside that architecture. The RLS policies and Kafka topics are recorded
below as the contract this platform would publish, not as things running.

## §2 Decisions

| Spec | Here |
|---|---|
| One tenant per legal entity under one Group | Built. `Tenant.groupId`; `Group.costCentres[]` one per tenancy; `GROUP_LICENCE.maxCompanies = 5` in `billing/seats.ts` |
| One licence; entitlements per company; usage metered per company; invoicing a commercial setting | Built. `CostCentre.chargeMode` INTERNAL / INTERCOMPANY / EXTERNAL; usage always metered |
| ETABLIX as a module entitlement of one company | Already built (`identity/modules.ts`); nothing inherited from the group, proven in `grouptenancy.test.ts` |
| Issuing company decides branding | Built. Exporter resolves the tenancy's brand; documents pin `issuer.companyId` and `profileVersion` |
| One user id across companies | Built differently: one **person** = one email; a **membership** is a user record in each company (the isolation boundary is made of those). `/v1/users/me` lists memberships; `/v1/auth/switch-company` moves between them. See §4 |

## §3 Domain model → where it lives

| Spec entity | Here |
|---|---|
| Group | `group/directory.ts` `Group` — ledger entity `Group`, tenancy = group id |
| Company | `Tenant` (+ `groupId`, `groupSlug`) |
| CompanyProfile (issuer, brand, numbering, signatories, versions) | `group/profile.ts` `IssuerProfile` — brand = the tenancy's `ClientBranding` (already versioned); issuer block, numbering rules, signatories; every version replayable from the chain |
| ProductWorkspace | Not built: one product. `entitlementsOf()` reports `product: 'construx'` |
| ModuleEntitlement | `ModuleGrant` (existing) |
| Membership / membership_roles | A `PlatformUser` per company, same email; roles per company (existing role catalogue) |
| GroupRole | `GroupRole` — GROUP_ADMIN, GROUP_FINANCE, GROUP_VIEWER, keyed by email |
| UsageAccount | The company wallet's caps (`monthlyMinor` = hard limit, alerts at 50/80/100) — `PUT /v1/groups/:id/companies/:tenantId/usage-account` |
| Integration | Existing per-tenancy API keys and webhooks. BitriPay merchant: not built |
| BillingAccount | `Group.billing` — currency, invoice mode, terms, payment customer reference (empty until a provider is integrated) |
| CostCentre | `Group.costCentres[]` — code, slug, charge mode, rate card |
| PlatformOperator | `PLATFORM_ADMIN` (existing, barred from delivery data by `abac.ts` and the gateway) |
| usage_events | Not a table: meters are **derived** from records that already exist (wallet debits, users, exports, evidence store) so there is one source of truth. `GET /v1/groups/:id/usage` |

## §4 Identity & sessions

- Single login, single MFA: the second factor is per user record, and the proof carries across a switch (`mfaSatisfied` is copied to the new session). A company requiring one still holds a session to enrolment if none is held.
- `/v1/auth/login` accepts `tenantId` to choose the company; otherwise the first active membership. The list of companies is **not** returned before the code is verified.
- `/v1/auth/switch-company` mints a new session for the other membership and revokes the old token. Nothing already running changes.
- A person with one membership never sees the other company exists (`grouptenancy.test.ts` "isolation").
- Group roles open the Group screen only. Operational access needs a membership — tested.
- Operator: no default read of any company record. Break-glass is `group/support.ts`: opened against a ticket with a reason, 5–240 minutes, recorded on the company's own chain, every read recorded, visible on Team & Access, closable by the company. What it opens is the governance record, read-only. **Not** OIDC: tokens are the platform's own HMAC tokens with a 15-minute TTL (`GATEWAY_AUTH_ACCESS_TTL_MINUTES`), which satisfies the §14 revocation target.

Token claims: `/v1/users/me` returns `entitlements` in the spec's claim form (`construx:plan:<package>`, `construx:module:<key>`). They are not embedded in the token; the gateway reads live state, which is stricter than a cached claim.

## §5 Entitlements

Three layers, all present: the gateway refuses module routes (`requireModule`, `MODULE_NOT_GRANTED` 403), engine contexts carry `grantedModules` and re-check, and the agent runtime loads only `runnableAgents(grantedModules)`. Revocation is immediate — same request. Product entitlement = the subscription package and standing. No inheritance from the group. `GET /v1/groups/:id/companies/:tenantId/entitlements`.

Not built: `PUT /companies/{id}/entitlements/{product}`; plans are changed by the operator through the existing package route; modules by the existing module grant. No `entitlement.changed` topic — see §11.

## §6 Roles

Group roles as specified. Company roles are the existing catalogue; `company_admin` = ENTERPRISE_ADMIN/OWNER, `company_finance` ≈ BILLING_ACU holders. **Viewer:** `VIEWER` — read on every area of the company's record, never platform administration, AI execution or billing; grantable by an administrator; priced at the lowest internal seat. Least privilege by default: a membership added with no roles named is a viewer (`POST /v1/users/memberships`).

## §7 Isolation

Every read is by tenancy already. The spec's table, mapped:

| Path | Here |
|---|---|
| PostgreSQL RLS | Not running (no database). The policy the schema would carry: `USING (tenant_id = current_setting('app.company_id')::uuid)` on every tenant table; the group reads use a separate reporting path that reads one tenancy at a time by id |
| Object storage | Evidence store is keyed by tenancy; signed URLs per object; no cross-tenancy listing |
| Search / vectors | The data layer filters by tenancy before ranking |
| Kafka | See §11 |
| Jobs / agents | Engine contexts carry the tenancy at creation; agents run under it |
| Caches | Keyed by tenancy where they exist |
| Audit | Every event carries `tenantId`; per-company export: `GET /v1/groups/:id/audit?tenantId=` (group admin) and the existing audit feed (company admin) |

§7.1 controlled sharing: `group/sharing.ts` — explicit per-record grant, read-only, expiring, revocable, same group only, owner's branding and "shared by" on the read. Deliberately a separate route (`/v1/shares/:id/record`), not a change to the generic entity read.

## §8 Branding & issuing company

- The tenancy's `ClientBranding` is the brand kit. `IssuerProfile` adds the registered issuer block, numbering rules and signatories; its version counts every change to any of them, brand included.
- Numbering: `POST /v1/documents/numbers/allocate` — one counter per (company, type, scope) on the chain; gapless and duplicate-free under concurrency (tested with 25 parallel requests).
- Exports pin `issuer: { companyId, profileVersion, documentType }` on the document and on the `Export` record; a report takes its reference from the company's `report` rule when one exists. A later profile change leaves the issued record unchanged — tested.
- §8.4 context pinning: exports are synchronous under the request's tenancy. AI jobs carry the tenancy in their engine context from creation. A switch mints a new session and cannot reach a context already created.
- Not built: the async `POST /documents/generate` job API (documents here are generated synchronously through the existing document routes); the `brand` schema's typography, letterhead templates and email domain fields; group-branded consolidated **report** documents (the statement JSON/CSV is group-branded and lists the companies included).

## §9 Billing & usage

- Meters per company from records: `acu` (wallet debits, raw and billed, by module), `seat` (active users), `document` (exports), `storage` (evidence bytes). `api_call` not metered.
- Dedicated pools by construction: one wallet per company. `group_shared` pool: not built.
- Hard limit: the wallet's monthly cap, set from the group by finance; at the cap AI is refused with the existing cap refusal and everything else continues. **Thresholds and the limit are told** (§9.3, `usage.threshold` / `usage.limit_reached`): the wallet signals 50 / 80 / 100 per cent once each per month and the limit once per scope, the platform records `ACU_ALERT_RAISED` / `ACU_CAP_BREACHED` on the company's chain, and `billing/usagealerts.ts` notifies the company's administrators and the group's finance and administrators (`acu.threshold`, `acu.limit_reached`). Queueing of AI jobs at the limit: not built — the specification's v1.0 successor refuses at the budget, which is what happens.
- Statement: `GET /v1/groups/:id/statement?month=` — one section per cost centre (plan as charged plus list price, seats, ACU, documents, storage), group totals, invoiced vs tracked by charge mode, companies included. CSV per group or per company. It is a statement: nothing moves money, BitriPay is not integrated, `invoice_mode` is recorded on the billing account for the invoicing run that does not yet exist.
- Rate cards **price the subscription**: the agreement version carries `rateCards` (a whole-percentage discount per card), the group approves it with the terms, `subscriptionPriceMinor()` prices every renewal and first month through the company's card, the allowance follows the amount paid, and the statement shows list and charged (§9.4).

## §10 API surface (this platform's paths)

| Spec | Here |
|---|---|
| GET /groups/{id}, /companies | `GET /v1/groups/:groupId` (directory) |
| POST /groups/{id}/companies | `POST /v1/admin/groups/:groupId/companies` (operator) |
| GET/PUT company profile, versions | `GET/PUT /v1/company/issuer`, `GET /v1/company/issuer/versions/:v` |
| POST /auth/switch-company, GET /users/me | Same paths under `/v1` |
| POST memberships | `POST /v1/users/memberships` |
| GET entitlements | `GET /v1/groups/:groupId/companies/:tenantId/entitlements` |
| POST /documents/numbers/allocate | `POST /v1/documents/numbers/allocate` |
| GET group usage, invoices | `GET /v1/groups/:groupId/usage`, `/statement`, `POST /statement/export` |
| PUT usage-account | `PUT /v1/groups/:groupId/companies/:tenantId/usage-account` |
| — | `POST /v1/admin/groups`, `PUT …/billing`, `PUT …/cost-centre`, `POST …/roles`; `POST /v1/groups/:id/roles`, `…/revoke`; `GET /v1/groups/:id/audit`; `/v1/shares…`; `/v1/admin/tenants/:id/support-access…`; `/v1/team/support-access…` |

## §11 Events

There is no Kafka. Every act here is an event on the Golden Thread ledger with `tenantId`, actor and correlation id, and the transactional outbox and webhook subscriptions already publish ledger events to subscribers. The spec's topics map to these event types:

| Topic | Ledger events |
|---|---|
| directory | `GROUP_CREATED`, `GROUP_UPDATED`, `TENANT_GROUPED`, `TENANT_CREATED`, `TENANT_CLOSED` |
| identity | `USER_CREATED`, `USER_ROLE_ASSIGNED`, `GROUP_ROLE_GRANTED`, `GROUP_ROLE_REVOKED` |
| entitlements | `MODULE_GRANT_*` (existing), `SUBSCRIPTION_PACKAGE_CHANGED` |
| branding | `ISSUER_PROFILE_UPDATED` (carries `version`), `CLIENT_BRANDING_SET` |
| documents | `DOCUMENT_NUMBER_ALLOCATED`, `EXPORT_GENERATED` (carries `issuer`) |
| usage | `ACU_*` wallet events, `ACU_CAPS_SET` |
| billing | `SUBSCRIPTION_CHARGE_*` (existing) |
| sharing / support | `RECORD_SHARED`, `RECORD_SHARE_REVOKED`, `SUPPORT_ACCESS_OPENED`, `SUPPORT_ACCESS_USED`, `SUPPORT_ACCESS_CLOSED` |

## §12 Rollout, as it applies here

1. Operator: Tenants & Users → Create a group → Bring a company in (twice) → Group role for the first group administrator.
2. Company administrators: Documents → set the issuer details and numbering rules; Team & Access → add people from the other company where one person works in both.
3. Operator: grant ETABLIX to ETABLIX Ltd (existing module grant).
4. Group finance: Group → set hard limits; export the month's statement in shadow before any invoicing.

## §13 Acceptance — `backend/tests/grouptenancy.test.ts`

Each criterion that reaches CONSTRUX has a test: isolation across companies; module refusal and same-request revocation; no inheritance; issuer brand, block and number on documents with immutability after a profile change; concurrent numbering; ACU attribution and dedicated pools; statement sections and per-company export; operator refused without break-glass, then logged; group dashboards publish figures only; per-company audit export. Not testable here: the async job that outlives a company switch (no async document job exists); VERYX.

## §14 Open items

1. One Postgres cluster or two: not applicable yet.
2. Token TTL: 15 minutes, in place.
3. ETABLIX agent tool list: the runtime already filters agents by module grant (`runnableAgents`).
4. ETABLIX RDC SARL: a third company, attached to the group as its own tenancy with its own cost centre, profile and numbering. Nothing about it is a sub-profile of ETABLIX Ltd.

---

# Part 2 — the Enterprise / Group specification v1.0 (4 September 2026)

The second specification ("CONSTRUX + VERYX Enterprise / Group account
specification", §1–§20, AT-01..AT-44) is implemented on top of Part 1 —
nothing above was removed or replaced. As before: CONSTRUX side only, and
wherever the specification says "both products" or VERYX, read CONSTRUX.
`backend/tests/enterprisegroup.test.ts` carries the acceptance tests by
their specification numbers.

## §1–§2 Binding decisions

| Decision | Here |
|---|---|
| One tenant per legal entity | Unchanged: a Company is a tenancy |
| One identity, explicit memberships | Unchanged: one address, one user record per company, `/v1/users/me` and `/v1/auth/switch-company` (= `GET /me/contexts`, `POST /session/context`) |
| One tenant id per product workspace | One product; `productCode: 'construx'` is carried on documents and subscription items |
| Two suite subscriptions under one agreement | `group/agreement.ts`: `Agreement` per group, versioned and effective-dated (mode, seller, payer, currency, cadence, pricing policy version; DRAFT → APPROVED → SUPERSEDED); each company's existing subscription read as line items (`tenantSubscriptionItems`: `construx.core` with its seats, plus every restricted module) |
| Configurable agreement mode, identical metering | `INTERNAL_COST_ALLOCATION` / `INVOICED_INTERCOMPANY` / `EXTERNAL_ENTERPRISE`; the cost centre's charge mode is the per-company allocation line class and defaults from the mode. Metering is the same code path in every mode (AT-43) |
| Separate wallets, no borrowing | Unchanged and tested (AT-23) |
| ETABLIX as a restricted module | Unchanged; the registry entry `MODULES.ETABLIX.registry` publishes the §7 shape (`construx.etablix.integrated_site_services`, restricted, `explicit_tenant_grant`, no self-activation). AT-17, AT-18 |
| Branding automatic from the bound issuer | Unchanged for reports; legal instruments freeze issuer, brand and source version into a manifest (§8) |
| Parent ownership grants nothing implicit | Unchanged; reporting is by grant (§12) |
| Transfers preserve identity and history | `group/transfer.ts` and `Group.history` (§16.3) |

## §4 Data model → where it lives

| Spec | Here |
|---|---|
| LegalProfileVersion (verification state; immutable once used) | `IssuerProfile.legal` — UNVERIFIED / DECLARED / VERIFIED; a change to the issuer block re-declares; `POST /v1/admin/tenants/:id/issuer/verify` (operator) makes a VERIFIED version; every version is immutable on the chain; `legalReadiness()` names what is missing |
| GroupTenantRelation (effective-dated, one primary) | `Group.costCentres[]` (current) + `Group.history[]` (left, with `leftAt`); `Tenant.groupId` is the one primary group; the statement is effective-dated over both |
| UserIdentity | Not built: no external identity providers; the platform is the single identity authority, and nothing is merged on email — a second company is an explicit membership |
| Agreement / TenantSubscription / SubscriptionItem | `Agreement`; the existing `Subscription`; `tenantSubscriptionItems()` |
| EntitlementGrant / ModuleDefinition | Existing module grants; registry entry on `MODULES` |
| TenantWallet / LedgerTransaction / UsageReservation / UsageRecord | The existing `ACUWallet`: holds are reservations, debits are usage records with tenant, project, person, module, feature, provider and multiplier. Added: replay-safe settlement and a per-person budget (`ACUCaps.perUserMinor`) |
| BudgetLimit | `ACUCaps`: monthly, per project, per module, per person |
| BrandProfileVersion / TemplateVersion | The brand is versioned through the issuer profile (Part 1); `templateVersion: 1` is recorded on every manifest — there is one template per document type in this build |
| NumberSeries | `DocumentSequence` (Part 1) |
| Document / DocumentRevision / Issuance | `group/issuance.ts`: `Document` (status, revisions with hashed manifests, approvals bound to a hash), `Issuance` (PENDING → ISSUED, or VOID; idempotency key; attempts; render hash; stored flag) |
| CrossTenantShare (acceptance, field scopes, export right) | `RecordShare` gains `status` PENDING → ACCEPTED, `fields`, `exportAllowed`; `POST /v1/shares/:id/accept` |
| ReportingGrant | `group/reporting.ts` `ReportingGrant` on the company's chain: metrics, roles, period, export right, expiry, revision |
| TransferCase | `group/transfer.ts` on the platform tenancy: DRAFT → REVIEW → SCHEDULED → EXECUTING → COMPLETED, FAILED, CANCELLED |
| OutboxEvent / InboxReceipt | The existing transactional outbox and webhook subscriptions over ledger events |
| IntegrationConnection / ExternalObjectMap / ProductWorkspace | Not built: one product, no legacy organisation ids to map |

## §5–§6 Identity, context, isolation

Unchanged from Part 1. The gateway derives the tenancy from the session, never from a header or a body; every read here checks the record's tenancy and answers a foreign id as no record (AT-05, AT-16, AT-30 are tested through the new routes too). Roles: the spec's Group Owner / Billing Admin / Analyst are GROUP_ADMIN / GROUP_FINANCE / GROUP_VIEWER; Tenant Admin is ENTERPRISE_ADMIN; `documents.approve` is held by a named signatory or, where none is named for the type, a company administrator; `documents.generate` / `documents.issue` by anybody who may take a document out of the company (EVIDENCE_AUDIT I).

## §7 Entitlements — unchanged plus the registry entry. **Scheduled and expiring entitlements are built:** a grant carries `validFrom` / `validTo`; `grantLifecycle()` reads SCHEDULED, ACTIVE, EXPIRED or REVOKED against the clock; `grantedModules()` holds only what is live; the entitlement read lists live and pending grants; the operator's decision has the dates. Revocation is immediate.

## §8 Documents

- **Lifecycle** `POST /v1/documents/lifecycle` (draft) → `/generate` (frozen, hashed manifest: body, issuer block and profile version, brand, template version, locale, source record version) → `/submit` → `/approve` (revision + hash; `VERSION_CONFLICT` otherwise; signatory or administrator) → `/issue` → `/download`. `/reject` returns to draft with the reason on the revision.
- **Approval policy** per document type: quotation, invoice, contract, certificate need approval; report, notice, letter go from generated to issued; overridable on the profile (`documentPolicies`), itself a recorded version.
- **Issuance** reserves the number and a PENDING issuance first (idempotency key, tenant-scoped), renders against the frozen manifest, then marks ISSUED. A failed render leaves the pending issuance and number for the retry (`ISSUANCE_RENDER_FAILED` 503, attempts counted); the same key after success replays; a different key on an issued document is `DOCUMENT_ISSUED`; the same key on another document is `IDEMPOTENCY_CONFLICT`. A pending issuance can be voided; its number stays recorded and is never reused. AT-13, AT-14 tested.
- **Readiness** `LEGAL_PROFILE_INCOMPLETE` (422) until the registered issuer block is complete; `ISSUER_PROFILE_CHANGED` when the profile moved since generation — regenerate and re-approve, so what was approved is exactly what goes out. A removed signatory invalidates the approval (AT-15).
- **Immutability** an issued document cannot be regenerated; a correction is a new document with `supersedes`. Issued bytes are kept in the evidence store where one is configured; otherwise the download re-renders the frozen manifest and says so (AT-11).
- Not built: the asynchronous document-job API with ACU reservation (rendering is synchronous and local, and charges nothing); DOCX for legal instruments (PDF only); group-branded management reports as documents.

## §9 Billing

- `PUT /v1/admin/groups/:id/agreement` (operator, draft) → `POST /v1/groups/:id/agreement/:version/approve` (group admin or finance). `GET /v1/groups/:id/billing`: the version in force, subscriptions as line items, seats used and distinct people (AT-27), and `invoicing`: one invoice only where seller, payer, currency and period agree; otherwise separate invoices plus the consolidated statement, with the reasons named (AT-28, AT-29). Internal-allocation companies are listed as allocation-only.
- Seats: `SEAT_LIMIT_REACHED` on activation is the existing rule (AT-26).
- Subscription states: ACTIVE / SUSPENDED / CANCELLED, plus `AWAITING_PAYMENT` (a paid package before its first month is paid) and `past_due` derived (`collection.pastDue()`: a period due and unpaid while its grace runs, on `GET /v1/billing/subscription` and the billing screen). Payment adapter: Stripe Checkout settles top-ups and subscription charges; refunds and disputes are read and recorded (§10). Not built: the invoicing run (the statement moves no money); proration.

## §10 Wallets

- Holds are reservations against available balance, never negative; `settle` charges once and a replayed settlement returns the same entry without moving the balance; `release` after settle is a no-op (commit and release are mutually exclusive). The §10.3 arithmetic is `enterprisegroup.test.ts` AT-20/21 (100 → 70 held, 40 refused, 55 settled → 45 available, 0 held, 55 consumed, replay unchanged).
- Budgets: monthly, per project, per module and — new — per person (`perUserMinor`, set on Billing).
- **reconciliation_required (AT-22):** a remote call that times out after it left (`AI_PROVIDER_TIMEOUT`) parks its hold — neither released nor charged — and the execution is `UNRESOLVED` until the operator reconciles it with evidence (`GET /v1/admin/ai/unreconciled`, `POST /v1/admin/ai/executions/:id/reconcile`: charge the call's cost or release; once; a replayed settlement moves nothing). Worker leases are not needed: AI runs in-process and synchronously.
- **Refunds, chargebacks and disputed funding (AT-25):** Stripe `charge.refunded` (running total) and `charge.dispute.created` are recorded as explicit `PaymentReversal`s against the receipt; what is still available is debited, what was consumed is a `PaymentException` with the shortfall; a dispute freezes the wallet (`WALLET_FROZEN` on reserve, everything else continues, survives a restart) until the operator lifts it with a reason; the operator records reversals by hand and resolves exceptions; Tenants & Users carries the card.
- **Group money funding wallets (§10.1):** `POST /v1/admin/groups/:id/credit` records one payment with explicit allocations totalling exactly the amount, each company credited as its own receipt under `<reference>/<code>`.
- Not built: micro-ACU denomination (1 ACU = 1 minor unit is a settled decision), credit lots and cross-tenant credit transfer (disabled by default in the spec; absent here).

## §11 Events

Unchanged: every act is a ledger event with tenant, actor and correlation id, published through the outbox. The new event codes are the `document.*`, `subscription.changed`, `reporting_grant.changed` and `tenant.group_changed` topics: `DOCUMENT_*`, `ISSUANCE_*`, `AGREEMENT_*`, `REPORTING_GRANT_*`, `GROUP_REPORT_GENERATED`, `TRANSFER_CASE_*`, `RECORD_SHARE_ACCEPTED`.

## §12 Collaboration and reporting

- Shares are proposed by the owner and accepted by the recipient; a share names fields or the whole record; the read projects the named fields only (AT-32); revocation ends the read on the next request (AT-33).
- Reporting grants: `POST /v1/company/reporting-grants` (company administrator) names metrics (`projects.count`, `projects.contract_value`, `people.active`, `documents.issued`, `acu.billed`, `events.governance`), group roles, period, export right, expiry. `POST /v1/groups/:id/reports` reads each company by id under its live grant, names withheld metrics and ungranted companies (never a zero), totals per currency without conversion (AT-31, AT-36); `GET …/reports/:id` rechecks every grant and withholds a section whose grant has since ended (AT-33).
- Not built: cross-tenant writes; intercompany elimination rules; FX conversion (policy is recorded as `ORIGINAL_CURRENCY_NO_CONVERSION`).

## §13 API

The spec's `/enterprise/v1` catalogue is served under this platform's `/v1` with the same semantics; the OpenAPI document the gateway already publishes covers every route. Error codes used as named: `VERSION_CONFLICT`, `IDEMPOTENCY_CONFLICT`, `SEAT_LIMIT_REACHED`, `DOCUMENT_NOT_APPROVED`, `LEGAL_PROFILE_INCOMPLETE`; `ACU_INSUFFICIENT` / `BUDGET_LIMIT_REACHED` are the existing `ACU_EXHAUSTED` (402) with the reason in the message; `RESOURCE_NOT_FOUND` is the existing 404. Errors are RFC 7807 with `x-correlation-id`, not the spec's `{ error: {...} }` envelope.

## §14 UI

| Spec route | Here |
|---|---|
| Account switcher | The console header (Part 1) |
| /enterprise/{group}/overview, companies, people | Group screen: directory, usage, roles (Part 1) |
| /enterprise/{group}/billing | Group screen: Agreement and subscriptions card (approve a draft; line items; seats and distinct people; invoice grouping) |
| /enterprise/{group}/reports | Group screen: Run a report; Reports card; a report opens with granted values and withheld markers |
| /company/settings/identity | Documents: issuer card with legal readiness and verification state |
| /company/settings/branding | Documents (Part 1) plus the approval policy |
| /company/settings/people | Team & Access (Part 1) plus group reporting grants and transfer approval |
| /company/settings/modules | Billing: subscription line items (product and restricted modules) |
| /company/settings/usage | Billing: caps now include a personal budget |
| /company/settings/audit | Audit feed (existing) |
| Document preview/issue | Documents: Legal documents card — status, revision, approval, issue action, resulting number, download, supersede, void |
| Operator | Tenants & Users: Onboard a group; per group Agreement; per company Readiness, Verify issuer, Transfer; Transfer cases card |

## §15 Onboarding

`POST /v1/admin/groups/onboard` is one idempotent act (AT-01, AT-44): group by slug, agreement once as a draft, company by cost-centre code, administrator by address, first group administrator once. Re-running creates nothing twice. Three readiness lights — operational, billing, issuance — are read from what exists (`GET /v1/company/readiness`, `GET /v1/admin/tenants/:id/readiness`) and nothing is guessed to make one green. The Groupe Nseya fixture is what the operator types in; no customer name is in the code. Not built: a seed script for the fixture (the operator's onboarding act is the fixture).

**Self-serve, added after v1.0.** A group can be founded at signup — `POST /v1/signup` with `structure: 'GROUP'` founds the group on verification with the organisation as its first company and the signer as `GROUP_ADMIN` — and its administrator extends it without the operator: `POST /v1/groups/:id/companies` creates a company on a paid self-serve package with one to five administrators named and invited (an address already in the group becomes a second membership; one held outside is refused; the sixth company is refused by the licence), and `POST /v1/groups/:id/companies/:tenantId/administrators` names a further administrator. Each company waits for its first month like any signup; the directory carries what each owes and the reference to settle against. The operator's onboarding act is unchanged for a group whose terms are agreed rather than self-served. `tests/groupsignup.test.ts`.

## §16 Transfer

`POST /v1/admin/tenants/:id/transfer-cases` (draft) → `/review` (destination checked) → company administrator approves on Team & Access → `/schedule` (effective date) → `/execute` (once due): the destination is checked again before anything moves; the old group's reporting grants, shares with its companies and group roles held only through this company end; the company leaves (history entry with `leftAt`) and joins the new group. A failed check fails the case before any change; the company is in one group at most and never two (AT-37, AT-38). Wallet credits, issued documents and the tenancy id do not move. Not built: migration of legacy data (there is none), closure retention workflows beyond the existing tenancy closure.

## §17 Targets

Live authority: every read here checks the grant, share or membership on the request; tokens are 15-minute. **Metrics (§17):** `GET /v1/admin/watch` carries `operational` — authorisation denials by reason, unreconciled provider outcomes and the oldest, open reservations and the oldest, frozen wallets, open payment exceptions, issuance failures pending retry, webhook signature failures, ledger state-hash discrepancies — counted from the record and shown on Risk & alerts. Not measured: the latency targets (no load rig here; recorded as unmeasured rather than met).

## §18 Acceptance — `backend/tests/enterprisegroup.test.ts`

Tested by number: AT-01, 02, 11, 13, 14, 15, 16, 17, 18, 20, 21, 23, 26, 27, 28, 29, 30, 31, 32, 33, 36, 37, 38, 43, 44, plus a restart replay (AT-42 as far as the ledger goes). Covered by Part 1 tests: AT-03, 05, 10. AT-22 (unknown completion held for reconciliation; a stale settlement moves nothing) and AT-25 (refund and chargeback as immutable adjustment and exception, no sibling charge) in `groupspec2.test.ts`; AT-24 (duplicate webhook, forged success) in `stripe.test.ts`. Not applicable on one synchronous product with no external identity provider or worker: AT-04, 06, 07, 08, 09, 12, 19, 34, 35, 39, 40, 41.
