import { hashEvidence } from '../core/canonical.ts';
import { DomainError } from '../core/errors.ts';
import { formatRef, ulid } from '../core/ids.ts';
import type { EntityRef } from '../goldenthread/types.ts';
import { replayTimeline } from '../goldenthread/replay.ts';
import { authorise, currentPhase, registerEvidence, runAI, write, type EngineContext } from './context.ts';
import { assessClaim, attributeDelay, CAUSE_LIABILITY, type DelayCause, type DelayEventInput } from './maths/claims.ts';
import {
  assessCostsProvision,
  assessProcedure,
  buildTimetable,
  type DisputeTimetable,
  type ProcedureFinding,
} from './maths/adjudication.ts';

/**
 * Engine F — Contracts, Change & Claims.
 *
 * Change is treated as a chain rather than a form: origin, notice, impact
 * assessment, instruction, valuation, and the downstream effect on every
 * affected package. Because every link is a Golden Thread event with a
 * timestamp and a hash, a claim becomes an exercise in reading the record.
 */

export type ContractSuite = 'JCT' | 'NEC4' | 'FIDIC' | 'ICHEME' | 'MF1' | 'BESPOKE';

export function createContract(
  ctx: EngineContext,
  input: {
    suite: ContractSuite;
    form: string;
    parties: Array<{ role: string; partyId: string; name: string }>;
    contractSumMinor: number;
    commencementDate: string;
    completionDate: string;
    liquidatedDamagesPerDayMinor: number;
    ldCapPercent: number;
    retentionPercent: number;
    defectsLiabilityMonths: number;
    /** Where the bid came from, if this contract was converted from a tender. */
    sourceBidPackId?: string;
  },
): { contractId: string } {
  authorise(ctx, 'CONTRACTS_CLAIMS', 'C', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'LEGAL_L4' });

  const contractId = ulid();
  write(ctx, {
    eventType: 'CONTRACT_CREATED',
    entity: { refType: 'Contract', refId: contractId },
    nextState: {
      id: contractId,
      projectId: ctx.projectId,
      suite: input.suite,
      form: input.form,
      parties: input.parties,
      contractSumMinor: input.contractSumMinor,
      commencementDate: input.commencementDate,
      completionDate: input.completionDate,
      liquidatedDamagesPerDayMinor: input.liquidatedDamagesPerDayMinor,
      ldCapPercent: input.ldCapPercent,
      ldCapMinor: Math.round(input.contractSumMinor * (input.ldCapPercent / 100)),
      retentionPercent: input.retentionPercent,
      defectsLiabilityMonths: input.defectsLiabilityMonths,
      sourceBidPackId: input.sourceBidPackId,
      status: 'DRAFT',
      createdAt: new Date().toISOString(),
    },
  });

  return { contractId };
}

/**
 * Bid-to-contract conversion. Carries the frozen commercial position forward so
 * nobody re-keys it — re-entry is where exclusions and qualifications get lost.
 */
export function convertBidToContract(
  ctx: EngineContext,
  input: {
    bidPackId: string;
    suite: ContractSuite;
    form: string;
    parties: Array<{ role: string; partyId: string; name: string }>;
    commencementDate: string;
    completionDate: string;
    liquidatedDamagesPerDayMinor: number;
    ldCapPercent: number;
    retentionPercent: number;
    defectsLiabilityMonths: number;
  },
): { contractId: string; contractSumMinor: number; carriedQualifications: string[] } {
  authorise(ctx, 'CONTRACTS_CLAIMS', 'C', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'LEGAL_L4' });

  const pack = ctx.ledger.require({ refType: 'BidSubmissionPack', refId: input.bidPackId });
  if (pack.state.status !== 'LOCKED') {
    throw new DomainError('BID_PACK_NOT_LOCKED', 'Only a locked bid pack can be converted into a contract');
  }

  const assembly = pack.state.assembly as {
    estimateTotalMinor: number;
    qualifications: string[];
    exclusions: string[];
  };

  const { contractId } = createContract(ctx, {
    suite: input.suite,
    form: input.form,
    parties: input.parties,
    contractSumMinor: assembly.estimateTotalMinor,
    commencementDate: input.commencementDate,
    completionDate: input.completionDate,
    liquidatedDamagesPerDayMinor: input.liquidatedDamagesPerDayMinor,
    ldCapPercent: input.ldCapPercent,
    retentionPercent: input.retentionPercent,
    defectsLiabilityMonths: input.defectsLiabilityMonths,
    sourceBidPackId: input.bidPackId,
  });

  const contract = ctx.ledger.require({ refType: 'Contract', refId: contractId });
  write(ctx, {
    eventType: 'CONTRACT_INGESTED',
    entity: { refType: 'Contract', refId: contractId },
    nextState: {
      ...contract.state,
      // Qualifications and exclusions travel with the contract sum. They are the
      // basis on which the price was given and they define what was priced.
      carriedQualifications: assembly.qualifications,
      carriedExclusions: assembly.exclusions,
      status: 'EXECUTED',
      executedAt: new Date().toISOString(),
    },
    evidenceRefs: [{ refType: 'BidSubmissionPack', refId: input.bidPackId }],
  });

  return { contractId, contractSumMinor: assembly.estimateTotalMinor, carriedQualifications: assembly.qualifications };
}

/**
 * Contract intelligence: extract the clauses that carry obligations and build a
 * register with deadlines. Notices missed because nobody read clause 61.3 is a
 * solved problem if the obligations are tracked as data.
 */
export async function extractContractIntelligence(
  ctx: EngineContext,
  input: { contractId: string; contractText: string; documentHash: string },
): Promise<{ clauseIds: string[]; obligationIds: string[]; acuConsumed: number }> {
  authorise(ctx, 'CONTRACTS_CLAIMS', 'X', { dataSensitivity: 'LEGAL_L4' });

  const contract = ctx.ledger.require({ refType: 'Contract', refId: input.contractId });
  const evidence = registerEvidence(ctx, {
    type: 'CONTRACT_DOCUMENT',
    hash: input.documentHash,
    description: `Executed contract document for ${String(contract.state.form)}`,
    linkedEntities: [{ refType: 'Contract', refId: input.contractId }],
  });

  const clauseIds: string[] = [];
  const obligationIds: string[] = [];

  // The obligation categories that actually generate disputes. Extraction is
  // scoped to these rather than summarising the whole document.
  const categories = [
    'NOTICE_REQUIREMENTS',
    'PAYMENT_MECHANISM',
    'EXTENSION_OF_TIME',
    'VARIATION_PROCEDURE',
    'LIQUIDATED_DAMAGES',
    'RETENTION',
    'DEFECTS_LIABILITY',
    'INSURANCE',
    'DESIGN_RESPONSIBILITY',
    'TERMINATION',
  ];

  const result = await runAI(ctx, {
    engine: 'CONTRACTS_CLAIMS',
    taskType: 'clause_extraction',
    capability: 'REASONING',
    inputRefs: [{ refType: 'Contract', refId: input.contractId }],
    request: {
      task: 'Identify clauses in each obligation category and extract any time bar that applies',
      payload: { suite: contract.state.suite, form: contract.state.form, categories, contractText: input.contractText.slice(0, 40_000) },
    },
    toWrites: (output) => {
      const writes: Array<{ eventType: string; entity: EntityRef; nextState: Record<string, unknown>; evidenceRefs?: EntityRef[] }> = [];

      for (const category of categories) {
        const clauseId = ulid();
        clauseIds.push(clauseId);
        writes.push({
          eventType: 'CONTRACT_CLAUSE_EXTRACTED',
          entity: { refType: 'ContractClause', refId: clauseId },
          nextState: {
            id: clauseId,
            contractId: input.contractId,
            category,
            clauseRef: `${String(contract.state.suite)}-${category}`,
            riskTags: [category],
            extractedAt: new Date().toISOString(),
            extractionNarrative: String(output.narrative ?? ''),
            // Extraction is a starting point for the commercial team, never the
            // final word on what a contract says.
            requiresLegalReview: true,
          },
          evidenceRefs: [evidence],
        });
      }

      // Time-barred obligations get an explicit deadline the platform can chase.
      const timeBarredCategories = ['NOTICE_REQUIREMENTS', 'EXTENSION_OF_TIME', 'VARIATION_PROCEDURE'];
      for (const category of timeBarredCategories) {
        const obligationId = ulid();
        obligationIds.push(obligationId);
        writes.push({
          eventType: 'OBLIGATION_REGISTERED',
          entity: { refType: 'Obligation', refId: obligationId },
          nextState: {
            id: obligationId,
            contractId: input.contractId,
            category,
            description: `${category.replace(/_/g, ' ').toLowerCase()} obligation under ${String(contract.state.form)}`,
            timeBarDays: category === 'EXTENSION_OF_TIME' ? 28 : 14,
            owner: 'CONTRACTOR',
            status: 'ACTIVE',
          },
          evidenceRefs: [evidence],
        });
      }

      return writes;
    },
  });

  return { clauseIds, obligationIds, acuConsumed: result.acuConsumed };
}

// --- Change control ----------------------------------------------------------

