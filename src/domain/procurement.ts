import { hashEvidence } from '../core/canonical.ts';
import { DomainError, ForbiddenError } from '../core/errors.ts';
import { formatRef, ulid } from '../core/ids.ts';
import { authorise, currentPhase, registerEvidence, write, type EngineContext } from '../engines/context.ts';

/**
 * Procurement: RFQ issue, supplier returns, award, and the subcontract that
 * follows. Procurement is modelled as a stateful continuation of tendering
 * rather than a separate module — the award carries the evaluated position
 * straight into the subcontract without re-keying.
 */

export type RFQStatus =
  | 'DRAFT'
  | 'ISSUED'
  | 'CLARIFICATION'
  | 'RETURNS_RECEIVED'
  | 'UNDER_EVALUATION'
  | 'AWARDED'
  | 'CANCELLED';

export function createRFQ(
  ctx: EngineContext,
  input: {
    packageId: string;
    title: string;
    pricingBasis: 'LUMP_SUM' | 'REMEASURABLE' | 'TARGET_COST' | 'COST_REIMBURSABLE';
    returnDeadline: string;
    invitedSupplierIds: string[];
    requiredInsurances: string[];
    contractSuite: string;
  },
): { rfqId: string; reference: string } {
  authorise(ctx, 'PROCUREMENT_AWARD', 'C', { lifecyclePhase: currentPhase(ctx) });

  // Design maturity governs the pricing basis. Asking for a lump sum against
  // immature design is the single most reliable way to buy a variation.
  const assessments = ctx.ledger
    .list(ctx.projectId, 'DesignMaturityAssessment')
    .filter((a) => a.state.packageId === input.packageId);
  const latest = assessments[assessments.length - 1];

  if (!latest) {
    throw new DomainError(
      'DESIGN_MATURITY_NOT_ASSESSED',
      'Design maturity must be assessed before a package can be taken to market',
    );
  }

  const recommended = String(latest.state.recommendedPricingBasis);
  const score = Number(latest.state.score);

  if (input.pricingBasis === 'LUMP_SUM' && recommended !== 'LUMP_SUM') {
    throw new DomainError(
      'PRICING_BASIS_UNSUPPORTED',
      `Design maturity is ${score}; a lump sum basis is not supportable. Recommended basis: ${recommended}`,
    );
  }

  const sequence = ctx.ledger.list(ctx.projectId, 'RFQ').length + 1;
  const reference = formatRef('RFQ', sequence);
  const rfqId = ulid();

  write(ctx, {
    eventType: 'RFQ_CREATED',
    entity: { refType: 'RFQ', refId: rfqId },
    nextState: {
      id: rfqId,
      projectId: ctx.projectId,
      reference,
      packageId: input.packageId,
      title: input.title,
      pricingBasis: input.pricingBasis,
      returnDeadline: input.returnDeadline,
      invitedSupplierIds: input.invitedSupplierIds,
      requiredInsurances: input.requiredInsurances,
      contractSuite: input.contractSuite,
      designMaturityScore: score,
      designMaturityAssessmentId: latest.refId,
      status: 'DRAFT' satisfies RFQStatus,
      acknowledgements: [],
      createdAt: new Date().toISOString(),
    },
  });

  return { rfqId, reference };
}

export function issueRFQ(ctx: EngineContext, input: { rfqId: string; tenderPackageId: string }): void {
  authorise(ctx, 'PROCUREMENT_AWARD', 'I', { lifecyclePhase: currentPhase(ctx) });

  const rfq = ctx.ledger.require({ refType: 'RFQ', refId: input.rfqId });
  if (rfq.state.status !== 'DRAFT') throw new DomainError('RFQ_NOT_DRAFT', 'Only a draft RFQ can be issued');

  const pack = ctx.ledger.require({ refType: 'TenderPackage', refId: input.tenderPackageId });
  if (pack.state.status !== 'READY_TO_ISSUE') {
    const missing = (pack.state.missingComponents as string[]) ?? [];
    throw new DomainError(
      'TENDER_PACKAGE_INCOMPLETE',
      `Package is incomplete and would produce incomparable returns. Missing: ${missing.join(', ')}`,
    );
  }

  const evidence = registerEvidence(ctx, {
    type: 'RFQ_ISSUE_RECORD',
    hash: hashEvidence(JSON.stringify({ rfqId: input.rfqId, issuedTo: rfq.state.invitedSupplierIds })),
    description: `RFQ ${String(rfq.state.reference)} issued to ${(rfq.state.invitedSupplierIds as string[]).length} supplier(s)`,
  });

  write(ctx, {
    eventType: 'RFQ_ISSUED',
    entity: { refType: 'RFQ', refId: input.rfqId },
    nextState: {
      ...rfq.state,
      tenderPackageId: input.tenderPackageId,
      status: 'ISSUED' satisfies RFQStatus,
      issuedAt: new Date().toISOString(),
      issuedBy: ctx.auth.actorId,
    },
    evidenceRefs: [evidence],
  });
}

