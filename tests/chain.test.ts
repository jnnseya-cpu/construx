import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { rejectsCode, throwsCode } from './helpers.ts';
import { hashEvidence } from '../src/core/canonical.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import * as business from '../src/domain/business.ts';
import * as cdm from '../src/domain/cdm.ts';
import * as structure from '../src/domain/structure.ts';
import * as framework from '../src/domain/framework.ts';
import * as supplychain from '../src/domain/supplychain.ts';
import * as quality from '../src/engines/quality.ts';
import * as safety from '../src/engines/safety.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The contractor's delivery chain, end to end.
 *
 *   Business Development -> Estimating -> Preconstruction -> Contract ->
 *   Project Management -> Commercial -> HSEQ -> Subcontract Procurement ->
 *   Programme -> Quality -> Handover
 *
 * Most of that chain existed. Its head did not: the platform began at a project
 * that already existed, with nothing describing how the business decided to
 * chase the job. Quality had three catalogue events and no command able to emit
 * any of them, so a snag could be raised and never closed. HSEQ could not record
 * that anyone had been hurt. Procurement could send an enquiry to anybody at all.
 *
 * These tests walk the chain and assert the joins — the places where one stage
 * hands to the next — because a chain is only as real as its weakest handover.
 */

let platform: Platform;
let seed: SeedResult;

const ctxFor = (who: string, projectId?: string) =>
  platform.context(seed.users[who]!.auth, projectId ?? seed.projectId, { source: 'WEB' });

/** Business development happens before a project exists. */
const pipelineCtx = (who: string) => ctxFor(who, `${seed.tenantId}-governance`);

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

// ── 1 · Business development ────────────────────────────────────────────────

describe('1 · Business development', () => {
  it('scores an opportunity on arithmetic rather than instinct', () => {
    const strong = business.qualify({
      strategicFit: 5, capability: 5, capacity: 4, clientQuality: 4, competitivePosition: 4, riskProfile: 4,
    });
    const weak = business.qualify({
      strategicFit: 2, capability: 2, capacity: 2, clientQuality: 2, competitivePosition: 2, riskProfile: 2,
    });

    assert.ok(strong.score > weak.score);
    assert.equal(strong.recommendation, 'PURSUE');
    assert.equal(weak.recommendation, 'DECLINE');
    assert.ok(weak.concerns.length > 0, 'a weak opportunity must say what is wrong with it');
  });

  it('forces a review when capacity or client quality is poor, however good the rest', () => {
    // The average would pass. Taking on work you cannot resource is how a good
    // job kills a good business, so either criterion alone stops a PURSUE.
    const stretched = business.qualify({
      strategicFit: 5, capability: 5, capacity: 2, clientQuality: 5, competitivePosition: 5, riskProfile: 5,
    });

    assert.ok(stretched.score >= 70, 'the fixture should score well on the average');
    assert.equal(stretched.recommendation, 'REVIEW', 'thin capacity did not force a review');
  });

  it('refuses a score outside the scale rather than clamping it', () => {
    throwsCode(
      () => business.qualify({ strategicFit: 9, capability: 3, capacity: 3, clientQuality: 3, competitivePosition: 3, riskProfile: 3 }),
      'QUALIFICATION_SCORE_INVALID',
    );
  });

  it('will not record a bid decision before the opportunity has been qualified', () => {
    const ctx = pipelineCtx('owner');
    const { opportunityId } = business.registerOpportunity(ctx, {
      title: 'Riverside flood alleviation',
      clientName: 'Environment Agency',
      sectorType: 'INFRASTRUCTURE',
      estimatedValueMinor: 2_400_000_00,
      source: 'Framework mini-competition',
    });

    throwsCode(
      () => business.decideBidNoBid(ctx, opportunityId, { bid: true, rationale: 'Looks good' }),
      'QUALIFICATION_REQUIRED',
    );
  });

  it('records a decision taken against its own recommendation', () => {
    // The platform advises; the business decides. What it must not do is let
    // the override pass unremarked — that is the finding a post-mortem needs.
    const ctx = pipelineCtx('owner');
    const { opportunityId } = business.registerOpportunity(ctx, {
      title: 'Speculative office fit-out',
      clientName: 'Unknown developer',
      sectorType: 'BUILDING',
      estimatedValueMinor: 800_000_00,
      source: 'Cold approach',
    });

    business.qualifyOpportunity(ctx, opportunityId, {
      strategicFit: 1, capability: 2, capacity: 2, clientQuality: 1, competitivePosition: 2, riskProfile: 1,
    });
    const decision = business.decideBidNoBid(ctx, opportunityId, {
      bid: true,
      rationale: 'Strategic entry into a new client despite the score',
    });

    assert.equal(decision.stage, 'BID');
    assert.equal(decision.againstRecommendation, true, 'the override was not flagged');
    assert.equal(business.pipeline(ctx).overrides, 1);
  });

  it('requires a rationale whichever way the decision goes', () => {
    const ctx = pipelineCtx('owner');
    const opportunity = business.pipeline(ctx).opportunities.find((o) => o.stage === 'QUALIFIED');
    if (!opportunity) return;
    throwsCode(
      () => business.decideBidNoBid(ctx, String(opportunity.id), { bid: false, rationale: '  ' }),
      'RATIONALE_REQUIRED',
    );
  });
});

// ── 1 → 5 · The join into delivery ──────────────────────────────────────────

describe('1 → 5 · Business development hands to project management', () => {
  it('turns a won opportunity into a project that remembers where it came from', () => {
    const ctx = pipelineCtx('admin');
    const { opportunityId } = business.registerOpportunity(ctx, {
      title: 'Ashworth WTW Phase 3',
      clientName: 'Meridian Water',
      sectorType: 'INFRASTRUCTURE',
      estimatedValueMinor: 12_000_000_00,
      source: 'Repeat client',
      countryCode: 'GB',
      city: 'Manchester',
    });

    business.qualifyOpportunity(ctx, opportunityId, {
      strategicFit: 5, capability: 5, capacity: 4, clientQuality: 5, competitivePosition: 4, riskProfile: 4,
    });
    business.decideBidNoBid(ctx, opportunityId, { bid: true, rationale: 'Repeat client, proven capability' });

    const portfolio = platform.ledger
      .list(`${seed.tenantId}-governance`, 'Portfolio')
      .at(0)!;

    const { projectId } = business.convertToProject(ctx, opportunityId, {
      projectName: 'Ashworth WTW Phase 3',
      portfolioId: String(portfolio.state.id),
      assetType: 'Water treatment facility',
      location: { continentCode: 'EU', countryCode: 'GB', city: 'Manchester' },
      currency: 'GBP',
      plannedStart: '2027-01-04',
      plannedCompletion: '2029-06-29',
    });

    const project = platform.ledger.get({ refType: 'Project', refId: projectId })!;
    assert.equal(project.state.originOpportunityId, opportunityId, 'the project forgot which pursuit created it');
    assert.equal(project.state.phase, 'CONCEPT', 'a converted project starts at the beginning like any other');
  });

  it('refuses to convert an opportunity that was never won', () => {
    const ctx = pipelineCtx('admin');
    const { opportunityId } = business.registerOpportunity(ctx, {
      title: 'Declined scheme',
      clientName: 'A client',
      sectorType: 'BUILDING',
      estimatedValueMinor: 100_000_00,
      source: 'Portal',
    });
    business.qualifyOpportunity(ctx, opportunityId, {
      strategicFit: 3, capability: 3, capacity: 3, clientQuality: 3, competitivePosition: 3, riskProfile: 3,
    });
    business.decideBidNoBid(ctx, opportunityId, { bid: false, rationale: 'No capacity this year' });

    throwsCode(
      () =>
        business.convertToProject(ctx, opportunityId, {
          projectName: 'Should not exist',
          portfolioId: 'x',
          assetType: 'Office',
          location: { continentCode: 'EU', countryCode: 'GB', city: 'Leeds' },
          currency: 'GBP',
          plannedStart: '2027-01-01',
          plannedCompletion: '2027-12-31',
        }),
      'OPPORTUNITY_NOT_WON',
    );
  });
});

