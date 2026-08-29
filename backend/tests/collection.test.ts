import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import * as collection from '../src/billing/collection.ts';
import { standing } from '../src/billing/entitlement.ts';
import { PACKAGES } from '../src/billing/seats.ts';
import { config } from '../src/config.ts';
import { Platform } from '../src/platform.ts';

/**
 * Taking the monthly subscription, and stopping when it does not arrive.
 *
 * `renewsAt` was set thirty days out at signup and moved by nothing. The
 * operator's forecast warned that a renewal was approaching, and
 * `monthlySubscriptionCharge` could say what a period was worth — and no code
 * anywhere raised the charge, took the money, or noticed that it had not
 * arrived. A customer could sign up, use the platform for a year, and never be
 * asked for a penny.
 *
 * The gap between "the period fell due" and "the money arrived" is the whole
 * subject, so the tests below are mostly about what happens *in* it: the grace
 * window, what a second scheduler tick must not do, and what settling one
 * invoice out of two must not buy.
 */

const DAY = 86_400_000;
let platform: Platform;

beforeEach(() => {
  platform = new Platform();
  collection.setCollector(collection.NO_PAYMENT_METHOD);
});

/** A paying tenancy, and the day its first period falls due. */
function paying(packageTier: 'SOLO' | 'CORE_PROJECT' = 'CORE_PROJECT') {
  const { tenant } = platform.createTenant({
    legalName: 'Paying Ltd',
    jurisdiction: 'GB',
    defaultCurrency: 'GBP',
    tier: packageTier === 'SOLO' ? 'SOLO' : 'TEAM',
    package: packageTier,
    enterpriseName: 'Paying',
  });
  const subscription = platform.subscription(tenant.id)!;
  return { tenant, subscription, dueAt: new Date(Date.parse(subscription.renewsAt)) };
}

const after = (from: Date, days: number) => new Date(from.getTime() + days * DAY);

describe('a period that falls due is charged', () => {
  it('raises the charge for what the package costs', () => {
    const { tenant, dueAt } = paying();
    const raised = collection.raiseCharge(platform, tenant.id, after(dueAt, 1))!;

    assert.equal(raised.alreadyRaised, false);
    assert.equal(raised.charge.amountMinor, PACKAGES.CORE_PROJECT.monthlyPriceMinor);
    assert.equal(raised.charge.status, 'DUE');
    assert.equal(raised.charge.currency, 'GBP');
  });

  it('raises nothing before the period is up', () => {
    const { tenant, dueAt } = paying();
    assert.equal(collection.raiseCharge(platform, tenant.id, after(dueAt, -1)), undefined);
  });

  it('bills a period once, however many times the scheduler fires', () => {
    // A timer that fires twice in a minute, or a deployment that replays, must
    // not bill a customer twice — and "have we already billed this period" is
    // answerable from the record rather than from a lock somebody remembers.
    const { tenant, dueAt } = paying();
    collection.raiseCharge(platform, tenant.id, after(dueAt, 1))!;

    // The second call raises nothing at all: the renewal has already moved on,
    // so the next period is not due yet. Two guards, and this is the outer one
    // — `alreadyRaised` behind it catches a period that somehow comes round
    // twice, which is the case a clock change or a restored journal produces.
    assert.equal(collection.raiseCharge(platform, tenant.id, after(dueAt, 1)), undefined);
    assert.equal(collection.chargesFor(platform, tenant.id).length, 1);
    assert.equal(collection.outstanding(platform, tenant.id).length, 1, 'one period billed once');
  });

  it('moves the renewal on even though nothing was paid', () => {
    // A renewal date that waited for payment would raise the same charge every
    // day somebody was late, and the debt would be the number of times the
    // scheduler ran rather than the number of months they owed.
    const { tenant, subscription, dueAt } = paying();
    collection.raiseCharge(platform, tenant.id, after(dueAt, 1));

    const moved = platform.subscription(tenant.id)!;
    assert.ok(moved.renewsAt > subscription.renewsAt, 'the renewal date did not move');
    assert.equal(collection.outstanding(platform, tenant.id).length, 1, 'the charge was settled by moving the date');
  });

  it('charges a free trial nothing', () => {
    const { tenant } = platform.createTenant({
      legalName: 'Evaluating Ltd',
      jurisdiction: 'GB',
      defaultCurrency: 'GBP',
      tier: 'FREE_TRIAL',
      package: 'FREE_TRIAL',
      enterpriseName: 'Evaluating',
    });
    const renews = new Date(Date.parse(platform.subscription(tenant.id)!.renewsAt));
    assert.equal(collection.raiseCharge(platform, tenant.id, after(renews, 1)), undefined);
  });

  it('stops charging a cancelled subscription', () => {
    // Continuing to raise charges against a subscription somebody ended would
    // build a debt nobody agreed to.
    const { tenant, dueAt } = paying();
    platform.setSubscriptionStatus({ tenantId: tenant.id, status: 'CANCELLED', reason: 'Customer left', decidedBy: 'ops' });
    assert.equal(collection.raiseCharge(platform, tenant.id, after(dueAt, 1)), undefined);
  });
});

