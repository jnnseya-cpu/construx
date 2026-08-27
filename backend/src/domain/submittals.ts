import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';
import type { EntityRecord } from '../goldenthread/ledger.ts';

/**
 * Material and technical approval submittals.
 *
 * Built because the platform could not generate a material approval submittal
 * without it, and it closes a gap the corporate control standard already
 * declared open rather than hid: `DEL.SUBMITTALS` carried a `notTrackedReason`
 * saying "supplier submissions are tender returns, not technical submittals",
 * which was true and is now not.
 *
 * A submittal is the act of proposing a specific product against a specific
 * clause and getting it accepted before it is bought. Everything expensive
 * about submittals happens in the gap between those two facts, and this module
 * is built around the three ways that gap goes wrong.
 *
 * **A submittal that answers nothing.** A product data sheet with no clause
 * reference cannot be reviewed against anything, so the reviewer approves *a
 * product* rather than *a compliance*, and the approval is worth nothing when
 * the clause is produced two years later. Every submittal here cites the clause
 * it answers, and the clause has to exist on the project.
 *
 * **A compliance claim with only one side of it.** "Complies" against a
 * requirement, with no specified value and no offered value beside it, is an
 * assertion the reviewer is being asked to countersign. The comparison is
 * recorded with both numbers or it is not recorded.
 *
 * **An approval that arrives after the material had to be ordered.** This is
 * the one that actually costs money, and it is invisible on every submittal
 * register that tracks only status. A product with a fourteen-week lead time
 * needed on site in October had to be approved in June; an approval in August
 * is an approval and a delay at the same time. The platform computes that date
 * at submission, reports the position against it, and — where somebody orders
 * anyway — records the order as placed at risk rather than pretending it was
 * covered.
 *
 * What this module deliberately does **not** do is refuse a late approval or an
 * at-risk order. Both are real acts that real projects perform for good
 * commercial reasons. Refusing them would push them off the platform and into
 * an inbox, which is the one outcome that makes the register worse than useless.
 */

export const SUBMITTAL_KIND = [
  /** A named product proposed against a specification. */
  'MATERIAL',
  /** A physical sample or benchmark panel offered for approval. */
  'SAMPLE',
  /** A fabrication or installation drawing produced by the contractor. */
  'SHOP_DRAWING',
  /** A calculation demonstrating the design intent is met. */
  'CALCULATION',
  /** A method of installation offered for acceptance. */
  'METHOD',
  /** A certificate, declaration of performance or test report. */
  'CERTIFICATE',
] as const;
export type SubmittalKind = (typeof SUBMITTAL_KIND)[number];

/**
 * The reviewer's decision, in the four states that actually differ in what the
 * contractor may then do.
 *
 * `APPROVED_WITH_COMMENTS` is not a softer approval — it is the state where
 * work may proceed *and* something must still be done, and collapsing it into
 * either neighbour loses one of those two facts.
 */
export const REVIEW_OUTCOME = ['APPROVED', 'APPROVED_WITH_COMMENTS', 'REVISE_AND_RESUBMIT', 'REJECTED'] as const;
export type ReviewOutcome = (typeof REVIEW_OUTCOME)[number];

/** The outcomes after which the material may be bought and built. */
const PERMITS_ORDER: readonly ReviewOutcome[] = ['APPROVED', 'APPROVED_WITH_COMMENTS'];

export type ComplianceClaim = {
  /** The requirement as the specification states it — "fire rating", "U-value". */
  requirement: string;
  /** What the specification demands. */
  specified: string;
  /** What the offered product actually achieves. */
  offered: string;
  compliant: boolean;
  /** Required where `compliant` is false. Why it is being offered anyway. */
  justification?: string;
};

