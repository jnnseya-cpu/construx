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
import { ACU_BUNDLES, PACKAGES, TOP_UPS } from '../src/billing/seats.ts';
import { throwsCode } from './helpers.ts';
import { config } from '../src/config.ts';
import { Platform } from '../src/platform.ts';
import * as collection from '../src/billing/collection.ts';

/**
 * The commercial rules, stated once and checked.
 *
 * Four of them, and every one is the kind that gets restated as a literal in
 * some other file six months later and then disagrees with itself:
 *
 *   1. **No AI work without available ACUs**, and no *limit* cuts a task short.
 *      Prepaid binds: no ACUs means no AI. A customer's own cap does not, for
 *      AI — it is signalled and named on the entry, and the run finishes.
 *   2. **£1 buys 100 ACUs.** One ACU is one minor unit.
 *   3. **Provider cost is charged at between 4x and 10x**, the top of the
 *      range at the smallest volumes and the bottom — which is the profit
 *      floor — at the largest.
 *   4. **20% of a subscription payment is credited as AI allowance.**
 *
 * And the profit rule that sits under all of them: **the company takes at
 * least 100% profit on every AI transaction**. It is a floor expressed as a
 * profit requirement, and the multiplier floor is derived from it rather than
 * configured beside it, so the rule and the arithmetic cannot drift apart. At
 * the 4x price the realised profit is 300%, comfortably clear of it.
 */

