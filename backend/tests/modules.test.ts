import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { createGateway } from '../src/api/gateway.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { MODULES, grantRef, isModuleId, requireModule, type ModuleId } from '../src/identity/modules.ts';
import { Platform, PLATFORM_TENANT_ID } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Private modules: who holds one, who decided, and who is never told it exists.
 *
 * A module is capability that lives in this codebase, runs against this ledger
 * and this permission matrix, and is reachable only by the tenancies a platform
 * operator has explicitly granted it to. Two properties have to hold, and the
 * second is the one that is easy to lose:
 *
 * 1. **A tenancy without the grant is refused.** Fail-closed, including on a
 *    module id that does not exist — a typo in an access check must never
 *    resolve to "allowed".
 * 2. **A tenancy without the grant is not told the module exists.** Refusing a
 *    request is not enough if the console publishes the catalogue to everybody:
 *    the module would be invisible only in the sense that a locked door is.
 *
 * Everything else here is the audit question. A grant is an act, not a derived
 * state, so "who gave this company access, and when, and why" has an answer,
 * and so does "who used to have it".
 */

let platform: Platform;
let seed: SeedResult;
let server: Server;
let base: string;
/** A second tenancy, so "granted" and "not granted" can be told apart. */
let otherTenantId: string;
let otherAdminToken: string;

const MODULE: ModuleId = 'ETABLIX';

function tokenFor(who: string): string {
  const user = platform.user(seed.users[who]!.id);
  return issueTokens({
    actorId: user.id,
    tenantId: user.tenantId,
    partyId: user.partyId,
    roles: user.roles,
    mfaSatisfied: true,
  }).accessToken;
}

async function call(
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: response.status, body };
}

const tenantId = () => seed.users.pm!.auth.tenantId;
const operatorId = () => seed.users.operator!.id;

function grant(reason = 'Delivering site services with ETABLIX on the northern framework'): void {
  platform.setModuleGrant({
    moduleId: MODULE,
    tenantId: tenantId(),
    status: 'ACTIVE',
    reason,
    decidedBy: operatorId(),
  });
}

function revoke(reason = 'Framework ended'): void {
  platform.setModuleGrant({
    moduleId: MODULE,
    tenantId: tenantId(),
    status: 'REVOKED',
    reason,
    decidedBy: operatorId(),
  });
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  const created = platform.createTenant({
    legalName: 'Halden Regional Contractors Ltd',
    jurisdiction: 'GB',
    defaultCurrency: 'GBP',
    tier: 'BUSINESS',
    enterpriseName: 'Halden Group',
  });
  otherTenantId = created.tenant.id;
  const otherAdmin = platform.createUser({
    tenantId: otherTenantId,
    name: 'Priya Raman',
    email: 'priya.raman@halden.example',
    roles: ['ENTERPRISE_ADMIN'],
  });
  otherAdminToken = issueTokens({
    actorId: otherAdmin.id,
    tenantId: otherAdmin.tenantId,
    partyId: otherAdmin.partyId,
    roles: otherAdmin.roles,
    mfaSatisfied: true,
  }).accessToken;

  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => {
  // Left revoked so a later suite in the same file cannot inherit a grant.
  server.close();
});

describe('the module gate', () => {
  it('refuses a tenancy that does not hold the module', () => {
    const error = throwsCode(() => requireModule([], MODULE), 'MODULE_NOT_GRANTED');
    // A 403, deliberately not a 404. Pretending the route does not exist is
    // obscurity against somebody who can already read the route list, and it
    // makes a genuine misconfiguration — a company that should hold the module
    // and does not — indistinguishable from a typo.
    assert.equal((error as { status?: number }).status, 403);
    assert.match(String(error.message), /ETABLIX AI Site Services/);
  });

  it('permits a tenancy that holds it', () => {
    assert.doesNotThrow(() => requireModule([MODULE], MODULE));
  });

  it('fails closed on a module id that does not exist', () => {
    // The worst direction for an access check to fail. A typo in a module name
    // must not become a route that is open to everybody, which is what an
    // `includes` against an unchecked string would give if the caller ever
    // passed the id straight through from a URL.
    const error = throwsCode(() => requireModule([], 'SITE_SERVICES' as ModuleId), 'MODULE_UNKNOWN');
    assert.equal((error as { status?: number }).status, 404);
    assert.equal(isModuleId('SITE_SERVICES'), false);
  });

  it('does not let one module stand in for another', () => {
    // Holding *a* module is not holding *this* module. Trivially true with one
    // module in the catalogue and the first thing to break with two, which is
    // why it is pinned now rather than the day a second one is added.
    assert.throws(() => requireModule(['DECOY' as ModuleId], MODULE), /does not hold/);
  });
});

