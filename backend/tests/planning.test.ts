import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { ROUTES } from '../src/api/routes.ts';
import * as planning from '../src/domain/planning/planning.ts';
import { planningWatchAgent } from '../src/agents/planning.ts';
import type { EngineContext } from '../src/engines/context.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * CONSTRUX Planning, the appraisal half, end to end through the engine: the
 * module gate, the permission area, the red line and its area, the facts, a
 * proposal, its evaluation and staleness, fee quotes gated on a two-person
 * publication of the schedule, and the costs with liabilities kept apart.
 */

let platform: Platform;
let seed: SeedResult;

const as = (who: string): EngineContext => platform.context(seed.users[who]!.auth, seed.projectId, { source: 'WEB' });
const refused = (fn: () => unknown, code: string) =>
  assert.throws(fn, (error: { code?: string }) => error.code === code, `expected ${code}`);

/** A rectangle in metres at a latitude, from the ellipsoid's radii of curvature. */
function rectangle(lat: number, lon: number, widthM: number, heightM: number): number[][] {
  const a = 6378137;
  const f = 1 / 298.257223563;
  const e2 = f * (2 - f);
  const phi = (lat * Math.PI) / 180;
  const w = 1 - e2 * Math.sin(phi) ** 2;
  const dLat = (heightM / ((a * (1 - e2)) / w ** 1.5)) * (180 / Math.PI);
  const dLon = (widthM / ((a / Math.sqrt(w)) * Math.cos(phi))) * (180 / Math.PI);
  return [[lon, lat], [lon + dLon, lat], [lon + dLon, lat + dLat], [lon, lat + dLat], [lon, lat]];
}

const THREE_HECTARES = { type: 'Polygon', coordinates: [rectangle(52.2, -1.5, 300, 100)] };

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

describe('the module and the permission area', () => {
  it('is refused to a company that has not been granted Planning', () => {
    refused(() => planning.planningOverview(as('owner')), 'MODULE_NOT_GRANTED');
  });

  it('opens once the operator grants it, and still checks the permission area', () => {
    platform.setModuleGrant({
      moduleId: 'PLANNING',
      tenantId: seed.tenantId,
      status: 'ACTIVE',
      reason: 'Planning released after the rule pack review',
      decidedBy: seed.users.operator!.id,
    });
    const overview = planning.planningOverview(as('owner'));
    assert.equal(overview.siteRevisions, 0);
    assert.equal(overview.rules.length, 3);
    assert.ok(overview.rules.every((rule) => rule.status === 'UNPUBLISHED'));
    // The site manager holds nothing on PLANNING_CONSENT.
    refused(() => planning.planningOverview(as('siteManager')), 'ACCESS_DENIED');
    // The programme planner reads but does not author.
    planning.planningOverview(as('planner'));
    refused(() => planning.recordSiteVersion(as('planner'), { geometry: THREE_HECTARES, authority: { name: 'Example DC', confirmed: false }, boundarySource: 'Title plan' }), 'ACCESS_DENIED');
  });
});

