import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { ACUWallet, effectiveMultiplier, minimumMultiplier } from '../src/billing/acu.ts';
import { assignIdentity, revokeIdentity, SeatLimitError, TIERS, type Subscription } from '../src/billing/subscription.ts';
import { buildInvoice, formatContractValue } from '../src/billing/invoice.ts';
import { ACU_BUNDLES, PACKAGES, SEATS, seatForRole } from '../src/billing/seats.ts';
import { config } from '../src/config.ts';

function wallet(balanceMinor = 10_000): ACUWallet {
  const w = new ACUWallet('tenant-1');
  w.topUp(balanceMinor);
  return w;
}

describe('ACU wallet', () => {
  it('charges the fixed multiplier over raw provider cost', () => {
    const w = wallet();
    const hold = w.reserve({ aiRequestId: 'req-1', estimatedRawCostMinor: 100 });
    const entry = w.settle(hold.holdId, 100, 'OPENAI');
    assert.equal(entry.rawCostMinor, 100);
    assert.equal(entry.billedMinor, 100 * config.billing.markupMultiplier);
  });

  it('never allows the balance to go negative', () => {
    const w = wallet(100);
    throwsCode(() => w.reserve({ aiRequestId: 'req-1', estimatedRawCostMinor: 1_000 }), 'ACU_EXHAUSTED');
    assert.equal(w.snapshot().balanceMinor, 100);
  });

  it('halts AI execution once credit is exhausted', () => {
    // Sized from the multiplier rather than from a literal, so the fixture
    // follows the price instead of quietly encoding last quarter's.
    const w = wallet(100 * config.billing.markupMultiplier);
    const hold = w.reserve({ aiRequestId: 'req-1', estimatedRawCostMinor: 100 });
    w.settle(hold.holdId, 100, 'OPENAI');
    assert.equal(w.snapshot().availableMinor, 0);
    assert.equal(w.snapshot().aiHalted, true);
    assert.throws(() => w.reserve({ aiRequestId: 'req-2', estimatedRawCostMinor: 1 }), /halted/);
  });

  it('ring-fences held funds so a second call cannot spend them', () => {
    // Two calls' worth of credit at the current rate, so the fixture tracks
    // the price rather than restating a number from a previous one.
    const charge = 100 * config.billing.markupMultiplier;
    const w = wallet(charge * 2);
    w.reserve({ aiRequestId: 'req-1', estimatedRawCostMinor: 100 });
    assert.equal(w.snapshot().heldMinor, charge);
    assert.equal(w.snapshot().availableMinor, charge);
    throwsCode(() => w.reserve({ aiRequestId: 'req-2', estimatedRawCostMinor: 200 }), 'ACU_EXHAUSTED');
  });

  it('charges nothing when an execution fails and its hold is released', () => {
    const w = wallet();
    const hold = w.reserve({ aiRequestId: 'req-1', estimatedRawCostMinor: 100 });
    w.release(hold.holdId, 'provider timeout');
    assert.equal(w.snapshot().balanceMinor, 10_000);
    assert.equal(w.snapshot().heldMinor, 0);
  });

  it('caps the charge at the amount reserved when an execution overruns its estimate', () => {
    const w = wallet();
    const hold = w.reserve({ aiRequestId: 'req-1', estimatedRawCostMinor: 100 });
    const entry = w.settle(hold.holdId, 500, 'OPENAI');
    assert.equal(entry.billedMinor, hold.heldMinor, 'the customer is never charged beyond the disclosed hold');
  });

  it('refuses to settle the same hold twice', () => {
    const w = wallet();
    const hold = w.reserve({ aiRequestId: 'req-1', estimatedRawCostMinor: 100 });
    w.settle(hold.holdId, 100, 'OPENAI');
    throwsCode(() => w.settle(hold.holdId, 100, 'OPENAI'), 'ACU_HOLD_NOT_FOUND');
  });

  it('enforces a monthly cap before contacting a provider', () => {
    const w = wallet(100_000);
    w.setCaps({ monthlyMinor: 500 });
    const hold = w.reserve({ aiRequestId: 'req-1', estimatedRawCostMinor: 100 });
    w.settle(hold.holdId, 100, 'OPENAI');
    assert.throws(() => w.reserve({ aiRequestId: 'req-2', estimatedRawCostMinor: 100 }), /Monthly AI cap/);
  });

  it('enforces per-project caps independently', () => {
    const w = wallet(100_000);
    w.setCaps({ perProjectMinor: { 'project-a': 400 } });
    const first = w.reserve({ aiRequestId: 'r1', estimatedRawCostMinor: 100, projectId: 'project-a' });
    w.settle(first.holdId, 100, 'OPENAI');
    assert.throws(() => w.reserve({ aiRequestId: 'r2', estimatedRawCostMinor: 100, projectId: 'project-a' }), /Project AI cap/);
    // A different project is unaffected.
    assert.ok(w.reserve({ aiRequestId: 'r3', estimatedRawCostMinor: 100, projectId: 'project-b' }));
  });

  it('raises alerts once per threshold', () => {
    const w = wallet(100_000);
    // Sized so three calls at the current rate land at 90% of the cap: high
    // enough to cross the 50% and 80% thresholds, low enough that nothing
    // breaches — a breach would halt execution and this test would be
    // measuring the cap rather than the alerts.
    const charge = 100 * config.billing.markupMultiplier;
    w.setCaps({ monthlyMinor: Math.ceil((charge * 3) / 0.9) });
    for (const request of ['r1', 'r2', 'r3']) {
      const hold = w.reserve({ aiRequestId: request, estimatedRawCostMinor: 100 });
      w.settle(hold.holdId, 100, 'OPENAI');
    }
    const thresholds = w.alerts().map((a) => a.threshold);
    assert.deepEqual(thresholds, [...new Set(thresholds)], 'alerts must not repeat for the same threshold');
    assert.ok(thresholds.includes(50));
    assert.ok(thresholds.includes(80));
  });

  it('attributes cost to the engine that spent it', () => {
    const w = wallet(100_000);
    for (const [request, module] of [['r1', 'PLANNING'], ['r2', 'PLANNING'], ['r3', 'TENDER']] as const) {
      const hold = w.reserve({ aiRequestId: request, estimatedRawCostMinor: 100, module });
      w.settle(hold.holdId, 100, 'OPENAI');
    }
    const attribution = w.attributionByModule();
    assert.equal(attribution.find((a) => a.module === 'PLANNING')?.calls, 2);
    assert.equal(attribution.find((a) => a.module === 'TENDER')?.calls, 1);
  });

  it('grants the free trial credit without a payment method', () => {
    const w = new ACUWallet('tenant-trial');
    w.grantTrialCredit();
    assert.equal(w.snapshot().availableMinor, config.billing.freeTrialGrantMinor);
    assert.equal(w.snapshot().aiHalted, false);
  });
});