describe('granting and revoking', () => {
  it('records who decided, when and why', () => {
    const granted = platform.setModuleGrant({
      moduleId: MODULE,
      tenantId: tenantId(),
      status: 'ACTIVE',
      reason: 'Appointed as ETABLIX site-services delivery partner',
      decidedBy: operatorId(),
    });

    assert.equal(granted.status, 'ACTIVE');
    assert.equal(granted.grantedBy, operatorId());
    assert.equal(granted.reason, 'Appointed as ETABLIX site-services delivery partner');
    assert.ok(granted.grantedAt);
    assert.deepEqual(platform.grantedModules(tenantId()), [MODULE]);
  });

  it('refuses a grant with no stated reason', () => {
    throwsCode(
      () =>
        platform.setModuleGrant({
          moduleId: MODULE,
          tenantId: tenantId(),
          status: 'ACTIVE',
          reason: '   ',
          decidedBy: operatorId(),
        }),
      'MODULE_REASON_REQUIRED',
    );
  });

  it('refuses a grant to a tenancy that does not exist', () => {
    // Otherwise a mistyped tenant id writes a grant nobody can see, against a
    // company that does not exist, which then sits on the register looking
    // exactly like a real one.
    assert.throws(
      () =>
        platform.setModuleGrant({
          moduleId: MODULE,
          tenantId: 'not-a-tenancy',
          status: 'ACTIVE',
          reason: 'Typo',
          decidedBy: operatorId(),
        }),
      /not found/i,
    );
  });

  it('takes the module back, and keeps the record of who had it', () => {
    grant();
    const live = platform.moduleGrants().find((entry) => entry.tenantId === tenantId())!;
    const revoked = platform.setModuleGrant({
      moduleId: MODULE,
      tenantId: tenantId(),
      status: 'REVOKED',
      reason: 'Framework ended',
      decidedBy: operatorId(),
    });

    assert.equal(revoked.status, 'REVOKED');
    assert.equal(revoked.revokedBy, operatorId());
    assert.equal(revoked.revokedReason, 'Framework ended');
    // The original grant survives revocation. "Who had this, and between which
    // dates" is what an access review asks, and a deleted row cannot answer it.
    assert.equal(revoked.grantedAt, live.grantedAt);
    assert.equal(revoked.grantedBy, live.grantedBy);
    assert.equal(revoked.reason, live.reason);
    assert.deepEqual(platform.grantedModules(tenantId()), []);
  });

  it('re-grants onto the same record, with the revocation cleared', () => {
    grant();
    revoke();
    const again = platform.setModuleGrant({
      moduleId: MODULE,
      tenantId: tenantId(),
      status: 'ACTIVE',
      reason: 'Framework renewed',
      decidedBy: operatorId(),
    });

    assert.equal(again.status, 'ACTIVE');
    // A live grant carrying a revocation date reads as expired.
    assert.equal(again.revokedAt, undefined);
    assert.equal(again.revokedBy, undefined);
    assert.equal(again.revokedReason, undefined);
    // One record per module per tenancy, so a re-grant cannot leave two rows
    // disagreeing about whether the company holds it.
    const mine = platform.moduleGrants().filter((entry) => entry.tenantId === tenantId());
    assert.equal(mine.length, 1);
    revoke();
  });

  it('grants to one tenancy without granting to another', () => {
    // The property the whole feature is for. One record per module *per
    // tenancy*: a grant keyed on the module alone would hand every customer on
    // the estate the module the moment one of them was given it, and nothing
    // about a single-tenancy test would notice.
    grant();
    platform.setModuleGrant({
      moduleId: MODULE,
      tenantId: otherTenantId,
      status: 'ACTIVE',
      reason: 'Second delivery partner',
      decidedBy: operatorId(),
    });
    assert.deepEqual(platform.grantedModules(tenantId()), [MODULE]);
    assert.deepEqual(platform.grantedModules(otherTenantId), [MODULE]);
    assert.equal(platform.moduleGrants().length, 2, 'the two grants share a record');

    // And revoking one leaves the other alone.
    platform.setModuleGrant({
      moduleId: MODULE,
      tenantId: otherTenantId,
      status: 'REVOKED',
      reason: 'Partner withdrew',
      decidedBy: operatorId(),
    });
    assert.deepEqual(platform.grantedModules(otherTenantId), []);
    assert.deepEqual(platform.grantedModules(tenantId()), [MODULE]);
    revoke();
  });

  it('writes nothing when the decision does not change anything', () => {
    grant();
    const before = platform.ledger.size;
    grant('Same again');
    assert.equal(platform.ledger.size, before, 'a no-op grant wrote to the ledger');
    revoke();
  });

  it('writes the decision on the operator’s own tenancy, not the customer’s', () => {
    grant();
    const events = platform.ledger
      .events()
      .filter((event) => event.eventType === 'MODULE_GRANTED' && event.entity.refId === grantRef(MODULE, tenantId()));
    assert.ok(events.length > 0, 'no MODULE_GRANTED event was written');
    for (const event of events) {
      // The grant is the operator's decision *about* a company, not that
      // company's record about themselves. A tenancy that could read its own
      // grant would be reading the register of who else has been given it — and
      // a tenancy that can read a record is one edit away from writing it.
      assert.equal(event.tenantId, PLATFORM_TENANT_ID);
    }
    revoke();
  });

  it('survives a replay of the ledger', () => {
    grant();
    const rebuilt = new Platform();
    rebuilt.ledger.restore(platform.ledger.events());
    rebuilt.rehydrate();
    assert.deepEqual(rebuilt.grantedModules(tenantId()), [MODULE]);
    revoke();
  });

});

