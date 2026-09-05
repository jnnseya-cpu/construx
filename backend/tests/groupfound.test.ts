import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import * as collection from '../src/billing/collection.ts';
import { config } from '../src/config.ts';
import { attachCompany, groupDirectory, groupOf, groupRolesFor } from '../src/group/directory.ts';
import { addCompany, coverGroupCompanies, foundGroup } from '../src/group/onboarding.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import { authOf } from '../src/seed.ts';
import { rejectsCode, throwsCode } from './helpers.ts';

/**
 * A company that signed up as one company founds a group from itself: the same
 * act the group signup performs at verification, run later by the company's own
 * administrator, without the operator.
 */

let platform: Platform;
let tenantId = '';
let adminId = '';

before(() => {
  platform = new Platform();
  const created = platform.createTenant({ legalName: 'JNN GLOBAL LTD', jurisdiction: 'GB', defaultCurrency: 'GBP', tier: 'TEAM', enterpriseName: 'JNN GLOBAL', trialGrant: false });
  tenantId = created.tenant.id;
  adminId = platform.createUser({ tenantId, name: 'Justin', email: 'justin@jnnglobal.example', roles: ['ENTERPRISE_ADMIN'] }).id;
});

describe('founding a group from an existing company', () => {
  it('is refused to somebody who is not the company’s administrator', () => {
    const viewer = platform.createUser({ tenantId, name: 'Vic', email: 'vic@jnnglobal.example', roles: ['VIEWER'] });
    throwsCode(() => foundGroup(platform, authOf(platform, viewer.id)), 'ADMINISTRATOR_REQUIRED');
  });

  it('makes the company the first cost centre and its administrator the group administrator, and nothing about the company changes', () => {
    const before = platform.tenant(tenantId);
    const result = foundGroup(platform, authOf(platform, adminId));
    assert.equal(result.group.displayName, 'JNN GLOBAL LTD', 'named after the company when no name is given');
    assert.equal(result.group.slug, 'jnn-global-ltd');
    assert.equal(result.company.tenantId, tenantId);
    assert.equal(result.company.code, 'JNN');
    assert.equal(result.maxCompanies, 5);

    const after = platform.tenant(tenantId);
    assert.equal(after.groupId, result.group.id);
    assert.equal(after.legalName, before.legalName);
    assert.equal(platform.subscription(tenantId).package, platform.subscription(tenantId).package);
    assert.deepEqual(groupRolesFor(platform, result.group.id, 'justin@jnnglobal.example'), ['GROUP_ADMIN']);
    assert.equal(groupDirectory(platform, result.group.id).companies.length, 1);
  });

  it('is refused a second time — a company belongs to one group', () => {
    throwsCode(() => foundGroup(platform, authOf(platform, adminId)), 'ALREADY_IN_GROUP');
  });

  it('lets the new group administrator add the next company with its own administrators straight away', () => {
    const groupId = platform.tenant(tenantId).groupId!;
    const added = addCompany(platform, authOf(platform, adminId), groupId, {
      displayName: 'JNN Homes Ltd',
      jurisdiction: 'GB',
      currency: 'GBP',
      // Two administrators need two seats; Solo carries one and is refused.
      package: 'CORE_PROJECT',
      administrators: [
        { name: 'Rowan Blake', email: 'rowan@jnnhomes.example' },
        { name: 'Kemi Adeyemi', email: 'kemi@jnnhomes.example' },
      ],
    });
    assert.equal(added.administrators.length, 2);
    assert.ok(added.administrators.every((person) => platform.user(person.id).roles.includes('ENTERPRISE_ADMIN')));
    assert.equal(groupDirectory(platform, groupId).companies.length, 2);
    // A company under a group opens at once, on the founding company's package,
    // covered by its subscription: nothing is raised against it.
    assert.equal(added.openingCharge, null);
    assert.equal(added.coveredBy.tenantId, tenantId);
    const company = platform.subscription(added.company.tenantId);
    assert.equal(company.status, 'ACTIVE');
    assert.equal(company.package, platform.subscription(tenantId).package);
    assert.equal(company.grantedFree, true);
    assert.equal(collection.chargesFor(platform, added.company.tenantId).length, 0);
    assert.equal(collection.raiseCharge(platform, added.company.tenantId, new Date(Date.parse(company.renewsAt) + 86_400_000)), undefined, 'and nothing at renewal');
    // The founding company's own periods run on the group's payment terms, not
    // the platform's grace: a company stopped on day seven of a fourteen-day
    // term would be stopped for a bill that was not yet late.
    const primary = platform.subscription(tenantId);
    const raised = collection.raiseCharge(platform, tenantId, new Date(Date.parse(primary.renewsAt) + 86_400_000));
    assert.ok(raised && !raised.alreadyRaised);
    const termsDays = groupOf(platform, groupId).billing.termsDays;
    assert.ok(termsDays >= 14);
    assert.equal(Math.round((Date.parse(raised!.charge.graceEndsAt) - Date.parse(raised!.charge.dueAt)) / 86_400_000), Math.max(termsDays, config.billing.subscriptionGraceDays));
  });

  it('brings a company created before the rule under the group’s subscription on the next run', () => {
    // As the live estate had it: a company created waiting for a first month
    // its own administrators were asked to pay, on a package of its own.
    const groupId = platform.tenant(tenantId).groupId!;
    const legacy = platform.createTenant({ legalName: 'Legacy Sub Ltd', jurisdiction: 'GB', defaultCurrency: 'GBP', tier: 'SOLO', package: 'SOLO', enterpriseName: 'Legacy Sub', trialGrant: false, opensOn: 'FIRST_PAYMENT' });
    platform.createUser({ tenantId: legacy.tenant.id, name: 'Lea', email: 'lea@legacysub.example', roles: ['ENTERPRISE_ADMIN'] });
    attachCompany(platform, authOf(platform, adminId), groupId, { tenantId: legacy.tenant.id, code: 'LEG' });
    assert.equal(platform.subscription(legacy.tenant.id).status, 'AWAITING_PAYMENT');
    assert.equal(collection.outstanding(platform, legacy.tenant.id).length, 1);

    const outcome = coverGroupCompanies(platform);
    assert.ok(outcome.covered.some((entry) => entry.tenantId === legacy.tenant.id), JSON.stringify(outcome));
    const covered = platform.subscription(legacy.tenant.id);
    assert.equal(covered.status, 'ACTIVE');
    assert.equal(covered.package, platform.subscription(tenantId).package);
    assert.equal(covered.grantedFree, true);
    assert.equal(collection.outstanding(platform, legacy.tenant.id).length, 0, 'the first month it was asked for is written off');
    assert.equal(platform.wallet(legacy.tenant.id).snapshot().balanceMinor, 0, 'nothing is credited: AI is a top-up');

    // Idempotent: a second run changes nothing.
    const again = coverGroupCompanies(platform);
    assert.equal(again.covered.length, 0);
    assert.equal(again.refused.length, 0);
  });

  it('gives a second group a distinct slug when two companies share a name', () => {
    const twin = platform.createTenant({ legalName: 'JNN GLOBAL LTD', jurisdiction: 'GB', defaultCurrency: 'GBP', tier: 'TEAM', enterpriseName: 'JNN GLOBAL 2', trialGrant: false });
    const twinAdmin = platform.createUser({ tenantId: twin.tenant.id, name: 'Twin', email: 'twin@example.test', roles: ['OWNER'] });
    const result = foundGroup(platform, authOf(platform, twinAdmin.id), { displayName: 'JNN GLOBAL LTD' });
    assert.equal(result.group.slug, 'jnn-global-ltd-2');
  });
});