export type ChangeOrigin = 'CLIENT' | 'CONSULTANT' | 'DESIGN' | 'SITE' | 'SUBCONTRACTOR' | 'INTERNAL_DISCOVERY';
export type ChangeNoticeType = 'CCI' | 'RFC' | 'VE' | 'SI' | 'NCR_LINKED' | 'DRAWING_REVISION';

export function submitChangeRequest(
  ctx: EngineContext,
  input: {
    description: string;
    origin: ChangeOrigin;
    noticeType: ChangeNoticeType;
    reason: string;
    impactedPackageIds: string[];
    /** Which subcontract packages are affected — the variation control matrix. */
    affectedSubcontractIds: string[];
    supportingEvidenceHash: string;
  },
): { changeRequestId: string; reference: string } {
  authorise(ctx, 'CHANGE_VARIATION', 'C', { lifecyclePhase: currentPhase(ctx) });

  const sequence = ctx.ledger.list(ctx.projectId, 'ChangeRequest').length + 1;
  const reference = formatRef('CR', sequence);
  const changeRequestId = ulid();

  const evidence = registerEvidence(ctx, {
    type: 'CHANGE_SUPPORTING_EVIDENCE',
    hash: input.supportingEvidenceHash,
    description: `Supporting evidence for ${reference}: ${input.description.slice(0, 80)}`,
  });

  write(ctx, {
    eventType: 'CHANGE_REQUEST_SUBMITTED',
    entity: { refType: 'ChangeRequest', refId: changeRequestId },
    nextState: {
      id: changeRequestId,
      projectId: ctx.projectId,
      reference,
      description: input.description,
      origin: input.origin,
      noticeType: input.noticeType,
      reason: input.reason,
      impactedPackageIds: input.impactedPackageIds,
      affectedSubcontractIds: input.affectedSubcontractIds,
      status: 'SUBMITTED',
      submittedAt: new Date().toISOString(),
      submittedBy: ctx.auth.actorId,
    },
    evidenceRefs: [evidence],
  });

  return { changeRequestId, reference };
}

/**
 * Impact assessment across all four dimensions at once. A change assessed only
 * for cost is how programme impact gets waived by silence.
 */
export async function assessImpact(
  ctx: EngineContext,
  input: {
    changeRequestId: string;
    costImpactMinor: number;
    timeImpactDays: number;
    affectedTaskIds: string[];
    qualityImpact: string;
    safetyImpact: string;
  },
): Promise<{ assessmentId: string; acuConsumed: number }> {
  authorise(ctx, 'CHANGE_VARIATION', 'X', { lifecyclePhase: currentPhase(ctx) });

  const changeRequest = ctx.ledger.require({ refType: 'ChangeRequest', refId: input.changeRequestId });
  if (changeRequest.state.status !== 'SUBMITTED') {
    throw new DomainError('CHANGE_NOT_ASSESSABLE', `Change ${String(changeRequest.state.reference)} is not awaiting assessment`);
  }

  const assessmentId = ulid();
  const evidence = registerEvidence(ctx, {
    type: 'IMPACT_ASSESSMENT_BASIS',
    hash: hashEvidence(JSON.stringify(input)),
    description: `Impact assessment basis for ${String(changeRequest.state.reference)}`,
    linkedEntities: [{ refType: 'ChangeRequest', refId: input.changeRequestId }],
  });

  const result = await runAI(ctx, {
    engine: 'CONTRACTS_CLAIMS',
    taskType: 'impact_assessment',
    capability: 'REASONING',
    inputRefs: [{ refType: 'ChangeRequest', refId: input.changeRequestId }],
    request: {
      task: 'Assess entitlement basis, knock-on effects and the notice obligations this change triggers',
      payload: {
        change: changeRequest.state,
        costImpactMinor: input.costImpactMinor,
        timeImpactDays: input.timeImpactDays,
        affectedTaskIds: input.affectedTaskIds,
      },
    },
    toWrites: (output) => [
      {
        eventType: 'IMPACT_ASSESSED',
        entity: { refType: 'ImpactAssessment', refId: assessmentId },
        nextState: {
          id: assessmentId,
          changeRequestId: input.changeRequestId,
          costImpactMinor: input.costImpactMinor,
          timeImpactDays: input.timeImpactDays,
          affectedTaskIds: input.affectedTaskIds,
          qualityImpact: input.qualityImpact,
          safetyImpact: input.safetyImpact,
          entitlementNarrative: String(output.narrative ?? ''),
          assessedAt: new Date().toISOString(),
          assessedBy: ctx.auth.actorId,
        },
        evidenceRefs: [evidence],
      },
    ],
  });

  write(ctx, {
    eventType: 'CHANGE_REQUEST_APPROVED',
    entity: { refType: 'ChangeRequest', refId: input.changeRequestId },
    nextState: { ...changeRequest.state, status: 'ASSESSED', assessmentId },
    evidenceRefs: [evidence],
  });

  return { assessmentId, acuConsumed: result.acuConsumed };
}

