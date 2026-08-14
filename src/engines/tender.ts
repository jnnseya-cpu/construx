import { hashEvidence } from '../core/canonical.ts';
import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import type { EntityRef } from '../goldenthread/types.ts';
import { authorise, currentPhase, registerEvidence, runAI, write, type EngineContext } from './context.ts';
import {
  analyseReturnVariance,
  DEFAULT_PENALTY_PROFILE,
  evaluateBids,
  generateClarifications,
  type NormalisedLine,
  type PenaltyProfile,
  type SubmissionInput,
} from './maths/bidScoring.ts';

/**
 * Engine A — Tender & Commercial Intelligence (concept to contract award).
 *
 * The tender journey is a state machine, not a folder of spreadsheets:
 *
 *   takeoff -> schedule -> route split (market | self-price) -> package issue
 *   -> returns -> normalise -> compare -> adjudicate -> bid pack -> award
 *   -> contract
 *
 * Each transition emits a Golden Thread event, so the commercial basis of an
 * award can be reconstructed years later.
 */

export type TakeoffSource = { drawingRef?: EntityRef; modelRef?: EntityRef; sheetId?: string; discipline: string };

export type TakeoffItem = {
  description: string;
  unit: string;
  quantity: number;
  /** Where the quantity came from — the traceability link back to the sheet. */
  sourceSheet?: string;
  measurementRule?: string;
};

/**
 * Drawing-to-estimate bridge: extract measurable quantities from 2D sheets or a
 * model. Most contractors still price from 2D long before a model is usable, so
 * this path is first-class rather than a fallback.
 */
export async function runTakeoff(
  ctx: EngineContext,
  input: { packageId: string; sources: TakeoffSource[]; items: TakeoffItem[]; costCodePrefix: string },
): Promise<{ takeoffId: string; boqItemIds: string[]; acuConsumed: number }> {
  authorise(ctx, 'BOQ_TAKEOFF', 'C', { lifecyclePhase: currentPhase(ctx) });

  if (input.items.length === 0) {
    throw new DomainError('TAKEOFF_EMPTY', 'A take-off must contain at least one measured item');
  }

  const takeoffId = ulid();
  const evidence = registerEvidence(ctx, {
    type: 'TAKEOFF_SOURCE',
    hash: hashEvidence(JSON.stringify(input.sources)),
    description: `Take-off sources for package ${input.packageId}: ${input.sources.map((s) => s.discipline).join(', ')}`,
  });

  const boqItemIds: string[] = [];

  const result = await runAI(ctx, {
    engine: 'TENDER',
    taskType: 'quantity_extraction',
    // Reading drawings and models is perception work.
    capability: 'PERCEPTION',
    inputRefs: input.sources.flatMap((s) => [s.drawingRef, s.modelRef].filter((r): r is EntityRef => r !== undefined)),
    request: {
      task: 'Extract and classify measurable quantities, and rate confidence per item',
      payload: { packageId: input.packageId, sources: input.sources, items: input.items },
      responseSchema: {
        type: 'object',
        properties: { judgement: { type: 'number' }, classification: { type: 'string' } },
      },
    },
    toWrites: (output, confidence) => {
      const baseConfidence = confidence ?? 0.75;
      const writes: Array<{
        eventType: string;
        entity: EntityRef;
        nextState: Record<string, unknown>;
        evidenceRefs?: EntityRef[];
      }> = [
        {
          eventType: 'TAKEOFF_COMPLETED',
          entity: { refType: 'Takeoff', refId: takeoffId },
          nextState: {
            id: takeoffId,
            packageId: input.packageId,
            sources: input.sources,
            itemCount: input.items.length,
            method: input.sources.some((s) => s.modelRef) ? 'MODEL_BASED' : 'DRAWING_BASED',
            confidence: baseConfidence,
            completedAt: new Date().toISOString(),
          },
          evidenceRefs: [evidence],
        },
      ];

      input.items.forEach((item, index) => {
        const boqItemId = ulid();
        boqItemIds.push(boqItemId);
        writes.push({
          eventType: 'BOQITEM_CREATED_FROM_TAKEOFF',
          entity: { refType: 'BoQItem', refId: boqItemId },
          nextState: {
            id: boqItemId,
            takeoffId,
            packageId: input.packageId,
            costCode: `${input.costCodePrefix}.${String(index + 1).padStart(3, '0')}`,
            description: item.description,
            unit: item.unit,
            quantity: item.quantity,
            measurementRule: item.measurementRule ?? 'NRM2',
            source: input.sources.some((s) => s.modelRef) ? 'BIM' : '2D',
            sourceSheet: item.sourceSheet,
            // Confidence travels with the quantity: a downstream estimator can
            // see which lines were machine-measured and how sure the engine was.
            confidenceScore: Number((baseConfidence * (output.judgement ? 0.9 + Number(output.judgement) * 0.2 : 1)).toFixed(3)),
          },
          evidenceRefs: [evidence],
        });
      });

      return writes;
    },
  });

  return { takeoffId, boqItemIds, acuConsumed: result.acuConsumed };
}

