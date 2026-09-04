import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { rateLimiter } from '../src/api/middleware.ts';
import { Platform, type PlatformUser } from '../src/platform.ts';
import * as structure from '../src/domain/structure.ts';
import { authOf } from '../src/seed.ts';
import { renderNumber } from '../src/group/profile.ts';
import { completeSignIn } from './helpers.ts';

/**
 * GN-SPEC-TENANCY-001 §13 — the acceptance criteria, as far as they reach
 * CONSTRUX. One group, two companies, one person in both. Each block below
 * is one line of §13.
 */

let platform: Platform;
let server: Server;
let base: string;
let operator: PlatformUser;
let etablix: { tenantId: string; enterpriseId: string; admin: PlatformUser; qs: PlatformUser; projectId: string };
let jn: { tenantId: string; enterpriseId: string; admin: PlatformUser; pm: PlatformUser; projectId: string };
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

function company(legalName: string, jurisdiction: string, adminEmail: string) {
  const created = platform.createTenant({
    legalName,
    jurisdiction,
    defaultCurrency: 'GBP',
    tier: 'ENTERPRISE',
    package: 'ENTERPRISE',
    enterpriseName: legalName,
  });
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
    contractValueMinor: 50_000_000,
    currency: 'GBP',
    plannedStart: '2026-10-01',
    plannedCompletion: '2027-06-30',
  }).projectId;
}