// ── 8 · Subcontract procurement ─────────────────────────────────────────────

describe('8 · Subcontract procurement runs off a prequalified register', () => {
  it('covers the trades a main contractor actually buys', () => {
    const codes = new Set(supplychain.TRADES.map((t) => t.code));
    for (const trade of [
      'GROUNDWORKS', 'CONCRETE_WORKS', 'STRUCTURAL_STEELWORK', 'ROOFING', 'MEP', 'DRYLINING',
      'CARPENTRY', 'DECORATING', 'FLOORING', 'FIRE_STOPPING', 'SCAFFOLDING', 'PLANT_HIRE',
      'WASTE_MANAGEMENT', 'TEMPORARY_WORKS_SUPPLY', 'QUANTITY_SURVEYOR', 'SITE_MANAGER',
    ]) {
      assert.ok(codes.has(trade), `${trade} is missing from the trade catalogue`);
    }
    assert.ok(supplychain.TRADES.length >= 70, 'the catalogue is too thin to describe a real supply chain');
  });

  it('bars a firm whose employers liability has lapsed, whatever else it scores', () => {
    // Not a deduction — a bar. Scoring an absolute requirement is how a
    // prequalification system approves somebody it should not have.
    const result = supplychain.assessPrequalification(
      {
        identity: { companyNumber: '01234567', companyStatus: 'active', incorporatedOn: '2001-01-01', cisStatus: 'GROSS' },
        financial: { turnoverMinorByYear: [20_000_000_00], accountsFiledUpToDate: true },
        insurances: [
          { type: 'PUBLIC_LIABILITY', insurer: 'A', limitMinor: 1_000_000_000, expiresOn: '2030-01-01' },
          { type: 'EMPLOYERS_LIABILITY', insurer: 'A', limitMinor: 1_000_000_000, expiresOn: '2020-01-01' },
        ],
        safetyAccreditations: ['CHAS'],
        qualityAccreditations: ['ISO 9001', 'ISO 45001'],
        riddorLastThreeYears: 0,
        references: [{ clientName: 'C', projectName: 'P', valueMinor: 1_000_00, verified: true }],
        capacity: { maxPackageValueMinor: 10_000_000_00 },
        complianceConfirmed: true,
      },
      ['GROUNDWORKS'],
      { today: '2026-08-19' },
    );

    assert.equal(result.status, 'DO_NOT_USE');
    assert.ok(result.bars.some((b) => b.includes('expired')), 'the lapsed policy was not treated as a bar');
    assert.deepEqual(result.approvedTrades, [], 'a rejected firm was still approved for a trade');
  });

  it('bars an unaccredited firm from a life-safety trade', () => {
    const base = {
      identity: { companyNumber: '02345678', companyStatus: 'active', incorporatedOn: '2016-01-01', cisStatus: 'GROSS' as const },
      financial: { turnoverMinorByYear: [5_000_000_00], accountsFiledUpToDate: true },
      insurances: [
        { type: 'PUBLIC_LIABILITY' as const, insurer: 'A', limitMinor: 1_000_000_000, expiresOn: '2030-01-01' },
        { type: 'EMPLOYERS_LIABILITY' as const, insurer: 'A', limitMinor: 1_000_000_000, expiresOn: '2030-01-01' },
      ],
      safetyAccreditations: [],
      qualityAccreditations: ['ISO 9001'],
      riddorLastThreeYears: 0,
      references: [{ clientName: 'C', projectName: 'P', valueMinor: 1_000_00, verified: true }],
      capacity: { maxPackageValueMinor: 5_000_000_00 },
      complianceConfirmed: true,
    };

    const fireStopping = supplychain.assessPrequalification(base, ['FIRE_STOPPING'], { today: '2026-08-19' });
    const decorating = supplychain.assessPrequalification(base, ['DECORATING'], { today: '2026-08-19' });

    assert.equal(fireStopping.status, 'DO_NOT_USE', 'an unaccredited firm was approved for fire-stopping');
    assert.notEqual(decorating.status, 'DO_NOT_USE', 'decorating does not need third-party accreditation');
  });

  it('refuses an enquiry to anyone not on the register, and names them', async () => {
    const ctx = ctxFor('qs');
    await rejectsCode(
      async () =>
        supplychain.assertEligibleForEnquiry(ctx, ['SUP-DOES-NOT-EXIST'], { trade: 'GROUNDWORKS' }),
      'SUPPLIER_NOT_PREQUALIFIED',
    );
  });

  it('refuses an enquiry to a suspended firm even while its approval is current', () => {
    const qsCtx = ctxFor('qs');
    const pmCtx = ctxFor('pm');

    const { supplierId } = supplychain.registerSupplier(qsCtx, {
      legalName: 'Suspended Scaffolding Ltd',
      trades: ['SCAFFOLDING'],
      contactName: 'A person',
      contactEmail: 'a@b.example',
    });
    supplychain.prequalifySupplier(pmCtx, supplierId, {
      identity: { companyNumber: '03456789', companyStatus: 'active', incorporatedOn: '2017-01-01', vatNumber: 'GB123', utr: '1234567890', cisStatus: 'GROSS' },
      financial: { turnoverMinorByYear: [2_000_000_00], accountsFiledUpToDate: true },
      insurances: [
        { type: 'PUBLIC_LIABILITY', insurer: 'A', limitMinor: 1_000_000_000, expiresOn: '2030-01-01' },
        { type: 'EMPLOYERS_LIABILITY', insurer: 'A', limitMinor: 1_000_000_000, expiresOn: '2030-01-01' },
      ],
      safetyAccreditations: ['CHAS'],
      qualityAccreditations: ['ISO 45001'],
      riddorLastThreeYears: 0,
      competenceCards: [{ scheme: 'CISRS', holders: 8 }],
      references: [{ clientName: 'C', projectName: 'P', valueMinor: 500_00, verified: true }],
      capacity: { maxPackageValueMinor: 1_000_000_00 },
      complianceConfirmed: true,
      evidenceHash: hashEvidence('pqq-suspended'),
    });

    assert.doesNotThrow(() => supplychain.assertEligibleForEnquiry(qsCtx, [supplierId], { trade: 'SCAFFOLDING' }));

    supplychain.suspendSupplier(pmCtx, supplierId, { reason: 'Serious incident under investigation' });

    throwsCode(
      () => supplychain.assertEligibleForEnquiry(qsCtx, [supplierId], { trade: 'SCAFFOLDING' }),
      'SUPPLIER_NOT_PREQUALIFIED',
    );
  });

  it('refuses an enquiry larger than the firm was assessed to carry', () => {
    const qsCtx = ctxFor('qs');
    const suppliers = supplychain.findSuppliers(qsCtx, { trade: 'GROUNDWORKS' });
    assert.ok(suppliers.length > 0, 'the seed should have prequalified groundworkers');

    throwsCode(
      () =>
        supplychain.assertEligibleForEnquiry(qsCtx, [String(suppliers[0]!.id)], {
          trade: 'GROUNDWORKS',
          packageValueMinor: 999_000_000_00,
        }),
      'SUPPLIER_NOT_PREQUALIFIED',
    );
  });

  it('reports where the supply chain is too thin to compete', () => {
    const coverage = supplychain.supplyChainCoverage(ctxFor('qs'));

    assert.ok(coverage.totals.suppliers > 0);
    // Fewer than three eligible firms cannot produce a competitive enquiry,
    // which is the number that matters rather than "do we have one".
    assert.ok(coverage.gaps.length > 0, 'a new register should report its gaps rather than look complete');
    assert.ok(coverage.trades.some((t) => t.code === 'GROUNDWORKS' && t.eligible >= 3));
  });
});