export type EstimateLine = {
  boqItemId: string;
  description: string;
  unit: string;
  quantity: number;
  labourMinor: number;
  plantMinor: number;
  materialMinor: number;
  subcontractMinor: number;
};

/**
 * Bottom-up estimate: labour, plant, material, subcontract, prelims, overhead
 * and profit, plus explicit risk allowance. Risk is priced, not buried in a
 * percentage nobody can explain later.
 */
export function buildEstimate(
  ctx: EngineContext,
  input: {
    packageId: string;
    lines: EstimateLine[];
    prelimsPercent: number;
    overheadPercent: number;
    profitPercent: number;
    riskAllowanceMinor: number;
    basisOfEstimate: string;
    assumptions: string[];
  },
): { estimateId: string; totalMinor: number; breakdown: Record<string, number> } {
  authorise(ctx, 'ESTIMATE_TENDER', 'C', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const direct = input.lines.reduce(
    (totals, line) => ({
      labour: totals.labour + line.labourMinor,
      plant: totals.plant + line.plantMinor,
      material: totals.material + line.materialMinor,
      subcontract: totals.subcontract + line.subcontractMinor,
    }),
    { labour: 0, plant: 0, material: 0, subcontract: 0 },
  );

  const directTotal = direct.labour + direct.plant + direct.material + direct.subcontract;
  const prelims = Math.round(directTotal * (input.prelimsPercent / 100));
  const subtotal = directTotal + prelims + input.riskAllowanceMinor;
  const overhead = Math.round(subtotal * (input.overheadPercent / 100));
  const profit = Math.round((subtotal + overhead) * (input.profitPercent / 100));
  const total = subtotal + overhead + profit;

  const estimateId = ulid();
  const breakdown = {
    labourMinor: direct.labour,
    plantMinor: direct.plant,
    materialMinor: direct.material,
    subcontractMinor: direct.subcontract,
    prelimsMinor: prelims,
    riskAllowanceMinor: input.riskAllowanceMinor,
    overheadMinor: overhead,
    profitMinor: profit,
  };

  write(ctx, {
    eventType: 'ESTIMATE_CREATED',
    entity: { refType: 'Estimate', refId: estimateId },
    nextState: {
      id: estimateId,
      packageId: input.packageId,
      version: 1,
      status: 'DRAFT',
      basisOfEstimate: input.basisOfEstimate,
      assumptions: input.assumptions,
      lines: input.lines,
      breakdown,
      totalMinor: total,
      marginPercent: total === 0 ? 0 : Number(((profit / total) * 100).toFixed(2)),
    },
  });

  return { estimateId, totalMinor: total, breakdown };
}

/**
 * Freeze the estimate. After this point the priced position is immutable and
 * every later movement is a variation with its own audit trail.
 */
export function freezeEstimate(ctx: EngineContext, estimateId: string, reason: string): void {
  authorise(ctx, 'ESTIMATE_TENDER', 'A', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const record = ctx.ledger.require({ refType: 'Estimate', refId: estimateId });
  if (record.state.status === 'FROZEN') throw new DomainError('ESTIMATE_ALREADY_FROZEN', 'Estimate is already frozen');

  const evidence = registerEvidence(ctx, {
    type: 'ESTIMATE_FREEZE_AUTHORITY',
    hash: hashEvidence(`${estimateId}:${reason}:${ctx.auth.actorId}`),
    description: `Estimate freeze authorised: ${reason}`,
    linkedEntities: [{ refType: 'Estimate', refId: estimateId }],
  });

  write(ctx, {
    eventType: 'ESTIMATE_FROZEN',
    entity: { refType: 'Estimate', refId: estimateId },
    nextState: {
      ...record.state,
      status: 'FROZEN',
      frozenAt: new Date().toISOString(),
      frozenBy: ctx.auth.actorId,
      freezeReason: reason,
    },
    evidenceRefs: [evidence],
  });
}

export type ScheduleRoute = 'SUPPLY_CHAIN' | 'SELF_PRICE';

/**
 * Route split. Each schedule line goes either to the market or to self-perform,
 * and both routes converge again at master pricing.
 */
export function assignScheduleRoute(
  ctx: EngineContext,
  input: { scheduleId: string; packageId: string; route: ScheduleRoute; lines: NormalisedLine[]; rationale: string },
): void {
  authorise(ctx, 'ESTIMATE_TENDER', 'U', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const existing = ctx.ledger.get({ refType: 'PricingSchedule', refId: input.scheduleId });

  if (!existing) {
    write(ctx, {
      eventType: 'SCHEDULE_BUILT',
      entity: { refType: 'PricingSchedule', refId: input.scheduleId },
      nextState: {
        id: input.scheduleId,
        packageId: input.packageId,
        route: input.route,
        routeRationale: input.rationale,
        lines: input.lines,
        status: 'ROUTED',
      },
    });
    return;
  }

  write(ctx, {
    eventType: 'SCHEDULE_ROUTE_ASSIGNED',
    entity: { refType: 'PricingSchedule', refId: input.scheduleId },
    nextState: { ...existing.state, route: input.route, routeRationale: input.rationale, status: 'ROUTED' },
  });
}

/**
 * Tender package composer. A package is not a pricing sheet — it is the full
 * enquiry set, and an incomplete one produces incomparable returns.
 */
export async function composeTenderPackage(
  ctx: EngineContext,
  input: {
    rfqId: string;
    packageId: string;
    scopeNarrative: string;
    designResponsibilityMatrix: Array<{ element: string; responsibleParty: string }>;
    attendances: string[];
    paymentTerms: string;
    programmeRef?: EntityRef;
    documents: Array<{ name: string; ref: EntityRef }>;
  },
): Promise<{ packageRefId: string; completenessScore: number; missing: string[]; acuConsumed: number }> {
  authorise(ctx, 'PROCUREMENT_AWARD', 'C', { lifecyclePhase: currentPhase(ctx) });

  const packageRefId = ulid();

  // Completeness is scored against what a bidder actually needs to price.
  const checklist = [
    { key: 'scope', present: input.scopeNarrative.trim().length > 50, label: 'Package-specific scope of works' },
    { key: 'drm', present: input.designResponsibilityMatrix.length > 0, label: 'Design responsibility matrix' },
    { key: 'attendances', present: input.attendances.length > 0, label: 'Attendances schedule' },
    { key: 'payment', present: input.paymentTerms.trim().length > 0, label: 'Payment terms' },
    { key: 'programme', present: input.programmeRef !== undefined, label: 'Programme attachment' },
    { key: 'documents', present: input.documents.length > 0, label: 'Tender documents' },
  ];
  const missing = checklist.filter((c) => !c.present).map((c) => c.label);
  const completenessScore = Number((checklist.filter((c) => c.present).length / checklist.length).toFixed(3));

  const result = await runAI(ctx, {
    engine: 'TENDER',
    taskType: 'package_composition',
    capability: 'REASONING',
    inputRefs: input.documents.map((d) => d.ref),
    request: {
      task: 'Assess enquiry package completeness and draft the enquiry cover letter',
      payload: {
        packageId: input.packageId,
        scopeNarrative: input.scopeNarrative,
        designResponsibilityMatrix: input.designResponsibilityMatrix,
        attendances: input.attendances,
        missing,
      },
    },
    toWrites: (output) => [
      {
        eventType: 'TENDER_PACKAGE_COMPOSED',
        entity: { refType: 'TenderPackage', refId: packageRefId },
        nextState: {
          id: packageRefId,
          rfqId: input.rfqId,
          packageId: input.packageId,
          scopeNarrative: input.scopeNarrative,
          designResponsibilityMatrix: input.designResponsibilityMatrix,
          attendances: input.attendances,
          paymentTerms: input.paymentTerms,
          programmeRef: input.programmeRef,
          documents: input.documents,
          completenessScore,
          missingComponents: missing,
          enquiryLetterNarrative: String(output.narrative ?? ''),
          status: missing.length === 0 ? 'READY_TO_ISSUE' : 'INCOMPLETE',
        },
      },
    ],
  });

  return { packageRefId, completenessScore, missing, acuConsumed: result.acuConsumed };
}

/**
 * Tender return intelligence: normalise heterogeneous supplier formats, flag
 * variance, and generate the clarification questions that follow from it.
 */
export async function analyseReturns(
  ctx: EngineContext,
  input: {
    rfqId: string;
    baseline: NormalisedLine[];
    returns: Array<{ submissionId: string; supplierName: string; lines: NormalisedLine[] }>;
  },
): Promise<{
  findings: ReturnType<typeof analyseReturnVariance>;
  clarifications: ReturnType<typeof generateClarifications>;
  acuConsumed: number;
}> {
  authorise(ctx, 'PROCUREMENT_AWARD', 'X', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  // The comparison itself is deterministic; the model only characterises findings.
  const findings = analyseReturnVariance(input.baseline, input.returns);
  const clarifications = generateClarifications(findings);

  const result = await runAI(ctx, {
    engine: 'TENDER',
    taskType: 'return_variance_analysis',
    capability: 'REASONING',
    inputRefs: input.returns.map((r) => ({ refType: 'SupplierSubmission', refId: r.submissionId })),
    request: {
      task: 'Characterise tender return variance and rank commercial exposure',
      payload: { rfqId: input.rfqId, findings, returnCount: input.returns.length },
    },
    toWrites: (output) =>
      input.returns.map((r) => {
        const record = ctx.ledger.require({ refType: 'SupplierSubmission', refId: r.submissionId });
        return {
          eventType: 'SUBMISSION_NORMALISED',
          entity: { refType: 'SupplierSubmission', refId: r.submissionId },
          nextState: {
            ...record.state,
            normalisedLines: r.lines,
            varianceFindings: findings.filter((f) => f.suppliersAffected.includes(r.supplierName)),
            normalisedAt: new Date().toISOString(),
            analysisNarrative: String(output.narrative ?? ''),
          },
        };
      }),
  });

  return { findings, clarifications, acuConsumed: result.acuConsumed };
}

/**
 * Evaluate bids. Scoring is fully deterministic and reproducible — an award
 * that cannot be recomputed is an award that cannot be defended.
 */
export function evaluateSubmissions(
  ctx: EngineContext,
  input: {
    rfqId: string;
    submissions: SubmissionInput[];
    profile?: PenaltyProfile;
    designMaturityScore?: number;
    packageLabourDemand?: number;
  },
): { evaluationId: string; result: ReturnType<typeof evaluateBids> } {
  authorise(ctx, 'PROCUREMENT_AWARD', 'U', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const rfq = ctx.ledger.require({ refType: 'RFQ', refId: input.rfqId });
  if (rfq.state.status !== 'RETURNS_RECEIVED' && rfq.state.status !== 'ISSUED') {
    throw new DomainError('RFQ_NOT_EVALUABLE', `RFQ status ${String(rfq.state.status)} does not permit evaluation`);
  }

  const result = evaluateBids(input.submissions, input.profile ?? DEFAULT_PENALTY_PROFILE, {
    designMaturityScore: input.designMaturityScore,
    packageLabourDemand: input.packageLabourDemand,
  });

  const evaluationId = ulid();
  const evidence = registerEvidence(ctx, {
    type: 'BID_EVALUATION_INPUTS',
    hash: hashEvidence(JSON.stringify({ submissions: input.submissions, profile: input.profile?.id ?? 'default-v1' })),
    description: `Evaluation inputs for RFQ ${input.rfqId} (${input.submissions.length} submissions)`,
  });

  write(ctx, {
    eventType: 'BIDS_EVALUATED',
    entity: { refType: 'BidEvaluation', refId: evaluationId },
    nextState: {
      id: evaluationId,
      rfqId: input.rfqId,
      profileId: result.profileId,
      method: result.method,
      scores: result.scores,
      recommendedSubmissionId: result.recommendedSubmissionId,
      recommendation: result.recommendation,
      clarificationRequired: result.clarificationRequired,
      evaluatedAt: new Date().toISOString(),
      evaluatedBy: ctx.auth.actorId,
    },
    evidenceRefs: [evidence],
  });

  return { evaluationId, result };
}

/** Adjudication: the commercial decision that closes the evaluation. */
export function adjudicate(
  ctx: EngineContext,
  input: { evaluationId: string; selectedSubmissionId: string; buyoutTargetMinor: number; rationale: string },
): { adjudicationId: string } {
  authorise(ctx, 'PROCUREMENT_AWARD', 'A', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const evaluation = ctx.ledger.require({ refType: 'BidEvaluation', refId: input.evaluationId });
  const scores = evaluation.state.scores as Array<{ submissionId: string; blockedFromAward: boolean; supplierName: string }>;
  const selected = scores.find((s) => s.submissionId === input.selectedSubmissionId);

  if (!selected) throw new DomainError('SUBMISSION_NOT_IN_EVALUATION', 'Selected submission was not part of this evaluation');
  if (selected.blockedFromAward) {
    throw new DomainError(
      'AWARD_BLOCKED',
      `${selected.supplierName} has blocking conditions (e.g. insurance gaps) that must be cleared before award`,
    );
  }

  const adjudicationId = ulid();
  const evidence = registerEvidence(ctx, {
    type: 'ADJUDICATION_RATIONALE',
    hash: hashEvidence(`${input.evaluationId}:${input.selectedSubmissionId}:${input.rationale}`),
    description: `Adjudication rationale: ${input.rationale}`,
    linkedEntities: [{ refType: 'BidEvaluation', refId: input.evaluationId }],
  });

  write(ctx, {
    eventType: 'ADJUDICATION_COMPLETED',
    entity: { refType: 'Adjudication', refId: adjudicationId },
    nextState: {
      id: adjudicationId,
      evaluationId: input.evaluationId,
      selectedSubmissionId: input.selectedSubmissionId,
      buyoutTargetMinor: input.buyoutTargetMinor,
      rationale: input.rationale,
      // Deviating from the computed recommendation is allowed but always visible.
      deviatedFromRecommendation: evaluation.state.recommendedSubmissionId !== input.selectedSubmissionId,
      adjudicatedAt: new Date().toISOString(),
      adjudicatedBy: ctx.auth.actorId,
    },
    evidenceRefs: [evidence],
  });

  return { adjudicationId };
}

/**
 * Bid submission pack: assemble, order and lock the outgoing bid. The locked
 * archive is hash-sealed so the submitted position can be proven later.
 */
export function compileBidPack(
  ctx: EngineContext,
  input: {
    rfqId: string;
    estimateId: string;
    submissionLetter: string;
    qualifications: string[];
    exclusions: string[];
    prelimsNarrative: string;
    attachments: Array<{ name: string; ref: EntityRef }>;
  },
): { packId: string; contentHash: string } {
  authorise(ctx, 'ESTIMATE_TENDER', 'A', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const estimate = ctx.ledger.require({ refType: 'Estimate', refId: input.estimateId });
  if (estimate.state.status !== 'FROZEN') {
    throw new DomainError('ESTIMATE_NOT_FROZEN', 'The estimate must be frozen before a bid pack can be compiled');
  }

  const packId = ulid();
  const assembly = {
    order: [
      'Submission letter',
      'Pricing schedules',
      'Qualifications and clarifications',
      'Exclusions',
      'Programme',
      'Prelims narrative',
      'Technical response attachments',
    ],
    submissionLetter: input.submissionLetter,
    qualifications: input.qualifications,
    exclusions: input.exclusions,
    prelimsNarrative: input.prelimsNarrative,
    attachments: input.attachments,
    estimateTotalMinor: estimate.state.totalMinor,
  };

  const contentHash = hashEvidence(JSON.stringify(assembly));
  const evidence = registerEvidence(ctx, {
    type: 'BID_PACK_ARCHIVE',
    hash: contentHash,
    description: `Locked bid submission pack for RFQ ${input.rfqId}`,
    linkedEntities: [{ refType: 'Estimate', refId: input.estimateId }],
  });

  write(ctx, {
    eventType: 'BID_PACK_COMPILED',
    entity: { refType: 'BidSubmissionPack', refId: packId },
    nextState: {
      id: packId,
      rfqId: input.rfqId,
      estimateId: input.estimateId,
      assembly,
      contentHash,
      status: 'COMPILED',
      compiledAt: new Date().toISOString(),
    },
    evidenceRefs: [evidence],
  });

  write(ctx, {
    eventType: 'BID_PACK_LOCKED',
    entity: { refType: 'BidSubmissionPack', refId: packId },
    nextState: {
      id: packId,
      rfqId: input.rfqId,
      estimateId: input.estimateId,
      assembly,
      contentHash,
      status: 'LOCKED',
      compiledAt: new Date().toISOString(),
      lockedAt: new Date().toISOString(),
      lockedBy: ctx.auth.actorId,
    },
    evidenceRefs: [evidence],
  });

  return { packId, contentHash };
}
