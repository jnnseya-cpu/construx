import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import { ROUTES } from '../src/api/routes.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';

/**
 * How the first operator comes to exist.
 *
 * A production deployment could not be administered at all. Every admin route
 * demands `PLATFORM_ADMIN`; the only thing that created one was the
 * demonstration seed; and the demonstration seed is switched off in production
 * — correctly, since it hands a working session to anonymous callers. So the
 * platform came up, served the public site, and could never be signed into.
 * Found on a real deployment, with the boot log reading `0 users across 0
 * tenancies` and no way to change it.
 *
 * The fix is a boot-time bootstrap from `PLATFORM_OPERATOR_EMAIL`, and the
 * property that makes it safe is that it is not a route. A public endpoint that
 * mints a `PLATFORM_ADMIN` is the worst thing that could be put on the
 * internet, whatever guard sits in front of it; setting a variable requires the
 * server itself, which is the authority the act deserves.
 */

let server: Server;
let base: string;

before(async () => {
  server = createGateway(new Platform());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server.close());

describe('the first operator is not reachable over the network', () => {
  it('exposes no public route that creates an operator', () => {
    // The invariant. Anything that mints a PLATFORM_ADMIN must require an
    // existing one, so the first can only come from the server itself.
    for (const route of ROUTES.filter((r) => r.public)) {
      assert.ok(
        !/operator/i.test(route.pattern),
        `${route.method} ${route.pattern} is public and mentions operators`,
      );
    }
  });

  it('refuses to create an operator without an authenticated one', async () => {
    const response = await fetch(`${base}/v1/operators`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Mallory', email: 'mallory@example.test' }),
    });

    assert.equal(response.status, 401, 'an anonymous caller created a platform operator');
  });

  it('refuses an ordinary tenant identity', async () => {
    // An enterprise admin is the most privileged thing a customer can hold, and
    // it must not reach this. The role-escalation audit closed the other door —
    // granting PLATFORM_ADMIN through user creation — and this is the same
    // prize behind a different one.
    const platform = new Platform();
    const { tenant } = platform.createTenant({
      legalName: 'Acme',
      enterpriseName: 'Acme',
      jurisdiction: 'GB',
      defaultCurrency: 'GBP',
      tier: 'TEAM',
    });
    const customer = platform.createUser({
      tenantId: tenant.id,
      name: 'Rowan',
      email: 'rowan@acme.test',
      roles: ['ENTERPRISE_ADMIN'],
    });

    const token = issueTokens({
      actorId: customer.id,
      tenantId: customer.tenantId,
      roles: customer.roles,
      mfaSatisfied: true,
    }).accessToken;

    const response = await fetch(`${base}/v1/operators`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: 'Mallory', email: 'mallory@example.test' }),
    });

    assert.equal(response.status, 403, 'an enterprise admin created a platform operator');
  });
});

describe('creating the first operator', () => {
  it('produces an identity that holds PLATFORM_ADMIN and nothing else', () => {
    const platform = new Platform();
    const operator = platform.createOperator({ name: 'Operator', email: 'ops@construxvg.com' });

    assert.deepEqual(operator.roles, ['PLATFORM_ADMIN']);
    assert.equal(operator.status, 'ACTIVE');
    assert.equal(platform.operators().length, 1);
  });

  it('is findable by the address it was created with, which is how sign-in works', () => {
    // There is no password anywhere in this platform: sign-in is an emailed
    // one-time code. So the address on the operator is the credential, and an
    // operator created against an address nobody can read is an account nobody
    // can use.
    const platform = new Platform();
    platform.createOperator({ name: 'Operator', email: 'ops@construxvg.com' });

    assert.ok(platform.userByEmail('ops@construxvg.com'), 'the operator cannot be found by email');
  });

  it('records the creation in the ledger', () => {
    // An identity holding the whole operator surface appearing from a
    // configuration file is exactly the kind of act the record exists for.
    const platform = new Platform();
    const operator = platform.createOperator({ name: 'Operator', email: 'ops@construxvg.com' });

    const committed = platform.ledger.events({ tenantId: 'platform' });
    assert.ok(
      committed.some((event) => event.eventType === 'USER_CREATED' && event.entity.refId === operator.id),
      'creating an operator left no trace in the ledger',
    );
  });

  it('lets an operator create another one', () => {
    // The second onwards goes through the route. Only the first needs the
    // server, so PLATFORM_OPERATOR_EMAIL is a bootstrap rather than a
    // permanent way of managing people.
    const platform = new Platform();
    platform.createOperator({ name: 'First', email: 'first@construxvg.com' });
    platform.createOperator({ name: 'Second', email: 'second@construxvg.com' });

    assert.equal(platform.operators().length, 2);
  });
});
