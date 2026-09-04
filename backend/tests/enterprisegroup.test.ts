import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { rateLimiter } from '../src/api/middleware.ts';
import { Platform, type PlatformUser } from '../src/platform.ts';
import * as structure from '../src/domain/structure.ts';
import { authOf } from '../src/seed.ts';
import { ACUWallet } from '../src/billing/acu.ts';
import { issueDocument } from '../src/group/issuance.ts';
import { MODULES } from '../src/identity/modules.ts';

/**
 * The Enterprise / Group specification v1.0 (4 September 2026), §18 — the
 * acceptance tests as far as they reach CONSTRUX, numbered as the
 * specification numbers them. Three companies: two in a group, one outside
 * it with a similar name, so nothing here can pass by matching a name.
 */

let platform: Platform;
let server: Server;
let base: string;
let operator: PlatformUser;
let etablix: { tenantId: string; admin: PlatformUser; qs: PlatformUser; projectId: string };
let jn: { tenantId: string; admin: PlatformUser; projectId: string };
let outsider: { tenantId: string; admin: PlatformUser };
let groupId: string;

function tokenFor(user: PlatformUser): string {
  const auth = authOf(platform, user.id);
  return issueTokens({ actorId: auth.actorId, tenantId: auth.tenantId, partyId: auth.partyId, roles: auth.roles, mfaSatisfied: true }).accessToken;
}

async function send(method: string, path: string, token: string | null, payload?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body, headers: response.headers };
}

function company(legalName: string, adminEmail: string, currency = 'GBP') {
  const created = platform.createTenant({ legalName, jurisdiction: 'GB', defaultCurrency: currency, tier: 'ENTERPRISE', package: 'ENTERPRISE', enterpriseName: legalName });
  const admin = platform.createUser({ tenantId: created.tenant.id, name: `${legalName} admin`, email: adminEmail, roles: ['ENTERPRISE_ADMIN'] });
  return { tenantId: created.tenant.id, enterpriseId: created.tenant.enterpriseId!, admin };
}

function projectIn(tenantId: string, enterpriseId: string, admin: PlatformUser, name: string): string {
  const gov = platform.context(authOf(platform, admin.id), `${tenantId}-governance`);
  const { portfolioId } = structure.createPortfolio(gov, { name: `${name} portfolio`, enterpriseId, governanceModel: 'CENTRALISED', continentCode: 'EU' });
  return structure.createProject(gov, {
    portfolioId,
    name,
    sectorType: 'UTILITIES',
    assetType: 'Fixture',
    location: { continentCode: 'EU', countryCode: 'GB', city: 'Manchester' },
    contractValueMinor: 80_000_000,
    currency: 'GBP',
    plannedStart: '2026-10-01',
    plannedCompletion: '2027-06-30',
  }).projectId;
}

const issuerBlock = {
  registeredName: 'ETABLIX LTD',
  tradingName: 'ETABLIX',
  registrationNo: '12345678',
  registeredAddress: { line1: '1 Site Street', city: 'London', postcode: 'EC1A 1AA', country: 'GB' },
  footerLegalText: 'ETABLIX LTD, registered in England & Wales No. 12345678',
};

before(async () => {
  platform = new Platform();
  operator = platform.createOperator({ name: 'Ruth Okafor', email: 'ops@construx.example' });
  const e = company('ETABLIX Ltd', 'rowan@etablix.example');
  const j = company('JN Construction Ltd', 'kemi@jnconstruction.example');
  const o = company('ETABLIX Services (Unrelated) Ltd', 'sam@etablix-unrelated.example');
  const qs = platform.createUser({ tenantId: e.tenantId, name: 'Justin Nseya', email: 'justin@groupe-nseya.example', roles: ['QS'] });
  etablix = { ...e, qs, projectId: projectIn(e.tenantId, e.enterpriseId, e.admin, 'Welfare village') };
  jn = { ...j, projectId: projectIn(j.tenantId, j.enterpriseId, j.admin, 'Riverside depot') };
  outsider = o;
  platform.setModuleGrant({ moduleId: 'ETABLIX', tenantId: e.tenantId, status: 'ACTIVE', reason: 'ETABLIX Ltd delivers site services', decidedBy: operator.id });
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  rateLimiter.reset();
});
after(() => server.close());

describe('AT-01, AT-44 — onboarding is one idempotent act, for any group', () => {
  const ask = {
    group: { displayName: 'Groupe Nseya', currency: 'GBP' },
    agreement: { mode: 'INTERNAL_COST_ALLOCATION', seller: { legalName: 'CONSTRUX Platform Ltd', tenantId: null }, payer: { legalName: 'Groupe Nseya Holdings SA', tenantId: null } },
    company: { displayName: 'ETABLIX RDC SARL', code: 'ERD', jurisdiction: 'GB', currency: 'GBP', tier: 'ENTERPRISE', package: 'ENTERPRISE', administrator: { name: 'Lea Mbala', email: 'lea@etablix-rdc.example' } },
    groupAdministrator: 'lea@etablix-rdc.example',
  };

  it('creates the group, the agreement draft, the company, its administrator and the group role once', async () => {
    const first = await send('POST', '/v1/admin/groups/onboard', tokenFor(operator), ask);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.groupCreated, true);
    assert.equal((first.body.company as Record<string, unknown>).created, true);
    assert.equal((first.body.administrator as Record<string, unknown>).created, true);
    assert.equal((first.body.agreement as Record<string, unknown>).created, true);
    assert.equal((first.body.groupRole as Record<string, unknown>).granted, true);
    const readiness = first.body.readiness as Record<string, Record<string, unknown>>;
    assert.equal(readiness.operational!.ready, true);
    assert.equal(readiness.billing!.ready, false, 'the agreement is a draft until the group approves it');
    assert.equal(readiness.issuance!.ready, false, 'no registered detail is guessed');
    groupId = String((first.body.group as Record<string, unknown>).id);

    const again = await send('POST', '/v1/admin/groups/onboard', tokenFor(operator), ask);
    assert.equal(again.status, 201, JSON.stringify(again.body));
    assert.equal(again.body.groupCreated, false);
    assert.equal((again.body.company as Record<string, unknown>).created, false);
    assert.equal((again.body.company as Record<string, unknown>).tenantId, (first.body.company as Record<string, unknown>).tenantId, 'the same company, not a second one');
    assert.equal((again.body.administrator as Record<string, unknown>).created, false);
    assert.equal((again.body.agreement as Record<string, unknown>).created, false);
    assert.equal(platform.tenants().filter((tenant) => tenant.legalName === 'ETABLIX RDC SARL').length, 1);
  });

  it('brings the two existing companies in under the same group, and refuses an address that already exists', async () => {
    for (const [tenantId, code] of [[etablix.tenantId, 'ETX'], [jn.tenantId, 'JNC']] as const) {
      const attached = await send('POST', `/v1/admin/groups/${groupId}/companies`, tokenFor(operator), { tenantId, code });
      assert.equal(attached.status, 201, JSON.stringify(attached.body));
    }
    const clash = await send('POST', '/v1/admin/groups/onboard', tokenFor(operator), { ...ask, company: { ...ask.company, displayName: 'Another', code: 'ANO', administrator: { name: 'Rowan', email: etablix.admin.email } } });
    assert.equal(clash.body.title, 'EMAIL_IN_USE');
    const role = await send('POST', `/v1/admin/groups/${groupId}/roles`, tokenFor(operator), { email: etablix.admin.email, role: 'GROUP_ADMIN' });
    assert.equal(role.status, 201, JSON.stringify(role.body));
    const finance = await send('POST', `/v1/admin/groups/${groupId}/roles`, tokenFor(operator), { email: jn.admin.email, role: 'GROUP_FINANCE' });
    assert.equal(finance.status, 201);
  });
});