export type SubmittalState = {
  id: string;
  reference: string;
  kind: SubmittalKind;
  title: string;
  clauseId: string;
  clauseRef: string;
  specificationRef: string;
  manufacturer: string;
  productReference: string;
  claims: ComplianceClaim[];
  substitution?: { differsFrom: string; whyProposed: string };
  procurementLeadTimeDays: number;
  requiredOnSiteBy: string;
  /** `requiredOnSiteBy` minus the lead time. The date the decision is actually needed. */
  approvalNeededBy: string;
  reviewPeriodDays: number;
  status: 'DRAFT' | 'UNDER_REVIEW' | 'APPROVED' | 'APPROVED_WITH_COMMENTS' | 'REVISE_AND_RESUBMIT' | 'REJECTED';
  revision: string;
  cycles: number;
  firstSubmittedAt?: string;
  submittedAt?: string;
  submittedBy?: string;
  reviewDueBy?: string;
  reviewedAt?: string;
  reviewedBy?: string;
  reviewComments?: string;
  ordered?: { at: string; by: string; atRisk: boolean; justification?: string; orderReference: string };
};

const DAY_MS = 86_400_000;

function addDays(isoDate: string, days: number): string {
  return new Date(Date.parse(isoDate) + days * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(to) - Date.parse(from)) / DAY_MS);
}

function requireSubmittal(ctx: EngineContext, submittalId: string): EntityRecord {
  const record = ctx.ledger.get({ refType: 'MaterialSubmittal', refId: submittalId });
  if (!record) throw new DomainError('SUBMITTAL_NOT_FOUND', `No submittal ${submittalId}`, 404);
  return record;
}

function stateOf(record: EntityRecord): SubmittalState {
  return record.state as unknown as SubmittalState;
}

/**
 * Validate the compliance comparison.
 *
 * Split out because it runs on both the first submission and every
 * resubmission, and a revision that quietly dropped the offered values would
 * otherwise slip past a check the original had to pass.
 */
function assertClaimsAnswerable(claims: ComplianceClaim[]): void {
  if (claims.length === 0) {
    throw new DomainError(
      'NOTHING_CLAIMED',
      'A submittal with no requirement compared is a product data sheet with a cover sheet on it. Name what the ' +
        'specification demands and what this product achieves, one line per requirement, so the reviewer is agreeing to ' +
        'something rather than initialling a brochure.',
    );
  }

  for (const claim of claims) {
    if (!claim.requirement.trim() || !claim.specified.trim() || !claim.offered.trim()) {
      throw new DomainError(
        'CLAIM_ONE_SIDED',
        `"${claim.requirement || 'an unnamed requirement'}" is missing the specified value, the offered value or both. ` +
          'A compliance claim with one side of the comparison is an assertion the reviewer is being asked to countersign.',
      );
    }
    if (!claim.compliant && !claim.justification?.trim()) {
      throw new DomainError(
        'DEPARTURE_UNJUSTIFIED',
        `"${claim.requirement}" is offered as not complying with the specification, with no reason given. A departure is a ` +
          'proposal the designer can accept or refuse; an unexplained one is a defect submitted for approval.',
      );
    }
  }
}

/**
 * Raise a submittal against a clause that exists.
 *
 * The clause lookup is the point of the whole record. A submittal reference
 * typed as free text would let somebody cite `E10/17` on a project whose
 * specification has no section E10, and nothing downstream — not the register,
 * not the coverage report, not the generated document — could tell.
 */
