import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';

/**
 * A tenancy an operator provisions must be one somebody can get into.
 *
 * The defect this pins, found by provisioning one against a running server and
 * then trying to use it. `POST /v1/admin/tenants` created the tenancy, its
 * subscription and its wallet — and no identity. Creating a user requires
 * `ENTERPRISE_ADMIN` *of that tenancy*, and a tenancy seconds old has none, so
 * the operator's own attempt came back 403. The customer was provisioned,
 * billed, credited with a trial grant, and unreachable. Nothing anywhere said
 * so: the estate view showed a healthy new tenancy with zero seats used, which
 * is exactly what a brand-new tenancy legitimately looks like.
 *
 * Public signup never had the defect — it creates the tenancy and its first
 * `ENTERPRISE_ADMIN` in one act, because somebody has to be able to invite the
 * rest. This is the same shape, and these tests exist so the two paths cannot
 * drift apart again.
 *
 * The property, stated once: **there is no correct tenancy with no way in.**
 */

let server: Server;
let base: string;
let platform: Platform;
let operatorToken: string;

before(async () => {
  platform = new Platform();
  const operator = platform.createOperator({ name: 'Operator', email: 'ops@construxvg.com' });
  operatorToken = issueTokens({
    actorId: operator.id,
    tenantId: operator.tenantId,
    roles: operator.roles,
    mfaSatisfied: true,
  }).accessToken;

  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server.close());

function onboard(body: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/v1/admin/tenants`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${operatorToken}` },
    body: JSON.stringify(body),
  });
}

const tenancy = (over: Record<string, unknown> = {}) => ({
  legalName: 'Meridian Infrastructure Ltd',
  enterpriseName: 'Meridian Group',
  jurisdiction: 'GB',
  defaultCurrency: 'GBP',
  tier: 'TEAM',
  adminName: 'Rowan Ellis',
  adminEmail: `rowan-${Math.random().toString(36).slice(2)}@meridian.test`,
  ...over,
});

describe('onboarding a tenancy', () => {
  it('creates the tenancy and its first administrator in one act', async () => {
    const response = await onboard(tenancy());
    assert.ok([200, 201].includes(response.status), `onboarding failed (${response.status})`);

    const body = (await response.json()) as {
      tenant: { id: string };
      administrator: { id: string; email: string; roles: string[]; tenantId: string };
    };

    assert.ok(body.administrator, 'a tenancy was provisioned with no administrator');
    assert.deepEqual(body.administrator.roles, ['ENTERPRISE_ADMIN']);
    assert.equal(body.administrator.tenantId, body.tenant.id, 'the administrator was put in the wrong tenancy');
  });

  it('leaves an identity that can be found by the address it was created with', async () => {
    // Sign-in is an emailed one-time code and there is no password anywhere, so
    // the address is the credential. An administrator created against an
    // address nothing can look up is an account nobody can use.
    const input = tenancy();
    await onboard(input);

    const found = platform.userByEmail(input.adminEmail as string);
    assert.ok(found, 'the administrator cannot be found by their email address');
    assert.ok(found.roles.includes('ENTERPRISE_ADMIN'));
  });

  it('can be sent a login code, which is the only way in', async () => {
    const input = tenancy();
    await onboard(input);

    const response = await fetch(`${base}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: input.adminEmail }),
    });

    assert.ok([200, 201].includes(response.status));
    // The login route answers the same way for an address that does not exist,
    // deliberately, so that it cannot be used to enumerate accounts. The code
    // is the thing only a real identity gets, so that is what is asserted.
    const body = (await response.json()) as { devCode?: string };
    assert.ok(body.devCode, 'no code was issued, so the tenancy cannot be entered');
  });

  it('gives the administrator a seat on the subscription', async () => {
    const input = tenancy();
    const body = (await (await onboard(input)).json()) as { tenant: { id: string } };

    const subscription = platform.subscription(body.tenant.id);
    assert.equal(subscription.assignedIdentities.length, 1, 'the first administrator consumed no seat');
  });
});

describe('what onboarding refuses', () => {
  it('refuses a tenancy with no administrator named', async () => {
    // Optional would preserve the defect for whoever omitted it. The schema
    // refuses rather than provisioning something unreachable.
    const { adminName, adminEmail, ...withoutAdmin } = tenancy();
    void adminName;
    void adminEmail;

    const response = await onboard(withoutAdmin);
    assert.equal(response.status, 400, 'a tenancy was provisioned with nobody able to sign in to it');
  });

  it('refuses an address that already holds an identity, before creating anything', async () => {
    // One human, one identity. Refused *before* the tenancy exists: creating it
    // and then failing on the administrator would leave exactly the unreachable
    // tenancy this exists to prevent — and leave it in the ledger.
    const input = tenancy();
    await onboard(input);

    const before = platform.tenants().length;
    const response = await onboard({ ...tenancy(), adminEmail: input.adminEmail });

    assert.equal(response.status, 400);
    assert.equal(platform.tenants().length, before, 'a tenancy was created and then abandoned without an administrator');
  });

  it('refuses an ordinary customer identity, however privileged', async () => {
    const { tenant } = platform.createTenant({
      legalName: 'Acme',
      enterpriseName: 'Acme',
      jurisdiction: 'GB',
      defaultCurrency: 'GBP',
      tier: 'TEAM',
    });
    const customer = platform.createUser({
      tenantId: tenant.id,
      name: 'Mallory',
      email: `mallory-${Math.random().toString(36).slice(2)}@acme.test`,
      roles: ['ENTERPRISE_ADMIN'],
    });
    const token = issueTokens({
      actorId: customer.id,
      tenantId: customer.tenantId,
      roles: customer.roles,
      mfaSatisfied: true,
    }).accessToken;

    const response = await fetch(`${base}/v1/admin/tenants`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(tenancy()),
    });

    assert.equal(response.status, 403, 'an enterprise admin onboarded a tenancy');
  });

  it('never lets the administrator be minted with an operator role', async () => {
    // The role-escalation audit closed this door on user creation. Onboarding
    // is a second door onto the same prize, and it does not accept a role at
    // all — ENTERPRISE_ADMIN is decided here, not passed in.
    const response = await onboard({ ...tenancy(), roles: ['PLATFORM_ADMIN'] });
    assert.equal(response.status, 400, 'the onboarding route accepted a roles field');
  });
});

describe('every tenancy on the estate has a way in', () => {
  it('holds for every tenancy this suite provisioned', async () => {
    // The invariant, checked across the whole estate rather than per call. A
    // tenancy with no ENTERPRISE_ADMIN cannot be administered, cannot invite
    // anybody, and cannot be used — whatever it is paying.
    for (const tenant of platform.tenants()) {
      const admins = platform.users(tenant.id).filter((user) => user.roles.includes('ENTERPRISE_ADMIN'));
      assert.ok(
        admins.length > 0,
        `${tenant.legalName} exists on the estate with nobody who can administer it`,
      );
    }
  });
});
