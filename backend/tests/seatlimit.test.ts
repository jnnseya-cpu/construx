import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import { PACKAGES } from '../src/billing/seats.ts';
import { authOf } from '../src/seed.ts';
import { Platform } from '../src/platform.ts';
import { issueTokens } from '../src/identity/auth.ts';

/**
 * A seat that is not there is a refusal, not a failure.
 *
 * Reported from a live tenancy on the Free package: "Add a person" answered
 * `INTERNAL_ERROR — The request could not be completed`, and the administrator
 * concluded nobody could be added at all. The package includes one identity and
 * the administrator was it; the seat limit was doing its job. But
 * `SeatLimitError` extended a bare `Error`, the gateway had no mapping for it,
 * and a correct commercial refusal went out as a 500 with no reason on it.
 *
 * The same class of defect the signature scanner had, and the same fix: a
 * refusal is a `DomainError`, so the person is told the limit, the package it
 * belongs to, and what to do — revoke a seat or move package.
 */

let platform: Platform;
let server: Server;
let base: string;
let adminToken: string;
let tenantId: string;

before(async () => {
  platform = new Platform();
  const created = platform.createTenant({
    legalName: 'Solo Surveys Ltd',
    jurisdiction: 'GB',
    defaultCurrency: 'GBP',
    tier: 'FREE_TRIAL',
    enterpriseName: 'Solo Surveys',
  });
  tenantId = created.tenant.id;
  const admin = platform.createUser({ tenantId, name: 'Rowan Adeyemi', email: 'rowan@solosurveys.example', roles: ['ENTERPRISE_ADMIN'] });
  const auth = authOf(platform, admin.id);
  adminToken = issueTokens({
    actorId: auth.actorId,
    tenantId: auth.tenantId,
    partyId: auth.partyId,
    roles: auth.roles,
    mfaSatisfied: true,
  }).accessToken;

  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server.close());

describe('adding a person beyond the package’s seats', () => {
  it('is refused with the limit, the package and what to do — not a 500', async () => {
    assert.equal(PACKAGES.FREE_TRIAL.includedSeats, 1, 'the Free package is one identity, which the administrator already is');

    const response = await fetch(`${base}/v1/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ name: 'Second Person', email: 'second@solosurveys.example', roles: ['PLANNER'] }),
    });
    const problem = (await response.json()) as { status: number; title: string; detail: string };

    assert.equal(response.status, 422, `a seat limit answered ${response.status}: ${JSON.stringify(problem)}`);
    assert.equal(problem.title, 'SEAT_LIMIT_REACHED');
    assert.match(problem.detail, /includes 1 seat/);
    assert.match(problem.detail, /buy a seat on acu & billing, revoke a seat, or move package/i);
    // Nothing was created on the way to the refusal.
    assert.equal(platform.users(tenantId).length, 1);
  });

  it('admits the person once a seat exists', async () => {
    // The remedy the refusal names, taken: the operator moves the tenancy to a
    // package with more seats, and the same request is accepted.
    platform.setSubscriptionPackage({
      tenantId,
      package: 'CORE_PROJECT',
      reason: 'Pilot agreement — seats for the delivery team',
      decidedBy: 'operator',
      grantFree: true,
    });
    const response = await fetch(`${base}/v1/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ name: 'Second Person', email: 'second@solosurveys.example', roles: ['PLANNER'] }),
    });
    assert.equal(response.status, 201, await response.text());
    assert.equal(platform.users(tenantId).length, 2);
  });
});