export function raiseSubmittal(
  ctx: EngineContext,
  input: {
    kind: SubmittalKind;
    title: string;
    clauseId: string;
    manufacturer: string;
    productReference: string;
    claims: ComplianceClaim[];
    procurementLeadTimeDays: number;
    requiredOnSiteBy: string;
    reviewPeriodDays: number;
    substitution?: { differsFrom: string; whyProposed: string };
  },
): { submittalId: string; reference: string; approvalNeededBy: string; alreadyLate: boolean } {
  authorise(ctx, 'DESIGN_INFORMATION', 'C');

  const clause = ctx.ledger.get({ refType: 'SpecClause', refId: input.clauseId });
  if (!clause || clause.state.projectId !== ctx.projectId) {
    throw new DomainError(
      'CLAUSE_NOT_FOUND',
      'No specification clause on this project has that id. A submittal cites the clause it answers, and a citation that ' +
        'resolves to nothing cannot be reviewed against anything — the reviewer would be approving a product rather than a ' +
        'compliance, which is worth nothing when the clause is produced two years later.',
      404,
    );
  }

  if (!input.title.trim() || !input.manufacturer.trim() || !input.productReference.trim()) {
    throw new DomainError(
      'PRODUCT_UNIDENTIFIED',
      'Name the manufacturer and the product reference. "Proprietary insulation board" is not a thing anybody can order, ' +
        'inspect on delivery or check against what was approved.',
    );
  }

  if (Number.isNaN(Date.parse(input.requiredOnSiteBy))) {
    throw new DomainError('REQUIRED_DATE_INVALID', `"${input.requiredOnSiteBy}" is not a date.`);
  }
  if (!Number.isFinite(input.procurementLeadTimeDays) || input.procurementLeadTimeDays < 0) {
    throw new DomainError(
      'LEAD_TIME_REQUIRED',
      'State the procurement lead time in days. Without it the platform cannot say when this decision is actually needed, ' +
        'and a submittal register that tracks only status is exactly the register that discovers a delay after it has ' +
        'happened. Zero is a legitimate answer for something held in stock; leaving it out is not.',
    );
  }
  if (!Number.isFinite(input.reviewPeriodDays) || input.reviewPeriodDays <= 0) {
    throw new DomainError(
      'REVIEW_PERIOD_REQUIRED',
      'State the review period the contract allows. A review with no period against it is never late, which is why it is ' +
        'never chased.',
    );
  }

  if (input.substitution && (!input.substitution.differsFrom.trim() || !input.substitution.whyProposed.trim())) {
    throw new DomainError(
      'SUBSTITUTION_UNSTATED',
      'This is offered as an alternative to what was specified, without saying what it is an alternative to or why. That is ' +
        'the shape of every substitution that gets approved and then argued about: the reviewer accepted a product and is ' +
        'later told they accepted a change.',
    );
  }

  assertClaimsAnswerable(input.claims);

  const approvalNeededBy = addDays(input.requiredOnSiteBy, -input.procurementLeadTimeDays);
  const today = new Date().toISOString().slice(0, 10);
  const sequence = ctx.ledger.list(ctx.projectId, 'MaterialSubmittal').length + 1;
  const reference = `SUB-${String(clause.state.specificationRef ?? '').replace(/\s+/g, '') || 'GEN'}-${String(sequence).padStart(3, '0')}`;
  const submittalId = ulid();

  write(ctx, {
    eventType: 'SUBMITTAL_RAISED',
    entity: { refType: 'MaterialSubmittal', refId: submittalId },
    nextState: {
      id: submittalId,
      projectId: ctx.projectId,
      reference,
      kind: input.kind,
      title: input.title,
      clauseId: input.clauseId,
      clauseRef: clause.state.clauseRef,
      specificationRef: clause.state.specificationRef,
      clauseMandatory: clause.state.mandatory,
      manufacturer: input.manufacturer,
      productReference: input.productReference,
      claims: input.claims,
      substitution: input.substitution,
      procurementLeadTimeDays: input.procurementLeadTimeDays,
      requiredOnSiteBy: input.requiredOnSiteBy,
      approvalNeededBy,
      reviewPeriodDays: input.reviewPeriodDays,
      status: 'DRAFT',
      revision: 'A',
      cycles: 0,
      raisedBy: ctx.auth.actorId,
      raisedAt: new Date().toISOString(),
    },
  });

  // Reported, not refused. A submittal raised after the date it was needed is a
  // fact about the project, and the register exists to make it visible on the
  // day rather than to argue with the person recording it.
  return { submittalId, reference, approvalNeededBy, alreadyLate: approvalNeededBy < today };
}