export function instructVariation(
  ctx: EngineContext,
  input: {
    changeRequestId: string;
    contractId: string;
    valuationMethod: 'BOQ_RATES' | 'STAR_RATE' | 'DAYWORK' | 'LUMP_SUM' | 'FAIR_VALUATION';
    valuedAmountMinor: number;
    timeImpactDays: number;
  },
): { variationId: string; reference: string } {
  authorise(ctx, 'CHANGE_VARIATION', 'A', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const changeRequest = ctx.ledger.require({ refType: 'ChangeRequest', refId: input.changeRequestId });
  if (changeRequest.state.status !== 'ASSESSED') {
    throw new DomainError('CHANGE_NOT_ASSESSED', 'A change must be impact-assessed before it can be instructed');
  }

  const sequence = ctx.ledger.list(ctx.projectId, 'Variation').length + 1;
  const reference = formatRef('VAR', sequence);
  const variationId = ulid();

  const evidence = registerEvidence(ctx, {
    type: 'VARIATION_INSTRUCTION',
    hash: hashEvidence(JSON.stringify({ ...input, reference })),
    description: `Variation instruction ${reference}`,
    linkedEntities: [{ refType: 'ChangeRequest', refId: input.changeRequestId }],
  });

  write(ctx, {
    eventType: 'VARIATION_INSTRUCTED',
    entity: { refType: 'Variation', refId: variationId },
    nextState: {
      id: variationId,
      projectId: ctx.projectId,
      reference,
      contractId: input.contractId,
      changeRequestId: input.changeRequestId,
      origin: changeRequest.state.origin,
      valuationMethod: input.valuationMethod,
      valuedAmountMinor: input.valuedAmountMinor,
      timeImpactDays: input.timeImpactDays,
      affectedSubcontractIds: changeRequest.state.affectedSubcontractIds,
      status: 'INSTRUCTED',
      instructedAt: new Date().toISOString(),
      instructedBy: ctx.auth.actorId,
    },
    evidenceRefs: [evidence],
  });

  // The change request is closed by the instruction. It used to stay
  // 'ASSESSED' forever, which meant a change could be instructed and then
  // refused, and the register had no way to tell an open position from a
  // decided one.
  write(ctx, {
    eventType: 'CHANGE_REQUEST_APPROVED',
    entity: { refType: 'ChangeRequest', refId: input.changeRequestId },
    nextState: { ...changeRequest.state, status: 'INSTRUCTED', variationId, variationReference: reference },
    evidenceRefs: [evidence],
  });

  return { variationId, reference };
}

/**
 * Domestic variation raised inside a subcontractor's payment application.
 * Catching downstream change here rather than at final account is the
 * difference between a managed cost and a surprise.
 */
export function flagDomesticVariation(
  ctx: EngineContext,
  input: {
    applicationId: string;
    subcontractId: string;
    description: string;
    claimedAmountMinor: number;
    claimedTimeDays: number;
    supportingEvidenceHash: string;
    /**
     * The upstream change this cost belongs to, where the subcontractor's claim
     * arises from one. Naming it is what makes the two sides of a single change
     * one record instead of two that never meet.
     */
    changeRequestId?: string;
  },
): { variationId: string; reference: string; earlyWarning: boolean } {
  authorise(ctx, 'CHANGE_VARIATION', 'C', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const sequence = ctx.ledger.list(ctx.projectId, 'Variation').length + 1;
  const reference = formatRef('DVAR', sequence);
  const variationId = ulid();

  const evidence = registerEvidence(ctx, {
    type: 'DOMESTIC_VARIATION_SUPPORT',
    hash: input.supportingEvidenceHash,
    description: `Domestic variation ${reference} raised within application ${input.applicationId}`,
  });

  // Anything material against the subcontract raises an early warning rather
  // than sitting in the register until the account is agreed.
  const subcontract = ctx.ledger.get({ refType: 'Subcontract', refId: input.subcontractId });
  const subcontractValue = Number(subcontract?.state.valueMinor ?? 0);
  const earlyWarning = subcontractValue > 0 && input.claimedAmountMinor > subcontractValue * 0.02;

  write(ctx, {
    eventType: 'DOMESTIC_VARIATION_FLAGGED',
    entity: { refType: 'Variation', refId: variationId },
    nextState: {
      id: variationId,
      projectId: ctx.projectId,
      reference,
      subcontractId: input.subcontractId,
      sourceApplicationId: input.applicationId,
      changeRequestId: input.changeRequestId,
      origin: 'SUBCONTRACTOR',
      description: input.description,
      valuedAmountMinor: input.claimedAmountMinor,
      timeImpactDays: input.claimedTimeDays,
      status: 'CLAIMED',
      isDomestic: true,
      earlyWarning,
      flaggedAt: new Date().toISOString(),
      requiresInternalReview: true,
    },
    evidenceRefs: [evidence],
  });

  return { variationId, reference, earlyWarning };
}

/**
 * Refuse a change outright.
 *
 * `CHANGE_REQUEST_REJECTED` was in the catalogue with nothing emitting it, so a
 * change could be submitted, assessed, and then simply left. A register full of
 * changes nobody ever decided is worse than a short one: it is impossible to
 * tell an open commercial position from an abandoned one, and at final account
 * every unresolved line is argued as though it were live.
 *
 * The reason is kept because it is the answer to the question that arrives
 * months later — a rejection nobody can explain gets re-opened.
 */
export function rejectChangeRequest(
  ctx: EngineContext,
  input: { changeRequestId: string; reason: string; rejectedBy?: string },
): { changeRequestId: string; reference: string } {
  authorise(ctx, 'CHANGE_VARIATION', 'A', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const changeRequest = ctx.ledger.require({ refType: 'ChangeRequest', refId: input.changeRequestId });
  if (changeRequest.state.status === 'REJECTED') {
    throw new DomainError('CHANGE_ALREADY_REJECTED', `${String(changeRequest.state.reference)} has already been refused`);
  }
  if (changeRequest.state.status === 'INSTRUCTED') {
    throw new DomainError('CHANGE_ALREADY_INSTRUCTED', 'A change that has been instructed cannot be refused; it is varied or omitted');
  }
  if (input.reason.trim().length < 15) {
    throw new DomainError('CHANGE_REJECTION_REASON_REQUIRED', 'A refusal must state its grounds. An unexplained rejection gets re-opened.');
  }

  const evidence = registerEvidence(ctx, {
    type: 'CHANGE_REJECTION',
    hash: hashEvidence(JSON.stringify({ changeRequestId: input.changeRequestId, reason: input.reason })),
    description: `Refusal of ${String(changeRequest.state.reference)}`,
    linkedEntities: [{ refType: 'ChangeRequest', refId: input.changeRequestId }],
  });

  write(ctx, {
    eventType: 'CHANGE_REQUEST_REJECTED',
    entity: { refType: 'ChangeRequest', refId: input.changeRequestId },
    nextState: {
      ...changeRequest.state,
      status: 'REJECTED',
      rejectionReason: input.reason,
      rejectedBy: input.rejectedBy ?? ctx.auth.actorId,
      rejectedAt: new Date().toISOString(),
    },
    evidenceRefs: [evidence],
  });

  return { changeRequestId: input.changeRequestId, reference: String(changeRequest.state.reference) };
}

/**
 * Value a variation upstream — agree with the client what the change is worth.
 *
 * `VARIATION_VALUED` was in the catalogue with nothing emitting it, because the
 * instruction carried a figure and everybody treated that as the valuation.
 * They are not the same act and they are usually months apart: the instruction
 * is the client telling you to do something, the valuation is the two of you
 * agreeing the price, and the gap between them is where a main contractor
 * discovers what its subcontractors actually charged.
 *
 * Which is the rule this command enforces. **An upstream valuation is refused
 * while the downstream cost it names is uncaptured.** If the change names
 * affected subcontract packages and not one of them has a domestic variation
 * against it, the contractor is agreeing a price with the client while guessing
 * at its own cost — and the guess is always low, because the subcontractor's
 * claim has not arrived yet. Once the client's figure is agreed there is no
 * route back. This is the single largest source of quiet margin loss on a
 * construction project, and it is entirely preventable by sequence.
 *
 * A change that names no subcontracts is self-delivered, has no downstream cost
 * to capture, and is valued without objection.
 */
export function valueVariation(
  ctx: EngineContext,
  input: {
    variationId: string;
    valuationMethod: 'BOQ_RATES' | 'STAR_RATE' | 'DAYWORK' | 'LUMP_SUM' | 'FAIR_VALUATION';
    agreedAmountMinor: number;
    agreedTimeDays: number;
    /** How the figure was arrived at. A valuation without a basis is a number. */
    basis: string;
    agreedWith: string;
  },
): {
  variationId: string;
  reference: string;
  agreedAmountMinor: number;
  movementFromInstructionMinor: number;
  downstreamCapturedMinor: number;
  marginOnChangeMinor: number;
} {
  authorise(ctx, 'CHANGE_VARIATION', 'A', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const variation = ctx.ledger.require({ refType: 'Variation', refId: input.variationId });
  if (variation.state.status === 'VALUED') {
    throw new DomainError('VARIATION_ALREADY_VALUED', `${String(variation.state.reference)} has already been valued`);
  }
  if (input.basis.trim().length < 15) {
    throw new DomainError('VARIATION_BASIS_REQUIRED', 'State how the figure was arrived at. A valuation without a basis is a number.');
  }

  const affected = (variation.state.affectedSubcontractIds ?? []) as string[];
  const domestic = ctx.ledger
    .list(ctx.projectId, 'Variation')
    .filter((record) => record.state.isDomestic === true);

  // Matched on the change, never on the package. Two changes can hit the same
  // subcontract — a wall thickness variation and a dewatering claim are not
  // each other's downstream cost, and treating them as such would report a
  // reconciliation that had not happened. A false all-clear here is worse than
  // a false alarm, because nobody goes back to check it.
  const captured = domestic.filter(
    (record) =>
      typeof record.state.changeRequestId === 'string' &&
      record.state.changeRequestId === variation.state.changeRequestId,
  );

  if (affected.length > 0 && captured.length === 0) {
    throw new DomainError(
      'DOWNSTREAM_COST_NOT_CAPTURED',
      `${String(variation.state.reference)} affects ${affected.length} subcontract ${affected.length === 1 ? 'package' : 'packages'} and no downstream cost has been captured. ` +
        'Agreeing the client figure first means agreeing it without knowing your own cost, and there is no route back once it is agreed.',
    );
  }

  const downstreamCaptured = captured.reduce((sum, record) => sum + Number(record.state.valuedAmountMinor ?? 0), 0);
  const instructed = Number(variation.state.valuedAmountMinor ?? 0);

  const evidence = registerEvidence(ctx, {
    type: 'VARIATION_VALUATION',
    hash: hashEvidence(JSON.stringify({ variationId: input.variationId, agreed: input.agreedAmountMinor, basis: input.basis })),
    description: `Valuation of ${String(variation.state.reference)} agreed with ${input.agreedWith}`,
    linkedEntities: [{ refType: 'Variation', refId: input.variationId }],
  });

  write(ctx, {
    eventType: 'VARIATION_VALUED',
    entity: { refType: 'Variation', refId: input.variationId },
    nextState: {
      ...variation.state,
      status: 'VALUED',
      valuationMethod: input.valuationMethod,
      instructedAmountMinor: instructed,
      valuedAmountMinor: input.agreedAmountMinor,
      timeImpactDays: input.agreedTimeDays,
      valuationBasis: input.basis,
      agreedWith: input.agreedWith,
      downstreamCapturedMinor: downstreamCaptured,
      valuedAt: new Date().toISOString(),
      valuedBy: ctx.auth.actorId,
    },
    evidenceRefs: [evidence],
  });

  return {
    variationId: input.variationId,
    reference: String(variation.state.reference),
    agreedAmountMinor: input.agreedAmountMinor,
    movementFromInstructionMinor: input.agreedAmountMinor - instructed,
    downstreamCapturedMinor: downstreamCaptured,
    marginOnChangeMinor: input.agreedAmountMinor - downstreamCaptured,
  };
}

export type VariationLine = {
  reference: string;
  variationId?: string;
  changeRequestId?: string;
  description: string;
  origin: string;
  noticeType?: string;
  /** SUBMITTED, ASSESSED, INSTRUCTED, VALUED, REJECTED. */
  status: string;
  instructedMinor: number;
  agreedMinor: number;
  downstreamCapturedMinor: number;
  affectedSubcontracts: number;
  timeImpactDays: number;
  /** Where the two sides of the same change disagree, and by how much. */
  mismatch?: { kind: 'DOWNSTREAM_NOT_RECOVERED' | 'UPSTREAM_UNSUPPORTED'; amountMinor: number; detail: string };
};

export type VariationRegister = {
  lines: VariationLine[];
  /** Change instructed and not yet valued with the client. */
  uninstructedMinor: number;
  unvaluedMinor: number;
  /** Downstream cost the business is carrying with nothing claimed upstream. */
  downstreamNotRecoveredMinor: number;
  /** Upstream value agreed against packages whose cost is still unknown. */
  upstreamUnsupportedMinor: number;
  /** Agreed upstream less captured downstream, across every valued change. */
  marginOnChangeMinor: number;
  summary: string;
};

/**
 * The variation control matrix: one change, both sides of it.
 *
 * Change is the part of a contract where money is lost quietly, and it is lost
 * in exactly two directions. **Downstream cost not recovered upstream** is a
 * subcontractor's claim the business will pay and never charged on to the
 * client. **Upstream value agreed without downstream cost** is a price agreed
 * with the client before anybody knew what the packages would cost — which
 * reads as a win at the time and as an unexplained margin drop at final account.
 *
 * Neither is visible from either side's register alone, which is why they are
 * usually found at the end. Both are arithmetic once the two sides are linked.
 */
export function variationRegister(ctx: EngineContext): VariationRegister {
  authorise(ctx, 'CHANGE_VARIATION', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const changes = ctx.ledger.list(ctx.projectId, 'ChangeRequest');
  const variations = ctx.ledger.list(ctx.projectId, 'Variation');
  const upstream = variations.filter((v) => v.state.isDomestic !== true);
  const domestic = variations.filter((v) => v.state.isDomestic === true);

  const lines: VariationLine[] = [];
  let downstreamNotRecovered = 0;
  let upstreamUnsupported = 0;
  let uninstructed = 0;
  let unvalued = 0;
  let marginOnChange = 0;

  // Changes that never became a variation. Assessed and left is the worst of
  // these: the assessment has been paid for and the position is still open.
  for (const change of changes) {
    const instructedAgainst = upstream.find((v) => v.state.changeRequestId === change.refId);
    if (instructedAgainst) continue;

    const assessment = ctx.ledger
      .list(ctx.projectId, 'ImpactAssessment')
      .find((a) => a.state.changeRequestId === change.refId);
    const cost = Number(assessment?.state.costImpactMinor ?? 0);

    // A refused change stays on the register — the record of what was decided
    // is the point — but it carries no exposure, because it was decided.
    if (change.state.status !== 'REJECTED') uninstructed += cost;

    lines.push({
      reference: String(change.state.reference),
      changeRequestId: change.refId,
      description: String(change.state.description ?? ''),
      origin: String(change.state.origin),
      noticeType: String(change.state.noticeType),
      status: String(change.state.status),
      instructedMinor: 0,
      agreedMinor: 0,
      downstreamCapturedMinor: 0,
      affectedSubcontracts: ((change.state.affectedSubcontractIds ?? []) as string[]).length,
      timeImpactDays: Number(assessment?.state.timeImpactDays ?? 0),
    });
  }

  for (const variation of upstream) {
    const affected = (variation.state.affectedSubcontractIds ?? []) as string[];
    const captured = domestic.filter(
      (d) => typeof d.state.changeRequestId === 'string' && d.state.changeRequestId === variation.state.changeRequestId,
    );
    const capturedMinor = captured.reduce((sum, d) => sum + Number(d.state.valuedAmountMinor ?? 0), 0);
    const valued = variation.state.status === 'VALUED';
    const agreed = valued ? Number(variation.state.valuedAmountMinor ?? 0) : 0;
    const instructed = valued ? Number(variation.state.instructedAmountMinor ?? 0) : Number(variation.state.valuedAmountMinor ?? 0);

    if (!valued) unvalued += instructed;
    if (valued) marginOnChange += agreed - capturedMinor;

    let mismatch: VariationLine['mismatch'];
    if (affected.length > 0 && captured.length === 0) {
      // Value agreed with the client against packages whose cost nobody knows.
      const exposed = valued ? agreed : instructed;
      upstreamUnsupported += exposed;
      mismatch = {
        kind: 'UPSTREAM_UNSUPPORTED',
        amountMinor: exposed,
        detail: `${affected.length} affected ${affected.length === 1 ? 'package has' : 'packages have'} no downstream cost captured`,
      };
    }

    lines.push({
      reference: String(variation.state.reference),
      variationId: variation.refId,
      changeRequestId: variation.state.changeRequestId as string | undefined,
      description: String(variation.state.description ?? variation.state.valuationBasis ?? ''),
      origin: String(variation.state.origin ?? 'CLIENT'),
      status: String(variation.state.status),
      instructedMinor: instructed,
      agreedMinor: agreed,
      downstreamCapturedMinor: capturedMinor,
      affectedSubcontracts: affected.length,
      timeImpactDays: Number(variation.state.timeImpactDays ?? 0),
      mismatch,
    });
  }

  for (const claim of domestic) {
    const recoveredBy =
      typeof claim.state.changeRequestId === 'string'
        ? upstream.find((v) => v.state.changeRequestId === claim.state.changeRequestId)
        : undefined;
    const amount = Number(claim.state.valuedAmountMinor ?? 0);

    let mismatch: VariationLine['mismatch'];
    if (!recoveredBy) {
      // Cost the business will pay with nothing claimed against it upstream.
      downstreamNotRecovered += amount;
      mismatch = {
        kind: 'DOWNSTREAM_NOT_RECOVERED',
        amountMinor: amount,
        detail:
          typeof claim.state.changeRequestId === 'string'
            ? 'Linked to a change that has not been instructed upstream'
            : 'Claimed by a subcontractor and not linked to any upstream change',
      };
    }

    lines.push({
      reference: String(claim.state.reference),
      variationId: claim.refId,
      changeRequestId: claim.state.changeRequestId as string | undefined,
      description: String(claim.state.description ?? ''),
      origin: 'SUBCONTRACTOR',
      status: String(claim.state.status),
      instructedMinor: 0,
      agreedMinor: 0,
      downstreamCapturedMinor: amount,
      affectedSubcontracts: claim.state.subcontractId ? 1 : 0,
      timeImpactDays: Number(claim.state.timeImpactDays ?? 0),
      mismatch,
    });
  }

  const exposures: string[] = [];
  if (downstreamNotRecovered > 0) exposures.push('cost carried with nothing claimed upstream');
  if (upstreamUnsupported > 0) exposures.push('value agreed against packages whose cost is unknown');

  const summary =
    lines.length === 0
      ? 'No change recorded on this contract.'
      : exposures.length === 0
        ? `${lines.length} change ${lines.length === 1 ? 'record' : 'records'}, both sides reconciled.`
        : `Change exposure in ${exposures.length === 1 ? 'one direction' : 'both directions'}: ${exposures.join(', ')}.`;

  return {
    lines: lines.sort((a, b) => a.reference.localeCompare(b.reference)),
    uninstructedMinor: uninstructed,
    unvaluedMinor: unvalued,
    downstreamNotRecoveredMinor: downstreamNotRecovered,
    upstreamUnsupportedMinor: upstreamUnsupported,
    marginOnChangeMinor: marginOnChange,
    summary,
  };
}

// --- Delay & claims ----------------------------------------------------------

export function recordDelayEvent(
  ctx: EngineContext,
  input: {
    cause: DelayCause;
    description: string;
    start: string;
    end: string;
    criticalDelayDays: number;
    affectedTaskIds: string[];
    noticeServed: boolean;
    noticeDate?: string;
    evidenceHashes: string[];
  },
): { delayEventId: string; liability: (typeof CAUSE_LIABILITY)[DelayCause]; noticeWithinTimeBar: boolean } {
  authorise(ctx, 'CONTRACTS_CLAIMS', 'C', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'LEGAL_L4' });

  const evidenceRefs = input.evidenceHashes.map((hash, index) =>
    registerEvidence(ctx, {
      type: 'DELAY_EVENT_EVIDENCE',
      hash,
      description: `Evidence ${index + 1} for delay event: ${input.description.slice(0, 60)}`,
    }),
  );

  if (evidenceRefs.length === 0) {
    throw new DomainError('DELAY_EVENT_UNEVIDENCED', 'A delay event must carry at least one item of evidence');
  }

  // Time bars run from the event, and most standard forms allow 28 days.
  const noticeWithinTimeBar =
    input.noticeServed && input.noticeDate
      ? (Date.parse(input.noticeDate) - Date.parse(input.start)) / 86_400_000 <= 28
      : false;

  const delayEventId = ulid();
  write(ctx, {
    eventType: 'DELAYEVENT_RECORDED',
    entity: { refType: 'DelayEvent', refId: delayEventId },
    nextState: {
      id: delayEventId,
      projectId: ctx.projectId,
      cause: input.cause,
      description: input.description,
      start: input.start,
      end: input.end,
      criticalDelayDays: input.criticalDelayDays,
      affectedTaskIds: input.affectedTaskIds,
      responsibility: CAUSE_LIABILITY[input.cause].responsibility,
      timeEntitlement: CAUSE_LIABILITY[input.cause].timeEntitlement,
      moneyEntitlement: CAUSE_LIABILITY[input.cause].moneyEntitlement,
      noticeServed: input.noticeServed,
      noticeDate: input.noticeDate,
      noticeWithinTimeBar,
      evidenceCount: evidenceRefs.length,
      recordedAt: new Date().toISOString(),
    },
    evidenceRefs,
  });

  return { delayEventId, liability: CAUSE_LIABILITY[input.cause], noticeWithinTimeBar };
}

/**
 * Assess a claim across every recorded delay event: attribution, concurrency,
 * entitlement and a realistic figure to submit.
 */
export async function assessDelayClaim(
  ctx: EngineContext,
  input: {
    contractId: string;
    claimType: 'EOT' | 'COST' | 'LOSS_AND_EXPENSE';
    claimedDays: number;
    claimedAmountMinor: number;
    dailyProlongationMinor: number;
  },
): Promise<{
  claimId: string;
  attribution: ReturnType<typeof attributeDelay>;
  assessment: ReturnType<typeof assessClaim>;
  acuConsumed: number;
}> {
  authorise(ctx, 'CONTRACTS_CLAIMS', 'X', { dataSensitivity: 'LEGAL_L4' });

  const delayEvents: DelayEventInput[] = ctx.ledger.list(ctx.projectId, 'DelayEvent').map((record) => ({
    id: record.refId,
    cause: record.state.cause as DelayCause,
    description: String(record.state.description),
    start: String(record.state.start),
    end: String(record.state.end),
    criticalDelayDays: Number(record.state.criticalDelayDays),
    affectedTaskIds: (record.state.affectedTaskIds as string[]) ?? [],
    evidenceCount: Number(record.state.evidenceCount ?? 0),
    noticeServed: record.state.noticeServed === true,
    noticeWithinTimeBar: record.state.noticeWithinTimeBar === true,
  }));

  if (delayEvents.length === 0) {
    throw new DomainError('NO_DELAY_EVENTS', 'No delay events have been recorded for this project');
  }

  const attribution = attributeDelay(delayEvents);

  const baselines = ctx.ledger.list(ctx.projectId, 'ProgrammeBaseline').filter((b) => b.state.status === 'APPROVED');
  const clauses = ctx.ledger.list(ctx.projectId, 'ContractClause');

  const assessment = assessClaim({
    attribution,
    dailyProlongationMinor: input.dailyProlongationMinor,
    claimedDays: input.claimedDays,
    claimedAmountMinor: input.claimedAmountMinor,
    contractualBasisIdentified: clauses.some((c) => c.state.category === 'EXTENSION_OF_TIME'),
    // Contemporaneous means recorded as it happened, which the Golden Thread
    // can actually prove: the events exist and their hashes chain.
    recordsContemporaneous: delayEvents.every((e) => e.evidenceCount > 0),
    programmeBaselineApproved: baselines.length > 0,
  });

  const claimId = ulid();
  const evidence = registerEvidence(ctx, {
    type: 'CLAIM_ASSESSMENT_BASIS',
    hash: hashEvidence(JSON.stringify({ attribution, assessment })),
    description: `Assessment basis for ${input.claimType} claim`,
  });

  // Opening a claim is a human commercial decision; the engine assesses it.
  // Keeping those as two events means the record shows who decided to claim.
  write(ctx, {
    eventType: 'CLAIM_OPENED',
    entity: { refType: 'Claim', refId: claimId },
    nextState: {
      id: claimId,
      projectId: ctx.projectId,
      contractId: input.contractId,
      type: input.claimType,
      claimedDays: input.claimedDays,
      claimedAmountMinor: input.claimedAmountMinor,
      status: 'OPEN',
      openedAt: new Date().toISOString(),
      openedBy: ctx.auth.actorId,
    },
    evidenceRefs: [evidence],
  });

  const result = await runAI(ctx, {
    engine: 'CONTRACTS_CLAIMS',
    taskType: 'claim_assessment',
    capability: 'REASONING',
    inputRefs: delayEvents.map((e) => ({ refType: 'DelayEvent', refId: e.id })),
    request: {
      task: 'Review the delay attribution and set out the contractual argument, including concurrency treatment',
      payload: { attribution, assessment, claimType: input.claimType },
    },
    toWrites: (output) => [
      {
        eventType: 'CLAIM_ASSESSED',
        entity: { refType: 'Claim', refId: claimId },
        nextState: {
          id: claimId,
          projectId: ctx.projectId,
          contractId: input.contractId,
          type: input.claimType,
          claimedDays: input.claimedDays,
          claimedAmountMinor: input.claimedAmountMinor,
          openedAt: ctx.ledger.require({ refType: 'Claim', refId: claimId }).state.openedAt,
          openedBy: ctx.auth.actorId,
          assessedDays: assessment.assessedDays,
          assessedAmountMinor: assessment.assessedAmountMinor,
          entitlementScore: assessment.entitlementScore,
          strengths: assessment.strengths,
          weaknesses: assessment.weaknesses,
          recommendation: assessment.recommendation,
          attribution,
          argumentNarrative: String(output.narrative ?? ''),
          status: 'ASSESSED',
          assessedAt: new Date().toISOString(),
        },
        evidenceRefs: [evidence],
      },
    ],
  });

  return { claimId, attribution, assessment, acuConsumed: result.acuConsumed };
}

/**
 * Build a court-ready evidence pack: a verified chronology drawn straight from
 * the ledger, with hashes, so the other side can check it rather than take it
 * on trust.
 */
export async function buildEvidencePack(
  ctx: EngineContext,
  input: { claimId: string; from: string; to: string; audience: 'INTERNAL' | 'CLIENT' | 'ADJUDICATOR' | 'COURT' },
): Promise<{ packId: string; eventCount: number; packHash: string; acuConsumed: number }> {
  authorise(ctx, 'CONTRACTS_CLAIMS', 'I', { dataSensitivity: 'LEGAL_L4' });

  const claim = ctx.ledger.require({ refType: 'Claim', refId: input.claimId });
  const attribution = claim.state.attribution as ReturnType<typeof attributeDelay>;

  const relevantEntities = [
    ...attribution.perEvent.map((e) => ({ refType: 'DelayEvent', refId: e.eventId })),
    ...ctx.ledger.list(ctx.projectId, 'Variation').map((v) => ({ refType: 'Variation', refId: v.refId })),
    ...ctx.ledger.list(ctx.projectId, 'RFI').map((r) => ({ refType: 'RFI', refId: r.refId })),
    ...ctx.ledger.list(ctx.projectId, 'ProgrammeBaseline').map((b) => ({ refType: 'ProgrammeBaseline', refId: b.refId })),
  ];

  const timeline = replayTimeline(ctx.ledger, ctx.tenantId, ctx.projectId, input.from, input.to, relevantEntities);

  const evidenceIndex = ctx.ledger
    .list(ctx.projectId, 'EvidenceItem')
    .map((e) => ({
      refId: e.refId,
      type: String(e.state.type),
      hash: String(e.state.hash),
      description: String(e.state.description),
      capturedAt: String(e.state.capturedAt),
    }));

  const pack = {
    claimId: input.claimId,
    audience: input.audience,
    period: { from: input.from, to: input.to },
    chronology: timeline,
    evidenceIndex,
    attribution,
    chainHead: ctx.ledger.chainHead(ctx.projectId),
    verificationInstructions:
      'Each entry carries the Golden Thread event id and chain hash. Recompute the chain from the first event to verify that no entry has been altered, inserted or removed.',
  };

  const packHash = hashEvidence(JSON.stringify(pack));
  const packId = ulid();

  const evidence = registerEvidence(ctx, {
    type: 'CLAIM_EVIDENCE_PACK',
    hash: packHash,
    description: `Evidence pack for claim ${input.claimId} (${timeline.length} events)`,
    linkedEntities: [{ refType: 'Claim', refId: input.claimId }],
  });

  const result = await runAI(ctx, {
    engine: 'CONTRACTS_CLAIMS',
    taskType: 'evidence_pack_narrative',
    capability: 'REASONING',
    inputRefs: [{ refType: 'Claim', refId: input.claimId }],
    request: {
      task: 'Write the narrative chronology tying the evidence to the entitlement argument',
      payload: { eventCount: timeline.length, attribution, audience: input.audience },
    },
    toWrites: (output) => [
      {
        eventType: 'CLAIM_EVIDENCEPACK_BUILT',
        entity: { refType: 'Claim', refId: input.claimId },
        nextState: {
          ...claim.state,
          evidencePackId: packId,
          evidencePackHash: packHash,
          evidencePackEventCount: timeline.length,
          evidencePackNarrative: String(output.narrative ?? ''),
          evidencePackBuiltAt: new Date().toISOString(),
          status: 'EVIDENCE_PACK_READY',
        },
        evidenceRefs: [evidence],
      },
    ],
  });

  return { packId, eventCount: timeline.length, packHash, acuConsumed: result.acuConsumed };
}

// --- The obligations calendar ---------------------------------------------------
//
// Two kinds of contractual obligation, and the distinction decides how each is
// managed.
//
// A **reactive** obligation has no date until something happens: a compensation
// event occurs and a notice period starts running. It cannot be diarised in
// advance, only watched for, and it is lost by not noticing rather than by
// forgetting.
//
// A **dated** obligation has a date the day the contract is signed: insurance
// renewal, bond expiry, the end of the defects liability period, retention
// release. Nothing triggers it and nobody is watching for it, which is exactly
// why it gets missed — there is no event to react to, only a diary nobody keeps.
//
// The platform held the first kind and not the second. It could tell you a
// notice was late; it could not tell you the retention was released two months
// ago and nobody asked for it.

export type ObligationSource = 'REGISTERED' | 'DERIVED_FROM_CONTRACT' | 'DERIVED_FROM_RECORD';

export type CalendarEntry = {
  reference: string;
  category: string;
  description: string;
  dueDate: string;
  daysRemaining: number;
  owner: string;
  /** Where the date came from, so nothing here looks like it was typed in. */
  source: ObligationSource;
  status: 'DUE' | 'APPROACHING' | 'OVERDUE' | 'SATISFIED';
  /**
   * Whether missing it can be put right. A late insurance renewal is a gap to
   * close; a missed time bar is gone, and putting both in the same list without
   * saying which is which is how the recoverable ones absorb the attention.
   */
  recoverable: boolean;
  entityRef?: EntityRef;
};

export type ObligationCalendar = {
  entries: CalendarEntry[];
  overdue: CalendarEntry[];
  /** Reactive obligations whose clock is running against a recorded trigger. */
  running: Array<{
    trigger: string;
    triggerDate: string;
    category: string;
    timeBarDays: number;
    daysRemaining: number;
    served: boolean;
    /** Once this passes there is no notice worth serving. */
    lost: boolean;
  }>;
  nextDue?: CalendarEntry;
  summary: string;
};

/** Add whole months to an ISO date, clamping to the end of a short month. */
function addMonths(iso: string, months: number): string {
  const date = new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.toISOString().slice(0, 10);
}

/**
 * Register a dated obligation.
 *
 * Obligations could only be created by clause extraction, which meant the
 * platform's list of what the contract requires was whatever a model happened
 * to find in the text. A person reading the contract has to be able to add one,
 * and the date is what makes it manageable rather than a note.
 */
export function registerObligation(
  ctx: EngineContext,
  input: {
    contractId: string;
    category: string;
    description: string;
    dueDate: string;
    owner: string;
    /** Renewals recur. An annual policy is not one obligation, it is one a year. */
    recurrenceMonths?: number;
  },
): { obligationId: string; reference: string } {
  authorise(ctx, 'CONTRACTS_CLAIMS', 'C', { dataSensitivity: 'LEGAL_L4' });

  ctx.ledger.require({ refType: 'Contract', refId: input.contractId });
  if (!input.owner.trim()) {
    throw new DomainError('OBLIGATION_OWNER_REQUIRED', 'An obligation with nobody against it is a note, not an obligation');
  }
  if (!/^\d{4}-\d{2}-\d{2}/.test(input.dueDate)) {
    throw new DomainError('OBLIGATION_DUE_DATE_REQUIRED', 'A dated obligation needs a date. Reactive obligations come from clause extraction.');
  }

  const sequence = ctx.ledger.list(ctx.projectId, 'Obligation').length + 1;
  const reference = formatRef('OBL', sequence);
  const obligationId = ulid();

  write(ctx, {
    eventType: 'OBLIGATION_REGISTERED',
    entity: { refType: 'Obligation', refId: obligationId },
    nextState: {
      id: obligationId,
      projectId: ctx.projectId,
      contractId: input.contractId,
      reference,
      category: input.category,
      description: input.description,
      dueDate: input.dueDate.slice(0, 10),
      recurrenceMonths: input.recurrenceMonths,
      owner: input.owner,
      status: 'ACTIVE',
      registeredAt: new Date().toISOString(),
      registeredBy: ctx.auth.actorId,
    },
  });

  return { obligationId, reference };
}

/**
 * The calendar.
 *
 * Dates are derived from what the contract already records rather than asked
 * for again — the defects liability period ends a known number of months after
 * a known completion date, and retention is released in two halves around it.
 * Deriving is not the same as inventing: every derived entry names the contract
 * term it came from, and where a term was never recorded no entry appears.
 */
export function obligationCalendar(
  ctx: EngineContext,
  today = new Date().toISOString().slice(0, 10),
  horizonDays = 180,
): ObligationCalendar {
  authorise(ctx, 'CONTRACTS_CLAIMS', 'R', { dataSensitivity: 'LEGAL_L4' });
  return obligationFacts(ctx.ledger, ctx.projectId, today, horizonDays);
}

/**
 * The calendar for one project, without the authorisation check.
 *
 * Separate because the morning briefing reads across every project in the
 * tenant from a context scoped to none of them, the same way it reads the
 * payment cycles. Building the calendar twice would mean two places deciding
 * what a contract requires.
 */
export function obligationFacts(
  ledger: EngineContext['ledger'],
  projectId: string,
  today = new Date().toISOString().slice(0, 10),
  horizonDays = 180,
): ObligationCalendar {
  const entries: CalendarEntry[] = [];
  const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

  const classify = (dueDate: string, satisfied: boolean): CalendarEntry['status'] => {
    if (satisfied) return 'SATISFIED';
    if (dueDate < today) return 'OVERDUE';
    return daysBetween(today, dueDate) <= 30 ? 'APPROACHING' : 'DUE';
  };

  const contracts = ledger.list(projectId, 'Contract');

  for (const contract of contracts) {
    const completion = typeof contract.state.completionDate === 'string' ? contract.state.completionDate.slice(0, 10) : undefined;
    const defectsMonths = Number(contract.state.defectsLiabilityMonths ?? 0);
    const form = String(contract.state.form ?? contract.state.suite ?? 'the contract');

    if (completion && defectsMonths > 0) {
      const expiry = addMonths(completion, defectsMonths);
      entries.push({
        reference: 'DLP-EXPIRY',
        category: 'DEFECTS_LIABILITY',
        description: `Defects liability period ends — ${defectsMonths} months from completion under ${form}`,
        dueDate: expiry,
        daysRemaining: daysBetween(today, expiry),
        owner: 'CONTRACTOR',
        source: 'DERIVED_FROM_CONTRACT',
        status: classify(expiry, false),
        // A defects period that ends is not a failure; it is a date to act
        // before, and afterwards the position is simply different.
        recoverable: true,
        entityRef: { refType: 'Contract', refId: contract.refId },
      });

      // Retention is released in two halves, and the second is the one that
      // goes missing: it falls due long after everybody has left the job.
      const retentionPercent = Number(contract.state.retentionPercent ?? 0);
      if (retentionPercent > 0) {
        entries.push({
          reference: 'RET-FIRST',
          category: 'RETENTION',
          description: `First half of retention released at practical completion (${retentionPercent}% held)`,
          dueDate: completion,
          daysRemaining: daysBetween(today, completion),
          owner: 'CONTRACTOR',
          source: 'DERIVED_FROM_CONTRACT',
          status: classify(completion, false),
          recoverable: true,
          entityRef: { refType: 'Contract', refId: contract.refId },
        });
        entries.push({
          reference: 'RET-SECOND',
          category: 'RETENTION',
          description: 'Second half of retention released at the end of the defects liability period',
          dueDate: expiry,
          daysRemaining: daysBetween(today, expiry),
          owner: 'CONTRACTOR',
          source: 'DERIVED_FROM_CONTRACT',
          status: classify(expiry, false),
          recoverable: true,
          entityRef: { refType: 'Contract', refId: contract.refId },
        });
      }
    }
  }

  // Registered obligations that carry a date. The undated ones are reactive and
  // are reported separately, because a list mixing "renew the policy by March"
  // with "serve within 14 days of an event that has not happened" is unusable.
  for (const record of ledger.list(projectId, 'Obligation')) {
    const dueDate = typeof record.state.dueDate === 'string' ? record.state.dueDate.slice(0, 10) : undefined;
    if (!dueDate) continue;

    const recurrence = Number(record.state.recurrenceMonths ?? 0);
    // A recurring obligation rolls forward rather than going overdue forever:
    // an annual policy renewed last year is not an outstanding failure, it is
    // due again next year.
    let effective = dueDate;
    if (recurrence > 0) {
      while (effective < today) effective = addMonths(effective, recurrence);
    }

    entries.push({
      reference: String(record.state.reference ?? record.refId.slice(-6)),
      category: String(record.state.category),
      // A recurring obligation is reported at its next occurrence. The platform
      // does not record whether the previous ones were met, and saying so is
      // better than either a false overdue or a silent all-clear.
      description:
        recurrence > 0 && effective !== dueDate
          ? `${String(record.state.description)} (recurs every ${recurrence} months; earlier occurrences are not recorded as met or missed)`
          : String(record.state.description),
      dueDate: effective,
      daysRemaining: daysBetween(today, effective),
      owner: String(record.state.owner ?? 'CONTRACTOR'),
      source: 'REGISTERED',
      status: classify(effective, record.state.status === 'SATISFIED'),
      recoverable: true,
      entityRef: { refType: 'Obligation', refId: record.refId },
    });
  }

  // Competency expiry. A lapsed card reads the same as one nobody held, and the
  // date is already on the record.
  for (const record of ledger.list(projectId, 'Competency')) {
    const expires = typeof record.state.expiresAt === 'string' ? record.state.expiresAt.slice(0, 10) : undefined;
    if (!expires) continue;
    if (daysBetween(today, expires) > horizonDays) continue;

    entries.push({
      reference: `CMP-${record.refId.slice(-6)}`,
      category: 'COMPETENCY',
      description: `${String(record.state.qualification)} expires for ${String(record.state.operativeId)}`,
      dueDate: expires,
      daysRemaining: daysBetween(today, expires),
      owner: 'CONTRACTOR',
      source: 'DERIVED_FROM_RECORD',
      status: classify(expires, false),
      recoverable: true,
      entityRef: { refType: 'Competency', refId: record.refId },
    });
  }

  // Reactive obligations, matched against the trigger events actually recorded.
  const obligations = ledger.list(projectId, 'Obligation');
  const notices = ledger.list(projectId, 'Notice');
  const running: ObligationCalendar['running'] = [];

  for (const event of ledger.list(projectId, 'DelayEvent')) {
    const triggerDate = String(event.state.start ?? '').slice(0, 10);
    if (!triggerDate) continue;

    // A time bar only matters where there was something to claim. The event
    // already carries its entitlement from the cause, so a contractor-risk
    // delay with no time and no money in it is not a missed notice — reporting
    // it as one is crying wolf, and the real ones get skimmed past.
    if (event.state.timeEntitlement !== true && event.state.moneyEntitlement !== true) continue;

    const obligation = obligations.find((o) => String(o.state.category).includes('EXTENSION'));
    const timeBarDays = Number(obligation?.state.timeBarDays ?? 28);
    const deadline = new Date(Date.parse(triggerDate) + timeBarDays * 86_400_000).toISOString().slice(0, 10);

    // The delay event records whether a notice was served against it, so that
    // is read rather than inferred by matching dates across the notice
    // register — an inference that would call an unrelated notice a match.
    const served =
      event.state.noticeServed === true ||
      notices.some((n) => {
        const ref = n.state.relatedEntityRef as EntityRef | undefined;
        return ref?.refType === 'DelayEvent' && ref.refId === event.refId;
      });

    running.push({
      trigger: String(event.state.description ?? event.state.cause ?? 'Delay event'),
      triggerDate,
      category: 'EXTENSION_OF_TIME',
      timeBarDays,
      daysRemaining: daysBetween(today, deadline),
      served,
      // The distinction that matters: a time bar that has run cannot be
      // recovered by arguing about it later.
      lost: !served && today > deadline,
    });
  }

  const withinHorizon = entries
    .filter((entry) => entry.status !== 'SATISFIED')
    .filter((entry) => entry.daysRemaining <= horizonDays)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate));

  const overdue = withinHorizon.filter((entry) => entry.status === 'OVERDUE');
  const nextDue = withinHorizon.find((entry) => entry.status !== 'OVERDUE');
  const lost = running.filter((r) => r.lost).length;

  const parts: string[] = [];
  if (overdue.length > 0) parts.push(`${overdue.length} obligation${overdue.length === 1 ? '' : 's'} past its date`);
  if (lost > 0) parts.push(`${lost} time ${lost === 1 ? 'bar' : 'bars'} run without a notice served`);

  const summary =
    withinHorizon.length === 0 && running.length === 0
      ? 'No contractual obligation falls due in the window, and no time bar is running.'
      : parts.length === 0
        ? `${withinHorizon.length} obligation${withinHorizon.length === 1 ? '' : 's'} in the next ${horizonDays} days, none overdue.`
        : `${parts.join(' and ')}.`;

  return { entries: withinHorizon, overdue, running, nextDue, summary };
}

/** Serve a contractual notice, with the time bar checked at the point of issue. */
export function issueNotice(
  ctx: EngineContext,
  input: {
    contractId: string;
    type: 'EOT' | 'COMPENSATION_EVENT' | 'VARIATION' | 'PAYMENT' | 'EARLY_WARNING' | 'DEFAULT';
    servedTo: string;
    content: string;
    triggerEventDate: string;
    relatedEntityRef?: EntityRef;
  },
): { noticeId: string; reference: string; withinTimeBar: boolean; daysElapsed: number } {
  authorise(ctx, 'CONTRACTS_CLAIMS', 'C', { dataSensitivity: 'LEGAL_L4' });

  const contract = ctx.ledger.require({ refType: 'Contract', refId: input.contractId });
  const obligations = ctx.ledger
    .list(ctx.projectId, 'Obligation')
    .filter((o) => o.state.contractId === input.contractId);

  const timeBarDays = Number(
    obligations.find((o) => String(o.state.category).includes(input.type === 'EOT' ? 'EXTENSION' : 'NOTICE'))?.state
      .timeBarDays ?? 28,
  );

  const daysElapsed = Math.floor((Date.now() - Date.parse(input.triggerEventDate)) / 86_400_000);
  const withinTimeBar = daysElapsed <= timeBarDays;

  const sequence = ctx.ledger.list(ctx.projectId, 'Notice').length + 1;
  const reference = formatRef('NOT', sequence);
  const noticeId = ulid();

  const evidence = registerEvidence(ctx, {
    type: 'NOTICE_SERVICE_RECORD',
    hash: hashEvidence(JSON.stringify({ reference, servedTo: input.servedTo, content: input.content })),
    description: `${input.type} notice ${reference} served on ${input.servedTo}`,
  });

  write(ctx, {
    eventType: 'NOTICE_ISSUED',
    entity: { refType: 'Notice', refId: noticeId },
    nextState: {
      id: noticeId,
      projectId: ctx.projectId,
      reference,
      contractId: input.contractId,
      contractSuite: contract.state.suite,
      type: input.type,
      servedTo: input.servedTo,
      content: input.content,
      triggerEventDate: input.triggerEventDate,
      issuedDate: new Date().toISOString().slice(0, 10),
      daysElapsed,
      timeBarDays,
      // A late notice is still served and still recorded — hiding it would
      // remove the very record needed to argue waiver or estoppel later.
      withinTimeBar,
      relatedEntityRef: input.relatedEntityRef,
      status: 'SERVED',
    },
    evidenceRefs: [evidence],
  });

  return { noticeId, reference, withinTimeBar, daysElapsed };
}

// --- Statutory adjudication --------------------------------------------------

/**
 * Open a dispute by recording the notice of adjudication.
 *
 * The statutory right under s.108(1) arises *at any time*, which is the whole
 * point of it: a party cannot be made to wait for practical completion, for a
 * final account, or for a contractual escalation ladder to be climbed. The
 * platform does not gate this on anything, because the Act does not.
 *
 * What it does is start the clock and say what happens if it runs out. Both
 * ends of the timetable are fatal in different directions, and both are missed
 * by people who were watching the merits instead of the dates.
 */
export function openDispute(
  ctx: EngineContext,
  input: {
    contractId: string;
    natureOfDispute: string;
    redressSought: string;
    disputedAmountMinor?: number;
    referringParty: string;
    respondingParty: string;
    noticeDate: string;
    /** Where the dispute is a failure to pay a notified sum, the application it arises from. */
    relatedApplicationId?: string;
    evidenceHash: string;
  },
): { disputeId: string; reference: string; timetable: DisputeTimetable; findings: ProcedureFinding[] } {
  authorise(ctx, 'CONTRACTS_CLAIMS', 'C', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'LEGAL_L4' });

  const contract = ctx.ledger.require({ refType: 'Contract', refId: input.contractId });
  if (input.natureOfDispute.trim().length < 20) {
    throw new DomainError(
      'DISPUTE_NOT_DEFINED',
      'The notice has to say what the dispute is. An adjudicator has jurisdiction over the dispute referred and nothing else, so a vague notice is a jurisdictional gift to the other side.',
    );
  }
  if (input.redressSought.trim().length < 10) {
    throw new DomainError('DISPUTE_REDRESS_UNSTATED', 'The notice has to say what is being asked for');
  }

  const sequence = ctx.ledger.list(ctx.projectId, 'Dispute').length + 1;
  const reference = formatRef('ADJ', sequence);
  const timetable = buildTimetable({ noticeDate: input.noticeDate });
  const disputeId = ulid();

  const evidence = registerEvidence(ctx, {
    type: 'NOTICE_OF_ADJUDICATION',
    hash: input.evidenceHash,
    description: `${reference}: ${input.natureOfDispute.slice(0, 80)}`,
    linkedEntities: [{ refType: 'Contract', refId: input.contractId }],
  });

  write(ctx, {
    eventType: 'DISPUTE_OPENED',
    entity: { refType: 'Dispute', refId: disputeId },
    nextState: {
      id: disputeId,
      projectId: ctx.projectId,
      reference,
      contractId: input.contractId,
      contractSuite: contract.state.suite,
      natureOfDispute: input.natureOfDispute,
      redressSought: input.redressSought,
      disputedAmountMinor: input.disputedAmountMinor,
      referringParty: input.referringParty,
      respondingParty: input.respondingParty,
      noticeDate: input.noticeDate,
      relatedApplicationId: input.relatedApplicationId,
      timetable,
      status: 'NOTICE_GIVEN',
    },
    evidenceRefs: [evidence],
  });

  return {
    disputeId,
    reference,
    timetable,
    findings: assessProcedure(timetable, { status: 'NOTICE_GIVEN' }, new Date().toISOString().slice(0, 10)),
  };
}

/**
 * Record the appointment and the referral.
 *
 * A referral served outside the seven days does not extinguish the right — a
 * fresh notice can be given, because the right arises at any time — but it does
 * put this reference in jeopardy. So it is recorded rather than refused: the
 * platform's job is to tell the party what they have done, not to pretend it
 * did not happen and leave them to find out from the responding party's
 * jurisdictional challenge.
 */
export function referDispute(
  ctx: EngineContext,
  input: {
    disputeId: string;
    adjudicatorName: string;
    /** Who appointed, where the parties did not agree — RICS, TeCSA, ICE and so on. */
    nominatingBody?: string;
    referralDate: string;
    evidenceHash: string;
  },
): { disputeId: string; reference: string; timetable: DisputeTimetable; findings: ProcedureFinding[] } {
  authorise(ctx, 'CONTRACTS_CLAIMS', 'U', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'LEGAL_L4' });

  const dispute = ctx.ledger.require({ refType: 'Dispute', refId: input.disputeId });
  if (dispute.state.status !== 'NOTICE_GIVEN') {
    throw new DomainError(
      'DISPUTE_ALREADY_REFERRED',
      `${String(dispute.state.reference)} is already at ${String(dispute.state.status)}`,
    );
  }

  const timetable = buildTimetable({
    noticeDate: String(dispute.state.noticeDate),
    referralDate: input.referralDate,
  });

  const evidence = registerEvidence(ctx, {
    type: 'REFERRAL_NOTICE',
    hash: input.evidenceHash,
    description: `${String(dispute.state.reference)} referred to ${input.adjudicatorName}`,
    linkedEntities: [{ refType: 'Dispute', refId: input.disputeId }],
  });

  write(ctx, {
    eventType: 'DISPUTE_REFERRED',
    entity: { refType: 'Dispute', refId: input.disputeId },
    nextState: {
      ...dispute.state,
      adjudicatorName: input.adjudicatorName,
      nominatingBody: input.nominatingBody,
      referralDate: input.referralDate,
      timetable,
      status: 'REFERRED',
    },
    evidenceRefs: [evidence],
  });

  return {
    disputeId: input.disputeId,
    reference: String(dispute.state.reference),
    timetable,
    findings: assessProcedure(timetable, { status: 'REFERRED' }, new Date().toISOString().slice(0, 10)),
  };
}

