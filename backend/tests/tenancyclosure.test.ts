import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import * as collection from '../src/billing/collection.ts';
import { PACKAGES } from '../src/billing/seats.ts';
import { authOf } from '../src/seed.ts';
import { Platform } from '../src/platform.ts';
import { issueTokens } from '../src/identity/auth.ts';

/**
 * Closing a customer's tenancy, and what it is owed.
 *
 * Requested as: the operator deletes an enterprise, every user attached to it
 * ends, and unused accounts are refunded automatically. Nothing on this
 * platform is deleted — the record is evidence — so closure is: subscription
 * cancelled (read-only), every identity deactivated and scheduled for erasure
 * through the ordinary grace period, the wallet emptied, and the refund owed
 * raised as an obligation with its basis. There is no rail that moves money
 * back on its own, so the operator settles it and records the reference.
 */

let platform: Platform;
let server: Server;
let base: string;
let tenantId: string;
let operatorToken: string;
let adminId: string;

function tokenFor(userId: string): string {
  const auth = authOf(platform, userId);
  return issueTokens({ actorId: auth.actorId, tenantId: auth.tenantId, partyId: auth.partyId, roles: auth.roles, mfaSatisfied: true })
    .accessToken;
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
  const created = platform.createTenant({
    legalName: 'Leaving Ltd',
    jurisdiction: 'GB',
    defaultCurrency: 'GBP',
    tier: 'TEAM',
    package: 'CORE_PROJECT',
    enterpriseName: 'Leaving',
    trialGrant: false,
  });
  tenantId = created.tenant.id;
  adminId = platform.createUser({ tenantId, name: 'Rowan Adeyemi', email: 'rowan@leaving.example', roles: ['ENTERPRISE_ADMIN'] }).id;
  platform.createUser({ tenantId, name: 'Esi Mensah', email: 'esi@leaving.example', roles: ['PLANNER'] });
  const operator = platform.createUser({ tenantId: 'platform', name: 'Ops', email: 'ops@construx.example', roles: ['PLATFORM_ADMIN'] });
  operatorToken = tokenFor(operator.id);

  // The customer has paid £40 of AI credit in. The package's monthly AI
  // allowance is in the wallet too, and is not the customer's money.
  platform.wallet(tenantId).topUp(4_000, 'Card payment');

  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server.close());

describe('the refund position', () => {
  it('refunds the unspent part of what was paid in, never the allowance', () => {
    const position = platform.refundPosition(tenantId);
    // £40 paid in and nothing spent; the subscription allowance was credited
    // too but is not the customer's money. The lesser of balance and paid-in
    // is what is owed — here, exactly what was paid.
    assert.equal(platform.wallet(tenantId).paidInMinor(), 4_000);
    assert.ok(platform.wallet(tenantId).availableMinor() > 4_000, 'the allowance sits in the wallet too');
    assert.equal(position.walletMinor, 4_000);
    assert.equal(position.subscriptionMinor, 0, 'no settled charge yet, so nothing is owed for the period');
    assert.equal(position.totalMinor, position.walletMinor);
  });

  it('owes the unused days of a settled period, pro rata', () => {
    const subscription = platform.subscription(tenantId);
    const dueAt = new Date(Date.parse(subscription.renewsAt) + 60_000);
    const raised = collection.raiseCharge(platform, tenantId, dueAt)!;
    collection.settleCharge(platform, { chargeId: raised.charge.id, reference: 'BANK-1' });
    // Half way through the new period, half the charge is unused.
    const renewed = platform.subscription(tenantId);
    const start = Date.parse(raised.charge.periodStart);
    const end = Date.parse(renewed.renewsAt);
    const halfway = new Date(start + (end - start) / 2);
    const position = platform.refundPosition(tenantId, halfway);
    const expected = Math.round(PACKAGES.CORE_PROJECT.monthlyPriceMinor / 2);
    assert.ok(Math.abs(position.subscriptionMinor - expected) <= 1, `${position.subscriptionMinor} vs ${expected}`);
  });
});