describe('AT-02, AT-17, AT-18 — identity by id, modules by explicit grant', () => {
  it('a renamed group keeps every relation by id', async () => {
    const renamed = await send('PUT', `/v1/admin/groups/${groupId}/billing`, tokenFor(operator), { displayName: 'Groupe Nseya Digital' });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    const directory = await send('GET', `/v1/groups/${groupId}`, tokenFor(etablix.admin));
    assert.equal(directory.status, 200);
    assert.equal((directory.body.group as Record<string, unknown>).displayName, 'Groupe Nseya Digital');
    assert.equal((directory.body.companies as unknown[]).length, 3);
  });

  it('the restricted module is published as a registry entry, and a same-named outsider holds nothing', async () => {
    assert.equal(MODULES.ETABLIX.registry.moduleKey, 'construx.etablix.integrated_site_services');
    assert.equal(MODULES.ETABLIX.registry.customerSelfActivation, false);
    const outsiderProject = projectIn(outsider.tenantId, platform.tenant(outsider.tenantId).enterpriseId!, outsider.admin, 'Lookalike');
    const refused = await send('GET', `/v1/projects/${outsiderProject}/site-services/appointment`, tokenFor(outsider.admin));
    assert.equal(refused.status, 403);
    assert.equal(refused.body.title, 'MODULE_NOT_GRANTED');
    const items = await send('GET', '/v1/company/subscription/items', tokenFor(etablix.admin));
    assert.equal(items.status, 200, JSON.stringify(items.body));
    const codes = (items.body.items as Array<Record<string, unknown>>).map((item) => item.code);
    assert.deepEqual(codes, ['construx.core', 'construx.etablix.integrated_site_services']);
    const jnItems = await send('GET', '/v1/company/subscription/items', tokenFor(jn.admin));
    assert.deepEqual((jnItems.body.items as Array<Record<string, unknown>>).map((item) => item.code), ['construx.core']);
  });

  it('a tenant administrator cannot grant themselves the module through any route', async () => {
    const attempt = await send('POST', '/v1/admin/modules/ETABLIX/decisions', tokenFor(jn.admin), { tenantId: jn.tenantId, status: 'ACTIVE', reason: 'Trying it on' });
    assert.notEqual(attempt.status, 201);
    assert.deepEqual(platform.grantedModules(jn.tenantId), []);
  });
});

