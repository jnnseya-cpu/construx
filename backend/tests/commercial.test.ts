import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { Server } from 'node:http';
import { createGateway } from '../src/api/gateway.ts';
import {
  assertCohortIsGeneral,
  benchmark,
  CONSENT_SCOPE,
  MAXIMUM_DOMINANCE,
  MEDIAN_AT,
  MINIMUM_COHORT,
  positionAgainst,
  type BenchmarkContribution,
} from '../src/commercial/benchmark.ts';
import { churnSignal, DORMANT_AFTER_DAYS, MINIMUM_PRIOR, windowFrom } from '../src/commercial/churn.ts';
import { expansionPosition, PRESSURE_AT, SLACK_UNDER } from '../src/commercial/expansion.ts';
import {
  FEE_BANDS,
  FEE_CAP_MINOR,
  FEE_FLOOR_MINOR,
  feeFor,
  raiseSettlement,
  reverse,
  settle,
  transactionRevenue,
} from '../src/commercial/settlement.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The commercial module: transaction revenue, consented benchmarking,
 * expansion proposals and the engagement signal.
 *
 * The benchmark block is the one that matters most. A benchmark is a disclosure
 * mechanism wearing a statistic's clothes, and the tests there are written from
 * the position of somebody trying to read a competitor's figure out of it.
 */

describe('what the platform earns, and what it refuses to charge for', () => {
  it('charges nothing on a payment it did not carry', () => {
    const fee = feeFor(1_000_000_00, 'RECORDED');
    assert.equal(fee.feeMinor, 0);
    assert.equal(fee.rate, 0);
    // The zero has to say why, or an absent charge is indistinguishable from a bug.
    assert.match(fee.basis, /carried no money|subscription buys/);
  });

  it('bands the rate downward as the transaction grows', () => {
    const rates = [1_000_00, 20_000_00, 100_000_00, 2_000_000_00].map(
      (amount) => feeFor(amount, 'FACILITATED').rate,
    );
    for (let index = 1; index < rates.length; index += 1) {
      assert.ok(rates[index]! < rates[index - 1]!, `rate did not fall from band ${index - 1} to ${index}`);
    }
  });

  it('keeps the band table in ascending order, or the biggest transactions price at the smallest band', () => {
    for (let index = 1; index < FEE_BANDS.length; index += 1) {
      assert.ok(FEE_BANDS[index]!.uptoMinor > FEE_BANDS[index - 1]!.uptoMinor);
    }
  });

  it('caps the fee absolutely, whatever the transaction is worth', () => {
    // The single most important number in the module. Without it, a customer
    // running a £20M certificate through the platform meets a five-figure fee
    // for a bank transfer, and leaves — correctly.
    const huge = feeFor(20_000_000_00, 'FACILITATED');
    assert.equal(huge.feeMinor, FEE_CAP_MINOR);
    assert.equal(huge.adjustedBy, 'CAP');
    assert.ok(huge.rawMinor > FEE_CAP_MINOR, 'the raw figure must exceed the cap or this proves nothing');
  });

  it('does not let the fee grow once the cap is reached, however much larger the payment', () => {
    assert.equal(feeFor(20_000_000_00, 'FACILITATED').feeMinor, feeFor(80_000_000_00, 'FACILITATED').feeMinor);
  });

  it('floors the fee, so a small transaction does not cost more to move than it earns', () => {
    // £50 at 0.9% is 45p, which does not cover moving the money.
    const tiny = feeFor(50_00, 'FACILITATED');
    assert.equal(tiny.feeMinor, FEE_FLOOR_MINOR);
    assert.equal(tiny.adjustedBy, 'FLOOR');
  });

  it('charges nothing at all on a zero-value transaction, floor or no floor', () => {
    // The floor covers the cost of moving money. No money moved.
    assert.equal(feeFor(0, 'FACILITATED').feeMinor, 0);
  });

  it('refuses a fractional or negative amount rather than producing an unreconcilable fee', () => {
    assert.throws(() => feeFor(10.5, 'FACILITATED'), /SETTLEMENT_AMOUNT_INVALID|whole number/);
    assert.throws(() => feeFor(-100, 'FACILITATED'), /SETTLEMENT_AMOUNT_INVALID|not negative/);
  });

  it('states the basis on every fee, including the ones that are zero', () => {
    for (const [amount, rail] of [
      [0, 'FACILITATED'],
      [180_00, 'FACILITATED'],
      [20_000_000_00, 'FACILITATED'],
      [50_000_00, 'RECORDED'],
    ] as const) {
      assert.ok(feeFor(amount, rail).basis.length > 0, `${amount} ${rail} has no basis`);
    }
  });
});