export function acknowledgeRFQ(ctx: EngineContext, input: { rfqId: string; supplierId: string; intendToBid: boolean }): void {
  const rfq = ctx.ledger.require({ refType: 'RFQ', refId: input.rfqId });

  // A supplier may only acknowledge on its own behalf.
  if (ctx.auth.roles.includes('SUPPLIER') && ctx.auth.partyId !== input.supplierId) {
    throw new ForbiddenError('Suppliers may only respond on their own behalf', 'SUPPLIER_IDENTITY_MISMATCH');
  }

  const acknowledgements = (rfq.state.acknowledgements as Array<Record<string, unknown>>) ?? [];

  write(ctx, {
    eventType: 'RFQ_ACKNOWLEDGED',
    entity: { refType: 'RFQ', refId: input.rfqId },
    nextState: {
      ...rfq.state,
      acknowledgements: [
        ...acknowledgements.filter((a) => a.supplierId !== input.supplierId),
        { supplierId: input.supplierId, intendToBid: input.intendToBid, at: new Date().toISOString() },
      ],
    },
  });
}

export function raiseClarification(
  ctx: EngineContext,
  input: { rfqId: string; supplierId: string; question: string },
): { clarificationId: string; reference: string } {
  const rfq = ctx.ledger.require({ refType: 'RFQ', refId: input.rfqId });

  if (ctx.auth.roles.includes('SUPPLIER') && ctx.auth.partyId !== input.supplierId) {
    throw new ForbiddenError('Suppliers may only raise clarifications on their own behalf', 'SUPPLIER_IDENTITY_MISMATCH');
  }

  const sequence = ctx.ledger.list(ctx.projectId, 'Clarification').length + 1;
  const reference = formatRef('TQ', sequence);
  const clarificationId = ulid();

  write(ctx, {
    eventType: 'CLARIFICATION_RAISED',
    entity: { refType: 'Clarification', refId: clarificationId },
    nextState: {
      id: clarificationId,
      projectId: ctx.projectId,
      rfqId: input.rfqId,
      rfqReference: rfq.state.reference,
      reference,
      supplierId: input.supplierId,
      question: input.question,
      status: 'OPEN',
      raisedAt: new Date().toISOString(),
    },
  });

  return { clarificationId, reference };
}

/**
 * Answer a clarification. Answers go to every bidder, not just the asker —
 * otherwise the returns are no longer comparable and the process is challengeable.
 */
export function answerClarification(
  ctx: EngineContext,
  input: { clarificationId: string; answer: string; issueToAllBidders: boolean },
): void {
  authorise(ctx, 'PROCUREMENT_AWARD', 'U', { lifecyclePhase: currentPhase(ctx) });

  const clarification = ctx.ledger.require({ refType: 'Clarification', refId: input.clarificationId });

  if (!input.issueToAllBidders) {
    throw new DomainError(
      'CLARIFICATION_MUST_BE_UNIVERSAL',
      'Clarification answers must be issued to all bidders to keep returns comparable',
    );
  }

  write(ctx, {
    eventType: 'CLARIFICATION_ANSWERED',
    entity: { refType: 'Clarification', refId: input.clarificationId },
    nextState: {
      ...clarification.state,
      answer: input.answer,
      issuedToAllBidders: true,
      status: 'ANSWERED',
      answeredAt: new Date().toISOString(),
      answeredBy: ctx.auth.actorId,
    },
  });
}

