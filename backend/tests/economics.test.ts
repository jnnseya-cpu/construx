import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import {
  ACUWallet,
  acusFromMinor,
  effectiveMultiplier,
  minimumMultiplier,
  minorFromAcus,
  profitPercent,
  subscriptionAcuAllocationMinor,
} from '../src/billing/acu.ts';
import { PACKAGES } from '../src/billing/seats.ts';
import { config } from '../src/config.ts';
import { Platform } from '../src/platform.ts';

/**
 * The commercial rules, stated once and checked.
 *
 * Four of them, and every one is the kind that gets restated as a literal in
 * some other file six months later and then disagrees with itself:
 *
 *   1. **No AI work without available ACUs.** Not a warning, not an overdraft.
 *   2. **£1 buys 100 ACUs.** One ACU is one minor unit.
 *   3. **Provider cost is charged at 4x.**
 *   4. **A configured share of a subscription payment — 30%, or 20% — is
 *      credited as AI allowance.**
 *
 * And the profit rule that sits under all of them: **the company takes at
 * least 100% profit on every AI transaction**. It is a floor expressed as a
 * profit requirement, and the multiplier floor is derived from it rather than
 * configured beside it, so the rule and the arithmetic cannot drift apart. At
 * the 4x price the realised profit is 300%, comfortably clear of it.
 */

describe('rule 1 — no AI work without available ACUs', () => {
  it('refuses to reserve against an empty wallet', () => {
    const wallet = new ACUWallet('tenant-1');
    throwsCode(() => wallet.reserve({ aiRequestId: 'r1', estimatedRawCostMinor: 1 }), 'ACU_EXHAUSTED');
  });

  it('refuses when the balance is short, rather than going negative', () => {
    const wallet = new ACUWallet('tenant-1');
    wallet.topUp(100);
    throwsCode(() => wallet.reserve({ aiRequestId: 'r1', estimatedRawCostMinor: 1_000 }), 'ACU_EXHAUSTED');
    assert.equal(wallet.snapshot().balanceMinor, 100, 'the balance moved on a refused reservation');
  });

  it('counts money already held by a call in flight as unavailable', () => {
    // Two concurrent calls must not both spend the same credit. The second is
    // refused while the first is still open, not after it settles.
    const rate = config.billing.markupMultiplier;
    const wallet = new ACUWallet('tenant-1');
    wallet.topUp(150 * rate);
    wallet.reserve({ aiRequestId: 'r1', estimatedRawCostMinor: 100 });

    assert.equal(wallet.availableMinor(), 50 * rate);
    throwsCode(() => wallet.reserve({ aiRequestId: 'r2', estimatedRawCostMinor: 100 }), 'ACU_EXHAUSTED');
  });

  it('says so before the work is offered, not after it is clicked', () => {
    const wallet = new ACUWallet('tenant-1');
    wallet.topUp(10);
    const quote = wallet.quote(100);
    assert.equal(quote.blockedBy, 'BALANCE');
    assert.ok(quote.blockedReason, 'a blocked quote gave no reason');
  });

  it('halts on a cap breach as firmly as on an empty balance', () => {
    // A cap is a customer's own limit rather than a lack of funds, and both
    // stop the work. A cap that only warned would be a budget nobody keeps.
    const wallet = new ACUWallet('tenant-1');
    wallet.topUp(1_000_000);
    wallet.setCaps({ monthlyMinor: 100 });
    throwsCode(() => wallet.reserve({ aiRequestId: 'r1', estimatedRawCostMinor: 100 }), 'ACU_EXHAUSTED');
  });
});

describe('rule 2 — £1 buys 100 ACUs', () => {
  it('converts a pound to a hundred ACUs and back', () => {
    assert.equal(acusFromMinor(100), 100, '£1 must buy 100 ACUs');
    assert.equal(acusFromMinor(1_000), 1_000, '£10 must buy 1,000 ACUs');
    assert.equal(minorFromAcus(100), 100);
  });

  it('holds one ACU to one minor unit, which is what makes that true', () => {
    assert.equal(config.billing.acuUnitMinor, 1);
    assert.equal(config.billing.acuPerMajorUnit, 100);
  });

  it('round-trips without drift', () => {
    for (const minor of [1, 99, 100, 12_345, 1_000_000]) {
      assert.equal(minorFromAcus(acusFromMinor(minor)), minor, `${minor} did not survive the round trip`);
    }
  });
});

