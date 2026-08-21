import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { COST_HEADS, priceEstimate } from '../src/engines/maths/costModel.ts';
import { CONTROL_ITEMS, evaluateControl } from '../src/lifecycle/control.ts';
import {
  atLeastProject,
  EXPOSURE,
  ORGANISATION_BANDS,
  organisationScale,
  PROJECT_BANDS,
  projectScale,
  proportionality,
} from '../src/lifecycle/scale.ts';
import { recommendFramework } from '../src/domain/framework.ts';
import { scrutinyFor } from '../src/domain/supplychain.ts';

/**
 * The same operating system, from a sole trader to a multi-billion programme.
 *
 * An absolute money threshold is always wrong at one end. "Enhanced scrutiny
 * above £250,000" is sensible for an £8m contractor, meaningless for a £4bn one
 * and unreachable for a £40k one. "Three quotes per package" is discipline on a
 * school and bureaucracy on a skip. So these tests run the extremes through the
 * same code and check that the platform is *proportionate* rather than merely
 * tolerant — a checklist that reports thirty gaps on a two-day repair has not
 * scaled down, it has just been ignored.
 */

describe('Scale bands', () => {
  it('runs from a two-day repair to a programme, with no gap between bands', () => {
    assert.equal(projectScale(3_000_00), 'MINOR');
    assert.equal(projectScale(380_000_00), 'SMALL');
    assert.equal(projectScale(6_200_000_00), 'MEDIUM');
    assert.equal(projectScale(85_000_000_00), 'MAJOR');
    assert.equal(projectScale(2_000_000_000_00), 'MEGA');

    // Boundaries belong to the lower band, and only the top band is open-ended.
    for (const band of PROJECT_BANDS.slice(0, -1)) {
      assert.equal(projectScale(band.ceilingMinor!), band.scale, `${band.label} should include its own ceiling`);
    }
    assert.equal(PROJECT_BANDS.at(-1)!.ceilingMinor, null);
  });

  it('starts the organisation bands at a sole trader rather than at £5m', () => {
    // Somebody turning over £40,000 is a real user of this platform, not a
    // rounding error below the bottom band.
    assert.equal(organisationScale(40_000_00), 'SOLE_TRADER');
    assert.equal(organisationScale(1_200_000_00), 'MICRO');
    assert.equal(organisationScale(8_000_000_00), 'SMALL');
    assert.equal(organisationScale(900_000_000_00), 'TIER_1');

    assert.equal(ORGANISATION_BANDS[0]!.scale, 'SOLE_TRADER');
    assert.equal(ORGANISATION_BANDS.at(-1)!.turnoverCeilingMinor, null);

    // Capacity has to grow monotonically or the bands are not a scale.
    const capacities = ORGANISATION_BANDS.map((b) => b.relationshipCapacity);
    assert.deepEqual(capacities, [...capacities].sort((a, b) => a - b));
  });

  it('asks for one quote on a skip and three on a package that matters', () => {
    assert.equal(proportionality({ projectValueMinor: 400_00 }).quotesRequired, 1);
    assert.equal(proportionality({ projectValueMinor: 120_000_00 }).quotesRequired, 2);
    assert.equal(proportionality({ projectValueMinor: 4_000_000_00 }).quotesRequired, 3);
  });
});

