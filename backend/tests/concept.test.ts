import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as conceptbrief from '../src/domain/conceptbrief.ts';
import * as conceptcompliance from '../src/domain/conceptcompliance.ts';
import * as conceptcontrols from '../src/domain/conceptcontrols.ts';
import * as conceptduediligence from '../src/domain/conceptduediligence.ts';
import * as conceptinitiation from '../src/domain/conceptinitiation.ts';
import * as conceptoptions from '../src/domain/conceptoptions.ts';
import * as conceptstrategy from '../src/domain/conceptstrategy.ts';
import * as stagegate from '../src/domain/stagegate.ts';
import * as structure from '../src/domain/structure.ts';
import * as safety from '../src/engines/safety.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Concept, stage 6 — C-WF-01 to C-WF-08 and the 6.4 gate.
 *
 * A fresh project inside the seeded tenancy, because `structure.createProject`
 * puts one in CONCEPT and the demonstration project is in OPERATIONS. Every
 * command runs under a role that actually holds the authority for it, so the
 * permission matrix is exercised rather than bypassed.
 */

let platform: Platform;
let seed: SeedResult;
let projectId: string;

const as = (who: keyof SeedResult['users']) =>
  platform.context(seed.users[who]!.auth, projectId, { source: 'WEB' });

const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

async function freshProject(): Promise<void> {
  platform = new Platform();
  seed = await seedDemoProject(platform);

  const portfolio = platform.ledger.entitiesOfType('Portfolio')[0];
  assert.ok(portfolio, 'the seed produced no portfolio to hang a project on');

  const admin = platform.context(seed.users.admin!.auth, seed.projectId, { source: 'WEB' });
  const created = structure.createProject(admin, {
    portfolioId: portfolio.refId,
    name: 'Concept Test Works',
    sectorType: 'UTILITIES',
    assetType: 'Pumping station',
    location: { continentCode: 'EU', countryCode: 'GB', city: 'Leeds' },
    contractValueMinor: 240_000_000,
    currency: 'GBP',
    plannedStart: iso(30),
    plannedCompletion: iso(900),
  });
  projectId = created.projectId;
  assert.equal(created.phase, 'CONCEPT');
}

// --- the walk ---------------------------------------------------------------
//
// Each step is its own function so a test can stop anywhere and assert what the
// gate says at that point. `walkToGate` runs the lot.

function configure(overrides: Partial<Parameters<typeof conceptinitiation.versionConfiguration>[1]> = {}) {
  return conceptinitiation.versionConfiguration(as('admin'), {
    projectCode: 'CTW-01',
    jurisdiction: 'GB',
    jurisdictionPack: 'GB-2026.1',
    classificationPack: 'UNICLASS-2015',
    contractCalendarPack: 'NEC4-2017',
    calendar: { timeZone: 'Europe/London', workingDays: [1, 2, 3, 4, 5], holidays: [] },
    reportingCurrency: 'GBP',
    measurementSystem: 'METRIC',
    sponsorId: seed.users.owner!.id,
    projectDirectorId: seed.users.pm!.id,
    dataResidency: 'UK',
    retentionYears: 12,
    defaultSensitivity: 'INTERNAL',
    reason: 'Project set up',
    ...overrides,
  });
}

function delegate() {
  return conceptinitiation.approveAuthorityMatrix(as('owner'), {
    delegations: [
      { decision: 'Approve the concept baseline', holderId: seed.users.owner!.id },
      {
        decision: 'Commit expenditure',
        holderId: seed.users.pm!.id,
        limitMinor: 5_000_000,
        escalatesToId: seed.users.owner!.id,
      },
    ],
  });
}

function requirement(reference: string, overrides: Record<string, unknown> = {}) {
  return conceptbrief.extractRequirement(as('admin'), {
    reference,
    category: 'FUNCTIONAL',
    statement: `${reference} — the works shall deliver the stated capacity`,
    source: 'Business case v2',
    sourceAnchor: 'p14',
    ownerId: seed.users.pm!.id,
    priority: 'MANDATORY',
    verification: { method: 'Witnessed performance test', stage: 'COMMISSIONING' },
    acceptanceCriteria: 'Measured throughput at or above the stated figure for four hours',
    origin: 'HUMAN',
    ...overrides,
  } as Parameters<typeof conceptbrief.extractRequirement>[1]);
}

function brief(): void {
  const a = requirement('REQ-001');
  const b = requirement('REQ-002', { category: 'SAFETY', priority: 'HIGH' });
  conceptbrief.acceptRequirement(as('owner'), { requirementId: a.requirementId });
  conceptbrief.acceptRequirement(as('owner'), { requirementId: b.requirementId });
  conceptbrief.baselineBrief(as('admin'), { evidenceHash: 'a'.repeat(64) });
}

function diligence(): { surveyId: string } {
  const survey = conceptduediligence.registerSurvey(as('admin'), {
    reference: 'GI-01',
    discipline: 'Geotechnical',
    author: 'Northern Ground Ltd',
    surveyedOn: iso(-40),
    coverage: [...conceptduediligence.IMPACT_CATEGORY],
    coordinateSystem: 'EPSG:27700',
    limitations: 'No access to the eastern boundary; four boreholes only',
    evidenceHash: 'b'.repeat(64),
  });
  const constraint = conceptduediligence.identifyConstraint(as('admin'), {
    reference: 'CON-01',
    description: 'Made ground to 4m across the northern half',
    constraintClass: 'HARD',
    severity: 'CRITICAL',
    impacts: ['GROUND'],
    spatialScope: 'Northern half of the site',
    surveyId: survey.surveyId,
    ownerId: seed.users.pm!.id,
  });
  conceptduediligence.assessConstraint(as('owner'), {
    constraintId: constraint.constraintId,
    assessment: 'Piled foundations assumed throughout; priced in the substructure line',
  });
  conceptduediligence.reviewDueDiligence(as('owner'), { note: 'Coverage sufficient for concept' });
  return survey;
}

const SCORES = [
  { criterion: 'CAPITAL_COST', rawValue: 7, weight: 0.4, basis: 'Benchmark from three comparable schemes' },
  { criterion: 'OPERABILITY', rawValue: 8, weight: 0.35, basis: "Operator's written assessment" },
  { criterion: 'CARBON', rawValue: 6, weight: 0.25, basis: 'PAS 2080 desktop estimate' },
];