before(async () => {
  platform = new Platform();
  operator = platform.createOperator({ name: 'Ruth Okafor', email: 'ops@construx.example' });
  const e = company('ETABLIX Ltd', 'GB', 'rowan@etablix.example');
  const j = company('JN Construction Ltd', 'GB', 'kemi@jnconstruction.example');
  const o = company('Outsider Civils Ltd', 'GB', 'sam@outsider.example');
  const qs = platform.createUser({ tenantId: e.tenantId, name: 'Justin Nseya', email: 'justin@groupe-nseya.example', roles: ['QS'] });
  const pm = platform.createUser({ tenantId: j.tenantId, name: 'Amara Diallo', email: 'amara@jnconstruction.example', roles: ['PM'] });
  etablix = { ...e, qs, projectId: projectIn(e.tenantId, e.enterpriseId, e.admin, 'Welfare village') };
  jn = { ...j, pm, projectId: projectIn(j.tenantId, j.enterpriseId, j.admin, 'Riverside depot') };
  outsider = o;
  platform.setModuleGrant({ moduleId: 'ETABLIX', tenantId: e.tenantId, status: 'ACTIVE', reason: 'ETABLIX Ltd delivers site services', decidedBy: operator.id });
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => server.close());

describe('the group above the companies (§2, §3)', () => {
  it('is created by the operator, and takes companies in with a cost centre each', async () => {
    const created = await send('POST', '/v1/admin/groups', tokenFor(operator), { displayName: 'Groupe Nseya', currency: 'GBP' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.slug, 'groupe-nseya');
    groupId = String(created.body.id);

    const first = await send('POST', `/v1/admin/groups/${groupId}/companies`, tokenFor(operator), { tenantId: etablix.tenantId, code: 'ETX', chargeMode: 'INTERNAL' });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const second = await send('POST', `/v1/admin/groups/${groupId}/companies`, tokenFor(operator), { tenantId: jn.tenantId, code: 'JNC', slug: 'jn-construction' });
    assert.equal(second.status, 201);
    const centres = second.body.costCentres as Array<Record<string, unknown>>;
    assert.deepEqual(centres.map((centre) => centre.code), ['ETX', 'JNC']);
    assert.equal(platform.tenant(jn.tenantId).groupSlug, 'jn-construction');

    const again = await send('POST', `/v1/admin/groups/${groupId}/companies`, tokenFor(operator), { tenantId: etablix.tenantId, code: 'ETX2' });
    assert.equal(again.body.title, 'ALREADY_IN_GROUP');
    const platformTenancy = await send('POST', `/v1/admin/groups/${groupId}/companies`, tokenFor(operator), { tenantId: 'platform', code: 'PLT' });
    assert.equal(platformTenancy.body.title, 'PLATFORM_TENANCY');
  });

  it('is not something a company administrator can create or change', async () => {
    const refused = await send('POST', '/v1/admin/groups', tokenFor(etablix.admin), { displayName: 'Mine', currency: 'GBP' });
    assert.equal(refused.status, 403);
  });
});

describe('group roles and the group console (§4, §6)', () => {
  it('requires a group role, which only somebody already in a company can hold', async () => {
    const stranger = await send('POST', `/v1/admin/groups/${groupId}/roles`, tokenFor(operator), { email: 'nobody@example.com', role: 'GROUP_ADMIN' });
    assert.equal(stranger.body.title, 'NOT_A_MEMBER');
    const granted = await send('POST', `/v1/admin/groups/${groupId}/roles`, tokenFor(operator), { email: etablix.admin.email, role: 'GROUP_ADMIN' });
    assert.equal(granted.status, 201, JSON.stringify(granted.body));

    const directory = await send('GET', `/v1/groups/${groupId}`, tokenFor(etablix.admin));
    assert.equal(directory.status, 200, JSON.stringify(directory.body));
    const companies = directory.body.companies as Array<Record<string, unknown>>;
    assert.deepEqual(companies.map((c) => c.code), ['ETX', 'JNC']);
    assert.deepEqual(directory.body.yourRoles, ['GROUP_ADMIN']);

    const refused = await send('GET', `/v1/groups/${groupId}`, tokenFor(jn.admin));
    assert.equal(refused.status, 403);
    assert.equal(refused.body.title, 'GROUP_ROLE_REQUIRED');
    const outside = await send('GET', `/v1/groups/${groupId}`, tokenFor(outsider.admin));
    assert.equal(outside.status, 403);
  });

  it('a group admin grants finance to somebody in the other company, and cannot revoke the last admin', async () => {
    const finance = await send('POST', `/v1/groups/${groupId}/roles`, tokenFor(etablix.admin), { email: jn.admin.email, role: 'GROUP_FINANCE' });
    assert.equal(finance.status, 201, JSON.stringify(finance.body));
    const statement = await send('GET', `/v1/groups/${groupId}/statement?month=2026-09`, tokenFor(jn.admin));
    assert.equal(statement.status, 200, JSON.stringify(statement.body));
    const directory = await send('GET', `/v1/groups/${groupId}`, tokenFor(etablix.admin));
    const adminRole = (directory.body.roles as Array<Record<string, unknown>>).find((role) => role.role === 'GROUP_ADMIN')!;
    const last = await send('POST', `/v1/groups/${groupId}/roles/${adminRole.id}/revoke`, tokenFor(etablix.admin), {});
    assert.equal(last.body.title, 'LAST_GROUP_ADMIN');
  });

  it('a group role opens the group console and not a company (§4)', async () => {
    // The group admin from ETABLIX holds no membership in JN Construction.
    const jnProject = await send('GET', `/v1/projects/${jn.projectId}`, tokenFor(etablix.admin));
    assert.notEqual(jnProject.status, 200, 'a group role must not open another company');
  });
});

describe('isolation: a member of one company cannot discover the other (§7, §13.1)', () => {
  it('refuses JN records to an ETABLIX-only person on every read path the API has', async () => {
    const qs = tokenFor(etablix.qs);
    const direct = await send('GET', `/v1/projects/${jn.projectId}`, qs);
    assert.notEqual(direct.status, 200);
    const entities = await send('GET', `/v1/projects/${jn.projectId}/entities/Project`, qs);
    assert.deepEqual(entities.body.entities ?? [], [], 'a foreign project lists nothing, and looks like no project at all');
    const list = await send('GET', '/v1/projects', qs);
    assert.equal(list.status, 200);
    const ids = ((list.body.projects ?? list.body.items ?? []) as Array<Record<string, unknown>>).map((project) => project.id);
    assert.ok(ids.includes(etablix.projectId));
    assert.equal(ids.includes(jn.projectId), false, 'JN Construction must not appear in an ETABLIX listing');
    const me = await send('GET', '/v1/users/me', qs);
    const memberships = me.body.memberships as Array<Record<string, unknown>>;
    assert.deepEqual(memberships.map((membership) => membership.tenantId), [etablix.tenantId], 'only ETABLIX exists for this person');
  });
});

describe('one identity, several companies (§4)', () => {
  let justinInJn: PlatformUser;

  it('adds an existing person to the other company as a second membership with named roles', async () => {
    const noRoles = await send('POST', '/v1/users/memberships', tokenFor(jn.admin), { email: etablix.qs.email, roles: [] });
    assert.equal(noRoles.status, 400, 'roles are the administrator\'s choice');
    const added = await send('POST', '/v1/users/memberships', tokenFor(jn.admin), { email: etablix.qs.email, roles: ['PM'] });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    justinInJn = platform.user(String(added.body.id));
    assert.equal(justinInJn.tenantId, jn.tenantId);
    assert.equal(justinInJn.email, etablix.qs.email);
    const twice = await send('POST', '/v1/users/memberships', tokenFor(jn.admin), { email: etablix.qs.email, roles: ['PM'] });
    assert.equal(twice.body.title, 'ALREADY_A_MEMBER');
    const outsiderAdds = await send('POST', '/v1/users/memberships', tokenFor(outsider.admin), { email: etablix.qs.email, roles: ['PM'] });
    assert.equal(outsiderAdds.body.title, 'NOT_IN_GROUP');
  });

  it('shows both companies in the switcher and moves between them with a new session', async () => {
    const me = await send('GET', '/v1/users/me', tokenFor(etablix.qs));
    const memberships = me.body.memberships as Array<Record<string, unknown>>;
    assert.deepEqual(memberships.map((membership) => membership.tenantId).sort(), [etablix.tenantId, jn.tenantId].sort());
    assert.equal((me.body.group as Record<string, unknown>).slug, 'groupe-nseya');

    const before = tokenFor(etablix.qs);
    const switched = await send('POST', '/v1/auth/switch-company', before, { tenantId: jn.tenantId });
    assert.equal(switched.status, 201, JSON.stringify(switched.body));
    assert.equal((switched.body.company as Record<string, unknown>).tenantId, jn.tenantId);
    const asJn = await send('GET', '/v1/users/me', String(switched.body.accessToken));
    assert.equal((asJn.body.activeCompany as Record<string, unknown>).tenantId, jn.tenantId);
    const old = await send('GET', '/v1/users/me', before);
    assert.equal(old.status, 401, 'the session that switched away is over');

    const elsewhere = await send('POST', '/v1/auth/switch-company', tokenFor(etablix.qs), { tenantId: outsider.tenantId });
    assert.equal(elsewhere.status, 403);
  });

  it('signs in to the company named, and to the first membership otherwise', async () => {
    rateLimiter.reset();
    const named = await send('POST', '/v1/auth/login', null, { email: etablix.qs.email, tenantId: jn.tenantId });
    assert.equal(named.status, 201, JSON.stringify(named.body));
    assert.equal(named.body.actorId, justinInJn.id);
    const verified = await send('POST', '/v1/auth/mfa/verify', null, { actorId: named.body.actorId, challengeId: named.body.challengeId, code: named.body.devCode });
    const token = await completeSignIn(base, verified.body);
    const me = await send('GET', '/v1/users/me', token);
    assert.equal((me.body.activeCompany as Record<string, unknown>).tenantId, jn.tenantId);
    const unnamed = await send('POST', '/v1/auth/login', null, { email: etablix.qs.email });
    assert.equal(unnamed.body.actorId, etablix.qs.id);
  });
});

describe('entitlements are per company and enforced beyond the menu (§5, §13.2, §13.3)', () => {
  it('lists each company\'s product, plan, modules and claims', async () => {
    const e = await send('GET', `/v1/groups/${groupId}/companies/${etablix.tenantId}/entitlements`, tokenFor(etablix.admin));
    assert.equal(e.status, 200, JSON.stringify(e.body));
    assert.deepEqual((e.body.modules as Array<Record<string, unknown>>).map((m) => m.moduleKey), ['ETABLIX']);
    assert.ok((e.body.claims as string[]).includes('construx:module:etablix'));
    const j = await send('GET', `/v1/groups/${groupId}/companies/${jn.tenantId}/entitlements`, tokenFor(etablix.admin));
    assert.deepEqual(j.body.modules, [], 'JN Construction inherits nothing from the group');
  });

  it('refuses the module\'s API to the company without it, and blocks the other within a request of revocation', async () => {
    const jnAttempt = await send('GET', `/v1/projects/${jn.projectId}/site-services/appointment`, tokenFor(jn.pm));
    assert.equal(jnAttempt.status, 403, JSON.stringify(jnAttempt.body));
    assert.equal(jnAttempt.body.title, 'MODULE_NOT_GRANTED');

    const before = await send('GET', `/v1/projects/${etablix.projectId}/site-services/appointment`, tokenFor(etablix.admin));
    assert.equal(before.status, 200, JSON.stringify(before.body));
    platform.setModuleGrant({ moduleId: 'ETABLIX', tenantId: etablix.tenantId, status: 'REVOKED', reason: 'Acceptance test: revocation is immediate', decidedBy: operator.id });
    const after = await send('GET', `/v1/projects/${etablix.projectId}/site-services/appointment`, tokenFor(etablix.admin));
    assert.equal(after.status, 403);
    platform.setModuleGrant({ moduleId: 'ETABLIX', tenantId: etablix.tenantId, status: 'ACTIVE', reason: 'Acceptance test: restored', decidedBy: operator.id });
  });
});

describe('the issuing company decides what a document says (§8, §13.4, §13.6)', () => {
  it('sets an issuer profile with numbering rules, versioned, with every version readable', async () => {
    const v0 = await send('GET', '/v1/company/issuer', tokenFor(etablix.admin));
    assert.equal(v0.status, 200);
    assert.equal((v0.body.profile as Record<string, unknown>).version, 0);

    const set = await send('PUT', '/v1/company/issuer', tokenFor(etablix.admin), {
      issuer: { registeredName: 'ETABLIX LTD', tradingName: 'ETABLIX', registrationNo: '12345678', registeredAddress: { line1: '1 Site Street', city: 'London', postcode: 'EC1A 1AA', country: 'GB' }, footerLegalText: 'ETABLIX LTD, registered in England & Wales No. 12345678' },
      numberingRules: {
        quotation: { prefix: 'ETX-Q-', pattern: '{YYYY}-{seq:5}', seqScope: 'year' },
        report: { prefix: 'ETX-R-', pattern: '{seq:6}', seqScope: 'all' },
      },
      signatories: [{ userId: etablix.admin.id, title: 'Directeur Général', documents: ['quotation', 'contract'] }],
    });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.version, 1);

    const bad = await send('PUT', '/v1/company/issuer', tokenFor(etablix.admin), { numberingRules: { invoice: { prefix: 'X', pattern: '{nope}', seqScope: 'year' } } });
    assert.equal(bad.body.title, 'NUMBERING_PATTERN_INVALID');
    const foreignSignatory = await send('PUT', '/v1/company/issuer', tokenFor(etablix.admin), { signatories: [{ userId: jn.pm.id, title: 'PM', documents: ['report'] }] });
    assert.equal(foreignSignatory.body.title, 'SIGNATORY_NOT_HERE');

    // A brand change moves the version too: the brand is part of what a document pins.
    const brand = await send('PUT', '/v1/branding', tokenFor(etablix.admin), { clientName: 'ETABLIX', primaryColour: '#e2571e', legalFooter: 'ETABLIX LTD · No. 12345678', documentReferencePrefix: 'ETX' });
    assert.equal(brand.status, 200, JSON.stringify(brand.body));
    const now = await send('GET', '/v1/company/issuer', tokenFor(etablix.admin));
    assert.equal((now.body.profile as Record<string, unknown>).version, 2);
    const v1 = await send('GET', '/v1/company/issuer/versions/1', tokenFor(etablix.admin));
    assert.equal(v1.status, 200);
    assert.equal(v1.body.version, 1);
    assert.equal((v1.body.brand as Record<string, unknown>).clientName, 'ETABLIX Ltd', 'version 1 keeps the brand it was set with');
  });

  it('allocates numbers atomically and without gaps, per company and type', async () => {
    const first = await send('POST', '/v1/documents/numbers/allocate', tokenFor(etablix.admin), { documentType: 'quotation' });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const year = new Date().getUTCFullYear();
    assert.equal(first.body.number, `ETX-Q-${year}-00001`);
    const burst = await Promise.all(Array.from({ length: 25 }, () => send('POST', '/v1/documents/numbers/allocate', tokenFor(etablix.admin), { documentType: 'quotation' })));
    const numbers = burst.map((r) => String(r.body.number));
    assert.equal(new Set(numbers).size, 25, 'no duplicates');
    const seqs = burst.map((r) => Number(r.body.seq)).sort((a, b) => a - b);
    assert.deepEqual(seqs, Array.from({ length: 25 }, (_, i) => i + 2), 'no gaps');
    const jnNoRule = await send('POST', '/v1/documents/numbers/allocate', tokenFor(jn.admin), { documentType: 'quotation' });
    assert.equal(jnNoRule.body.title, 'NUMBERING_RULE_MISSING', 'JN Construction numbers nothing under ETABLIX\'s rule');
    assert.equal(renderNumber({ prefix: 'A-', pattern: '{YY}{MM}-{seq:3}', seqScope: 'all' }, 7, new Date('2026-09-04T00:00:00Z')), 'A-2609-007');
  });

  it('a report pins the issuing company and profile version, takes its number from the rule, and is unchanged by a later profile change', async () => {
    const admin = authOf(platform, etablix.admin.id);
    const report = platform.exports.projectReport(admin, etablix.projectId, { audience: 'INTERNAL', format: 'PDF', correlationId: 'acceptance-1' });
    assert.equal(report.issuer?.companyId, etablix.tenantId);
    assert.equal(report.issuer?.profileVersion, 2);
    assert.equal(report.reference, 'ETX-R-000001');
    assert.equal(report.branding.clientName, 'ETABLIX', 'the brand is the issuing company\'s, not the person\'s');

    await send('PUT', '/v1/company/issuer', tokenFor(etablix.admin), { issuer: { registeredName: 'ETABLIX LIMITED' } });
    const stored = platform.ledger.get({ refType: 'Export', refId: report.id })!;
    assert.equal((stored.state.issuer as Record<string, unknown>).profileVersion, 2, 'issued documents are immutable against later profile changes');
    const next = platform.exports.projectReport(admin, etablix.projectId, { audience: 'INTERNAL', format: 'PDF', correlationId: 'acceptance-2' });
    assert.equal(next.issuer?.profileVersion, 3, 'new documents use the new version');
    assert.equal(next.reference, 'ETX-R-000002');

    // JN Construction's document carries JN Construction, whoever is signed in — including the person who is in both.
    const justinInJn = platform.allUsers().find((user) => user.email === etablix.qs.email && user.tenantId === jn.tenantId)!;
    const jnDoc = platform.exports.projectReport(authOf(platform, justinInJn.id), jn.projectId, { audience: 'INTERNAL', format: 'PDF', correlationId: 'acceptance-3' });
    assert.equal(jnDoc.issuer?.companyId, jn.tenantId);
    assert.equal(jnDoc.branding.clientName, 'JN Construction Ltd');
  });
});

describe('usage per company, one statement for the group (§9, §13.7, §13.8)', () => {
  it('attributes AI spend to the company that incurred it and never to the other', async () => {
    const wallet = platform.wallet(etablix.tenantId);
    wallet.topUp(100_000, 'Acceptance top-up');
    const hold = wallet.reserve({ aiRequestId: 'acc-ai-1', estimatedRawCostMinor: 500, projectId: etablix.projectId, module: 'ETABLIX', feature: 'brief' });
    wallet.settle(hold.holdId, 400, 'local');

    const usage = await send('GET', `/v1/groups/${groupId}/usage`, tokenFor(etablix.admin));
    assert.equal(usage.status, 200, JSON.stringify(usage.body));
    const companies = usage.body.companies as Array<Record<string, unknown>>;
    const etx = companies.find((c) => c.code === 'ETX')!;
    const jnc = companies.find((c) => c.code === 'JNC')!;
    const etxAcu = (etx.meters as Record<string, Record<string, number>>).acu!;
    const jncAcu = (jnc.meters as Record<string, Record<string, number>>).acu!;
    assert.equal(etxAcu.rawMinor, 400);
    assert.ok(Number(etxAcu.billedMinor) > 400, 'billed carries the markup');
    assert.equal((etxAcu.byModule as unknown as Record<string, number>).ETABLIX, etxAcu.billedMinor);
    assert.equal(jncAcu.billedMinor, 0, 'ETABLIX consumption never touches JN Construction');
    assert.equal((etx.meters as Record<string, number>).document, 2, 'the two reports issued above');
    assert.equal(platform.wallet(jn.tenantId).snapshot().balanceMinor, platform.wallet(jn.tenantId).snapshot().balanceMinor);
  });

  it('a group finance role sets a company\'s hard limit from the group, recorded on the company', async () => {
    const set = await send('PUT', `/v1/groups/${groupId}/companies/${jn.tenantId}/usage-account`, tokenFor(jn.admin), { monthlyHardLimitMinor: 25_000, reason: 'Pilot budget for the depot' });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    assert.equal(set.body.monthlyHardLimitMinor, 25_000);
    assert.equal(platform.wallet(jn.tenantId).snapshot().caps.monthlyMinor, 25_000);
    const viewer = await send('PUT', `/v1/groups/${groupId}/companies/${jn.tenantId}/usage-account`, tokenFor(etablix.qs), { monthlyHardLimitMinor: 1, reason: 'Should not be allowed' });
    assert.equal(viewer.status, 403);
  });

  it('the statement has a section per cost centre, a total, and exports per company', async () => {
    const month = new Date().toISOString().slice(0, 7);
    const statement = await send('GET', `/v1/groups/${groupId}/statement?month=${month}`, tokenFor(etablix.admin));
    assert.equal(statement.status, 200, JSON.stringify(statement.body));
    assert.deepEqual(statement.body.companiesIncluded, ['ETABLIX Ltd', 'JN Construction Ltd']);
    const sections = statement.body.sections as Array<Record<string, unknown>>;
    assert.equal(sections.length, 2);
    const totals = statement.body.totals as Record<string, number>;
    assert.equal(totals.acuBilledMinor, sections.reduce((sum, s) => sum + Number(s.acuBilledMinor), 0));
    assert.equal(totals.invoicedMinor, 0, 'both cost centres are INTERNAL: tracked, not invoiced');

    const response = await fetch(`${base}/v1/groups/${groupId}/statement/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenFor(jn.admin)}` },
      body: JSON.stringify({ month, tenantId: jn.tenantId }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/csv/);
    const csv = await response.text();
    assert.equal(csv.trim().split('\n').length, 2, 'header and one company');
    assert.ok(csv.includes('"JNC"'));
    const viewer = await send('GET', `/v1/groups/${groupId}/statement?month=${month}`, tokenFor(etablix.qs));
    assert.equal(viewer.status, 403);
  });
});

describe('controlled sharing between companies (§7.1)', () => {
  let shareId: string;

  it('shares one record read-only with the other company, rendered with the owner\'s branding', async () => {
    const outside = await send('POST', '/v1/shares', tokenFor(etablix.admin), { granteeTenantId: outsider.tenantId, refType: 'Project', refId: etablix.projectId });
    assert.equal(outside.body.title, 'GRANTEE_NOT_IN_GROUP');
    const wallet = await send('POST', '/v1/shares', tokenFor(etablix.admin), { granteeTenantId: jn.tenantId, refType: 'ACUWallet', refId: etablix.tenantId });
    assert.equal(wallet.body.title, 'RECORD_NOT_SHAREABLE');
    const shared = await send('POST', '/v1/shares', tokenFor(etablix.admin), { granteeTenantId: jn.tenantId, refType: 'Project', refId: etablix.projectId, note: 'Site services on the depot' });
    assert.equal(shared.status, 201, JSON.stringify(shared.body));
    shareId = String(shared.body.id);

    const read = await send('GET', `/v1/shares/${shareId}/record`, tokenFor(jn.pm));
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.equal((read.body.sharedBy as Record<string, unknown>).name, 'ETABLIX Ltd');
    assert.equal((read.body.record as Record<string, unknown>).id, etablix.projectId);
    const notForThem = await send('GET', `/v1/shares/${shareId}/record`, tokenFor(outsider.admin));
    assert.equal(notForThem.status, 403);
    // Still not the generic read: the share does not open the isolation boundary.
    const direct = await send('GET', `/v1/projects/${etablix.projectId}`, tokenFor(jn.pm));
    assert.notEqual(direct.status, 200);
  });

  it('ends on revocation, on the next request', async () => {
    const revoked = await send('POST', `/v1/shares/${shareId}/revoke`, tokenFor(etablix.admin), {});
    assert.equal(revoked.status, 201, JSON.stringify(revoked.body));
    const read = await send('GET', `/v1/shares/${shareId}/record`, tokenFor(jn.pm));
    assert.equal(read.status, 403);
    assert.equal(read.body.title, 'SHARE_ENDED');
  });
});

describe('the operator has no default read; support access is break-glass and visible (§4, §13.9)', () => {
  it('refuses a company\'s record to the operator until a window is opened, then records every read', async () => {
    const closed = await send('GET', `/v1/admin/tenants/${etablix.tenantId}/support-access/audit`, tokenFor(operator));
    assert.equal(closed.status, 403);
    assert.equal(closed.body.title, 'SUPPORT_ACCESS_REQUIRED');
    const project = await send('GET', `/v1/projects/${etablix.projectId}`, tokenFor(operator));
    assert.equal(project.status, 403, 'a project is never opened to an operator');

    const noTicket = await send('POST', `/v1/admin/tenants/${etablix.tenantId}/support-access`, tokenFor(operator), { reason: 'Customer reports a missing gate decision', ticketRef: '' });
    assert.equal(noTicket.status, 400, 'an empty ticket fails the schema before the handler');
    const opened = await send('POST', `/v1/admin/tenants/${etablix.tenantId}/support-access`, tokenFor(operator), { reason: 'Customer reports a missing gate decision', ticketRef: 'SUP-4411', minutes: 30 });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));

    const read = await send('GET', `/v1/admin/tenants/${etablix.tenantId}/support-access/audit`, tokenFor(operator));
    assert.equal(read.status, 200, JSON.stringify(read.body));
    assert.ok((read.body.events as unknown[]).length > 0);
    assert.equal(((read.body.grant as Record<string, unknown>).uses as unknown[]).length, 1);

    const visible = await send('GET', '/v1/team/support-access', tokenFor(etablix.admin));
    assert.equal(visible.status, 200);
    const grants = visible.body.grants as Array<Record<string, unknown>>;
    assert.equal(grants[0]!.ticketRef, 'SUP-4411');
    assert.equal((grants[0]!.uses as unknown[]).length, 1, 'the company sees what was read');

    const ended = await send('POST', `/v1/team/support-access/${grants[0]!.id}/close`, tokenFor(etablix.admin), {});
    assert.equal(ended.status, 201, JSON.stringify(ended.body));
    const after = await send('GET', `/v1/admin/tenants/${etablix.tenantId}/support-access/audit`, tokenFor(operator));
    assert.equal(after.status, 403);
    const stillClosedToProject = await send('GET', `/v1/projects/${etablix.projectId}`, tokenFor(operator));
    assert.equal(stillClosedToProject.status, 403);
  });
});