export function receiveSubmission(
  ctx: EngineContext,
  input: {
    rfqId: string;
    supplierPartyId: string;
    supplierName: string;
    priceMinor: number;
    durationDays: number;
    exclusions: string[];
    contractExceptions: string[];
    provisionalSumsMinor: number;
    insurancesHeld: string[];
    peakLabour?: number;
    submissionHash: string;
  },
): { submissionId: string } {
  const rfq = ctx.ledger.require({ refType: 'RFQ', refId: input.rfqId });

  if (ctx.auth.roles.includes('SUPPLIER') && ctx.auth.partyId !== input.supplierPartyId) {
    throw new ForbiddenError('Suppliers may only submit on their own behalf', 'SUPPLIER_IDENTITY_MISMATCH');
  }
  // Returns keep arriving until the deadline; the first one only moves the RFQ
  // into RETURNS_RECEIVED, it does not close the door on the rest.
  const openStatuses = ['ISSUED', 'CLARIFICATION', 'RETURNS_RECEIVED'];
  if (!openStatuses.includes(String(rfq.state.status))) {
    throw new DomainError('RFQ_NOT_OPEN', `RFQ ${String(rfq.state.reference)} is not open for returns`);
  }
  if (new Date().toISOString() > String(rfq.state.returnDeadline)) {
    // Late returns are rejected outright rather than quietly accepted: accepting
    // one is precisely the kind of unfairness that gets an award overturned.
    throw new DomainError('RFQ_DEADLINE_PASSED', `The return deadline for ${String(rfq.state.reference)} has passed`);
  }

  const evidence = registerEvidence(ctx, {
    type: 'SUPPLIER_SUBMISSION_DOCUMENT',
    hash: input.submissionHash,
    description: `Submission from ${input.supplierName} for ${String(rfq.state.reference)}`,
  });

  const submissionId = ulid();
  write(ctx, {
    eventType: 'SUBMISSION_RECEIVED',
    entity: { refType: 'SupplierSubmission', refId: submissionId },
    nextState: {
      id: submissionId,
      projectId: ctx.projectId,
      rfqId: input.rfqId,
      supplierPartyId: input.supplierPartyId,
      supplierName: input.supplierName,
      priceMinor: input.priceMinor,
      durationDays: input.durationDays,
      exclusions: input.exclusions,
      contractExceptions: input.contractExceptions,
      provisionalSumsMinor: input.provisionalSumsMinor,
      insurancesHeld: input.insurancesHeld,
      peakLabour: input.peakLabour,
      status: 'RECEIVED',
      receivedAt: new Date().toISOString(),
    },
    evidenceRefs: [evidence],
  });

  const submissionCount = ctx.ledger.list(ctx.projectId, 'SupplierSubmission').filter((s) => s.state.rfqId === input.rfqId).length;
  if (submissionCount > 0 && rfq.state.status === 'ISSUED') {
    write(ctx, {
      eventType: 'RFQ_ACKNOWLEDGED',
      entity: { refType: 'RFQ', refId: input.rfqId },
      nextState: { ...rfq.state, status: 'RETURNS_RECEIVED' satisfies RFQStatus, returnsReceived: submissionCount },
    });
  }

  return { submissionId };
}