describe('the attempt, and what it says when it cannot be made', () => {
  it('records the reason rather than swallowing it', async () => {
    // A tenancy about to be suspended has to be able to show what was tried and
    // what it said. "We took your platform away" with no attempt on the record
    // is not a conversation anybody wins.
    const { tenant, dueAt } = paying();
    const raised = collection.raiseCharge(platform, tenant.id, after(dueAt, 1))!;
    const outcome = await collection.attemptCollection(platform, raised.charge, after(dueAt, 1));

    assert.equal(outcome.settled, false);
    if (!outcome.settled) assert.match(outcome.because, /no payment method/i);

    const stored = collection.requireCharge(platform, raised.charge.id);
    assert.equal(stored.attempts.length, 1);
    assert.match(stored.attempts[0]!.because, /no payment method/i);
  });

  it('settles the charge when a collector can take the money', async () => {
    collection.setCollector(async ({ amountMinor }) => ({ settled: true, reference: 'ch_test_1', amountMinor }));

    const { tenant, dueAt } = paying();
    const raised = collection.raiseCharge(platform, tenant.id, after(dueAt, 1))!;
    await collection.attemptCollection(platform, raised.charge, after(dueAt, 1));

    const stored = collection.requireCharge(platform, raised.charge.id);
    assert.equal(stored.status, 'SETTLED');
    assert.equal(stored.settlementReference, 'ch_test_1');
    assert.equal(collection.outstanding(platform, tenant.id).length, 0);
  });
});

describe('everything stops when the money does not arrive', () => {
  it('does not stop a tenancy inside its grace window', async () => {
    // Most late payments are not refusals. A card expires, a finance team is on
    // holiday, a bank holds a transfer — cutting somebody off the hour a
    // payment is late costs more than it saves.
    const { tenant, dueAt } = paying();
    await collection.runCollection(platform, after(dueAt, 1));

    const inGrace = after(dueAt, config.billing.subscriptionGraceDays - 1);
    assert.equal(collection.enforceUnpaid(platform, tenant.id, inGrace).suspended, false);
    assert.equal(platform.subscription(tenant.id)!.status, 'ACTIVE');
  });

  it('stops it once the grace window has run out', async () => {
    const { tenant, dueAt } = paying();
    await collection.runCollection(platform, after(dueAt, 1));

    const past = after(dueAt, config.billing.subscriptionGraceDays + 1);
    const stopped = collection.enforceUnpaid(platform, tenant.id, past);

    assert.equal(stopped.suspended, true);
    assert.match(String(stopped.because), /unpaid subscription period/i);
    assert.equal(platform.subscription(tenant.id)!.status, 'SUSPENDED');
  });

  it('closes writes, AI and export — which is what "everything stops" means', async () => {
    // The suspension is only worth anything if it reaches the gates. This is
    // the assertion that connects the billing cycle to the entitlement model
    // rather than trusting that they are wired together.
    const { tenant, dueAt } = paying();
    await collection.runCollection(platform, after(dueAt, 1));
    collection.enforceUnpaid(platform, tenant.id, after(dueAt, config.billing.subscriptionGraceDays + 1));

    const position = standing(platform.subscription(tenant.id), ['PM']);
    assert.equal(position.status, 'SUSPENDED');
    assert.equal(position.mayWrite, false);
    assert.equal(position.mayRunAI, false);
    assert.equal(position.mayExport, false);
  });

  it('suspends once rather than every hour after that', async () => {
    const { tenant, dueAt } = paying();
    await collection.runCollection(platform, after(dueAt, 1));
    const past = after(dueAt, config.billing.subscriptionGraceDays + 1);

    assert.equal(collection.enforceUnpaid(platform, tenant.id, past).suspended, true);
    assert.equal(collection.enforceUnpaid(platform, tenant.id, past).suspended, false, 'it suspended an already-suspended tenancy');
  });
});