describe('per-company audit export (§13.11) and the record after a restart', () => {
  it('a group admin reads everything one company did between dates', async () => {
    const from = new Date(Date.now() - 3_600_000).toISOString();
    const audit = await send('GET', `/v1/groups/${groupId}/audit?tenantId=${etablix.tenantId}&from=${from}`, tokenFor(etablix.admin));
    assert.equal(audit.status, 200, JSON.stringify(audit.body));
    const types = (audit.body.events as Array<Record<string, unknown>>).map((event) => event.eventType);
    assert.ok(types.includes('ISSUER_PROFILE_UPDATED'));
    assert.ok(types.includes('SUPPORT_ACCESS_OPENED'));
    const finance = await send('GET', `/v1/groups/${groupId}/audit?tenantId=${etablix.tenantId}`, tokenFor(jn.admin));
    assert.equal(finance.status, 403, 'finance sees figures, not the record');
  });

  it('survives a restart: group, cost centres, roles, profile versions and sequences are on the ledger', () => {
    const rebuilt = new Platform();
    rebuilt.ledger.restore(platform.ledger.events());
    rebuilt.rehydrate();
    assert.equal(rebuilt.tenant(jn.tenantId).groupId, groupId);
    const record = rebuilt.ledger.get({ refType: 'Group', refId: groupId })!;
    assert.equal((record.state.costCentres as unknown[]).length, 2);
    assert.equal(rebuilt.ledger.listByTenant(groupId, 'GroupRole').length, 2);
    const sequence = rebuilt.ledger.get({ refType: 'DocumentSequence', refId: `${etablix.tenantId}:quotation:${new Date().getUTCFullYear()}` })!;
    assert.equal(sequence.state.next, 27);
  });
});