/** Send it for review, which starts the contractual clock. */
export function submitForReview(
  ctx: EngineContext,
  submittalId: string,
): { reviewDueBy: string; approvalNeededBy: string; slackDays: number } {
  authorise(ctx, 'DESIGN_INFORMATION', 'U');

  const record = requireSubmittal(ctx, submittalId);
  const state = stateOf(record);

  if (state.status === 'UNDER_REVIEW') {
    throw new DomainError('ALREADY_UNDER_REVIEW', `${state.reference} is already with the reviewer.`);
  }
  if (PERMITS_ORDER.includes(state.status as ReviewOutcome)) {
    throw new DomainError(
      'ALREADY_APPROVED',
      `${state.reference} is already approved. Resubmit it as a revision if the product has changed — an approval is against ` +
        'a specific product reference, and quietly reusing it for a different one is how the wrong material arrives.',
    );
  }

  const now = new Date().toISOString();
  const submittedOn = now.slice(0, 10);
  const reviewDueBy = addDays(submittedOn, state.reviewPeriodDays);

  write(ctx, {
    eventType: 'SUBMITTAL_ISSUED',
    entity: { refType: 'MaterialSubmittal', refId: submittalId },
    nextState: {
      ...record.state,
      status: 'UNDER_REVIEW',
      submittedAt: now,
      submittedBy: ctx.auth.actorId,
      // Set once and never reset. How long this product has been going round in
      // circles is the number that matters on a third cycle, and a field that
      // moved with each resubmission would report a nine-month argument as a
      // fortnight old.
      firstSubmittedAt: state.firstSubmittedAt ?? now,
      reviewDueBy,
      cycles: state.cycles + 1,
    },
  });

  return {
    reviewDueBy,
    approvalNeededBy: state.approvalNeededBy,
    // Negative means the contractual review period runs out after the date the
    // decision was needed — the programme is exposed even if nobody is late.
    slackDays: daysBetween(reviewDueBy, state.approvalNeededBy),
  };
}

/**
 * The reviewer's decision.
 *
 * Separation of duties is enforced here rather than in the matrix, for the
 * usual reason: the matrix can express "may approve" and cannot express "not
 * the same person who submitted it".
 */
export function reviewSubmittal(
  ctx: EngineContext,
  submittalId: string,
  input: { outcome: ReviewOutcome; comments: string },
): { outcome: ReviewOutcome; daysLate: number; mayOrder: boolean; reviewOverdueByDays: number } {
  authorise(ctx, 'DESIGN_INFORMATION', 'A');

  const record = requireSubmittal(ctx, submittalId);
  const state = stateOf(record);

  if (state.status !== 'UNDER_REVIEW') {
    throw new DomainError(
      'NOT_UNDER_REVIEW',
      `${state.reference} has not been submitted for review, so there is nothing to decide on.`,
    );
  }
  if (state.submittedBy === ctx.auth.actorId) {
    throw new DomainError(
      'SELF_REVIEW_REFUSED',
      'The person who submitted this cannot be the person who approves it. A submittal exists so that somebody other than ' +
        'the party buying the material agrees it meets the specification; one signature doing both jobs is the approval ' +
        'process omitted with paperwork left over.',
    );
  }
  if (input.outcome !== 'APPROVED' && !input.comments.trim()) {
    throw new DomainError(
      'DECISION_UNEXPLAINED',
      'Say what is wrong with it. A rejection or a resubmission request with nothing beside it sends the contractor back ' +
        'to guess, and the second cycle fails for a reason the first one never named.',
    );
  }

  const now = new Date().toISOString();
  const decidedOn = now.slice(0, 10);

  write(ctx, {
    eventType: 'SUBMITTAL_REVIEWED',
    entity: { refType: 'MaterialSubmittal', refId: submittalId },
    nextState: {
      ...record.state,
      status: input.outcome,
      reviewedAt: now,
      reviewedBy: ctx.auth.actorId,
      reviewComments: input.comments,
    },
  });

  return {
    outcome: input.outcome,
    // How late the *decision* is against the date the material had to be
    // ordered. This is the number the register is for.
    daysLate: Math.max(0, daysBetween(state.approvalNeededBy, decidedOn)),
    // How late the reviewer is against the period the contract allows. A
    // different question with a different answer, and on most contracts a
    // different party's problem.
    reviewOverdueByDays: state.reviewDueBy ? Math.max(0, daysBetween(state.reviewDueBy, decidedOn)) : 0,
    mayOrder: PERMITS_ORDER.includes(input.outcome),
  };
}

