import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import { ROUTES } from '../src/api/routes.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The account layer, enumerated.
 *
 * `AC-C-WF-01-01: Platform Super Admin cannot execute any endpoint in this
 * workflow.` The specification states it for one workflow; it is true of every
 * project-scoped endpoint in the platform, and the only way to know that is to
 * ask all of them.
 *
 * Two functions enforce it — `projectContext` and `tenantContext` — and a route
 * that reaches the ledger without going through one of them is outside the
 * fence. That is not hypothetical: the lineage route carries its own explicit
 * check precisely because it builds its own context, and nothing was stopping
 * the next route like it from forgetting.
 *
 * So this walks the routing table rather than sampling it. Every route whose
 * pattern names a project is called with a platform operator's token and must
 * refuse. A route added next year is in this test the day it is added, without
 * anybody remembering to come back here — which is the only kind of security
 * test that stays true.
 *
 * **Why the operator is fenced out at all.** It is not that operators are
 * untrusted; it is that the separation is what the product sells. A customer's
 * commercial position, safety record and legal correspondence are theirs, and a
 * platform administrator who could open a payment application has made the
 * tenancy boundary a matter of policy rather than of mechanism.
 */

let platform: Platform;
let seed: SeedResult;
let server: Server;
let base: string;
let operatorToken: string;

const PROJECT_ROUTES = ROUTES.filter((route) => route.pattern.includes(':projectId'));

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const operator = platform.user(seed.users.operator!.id);
  assert.ok(operator.roles.includes('PLATFORM_ADMIN'), 'the seeded operator is not a platform administrator');
  operatorToken = issueTokens({
    actorId: operator.id,
    tenantId: operator.tenantId,
    partyId: operator.partyId,
    roles: operator.roles,
    mfaSatisfied: true,
  }).accessToken;
});

after(() => server.close());

/** A path for a route pattern, with the seeded project and a plausible id elsewhere. */
function pathFor(pattern: string): string {
  return pattern
    .split('/')
    .map((segment) => {
      if (!segment.startsWith(':')) return segment;
      if (segment === ':projectId') return seed.projectId;
      return '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    })
    .join('/');
}

describe('a platform operator cannot reach customer delivery data', () => {
  it('has a routing table worth walking', () => {
    // If this ever drops sharply, the routes moved rather than the risk going
    // away, and the sweep below would be passing on an empty set.
    assert.ok(PROJECT_ROUTES.length > 100, `only ${PROJECT_ROUTES.length} project routes found`);
  });

  it('refuses every project-scoped endpoint, read and write alike', async () => {
    const leaked: string[] = [];

    for (const route of PROJECT_ROUTES) {
      const response = await fetch(`${base}${pathFor(route.pattern)}`, {
        method: route.method,
        headers: { authorization: `Bearer ${operatorToken}`, 'content-type': 'application/json' },
        // An empty object for a write. A route that refuses on the schema
        // before it refuses on the account layer would pass this test for the
        // wrong reason, so the status is checked as well as the refusal.
        body: route.method === 'GET' || route.method === 'DELETE' ? undefined : '{}',
      });

      // 403 is the answer. 400 and 422 are not: they mean the request was
      // rejected for its shape, which tells us nothing about whether the
      // operator would have been let through with a correct body.
      if (response.status === 403) continue;
      if (response.status === 404) continue; // the id substituted for a non-project param does not exist

      const body = await response.text();
      leaked.push(`${route.method} ${route.pattern} → ${response.status} ${body.slice(0, 120)}`);
    }

    assert.deepEqual(leaked, [], `the operator layer reached customer delivery data:\n  ${leaked.join('\n  ')}`);
  });

  it('answers "not allowed" rather than "not found", so the refusal is legible', async () => {
    // A 404 would be defensible as enumeration resistance and it is the wrong
    // answer here: the operator knows the project exists — they administer the
    // tenancy that owns it. Telling them it does not exist would be a lie that
    // sends somebody debugging the wrong thing.
    const response = await fetch(`${base}/v1/projects/${seed.projectId}/consistency`, {
      headers: { authorization: `Bearer ${operatorToken}` },
    });

    assert.equal(response.status, 403);
    const problem = (await response.json()) as { title?: string; detail?: string };
    assert.equal(problem.title, 'ACCOUNT_LAYER_SEPARATION');
    assert.match(problem.detail ?? '', /barred from customer delivery data/);
  });

  it('lets the same endpoints through for a project person, so the fence is the layer and not a broken route', async () => {
    // Without this the test above passes on a platform where nothing works.
    const pm = platform.user(seed.users.pm!.id);
    const token = issueTokens({
      actorId: pm.id,
      tenantId: pm.tenantId,
      partyId: pm.partyId,
      roles: pm.roles,
      mfaSatisfied: true,
    }).accessToken;

    const response = await fetch(`${base}/v1/projects/${seed.projectId}/consistency`, {
      headers: { authorization: `Bearer ${token}` },
    });

    assert.equal(response.status, 200);
  });
});

describe('the operator keeps the surface that is actually theirs', () => {
  it('reads tenancy health, revenue and system state', async () => {
    // The fence is one-directional and deliberately so. An operator who could
    // not see tenancy health, revenue or system state could not run the
    // platform, and the separation is about delivery data rather than about
    // withholding administration from the administrator.
    for (const path of ['/v1/admin/overview', '/v1/admin/burn', '/v1/admin/readiness']) {
      const response = await fetch(`${base}${path}`, {
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      assert.notEqual(response.status, 403, `${path} refused the operator`);
    }
  });

  it('is barred from the estate control view, which is customer data at portfolio scale', async () => {
    // An earlier version of this test expected the operator to read it, and the
    // platform was right and the test was wrong. `/v1/control/estate` measures
    // every one of a customer's projects against the control standard — it is
    // the widest possible view of their delivery, not a platform metric. That it
    // aggregates does not make it the operator's.
    const response = await fetch(`${base}/v1/control/estate`, {
      headers: { authorization: `Bearer ${operatorToken}` },
    });

    assert.equal(response.status, 403);
    assert.equal(((await response.json()) as { title?: string }).title, 'ACCOUNT_LAYER_SEPARATION');
  });
});