describe('The ratio, not the amount', () => {
  it('treats the same package differently for two different businesses', () => {
    // £400k. Routine for a £30m contractor; the whole year for a £600k one.
    const large = proportionality({ projectValueMinor: 400_000_00, annualTurnoverMinor: 30_000_000_00 });
    const small = proportionality({ projectValueMinor: 400_000_00, annualTurnoverMinor: 600_000_00 });

    assert.equal(large.projectScale, small.projectScale, 'the same job is the same size');
    assert.equal(large.scrutiny, 'STANDARD');
    assert.equal(small.scrutiny, 'ENHANCED', 'the business that cannot absorb it going wrong looks harder');
    assert.equal(large.bettingTheCompany, false);
    assert.equal(small.bettingTheCompany, true);
  });

  it('annualises a multi-year programme instead of comparing it to one year', () => {
    // £2bn over five years is £400m a year against £900m of turnover. Comparing
    // the whole contract to a single year's revenue reports 222%, which is not
    // a ratio anybody can act on.
    const spread = proportionality({ projectValueMinor: 200_000_000_000, annualTurnoverMinor: 900_000_000_00, durationWeeks: 260 });
    const crammed = proportionality({ projectValueMinor: 200_000_000_000, annualTurnoverMinor: 900_000_000_00, durationWeeks: 52 });

    assert.equal(spread.exposureAnnualised, true);
    assert.ok(spread.exposurePercent! < 50);
    assert.equal(crammed.exposureAnnualised, false);
    assert.ok(crammed.exposurePercent! > 200);
    assert.match(spread.rationale, /annualised over 5\.0 years/);
  });

  it('declines to compute exposure when turnover is unknown, rather than assuming', () => {
    const unknown = proportionality({ projectValueMinor: 400_000_00 });
    assert.equal(unknown.exposurePercent, undefined);
    assert.equal(unknown.bettingTheCompany, false);
    assert.equal(unknown.organisationScale, undefined);
  });

  it('makes supplier scrutiny relative once the buyer is known', () => {
    // Absolute thresholds remain the default for a caller that does not say.
    assert.equal(scrutinyFor(15_000_00), 'LIGHT');
    assert.equal(scrutinyFor(900_000_00), 'ENHANCED');

    // A £200k package: routine for a £30m business, the year for a £400k one.
    assert.equal(scrutinyFor(200_000_00, 30_000_000_00), 'STANDARD');
    assert.equal(scrutinyFor(200_000_00, 400_000_00), 'ENHANCED');

    // And a £4,000 package stays light for the sole trader, because demanding
    // audited accounts for it pushes good small firms out of the supply chain.
    assert.equal(scrutinyFor(4_000_00, 40_000_00), 'LIGHT');
  });
});

describe('A sole trader, a £3,000 bathroom', () => {
  const bathroom = () =>
    priceEstimate({
      durationWeeks: 2,
      lines: [{ description: 'Bathroom refit', unit: 'item', quantity: 1, labourRateMinor: 140_000, materialRateMinor: 120_000 }],
      quantified: [{ head: 'WASTE', description: 'Skip', unit: 'no', quantity: 1, rateMinor: 26_000 }],
      insurance: { policies: [{ type: 'Public liability', percentOfContractValue: 0.8 }] },
      margin: { overheadPercent: 4, profitPercent: 15 },
    });

  it('prices it without demanding fifteen heads it does not have', () => {
    const priced = bathroom();

    assert.equal(priced.projectScale, 'MINOR');
    assert.ok(priced.tenderTotalMinor > 300_000 && priced.tenderTotalMinor < 400_000);

    const notExpected = priced.heads.filter((h) => h.status === 'NOT_EXPECTED');
    assert.ok(notExpected.length > 10, 'most of the twenty heads are meaningless on a bathroom');
    for (const head of notExpected) {
      assert.match(head.derivation, /Not expected on a under £25k job/i);
      assert.ok(!priced.omissions.includes(head.head), `${head.head} was counted as an omission`);
    }

    // Site management, commissioning and temporary works are the obvious ones.
    for (const head of ['SITE_MANAGEMENT', 'COMMISSIONING', 'TEMPORARY_WORKS', 'INFLATION']) {
      assert.equal(priced.heads.find((h) => h.head === head)!.status, 'NOT_EXPECTED');
    }
  });

  it('does not nag about a risk register or inflation on a two-week job', () => {
    const priced = bathroom();
    assert.ok(!priced.warnings.some((w) => w.includes('contingency')));
    assert.ok(!priced.warnings.some((w) => w.includes('fixed price on future costs')));
  });

  it('still holds it to the handful of things that do matter', () => {
    const priced = bathroom();

    // Labour, materials, waste, insurance, overhead and profit all apply at any
    // size — this is proportionality, not an exemption.
    for (const head of ['DIRECT_WORKS', 'MATERIALS', 'WASTE', 'INSURANCE', 'OVERHEAD', 'PROFIT']) {
      assert.equal(priced.heads.find((h) => h.head === head)!.status, 'PRICED', `${head} should still be priced`);
    }
  });

  it('asks for six control items rather than thirty-six', () => {
    const report = evaluateControl('CONSTRUCTION', () => [], 3_000_00);

    assert.equal(report.projectScale, 'MINOR');
    assert.ok(report.applicableItems < 10, `${report.applicableItems} items is still a form, not a control standard`);
    assert.ok(report.applicableItems >= 4, 'some discipline applies at every size');

    // What survives at this size is what actually matters on a small job.
    const applicable = report.stages.flatMap((s) => s.items).filter((i) => i.status !== 'NOT_PROPORTIONATE');
    const ids = applicable.map((i) => i.id);
    assert.ok(ids.includes('PRE.SCOPE'), 'what is and is not included matters at every size');
    assert.ok(ids.includes('MOB.RAMS'), 'how the work is done safely matters at every size');
    assert.ok(ids.includes('COM.LESSONS_LEARNED'), 'what the job taught the business matters at every size');

    // And what does not.
    for (const id of ['MOB.BASELINE', 'MOB.DOCUMENT_CONTROL', 'DEL.COST_REPORT', 'DEL.RFI']) {
      assert.equal(
        report.stages.flatMap((s) => s.items).find((i) => i.id === id)!.status,
        'NOT_PROPORTIONATE',
        `${id} should not be demanded of a £3,000 job`,
      );
    }
  });

  it('sizes a framework of a dozen firms, not seventy', () => {
    const trader = recommendFramework({ annualTurnoverMinor: 40_000_00, projectTypes: ['REFURBISHMENT'] });

    assert.equal(trader.band.size, 'SOLE_TRADER');
    assert.equal(trader.recommendedSize, 12, 'one person cannot maintain seventy relationships');
    assert.equal(trader.concurrentProjects, 1);
  });
});

