import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createGateway } from '../src/api/gateway.ts';
import * as collection from '../src/billing/collection.ts';
import * as engine from '../src/billing/estateengine.ts';
import { config } from '../src/config.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import { authOf } from '../src/seed.ts';

/**
 * The estate read as a whole: whether every customer can run their tenancy,
 * whether what is owed is arriving, whether what is owed back has been paid,
 * and whether the register says what is live — every check against the
 * subscriptions, the charges, the receipts, the identities and the wallets.
 */

const DAY = 86_400_000;
let platform: Platform;
let server: Server;
let base: string;
let operatorToken: string;
let operator: ReturnType<typeof authOf>;
let runningId = '';
let unrunId = '';
let waitingId = '';
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

const byCheck = (findings: readonly engine.EstateFinding[]) => new Map(findings.map((finding) => [finding.check, finding]));

before(async () => {
  platform = new Platform();
  collection.setCollector(collection.NO_PAYMENT_METHOD);
  const ops = platform.createOperator({ name: 'Ruth', email: 'ops@construx.example' });
  operator = authOf(platform, ops.id);
  operatorToken = tokenFor(ops.id);
  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(() => server.close());

describe('an empty estate', () => {
  it('weighs to a hundred, fails nothing, and offers to onboard the first tenancy', () => {
    const position = engine.estatePosition(platform);
    assert.equal(position.sweep.reduce((sum, finding) => sum + finding.weight, 0), 100);
    assert.equal(position.sweep.length, 11);
    assert.ok(position.sweep.every((finding) => finding.ok), position.health.summary);
    assert.equal(position.health.score, 100);
    assert.equal(position.health.band, 'STRONG');
    assert.match(position.health.summary, /no customer tenancies/);
    assert.equal(position.results.totals.tenancies.open, 0);
    assert.equal(position.results.series.length, 0);
    assert.ok(position.recommendations.some((item) => item.action?.command === 'onboard'));
    assert.ok(position.limits.length >= 3);
  });
});

describe('a working estate and its faults', () => {
  it('reads three tenancies and finds the one nobody can run', async () => {
    // A paying customer, run by an administrator, its first month settled.
    const running = platform.createTenant({ legalName: 'Running Ltd', jurisdiction: 'GB', defaultCurrency: 'GBP', tier: 'TEAM', package: 'CORE_PROJECT', enterpriseName: 'Running', trialGrant: false });
    runningId = running.tenant.id;
    const admin = platform.createUser({ tenantId: runningId, name: 'Rowan Adeyemi', email: 'rowan@running.example', roles: ['ENTERPRISE_ADMIN'] });
    adminToken = tokenFor(admin.id);
    platform.recordSubscriptionPayment({ tenantId: runningId, chargeId: running.openingCharge!.id, method: 'BANK_TRANSFER', reference: 'FPS-RUN-0001', recordedBy: operator.actorId, source: 'OPERATOR' });

    // Provisioned by the operator on a free package and never given a person.
    const unrun = platform.createTenant({ legalName: 'Nobody Home Ltd', jurisdiction: 'GB', defaultCurrency: 'GBP', tier: 'FREE_TRIAL', enterpriseName: 'Nobody Home', trialGrant: false });
    unrunId = unrun.tenant.id;

    // A stranger's paid signup, waiting for its first month.
    const waiting = platform.createTenant({ legalName: 'Waiting Ltd', jurisdiction: 'GB', defaultCurrency: 'GBP', tier: 'SOLO', package: 'SOLO', enterpriseName: 'Waiting', trialGrant: false, opensOn: 'FIRST_PAYMENT' });
    waitingId = waiting.tenant.id;
    platform.createUser({ tenantId: waitingId, name: 'Wren Okafor', email: 'wren@waiting.example', roles: ['ENTERPRISE_ADMIN'] });
    assert.equal(platform.subscription(waitingId).status, 'AWAITING_PAYMENT');

    const position = engine.estatePosition(platform);
    const checks = byCheck(position.sweep);
    assert.equal(checks.get('Administrators')!.ok, false);
    assert.match(checks.get('Administrators')!.detail, /Nobody Home Ltd/);
    assert.equal(checks.get('First payment')!.ok, true, 'a signup a moment old is not stale');
    assert.match(checks.get('First payment')!.detail, /1 tenancy waiting/);
    assert.equal(checks.get('Collection')!.ok, true, checks.get('Collection')!.detail);
    assert.equal(checks.get('Switched off')!.ok, true);
    assert.equal(checks.get('Register')!.ok, true);
    assert.equal(position.health.score, 88);
    assert.equal(position.health.band, 'WORKABLE');

    assert.equal(position.results.totals.tenancies.open, 3);
    assert.equal(position.results.totals.tenancies.active, 2);
    assert.equal(position.results.totals.tenancies.awaitingPayment, 1);
    assert.equal(position.results.totals.people.active, 2);
    assert.equal(position.results.totals.people.administrators, 2);
    assert.equal(position.results.totals.money.lifetimeRevenueMinor, running.openingCharge!.amountMinor);
    assert.equal(position.results.series.length, 1);
    assert.equal(position.results.series[0]!.joined, 3);
    assert.equal(position.results.series[0]!.receipts, 1);

    const noAdmin = position.recommendations.find((item) => item.title.includes('Nobody Home Ltd'));
    assert.ok(noAdmin, 'the tenancy nobody can run is a recommendation');
    assert.equal(noAdmin!.priority, 'HIGH');
    assert.equal(noAdmin!.action?.command, 'close');
    assert.equal(noAdmin!.action?.tenantId, unrunId);
    assert.deepEqual(position.attention.find((entry) => entry.tenantId === unrunId)?.flags, ['no administrator']);
  });

  it('sees the first month go stale and the running period fall past due, and points at the charge', () => {
    const later = new Date(Date.now() + 20 * DAY);
    // The running tenancy's renewal falls due and is raised; nobody pays.
    const raised = collection.raiseCharge(platform, runningId, new Date(Date.now() + 31 * DAY));
    assert.ok(raised && !raised.alreadyRaised);
    const at = new Date(Date.now() + 33 * DAY);

    const position = engine.estatePosition(platform, at);
    const checks = byCheck(position.sweep);
    assert.equal(checks.get('First payment')!.ok, false);
    assert.match(checks.get('First payment')!.detail, /Waiting Ltd/);
    assert.equal(checks.get('Collection')!.ok, false);
    // Due on the renewal date thirty days in; read three days after it.
    assert.match(checks.get('Collection')!.detail, /Running Ltd .*3 days late, stops/);

    const settle = position.recommendations.filter((item) => item.action?.command === 'settle-charge');
    assert.equal(settle.length, 2, 'one door per unpaid charge');
    assert.ok(settle.some((item) => item.action?.tenantId === runningId && item.action.chargeId === raised!.charge.id));
    assert.ok(settle.some((item) => item.action?.tenantId === waitingId && item.action.chargeId === collection.outstanding(platform, waitingId)[0]!.id));
    assert.deepEqual(position.attention.find((entry) => entry.tenantId === waitingId)?.flags, ['first payment overdue']);

    // Past the grace and still running: the estate says so rather than falling silent.
    const afterGrace = engine.estatePosition(platform, new Date(at.getTime() + (config.billing.subscriptionGraceDays + 1) * DAY));
    assert.match(byCheck(afterGrace.sweep).get('Collection')!.detail, /grace ended .* and still running/);
    void later;
  });

  it('settling the running tenancy’s period clears the collection finding', () => {
    const due = collection.outstanding(platform, runningId)[0]!;
    platform.recordSubscriptionPayment({ tenantId: runningId, chargeId: due.id, method: 'BANK_TRANSFER', reference: 'FPS-RUN-0002', recordedBy: operator.actorId, source: 'OPERATOR' });
    const position = engine.estatePosition(platform, new Date(Date.now() + 33 * DAY));
    assert.equal(byCheck(position.sweep).get('Collection')!.ok, true);
  });

  it('a disputed payment freezes the wallet, and the sweep offers to unfreeze it once nothing is open', async () => {
    const credited = await send('POST', `/v1/admin/tenants/${runningId}/credit`, operatorToken, { amountMinor: 5_000, method: 'CARD', reference: 'CARD-RUN-0003' });
    assert.equal(credited.status, 201, JSON.stringify(credited.body));
    const disputed = await send('POST', `/v1/admin/tenants/${runningId}/payments/reverse`, operatorToken, { reference: 'CARD-RUN-0003', amountMinor: 5_000, kind: 'DISPUTE', eventId: 'dp_0003' });
    assert.equal(disputed.status, 201, JSON.stringify(disputed.body));
    assert.equal(disputed.body.frozen, true);

    const position = engine.estatePosition(platform);
    const checks = byCheck(position.sweep);
    assert.equal(checks.get('Frozen wallets')!.ok, false);
    assert.match(checks.get('Frozen wallets')!.detail, /Running Ltd/);
    // Nothing had been spent, so nothing is short and no exception is open.
    assert.equal(checks.get('Payment exceptions')!.ok, true, checks.get('Payment exceptions')!.detail);
    const door = position.recommendations.find((item) => item.action?.command === 'unfreeze');
    assert.ok(door, 'a frozen wallet with no open dispute offers the unfreeze door');
    assert.equal(door!.action?.tenantId, runningId);
    assert.ok(position.attention.find((entry) => entry.tenantId === runningId)?.flags.includes('wallet frozen'));
  });

  it('a closed tenancy: its refund comes due, then it is ready to delete and its erasures fall due', () => {
    const closed = platform.closeTenant(operator, { tenantId: waitingId, reason: 'Never paid for the first month; abandoned signup' });
    assert.ok(closed.tenant.closedAt);

    const soon = engine.estatePosition(platform, new Date(Date.now() + DAY));
    let checks = byCheck(soon.sweep);
    assert.equal(checks.get('First payment')!.ok, true, 'a closed tenancy is no longer waiting');
    assert.equal(checks.get('Refunds')!.ok, true, 'a refund a day old is not late');
    assert.equal(checks.get('Register')!.ok, true, 'a closed tenancy inside its grace stays on the register');
    assert.equal(soon.results.totals.tenancies.closed, 1);
    assert.equal(soon.results.totals.tenancies.open, 2);
    assert.equal(soon.results.series[0]!.closed, 1);

    const refunds = platform.refunds().filter((refund) => refund.status === 'DUE');
    const late = engine.estatePosition(platform, new Date(Date.now() + (engine.REFUND_DAYS + 1) * DAY));
    checks = byCheck(late.sweep);
    if (refunds.length > 0) {
      assert.equal(checks.get('Refunds')!.ok, false);
      const door = late.recommendations.find((item) => item.action?.command === 'settle');
      assert.ok(door, 'a late refund offers the record-the-refund door');
      assert.equal(door!.action?.refundId, refunds[0]!.id);
    } else {
      assert.equal(checks.get('Refunds')!.ok, true, 'nothing was paid in, so nothing is owed back');
    }

    const afterGrace = engine.estatePosition(platform, new Date(Date.now() + (config.privacy.erasureGraceDays + 1) * DAY));
    checks = byCheck(afterGrace.sweep);
    assert.equal(checks.get('Erasures')!.ok, false);
    assert.match(checks.get('Erasures')!.detail, /1 identity past the grace period/);
    assert.equal(checks.get('Register')!.ok, false);
    assert.match(checks.get('Register')!.detail, /Waiting Ltd/);
    assert.ok(afterGrace.recommendations.some((item) => item.action?.command === 'people' && item.action.tenantId === waitingId));
    assert.ok(afterGrace.recommendations.some((item) => item.action?.command === 'delete' && item.action.tenantId === waitingId));
    const flags = afterGrace.attention.find((entry) => entry.tenantId === waitingId)?.flags ?? [];
    assert.ok(flags.includes('ready to delete') && flags.includes('1 erasure overdue'), flags.join(', '));
    // Administrators 12, Frozen wallets 8, Erasures 8, Register 6 failing: 66.
    assert.equal(afterGrace.health.score, 66, afterGrace.health.summary);
    assert.equal(afterGrace.health.band, 'WORKABLE');
  });

  it('a suspended tenancy is switched off and still open, and the door is the status', () => {
    platform.setSubscriptionStatus({ tenantId: runningId, status: 'SUSPENDED', reason: 'Test — customer asked to pause', decidedBy: operator.actorId });
    const position = engine.estatePosition(platform);
    assert.equal(byCheck(position.sweep).get('Switched off')!.ok, false);
    const door = position.recommendations.find((item) => item.action?.command === 'status');
    assert.equal(door?.action?.tenantId, runningId);
    platform.setSubscriptionStatus({ tenantId: runningId, status: 'ACTIVE', reason: 'Test — resumed', decidedBy: operator.actorId });
    assert.equal(byCheck(engine.estatePosition(platform).sweep).get('Switched off')!.ok, true);
  });

  it('the health band follows the weights that pass', () => {
    const score = engine.healthScore(
      [
        { check: 'A', ok: true, weight: 60, detail: '' },
        { check: 'B', ok: false, weight: 30, detail: '' },
        { check: 'C', ok: true, weight: 10, detail: '' },
      ],
      3,
    );
    assert.equal(score.score, 70);
    assert.equal(score.band, 'WORKABLE');
    assert.equal(score.passing, 2);
    assert.match(score.summary, /1 check failing, costliest first: B/);
  });
});

describe('the route', () => {
  it('serves the position to the operator and refuses a customer administrator', async () => {
    const position = await send('GET', '/v1/admin/tenants/position', operatorToken);
    assert.equal(position.status, 200, JSON.stringify(position.body));
    const health = position.body.health as { score: number; total: number };
    assert.equal(health.total, 11);
    assert.ok(Array.isArray(position.body.sweep));
    assert.ok(Array.isArray(position.body.recommendations));
    assert.ok(Array.isArray(position.body.attention));
    assert.ok((position.body.results as { totals: unknown }).totals);

    const refused = await send('GET', '/v1/admin/tenants/position', adminToken);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.title, 'PLATFORM_ADMIN_REQUIRED');
  });

  it('the estate register still carries every row the engine flags', async () => {
    const estate = await send('GET', '/v1/admin/tenants', operatorToken);
    assert.equal(estate.status, 200);
    const rows = estate.body.tenants as Array<{ id: string }>;
    const position = await send('GET', '/v1/admin/tenants/position', operatorToken);
    for (const entry of position.body.attention as Array<{ tenantId: string }>) {
      assert.ok(rows.some((row) => row.id === entry.tenantId), `${entry.tenantId} flagged but not on the register`);
    }
  });
});
