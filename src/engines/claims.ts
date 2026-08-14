import { hashEvidence } from '../core/canonical.ts';
import { DomainError } from '../core/errors.ts';
import { formatRef, ulid } from '../core/ids.ts';
import type { EntityRef } from '../goldenthread/types.ts';
import { replayTimeline } from '../goldenthread/replay.ts';
import { authorise, currentPhase, registerEvidence, runAI, write, type EngineContext } from './context.ts';
import { assessClaim, attributeDelay, CAUSE_LIABILITY, type DelayCause, type DelayEventInput } from './maths/claims.ts';

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
