import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createGateway } from '../src/api/gateway.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import * as structure from '../src/domain/structure.ts';
import * as safety from '../src/engines/safety.ts';

/**
 * The whole concept stage, driven through the real HTTP gateway with the exact
 * request bodies the console's new commands send.
 *
 * Every concept engine was complete and unit-tested, but the console offered
 * only the seven *create* commands — so a project could be configured and have
 * requirements, surveys and options added, and then dead-end: there was no
 * affordance to baseline the brief, assess a constraint, score or select an
 * option, open or approve the cost plan, choose a strategy, screen compliance
 * or approve the risk review. "Freeze concept baseline" therefore refused with
 * GATE_NOT_MET for ever, because the steps that satisfy the 6.4 gate had no
 * door.
 *
 * This posts the exact body each new `concept.js` command produces, in the
 * order a person drives the stage, and proves the 6.4 gate actually opens: the
 * final freeze SUCCEEDS, which it could not before the commands existed. It is
 * the gate opening that is the proof, not the buttons rendering.
 *
 * `structure.createProject` and `safety.registerRisk` are called directly:
 * creating a project is an enterprise-governance act with no concept screen,
 * and the risk register is a cross-cutting register the concept screen reads
 * but does not own. Everything the concept vertical is responsible for goes
 * over HTTP.
 */

type Who = 'admin' | 'owner' | 'pm' | 'qs' | 'planner' | 'safety';

let platform: Platform;
let seed: SeedResult;
let server: Server;
let base: string;
let projectId: string;

const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

const tokenFor = (who: Who): string => {
  const auth = seed.users[who]!.auth;
  return issueTokens({
    actorId: auth.actorId,
    tenantId: auth.tenantId,
    enterpriseId: auth.enterpriseId,
    roles: auth.roles,
    mfaSatisfied: true,
  }).accessToken;
};

async function call(
  method: string,
  path: string,
  who: Who,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${tokenFor(who)}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

/** A write that must have been accepted; returns the response body. */
async function post(path: string, who: Who, body: unknown): Promise<Record<string, unknown>> {
  const { status, json } = await call('POST', `/v1/projects/${projectId}${path}`, who, body);
  assert.ok(status >= 200 && status < 300, `POST ${path} as ${who} → ${status}: ${JSON.stringify(json)}`);
  return json;
}

const get = async (path: string, who: Who): Promise<Record<string, unknown>> => {
  const { status, json } = await call('GET', `/v1/projects/${projectId}${path}`, who);
  assert.ok(status >= 200 && status < 300, `GET ${path} as ${who} → ${status}: ${JSON.stringify(json)}`);
  return json;
};

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);

  const portfolio = platform.ledger.entitiesOfType('Portfolio')[0];
  assert.ok(portfolio, 'the seed produced no portfolio to hang a project on');

  // Creating a project is an enterprise-governance act — the seed and the test
  // helpers build projects this way, through the governance scope.
  const gov = platform.context(seed.users.admin!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
  const created = structure.createProject(gov, {
    portfolioId: portfolio.refId,
    name: 'Concept Journey Works',
    sectorType: 'UTILITIES',
    assetType: 'Pumping station',
    location: { continentCode: 'EU', countryCode: 'GB', city: 'Leeds' },
    contractValueMinor: 240_000_000,
    currency: 'GBP',
    plannedStart: iso(30),
    plannedCompletion: iso(900),
  });
  projectId = created.projectId;
  assert.equal(created.phase, 'CONCEPT', 'a fresh project must start at CONCEPT');

  server = createGateway(platform);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.close();
});