function options(): { chosen: string; rejected: string } {
  const a = conceptoptions.createOption(as('admin'), {
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
  const b = conceptoptions.createOption(as('admin'), {
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
  conceptoptions.analyseOption(as('pm'), { optionId: a.optionId, scores: SCORES });
  conceptoptions.analyseOption(as('pm'), {
    optionId: b.optionId,
    scores: SCORES.map((s) => ({ ...s, rawValue: s.rawValue - 2 })),
  });
  conceptoptions.selectOption(as('owner'), {
    optionId: a.optionId,
    rationale: 'Lower capital cost and shorter programme against the same criteria',
    evidenceHash: 'c'.repeat(64),
  });
  conceptoptions.rejectOption(as('owner'), {
    optionId: b.optionId,
    rationale: 'Higher cost with no operability benefit the operator would pay for',
  });
  return { chosen: a.optionId, rejected: b.optionId };
}

const MILESTONES = [
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

function controls(options: { budgetCapMinor?: number } = {}): void {
  conceptcontrols.createCostPlan(as('qs'), {
    baseDate: iso(0),
    budgetCapMinor: options.budgetCapMinor,
  });
  conceptcontrols.addCostLine(as('qs'), {
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
  conceptcontrols.addCostLine(as('qs'), {
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
  conceptcontrols.createMilestoneProgramme(as('planner'), { dataDate: iso(0), milestones: MILESTONES });

  const total = conceptcontrols.costTotals(conceptcontrols.currentCostPlan(as('qs'))!).totalMinor;
  conceptcontrols.generateCashflow(as('qs'), {
    periods: [
      { period: '2026-Q1', spendMinor: Math.floor(total / 2), fundingMinor: Math.floor(total / 2) },
      { period: '2026-Q2', spendMinor: total - Math.floor(total / 2) },
    ],
  });
  conceptcontrols.approveConceptControls(as('admin'), {
    cutOffDate: iso(0),
    evidenceHash: 'd'.repeat(64),
  });
}

function strategy(): void {
  conceptstrategy.createProcurementStrategy(as('pm'), {
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
  conceptstrategy.approvePackageStrategy(as('pm'), {
    worksScopeElements: ['CIVILS', 'MECHANICAL', 'ELECTRICAL'],
    packages: [
      {
        reference: 'PKG-CIV',
        name: 'Civils',
        scopeElements: ['CIVILS'],
        interfaces: ['Hands over slab to MECHANICAL'],
        ownerId: seed.users.pm!.id,
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
        ownerId: seed.users.pm!.id,
        requiredOnSiteMilestoneRef: 'M-SITE',
        enquiryDate: iso(60),
        awardDate: iso(150),
        leadTimeWeeks: 40,
      },
    ],
  });
  conceptstrategy.selectContractStrategy(as('owner'), {
    contractFamily: 'NEC4',
    contractOption: 'Option C — target contract with activity schedule',
    paymentTerms: 'Monthly assessment, 21 days',
    insuranceRequirements: ['Contract works', 'Public liability GBP 10m'],
    bondsAndGuarantees: ['Performance bond 10%'],
    provisionalNotices: ['Early warning', 'Compensation event'],
  });
}

function risk(): void {
  safety.registerRisk(as('pm'), {
    id: 'RSK-01',
    title: 'Ground conditions worse than the four boreholes suggest',
    category: 'GROUND_CONDITIONS',
    probability: 0.3,
    costImpact: { optimistic: 2_000_000, mostLikely: 8_000_000, pessimistic: 30_000_000 },
    scheduleImpactDays: { optimistic: 5, mostLikely: 20, pessimistic: 60 },
    ownerPartyId: seed.users.pm!.id,
    projectValueMinor: 240_000_000,
    projectDurationDays: 870,
    mitigations: [
      { description: 'Additional boreholes before design freeze', costMinor: 300_000, probabilityReduction: 0.4, impactReduction: 0.3 },
    ],
  });

  conceptcompliance.confirmComplianceApplicability(as('safety'), {
    regimes: [
      {
        regime: 'CDM_2015',
        applicable: true,
        basis: 'Notifiable construction project in Great Britain',
        milestoneRef: 'M-GW2',
      },
      { regime: 'COMAH', applicable: false, basis: 'No listed dangerous substances above threshold' },
    ],
    confirmedByName: 'H. Okafor',
    confirmedByRole: 'HSE Manager',
    competenceBasis: 'CMIOSH, fifteen years on notifiable water infrastructure',
    evidenceHash: 'e'.repeat(64),
  });

  conceptcompliance.approveRiskReview(as('pm'), {
    declaredAllowanceMinor: 12_000_000,
    retainedExposureNote: 'Ground risk retained by the client to the value of the allowance',
    evidenceHash: 'f'.repeat(64),
  });
}

function walkToGate(): void {
  configure();
  delegate();
  brief();
  diligence();
  options();
  controls();
  strategy();
  risk();
}

beforeEach(freshProject);

// ============================================================ C-WF-01

describe('C-WF-01 — project initiation and control configuration', () => {
  it('records the configuration as a version, not an edit', () => {
    const first = configure();
    assert.equal(first.version, 1);

    const second = configure({
      reason: 'Time zone corrected after the client confirmed the operating base',
      impactAssessment: 'No approved output exists yet; nothing downstream is affected',
      calendar: { timeZone: 'Europe/Dublin', workingDays: [1, 2, 3, 4, 5], holidays: [] },
    });
    assert.equal(second.version, 2);

    const position = conceptinitiation.initiationPosition(as('pm'));
    assert.equal(position.configurationVersions, 2);
    assert.equal(position.configuration?.calendar.timeZone, 'Europe/Dublin');
    // Version 1 is still on the record, which is the whole point of versioning
    // rather than editing.
    assert.equal(position.configuration?.supersedes !== undefined, true);
  });

  it('refuses to reconfigure without an impact assessment', () => {
    configure();
    const error = throwsCode(() => configure({ reason: 'Changed my mind' }), 'IMPACT_ASSESSMENT_REQUIRED');
    assert.match(String(error.message), /impact assessment/i);
  });

  it('refuses a time zone the platform cannot resolve', () => {
    throwsCode(
      () => configure({ calendar: { timeZone: 'Europe/Camelot', workingDays: [1, 2, 3], holidays: [] } }),
      'UNKNOWN_TIME_ZONE',
    );
  });

  it('refuses a calendar with no working days, which makes every duration infinite', () => {
    throwsCode(
      () => configure({ calendar: { timeZone: 'Europe/London', workingDays: [], holidays: [] } }),
      'NO_WORKING_DAYS',
    );
  });

  it('refuses a project code another project in the tenancy already holds', async () => {
    configure();

    // A second project in the same tenancy, reaching for the same code.
    const portfolio = platform.ledger.entitiesOfType('Portfolio')[0]!;
    const other = structure.createProject(platform.context(seed.users.admin!.auth, seed.projectId, { source: 'WEB' }), {
      portfolioId: portfolio.refId,
      name: 'Second Works',
      sectorType: 'UTILITIES',
      assetType: 'Pumping station',
      location: { continentCode: 'EU', countryCode: 'GB', city: 'York' },
      contractValueMinor: 100_000_000,
      currency: 'GBP',
      plannedStart: iso(30),
      plannedCompletion: iso(600),
    });

    const otherCtx = platform.context(seed.users.admin!.auth, other.projectId, { source: 'WEB' });
    throwsCode(
      () =>
        conceptinitiation.versionConfiguration(otherCtx, {
          projectCode: 'ctw-01', // case-insensitively the same
          jurisdiction: 'GB',
          jurisdictionPack: 'GB-2026.1',
          classificationPack: 'UNICLASS-2015',
          contractCalendarPack: 'NEC4-2017',
          calendar: { timeZone: 'Europe/London', workingDays: [1, 2, 3, 4, 5], holidays: [] },
          reportingCurrency: 'GBP',
          measurementSystem: 'METRIC',
          sponsorId: seed.users.owner!.id,
          projectDirectorId: seed.users.pm!.id,
          dataResidency: 'UK',
          retentionYears: 12,
          defaultSensitivity: 'INTERNAL',
          reason: 'Set up',
        }),
      'DUPLICATE_PROJECT_CODE',
    );
  });

  it('will not approve an authority matrix before the project is configured', () => {
    throwsCode(() => delegate(), 'NOT_CONFIGURED');
  });

  it('refuses a delegation with a limit and nowhere above it to go', () => {
    configure();
    throwsCode(
      () =>
        conceptinitiation.approveAuthorityMatrix(as('owner'), {
          delegations: [{ decision: 'Commit expenditure', holderId: seed.users.pm!.id, limitMinor: 100 }],
        }),
      'ESCALATION_MISSING',
    );
  });

  it('refuses a delegation that escalates to its own holder', () => {
    configure();
    throwsCode(
      () =>
        conceptinitiation.approveAuthorityMatrix(as('owner'), {
          delegations: [
            {
              decision: 'Commit expenditure',
              holderId: seed.users.pm!.id,
              limitMinor: 100,
              escalatesToId: seed.users.pm!.id,
            },
          ],
        }),
      'ESCALATION_SELF',
    );
  });

  it('flags an authority matrix left behind by a reconfiguration', () => {
    configure();
    delegate();
    assert.equal(conceptinitiation.authorityBlockedReason(as('pm')), null);

    configure({ reason: 'Currency changed', impactAssessment: 'Cost plan to be restated' });
    const reason = conceptinitiation.authorityBlockedReason(as('pm'));
    assert.match(String(reason), /Re-approve it under the current rules/);
  });

  it('blocks baseline work while the project is unconfigured', () => {
    assert.match(String(conceptinitiation.configurationBlockedReason(as('pm'))), /no configuration/);
    configure();
    assert.equal(conceptinitiation.configurationBlockedReason(as('pm')), null);
  });
});

// ============================================================ C-WF-02

describe('C-WF-02 — strategic brief and requirements baseline', () => {
  beforeEach(() => {
    configure();
  });

  it('holds a machine-extracted requirement below the threshold as NEEDS_REVIEW', () => {
    const low = requirement('REQ-AI-1', { origin: 'AI', confidence: 0.4 });
    assert.equal(low.status, 'NEEDS_REVIEW');

    const high = requirement('REQ-AI-2', { origin: 'AI', confidence: 0.9 });
    assert.equal(high.status, 'DRAFT');
  });

  it('will not accept an extracted requirement with no confidence stated', () => {
    throwsCode(() => requirement('REQ-AI-3', { origin: 'AI' }), 'CONFIDENCE_REQUIRED');
  });

  it('keeps an AI requirement visibly unadopted until a person accepts it', () => {
    const created = requirement('REQ-AI-4', { origin: 'AI', confidence: 0.9 });
    assert.equal(conceptbrief.briefPosition(as('pm')).unacceptedAiRequirements, 1);

    conceptbrief.acceptRequirement(as('owner'), { requirementId: created.requirementId });
    assert.equal(conceptbrief.briefPosition(as('pm')).unacceptedAiRequirements, 0);
  });

  it('refuses a requirement with no verification method, however well written', () => {
    throwsCode(
      () => requirement('REQ-X', { verification: { method: '   ', stage: 'DESIGN' } }),
      'VERIFICATION_REQUIRED',
    );
  });

  it('refuses a verification stage that is not a lifecycle stage', () => {
    throwsCode(
      () => requirement('REQ-Y', { verification: { method: 'Test', stage: 'SOMEDAY' } }),
      'INVALID_VERIFICATION_STAGE',
    );
  });

  it('will not baseline while a requirement is neither accepted nor superseded', () => {
    const a = requirement('REQ-001');
    requirement('REQ-002');
    conceptbrief.acceptRequirement(as('owner'), { requirementId: a.requirementId });

    const error = throwsCode(
      () => conceptbrief.baselineBrief(as('admin'), { evidenceHash: 'a'.repeat(64) }),
      'BRIEF_NOT_READY',
    );
    assert.match(String(error.message), /neither accepted nor superseded/);
  });

  it('counts a superseded requirement as resolved, not as outstanding', () => {
    const a = requirement('REQ-001');
    const b = requirement('REQ-002');
    conceptbrief.acceptRequirement(as('owner'), { requirementId: a.requirementId });
    conceptbrief.supersedeRequirement(as('owner'), {
      requirementId: b.requirementId,
      reason: 'Duplicated REQ-001 after the client consolidated the brief',
      replacedByRequirementId: a.requirementId,
    });

    assert.equal(conceptbrief.briefBaselineBlockedReason(as('pm')), null);
  });

  it('refuses to supersede without a reason, which is the only record it was deliberate', () => {
    const a = requirement('REQ-001');
    throwsCode(
      () => conceptbrief.supersedeRequirement(as('owner'), { requirementId: a.requirementId, reason: '  ' }),
      'REASON_REQUIRED',
    );
  });

  it('freezes the hash of every requirement, so a later edit shows as drift', () => {
    const a = requirement('REQ-001');
    conceptbrief.acceptRequirement(as('owner'), { requirementId: a.requirementId });
    const baseline = conceptbrief.baselineBrief(as('admin'), { evidenceHash: 'a'.repeat(64) });
    assert.equal(baseline.requirements, 1);
    assert.deepEqual(conceptbrief.briefDrift(as('pm')), []);

    // Supersede it: the record moves, and the baseline can prove it.
    conceptbrief.supersedeRequirement(as('owner'), {
      requirementId: a.requirementId,
      reason: 'Client withdrew the capacity requirement',
    });
    assert.deepEqual(conceptbrief.briefDrift(as('pm')), [{ reference: 'REQ-001', state: 'DRIFTED' }]);
  });

  it('reports a mandatory conflict without refusing the baseline', () => {
    const a = requirement('REQ-001');
    const b = requirement('REQ-002', { conflictsWith: [] });
    // Declared from one side only; the check reads both.
    const c = requirement('REQ-003', { conflictsWith: [a.requirementId] });
    conceptbrief.acceptRequirement(as('owner'), { requirementId: a.requirementId });
    conceptbrief.acceptRequirement(as('owner'), { requirementId: b.requirementId });
    conceptbrief.acceptRequirement(as('owner'), { requirementId: c.requirementId });

    // The baseline is honest about the conflict rather than hiding it.
    assert.equal(conceptbrief.briefBaselineBlockedReason(as('pm')), null);
    const conflict = conceptbrief.briefConflictReason(as('pm'));
    assert.match(String(conflict), /REQ-001 vs REQ-003/);
  });

  it('does not treat a conflict between non-mandatory requirements as blocking', () => {
    const a = requirement('REQ-001', { priority: 'MEDIUM' });
    const b = requirement('REQ-002', { priority: 'MEDIUM', conflictsWith: [a.requirementId] });
    conceptbrief.acceptRequirement(as('owner'), { requirementId: a.requirementId });
    conceptbrief.acceptRequirement(as('owner'), { requirementId: b.requirementId });
    assert.equal(conceptbrief.briefConflictReason(as('pm')), null);
  });

  it('will not record a requirement before the project is configured', async () => {
    await freshProject();
    throwsCode(() => requirement('REQ-001'), 'NOT_CONFIGURED');
  });
});

// ============================================================ C-WF-03

describe('C-WF-03 — site, asset and constraint due diligence', () => {
  beforeEach(() => {
    configure();
  });

  it('refuses a survey with no coordinate system recorded', () => {
    throwsCode(
      () =>
        conceptduediligence.registerSurvey(as('admin'), {
          reference: 'GI-01',
          discipline: 'Geotechnical',
          author: 'Northern Ground Ltd',
          surveyedOn: iso(-40),
          coverage: ['GROUND'],
          coordinateSystem: '   ',
          limitations: 'None',
          evidenceHash: 'b'.repeat(64),
        }),
      'COORDINATE_SYSTEM_REQUIRED',
    );
  });

  it('accepts NONE as a coordinate system, which is a different fact from an absent one', () => {
    const survey = conceptduediligence.registerSurvey(as('admin'), {
      reference: 'DESK-01',
      discipline: 'Contamination desk study',
      author: 'Envirocheck',
      surveyedOn: iso(-60),
      coverage: ['CONTAMINATION'],
      coordinateSystem: 'NONE',
      limitations: 'Desk study only; no intrusive investigation',
      evidenceHash: 'b'.repeat(64),
    });

    // …and a constraint drawn from it cannot carry geometry.
    throwsCode(
      () =>
        conceptduediligence.identifyConstraint(as('admin'), {
          reference: 'CON-01',
          description: 'Historic filling station forecourt',
          constraintClass: 'SOFT',
          severity: 'MAJOR',
          impacts: ['CONTAMINATION'],
          spatialScope: 'South-west corner',
          geometryRef: 'poly-1',
          surveyId: survey.surveyId,
          ownerId: seed.users.pm!.id,
        }),
      'NO_COORDINATE_SYSTEM',
    );
  });

  it('refuses a survey with no limitations stated', () => {
    throwsCode(
      () =>
        conceptduediligence.registerSurvey(as('admin'), {
          reference: 'GI-02',
          discipline: 'Topographic',
          author: 'Surveyors Ltd',
          surveyedOn: iso(-10),
          coverage: ['ACCESS'],
          coordinateSystem: 'EPSG:27700',
          limitations: '',
          evidenceHash: 'b'.repeat(64),
        }),
      'LIMITATIONS_REQUIRED',
    );
  });

  it('scores readiness on evidence coverage, so registering the same report twice moves nothing', () => {
    const first = conceptduediligence.registerSurvey(as('admin'), {
      reference: 'GI-01',
      discipline: 'Geotechnical',
      author: 'Northern Ground Ltd',
      surveyedOn: iso(-40),
      coverage: ['GROUND', 'CONTAMINATION'],
      coordinateSystem: 'EPSG:27700',
      limitations: 'Four boreholes',
      evidenceHash: 'b'.repeat(64),
    });
    const before = conceptduediligence.dueDiligenceReadiness(as('pm')).percent;

    conceptduediligence.registerSurvey(as('admin'), {
      reference: 'GI-01-COPY',
      discipline: 'Geotechnical',
      author: 'Northern Ground Ltd',
      surveyedOn: iso(-40),
      coverage: ['GROUND', 'CONTAMINATION'],
      coordinateSystem: 'EPSG:27700',
      limitations: 'Four boreholes',
      evidenceHash: 'b'.repeat(64),
    });
    assert.equal(conceptduediligence.dueDiligenceReadiness(as('pm')).percent, before);
    assert.ok(first.surveyId);
  });

  it('stops counting a superseded survey toward coverage while keeping it readable', () => {
    const old = conceptduediligence.registerSurvey(as('admin'), {
      reference: 'ECO-2019',
      discipline: 'Ecology',
      author: 'Habitat Ltd',
      surveyedOn: '2019-06-01',
      coverage: ['ECOLOGY'],
      coordinateSystem: 'EPSG:27700',
      limitations: 'Single season',
      evidenceHash: 'b'.repeat(64),
    });
    assert.equal(conceptduediligence.dueDiligencePosition(as('pm')).liveSurveys, 1);

    const fresh = conceptduediligence.registerSurvey(as('admin'), {
      reference: 'ECO-2026',
      discipline: 'Ecology',
      author: 'Habitat Ltd',
      surveyedOn: iso(-5),
      coverage: ['ECOLOGY'],
      coordinateSystem: 'EPSG:27700',
      limitations: 'Single season',
      evidenceHash: 'b'.repeat(64),
    });
    conceptduediligence.supersedeSurvey(as('admin'), {
      surveyId: old.surveyId,
      replacedBySurveyId: fresh.surveyId,
      reason: 'Seven years old; protected species survey out of date',
    });

    const position = conceptduediligence.dueDiligencePosition(as('pm'));
    assert.equal(position.surveys, 2, 'the old survey was removed rather than superseded');
    assert.equal(position.supersededSurveys, 1);
    assert.equal(position.liveSurveys, 1);
  });

  it('refuses to supersede a survey with an older one', () => {
    const fresh = conceptduediligence.registerSurvey(as('admin'), {
      reference: 'ECO-2026',
      discipline: 'Ecology',
      author: 'Habitat Ltd',
      surveyedOn: iso(-5),
      coverage: ['ECOLOGY'],
      coordinateSystem: 'EPSG:27700',
      limitations: 'Single season',
      evidenceHash: 'b'.repeat(64),
    });
    const old = conceptduediligence.registerSurvey(as('admin'), {
      reference: 'ECO-2019',
      discipline: 'Ecology',
      author: 'Habitat Ltd',
      surveyedOn: '2019-06-01',
      coverage: ['ECOLOGY'],
      coordinateSystem: 'EPSG:27700',
      limitations: 'Single season',
      evidenceHash: 'b'.repeat(64),
    });
    throwsCode(
      () =>
        conceptduediligence.supersedeSurvey(as('admin'), {
          surveyId: fresh.surveyId,
          replacedBySurveyId: old.surveyId,
          reason: 'Wrong way round',
        }),
      'REPLACEMENT_OLDER',
    );
  });

  it('drops an expired survey out of coverage without superseding it', () => {
    conceptduediligence.registerSurvey(as('admin'), {
      reference: 'FLOOD-01',
      discipline: 'Flood risk',
      author: 'Hydro Ltd',
      surveyedOn: iso(-400),
      coverage: ['FLOOD'],
      coordinateSystem: 'EPSG:27700',
      limitations: 'Modelled, not measured',
      validUntil: iso(-10),
      evidenceHash: 'b'.repeat(64),
    });
    const position = conceptduediligence.dueDiligencePosition(as('pm'));
    assert.equal(position.expiredSurveys, 1);
    assert.equal(position.liveSurveys, 0);
    assert.equal(position.readiness.covered.includes('FLOOD'), false);
  });

  it('refuses a constraint with no survey behind it', () => {
    throwsCode(
      () =>
        conceptduediligence.identifyConstraint(as('admin'), {
          reference: 'CON-01',
          description: 'Somebody said the ground is bad',
          constraintClass: 'HARD',
          severity: 'CRITICAL',
          impacts: ['GROUND'],
          spatialScope: 'Everywhere',
          surveyId: 'not-a-survey',
          ownerId: seed.users.pm!.id,
        }),
      'NO_SUCH_SURVEY',
    );
  });

  it('refuses to assess an assumption with neither an allowance nor a named acceptance', () => {
    const survey = conceptduediligence.registerSurvey(as('admin'), {
      reference: 'GI-01',
      discipline: 'Geotechnical',
      author: 'Northern Ground Ltd',
      surveyedOn: iso(-40),
      coverage: ['GROUND'],
      coordinateSystem: 'EPSG:27700',
      limitations: 'Four boreholes',
      evidenceHash: 'b'.repeat(64),
    });
    const constraint = conceptduediligence.identifyConstraint(as('admin'), {
      reference: 'CON-02',
      description: 'Assumed no deep obstructions beyond the boreholes',
      constraintClass: 'ASSUMPTION',
      severity: 'MAJOR',
      impacts: ['GROUND'],
      spatialScope: 'Whole site',
      surveyId: survey.surveyId,
      ownerId: seed.users.pm!.id,
    });

    throwsCode(
      () =>
        conceptduediligence.assessConstraint(as('owner'), {
          constraintId: constraint.constraintId,
          assessment: 'Probably fine',
        }),
      'UNKNOWN_UNPRICED',
    );

    // Either an allowance…
    conceptduediligence.assessConstraint(as('owner'), {
      constraintId: constraint.constraintId,
      assessment: 'Carried as a provisional sum pending further boreholes',
      allowanceMinor: 2_000_000,
    });
    assert.equal(conceptduediligence.dueDiligencePosition(as('pm')).allowanceMinor, 2_000_000);
  });

  it('blocks option recommendation while a critical constraint is unassessed', () => {
    const survey = conceptduediligence.registerSurvey(as('admin'), {
      reference: 'GI-01',
      discipline: 'Geotechnical',
      author: 'Northern Ground Ltd',
      surveyedOn: iso(-40),
      coverage: ['GROUND'],
      coordinateSystem: 'EPSG:27700',
      limitations: 'Four boreholes',
      evidenceHash: 'b'.repeat(64),
    });
    const constraint = conceptduediligence.identifyConstraint(as('admin'), {
      reference: 'CON-01',
      description: 'Made ground to 4m',
      constraintClass: 'HARD',
      severity: 'CRITICAL',
      impacts: ['GROUND'],
      spatialScope: 'Northern half',
      surveyId: survey.surveyId,
      ownerId: seed.users.pm!.id,
    });

    assert.match(String(conceptduediligence.constraintAssessmentBlockedReason(as('pm'))), /CON-01/);
    conceptduediligence.assessConstraint(as('owner'), {
      constraintId: constraint.constraintId,
      assessment: 'Piling assumed throughout',
    });
    assert.equal(conceptduediligence.constraintAssessmentBlockedReason(as('pm')), null);
  });

  it('refuses an investigation that closes nothing', () => {
    throwsCode(
      () =>
        conceptduediligence.assignInvestigation(as('admin'), {
          reference: 'INV-01',
          description: 'Have a look at the site',
          ownerId: seed.users.pm!.id,
          dueDate: iso(30),
        }),
      'TARGET_REQUIRED',
    );
  });

  it('refuses to close an investigation with no finding', () => {
    const action = conceptduediligence.assignInvestigation(as('admin'), {
      reference: 'INV-01',
      description: 'Establish heritage constraints',
      coverageGap: 'HERITAGE',
      ownerId: seed.users.pm!.id,
      dueDate: iso(30),
    });
    throwsCode(
      () =>
        conceptduediligence.closeInvestigation(as('admin'), {
          actionId: action.actionId,
          finding: '  ',
          evidenceHash: 'c'.repeat(64),
        }),
      'FINDING_REQUIRED',
    );
  });

  it('counts an overdue investigation, which is what the gate reads', () => {
    conceptduediligence.assignInvestigation(as('admin'), {
      reference: 'INV-01',
      description: 'Establish heritage constraints',
      coverageGap: 'HERITAGE',
      ownerId: seed.users.pm!.id,
      dueDate: iso(-3),
    });
    assert.equal(conceptduediligence.dueDiligencePosition(as('pm')).investigationsOverdue, 1);
  });

  it('records the readiness figure as it stood at the review, not as it later becomes', () => {
    conceptduediligence.registerSurvey(as('admin'), {
      reference: 'GI-01',
      discipline: 'Geotechnical',
      author: 'Northern Ground Ltd',
      surveyedOn: iso(-40),
      coverage: ['GROUND'],
      coordinateSystem: 'EPSG:27700',
      limitations: 'Four boreholes',
      evidenceHash: 'b'.repeat(64),
    });
    const review = conceptduediligence.reviewDueDiligence(as('owner'), { note: 'Early review' });
    const atReview = review.readinessPercent;

    conceptduediligence.registerSurvey(as('admin'), {
      reference: 'TOPO-01',
      discipline: 'Topographic',
      author: 'Surveyors Ltd',
      surveyedOn: iso(-20),
      coverage: ['ACCESS', 'UTILITIES', 'FLOOD'],
      coordinateSystem: 'EPSG:27700',
      limitations: 'Above ground only',
      evidenceHash: 'b'.repeat(64),
    });

    const position = conceptduediligence.dueDiligencePosition(as('pm'));
    assert.ok(position.readiness.percent > atReview, 'coverage did not increase');
    assert.equal(
      position.lastReview?.readinessPercent,
      atReview,
      'the stored review was rewritten by later evidence',
    );
  });

  it('refuses a review before anything has been surveyed', () => {
    throwsCode(() => conceptduediligence.reviewDueDiligence(as('owner'), { note: 'Nothing yet' }), 'NOTHING_TO_REVIEW');
  });
});

// ============================================================ C-WF-04

describe('C-WF-04 — feasibility options and option selection', () => {
  beforeEach(() => {
    configure();
    brief();
    diligence();
  });

  it('preserves the raw score separately from the weighted total', () => {
    const created = conceptoptions.createOption(as('admin'), {
      reference: 'OPT-A',
      name: 'Refurbish',
      description: 'x',
      scopeStatement: 'Existing structure retained',
      assumptions: ['Structure serviceable'],
      exclusions: [],
      baseDate: iso(0),
      currency: 'GBP',
      orderOfCostMinor: 180_000_000,
      costLowMinor: 160_000_000,
      costHighMinor: 220_000_000,
      durationDaysLow: 500,
      durationDaysMostLikely: 600,
      durationDaysHigh: 780,
    });
    const analysed = conceptoptions.analyseOption(as('pm'), { optionId: created.optionId, scores: SCORES });
    // 7*0.4 + 8*0.35 + 6*0.25 = 7.1
    assert.equal(analysed.weightedScore, 7.1);

    const row = conceptoptions.compareOptions(as('pm')).rows[0];
    assert.equal(row?.scores.find((s) => s.criterion === 'CAPITAL_COST')?.rawValue, 7);
  });

  it('refuses scores whose weights do not sum to one', () => {
    const created = conceptoptions.createOption(as('admin'), {
      reference: 'OPT-A',
      name: 'Refurbish',
      description: 'x',
      scopeStatement: 'Existing structure retained',
      assumptions: ['Structure serviceable'],
      exclusions: [],
      baseDate: iso(0),
      currency: 'GBP',
      orderOfCostMinor: 180_000_000,
      costLowMinor: 160_000_000,
      costHighMinor: 220_000_000,
      durationDaysLow: 500,
      durationDaysMostLikely: 600,
      durationDaysHigh: 780,
    });
    throwsCode(
      () =>
        conceptoptions.analyseOption(as('pm'), {
          optionId: created.optionId,
          scores: SCORES.map((s) => ({ ...s, weight: 0.5 })),
        }),
      'WEIGHTS_UNBALANCED',
    );
  });

  it('refuses a score with no basis behind it', () => {
    const created = conceptoptions.createOption(as('admin'), {
      reference: 'OPT-A',
      name: 'Refurbish',
      description: 'x',
      scopeStatement: 'Existing structure retained',
      assumptions: ['Structure serviceable'],
      exclusions: [],
      baseDate: iso(0),
      currency: 'GBP',
      orderOfCostMinor: 180_000_000,
      costLowMinor: 160_000_000,
      costHighMinor: 220_000_000,
      durationDaysLow: 500,
      durationDaysMostLikely: 600,
      durationDaysHigh: 780,
    });
    throwsCode(
      () =>
        conceptoptions.analyseOption(as('pm'), {
          optionId: created.optionId,
          scores: SCORES.map((s) => ({ ...s, basis: '' })),
        }),
      'BASIS_REQUIRED',
    );
  });

  it('refuses a cost range that does not contain its own point estimate', () => {
    throwsCode(
      () =>
        conceptoptions.createOption(as('admin'), {
          reference: 'OPT-A',
          name: 'Refurbish',
          description: 'x',
          scopeStatement: 'Existing structure retained',
          assumptions: ['a'],
          exclusions: [],
          baseDate: iso(0),
          currency: 'GBP',
          orderOfCostMinor: 180_000_000,
          costLowMinor: 190_000_000,
          costHighMinor: 220_000_000,
          durationDaysLow: 500,
          durationDaysMostLikely: 600,
          durationDaysHigh: 780,
        }),
      'RANGE_EXCLUDES_ESTIMATE',
    );
  });

  it('withholds a comparison across different price base dates rather than inventing an index', () => {
    const a = conceptoptions.createOption(as('admin'), {
      reference: 'OPT-A',
      name: 'Refurbish',
      description: 'x',
      scopeStatement: 'Existing retained',
      assumptions: ['a'],
      exclusions: [],
      baseDate: '2024-01-01',
      currency: 'GBP',
      orderOfCostMinor: 180_000_000,
      costLowMinor: 160_000_000,
      costHighMinor: 220_000_000,
      durationDaysLow: 500,
      durationDaysMostLikely: 600,
      durationDaysHigh: 780,
    });
    const b = conceptoptions.createOption(as('admin'), {
      reference: 'OPT-B',
      name: 'New build',
      description: 'x',
      scopeStatement: 'New structure',
      assumptions: ['a'],
      exclusions: [],
      baseDate: '2026-01-01',
      currency: 'GBP',
      orderOfCostMinor: 240_000_000,
      costLowMinor: 210_000_000,
      costHighMinor: 300_000_000,
      durationDaysLow: 620,
      durationDaysMostLikely: 720,
      durationDaysHigh: 900,
    });
    conceptoptions.analyseOption(as('pm'), { optionId: a.optionId, scores: SCORES });
    conceptoptions.analyseOption(as('pm'), { optionId: b.optionId, scores: SCORES });

    const comparison = conceptoptions.compareOptions(as('pm'));
    assert.equal(comparison.comparable, false);
    assert.match(String(comparison.incomparableReason), /price base dates/);
    // The rows are still returned — the refusal is the verdict, not a blank page.
    assert.equal(comparison.rows.length, 2);
  });

  it('withholds a comparison across different criteria sets', () => {
    const a = conceptoptions.createOption(as('admin'), {
      reference: 'OPT-A',
      name: 'Refurbish',
      description: 'x',
      scopeStatement: 'Existing retained',
      assumptions: ['a'],
      exclusions: [],
      baseDate: iso(0),
      currency: 'GBP',
      orderOfCostMinor: 180_000_000,
      costLowMinor: 160_000_000,
      costHighMinor: 220_000_000,
      durationDaysLow: 500,
      durationDaysMostLikely: 600,
      durationDaysHigh: 780,
    });
    const b = conceptoptions.createOption(as('admin'), {
      reference: 'OPT-B',
      name: 'New build',
      description: 'x',
      scopeStatement: 'New structure',
      assumptions: ['a'],
      exclusions: [],
      baseDate: iso(0),
      currency: 'GBP',
      orderOfCostMinor: 240_000_000,
      costLowMinor: 210_000_000,
      costHighMinor: 300_000_000,
      durationDaysLow: 620,
      durationDaysMostLikely: 720,
      durationDaysHigh: 900,
    });
    conceptoptions.analyseOption(as('pm'), { optionId: a.optionId, scores: SCORES });
    conceptoptions.analyseOption(as('pm'), {
      optionId: b.optionId,
      scores: [{ criterion: 'CAPITAL_COST', rawValue: 5, weight: 1, basis: 'Benchmark' }],
    });

    const comparison = conceptoptions.compareOptions(as('pm'));
    assert.equal(comparison.comparable, false);
    assert.match(String(comparison.incomparableReason), /different criteria/);
  });

  it('reports whether a sensitivity test changes the leader, reproducibly', () => {
    // A crossing pair, which is the only interesting case: OPT-A leads overall
    // on the strength of its capital cost score, and OPT-B is ahead on
    // everything else. An option that dominates on every criterion cannot be
    // flipped by varying one, and a test built on that pair would pass for the
    // wrong reason.
    const shape = {
      description: 'x',
      assumptions: ['a'],
      exclusions: [],
      baseDate: iso(0),
      currency: 'GBP',
      orderOfCostMinor: 180_000_000,
      costLowMinor: 160_000_000,
      costHighMinor: 220_000_000,
      durationDaysLow: 500,
      durationDaysMostLikely: 600,
      durationDaysHigh: 780,
    };
    const a = conceptoptions.createOption(as('admin'), {
      ...shape,
      reference: 'OPT-A',
      name: 'Cheap',
      scopeStatement: 'Existing retained',
    });
    const b = conceptoptions.createOption(as('admin'), {
      ...shape,
      reference: 'OPT-B',
      name: 'Better to run',
      scopeStatement: 'Existing retained',
    });
    conceptoptions.analyseOption(as('pm'), {
      optionId: a.optionId,
      scores: [
        { criterion: 'CAPITAL_COST', rawValue: 9, weight: 0.4, basis: 'Benchmark' },
        { criterion: 'OPERABILITY', rawValue: 5, weight: 0.35, basis: 'Operator assessment' },
        { criterion: 'CARBON', rawValue: 5, weight: 0.25, basis: 'PAS 2080' },
      ],
    });
    conceptoptions.analyseOption(as('pm'), {
      optionId: b.optionId,
      scores: [
        { criterion: 'CAPITAL_COST', rawValue: 2, weight: 0.4, basis: 'Benchmark' },
        { criterion: 'OPERABILITY', rawValue: 8, weight: 0.35, basis: 'Operator assessment' },
        { criterion: 'CARBON', rawValue: 8, weight: 0.25, basis: 'PAS 2080' },
      ],
    });
    // A = 3.6 + 1.75 + 1.25 = 6.6; B = 0.8 + 2.8 + 2.0 = 5.6.
    assert.equal(conceptoptions.compareOptions(as('pm')).leader, 'OPT-A');

    const first = conceptoptions.sensitivity(as('pm'), { criterion: 'CAPITAL_COST', changePercent: -10 });
    const second = conceptoptions.sensitivity(as('pm'), { criterion: 'CAPITAL_COST', changePercent: -10 });
    assert.deepEqual(first, second, 'the same test gave two different answers');
    assert.equal(first.rankChanged, false, 'a 10% move should not flip a one-point lead');

    // Take capital cost out altogether and B wins on the rest, which is the
    // result the review exists to surface.
    const big = conceptoptions.sensitivity(as('pm'), { criterion: 'CAPITAL_COST', changePercent: -100 });
    assert.equal(big.rankChanged, true);
    assert.equal(big.scoresByOption['OPT-B'], 4.8);
  });

  it('links the selected option to the brief baseline hash it was chosen against', () => {
    options();
    const selected = conceptoptions.selectedOption(as('pm')) as unknown as { briefBaselineHash?: string };
    assert.equal(selected.briefBaselineHash, conceptbrief.currentBriefBaseline(as('pm'))?.baselineHash);
  });

  it('refuses a second selected option', () => {
    options();
    // A third option, analysed and undecided — so the status guard passes and
    // the one-selection rule is what actually refuses.
    const c = conceptoptions.createOption(as('admin'), {
      reference: 'OPT-C',
      name: 'Hybrid',
      description: 'x',
      scopeStatement: 'Partial retention',
      assumptions: ['a'],
      exclusions: [],
      baseDate: iso(0),
      currency: 'GBP',
      orderOfCostMinor: 200_000_000,
      costLowMinor: 180_000_000,
      costHighMinor: 250_000_000,
      durationDaysLow: 550,
      durationDaysMostLikely: 650,
      durationDaysHigh: 800,
    });
    conceptoptions.analyseOption(as('pm'), { optionId: c.optionId, scores: SCORES });

    const error = throwsCode(
      () =>
        conceptoptions.selectOption(as('owner'), {
          optionId: c.optionId,
          rationale: 'Changed our minds',
          evidenceHash: 'c'.repeat(64),
        }),
      'OPTION_ALREADY_SELECTED',
    );
    assert.match(String(error.message), /Two selected options is not a decision/);
  });

  it('refuses to select an option that was never analysed', () => {
    const created = conceptoptions.createOption(as('admin'), {
      reference: 'OPT-Z',
      name: 'Unscored',
      description: 'x',
      scopeStatement: 'Existing retained',
      assumptions: ['a'],
      exclusions: [],
      baseDate: iso(0),
      currency: 'GBP',
      orderOfCostMinor: 180_000_000,
      costLowMinor: 160_000_000,
      costHighMinor: 220_000_000,
      durationDaysLow: 500,
      durationDaysMostLikely: 600,
      durationDaysHigh: 780,
    });
    // Nothing is comparable yet, so the composed guard refuses before the
    // status check is reached.
    throwsCode(
      () =>
        conceptoptions.selectOption(as('owner'), {
          optionId: created.optionId,
          rationale: 'It is the only one',
          evidenceHash: 'c'.repeat(64),
        }),
      'SELECTION_BLOCKED',
    );
  });

  it('refuses selection while a critical constraint is unassessed', async () => {
    await freshProject();
    configure();
    brief();

    const survey = conceptduediligence.registerSurvey(as('admin'), {
      reference: 'GI-01',
      discipline: 'Geotechnical',
      author: 'Northern Ground Ltd',
      surveyedOn: iso(-40),
      coverage: ['GROUND'],
      coordinateSystem: 'EPSG:27700',
      limitations: 'Four boreholes',
      evidenceHash: 'b'.repeat(64),
    });
    conceptduediligence.identifyConstraint(as('admin'), {
      reference: 'CON-01',
      description: 'Made ground',
      constraintClass: 'HARD',
      severity: 'CRITICAL',
      impacts: ['GROUND'],
      spatialScope: 'Northern half',
      surveyId: survey.surveyId,
      ownerId: seed.users.pm!.id,
    });

    const error = throwsCode(() => options(), 'SELECTION_BLOCKED');
    assert.match(String(error.message), /critical constraint/);
  });

  it('refuses a rejection with no rationale', () => {
    const a = conceptoptions.createOption(as('admin'), {
      reference: 'OPT-A',
      name: 'Refurbish',
      description: 'x',
      scopeStatement: 'Existing retained',
      assumptions: ['a'],
      exclusions: [],
      baseDate: iso(0),
      currency: 'GBP',
      orderOfCostMinor: 180_000_000,
      costLowMinor: 160_000_000,
      costHighMinor: 220_000_000,
      durationDaysLow: 500,
      durationDaysMostLikely: 600,
      durationDaysHigh: 780,
    });
    throwsCode(() => conceptoptions.rejectOption(as('owner'), { optionId: a.optionId, rationale: '' }), 'RATIONALE_REQUIRED');
  });

  it('keeps rejected options in the comparison, because the table is the record of the decision', () => {
    options();
    const comparison = conceptoptions.compareOptions(as('pm'));
    assert.equal(comparison.comparable, true);
    assert.deepEqual(
      comparison.rows.map((r) => r.reference).sort(),
      ['OPT-A', 'OPT-B'],
      'a rejected option dropped out of the comparison, leaving a one-row table',
    );
    // The leader is still the option in contention, not merely the top row.
    assert.equal(comparison.leader, 'OPT-A');
  });

  it('does not let a rejected option block a later selection', async () => {
    // The deadlock the contending/scored split exists to prevent: reject an
    // option because its price base did not match, and the comparison would
    // stay permanently incomparable if rejections were still counted.
    await freshProject();
    configure();
    brief();
    diligence();

    const shape = {
      description: 'x',
      assumptions: ['a'],
      exclusions: [],
      currency: 'GBP',
      orderOfCostMinor: 180_000_000,
      costLowMinor: 160_000_000,
      costHighMinor: 220_000_000,
      durationDaysLow: 500,
      durationDaysMostLikely: 600,
      durationDaysHigh: 780,
    };
    const stale = conceptoptions.createOption(as('admin'), {
      ...shape,
      reference: 'OPT-OLD',
      name: 'Priced on an old base',
      scopeStatement: 'Existing retained',
      baseDate: '2024-01-01',
    });
    const current = conceptoptions.createOption(as('admin'), {
      ...shape,
      reference: 'OPT-NEW',
      name: 'Priced on the current base',
      scopeStatement: 'Existing retained',
      baseDate: iso(0),
    });
    conceptoptions.analyseOption(as('pm'), { optionId: stale.optionId, scores: SCORES });
    conceptoptions.analyseOption(as('pm'), { optionId: current.optionId, scores: SCORES });

    // While both are in contention the comparison is withheld, correctly.
    assert.equal(conceptoptions.compareOptions(as('pm')).comparable, false);

    conceptoptions.rejectOption(as('owner'), {
      optionId: stale.optionId,
      rationale: 'Priced on a 2024 base and not worth restating; superseded by OPT-NEW.',
    });

    // Ruled out, so it no longer blocks — but it is still in the table.
    const comparison = conceptoptions.compareOptions(as('pm'));
    assert.equal(comparison.comparable, true, comparison.incomparableReason ?? '');
    assert.equal(comparison.rows.length, 2);
    conceptoptions.selectOption(as('owner'), {
      optionId: current.optionId,
      rationale: 'The only option on the current price base.',
      evidenceHash: 'c'.repeat(64),
    });
    assert.equal(conceptoptions.selectedOption(as('pm'))?.reference, 'OPT-NEW');
  });

  it('keeps every rejected option with its reason', () => {
    options();
    const position = conceptoptions.optionPosition(as('pm'));
    assert.equal(position.rejected, 1);
    assert.match(position.rejectedWithRationale[0]!.rationale, /no operability benefit/);
  });

  it('refuses to re-score an option that has been decided', () => {
    const { chosen } = options();
    throwsCode(() => conceptoptions.analyseOption(as('pm'), { optionId: chosen, scores: SCORES }), 'OPTION_DECIDED');
  });
});

// ============================================================ C-WF-05

describe('C-WF-05 — concept cost, programme and cashflow baseline', () => {
  beforeEach(() => {
    configure();
    brief();
    diligence();
    options();
  });

  it('separates the verified total from the total', () => {
    conceptcontrols.createCostPlan(as('qs'), { baseDate: iso(0) });
    conceptcontrols.addCostLine(as('qs'), {
      wbsCode: '1.1',
      category: 'SUBSTRUCTURE',
      description: 'Piling',
      quantity: 100,
      unit: 'nr',
      rateMinor: 100_000,
      rateSource: 'SPONS 2026',
      rateBaseDate: iso(0),
    });
    const provisional = conceptcontrols.addCostLine(as('qs'), {
      wbsCode: '2.1',
      category: 'SUPERSTRUCTURE',
      description: 'Frame — rate not yet benchmarked',
      quantity: 1,
      unit: 'sum',
      rateMinor: 40_000_000,
    });
    assert.equal(provisional.provisional, true);

    const totals = conceptcontrols.costTotals(conceptcontrols.currentCostPlan(as('qs'))!);
    assert.equal(totals.totalMinor, 50_000_000);
    assert.equal(totals.verifiedTotalMinor, 10_000_000);
    assert.equal(totals.provisionalLines, 1);
  });

  it('derives P50 and P80 from the stored ranges by the declared method', () => {
    conceptcontrols.createCostPlan(as('qs'), { baseDate: iso(0), rangeMethod: 'PERT' });
    conceptcontrols.addCostLine(as('qs'), {
      wbsCode: '1.1',
      category: 'SUBSTRUCTURE',
      description: 'Piling',
      quantity: 1,
      unit: 'sum',
      rateMinor: 10_000_000,
      rateSource: 'SPONS 2026',
      rateBaseDate: iso(0),
      lowMinor: 6_000_000,
      highMinor: 18_000_000,
    });
    const totals = conceptcontrols.costTotals(conceptcontrols.currentCostPlan(as('qs'))!);
    // PERT: (6 + 4*10 + 18) / 6 = 10.667m
    assert.equal(totals.p50Minor, 10_666_667);
    // sigma = (18-6)/6 = 2m; P80 = P50 + 0.8416 * 2m
    assert.equal(totals.p80Minor, 12_349_867);
    assert.ok(totals.p80Minor > totals.p50Minor, 'P80 is not above P50');
  });

  it('counts the lines with no range, because a P80 built from point estimates is a P80 of nothing', () => {
    conceptcontrols.createCostPlan(as('qs'), { baseDate: iso(0) });
    conceptcontrols.addCostLine(as('qs'), {
      wbsCode: '1.1',
      category: 'SUBSTRUCTURE',
      description: 'Piling',
      quantity: 1,
      unit: 'sum',
      rateMinor: 10_000_000,
      rateSource: 'SPONS',
      rateBaseDate: iso(0),
    });
    assert.equal(conceptcontrols.conceptControlsPosition(as('qs')).pointOnlyLines, 1);
  });

  it('refuses a second line on the same WBS code', () => {
    conceptcontrols.createCostPlan(as('qs'), { baseDate: iso(0) });
    const line = {
      wbsCode: '1.1',
      category: 'SUBSTRUCTURE' as const,
      description: 'Piling',
      quantity: 1,
      unit: 'sum',
      rateMinor: 10_000_000,
    };
    conceptcontrols.addCostLine(as('qs'), line);
    throwsCode(() => conceptcontrols.addCostLine(as('qs'), line), 'DUPLICATE_WBS');
  });

  it('refuses an undeclared open start on the programme', () => {
    throwsCode(
      () =>
        conceptcontrols.createMilestoneProgramme(as('planner'), {
          dataDate: iso(0),
          milestones: [
            { reference: 'M-A', name: 'A', plannedDate: iso(10), openFinishReason: 'end' },
            { reference: 'M-B', name: 'B', plannedDate: iso(20), openStartReason: 'start', openFinishReason: 'end' },
          ],
        }),
      'UNDECLARED_OPEN_START',
    );
  });

  it('refuses an undeclared open finish', () => {
    throwsCode(
      () =>
        conceptcontrols.createMilestoneProgramme(as('planner'), {
          dataDate: iso(0),
          milestones: [{ reference: 'M-A', name: 'A', plannedDate: iso(10), openStartReason: 'start' }],
        }),
      'UNDECLARED_OPEN_FINISH',
    );
  });

  it('refuses a milestone dated before something it follows', () => {
    throwsCode(
      () =>
        conceptcontrols.createMilestoneProgramme(as('planner'), {
          dataDate: iso(0),
          milestones: [
            { reference: 'M-A', name: 'A', plannedDate: iso(100), openStartReason: 'start' },
            { reference: 'M-B', name: 'B', plannedDate: iso(50), predecessors: ['M-A'], openFinishReason: 'end' },
          ],
        }),
      'IMPOSSIBLE_LOGIC',
    );
  });

  it('refuses a predecessor that is not in the programme', () => {
    throwsCode(
      () =>
        conceptcontrols.createMilestoneProgramme(as('planner'), {
          dataDate: iso(0),
          milestones: [
            { reference: 'M-A', name: 'A', plannedDate: iso(10), predecessors: ['M-GHOST'], openFinishReason: 'end' },
          ],
        }),
      'UNKNOWN_PREDECESSOR',
    );
  });

  it('refuses a cashflow that does not reconcile to its own cost plan', () => {
    conceptcontrols.createCostPlan(as('qs'), { baseDate: iso(0) });
    conceptcontrols.addCostLine(as('qs'), {
      wbsCode: '1.1',
      category: 'SUBSTRUCTURE',
      description: 'Piling',
      quantity: 1,
      unit: 'sum',
      rateMinor: 10_000_000,
    });
    conceptcontrols.createMilestoneProgramme(as('planner'), { dataDate: iso(0), milestones: MILESTONES });

    throwsCode(
      () => conceptcontrols.generateCashflow(as('qs'), { periods: [{ period: '2026-Q1', spendMinor: 9_000_000 }] }),
      'CASHFLOW_UNRECONCILED',
    );
  });

  it('reports peak exposure as spend ahead of funding', () => {
    conceptcontrols.createCostPlan(as('qs'), { baseDate: iso(0) });
    conceptcontrols.addCostLine(as('qs'), {
      wbsCode: '1.1',
      category: 'SUBSTRUCTURE',
      description: 'Piling',
      quantity: 1,
      unit: 'sum',
      rateMinor: 10_000_000,
    });
    conceptcontrols.createMilestoneProgramme(as('planner'), { dataDate: iso(0), milestones: MILESTONES });

    const cashflow = conceptcontrols.generateCashflow(as('qs'), {
      periods: [
        { period: '2026-Q1', spendMinor: 6_000_000, fundingMinor: 2_000_000 },
        { period: '2026-Q2', spendMinor: 4_000_000, fundingMinor: 10_000_000 },
      ],
    });
    // Q1: cumulative 6m against funding 2m = 4m exposure. Q2: 10m against 10m = 0.
    assert.equal(cashflow.peakExposureMinor, 4_000_000);
  });

  it('refuses to approve an affordability gap with no actions against it', () => {
    throwsCode(() => controls({ budgetCapMinor: 1_000_000 }), 'AFFORDABILITY_UNADDRESSED');
  });

  it('approves a gap that carries actions, and records its size', () => {
    conceptcontrols.createCostPlan(as('qs'), { baseDate: iso(0), budgetCapMinor: 1_000_000 });
    conceptcontrols.addCostLine(as('qs'), {
      wbsCode: '1.1',
      category: 'SUBSTRUCTURE',
      description: 'Piling',
      quantity: 1,
      unit: 'sum',
      rateMinor: 10_000_000,
      rateSource: 'SPONS',
      rateBaseDate: iso(0),
    });
    conceptcontrols.createMilestoneProgramme(as('planner'), { dataDate: iso(0), milestones: MILESTONES });
    conceptcontrols.generateCashflow(as('qs'), { periods: [{ period: '2026-Q1', spendMinor: 10_000_000 }] });

    const approved = conceptcontrols.approveConceptControls(as('admin'), {
      cutOffDate: iso(0),
      affordabilityActions: ['Sponsor to seek additional funding at the March board'],
      evidenceHash: 'd'.repeat(64),
    });
    assert.equal(approved.affordabilityGapMinor, approved.p80Minor - 1_000_000);
    assert.ok(approved.affordabilityGapMinor > 0);
  });

  it('refuses to approve while the cashflow points at a superseded cost plan', () => {
    controls();
    assert.equal(conceptcontrols.conceptControlsBlockedReason(as('qs')), null);

    // A second cost plan supersedes the one the cashflow was built against.
    conceptcontrols.createCostPlan(as('qs'), { baseDate: iso(0) });
    // An empty plan is refused for having no lines, which is the earlier and
    // more basic failure. Give it one so the coupling check is what speaks.
    assert.match(String(conceptcontrols.conceptControlsBlockedReason(as('qs'))), /no lines/);
    conceptcontrols.addCostLine(as('qs'), {
      wbsCode: '1.1',
      category: 'SUBSTRUCTURE',
      description: 'Piling, restated',
      quantity: 1,
      unit: 'sum',
      rateMinor: 60_000_000,
      rateSource: 'SPONS 2026',
      rateBaseDate: iso(0),
    });
    assert.match(String(conceptcontrols.conceptControlsBlockedReason(as('qs'))), /earlier cost plan/);
  });

  it('refuses a cost plan before an option is selected', async () => {
    await freshProject();
    configure();
    throwsCode(() => conceptcontrols.createCostPlan(as('qs'), { baseDate: iso(0) }), 'NO_SELECTED_OPTION');
  });
});

// ============================================================ C-WF-06

describe('C-WF-06 — procurement, contract and delivery strategy', () => {
  beforeEach(() => {
    configure();
    brief();
    diligence();
    options();
    controls();
  });

  it('refuses a strategy that assessed only one route', () => {
    throwsCode(
      () =>
        conceptstrategy.createProcurementStrategy(as('pm'), {
          weights: { TIME: 1 },
          assessments: [{ route: 'DESIGN_AND_BUILD', scores: { TIME: 9 }, note: 'Fast' }],
          selectedRoute: 'DESIGN_AND_BUILD',
          rationale: 'Fastest',
          designResponsibility: 'Contractor',
          riskAppetite: 'Low',
        }),
      'NO_COMPARISON',
    );
  });

  it('refuses a single-source route with no authorised justification', () => {
    throwsCode(
      () =>
        conceptstrategy.createProcurementStrategy(as('pm'), {
          weights: { TIME: 1 },
          assessments: [
            { route: 'SINGLE_SOURCE', scores: { TIME: 9 }, note: 'Quickest' },
            { route: 'TRADITIONAL', scores: { TIME: 3 }, note: 'Slow' },
          ],
          selectedRoute: 'SINGLE_SOURCE',
          rationale: 'It was quicker',
          designResponsibility: 'Contractor',
          riskAppetite: 'Low',
        }),
      'SINGLE_SOURCE_UNJUSTIFIED',
    );
  });

  it('accepts a single-source route that names its justification and approver', () => {
    const created = conceptstrategy.createProcurementStrategy(as('pm'), {
      weights: { TIME: 1 },
      assessments: [
        { route: 'SINGLE_SOURCE', scores: { TIME: 9 }, note: 'Quickest' },
        { route: 'TRADITIONAL', scores: { TIME: 3 }, note: 'Slow' },
      ],
      selectedRoute: 'SINGLE_SOURCE',
      rationale: 'Sole proprietary technology compatible with the existing plant',
      designResponsibility: 'Contractor',
      riskAppetite: 'Low',
      singleSourceJustification: 'Only manufacturer able to interface with the installed SCADA',
      singleSourceApprovedBy: 'Commercial Director',
    });
    assert.equal(created.version, 1);
  });

  it('refuses a scope element that appears in two packages', () => {
    conceptstrategy.createProcurementStrategy(as('pm'), {
      weights: { TIME: 1 },
      assessments: [
        { route: 'TRADITIONAL', scores: { TIME: 5 }, note: 'a' },
        { route: 'DESIGN_AND_BUILD', scores: { TIME: 8 }, note: 'b' },
      ],
      selectedRoute: 'DESIGN_AND_BUILD',
      rationale: 'Programme',
      designResponsibility: 'Contractor',
      riskAppetite: 'Low',
    });

    const error = throwsCode(
      () =>
        conceptstrategy.approvePackageStrategy(as('pm'), {
          worksScopeElements: ['CIVILS', 'MECHANICAL'],
          packages: [
            {
              reference: 'PKG-1',
              name: 'One',
              scopeElements: ['CIVILS', 'MECHANICAL'],
              interfaces: [],
              ownerId: seed.users.pm!.id,
              requiredOnSiteMilestoneRef: 'M-SITE',
              enquiryDate: iso(60),
              awardDate: iso(140),
              leadTimeWeeks: 10,
            },
            {
              reference: 'PKG-2',
              name: 'Two',
              scopeElements: ['MECHANICAL'],
              interfaces: [],
              ownerId: seed.users.pm!.id,
              requiredOnSiteMilestoneRef: 'M-SITE',
              enquiryDate: iso(60),
              awardDate: iso(140),
              leadTimeWeeks: 10,
            },
          ],
        }),
      'PACKAGE_SCOPE_OVERLAP',
    );
    assert.match(String(error.message), /MECHANICAL \(PKG-1, PKG-2\)/);
  });

  it('refuses a scope element that appears in no package', () => {
    conceptstrategy.createProcurementStrategy(as('pm'), {
      weights: { TIME: 1 },
      assessments: [
        { route: 'TRADITIONAL', scores: { TIME: 5 }, note: 'a' },
        { route: 'DESIGN_AND_BUILD', scores: { TIME: 8 }, note: 'b' },
      ],
      selectedRoute: 'DESIGN_AND_BUILD',
      rationale: 'Programme',
      designResponsibility: 'Contractor',
      riskAppetite: 'Low',
    });

    const error = throwsCode(
      () =>
        conceptstrategy.approvePackageStrategy(as('pm'), {
          worksScopeElements: ['CIVILS', 'MECHANICAL', 'ELECTRICAL'],
          packages: [
            {
              reference: 'PKG-1',
              name: 'One',
              scopeElements: ['CIVILS', 'MECHANICAL'],
              interfaces: [],
              ownerId: seed.users.pm!.id,
              requiredOnSiteMilestoneRef: 'M-SITE',
              enquiryDate: iso(60),
              awardDate: iso(140),
              leadTimeWeeks: 10,
            },
          ],
        }),
      'PACKAGE_SCOPE_GAP',
    );
    assert.match(String(error.message), /ELECTRICAL/);
  });

  it('refuses a package whose required-on-site milestone is not on the programme', () => {
    conceptstrategy.createProcurementStrategy(as('pm'), {
      weights: { TIME: 1 },
      assessments: [
        { route: 'TRADITIONAL', scores: { TIME: 5 }, note: 'a' },
        { route: 'DESIGN_AND_BUILD', scores: { TIME: 8 }, note: 'b' },
      ],
      selectedRoute: 'DESIGN_AND_BUILD',
      rationale: 'Programme',
      designResponsibility: 'Contractor',
      riskAppetite: 'Low',
    });

    throwsCode(
      () =>
        conceptstrategy.approvePackageStrategy(as('pm'), {
          worksScopeElements: ['CIVILS'],
          packages: [
            {
              reference: 'PKG-1',
              name: 'One',
              scopeElements: ['CIVILS'],
              interfaces: [],
              ownerId: seed.users.pm!.id,
              requiredOnSiteMilestoneRef: 'M-IMAGINARY',
              enquiryDate: iso(60),
              awardDate: iso(140),
              leadTimeWeeks: 10,
            },
          ],
        }),
      'MILESTONE_NOT_FOUND',
    );
  });

  it('refuses an order that is late before it is placed', () => {
    conceptstrategy.createProcurementStrategy(as('pm'), {
      weights: { TIME: 1 },
      assessments: [
        { route: 'TRADITIONAL', scores: { TIME: 5 }, note: 'a' },
        { route: 'DESIGN_AND_BUILD', scores: { TIME: 8 }, note: 'b' },
      ],
      selectedRoute: 'DESIGN_AND_BUILD',
      rationale: 'Programme',
      designResponsibility: 'Contractor',
      riskAppetite: 'Low',
    });

    // M-SITE is at +560 days; awarding at +140 leaves 60 weeks, so a 70-week
    // switchgear order cannot arrive.
    const error = throwsCode(
      () =>
        conceptstrategy.approvePackageStrategy(as('pm'), {
          worksScopeElements: ['CIVILS'],
          packages: [
            {
              reference: 'PKG-SWG',
              name: 'Switchgear',
              scopeElements: ['CIVILS'],
              interfaces: [],
              ownerId: seed.users.pm!.id,
              requiredOnSiteMilestoneRef: 'M-SITE',
              enquiryDate: iso(60),
              awardDate: iso(140),
              leadTimeWeeks: 70,
            },
          ],
        }),
      'LEAD_TIME_IMPOSSIBLE',
    );
    assert.match(String(error.message), /late before it is placed/);
  });

  it('records the contract strategy as provisional, always', () => {
    strategy();
    assert.equal(conceptstrategy.currentContractStrategy(as('pm'))?.provisional, true);
  });

  it('flags a package strategy left behind by a new procurement route', () => {
    strategy();
    assert.equal(conceptstrategy.strategyBlockedReason(as('pm')), null);

    conceptstrategy.createProcurementStrategy(as('pm'), {
      weights: { TIME: 1 },
      assessments: [
        { route: 'TRADITIONAL', scores: { TIME: 9 }, note: 'a' },
        { route: 'DESIGN_AND_BUILD', scores: { TIME: 3 }, note: 'b' },
      ],
      selectedRoute: 'TRADITIONAL',
      rationale: 'Client wants design control after all',
      designResponsibility: 'Employer',
      riskAppetite: 'Low',
    });
    assert.match(String(conceptstrategy.strategyBlockedReason(as('pm'))), /earlier procurement route/);
  });

  it('surfaces long-lead packages without being asked', () => {
    strategy();
    const position = conceptstrategy.strategyPosition(as('pm'));
    assert.deepEqual(
      position.longLead.map((p) => p.reference),
      ['PKG-MEP'],
    );
  });
});

// ============================================================ C-WF-07

describe('C-WF-07 — risk, opportunity, safety and compliance initiation', () => {
  beforeEach(() => {
    configure();
    brief();
    diligence();
    options();
    controls();
    strategy();
  });

  it('refuses a screening with no competent person named', () => {
    throwsCode(
      () =>
        conceptcompliance.confirmComplianceApplicability(as('safety'), {
          regimes: [{ regime: 'CDM_2015', applicable: true, basis: 'Notifiable', milestoneRef: 'M-GW2' }],
          confirmedByName: '',
          confirmedByRole: 'HSE Manager',
          competenceBasis: 'CMIOSH',
          evidenceHash: 'e'.repeat(64),
        }),
      'COMPETENCE_REQUIRED',
    );
  });

  it('refuses an applicable regime that names no milestone', () => {
    throwsCode(
      () =>
        conceptcompliance.confirmComplianceApplicability(as('safety'), {
          regimes: [{ regime: 'CDM_2015', applicable: true, basis: 'Notifiable' }],
          confirmedByName: 'H. Okafor',
          confirmedByRole: 'HSE Manager',
          competenceBasis: 'CMIOSH',
          evidenceHash: 'e'.repeat(64),
        }),
      'GATEWAY_UNPLANNED',
    );
  });

  it('refuses a regime marked either way with no reasoning', () => {
    throwsCode(
      () =>
        conceptcompliance.confirmComplianceApplicability(as('safety'), {
          regimes: [{ regime: 'COMAH', applicable: false, basis: '  ' }],
          confirmedByName: 'H. Okafor',
          confirmedByRole: 'HSE Manager',
          competenceBasis: 'CMIOSH',
          evidenceHash: 'e'.repeat(64),
        }),
      'BASIS_REQUIRED',
    );
  });

  it('reports an applicable gateway that is on the programme but not marked statutory', () => {
    conceptcompliance.confirmComplianceApplicability(as('safety'), {
      regimes: [
        // M-SITE exists but is not a statutory milestone.
        { regime: 'CDM_2015', applicable: true, basis: 'Notifiable', milestoneRef: 'M-SITE' },
      ],
      confirmedByName: 'H. Okafor',
      confirmedByRole: 'HSE Manager',
      competenceBasis: 'CMIOSH',
      evidenceHash: 'e'.repeat(64),
    });
    assert.match(String(conceptcompliance.complianceBlockedReason(as('pm'))), /not marked\s+statutory/);
  });

  it('passes when every applicable gateway is a statutory milestone', () => {
    risk();
    assert.equal(conceptcompliance.complianceBlockedReason(as('pm')), null);
  });

  it('refuses a risk review while a critical risk has no response', () => {
    safety.registerRisk(as('pm'), {
      id: 'RSK-BARE',
      title: 'Unmitigated catastrophic exposure',
      category: 'GROUND_CONDITIONS',
      probability: 0.9,
      costImpact: { optimistic: 50_000_000, mostLikely: 100_000_000, pessimistic: 200_000_000 },
      scheduleImpactDays: { optimistic: 100, mostLikely: 200, pessimistic: 400 },
      ownerPartyId: seed.users.pm!.id,
      projectValueMinor: 240_000_000,
      projectDurationDays: 870,
    });

    const error = throwsCode(
      () =>
        conceptcompliance.approveRiskReview(as('pm'), {
          declaredAllowanceMinor: 12_000_000,
          retainedExposureNote: 'Carried',
          evidenceHash: 'f'.repeat(64),
        }),
      'RISK_REVIEW_BLOCKED',
    );
    assert.match(String(error.message), /no response/);
  });

  it('refuses an allowance that does not reconcile to the cost plan', () => {
    safety.registerRisk(as('pm'), {
      id: 'RSK-01',
      title: 'Ground conditions',
      category: 'GROUND_CONDITIONS',
      probability: 0.3,
      costImpact: { optimistic: 2_000_000, mostLikely: 8_000_000, pessimistic: 30_000_000 },
      scheduleImpactDays: { optimistic: 5, mostLikely: 20, pessimistic: 60 },
      ownerPartyId: seed.users.pm!.id,
      projectValueMinor: 240_000_000,
      projectDurationDays: 870,
      mitigations: [
        { description: 'More boreholes', costMinor: 300_000, probabilityReduction: 0.4, impactReduction: 0.3 },
      ],
    });

    const error = throwsCode(
      () =>
        conceptcompliance.approveRiskReview(as('pm'), {
          // The cost plan carries 12,000,000 under RISK_ALLOWANCE.
          declaredAllowanceMinor: 20_000_000,
          retainedExposureNote: 'Carried',
          evidenceHash: 'f'.repeat(64),
        }),
      'ALLOWANCE_UNRECONCILED',
    );
    assert.match(String(error.message), /counted twice/);
  });

  it('records the reconciliation once it balances', () => {
    risk();
    const review = conceptcompliance.currentConceptRiskReview(as('pm'));
    assert.equal(review?.reconciliationDifferenceMinor, 0);
    assert.equal(review?.costPlanAllowanceMinor, 12_000_000);
    assert.ok((review?.residualExposureMinor ?? 0) < (review?.inherentExposureMinor ?? 0));
  });

  it('does not rebuild the risk register, and reads what the safety engine wrote', () => {
    risk();
    const register = conceptcompliance.riskRegister(as('pm'));
    assert.equal(register.length, 1);
    assert.equal(register[0]?.title, 'Ground conditions worse than the four boreholes suggest');
    assert.ok(register[0]?.expectedCostMinor > 0, 'the engine scored nothing');
  });
});

// ============================================================ C-WF-08 and 6.4

describe('C-WF-08 — concept stage assurance and the 6.4 gate', () => {
  it('routes a CONCEPT project to the concept gate rather than the tender gate', () => {
    configure();
    const report = stagegate.gateFor(as('pm'));
    assert.equal(report.phase, 'CONCEPT');
    assert.equal(report.clauses.length, 7);
  });

  it('names every missing input rather than counting them', () => {
    configure();
    const report = stagegate.evaluateConceptGate(as('pm'));
    const inputs = report.clauses.find((c) => c.clause === 'INPUTS_COMPLETE');
    assert.equal(inputs?.state, 'FAIL');
    assert.ok(inputs!.blocking.length >= 4, 'the gate reported a count, not the names');
    assert.ok(inputs!.blocking.some((b) => /authority matrix/i.test(b)));
    assert.ok(inputs!.blocking.some((b) => /No option has been selected/i.test(b)));
  });

  it('passes every stage-specific clause on a complete concept stage', () => {
    walkToGate();
    const report = stagegate.evaluateConceptGate(as('pm'));

    const state = (clause: string) => report.clauses.find((c) => c.clause === clause)?.state;
    const why = (clause: string) =>
      report.clauses.find((c) => c.clause === clause)?.blocking.join('; ') ?? '';
    assert.equal(state('INPUTS_COMPLETE'), 'PASS', why('INPUTS_COMPLETE'));
    assert.equal(state('APPROVALS_GOVERNED'), 'PASS', why('APPROVALS_GOVERNED'));
    assert.equal(state('BLOCKERS_CLOSED'), 'PASS', why('BLOCKERS_CLOSED'));
    assert.equal(state('ONE_CUT_OFF'), 'PASS', why('ONE_CUT_OFF'));
    assert.equal(state('REPLAYABLE'), 'PASS');
  });

  it('passes the AI clause only because this concept stage used no AI', () => {
    // The shared clause is honest in both directions: nothing to account for
    // is a pass, and an AI output that *is* used makes it unassessable,
    // because the platform records no prompt version or assumptions. This walk
    // uses no AI, so the pass has to say why rather than being read as an
    // assurance about AI governance.
    walkToGate();
    const ai = stagegate.evaluateConceptGate(as('pm')).clauses.find((c) => c.clause === 'AI_ACCOUNTED');
    assert.equal(ai?.state, 'PASS');
    assert.match(ai!.detail, /No AI output was used in this concept stage/);
    assert.deepEqual(ai!.blocking, []);
  });

  it('reports the design mobilisation worklist as not built rather than passing it', () => {
    walkToGate();
    const downstream = stagegate
      .evaluateConceptGate(as('pm'))
      .clauses.find((c) => c.clause === 'DOWNSTREAM_CREATED');
    assert.equal(downstream?.state, 'NOT_ASSESSABLE');
    assert.ok(downstream!.blocking.some((b) => /mobilisation worklist/i.test(b)));
  });

  it('fails the cut-off clause when the cost plan moves after approval', () => {
    walkToGate();
    assert.equal(
      stagegate.evaluateConceptGate(as('pm')).clauses.find((c) => c.clause === 'ONE_CUT_OFF')?.state,
      'PASS',
    );

    conceptcontrols.createCostPlan(as('qs'), { baseDate: iso(0) });
    const cutOff = stagegate.evaluateConceptGate(as('pm')).clauses.find((c) => c.clause === 'ONE_CUT_OFF');
    assert.equal(cutOff?.state, 'FAIL');
    assert.ok(cutOff!.blocking.some((b) => /no longer current/.test(b)));
  });

  it('fails the cut-off clause when a baselined requirement is edited afterwards', () => {
    walkToGate();
    const requirement = conceptbrief.liveRequirements(as('pm'))[0]!;
    conceptbrief.supersedeRequirement(as('owner'), {
      requirementId: requirement.requirementId,
      reason: 'Client withdrew it after the gate pack was issued',
    });

    const cutOff = stagegate.evaluateConceptGate(as('pm')).clauses.find((c) => c.clause === 'ONE_CUT_OFF');
    assert.equal(cutOff?.state, 'FAIL');
    assert.ok(cutOff!.blocking.some((b) => /REQ-00\d has changed/.test(b)));
  });

  it('fails the approvals clause when one person both baselined the brief and chose the option', async () => {
    await freshProject();
    configure();
    delegate();

    // The admin does both, which is what party separation exists to catch.
    const a = requirement('REQ-001');
    conceptbrief.acceptRequirement(as('owner'), { requirementId: a.requirementId });
    conceptbrief.baselineBrief(as('admin'), { evidenceHash: 'a'.repeat(64) });
    diligence();

    const created = conceptoptions.createOption(as('admin'), {
      reference: 'OPT-A',
      name: 'Refurbish',
      description: 'x',
      scopeStatement: 'Existing retained',
      assumptions: ['a'],
      exclusions: [],
      baseDate: iso(0),
      currency: 'GBP',
      orderOfCostMinor: 180_000_000,
      costLowMinor: 160_000_000,
      costHighMinor: 220_000_000,
      durationDaysLow: 500,
      durationDaysMostLikely: 600,
      durationDaysHigh: 780,
    });
    conceptoptions.analyseOption(as('pm'), { optionId: created.optionId, scores: SCORES });
    conceptoptions.selectOption(as('admin'), {
      optionId: created.optionId,
      rationale: 'The only option assessed',
      evidenceHash: 'c'.repeat(64),
    });

    const approvals = stagegate
      .evaluateConceptGate(as('pm'))
      .clauses.find((c) => c.clause === 'APPROVALS_GOVERNED');
    assert.equal(approvals?.state, 'FAIL');
    assert.ok(approvals!.blocking.some((b) => /baselined the brief also selected the option/.test(b)));
  });

  it('freezes the concept baseline with the hash of every component', () => {
    walkToGate();
    const baseline = stagegate.approveConceptBaseline(as('owner'), { evidenceHash: '1'.repeat(64) });
    assert.ok(baseline.components >= 12, `only ${baseline.components} components frozen`);
    assert.match(baseline.baselineHash, /^sha256:/);
    assert.deepEqual(stagegate.conceptBaselineDrift(as('pm')), []);
  });

  it('detects a component that moved after the baseline froze it', () => {
    walkToGate();
    stagegate.approveConceptBaseline(as('owner'), { evidenceHash: '1'.repeat(64) });

    // Reconfiguring the project moves the configuration record the baseline
    // cited — a new version, so the old id no longer resolves to what was
    // frozen. Superseding a requirement moves the brief instead, which is the
    // in-place case.
    const requirement = conceptbrief.liveRequirements(as('pm'))[0]!;
    conceptbrief.supersedeRequirement(as('owner'), {
      requirementId: requirement.requirementId,
      reason: 'Withdrawn after the baseline',
    });

    // The BriefBaseline entity itself has not moved — the requirement has —
    // so the baseline drift stays empty and the brief drift catches it. Both
    // checks exist because they answer different questions.
    assert.deepEqual(stagegate.conceptBaselineDrift(as('pm')), []);
    assert.deepEqual(conceptbrief.briefDrift(as('pm')), [{ reference: 'REQ-001', state: 'DRIFTED' }]);
  });

  it('refuses a baseline over a failing gate', () => {
    configure();
    const error = throwsCode(
      () => stagegate.approveConceptBaseline(as('owner'), { evidenceHash: '1'.repeat(64) }),
      'GATE_NOT_MET',
    );
    assert.match(String(error.message), /freezes a position nobody approved/);
  });

  it('refuses a baseline once the project has left concept', () => {
    walkToGate();
    // The coarse lifecycle gate that predates 6.4 still applies: CONCEPT
    // cannot be left without a scope package. Both gates are in force, and
    // this test needs the project on the far side of the older one.
    structure.createScopePackage(as('pm'), {
      name: 'Whole works',
      discipline: 'Civil and MEP',
      scopeOfWorks: 'Pumping station refurbishment',
      inclusions: ['Civils', 'Mechanical', 'Electrical'],
      exclusions: ['Site-wide drainage'],
      acceptanceCriteria: ['Performance test passed'],
      estimatedValueMinor: 240_000_000,
      designResponsibility: 'CONTRACTOR',
    });
    structure.transitionPhase(as('owner'), { to: 'DESIGN', justification: 'Concept approved' });
    throwsCode(() => stagegate.approveConceptBaseline(as('owner'), { evidenceHash: '1'.repeat(64) }), 'NOT_IN_CONCEPT');
  });

  it('will not pass the gate cleanly while a clause is unassessable', () => {
    walkToGate();
    const error = throwsCode(
      () => stagegate.decideGate(as('owner'), { decision: 'PASS', rationale: 'Looks fine' }),
      'GATE_NOT_MET',
    );
    assert.match(String(error.message), /AI_ACCOUNTED|DOWNSTREAM_CREATED/);
  });

  it('accepts a conditional pass that names an owner and a date against every open clause', () => {
    walkToGate();
    const report = stagegate.evaluateConceptGate(as('pm'));
    const outstanding = [...report.failed, ...report.unassessable];

    const decided = stagegate.decideGate(as('owner'), {
      decision: 'PASS_WITH_CONDITIONS',
      rationale: 'Concept complete; the two unassessable clauses are platform gaps, not project gaps',
      conditions: outstanding.map((clause) => ({
        clause,
        what: 'Close before the design gate',
        owner: seed.users.pm!.id,
        by: iso(90),
      })),
    });
    assert.equal(decided.decision, 'PASS_WITH_CONDITIONS');
    assert.equal(decided.conditions, outstanding.length);
  });
});

// ============================================================ catalogue

describe('the concept stage in the catalogue and the access map', () => {
  const EVENTS: Array<[string, string]> = [
    ['PROJECT_CONFIGURATION_VERSIONED', 'ProjectConfiguration'],
    ['AUTHORITY_MATRIX_APPROVED', 'AuthorityMatrix'],
    ['REQUIREMENT_EXTRACTED', 'ProjectRequirement'],
    ['REQUIREMENT_ACCEPTED', 'ProjectRequirement'],
    ['REQUIREMENT_SUPERSEDED', 'ProjectRequirement'],
    ['BRIEF_BASELINED', 'BriefBaseline'],
    ['SURVEY_REGISTERED', 'SiteSurvey'],
    ['SURVEY_SUPERSEDED', 'SiteSurvey'],
    ['CONSTRAINT_IDENTIFIED', 'SiteConstraint'],
    ['CONSTRAINT_ASSESSED', 'SiteConstraint'],
    ['INVESTIGATION_ASSIGNED', 'InvestigationAction'],
    ['INVESTIGATION_CLOSED', 'InvestigationAction'],
    ['DUE_DILIGENCE_REVIEWED', 'DueDiligenceReview'],
    ['OPTION_CREATED', 'FeasibilityOption'],
    ['OPTION_ANALYSED', 'FeasibilityOption'],
    ['OPTION_SELECTED', 'FeasibilityOption'],
    ['OPTION_REJECTED', 'FeasibilityOption'],
    ['COST_PLAN_CREATED', 'ConceptCostPlan'],
    ['COST_PLAN_LINE_ADDED', 'ConceptCostPlan'],
    ['MILESTONE_PROGRAMME_CREATED', 'MilestoneProgramme'],
    ['CONCEPT_CASHFLOW_GENERATED', 'ConceptCashflow'],
    ['CONCEPT_CONTROLS_APPROVED', 'ConceptControls'],
    ['PROCUREMENT_STRATEGY_CREATED', 'ProcurementStrategy'],
    ['PACKAGE_STRATEGY_APPROVED', 'PackageStrategy'],
    ['CONTRACT_STRATEGY_SELECTED', 'ContractStrategy'],
    ['COMPLIANCE_APPLICABILITY_CONFIRMED', 'ComplianceApplicability'],
    ['RISK_REVIEW_APPROVED', 'ConceptRiskReview'],
    ['CONCEPT_BASELINE_APPROVED', 'ConceptBaseline'],
  ];

  it('registers every concept event against its entity', () => {
    for (const [code, entity] of EVENTS) {
      const definition = lookupEventType(code);
      assert.ok(definition, `${code} is not in the catalogue`);
      assert.equal(definition.entity, entity, `${code} is registered against ${definition.entity}`);
    }
  });

  it('classifies every concept entity, so none is readable by default', () => {
    for (const [, entity] of EVENTS) {
      assert.ok(classifyEntity(entity), `${entity} has no entry in the entity access map`);
    }
  });

  it('does not overload the Last Planner constraint entity with site constraints', () => {
    // Two genuinely different things: something blocking next week's task, and
    // a permanent property of the ground.
    assert.equal(classifyEntity('Constraint')?.area, 'LOOKAHEAD_CONSTRAINTS');
    assert.equal(classifyEntity('SiteConstraint')?.area, 'PROJECT_SETUP');
  });

  it('keeps the milestone programme readable by everyone who plans against it', () => {
    // Commercially sensitive things are banded; a date is not one of them.
    assert.equal(classifyEntity('MilestoneProgramme')?.sensitivity, undefined);
    assert.equal(classifyEntity('ConceptCostPlan')?.sensitivity, 'COMMERCIAL_L3');
  });

  it('marks the AI-capable events and no others', () => {
    assert.equal(lookupEventType('REQUIREMENT_EXTRACTED')?.aiAllowed, true);
    assert.equal(lookupEventType('CONSTRAINT_IDENTIFIED')?.aiAllowed, true);
    assert.equal(lookupEventType('OPTION_ANALYSED')?.aiAllowed, true);
    // The decisions are not.
    assert.equal(lookupEventType('OPTION_SELECTED')?.aiAllowed, false);
    assert.equal(lookupEventType('CONCEPT_BASELINE_APPROVED')?.aiAllowed, false);
    assert.equal(lookupEventType('RISK_REVIEW_APPROVED')?.aiAllowed, false);
  });
});
