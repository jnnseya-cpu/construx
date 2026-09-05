import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import { rateLimiter, resetIdempotency } from '../src/api/middleware.ts';
import * as collection from '../src/billing/collection.ts';
import { GROUP_LICENCE, PACKAGES } from '../src/billing/seats.ts';
import { groupOfTenant, groupRolesFor } from '../src/group/directory.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import { completeSignIn } from './helpers.ts';

/**
 * A group that runs itself.
 *
 * Asked as: how does a company signing up say it is a group account rather
 * than a normal one, and how does it create the administrators of its
 * organisations? Until now a group was the operator's to found and the
 * operator's to extend, company by company. Now:
 *
 *   - The signup form asks for the account structure. "A group of companies"
 *     founds the group on verification, with the organisation named as its
 *     first company and the person as its first group administrator.
 *   - The group administrator adds the other organisations from the Group
 *     screen — each a tenancy of its own on a paid package, with one or more
 *     administrators named and invited — up to what the licence covers.
 *   - Nothing is free unless the package is: each company's first month is
 *     charged and the company waits for it, and the group sees what is owed.
 */

let platform: Platform;
let server: Server;
let base: string;
let operatorToken: string;

async function call(method: string, path: string, token?: string, payload?: unknown) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

async function signUp(input: { email: string; organisationName: string; package: string; structure?: string }) {
  rateLimiter.reset();
  const started = await call('POST', '/v1/signup', undefined, {
    email: input.email,
    contactName: 'Justin Nseya',
    organisationName: input.organisationName,
    jurisdiction: 'GB',
    currency: 'GBP',
    package: input.package,
    ...(input.structure ? { structure: input.structure } : {}),
  });
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const verified = await call('POST', '/v1/signup/verify', undefined, { registrationId: started.body.registrationId, token: started.body.devToken });
  assert.equal(verified.status, 201, JSON.stringify(verified.body));
  const user = platform.userByEmail(input.email);
  assert.ok(user, `${input.email} was not provisioned`);
  return { verified: verified.body, tenantId: user.tenantId, userId: user.id };
}

async function signIn(email: string): Promise<string> {
  rateLimiter.reset();
  const login = await call('POST', '/v1/auth/login', undefined, { email });
  assert.equal(login.status, 201, JSON.stringify(login.body));
  const verified = await call('POST', '/v1/auth/mfa/verify', undefined, { actorId: login.body.actorId, challengeId: login.body.challengeId, code: login.body.devCode });
  assert.equal(verified.status, 201, JSON.stringify(verified.body));
  return completeSignIn(base, verified.body);
}

function tokenFor(userId: string): string {
  const user = platform.user(userId);
  return issueTokens({ actorId: user.id, tenantId: user.tenantId, partyId: user.partyId, roles: user.roles, mfaSatisfied: true }).accessToken;
}

const company = (name: string, administrators: Array<{ name: string; email: string }>, over: Record<string, unknown> = {}) => ({
  displayName: name,
  jurisdiction: 'GB',
  currency: 'GBP',
  package: 'CORE_PROJECT',
  administrators,
  ...over,
});

before(async () => {
  platform = new Platform();
  collection.setCollector(collection.NO_PAYMENT_METHOD);
  const operator = platform.createUser({ tenantId: 'platform', name: 'Ops', email: 'ops@construx.example', roles: ['PLATFORM_ADMIN'] });
  operatorToken = tokenFor(operator.id);
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  resetIdempotency();
});

after(() => {
  server.close();
});

describe('the account structure at signup', () => {
  it('offers the two structures with the licence’s count, from the server', async () => {
    const offer = await call('GET', '/v1/signup/account-types');
    assert.equal(offer.status, 200);
    assert.deepEqual(
      offer.body.structures.map((s: { structure: string }) => s.structure),
      ['COMPANY', 'GROUP'],
    );
    assert.equal(offer.body.groupLicence.maxCompanies, GROUP_LICENCE.maxCompanies);
    assert.match(offer.body.structures[1].detail, new RegExp(`up to ${GROUP_LICENCE.maxCompanies}`));
  });

  it('founds nothing when a single company is asked for, or when nothing is said', async () => {
    const plain = await signUp({ email: 'owner@single-co.example', organisationName: 'Single Co Ltd', package: 'SOLO' });
    assert.equal(plain.verified.structure, 'COMPANY');
    assert.equal(plain.verified.group, null);
    assert.equal(platform.tenant(plain.tenantId).groupId, undefined);
  });
});