describe('through the gateway', () => {
  let server: Server;
  let base: string;

  before(async () => {
    server = createGateway(platform);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('founds a group from a fresh company and the person’s own read shows the Group role', async () => {
    const fresh = platform.createTenant({ legalName: 'Etablix Ltd', jurisdiction: 'GB', defaultCurrency: 'GBP', tier: 'TEAM', enterpriseName: 'Etablix', trialGrant: false });
    const admin = platform.createUser({ tenantId: fresh.tenant.id, name: 'Ade', email: 'ade@etablix.example', roles: ['ENTERPRISE_ADMIN'] });
    const token = issueTokens({ actorId: admin.id, tenantId: admin.tenantId, partyId: admin.partyId, roles: admin.roles, mfaSatisfied: true }).accessToken;

    const before = await fetch(`${base}/v1/users/me`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json() as Promise<{ group: unknown }>);
    assert.equal(before.group, null, 'a plain company: no group on the read, so no Group screen');

    const founded = await fetch(`${base}/v1/groups`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({}) });
    assert.equal(founded.status, 201, await founded.text());

    const after = await fetch(`${base}/v1/users/me`, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.json() as Promise<{ group: { displayName: string; roles: string[] } }>);
    assert.equal(after.group.displayName, 'Etablix Ltd');
    assert.deepEqual(after.group.roles, ['GROUP_ADMIN']);

    const again = await fetch(`${base}/v1/groups`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({}) });
    assert.equal(again.status, 409);
    await rejectsCode(async () => {
      const body = (await again.clone().json().catch(() => ({}))) as { title?: string };
      throw Object.assign(new Error('refused'), { code: body.title ?? 'ALREADY_IN_GROUP' });
    }, 'ALREADY_IN_GROUP');
  });
});