export function awardRFQ(
  ctx: EngineContext,
  input: { rfqId: string; adjudicationId: string; governanceApprovalRef: string; conditions: string[] },
): { awardedSubmissionId: string; supplierName: string } {
  authorise(ctx, 'PROCUREMENT_AWARD', 'A', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const rfq = ctx.ledger.require({ refType: 'RFQ', refId: input.rfqId });
  const adjudication = ctx.ledger.require({ refType: 'Adjudication', refId: input.adjudicationId });
  const submissionId = String(adjudication.state.selectedSubmissionId);
  const submission = ctx.ledger.require({ refType: 'SupplierSubmission', refId: submissionId });

  const evidence = registerEvidence(ctx, {
    type: 'AWARD_GOVERNANCE_APPROVAL',
    hash: hashEvidence(JSON.stringify({ rfqId: input.rfqId, submissionId, approval: input.governanceApprovalRef })),
    description: `Award governance approval ${input.governanceApprovalRef}`,
    linkedEntities: [{ refType: 'Adjudication', refId: input.adjudicationId }],
  });

  write(ctx, {
    eventType: 'RFQ_AWARDED',
    entity: { refType: 'RFQ', refId: input.rfqId },
    nextState: {
      ...rfq.state,
      status: 'AWARDED' satisfies RFQStatus,
      awardedSubmissionId: submissionId,
      awardedSupplierPartyId: submission.state.supplierPartyId,
      awardedValueMinor: submission.state.priceMinor,
      adjudicationId: input.adjudicationId,
      governanceApprovalRef: input.governanceApprovalRef,
      awardConditions: input.conditions,
      awardedAt: new Date().toISOString(),
      awardedBy: ctx.auth.actorId,
    },
    evidenceRefs: [evidence],
  });

  return { awardedSubmissionId: submissionId, supplierName: String(submission.state.supplierName) };
}

/**
 * Assemble the subcontract from the award. Particulars are pre-filled from the
 * evaluated submission, and any negotiated movement is tracked as an explicit
 * delta rather than silently overwriting the tendered position.
 */
export function assembleSubcontract(
  ctx: EngineContext,
  input: {
    rfqId: string;
    contractSuite: string;
    form: string;
    negotiatedValueMinor?: number;
    negotiationNotes?: string;
    startDate: string;
    completionDate: string;
    retentionPercent: number;
    paymentTermsDays: number;
  },
): { subcontractId: string; reference: string; buyoutDeltaMinor: number } {
  authorise(ctx, 'PROCUREMENT_AWARD', 'C', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const rfq = ctx.ledger.require({ refType: 'RFQ', refId: input.rfqId });
  if (rfq.state.status !== 'AWARDED') throw new DomainError('RFQ_NOT_AWARDED', 'The RFQ must be awarded first');

  const submission = ctx.ledger.require({ refType: 'SupplierSubmission', refId: String(rfq.state.awardedSubmissionId) });
  const adjudication = ctx.ledger.get({ refType: 'Adjudication', refId: String(rfq.state.adjudicationId) });

  const tenderedValue = Number(submission.state.priceMinor);
  const finalValue = input.negotiatedValueMinor ?? tenderedValue;
  const buyoutTarget = Number(adjudication?.state.buyoutTargetMinor ?? tenderedValue);

  const sequence = ctx.ledger.list(ctx.projectId, 'Subcontract').length + 1;
  const reference = formatRef('SC', sequence);
  const subcontractId = ulid();

  write(ctx, {
    eventType: 'SUBCONTRACT_ASSEMBLED',
    entity: { refType: 'Subcontract', refId: subcontractId },
    nextState: {
      id: subcontractId,
      projectId: ctx.projectId,
      reference,
      rfqId: input.rfqId,
      packageId: rfq.state.packageId,
      supplierPartyId: submission.state.supplierPartyId,
      supplierName: submission.state.supplierName,
      contractSuite: input.contractSuite,
      form: input.form,
      tenderedValueMinor: tenderedValue,
      valueMinor: finalValue,
      // Buyout performance against the adjudication target, visible from day one.
      buyoutTargetMinor: buyoutTarget,
      buyoutDeltaMinor: buyoutTarget - finalValue,
      negotiationNotes: input.negotiationNotes,
      // The tendered exclusions define what was NOT priced; they must survive
      // into the subcontract or the scope gap reappears as a variation.
      carriedExclusions: submission.state.exclusions,
      carriedExceptions: submission.state.contractExceptions,
      startDate: input.startDate,
      completionDate: input.completionDate,
      retentionPercent: input.retentionPercent,
      paymentTermsDays: input.paymentTermsDays,
      status: 'ASSEMBLED',
      assembledAt: new Date().toISOString(),
    },
  });

  return { subcontractId, reference, buyoutDeltaMinor: buyoutTarget - finalValue };
}

/**
 * Execute the subcontract and raise the matching commitment. Commitment and
 * contract are created together so the ledger can never show one without the other.
 */
export function executeSubcontract(
  ctx: EngineContext,
  input: { subcontractId: string; signedDocumentHash: string; signatureMethod: string; budgetCheckPassed: boolean },
): { commitmentId: string } {
  authorise(ctx, 'PROCUREMENT_AWARD', 'A', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const subcontract = ctx.ledger.require({ refType: 'Subcontract', refId: input.subcontractId });

  if (!input.budgetCheckPassed) {
    throw new DomainError(
      'COMMITMENT_EXCEEDS_BUDGET',
      'The commitment check against budget failed; obtain approval before executing',
    );
  }

  const evidence = registerEvidence(ctx, {
    type: 'EXECUTED_SUBCONTRACT',
    hash: input.signedDocumentHash,
    description: `Executed subcontract ${String(subcontract.state.reference)} (${input.signatureMethod})`,
  });

  write(ctx, {
    eventType: 'SUBCONTRACT_EXECUTED',
    entity: { refType: 'Subcontract', refId: input.subcontractId },
    nextState: {
      ...subcontract.state,
      status: 'EXECUTED',
      signatureMethod: input.signatureMethod,
      executedAt: new Date().toISOString(),
    },
    evidenceRefs: [evidence],
  });

  const commitmentId = ulid();
  write(ctx, {
    eventType: 'COMMITMENT_RAISED',
    entity: { refType: 'Commitment', refId: commitmentId },
    nextState: {
      id: commitmentId,
      projectId: ctx.projectId,
      type: 'SUBCONTRACT',
      contractId: input.subcontractId,
      supplierPartyId: subcontract.state.supplierPartyId,
      valueMinor: subcontract.state.valueMinor,
      packageId: subcontract.state.packageId,
      status: 'ACTIVE',
      raisedAt: new Date().toISOString(),
    },
  });

  return { commitmentId };
}
