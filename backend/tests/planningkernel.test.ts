import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FEE_SCHEDULES, quoteFee, FeeInputError, type FeeInput } from '../src/domain/planning/fees.ts';
import { areaDivergence, geodeticAreaM2, GeometryError, parseSiteGeometry } from '../src/domain/planning/geometry.ts';
import { evaluateRules, type RuleInput } from '../src/domain/planning/rules.ts';

/**
 * The planning kernels, against the owner's reference fixtures
 * (`CONSTRUX_Planning_Fee_Reference.py`) and the specification's acceptance
 * table (§8). Every figure here is the specification's; the code is held to it.
 */

const ALL = new Set(FEE_SCHEDULES.map((schedule) => schedule.version));
const fee = (input: Omit<FeeInput, 'madeOn'> & { madeOn?: string }, published: ReadonlySet<string> = ALL) =>
  quoteFee({ madeOn: '2026-12-08', ...input }, published);
const pounds = (input: Parameters<typeof fee>[0]) => fee(input).amountMinor;

describe('the reference kernel fixtures', () => {
  it('full: boundaries either side of each band, both schedules', () => {
    const cases: Array<[string, number[]]> = [
      ['2026-12-07', [5490, 6590, 26360, 32291, 32950, 32774]],
      ['2026-12-08', [6768, 8180, 32720, 40082, 40318, 40554]],
    ];
    for (const [madeOn, expected] of cases) {
      [9, 10, 40, 49, 50, 51].forEach((dwellings, index) => {
        assert.equal(pounds({ route: 'full', madeOn, dwellings }), expected[index]! * 100, `${madeOn} ${dwellings}`);
      });
    }
  });

  it('outline: started 0.1 ha units either side of each band', () => {
    const cases: Array<[string, number[]]> = [
      ['2026-04-01', [3050, 3295, 16475, 16487, 17271]],
      ['2026-12-08', [3595, 4480, 22400, 22667, 23735]],
    ];
    for (const [madeOn, expected] of cases) {
      [4999, 5000, 25000, 25001, 30000].forEach((areaM2, index) => {
        assert.equal(pounds({ route: 'outline', madeOn, areaM2 }), expected[index]! * 100, `${madeOn} ${areaM2}`);
      });
    }
  });

  it('caps', () => {
    for (const [madeOn, fullCap, outlineCap] of [['2026-04-01', 427537, 213769], ['2026-12-08', 513512, 290625]] as const) {
      assert.equal(pounds({ route: 'full', madeOn, dwellings: 100_000 }), fullCap * 100);
      assert.equal(pounds({ route: 'outline', madeOn, areaM2: 100_000_000 }), outlineCap * 100);
      const capped = fee({ route: 'full', madeOn, dwellings: 100_000 });
      assert.equal(capped.breakdown.at(-1)!.description, 'Statutory cap adjustment');
    }
  });

  it('request fees', () => {
    for (const [route, before, after] of [['condition_details', 309, 435], ['section_73_major', 2076, 3150], ['section_96a_non_householder', 309, 360]] as const) {
      assert.equal(pounds({ route, madeOn: '2026-12-07' }), before * 100);
      assert.equal(pounds({ route, madeOn: '2026-12-08' }), after * 100);
    }
  });

  it('reserved matters: history unknown is review; not met is the full fee; met is the flat fee', () => {
    assert.equal(pounds({ route: 'reserved_matters', dwellings: 40 }), null);
    assert.equal(pounds({ route: 'reserved_matters', dwellings: 40, reservedHistoryThresholdMet: false }), 3_272_000);
    assert.equal(pounds({ route: 'reserved_matters', reservedHistoryThresholdMet: true }), 74_900);
  });

  it('unsupported or unverified: no payable figure', () => {
    const april2027 = fee({ route: 'full', madeOn: '2027-04-01', dwellings: 40 });
    assert.equal(april2027.amountMinor, null);
    assert.equal(april2027.status, 'REVIEW_REQUIRED');
    assert.equal(april2027.ruleVersion, null);
    assert.equal(pounds({ route: 'outline', areaM2: 30_000, nonStandard: 'possible exemption for a community-led scheme' }), null);
  });

  it('invalid inputs are refused, not guessed', () => {
    assert.throws(() => fee({ route: 'full', dwellings: 0 }), FeeInputError);
    assert.throws(() => fee({ route: 'outline', areaM2: Number.NaN }), FeeInputError);
    assert.throws(() => fee({ route: 'full', madeOn: '8 Dec 2026', dwellings: 4 }), FeeInputError);
  });
});

