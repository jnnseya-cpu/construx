import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, registerEvidence, write, type EngineContext } from '../engines/context.ts';
import { hashEvidence } from '../core/canonical.ts';
import type { EntityRecord } from '../goldenthread/ledger.ts';

/**
 * Clarifications, addenda and tender return intelligence — T-WF-06.
 *
 * Three things happen between issuing an enquiry and adjudicating it, and all
 * three are where a tender is challenged.
 *
 * **Somebody asks a question.** Internally, of the client, or from a bidder. The
 * answer changes what is being priced, and it has to reach everybody entitled to
 * it at the same time. A bidder who got the answer and a bidder who did not are
 * not competing on the same information, and that is not a process defect — it
 * is grounds to set the award aside.
 *
 * **An addendum arrives.** That register is already built: the invitation holds
 * the addenda (T-WF-01) and the frozen review measures what each one touched
 * (T-WF-02). Nothing here rebuilds it.
 *
 * **The returns come back and get compared.** This is the dangerous one. Two
 * quotations are never on the same basis, so somebody adjusts them until they
 * are — and the adjustments are where the comparison stops being a comparison
 * and starts being an opinion. The rule here is that **the raw return is never
 * touched** and **every adjustment names its source**: a line in a return, or an
 * issued clarification. That is `AC-T-WF-06-01`, and it is a refusal rather than
 * a report, because an unsourced adjustment is indistinguishable from a
 * preference once a week has passed.
 *
 * ---
 *
 * **Recipients and issue times are on the record.** `AC-T-WF-06-02`. Who was
 * told, when, and whether they opened it. The question a year later is never
 * what the answer was — it is whether one bidder had it three days earlier.
 *
 * **An open question lowers the confidence in the comparison.** `AC-T-WF-06-03`.
 * A comparison presented as complete while a material query is outstanding is
 * the thing that gets adjudicated on, and the query is then somebody's problem
 * on site. Completeness falls, ranking is suppressed, and the value at risk in
 * the open queries is carried forward as priced risk rather than lost.
 */

// --- The clarification register ---------------------------------------------

/**
 * Who the question is between.
 *
 * `INTERNAL` — the bid team asking itself; nothing leaves the tenancy.
 * `CLIENT` — a question to the client or their agent, answered by addendum or
 *   by written response, and the answer is the same for every bidder.
 * `BIDDER` — a question from a firm pricing one of our packages.
 */
export const CLARIFICATION_SIDE = ['INTERNAL', 'CLIENT', 'BIDDER'] as const;
export type ClarificationSide = (typeof CLARIFICATION_SIDE)[number];

/**
 * `OPEN` answers go to everybody entitled to them. `COMMERCIAL_IN_CONFIDENCE`
 * is one bidder's own commercial position — their rate, their programme, their
 * subcontractor — and it goes back to them and nobody else.
 */
export const CONFIDENTIALITY = ['OPEN', 'COMMERCIAL_IN_CONFIDENCE'] as const;
export type Confidentiality = (typeof CONFIDENTIALITY)[number];

/**
 * What the question is about, in the controlled information.
 *
 * At least one is required. A clarification that names nothing cannot be
 * answered twice the same way, and cannot be found by the person who later
 * prices the thing it was about.
 */
export type InformationLink = {
  document?: string;
  clause?: string;
  drawing?: string;
  /** The RFQ or package reference the question concerns. */
  package?: string;
  /** The scope-matrix item, where the question came out of the review. */
  scopeItem?: string;
};

export type ClarificationRecipient = {
  partyId: string;
  name: string;
  /** Whether this party is one of the bidders, which is what the fence checks. */
  isBidder: boolean;
};

function requireClarification(ctx: EngineContext, clarificationId: string): EntityRecord {
  const record = ctx.ledger.get({ refType: 'Clarification', refId: clarificationId });
  if (!record) throw new DomainError('CLARIFICATION_NOT_FOUND', `No clarification ${clarificationId}`, 404);
  return record;
}

function hasLink(links: InformationLink): boolean {
  return Boolean(
    links.document?.trim() ||
      links.clause?.trim() ||
      links.drawing?.trim() ||
      links.package?.trim() ||
      links.scopeItem?.trim(),
  );
}

/**
 * Raise a clarification on the tender rather than on one RFQ.
 *
 * The RFQ-scoped supplier question already exists as
 * `procurement.raiseClarification`, and this does not replace it: both write
 * `CLARIFICATION_RAISED` against the same `Clarification` entity and share one
 * `TQ-nnn` sequence, so the register is one register. What this adds is the two
 * sides that had nowhere to go — the internal question and the question to the
 * client — and the link into the controlled information that makes an answer
 * findable.
 */