describe('the settlement record', () => {
  const base = {
    id: 's-1',
    tenantId: 't-1',
    projectId: 'p-1',
    againstRef: { refType: 'PaymentCertificate', refId: 'c-1' },
    amountMinor: 100_000_00,
    currency: 'GBP',
    rail: 'FACILITATED' as const,
  };

  it('always leaves the payee amount minus fee', () => {
    const record = raiseSettlement(base);
    assert.equal(record.netMinor, record.amountMinor - record.feeMinor);
  });

  it('refuses to settle the same record twice', () => {
    // Revenue recognised twice and a payee credited twice.
    const settled = settle(raiseSettlement(base));
    assert.throws(() => settle(settled), /SETTLEMENT_ALREADY_SETTLED|twice/);
  });

  it('refuses to settle a reversed record', () => {
    const reversed = reverse(raiseSettlement(base), 'The payer recalled the transfer');
    assert.throws(() => settle(reversed), /SETTLEMENT_REVERSED|cannot be settled/);
  });

  it('gives the fee back with a reversal', () => {
    // A platform that kept its cut of a payment that was reversed has charged
    // for a service it did not complete.
    const reversed = reverse(settle(raiseSettlement(base)), 'Bank recall');
    assert.equal(reversed.feeMinor, 0);
    assert.equal(reversed.netMinor, 0);
  });

  it('refuses a reversal with no reason', () => {
    assert.throws(() => reverse(raiseSettlement(base), '   '), /REASON_REQUIRED|has to say why/);
  });

  it('counts only settled fees as revenue', () => {
    const settled = settle(raiseSettlement({ ...base, id: 'a' }));
    const pending = raiseSettlement({ ...base, id: 'b' });
    const position = transactionRevenue([settled, pending]);
    assert.equal(position.earnedMinor, settled.feeMinor);
    assert.equal(position.pendingMinor, pending.feeMinor);
    assert.notEqual(position.earnedMinor, settled.feeMinor + pending.feeMinor);
  });

  it('shows reversed fees rather than netting them silently away', () => {
    // A rising figure here is a signal, and one that has been netted out of the
    // earned total is a signal nobody can see.
    const reversed = reverse(settle(raiseSettlement({ ...base, id: 'r' })), 'recall');
    const position = transactionRevenue([reversed]);
    assert.ok(position.reversedMinor > 0, 'the fee that was given back must still be visible');
    assert.equal(position.earnedMinor, 0);
  });

  it('reports a take rate against value carried, and none where nothing was carried', () => {
    const carried = settle(raiseSettlement({ ...base, id: 'c' }));
    assert.ok(transactionRevenue([carried]).takeRate! > 0);
    const recorded = settle(raiseSettlement({ ...base, id: 'd', rail: 'RECORDED' }));
    assert.equal(transactionRevenue([recorded]).takeRate, null);
  });
});

