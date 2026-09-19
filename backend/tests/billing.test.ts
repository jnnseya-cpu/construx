import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { ALL_ROLES, OPERATOR_ONLY_ROLES } from '../src/identity/roles.ts';
import { ACUWallet, VOLUME_BANDS, effectiveMultiplier, minimumMultiplier, profitPercent, subscriptionAcuAllocationMinor } from '../src/billing/acu.ts';
import { assignIdentity, revokeIdentity, SeatLimitError, TIERS, type Subscription } from '../src/billing/subscription.ts';
import { buildInvoice, formatContractValue } from '../src/billing/invoice.ts';
import { ACU_BUNDLES, PACKAGES, SEATS, UNCHARGED_ROLES, seatForRole } from '../src/billing/seats.ts';
import { config } from '../src/config.ts';

/**
 * The rate an ordinary test wallet is charged at.
 *
 * The AI price is a range, not a number: the top of it at the smallest volumes
 * down to the profit floor at the largest. A fixture that restates one end
 * asserts the wrong figure the moment either end moves, so this derives the
 * rate from the same function the wallet uses. These wallets settle tens of
 * pence a month, which is the first band.
 */
const RATE = effectiveMultiplier(0, false);

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
    assert.equal(entry.billedMinor, 100 * RATE);
  });

  it('never allows the balance to go negative', () => {
    const w = wallet(100);
    throwsCode(() => w.reserve({ aiRequestId: 'req-1', estimatedRawCostMinor: 1_000 }), 'ACU_EXHAUSTED');
    assert.equal(w.snapshot().balanceMinor, 100);
  });

  it('halts AI execution once credit is exhausted', () => {
    // No ACUs means no AI, for a reasoning run as much as for a render.
    // Sized from the multiplier rather than from a literal, so the fixture
    // follows the price instead of quietly encoding last quarter's.
    const w = wallet(100 * RATE);
    const hold = w.reserve({ aiRequestId: 'req-1', estimatedRawCostMinor: 100 });
    w.settle(hold.holdId, 100, 'OPENAI');
    assert.equal(w.snapshot().availableMinor, 0);
    assert.equal(w.snapshot().aiHalted, true);
    assert.throws(() => w.reserve({ aiRequestId: 'req-2', estimatedRawCostMinor: 1 }), /halted/);
    assert.throws(
      () => w.reserve({ aiRequestId: 'req-3', estimatedRawCostMinor: 1, runToCompletion: true }),
      /halted/,
    );
  });

  it('charges nothing while the tenancy is exempt, and still records what the providers cost', () => {
    // Reported as a group holding twelve months of free ACUs watching a
    // prepaid balance fall anyway. The spend is real and stays on the record;
    // what changes is who pays for it.
    const w = new ACUWallet('tenant-1');
    w.setUnmetered({ reason: 'Enterprise was granted free of charge, and AI with it' });
    const hold = w.reserve({ aiRequestId: 'req-1', estimatedRawCostMinor: 100 });
    assert.equal(hold.heldMinor, 0, 'nothing is ring-fenced against a charge that is not coming');
    const entry = w.settle(hold.holdId, 100, 'OPENAI');
    assert.equal(entry.billedMinor, 0);
    assert.equal(entry.rawCostMinor, 100, 'what the provider charged this platform is still on the entry');
    assert.match(entry.note ?? '', /Not charged/);
    const snap = w.snapshot();
    assert.equal(snap.balanceMinor, 0);
    assert.equal(snap.aiHalted, false, 'an empty balance does not halt AI that is not billed to it');
    assert.equal(snap.unmetered?.reason, 'Enterprise was granted free of charge, and AI with it');
  });

  it('does not count a run nobody was charged for against the realised rate', () => {
    /*
     * Reported as **"Effective multiplier 1.70× IS TOTALLY WRONG. IT MUST BE
     * 4X TO 10X"**, on a screen dividing everything billed by everything it
     * cost. On an exempt account those are two different things: billed stops
     * rising, provider cost keeps rising, and the ratio decays towards zero —
     * so a platform whose floor is 4× reported itself selling at 1.70×.
     *
     * A realised rate is what was charged over what the *charged* runs cost.
     * Runs nobody was charged for are Absorbed.
     */
    const w = wallet(100_000);
    const charged = w.reserve({ aiRequestId: 'charged', estimatedRawCostMinor: 43 });
    w.settle(charged.holdId, 43, 'OPENAI');

    w.setUnmetered({ reason: 'granted free' });
    const given = w.reserve({ aiRequestId: 'given', estimatedRawCostMinor: 58 });
    w.settle(given.holdId, 58, 'OPENAI');

    const snap = w.snapshot();
    assert.equal(snap.monthRawSpendMinor, 101, 'both runs cost the providers something');
    assert.equal(snap.monthChargedRawMinor, 43, 'only one of them was charged for');
    assert.equal(snap.monthAbsorbedRawMinor, 58, 'the rest was borne by this platform');

    const realised = snap.monthBilledMinor / snap.monthChargedRawMinor;
    assert.equal(realised, RATE, 'the realised rate is not the rate the charged run was raised at');
    assert.ok(realised >= minimumMultiplier(), 'the realised rate fell below the floor');
    // The figure the screen used to show, named rather than merely absent: the
    // old denominator understates the rate, and understates it further with
    // every run that is given away — which is why an exempt account watched it
    // fall through the floor.
    assert.ok(
      snap.monthBilledMinor / snap.monthRawSpendMinor < realised,
      'dividing by every run, charged or not, no longer understates the realised rate',
    );
  });

  it('keeps this platform’s own cost and margin out of the customer’s view', () => {
    /*
     * Reported as "USERS DON'T NEED TO SEE ALL OF THESE", against a screen
     * reading "£1.72 on £0.43 of provider cost" beside an effective multiplier.
     *
     * It is worse than clutter: what the providers charge and what is made on
     * top is this company's margin, and `/v1/billing/wallet` returned all of it
     * — lifetime cost, lifetime profit, the profit percentage — to every
     * tenancy that opened its billing screen. Taking the figures off the screen
     * would not have touched that; the response carried them whether or not
     * anything rendered them.
     *
     * Asserted on the keys rather than on the screen, because the screen is not
     * where the boundary is.
     */
    const w = wallet(100_000);
    const hold = w.reserve({ aiRequestId: 'r1', estimatedRawCostMinor: 43 });
    w.settle(hold.holdId, 43, 'OPENAI');

    const customer = w.customerSnapshot() as Record<string, unknown>;
    for (const secret of [
      'lifetimeRawCostMinor',
      'lifetimeProfitMinor',
      'lifetimeProfitPercent',
      'monthRawSpendMinor',
      'monthChargedRawMinor',
      'monthAbsorbedRawMinor',
    ]) {
      assert.ok(!(secret in customer), `${secret} is this platform's own economics and reached the customer`);
    }

    // And everything they are actually owed is still there.
    assert.equal(customer.monthBilledMinor, 43 * RATE);
    assert.equal(customer.lifetimeBilledMinor, 43 * RATE);
    assert.equal(customer.availableMinor, w.snapshot().availableMinor);
    assert.equal(customer.aiHalted, false);
    assert.ok('caps' in customer && 'alerts' in customer && 'unmetered' in customer);
  });

  it('quotes an exempt tenancy nil, so the price before the button matches the charge after it', () => {
    const w = new ACUWallet('tenant-1');
    w.setUnmetered({ reason: 'granted free' });
    const quote = w.quote(100);
    assert.equal(quote.chargeMinor, 0);
    assert.equal(quote.blockedReason, undefined, 'an empty balance cannot block a run that costs nothing');
  });

  it('charges again the moment the exemption term runs out', () => {
    // Expiry is applied at the accessor, not by a sweep: nothing fails when a
    // customer is not charged, so a missed sweep would be invisible.
    const w = wallet(100 * RATE);
    w.setUnmetered({ reason: 'twelve months free', until: '2020-01-01T00:00:00.000Z' });
    assert.equal(w.unmetered(), null, 'a term in the past is not a grant in force');
    const hold = w.reserve({ aiRequestId: 'req-1', estimatedRawCostMinor: 100 });
    assert.equal(w.settle(hold.holdId, 100, 'OPENAI').billedMinor, 100 * RATE);
  });

  it('does not halt an AI run at a cap, because a ceiling does not cut a task in half', () => {
    // The money is funded, so what the cap decides is whether the work is
    // allowed to finish — and a reasoning task stopped at a ceiling has spent
    // the tokens and produced nothing usable. Non-AI metered work is refused.
    const w = wallet(100 * RATE);
    w.setCaps({ monthlyMinor: 1 });
    assert.throws(() => w.reserve({ aiRequestId: 'render', estimatedRawCostMinor: 1 }), /cap/i);
    const hold = w.reserve({ aiRequestId: 'reason', estimatedRawCostMinor: 1, runToCompletion: true });
    assert.ok(hold.authorisedOverrun, 'an AI run past the cap said nothing about it');
    assert.equal(w.snapshot().aiHalted, false);
  });

  it('ring-fences held funds so a second call cannot spend them', () => {
    // Two calls' worth of credit at the current rate, so the fixture tracks
    // the price rather than restating a number from a previous one.
    const charge = 100 * RATE;
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

  it('caps a modest overrun at what was quoted, because the floor leaves room to', () => {
    /*
     * Estimate 100 raw, held at the rate. Actual 150 raw.
     *
     * **This asserted the opposite while the price and the profit floor were
     * the same number.** With one flat multiple, honouring the quote would
     * always have sold below the floor, so the quote could never be honoured
     * and every overrun was charged in full — disclosed, but a surprise.
     *
     * The price is a range now and the floor is its bottom rung, so there is
     * room between them: a run that overruns its estimate is charged what the
     * customer was quoted, as long as that still clears the floor. The next
     * test covers the case where it does not.
     */
    const w = wallet();
    const hold = w.reserve({ aiRequestId: 'req-1', estimatedRawCostMinor: 100 });
    const entry = w.settle(hold.holdId, 150, 'OPENAI');

    assert.equal(entry.billedMinor, hold.heldMinor, 'the customer was charged more than they were quoted');
    assert.ok(entry.billedMinor >= 150 * minimumMultiplier(), 'honouring the quote sold below the profit floor');
  });

  it('charges the floor rather than the quote when honouring it would sell at a loss', () => {
    // Estimate 100 raw, actual 1,000 raw — an answer ten times the size of the
    // question, which anybody can produce on purpose. Capping at the hold would
    // charge less than the providers cost.
    const w = wallet();
    const hold = w.reserve({ aiRequestId: 'req-1', estimatedRawCostMinor: 100 });
    const entry = w.settle(hold.holdId, 1_000, 'OPENAI');

    assert.equal(entry.billedMinor, 1_000 * minimumMultiplier(), 'an overrun past the floor was not charged at it');
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

  it('never charges the same hold twice: a replayed settlement is the first one, and a released hold cannot be settled', () => {
    const w = wallet();
    const hold = w.reserve({ aiRequestId: 'req-1', estimatedRawCostMinor: 100 });
    const first = w.settle(hold.holdId, 100, 'OPENAI');
    const balance = w.availableMinor();
    // A completion reported twice — a retried callback — is the same
    // settlement. The balance does not move and the entry is the same one.
    const again = w.settle(hold.holdId, 100, 'OPENAI');
    assert.equal(again.id, first.id);
    assert.equal(w.availableMinor(), balance);
    assert.equal(w.allEntries().filter((entry) => entry.type === 'DEBIT').length, 1);
    // Commit and release are mutually exclusive: a hold that was released is gone.
    const released = w.reserve({ aiRequestId: 'req-2', estimatedRawCostMinor: 100 });
    w.release(released.holdId, 'failed');
    throwsCode(() => w.settle(released.holdId, 100, 'OPENAI'), 'ACU_HOLD_NOT_FOUND');
  });

  it('enforces a monthly cap before contacting a provider', () => {
    const w = wallet(100_000);
    // Room for exactly one call at the current rate, so the second breaches.
    // Derived rather than written as a figure: a cap fixture pinned to a
    // multiplier stops testing the cap and starts testing the rate.
    w.setCaps({ monthlyMinor: 100 * RATE + 1 });
    const hold = w.reserve({ aiRequestId: 'req-1', estimatedRawCostMinor: 100 });
    w.settle(hold.holdId, 100, 'OPENAI');
    assert.throws(() => w.reserve({ aiRequestId: 'req-2', estimatedRawCostMinor: 100 }), /Monthly AI cap/);
  });

  it('enforces per-project caps independently', () => {
    const w = wallet(100_000);
    // One call's worth at the current rate, so the second breaches. Derived
    // rather than written as a figure: a cap fixture pinned to the old
    // multiplier stops testing the cap and starts testing the rate.
    w.setCaps({ perProjectMinor: { 'project-a': 100 * RATE } });
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
    const charge = 100 * RATE;
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

describe('the AI price range', () => {
  /*
   * **The price is a range of 4× to 10×, by decision of the business, and this
   * is where that is held to.**
   *
   * It was one flat multiple at every level of spend. That priced a tenancy
   * spending £0.43 of provider cost a month identically to one spending
   * £4,000, and the two do not cost the same to serve: a run whose provider
   * cost is a fraction of a penny still takes a routing decision, a
   * reservation, a ledger append, an evidence write and a settlement, none of
   * which shrink with the token count.
   *
   * So the smallest consumers pay the top and the largest pay the bottom, and
   * the bottom is the profit floor, which nothing may go below.
   */
  it('spans the configured range, top to bottom, and never leaves it', () => {
    for (const spend of [0, 500, 1_000, 5_000, 20_000, 100_000, 5_000_000, Number.MAX_SAFE_INTEGER]) {
      const rate = effectiveMultiplier(spend, false);
      assert.ok(
        rate >= config.billing.markupMultiplier && rate <= config.billing.maxMarkupMultiplier,
        `a monthly spend of ${spend} priced at ${rate}×, outside the ${config.billing.markupMultiplier}–${config.billing.maxMarkupMultiplier}× range`,
      );
    }
  });

  it('charges the top of the range at the smallest spend and the bottom at the largest', () => {
    assert.equal(effectiveMultiplier(0, false), config.billing.maxMarkupMultiplier);
    assert.equal(effectiveMultiplier(Number.MAX_SAFE_INTEGER, false), config.billing.markupMultiplier);
  });

  it('only ever falls as spend rises, so growing can never cost more', () => {
    // A ladder with a step the wrong way round would charge an account more
    // for spending more, which nothing else would catch: every rung still
    // clears the floor and no assertion anywhere compares two of them.
    let previous = Number.POSITIVE_INFINITY;
    for (const spend of [0, 500, 1_000, 2_500, 5_000, 10_000, 20_000, 50_000, 100_000, 1_000_000]) {
      const rate = effectiveMultiplier(spend, false);
      assert.ok(rate <= previous, `a monthly spend of ${spend} cost ${rate}×, more than the band below it`);
      previous = rate;
    }
  });

  it('holds a negotiated tenancy at the bottom of the range whatever it spends', () => {
    // What the flag has always meant — this account pays less — now expressed
    // against a range rather than against a table that discounted below the
    // headline. Set for the ENTERPRISE and SOVEREIGN tiers.
    for (const spend of [0, 100_000, 5_000_000]) {
      assert.equal(effectiveMultiplier(spend, true), config.billing.markupMultiplier);
    }
  });

  it('never discounts through the floor, whatever the bands say', () => {
    // The guard that makes "the platform never sells AI at a loss" a property
    // of the code rather than of whoever last tuned the band table.
    for (const spend of [0, 100_000, 500_000, 5_000_000, Number.MAX_SAFE_INTEGER]) {
      for (const negotiated of [true, false]) {
        assert.ok(
          effectiveMultiplier(spend, negotiated) >= minimumMultiplier(),
          `a monthly spend of ${spend} priced below the ${minimumMultiplier()}x floor`,
        );
      }
    }
  });

  it('publishes a band table that spans the range it claims to', () => {
    // The ladder is computed from the two ends rather than written out, so the
    // published range and the table implementing it cannot drift. This is what
    // holds that true.
    assert.equal(VOLUME_BANDS[0]!.multiplier, config.billing.maxMarkupMultiplier);
    assert.equal(VOLUME_BANDS.at(-1)!.multiplier, config.billing.markupMultiplier);
    assert.equal(VOLUME_BANDS.at(-1)!.upToRawMinor, Number.POSITIVE_INFINITY, 'the ladder has no rung for the largest spenders');
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
    // that, and every later change to the rate has needed no edit at all.
    //
    // Second: what was derived was the wrong quantity. `usableAcus` was
    // price ÷ markup, which is the *provider work* the credit funds, while a
    // package advertises its wallet credit — and both were called ACUs on the
    // same site. A £300 bundle credits 30,000 ACUs and said 7,500, understating
    // itself fourfold against the package beside it. The two measure different
    // things, and calling both of them ACUs hid it.
    const rate = config.billing.markupMultiplier;
    for (const bundle of Object.values(ACU_BUNDLES)) {
      assert.equal(bundle.multiplier, rate);
      // The credit, on the same basis as a package's monthly allowance.
      assert.equal(bundle.usableAcus, bundle.priceMinor, `${bundle.bundle} does not credit what it costs`);
      // And what that credit buys, under a name that says what it is.
      assert.equal(bundle.providerCostMinor, Math.floor(bundle.priceMinor / rate));
    }
    assert.equal(ACU_BUNDLES.STARTER.usableAcus, 30_000, '£300 credits 30,000 ACUs');
    assert.equal(ACU_BUNDLES.STARTER.providerCostMinor, 7_500, 'which funds £75 of provider work at 4x');
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
    assert.equal(invoice.aiUsageMinor, 100 * RATE);
    assert.equal(invoice.aiRawCostMinor, 100);
    assert.equal(invoice.effectiveMultiplier, RATE);

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