describe('rule 1 — no AI work without available ACUs, and no limit cuts a task short', () => {
  /*
   * Two halves, and keeping them apart is the whole of the rule.
   *
   * **The balance binds.** Prepaid only: sufficient ACUs have to be available,
   * and no ACUs means no AI. Nothing runs a provider on credit, so the platform
   * never lays out money it cannot bill and a customer never receives a charge
   * they did not fund first.
   *
   * **A limit does not.** A cap — monthly, per project, per module, per person
   * — is a ceiling the customer set. The money behind an AI run past one is
   * funded either way, so what the cap decides is not whether the platform can
   * afford the work but whether it is allowed to *finish* it. A reasoning task
   * stopped at a ceiling has spent the tokens and produced nothing usable, so
   * the breach is signalled and named on the entry and the run completes.
   */

  it('refuses to reserve against an empty wallet, for AI as much as anything else', () => {
    const wallet = new ACUWallet('tenant-1');
    throwsCode(() => wallet.reserve({ aiRequestId: 'r1', estimatedRawCostMinor: 1 }), 'ACU_EXHAUSTED');
    throwsCode(
      () => wallet.reserve({ aiRequestId: 'r2', estimatedRawCostMinor: 1, runToCompletion: true }),
      'ACU_EXHAUSTED',
    );
  });

  it('refuses when the balance is short, rather than going negative', () => {
    const wallet = new ACUWallet('tenant-1');
    wallet.topUp(100);
    throwsCode(
      () => wallet.reserve({ aiRequestId: 'r1', estimatedRawCostMinor: 1_000, runToCompletion: true }),
      'ACU_EXHAUSTED',
    );
    assert.equal(wallet.snapshot().balanceMinor, 100, 'the balance moved on a refused reservation');
  });

  it('counts money already held by a call in flight as unavailable', () => {
    // Two concurrent calls must not both spend the same credit. The second is
    // refused while the first is still open, not after it settles.
    const rate = effectiveMultiplier(0, false);
    const wallet = new ACUWallet('tenant-1');
    wallet.topUp(150 * rate);
    wallet.reserve({ aiRequestId: 'r1', estimatedRawCostMinor: 100, runToCompletion: true });

    assert.equal(wallet.availableMinor(), 50 * rate);
    throwsCode(
      () => wallet.reserve({ aiRequestId: 'r2', estimatedRawCostMinor: 100, runToCompletion: true }),
      'ACU_EXHAUSTED',
    );
  });

  it('says so before the work is offered, not after it is clicked', () => {
    const wallet = new ACUWallet('tenant-1');
    wallet.topUp(10);
    const quote = wallet.quote(100, undefined, undefined, undefined, true);
    assert.equal(quote.blockedBy, 'BALANCE');
    assert.ok(quote.blockedReason, 'a blocked quote gave no reason');
  });

  it('halts non-AI metered work on a cap breach, as firmly as on an empty balance', () => {
    // A document render or a spatial compute is a fixed job the platform prices
    // up front. There is no "keep going until it is right" in a PDF, so a cap
    // stops one exactly as it always did.
    const wallet = new ACUWallet('tenant-1');
    wallet.topUp(1_000_000);
    wallet.setCaps({ monthlyMinor: 100 });
    throwsCode(() => wallet.reserve({ aiRequestId: 'r1', estimatedRawCostMinor: 100 }), 'ACU_EXHAUSTED');
  });

  it('lets an AI run pass a cap, tells the company, and names it on the entry', () => {
    const wallet = new ACUWallet('tenant-1');
    const signals: string[] = [];
    wallet.onSignal((signal) => signals.push(signal.kind));
    wallet.topUp(1_000_000);
    wallet.setCaps({ monthlyMinor: 100 });

    const hold = wallet.reserve({ aiRequestId: 'r1', estimatedRawCostMinor: 100, runToCompletion: true });
    assert.ok(hold.authorisedOverrun, 'the cap was passed silently');
    assert.match(String(hold.authorisedOverrun), /cap/i);
    // Told exactly as before. Being told is now the whole of the consequence.
    assert.ok(signals.includes('LIMIT_REACHED'), 'nobody was told the cap was reached');

    const entry = wallet.settle(hold.holdId, 100, 'OPENAI');
    assert.match(String(entry.note), /cap/i);
    // Charged against the funded balance as normal — nothing on credit.
    assert.equal(wallet.snapshot().balanceMinor, 1_000_000 - entry.billedMinor);
    assert.ok(wallet.snapshot().balanceMinor > 0);
  });

  it('quotes a cap an AI run will pass as a cost, never as a refusal', () => {
    const wallet = new ACUWallet('tenant-1');
    wallet.topUp(1_000_000);
    wallet.setCaps({ monthlyMinor: 100 });

    const forRender = wallet.quote(100);
    assert.equal(forRender.blockedBy, 'CAP');

    const forAi = wallet.quote(100, undefined, undefined, undefined, true);
    assert.equal(forAi.blockedReason, undefined, 'the quote refuses work the platform would run');
    assert.ok(forAi.overrunReason);
    assert.equal(forAi.capBreach?.scope, 'MONTHLY');
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

describe('rule 3 — provider cost is charged at 4x to 10x', () => {
  it('charges the top of the range on a wallet that has spent nothing', () => {
    const wallet = new ACUWallet('tenant-1');
    wallet.topUp(10_000);
    const hold = wallet.reserve({ aiRequestId: 'r1', estimatedRawCostMinor: 250 });
    const entry = wallet.settle(hold.holdId, 250, 'OPENAI');

    assert.equal(entry.rawCostMinor, 250);
    assert.equal(entry.billedMinor, 250 * config.billing.maxMarkupMultiplier);
    assert.equal(entry.effectiveMultiplier, config.billing.maxMarkupMultiplier);
  });

  it('states both ends of the range in configuration, so nothing infers them', () => {
    // The rate the business states: provider cost charged at between four and
    // ten times, the bottom of the range being the profit floor. Pinned as
    // literals here on purpose — everything else in the platform derives from
    // these two, so this is the one assertion that would fail if either number
    // were changed without a decision.
    assert.equal(config.billing.markupMultiplier, 4);
    assert.equal(config.billing.maxMarkupMultiplier, 10);
  });

  it('meets the rule that every £1 of provider cost produces at least £4', () => {
    // The business rule in its own terms. £1 spent with a provider must return
    // at least £4, which is 300% profit on what was paid out, and up to £10 at
    // the smallest volumes.
    const rawCost = 100;
    for (const rate of [config.billing.markupMultiplier, config.billing.maxMarkupMultiplier]) {
      const billed = rawCost * rate;
      assert.ok(billed >= 400, '£1 of provider cost must produce at least £4');
      assert.ok(
        profitPercent(rawCost, billed) >= config.billing.minimumProfitPercent,
        `a rate of ${rate}x fell below the required profit`,
      );
    }
    assert.equal(profitPercent(rawCost, rawCost * config.billing.markupMultiplier), 300);
  });

  it('derives the floor from the profit rule rather than from a loose constant', () => {
    // Required profit of 300% means charging four times: 1 + 300/100. Changing
    // the rule changes the floor by construction, so the two cannot drift apart.
    assert.equal(config.billing.minimumProfitPercent, 300);
    assert.equal(minimumMultiplier(), 4);
    assert.equal(profitPercent(100, 100 * minimumMultiplier()), config.billing.minimumProfitPercent);
  });

  it('sets the floor at the bottom of the range, so no case produces less than £4', () => {
    // £1 of provider cost produces at least £4, with no discount, no band and
    // no cap that could make it less. The bottom of the price range and the
    // profit floor are the same number by construction.
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

  it('honours the quote on an overrun, and charges the floor only when honouring it would lose money', () => {
    // `settle` caps an execution at the amount reserved and disclosed, unless
    // the cap would sell below the floor.
    //
    // **This asserted that the cap could never win.** That was true while the
    // price was one flat 4x: the floor and the price were the same number, so
    // honouring a quote always breached the floor and every overrun was charged
    // in full. With a range there is room between them, and the customer gets
    // the price they were shown until the overrun is large enough to take the
    // charge below cost.
    const wallet = new ACUWallet('tenant-1');
    wallet.topUp(100_000);
    const modest = wallet.reserve({ aiRequestId: 'r1', estimatedRawCostMinor: 100, runToCompletion: true });
    const honoured = wallet.settle(modest.holdId, 150, 'OPENAI');
    assert.equal(honoured.billedMinor, modest.heldMinor, 'the customer was charged more than they were quoted');
    assert.ok(honoured.billedMinor >= 150 * minimumMultiplier(), 'honouring the quote sold below the floor');

    const severe = wallet.reserve({ aiRequestId: 'r2', estimatedRawCostMinor: 100, runToCompletion: true });
    const floored = wallet.settle(severe.holdId, 2_000, 'OPENAI');
    assert.equal(floored.billedMinor, 2_000 * minimumMultiplier(), 'an overrun past the floor was not charged at it');
    assert.ok(floored.billedMinor > severe.heldMinor, 'the estimate was not exceeded, so this proves nothing');
    assert.match(String(floored.note), /above the estimate/i, 'an overrun was charged without being disclosed');
  });

  it('reports the profit it actually made on an account', () => {
    // Stated on the record rather than left to be recomputed by hand, so
    // "are we hitting the rule" is a read rather than an exercise.
    const wallet = new ACUWallet('tenant-1');
    wallet.topUp(10_000);
    const hold = wallet.reserve({ aiRequestId: 'r1', estimatedRawCostMinor: 200 });
    wallet.settle(hold.holdId, 200, 'OPENAI');

    const rate = config.billing.maxMarkupMultiplier;
    const snapshot = wallet.snapshot();
    assert.equal(snapshot.lifetimeRawCostMinor, 200);
    assert.equal(snapshot.lifetimeBilledMinor, 200 * rate);
    assert.equal(snapshot.lifetimeProfitMinor, 200 * rate - 200);
    assert.equal(snapshot.lifetimeProfitPercent, (rate - 1) * 100);
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

  it('charges within the range at every level of spend, and never below it', () => {
    // This has now asserted three different rules, which is the point of having
    // it: bands that discounted below the headline, then one flat 4x, and now a
    // range of 4x to 10x with the smallest consumers at the top. What has never
    // changed is that nothing prices below the floor.
    for (const spend of [0, 100_000, 5_000_000, Number.MAX_SAFE_INTEGER]) {
      for (const incentive of [true, false]) {
        const rate = effectiveMultiplier(spend, incentive);
        assert.ok(
          rate >= config.billing.markupMultiplier && rate <= config.billing.maxMarkupMultiplier,
          `spend ${spend} with incentive ${incentive} priced at ${rate}x, outside the range`,
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

  it('credits nothing when a paid tenancy is created, and the allowance when its first month is paid', () => {
    // Nothing is free unless the package is. A paid tenancy used to open with
    // the trial grant and the first month's allowance — £21.00 of AI on a £100
    // package before a penny had arrived. It opens with nothing, owes its
    // first month from the day it exists, and the allowance follows the money.
    const platform = new Platform();
    const { tenant, openingCharge } = platform.createTenant({
      legalName: 'Paid Ltd',
      jurisdiction: 'GB',
      defaultCurrency: 'GBP',
      tier: 'TEAM',
      package: 'CORE_PROJECT',
      enterpriseName: 'Paid',
    });

    assert.equal(platform.wallet(tenant.id).snapshot().balanceMinor, 0, 'a paid package opens with no free AI');
    assert.ok(openingCharge, 'the first month is charged the day the tenancy exists');
    assert.equal(openingCharge.amountMinor, PACKAGES.CORE_PROJECT.monthlyPriceMinor);
    assert.equal(openingCharge.status, 'DUE');

    platform.recordSubscriptionPayment({ tenantId: tenant.id, chargeId: openingCharge.id, method: 'BANK_TRANSFER', reference: 'BACS-0001', recordedBy: 'ops' });
    assert.equal(
      platform.wallet(tenant.id).snapshot().balanceMinor,
      subscriptionAcuAllocationMinor(PACKAGES.CORE_PROJECT.monthlyPriceMinor),
      'paying the month credits its allowance, and only its allowance',
    );
    // The receipt is revenue, and is not AI credit.
    assert.equal(platform.paymentReceipts(tenant.id)[0]?.chargeId, openingCharge.id);
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

    // A new tenancy has exactly one billable period, and paying it credits the
    // allowance once. Issuing the invoice — twice — credits nothing: an invoice
    // documents a period, it does not pay for one, and paying it again is
    // answered as the same payment.
    const opening = collection.chargesFor(platform, tenant.id)[0];
    assert.ok(opening, 'a paid tenancy is charged its first month at creation');
    platform.recordSubscriptionPayment({ tenantId: tenant.id, chargeId: opening.id, method: 'CARD', reference: 'pi_reissue_1', recordedBy: 'stripe', source: 'PROVIDER' });
    const atCreation = wallet.snapshot().balanceMinor;
    assert.equal(atCreation, subscriptionAcuAllocationMinor(PACKAGES.CORE_PROJECT.monthlyPriceMinor));
    platform.issueInvoice(tenant.id, period);
    platform.issueInvoice(tenant.id, period);
    assert.equal(wallet.snapshot().balanceMinor, atCreation, 'issuing an invoice credited the allowance');
    platform.recordSubscriptionPayment({ tenantId: tenant.id, chargeId: opening.id, method: 'CARD', reference: 'pi_reissue_1', recordedBy: 'stripe', source: 'PROVIDER' });
    assert.equal(wallet.snapshot().balanceMinor, atCreation, 'a retried settlement credited the allowance again');

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
    // Nothing is paid, so 20% of nothing is nothing. The grant is made once at
    // signup — a different mechanism, deliberately, because a monthly allowance
    // on a free package is a free platform.
    assert.equal(PACKAGES.FREE_TRIAL.monthlyPriceMinor, 0);
    assert.equal(subscriptionAcuAllocationMinor(PACKAGES.FREE_TRIAL.monthlyPriceMinor), 0);
    // Sized as a first task, not a first project. It was 500 — £1.25 of
    // provider cost per signup at the 4× markup, with nothing paid against it
    // and no ceiling on how many signups. 100 covers a handful of standard
    // runs for at most £0.25, and the monthly budget bounds the total.
    assert.equal(config.billing.freeTrialGrantMinor, 100);
    assert.ok(config.billing.trialMonthlyBudgetMinor >= config.billing.freeTrialGrantMinor);
  });

  it('offers four top-up amounts a customer can actually pay: £10, £30, £50 and £100', () => {
    // The Top up button sent a single hardcoded £1,000 to the payment page, so
    // the only way to add credit was to buy a thousand pounds of it — on a £100
    // package, or on one granted free. The denominations are published, and
    // what each credits is derived from the amount exactly as a bundle's is.
    assert.deepEqual(
      TOP_UPS.map((option) => option.amountMinor),
      [1_000, 3_000, 5_000, 10_000],
    );
    for (const option of TOP_UPS) {
      assert.equal(option.usableAcus, acusFromMinor(option.amountMinor));
      assert.ok(option.amountMinor < ACU_BUNDLES.STARTER.priceMinor, 'a top-up sits below the bundle ladder');
    }
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
    // Divided by the *bottom* of the price range, because that is the worst
    // case for the platform: the cheapest rate buys the most provider cost per
    // ACU, so it is the most a fully consumed allowance can cost to serve.
    const providerSpend = allowanceMinor / config.billing.markupMultiplier;

    assert.equal(plan, 95_000, '£950/month');
    assert.equal(allowanceMinor, 19_000, '£190 of AI allowance at 20%');
    assert.equal(acusFromMinor(allowanceMinor), 19_000, '19,000 ACUs');
    assert.equal(providerSpend, 4_750, '£47.50 of provider cost');

    // The worst case for the platform is the customer spending the allowance
    // to the last ACU: it takes £950 and pays a provider £47.50.
    assert.equal(plan - providerSpend, 90_250, '£902.50 retained if the allowance is fully consumed');
    assert.ok(
      profitPercent(providerSpend, plan) >= config.billing.minimumProfitPercent,
      'the plan itself fell below the required profit',
    );
  });
});
