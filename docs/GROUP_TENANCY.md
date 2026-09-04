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

Group roles as specified. Company roles are the existing catalogue; `company_admin` = ENTERPRISE_ADMIN/OWNER, `company_finance` ≈ BILLING_ACU holders. **No viewer role exists**, so a new membership does not default to viewer: the administrator names the roles (`ROLES_REQUIRED` otherwise). Adding a bare viewer role would change the settled permission matrix; recorded rather than done.

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
- Hard limit: the wallet's monthly cap, set from the group by finance; at the cap AI is refused with the existing cap refusal and everything else continues. Queueing of AI jobs at the limit: not built.
- Statement: `GET /v1/groups/:id/statement?month=` — one section per cost centre (plan as charged plus list price, seats, ACU, documents, storage), group totals, invoiced vs tracked by charge mode, companies included. CSV per group or per company. It is a statement: nothing moves money, BitriPay is not integrated, `invoice_mode` is recorded on the billing account for the invoicing run that does not yet exist.
- Rate cards are recorded per cost centre and shown; they do not yet change prices.

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