describe('the red line, the facts and a proposal', () => {
  let siteId: string;
  let proposalId: string;

  it('records a red line, measures it, and holds the confirmed area apart', () => {
    refused(() => planning.recordSiteVersion(as('pm'), { geometry: { type: 'Point', coordinates: [0, 0] }, authority: { name: 'Example DC', confirmed: false }, boundarySource: 'Title plan' }), 'SITE_GEOMETRY_INVALID');
    refused(() => planning.recordSiteVersion(as('pm'), { geometry: THREE_HECTARES, authority: { name: 'Example DC', confirmed: true }, boundarySource: 'Title plan' }), 'AUTHORITY_SOURCE_REQUIRED');
    const site = planning.recordSiteVersion(as('pm'), {
      geometry: THREE_HECTARES,
      confirmedAreaM2: 30_000,
      authority: { name: 'Example District Council', confirmed: true, source: 'Planning Data API boundary check, 20 Nov 2026' },
      boundarySource: 'Title plan WK123456 and topographical survey rev B',
    });
    assert.ok(Math.abs(site.calculatedAreaM2! - 30_000) < 3);
    assert.equal(site.confirmedAreaM2, 30_000);
    assert.equal(site.divergence.material, false);
    assert.equal(site.revision, 1);
    siteId = site.id;
  });

  it('records a site by its stated area alone, any size, and refuses one with neither area nor boundary', () => {
    refused(() => planning.recordSiteVersion(as('pm'), { authority: { name: 'Example DC', confirmed: false }, boundarySource: 'Agent particulars' }), 'SITE_AREA_REQUIRED');
    const stated = planning.recordSiteVersion(as('pm'), { confirmedAreaM2: 7_250, authority: { name: 'Example DC', confirmed: false }, boundarySource: 'Agent particulars, 0.725 ha' });
    assert.equal(stated.calculatedAreaM2, null);
    assert.equal(stated.geometry, undefined);
    assert.equal(stated.divergence.material, false);
    // The drawn revision is recorded again so the rest of this file reads the 3 ha site.
    siteId = planning.recordSiteVersion(as('pm'), {
      geometry: THREE_HECTARES,
      confirmedAreaM2: 30_000,
      authority: { name: 'Example District Council', confirmed: true, source: 'Planning Data API boundary check, 20 Nov 2026' },
      boundarySource: 'Title plan WK123456 and topographical survey rev B',
    }).id;
  });

  it('accepts the latest revision only, once', () => {
    planning.acceptSiteVersion(as('pm'), { siteVersionId: siteId, note: 'Checked against the title plan' });
    refused(() => planning.acceptSiteVersion(as('pm'), { siteVersionId: siteId, note: 'again' }), 'SITE_VERSION_ACCEPTED');
  });

  it('records facts only from the closed list, each with its source', () => {
    refused(() => planning.recordSiteFact(as('pm'), { key: 'FLOOD_ZONE', value: '4', source: 'Flood map' }), 'SITE_FACT_VALUE');
    refused(() => planning.recordSiteFact(as('pm'), { key: 'MOON_PHASE', value: '1', source: 'Almanac' }), 'SITE_FACT_UNKNOWN');
  });

  it('evaluates the worked project and pins what it read', () => {
    refused(() => planning.recordProposal(as('pm'), { siteVersionId: siteId, scenarioName: 'Full, 40 homes', route: 'full', use: 'HOUSING', dwellingCount: 0, createdGiaM2: 3600 }), 'PROPOSAL_DWELLINGS');
    proposalId = planning.recordProposal(as('pm'), { siteVersionId: siteId, scenarioName: 'Full, 40 homes', route: 'full', use: 'HOUSING', dwellingCount: 40, createdGiaM2: 3600, assumptions: ['Two-storey houses'] }).id;
    const evaluation = planning.evaluateProposal(as('pm'), { proposalId });
    assert.equal(evaluation.major, 'MAJOR');
    assert.equal(evaluation.inputs.areaBasis, 'CONFIRMED');
    assert.equal(evaluation.rulePackPublished, false);
    const fra = evaluation.findings.find((finding) => finding.code === 'FRA')!;
    assert.equal(fra.status, 'review_required');
    assert.deepEqual(planning.evaluationStaleness(as('pm'), evaluation), []);

    // A fact recorded afterwards makes the evaluation stale, and a new run reads it.
    planning.recordSiteFact(as('pm'), { key: 'FLOOD_ZONE', value: '1', source: 'Flood Map for Planning, 21 Nov 2026' });
    const overview = planning.planningOverview(as('pm'));
    assert.match(overview.scenarios[0]!.stale.join(' '), /Flood zone/);
    assert.ok(overview.blockers.some((blocker) => blocker.code === 'FRA'));
    const again = planning.evaluateProposal(as('pm'), { proposalId });
    assert.equal(again.findings.find((finding) => finding.code === 'FRA')!.status, 'applies');
    assert.deepEqual(planning.planningOverview(as('pm')).scenarios[0]!.stale, []);
  });

  it('marks the evaluation stale when the red line or the proposal changes', () => {
    planning.recordProposal(as('pm'), { siteVersionId: siteId, scenarioName: 'Full, 40 homes', route: 'full', use: 'HOUSING', dwellingCount: 42, createdGiaM2: 3800 });
    const evaluation = planning.evaluations(as('pm')).at(-1)!;
    assert.match(planning.evaluationStaleness(as('pm'), evaluation).join(' '), /newer version/);
    planning.recordSiteVersion(as('pm'), { geometry: THREE_HECTARES, confirmedAreaM2: 32_000, authority: { name: 'Example District Council', confirmed: true, source: 'Boundary check' }, boundarySource: 'Survey rev C' });
    assert.match(planning.evaluationStaleness(as('pm'), evaluation).join(' '), /newer revision \(4\)/);
    // The drawn area is now 6% from the confirmed one: material, raised for review.
    const overview = planning.planningOverview(as('pm'));
    assert.equal(overview.site!.divergence.material, true);
    // The historical evaluation is untouched.
    assert.equal(evaluation.siteVersionId, siteId);
  });
});