/**
 * Resubmit after a revise-and-resubmit or a rejection.
 *
 * A new revision letter on the same record rather than a new record: the point
 * of a submittal register is that somebody can see a product went round three
 * times, and splitting each cycle into its own row is how that becomes
 * invisible.
 */
export function resubmit(
  ctx: EngineContext,
  submittalId: string,
  input: {
    manufacturer?: string;
    productReference?: string;
    claims: ComplianceClaim[];
    substitution?: { differsFrom: string; whyProposed: string };
    whatChanged: string;
  },
): { revision: string; cycles: number } {
  authorise(ctx, 'DESIGN_INFORMATION', 'U');

  const record = requireSubmittal(ctx, submittalId);
  const state = stateOf(record);

  if (state.status !== 'REVISE_AND_RESUBMIT' && state.status !== 'REJECTED') {
    throw new DomainError(
      'NOT_RETURNED',
      `${state.reference} is ${state.status.replace(/_/g, ' ').toLowerCase()}, not returned for revision. Nothing has been ` +
        'asked for.',
    );
  }
  if (!input.whatChanged.trim()) {
    throw new DomainError(
      'CHANGE_UNSTATED',
      'Say what changed since the last revision. A reviewer given an unmarked resubmission either re-reads the whole thing ' +
        'or initials it, and on a third cycle it is always the second.',
    );
  }

  assertClaimsAnswerable(input.claims);

  const revision = state.revision === 'Z' ? 'AA' : String.fromCharCode(state.revision.charCodeAt(0) + 1);

  write(ctx, {
    eventType: 'SUBMITTAL_RESUBMITTED',
    entity: { refType: 'MaterialSubmittal', refId: submittalId },
    nextState: {
      ...record.state,
      status: 'DRAFT',
      revision,
      manufacturer: input.manufacturer?.trim() || state.manufacturer,
      productReference: input.productReference?.trim() || state.productReference,
      claims: input.claims,
      substitution: input.substitution ?? state.substitution,
      whatChanged: input.whatChanged,
      // Cleared deliberately. The previous decision was against the previous
      // revision, and carrying it forward would show revision B as approved on
      // the strength of a review of revision A.
      reviewedAt: undefined,
      reviewedBy: undefined,
      reviewComments: undefined,
      reviewDueBy: undefined,
    },
  });

  return { revision, cycles: state.cycles };
}

/**
 * Record that the material was ordered.
 *
 * Ordering an unapproved long-lead item is a real commercial decision that real
 * projects take, so this does not refuse it — it refuses to record it as though
 * it were covered. `atRisk` with a justification is a governed act somebody
 * owns; the same order with `atRisk` unset is a claim the material was approved,
 * and that claim is refused.
 */
export function recordOrdered(
  ctx: EngineContext,
  submittalId: string,
  input: { orderReference: string; atRisk?: boolean; justification?: string },
): { atRisk: boolean; status: string } {
  authorise(ctx, 'DESIGN_INFORMATION', 'U');

  const record = requireSubmittal(ctx, submittalId);
  const state = stateOf(record);

  if (!input.orderReference.trim()) {
    throw new DomainError('ORDER_REFERENCE_REQUIRED', 'Record the order or purchase reference the material was bought on.');
  }
  if (state.ordered) {
    throw new DomainError(
      'ALREADY_ORDERED',
      `${state.reference} was already ordered on ${state.ordered.orderReference}.`,
    );
  }

  const approved = PERMITS_ORDER.includes(state.status as ReviewOutcome);

  if (!approved && !input.atRisk) {
    throw new DomainError(
      'ORDERED_WITHOUT_APPROVAL',
      `${state.reference} is ${state.status.replace(/_/g, ' ').toLowerCase()}, not approved. Ordering a long-lead item ` +
        'before approval is a legitimate commercial decision and the platform will record it — but it will record it as ' +
        'placed at risk, with a reason and the person who took it. Recording it as an ordinary order would put the exposure ' +
        'nowhere, and the exposure is the entire content of the decision.',
    );
  }
  if (!approved && !input.justification?.trim()) {
    throw new DomainError(
      'RISK_UNJUSTIFIED',
      'An order placed at risk carries the reason it was worth taking. "Programme" is not a reason; what happens if the ' +
        'submittal comes back rejected is.',
    );
  }

  write(ctx, {
    eventType: 'SUBMITTAL_ORDERED',
    entity: { refType: 'MaterialSubmittal', refId: submittalId },
    nextState: {
      ...record.state,
      ordered: {
        at: new Date().toISOString(),
        by: ctx.auth.actorId,
        atRisk: !approved,
        justification: input.justification,
        orderReference: input.orderReference,
      },
    },
  });

  return { atRisk: !approved, status: state.status };
}

