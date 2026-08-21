import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { createGateway } from '../src/api/gateway.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Governance: who may do what, and who changed it.
 *
 * Two holes, both of the kind that only shows up when somebody looks.
 *
 * A person's roles were whatever they were created with, forever. The only way
 * to change them was to suspend the identity and issue another, which loses the
 * link between the person and everything they had already authored — so in
 * practice roles did not change, and people kept access they should not have
 * had.
 *
 * And the billing routes enforced nothing at all. The permission matrix had the
 * answer, the console asked it before drawing the buttons, and the API never
 * did: any authenticated identity in a tenant could top the wallet up, move the
 * AI spend caps, or issue an invoice. The interface was the only thing stopping
 * them, which is to say nothing was.
 */

let platform: Platform;
let seed: SeedResult;
let server: Server;
let base: string;

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
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
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

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server.close());

describe('changing what somebody is allowed to do', () => {
  it('changes the roles and records who changed them and why', () => {
    const admin = seed.users.admin!.auth;
    const target = seed.users.planner!.id;

    const result = platform.assignRoles(admin, {
      userId: target,
      roles: ['PLANNER', 'QAQC'],
      reason: 'Covering quality inspection while the QA engineer is on leave',
    });

    assert.deepEqual(result.previousRoles, ['PLANNER']);
    assert.deepEqual(result.roles, ['PLANNER', 'QAQC']);
    assert.deepEqual(platform.user(target).roles, ['PLANNER', 'QAQC']);

    const record = platform.ledger.require({ refType: 'User', refId: target });
    assert.deepEqual(record.state.previousRoles, ['PLANNER']);
    assert.equal(record.state.changedBy, admin.actorId);
    assert.match(String(record.state.reason), /on leave/);
  });

  it('refuses a self-elevation, which is the first thing an insider tries', () => {
    const admin = seed.users.admin!.auth;

    throwsCode(
      () =>
        platform.assignRoles(admin, {
          userId: admin.actorId,
          roles: ['ENTERPRISE_ADMIN', 'OWNER'],
          reason: 'Taking on the client representative duties as well',
        }),
      'SELF_ROLE_CHANGE',
    );
  });

  it('refuses to put an operator role on a delivery identity', () => {
    // The account layers are separate by construction. This would collapse that
    // in one call.
    throwsCode(
      () =>
        platform.assignRoles(seed.users.admin!.auth, {
          userId: seed.users.qs!.id,
          roles: ['QS', 'PLATFORM_ADMIN'],
          reason: 'Needs to see the platform logs to debug an export',
        }),
      'ACCOUNT_LAYER_SEPARATION',
    );
    assert.deepEqual(platform.user(seed.users.qs!.id).roles, ['QS'], 'and nothing changed');
  });

  it('refuses to leave an identity with no role at all', () => {
    throwsCode(
      () => platform.assignRoles(seed.users.admin!.auth, { userId: seed.users.fm!.id, roles: [], reason: 'Leaving the project' }),
      'ROLES_REQUIRED',
    );
  });

  it('refuses a change nobody explained', () => {
    throwsCode(
      () => platform.assignRoles(seed.users.admin!.auth, { userId: seed.users.fm!.id, roles: ['PM'], reason: 'moved' }),
      'ROLE_CHANGE_UNEXPLAINED',
    );
  });

  it('will not reach into another tenancy', () => {
    const other = platform.createTenant({
      legalName: 'Somebody Else Ltd',
      jurisdiction: 'GB',
      defaultCurrency: 'GBP',
      tier: 'BUSINESS',
      enterpriseName: 'Somebody Else',
    });
    const stranger = platform.createUser({
      tenantId: other.tenant.id,
      name: 'Their admin',
      email: 'admin@somebodyelse.example',
      roles: ['ENTERPRISE_ADMIN'],
    });

    // Answered as "no such user" rather than "not yours": the distinction is
    // itself information about who exists elsewhere on the platform.
    assert.throws(
      () => platform.assignRoles(seed.users.admin!.auth, { userId: stranger.id, roles: ['PM'], reason: 'Reorganising the team' }),
      /No user/,
    );
  });

  it('is refused over HTTP to anyone but an enterprise admin or the owner', async () => {
    const reply = await call('POST', `/v1/users/${seed.users.fm!.id}/roles`, {
      token: tokenFor('qs'),
      body: { roles: ['PM'], reason: 'Taking over project management next month' },
    });

    assert.equal(reply.status, 403);
    assert.equal(reply.body.title, 'ENTERPRISE_ADMIN_REQUIRED');
  });

  it('works over HTTP for one who may', async () => {
    const reply = await call('POST', `/v1/users/${seed.users.fm!.id}/roles`, {
      token: tokenFor('admin'),
      body: { roles: ['FM', 'SUPERVISOR'], reason: 'Taking on site supervision during commissioning' },
    });

    assert.equal(reply.status, 201);
    assert.deepEqual(reply.body.roles, ['FM', 'SUPERVISOR']);
  });
});

