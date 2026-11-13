import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import {
  feasibilityScheme, suggestMix, DEFAULT_ASSUMPTIONS, DWELLING_ARCHETYPES,
  type FeasibilityInput,
} from '../src/domain/feasibility.ts';

/**
 * The feasibility engine turns a site and a brief into a schedule, a land
 * budget, an order-of-cost and a programme. Everything here is deterministic,
 * so the one thing the tests must prove is that it reconciles: the areas sum to
 * the GIA, the GIA drives the cost, the land uses sum to the site, and nothing
 * is invented. A feasibility figure that does not add up is worse than none.
 */

const birmingham: FeasibilityInput = {
  schemeName: 'Birmingham 1 ha test scheme',
  authority: 'Birmingham City Council',
  tenure: 'Social rent',
  siteAreaHa: 1.0,
  mix: [
    { code: '2b4p-house', count: 10 },
    { code: '3b5p-house', count: 14 },
    { code: '1b2p-flat', count: 12 },
    { code: '2b4p-flat', count: 10 },
    { code: '3b5p-flat', count: 4 },
  ],
};

describe('the schedule of accommodation reconciles', () => {
  const s = feasibilityScheme(birmingham);

  it('counts the homes, houses, flats and bedspaces correctly', () => {
    assert.equal(s.totals.homes, 50);
    assert.equal(s.totals.houses, 24);
    assert.equal(s.totals.flats, 26);
    // 10*4 + 14*5 + 12*2 + 10*4 + 4*5 = 40+70+24+40+20
    assert.equal(s.totals.bedspaces, 194);
  });

  it('applies the NDSS minimum plus the design uplift, not an invented area', () => {
    const line = s.schedule.find((l) => l.code === '3b5p-house')!;
    const arch = DWELLING_ARCHETYPES.find((a) => a.code === '3b5p-house')!;
    assert.equal(line.ndssMinM2, arch.ndssMinM2); // 93, straight from NDSS
    assert.equal(line.designM2, Math.round(93 * 1.07 * 10) / 10); // 99.5
    assert.equal(line.totalDesignM2, Math.round(line.designM2 * 14 * 10) / 10);
  });

  it('net dwelling GIA is the sum of the schedule lines', () => {
    const sum = Math.round(s.schedule.reduce((a, l) => a + l.totalDesignM2, 0) * 10) / 10;
    assert.equal(s.totals.netDwellingGiaM2, sum);
  });

  it('costed GIA adds the flat common area and nothing else', () => {
    const expectedFlatBuilding = Math.round((s.totals.netDwellingGiaM2 - s.totals.houseBuildingGiaM2) * 1.18 * 10) / 10;
    assert.equal(s.totals.flatBuildingGiaM2, expectedFlatBuilding);
    assert.equal(s.totals.costedBuildingGiaM2, Math.round((s.totals.houseBuildingGiaM2 + s.totals.flatBuildingGiaM2) * 10) / 10);
  });

  it('reports density from the site area, not a guess', () => {
    assert.equal(s.totals.densityDph, 50); // 50 homes / 1.0 ha
  });
});

describe('the cost plan builds up and totals correctly', () => {
  const s = feasibilityScheme(birmingham);
  const line = (item: string) => s.costPlan.lines.find((l) => l.item === item)!.amountMinor;

  it('prices buildings off the GIA and the published rate', () => {
    assert.equal(line('Houses'), Math.round(s.totals.houseBuildingGiaM2 * DEFAULT_ASSUMPTIONS.houseRatePerM2 * 100));
    assert.equal(line('Flats'), Math.round(s.totals.flatBuildingGiaM2 * DEFAULT_ASSUMPTIONS.flatRatePerM2 * 100));
  });

  it('direct works is the sum of its components', () => {
    const parts = ['Houses', 'Flats', 'Clearance, earthworks & enabling', 'Roads, footways, parking & S278',
      'Foul, surface drainage & SuDS', 'Utilities & site lighting', 'Landscape, gardens, play & BNG', 'External stores & ancillary'];
    const sum = parts.reduce((a, p) => a + line(p), 0);
    assert.equal(s.costPlan.directWorksMinor, sum);
    assert.equal(line('Direct works'), sum);
  });

  it('applies preliminaries, OHP, fees, risk and inflation in the right order', () => {
    const direct = s.costPlan.directWorksMinor;
    const prelims = Math.round(direct * 0.12);
    const ohp = Math.round((direct + prelims) * 0.06);
    assert.equal(line('Main contractor preliminaries'), prelims);
    assert.equal(line('Overhead & profit'), ohp);
    assert.equal(s.costPlan.baseConstructionMinor, direct + prelims + ohp);
    // Forecast outturn = base incl risk + inflation, and base incl risk builds on base construction.
    assert.equal(line('Forecast outturn'), s.costPlan.forecastOutturnMinor);
    assert.ok(s.costPlan.forecastOutturnMinor > s.costPlan.baseInclRiskMinor);
    assert.equal(s.costPlan.forecastOutturnMinor - s.costPlan.baseInclRiskMinor, line('Inflation allowance'));
  });

  it('derives per-home and per-m² metrics from the totals', () => {
    assert.equal(s.costPlan.perHomeMinor, Math.round(s.costPlan.forecastOutturnMinor / s.totals.homes));
    assert.equal(s.costPlan.perM2Minor, Math.round(s.costPlan.baseConstructionMinor / s.totals.costedBuildingGiaM2));
    // Sanity: a UK social-housing outturn lands in a credible band (£250k–£500k/home).
    const perHomePounds = s.costPlan.perHomeMinor / 100;
    assert.ok(perHomePounds > 250_000 && perHomePounds < 500_000, `per-home £${perHomePounds}`);
  });
});