describe('the specification’s fee examples', () => {
  it('the worked project, made 7 and 8 December', () => {
    assert.equal(pounds({ route: 'full', madeOn: '2026-12-07', dwellings: 40 }), 2_636_000);
    assert.equal(pounds({ route: 'full', madeOn: '2026-12-08', dwellings: 40 }), 3_272_000);
    assert.equal(pounds({ route: 'outline', madeOn: '2026-12-07', areaM2: 30_000 }), 1_727_100);
    assert.equal(pounds({ route: 'outline', madeOn: '2026-12-08', areaM2: 30_000 }), 2_373_500);
    // Outline plus one reserved-matters application for all 40, no qualifying prior payment.
    const outlinePlusRm = (madeOn: string) =>
      pounds({ route: 'outline', madeOn, areaM2: 30_000 })! + pounds({ route: 'reserved_matters', madeOn, dwellings: 40, reservedHistoryThresholdMet: false })!;
    assert.equal(outlinePlusRm('2026-12-07'), 4_363_100);
    assert.equal(outlinePlusRm('2026-12-08'), 5_645_500);
    assert.equal(3 * pounds({ route: 'condition_details', madeOn: '2026-12-07' })!, 92_700);
    assert.equal(3 * pounds({ route: 'condition_details', madeOn: '2026-12-08' })!, 130_500);
  });

  it('the outline response matches the specification’s example breakdown', () => {
    const quote = fee({ route: 'outline', madeOn: '2026-12-08', areaM2: 30_000 });
    assert.equal(quote.ruleVersion, 'england-2026-12-08');
    assert.deepEqual(quote.breakdown.map((entry) => [entry.quantity, entry.amountMinor]), [[1, 2_240_000], [5, 133_500]]);
  });

  it('an unpublished schedule shows what it would come to, but nothing payable', () => {
    const quote = fee({ route: 'full', dwellings: 40 }, new Set());
    assert.equal(quote.status, 'REVIEW_REQUIRED');
    assert.equal(quote.amountMinor, null);
    assert.equal(quote.breakdown[0]!.amountMinor, 3_272_000);
    assert.match(quote.reviewReasons[0]!, /has not been checked against its published source/);
  });

  it('a condition request made 7 December stays on the April schedule however late it is validated', () => {
    assert.equal(fee({ route: 'condition_details', madeOn: '2026-12-07' }).ruleVersion, 'england-2026-04-01');
  });
});

// --- Geometry --------------------------------------------------------------------------

/** A rectangle of the given metres at a latitude, built from the ellipsoid's radii of curvature. */
function rectangle(lat: number, lon: number, widthM: number, heightM: number): number[][] {
  const a = 6378137;
  const f = 1 / 298.257223563;
  const e2 = f * (2 - f);
  const phi = (lat * Math.PI) / 180;
  const w = 1 - e2 * Math.sin(phi) ** 2;
  const meridian = (a * (1 - e2)) / w ** 1.5;
  const normal = a / Math.sqrt(w);
  const dLat = (heightM / meridian) * (180 / Math.PI);
  const dLon = (widthM / (normal * Math.cos(phi))) * (180 / Math.PI);
  return [[lon, lat], [lon + dLon, lat], [lon + dLon, lat + dLat], [lon, lat + dLat], [lon, lat]];
}