describe('the concept vertical completes through the gateway', () => {
  it('drives the stage to a freezable 6.4 baseline with the console command bodies', async () => {
    const ownerId = seed.users.owner!.id;
    const pmId = seed.users.pm!.id;

    // C-WF-01 — configuration (the `configuration` command, after its transform
    // folds the time zone into the calendar object).
    await post('/concept/configuration', 'admin', {
      projectCode: 'CJW-01',
      jurisdiction: 'GB',
      jurisdictionPack: 'GB-2026.1',
      classificationPack: 'UNICLASS-2015',
      contractCalendarPack: 'NEC4-2017',
      calendar: { timeZone: 'Europe/London', workingDays: [1, 2, 3, 4, 5], holidays: [] },
      reportingCurrency: 'GBP',
      measurementSystem: 'METRIC',
      sponsorId: ownerId,
      projectDirectorId: pmId,
      dataResidency: 'UK',
      retentionYears: 12,
      defaultSensitivity: 'INTERNAL',
      reason: 'Project set up',
    });

    // C-WF-01 — authority matrix (`authority-matrix`).
    await post('/concept/authority-matrix', 'owner', {
      delegations: [
        { decision: 'Approve the concept baseline', holderId: ownerId },
        { decision: 'Commit expenditure', holderId: pmId, limitMinor: 5_000_000, escalatesToId: ownerId },
      ],
    });

    // C-WF-02 — two requirements (`requirement`), accepted (per-row accept) and
    // baselined (`baseline-brief`).
    const reqA = await post('/concept/requirements', 'admin', {
      reference: 'REQ-001',
      category: 'FUNCTIONAL',
      statement: 'REQ-001 — the works shall deliver the stated capacity',
      source: 'Business case v2',
      sourceAnchor: 'p14',
      ownerId: pmId,
      priority: 'MANDATORY',
      acceptanceCriteria: 'Measured throughput at or above the stated figure for four hours',
      origin: 'HUMAN',
      verification: { method: 'Witnessed performance test', stage: 'COMMISSIONING' },
    });
    const reqB = await post('/concept/requirements', 'admin', {
      reference: 'REQ-002',
      category: 'SAFETY',
      statement: 'REQ-002 — the works shall deliver the stated capacity',
      source: 'Business case v2',
      sourceAnchor: 'p14',
      ownerId: pmId,
      priority: 'HIGH',
      acceptanceCriteria: 'Measured throughput at or above the stated figure for four hours',
      origin: 'HUMAN',
      verification: { method: 'Witnessed performance test', stage: 'COMMISSIONING' },
    });
    await post(`/concept/requirements/${String(reqA.requirementId)}/accept`, 'owner', {});
    await post(`/concept/requirements/${String(reqB.requirementId)}/accept`, 'owner', {});
    await post('/concept/brief/baseline', 'admin', { evidenceHash: 'a'.repeat(64) });

    // C-WF-03 — survey (`survey`), constraint (`constraint`), assess
    // (`assess-constraint`) and review (`review-diligence`).
    const survey = await post('/concept/surveys', 'admin', {
      reference: 'GI-01',
      discipline: 'Geotechnical',
      author: 'Northern Ground Ltd',
      surveyedOn: iso(-40),
      coverage: ['GROUND'],
      coordinateSystem: 'EPSG:27700',
      limitations: 'No access to the eastern boundary; four boreholes only',
      evidenceHash: 'b'.repeat(64),
    });
    const constraint = await post('/concept/constraints', 'admin', {
      reference: 'CON-01',
      description: 'Made ground to 4m across the northern half',
      constraintClass: 'HARD',
      severity: 'CRITICAL',
      impacts: ['GROUND'],
      spatialScope: 'Northern half of the site',
      surveyId: String(survey.surveyId),
      ownerId: pmId,
    });
    await post(`/concept/constraints/${String(constraint.constraintId)}/assess`, 'owner', {
      assessment: 'Piled foundations assumed throughout; priced in the substructure line',
    });
    await post('/concept/due-diligence/review', 'owner', { note: 'Coverage sufficient for concept' });

    // C-WF-04 — two options (`option`), scored (`analyse-option`), one selected
    // (`select-option`) and one rejected (`reject-option`). Separation of
    // duties is live: the owner selects, the admin baselined the brief.
    const scores = [
      { criterion: 'CAPITAL_COST', rawValue: 7, weight: 0.4, basis: 'Benchmark from three comparable schemes' },
      { criterion: 'OPERABILITY', rawValue: 8, weight: 0.35, basis: "Operator's written assessment" },
      { criterion: 'CARBON', rawValue: 6, weight: 0.25, basis: 'PAS 2080 desktop estimate' },
    ];
    const optA = await post('/concept/options', 'admin', {
      reference: 'OPT-A',
      name: 'Refurbish in place',
      description: 'Retain the existing structure',
      scopeStatement: 'Existing structure retained; process plant replaced',
      assumptions: ['Structure is serviceable'],
      exclusions: ['Site-wide drainage'],
      baseDate: iso(0),
      currency: 'GBP',
      orderOfCostMinor: 180_000_000,
      costLowMinor: 160_000_000,
      costHighMinor: 220_000_000,
      durationDaysLow: 500,
      durationDaysMostLikely: 600,
      durationDaysHigh: 780,
    });
    const optB = await post('/concept/options', 'admin', {
      reference: 'OPT-B',
      name: 'New build',
      description: 'New structure on the northern plot',
      scopeStatement: 'New structure and process plant; existing demolished',
      assumptions: ['Planning consent obtainable'],
      exclusions: ['Site-wide drainage'],
      baseDate: iso(0),
      currency: 'GBP',
      orderOfCostMinor: 240_000_000,
      costLowMinor: 210_000_000,
      costHighMinor: 300_000_000,
      durationDaysLow: 620,
      durationDaysMostLikely: 720,
      durationDaysHigh: 900,
    });
    await post(`/concept/options/${String(optA.optionId)}/analyse`, 'pm', { scores });
    await post(`/concept/options/${String(optB.optionId)}/analyse`, 'pm', {
      scores: scores.map((s) => ({ ...s, rawValue: s.rawValue - 2 })),
    });
    await post(`/concept/options/${String(optA.optionId)}/select`, 'owner', {
      rationale: 'Lower capital cost and shorter programme against the same criteria',
      evidenceHash: 'c'.repeat(64),
    });
    await post(`/concept/options/${String(optB.optionId)}/reject`, 'owner', {
      rationale: 'Higher cost with no operability benefit the operator would pay for',
    });

    // C-WF-05 — cost plan (`cost-plan`), two lines (`costline`), programme
    // (`programme`), cashflow (`cashflow`) and one approval (`approve-controls`).
    await post('/concept/cost-plan', 'qs', { baseDate: iso(0) });
    await post('/concept/cost-plan/lines', 'qs', {
      wbsCode: '1.1',
      category: 'SUBSTRUCTURE',
      description: 'Piled foundations',
      quantity: 400,
      unit: 'nr',
      rateMinor: 150_000,
      rateSource: 'SPONS 2026',
      rateBaseDate: iso(0),
      lowMinor: 54_000_000,
      highMinor: 72_000_000,
    });
    await post('/concept/cost-plan/lines', 'qs', {
      wbsCode: '9.1',
      category: 'RISK_ALLOWANCE',
      description: 'Quantified risk allowance',
      quantity: 1,
      unit: 'sum',
      rateMinor: 12_000_000,
      rateSource: 'Risk register, expected value',
      rateBaseDate: iso(0),
      lowMinor: 8_000_000,
      highMinor: 20_000_000,
    });
    const milestones = [
      { reference: 'M-START', name: 'Concept approved', plannedDate: iso(10), openStartReason: 'Project start' },
      { reference: 'M-GW2', name: 'Gateway 2 submission', plannedDate: iso(200), predecessors: ['M-START'], statutory: true },
      { reference: 'M-SITE', name: 'Structure required on site', plannedDate: iso(560), predecessors: ['M-GW2'] },
      {
        reference: 'M-END',
        name: 'Practical completion',
        plannedDate: iso(880),
        predecessors: ['M-SITE'],
        openFinishReason: 'End of the concept programme',
      },
    ];
    await post('/concept/programme', 'planner', { dataDate: iso(0), milestones });

    // The cashflow must reconcile to the cost plan total, which the controls
    // read reports — the same figure the console shows beside the button.
    const controls = await get('/concept/controls', 'qs');
    const total = Number((controls.totals as Record<string, unknown>).totalMinor);
    const firstHalf = Math.floor(total / 2);
    await post('/concept/cashflow', 'qs', {
      periods: [
        { period: '2026-Q1', spendMinor: firstHalf, fundingMinor: firstHalf },
        { period: '2026-Q2', spendMinor: total - firstHalf },
      ],
    });
    await post('/concept/controls/approve', 'admin', { cutOffDate: iso(0), evidenceHash: 'd'.repeat(64) });

    // C-WF-06 — procurement (`procurement-strategy`), packages
    // (`package-strategy`) and contract form (`contract-strategy`).
    await post('/concept/procurement-strategy', 'pm', {
      weights: { SCOPE_CERTAINTY: 0.3, TIME: 0.3, PRICE_CERTAINTY: 0.4 },
      assessments: [
        { route: 'TRADITIONAL', scores: { SCOPE_CERTAINTY: 8, TIME: 5, PRICE_CERTAINTY: 7 }, note: 'Design complete first' },
        { route: 'DESIGN_AND_BUILD', scores: { SCOPE_CERTAINTY: 5, TIME: 8, PRICE_CERTAINTY: 8 }, note: 'Faster, less control' },
      ],
      selectedRoute: 'DESIGN_AND_BUILD',
      rationale: 'Programme is the binding constraint and the scope is well understood',
      designResponsibility: 'Contractor, to employer requirements',
      riskAppetite: 'Low on time, moderate on cost',
    });
    await post('/concept/package-strategy', 'pm', {
      worksScopeElements: ['CIVILS', 'MECHANICAL', 'ELECTRICAL'],
      packages: [
        {
          reference: 'PKG-CIV',
          name: 'Civils',
          scopeElements: ['CIVILS'],
          interfaces: ['Hands over slab to MECHANICAL'],
          ownerId: pmId,
          requiredOnSiteMilestoneRef: 'M-SITE',
          enquiryDate: iso(60),
          awardDate: iso(140),
          leadTimeWeeks: 20,
        },
        {
          reference: 'PKG-MEP',
          name: 'Mechanical and electrical',
          scopeElements: ['MECHANICAL', 'ELECTRICAL'],
          interfaces: ['Takes slab from CIVILS'],
          ownerId: pmId,
          requiredOnSiteMilestoneRef: 'M-SITE',
          enquiryDate: iso(60),
          awardDate: iso(150),
          leadTimeWeeks: 40,
        },
      ],
    });
    await post('/concept/contract-strategy', 'owner', {
      contractFamily: 'NEC4',
      contractOption: 'Option C — target contract with activity schedule',
      paymentTerms: 'Monthly assessment, 21 days',
      insuranceRequirements: ['Contract works', 'Public liability GBP 10m'],
      bondsAndGuarantees: ['Performance bond 10%'],
      provisionalNotices: ['Early warning', 'Compensation event'],
    });

    // The risk register is a cross-cutting register the concept screen reads but
    // does not own, so it is populated directly, as the project itself was.
    safety.registerRisk(platform.context(seed.users.pm!.auth, projectId, { source: 'WEB' }), {
      id: 'RSK-01',
      title: 'Ground conditions worse than the four boreholes suggest',
      category: 'GROUND_CONDITIONS',
      probability: 0.3,
      costImpact: { optimistic: 2_000_000, mostLikely: 8_000_000, pessimistic: 30_000_000 },
      scheduleImpactDays: { optimistic: 5, mostLikely: 20, pessimistic: 60 },
      ownerPartyId: pmId,
      projectValueMinor: 240_000_000,
      projectDurationDays: 870,
      mitigations: [
        { description: 'Additional boreholes before design freeze', costMinor: 300_000, probabilityReduction: 0.4, impactReduction: 0.3 },
      ],
    });

    // C-WF-07 — statutory screening (`compliance-screen`) and the risk review
    // (`risk-review`), whose declared allowance reconciles to the RISK_ALLOWANCE
    // line in the cost plan.
    await post('/concept/compliance-screen', 'safety', {
      regimes: [
        { regime: 'CDM_2015', applicable: true, basis: 'Notifiable construction project in Great Britain', milestoneRef: 'M-GW2' },
        { regime: 'COMAH', applicable: false, basis: 'No listed dangerous substances above threshold' },
      ],
      confirmedByName: 'H. Okafor',
      confirmedByRole: 'HSE Manager',
      competenceBasis: 'CMIOSH, fifteen years on notifiable water infrastructure',
      evidenceHash: 'e'.repeat(64),
    });
    await post('/concept/risk-review', 'pm', {
      declaredAllowanceMinor: 12_000_000,
      retainedExposureNote: 'Ground risk retained by the client to the value of the allowance',
      evidenceHash: 'f'.repeat(64),
    });

    // The gate now reads clean: every clause PASSes and nothing failed.
    const gate = await get('/concept/gate', 'admin');
    const clauses = gate.clauses as Array<{ clause: string; state: string }>;
    const failing = clauses.filter((c) => c.state === 'FAIL').map((c) => c.clause);
    assert.deepEqual(failing, [], `the 6.4 gate still has failing clauses: ${failing.join(', ')}`);

    // THE PROOF: the freeze succeeds end to end, which it could not before the
    // commands above had any door. A baseline over a failing gate is refused
    // with GATE_NOT_MET; a baselineId coming back is the gate having opened.
    const frozen = await post('/concept/baseline', 'owner', { evidenceHash: 'g'.repeat(64) });
    assert.ok(frozen.baselineId, `the concept baseline did not freeze: ${JSON.stringify(frozen)}`);
    assert.ok(Number(frozen.components) > 0, 'the baseline froze no components');
  });

  it('refuses a freeze before the spine is driven (the gate is real, not a rubber stamp)', async () => {
    // A second fresh project, configured only. The same freeze command must be
    // refused, which is what makes the success above meaningful.
    const portfolio = platform.ledger.entitiesOfType('Portfolio')[0]!;
    const gov = platform.context(seed.users.admin!.auth, `${seed.tenantId}-governance`, { source: 'WEB' });
    const bare = structure.createProject(gov, {
      portfolioId: portfolio.refId,
      name: 'Concept Journey — ungated',
      sectorType: 'UTILITIES',
      assetType: 'Pumping station',
      location: { continentCode: 'EU', countryCode: 'GB', city: 'York' },
      contractValueMinor: 100_000_000,
      currency: 'GBP',
      plannedStart: iso(30),
      plannedCompletion: iso(600),
    });

    const refused = await call('POST', `/v1/projects/${bare.projectId}/concept/baseline`, 'owner', {
      evidenceHash: 'g'.repeat(64),
    });
    assert.ok(refused.status >= 400, 'an un-driven concept must not freeze a baseline');
    assert.equal(refused.json.title, 'GATE_NOT_MET', `expected GATE_NOT_MET, got ${JSON.stringify(refused.json)}`);
  });
});