describe('the billing routes enforce the matrix they always had', () => {
  it('refuses a spend cap change to a role with no billing authority', async () => {
    // A site supervisor moving the AI budget ceiling was previously a 201.
    const reply = await call('POST', '/v1/billing/caps', {
      token: tokenFor('safety'),
      body: { monthlyMinor: 1_000_000, reason: 'Raising the ceiling for the forecast run' },
    });

    assert.equal(reply.status, 403);
    assert.equal(reply.body.title, 'ACCESS_DENIED');
  });

  it('refuses a top-up to the same role, because it creates a liability', async () => {
    const reply = await call('POST', '/v1/billing/top-up', {
      token: tokenFor('safety'),
      body: { amountMinor: 500_000 },
    });

    assert.equal(reply.status, 403);
  });

  it('refuses the wallet position to a role with no billing read', async () => {
    const reply = await call('GET', '/v1/billing/wallet', { token: tokenFor('qaqc') });
    assert.equal(reply.status, 403);
  });

  it('allows the enterprise admin, and records who moved the ceiling', async () => {
    const reply = await call('POST', '/v1/billing/caps', {
      token: tokenFor('admin'),
      body: { monthlyMinor: 2_000_000, reason: 'Raised for the delay forecasting work in September' },
    });

    assert.equal(reply.status, 201);
    assert.equal(reply.body.caps.monthlyMinor, 2_000_000);

    const record = platform.ledger.require({ refType: 'ACUWallet', refId: seed.tenantId });
    assert.equal((record.state.caps as { monthlyMinor: number }).monthlyMinor, 2_000_000);
    assert.match(String(record.state.reason), /September/);
    assert.equal(record.state.tenantId, seed.tenantId);
  });

  it('keeps the previous ceiling on the record, so a change can be read as a change', () => {
    const events = platform.ledger.eventsForEntity({ refType: 'ACUWallet', refId: seed.tenantId });
    const capsSet = events.filter((e) => e.eventType === 'ACU_CAPS_SET');

    assert.ok(capsSet.length >= 1);
    const record = platform.ledger.require({ refType: 'ACUWallet', refId: seed.tenantId });
    assert.ok('previousCaps' in record.state);
  });

  it('records the change against a person rather than the system', () => {
    // Every other wallet event is a system act. This one is a decision, and the
    // whole point of recording it is that somebody made it.
    const events = platform.ledger
      .eventsForEntity({ refType: 'ACUWallet', refId: seed.tenantId })
      .filter((e) => e.eventType === 'ACU_CAPS_SET');

    assert.ok(events.every((e) => e.actor.refType === 'User'));
  });

  it('refuses a cap change nobody explained', async () => {
    const reply = await call('POST', '/v1/billing/caps', {
      token: tokenFor('admin'),
      body: { monthlyMinor: 3_000_000 },
    });

    assert.equal(reply.status, 400, 'the reason is required by the schema');
  });
});
