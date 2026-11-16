import { DomainError } from '../core/errors.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';
import { ALL_ROLES, type Role } from '../identity/roles.ts';
import { complianceMatrix, liveWaivers, type MatrixLine } from './itt.ts';
import { describeQuoteSource, type QuoteSource } from './tendersource.ts';

/**
 * Where each requirement of a tender stands, in the five words a bid review uses.
 *
 * The matrix already tests every requirement it can against the company's own
 * records — SATISFIED, GAP, or UNKNOWN where nothing can be tested. A bid review
 * needs more than that: whether a line is **Confirmed**, only **Assumed**,
 * **Conflicting** between documents, **Missing**, or waiting on a **Decision**,
 * and on what basis — and never to treat a line nobody checked as met.
 *
 * The platform's own test gives every line a status and its basis. A person can
 * then record a review of a line — an assumption and what it rests on, a
 * conflict and the references that conflict, a decision with an owner and a
 * date — which stands on the record beside the waivers. Two rules keep the
 * review honest against the company's records, which stay the one source of
 * truth for what the business holds:
 *
 *   - a line the records show as a gap cannot be reviewed as Confirmed: the
 *     evidence is recorded in the company's facts, and that clears it;
 *   - evidence recorded after a line was reviewed as Missing confirms it, and
 *     evidence that lapses after a line was reviewed as Confirmed makes it
 *     Missing again — the records move, the position follows.
 */