// ── 7 · HSEQ ────────────────────────────────────────────────────────────────

describe('7 · HSEQ records what happened and who is qualified', () => {
  it('records an incident and escalates the ones that stop being a site matter', () => {
    const ctx = ctxFor('safety');

    const nearMiss = safety.recordIncident(ctx, {
      occurredAt: new Date().toISOString(),
      location: 'Clarifier 1, east walkway',
      category: 'NEAR_MISS',
      description: 'Scaffold board displaced by wind, no injury',
      immediateAction: 'Area closed, boards re-secured and re-inspected',
      personsInvolved: [],
      riddorReportable: false,
      evidenceHash: hashEvidence('near-miss-photo'),
    });

    const lostTime = safety.recordIncident(ctx, {
      occurredAt: new Date().toISOString(),
      location: 'Filter gallery',
      category: 'LOST_TIME',
      description: 'Operative struck hand while striking formwork',
      immediateAction: 'First aid administered, RIDDOR notification prepared',
      personsInvolved: ['operative-1'],
      riddorReportable: true,
      lostTimeDays: 8,
      evidenceHash: hashEvidence('lost-time-report'),
    });

    assert.equal(nearMiss.escalated, false);
    assert.equal(lostTime.escalated, true, 'a lost-time injury must escalate');

    const position = safety.safetyPosition(ctx);
    assert.equal(position.incidents.total, 2);
    assert.equal(position.incidents.escalated, 1);
    assert.equal(position.incidents.lostTimeDays, 8);
  });

  it('insists the RIDDOR question is answered rather than left blank', async () => {
    await rejectsCode(
      async () =>
        safety.recordIncident(ctxFor('safety'), {
          occurredAt: new Date().toISOString(),
          location: 'Site',
          category: 'MINOR_INJURY',
          description: 'Cut finger',
          immediateAction: '',
          personsInvolved: [],
          riddorReportable: false,
          evidenceHash: hashEvidence('x'),
        }),
      'IMMEDIATE_ACTION_REQUIRED',
    );
  });

  it('knows which training has expired, which is the only useful thing about a record of it', () => {
    const ctx = ctxFor('safety');

    safety.recordTraining(ctx, {
      personId: 'operative-1',
      competency: 'CPCS Slinger/Signaller',
      provider: 'NOCN',
      completedOn: '2024-01-15',
      expiresOn: '2025-01-15',
      certificateHash: hashEvidence('cert-expired'),
    });
    safety.recordTraining(ctx, {
      personId: 'operative-2',
      competency: 'SMSTS',
      provider: 'CITB',
      completedOn: '2026-02-01',
      expiresOn: '2031-02-01',
      certificateHash: hashEvidence('cert-current'),
    });

    const position = safety.safetyPosition(ctx);
    assert.equal(position.training.records, 2);
    assert.equal(position.training.expired, 1, 'an expired competency reads the same as one nobody ever held');
  });
});

// ── 10 · Quality ────────────────────────────────────────────────────────────

