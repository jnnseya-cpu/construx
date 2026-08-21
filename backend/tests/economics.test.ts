import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import {
  ACUWallet,
  acusFromMinor,
  effectiveMultiplier,
  minorFromAcus,
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
 *   4. **30% of a subscription payment is credited as AI allowance.**
 *
 * And one guard that is not a price: the platform never sells AI below 2x, so
 * whatever the volume table says, a call always at least doubles its money.
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

  it('leaves a 75% gross margin, which is not the same as a 100% one', () => {
    // Written out because "4x", "300% markup" and "75% margin" are three names
    // for one number and the three get used interchangeably in conversation.
    const rawCost = 100;
    const billed = rawCost * config.billing.markupMultiplier;
    const profit = billed - rawCost;

    assert.equal(billed, 400);
    assert.equal(profit, 300);
    assert.equal(profit / billed, 0.75, 'gross margin');
    assert.equal(profit / rawCost, 3, 'markup');
  });

  it('never charges below the floor, whatever the volume table says', () => {
    // The guard, not the price. A band table is exactly the constant somebody
    // tunes without re-deriving what it does to the margin.
    for (const spend of [0, 1, 200_000, 200_001, 1_000_000, 5_000_000, Number.MAX_SAFE_INTEGER]) {
      for (const incentive of [true, false]) {
        assert.ok(
          effectiveMultiplier(spend, incentive) >= config.billing.minimumMultiplier,
          `spend ${spend} with incentive ${incentive} priced below the floor`,
        );
      }
    }
  });

  it('keeps the volume incentive as a discount from 4x, not a discount to below cost', () => {
    assert.equal(effectiveMultiplier(0, false), 4);
    assert.equal(effectiveMultiplier(100_000, true), 4);
    assert.ok(effectiveMultiplier(5_000_000, true) < 4, 'the incentive stopped being an incentive');
    assert.ok(effectiveMultiplier(5_000_000, true) > 2, 'the incentive discounted through the floor');
  });
});

describe('rule 4 — 30% of a subscription buys AI allowance', () => {
  it('allocates thirty per cent of the plan price', () => {
    assert.equal(subscriptionAcuAllocationMinor(100_000), 30_000, '£1,000 must allocate £300');
    assert.equal(subscriptionAcuAllocationMinor(95_000), 28_500, '£950 must allocate £285');
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
