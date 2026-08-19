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
import { costHead, priceEstimate, reprice, type CostModelInput, type PricedEstimate } from './maths/costModel.ts';
import {
  cashflowScoreFor,
  modelFunding,
  type FundingModel,
  type PaymentTerms,
  type SupplyTerms,
  type VatTreatment,
} from './maths/funding.ts';

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

export type EstimateInput = CostModelInput & {
  packageId: string;
  basisOfEstimate: string;
  assumptions: string[];
};

/**
 * Bottom-up estimate across the twenty tender cost heads.
 *
 * The arithmetic lives in `maths/costModel.ts` and every head is priced on the
 * basis it actually has — time-related costs by the week, contingency from the
 * risk register at P80, inflation on the exposed spend after the base date, and
 * margin on the cost beneath it. Nothing here derives prelims from a percentage
 * of works, because that is the single most reliable way to lose money on a job
 * whose programme moves.
 *
 * A head that is neither priced nor excluded comes back as an omission and the
 * estimate is marked incomplete. A zero against waste is not a job with no
 * waste in it.
 */
export function buildEstimate(
  ctx: EngineContext,
  input: EstimateInput,
): {
  estimateId: string;
  totalMinor: number;
  breakdown: Record<string, number>;
  priced: PricedEstimate;
} {
  authorise(ctx, 'ESTIMATE_TENDER', 'C', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  if (input.lines.length === 0) {
    throw new DomainError('ESTIMATE_EMPTY', 'An estimate must price at least one measured line');
  }

  const priced = priceEstimate(input);

  // Flat by head, so a projection or an export can read a total without
  // walking the build-up.
  const breakdown = Object.fromEntries(priced.heads.map((h) => [`${h.head.toLowerCase()}Minor`, h.amountMinor]));

  const estimateId = ulid();

  write(ctx, {
    eventType: 'ESTIMATE_CREATED',
    entity: { refType: 'Estimate', refId: estimateId },
    nextState: {
      id: estimateId,
      packageId: input.packageId,
      version: 1,
      status: priced.omissions.length === 0 ? 'DRAFT' : 'INCOMPLETE',
      basisOfEstimate: input.basisOfEstimate,
      assumptions: input.assumptions,
      durationWeeks: input.durationWeeks,
      lines: input.lines,
      // The inputs are kept alongside the result. An estimate you cannot
      // recompute is a number, not an estimate — and repricing against a moved
      // programme needs the weekly rates, not the weekly totals.
      model: input,
      heads: priced.heads,
      subtotals: priced.subtotals,
      benchmarks: priced.benchmarks,
      omissions: priced.omissions,
      exclusions: priced.exclusions,
      warnings: priced.warnings,
      breakdown,
      totalMinor: priced.tenderTotalMinor,
      marginPercent: priced.marginPercent,
    },
  });

  return { estimateId, totalMinor: priced.tenderTotalMinor, breakdown, priced };
}

/**
 * What this estimate becomes on a different programme.
 *
 * The question every contractor is asked after award and few can answer
 * quickly. It is answerable at all only because the time-related heads were
 * priced by the week rather than as a percentage — the same reason a slipped
 * programme is a known number here instead of a surprise at final account.
 *
 * This computes and returns; it writes nothing, because a what-if is not a
 * commercial position.
 */
export function repriceEstimate(
  ctx: EngineContext,
  estimateId: string,
  durationWeeks: number,
): { originalWeeks: number; durationWeeks: number; originalTotalMinor: number; totalMinor: number; deltaMinor: number; priced: PricedEstimate } {
  authorise(ctx, 'ESTIMATE_TENDER', 'R', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  if (durationWeeks <= 0) throw new DomainError('DURATION_INVALID', 'A programme must be at least one week');

  const record = ctx.ledger.require({ refType: 'Estimate', refId: estimateId });
  const model = record.state.model as CostModelInput | undefined;
  if (!model || model.durationWeeks === undefined) {
    throw new DomainError('ESTIMATE_NOT_TIME_BASED', 'This estimate carries no programme, so it cannot be repriced against one');
  }

  const priced = reprice(model, durationWeeks);
  const originalTotalMinor = Number(record.state.totalMinor);

  return {
    originalWeeks: model.durationWeeks,
    durationWeeks,
    originalTotalMinor,
    totalMinor: priced.tenderTotalMinor,
    deltaMinor: priced.tenderTotalMinor - originalTotalMinor,
    priced,
  };
}

// --- Cash flow and peak funding -----------------------------------------------------

/**
 * Model the cash this tender needs before it earns anything.
 *
 * Never bid without this. A contract can cover its cost, carry a healthy margin
 * and still take more working capital than the business has — and the estimate,
 * which is a statement about cost rather than about cash, will not say so. The
 * peak funding requirement is a different question from the margin and it is
 * the one that closes companies.
 *
 * The cost profile is read from the estimate rather than typed again, so the
 * cash model cannot drift from the price. The heads are regrouped by *how each
 * is paid* rather than by what it buys: labour weekly whatever happens,
 * materials on supplier terms with a deposit in front, packages on subcontract
 * terms, everything else on ordinary credit.
 */
export function modelTenderFunding(
  ctx: EngineContext,
  estimateId: string,
  input: {
    payment: PaymentTerms;
    supply: SupplyTerms;
    vat: VatTreatment;
    /** Spent before anybody is productive: hoarding, cabins, bonds, deposits. */
    mobilisationMinor?: number;
    availableWorkingCapitalMinor?: number;
    /** Overrides the estimate's programme, for testing a different duration. */
    durationWeeks?: number;
  },
): FundingModel & { fundingId: string; estimateId: string; suggestedCashflowScore?: number } {
  authorise(ctx, 'BUDGET_COST', 'U', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const record = ctx.ledger.require({ refType: 'Estimate', refId: estimateId });
  const heads = record.state.heads as Array<{ head: string; amountMinor: number }> | undefined;
  if (!heads) {
    throw new DomainError('ESTIMATE_NOT_PRICED', 'This estimate carries no cost heads to build a cash model from');
  }

  const amount = (head: string): number => heads.find((h) => h.head === head)?.amountMinor ?? 0;
  const durationWeeks = input.durationWeeks ?? Number(record.state.durationWeeks ?? 0);
  if (!durationWeeks) {
    throw new DomainError('ESTIMATE_NOT_TIME_BASED', 'This estimate carries no programme, so its cash flow cannot be timed');
  }

  // Grouped by payment behaviour, not by cost head. Everything site-wide and
  // quantified is bought on ordinary supplier credit; only labour, materials
  // and packages behave differently enough to model separately.
  const onSupplierCredit = [
    'PLANT', 'PRELIMINARIES', 'SITE_MANAGEMENT', 'LOGISTICS', 'HEALTH_AND_SAFETY',
    'QUALITY', 'TEMPORARY_WORKS', 'TESTING', 'COMMISSIONING', 'WASTE',
    'DESIGN', 'PROFESSIONAL_FEES', 'INSURANCE',
  ].reduce((sum, head) => sum + amount(head), 0);

  const model = modelFunding({
    contractValueMinor: Number(record.state.totalMinor),
    durationWeeks,
    cost: {
      labourMinor: amount('DIRECT_WORKS'),
      materialsMinor: amount('MATERIALS'),
      subcontractMinor: amount('SUBCONTRACT'),
      plantAndPrelimsMinor: onSupplierCredit,
      mobilisationMinor: input.mobilisationMinor ?? 0,
      // Overhead is recovered evenly across the job rather than drawn in a lump.
      weeklyOverheadMinor: Math.round(amount('OVERHEAD') / durationWeeks),
    },
    payment: input.payment,
    supply: input.supply,
    vat: input.vat,
    availableWorkingCapitalMinor: input.availableWorkingCapitalMinor,
  });

  const suggestedCashflowScore =
    input.availableWorkingCapitalMinor === undefined
      ? undefined
      : cashflowScoreFor(model.peakFundingRequirementMinor, input.availableWorkingCapitalMinor);

  const fundingId = ulid();
  write(ctx, {
    eventType: 'TENDER_FUNDING_MODELLED',
    entity: { refType: 'FundingModel', refId: fundingId },
    nextState: {
      id: fundingId,
      estimateId,
      contractValueMinor: Number(record.state.totalMinor),
      durationWeeks,
      peakFundingRequirementMinor: model.peakFundingRequirementMinor,
      peakWeek: model.peakWeek,
      weeksNegative: model.weeksNegative,
      marginMinor: model.marginMinor,
      marginPercent: model.marginPercent,
      returnOnPeakFunding: model.returnOnPeakFunding,
      retentionHeldMinor: model.retentionHeldMinor,
      finalRetentionWeek: model.finalRetentionWeek,
      verdict: model.verdict,
      availableWorkingCapitalMinor: model.availableWorkingCapitalMinor,
      headroomMinor: model.headroomMinor,
      remedies: model.remedies,
      warnings: model.warnings,
      // The weekly series is the working, and an auditor asking why a bid was
      // refused on cash rather than on price needs to see it.
      periods: model.periods,
      terms: { payment: input.payment, supply: input.supply, vat: input.vat },
      suggestedCashflowScore,
      modelledAt: new Date().toISOString(),
      modelledBy: ctx.auth.actorId,
    },
  });

  return { ...model, fundingId, estimateId, suggestedCashflowScore };
}

// --- Automatic tender response ----------------------------------------------------

export type TenderEnquiry = {
  /** The client's own reference for the enquiry. */
  clientReference: string;
  clientName: string;
  projectTitle: string;
  /** Form of contract the client is proposing. */
  contractForm: string;
  returnBy: string;
  scopeNarrative: string;
  /** What the client has actually sent, and at what revision. */
  documents: Array<{ name: string; revision?: string; ref?: EntityRef }>;
  /** Employer's requirements the response must answer, in the client's words. */
  employerRequirements?: string[];
  /** Elements the client expects the contractor to design. */
  contractorDesignedPortions?: string[];
};

export type TenderResponse = {
  responseId: string;
  estimateId: string;
  tenderTotalMinor: number;
  /** Qualifications and exclusions, ready to go in front of the client. */
  qualifications: string[];
  exclusions: string[];
  /** Things the enquiry did not tell us that we had to assume. */
  assumptionsMade: string[];
  /** Questions that should go back as tender queries before the return date. */
  tenderQueries: string[];
  submissionLetter: string;
  /** Whether this is fit to submit, and if not, why not. */
  readyToSubmit: boolean;
  blockers: string[];
  acuConsumed: number;
};

/** Enquiry components a bidder needs before a price means anything. */
const ENQUIRY_CHECKLIST = [
  { key: 'scope', label: 'Scope of works', present: (e: TenderEnquiry) => e.scopeNarrative.trim().length > 50 },
  { key: 'documents', label: 'Tender drawings and specification', present: (e: TenderEnquiry) => e.documents.length > 0 },
  { key: 'revisions', label: 'Document revisions', present: (e: TenderEnquiry) => e.documents.every((d) => Boolean(d.revision)) },
  { key: 'contract', label: 'Form of contract', present: (e: TenderEnquiry) => e.contractForm.trim().length > 0 },
  { key: 'return', label: 'Return date', present: (e: TenderEnquiry) => e.returnBy.trim().length > 0 },
  { key: 'requirements', label: "Employer's requirements", present: (e: TenderEnquiry) => (e.employerRequirements ?? []).length > 0 },
];

/**
 * Respond to a client enquiry: price it, qualify it, and draft the letter.
 *
 * The division of labour is the same one the platform applies everywhere. The
 * money is arithmetic — the cost model prices twenty heads on the basis each
 * one has, and the model never touches a number. What the model does is the
 * writing: turning an unpriced head into an exclusion a client will accept, an
 * unanswerable gap in the enquiry into a tender query, and the whole thing into
 * a covering letter.
 *
 * The response refuses to call itself submittable while a cost head is neither
 * priced nor excluded. That is the failure this is built to prevent: a bid that
 * looks complete, prices twenty-two of twenty-three items, and wins because of
 * the one it forgot.
 */
export async function respondToTender(
  ctx: EngineContext,
  input: { enquiry: TenderEnquiry; estimate: EstimateInput },
): Promise<TenderResponse> {
  authorise(ctx, 'ESTIMATE_TENDER', 'C', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  // 1 — Price it. Deterministic, and committed before anything is drafted, so
  // the words are written against a number that already exists on the ledger.
  const built = buildEstimate(ctx, input.estimate);
  const priced = built.priced;

  // 2 — What the enquiry itself failed to provide.
  const enquiryGaps = ENQUIRY_CHECKLIST.filter((c) => !c.present(input.enquiry)).map((c) => c.label);

  const responseId = ulid();
  const unpricedLabels = priced.omissions.map((head) => costHead(head)?.label ?? head);

  const result = await runAI(ctx, {
    engine: 'TENDER',
    taskType: 'tender_response',
    capability: 'REASONING',
    inputRefs: input.enquiry.documents.map((d) => d.ref).filter((r): r is EntityRef => r !== undefined),
    request: {
      task:
        'Draft the qualifications, exclusions, tender queries and covering letter for this bid. ' +
        'Do not state, adjust or infer any price: the commercial figures are fixed and supplied.',
      payload: {
        enquiry: input.enquiry,
        enquiryGaps,
        headsPriced: priced.heads.filter((h) => h.status === 'PRICED').map((h) => h.label),
        headsExcluded: priced.exclusions,
        headsUnpriced: unpricedLabels,
        assumptions: input.estimate.assumptions,
        basisOfEstimate: input.estimate.basisOfEstimate,
        warnings: priced.warnings,
        contractForm: input.enquiry.contractForm,
        contractorDesignedPortions: input.enquiry.contractorDesignedPortions ?? [],
      },
    },
    toWrites: (output) => [
      {
        eventType: 'TENDER_RESPONSE_DRAFTED',
        entity: { refType: 'TenderResponse', refId: responseId },
        nextState: {
          id: responseId,
          estimateId: built.estimateId,
          clientReference: input.enquiry.clientReference,
          clientName: input.enquiry.clientName,
          projectTitle: input.enquiry.projectTitle,
          contractForm: input.enquiry.contractForm,
          returnBy: input.enquiry.returnBy,
          enquiryGaps,
          qualifications: asStrings(output.qualifications),
          exclusions: priced.exclusions.map((e) => `${e.label}: ${e.reason}`),
          assumptionsMade: asStrings(output.assumptionsMade),
          tenderQueries: asStrings(output.tenderQueries),
          submissionLetter: String(output.narrative ?? output.submissionLetter ?? ''),
          tenderTotalMinor: priced.tenderTotalMinor,
          unpricedHeads: priced.omissions,
          status: priced.omissions.length === 0 ? 'DRAFTED' : 'INCOMPLETE',
          draftedAt: new Date().toISOString(),
        },
      },
    ],
  });

  // 3 — The blockers are computed here, not asked of the model. Whether a bid
  // is fit to submit is not a matter of opinion.
  const blockers: string[] = [];
  if (priced.omissions.length > 0) {
    blockers.push(`${unpricedLabels.length} cost head(s) neither priced nor excluded: ${unpricedLabels.join(', ')}`);
  }
  if (enquiryGaps.length > 0) {
    blockers.push(`The enquiry is incomplete: ${enquiryGaps.join(', ')}`);
  }
  if (priced.subtotals.profitMinor <= 0) {
    blockers.push('The build-up carries no profit');
  }

  const drafted = ctx.ledger.require({ refType: 'TenderResponse', refId: responseId });

  return {
    responseId,
    estimateId: built.estimateId,
    tenderTotalMinor: priced.tenderTotalMinor,
    qualifications: asStrings(drafted.state.qualifications),
    exclusions: asStrings(drafted.state.exclusions),
    assumptionsMade: asStrings(drafted.state.assumptionsMade),
    // A gap in the enquiry is a question for the client, always — whatever the
    // model came back with, the checklist findings go out.
    tenderQueries: [...enquiryGaps.map((g) => `Please confirm: ${g} was not included in the enquiry.`), ...asStrings(drafted.state.tenderQueries)],
    submissionLetter: String(drafted.state.submissionLetter ?? ''),
    readyToSubmit: blockers.length === 0,
    blockers,
    acuConsumed: result.acuConsumed,
  };
}

function asStrings(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter((v) => v.trim().length > 0);
  if (typeof value === 'string' && value.trim().length > 0) return [value];
  return [];
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