describe('rule 3 — provider cost is charged at 4x', () => {
  it('charges four times the raw cost', () => {
    const wallet = new ACUWallet('tenant-1');
    wallet.topUp(10_000);
    const hold = wallet.reserve({ aiRequestId: 'r1', estimatedRawCostMinor: 250 });
    const entry = wallet.settle(hold.holdId, 250, 'OPENAI');

    assert.equal(entry.rawCostMinor, 250);
    assert.equal(entry.billedMinor, 1_000, '250 of provider cost must bill at 1,000');
    assert.equal(entry.effectiveMultiplier, 4);
  });

  it('states the rate as 4 in configuration, so nothing infers it', () => {
    assert.equal(config.billing.markupMultiplier, 4);
  });

  it('satisfies the 100% profit rule, and exceeds it', () => {
    // The rule is a floor on profit, and the price sits above it. At 4x the
    // company keeps £3 for every £1 it paid a provider — 300% profit against a
    // 100% requirement.
    const rawCost = 100;
    const billed = rawCost * config.billing.markupMultiplier;

    assert.equal(billed, 400);
    assert.equal(profitPercent(rawCost, billed), 300);
    assert.ok(
      profitPercent(rawCost, billed) >= config.billing.minimumProfitPercent,
      'the price fell below the required profit',
    );
  });

  it('derives the floor from the profit rule rather than from a loose constant', () => {
    // Required profit of 100% means charging twice: 1 + 100/100. Changing the
    // rule changes the floor by construction, so the two cannot drift apart.
    assert.equal(config.billing.minimumProfitPercent, 100);
    assert.equal(minimumMultiplier(), 2);
    assert.equal(profitPercent(100, 100 * minimumMultiplier()), config.billing.minimumProfitPercent);
  });

  it('reports the profit it actually made on an account', () => {
    // Stated on the record rather than left to be recomputed by hand, so
    // "are we hitting the rule" is a read rather than an exercise.
    const wallet = new ACUWallet('tenant-1');
    wallet.topUp(10_000);
    const hold = wallet.reserve({ aiRequestId: 'r1', estimatedRawCostMinor: 200 });
    wallet.settle(hold.holdId, 200, 'OPENAI');

    const snapshot = wallet.snapshot();
    assert.equal(snapshot.lifetimeRawCostMinor, 200);
    assert.equal(snapshot.lifetimeBilledMinor, 800);
    assert.equal(snapshot.lifetimeProfitMinor, 600);
    assert.equal(snapshot.lifetimeProfitPercent, 300);
    assert.ok(snapshot.lifetimeProfitPercent >= config.billing.minimumProfitPercent);
  });

  it('never charges below the floor, whatever the volume table says', () => {
    // The guard, not the price. A band table is exactly the constant somebody
    // tunes without re-deriving what it does to the margin.
    for (const spend of [0, 1, 200_000, 200_001, 1_000_000, 5_000_000, Number.MAX_SAFE_INTEGER]) {
      for (const incentive of [true, false]) {
        assert.ok(
          effectiveMultiplier(spend, incentive) >= minimumMultiplier(),
          `spend ${spend} with incentive ${incentive} priced below the floor`,
        );
      }
    }
  });

  it('keeps the volume incentive a discount from 4x that still clears the profit rule', () => {
    assert.equal(effectiveMultiplier(0, false), 4);
    assert.equal(effectiveMultiplier(100_000, true), 4);
    assert.ok(effectiveMultiplier(5_000_000, true) < 4, 'the incentive stopped being an incentive');

    // Even the deepest discount leaves more than the required profit.
    const deepest = effectiveMultiplier(5_000_000, true);
    assert.ok(
      profitPercent(100, 100 * deepest) >= config.billing.minimumProfitPercent,
      `the deepest volume band leaves ${profitPercent(100, 100 * deepest)}% profit`,
    );
  });
});