/**
 * Record the adjudicator's decision.
 *
 * Recorded whether or not it is in time, for the same reason a late notice is:
 * a decision reached one day outside the period is a nullity, and that is a
 * fact somebody needs in front of them before they pay against it. The platform
 * says so; it does not refuse the record and leave the question open.
 *
 * A decision is binding *until* the dispute is finally determined by legal
 * proceedings, arbitration or agreement. Temporarily binding is still binding,
 * which is the part parties reliably misunderstand — it must be complied with
 * in the meantime whatever either of them thinks of it.
 */
export function recordAdjudicatorDecision(
  ctx: EngineContext,
  input: {
    disputeId: string;
    decisionDate: string;
    /** Which party the decision favoured, and what it awarded. */
    inFavourOf: string;
    awardedAmountMinor?: number;
    awardedDays?: number;
    /** Extension of the decision period, where one was agreed. */
    extensionDays?: number;
    extensionAgreedBy?: 'REFERRING_PARTY' | 'BOTH_PARTIES';
    extensionAgreedDate?: string;
    /** How the adjudicator apportioned their own fees. */
    adjudicatorFeesMinor?: number;
    feesBorneBy?: string;
    evidenceHash: string;
  },
): {
  disputeId: string;
  reference: string;
  timetable: DisputeTimetable;
  enforceable: boolean;
  findings: ProcedureFinding[];
} {
  authorise(ctx, 'CONTRACTS_CLAIMS', 'U', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'LEGAL_L4' });

  const dispute = ctx.ledger.require({ refType: 'Dispute', refId: input.disputeId });
  if (dispute.state.status !== 'REFERRED') {
    throw new DomainError(
      'DISPUTE_NOT_REFERRED',
      `${String(dispute.state.reference)} is at ${String(dispute.state.status)}. A decision follows a referral.`,
    );
  }

  const timetable = buildTimetable({
    noticeDate: String(dispute.state.noticeDate),
    referralDate: String(dispute.state.referralDate),
    extensionDays: input.extensionDays,
    extensionAgreedBy: input.extensionAgreedBy,
    extensionAgreedDate: input.extensionAgreedDate,
  });

  const findings = assessProcedure(timetable, { decisionDate: input.decisionDate, status: 'DECIDED' }, input.decisionDate);
  const enforceable = !findings.some((f) => f.severity === 'CRITICAL' && f.authority.includes('s.108(2)(c)'));

  const evidence = registerEvidence(ctx, {
    type: 'ADJUDICATOR_DECISION',
    hash: input.evidenceHash,
    description: `${String(dispute.state.reference)} decided in favour of ${input.inFavourOf}`,
    linkedEntities: [{ refType: 'Dispute', refId: input.disputeId }],
  });

  write(ctx, {
    eventType: 'DISPUTE_DECIDED',
    entity: { refType: 'Dispute', refId: input.disputeId },
    nextState: {
      ...dispute.state,
      decisionDate: input.decisionDate,
      inFavourOf: input.inFavourOf,
      awardedAmountMinor: input.awardedAmountMinor,
      awardedDays: input.awardedDays,
      extensionDays: input.extensionDays,
      extensionAgreedBy: input.extensionAgreedBy,
      adjudicatorFeesMinor: input.adjudicatorFeesMinor,
      feesBorneBy: input.feesBorneBy,
      timetable,
      enforceable,
      // Temporarily binding is still binding. It is complied with until the
      // dispute is finally determined, and "final" does not mean this.
      bindingUntilFinallyDetermined: enforceable,
      status: 'DECIDED',
    },
    evidenceRefs: [evidence],
  });

  return { disputeId: input.disputeId, reference: String(dispute.state.reference), timetable, enforceable, findings };
}