describe('10 · Quality is assurance, not a defect list', () => {
  let planId: string;

  before(() => {
    // The seeded project has reached Operations, and quality writes are gated
    // to Construction, Commissioning and Handover — correctly, since inspecting
    // work that finished two years ago is not a thing. Rather than bypass the
    // gate, this regresses the project through the governed transition, which
    // is a real move a project can make and is recorded as a regression with a
    // justification against it.
    structure.transitionPhase(ctxFor('admin'), {
      to: 'HANDOVER',
      justification: 'Reopened for outstanding quality assurance on the clarifier base slab',
    });
  });

  it('refuses a plan stage with nothing to inspect against', () => {
    throwsCode(
      () =>
        quality.createInspectionPlan(ctxFor('qaqc'), {
          workPackageId: 'wp-1',
          title: 'Reinforcement',
          discipline: 'CIVILS',
          stages: [{ reference: 'A', description: 'Check it', acceptanceCriteria: '  ', type: 'HOLD', responsible: 'QA' }],
        }),
      'ACCEPTANCE_CRITERIA_REQUIRED',
    );
  });

  it('creates an inspection and test plan with hold points', () => {
    const plan = quality.createInspectionPlan(ctxFor('qaqc'), {
      workPackageId: 'wp-clarifier-1',
      title: 'Clarifier 1 base slab',
      discipline: 'CIVILS',
      specificationRef: 'SPEC-C-300',
      stages: [
        { reference: 'S1', description: 'Formwork and dimensional check', acceptanceCriteria: 'Within ±10mm of setting-out', type: 'HOLD', responsible: 'Site engineer' },
        { reference: 'S2', description: 'Reinforcement pre-pour inspection', acceptanceCriteria: 'Cover and lap lengths to drawing C-1001 rev P03', type: 'HOLD', responsible: 'QA/QC' },
        { reference: 'S3', description: 'Concrete cube results at 28 days', acceptanceCriteria: 'Characteristic strength 40N/mm²', type: 'REVIEW', responsible: 'QA/QC' },
      ],
    });

    planId = plan.planId;
    assert.equal(plan.holdPoints, 2);
    assert.match(plan.reference, /^ITP-\d{5}$/);
  });

  it('stops the work while a hold point is outstanding, and says which', () => {
    const ctx = ctxFor('qaqc');
    assert.equal(quality.openHoldPoints(ctx).length, 2);

    throwsCode(() => quality.assertHoldPointsClear(ctx, 'wp-clarifier-1'), 'HOLD_POINT_OPEN');
  });

  it('will not record a failed inspection without saying what did not conform', () => {
    throwsCode(
      () =>
        quality.recordInspection(ctxFor('qaqc'), {
          planId,
          stageReference: 'S1',
          outcome: 'FAIL',
          inspectedBy: 'Site engineer',
          comments: 'Not right',
          evidenceHash: hashEvidence('insp-1'),
        }),
      'NON_CONFORMANCE_REQUIRED',
    );
  });

  it('raises the non-conformance in the same breath as the failure', () => {
    const result = quality.recordInspection(ctxFor('qaqc'), {
      planId,
      stageReference: 'S1',
      outcome: 'FAIL',
      inspectedBy: 'Site engineer',
      comments: 'Setting-out 25mm out on the east face',
      evidenceHash: hashEvidence('insp-fail'),
      nonConformance: {
        description: 'Formwork set out 25mm beyond tolerance on the east face',
        severity: 'MAJOR',
        proposedAction: 'Strike, reset and re-survey before reinforcement',
      },
    });

    assert.ok(result.ncrId, 'a failed inspection left no non-conformance behind it');
    assert.equal(result.stageReleased, false);
    assert.equal(quality.qualityPosition(ctxFor('qaqc')).ncrs.open, 1);
  });

  it('releases the hold point once the stage passes', () => {
    const ctx = ctxFor('qaqc');

    quality.recordInspection(ctx, {
      planId, stageReference: 'S1', outcome: 'PASS',
      inspectedBy: 'Site engineer', comments: 'Reset and re-surveyed, within tolerance',
      evidenceHash: hashEvidence('insp-pass-1'),
    });
    const second = quality.recordInspection(ctx, {
      planId, stageReference: 'S2', outcome: 'PASS_WITH_COMMENT',
      inspectedBy: 'QA/QC', comments: 'Two additional spacers requested and fitted',
      evidenceHash: hashEvidence('insp-pass-2'),
    });

    assert.equal(second.stageReleased, true);
    assert.equal(quality.openHoldPoints(ctx).length, 0, 'a passed hold point is still holding');
    assert.doesNotThrow(() => quality.assertHoldPointsClear(ctx, 'wp-clarifier-1'));
  });

  it('closes a non-conformance with a disposition somebody owns', () => {
    const ctx = ctxFor('qaqc');
    const ncr = platform.ledger.list(seed.projectId, 'NCR').find((r) => r.state.status === 'OPEN')!;

    throwsCode(
      () => quality.closeNCR(ctx, ncr.refId, { disposition: 'USE_AS_IS', justification: '  ', evidenceHash: hashEvidence('x') }),
      'JUSTIFICATION_REQUIRED',
    );

    const closed = quality.closeNCR(ctx, ncr.refId, {
      disposition: 'REWORK',
      justification: 'Formwork struck, reset and re-surveyed; verified at inspection S1',
      evidenceHash: hashEvidence('ncr-closure'),
    });

    assert.equal(closed.status, 'CLOSED');
    assert.equal(quality.qualityPosition(ctx).ncrs.open, 0);
  });

  it('reports a conformance position rather than a feeling', () => {
    const position = quality.qualityPosition(ctxFor('qaqc'));

    assert.equal(position.plans, 1);
    assert.equal(position.stagesTotal, 3);
    assert.equal(position.stagesPassed, 2);
    assert.equal(position.conformancePercent, 66.67);
    assert.equal(position.holdPointsOpen, 0);
  });
});

// ── 7 · CDM and the Principal Contractor's duties ───────────────────────────

describe('7 · CDM duties are enforced, not documented', () => {
  let cppId: string;

  it('publishes what each document must contain, as a floor rather than a style', () => {
    const cpp = cdm.documentSpec('CONSTRUCTION_PHASE_PLAN');

    assert.ok(cpp.gatesConstruction, 'the Construction Phase Plan must gate the construction phase');
    for (const section of ['Welfare facilities', 'Fire and emergency procedures', 'Site induction arrangements']) {
      assert.ok(cpp.requiredSections.includes(section), `the plan does not require "${section}"`);
    }
    assert.ok(cdm.CDM_DOCUMENTS.length >= 12, 'the catalogue does not cover the documents a PC actually needs');
  });

  it('drafts from project state and names what it could not fill, rather than inventing it', () => {
    const draft = cdm.draftDocument(ctxFor('safety'), {
      type: 'CONSTRUCTION_PHASE_PLAN',
      title: 'Ashworth WTW Phase 2 — Construction Phase Plan',
      draftedByAgent: 'safety-agent',
    });

    cppId = draft.documentId;

    // The description and the significant risks come from the ledger; the rest
    // is honestly reported as missing.
    const description = draft.sections.find((s) => s.heading === 'Project description and programme')!;
    assert.ok(description.body.includes('Ashworth'), 'the plan is not project-specific');
    assert.ok(draft.gaps.length > 0, 'a first draft claiming no gaps is not telling the truth');
    for (const gap of draft.gaps) {
      const section = draft.sections.find((s) => s.heading === gap)!;
      assert.match(section.body, /Not yet provided/, 'a gap was filled with plausible text instead of being named');
    }
  });

  it('refuses to put a competent person against a plan with holes in it', () => {
    throwsCode(
      () => cdm.approveDocument(ctxFor('safety'), cppId, { comments: 'Looks fine' }),
      'CDM_DOCUMENT_INCOMPLETE',
    );
  });

  it('refuses construction-phase work while no plan is approved', () => {
    throwsCode(() => cdm.assertConstructionPhasePlan(ctxFor('safety')), 'CONSTRUCTION_PHASE_PLAN_REQUIRED');
    throwsCode(
      () =>
        cdm.recordInduction(ctxFor('safety'), {
          personId: 'op-1', personName: 'A worker', employer: 'Northstone',
          inductedBy: 'HSE Manager', competenciesChecked: ['CSCS'],
        }),
      'CONSTRUCTION_PHASE_PLAN_REQUIRED',
    );
  });

  it('approves once every required section is filled', () => {
    const spec = cdm.documentSpec('CONSTRUCTION_PHASE_PLAN');
    const complete = cdm.draftDocument(ctxFor('safety'), {
      type: 'CONSTRUCTION_PHASE_PLAN',
      title: 'Ashworth WTW Phase 2 — Construction Phase Plan rev B',
      sections: spec.requiredSections.map((heading) => ({
        heading,
        body: `${heading}: arrangements agreed with the client and the principal designer.`,
      })),
    });

    assert.deepEqual(complete.gaps, []);
    const approved = cdm.approveDocument(ctxFor('safety'), complete.documentId, {
      comments: 'Reviewed against the pre-construction information',
    });
    assert.equal(approved.status, 'APPROVED');
    assert.doesNotThrow(() => cdm.assertConstructionPhasePlan(ctxFor('safety')));
  });

  it('refuses a sign-off from someone the document does not name as competent', () => {
    const draft = cdm.draftDocument(ctxFor('safety'), {
      type: 'LIFTING_PLAN',
      title: 'Clarifier 1 precast lift',
      sections: cdm.documentSpec('LIFTING_PLAN').requiredSections.map((heading) => ({ heading, body: 'Agreed.' })),
    });

    // A lifting plan is signed by the constructor, not the safety adviser.
    throwsCode(() => cdm.approveDocument(ctxFor('safety'), draft.documentId, { comments: 'ok' }), 'CDM_APPROVER_NOT_COMPETENT');
  });

  it('refuses an AI actor authoring a safety approval, at the catalogue', () => {
    // Defence in depth, and the law: a method statement signed by a model is
    // not a competent person's signature.
    assert.equal(lookupEventType('CDM_DOCUMENT_APPROVED')?.aiAllowed, false);
    assert.equal(lookupEventType('RAMS_APPROVED')?.aiAllowed, false);
    // Drafting is exactly what an agent is for.
    assert.equal(lookupEventType('CDM_DOCUMENT_DRAFTED')?.aiAllowed, true);
  });

  it('inducts a worker once the site has a plan, and knows who is current', () => {
    const ctx = ctxFor('safety');

    assert.equal(cdm.isInducted(ctx, 'op-1'), false);
    cdm.recordInduction(ctx, {
      personId: 'op-1', personName: 'A worker', employer: 'Northstone Civils Ltd',
      inductedBy: 'HSE Manager', competenciesChecked: ['CSCS', 'Confined space'],
    });

    assert.equal(cdm.isInducted(ctx, 'op-1'), true);
    assert.doesNotThrow(() => cdm.assertInducted(ctx, 'op-1'));
    throwsCode(() => cdm.assertInducted(ctx, 'op-2'), 'INDUCTION_REQUIRED');
  });

  it('will not record a toolbox talk that briefed nobody', () => {
    throwsCode(
      () => cdm.recordToolboxTalk(ctxFor('safety'), { subject: 'Manual handling', deliveredBy: 'Supervisor', keyPoints: ['Lift safely'], attendees: [] }),
      'ATTENDANCE_REQUIRED',
    );
  });

  it('reports the duty position as named breaches rather than a percentage', () => {
    const ctx = ctxFor('safety');
    cdm.recordToolboxTalk(ctx, {
      subject: 'Working near deep excavations',
      deliveredBy: 'Site Supervisor',
      keyPoints: ['Edge protection', 'Access routes', 'Reporting damage'],
      attendees: ['op-1', 'op-2', 'op-3'],
    });

    const position = cdm.principalContractorPosition(ctx);

    assert.equal(position.constructionPhasePlan.inPlace, true);
    assert.equal(position.inductions.current, 1);
    assert.equal(position.toolboxTalks.attendances, 3);
    // The incomplete first draft is still open, and the position says so by name.
    assert.ok(
      position.breaches.some((b) => b.includes('unfilled required section')),
      'a document with holes in it did not appear as a breach',
    );
  });
});