describe('benchmarking, read as an attempt to identify somebody', () => {
  const consented = (values: number[]): BenchmarkContribution[] =>
    values.map((value, index) => ({ tenantId: `t-${index}`, value, consented: true }));

  it('refuses a cohort smaller than the floor rather than publishing a thinner number', () => {
    const result = benchmark({ metric: 'Margin', cohort: 'Civils', contributions: consented([5, 6, 7, 8]) });
    assert.equal(result.published, false);
    assert.equal(result.published === false && result.reason, 'COHORT_TOO_SMALL');
  });

  it('publishes at exactly the floor, so the boundary is the stated one', () => {
    const result = benchmark({
      metric: 'Margin',
      cohort: 'Civils',
      contributions: consented(Array.from({ length: MINIMUM_COHORT }, () => 10)),
    });
    assert.equal(result.published, true);
  });

  it('counts only the consenting, and refuses on that count rather than the total', () => {
    // The failure that looks safest in review: check k against everybody, then
    // average only those who agreed. A cohort of forty resting on three.
    const contributions: BenchmarkContribution[] = [
      ...consented([10, 11, 12]),
      ...Array.from({ length: 40 }, (_, index) => ({ tenantId: `n-${index}`, value: 10, consented: false })),
    ];
    const result = benchmark({ metric: 'Margin', cohort: 'Civils', contributions });
    assert.equal(result.published, false);
    assert.equal(result.contributors, 3, 'the count must be of consenting contributors only');
  });

  it('refuses where nobody has consented at all', () => {
    const result = benchmark({
      metric: 'Margin',
      cohort: 'Civils',
      contributions: Array.from({ length: 20 }, (_, index) => ({ tenantId: `n-${index}`, value: 10, consented: false })),
    });
    assert.equal(result.published === false && result.reason, 'NO_CONSENTED_CONTRIBUTIONS');
  });

  it('refuses a cohort one member dominates, even though the count is large enough', () => {
    // k-anonymity says nothing about this, and it is how a benchmark leaks in
    // practice: five contributors, one of them 94% of the total, and the mean
    // discloses them almost exactly.
    const result = benchmark({
      metric: 'Turnover',
      cohort: 'Water · North West',
      contributions: consented([1, 1, 1, 1, 200]),
    });
    assert.equal(result.published, false);
    assert.equal(result.published === false && result.reason, 'ONE_CONTRIBUTOR_DOMINATES');
  });

  it('cannot be fooled into passing dominance by a large negative figure', () => {
    // Without measuring against absolute values, a loss cancels a profit, the
    // total goes near zero and every share looks modest.
    const result = benchmark({
      metric: 'Margin',
      cohort: 'Civils',
      contributions: consented([100, 1, 1, 1, -99]),
    });
    assert.equal(result.published, false, 'a cancelling total must not create a passable cohort');
  });

  it('refuses a dominated cohort even when every figure in it is negative', () => {
    // Margin can be negative, and a whole cohort of loss-making projects is
    // ordinary. Measured against a signed total the ratio comes out negative,
    // which is not greater than the threshold, and the dominant member walks
    // straight through the check. Measured against magnitude it does not.
    const result = benchmark({
      metric: 'Margin',
      cohort: 'Civils',
      contributions: consented([-100, -1, -1, -1, -1]),
    });
    assert.equal(result.published, false);
    assert.equal(result.published === false && result.reason, 'ONE_CONTRIBUTOR_DOMINATES');
  });

  it('publishes a mean and never a minimum or a maximum', () => {
    const result = benchmark({ metric: 'Margin', cohort: 'Civils', contributions: consented([4, 5, 6, 7, 8]) });
    assert.equal(result.published, true);
    if (result.published) {
      assert.equal(result.mean, 6);
      // A minimum is one contributor's figure published exactly. Calling it
      // "the lowest in the cohort" does not change what it is.
      assert.ok(!('min' in result) && !('max' in result));
    }
  });

  it('withholds the median until the cohort is twice the floor', () => {
    const small = benchmark({ metric: 'M', cohort: 'C', contributions: consented([1, 2, 3, 4, 5]) });
    assert.ok(small.published && small.median === undefined, 'at k the median is a member’s own number');

    const large = benchmark({
      metric: 'M',
      cohort: 'C',
      contributions: consented(Array.from({ length: MEDIAN_AT }, (_, index) => index + 1)),
    });
    assert.ok(large.published && typeof large.median === 'number');
  });

  it('carries the basis with every published figure', () => {
    const result = benchmark({ metric: 'M', cohort: 'C', contributions: consented([4, 5, 6, 7, 8]) });
    assert.ok(result.published && result.basis.length > 0);
    assert.ok(result.published && /no company is named/i.test(result.basis));
  });

  it('never returns a contributing tenancy id in any shape', () => {
    const result = benchmark({ metric: 'M', cohort: 'C', contributions: consented([4, 5, 6, 7, 8]) });
    const serialised = JSON.stringify(result);
    for (let index = 0; index < 5; index += 1) {
      assert.ok(!serialised.includes(`t-${index}`), 'a contributor id reached the published result');
    }
  });

  it('refuses a cohort defined narrowly enough to name somebody by description', () => {
    // "Water contractors in Rochdale turning over £8-9m" identifies one company
    // without naming it and passes every count-based check.
    assert.doesNotThrow(() => assertCohortIsGeneral('Civils · North West'));
    assert.throws(
      () => assertCohortIsGeneral('Water · North West · £8m-£9m · Framework AMP8'),
      /COHORT_TOO_NARROW|at most three/,
    );
  });

  it('still tells a non-contributing company where it stands', () => {
    // Withholding a reading to extract a contribution would be a dark pattern.
    const published = benchmark({ metric: 'M', cohort: 'C', contributions: consented([4, 5, 6, 7, 8]) });
    const position = positionAgainst(published, 9);
    assert.equal(position.comparison?.standing, 'ABOVE');
    assert.equal(position.ownValue, 9);
  });

  it('reads a hair either side of the mean as standing at it, not above it', () => {
    const published = benchmark({ metric: 'M', cohort: 'C', contributions: consented([100, 100, 100, 100, 100]) });
    assert.equal(positionAgainst(published, 100.5).comparison?.standing, 'AT');
    assert.equal(positionAgainst(published, 130).comparison?.standing, 'ABOVE');
    assert.equal(positionAgainst(published, 70).comparison?.standing, 'BELOW');
  });

  it('passes the refusal through rather than inventing a comparison', () => {
    const refused = benchmark({ metric: 'M', cohort: 'C', contributions: consented([1, 2]) });
    const position = positionAgainst(refused, 9);
    assert.equal(position.comparison, undefined);
    assert.match(position.finding, /at least/);
  });

  it('states the consent scope in terms a person could act on', () => {
    assert.match(CONSENT_SCOPE, new RegExp(String(MINIMUM_COHORT)));
    assert.match(CONSENT_SCOPE, /withdrawn at any time/);
    assert.match(CONSENT_SCOPE, /no company is named/i);
  });

  it('keeps its two thresholds meaningful', () => {
    assert.ok(MINIMUM_COHORT >= 5, 'below five a contributor can solve for the others');
    assert.ok(MAXIMUM_DOMINANCE > 0 && MAXIMUM_DOMINANCE < 1);
  });
});