describe('JNN GLOBAL LTD signs up as a group of companies', () => {
  const founderEmail = 'justin@jnnglobal.example';
  let holdingTenantId: string;
  let groupId: string;
  let founderToken: string;

  before(async () => {
    const signed = await signUp({ email: founderEmail, organisationName: 'JNN GLOBAL LTD', package: 'CORE_PROJECT', structure: 'GROUP' });
    holdingTenantId = signed.tenantId;
    assert.equal(signed.verified.structure, 'GROUP');
    assert.ok(signed.verified.group, 'verification founded no group');
    groupId = signed.verified.group.id;
    assert.equal(signed.verified.group.displayName, 'JNN GLOBAL LTD');
    assert.equal(signed.verified.group.maxCompanies, GROUP_LICENCE.maxCompanies);
  });

  it('is the group’s first company, and the signer its first group administrator', () => {
    const group = groupOfTenant(platform, holdingTenantId);
    assert.ok(group, 'the holding company is in no group');
    assert.equal(group.id, groupId);
    assert.equal(group.slug, 'jnn-global-ltd');
    assert.equal(group.costCentres.length, 1);
    assert.equal(group.costCentres[0]!.code, 'JNN');
    assert.deepEqual(groupRolesFor(platform, groupId, founderEmail), ['GROUP_ADMIN']);
    // The paywall is unchanged by the structure: the holding company is on a
    // paid package and waits for its first month like any signup.
    assert.equal(platform.subscription(holdingTenantId).status, 'AWAITING_PAYMENT');
  });

  it('shows the founder the group console with room for the other companies', async () => {
    founderToken = await signIn(founderEmail);
    const me = await call('GET', '/v1/users/me', founderToken);
    assert.equal(me.body.group.id, groupId);
    assert.deepEqual(me.body.group.roles, ['GROUP_ADMIN']);

    const directory = await call('GET', `/v1/groups/${groupId}`, founderToken);
    assert.equal(directory.status, 200, JSON.stringify(directory.body));
    assert.equal(directory.body.companies.length, 1);
    assert.equal(directory.body.maxCompanies, GROUP_LICENCE.maxCompanies);
    assert.equal(directory.body.companies[0].awaitingFirstPayment, true);
    assert.equal(directory.body.companies[0].outstandingMinor, PACKAGES.CORE_PROJECT.monthlyPriceMinor);
    assert.match(directory.body.companies[0].paymentReference, /^CX-[A-Z0-9]{8}$/);
    assert.deepEqual(
      directory.body.packages.map((p: { package: string }) => p.package),
      ['SOLO', 'CORE_PROJECT', 'PROFESSIONAL_DELIVERY'],
      'the form offers the paid self-serve packages and nothing the operator provisions',
    );
    assert.ok(directory.body.jurisdictions.some((j: { code: string }) => j.code === 'GB'));
  });

  it('lets the founder add an organisation with two administrators, each invited', async () => {
    const added = await call('POST', `/v1/groups/${groupId}/companies`, founderToken, company('JNN Homes Ltd', [
      { name: 'Kemi Adeyemi', email: 'kemi@jnnhomes.example' },
      { name: 'Rowan Blake', email: 'rowan@jnnhomes.example' },
    ]));
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal(added.body.company.name, 'JNN Homes Ltd');
    assert.equal(added.body.company.code, 'JNN2', 'the code is derived, and does not collide with the holding company’s');
    assert.equal(added.body.administrators.length, 2);
    assert.equal(added.body.companies, 2);
    assert.equal(added.body.invitations.length, 2);
    assert.ok(added.body.invitations.every((i: { notified: string }) => ['SENT', 'RECORDED', 'QUEUED'].includes(i.notified)), JSON.stringify(added.body.invitations));

    const tenantId = added.body.company.tenantId as string;
    for (const email of ['kemi@jnnhomes.example', 'rowan@jnnhomes.example']) {
      const admin = platform.users(tenantId).find((user) => user.email === email);
      assert.ok(admin, `${email} was not created in the new company`);
      assert.deepEqual(admin.roles, ['OWNER', 'ENTERPRISE_ADMIN']);
    }
    // Its own group membership; open at once, on the holding company's package
    // and covered by its subscription — a company under a group pays nothing.
    assert.equal(platform.tenant(tenantId).groupId, groupId);
    assert.equal(platform.subscription(tenantId).status, 'ACTIVE');
    assert.equal(platform.subscription(tenantId).package, platform.subscription(holdingTenantId).package);
    assert.equal(platform.subscription(tenantId).grantedFree, true);
    assert.equal(added.body.openingCharge, null, 'no first month of its own');
    assert.equal((added.body.coveredBy as { tenantId: string }).tenantId, holdingTenantId);
    assert.equal(collection.outstanding(platform, tenantId).length, 0);
    assert.equal(platform.wallet(tenantId).snapshot().balanceMinor, 0, 'a group company was credited before anything was paid');

    // And its administrator can start a sign-in.
    rateLimiter.reset();
    const login = await call('POST', '/v1/auth/login', undefined, { email: 'kemi@jnnhomes.example' });
    assert.equal(login.status, 201);
    assert.ok(login.body.challengeId);
  });

  it('adds somebody already in the group as a second membership, not a second person', async () => {
    const added = await call('POST', `/v1/groups/${groupId}/companies`, founderToken, company('JNN Civils Ltd', [
      { name: 'Kemi Adeyemi', email: 'kemi@jnnhomes.example' },
    ]));
    assert.equal(added.status, 201, JSON.stringify(added.body));
    assert.equal(added.body.administrators[0].existing, true);
    const me = await call('GET', '/v1/users/me', tokenFor(added.body.administrators[0].id));
    assert.equal(me.body.memberships.length, 2, 'one address, two companies, one identity');
  });

  it('refuses an address held outside the group, and creates nothing', async () => {
    const before = groupOfTenant(platform, holdingTenantId)!.costCentres.length;
    const refused = await call('POST', `/v1/groups/${groupId}/companies`, founderToken, company('JNN Plant Ltd', [
      { name: 'Somebody Else', email: 'owner@single-co.example' },
    ]));
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.title, 'EMAIL_IN_USE');
    assert.equal(groupOfTenant(platform, holdingTenantId)!.costCentres.length, before);
    assert.equal(platform.userByEmail('owner@single-co.example')!.tenantId !== holdingTenantId, true);
  });

  it('is the group administrator’s act: a company administrator without the role is refused', async () => {
    const kemi = platform.users(groupOfTenant(platform, holdingTenantId)!.costCentres[1]!.tenantId).find((u) => u.email === 'kemi@jnnhomes.example')!;
    const refused = await call('POST', `/v1/groups/${groupId}/companies`, tokenFor(kemi.id), company('Rogue Ltd', [{ name: 'Rogue Admin', email: 'r@rogue.example' }]));
    assert.equal(refused.status, 403);
    assert.equal(refused.body.title, 'GROUP_ROLE_REQUIRED');
  });

  it('puts the company on the holding company’s package whatever the request names', async () => {
    // The group's package is the enterprise account's. A request naming Solo
    // gets the holding company's Core Project, covered, with both seats held.
    const added = await call('POST', `/v1/groups/${groupId}/companies`, founderToken, company('JNN Solo Ltd', [
      { name: 'One Person', email: 'one@jnnsolo.example' },
      { name: 'Two Person', email: 'two@jnnsolo.example' },
    ], { package: 'SOLO' }));
    assert.equal(added.status, 201, JSON.stringify(added.body));
    const tenantId = added.body.company.tenantId as string;
    assert.equal(platform.subscription(tenantId).package, platform.subscription(holdingTenantId).package);
    assert.equal(platform.subscription(tenantId).grantedFree, true);
    assert.equal((added.body.coveredBy as { package: string }).package, platform.subscription(holdingTenantId).package);
  });

  it('refuses more administrators than the group’s package seats, before anything is created', async () => {
    // A group whose enterprise account is on Solo carries one seat per company.
    const solo = await signUp({ email: 'owner@solo-group.example', organisationName: 'Solo Group Ltd', package: 'SOLO', structure: 'GROUP' });
    const soloToken = await signIn('owner@solo-group.example');
    const soloGroupId = solo.verified.group.id as string;
    const before = groupOfTenant(platform, solo.tenantId)!.costCentres.length;
    const refused = await call('POST', `/v1/groups/${soloGroupId}/companies`, soloToken, company('Solo Sub Ltd', [
      { name: 'One Person', email: 'one@solosub.example' },
      { name: 'Two Person', email: 'two@solosub.example' },
    ]));
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    assert.equal(refused.body.title, 'SEAT_LIMIT_REACHED');
    assert.match(String(refused.body.detail), /Solo Group Ltd's Solo package/);
    assert.equal(groupOfTenant(platform, solo.tenantId)!.costCentres.length, before, 'a refused company was attached anyway');
    assert.equal(platform.userByEmail('one@solosub.example'), undefined, 'a refused company left an administrator behind');
  });

  it('names a further administrator for one of its companies, once', async () => {
    const tenantId = groupOfTenant(platform, holdingTenantId)!.costCentres[1]!.tenantId;
    const appointed = await call('POST', `/v1/groups/${groupId}/companies/${tenantId}/administrators`, founderToken, { name: 'Esi Mensah', email: 'esi@jnnhomes.example' });
    assert.equal(appointed.status, 201, JSON.stringify(appointed.body));
    assert.equal(appointed.body.administrator.existing, false);
    assert.equal(appointed.body.invitations.length, 1);
    assert.deepEqual(platform.users(tenantId).find((u) => u.email === 'esi@jnnhomes.example')!.roles, ['OWNER', 'ENTERPRISE_ADMIN']);

    const again = await call('POST', `/v1/groups/${groupId}/companies/${tenantId}/administrators`, founderToken, { name: 'Esi Mensah', email: 'esi@jnnhomes.example' });
    assert.equal(again.status, 409);
    assert.equal(again.body.title, 'ALREADY_A_MEMBER');

    const elsewhere = await call('POST', `/v1/groups/${groupId}/companies/${platform.userByEmail('owner@single-co.example')!.tenantId}/administrators`, founderToken, { name: 'Xavier Nobody', email: 'x@x.example' });
    assert.equal(elsewhere.status, 404, 'a company outside the group must read as no company');
  });

  it('stops at what the licence covers', async () => {
    let held = groupOfTenant(platform, holdingTenantId)!.costCentres.length;
    while (held < GROUP_LICENCE.maxCompanies) {
      const added = await call('POST', `/v1/groups/${groupId}/companies`, founderToken, company(`JNN Sub ${held} Ltd`, [{ name: 'Admin', email: `admin${held}@jnnsub.example` }], { package: 'SOLO' }));
      assert.equal(added.status, 201, JSON.stringify(added.body));
      held = added.body.companies;
    }
    const sixth = await call('POST', `/v1/groups/${groupId}/companies`, founderToken, company('One Too Many Ltd', [{ name: 'Admin', email: 'toomany@jnnsub.example' }]));
    assert.equal(sixth.status, 409, JSON.stringify(sixth.body));
    assert.equal(sixth.body.title, 'GROUP_FULL');
    assert.equal(platform.userByEmail('toomany@jnnsub.example'), undefined, 'a refused company left an administrator behind');
  });

  it('shows the holding company open once the operator records its first month', async () => {
    const charge = collection.chargesFor(platform, holdingTenantId)[0]!;
    const settled = await call('POST', `/v1/admin/tenants/${holdingTenantId}/charges/${charge.id}/settle`, operatorToken, { reference: 'BACS-JNN-0001', method: 'BANK_TRANSFER' });
    assert.equal(settled.status, 201, JSON.stringify(settled.body));
    const directory = await call('GET', `/v1/groups/${groupId}`, founderToken);
    const holding = directory.body.companies.find((c: { tenantId: string }) => c.tenantId === holdingTenantId);
    assert.equal(holding.awaitingFirstPayment, false);
    assert.equal(holding.outstandingMinor, 0);
    assert.equal(holding.paymentReference, null);
    // The companies the administrator added never waited: a company under a
    // group is open from creation, on the holding company's package, covered.
    assert.equal(directory.body.companies.filter((c: { awaitingFirstPayment: boolean }) => c.awaitingFirstPayment).length, 0);
    assert.equal(directory.body.companies.filter((c: { coveredByGroup: boolean }) => c.coveredByGroup).length, GROUP_LICENCE.maxCompanies - 1);
    assert.equal(directory.body.companies.length, GROUP_LICENCE.maxCompanies);
  });

  it('gives a second group with the same name its own slug', async () => {
    const twin = await signUp({ email: 'twin@jnnglobal-other.example', organisationName: 'JNN GLOBAL LTD', package: 'SOLO', structure: 'GROUP' });
    assert.equal(twin.verified.group.slug, 'jnn-global-ltd-2');
    assert.notEqual(twin.verified.group.id, groupId);
  });
});