// ── 8 · Classification ──────────────────────────────────────────────────────

describe('8 · Strategic / Approved / Conditional / Do Not Use', () => {
  /** A clean submission at ENHANCED scrutiny, varied per test. */
  const submission = (over: Partial<supplychain.PrequalificationInput> = {}): supplychain.PrequalificationInput => ({
    identity: {
      companyNumber: '01234567', companyStatus: 'active', incorporatedOn: '2006-04-01',
      vatNumber: 'GB123456789', utr: '1234567890', cisStatus: 'GROSS',
    },
    financial: {
      turnoverMinorByYear: [8_000_000_00, 7_400_000_00, 6_900_000_00],
      netAssetsMinor: 2_100_000_00, creditScore: 82, creditAgency: 'Creditsafe',
      accountsFiledUpToDate: true, accountsMadeUpTo: '2026-03-31',
    },
    insurances: [
      { type: 'PUBLIC_LIABILITY', insurer: 'Aviva', limitMinor: 1_000_000_000, expiresOn: '2029-01-01' },
      { type: 'EMPLOYERS_LIABILITY', insurer: 'Aviva', limitMinor: 1_000_000_000, expiresOn: '2029-01-01' },
    ],
    safetyAccreditations: ['CHAS', 'Constructionline Gold'],
    qualityAccreditations: ['ISO 9001', 'ISO 45001', 'ISO 14001'],
    riddorLastThreeYears: 0,
    ramsCapability: { producesInHouse: true, sampleReviewed: true, sampleAcceptable: true },
    competenceCards: [{ scheme: 'CSCS', holders: 30, earliestExpiry: '2029-01-01' }],
    training: [{ qualification: 'SMSTS', holders: 3, earliestExpiry: '2030-01-01' }],
    references: [
      { clientName: 'A', projectName: 'P1', valueMinor: 2_000_000_00, verified: true, rating: 5 },
      { clientName: 'B', projectName: 'P2', valueMinor: 1_500_000_00, verified: true, rating: 4 },
      { clientName: 'C', projectName: 'P3', valueMinor: 900_000_00, verified: true, rating: 5 },
    ],
    capacity: { maxPackageValueMinor: 1_000_000_00, maxConcurrentPackages: 3, mobilisationDays: 10 },
    dayRates: [{ role: 'Groundworker', rateMinor: 220_00, quotedOn: '2026-06-01', basis: 'DAY' }],
    coverage: { regions: ['North West'], maxTravelMiles: 50 },
    performance: { packagesCompleted: 6, onTimePercent: 94, disputes: 0 },
    complianceConfirmed: true,
    ...over,
  });

  const assess = (over: Partial<supplychain.PrequalificationInput> = {}, packageValueMinor?: number) =>
    supplychain.assessPrequalification(submission(over), ['GROUNDWORKS'], {
      today: '2026-08-19',
      ...(packageValueMinor === undefined ? {} : { packageValueMinor }),
    });

  it('scales what it demands to the size of the package', () => {
    // The whole point of "where proportionate": a two-person firm bidding a
    // £15k package is not asked for three years of audited accounts.
    assert.equal(supplychain.scrutinyFor(15_000_00), 'LIGHT');
    assert.equal(supplychain.scrutinyFor(120_000_00), 'STANDARD');
    assert.equal(supplychain.scrutinyFor(900_000_00), 'ENHANCED');

    const bare: Partial<supplychain.PrequalificationInput> = {
      financial: {}, references: [], competenceCards: [], training: [],
      identity: { companyNumber: '09999999', companyStatus: 'active', incorporatedOn: '2020-01-01', cisStatus: 'GROSS' },
      capacity: { maxPackageValueMinor: 20_000_00 },
    };

    const small = assess(bare, 15_000_00);
    const large = assess(bare, 900_000_00);

    assert.equal(small.scrutiny, 'LIGHT');
    assert.deepEqual(small.missing, [], 'a small package demanded paperwork it has no business asking for');
    assert.equal(large.scrutiny, 'ENHANCED');
    assert.ok(large.missing.length > 5, 'a large package accepted a submission with nothing in it');
    assert.ok(large.missing.includes('Three years of turnover'));
    assert.ok(large.missing.includes('Credit reference'));
  });

  it('earns STRATEGIC on delivery rather than on paperwork', () => {
    const proven = assess();
    assert.equal(proven.status, 'STRATEGIC');
    assert.match(proven.rationale, /completed packages/);

    // Identical pack, no history with this business. Cannot be strategic.
    const unproven = assess({ performance: { packagesCompleted: 1, onTimePercent: 95, disputes: 0 } });
    assert.equal(unproven.status, 'APPROVED', 'a firm became strategic on paperwork alone');

    // Proven volume, but a dispute. Strategic is a relationship, not a count.
    const disputed = assess({ performance: { packagesCompleted: 9, onTimePercent: 95, disputes: 1 } });
    assert.notEqual(disputed.status, 'STRATEGIC');
  });

  it('drops to CONDITIONAL for anything worth watching, and says what', () => {
    const riddor = assess({ riddorLastThreeYears: 1 });
    assert.equal(riddor.status, 'CONDITIONAL');
    assert.ok(riddor.conditions.some((c) => c.includes('RIDDOR')));

    const outsourced = assess({ ramsCapability: { producesInHouse: false, sampleReviewed: true, sampleAcceptable: true } });
    assert.equal(outsourced.status, 'CONDITIONAL');
    assert.ok(outsourced.conditions.some((c) => c.includes('outsourced')));

    const unverified = assess({
      references: [{ clientName: 'A', projectName: 'P', valueMinor: 100_00, verified: false }],
    });
    assert.ok(unverified.conditions.some((c) => c.includes('none verified')));
  });

  it('flags a firm whose capacity is most of its year', () => {
    // One package should not be a firm's survival. Turnover £8m, capacity £5m.
    const stretched = assess({ capacity: { maxPackageValueMinor: 5_000_000_00 } });
    assert.ok(
      stretched.conditions.some((c) => c.includes('40%')),
      'a package worth most of the firm\'s turnover passed without comment',
    );
  });

  it('bars a dissolved company and an unresolved prohibition notice', () => {
    const dissolved = assess({
      identity: { companyNumber: '01234567', companyStatus: 'dissolved', incorporatedOn: '2006-04-01', cisStatus: 'GROSS' },
    });
    assert.equal(dissolved.status, 'DO_NOT_USE');
    assert.ok(dissolved.bars.some((b) => b.includes('dissolved')));

    const prohibited = assess({
      enforcementNotices: [{ type: 'PROHIBITION', issuedOn: '2026-05-01', resolved: false }],
    });
    assert.equal(prohibited.status, 'DO_NOT_USE');
    assert.ok(prohibited.bars.some((b) => b.includes('prohibition')));

    // A resolved improvement notice is a condition, not a bar.
    const improved = assess({ enforcementNotices: [{ type: 'IMPROVEMENT', issuedOn: '2025-01-01', resolved: true }] });
    assert.equal(improved.status, 'CONDITIONAL');
  });

  it('notices a CIS position that costs the subcontractor money', () => {
    const unregistered = assess({
      identity: { companyNumber: '01234567', companyStatus: 'active', incorporatedOn: '2006-04-01', vatNumber: 'GB1', utr: '1', cisStatus: 'UNREGISTERED' },
    });
    assert.ok(unregistered.conditions.some((c) => c.includes('higher rate')));
  });

  it('treats a stale day rate as a condition rather than a price', () => {
    const stale = assess({
      dayRates: [{ role: 'Groundworker', rateMinor: 180_00, quotedOn: '2024-01-01', basis: 'DAY' }],
    });
    assert.ok(stale.conditions.some((c) => c.includes('re-confirmed')));
  });

  it('keeps the whole submission, not just the verdict', () => {
    const qsCtx = ctxFor('qs');
    const suppliers = supplychain.findSuppliers(qsCtx, { trade: 'GROUNDWORKS' });
    const northstone = suppliers.find((s) => String(s.legalName).includes('Northstone'))!;

    // Searchable without reading the whole assessment.
    assert.ok(Array.isArray(northstone.dayRates) && (northstone.dayRates as unknown[]).length > 0);
    assert.ok(((northstone.labourByTrade as Record<string, number>).GROUNDWORKS ?? 0) > 0);
    assert.ok(Array.isArray(northstone.plant) && (northstone.plant as unknown[]).length > 0);

    // And the submission itself is on the record: what were we told, and when.
    const submitted = (northstone.prequalification as { submitted: Record<string, unknown> }).submitted;
    assert.ok(submitted.identity, 'the Companies House and tax identity was not kept');
    assert.ok(submitted.financial, 'the financial submission was not kept');
    assert.ok(submitted.references, 'the references were not kept');
  });

  it('classifies the seeded supply chain into three different tiers', () => {
    const coverage = supplychain.supplyChainCoverage(ctxFor('qs'));

    assert.equal(coverage.totals.strategic, 1, 'the proven firm should be strategic');
    assert.equal(coverage.totals.conditional, 1, 'the firm carrying a RIDDOR should be conditional');
    assert.ok(coverage.totals.approved >= 1);
  });
});