describe('paying puts it back', () => {
  it('reinstates a suspended tenancy when the money arrives', async () => {
    const { tenant, dueAt } = paying();
    await collection.runCollection(platform, after(dueAt, 1));
    collection.enforceUnpaid(platform, tenant.id, after(dueAt, config.billing.subscriptionGraceDays + 1));
    assert.equal(platform.subscription(tenant.id)!.status, 'SUSPENDED');

    const owed = collection.outstanding(platform, tenant.id)[0]!;
    collection.settleCharge(platform, { chargeId: owed.id, reference: 'bank-transfer-4471' });

    assert.equal(platform.subscription(tenant.id)!.status, 'ACTIVE');
    assert.equal(standing(platform.subscription(tenant.id), ['PM']).mayWrite, true);
  });

  it('does not reinstate while an older period is still owed', async () => {
    // Otherwise a customer stays live for ever by always paying the oldest
    // invoice and never catching up.
    const { tenant, dueAt } = paying();
    await collection.runCollection(platform, after(dueAt, 1));
    await collection.runCollection(platform, after(dueAt, 31));
    collection.enforceUnpaid(platform, tenant.id, after(dueAt, 40));

    const owed = collection.outstanding(platform, tenant.id);
    assert.equal(owed.length, 2, 'two periods should be outstanding');

    collection.settleCharge(platform, { chargeId: owed[0]!.id, reference: 'part-payment' });
    assert.equal(platform.subscription(tenant.id)!.status, 'SUSPENDED', 'one payment of two reinstated the tenancy');

    collection.settleCharge(platform, { chargeId: owed[1]!.id, reference: 'the-rest' });
    assert.equal(platform.subscription(tenant.id)!.status, 'ACTIVE');
  });

  it('takes a repeated settlement as success, because a retried webhook is not a fault', () => {
    const { tenant, dueAt } = paying();
    collection.raiseCharge(platform, tenant.id, after(dueAt, 1));
    const owed = collection.outstanding(platform, tenant.id)[0]!;

    collection.settleCharge(platform, { chargeId: owed.id, reference: 'pi_1' });
    const again = collection.settleCharge(platform, { chargeId: owed.id, reference: 'pi_1' });

    assert.equal(again.status, 'SETTLED');
    assert.equal(again.settlementReference, 'pi_1', 'a retry overwrote the original reference');
  });
});

describe('one pass over the estate', () => {
  it('raises, attempts and stops in a single run, and names who it stopped', async () => {
    const { tenant, dueAt } = paying();

    const first = await collection.runCollection(platform, after(dueAt, 1));
    assert.equal(first.raised, 1);
    assert.equal(first.failed, 1);
    assert.equal(first.suspended, 0, 'it suspended inside the grace window');

    const later = await collection.runCollection(platform, after(dueAt, config.billing.subscriptionGraceDays + 1));
    assert.equal(later.suspended, 1);
    assert.deepEqual(
      later.suspendedTenants.map((t) => t.tenantId),
      [tenant.id],
      'a run that suspended somebody must name them rather than count them',
    );
  });

  it('is off unless somebody arms it', () => {
    // A billing timer that starts itself on a laptop, or on a staging box
    // restored from a production journal, raises charges against real
    // tenancies.
    assert.equal(config.billing.collectionEnabled, false);
    const schedule = collection.startCollectionSchedule(platform);
    schedule.stop();
  });
});
