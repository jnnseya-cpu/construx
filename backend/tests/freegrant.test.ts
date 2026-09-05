import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import * as collection from '../src/billing/collection.ts';
import * as engine from '../src/billing/estateengine.ts';
import { PACKAGES } from '../src/billing/seats.ts';
import { monthlySubscriptionCharge } from '../src/billing/subscription.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import { authOf } from '../src/seed.ts';

/**
 * A package granted free of charge owes nothing — not the first month, not a
 * renewal — and the wallet is still the tenancy's own to top up.
 *
 * Reported as: one account is exempt from any monthly cost but buys its ACUs by
 * topping up. The operator's door for that existed and recorded the decision on
 * the event; nothing read it. The response said £0 a month, `raiseCharge` read
 * the list price at every renewal, and a signup waiting for its first month
 * stayed waiting with the charge still due.
 */

const DAY = 86_400_000;
let platform: Platform;
let server: Server;
let base: string;
let operatorToken: string;
let operatorId = '';
let tenantId = '';
let adminToken = '';

function tokenFor(userId: string): string {
  const auth = authOf(platform, userId);
  return issueTokens({ actorId: auth.actorId, tenantId: auth.tenantId, partyId: auth.partyId, roles: auth.roles, mfaSatisfied: true }).accessToken;
}

async function send(method: string, path: string, token: string, payload?: unknown) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

