import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { commercialOverview } from '../src/domain/commercialoverview.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Where this job is commercially, on one read.
 *
 * The figures were never missing — the contract sum, the commitments, the
 * certificates, the CVR's forecast and exposure, the budget's cost codes and
 * the actuals posted against them are all records this platform already keeps.
 * What was missing was the read that puts them beside each other, so answering
 * "where is this job" meant opening the Command Centre for three numbers and
 * Cost & Value for the rest.
 *
 * What this file is mostly asserting is that the composition stays a
 * composition: that no figure here is a second arithmetic for a number an
 * engine already published, and that a record which does not exist reads as
 * absent rather than as zero.
 */

let platform: Platform;
let seed: SeedResult;

const asOwner = () => platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' });

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

describe('the commercial overview of a project', () => {
  it('composes the six figures a commercial director opens the screen for', () => {
    const overview = commercialOverview(asOwner());
    const by = new Map(overview.headline.map((entry) => [entry.key, entry]));

    for (const key of ['contractValue', 'committed', 'certified', 'forecastFinalCost', 'forecastMargin', 'exposure']) {
      assert.ok(by.has(key), `the overview lost ${key}`);
    }

    // Each against the record it is composed from, so a change to either side
    // fails here rather than showing a plausible wrong number on a dashboard.
    const contract = platform.ledger
      .list(seed.projectId, 'Contract')
      .filter((record) => record.state.status === 'EXECUTED')
      .at(-1)!;
    const commitments = platform.ledger
      .list(seed.projectId, 'Commitment')
      .reduce((sum, record) => sum + Number(record.state.valueMinor ?? 0), 0);
    const certified = platform.ledger
      .list(seed.projectId, 'PaymentCertificate')
      .reduce((sum, record) => sum + Number(record.state.certifiedMinor ?? 0), 0);

    assert.equal(by.get('contractValue')!.amountMinor, Number(contract.state.contractSumMinor));
    assert.equal(by.get('committed')!.amountMinor, commitments);
    assert.equal(by.get('certified')!.amountMinor, certified);
    assert.ok(commitments > 0 && certified > 0, 'the fixture must actually have commitments and certificates');
  });

  it('takes the margin from the CVR rather than recomputing it', () => {
    // The load-bearing assertion of the whole module. A margin subtracted here
    // would be a second answer to a question the CVR engine already answers,
    // and the one on the screen would be the one nobody had tested.
    const cvr = platform.ledger.list(seed.projectId, 'CVR').at(-1)!.state as Record<string, unknown>;
    const by = new Map(commercialOverview(asOwner()).headline.map((entry) => [entry.key, entry]));

    assert.equal(by.get('forecastMargin')!.amountMinor, Number(cvr.forecastMarginMinor));
    assert.equal(by.get('forecastMargin')!.percent, Number(cvr.forecastMarginPercent));
    assert.equal(by.get('forecastFinalCost')!.amountMinor, Number(cvr.forecastFinalCostMinor));
    assert.equal(by.get('exposure')!.amountMinor, Number(cvr.unapprovedExposureMinor));
  });

  it('names the client and the form off the contract, not the party key', () => {
    const overview = commercialOverview(asOwner());
    // "CLIENT-AWA" is what the record keys on and not what anybody calls the
    // client; a header showing the key has not answered the question it asked.
    assert.equal(overview.header.client, 'Ashworth Water Authority');
    assert.equal(overview.header.contractor, 'Meridian Infrastructure Group Ltd');
    assert.match(overview.header.contractForm ?? '', /NEC4/);
    assert.doesNotMatch(overview.header.client ?? '', /^CLIENT-/);
  });

  it('breaks the cost down by the budget’s own cost codes, with the actuals against them', () => {
    const overview = commercialOverview(asOwner());
    const budget = platform.ledger
      .list(seed.projectId, 'Budget')
      .filter((record) => record.state.status === 'APPROVED')
      .at(-1)!.state as Record<string, unknown>;
    const codes = budget.byCostCode as Array<{ costCode: string; budgetMinor: number }>;

    assert.equal(overview.breakdown.byCostCode.length, codes.length);
    assert.equal(overview.breakdown.totalMinor, codes.reduce((sum, code) => sum + code.budgetMinor, 0));
    // Largest first: the screen shows the top codes and "top" has to mean something.
    const values = overview.breakdown.byCostCode.map((code) => code.budgetMinor);
    assert.deepEqual(values, [...values].sort((a, b) => b - a));
    // Shares add up to the whole, within the rounding one decimal place allows.
    const share = overview.breakdown.byCostCode.reduce((sum, code) => sum + code.share, 0);
    assert.ok(Math.abs(share - 100) < 1, `shares total ${share}, not 100`);

    // The actuals are the ones posted against that code, not a spread.
    const first = overview.breakdown.byCostCode[0]!;
    const posted = platform.ledger
      .list(seed.projectId, 'ActualCost')
      .filter((record) => record.state.costCode === first.costCode)
      .reduce((sum, record) => sum + Number(record.state.amountMinor ?? 0), 0);
    assert.equal(first.actualMinor, posted);
  });

  it('orders the risks by what they are expected to cost', () => {
    const overview = commercialOverview(asOwner());
    const expected = overview.risks.map((risk) => risk.expectedCostMinor);
    assert.deepEqual(expected, [...expected].sort((a, b) => b - a));
    assert.ok(overview.risks.length > 0, 'the fixture must have open risks');
  });

  it('says the register does not model opportunities rather than showing none', () => {
    // An empty "Opportunities" panel says this project has no upside. The truth
    // is that `scoreRisk` takes a probability and an impact and returns an
    // expected cost, and no record here holds a priced upside at all.
    const overview = commercialOverview(asOwner());
    assert.equal(overview.opportunities.modelled, false);
    assert.match(overview.opportunities.because, /downside only/);
  });

  it('reads an absent record as absent, never as zero', () => {
    // £0 forecast final cost on a project nobody has forecast looks like an
    // answer and is not one, so every missing figure has to name the record
    // that would carry it.
    const position = commercialOverview(asOwner());
    for (const entry of position.headline) {
      if (entry.amountMinor === null) {
        assert.ok(entry.absent, `${entry.key} is missing and does not say why`);
      }
    }
    // The curve says how much record it was drawn from rather than implying a
    // trend from two points.
    assert.match(position.costVsValue.note, /month|Nothing/);
    assert.equal(position.costVsValue.periods.length, position.costVsValue.certifiedMinor.length);
    assert.equal(position.costVsValue.periods.length, position.costVsValue.actualCostMinor.length);
  });

  it('is Commercial-L3, so a role that is not cleared for the margin is refused', () => {
    // The permission matrix already decides who may see a commercial position.
    // This read is the margin, so it authorises on the area that owns it rather
    // than on the project read that every seat holds.
    const asSafety = platform.context(seed.users.safety!.auth, seed.projectId, { source: 'WEB' });
    throwsCode(() => commercialOverview(asSafety), 'ACCESS_DENIED');
  });
});