export function raiseTenderClarification(
  ctx: EngineContext,
  input: {
    side: ClarificationSide;
    subject: string;
    question: string;
    links: InformationLink;
    /** When an answer is needed. A question with no date is a question nobody chases. */
    responseDeadline?: string;
    confidentiality?: Confidentiality;
    /** Required for a bidder-side question: the firm that asked it. */
    bidderPartyId?: string;
  },
): { clarificationId: string; reference: string } {
  authorise(ctx, 'PROCUREMENT_AWARD', 'C', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  if (!input.subject.trim() || !input.question.trim()) {
    throw new DomainError('CLARIFICATION_EMPTY', 'A clarification needs a subject and the question itself.');
  }

  if (!hasLink(input.links)) {
    throw new DomainError(
      'CLARIFICATION_UNLINKED',
      'Name what this question is about — a document, a clause, a drawing, a package or a scope item. ' +
        'An answer that is not attached to the information it changes will not be found by the person pricing it.',
    );
  }

  if (input.side === 'BIDDER' && !input.bidderPartyId?.trim()) {
    throw new DomainError(
      'BIDDER_NOT_NAMED',
      'A bidder-side clarification names the firm that asked it. Without that there is no way to tell whether the answer went back to them.',
    );
  }

  const confidentiality: Confidentiality = input.confidentiality ?? 'OPEN';
  if (confidentiality === 'COMMERCIAL_IN_CONFIDENCE' && input.side !== 'BIDDER') {
    throw new DomainError(
      'CONFIDENTIALITY_NOT_APPLICABLE',
      'Commercial-in-confidence describes one bidder’s own position. An internal or client-side question has no bidder to keep it from.',
    );
  }

  const sequence = ctx.ledger.list(ctx.projectId, 'Clarification').length + 1;
  const reference = `TQ-${String(sequence).padStart(3, '0')}`;
  const clarificationId = ulid();

  write(ctx, {
    eventType: 'CLARIFICATION_RAISED',
    entity: { refType: 'Clarification', refId: clarificationId },
    nextState: {
      id: clarificationId,
      projectId: ctx.projectId,
      reference,
      side: input.side,
      subject: input.subject,
      question: input.question,
      links: input.links,
      responseDeadline: input.responseDeadline,
      confidentiality,
      supplierId: input.bidderPartyId,
      status: 'OPEN',
      raisedAt: new Date().toISOString(),
      raisedBy: ctx.auth.actorId,
    },
  });

  return { clarificationId, reference };
}

/**
 * Issue the approved response.
 *
 * `AC-T-WF-06-02`: the recipients and the time are the record. Two refusals
 * guard the two ways this goes wrong — a confidential answer reaching a
 * competitor, and an open answer reaching only the firm that asked.
 */
export function issueClarification(
  ctx: EngineContext,
  input: {
    clarificationId: string;
    response: string;
    recipients: ClarificationRecipient[];
    /** Every bidder entitled to an open answer. Supplied by the caller from the enquiry. */
    entitledBidders?: string[];
  },
): { issuedAt: string; recipients: number } {
  authorise(ctx, 'PROCUREMENT_AWARD', 'U', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireClarification(ctx, input.clarificationId);

  if (record.state.status === 'ISSUED') {
    throw new DomainError(
      'CLARIFICATION_ALREADY_ISSUED',
      `${String(record.state.reference)} was issued on ${String(record.state.issuedAt)}. A changed answer is a new clarification, ` +
        'because the first one has already been priced against.',
    );
  }

  if (!input.response.trim()) {
    throw new DomainError('RESPONSE_EMPTY', 'There is no answer to issue.');
  }

  if (input.recipients.length === 0) {
    throw new DomainError(
      'NO_RECIPIENTS',
      'An answer issued to nobody is an answer nobody has. Name who it goes to.',
    );
  }

  const side = record.state.side ?? (record.state.rfqId ? 'BIDDER' : 'INTERNAL');
  const confidentiality = (record.state.confidentiality as Confidentiality) ?? 'OPEN';
  const asker = record.state.supplierId as string | undefined;

  // The fence. A bidder's own commercial position goes back to that bidder.
  if (confidentiality === 'COMMERCIAL_IN_CONFIDENCE') {
    const leaked = input.recipients.filter((r) => r.isBidder && r.partyId !== asker);
    if (leaked.length > 0) {
      throw new DomainError(
        'CONFIDENTIAL_DISCLOSURE_REFUSED',
        `${String(record.state.reference)} is commercial-in-confidence to the firm that raised it. ` +
          `Issuing it to ${leaked.map((r) => r.name).join(', ')} would put one bidder’s commercial position in a competitor’s hands.`,
      );
    }
  }

  // The other half of the same fence. An open answer that reaches only the firm
  // that asked leaves every other bidder pricing the old information.
  if (side === 'BIDDER' && confidentiality === 'OPEN' && input.entitledBidders && input.entitledBidders.length > 0) {
    const reached = new Set(input.recipients.filter((r) => r.isBidder).map((r) => r.partyId));
    const missed = input.entitledBidders.filter((b) => !reached.has(b));
    if (missed.length > 0) {
      throw new DomainError(
        'BIDDER_EXCLUDED',
        `${missed.length} bidder${missed.length === 1 ? '' : 's'} entitled to this answer ${missed.length === 1 ? 'is' : 'are'} not on the ` +
          `distribution: ${missed.join(', ')}. Returns priced on different information are not comparable, and the award is challengeable.`,
      );
    }
  }

  const issuedAt = new Date().toISOString();

  const evidence = registerEvidence(ctx, {
    type: 'CLARIFICATION_ISSUE',
    hash: hashEvidence(JSON.stringify({ reference: record.state.reference, response: input.response, recipients: input.recipients, issuedAt })),
    description: `${String(record.state.reference)} issued to ${input.recipients.length} recipient${input.recipients.length === 1 ? '' : 's'}`,
    linkedEntities: [{ refType: 'Clarification', refId: input.clarificationId }],
  });

  write(ctx, {
    eventType: 'CLARIFICATION_ISSUED',
    entity: { refType: 'Clarification', refId: input.clarificationId },
    nextState: {
      ...record.state,
      status: 'ISSUED',
      answer: input.response,
      response: input.response,
      issuedAt,
      issuedBy: ctx.auth.actorId,
      distribution: input.recipients.map((r) => ({ ...r, issuedAt })),
      acknowledgements: [],
    },
    evidenceRefs: [evidence],
  });

  return { issuedAt, recipients: input.recipients.length };
}

/**
 * Read evidence. Being sent an answer and having read it are different facts,
 * and the second is the one that matters when a bidder says they never saw it.
 */
export function acknowledgeClarification(
  ctx: EngineContext,
  input: { clarificationId: string; partyId: string },
): { acknowledgedAt: string } {
  const record = requireClarification(ctx, input.clarificationId);

  if (record.state.status !== 'ISSUED') {
    throw new DomainError(
      'CLARIFICATION_NOT_ISSUED',
      'Nothing has been issued, so there is nothing to acknowledge.',
    );
  }

  const distribution = (record.state.distribution as ClarificationRecipient[]) ?? [];
  if (!distribution.some((r) => r.partyId === input.partyId)) {
    throw new DomainError(
      'NOT_A_RECIPIENT',
      `${input.partyId} is not on the distribution for ${String(record.state.reference)}.`,
      403,
    );
  }

  // A supplier acknowledges only for themselves. Anybody else acknowledging on
  // their behalf destroys the only value the record has.
  if (ctx.auth.roles.includes('SUPPLIER') && ctx.auth.partyId !== input.partyId) {
    throw new DomainError('SUPPLIER_IDENTITY_MISMATCH', 'A firm acknowledges only its own receipt.', 403);
  }

  const acknowledgements = (record.state.acknowledgements as Array<{ partyId: string; at: string }>) ?? [];
  if (acknowledgements.some((a) => a.partyId === input.partyId)) {
    return { acknowledgedAt: acknowledgements.find((a) => a.partyId === input.partyId)!.at };
  }

  const acknowledgedAt = new Date().toISOString();

  write(ctx, {
    eventType: 'CLARIFICATION_ACKNOWLEDGED',
    entity: { refType: 'Clarification', refId: input.clarificationId },
    nextState: {
      ...record.state,
      acknowledgements: [...acknowledgements, { partyId: input.partyId, at: acknowledgedAt }],
    },
  });

  return { acknowledgedAt };
}

// --- The return comparison ---------------------------------------------------

export type RawReturnLine = {
  reference: string;
  description: string;
  amountMinor: number;
};

export type RawReturn = {
  bidderPartyId: string;
  bidderName: string;
  submittedAt: string;
  lines: RawReturnLine[];
  exclusions: string[];
  qualifications: string[];
  /** The sum of the lines. Held so a later read never has to trust arithmetic done elsewhere. */
  totalMinor: number;
};

/**
 * Why a return was adjusted. Every one of these is a normalisation, not a
 * judgement about who should win.
 */
export const ADJUSTMENT_BASIS_CATEGORY = [
  'SCOPE_ADDED',
  'SCOPE_REMOVED',
  'EXCLUSION_PRICED',
  'QUALIFICATION_PRICED',
  'ATTENDANCE_MOVED',
  'PROGRAMME_IMPACT',
  'TAX_OR_CURRENCY',
  'ARITHMETIC_CORRECTION',
] as const;
export type AdjustmentBasisCategory = (typeof ADJUSTMENT_BASIS_CATEGORY)[number];

export type ComparisonAdjustment = {
  reference: string;
  bidderPartyId: string;
  category: AdjustmentBasisCategory;
  /** Signed. Positive adds to the bidder's evaluated cost. */
  amountMinor: number;
  reason: string;
  /** Exactly one of these is what makes the adjustment traceable. */
  fromReturnLine?: string;
  fromClarification?: string;
  recordedBy: string;
  recordedAt: string;
};

export type ComparisonQuery = {
  reference: string;
  bidderPartyId: string;
  subject: string;
  /** Material means the comparison cannot be relied on until it is answered. */
  material: boolean;
  /** What it is worth if it goes the wrong way. Carried to adjudication while open. */
  valueAtRiskMinor: number;
  status: 'OPEN' | 'RESOLVED';
  resolution?: string;
  resolvedByClarification?: string;
};

function requireComparison(ctx: EngineContext, comparisonId: string): EntityRecord {
  const record = ctx.ledger.get({ refType: 'ReturnComparison', refId: comparisonId });
  if (!record) throw new DomainError('COMPARISON_NOT_FOUND', `No return comparison ${comparisonId}`, 404);
  return record;
}

function assertComparisonOpen(record: EntityRecord): void {
  if (record.state.status === 'CLOSED') {
    throw new DomainError(
      'COMPARISON_CLOSED',
      `${String(record.state.reference)} was closed for adjudication. A change after that is a new comparison.`,
    );
  }
}

export function openComparison(
  ctx: EngineContext,
  input: {
    packageReference: string;
    /** The deadline the returns were priced to, and the information they were priced on. */
    returnDeadline: string;
    informationCutOff: string;
    bidders: Array<{ partyId: string; name: string }>;
  },
): { comparisonId: string; reference: string } {
  authorise(ctx, 'PROCUREMENT_AWARD', 'C', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  if (input.bidders.length < 2) {
    throw new DomainError(
      'COMPARISON_NEEDS_TWO',
      'A comparison of one return is a price, not a comparison. Record a single return against the package directly.',
    );
  }

  const partyIds = new Set(input.bidders.map((b) => b.partyId));
  if (partyIds.size !== input.bidders.length) {
    throw new DomainError('BIDDER_LISTED_TWICE', 'The same firm appears twice in the bidder list.');
  }

  const sequence = ctx.ledger.list(ctx.projectId, 'ReturnComparison').length + 1;
  const reference = `TC-${String(sequence).padStart(3, '0')}`;
  const comparisonId = ulid();

  write(ctx, {
    eventType: 'RETURN_COMPARISON_UPDATED',
    entity: { refType: 'ReturnComparison', refId: comparisonId },
    nextState: {
      id: comparisonId,
      projectId: ctx.projectId,
      reference,
      packageReference: input.packageReference,
      returnDeadline: input.returnDeadline,
      informationCutOff: input.informationCutOff,
      bidders: input.bidders,
      returns: [] as RawReturn[],
      adjustments: [] as ComparisonAdjustment[],
      queries: [] as ComparisonQuery[],
      status: 'OPEN',
      openedAt: new Date().toISOString(),
      openedBy: ctx.auth.actorId,
    },
  });

  return { comparisonId, reference };
}

/**
 * Record a return exactly as it arrived.
 *
 * Written once. Everything the comparison does to it afterwards is an
 * adjustment sitting beside it, never an edit — which is what lets the position
 * show raw, adjustments and evaluated as three separate numbers that reconcile.
 */
export function recordRawReturn(
  ctx: EngineContext,
  comparisonId: string,
  input: {
    bidderPartyId: string;
    submittedAt: string;
    lines: RawReturnLine[];
    exclusions?: string[];
    qualifications?: string[];
  },
): { totalMinor: number } {
  authorise(ctx, 'PROCUREMENT_AWARD', 'U', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireComparison(ctx, comparisonId);
  assertComparisonOpen(record);

  const bidders = (record.state.bidders as Array<{ partyId: string; name: string }>) ?? [];
  const bidder = bidders.find((b) => b.partyId === input.bidderPartyId);
  if (!bidder) {
    throw new DomainError(
      'BIDDER_NOT_IN_COMPARISON',
      `${input.bidderPartyId} is not one of the firms in ${String(record.state.reference)}.`,
    );
  }

  const returns = (record.state.returns as RawReturn[]) ?? [];
  if (returns.some((r) => r.bidderPartyId === input.bidderPartyId)) {
    throw new DomainError(
      'RAW_RETURN_IMMUTABLE',
      `${bidder.name}’s return is already recorded and does not change. A revised price is a new comparison; ` +
        'a correction to what they meant is an adjustment, which keeps their number visible beside it.',
    );
  }

  if (input.lines.length === 0) {
    throw new DomainError('RETURN_EMPTY', 'A return with no priced lines is a non-submission, not a return.');
  }

  const totalMinor = input.lines.reduce((sum, line) => sum + line.amountMinor, 0);

  const raw: RawReturn = {
    bidderPartyId: input.bidderPartyId,
    bidderName: bidder.name,
    submittedAt: input.submittedAt,
    lines: input.lines,
    exclusions: input.exclusions ?? [],
    qualifications: input.qualifications ?? [],
    totalMinor,
  };

  const evidence = registerEvidence(ctx, {
    type: 'RAW_TENDER_RETURN',
    hash: hashEvidence(JSON.stringify(raw)),
    description: `${bidder.name} — return as received against ${String(record.state.packageReference)}`,
    linkedEntities: [{ refType: 'ReturnComparison', refId: comparisonId }],
  });

  write(ctx, {
    eventType: 'RETURN_COMPARISON_UPDATED',
    entity: { refType: 'ReturnComparison', refId: comparisonId },
    nextState: { ...record.state, returns: [...returns, raw] },
    evidenceRefs: [evidence],
  });

  return { totalMinor };
}

/**
 * Adjust a return onto the common basis.
 *
 * `AC-T-WF-06-01`. Every adjustment cites the return line it corrects or the
 * issued clarification that authorises it, and neither is optional. A
 * clarification cited before it was issued is refused as well — an adjustment
 * resting on an answer nobody has sent rests on nothing.
 */
export function adjustComparison(
  ctx: EngineContext,
  comparisonId: string,
  input: {
    bidderPartyId: string;
    category: AdjustmentBasisCategory;
    amountMinor: number;
    reason: string;
    fromReturnLine?: string;
    fromClarification?: string;
  },
): { reference: string } {
  authorise(ctx, 'PROCUREMENT_AWARD', 'U', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireComparison(ctx, comparisonId);
  assertComparisonOpen(record);

  const returns = (record.state.returns as RawReturn[]) ?? [];
  const raw = returns.find((r) => r.bidderPartyId === input.bidderPartyId);
  if (!raw) {
    throw new DomainError(
      'NO_RETURN_TO_ADJUST',
      `${input.bidderPartyId} has no recorded return in ${String(record.state.reference)}. Record what they sent before adjusting it.`,
    );
  }

  if (!input.fromReturnLine?.trim() && !input.fromClarification?.trim()) {
    throw new DomainError(
      'ADJUSTMENT_UNSOURCED',
      'Every adjustment cites the return line it corrects or the clarification that authorises it. ' +
        'An adjustment with no source cannot be told apart from a preference once the meeting is over.',
    );
  }

  if (input.fromReturnLine && !raw.lines.some((l) => l.reference === input.fromReturnLine)) {
    throw new DomainError(
      'UNKNOWN_RETURN_LINE',
      `${raw.bidderName}’s return has no line ${input.fromReturnLine}.`,
    );
  }

  if (input.fromClarification) {
    const clarifications = ctx.ledger.list(ctx.projectId, 'Clarification');
    const cited = clarifications.find((c) => c.state.reference === input.fromClarification);
    if (!cited) {
      throw new DomainError('UNKNOWN_CLARIFICATION', `There is no clarification ${input.fromClarification} on this project.`);
    }
    if (cited.state.status !== 'ISSUED' && cited.state.status !== 'ANSWERED') {
      throw new DomainError(
        'CLARIFICATION_NOT_ISSUED',
        `${input.fromClarification} has not been answered. An adjustment resting on a question nobody has answered rests on nothing.`,
      );
    }
  }

  if (!input.reason.trim()) {
    throw new DomainError('ADJUSTMENT_REASON_REQUIRED', 'Say what the adjustment is for in terms somebody else can check.');
  }

  const adjustments = (record.state.adjustments as ComparisonAdjustment[]) ?? [];
  const reference = `ADJ-${String(adjustments.length + 1).padStart(3, '0')}`;

  const adjustment: ComparisonAdjustment = {
    reference,
    bidderPartyId: input.bidderPartyId,
    category: input.category,
    amountMinor: input.amountMinor,
    reason: input.reason,
    fromReturnLine: input.fromReturnLine,
    fromClarification: input.fromClarification,
    recordedBy: ctx.auth.actorId,
    recordedAt: new Date().toISOString(),
  };

  write(ctx, {
    eventType: 'RETURN_COMPARISON_UPDATED',
    entity: { refType: 'ReturnComparison', refId: comparisonId },
    nextState: { ...record.state, adjustments: [...adjustments, adjustment] },
  });

  return { reference };
}

/**
 * Raise a query against a return.
 *
 * A material one is the difference between a comparison you can adjudicate on
 * and one you cannot: while it is open, completeness falls, ranking is
 * suppressed, and what it is worth is carried to adjudication as priced risk.
 */
export function raiseComparisonQuery(
  ctx: EngineContext,
  comparisonId: string,
  input: { bidderPartyId: string; subject: string; material: boolean; valueAtRiskMinor: number },
): { reference: string } {
  authorise(ctx, 'PROCUREMENT_AWARD', 'U', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireComparison(ctx, comparisonId);
  assertComparisonOpen(record);

  const bidders = (record.state.bidders as Array<{ partyId: string; name: string }>) ?? [];
  if (!bidders.some((b) => b.partyId === input.bidderPartyId)) {
    throw new DomainError('BIDDER_NOT_IN_COMPARISON', `${input.bidderPartyId} is not one of the firms in this comparison.`);
  }

  if (input.material && input.valueAtRiskMinor <= 0) {
    throw new DomainError(
      'MATERIAL_QUERY_NEEDS_A_VALUE',
      'A material query is one that moves the number. Say what it is worth if it goes the wrong way — that figure is what gets ' +
        'carried to adjudication while the query is open, and a zero would carry nothing.',
    );
  }

  const queries = (record.state.queries as ComparisonQuery[]) ?? [];
  const reference = `CQ-${String(queries.length + 1).padStart(3, '0')}`;

  const query: ComparisonQuery = {
    reference,
    bidderPartyId: input.bidderPartyId,
    subject: input.subject,
    material: input.material,
    valueAtRiskMinor: input.material ? input.valueAtRiskMinor : 0,
    status: 'OPEN',
  };

  write(ctx, {
    eventType: 'RETURN_COMPARISON_UPDATED',
    entity: { refType: 'ReturnComparison', refId: comparisonId },
    nextState: { ...record.state, queries: [...queries, query] },
  });

  return { reference };
}

export function resolveComparisonQuery(
  ctx: EngineContext,
  comparisonId: string,
  input: { reference: string; resolution: string; clarification?: string },
): void {
  authorise(ctx, 'PROCUREMENT_AWARD', 'U', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireComparison(ctx, comparisonId);
  assertComparisonOpen(record);

  const queries = (record.state.queries as ComparisonQuery[]) ?? [];
  const query = queries.find((q) => q.reference === input.reference);
  if (!query) throw new DomainError('QUERY_NOT_FOUND', `No query ${input.reference} on this comparison.`, 404);
  if (query.status === 'RESOLVED') {
    throw new DomainError('QUERY_ALREADY_RESOLVED', `${input.reference} was already resolved.`);
  }
  if (!input.resolution.trim()) {
    throw new DomainError('RESOLUTION_REQUIRED', 'Say what the answer was.');
  }

  write(ctx, {
    eventType: 'RETURN_COMPARISON_UPDATED',
    entity: { refType: 'ReturnComparison', refId: comparisonId },
    nextState: {
      ...record.state,
      queries: queries.map((q) =>
        q.reference === input.reference
          ? { ...q, status: 'RESOLVED' as const, resolution: input.resolution, resolvedByClarification: input.clarification }
          : q,
      ),
    },
  });
}

// --- The comparison itself ---------------------------------------------------

export type ComparedBidder = {
  partyId: string;
  name: string;
  returned: boolean;
  rawMinor: number;
  adjustmentsMinor: number;
  evaluatedMinor: number;
  adjustments: ComparisonAdjustment[];
  openQueries: string[];
  carriedRiskMinor: number;
};

export type ComparisonResult = {
  reference: string;
  packageReference: string;
  bidders: ComparedBidder[];
  /** Present only when ranking is not suppressed. Lowest evaluated cost first. */
  ranking?: string[];
  rankingSuppressed: boolean;
  suppressionReason?: string;
  /** 0–100. Falls with unreturned bidders and with open material queries. */
  completeness: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  /** What the open material queries are worth, carried to adjudication. */
  carriedRiskMinor: number;
  summary: string;
};

/**
 * Compare, with the confidence stated.
 *
 * `AC-T-WF-06-03`. Completeness counts the things this comparison needs to know
 * — one return from each firm asked, and one answer to each material query —
 * against the ones it has. A single count, so it is reproducible and arguable
 * in the right way: you can disagree that a query is material, which is a
 * decision somebody made and recorded.
 *
 * It is deliberately **not** the two proportions multiplied. That was the first
 * version and it was wrong on a real case: both firms returned, one query open,
 * and the screen said 0% settled. Nobody believes a number that says nothing is
 * known about a comparison holding two complete priced returns, and a measure
 * nobody believes is worse than none.
 *
 * Confidence is stated from the facts rather than from a threshold on the
 * percentage, because "76% therefore medium" is a number pretending to be a
 * judgement. A firm that has not returned is `LOW`; everything in with a
 * material query open is `MEDIUM`; everything in and everything answered is
 * `HIGH`.
 *
 * Ranking is suppressed while either is short of complete. A ranked list is
 * read as a recommendation however it is labelled, and the failure this
 * prevents is a package awarded on a comparison somebody knew was incomplete.
 */
export function compareReturns(ctx: EngineContext, comparisonId: string): ComparisonResult {
  authorise(ctx, 'PROCUREMENT_AWARD', 'X', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });
  return computeComparison(requireComparison(ctx, comparisonId));
}

/**
 * The arithmetic, with no authorisation of its own.
 *
 * Separate because the callers hold different rights and the matrix is right
 * about that: the QS runs the comparison (`X`) and the commercial manager
 * closes it (`A`), and neither holds the other's. Making `closeComparison` call
 * the authorising `compareReturns` would have demanded both from one person.
 */
function computeComparison(record: EntityRecord): ComparisonResult {
  const bidderList = (record.state.bidders as Array<{ partyId: string; name: string }>) ?? [];
  const returns = (record.state.returns as RawReturn[]) ?? [];
  const adjustments = (record.state.adjustments as ComparisonAdjustment[]) ?? [];
  const queries = (record.state.queries as ComparisonQuery[]) ?? [];

  const bidders: ComparedBidder[] = bidderList.map((b) => {
    const raw = returns.find((r) => r.bidderPartyId === b.partyId);
    const mine = adjustments.filter((a) => a.bidderPartyId === b.partyId);
    const adjustmentsMinor = mine.reduce((sum, a) => sum + a.amountMinor, 0);
    const open = queries.filter((q) => q.bidderPartyId === b.partyId && q.status === 'OPEN');
    return {
      partyId: b.partyId,
      name: b.name,
      returned: Boolean(raw),
      rawMinor: raw?.totalMinor ?? 0,
      adjustmentsMinor,
      evaluatedMinor: (raw?.totalMinor ?? 0) + adjustmentsMinor,
      adjustments: mine,
      openQueries: open.map((q) => q.reference),
      carriedRiskMinor: open.filter((q) => q.material).reduce((sum, q) => sum + q.valueAtRiskMinor, 0),
    };
  });

  const returnedCount = bidders.filter((b) => b.returned).length;
  const material = queries.filter((q) => q.material);
  const materialOpen = material.filter((q) => q.status === 'OPEN');

  // One count, not two proportions multiplied: the things this comparison needs
  // to know are one return per firm asked and one answer per material query.
  const needed = bidderList.length + material.length;
  const held = returnedCount + (material.length - materialOpen.length);
  const completeness = needed === 0 ? 0 : Math.round((100 * held) / needed);

  const confidence: ComparisonResult['confidence'] =
    returnedCount < bidderList.length ? 'LOW' : materialOpen.length > 0 ? 'MEDIUM' : 'HIGH';

  const reasons: string[] = [];
  if (returnedCount < bidderList.length) {
    reasons.push(`${bidderList.length - returnedCount} of ${bidderList.length} firms have not returned`);
  }
  if (materialOpen.length > 0) {
    reasons.push(`${materialOpen.length} material quer${materialOpen.length === 1 ? 'y is' : 'ies are'} open`);
  }

  const carriedRiskMinor = materialOpen.reduce((sum, q) => sum + q.valueAtRiskMinor, 0);
  const rankingSuppressed = reasons.length > 0;

  const ranked = bidders
    .filter((b) => b.returned)
    .slice()
    .sort((a, b) => a.evaluatedMinor - b.evaluatedMinor)
    .map((b) => b.name);

  const summary = rankingSuppressed
    ? `${String(record.state.reference)} is ${completeness}% complete — ${reasons.join(', ')}. Ranking is suppressed and ` +
      `${(carriedRiskMinor / 100).toFixed(2)} of unresolved variance is carried to adjudication.`
    : `${String(record.state.reference)} is complete: ${returnedCount} returns compared on a common basis, every adjustment sourced.`;

  return {
    reference: String(record.state.reference),
    packageReference: String(record.state.packageReference),
    bidders,
    ranking: rankingSuppressed ? undefined : ranked,
    rankingSuppressed,
    suppressionReason: rankingSuppressed ? reasons.join('; ') : undefined,
    completeness,
    confidence,
    carriedRiskMinor,
    summary,
  };
}

/**
 * Close the comparison for adjudication.
 *
 * Not refused while queries are open — a bid deadline does not wait for an
 * answer, and pretending otherwise would only teach people to mark queries
 * immaterial. What is refused is closing it while the carried risk is unstated:
 * the closing record names what is being carried, so adjudication sees it.
 */
export function closeComparison(
  ctx: EngineContext,
  comparisonId: string,
  input: { rationale: string },
): { carriedRiskMinor: number; completeness: number } {
  authorise(ctx, 'PROCUREMENT_AWARD', 'A', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireComparison(ctx, comparisonId);
  assertComparisonOpen(record);

  const returns = (record.state.returns as RawReturn[]) ?? [];
  if (returns.length === 0) {
    throw new DomainError('NOTHING_TO_ADJUDICATE', 'No returns have been recorded on this comparison.');
  }

  if (!input.rationale.trim()) {
    throw new DomainError('RATIONALE_REQUIRED', 'Say why the comparison is being closed in the state it is in.');
  }

  const result = computeComparison(record);

  write(ctx, {
    eventType: 'RETURN_COMPARISON_UPDATED',
    entity: { refType: 'ReturnComparison', refId: comparisonId },
    nextState: {
      ...record.state,
      status: 'CLOSED',
      closedAt: new Date().toISOString(),
      closedBy: ctx.auth.actorId,
      closingRationale: input.rationale,
      closingCompleteness: result.completeness,
      carriedRiskMinor: result.carriedRiskMinor,
      carriedQueries: result.bidders.flatMap((b) => b.openQueries),
    },
  });

  return { carriedRiskMinor: result.carriedRiskMinor, completeness: result.completeness };
}

// --- The position ------------------------------------------------------------

export type TenderIntelPosition = {
  clarifications: Array<{
    clarificationId: string;
    reference: string;
    side: ClarificationSide;
    subject: string;
    status: string;
    confidentiality: Confidentiality;
    links: InformationLink;
    responseDeadline?: string;
    issuedAt?: string;
    recipients: number;
    acknowledged: number;
  }>;
  comparisons: Array<{
    comparisonId: string;
    reference: string;
    packageReference: string;
    status: string;
    completeness: number;
    confidence: string;
    carriedRiskMinor: number;
    rankingSuppressed: boolean;
  }>;
  summary: string;
};

export function tenderIntelPosition(ctx: EngineContext): TenderIntelPosition {
  authorise(ctx, 'PROCUREMENT_AWARD', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const clarifications = ctx.ledger.list(ctx.projectId, 'Clarification').map((record) => {
    const distribution = (record.state.distribution as ClarificationRecipient[]) ?? [];
    const acknowledgements = (record.state.acknowledgements as Array<{ partyId: string }>) ?? [];
    return {
      clarificationId: String(record.state.id ?? record.refId),
      reference: String(record.state.reference),
      side: (record.state.side as ClarificationSide) ?? (record.state.rfqId ? 'BIDDER' : 'INTERNAL'),
      subject: String(record.state.subject ?? record.state.question ?? ''),
      status: String(record.state.status),
      confidentiality: (record.state.confidentiality as Confidentiality) ?? 'OPEN',
      links: (record.state.links as InformationLink) ?? {},
      responseDeadline: record.state.responseDeadline as string | undefined,
      issuedAt: (record.state.issuedAt ?? record.state.answeredAt) as string | undefined,
      recipients: distribution.length,
      acknowledged: acknowledgements.length,
    };
  });

  const comparisons = ctx.ledger.list(ctx.projectId, 'ReturnComparison').map((record) => {
    const result = computeComparison(record);
    return {
      comparisonId: String(record.state.id),
      reference: result.reference,
      packageReference: result.packageReference,
      status: String(record.state.status),
      completeness: result.completeness,
      confidence: result.confidence,
      carriedRiskMinor: result.carriedRiskMinor,
      rankingSuppressed: result.rankingSuppressed,
    };
  });

  const unanswered = clarifications.filter((c) => c.status === 'OPEN').length;
  const suppressed = comparisons.filter((c) => c.rankingSuppressed).length;

  const parts: string[] = [];
  parts.push(`${clarifications.length} clarification${clarifications.length === 1 ? '' : 's'}`);
  if (unanswered > 0) parts.push(`${unanswered} unanswered`);
  parts.push(`${comparisons.length} comparison${comparisons.length === 1 ? '' : 's'}`);
  if (suppressed > 0) parts.push(`${suppressed} with ranking suppressed`);

  return { clarifications, comparisons, summary: parts.join(', ') + '.' };
}