describe('volume incentive', () => {
  it('holds the full multiplier at low monthly spend', () => {
    assert.equal(effectiveMultiplier(100_000, true), 4.0);
  });

  it('steps down for larger consumers while staying above cost', () => {
    assert.equal(effectiveMultiplier(500_000, true), 3.6);
    assert.equal(effectiveMultiplier(5_000_000, true), 3.3);
  });

  it('never discounts through the floor, whatever the bands say', () => {
    // The guard that makes "the platform never sells AI at a loss" a property
    // of the code rather than of whoever last tuned the band table. Every rate
    // the incentive can produce is at or above the floor.
    for (const spend of [0, 100_000, 500_000, 5_000_000, Number.MAX_SAFE_INTEGER]) {
      assert.ok(
        effectiveMultiplier(spend, true) >= minimumMultiplier(),
        `a monthly spend of ${spend} priced below the ${minimumMultiplier()}x floor`,
      );
    }
  });

  it('is off unless enabled for the tenant', () => {
    assert.equal(effectiveMultiplier(5_000_000, false), config.billing.markupMultiplier);
  });
});

describe('subscription seats', () => {
  const subscription: Subscription = {
    id: 'sub-1',
    tenantId: 'tenant-1',
    tier: 'SOLO',
    package: 'CORE_PROJECT',
    status: 'ACTIVE',
    assignedIdentities: [],
    startedAt: new Date().toISOString(),
    renewsAt: new Date().toISOString(),
  };

  const fill = (count: number) => {
    let current = subscription;
    for (let i = 0; i < count; i += 1) current = assignIdentity(current, `u${i}`);
    return current;
  };

  it('enforces the package seat cap', () => {
    const cap = PACKAGES.CORE_PROJECT.includedSeats as number;
    const current = fill(cap);
    assert.throws(() => assignIdentity(current, 'one-too-many'), SeatLimitError);
  });

  it('treats seats as reusable once revoked', () => {
    let current = fill(PACKAGES.CORE_PROJECT.includedSeats as number);
    current = revokeIdentity(current, 'u2');
    assert.doesNotThrow(() => assignIdentity(current, 'replacement'));
  });

  it('places no seat cap on the enterprise package', () => {
    assert.equal(PACKAGES.ENTERPRISE.includedSeats, null);
    assert.equal(PACKAGES.ENTERPRISE.isolatedTenancy, true);
    assert.equal(PACKAGES.ENTERPRISE.apiAccess, true);
  });

  it('does not charge a seat for the regulator or the platform operator', () => {
    // The asset owner is obliged to give the regulator access; selling them a
    // seat would make a statutory duty a line item.
    const withRegulator = assignIdentity(subscription, 'bsr-1', ['REGULATOR']);
    assert.deepEqual(withRegulator.assignedIdentities, []);
    assert.equal(withRegulator, subscription, 'an uncharged role leaves the subscription untouched');
  });

  it('is idempotent when the same identity is assigned twice', () => {
    const once = assignIdentity(subscription, 'u1');
    assert.deepEqual(assignIdentity(once, 'u1').assignedIdentities, ['u1']);
  });
});