describe('fees: published by two people before anything is payable', () => {
  it('shows what an unpublished schedule would come to, with no payable figure', () => {
    const quote = planning.quoteFeeFor(as('pm'), { route: 'full', madeOn: '2026-12-08', dateBasis: 'ASSUMED', dwellings: 40 });
    assert.equal(quote.status, 'REVIEW_REQUIRED');
    assert.equal(quote.amountMinor, null);
    assert.equal(quote.breakdown[0]!.amountMinor, 3_272_000);
  });

  it('needs the preparer and the publisher to be different people', () => {
    refused(() => planning.prepareRuleVersion(as('pm'), { version: 'england-2026-12-08', checkNote: 'too short' }), 'PLANNING_FIELD_REQUIRED');
    refused(() => planning.publishRuleVersion(as('owner'), { version: 'england-2026-12-08', note: 'Reviewed' }), 'RULE_VERSION_NOT_PREPARED');
    planning.prepareRuleVersion(as('owner'), { version: 'england-2026-12-08', checkNote: 'Every figure checked against the 8 December 2026 schedule PDF, page by page' });
    refused(() => planning.publishRuleVersion(as('owner'), { version: 'england-2026-12-08', note: 'Reviewed' }), 'RULE_VERSION_SAME_PERSON');
    // The PM can prepare but holds no approval.
    refused(() => planning.publishRuleVersion(as('pm'), { version: 'england-2026-12-08', note: 'Reviewed' }), 'ACCESS_DENIED');
    planning.returnRuleVersion(as('owner'), { version: 'england-2026-12-08', reason: 'Prepared and approved by the same person' });
    planning.prepareRuleVersion(as('pm'), { version: 'england-2026-12-08', checkNote: 'Every figure checked against the 8 December 2026 schedule PDF, page by page' });
    planning.publishRuleVersion(as('owner'), { version: 'england-2026-12-08', note: 'Second check of the upper bands and caps' });
    assert.equal(planning.ruleVersions(as('pm')).find((rule) => rule.version === 'england-2026-12-08')!.status, 'PUBLISHED');
  });

  it('then quotes a payable figure, as an append-only snapshot', () => {
    const before = planning.feeQuotes(as('pm')).length;
    const quote = planning.quoteFeeFor(as('pm'), { route: 'full', madeOn: '2026-12-08', dateBasis: 'ASSUMED', dwellings: 40 });
    assert.equal(quote.status, 'CALCULATED');
    assert.equal(quote.amountMinor, 3_272_000);
    assert.equal(quote.ruleVersion, 'england-2026-12-08');
    assert.ok(quote.scheduleHash);
    // The April schedule is not published, so a 7 December quote is not payable.
    assert.equal(planning.quoteFeeFor(as('pm'), { route: 'full', madeOn: '2026-12-07', dateBasis: 'EVIDENCED', dwellings: 40 }).amountMinor, null);
    assert.equal(planning.feeQuotes(as('pm')).length, before + 2);
  });

  it('uses only an accepted red line for an outline fee, and raises a material area difference', () => {
    // Revision 2 is not accepted.
    const quote = planning.quoteFeeFor(as('pm'), { route: 'outline', madeOn: '2026-12-08', dateBasis: 'ASSUMED' });
    assert.equal(quote.amountMinor, null);
    assert.match(quote.reviewReasons.join(' '), /not been accepted/);
    const latest = planning.siteVersions(as('pm')).at(-1)!;
    planning.acceptSiteVersion(as('pm'), { siteVersionId: latest.id, note: 'Survey rev C' });
    const after = planning.quoteFeeFor(as('pm'), { route: 'outline', madeOn: '2026-12-08', dateBasis: 'ASSUMED' });
    assert.equal(after.amountMinor, null);
    assert.match(after.reviewReasons.join(' '), /% from the confirmed/);
  });

  it('refuses a made date that is not a date', () => {
    refused(() => planning.quoteFeeFor(as('pm'), { route: 'full', madeOn: '08/12/2026', dateBasis: 'ASSUMED', dwellings: 4 }), 'FEE_INPUT_INVALID');
  });
});