describe('expansion proposals, read as an attempt to generate revenue', () => {
  const at = (used: number, limit: number | null) => [{ resource: 'Identities', used, limit, unit: 'seats' }];

  it('proposes nothing where a tenancy is comfortably inside its limits', () => {
    const position = expansionPosition({
      tenantId: 't',
      tier: 'TEAM',
      largerPackageExists: true,
      uses: at(5, 10),
      settledIn: true,
    });
    assert.deepEqual(position.proposals, []);
  });

  it('proposes an upgrade only once a limit is actually under pressure', () => {
    const under = expansionPosition({
      tenantId: 't',
      tier: 'TEAM',
      largerPackageExists: true,
      uses: at(Math.floor(10 * PRESSURE_AT) - 1, 10),
      settledIn: false,
    });
    assert.deepEqual(under.proposals, [], 'nothing should be proposed below the pressure threshold');

    const over = expansionPosition({
      tenantId: 't',
      tier: 'TEAM',
      largerPackageExists: true,
      uses: at(9, 10),
      settledIn: false,
    });
    assert.equal(over.proposals[0]?.kind, 'EXPAND');
  });

  it('does not propose an upgrade that does not exist', () => {
    // On the largest package, running out of seats is a fact to state and a
    // conversation to have — not an upsell.
    const position = expansionPosition({
      tenantId: 't',
      tier: 'SOVEREIGN',
      largerPackageExists: false,
      uses: at(10, 10),
      settledIn: true,
    });
    assert.equal(position.proposals[0]?.kind, 'NOTHING_TO_PROPOSE');
    assert.match(position.proposals[0]!.finding, /largest package/);
  });

  it('proposes a reduction where a settled tenancy is paying for what it does not use', () => {
    // The cheapest retention there is, and the proof the engine is not only
    // pointed one way.
    const position = expansionPosition({
      tenantId: 't',
      tier: 'BUSINESS',
      largerPackageExists: true,
      uses: at(2, 20),
      settledIn: true,
    });
    assert.equal(position.proposals[0]?.kind, 'REDUCE');
  });

  it('does not tell a company three weeks in to downgrade', () => {
    // They have not finished onboarding. Telling them to spend less is telling
    // them to give up.
    const position = expansionPosition({
      tenantId: 't',
      tier: 'BUSINESS',
      largerPackageExists: true,
      uses: at(2, 20),
      settledIn: false,
    });
    assert.deepEqual(position.proposals, []);
  });

  it('proposes nothing about an uncapped resource, which cannot be exceeded', () => {
    const position = expansionPosition({
      tenantId: 't',
      tier: 'SOVEREIGN',
      largerPackageExists: false,
      uses: at(4_000, null),
      settledIn: true,
    });
    assert.deepEqual(position.proposals, []);
  });

  it('proposes nothing against a limit of zero rather than reporting Infinity per cent', () => {
    // A package configured with a zero limit divides by zero. The visible
    // symptom is a proposal reading "5 of 0 seats (Infinity%)", which is worse
    // than no proposal because somebody would act on it.
    for (const used of [0, 5]) {
      const position = expansionPosition({
        tenantId: 't',
        tier: 'TEAM',
        largerPackageExists: true,
        uses: [{ resource: 'Identities', used, limit: 0, unit: 'seats' }],
        settledIn: true,
      });
      assert.deepEqual(position.proposals, [], `used=${used} produced a proposal against a zero limit`);
      assert.ok(!/Infinity|NaN/.test(JSON.stringify(position)));
    }
  });

  it('shows the measurement on every proposal, so none has to be taken on trust', () => {
    const position = expansionPosition({
      tenantId: 't',
      tier: 'TEAM',
      largerPackageExists: true,
      uses: at(10, 10),
      settledIn: true,
    });
    for (const proposal of position.proposals) assert.match(proposal.measurement, /\d+ of \d+/);
  });

  it('puts the thing at its limit above the thing merely near it', () => {
    const position = expansionPosition({
      tenantId: 't',
      tier: 'TEAM',
      largerPackageExists: true,
      uses: [
        { resource: 'Storage', used: 87, limit: 100, unit: 'GB' },
        { resource: 'Identities', used: 10, limit: 10, unit: 'seats' },
      ],
      settledIn: true,
    });
    assert.equal(position.proposals[0]?.resource, 'Identities');
  });

  it('keeps the two thresholds apart, or every tenancy is both under pressure and slack', () => {
    assert.ok(SLACK_UNDER < PRESSURE_AT);
  });
});