describe('over HTTP', () => {
  it('lets nobody but the platform operator grant a module', async () => {
    for (const [who, token] of [
      ['a tenant administrator', otherAdminToken],
      ['a project director', tokenFor('pm')],
    ] as const) {
      const reply = await call('POST', `/v1/admin/tenants/${tenantId()}/modules/${MODULE}`, {
        token,
        body: { status: 'ACTIVE', reason: 'Please' },
      });
      assert.equal(reply.status, 403, `${who} granted themselves a module`);
    }
    assert.deepEqual(platform.grantedModules(tenantId()), []);
  });

  it('refuses a module the platform does not have', async () => {
    const reply = await call('POST', `/v1/admin/tenants/${tenantId()}/modules/WELFARE`, {
      token: tokenFor('operator'),
      body: { status: 'ACTIVE', reason: 'Typed the wrong name' },
    });
    assert.equal(reply.status, 404);
  });

  it('refuses a grant with no reason at the schema, before it reaches the platform', async () => {
    const reply = await call('POST', `/v1/admin/tenants/${tenantId()}/modules/${MODULE}`, {
      token: tokenFor('operator'),
      body: { status: 'ACTIVE' },
    });
    assert.equal(reply.status, 400);
  });

  it('grants, and says what has just been handed over', async () => {
    const reply = await call('POST', `/v1/admin/tenants/${tenantId()}/modules/${MODULE}`, {
      token: tokenFor('operator'),
      body: { status: 'ACTIVE', reason: 'Delivery partner on the northern framework' },
    });
    assert.equal(reply.status, 201);
    assert.equal(reply.body.status, 'ACTIVE');
    assert.equal(reply.body.moduleName, MODULES[MODULE].name);
    assert.match(reply.body.effect, /alongside everything else it holds/);
  });

  it('tells a granted tenancy what it holds', async () => {
    const reply = await call('GET', '/v1/permissions/matrix', { token: tokenFor('pm') });
    assert.equal(reply.status, 200);
    assert.deepEqual(
      reply.body.modules.map((entry: { id: string }) => entry.id),
      [MODULE],
    );
    // The summary and the restriction travel with it, so a screen can say what
    // the module is and why it is not on the price list without holding a
    // second copy of either.
    assert.equal(reply.body.modules[0].name, MODULES[MODULE].name);
    assert.ok(reply.body.modules[0].summary.length > 40);
  });

  it('never tells an ungranted tenancy the module exists', async () => {
    const reply = await call('GET', '/v1/permissions/matrix', { token: otherAdminToken });
    assert.equal(reply.status, 200);
    // Not "an empty list of the modules they could have" — an empty list, with
    // nothing anywhere in the response naming a module they do not hold. This
    // is the assertion that makes "not visible to other users" mean something
    // stronger than "locked".
    assert.deepEqual(reply.body.modules, []);
    assert.doesNotMatch(JSON.stringify(reply.body), /ETABLIX/i);
  });

  it('keeps the register — live and revoked — for the operator alone', async () => {
    const refused = await call('GET', '/v1/admin/modules', { token: otherAdminToken });
    assert.equal(refused.status, 403);

    const reply = await call('GET', '/v1/admin/modules', { token: tokenFor('operator') });
    assert.equal(reply.status, 200);
    assert.deepEqual(
      reply.body.modules.map((entry: { id: string }) => entry.id),
      Object.keys(MODULES),
    );
    const mine = reply.body.grants.find((entry: { tenantId: string }) => entry.tenantId === tenantId());
    assert.ok(mine, 'the grant is missing from the register');
    // Named, not just identified. A register of tenant ULIDs is not a register
    // anybody can review.
    assert.equal(mine.legalName, platform.tenant(tenantId()).legalName);
    assert.equal(mine.moduleName, MODULES[MODULE].name);
  });

  it('puts what each tenancy holds on the estate row', async () => {
    const reply = await call('GET', '/v1/admin/tenants', { token: tokenFor('operator') });
    assert.equal(reply.status, 200);
    const rows = new Map(reply.body.tenants.map((row: { id: string }) => [row.id, row]));
    assert.deepEqual((rows.get(tenantId()) as any).modules.map((m: { id: string }) => m.id), [MODULE]);
    assert.deepEqual((rows.get(otherTenantId) as any).modules, []);
  });

  it('closes the module again, and the tenancy stops being told about it', async () => {
    const reply = await call('POST', `/v1/admin/tenants/${tenantId()}/modules/${MODULE}`, {
      token: tokenFor('operator'),
      body: { status: 'REVOKED', reason: 'Framework ended' },
    });
    assert.equal(reply.status, 201);
    assert.match(reply.body.effect, /stay on the ledger/);

    const after = await call('GET', '/v1/permissions/matrix', { token: tokenFor('pm') });
    assert.deepEqual(after.body.modules, []);

    // And it is still on the operator's register, which is the difference
    // between revoking access and erasing the fact that it was given.
    const register = await call('GET', '/v1/admin/modules', { token: tokenFor('operator') });
    const mine = register.body.grants.find((entry: { tenantId: string }) => entry.tenantId === tenantId());
    assert.equal(mine.status, 'REVOKED');
    assert.equal(mine.revokedReason, 'Framework ended');
  });
});

