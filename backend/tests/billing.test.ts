import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { ALL_ROLES, OPERATOR_ONLY_ROLES } from '../src/identity/roles.ts';
import { ACUWallet, effectiveMultiplier, minimumMultiplier, profitPercent, subscriptionAcuAllocationMinor } from '../src/billing/acu.ts';
import { assignIdentity, revokeIdentity, SeatLimitError, TIERS, type Subscription } from '../src/billing/subscription.ts';
import { buildInvoice, formatContractValue } from '../src/billing/invoice.ts';
import { ACU_BUNDLES, PACKAGES, SEATS, UNCHARGED_ROLES, seatForRole } from '../src/billing/seats.ts';
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

  it('charges an overrun in full, and says so on the entry', () => {
    // Estimate 100 raw, held at 5× = 500. Actual 150 raw bills 750, and 750 is
    // what is charged: the profit floor is the price, so the cap at the
    // disclosed hold can never win.
    //
    // This asserted the opposite until the floor moved. The rule is that £1 of
    // provider cost produces £5 with no exceptions, so the customer pays for
    // what the run actually cost rather than what it was estimated at — and
    // the whole exposure that creates rests on the entry saying so, which is
    // why the note is asserted rather than treated as decoration.
    const w = wallet();
    const hold = w.reserve({ aiRequestId: 'req-1', estimatedRawCostMinor: 100 });
    const entry = w.settle(hold.holdId, 150, 'OPENAI');

    assert.equal(entry.billedMinor, 150 * config.billing.markupMultiplier, 'an overrun is charged at the rate');
    assert.ok(entry.billedMinor > hold.heldMinor, 'the charge did not exceed the estimate, so nothing overran');
    assert.match(String(entry.note), /above the estimate/i, 'an overrun that is not disclosed is a surprise');
    assert.match(String(entry.note), new RegExp(String(hold.heldMinor)), 'the note must name what was quoted');
  });

  it('will not honour the cap by selling below cost', () => {
    /*
     * This test used to assert the opposite, and the opposite was a leak.
     *
     * Estimate 100 raw, held at 4x = 400. Actual 500 raw. Capping at the hold
     * charged 400 for something that cost 500 — a straight loss, on every call
     * whose answer turned out much larger than its question. The estimator
     * assumes output is a quarter of input, so a short prompt against a schema
     * demanding a long list produces exactly this, repeatably, for anybody who
     * noticed.
     *
     * The cap yields to the company's own profit floor: never below
     * `minimumMultiplier` on the cost actually incurred. Since the floor was
     * raised to the price, that is every settlement rather than only the large
     * overruns — but this case is the one the floor was written for, and it is
     * kept as the case that must never regress whatever the floor is set to.
     */
    const w = wallet();
    const hold = w.reserve({ aiRequestId: 'req-1', estimatedRawCostMinor: 100 });
    const entry = w.settle(hold.holdId, 500, 'OPENAI');

    assert.ok(entry.billedMinor > hold.heldMinor, 'the cap was honoured at the platform\'s expense');
    assert.equal(entry.billedMinor, Math.ceil(500 * minimumMultiplier()), 'charged at the profit floor');
    assert.ok(
      profitPercent(entry.rawCostMinor, entry.billedMinor) >= config.billing.minimumProfitPercent,
      'an overrun was settled below the required profit',
    );
    assert.match(String(entry.note), /above the estimate/i, 'an overrun must say so on the entry');
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
    // One call's worth at the current rate, so the second breaches. Derived
    // rather than written as a figure: a cap fixture pinned to the old
    // multiplier stops testing the cap and starts testing the rate.
    w.setCaps({ perProjectMinor: { 'project-a': 100 * config.billing.markupMultiplier } });
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

  it('says whether each module ran on a model or on this platform', () => {
    // This list used to be AI engines and nothing else. It is now billed either
    // way — a document render and a site reconstruction are in it, and both are
    // arithmetic this platform performs rather than a model somebody was
    // charged for thinking. The screen labelled every row "Engine", so a
    // customer reading "Site capture, 5 executions" beside "BIM twin" would
    // conclude their site data had been through a model. That is a statement
    // about where their data went, not a caption.
    const w = wallet(100_000);
    const spend = (module: string, provider: string, request: string) => {
      const hold = w.reserve({ aiRequestId: request, estimatedRawCostMinor: 100, module });
      w.settle(hold.holdId, 100, provider);
    };
    spend('TENDER', 'OPENAI', 'r1');
    spend('SITE_CAPTURE', 'LOCAL', 'r2');
    spend('SITE_CAPTURE', 'LOCAL', 'r3');
    spend('BIM_TWIN', 'OPENAI', 'r4');
    spend('BIM_TWIN', 'LOCAL', 'r5');

    const by = new Map(w.attributionByModule().map((row) => [row.module, row.basis]));
    assert.equal(by.get('TENDER'), 'MODEL');
    assert.equal(by.get('SITE_CAPTURE'), 'LOCAL', 'compute this platform performed was presented as a model call');
    // A module that did both must not claim to be either. Rounding it to
    // "MODEL" overstates where the data went; rounding it to "LOCAL"
    // understates it, which is worse.
    assert.equal(by.get('BIM_TWIN'), 'MIXED');
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
    assert.equal(effectiveMultiplier(100_000, true), 5.0);
  });

  it('charges 5x at every level of spend, with no step down', () => {
    // The bands stepped 4.0 → 3.6 → 3.3 and were flattened by decision: the
    // price is 5x and there is no rate below it anywhere in the platform. A
    // tenant spending a million a month pays the same multiplier as one
    // spending ten pounds.
    for (const spend of [0, 100_000, 500_000, 5_000_000, Number.MAX_SAFE_INTEGER]) {
      assert.equal(
        effectiveMultiplier(spend, true),
        config.billing.markupMultiplier,
        `a monthly spend of ${spend} was not charged at the headline rate`,
      );
    }
  });

  it('is the same rate whether or not the incentive is switched on', () => {
    // The mechanism is retained and audited so a band could be reintroduced
    // deliberately. Until one is, the switch changes nothing — which is the
    // property worth asserting, because a flag that silently discounts is how
    // a rate below the headline would come back without anyone deciding it.
    for (const spend of [0, 500_000, 5_000_000]) {
      assert.equal(effectiveMultiplier(spend, true), effectiveMultiplier(spend, false));
    }
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
      // The CDM 2015 statutory duty holder. Its own seat rather than folded
      // into the document controller: this role approves designs and owns
      // design risk elimination, and pricing it with the drawing register
      // would say the platform thinks those are the same job.
      PRINCIPAL_DESIGNER: 13_000,
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
    // Enumerated from the role list rather than hand-written, so a role added
    // later without a seat fails here instead of failing when somebody tries to
    // assign it. The hand-written list was already stale: it predated five
    // roles, and would have kept passing while none of them could be bought.
    for (const role of ALL_ROLES) {
      if (OPERATOR_ONLY_ROLES.includes(role)) continue;
      if (UNCHARGED_ROLES.includes(role)) continue;
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

  it('offers the three ACU bundles at one rate, because 4x is the rate', () => {
    // This asserted that each bundle was better value than the last, which was
    // true when the yield was hardcoded at a 3x-era ladder. With a flat
    // multiplier a bundle is a convenience — fewer transactions, one purchase
    // order — and not a discount, and the catalogue must not imply otherwise.
    const rate = (b: { priceMinor: number; usableAcus: number }) => b.usableAcus / b.priceMinor;
    assert.equal(rate(ACU_BUNDLES.GROWTH), rate(ACU_BUNDLES.STARTER));
    assert.equal(rate(ACU_BUNDLES.SCALE), rate(ACU_BUNDLES.GROWTH));
  });

  it('offers a top-up a Solo customer can actually buy', () => {
    // The ladder was built when the cheapest package was £950. With the
    // cheapest now £100, a customer who ran out in week three had to spend
    // three times their monthly subscription to carry on — which is not a
    // top-up, it is a reason to stop using the product.
    const solo = ACU_BUNDLES.SOLO;
    assert.equal(solo.priceMinor, 5_000, 'the smallest top-up is £50');
    assert.ok(
      solo.priceMinor < PACKAGES.SOLO.monthlyPriceMinor,
      'the smallest top-up costs more than a month of the package it is for',
    );
    // Worth buying: more than the monthly allowance it tops up.
    assert.ok(
      solo.usableAcus > subscriptionAcuAllocationMinor(PACKAGES.SOLO.monthlyPriceMinor),
      'the smallest top-up credits less than a Solo month, so it barely helps',
    );
  });

  it('publishes four top-ups, in price order', () => {
    const prices = Object.values(ACU_BUNDLES).map((b) => b.priceMinor);
    assert.equal(prices.length, 4);
    assert.deepEqual(prices, [...prices].sort((a, b) => a - b), 'the catalogue is not in price order');
  });

  it('publishes a yield derived from the multiplier, not a stale number', () => {
    // Two defects, and the second is the one that survived longest.
    //
    // First: 10,000 / 40,000 / 110,000 ACUs were advertised — the figures a 3x
    // markup produces — while billing ran at 4x, so the catalogue promised a
    // third more than the engine would ever deliver. Deriving the figure fixed
    // that, and the move to 5x then needed no edit at all.
    //
    // Second: what was derived was the wrong quantity. `usableAcus` was
    // price ÷ markup, which is the *provider work* the credit funds, while a
    // package advertises its wallet credit — and both were called ACUs on the
    // same site. A £300 bundle credits 30,000 ACUs and said 6,000, understating
    // itself fivefold against the package beside it. The two only ever looked
    // consistent because the allocation is 20% and the markup is 5×, so both
    // happened to work out at price ÷ 5.
    const rate = config.billing.markupMultiplier;
    for (const bundle of Object.values(ACU_BUNDLES)) {
      assert.equal(bundle.multiplier, rate);
      // The credit, on the same basis as a package's monthly allowance.
      assert.equal(bundle.usableAcus, bundle.priceMinor, `${bundle.bundle} does not credit what it costs`);
      // And what that credit buys, under a name that says what it is.
      assert.equal(bundle.providerCostMinor, Math.floor(bundle.priceMinor / rate));
    }
    assert.equal(ACU_BUNDLES.STARTER.usableAcus, 30_000, '£300 credits 30,000 ACUs');
    assert.equal(ACU_BUNDLES.STARTER.providerCostMinor, 6_000, 'which funds £60 of provider work at 5x');
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
  it('bills storage that is held, which nothing used to', () => {
    // Blocks could be bought and never appeared on an invoice, so the platform
    // carried the disk and charged nothing for it — a cost with no revenue
    // against it, recurring for as long as the customer kept the data.
    const w = wallet(1_000);
    const subscription: Subscription = {
      id: 'sub-s',
      tenantId: 'tenant-s',
      tier: 'BUSINESS',
      package: 'PROFESSIONAL_DELIVERY',
      status: 'ACTIVE',
      assignedIdentities: ['u1'],
      startedAt: new Date().toISOString(),
      renewsAt: new Date().toISOString(),
    };

    const without = buildInvoice(subscription, w, new Date().toISOString().slice(0, 7), 'GBP', 0);
    const withBlocks = buildInvoice(subscription, w, new Date().toISOString().slice(0, 7), 'GBP', 3);

    assert.equal(without.storageMinor, 0);
    assert.equal(withBlocks.storageMinor, 3 * config.billing.storageBlockPriceMinor);
    assert.equal(withBlocks.totalMinor, without.totalMinor + withBlocks.storageMinor, 'held storage is not payable');
    assert.ok(
      withBlocks.lines.some((line) => line.category === 'STORAGE'),
      'the customer must see what the storage charge is for',
    );
  });

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

    // The total is the subscription, not the subscription plus the AI.
    //
    // It used to be both, which billed the customer twice: once when they
    // bought the credit — the wallet is prepaid, `acu.ts` opens by saying so —
    // and again on the invoice for having spent it. AI stays on the invoice as
    // a line, because somebody is entitled to see what their credit went on;
    // what it is not is payable a second time.
    assert.equal(invoice.totalMinor, invoice.subscriptionMinor, 'AI usage was charged again on the invoice');
    assert.equal(invoice.aiUsageDrawnFromCredit, true, 'the invoice must say why the lines exceed the total');
    assert.ok(invoice.aiUsageMinor > 0, 'the consumption is still shown');
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