describe('the engagement signal', () => {
  const window = (over: Partial<Parameters<typeof churnSignal>[0]['window']> = {}) => ({
    recent: 100,
    prior: 100,
    recentActors: 5,
    priorActors: 5,
    daysSinceLastEvent: 1,
    activeDays: 20,
    periodDays: 28,
    ...over,
  });

  it('reads steady activity as engaged', () => {
    assert.equal(churnSignal({ tenantId: 't', window: window() }).band, 'ENGAGED');
  });

  it('is scale-free: a large customer falling is caught, a small steady one is not', () => {
    // A fixed threshold flags every small customer for ever and every large one
    // never. The signal is a tenancy doing markedly less than *it* used to.
    const bigFalling = churnSignal({ tenantId: 'a', window: window({ prior: 400, recent: 40 }) });
    const smallSteady = churnSignal({ tenantId: 'b', window: window({ prior: 22, recent: 22 }) });
    assert.equal(bigFalling.band, 'DECAYING');
    assert.equal(smallSteady.band, 'ENGAGED');
  });

  it('calls a month of silence dormant rather than computing a decay from it', () => {
    const signal = churnSignal({
      tenantId: 't',
      window: window({ daysSinceLastEvent: DORMANT_AFTER_DAYS, recent: 0 }),
    });
    assert.equal(signal.band, 'DORMANT');
    assert.equal(signal.action, 'Ask. Nothing in the data distinguishes a lost customer from a quiet quarter.');
  });

  it('refuses to read anything into too little history', () => {
    const signal = churnSignal({ tenantId: 't', window: window({ prior: MINIMUM_PRIOR - 1, recent: 1 }) });
    assert.equal(signal.band, 'TOO_NEW_TO_SAY');
    assert.equal(signal.decay, null, 'no ratio may be reported where the base is too small');
  });

  it('never produces a probability or a score', () => {
    // There is no cohort of past churn to have trained on, and a percentage
    // produced without one is a decimal point with nothing behind it.
    const signal = churnSignal({ tenantId: 't', window: window({ prior: 400, recent: 40 }) });
    const serialised = JSON.stringify(signal);
    assert.ok(!/probability|score|likelihood|risk[A-Z]/.test(serialised));
  });

  it('keeps what was measured apart from what it might mean', () => {
    const signal = churnSignal({ tenantId: 't', window: window({ prior: 400, recent: 40 }) });
    assert.ok(signal.measurements.length > 0);
    assert.ok(signal.interpretations.length > 0);
    // The seasonal reading has to be offered, or an account manager phones a
    // customer who is simply between projects and gives them a reason to leave.
    assert.ok(signal.interpretations.some((line) => /seasonal|between projects/i.test(line)));
  });

  it('notices people leaving before volume falls, which is the earlier signal', () => {
    const signal = churnSignal({
      tenantId: 't',
      window: window({ prior: 400, recent: 240, priorActors: 10, recentActors: 2 }),
    });
    assert.ok(signal.interpretations.some((line) => /earlier signal/i.test(line)));
  });

  it('builds a window from real timestamps, splitting the two periods at the right place', () => {
    const now = new Date('2026-03-01T00:00:00.000Z');
    const day = 24 * 60 * 60 * 1000;
    const events = [
      { at: new Date(now.getTime() - 2 * day).toISOString(), actorId: 'u1' },
      { at: new Date(now.getTime() - 3 * day).toISOString(), actorId: 'u2' },
      { at: new Date(now.getTime() - 40 * day).toISOString(), actorId: 'u3' },
    ];
    const built = windowFrom(events, 28, now);
    assert.equal(built.recent, 2);
    assert.equal(built.prior, 1);
    assert.equal(built.recentActors, 2);
    assert.equal(built.daysSinceLastEvent, 2);
    assert.equal(built.activeDays, 2);
  });

  it('reports never-written as dormant rather than as engaged', () => {
    const built = windowFrom([], 28, new Date());
    assert.equal(built.daysSinceLastEvent, null);
    assert.equal(churnSignal({ tenantId: 't', window: built }).band, 'DORMANT');
  });
});