// ── 8b · Framework agreements ───────────────────────────────────────────────

/**
 * A framework is a standing relationship with an award rule, not a longer list.
 * Three things are worth testing and only three: that the size is arithmetic
 * rather than a round number somebody liked, that a framework place is gated on
 * the same prequalification an enquiry is, and that the award rule actually
 * distributes work — which is the governance failure frameworks are famous for.
 */
describe('8b · Framework agreements are sized, gated and rotated', () => {
  const admitted: string[] = [];
  let frameworkId: string;

  const prequalified = (legalName: string, trades: string[], maxPackageValueMinor = 2_000_000_00): string => {
    const { supplierId } = supplychain.registerSupplier(ctxFor('qs'), {
      legalName,
      trades,
      contactName: 'A person',
      contactEmail: `${legalName.replace(/\W/g, '').toLowerCase()}@example.com`,
    });
    supplychain.prequalifySupplier(ctxFor('pm'), supplierId, {
      identity: { companyNumber: '05550000', companyStatus: 'active', incorporatedOn: '2010-05-01', vatNumber: 'GB99', utr: '9999999999', cisStatus: 'GROSS' },
      financial: { turnoverMinorByYear: [12_000_000_00, 11_000_000_00], accountsFiledUpToDate: true },
      insurances: [
        { type: 'PUBLIC_LIABILITY', insurer: 'A', limitMinor: 1_000_000_000, expiresOn: '2030-01-01' },
        { type: 'EMPLOYERS_LIABILITY', insurer: 'A', limitMinor: 1_000_000_000, expiresOn: '2030-01-01' },
      ],
      safetyAccreditations: ['CHAS'],
      qualityAccreditations: ['ISO 9001'],
      riddorLastThreeYears: 0,
      competenceCards: [{ scheme: 'CSCS', holders: 20 }],
      references: [{ clientName: 'C', projectName: 'P', valueMinor: 1_500_000_00, verified: true }],
      capacity: { maxPackageValueMinor },
      complianceConfirmed: true,
      evidenceHash: hashEvidence(`pqq-${legalName}`),
    });
    return supplierId;
  };

  it('sizes the framework from the trades bought, not from a round number', () => {
    const small = framework.recommendFramework({
      annualTurnoverMinor: 12_000_000_00,
      projectTypes: ['RESIDENTIAL', 'REFURBISHMENT'],
    });

    // The user's own brief was "perhaps 50–100". That range should fall out of
    // the arithmetic for a typical regional contractor rather than be asserted.
    assert.equal(small.band.size, 'SMALL');
    assert.ok(small.recommendedSize >= 50 && small.recommendedSize <= 100, `expected 50–100, got ${small.recommendedSize}`);
    assert.ok(small.tradesInScope > 20, 'a residential and refurbishment contractor buys more than 20 trades');
    assert.ok(small.idealSize > small.recommendedSize, 'overlap between trades should reduce the headcount');
  });

  it('gives a fit-out contractor a smaller framework than a civils contractor', () => {
    const fitOut = framework.recommendFramework({ annualTurnoverMinor: 40_000_000_00, projectTypes: ['FIT_OUT'] });
    const civils = framework.recommendFramework({ annualTurnoverMinor: 40_000_000_00, projectTypes: ['CIVILS_INFRASTRUCTURE'] });

    assert.equal(fitOut.band.size, civils.band.size, 'same turnover, so the difference must be the work');
    assert.notEqual(fitOut.tradesInScope, civils.tradesInScope);
  });

  it('separates a large contractor from a Tier 1 on concurrency, not turnover alone', () => {
    const large = framework.recommendFramework({ annualTurnoverMinor: 300_000_000_00, projectTypes: ['HRB_RESIDENTIAL'] });
    const tier1 = framework.recommendFramework({ annualTurnoverMinor: 900_000_000_00, projectTypes: ['HRB_RESIDENTIAL'] });

    // Both need three quotes. The Tier 1 needs them on far more sites at once,
    // and no subcontractor can be on twenty of your sites simultaneously.
    assert.ok(tier1.concurrentProjects > large.concurrentProjects);
    assert.ok(tier1.recommendedSize > large.recommendedSize, 'scale must reach the framework size');
  });

  it('lets a business that knows its own site count override the band default', () => {
    const defaulted = framework.recommendFramework({ annualTurnoverMinor: 60_000_000_00, projectTypes: ['RESIDENTIAL'] });
    const busy = framework.recommendFramework({
      annualTurnoverMinor: 60_000_000_00,
      projectTypes: ['RESIDENTIAL'],
      concurrentProjects: 24,
    });

    assert.ok(busy.recommendedSize > defaulted.recommendedSize);
    throwsCode(
      () => framework.recommendFramework({ annualTurnoverMinor: 60_000_000_00, projectTypes: ['RESIDENTIAL'], concurrentProjects: 0 }),
      'CONCURRENT_PROJECTS_INVALID',
    );
    throwsCode(
      () => framework.recommendFramework({ annualTurnoverMinor: 60_000_000_00, projectTypes: [] }),
      'PROJECT_TYPES_REQUIRED',
    );
  });

  it('caps the recommendation at what the business can actually maintain', () => {
    const micro = framework.recommendFramework({
      annualTurnoverMinor: 3_000_000_00,
      projectTypes: ['HRB_RESIDENTIAL'],
    });

    assert.equal(micro.recommendedSize, micro.relationshipCapacity);
    assert.match(micro.rationale, /capped/);
  });

  it('refuses a framework that buys nothing or ends before it starts', () => {
    const pmCtx = ctxFor('pm');
    throwsCode(
      () => framework.createFramework(pmCtx, { name: 'Empty', startsOn: '2026-01-01', endsOn: '2029-01-01', lots: [], callOffMethod: 'ROTATION', paymentTerms: '30 days' }),
      'FRAMEWORK_EMPTY',
    );
    throwsCode(
      () =>
        framework.createFramework(pmCtx, {
          name: 'Backwards',
          startsOn: '2029-01-01',
          endsOn: '2026-01-01',
          lots: [{ reference: 'L1', trade: 'GROUNDWORKS', maxPackageValueMinor: 500_000_00, directAwardCeilingMinor: 25_000_00 }],
          callOffMethod: 'ROTATION',
          paymentTerms: '30 days',
        }),
      'FRAMEWORK_TERM_INVALID',
    );
  });

  it('refuses a direct-award ceiling that is no ceiling at all', () => {
    throwsCode(
      () =>
        framework.createFramework(ctxFor('pm'), {
          name: 'Open goal',
          startsOn: '2026-01-01',
          endsOn: '2029-01-01',
          lots: [{ reference: 'L1', trade: 'GROUNDWORKS', maxPackageValueMinor: 500_000_00, directAwardCeilingMinor: 900_000_00 }],
          callOffMethod: 'DIRECT_AWARD',
          paymentTerms: '30 days',
        }),
      'DIRECT_AWARD_CEILING_INVALID',
    );
  });

  it('creates a framework with lots against real trades', () => {
    const result = framework.createFramework(ctxFor('pm'), {
      name: 'Regional works framework 2026–2030',
      startsOn: '2026-01-01',
      endsOn: '2030-01-01',
      extensionMonths: 24,
      lots: [
        { reference: 'LOT-01', trade: 'GROUNDWORKS', maxPackageValueMinor: 1_500_000_00, directAwardCeilingMinor: 50_000_00 },
        { reference: 'LOT-02', trade: 'FIRE_STOPPING', maxPackageValueMinor: 400_000_00, directAwardCeilingMinor: 25_000_00 },
      ],
      callOffMethod: 'ROTATION',
      paymentTerms: '30 days from due date',
      retentionPercent: 3,
      targets: { localSmePercent: 60, maxSharePerSupplierPercent: 40 },
    });

    frameworkId = result.frameworkId;
    assert.equal(result.lots, 2);
    assert.match(result.reference, /^FW-\d{3}$/);
    assert.ok(framework.listFrameworks(ctxFor('pm')).some((f) => f.id === frameworkId));
  });

  it('refuses a lot against a trade that is not in the catalogue', () => {
    throwsCode(
      () =>
        framework.createFramework(ctxFor('pm'), {
          name: 'Invented',
          startsOn: '2026-01-01',
          endsOn: '2029-01-01',
          lots: [{ reference: 'L1', trade: 'TIME_TRAVEL', maxPackageValueMinor: 100_00, directAwardCeilingMinor: 100_00 }],
          callOffMethod: 'ROTATION',
          paymentTerms: '30 days',
        }),
      'TRADE_UNKNOWN',
    );
  });

  it('gates a framework place on the same prequalification an enquiry needs', () => {
    const pmCtx = ctxFor('pm');
    const { supplierId } = supplychain.registerSupplier(ctxFor('qs'), {
      legalName: 'Never Assessed Groundworks Ltd',
      trades: ['GROUNDWORKS'],
      contactName: 'A person',
      contactEmail: 'never@example.com',
    });

    // Registered but never prequalified. A framework place is worth more than a
    // single enquiry, so it must not be the weaker of the two routes in.
    throwsCode(
      () => framework.admitToFramework(pmCtx, frameworkId, { supplierId, lot: 'LOT-01', tier: 'LOCAL_SME' }),
      'SUPPLIER_NOT_ELIGIBLE_FOR_LOT',
    );
  });

  it('admits prequalified firms and refuses the same firm twice on one lot', () => {
    const pmCtx = ctxFor('pm');
    for (const name of ['Alpha Groundworks Ltd', 'Bravo Civils Ltd', 'Charlie Excavation Ltd']) {
      const supplierId = prequalified(name, ['GROUNDWORKS']);
      admitted.push(supplierId);
      framework.admitToFramework(pmCtx, frameworkId, { supplierId, lot: 'LOT-01', tier: 'LOCAL_SME' });
    }

    throwsCode(
      () => framework.admitToFramework(pmCtx, frameworkId, { supplierId: admitted[0]!, lot: 'LOT-01', tier: 'LOCAL_SME' }),
      'ALREADY_A_MEMBER',
    );
    throwsCode(
      () => framework.admitToFramework(pmCtx, frameworkId, { supplierId: admitted[0]!, lot: 'LOT-99', tier: 'LOCAL_SME' }),
      'LOT_NOT_FOUND',
    );
  });

  it('rotates work to whoever has had least of it', () => {
    const pmCtx = ctxFor('pm');

    const first = framework.callOff(pmCtx, frameworkId, { lot: 'LOT-01', packageValueMinor: 400_000_00, today: '2027-06-01' });
    assert.equal(first.method, 'ROTATION');
    assert.ok(first.competitive);
    assert.equal(first.invited.length, 3);

    framework.recordFrameworkAward(pmCtx, frameworkId, {
      supplierId: first.invited[0]!.supplierId,
      lot: 'LOT-01',
      valueMinor: 400_000_00,
      packageReference: 'PKG-001',
      evidenceHash: hashEvidence('award-001'),
    });

    const second = framework.callOff(pmCtx, frameworkId, { lot: 'LOT-01', packageValueMinor: 300_000_00, today: '2027-06-02' });
    assert.notEqual(second.invited[0]!.supplierId, first.invited[0]!.supplierId, 'the firm just awarded should not lead the next call-off');
    assert.equal(second.invited[0]!.awards, 0);
  });

  it('drops a suspended member out of the call-off without removing them', () => {
    const pmCtx = ctxFor('pm');
    supplychain.suspendSupplier(pmCtx, admitted[2]!, { reason: 'Insurance lapsed mid-term' });

    const result = framework.callOff(pmCtx, frameworkId, { lot: 'LOT-01', packageValueMinor: 200_000_00, today: '2027-07-01' });

    assert.ok(!result.invited.some((i) => i.supplierId === admitted[2]!));
    assert.equal(result.excluded.length, 1);
    assert.ok(!result.competitive, 'two eligible firms is not a competitive enquiry');
    assert.match(result.note, /below the 3 required/);

    // Still a member: suspension is not expulsion, and the record should say so.
    const position = framework.frameworkPosition(pmCtx, frameworkId, '2027-07-01');
    assert.equal(position.members, 3);
  });

  it('escalates a direct award above the lot ceiling into a competition', () => {
    const pmCtx = ctxFor('pm');
    const { frameworkId: directId } = framework.createFramework(pmCtx, {
      name: 'Small works',
      startsOn: '2026-01-01',
      endsOn: '2030-01-01',
      lots: [{ reference: 'SW-01', trade: 'DECORATING', maxPackageValueMinor: 200_000_00, directAwardCeilingMinor: 25_000_00 }],
      callOffMethod: 'DIRECT_AWARD',
      paymentTerms: '30 days',
    });

    for (const name of ['Delta Decorators Ltd', 'Echo Painting Ltd', 'Foxtrot Finishes Ltd']) {
      framework.admitToFramework(pmCtx, directId, {
        supplierId: prequalified(name, ['DECORATING']),
        lot: 'SW-01',
        tier: 'LOCAL_SME',
      });
    }

    const small = framework.callOff(pmCtx, directId, { lot: 'SW-01', packageValueMinor: 18_000_00, today: '2027-01-01' });
    assert.equal(small.method, 'DIRECT_AWARD');
    assert.equal(small.invited.length, 1);

    const large = framework.callOff(pmCtx, directId, { lot: 'SW-01', packageValueMinor: 120_000_00, today: '2027-01-01' });
    assert.equal(large.method, 'MINI_COMPETITION', 'the lot ceiling must beat the framework method');
    assert.equal(large.invited.length, 3);

    throwsCode(
      () => framework.callOff(pmCtx, directId, { lot: 'SW-01', packageValueMinor: 900_000_00, today: '2027-01-01' }),
      'PACKAGE_EXCEEDS_LOT',
    );
    throwsCode(
      () => framework.callOff(pmCtx, directId, { lot: 'SW-01', packageValueMinor: 10_000_00, today: '2031-01-01' }),
      'FRAMEWORK_EXPIRED',
    );
  });

  it('names the concentration and the empty lot rather than scoring the framework', () => {
    const pmCtx = ctxFor('pm');
    const position = framework.frameworkPosition(pmCtx, frameworkId, '2029-09-01');

    // LOT-02 was never populated: a lot nobody can bid is worse than no lot.
    assert.ok(position.thinLots.some((l) => l.lot === 'LOT-02' && l.eligible === 0));

    // One firm took the only award, so it holds 100% of framework value.
    assert.ok(position.concentration.some((c) => c.sharePercent === 100));
    assert.ok(position.warnings.some((w) => w.includes('above the 40% limit')));

    // Four months to run and two thirds of the members never used.
    assert.ok(position.warnings.some((w) => w.includes('Expires in')));
    assert.equal(position.neverAwarded.length, 2);
    assert.ok(position.warnings.some((w) => w.includes('never been awarded work')));

    assert.equal(position.byTier.LOCAL_SME, 3);
    assert.equal(position.localSmePercent, 100);
  });

  it('refuses an award to a firm that is not on the lot', () => {
    throwsCode(
      () =>
        framework.recordFrameworkAward(ctxFor('pm'), frameworkId, {
          supplierId: 'SUP-NOT-A-MEMBER',
          lot: 'LOT-01',
          valueMinor: 10_000_00,
          packageReference: 'PKG-X',
          evidenceHash: hashEvidence('nope'),
        }),
      'NOT_A_MEMBER',
    );
    throwsCode(() => framework.frameworkPosition(ctxFor('pm'), 'FW-DOES-NOT-EXIST'), 'FRAMEWORK_NOT_FOUND');
  });

  it('keeps every framework event in the catalogue and off the AI', () => {
    for (const code of ['FRAMEWORK_CREATED', 'FRAMEWORK_SUPPLIER_ADMITTED', 'FRAMEWORK_AWARD_RECORDED']) {
      const definition = lookupEventType(code);
      assert.ok(definition, `${code} is not in the catalogue`);
      assert.equal(definition.entity, 'Framework');
      assert.equal(definition.aiAllowed, false, `${code} must not be writable by a model`);
    }
    assert.equal(lookupEventType('FRAMEWORK_AWARD_RECORDED')!.requiresEvidence, true);
  });
});