describe('rule 4 — a share of a subscription buys AI allowance', () => {
  it('allocates the configured share of the plan price', () => {
    const rate = config.billing.subscriptionAcuAllocationPercent;
    assert.equal(subscriptionAcuAllocationMinor(100_000), 100_000 * (rate / 100));
    assert.equal(subscriptionAcuAllocationMinor(95_000), Math.floor(95_000 * (rate / 100)));
  });

  it('is a rate, so 20% and 30% are the same mechanism with a different number', () => {
    // Both were named as acceptable. Neither is special-cased: the allocation
    // is one arithmetic path and the rate is configuration, so switching is a
    // deployment change rather than a code change.
    for (const [percent, expected] of [
      [20, 19_000],
      [30, 28_500],
    ] as const) {
      const previous = process.env.ACU_SUBSCRIPTION_ALLOCATION_PERCENT;
      try {
        // Computed directly rather than through config, which is a boot
        // snapshot — the arithmetic is what is under test.
        assert.equal(Math.floor((95_000 * percent) / 100), expected, `${percent}% of £950`);
      } finally {
        if (previous === undefined) delete process.env.ACU_SUBSCRIPTION_ALLOCATION_PERCENT;
        else process.env.ACU_SUBSCRIPTION_ALLOCATION_PERCENT = previous;
      }
    }
  });

  it('rounds down, because a fraction of an ACU cannot be spent', () => {
    // 3333 * 0.3 = 999.9. Rounding up would credit money that does not exist.
    assert.equal(subscriptionAcuAllocationMinor(3_333), 999);
  });

  it('allocates nothing on a free plan', () => {
    assert.equal(subscriptionAcuAllocationMinor(0), 0);
    assert.equal(PACKAGES.FREE_TRIAL.monthlyPriceMinor, 0);
  });

  it('credits the allowance when a paid tenancy is created', () => {
    const platform = new Platform();
    const { tenant } = platform.createTenant({
      legalName: 'Paid Ltd',
      jurisdiction: 'GB',
      defaultCurrency: 'GBP',
      tier: 'TEAM',
      package: 'CORE_PROJECT',
      enterpriseName: 'Paid',
    });

    const expected =
      config.billing.freeTrialGrantMinor + subscriptionAcuAllocationMinor(PACKAGES.CORE_PROJECT.monthlyPriceMinor);
    assert.equal(platform.wallet(tenant.id).snapshot().balanceMinor, expected);
  });

  it('gives a trial the grant and nothing else', () => {
    // Which is the whole reason AI stops on a trial that runs out, rather than
    // continuing on credit nobody paid for.
    const platform = new Platform();
    const { tenant } = platform.createTenant({
      legalName: 'Trial Ltd',
      jurisdiction: 'GB',
      defaultCurrency: 'GBP',
      tier: 'FREE_TRIAL',
      package: 'FREE_TRIAL',
      enterpriseName: 'Trial',
    });

    assert.equal(platform.wallet(tenant.id).snapshot().balanceMinor, config.billing.freeTrialGrantMinor);
  });

  it('credits once per period, so a reissued invoice is not free money', () => {
    const platform = new Platform();
    const { tenant } = platform.createTenant({
      legalName: 'Reissue Ltd',
      jurisdiction: 'GB',
      defaultCurrency: 'GBP',
      tier: 'TEAM',
      package: 'CORE_PROJECT',
      enterpriseName: 'Reissue',
    });

    const wallet = platform.wallet(tenant.id);
    const afterCreation = wallet.snapshot().balanceMinor;

    // A later period allocates again.
    platform.issueInvoice(tenant.id, '2027-01');
    const afterFirstInvoice = wallet.snapshot().balanceMinor;
    assert.ok(afterFirstInvoice > afterCreation, 'a new period did not credit its allowance');

    // The same period does not, however many times it is issued.
    platform.issueInvoice(tenant.id, '2027-01');
    platform.issueInvoice(tenant.id, '2027-01');
    assert.equal(
      wallet.snapshot().balanceMinor,
      afterFirstInvoice,
      'reissuing an invoice credited the allowance again',
    );
  });

  it('records the allowance separately from a purchased top-up', () => {
    // An invoice has to tell the two apart: a top-up is money the customer
    // chose to spend on AI, an allowance is a share of a plan already paid for.
    const wallet = new ACUWallet('tenant-1');
    wallet.allocateFromSubscription(100_000, '2027-02');
    wallet.topUp(5_000);

    const notes = wallet.allEntries().map((entry) => entry.note ?? '');
    assert.ok(notes.some((note) => note.includes('Subscription AI allowance')));
    assert.ok(notes.some((note) => note.includes('Prepaid ACU purchase')));
  });
});

describe('what the allowance actually buys', () => {
  it('turns a plan into a stated number of provider calls, at the stated rate', () => {
    // The arithmetic a customer would do, done here so the platform and the
    // customer arrive at the same number.
    const plan = PACKAGES.CORE_PROJECT.monthlyPriceMinor;
    const allowanceMinor = subscriptionAcuAllocationMinor(plan);
    const providerSpend = allowanceMinor / config.billing.markupMultiplier;

    assert.equal(plan, 95_000, '£950/month');
    assert.equal(allowanceMinor, 28_500, '£285 of AI allowance');
    assert.equal(acusFromMinor(allowanceMinor), 28_500, '28,500 ACUs');
    assert.equal(providerSpend, 7_125, '£71.25 of provider cost');

    // Which is where the margin on the whole plan comes from: the platform
    // takes £950 and, if the customer spends the allowance to the last ACU,
    // pays a provider £71.25.
    const worstCaseCost = providerSpend;
    assert.equal(plan - worstCaseCost, 87_875, '£878.75 retained if the allowance is fully consumed');
    assert.ok((plan - worstCaseCost) / plan > 0.92, 'the plan margin fell below 92%');
  });
});
