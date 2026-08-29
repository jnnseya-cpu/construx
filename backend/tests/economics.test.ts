import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
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
import { throwsCode } from './helpers.ts';
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
 *   4. **20% of a subscription payment is credited as AI allowance.**
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

describe('rule 3 — provider cost is charged at 5x', () => {
  it('charges five times the raw cost', () => {
    const wallet = new ACUWallet('tenant-1');
    wallet.topUp(10_000);
    const hold = wallet.reserve({ aiRequestId: 'r1', estimatedRawCostMinor: 250 });
    const entry = wallet.settle(hold.holdId, 250, 'OPENAI');

    assert.equal(entry.rawCostMinor, 250);
    assert.equal(entry.billedMinor, 1_250, '250 of provider cost must bill at 1,250');
    assert.equal(entry.effectiveMultiplier, 5);
  });

  it('states the rate as 5 in configuration, so nothing infers it', () => {
    // The rate the business states: five times provider cost. Pinned as a
    // literal here on purpose — everything else in the platform derives from
    // `config.billing.markupMultiplier`, so this is the one assertion that
    // would fail if the number itself were changed without a decision.
    assert.equal(config.billing.markupMultiplier, 5);
  });

  it('meets the rule that every £1 of provider cost produces £5', () => {
    // The business rule in its own terms. £1 spent with a provider must return
    // £5, which is 400% profit on what was paid out.
    const rawCost = 100;
    const billed = rawCost * config.billing.markupMultiplier;

    assert.equal(billed, 500, '£1 of provider cost must produce £5');
    assert.equal(profitPercent(rawCost, billed), 400);
    assert.ok(
      profitPercent(rawCost, billed) >= config.billing.minimumProfitPercent,
      'the price fell below the required profit',
    );
  });

  it('derives the floor from the profit rule rather than from a loose constant', () => {
    // Required profit of 400% means charging five times: 1 + 400/100. Changing
    // the rule changes the floor by construction, so the two cannot drift apart.
    assert.equal(config.billing.minimumProfitPercent, 400);
    assert.equal(minimumMultiplier(), 5);
    assert.equal(profitPercent(100, 100 * minimumMultiplier()), config.billing.minimumProfitPercent);
  });

  it('sets the floor at the price, so there is no case that produces less than £5', () => {
    // The rule as instructed, and the whole of it: £1 of provider cost produces
    // £5, with no discount, no band and no cap that could make it less.
    assert.equal(minimumMultiplier(), config.billing.markupMultiplier);
    for (const spend of [0, 200_000, 1_000_000, Number.MAX_SAFE_INTEGER]) {
      for (const incentive of [true, false]) {
        assert.ok(
          effectiveMultiplier(spend, incentive) >= minimumMultiplier(),
          `spend ${spend} with incentive ${incentive} priced below the rule`,
        );
      }
    }
  });

  it('charges an overrun in full, which is what the floor at the price means', () => {
    // The consequence, asserted rather than left to be discovered. `settle`
    // capped an execution at the amount reserved and disclosed unless the cap
    // would sell below the floor. With the floor at the price the cap can never
    // win, so a run that costs more than its estimate is charged for what it
    // cost — and the entry has to say so, because that is the only thing
    // standing between a customer and a surprise.
    const wallet = new ACUWallet('tenant-1');
    wallet.topUp(100_000);
    const hold = wallet.reserve({ aiRequestId: 'r1', estimatedRawCostMinor: 100 });
    const entry = wallet.settle(hold.holdId, 150, 'OPENAI');

    assert.equal(entry.billedMinor, 150 * config.billing.markupMultiplier);
    assert.ok(entry.billedMinor > hold.heldMinor, 'the estimate was not exceeded, so this proves nothing');
    assert.match(String(entry.note), /above the estimate/i, 'an overrun was charged without being disclosed');
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
    assert.equal(snapshot.lifetimeBilledMinor, 1_000);
    assert.equal(snapshot.lifetimeProfitMinor, 800);
    assert.equal(snapshot.lifetimeProfitPercent, 400);
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

  it('charges 5x at every level of spend, and never less', () => {
    // This asserted the opposite — that a large consumer was discounted below
    // the headline. The bands were flattened by decision: 5x is the price and
    // no rate below it exists anywhere in the platform.
    for (const spend of [0, 100_000, 5_000_000, Number.MAX_SAFE_INTEGER]) {
      for (const incentive of [true, false]) {
        assert.equal(
          effectiveMultiplier(spend, incentive),
          5,
          `spend ${spend} with incentive ${incentive} was not charged at 5x`,
        );
      }
    }
  });

  it('clears the profit rule at the rate it actually charges', () => {
    // The floor is still the guard. It mattered more when the bands discounted;
    // it matters now as the thing that stops a future edit selling at a loss.
    const rate = effectiveMultiplier(5_000_000, true);
    assert.ok(
      profitPercent(100, 100 * rate) >= config.billing.minimumProfitPercent,
      `charging at ${rate}x leaves ${profitPercent(100, 100 * rate)}% profit`,
    );
  });
});

describe('rule 4 — 20% of a subscription buys AI allowance', () => {
  it('allocates the configured share of the plan price', () => {
    const rate = config.billing.subscriptionAcuAllocationPercent;
    assert.equal(subscriptionAcuAllocationMinor(100_000), 100_000 * (rate / 100));
    assert.equal(subscriptionAcuAllocationMinor(95_000), Math.floor(95_000 * (rate / 100)));
  });

  it('allocates twenty per cent', () => {
    assert.equal(config.billing.subscriptionAcuAllocationPercent, 20);
    assert.equal(subscriptionAcuAllocationMinor(95_000), 19_000, '20% of £950 is £190');
    assert.equal(subscriptionAcuAllocationMinor(220_000), 44_000, '20% of £2,200 is £440');
  });

  it('rounds down, because a fraction of an ACU cannot be spent', () => {
    // 3333 * 0.2 = 666.6. Rounding up would credit money that does not exist.
    assert.equal(subscriptionAcuAllocationMinor(3_333), 666);
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

  it('credits once per period, and refuses periods that are worth money to invent', () => {
    /*
     * The allowance is money: twenty per cent of the plan, credited when a
     * period is billed. The wallet refuses a second allocation for the *same*
     * period, and that was the only guard — nothing stopped anybody asking for
     * a different one. `POST /v1/billing/invoice` was tenant-callable with a
     * client-supplied period, so a loop from 2020-01 to 2030-12 minted a
     * hundred and thirty-two months of allowance for free.
     *
     * This test used to bill 2027-01 to show "a later period allocates again",
     * which is exactly the hole: 2027-01 has not happened. Issuing is now
     * operator-only and the period must be real.
     */
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
    const period = new Date().toISOString().slice(0, 7);

    // A new tenancy has exactly one billable period, and creation already
    // credited it. Reissuing the invoice for it credits nothing further, which
    // is what makes a corrected or retried invoice safe.
    const atCreation = wallet.snapshot().balanceMinor;
    platform.issueInvoice(tenant.id, period);
    platform.issueInvoice(tenant.id, period);
    assert.equal(wallet.snapshot().balanceMinor, atCreation, 'reissuing an invoice credited the allowance again');

    // A month that has not happened cannot have been consumed.
    const nextYear = String(Number(period.slice(0, 4)) + 1);
    throwsCode(() => platform.issueInvoice(tenant.id, `${nextYear}-01`), 'INVOICE_PERIOD_FUTURE');

    // Nor one that predates the plan: a customer who signed up this week did
    // not have a subscription in 2019.
    throwsCode(() => platform.issueInvoice(tenant.id, '2019-03'), 'INVOICE_PERIOD_BEFORE_SUBSCRIPTION');

    assert.equal(wallet.snapshot().balanceMinor, atCreation, 'a refused period still moved the balance');
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

describe('every package credits 20% of its price as AI', () => {
  it('gives each package the allowance its price implies', () => {
    // The rule in its own terms: a fifth of what the customer pays is credited
    // to their AI wallet each period. One ACU is one minor unit, so the ACU
    // figure is just 20% of the price — which is why it does not move when the
    // markup does. What the markup changes is how much provider work those
    // ACUs buy, not how many there are.
    const expected: Record<string, number> = {
      FREE_TRIAL: 0,
      SOLO: 2_000,
      CORE_PROJECT: 19_000,
      PROFESSIONAL_DELIVERY: 44_000,
      ENTERPRISE: 130_000,
    };

    // Every package is covered, so a new one cannot be added without a figure.
    assert.deepEqual(Object.keys(expected).sort(), Object.keys(PACKAGES).sort());

    for (const [tier, acus] of Object.entries(expected)) {
      const price = PACKAGES[tier as keyof typeof PACKAGES].monthlyPriceMinor;
      assert.equal(
        subscriptionAcuAllocationMinor(price),
        acus,
        `${tier} at ${price} minor should credit ${acus} ACUs`,
      );
      assert.equal(acusFromMinor(subscriptionAcuAllocationMinor(price)), acus);
    }
  });

  it('gives the free trial a one-off grant rather than a monthly allowance', () => {
    // Nothing is paid, so 20% of nothing is nothing. The 500 ACUs are a grant
    // made once at signup — a different mechanism, deliberately, because a
    // monthly allowance on a free package is a free platform.
    assert.equal(PACKAGES.FREE_TRIAL.monthlyPriceMinor, 0);
    assert.equal(subscriptionAcuAllocationMinor(PACKAGES.FREE_TRIAL.monthlyPriceMinor), 0);
    assert.equal(config.billing.freeTrialGrantMinor, 500);
  });

  it('prices Solo as the entry package a single person can afford', () => {
    const solo = PACKAGES.SOLO;
    assert.equal(solo.monthlyPriceMinor, 10_000, 'Solo is £100 a month');
    assert.equal(solo.includedSeats, 1);
    assert.equal(solo.apiAccess, false);
    // Export is the difference between a paid package and the trial: a sole
    // trader whose output cannot leave the platform has bought a filing cabinet.
    assert.equal(solo.export, true);
    assert.equal(PACKAGES.FREE_TRIAL.export, false);
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
    assert.equal(allowanceMinor, 19_000, '£190 of AI allowance at 20%');
    assert.equal(acusFromMinor(allowanceMinor), 19_000, '19,000 ACUs');
    assert.equal(providerSpend, 3_800, '£38 of provider cost');

    // The worst case for the platform is the customer spending the allowance
    // to the last ACU: it takes £950 and pays a provider £38.
    assert.equal(plan - providerSpend, 91_200, '£912 retained if the allowance is fully consumed');
    assert.ok(
      profitPercent(providerSpend, plan) >= config.billing.minimumProfitPercent,
      'the plan itself fell below the required profit',
    );
  });
});