describe('§9 — the agreement, subscriptions, seats and invoice grouping (AT-26, AT-27, AT-28, AT-29, AT-43)', () => {
  it('the draft is approved by the group and comes into force; billing readiness follows', async () => {
    const billingBefore = await send('GET', `/v1/groups/${groupId}/billing`, tokenFor(jn.admin));
    assert.equal(billingBefore.status, 200, JSON.stringify(billingBefore.body));
    assert.equal(billingBefore.body.inForce, null);
    const approved = await send('POST', `/v1/groups/${groupId}/agreement/1/approve`, tokenFor(jn.admin), {});
    assert.equal(approved.status, 201, JSON.stringify(approved.body));
    const billing = await send('GET', `/v1/groups/${groupId}/billing`, tokenFor(jn.admin));
    const inForce = billing.body.inForce as Record<string, unknown>;
    assert.equal(inForce.mode, 'INTERNAL_COST_ALLOCATION');
    assert.equal((inForce.payer as Record<string, unknown>).legalName, 'Groupe Nseya Holdings SA');
    const readiness = await send('GET', '/v1/company/readiness', tokenFor(etablix.admin));
    assert.equal((readiness.body.billing as Record<string, unknown>).ready, true);
    const viewer = await send('GET', `/v1/groups/${groupId}/billing`, tokenFor(etablix.qs));
    assert.equal(viewer.status, 403);
  });

  it('AT-27: one person in two companies holds a seat in each, and is one distinct person', async () => {
    const added = await send('POST', '/v1/users/memberships', tokenFor(jn.admin), { email: etablix.qs.email, roles: ['PM'] });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    const billing = await send('GET', `/v1/groups/${groupId}/billing`, tokenFor(jn.admin));
    const seats = billing.body.seats as { used: number; distinctPeople: number };
    const directory = await send('GET', `/v1/groups/${groupId}`, tokenFor(etablix.admin));
    const people = (directory.body.companies as Array<{ people: number }>).reduce((sum, company) => sum + company.people, 0);
    assert.equal(seats.used, people, 'one seat per active person per company');
    assert.ok(seats.used > seats.distinctPeople, 'the same address counts once as a person and once per company as a seat');
  });

  it('AT-26: seat activation at the limit is refused transactionally, never silently bought', async () => {
    const small = platform.createTenant({ legalName: 'Tiny Ltd', jurisdiction: 'GB', defaultCurrency: 'GBP', tier: 'SOLO', package: 'SOLO', enterpriseName: 'Tiny' });
    platform.createUser({ tenantId: small.tenant.id, name: 'Only One', email: 'one@tiny.example', roles: ['ENTERPRISE_ADMIN'] });
    assert.throws(
      () => platform.createUser({ tenantId: small.tenant.id, name: 'Second', email: 'two@tiny.example', roles: ['PM'] }),
      (error: unknown) => (error as { code?: string }).code === 'SEAT_LIMIT_REACHED',
    );
    assert.equal(platform.users(small.tenant.id).length, 1);
  });

  it('AT-28 / AT-29: one invoice only where seller, payer, currency and period agree; otherwise separate invoices and the statement', async () => {
    const consolidated = await send('GET', `/v1/groups/${groupId}/billing`, tokenFor(jn.admin));
    const invoicing = consolidated.body.invoicing as Record<string, unknown>;
    assert.equal(invoicing.single, true, JSON.stringify(invoicing));
    assert.equal((invoicing.allocationOnly as string[]).length, 3, 'internal allocation: statement, not invoice');

    const eur = company('Chantier Nord SAS', 'nord@chantier.example', 'EUR');
    const attached = await send('POST', `/v1/admin/groups/${groupId}/companies`, tokenFor(operator), { tenantId: eur.tenantId, code: 'CNS', chargeMode: 'EXTERNAL' });
    assert.equal(attached.status, 201, JSON.stringify(attached.body));
    const centre = await send('PUT', `/v1/admin/groups/${groupId}/companies/${etablix.tenantId}/cost-centre`, tokenFor(operator), { chargeMode: 'INTERCOMPANY' });
    assert.equal(centre.status, 200);
    const split = await send('GET', `/v1/groups/${groupId}/billing`, tokenFor(jn.admin));
    const now = split.body.invoicing as Record<string, unknown>;
    assert.equal(now.single, false);
    assert.ok((now.reasons as string[]).some((reason) => reason.includes('currency')));
    assert.equal((now.invoices as unknown[]).length, 2, 'GBP and EUR invoices, separately');
    await send('PUT', `/v1/admin/groups/${groupId}/companies/${etablix.tenantId}/cost-centre`, tokenFor(operator), { chargeMode: 'INTERNAL' });
  });

  it('AT-43: an internal licence with no software fee still meters AI and provider cost', async () => {
    const wallet = platform.wallet(etablix.tenantId);
    wallet.topUp(100_000, 'Acceptance top-up');
    const hold = wallet.reserve({ aiRequestId: 'at-43', estimatedRawCostMinor: 500, projectId: etablix.projectId, userId: etablix.qs.id, module: 'ETABLIX', feature: 'brief' });
    wallet.settle(hold.holdId, 400, 'local');
    const usage = await send('GET', `/v1/groups/${groupId}/usage`, tokenFor(jn.admin));
    const etx = (usage.body.companies as Array<Record<string, unknown>>).find((c) => c.code === 'ETX')!;
    const acu = (etx.meters as Record<string, Record<string, number>>).acu!;
    assert.equal(acu.rawMinor, 400, 'provider cost recorded');
    assert.ok(Number(acu.billedMinor) > 400, 'the charge recorded, whatever the agreement mode');
    assert.equal(etx.chargeMode, 'INTERNAL');
  });
});

describe('§10 — wallets, reservations and budgets (AT-20 to AT-23)', () => {
  it('AT-20 / AT-21: 100 available, 70 and 40 reserved, 55 committed, replay changes nothing', () => {
    const wallet = new ACUWallet('arith');
    wallet.topUp(100);
    // Held amounts carry the platform's multiplier; the raw figures are chosen so the held figures are 70 and 40.
    const seventy = wallet.reserve({ aiRequestId: 'job-70', estimatedRawCostMinor: 14 });
    assert.equal(seventy.heldMinor, 70);
    assert.equal(wallet.availableMinor(), 30);
    assert.throws(() => wallet.reserve({ aiRequestId: 'job-40', estimatedRawCostMinor: 8 }), (error: unknown) => (error as { code?: string }).code === 'ACU_EXHAUSTED');
    assert.equal(wallet.heldMinor(), 70, 'exactly one reservation succeeded');
    const settled = wallet.settle(seventy.holdId, 11, 'provider-a');
    assert.equal(settled.billedMinor, 55);
    assert.equal(wallet.availableMinor(), 45);
    assert.equal(wallet.heldMinor(), 0);
    assert.equal(wallet.snapshot().lifetimeBilledMinor, 55);
    const replayed = wallet.settle(seventy.holdId, 11, 'provider-a');
    assert.equal(replayed.id, settled.id, 'the same settlement, not a second one');
    assert.equal(wallet.availableMinor(), 45);
    assert.equal(wallet.snapshot().lifetimeBilledMinor, 55);
    assert.equal(wallet.release(seventy.holdId), undefined, 'commit and release are mutually exclusive');
  });

  it('AT-23: an empty wallet is refused even though a sibling is funded', () => {
    assert.ok(platform.wallet(etablix.tenantId).availableMinor() > 0);
    // A company provisioned with no invented funding (§15.2): its wallet opens empty.
    const unfunded = platform.createTenant({ legalName: 'Unfunded Sibling Ltd', jurisdiction: 'GB', defaultCurrency: 'GBP', tier: 'ENTERPRISE', package: 'ENTERPRISE', enterpriseName: 'Unfunded', trialGrant: false });
    const empty = platform.wallet(unfunded.tenant.id);
    // The plan's own AI allowance is credited with the subscription; spend it down so the wallet is genuinely empty.
    empty.closeOut('Acceptance: drained to zero');
    assert.equal(empty.availableMinor(), 0);
    assert.throws(() => empty.reserve({ aiRequestId: 'at-23', estimatedRawCostMinor: 10 }), (error: unknown) => (error as { code?: string }).code === 'ACU_EXHAUSTED');
    assert.equal(platform.wallet(etablix.tenantId).heldMinor(), 0, 'nothing was taken from the sibling');
  });

  it('a personal budget stops one person without stopping the company', async () => {
    const set = await send('POST', '/v1/billing/caps', tokenFor(etablix.admin), { perUserMinor: { [etablix.qs.id]: 100 }, reason: 'Pilot allowance for the QS' });
    assert.equal(set.status, 201, JSON.stringify(set.body));
    const wallet = platform.wallet(etablix.tenantId);
    assert.throws(() => wallet.reserve({ aiRequestId: 'at-budget', estimatedRawCostMinor: 100, userId: etablix.qs.id }), (error: unknown) => String((error as Error).message).includes('Personal'));
    const other = wallet.reserve({ aiRequestId: 'at-budget-2', estimatedRawCostMinor: 100, userId: etablix.admin.id });
    wallet.release(other.holdId, 'test');
  });
});