describe('costs: the known subtotal, and the liabilities kept apart', () => {
  it('adds the project’s own allowances and the December fee into one known range', () => {
    // The project's own lines, entered with their source — no example figures.
    planning.recordCostLine(as('pm'), { label: 'Planning and design', costCode: 'PL-01', kind: 'ALLOWANCE', gate: 'G1', source: 'Planning consultant’s fee range, Oct 2026', lowMinor: 1_500_000, highMinor: 3_500_000, vatBasis: 'EXCLUDED', confidence: 'LOW', estimateDate: '2026-11-22', cashTrigger: 'Appointment and stage payments' });
    planning.recordCostLine(as('pm'), { label: 'Ecology and BNG design', costCode: 'PL-03', kind: 'ALLOWANCE', gate: 'G1', source: 'Ecologist’s budget range, Oct 2026', lowMinor: 500_000, highMinor: 2_000_000, vatBasis: 'EXCLUDED', confidence: 'LOW', estimateDate: '2026-11-22', cashTrigger: 'Commission, by survey window' });
    const quote = planning.feeQuotes(as('pm')).find((entry) => entry.status === 'CALCULATED')!;
    planning.recordCostLine(as('pm'), { label: 'Full planning fee', costCode: 'PL-10', gate: 'G2', vatBasis: 'NOT_APPLICABLE', confidence: 'HIGH', estimateDate: '2026-11-22', cashTrigger: 'On submission', feeQuoteId: quote.id });
    refused(
      () => planning.recordCostLine(as('pm'), { label: 'Again', costCode: 'PL-10', gate: 'G2', vatBasis: 'NOT_APPLICABLE', confidence: 'HIGH', estimateDate: '2026-11-22', cashTrigger: 'On submission', feeQuoteId: quote.id }),
      'FEE_QUOTE_ALREADY_COSTED',
    );
    const summary = planning.costSummary(as('pm'));
    assert.equal(summary.known.lowMinor, 5_272_000);
    assert.equal(summary.known.highMinor, 8_772_000);
    assert.equal(summary.known.baseMinor, null, 'the allowances give a range, not a base');
    assert.equal(summary.known.baseMissing, 2);
    assert.ok(summary.unresolved.some((entry) => /CIL: liability unknown/.test(entry)));
  });

  it('needs a source on any line not made from a fee quote, and the route lets a quote line carry its own', () => {
    refused(
      () => planning.recordCostLine(as('pm'), { label: 'Transport assessment', costCode: 'PL-05', kind: 'ALLOWANCE', gate: 'G1', lowMinor: 800_000, highMinor: 1_500_000, vatBasis: 'EXCLUDED', confidence: 'LOW', estimateDate: '2026-11-22', cashTrigger: 'On commission' }),
      'PLANNING_FIELD_REQUIRED',
    );
    const route = ROUTES.find((entry) => entry.method === 'POST' && entry.pattern === '/v1/projects/:projectId/planning/costs')!;
    assert.ok(!((route.schema as { required: string[] }).required.includes('source')));
  });

  it('keeps a liability out of the cash total, and an unknown amount unknown', () => {
    planning.recordCostLine(as('pm'), { label: 'Section 106 contributions', costCode: 'PL-20', kind: 'LIABILITY', gate: 'G3', source: 'Heads of terms not yet issued', lowMinor: null, baseMinor: null, highMinor: null, vatBasis: 'NOT_APPLICABLE', confidence: 'LOW', estimateDate: '2026-11-22', cashTrigger: 'Per the agreement’s triggers' });
    const summary = planning.costSummary(as('pm'));
    assert.equal(summary.known.lowMinor, 5_272_000, 'unchanged');
    assert.equal(summary.liabilities.length, 1);
    assert.equal(summary.liabilities[0]!.lowMinor, null);
    assert.ok(!summary.unresolved.some((entry) => /Section 106/.test(entry)));
  });

  it('revises a line as a new version, refuses a stale one, and will not rewrite a fee line’s figure', () => {
    const line = planning.costLines(as('pm')).find((entry) => entry.label === 'Ecology and BNG design')!;
    refused(() => planning.reviseCostLine(as('pm'), line.id, { lowMinor: 4_000_000 }), 'COST_ORDER');
    planning.reviseCostLine(as('pm'), line.id, { lowMinor: 400_000, source: 'Quote from Example Ecology Ltd, 21 Nov 2026', confidence: 'MEDIUM' });
    const stale = { ...as('pm'), expectedVersion: line.version };
    refused(() => planning.reviseCostLine(stale, line.id, { lowMinor: 300_000 }), 'VERSION_CONFLICT');
    const fee = planning.costLines(as('pm')).find((entry) => entry.kind === 'STATUTORY_FEE')!;
    refused(() => planning.reviseCostLine(as('pm'), fee.id, { lowMinor: 1 }), 'COST_LINE_FROM_QUOTE');
    // Commitments and actuals feed the outturn: actual + committed-unpaid + uncommitted base.
    const design = planning.costLines(as('pm')).find((entry) => entry.label === 'Planning and design')!;
    refused(() => planning.reviseCostLine(as('pm'), design.id, { committedMinor: 2_000_000 }), 'COST_COMMITMENT_REF');
    planning.reviseCostLine(as('pm'), design.id, { baseMinor: 2_500_000, committedMinor: 2_200_000, actualMinor: 500_000, commitmentRef: 'PO-1042' });
    const outturn = planning.costSummary(as('pm')).outturn;
    assert.equal(outturn.actualMinor, 500_000);
    assert.equal(outturn.committedMinor, 1_700_000);
    // The fee line (base £32,720) is uncommitted; the allowance without a base cannot be forecast.
    assert.equal(outturn.uncommittedMinor, 3_272_000);
    assert.equal(outturn.minor, 500_000 + 1_700_000 + 3_272_000);
    assert.equal(outturn.unforecast, 1);
    planning.reviseCostLine(as('pm'), line.id, { withdraw: { reason: 'Ecology now in the consultant appointment' } });
    assert.equal(planning.costSummary(as('pm')).known.lowMinor, 5_272_000 - 500_000);
  });
});

