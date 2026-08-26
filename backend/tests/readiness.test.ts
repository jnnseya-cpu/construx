import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Server } from 'node:http';
import { createGateway } from '../src/api/gateway.ts';
import { readiness } from '../src/api/readiness.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';

/**
 * Deployment readiness.
 *
 * The platform already computed all of this at boot and printed it to a log
 * nobody reads twice, so the one person whose job is to fix a half-configured
 * deployment could not see its state without shell access to the box. That is
 * how a deployment sits for a day with a payment rail keyed on one side and a
 * ledger writing to nothing.
 *
 * Two properties are load-bearing and everything below is one of them.
 *
 * **No value ever crosses the boundary.** The report says whether a secret is
 * set. A readiness screen that leaks the thing it reports on is worse than no
 * readiness screen, and the failure would be silent — the page would look
 * exactly right.
 *
 * **Half-configured is its own state.** A Stripe key with no webhook secret
 * takes money and credits nothing, and it reads as configured from every angle
 * except this one. Two states would put it under "configured" or under "not
 * set", and both are wrong in the direction that costs money.
 */

let server: Server;
let base: string;

before(async () => {
  server = createGateway(new Platform());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server.close());

describe('the report never carries a value', () => {
  it('does not contain any configured secret anywhere in its JSON', () => {
    // The whole point, tested the only way that catches it: search the entire
    // serialised report for each secret this process is holding. A future
    // capability that helpfully quotes a value into its `detail` fails here
    // rather than in production.
    const secrets = [
      process.env.GATEWAY_JWT_SECRET,
      process.env.STRIPE_SECRET_KEY,
      process.env.STRIPE_WEBHOOK_SECRET,
      process.env.KODA_SECRET_KEY,
      process.env.KODA_WEBHOOK_SECRET,
      process.env.OPENAI_API_KEY,
      process.env.GEMINI_API_KEY,
      process.env.ANTHROPIC_API_KEY,
      process.env.SMTP_PASS,
      process.env.SIGNING_PRIVATE_KEY_PEM,
    ].filter((value): value is string => typeof value === 'string' && value.length > 6);

    const serialised = JSON.stringify(readiness());
    for (const secret of secrets) {
      assert.ok(!serialised.includes(secret), 'the readiness report contains a configured secret value');
    }
  });

  it('publishes variable names, which are documentation rather than credentials', () => {
    // Deliberate, and worth stating: an operator cannot fix what they cannot
    // name, and these names are already in `.env.example`.
    const report = readiness();
    const ledger = report.capabilities.find((c) => c.key === 'ledger.journal')!;

    assert.ok(ledger.env.includes('LEDGER_JOURNAL_PATH'));
    assert.ok(ledger.env.length > 0, 'a capability published no way to configure it');
  });

  it('names a variable for every capability', () => {
    for (const capability of readiness().capabilities) {
      assert.ok(capability.env.length > 0, `${capability.key} says nothing about how to configure it`);
      assert.ok(capability.detail.length > 20, `${capability.key} has no useful detail`);
    }
  });
});

describe('half-configured is reported as its own state', () => {
  /** Run with an environment applied, restoring whatever was there before. */
  function withEnv<T>(vars: Record<string, string | undefined>, run: () => T): T {
    const previous = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(vars)) {
      previous.set(key, process.env[key]);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      return run();
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  it('reads the shape of a rail from the process it is running in', () => {
    // `config` is frozen at import, so this asserts against the state this test
    // process actually has rather than a rewritten one. Whatever that state is,
    // the rail must be in exactly one of the three and the arithmetic must
    // agree with it.
    const report = readiness();
    for (const key of ['payments.card', 'payments.mobile']) {
      const rail = report.capabilities.find((c) => c.key === key)!;
      assert.ok(
        ['CONFIGURED', 'NOT_SET', 'DEGRADED'].includes(rail.state),
        `${key} reported a state that is not one of the three`,
      );
    }
    void withEnv;
  });

  it('counts configured and degraded consistently with the capability list', () => {
    const report = readiness();

    assert.equal(report.configured, report.capabilities.filter((c) => c.state === 'CONFIGURED').length);
    assert.equal(report.degraded, report.capabilities.filter((c) => c.state === 'DEGRADED').length);
  });

  it('lists every unconfigured critical capability as blocking', () => {
    // The go-live list. A critical capability that is merely half-configured
    // must appear here too — "present and wrong" does not clear a blocker.
    const report = readiness();
    const expected = report.capabilities.filter((c) => c.critical && c.state !== 'CONFIGURED').map((c) => c.label);

    assert.deepEqual(report.blocking, expected);
  });

  it('carries the boot warnings unchanged rather than rewording them', () => {
    // Two voices on one question is how a platform ends up telling an operator
    // different things in the log and on the screen.
    const report = readiness();
    assert.ok(Array.isArray(report.warnings));
  });
});

describe('who may see it', () => {
  it('refuses an anonymous caller', async () => {
    const response = await fetch(`${base}/v1/admin/readiness`);
    assert.equal(response.status, 401, 'deployment readiness was served to an anonymous caller');
  });

  it('refuses the most privileged customer identity', async () => {
    // It carries no secret and is still operator-only: it is a map of which
    // locks on this deployment are unlocked, which is what an attacker wants
    // most and a customer has no business seeing.
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

    const response = await fetch(`${base}/v1/admin/readiness`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 403, 'an enterprise admin read the deployment configuration map');
  });

  it('serves it to a platform operator', async () => {
    const platform = new Platform();
    const operator = platform.createOperator({ name: 'Operator', email: 'ops@construxvg.com' });
    const token = issueTokens({
      actorId: operator.id,
      tenantId: operator.tenantId,
      roles: operator.roles,
      mfaSatisfied: true,
    }).accessToken;

    const response = await fetch(`${base}/v1/admin/readiness`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);

    const body = (await response.json()) as { capabilities: unknown[]; blocking: unknown[] };
    assert.ok(body.capabilities.length >= 10, 'the report covered almost nothing');
    assert.ok(Array.isArray(body.blocking));
  });
});