export type DisputePosition = {
  total: number;
  live: number;
  disputes: Array<{
    disputeId: string;
    reference: string;
    status: string;
    natureOfDispute: string;
    referringParty: string;
    disputedAmountMinor?: number;
    nextDeadline?: string;
    daysToNextDeadline?: number;
    findings: ProcedureFinding[];
  }>;
  /** Sum in dispute across everything live. Redacted where the reader has no commercial clearance. */
  amountInDisputeMinor?: number;
  costsProvisionFindings: ProcedureFinding[];
  summary: string;
};

/**
 * Where every dispute stands, and what is about to expire.
 *
 * Ordered by the deadline that is nearest, because that is the only ordering
 * that reflects what happens if nobody looks at this today.
 */
export function disputePosition(
  ctx: EngineContext,
  today = new Date().toISOString().slice(0, 10),
): DisputePosition {
  authorise(ctx, 'CONTRACTS_CLAIMS', 'R', { dataSensitivity: 'LEGAL_L4' });

  const records = ctx.ledger.list(ctx.projectId, 'Dispute').map((record) => record.state);
  const live = records.filter((d) => d.status !== 'DECIDED' && d.status !== 'WITHDRAWN');

  const disputes = records
    .map((dispute) => {
      const timetable = dispute.timetable as DisputeTimetable;
      const findings = assessProcedure(
        timetable,
        { decisionDate: dispute.decisionDate as string | undefined, status: String(dispute.status) },
        today,
      );

      const nextDeadline =
        dispute.status === 'NOTICE_GIVEN'
          ? timetable.referralDeadline
          : dispute.status === 'REFERRED'
            ? (timetable.extendedDecisionDeadline ?? timetable.decisionDeadline)
            : undefined;

      return {
        // Carried so a screen can act on the record it is showing rather than
        // looking it up again by reference.
        disputeId: String(dispute.id),
        reference: String(dispute.reference),
        status: String(dispute.status),
        natureOfDispute: String(dispute.natureOfDispute),
        referringParty: String(dispute.referringParty),
        disputedAmountMinor: dispute.disputedAmountMinor as number | undefined,
        nextDeadline,
        daysToNextDeadline:
          nextDeadline === undefined ? undefined : Math.round((Date.parse(nextDeadline) - Date.parse(today)) / 86_400_000),
        findings,
      };
    })
    .sort((a, b) => (a.nextDeadline ?? '9999').localeCompare(b.nextDeadline ?? '9999'));

  // The contract's costs provision, read once across the project rather than
  // per dispute — it is a term of the contract, not a fact about a reference.
  const contract = ctx.ledger.list(ctx.projectId, 'Contract').at(-1);
  const costsProvisionFindings = contract
    ? assessCostsProvision({ contractAllocatesPartiesCosts: contract.state.allocatesAdjudicationCosts === true })
    : [];

  const critical = disputes.filter((d) => d.findings.some((f) => f.severity === 'CRITICAL'));
  const soonest = disputes.find((d) => d.daysToNextDeadline !== undefined);

  const summary =
    records.length === 0
      ? 'No dispute has been referred to adjudication.'
      : critical.length > 0
        ? `${critical.length} of ${records.length} adjudication${records.length === 1 ? '' : 's'} has a procedural defect that would be taken against it.`
        : soonest
          ? `${live.length} live. ${soonest.reference} next: ${soonest.daysToNextDeadline} days to ${soonest.nextDeadline}.`
          : `${records.length} concluded, none live.`;

  return {
    total: records.length,
    live: live.length,
    disputes,
    amountInDisputeMinor: live.reduce((sum, d) => sum + Number(d.disputedAmountMinor ?? 0), 0),
    costsProvisionFindings,
    summary,
  };
}