describe('the planning watch', () => {
  const watch = async () => planningWatchAgent.evaluate!(as('pm'));

  it('reports the area discrepancy and the unevaluated version, each with the record it read', async () => {
    const output = await watch();
    const keys = output.findings.map((finding) => finding.key);
    assert.ok(keys.some((key) => key.startsWith('planning:area:')), keys.join(', '));
    // The latest version (42 homes) was never evaluated; the evaluation of v1 is superseded, not stale.
    assert.ok(keys.some((key) => key.startsWith('planning:unevaluated:')), keys.join(', '));
    assert.ok(!keys.some((key) => key.startsWith('planning:stale:')), keys.join(', '));
    assert.ok(output.findings.every((finding) => finding.evidence.length > 0));
    assert.deepEqual(output.proposals, []);
    assert.equal(planningWatchAgent.mandate.maxUnattended, 'OBSERVE');
  });

  it('reports a current evaluation going stale when a site fact changes', async () => {
    // A version on the current red line, evaluated: nothing stale.
    const site = planning.siteVersions(as('pm')).at(-1)!;
    const current = planning.recordProposal(as('pm'), { siteVersionId: site.id, scenarioName: 'Full, 40 homes', route: 'full', use: 'HOUSING', dwellingCount: 42, createdGiaM2: 3800 });
    planning.evaluateProposal(as('pm'), { proposalId: current.id });
    assert.ok(!(await watch()).findings.some((finding) => finding.key.startsWith('planning:stale:') || finding.key.startsWith('planning:unevaluated:')));
    planning.recordSiteFact(as('pm'), { key: 'HRA_SCREENING', value: 'NO_LIKELY_SIGNIFICANT_EFFECT', source: 'HRA screening report, 20 Nov 2026' });
    const stale = (await watch()).findings.find((finding) => finding.key.startsWith('planning:stale:'))!;
    assert.match(stale.summary, /Habitats Regulations screening/);
  });
});

describe('the routes', () => {
  it('publishes every planning command and read', () => {
    const paths = new Set(ROUTES.filter((route) => route.pattern.includes('/planning')).map((route) => `${route.method} ${route.pattern}`));
    for (const path of [
      'GET /v1/projects/:projectId/planning',
      'POST /v1/projects/:projectId/planning/site-versions',
      'POST /v1/projects/:projectId/planning/site-versions/:siteVersionId/accept',
      'POST /v1/projects/:projectId/planning/facts',
      'POST /v1/projects/:projectId/planning/proposals',
      'POST /v1/projects/:projectId/planning/evaluations',
      'POST /v1/projects/:projectId/planning/fee-quotes',
      'POST /v1/projects/:projectId/planning/costs',
      'PATCH /v1/projects/:projectId/planning/costs/:costLineId',
      'POST /v1/projects/:projectId/planning/applications/:applicationId/budget',
      'POST /v1/projects/:projectId/planning/rule-versions/:version/prepare',
      'POST /v1/projects/:projectId/planning/rule-versions/:version/publish',
      'POST /v1/projects/:projectId/planning/rule-versions/:version/return',
    ]) {
      assert.ok(paths.has(path), path);
    }
  });
});