describe('the land budget apportions the real site and balances', () => {
  const s = feasibilityScheme(birmingham);

  it('the allocated uses plus the balance equal the site area exactly', () => {
    const named = s.landBudget.uses.filter((u) => !u.use.startsWith('Undeveloped') && !u.use.startsWith('OVER SITE'));
    const allocated = named.reduce((a, u) => a + u.areaM2, 0);
    assert.equal(s.landBudget.allocatedM2, allocated);
    assert.equal(allocated + s.landBudget.balanceM2, s.siteAreaM2);
    assert.equal(s.siteAreaM2, 10000);
  });

  it('flags an over-dense scheme instead of silently overflowing the site', () => {
    const dense = feasibilityScheme({ ...birmingham, mix: [{ code: '3b5p-house', count: 120 }] });
    assert.equal(dense.landBudget.overSite, true);
    assert.ok(dense.landBudget.balanceM2 < 0);
    assert.ok(dense.landBudget.uses.some((u) => u.use.startsWith('OVER SITE')));
  });
});

describe('accessibility, parking and programme', () => {
  const s = feasibilityScheme(birmingham);

  it('meets the M4(2) policy minimum and never goes under it', () => {
    assert.ok(s.accessibility.m4_2Percent >= DEFAULT_ASSUMPTIONS.m4_2MinPercent);
    assert.equal(s.accessibility.meetsPolicy, true);
    assert.equal(s.accessibility.m4_1 + s.accessibility.m4_2 + s.accessibility.m4_3, s.totals.homes);
  });

  it('sizes parking and cycle from the unit counts', () => {
    assert.equal(s.parking.houseSpaces, 24); // 24 houses * 1.0
    assert.equal(s.parking.totalSpaces, s.parking.houseSpaces + s.parking.flatSpaces + s.parking.visitorSpaces);
  });

  it('scales the on-site period with the number of homes and reports a credible total', () => {
    assert.equal(s.programme.onSiteMonths, Math.max(14, Math.round(12 + 50 * 0.16)));
    assert.ok(s.programme.totalMonths >= 30 && s.programme.totalMonths <= 52);
    const last = s.programme.stages[s.programme.stages.length - 1]!;
    assert.equal(last.cumulativeMonths, s.programme.stages.reduce((a, st) => a + st.months, 0));
  });
});

describe('validation and the mix suggestion', () => {
  it('refuses an empty mix, a bad site area and an unknown archetype', () => {
    throwsCode(() => feasibilityScheme({ ...birmingham, mix: [] }), 'MIX_REQUIRED');
    throwsCode(() => feasibilityScheme({ ...birmingham, siteAreaHa: 0 }), 'SITE_AREA_REQUIRED');
    throwsCode(() => feasibilityScheme({ ...birmingham, mix: [{ code: 'x' as never, count: 1 }] }), 'ARCHETYPE_UNKNOWN');
    throwsCode(() => feasibilityScheme({ ...birmingham, mix: [{ code: '1b2p-flat', count: -1 }] }), 'MIX_COUNT_INVALID');
  });

  it('suggests a family-weighted mix that fills the site to the target density', () => {
    const mix = suggestMix(1.0, 50);
    const homes = mix.reduce((a, e) => a + e.count, 0);
    assert.ok(homes >= 48 && homes <= 52, `suggested ${homes} homes`);
    // The suggestion is a valid input the engine can compute without edits.
    const s = feasibilityScheme({ ...birmingham, mix });
    assert.ok(s.totals.familyHomePercent >= 40);
    throwsCode(() => suggestMix(0), 'SITE_AREA_REQUIRED');
  });

  it('honours assumption overrides deterministically', () => {
    const cheaper = feasibilityScheme({ ...birmingham, assumptions: { houseRatePerM2: 2000, flatRatePerM2: 2300 } });
    const base = feasibilityScheme(birmingham);
    assert.ok(cheaper.costPlan.forecastOutturnMinor < base.costPlan.forecastOutturnMinor);
  });
});
