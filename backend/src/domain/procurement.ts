import { hashEvidence } from '../core/canonical.ts';
import { DomainError, ForbiddenError } from '../core/errors.ts';
import { formatRef, ulid } from '../core/ids.ts';
import { authorise, currentPhase, registerEvidence, write, type EngineContext } from '../engines/context.ts';
import { assertEligibleForEnquiry, supplierForParty } from './supplychain.ts';

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
    /** The trade being bought, so eligibility is checked against it. */
    trade?: string;
    /** Package value, so nobody is invited beyond their assessed capacity. */
    packageValueMinor?: number;
  },
): { rfqId: string; reference: string } {
  authorise(ctx, 'PROCUREMENT_AWARD', 'C', { lifecyclePhase: currentPhase(ctx) });

  // Everyone invited must be on the register and currently prequalified. This
  // refuses the whole enquiry rather than dropping the ineligible firms: an
  // RFQ that silently went to four of the six you selected produces a
  // comparison you cannot trust.
  assertEligibleForEnquiry(ctx, input.invitedSupplierIds, {
    trade: input.trade,
    packageValueMinor: input.packageValueMinor,
  });

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

  // A supplier may only acknowledge on its own behalf. The comparison is
  // against the party, and a supplier acting for itself may name either its
  // party or its register entry — the two identify the same firm now that a
  // supplier records the party it trades as, and refusing one of them would be
  // refusing a firm for using its own name.
  const own = supplierForParty(ctx, input.supplierId)?.supplierId ?? input.supplierId;
  const asParty =
    ctx.ledger.get({ refType: 'Supplier', refId: input.supplierId })?.state.partyId ?? input.supplierId;
  if (
    ctx.auth.roles.includes('SUPPLIER') &&
    ctx.auth.partyId !== input.supplierId &&
    ctx.auth.partyId !== asParty
  ) {
    throw new ForbiddenError('Suppliers may only respond on their own behalf', 'SUPPLIER_IDENTITY_MISMATCH');
  }

  // Answering an enquiry nobody sent you is not an answer. Tolerant of a firm
  // registered before suppliers carried a party, for the same reason the
  // submission gate is: the ledger's own history has to stay replayable.
  const invited = (rfq.state.invitedSupplierIds as string[]) ?? [];
  if (invited.length > 0 && !invited.includes(own) && !invited.includes(input.supplierId)) {
    throw new DomainError(
      'SUPPLIER_NOT_INVITED',
      `That firm was not invited to ${String(rfq.state.reference)}, so there is no enquiry for it to acknowledge`,
    );
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

  /**
   * The return has to come from a firm that was invited, and this is where that
   * is checked.
   *
   * `assertEligibleForEnquiry` gates who may be *invited* and nothing gated who
   * may *return*, because the invitation named a supply-chain register id and
   * the submission named a party with nothing joining them. The eligibility
   * check could therefore be bypassed end to end: an unqualified firm's bid
   * received, evaluated, adjudicated and awarded without the prequalification
   * that the enquiry refused to go out without.
   *
   * A submission from a firm registered before suppliers carried a party is
   * still accepted, with the gap named in the error only when the party is
   * unknown outright. Refusing those would make the ledger's own history
   * unreplayable through the command path, which is a worse failure than the
   * one being fixed.
   */
  const supplier = supplierForParty(ctx, input.supplierPartyId);
  if (supplier) {
    const invited = (rfq.state.invitedSupplierIds as string[]) ?? [];
    if (!invited.includes(supplier.supplierId)) {
      throw new DomainError(
        'SUPPLIER_NOT_INVITED',
        `${supplier.legalName} was not invited to ${String(rfq.state.reference)}. A return from an uninvited firm ` +
          'cannot be evaluated against the others, and awarding on it would bypass the prequalification the enquiry required.',
      );
    }
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
      // The register entry this party is, resolved once and recorded. A join
      // re-derived on every read is a join that changes when the register does.
      supplierId: supplier?.supplierId,
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

/**
 * Who was asked, who answered, and who has said nothing.
 *
 * Every fact this needs was already on the record — the invited list on the
 * RFQ, the acknowledgements written against it, the submissions that name it —
 * and nothing put them beside each other. From a screen that is
 * indistinguishable from not tracking bidders at all, and it is the difference
 * between "four returns received" and "four of nine, and the two who said they
 * were bidding are not among them".
 *
 * The silence is the finding. A firm that declined is a normal outcome and
 * tells you the package or the programme is wrong if enough of them do it. A
 * firm that said it intended to bid and then did not return is a hole in the
 * competition somebody should have chased on the Friday. And a firm that never
 * acknowledged at all may simply not have received the enquiry — which is a
 * question about the issue, not about the bidder.
 *
 * Nothing here is scored or ranked. Comparing prices is `evaluateSubmissions`,
 * which is a different question asked after this one is answered.
 */
export type BidderPosition = {
  supplierId: string;
  supplierName?: string;
  acknowledged: boolean;
  acknowledgedAt?: string;
  /** What they said they would do. Absent where they never acknowledged. */
  intendToBid?: boolean;
  returned: boolean;
  returnedAt?: string;
  submissionId?: string;
  clarificationsRaised: number;
  /**
   * What this bidder is, in one word, so a list can be read rather than
   * decoded. `BROKEN_PROMISE` is deliberately not called "declined": they said
   * they would bid.
   */
  outcome: 'RETURNED' | 'DECLINED' | 'BROKEN_PROMISE' | 'SILENT' | 'AWAITED';
};

export type TenderReconciliation = {
  rfqId: string;
  reference: string;
  status: RFQStatus;
  returnDeadline: string;
  /** Whether the deadline has passed, which changes what silence means. */
  closed: boolean;
  invited: number;
  acknowledged: number;
  intendingToBid: number;
  returned: number;
  bidders: BidderPosition[];
  /**
   * Returns that name this RFQ from a firm that was never invited. Reported
   * rather than filtered: a return from an uninvited firm is either a data
   * fault or a procurement irregularity, and both need somebody to look.
   */
  uninvitedReturns: string[];
  /**
   * The honest limit on this answer, where there is one.
   *
   * A supplier now records the party it trades as, so an invitation and a
   * return name the same firm and this is normally absent. It survives for the
   * records that predate the join: the ledger is append-only, firms registered
   * before suppliers carried a party cannot be matched to their returns, and
   * where *no* return matches *any* invitation that is one missing join rather
   * than a supply chain that ignored the enquiry. Saying so beats publishing a
   * reconciliation that reconciles nothing while looking as though it does.
   */
  unmatchable?: string;
  summary: string;
  /** Where the competition is thin enough that the award is exposed. */
  concern?: string;
};

export function reconcileTenderResponses(
  ctx: EngineContext,
  rfqId: string,
  today = new Date().toISOString(),
): TenderReconciliation {
  authorise(ctx, 'PROCUREMENT_AWARD', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const rfq = ctx.ledger.require({ refType: 'RFQ', refId: rfqId });
  const invited = (rfq.state.invitedSupplierIds as string[]) ?? [];
  const acknowledgements = (rfq.state.acknowledgements as Array<Record<string, unknown>>) ?? [];
  const deadline = String(rfq.state.returnDeadline);
  const closed = today > deadline;

  const submissions = ctx.ledger
    .list(ctx.projectId, 'SupplierSubmission')
    .filter((record) => record.state.rfqId === rfqId);
  const clarifications = ctx.ledger
    .list(ctx.projectId, 'Clarification')
    .filter((record) => record.state.rfqId === rfqId);

  // The join, read rather than guessed. A submission records the register entry
  // its party resolved to at the moment it arrived; where it does not, the firm
  // was registered before suppliers carried a party and the fallback compares
  // the raw identifiers, which is what the record supports and no more.
  const registerIdOf = (record: (typeof submissions)[number]): string =>
    typeof record.state.supplierId === 'string' ? record.state.supplierId : String(record.state.supplierPartyId);

  const bidders: BidderPosition[] = invited.map((supplierId) => {
    const supplier = ctx.ledger.get({ refType: 'Supplier', refId: supplierId });
    const partyId = typeof supplier?.state.partyId === 'string' ? supplier.state.partyId : undefined;
    // An acknowledgement is written under whichever identifier the acknowledging
    // party held, so both are accepted rather than one being assumed.
    const ack = acknowledgements.find(
      (entry) => entry.supplierId === supplierId || (partyId !== undefined && entry.supplierId === partyId),
    );
    const submission = submissions.find((record) => registerIdOf(record) === supplierId);
    const intendToBid = ack ? Boolean(ack.intendToBid) : undefined;

    // Before the deadline an unreturned bid is not yet a failure; after it, the
    // distinction between declining and going quiet is the whole point.
    const outcome: BidderPosition['outcome'] = submission
      ? 'RETURNED'
      : intendToBid === false
        ? 'DECLINED'
        : !closed
          ? 'AWAITED'
          : intendToBid === true
            ? 'BROKEN_PROMISE'
            : 'SILENT';

    return {
      supplierId,
      // From the register where it is known, so the list reads as the firms
      // that were invited rather than as a column of identifiers.
      supplierName: supplier ? String(supplier.state.legalName) : submission ? String(submission.state.supplierName) : undefined,
      acknowledged: ack !== undefined,
      acknowledgedAt: ack ? String(ack.at) : undefined,
      intendToBid,
      returned: submission !== undefined,
      returnedAt: submission ? String(submission.state.receivedAt) : undefined,
      submissionId: submission?.refId,
      clarificationsRaised: clarifications.filter(
        (record) => record.state.supplierId === supplierId || (partyId !== undefined && record.state.supplierId === partyId),
      ).length,
      outcome,
    };
  });

  const invitedSet = new Set(invited);
  const uninvitedReturns = submissions
    .filter((record) => !invitedSet.has(registerIdOf(record)))
    .map((record) => String(record.state.supplierName));

  // No return matched any invitation, and returns exist. That is the missing
  // join rather than a supply chain that ignored the enquiry, and reporting it
  // as the latter would send somebody chasing three firms that did in fact bid.
  const unmatchable =
    submissions.length > 0 && submissions.length === uninvitedReturns.length && invited.length > 0
      ? 'No return matches any invitation. These firms were registered before a supplier recorded the party it ' +
        'trades as, so the platform holds nothing joining the two identifiers — the outcomes below are what the ' +
        'record supports and not what happened. Re-registering the firms against their parties makes this exact; ' +
        'the ledger is append-only, so the existing entries cannot be amended in place.'
      : undefined;

  const returned = bidders.filter((bidder) => bidder.returned).length;
  const intendingToBid = bidders.filter((bidder) => bidder.intendToBid === true).length;
  const broken = bidders.filter((bidder) => bidder.outcome === 'BROKEN_PROMISE');
  const silent = bidders.filter((bidder) => bidder.outcome === 'SILENT');

  // Three is the conventional floor for a comparable return, and below it the
  // exposure is the award rather than the price: a single return is a
  // negotiation, and an audit will read it as one.
  const concern =
    unmatchable !== undefined
      ? undefined
      : closed && returned === 0
      ? 'Nothing was returned. The package goes back to market or the requirement changes; there is nothing here to award.'
      : closed && returned === 1
        ? 'One return is a negotiation, not a competition. Awarding on it is defensible only if the reason is recorded now rather than reconstructed later.'
        : closed && returned === 2
          ? 'Two returns give a price and no market. Enough to award, not enough to prove the price.'
          : silent.length > invited.length / 2
            ? `${silent.length} of ${invited.length} invited firms never acknowledged. That is a question about whether the enquiry reached them, not about the bidders.`
            : undefined;

  return {
    rfqId,
    reference: String(rfq.state.reference),
    status: String(rfq.state.status) as RFQStatus,
    returnDeadline: deadline,
    closed,
    invited: invited.length,
    acknowledged: bidders.filter((bidder) => bidder.acknowledged).length,
    intendingToBid,
    returned,
    bidders,
    uninvitedReturns,
    ...(unmatchable ? { unmatchable } : {}),
    summary:
      invited.length === 0
        ? 'Nobody was invited, so there is nothing to reconcile.'
        : `${returned} of ${invited.length} invited ${returned === 1 ? 'firm has' : 'firms have'} returned` +
          `${closed ? ', and the deadline has passed' : `, with the deadline on ${deadline.slice(0, 10)}`}.` +
          (broken.length > 0
            ? ` ${broken.length} said ${broken.length === 1 ? 'it' : 'they'} intended to bid and did not return.`
            : '') +
          (uninvitedReturns.length > 0
            ? ` ${uninvitedReturns.length} return${uninvitedReturns.length === 1 ? '' : 's'} came from a firm that was never invited.`
            : ''),
  };
}