export const REVIEW_STATUSES = ['CONFIRMED', 'ASSUMED', 'CONFLICTING', 'MISSING', 'DECISION_REQUIRED'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export type RequirementReview = {
  reference: string;
  status: ReviewStatus;
  /** What the status rests on: the evidence, the assumption, the references that conflict. */
  basis: string;
  /** The next thing to do, where the reviewer names one. */
  action?: string;
  /** Who makes the decision, for DECISION_REQUIRED. */
  owner?: Role;
  /** By when, for DECISION_REQUIRED. */
  decisionDue?: string;
  /** For MISSING on a pass/fail line: false where the business appears unable to meet it at all. */
  obtainable?: boolean;
  reviewedBy: string;
  reviewedAt: string;
};

export type LinePosition = {
  reference: string;
  requirement: string;
  mandatory: boolean;
  status: ReviewStatus;
  basis: string;
  /** PLATFORM where the status is the platform's own test; otherwise the person who reviewed it. */
  setBy: 'PLATFORM' | string;
  setAt?: string;
  /** Pass/fail, or the marks and limit the line is scored on. */
  threshold: string;
  action: string;
  owner: Role;
  due?: string;
  source?: QuoteSource;
  sourceText: string;
  waived: boolean;
};

export type MatrixPosition = {
  analysisId: string;
  reference: string;
  lines: LinePosition[];
  counts: Record<ReviewStatus, number>;
  /** The pass/fail lines, sorted three ways — the split a bid decision is made on. */
  gates: { met: string[]; needEvidence: string[]; cannotMeet: string[] };
  /** Lines whose wording was not found in the documents. */
  untraced: string[];
  summary: string;
};

function reviewsOf(state: Record<string, unknown>): RequirementReview[] {
  return (state.reviews as RequirementReview[] | undefined) ?? [];
}

function latestReview(reviews: RequirementReview[], reference: string): RequirementReview | undefined {
  return reviews.filter((review) => review.reference === reference).at(-1);
}

function thresholdOf(line: MatrixLine, minimumQualityScore: string | undefined): string {
  if (line.mandatory) return 'Pass/fail';
  const parts = [
    line.weightingPercent === undefined ? 'Scored, weighting not stated' : `${line.weightingPercent}% of the marks`,
    line.responseLimit?.statedAs,
    minimumQualityScore ? `minimum: ${minimumQualityScore}` : undefined,
  ];
  return parts.filter(Boolean).join(' · ');
}

/** Where every line stands, its basis, and what to do next. */
export function matrixPosition(ctx: EngineContext, analysisId: string): MatrixPosition {
  authorise(ctx, 'ESTIMATE_TENDER', 'R', { dataSensitivity: 'COMMERCIAL_L3' });
  const analysis = complianceMatrix(ctx, analysisId);
  const record = ctx.ledger.require({ refType: 'ITTAnalysis', refId: analysisId });
  const state = record.state as Record<string, unknown>;
  const reviews = reviewsOf(state);
  const waived = new Set(liveWaivers(ctx, analysisId).map((waiver) => waiver.reference));
  const particulars = state.particulars as { evaluation?: { minimumQualityScore?: string | null } } | undefined;
  const minimum = particulars?.evaluation?.minimumQualityScore ?? undefined;

  const lines = analysis.matrix.map((line): LinePosition => {
    const review = latestReview(reviews, line.reference);
    let status: ReviewStatus;
    let basis: string;
    let setBy: LinePosition['setBy'] = 'PLATFORM';
    let setAt: string | undefined;
    if (review && !(review.status === 'MISSING' && line.status === 'SATISFIED') && !(review.status === 'CONFIRMED' && line.status === 'GAP')) {
      status = review.status;
      basis = review.basis;
      setBy = review.reviewedBy;
      setAt = review.reviewedAt;
    } else if (line.status === 'SATISFIED') {
      status = 'CONFIRMED';
      basis = `On the company's records: ${line.evidenceHeld ?? 'evidence held'}.` + (review ? ' Recorded since the line was reviewed as missing.' : '');
    } else if (line.status === 'GAP') {
      status = 'MISSING';
      basis =
        review?.status === 'CONFIRMED'
          ? `Reviewed as confirmed on ${review.reviewedAt.slice(0, 10)}, but the company's records no longer hold it: ${line.evidenceRequired}.`
          : `Nothing on the company's records meets it: ${line.evidenceRequired}.`;
    } else {
      status = 'MISSING';
      basis = 'Not checked: the platform cannot test this against the company’s records, so it is not treated as met until a person reviews it.';
    }

    const action =
      review?.action && setBy !== 'PLATFORM'
        ? review.action
        : status === 'CONFIRMED'
          ? '—'
          : status === 'MISSING' && line.mandatory && review?.obtainable === false && setBy !== 'PLATFORM'
            ? 'Decide whether to bid: this is pass/fail and appears not to be obtainable'
            : status === 'MISSING' && line.mandatory
              ? `Obtain and record the evidence: ${line.evidenceRequired}`
              : status === 'MISSING'
                ? line.weightingPercent !== undefined || line.responseLimit
                  ? 'Write and approve the answer'
                  : `Provide: ${line.evidenceRequired}`
                : status === 'ASSUMED'
                  ? 'Confirm the assumption, or put it to the buyer as a clarification'
                  : status === 'CONFLICTING'
                    ? 'Raise a clarification for the buyer to rule on'
                    : 'Make the decision';

    return {
      reference: line.reference,
      requirement: line.requirement,
      mandatory: line.mandatory,
      status,
      basis,
      setBy,
      ...(setAt ? { setAt } : {}),
      threshold: thresholdOf(line, minimum ?? undefined),
      action,
      owner: (setBy !== 'PLATFORM' && review?.owner) || line.owner,
      ...((setBy !== 'PLATFORM' && review?.decisionDue) || line.dueBy ? { due: (setBy !== 'PLATFORM' && review?.decisionDue) || line.dueBy } : {}),
      ...(line.source ? { source: line.source } : {}),
      sourceText: describeQuoteSource(line.source),
      waived: waived.has(line.reference),
    };
  });

  const counts = Object.fromEntries(REVIEW_STATUSES.map((status) => [status, 0])) as Record<ReviewStatus, number>;
  for (const line of lines) counts[line.status] += 1;
  const gateLines = lines.filter((line) => line.mandatory && !line.waived);
  const cannotMeet = gateLines
    .filter((line) => line.status === 'MISSING' && latestReview(reviews, line.reference)?.obtainable === false && line.setBy !== 'PLATFORM')
    .map((line) => line.reference);
  const gates = {
    met: gateLines.filter((line) => line.status === 'CONFIRMED').map((line) => line.reference),
    needEvidence: gateLines.filter((line) => line.status !== 'CONFIRMED' && !cannotMeet.includes(line.reference)).map((line) => line.reference),
    cannotMeet,
  };
  const untraced = lines.filter((line) => line.source && !line.source.located).map((line) => line.reference);

  const open = lines.length - counts.CONFIRMED;
  return {
    analysisId,
    reference: analysis.reference,
    lines,
    counts,
    gates,
    untraced,
    summary:
      `${counts.CONFIRMED} of ${lines.length} confirmed` +
      (open > 0 ? `; ${open} open (${REVIEW_STATUSES.filter((s) => s !== 'CONFIRMED' && counts[s] > 0).map((s) => `${counts[s]} ${s.toLowerCase().replace('_', ' ')}`).join(', ')})` : '') +
      `. Pass/fail: ${gates.met.length} met, ${gates.needEvidence.length} need evidence` +
      (gates.cannotMeet.length > 0 ? `, ${gates.cannotMeet.length} appear unable to be met` : '') +
      '.',
  };
}

const BASIS_MIN = 10;

/** A person's review of one line: its status, what it rests on, and what happens next. */
export function reviewRequirement(
  ctx: EngineContext,
  analysisId: string,
  input: {
    reference: string;
    status: ReviewStatus;
    basis: string;
    action?: string;
    owner?: Role;
    decisionDue?: string;
    obtainable?: boolean;
  },
): LinePosition {
  authorise(ctx, 'ESTIMATE_TENDER', 'U', { dataSensitivity: 'COMMERCIAL_L3' });
  const analysis = complianceMatrix(ctx, analysisId);
  const line = analysis.matrix.find((entry) => entry.reference === input.reference);
  if (!line) {
    throw new DomainError('REQUIREMENT_NOT_FOUND', `${input.reference} is not a line on this matrix.`, 404, [
      { field: 'reference', message: 'choose a line on the matrix' },
    ]);
  }
  if (!REVIEW_STATUSES.includes(input.status)) {
    throw new DomainError('REVIEW_STATUS_INVALID', `A line is one of ${REVIEW_STATUSES.join(', ')}.`, 422, [
      { field: 'status', message: 'choose a status' },
    ]);
  }
  const basis = input.basis.trim();
  if (basis.length < BASIS_MIN) {
    throw new DomainError(
      'REVIEW_BASIS_REQUIRED',
      input.status === 'ASSUMED'
        ? 'Say what the assumption is and what it rests on, so whoever prices or answers from it knows.'
        : input.status === 'CONFLICTING'
          ? 'Name the references that conflict — the document and clause on each side.'
          : 'Say what this rests on, so the record shows why.',
      422,
      [{ field: 'basis', message: `at least ${BASIS_MIN} characters` }],
    );
  }
  if (input.status === 'CONFIRMED' && line.status === 'GAP') {
    throw new DomainError(
      'RECORD_THE_EVIDENCE',
      `The company's records hold nothing that meets ${input.reference} (${line.evidenceRequired}). Record it in the company's ` +
        'facts — the insurance, accreditation or reference — and the line is confirmed from them, on every tender that asks.',
      409,
    );
  }
  if (input.status === 'DECISION_REQUIRED') {
    const problems: Array<{ field: string; message: string }> = [];
    if (!input.owner || !ALL_ROLES.includes(input.owner)) problems.push({ field: 'owner', message: 'who decides' });
    if (!input.decisionDue || !/^\d{4}-\d{2}-\d{2}$/.test(input.decisionDue)) problems.push({ field: 'decisionDue', message: 'by when, YYYY-MM-DD' });
    else if (analysis.returnBy && input.decisionDue > analysis.returnBy.slice(0, 10)) {
      problems.push({ field: 'decisionDue', message: `on or before the return, ${analysis.returnBy.slice(0, 10)}` });
    }
    if (problems.length > 0) {
      throw new DomainError('DECISION_NEEDS_OWNER_AND_DATE', 'A decision needs someone to make it and a date it is made by.', 422, problems);
    }
  }
  if (input.obtainable !== undefined && !(input.status === 'MISSING' && line.mandatory)) {
    throw new DomainError('OBTAINABLE_ONLY_FOR_MISSING_GATE', 'Whether it can be obtained is said of a missing pass/fail line only.', 422, [
      { field: 'obtainable', message: 'only for a missing pass/fail line' },
    ]);
  }

  const record = ctx.ledger.require({ refType: 'ITTAnalysis', refId: analysisId });
  const state = record.state as Record<string, unknown>;
  const review: RequirementReview = {
    reference: input.reference,
    status: input.status,
    basis,
    ...(input.action?.trim() ? { action: input.action.trim() } : {}),
    ...(input.status === 'DECISION_REQUIRED' ? { owner: input.owner!, decisionDue: input.decisionDue! } : {}),
    ...(input.obtainable !== undefined ? { obtainable: input.obtainable } : {}),
    reviewedBy: ctx.auth.actorId,
    reviewedAt: new Date().toISOString(),
  };
  // The analysis's own project, as the waivers are written.
  write(ctx, {
    eventType: 'REQUIREMENT_REVIEWED',
    entity: { refType: 'ITTAnalysis', refId: analysisId },
    projectId: record.projectId,
    nextState: { ...state, reviews: [...reviewsOf(state), review] },
    reason: `${input.reference}: ${input.status.toLowerCase().replace('_', ' ')} — ${basis}`,
  });
  return matrixPosition(ctx, analysisId).lines.find((entry) => entry.reference === input.reference)!;
}