describe('the red line', () => {
  it('measures a 100 m square in England to within a square metre', () => {
    const area = geodeticAreaM2(parseSiteGeometry({ type: 'Polygon', coordinates: [rectangle(52.5, -1.9, 100, 100)] }));
    assert.ok(Math.abs(area - 10_000) < 1, `measured ${area}`);
  });

  it('measures a 3 ha site, subtracts a hole and adds a second part', () => {
    const site = rectangle(51.5, -0.1, 300, 100);
    const hole = rectangle(51.5001, -0.099, 20, 20);
    const part = rectangle(51.51, -0.1, 50, 50);
    const geometry = parseSiteGeometry({ type: 'MultiPolygon', coordinates: [[site, hole.reverse()], [part]] });
    const area = geodeticAreaM2(geometry);
    assert.ok(Math.abs(area - (30_000 - 400 + 2_500)) < 3, `measured ${area}`);
  });

  it('accepts a Feature or a one-feature collection, and refuses what is not a red line', () => {
    const ring = rectangle(52, -1, 50, 50);
    assert.equal(parseSiteGeometry({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] } }).type, 'MultiPolygon');
    assert.equal(parseSiteGeometry({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] } }] }).coordinates.length, 1);
    const refuse = (input: unknown, pattern: RegExp) => assert.throws(() => parseSiteGeometry(input), (error: Error) => error instanceof GeometryError && pattern.test(error.message));
    refuse({ type: 'Point', coordinates: [0, 0] }, /Polygon or MultiPolygon/);
    refuse({ type: 'Polygon', coordinates: [ring.slice(0, -1)] }, /not closed/);
    refuse({ type: 'Polygon', coordinates: [[[0, 0], [1, 1], [0, 0], [0, 0]]] }, /at least four|encloses no area/);
    // A bow-tie crosses itself.
    refuse({ type: 'Polygon', coordinates: [[[0, 0], [0.001, 0.001], [0.001, 0], [0, 0.001], [0, 0]]] }, /crosses or touches itself/);
    refuse({ type: 'Polygon', coordinates: [[[400000, 300000], [400100, 300000], [400100, 300100], [400000, 300000]]] }, /EPSG:4326/);
    refuse({ type: 'Polygon', coordinates: [ring, rectangle(53, -1, 10, 10)] }, /outside its shell/);
    refuse({ type: 'MultiPolygon', coordinates: [[ring], [rectangle(52.0001, -0.9999, 5, 5)]] }, /must not overlap/);
    refuse({ type: 'FeatureCollection', features: [] }, /one feature/);
  });

  it('raises a material difference between the drawn and confirmed area', () => {
    assert.equal(areaDivergence(10_100, 10_000).material, false);
    assert.equal(areaDivergence(10_300, 10_000).material, true);
    // Within 2% but either side of 1 ha.
    const straddle = areaDivergence(10_050, 9_990);
    assert.equal(straddle.material, true);
    assert.match(straddle.reasons.join(' '), /either side of 1 ha/);
    assert.equal(areaDivergence(10_000, null).material, false);
  });
});

// --- Rules ------------------------------------------------------------------------------

const base: RuleInput = { use: 'HOUSING', siteAreaM2: null, areaBasis: 'CONFIRMED', areaReviewReasons: [], authorityConfirmed: true, dwellings: null, createdGiaM2: null, facts: {} };
const status = (input: Partial<RuleInput>, code: string) => evaluateRules({ ...base, ...input }).findings.find((finding) => finding.code === code)!.status;