before(async () => {
  platform = new Platform();
  collection.setCollector(collection.NO_PAYMENT_METHOD);
  const operator = platform.createOperator({ name: 'Ruth', email: 'ops@construx.example' });
  operatorId = operator.id;
  operatorToken = tokenFor(operator.id);
  // A stranger's paid signup: waiting for its first month, nothing in the wallet.
  const created = platform.createTenant({ legalName: 'JNN Global Ltd', jurisdiction: 'GB', defaultCurrency: 'GBP', tier: 'TEAM', package: 'CORE_PROJECT', enterpriseName: 'JNN Global', trialGrant: false, opensOn: 'FIRST_PAYMENT' });
  tenantId = created.tenant.id;
  const admin = platform.createUser({ tenantId, name: 'Jean Nseya', email: 'jean@jnnglobal.example', roles: ['ENTERPRISE_ADMIN'] });
  adminToken = tokenFor(admin.id);
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server.close());

describe('granting the package free of charge', () => {
  it('starts as a paid signup waiting for its first month', () => {
    assert.equal(platform.subscription(tenantId).status, 'AWAITING_PAYMENT');
    assert.equal(collection.outstanding(platform, tenantId).length, 1);
    assert.equal(platform.wallet(tenantId).snapshot().balanceMinor, 0);
  });

  it('opens the tenancy, writes off the first month, and leaves the wallet at nothing', async () => {
    const granted = await send('POST', `/v1/admin/tenants/${tenantId}/package`, operatorToken, {
      package: 'CORE_PROJECT',
      reason: 'JNN Global Ltd is exempt from the monthly subscription; it buys ACUs by topping up',
      grantFree: true,
    });
    assert.equal(granted.status, 201, JSON.stringify(granted.body));
    assert.equal(granted.body.grantedFree, true);
    assert.equal(granted.body.status, 'ACTIVE');
    assert.equal(granted.body.monthlyPriceMinor, 0);
    assert.ok(Number(granted.body.listPriceMinor) > 0);

    const subscription = platform.subscription(tenantId);
    assert.equal(subscription.status, 'ACTIVE');
    assert.equal(subscription.grantedFree, true);
    assert.equal(monthlySubscriptionCharge(subscription), 0);
    assert.equal(collection.outstanding(platform, tenantId).length, 0, 'the first month is no longer owed');
    assert.ok(collection.chargesFor(platform, tenantId).some((charge) => charge.status === 'WRITTEN_OFF'));
    assert.equal(platform.wallet(tenantId).snapshot().balanceMinor, 0, 'a free package credits no AI');
  });

  it('raises nothing at renewal', () => {
    const subscription = platform.subscription(tenantId);
    const raised = collection.raiseCharge(platform, tenantId, new Date(Date.parse(subscription.renewsAt) + DAY));
    assert.equal(raised, undefined);
    assert.equal(collection.outstanding(platform, tenantId).length, 0);
    assert.equal(collection.raiseOpeningCharge(platform, tenantId), undefined, 'and no opening charge either');
  });

  it('the customer sees no monthly price and the operator sees the grant', async () => {
    const own = await send('GET', '/v1/billing/subscription', adminToken);
    assert.equal(own.status, 200, JSON.stringify(own.body));
    const summary = own.body.subscription as Record<string, unknown>;
    assert.equal(summary.grantedFree, true);
    assert.equal(summary.monthlyPriceMinor, 0);
    assert.equal(summary.listPriceMinor, PACKAGES.CORE_PROJECT.monthlyPriceMinor);
    assert.equal(summary.status, 'ACTIVE');

    const estate = await send('GET', '/v1/admin/tenants', operatorToken);
    const row = (estate.body.tenants as Array<Record<string, unknown>>).find((entry) => entry.id === tenantId)!;
    assert.equal(row.grantedFree, true);
    assert.equal(row.monthlyPriceMinor, 0);
    assert.equal(row.outstandingMinor, 0);
    assert.equal(row.status, 'ACTIVE');

    const position = engine.estatePosition(platform, new Date(Date.now() + 40 * DAY));
    const checks = new Map(position.sweep.map((finding) => [finding.check, finding]));
    assert.equal(checks.get('First payment')!.ok, true);
    assert.equal(checks.get('Collection')!.ok, true, checks.get('Collection')!.detail);
  });

  it('still buys its AI by topping up', async () => {
    const credited = await send('POST', `/v1/admin/tenants/${tenantId}/credit`, operatorToken, { amountMinor: 10_000, method: 'BANK_TRANSFER', reference: 'FPS-JNN-0001' });
    assert.equal(credited.status, 201, JSON.stringify(credited.body));
    assert.equal(platform.wallet(tenantId).snapshot().availableMinor, 10_000);
    // A top-up is a receipt, not a subscription payment: nothing about the grant moves.
    assert.equal(platform.subscription(tenantId).grantedFree, true);
    assert.equal(collection.outstanding(platform, tenantId).length, 0);
  });

  it('survives a seat change and a restart', () => {
    platform.createUser({ tenantId, name: 'Esi Mensah', email: 'esi@jnnglobal.example', roles: ['PLANNER'] });
    const rebuilt = new Platform();
    rebuilt.ledger.restore(platform.ledger.events());
    rebuilt.rehydrate();
    const restored = rebuilt.subscription(tenantId);
    assert.equal(restored.grantedFree, true, 'the grant is on the record, not in memory');
    assert.equal(restored.assignedIdentities.length, 2);
    assert.equal(collection.raiseCharge(rebuilt, tenantId, new Date(Date.parse(restored.renewsAt) + DAY)), undefined);
  });

  it('granting the same package free again changes nothing', () => {
    const before = platform.ledger.events().length;
    platform.setSubscriptionPackage({ tenantId, package: 'CORE_PROJECT', reason: 'Said twice', decidedBy: operatorId, grantFree: true });
    assert.equal(platform.ledger.events().length, before);
  });

  it('can be withdrawn: the same package, paid again from the next renewal', () => {
    const paid = platform.setSubscriptionPackage({ tenantId, package: 'CORE_PROJECT', reason: 'Exemption ended by agreement', decidedBy: operatorId, grantFree: false });
    assert.equal(paid.grantedFree, false);
    assert.equal(monthlySubscriptionCharge(paid), PACKAGES.CORE_PROJECT.monthlyPriceMinor);
    const raised = collection.raiseCharge(platform, tenantId, new Date(Date.parse(paid.renewsAt) + DAY));
    assert.ok(raised && !raised.alreadyRaised, 'a paid package is charged at renewal');
    assert.equal(raised!.charge.amountMinor, PACKAGES.CORE_PROJECT.monthlyPriceMinor);
  });
});