describe('what a module is not', () => {
  it('is not a package tier, so it does not appear on anything a customer can buy', () => {
    // A tier is bought and is exclusive; a grant is decided and is additive.
    // Putting a module in the tier ladder would put it in the shop window,
    // which is the one place it must never be.
    const publicSurface = JSON.stringify(MODULES);
    assert.ok(publicSurface.includes('not offered for sale'));
  });

  it('is not standing, so a suspended tenancy keeps the grant it was given', () => {
    grant();
    platform.setSubscriptionStatus({
      tenantId: tenantId(),
      status: 'SUSPENDED',
      reason: 'Payment failed on renewal',
      decidedBy: operatorId(),
    });

    // Standing answers "may this tenancy do anything right now" and is derived
    // from paying; the grant is an act somebody took. Losing the module on
    // suspension would mean reactivating a customer silently dropped capability
    // nobody remembered to re-add.
    assert.deepEqual(platform.grantedModules(tenantId()), [MODULE]);

    platform.setSubscriptionStatus({
      tenantId: tenantId(),
      status: 'ACTIVE',
      reason: 'Payment received',
      decidedBy: operatorId(),
    });
    revoke();
  });

  it('carries onto the engine context beside standing, not inside it', () => {
    grant();
    const ctx = platform.context(seed.users.pm!.auth, seed.projectId);
    assert.deepEqual([...ctx.grantedModules], [MODULE]);
    assert.equal(ctx.standing.mayWrite, true);
    revoke();

    const closed = platform.context(seed.users.pm!.auth, seed.projectId);
    assert.deepEqual([...closed.grantedModules], []);
    // Standing is untouched by the revocation, which is the whole point of
    // resolving the two side by side.
    assert.equal(closed.standing.mayWrite, true);
  });
});