describe('the rules, against the specification’s acceptance table', () => {
  it('0.4999 ha with an unknown count is not major by area; 0.5 ha is', () => {
    assert.equal(status({ siteAreaM2: 4_999, createdGiaM2: 500 }, 'MAJOR_UNKNOWN_COUNT_AREA'), 'does_not_apply');
    assert.equal(evaluateRules({ ...base, siteAreaM2: 4_999, createdGiaM2: 500 }).major, 'UNRESOLVED');
    assert.equal(status({ siteAreaM2: 5_000, createdGiaM2: 500 }, 'MAJOR_UNKNOWN_COUNT_AREA'), 'applies');
    assert.equal(evaluateRules({ ...base, siteAreaM2: 5_000, createdGiaM2: 500 }).major, 'MAJOR');
  });

  it('1 ha with 9 dwellings is major by site area; 0.5 ha with 9 does not use the unknown-count branch', () => {
    const one = evaluateRules({ ...base, siteAreaM2: 10_000, dwellings: 9, createdGiaM2: 900 });
    assert.equal(one.major, 'MAJOR');
    assert.equal(one.findings.find((finding) => finding.code === 'MAJOR_SITE_AREA')!.status, 'applies');
    const half = evaluateRules({ ...base, siteAreaM2: 5_000, dwellings: 9, createdGiaM2: 900 });
    assert.equal(half.major, 'NOT_MAJOR');
    assert.match(half.findings.find((finding) => finding.code === 'MAJOR_UNKNOWN_COUNT_AREA')!.reason, /known/);
  });

  it('keeps every matched major reason independently', () => {
    const result = evaluateRules({ ...base, siteAreaM2: 30_000, dwellings: 40, createdGiaM2: 3_600 });
    assert.deepEqual(
      result.findings.filter((finding) => finding.code.startsWith('MAJOR_') && finding.status === 'applies').map((finding) => finding.code),
      ['MAJOR_DWELLINGS', 'MAJOR_SITE_AREA', 'MAJOR_FLOORSPACE'],
    );
  });

  it('an unknown that cannot change the outcome is unavailable, not a review', () => {
    assert.equal(status({ siteAreaM2: 30_000, dwellings: 40 }, 'MAJOR_FLOORSPACE'), 'unavailable');
  });

  it('the worked project: 3 ha, 40 homes', () => {
    const project = { siteAreaM2: 30_000, dwellings: 40, createdGiaM2: 3_600 };
    assert.equal(status(project, 'FRA'), 'review_required', 'no flood zone recorded is never Flood Zone 1');
    assert.equal(status({ ...project, facts: { FLOOD_ZONE: '1' } }, 'FRA'), 'applies', '3 ha in Flood Zone 1 needs an FRA by area');
    assert.equal(status(project, 'EIA_SCREENING'), 'review_required', 'below the numbers, screening stays open');
    assert.equal(status({ ...project, facts: { EIA_SENSITIVE_AREA: 'NO', EIA_CUMULATIVE: 'NONE_FOUND' } }, 'EIA_SCREENING'), 'does_not_apply');
    assert.equal(status(project, 'BNG'), 'review_required');
    assert.equal(status(project, 'CIL'), 'unavailable');
    assert.equal(status(project, 'LOCAL_VALIDATION'), 'review_required');
    const period = evaluateRules({ ...base, ...project }).findings.find((finding) => finding.code === 'DETERMINATION_PERIOD')!;
    assert.match(period.reason, /^13 weeks/);
  });

  it('EIA thresholds and the period that follows a requirement for a statement', () => {
    assert.equal(status({ siteAreaM2: 30_000, dwellings: 151 }, 'EIA_SCREENING'), 'review_required');
    assert.equal(status({ siteAreaM2: 50_001, dwellings: 40 }, 'EIA_SCREENING'), 'review_required');
    const es = evaluateRules({ ...base, siteAreaM2: 30_000, dwellings: 40, facts: { EIA_SCREENING_OPINION: 'ES_REQUIRED' } });
    assert.match(es.findings.find((finding) => finding.code === 'DETERMINATION_PERIOD')!.reason, /^16 weeks/);
  });

  it('a small site in Flood Zone 1 needs the other flood sources checked before an FRA is ruled out', () => {
    assert.equal(status({ siteAreaM2: 4_000, dwellings: 8, facts: { FLOOD_ZONE: '1' } }, 'FRA'), 'review_required');
    assert.equal(status({ siteAreaM2: 4_000, dwellings: 8, facts: { FLOOD_ZONE: '1', CRITICAL_DRAINAGE_AREA: 'NO', SURFACE_WATER_RISK: 'LOW', FUTURE_FLOOD_RISK: 'NO' } }, 'FRA'), 'does_not_apply');
    assert.equal(status({ siteAreaM2: 4_000, dwellings: 8, facts: { FLOOD_ZONE: '2' } }, 'FRA'), 'applies');
  });

  it('a non-housing use and an unconfirmed authority go to review', () => {
    const result = evaluateRules({ ...base, use: 'MIXED', authorityConfirmed: false, siteAreaM2: 30_000, dwellings: 40 });
    assert.ok(result.findings.some((finding) => finding.code === 'USE_SCOPE' && finding.status === 'review_required'));
    assert.ok(result.findings.some((finding) => finding.code === 'AUTHORITY'));
    assert.ok(result.findings.filter((finding) => finding.code.startsWith('MAJOR_')).every((finding) => finding.status === 'review_required'));
  });
});