describe('seat pricing', () => {
  it('prices every seat the review specifies', () => {
    const prices = Object.fromEntries(Object.values(SEATS).map((s) => [s.seat, s.monthlyPriceMinor]));
    assert.deepEqual(prices, {
      CONSTRUCTION_MANAGER: 18_000,
      PROJECT_MANAGER: 14_000,
      COMMERCIAL_MANAGER: 15_000,
      PLANNER: 11_000,
      DOCUMENT_CONTROLLER: 9_000,
      SITE_SUPERVISOR: 7_000,
      SUBCONTRACTOR: 2_500,
      EXECUTIVE: 12_000,
    });
  });

  it('prices authority above headcount', () => {
    // The whole point of role-based seats: the seat that can commit the job
    // costs more than the seat that reports on it.
    assert.ok(SEATS.CONSTRUCTION_MANAGER.monthlyPriceMinor > SEATS.PROJECT_MANAGER.monthlyPriceMinor);
    assert.ok(SEATS.PROJECT_MANAGER.monthlyPriceMinor > SEATS.SITE_SUPERVISOR.monthlyPriceMinor);
    assert.ok(SEATS.SITE_SUPERVISOR.monthlyPriceMinor > SEATS.SUBCONTRACTOR.monthlyPriceMinor);
  });

  it('maps every delivery role to a seat', () => {
    for (const role of ['EPC', 'PM', 'QS', 'PLANNER', 'BIM', 'DESIGNER', 'SUPERVISOR', 'QAQC', 'SAFETY', 'FM', 'SUPPLIER', 'OWNER'] as const) {
      assert.ok(seatForRole(role), `${role} has no seat price`);
    }
  });

  it('leaves the operator and the regulator unpriced', () => {
    assert.equal(seatForRole('PLATFORM_ADMIN'), undefined);
    assert.equal(seatForRole('REGULATOR'), undefined);
  });

  it('prices the three packages the review specifies', () => {
    assert.equal(PACKAGES.CORE_PROJECT.monthlyPriceMinor, 95_000);
    assert.equal(PACKAGES.PROFESSIONAL_DELIVERY.monthlyPriceMinor, 220_000);
    assert.equal(PACKAGES.ENTERPRISE.monthlyPriceMinor, 650_000);
    assert.equal(PACKAGES.CORE_PROJECT.includedSeats, 10);
    assert.equal(PACKAGES.PROFESSIONAL_DELIVERY.includedSeats, 25);
  });

  it('offers the three ACU bundles, each better value than the last', () => {
    const rate = (b: { priceMinor: number; usableAcus: number }) => b.usableAcus / b.priceMinor;
    assert.ok(rate(ACU_BUNDLES.GROWTH) > rate(ACU_BUNDLES.STARTER));
    assert.ok(rate(ACU_BUNDLES.SCALE) > rate(ACU_BUNDLES.GROWTH));
  });

  it('keeps AI out of the package, whatever the package', () => {
    // No package includes ACUs. If one ever did, the commercial promise that
    // AI is metered strictly by consumption would be false.
    for (const definition of Object.values(PACKAGES)) {
      assert.ok(!('includedAcus' in definition), `${definition.label} must not bundle AI`);
    }
  });
});

describe('invoicing', () => {
  it('separates the subscription line from AI usage and states the multiplier', () => {
    const w = wallet(100_000);
    const hold = w.reserve({ aiRequestId: 'r1', estimatedRawCostMinor: 100, module: 'PLANNING' });
    w.settle(hold.holdId, 100, 'OPENAI');

    const subscription: Subscription = {
      id: 'sub-1',
      tenantId: 'tenant-1',
      tier: 'BUSINESS',
      package: 'PROFESSIONAL_DELIVERY',
      status: 'ACTIVE',
      assignedIdentities: ['u1'],
      startedAt: new Date().toISOString(),
      renewsAt: new Date().toISOString(),
    };

    const invoice = buildInvoice(subscription, w, new Date().toISOString().slice(0, 7));
    assert.equal(invoice.subscriptionMinor, PACKAGES.PROFESSIONAL_DELIVERY.monthlyPriceMinor);
    assert.equal(invoice.aiUsageMinor, 100 * config.billing.markupMultiplier);
    assert.equal(invoice.aiRawCostMinor, 100);
    assert.equal(invoice.effectiveMultiplier, config.billing.markupMultiplier);
    assert.equal(invoice.totalMinor, invoice.subscriptionMinor + invoice.aiUsageMinor);
    assert.ok(invoice.commercialTerms.some((t) => t.includes('no AI usage entitlement')));
  });
});

describe('value formatting', () => {
  it('renders zero at portfolio level as $0.0M rather than $0.0B', () => {
    assert.equal(formatContractValue(0), '$0.0M');
  });

  it('picks the unit from the magnitude', () => {
    assert.equal(formatContractValue(50_000_000), '$0.5M');
    assert.equal(formatContractValue(240_000_000_000), '$2.4B');
    assert.equal(formatContractValue(50_000), '$0.5K');
  });
});