describe('A £2bn programme', () => {
  it('applies the whole standard, with nothing excused', () => {
    const report = evaluateControl('CONSTRUCTION', () => [], 2_000_000_000_00);

    assert.equal(report.projectScale, 'MEGA');
    assert.equal(report.applicableItems, CONTROL_ITEMS.length, 'nothing is excused at this size');
    assert.equal(report.stages.reduce((n, s) => n + s.notProportionate, 0), 0);
  });

  it('measures against the whole standard when the value is unknown', () => {
    // A project whose value nobody recorded is measured as though it were the
    // largest, because quietly excusing items on a job that might be enormous
    // is the more dangerous failure.
    const report = evaluateControl('CONSTRUCTION', () => []);
    assert.equal(report.projectScale, 'MEGA');
    assert.equal(report.applicableItems, CONTROL_ITEMS.length);
  });

  it('separates a Tier 1 from a large contractor on the framework it needs', () => {
    const large = recommendFramework({ annualTurnoverMinor: 300_000_000_00, projectTypes: ['HRB_RESIDENTIAL'] });
    const tier1 = recommendFramework({ annualTurnoverMinor: 900_000_000_00, projectTypes: ['HRB_RESIDENTIAL'] });

    assert.ok(tier1.recommendedSize > large.recommendedSize);
    assert.ok(tier1.recommendedSize > 300);
  });
});

describe('The standard itself scales', () => {
  it('gives every control item and cost head a size it starts applying at', () => {
    for (const item of CONTROL_ITEMS) {
      const from = item.appliesFrom ?? 'MINOR';
      assert.ok(PROJECT_BANDS.some((b) => b.scale === from), `${item.id} applies from a band that does not exist`);
    }
    for (const head of COST_HEADS) {
      const from = head.expectedFrom ?? 'MINOR';
      assert.ok(PROJECT_BANDS.some((b) => b.scale === from), `${head.head} is expected from a band that does not exist`);
    }
  });

  it('keeps a core that applies at every size', () => {
    const universal = CONTROL_ITEMS.filter((i) => (i.appliesFrom ?? 'MINOR') === 'MINOR');
    assert.ok(universal.length >= 4, 'a standard that excuses everything on small jobs is not a standard');

    const universalHeads = COST_HEADS.filter((h) => (h.expectedFrom ?? 'MINOR') === 'MINOR');
    // Labour, materials, plant, waste, insurance, overhead, profit.
    assert.ok(universalHeads.length >= 6);
  });

  it('never lets a larger project need less than a smaller one', () => {
    // Monotonicity: whatever applies at one size must still apply above it.
    // Without this the bands would be a set of special cases rather than a scale.
    let previous = 0;
    for (const band of PROJECT_BANDS) {
      const applies = CONTROL_ITEMS.filter((i) => atLeastProject(band.scale, i.appliesFrom ?? 'MINOR')).length;
      assert.ok(applies >= previous, `${band.label} demands fewer items than the band below it`);
      previous = applies;
    }
    assert.equal(previous, CONTROL_ITEMS.length, 'the largest band should demand everything');
  });

  it('holds the exposure thresholds in one place rather than in each caller', () => {
    assert.equal(EXPOSURE.bettingTheCompanyPercent, 40);
    assert.ok(EXPOSURE.materialPercent < EXPOSURE.bettingTheCompanyPercent);
  });
});