describe('closing', () => {
  it('is the operator’s act, and refuses the platform and the demonstration', async () => {
    const admin = await send('POST', `/v1/admin/tenants/${tenantId}/close`, tokenFor(adminId), { reason: 'We are leaving the platform' });
    assert.equal(admin.status, 403);
    const own = await send('POST', '/v1/admin/tenants/platform/close', operatorToken, { reason: 'Closing the platform itself' });
    assert.equal(own.status, 422);
    assert.equal(own.body.title, 'CANNOT_CLOSE_PLATFORM_TENANCY');
    const short = await send('POST', `/v1/admin/tenants/${tenantId}/close`, operatorToken, { reason: 'bye' });
    assert.equal(short.status, 400);
  });

  it('previews what would happen', async () => {
    const preview = await send('GET', `/v1/admin/tenants/${tenantId}/closure`, operatorToken);
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.equal(preview.body.identities, 2);
    assert.equal(preview.body.active, 2);
    assert.ok(Number((preview.body.refund as Record<string, number>).totalMinor) > 0);
  });

  it('cancels, deactivates everybody, schedules erasure, empties the wallet and raises the refund', async () => {
    const before = platform.refundPosition(tenantId);
    const closed = await send('POST', `/v1/admin/tenants/${tenantId}/close`, operatorToken, { reason: 'Customer gave notice on 1 September' });
    assert.equal(closed.status, 201, JSON.stringify(closed.body));
    assert.equal(closed.body.identitiesDeactivated, 2);
    const refund = closed.body.refund as Record<string, unknown>;
    assert.equal(refund.status, 'DUE');
    assert.equal(refund.totalMinor, before.totalMinor);
    assert.equal(refund.walletMinor, before.walletMinor);

    assert.equal(platform.subscription(tenantId).status, 'CANCELLED');
    assert.equal(platform.subscription(tenantId).assignedIdentities.length, 0, 'every seat released');
    for (const user of platform.users(tenantId)) {
      assert.equal(user.status, 'SUSPENDED');
      assert.ok(user.erasureDueAt, 'erasure scheduled through the grace period');
    }
    assert.throws(() => platform.login('rowan@leaving.example'), (error: { code?: string }) => error.code === 'USER_SUSPENDED');
    assert.equal(platform.wallet(tenantId).availableMinor(), 0, 'the wallet is emptied against the refund');
    assert.ok(platform.tenant(tenantId).closedAt);

    const again = await send('POST', `/v1/admin/tenants/${tenantId}/close`, operatorToken, { reason: 'Customer gave notice on 1 September' });
    assert.equal(again.status, 409);
    assert.equal(again.body.title, 'TENANT_ALREADY_CLOSED');
  });

  it('lists the refund as due, and the estate row says the tenancy is closed', async () => {
    const refunds = await send('GET', '/v1/admin/refunds', operatorToken);
    assert.equal(refunds.status, 200);
    const list = refunds.body.refunds as Array<Record<string, unknown>>;
    assert.equal(list.length, 1);
    assert.equal(list[0]!.status, 'DUE');
    assert.equal(refunds.body.dueMinor, list[0]!.totalMinor);

    const tenants = await send('GET', '/v1/admin/tenants', operatorToken);
    const row = (tenants.body.tenants as Array<Record<string, unknown>>).find((t) => t.id === tenantId)!;
    assert.ok(row.closedAt);
    assert.equal(row.status, 'CANCELLED');
  });

  it('is settled with a reference, once', async () => {
    const refunds = await send('GET', '/v1/admin/refunds', operatorToken);
    const refund = (refunds.body.refunds as Array<Record<string, unknown>>)[0]!;
    const noRef = await send('POST', `/v1/admin/refunds/${refund.id}/settle`, operatorToken, { reference: '' });
    assert.equal(noRef.status, 400);
    const settled = await send('POST', `/v1/admin/refunds/${refund.id}/settle`, operatorToken, { reference: 'FPS-20260903-0042' });
    assert.equal(settled.status, 201, JSON.stringify(settled.body));
    assert.equal(settled.body.status, 'SETTLED');
    assert.equal(settled.body.settlementReference, 'FPS-20260903-0042');
    const twice = await send('POST', `/v1/admin/refunds/${refund.id}/settle`, operatorToken, { reference: 'FPS-20260903-0043' });
    assert.equal(twice.status, 409);
    const after = await send('GET', '/v1/admin/refunds', operatorToken);
    assert.equal(after.body.dueMinor, 0);
  });

  it('survives a restart', () => {
    const rebuilt = new Platform();
    rebuilt.ledger.restore(platform.ledger.events());
    rebuilt.rehydrate();
    assert.ok(rebuilt.tenant(tenantId).closedAt);
    assert.equal(rebuilt.refunds().length, 1);
    assert.equal(rebuilt.refunds()[0]!.status, 'SETTLED');
  });
});