describe('over HTTP', () => {
  let platform: Platform;
  let seed: SeedResult;
  let server: Server;
  let base: string;

  before(async () => {
    platform = new Platform();
    seed = await seedDemoProject(platform);
    server = createGateway(platform);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  after(() => server.close());

  function tokenFor(who: keyof SeedResult['users']): string {
    const user = platform.user(seed.users[who]!.id);
    return issueTokens({
      actorId: user.id,
      tenantId: user.tenantId,
      partyId: user.partyId,
      roles: user.roles,
      mfaSatisfied: true,
    }).accessToken;
  }

  async function call(method: string, path: string, who: keyof SeedResult['users'], payload?: unknown) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${tokenFor(who)}`,
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text) as Record<string, any>) : undefined };
  }

  it('raises a settlement and shows the fee it computed', async () => {
    const raised = await call('POST', `/v1/projects/${seed.projectId}/platform-settlements`, 'admin', {
      againstRefType: 'PaymentCertificate',
      againstRefId: 'cert-1',
      amountMinor: 100_000_00,
      rail: 'FACILITATED',
    });
    assert.equal(raised.status, 201);
    assert.equal(raised.body!.settlement.status, 'PENDING');
    assert.ok(raised.body!.fee.basis.length > 0);
    assert.equal(raised.body!.settlement.netMinor, 100_000_00 - raised.body!.settlement.feeMinor);
  });

  it('refuses to complete the same settlement twice, over the wire as well as in the domain', async () => {
    const raised = await call('POST', `/v1/projects/${seed.projectId}/platform-settlements`, 'admin', {
      againstRefType: 'PaymentCertificate',
      againstRefId: 'cert-2',
      amountMinor: 20_000_00,
      rail: 'FACILITATED',
    });
    const id = raised.body!.settlement.id;
    const first = await call('POST', `/v1/projects/${seed.projectId}/platform-settlements/${id}/complete`, 'admin');
    assert.equal(first.status, 201);
    const second = await call('POST', `/v1/projects/${seed.projectId}/platform-settlements/${id}/complete`, 'admin');
    assert.equal(second.status, 409);
  });

  it('refuses a site manager raising a settlement', async () => {
    const refused = await call('POST', `/v1/projects/${seed.projectId}/platform-settlements`, 'siteManager', {
      againstRefType: 'PaymentCertificate',
      againstRefId: 'cert-3',
      amountMinor: 1_000_00,
      rail: 'FACILITATED',
    });
    assert.equal(refused.status, 403);
  });

  it('reports transaction revenue with the bands and limits alongside it', async () => {
    const read = await call('GET', '/v1/admin/transaction-revenue', 'admin');
    assert.equal(read.status, 200);
    assert.ok(Array.isArray(read.body!.bands));
    assert.equal(read.body!.capMinor, FEE_CAP_MINOR);
    assert.equal(read.body!.floorMinor, FEE_FLOOR_MINOR);
  });

  it('gives the commercial position, with consent absent until it is given', async () => {
    const read = await call('GET', '/v1/admin/commercial', 'admin');
    assert.equal(read.status, 200);
    assert.equal(read.body!.benchmarkConsent.granted, false, 'absence must never read as consent');
    assert.ok(read.body!.expansion);
    assert.ok(read.body!.engagement.band);
  });

  it('records consent, and records its withdrawal, both against a named person', async () => {
    const granted = await call('POST', '/v1/admin/benchmark-consent', 'admin', { granted: true });
    assert.equal(granted.status, 201);
    assert.equal(granted.body!.consent.granted, true);
    assert.ok(granted.body!.consent.decidedBy.length > 0);
    assert.equal(granted.body!.consent.scope, CONSENT_SCOPE);

    const after = await call('GET', '/v1/admin/commercial', 'admin');
    assert.equal(after.body!.benchmarkConsent.granted, true);

    const withdrawn = await call('POST', '/v1/admin/benchmark-consent', 'admin', { granted: false });
    assert.equal(withdrawn.status, 201);
    const afterWithdrawal = await call('GET', '/v1/admin/commercial', 'admin');
    assert.equal(afterWithdrawal.body!.benchmarkConsent.granted, false);
  });

  it('refuses a site manager setting benchmark consent for the company', async () => {
    const refused = await call('POST', '/v1/admin/benchmark-consent', 'siteManager', { granted: true });
    assert.equal(refused.status, 403);
  });

  it('refuses every commercial route to an unauthenticated caller', async () => {
    for (const path of ['/v1/admin/commercial', '/v1/admin/transaction-revenue']) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 401, path);
    }
  });
});
