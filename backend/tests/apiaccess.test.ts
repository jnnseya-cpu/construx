import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import { PACKAGES } from '../src/billing/seats.ts';
import { authOf } from '../src/seed.ts';
import { Platform } from '../src/platform.ts';
import { issueTokens } from '../src/identity/auth.ts';

/**
 * API access is a term of the package, not a label on the pricing page.
 *
 * `PACKAGES[...].apiAccess` said "No API access" on Free and Solo and nothing
 * enforced it: a Free tenancy could issue live keys and integrate. Issuing a
 * key or a webhook subscription is now refused on a package without it, with
 * the package named and the remedy stated — and admitted the moment the
 * tenancy moves to one that includes it.
 */

let platform: Platform;
let server: Server;
let base: string;
let tenantId: string;
let adminToken: string;

before(async () => {
  platform = new Platform();
  const created = platform.createTenant({
    legalName: 'Free Works Ltd',
    jurisdiction: 'GB',
    defaultCurrency: 'GBP',
    tier: 'FREE_TRIAL',
    enterpriseName: 'Free Works',
  });
  tenantId = created.tenant.id;
  const admin = platform.createUser({ tenantId, name: 'Rowan Adeyemi', email: 'rowan@freeworks.example', roles: ['ENTERPRISE_ADMIN'] });
  const auth = authOf(platform, admin.id);
  adminToken = issueTokens({ actorId: auth.actorId, tenantId: auth.tenantId, partyId: auth.partyId, roles: auth.roles, mfaSatisfied: true })
    .accessToken;
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server.close());

async function post(path: string, payload: unknown) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('API access follows the package', () => {
  it('is refused on a package that does not include it, naming the package', async () => {
    assert.equal(PACKAGES.FREE_TRIAL.apiAccess, false);
    const key = await post('/v1/developer/keys', { name: 'Integration', mode: 'LIVE', scopes: ['projects:read'] });
    assert.equal(key.status, 422, JSON.stringify(key.body));
    assert.equal(key.body.title, 'API_ACCESS_NOT_ON_PLAN');
    assert.match(String(key.body.detail), new RegExp(PACKAGES.FREE_TRIAL.label));
    const hook = await post('/v1/developer/webhooks', { name: 'Hook', url: 'https://example.com/hook', mode: 'LIVE' });
    assert.equal(hook.status, 422);
    assert.equal(hook.body.title, 'API_ACCESS_NOT_ON_PLAN');
  });

  it('is admitted once the tenancy moves to a package that includes it', async () => {
    // Core Project does not include the API either; Professional Delivery is
    // the first package that does.
    assert.equal(PACKAGES.CORE_PROJECT.apiAccess, false);
    platform.setSubscriptionPackage({
      tenantId,
      package: 'PROFESSIONAL_DELIVERY',
      reason: 'Pilot agreement — integration needed',
      decidedBy: 'operator',
      grantFree: true,
    });
    assert.equal(PACKAGES.PROFESSIONAL_DELIVERY.apiAccess, true);
    const key = await post('/v1/developer/keys', { name: 'Integration', mode: 'LIVE', scopes: ['projects:read'] });
    assert.equal(key.status, 201, JSON.stringify(key.body));
    assert.ok(String((key.body as { secret?: string }).secret ?? '').startsWith('ck_live_'));
  });
});
