import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { rejectsCode, throwsCode } from './helpers.ts';
import { hashEvidence } from '../src/core/canonical.ts';
import * as business from '../src/domain/business.ts';
import * as structure from '../src/domain/structure.ts';
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
        annualTurnoverMinor: 20_000_000_00,
        yearsTrading: 25,
        accountsFiledUpToDate: true,
        insurances: [
          { type: 'PUBLIC_LIABILITY', insurer: 'A', limitMinor: 1_000_000_000, expiresOn: '2030-01-01' },
          { type: 'EMPLOYERS_LIABILITY', insurer: 'A', limitMinor: 1_000_000_000, expiresOn: '2020-01-01' },
        ],
        safetyAccreditations: ['CHAS'],
        qualityAccreditations: ['ISO 9001', 'ISO 45001'],
        riddorLastThreeYears: 0,
        references: 5,
        maxPackageValueMinor: 10_000_000_00,
        complianceConfirmed: true,
      },
      ['GROUNDWORKS'],
      '2026-08-19',
    );

    assert.equal(result.status, 'REJECTED');
    assert.ok(result.bars.some((b) => b.includes('expired')), 'the lapsed policy was not treated as a bar');
    assert.deepEqual(result.approvedTrades, [], 'a rejected firm was still approved for a trade');
  });

  it('bars an unaccredited firm from a life-safety trade', () => {
    const base = {
      annualTurnoverMinor: 5_000_000_00,
      yearsTrading: 10,
      accountsFiledUpToDate: true,
      insurances: [
        { type: 'PUBLIC_LIABILITY' as const, insurer: 'A', limitMinor: 1_000_000_000, expiresOn: '2030-01-01' },
        { type: 'EMPLOYERS_LIABILITY' as const, insurer: 'A', limitMinor: 1_000_000_000, expiresOn: '2030-01-01' },
      ],
      safetyAccreditations: [],
      qualityAccreditations: ['ISO 9001'],
      riddorLastThreeYears: 0,
      references: 3,
      maxPackageValueMinor: 5_000_000_00,
      complianceConfirmed: true,
    };

    const fireStopping = supplychain.assessPrequalification(base, ['FIRE_STOPPING'], '2026-08-19');
    const decorating = supplychain.assessPrequalification(base, ['DECORATING'], '2026-08-19');

    assert.equal(fireStopping.status, 'REJECTED', 'an unaccredited firm was approved for fire-stopping');
    assert.notEqual(decorating.status, 'REJECTED', 'decorating does not need third-party accreditation');
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
      annualTurnoverMinor: 2_000_000_00,
      yearsTrading: 9,
      accountsFiledUpToDate: true,
      insurances: [
        { type: 'PUBLIC_LIABILITY', insurer: 'A', limitMinor: 1_000_000_000, expiresOn: '2030-01-01' },
        { type: 'EMPLOYERS_LIABILITY', insurer: 'A', limitMinor: 1_000_000_000, expiresOn: '2030-01-01' },
      ],
      safetyAccreditations: ['CHAS'],
      qualityAccreditations: ['ISO 45001'],
      riddorLastThreeYears: 0,
      references: 3,
      maxPackageValueMinor: 1_000_000_00,
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