describe('§8 — documents: lifecycle, approval by hash, atomic issuance (AT-10 to AT-16)', () => {
  let documentId: string;
  let firstHash: string;

  it('AT-16: a draft cannot name a source record, an issuer or a signatory belonging to a sibling', async () => {
    const foreign = await send('POST', '/v1/documents/lifecycle', tokenFor(etablix.admin), { documentType: 'quotation', title: 'Depot works', source: { refType: 'Project', refId: jn.projectId } });
    assert.equal(foreign.status, 404, 'a sibling record is answered as no record');
    const sibling = await send('PUT', '/v1/company/issuer', tokenFor(etablix.admin), { signatories: [{ userId: jn.admin.id, title: 'Director', documents: ['quotation'] }] });
    assert.equal(sibling.body.title, 'SIGNATORY_NOT_HERE');
  });

  it('issues nothing while the registered issuer is incomplete (LEGAL_PROFILE_INCOMPLETE) or unapproved (DOCUMENT_NOT_APPROVED)', async () => {
    await send('PUT', '/v1/company/issuer', tokenFor(etablix.admin), { numberingRules: { quotation: { prefix: 'ETB-QUO-', pattern: '{YYYY}-{seq:6}', seqScope: 'year' } } });
    const draft = await send('POST', '/v1/documents/lifecycle', tokenFor(etablix.admin), {
      documentType: 'quotation',
      title: 'Welfare village — phase 1',
      body: { Client: 'Riverside Depot Ltd', 'Total excl. VAT': 48500, Validity: '30 days' },
      source: { refType: 'Project', refId: etablix.projectId },
    });
    assert.equal(draft.status, 201, JSON.stringify(draft.body));
    documentId = String(draft.body.id);
    const early = await send('POST', `/v1/documents/lifecycle/${documentId}/issue`, tokenFor(etablix.admin), { idempotencyKey: 'issue-early-0001' });
    assert.equal(early.body.title, 'DOCUMENT_NOT_APPROVED');
    const generated = await send('POST', `/v1/documents/lifecycle/${documentId}/generate`, tokenFor(etablix.admin), {});
    assert.equal(generated.status, 201, JSON.stringify(generated.body));
    assert.equal(generated.body.status, 'GENERATED');
    firstHash = String((generated.body.revisions as Array<Record<string, unknown>>)[0]!.hash);
    const approved = await send('POST', `/v1/documents/lifecycle/${documentId}/approve`, tokenFor(etablix.admin), { revision: 1, hash: firstHash });
    assert.equal(approved.status, 201, JSON.stringify(approved.body));
    const incomplete = await send('POST', `/v1/documents/lifecycle/${documentId}/issue`, tokenFor(etablix.admin), { idempotencyKey: 'issue-early-0002' });
    assert.equal(incomplete.body.title, 'LEGAL_PROFILE_INCOMPLETE');
    assert.equal(incomplete.status, 422);
  });

  it('AT-15: changing the content invalidates the approval; the approval names the hash it approved', async () => {
    const regenerated = await send('POST', `/v1/documents/lifecycle/${documentId}/generate`, tokenFor(etablix.admin), { body: { Client: 'Riverside Depot Ltd', 'Total excl. VAT': 51200, Validity: '30 days' } });
    assert.equal(regenerated.status, 201, JSON.stringify(regenerated.body));
    assert.equal(regenerated.body.status, 'GENERATED', 'the approval is gone');
    const stale = await send('POST', `/v1/documents/lifecycle/${documentId}/approve`, tokenFor(etablix.admin), { revision: 1, hash: firstHash });
    assert.equal(stale.body.title, 'VERSION_CONFLICT');
    const current = (regenerated.body.revisions as Array<Record<string, unknown>>)[1]!;
    const wrongVersion = await send('POST', `/v1/documents/lifecycle/${documentId}/generate`, tokenFor(etablix.admin), { expectedVersion: 1 });
    assert.equal(wrongVersion.body.title, 'VERSION_CONFLICT');
    const approved = await send('POST', `/v1/documents/lifecycle/${documentId}/approve`, tokenFor(etablix.admin), { revision: 2, hash: current.hash });
    assert.equal(approved.status, 201, JSON.stringify(approved.body));
    assert.equal(approved.body.status, 'APPROVED');
  });

  it('AT-14: a render failure keeps the pending issuance and number; the retry finishes with the same number', async () => {
    const set = await send('PUT', '/v1/company/issuer', tokenFor(etablix.admin), { issuer: issuerBlock });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal((set.body.legal as Record<string, unknown>).state, 'DECLARED');
    // The issuer changed since the approved revision was generated: what was
    // approved no longer carries the company's current registered details.
    const stale = await send('POST', `/v1/documents/lifecycle/${documentId}/issue`, tokenFor(etablix.admin), { idempotencyKey: 'issue-welfare-0000' });
    assert.equal(stale.body.title, 'ISSUER_PROFILE_CHANGED');
    const regenerated = await send('POST', `/v1/documents/lifecycle/${documentId}/generate`, tokenFor(etablix.admin), {});
    const revision = (regenerated.body.revisions as Array<Record<string, unknown>>)[2]!;
    const approved = await send('POST', `/v1/documents/lifecycle/${documentId}/approve`, tokenFor(etablix.admin), { revision: 3, hash: revision.hash });
    assert.equal(approved.status, 201, JSON.stringify(approved.body));
    const actor = authOf(platform, etablix.admin.id);
    let attempts = 0;
    assert.throws(
      () => issueDocument(platform, actor, documentId, { idempotencyKey: 'issue-welfare-0001' }, () => {
        attempts += 1;
        throw new Error('renderer offline');
      }),
      (error: unknown) => (error as { code?: string }).code === 'ISSUANCE_RENDER_FAILED',
    );
    assert.equal(attempts, 1);
    const listed = await send('GET', '/v1/documents/lifecycle', tokenFor(etablix.admin));
    const pending = (listed.body.issuances as Array<Record<string, unknown>>).find((issuance) => issuance.documentId === documentId)!;
    assert.equal(pending.status, 'PENDING');
    const year = new Date().getUTCFullYear();
    assert.equal(pending.number, `ETB-QUO-${year}-000001`);
    assert.equal(pending.attempts, 1);

    const retried = await send('POST', `/v1/documents/lifecycle/${documentId}/issue`, tokenFor(etablix.admin), { idempotencyKey: 'issue-welfare-0001' });
    assert.equal(retried.status, 201, JSON.stringify(retried.body));
    const issuance = retried.body.issuance as Record<string, unknown>;
    assert.equal(issuance.number, `ETB-QUO-${year}-000001`, 'the same number, not a second one');
    assert.equal(issuance.status, 'ISSUED');
    assert.equal(issuance.attempts, 2);
    assert.equal((retried.body.document as Record<string, unknown>).status, 'ISSUED');

    const replay = await send('POST', `/v1/documents/lifecycle/${documentId}/issue`, tokenFor(etablix.admin), { idempotencyKey: 'issue-welfare-0001' });
    assert.equal(replay.status, 201);
    assert.equal(replay.body.replayed, true);
    assert.equal((replay.body.issuance as Record<string, unknown>).id, issuance.id);
    const otherKey = await send('POST', `/v1/documents/lifecycle/${documentId}/issue`, tokenFor(etablix.admin), { idempotencyKey: 'issue-welfare-0002' });
    assert.equal(otherKey.body.title, 'DOCUMENT_ISSUED');
    const reused = await send('POST', '/v1/documents/lifecycle', tokenFor(etablix.admin), { documentType: 'quotation', title: 'Another' });
    const conflict = await send('POST', `/v1/documents/lifecycle/${reused.body.id}/issue`, tokenFor(etablix.admin), { idempotencyKey: 'issue-welfare-0001' });
    assert.equal(conflict.body.title, 'IDEMPOTENCY_CONFLICT');
  });

  it('AT-11: an issued document is immutable; a later brand and profile change leaves its manifest, and a void number is never reused', async () => {
    const brand = await send('PUT', '/v1/branding', tokenFor(etablix.admin), { clientName: 'ETABLIX New Look', primaryColour: '#0044aa', legalFooter: 'New footer', documentReferencePrefix: 'ETX' });
    assert.equal(brand.status, 200, JSON.stringify(brand.body));
    const doc = await send('GET', `/v1/documents/lifecycle/${documentId}`, tokenFor(etablix.admin));
    const revision = (doc.body.revisions as Array<Record<string, unknown>>)[2]!;
    const manifest = revision.manifest as Record<string, unknown>;
    assert.equal((manifest.issuer as Record<string, unknown>).registeredName, 'ETABLIX LTD');
    assert.notEqual((manifest.brand as Record<string, unknown> | null)?.clientName, 'ETABLIX New Look', 'the frozen brand is the one at generation');
    const earlier = (doc.body.revisions as Array<Record<string, unknown>>)[1]!.manifest as Record<string, unknown>;
    assert.equal((earlier.issuer as Record<string, unknown>).registeredName, 'ETABLIX Ltd', 'the earlier revision keeps the issuer it was generated under');
    const regenerate = await send('POST', `/v1/documents/lifecycle/${documentId}/generate`, tokenFor(etablix.admin), {});
    assert.equal(regenerate.body.title, 'DOCUMENT_ISSUED');
    const download = await fetch(`${base}/v1/documents/lifecycle/${documentId}/download`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(etablix.admin)}` }, body: '{}' });
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-type') ?? '', /pdf/);
    const notTheirs = await send('GET', `/v1/documents/lifecycle/${documentId}`, tokenFor(jn.admin));
    assert.equal(notTheirs.status, 404, 'a sibling cannot even confirm it exists');

    // A second document: reserved, abandoned, voided. The number stays on the record.
    const second = await send('POST', '/v1/documents/lifecycle', tokenFor(etablix.admin), { documentType: 'quotation', title: 'Abandoned quotation', body: { Total: 1 } });
    await send('POST', `/v1/documents/lifecycle/${second.body.id}/generate`, tokenFor(etablix.admin), {});
    const got = await send('GET', `/v1/documents/lifecycle/${second.body.id}`, tokenFor(etablix.admin));
    const hash = String((got.body.revisions as Array<Record<string, unknown>>)[0]!.hash);
    await send('POST', `/v1/documents/lifecycle/${second.body.id}/approve`, tokenFor(etablix.admin), { revision: 1, hash });
    assert.throws(() => issueDocument(platform, authOf(platform, etablix.admin.id), String(second.body.id), { idempotencyKey: 'issue-abandon-0001' }, () => { throw new Error('offline'); }));
    const listed = await send('GET', '/v1/documents/lifecycle', tokenFor(etablix.admin));
    const pending = (listed.body.issuances as Array<Record<string, unknown>>).find((issuance) => issuance.status === 'PENDING')!;
    const year = new Date().getUTCFullYear();
    assert.equal(pending.number, `ETB-QUO-${year}-000002`);
    const voided = await send('POST', `/v1/documents/issuances/${pending.id}/void`, tokenFor(etablix.admin), { reason: 'Customer withdrew before issue' });
    assert.equal(voided.status, 201, JSON.stringify(voided.body));
    assert.equal(voided.body.status, 'VOID');
    const issued = await send('POST', `/v1/documents/lifecycle/${second.body.id}/issue`, tokenFor(etablix.admin), { idempotencyKey: 'issue-abandon-0002' });
    assert.equal(issued.status, 201, JSON.stringify(issued.body));
    assert.equal((issued.body.issuance as Record<string, unknown>).number, `ETB-QUO-${year}-000003`, 'the void number is never handed out again');
  });

  it('AT-13: concurrent issuance never collides on a number, and each company keeps its own prefix', async () => {
    await send('PUT', '/v1/company/issuer', tokenFor(jn.admin), { issuer: { ...issuerBlock, registeredName: 'JN CONSTRUCTION LTD', tradingName: 'JN Construction', registrationNo: '87654321' }, numberingRules: { report: { prefix: 'JNC-REP-', pattern: '{YYYY}-{seq:6}', seqScope: 'year' } } });
    const drafts = await Promise.all(
      Array.from({ length: 6 }, (_, i) => send('POST', '/v1/documents/lifecycle', tokenFor(jn.admin), { documentType: 'report', title: `Weekly report ${i}`, body: { Week: i } })),
    );
    await Promise.all(drafts.map((draft) => send('POST', `/v1/documents/lifecycle/${draft.body.id}/generate`, tokenFor(jn.admin), {})));
    const issued = await Promise.all(drafts.map((draft, i) => send('POST', `/v1/documents/lifecycle/${draft.body.id}/issue`, tokenFor(jn.admin), { idempotencyKey: `issue-weekly-${i}-0001` })));
    const numbers = issued.map((r) => String((r.body.issuance as Record<string, unknown>)?.number));
    assert.equal(new Set(numbers).size, 6, JSON.stringify(issued.map((r) => r.body)));
    assert.ok(numbers.every((number) => number.startsWith('JNC-REP-')));
    assert.ok(issued.every((r) => r.status === 201), 'a report needs no approval under the published policy');
  });

  it('the operator verifies the declared issuer; a later change re-declares it', async () => {
    const verified = await send('POST', `/v1/admin/tenants/${etablix.tenantId}/issuer/verify`, tokenFor(operator), { note: 'Companies House 12345678 matches' });
    assert.equal(verified.status, 201, JSON.stringify(verified.body));
    assert.equal((verified.body.legal as Record<string, unknown>).state, 'VERIFIED');
    const incomplete = await send('POST', `/v1/admin/tenants/${outsider.tenantId}/issuer/verify`, tokenFor(operator), { note: 'Nothing declared' });
    assert.equal(incomplete.body.title, 'LEGAL_PROFILE_INCOMPLETE');
    const changed = await send('PUT', '/v1/company/issuer', tokenFor(etablix.admin), { issuer: { registrationNo: '12345679' } });
    assert.equal((changed.body.legal as Record<string, unknown>).state, 'DECLARED');
    const notOperator = await send('POST', `/v1/admin/tenants/${etablix.tenantId}/issuer/verify`, tokenFor(etablix.admin), { note: 'Self-verified' });
    assert.equal(notOperator.status, 403);
  });
});

describe('§12 — shares are accepted and scoped to fields (AT-32, AT-33)', () => {
  let shareId: string;

  it('the recipient sees only the named fields, and only after accepting', async () => {
    const proposed = await send('POST', '/v1/shares', tokenFor(jn.admin), {
      granteeTenantId: etablix.tenantId,
      refType: 'Project',
      refId: jn.projectId,
      fields: ['name', 'plannedStart', 'plannedCompletion'],
      note: 'Site programme for the services quotation',
    });
    assert.equal(proposed.status, 201, JSON.stringify(proposed.body));
    assert.equal(proposed.body.status, 'PENDING');
    shareId = String(proposed.body.id);
    const badField = await send('POST', '/v1/shares', tokenFor(jn.admin), { granteeTenantId: etablix.tenantId, refType: 'Project', refId: jn.projectId, fields: ['tenderMargin'] });
    assert.equal(badField.body.title, 'FIELD_UNKNOWN');

    const early = await send('GET', `/v1/shares/${shareId}/record`, tokenFor(etablix.admin));
    assert.equal(early.status, 403);
    assert.equal(early.body.title, 'SHARE_NOT_ACCEPTED');
    const wrongCompany = await send('POST', `/v1/shares/${shareId}/accept`, tokenFor(outsider.admin), {});
    assert.equal(wrongCompany.status, 403);
    const accepted = await send('POST', `/v1/shares/${shareId}/accept`, tokenFor(etablix.admin), {});
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));

    const read = await send('GET', `/v1/shares/${shareId}/record`, tokenFor(etablix.qs));
    assert.equal(read.status, 200, JSON.stringify(read.body));
    const record = read.body.record as Record<string, unknown>;
    assert.deepEqual(Object.keys(record).sort(), ['id', 'name', 'plannedCompletion', 'plannedStart']);
    assert.equal(record.contractValueMinor, undefined, 'the commercial position stays home');
    assert.equal((read.body.sharedBy as Record<string, unknown>).name, 'JN Construction Ltd');
  });

  it('AT-33: revocation ends the read on the next request', async () => {
    await send('POST', `/v1/shares/${shareId}/revoke`, tokenFor(jn.admin), {});
    const read = await send('GET', `/v1/shares/${shareId}/record`, tokenFor(etablix.qs));
    assert.equal(read.body.title, 'SHARE_ENDED');
  });
});

describe('§12 — reporting grants and grant-filtered group reports (AT-30, AT-31, AT-33, AT-36)', () => {
  let reportId: string;

  it('AT-31: a report without a grant names the company as withheld and shows no figure', async () => {
    const run = await send('POST', `/v1/groups/${groupId}/reports`, tokenFor(etablix.admin), { metrics: ['projects.count', 'projects.contract_value'] });
    assert.equal(run.status, 201, JSON.stringify(run.body));
    const sections = run.body.sections as Array<Record<string, unknown>>;
    assert.ok(sections.every((section) => section.status === 'NOT_GRANTED'));
    assert.ok(sections.every((section) => Object.keys(section.values as object).length === 0), 'no value, not zero');
    assert.deepEqual(run.body.totals, {});
  });

  it('a company grants named metrics to named roles; the report reads them and withholds the rest', async () => {
    const notAdmin = await send('POST', '/v1/company/reporting-grants', tokenFor(etablix.qs), { metrics: ['projects.count'] });
    assert.equal(notAdmin.status, 403);
    const granted = await send('POST', '/v1/company/reporting-grants', tokenFor(jn.admin), { metrics: ['projects.count', 'projects.contract_value'], roles: ['GROUP_ADMIN'], note: 'Board pack' });
    assert.equal(granted.status, 201, JSON.stringify(granted.body));
    const partial = await send('POST', '/v1/company/reporting-grants', tokenFor(etablix.admin), { metrics: ['projects.count'], roles: ['GROUP_ADMIN', 'GROUP_FINANCE'] });
    assert.equal(partial.status, 201);

    const run = await send('POST', `/v1/groups/${groupId}/reports`, tokenFor(etablix.admin), { metrics: ['projects.count', 'projects.contract_value', 'acu.billed'] });
    assert.equal(run.status, 201, JSON.stringify(run.body));
    reportId = String(run.body.id);
    const sections = run.body.sections as Array<Record<string, unknown>>;
    const jnc = sections.find((s) => s.code === 'JNC')!;
    const etx = sections.find((s) => s.code === 'ETX')!;
    const erd = sections.find((s) => s.code === 'ERD')!;
    assert.equal(jnc.status, 'INCLUDED');
    assert.equal((jnc.values as Record<string, Record<string, unknown>>)['projects.count']!.value, 1);
    assert.equal((jnc.values as Record<string, Record<string, unknown>>)['projects.contract_value']!.currency, 'GBP');
    assert.deepEqual(jnc.withheld, ['acu.billed']);
    assert.equal(etx.status, 'INCLUDED');
    assert.deepEqual(etx.withheld, ['projects.contract_value', 'acu.billed'], 'ETABLIX granted the count only');
    assert.equal(erd.status, 'NOT_GRANTED');
    assert.equal((run.body.totals as Record<string, Record<string, number>>).count!['projects.count'], 2);
    assert.equal(run.body.currencyPolicy, 'ORIGINAL_CURRENCY_NO_CONVERSION');

    // Finance holds a grant from ETABLIX only.
    const finance = await send('POST', `/v1/groups/${groupId}/reports`, tokenFor(jn.admin), { metrics: ['projects.count'] });
    const financeSections = finance.body.sections as Array<Record<string, unknown>>;
    assert.equal(financeSections.find((s) => s.code === 'JNC')!.status, 'NOT_GRANTED', 'JN granted admins, not finance');
    assert.equal(financeSections.find((s) => s.code === 'ETX')!.status, 'INCLUDED');
  });

  it('AT-30: a group role still opens no company record', async () => {
    const direct = await send('GET', `/v1/projects/${jn.projectId}`, tokenFor(etablix.admin));
    assert.notEqual(direct.status, 200);
    const list = await send('GET', `/v1/projects/${jn.projectId}/entities/Project`, tokenFor(etablix.admin));
    assert.deepEqual(list.body.entities ?? [], []);
  });

  it('AT-33: a stored report rechecks its grants on every read', async () => {
    const before = await send('GET', `/v1/groups/${groupId}/reports/${reportId}`, tokenFor(etablix.admin));
    assert.equal(before.status, 200, JSON.stringify(before.body));
    assert.deepEqual(before.body.withheldSinceGeneration, []);
    const grants = await send('GET', '/v1/company/reporting-grants', tokenFor(jn.admin));
    const grant = (grants.body.grants as Array<Record<string, unknown>>)[0]!;
    const revoked = await send('POST', `/v1/company/reporting-grants/${grant.id}/revoke`, tokenFor(jn.admin), {});
    assert.equal(revoked.status, 201, JSON.stringify(revoked.body));
    const after = await send('GET', `/v1/groups/${groupId}/reports/${reportId}`, tokenFor(etablix.admin));
    assert.deepEqual(after.body.withheldSinceGeneration, ['JN Construction Ltd']);
    const jnc = (after.body.sections as Array<Record<string, unknown>>).find((s) => s.code === 'JNC')!;
    assert.equal(jnc.status, 'GRANT_REVOKED');
    assert.deepEqual(jnc.values, {});
    const listed = await send('GET', `/v1/groups/${groupId}/reports`, tokenFor(etablix.qs));
    assert.equal(listed.status, 403, 'no group role, no reports');
  });
});

describe('§16.3 — transferring a company between groups (AT-37, AT-38)', () => {
  let otherGroupId: string;
  let caseId: string;

  it('AT-38: a case whose destination cannot take the company fails before anything moves', async () => {
    const other = await send('POST', '/v1/admin/groups', tokenFor(operator), { displayName: 'Northern Holdings', currency: 'GBP' });
    otherGroupId = String(other.body.id);
    // Fill the destination to the licence limit.
    for (let i = 0; i < 5; i += 1) {
      const filler = company(`Filler ${i} Ltd`, `filler${i}@northern.example`);
      const attached = await send('POST', `/v1/admin/groups/${otherGroupId}/companies`, tokenFor(operator), { tenantId: filler.tenantId, code: `F${i}` });
      assert.equal(attached.status, 201, JSON.stringify(attached.body));
    }
    const opened = await send('POST', `/v1/admin/tenants/${jn.tenantId}/transfer-cases`, tokenFor(operator), { toGroupId: otherGroupId, code: 'JNC', reason: 'Sale of JN Construction to Northern Holdings' });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    const review = await send('POST', `/v1/admin/transfer-cases/${opened.body.id}/review`, tokenFor(operator), {});
    assert.equal(review.body.title, 'TRANSFER_NOT_POSSIBLE');
    assert.equal(platform.tenant(jn.tenantId).groupId, groupId, 'still exactly where it was');
    const cancelled = await send('POST', `/v1/admin/transfer-cases/${opened.body.id}/cancel`, tokenFor(operator), { reason: 'Destination full' });
    assert.equal(cancelled.body.status, 'CANCELLED');
  });

  it('AT-37: reviewed, approved by the company, scheduled, executed — identity kept, old group access ended, billing effective-dated', async () => {
    const room = await send('POST', '/v1/admin/groups', tokenFor(operator), { displayName: 'Southern Holdings', currency: 'GBP' });
    const southern = String(room.body.id);
    const opened = await send('POST', `/v1/admin/tenants/${jn.tenantId}/transfer-cases`, tokenFor(operator), { toGroupId: southern, code: 'JNC', reason: 'Sale of JN Construction to Southern Holdings' });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    caseId = String(opened.body.id);
    const tooEarly = await send('POST', `/v1/admin/transfer-cases/${caseId}/schedule`, tokenFor(operator), { effectiveAt: new Date().toISOString() });
    assert.equal(tooEarly.body.title, 'TRANSFER_STEP_INVALID');
    const review = await send('POST', `/v1/admin/transfer-cases/${caseId}/review`, tokenFor(operator), {});
    assert.equal(review.status, 201, JSON.stringify(review.body));
    const unapproved = await send('POST', `/v1/admin/transfer-cases/${caseId}/schedule`, tokenFor(operator), { effectiveAt: new Date().toISOString() });
    assert.equal(unapproved.body.title, 'COMPANY_APPROVAL_REQUIRED');
    const wrongCompany = await send('POST', `/v1/team/transfer-cases/${caseId}/approve`, tokenFor(etablix.admin), {});
    assert.equal(wrongCompany.status, 403);
    const visible = await send('GET', '/v1/team/transfer-cases', tokenFor(jn.admin));
    assert.equal((visible.body.cases as unknown[]).length, 2);
    const approved = await send('POST', `/v1/team/transfer-cases/${caseId}/approve`, tokenFor(jn.admin), {});
    assert.equal(approved.status, 201, JSON.stringify(approved.body));
    const future = await send('POST', `/v1/admin/transfer-cases/${caseId}/schedule`, tokenFor(operator), { effectiveAt: new Date(Date.now() + 86_400_000).toISOString() });
    assert.equal(future.body.status, 'SCHEDULED');
    const notDue = await send('POST', `/v1/admin/transfer-cases/${caseId}/execute`, tokenFor(operator), {});
    assert.equal(notDue.body.title, 'TRANSFER_NOT_DUE');

    // Reschedule to now: cancel is not allowed on a scheduled case's date, so schedule again from review is not possible; the
    // operator sets the date to the present through a fresh schedule step is refused — so the test drives the domain directly.
    const { scheduleTransferCase, executeTransferCase } = await import('../src/group/transfer.ts');
    const held = platform.ledger.get({ refType: 'TransferCase', refId: caseId })!.state as unknown as { status: string };
    assert.equal(held.status, 'SCHEDULED');
    const operatorAuth = authOf(platform, operator.id);
    const sharesBefore = platform.ledger.entitiesOfType('RecordShare').length;
    assert.ok(sharesBefore > 0);
    // A share JN gave ETABLIX that is still live, and ETABLIX's live grant to the old group, both end with the move.
    await send('POST', '/v1/shares', tokenFor(jn.admin), { granteeTenantId: etablix.tenantId, refType: 'Project', refId: jn.projectId, note: 'Still open at the sale' });
    const executed = executeTransferCase(platform, operatorAuth, caseId, new Date(Date.now() + 2 * 86_400_000));
    assert.equal(executed.status, 'COMPLETED', JSON.stringify(executed));
    void scheduleTransferCase;

    assert.equal(platform.tenant(jn.tenantId).groupId, southern, 'the new primary group');
    assert.equal(platform.tenant(jn.tenantId).id, jn.tenantId, 'the same tenancy');
    assert.equal(platform.ledger.listByTenant(jn.tenantId, 'Project').length, 1, 'records untouched');
    const oldGroup = await send('GET', `/v1/groups/${groupId}`, tokenFor(etablix.admin));
    assert.deepEqual((oldGroup.body.companies as Array<Record<string, unknown>>).map((c) => c.code).sort(), ['CNS', 'ERD', 'ETX']);
    const history = (oldGroup.body.group as Record<string, unknown>).history as Array<Record<string, unknown>>;
    assert.equal(history.length, 1);
    assert.equal(history[0]!.code, 'JNC');
    assert.ok(history[0]!.leftAt);
    const roles = (oldGroup.body.roles as Array<Record<string, unknown>>).map((role) => role.email);
    assert.equal(roles.includes(jn.admin.email), false, 'the old group role over the sold company is gone');
    const liveJnShares = platform.ledger.entitiesOfType('RecordShare').map((r) => r.state as { ownerTenantId: string; revokedAt?: string }).filter((s) => s.ownerTenantId === jn.tenantId && !s.revokedAt);
    assert.equal(liveJnShares.length, 0, 'shares with the old group\'s companies ended');
    const jnGrants = platform.ledger.listByTenant(jn.tenantId, 'ReportingGrant').map((r) => r.state as { revokedAt?: string });
    assert.ok(jnGrants.every((grant) => grant.revokedAt), 'reporting grants to the old group ended');

    const month = new Date().toISOString().slice(0, 7);
    const statement = await send('GET', `/v1/groups/${groupId}/statement?month=${month}`, tokenFor(etablix.admin));
    const jncSection = (statement.body.sections as Array<Record<string, unknown>>).find((s) => s.code === 'JNC')!;
    assert.ok(jncSection, 'the month it left still shows the company, up to the date it left');
    assert.equal((jncSection.membership as Record<string, unknown>).left, true);
    const noSecond = await send('POST', `/v1/admin/tenants/${jn.tenantId}/transfer-cases`, tokenFor(operator), { toGroupId: groupId, code: 'JNC', reason: 'Trying to move it straight back' });
    assert.equal(noSecond.status, 201, 'a new case can be opened; the old one is complete');
  });

  it('survives a restart: agreement, documents, issuances, grants, reports and cases are on the ledger', () => {
    const rebuilt = new Platform();
    rebuilt.ledger.restore(platform.ledger.events());
    rebuilt.rehydrate();
    assert.ok(rebuilt.ledger.get({ refType: 'Agreement', refId: groupId }), 'agreement');
    assert.ok(rebuilt.ledger.listByTenant(etablix.tenantId, 'Document').length >= 3, 'documents');
    assert.ok(rebuilt.ledger.listByTenant(etablix.tenantId, 'Issuance').some((r) => r.state.status === 'VOID'), 'void issuance');
    assert.ok(rebuilt.ledger.listByTenant(groupId, 'GroupReport').length >= 2, 'reports');
    assert.equal(rebuilt.tenant(jn.tenantId).groupId, platform.tenant(jn.tenantId).groupId, 'the transferred company is in its new group after a restart');
    assert.notEqual(rebuilt.tenant(jn.tenantId).groupId, groupId);
  });
});