// --- The position -----------------------------------------------------------

export type SubmittalPosition = {
  submittals: Array<{
    submittalId: string;
    reference: string;
    revision: string;
    kind: string;
    title: string;
    manufacturer: string;
    productReference: string;
    clauseRef: string;
    specificationRef: string;
    status: string;
    cycles: number;
    isSubstitution: boolean;
    departures: number;
    approvalNeededBy: string;
    /** Days between now and the date the decision is needed. Negative is past it. */
    daysToDecision: number;
    reviewOverdueByDays: number;
    orderedAtRisk: boolean;
  }>;
  /** Awaiting a decision that is already past the contractual review period. */
  reviewsOverdue: number;
  /** Not yet approved, and past the date the material had to be ordered. */
  pastOrderingDate: number;
  /** Ordered on the strength of a decision that has not been taken. */
  atRisk: number;
  /** On a third cycle or worse — a product nobody is converging on. */
  circling: number;
  summary: string;
};

export function submittalPosition(ctx: EngineContext, today = new Date().toISOString().slice(0, 10)): SubmittalPosition {
  authorise(ctx, 'DESIGN_INFORMATION', 'R');

  const submittals = ctx.ledger.list(ctx.projectId, 'MaterialSubmittal').map((record) => {
    const state = stateOf(record);
    const settled = PERMITS_ORDER.includes(state.status as ReviewOutcome);
    return {
      submittalId: state.id,
      reference: state.reference,
      revision: state.revision,
      kind: state.kind,
      title: state.title,
      manufacturer: state.manufacturer,
      productReference: state.productReference,
      clauseRef: state.clauseRef,
      specificationRef: state.specificationRef,
      status: state.status,
      cycles: state.cycles,
      isSubstitution: state.substitution !== undefined,
      departures: state.claims.filter((claim) => !claim.compliant).length,
      approvalNeededBy: state.approvalNeededBy,
      daysToDecision: daysBetween(today, state.approvalNeededBy),
      reviewOverdueByDays:
        state.status === 'UNDER_REVIEW' && state.reviewDueBy ? Math.max(0, daysBetween(state.reviewDueBy, today)) : 0,
      orderedAtRisk: state.ordered?.atRisk === true,
      settled,
    };
  });

  // Soonest decision first. A register sorted by when it was raised buries the
  // one that needed answering last week under forty that are fine.
  submittals.sort((a, b) => a.approvalNeededBy.localeCompare(b.approvalNeededBy));

  const reviewsOverdue = submittals.filter((s) => s.reviewOverdueByDays > 0).length;
  const pastOrderingDate = submittals.filter((s) => !s.settled && s.daysToDecision < 0).length;
  const atRisk = submittals.filter((s) => s.orderedAtRisk).length;
  const circling = submittals.filter((s) => s.cycles >= 3).length;

  const parts = [`${submittals.length} submittal${submittals.length === 1 ? '' : 's'}`];
  if (pastOrderingDate > 0) parts.push(`${pastOrderingDate} past the date the material had to be ordered`);
  if (reviewsOverdue > 0) parts.push(`${reviewsOverdue} awaiting a decision beyond the review period`);
  if (atRisk > 0) parts.push(`${atRisk} ordered at risk`);
  if (circling > 0) parts.push(`${circling} on a third cycle or worse`);

  return {
    submittals: submittals.map(({ settled: _settled, ...rest }) => rest),
    reviewsOverdue,
    pastOrderingDate,
    atRisk,
    circling,
    summary: parts.join(', ') + '.',
  };
}
