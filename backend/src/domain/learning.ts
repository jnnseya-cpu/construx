import { DomainError } from '../core/errors.ts';
import { formatRef, ulid } from '../core/ids.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';
import type { EntityRecord } from '../goldenthread/ledger.ts';
import {
  benchmarkEstimate,
  confidenceFor,
  costIntelligence,
  type BenchmarkedLine,
  type Confidence,
  type EstimateBenchmark,
} from './costintel.ts';
import { QUALIFICATION_CRITERIA, type OpportunityStage } from './business.ts';

/**
 * The loop closing on the bid — `L7.6`, §4.10.
 *
 * ---
 *
 * **What was already here, and what was missing.** Lessons learned are
 * corporate memory across projects. The cost intelligence database is built
 * from committed records. Forecast accuracy compares estimate-at-completion
 * snapshots against the final account. Every one of those looks *backwards* at
 * delivery. None of them reaches *forward* into the next bid.
 *
 * So the business loses the same money twice. The estimate that came in eleven
 * per cent under the market is a fact somebody found out during delivery, and
 * the next tender is priced by somebody who never saw it. The opportunity
 * scored four out of five for win probability that lost is a fact nobody
 * counted, so four out of five still means whatever the last person to use it
 * thought it meant.
 *
 * ## Three parts, and the third is the one that matters
 *
 * - **Outcome capture.** A loss was invisible: `LOST` was a declared
 *   opportunity stage that nothing ever set, so a bid that lost sat at `BID`
 *   for ever and the record could not tell a live tender from a dead one. That
 *   is the signal the whole loop learns from, and it was being thrown away.
 * - **Calibration signals.** A projection over the record, never stored, that
 *   asks four questions the platform can answer honestly: how far our price sat
 *   from the winning price, what a win-probability score has actually been
 *   worth, how far our package estimates sit from the market, and whether the
 *   red team's findable score tracks the mark the buyer gave.
 * - **Promotion.** A signal is not a lesson. Nothing a signal says reaches an
 *   estimator until a named person promotes it, and a promoted lesson carries
 *   its source bids and its approver. **An agent may propose and may not
 *   promote** — the same rule that keeps every mandate at propose, applied to
 *   the one place where an unverified output would become institutional truth.
 *
 * ## What a signal will not do
 *
 * **It will not speak from one observation.** `proposeLesson` refuses a signal
 * the record cannot support: one lost bid is a data point, and a correction
 * factor built on it is somebody's anecdote with a percentage sign on it.
 *
 * **It will not silently move a number.** A promoted lesson changes what the
 * benchmark *says*, and says that it is doing so and on what evidence. It does
 * not rewrite a rate, and it does not alter the bid/no-bid recommendation — the
 * observed win rate is published beside the scored one rather than folded into
 * it, because a score somebody can no longer reproduce is a score nobody can
 * argue with.
 */

export const SIGNAL_KIND = [
  /** How far our price sat from the winning price, where the buyer disclosed it. */
  'PRICE_POSITION',
  /** What a win-probability score has actually been worth, per score. */
  'WIN_RATE',
  /** How far our package estimates sit from what the market returned. */
  'ESTIMATING_BIAS',
  /** Whether the red team's findable score tracks the mark the buyer gave. */
  'EVALUATOR_ACCURACY',
  /**
   * What the priced risk allowance turned out to be worth, from contingency
   * drawn against contingency carried. §4.10.2's risk distribution, and the
   * last of its four deltas to have a record behind it.
   */
  'RISK_CONTINGENCY',
] as const;

export type SignalKind = (typeof SIGNAL_KIND)[number];

export type CalibrationSignal = {
  /** Stable and derived, so a lesson can name the signal it came from. */
  id: string;
  kind: SignalKind;
  /** What it is about: a score band, the estimate as a whole, the price. */
  subject: string;
  observations: number;
  confidence: Confidence;
  /**
   * The correction the record supports, as a percentage, or `null` where there
   * is nothing to say. Never a zero standing in for "we do not know".
   */
  deltaPercent: number | null;
  /** What it means, in the words somebody acting on it needs. */
  reading: string;
  /** The records behind it, so a promoted lesson carries its source bids. */
  sources: string[];
};

export type BidOutcome = 'WON' | 'LOST';

export type RecordedOutcome = {
  outcome: BidOutcome;
  decidedOn: string;
  /** What we tendered. Read from the opportunity where not stated. */
  ourPriceMinor?: number;
  /** What the winner tendered, where the buyer disclosed it. */
  winningPriceMinor?: number;
  winnerName?: string;
  /** The buyer's marks, where they were given. */
  qualityScorePercent?: number;
  commercialScorePercent?: number;
  rank?: number;
  tenderers?: number;
  /** The assurance review of the submission that went in, where one was run. */
  reviewId?: string;
  /** What the evaluator said. Kept verbatim; it is the most useful thing here. */
  feedback: string[];
  recordedAt: string;
  recordedBy: string;
};

export const LESSON_STATUS = ['PROPOSED', 'PROMOTED', 'REJECTED', 'RETIRED'] as const;
export type LessonStatus = (typeof LESSON_STATUS)[number];

export type CalibrationLesson = {
  id: string;
  reference: string;
  signalId: string;
  kind: SignalKind;
  subject: string;
  /**
   * The correction this lesson applies, as a percentage.
   *
   * Positive means our figure runs low against what actually happened.
   */
  adjustmentPercent: number;
  /** Why the record supports it. Not the signal's own sentence repeated. */
  rationale: string;
  /** The bids and packages behind it, carried onto the lesson itself. */
  sources: string[];
  observations: number;
  confidence: Confidence;
  status: LessonStatus;
  proposedAt: string;
  proposedBy: string;
  promotedAt?: string;
  promotedBy?: string;
  promotionNote?: string;
  rejectedAt?: string;
  rejectedBy?: string;
  rejectedReason?: string;
  retiredAt?: string;
  retiredBy?: string;
  retiredReason?: string;
};

const RATIONALE_MIN = 20;
const NOTE_MIN = 12;

/** A lesson cannot be built on fewer than this. One bid is an anecdote. */
const MIN_OBSERVATIONS = 3;

/** The largest correction a single lesson may carry, either way. */
const MAX_ADJUSTMENT_PERCENT = 40;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

/**
 * Every calibration in the tenancy.
 *
 * By tenant rather than by project, and that is the whole point of it. A
 * correction learned from three lost bids is a fact about how this business
 * prices, not about the project somebody happened to be looking at when they
 * proposed it — and an estimator benchmarking on a delivery project has to see
 * the same promoted lesson the bid team does, or the loop closes on nothing.
 */
function lessonsOf(ctx: EngineContext): CalibrationLesson[] {
  return ctx.ledger
    .listByTenant(ctx.tenantId, 'CalibrationLesson')
    .map((record) => record.state as unknown as CalibrationLesson);
}

function requireLesson(ctx: EngineContext, lessonId: string): EntityRecord {
  const record = ctx.ledger.get({ refType: 'CalibrationLesson', refId: lessonId });
  if (!record || record.tenantId !== ctx.tenantId) {
    throw new DomainError('CALIBRATION_LESSON_NOT_FOUND', `No calibration lesson ${lessonId}`, 404);
  }
  return record;
}

type OpportunityState = {
  id: string;
  title: string;
  clientName: string;
  estimatedValueMinor?: number;
  stage: OpportunityStage;
  qualification?: { scores?: Record<string, number> };
  outcome?: RecordedOutcome;
};

/**
 * Every opportunity in the tenancy's pipeline.
 *
 * Read straight from the ledger rather than through `business.ts`, so the
 * calibration is a projection over the record and cannot drift from it.
 */
function opportunitiesOf(ctx: EngineContext): OpportunityState[] {
  return ctx.ledger
    .listByTenant(ctx.tenantId, 'Opportunity')
    .map((record) => record.state as unknown as OpportunityState);
}

// --- Outcome capture — §4.10.1 ------------------------------------------------------

/**
 * Record how a bid ended, and what the buyer said about it.
 *
 * `BUSINESS_DEVELOPMENT` `U`, and `aiAllowed: false`. This carries a
 * competitor's price and moves an opportunity out of the live pipeline; it is a
 * transcription of the buyer's letter by somebody holding it, not a judgement
 * an agent may make.
 *
 * **A loss had nowhere to go.** `LOST` was a declared stage nothing ever set,
 * so a bid that lost stayed at `BID` and the pipeline could not tell a live
 * tender from a dead one — which loses exactly the signal the loop learns from.
 */
export function recordBidOutcome(
  ctx: EngineContext,
  opportunityId: string,
  input: {
    outcome: BidOutcome;
    decidedOn: string;
    ourPriceMinor?: number;
    winningPriceMinor?: number;
    winnerName?: string;
    qualityScorePercent?: number;
    commercialScorePercent?: number;
    rank?: number;
    tenderers?: number;
    reviewId?: string;
    feedback?: string[];
  },
): RecordedOutcome {
  authorise(ctx, 'BUSINESS_DEVELOPMENT', 'U');

  const record = ctx.ledger.get({ refType: 'Opportunity', refId: opportunityId });
  if (!record || record.tenantId !== ctx.tenantId) {
    throw new DomainError('OPPORTUNITY_NOT_FOUND', `No opportunity ${opportunityId}`, 404);
  }
  const state = record.state as unknown as OpportunityState;

  if (state.outcome) {
    throw new DomainError(
      'OUTCOME_ALREADY_RECORDED',
      `${state.title} was recorded as ${state.outcome.outcome.toLowerCase()} on ${state.outcome.decidedOn}. An outcome ` +
        'that can be rewritten is one the calibration cannot rely on.',
      409,
    );
  }
  if (state.stage === 'NO_BID') {
    throw new DomainError(
      'NOT_BID',
      `${state.title} was a no-bid. There is no outcome to record, because nothing was submitted — and counting it as a ` +
        'loss would make the win rate a measure of how often we decline.',
    );
  }
  if (state.stage === 'IDENTIFIED' || state.stage === 'QUALIFIED') {
    throw new DomainError(
      'NOT_SUBMITTED',
      `${state.title} has not reached a bid decision. Record the decision to bid before recording how it ended.`,
    );
  }

  for (const [field, value] of [
    ['qualityScorePercent', input.qualityScorePercent],
    ['commercialScorePercent', input.commercialScorePercent],
  ] as const) {
    if (value !== undefined && (value < 0 || value > 100)) {
      throw new DomainError('SCORE_OUT_OF_RANGE', `${field} is a percentage, between 0 and 100.`, 422, [
        { field, message: 'Between 0 and 100' },
      ]);
    }
  }
  if (input.rank !== undefined && input.tenderers !== undefined && input.rank > input.tenderers) {
    throw new DomainError(
      'RANK_IMPOSSIBLE',
      `Ranked ${input.rank} of ${input.tenderers}. One of the two figures is wrong, and which one changes what the ` +
        'result says about the market.',
    );
  }
  if (input.outcome === 'WON' && input.winningPriceMinor !== undefined) {
    throw new DomainError(
      'WINNING_PRICE_ON_A_WIN',
      'A win does not carry somebody else’s winning price. Record what we tendered.',
    );
  }

  const outcome: RecordedOutcome = {
    outcome: input.outcome,
    decidedOn: input.decidedOn.slice(0, 10),
    ...(input.ourPriceMinor === undefined
      ? state.estimatedValueMinor === undefined
        ? {}
        : { ourPriceMinor: state.estimatedValueMinor }
      : { ourPriceMinor: input.ourPriceMinor }),
    ...(input.winningPriceMinor === undefined ? {} : { winningPriceMinor: input.winningPriceMinor }),
    ...(input.winnerName === undefined ? {} : { winnerName: input.winnerName }),
    ...(input.qualityScorePercent === undefined ? {} : { qualityScorePercent: input.qualityScorePercent }),
    ...(input.commercialScorePercent === undefined ? {} : { commercialScorePercent: input.commercialScorePercent }),
    ...(input.rank === undefined ? {} : { rank: input.rank }),
    ...(input.tenderers === undefined ? {} : { tenderers: input.tenderers }),
    ...(input.reviewId === undefined ? {} : { reviewId: input.reviewId }),
    feedback: (input.feedback ?? []).map((line) => line.trim()).filter(Boolean),
    recordedAt: new Date().toISOString(),
    recordedBy: ctx.auth.actorId,
  };

  write(ctx, {
    projectId: record.projectId,
    eventType: 'BID_OUTCOME_RECORDED',
    entity: { refType: 'Opportunity', refId: opportunityId },
    nextState: {
      ...record.state,
      // A win leaves the stage alone: converting it to a project is a separate
      // act with its own record, and moving it here would claim a conversion
      // that has not happened. A loss has nowhere else to go.
      ...(input.outcome === 'LOST' ? { stage: 'LOST' satisfies OpportunityStage } : {}),
      outcome,
    },
  });

  return outcome;
}

// --- Calibration signals — §4.10.2 --------------------------------------------------

export type CalibrationReading = {
  signals: CalibrationSignal[];
  /** Settled bids the calibration had to work from. */
  settled: { won: number; lost: number };
  /** What the record cannot answer, said rather than left as a short list. */
  limits: string[];
  summary: string;
};

/**
 * What the record says about how the business bids.
 *
 * A projection, computed on every request and never stored. A stored
 * calibration would be a second copy of a conclusion that has to move every
 * time an outcome is recorded, and the one somebody trusts would be whichever
 * screen they opened.
 */
export function calibrationSignals(ctx: EngineContext, today?: string): CalibrationReading {
  authorise(ctx, 'ESTIMATE_TENDER', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const day = today ?? new Date().toISOString().slice(0, 10);
  const opportunities = opportunitiesOf(ctx);
  const settled = opportunities.filter((entry) => entry.outcome !== undefined);
  const won = settled.filter((entry) => entry.outcome!.outcome === 'WON');
  const lost = settled.filter((entry) => entry.outcome!.outcome === 'LOST');

  const signals: CalibrationSignal[] = [];
  const limits: string[] = [];

  // --- Where our price sits against the winner's ---------------------------
  const disclosed = lost.filter(
    (entry) =>
      entry.outcome!.winningPriceMinor !== undefined &&
      entry.outcome!.winningPriceMinor > 0 &&
      (entry.outcome!.ourPriceMinor ?? 0) > 0,
  );
  if (disclosed.length > 0) {
    const gaps = disclosed.map(
      (entry) =>
        ((entry.outcome!.ourPriceMinor! - entry.outcome!.winningPriceMinor!) / entry.outcome!.winningPriceMinor!) * 100,
    );
    const gap = Number(median(gaps).toFixed(1));
    signals.push({
      id: 'price:position',
      kind: 'PRICE_POSITION',
      subject: 'Our price against the winning price',
      observations: disclosed.length,
      confidence: confidenceFor(disclosed.length),
      deltaPercent: gap,
      reading:
        gap > 0
          ? `On ${disclosed.length} lost bid(s) where the buyer disclosed the winning price, ours sat a median ${gap}% ` +
            'above it. That is a gap in price, not necessarily a gap in cost.'
          : `On ${disclosed.length} lost bid(s) where the buyer disclosed the winning price, ours sat a median ` +
            `${Math.abs(gap)}% below it — so price is not why these were lost.`,
      sources: disclosed.map((entry) => entry.title),
    });
  } else {
    limits.push(
      'No lost bid has a disclosed winning price on the record, so nothing can be said about where our price sits ' +
        'against the market.',
    );
  }

  // --- What a win-probability score has actually been worth ----------------
  const scored = settled.filter((entry) => typeof entry.qualification?.scores?.winProbability === 'number');
  const byScore = new Map<number, OpportunityState[]>();
  for (const entry of scored) {
    const score = entry.qualification!.scores!.winProbability!;
    byScore.set(score, [...(byScore.get(score) ?? []), entry]);
  }
  for (const [score, entries] of [...byScore.entries()].sort((a, b) => a[0] - b[0])) {
    const wins = entries.filter((entry) => entry.outcome!.outcome === 'WON').length;
    const rate = Number(((wins / entries.length) * 100).toFixed(1));
    // The factor is scored 1 to 5 and five is always good for us, so a score
    // read as a probability is that score's share of five.
    const implied = (score / 5) * 100;
    signals.push({
      id: `win:${score}`,
      kind: 'WIN_RATE',
      subject: `Opportunities scored ${score} of 5 for win probability`,
      observations: entries.length,
      confidence: confidenceFor(entries.length),
      deltaPercent: Number((rate - implied).toFixed(1)),
      reading:
        `${wins} of ${entries.length} settled bid(s) scored ${score} were won — ${rate}% against the ${implied}% the ` +
        'score implies. The factor is a judgement about a particular tender, so this is what that judgement has been ' +
        'worth rather than a probability to substitute for it.',
      sources: entries.map((entry) => entry.title),
    });
  }
  if (scored.length === 0) {
    limits.push(
      'No settled bid carries a win-probability score, so what that score has been worth cannot be measured. It is ' +
        'set at qualification, before the bid decision.',
    );
  }

  // --- How far our package estimates sit from the market -------------------
  const intelligence = costIntelligence(ctx, { today: day });
  if (intelligence.estimatingAccuracy) {
    const accuracy = intelligence.estimatingAccuracy;
    signals.push({
      id: 'estimate:bias',
      kind: 'ESTIMATING_BIAS',
      subject: 'Package estimates against what the market returned',
      observations: accuracy.packages,
      confidence: accuracy.confidence,
      deltaPercent: accuracy.medianVariancePercent,
      reading: accuracy.reading,
      sources: intelligence.outturns
        .filter((outturn) => outturn.variancePercent !== undefined)
        .map((outturn) => `${outturn.projectName} · ${outturn.supplierName}`),
    });
  } else {
    limits.push(
      'No package has both an estimate and an executed subcontract against it, so estimating bias cannot be measured.',
    );
  }

  // --- Does the red team's score track the buyer's mark? -------------------
  const marked = settled.filter(
    (entry) => entry.outcome!.reviewId !== undefined && entry.outcome!.qualityScorePercent !== undefined,
  );
  const pairs: Array<{ title: string; predicted: number; actual: number }> = [];
  for (const entry of marked) {
    const review = ctx.ledger.get({ refType: 'AssuranceReview', refId: entry.outcome!.reviewId! });
    if (!review || review.tenantId !== ctx.tenantId) continue;
    const predicted = Number((review.state as { findableScorePercent?: number }).findableScorePercent ?? NaN);
    if (!Number.isFinite(predicted)) continue;
    pairs.push({ title: entry.title, predicted, actual: entry.outcome!.qualityScorePercent! });
  }
  if (pairs.length > 0) {
    const errors = pairs.map((pair) => pair.predicted - pair.actual);
    const bias = Number(median(errors).toFixed(1));
    signals.push({
      id: 'evaluator:accuracy',
      kind: 'EVALUATOR_ACCURACY',
      subject: 'The findable score against the mark the buyer gave',
      observations: pairs.length,
      confidence: confidenceFor(pairs.length),
      deltaPercent: bias,
      reading:
        bias > 0
          ? `Across ${pairs.length} marked submission(s) the findable score read a median ${bias} points above the ` +
            'buyer’s quality mark. The review is reading the submission more kindly than the evaluator did.'
          : `Across ${pairs.length} marked submission(s) the findable score read a median ${Math.abs(bias)} points ` +
            'below the buyer’s quality mark.',
      sources: pairs.map((pair) => pair.title),
    });
  } else {
    limits.push(
      'No settled bid names both an assurance review and the buyer’s quality mark, so the findable score is not ' +
        'calibrated against real feedback. It remains what it says it is: what a scorer can find, not what they gave.',
    );
  }

  // --- What the risk allowance was actually worth --------------------------
  //
  // §4.10.2 asks for a calibration delta against the risk distribution beside
  // the ones for rates, productivity and win probability. It could not be
  // derived while the baseline priced a contingency and nothing ever spent one:
  // a risk allowance nobody draws against is right by construction, because
  // nothing can contradict it. `BUDGET_CONTINGENCY_DRAWN` is the outturn, and
  // this is the comparison.
  //
  // Tenancy-wide, not per project. One job's contingency says what happened on
  // that job; the question here is whether this business prices risk well, and
  // that is only answerable across several.
  const budgets = ctx.ledger
    .listByTenant(ctx.tenantId, 'Budget')
    .filter((record) => record.state.status === 'APPROVED' && Number(record.state.contingencyMinor ?? 0) > 0);
  // Only a baseline something has been drawn against has an outturn to read. A
  // job with an untouched allowance may be well priced or may simply not have
  // finished, and counting it as nought per cent consumed would report the
  // second as the first.
  const consumed = budgets.filter((record) => Number(record.state.contingencyDrawnMinor ?? 0) > 0);
  if (consumed.length > 0) {
    const shares = consumed.map(
      (record) => (Number(record.state.contingencyDrawnMinor) / Number(record.state.contingencyMinor)) * 100,
    );
    const share = Number(median(shares).toFixed(1));
    // A hundred per cent consumed is the allowance exactly spent. The delta is
    // the distance from that, so a positive figure means risk was over-priced
    // and a negative one means it ran out.
    const delta = Number((100 - share).toFixed(1));
    signals.push({
      id: 'risk:contingency',
      kind: 'RISK_CONTINGENCY',
      subject: 'The risk allowance against what the risks actually cost',
      observations: consumed.length,
      confidence: confidenceFor(consumed.length),
      deltaPercent: delta,
      reading:
        delta > 0
          ? `Across ${consumed.length} baseline(s) with a contingency that has been drawn on, a median ${share}% of ` +
            `the allowance was spent. ${delta}% of the risk pot was carried and not needed, which is money that sat ` +
            'in the price and could have been competed with.'
          : `Across ${consumed.length} baseline(s) a median ${share}% of the risk allowance was spent. The pot is ` +
            'running to its limit, so the next job priced this way has no room for a risk that costs more than expected.',
      sources: consumed.map((record) => String(record.state.version ?? record.refId)),
    });
  } else if (budgets.length > 0) {
    limits.push(
      `${budgets.length} approved baseline(s) price a contingency and none has been drawn against, so what the risk ` +
        'allowance is worth cannot be measured yet. An untouched allowance is not evidence it was right.',
    );
  } else {
    limits.push(
      'No approved cost baseline prices a contingency, so there is no risk allowance to calibrate.',
    );
  }

  return {
    signals,
    settled: { won: won.length, lost: lost.length },
    limits,
    summary:
      settled.length === 0
        ? 'No bid has a recorded outcome yet, so there is nothing to calibrate against.'
        : `${settled.length} settled bid(s) — ${won.length} won, ${lost.length} lost — producing ${signals.length} ` +
          `signal(s)${limits.length > 0 ? ` and ${limits.length} question(s) the record cannot answer` : ''}.`,
  };
}

// --- Promotion — §4.10.3, gate G7 ---------------------------------------------------

/**
 * Propose that a signal become a lesson.
 *
 * `ESTIMATE_TENDER` `C`, and `aiAllowed: true` — an agent may propose. What it
 * may not do is promote, which is the whole of the guardrail: unverified agent
 * output never becomes institutional truth.
 *
 * Refused where the signal is too thin to support one. A correction factor
 * built on a single lost bid is an anecdote with a percentage sign on it, and
 * once it is in the rate library nobody remembers where it came from.
 */
export function proposeLesson(
  ctx: EngineContext,
  input: { signalId: string; adjustmentPercent: number; rationale: string },
): CalibrationLesson {
  authorise(ctx, 'ESTIMATE_TENDER', 'C', { dataSensitivity: 'COMMERCIAL_L3' });

  const reading = calibrationSignals(ctx);
  const signal = reading.signals.find((candidate) => candidate.id === input.signalId);
  if (!signal) {
    throw new DomainError(
      'SIGNAL_NOT_FOUND',
      `The record produces no signal ${input.signalId}. A lesson with no signal behind it is an opinion with a ` +
        'reference number.',
      404,
    );
  }

  if (signal.observations < MIN_OBSERVATIONS) {
    throw new DomainError(
      'SIGNAL_TOO_THIN',
      `${signal.subject} rests on ${signal.observations} observation(s) and a lesson needs at least ` +
        `${MIN_OBSERVATIONS}. Below that it is a data point, not a correction — and once it is in the library nobody ` +
        'remembers it was one bid.',
    );
  }

  const rationale = input.rationale.trim();
  if (rationale.length < RATIONALE_MIN) {
    throw new DomainError(
      'RATIONALE_REQUIRED',
      `Say why the record supports this, in at least ${RATIONALE_MIN} characters. Repeating the signal’s own ` +
        'sentence is not a reason to act on it.',
      422,
      [{ field: 'rationale', message: `At least ${RATIONALE_MIN} characters` }],
    );
  }

  if (Math.abs(input.adjustmentPercent) > MAX_ADJUSTMENT_PERCENT) {
    throw new DomainError(
      'ADJUSTMENT_TOO_LARGE',
      `A ${input.adjustmentPercent}% correction is larger than any calibration should carry. A gap that size is a ` +
        'scope difference or a mistake, and applying it as a factor hides whichever it is.',
    );
  }

  const live = lessonsOf(ctx).find(
    (lesson) => lesson.signalId === signal.id && (lesson.status === 'PROPOSED' || lesson.status === 'PROMOTED'),
  );
  if (live) {
    throw new DomainError(
      'LESSON_ALREADY_OPEN',
      `${live.reference} is already ${live.status.toLowerCase()} against this signal. Two corrections for one fact is ` +
        'two factors to keep in step, and the stale one is whichever nobody remembers.',
      409,
    );
  }

  const id = ulid();
  const lesson: CalibrationLesson = {
    id,
    reference: formatRef('CAL', lessonsOf(ctx).length + 1),
    signalId: signal.id,
    kind: signal.kind,
    subject: signal.subject,
    adjustmentPercent: Number(input.adjustmentPercent.toFixed(1)),
    rationale,
    // Carried onto the lesson rather than re-derived, because the signal moves
    // as outcomes are recorded and the lesson must say what it was built on.
    sources: signal.sources,
    observations: signal.observations,
    confidence: signal.confidence,
    status: 'PROPOSED',
    proposedAt: new Date().toISOString(),
    proposedBy: ctx.auth.actorId,
  };

  write(ctx, {
    eventType: 'CALIBRATION_LESSON_PROPOSED',
    entity: { refType: 'CalibrationLesson', refId: id },
    nextState: lesson as unknown as Record<string, unknown>,
  });

  return lesson;
}

/**
 * Gate `G7_LESSON_PROMOTE`.
 *
 * `ESTIMATE_TENDER` `A`, `aiAllowed: false`. Until this runs, the lesson
 * changes nothing anybody sees.
 */
export function promoteLesson(
  ctx: EngineContext,
  lessonId: string,
  input: { note: string },
): CalibrationLesson {
  authorise(ctx, 'ESTIMATE_TENDER', 'A', { dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireLesson(ctx, lessonId);
  const lesson = record.state as unknown as CalibrationLesson;

  if (lesson.status !== 'PROPOSED') {
    throw new DomainError(
      'LESSON_NOT_PROPOSED',
      `${lesson.reference} is ${lesson.status.toLowerCase()} and only a proposed lesson can be promoted.`,
      409,
    );
  }
  if (lesson.proposedBy === ctx.auth.actorId) {
    // The same segregation the payment cycle and the signature ceremony carry.
    // One person proposing a correction and then approving it is the same
    // opinion written twice, and this one goes into every future estimate.
    throw new DomainError(
      'PROMOTER_IS_PROPOSER',
      `${lesson.reference} was proposed by you. Somebody else has to promote it — a correction that goes into every ` +
        'future estimate is not a thing one person decides on their own.',
      409,
    );
  }

  const note = input.note.trim();
  if (note.length < NOTE_MIN) {
    throw new DomainError(
      'PROMOTION_NOTE_REQUIRED',
      `Write what you checked, in at least ${NOTE_MIN} characters. A promoted lesson carries its approver, and an ` +
        'approver with nothing recorded is a name on a decision nobody can reconstruct.',
      422,
      [{ field: 'note', message: `At least ${NOTE_MIN} characters` }],
    );
  }

  const promoted: CalibrationLesson = {
    ...lesson,
    status: 'PROMOTED',
    promotedAt: new Date().toISOString(),
    promotedBy: ctx.auth.actorId,
    promotionNote: note,
  };

  write(ctx, {
    eventType: 'CALIBRATION_LESSON_PROMOTED',
    entity: { refType: 'CalibrationLesson', refId: lesson.id },
    nextState: promoted as unknown as Record<string, unknown>,
    reason: note,
  });

  return promoted;
}

/** Refuse a proposal. Kept, because a correction somebody looked at and refused is part of the record. */
export function rejectLesson(ctx: EngineContext, lessonId: string, input: { reason: string }): CalibrationLesson {
  authorise(ctx, 'ESTIMATE_TENDER', 'A', { dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireLesson(ctx, lessonId);
  const lesson = record.state as unknown as CalibrationLesson;
  if (lesson.status !== 'PROPOSED') {
    throw new DomainError(
      'LESSON_NOT_PROPOSED',
      `${lesson.reference} is ${lesson.status.toLowerCase()} and only a proposed lesson can be rejected.`,
      409,
    );
  }

  const reason = input.reason.trim();
  if (reason.length < NOTE_MIN) {
    throw new DomainError('REJECTION_REASON_REQUIRED', `Say why, in at least ${NOTE_MIN} characters.`, 422, [
      { field: 'reason', message: `At least ${NOTE_MIN} characters` },
    ]);
  }

  const rejected: CalibrationLesson = {
    ...lesson,
    status: 'REJECTED',
    rejectedAt: new Date().toISOString(),
    rejectedBy: ctx.auth.actorId,
    rejectedReason: reason,
  };

  write(ctx, {
    eventType: 'CALIBRATION_LESSON_REJECTED',
    entity: { refType: 'CalibrationLesson', refId: lesson.id },
    nextState: rejected as unknown as Record<string, unknown>,
    reason,
  });

  return rejected;
}

/**
 * Stop applying a promoted lesson.
 *
 * A correction that was true about last year's market is not true for ever, and
 * a library nobody can retire from is one that accumulates.
 */
export function retireLesson(ctx: EngineContext, lessonId: string, input: { reason: string }): CalibrationLesson {
  authorise(ctx, 'ESTIMATE_TENDER', 'A', { dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireLesson(ctx, lessonId);
  const lesson = record.state as unknown as CalibrationLesson;
  if (lesson.status !== 'PROMOTED') {
    throw new DomainError(
      'LESSON_NOT_PROMOTED',
      `${lesson.reference} is ${lesson.status.toLowerCase()} and is not being applied to anything.`,
      409,
    );
  }

  const reason = input.reason.trim();
  if (reason.length < NOTE_MIN) {
    throw new DomainError('RETIREMENT_REASON_REQUIRED', `Say why, in at least ${NOTE_MIN} characters.`, 422, [
      { field: 'reason', message: `At least ${NOTE_MIN} characters` },
    ]);
  }

  const retired: CalibrationLesson = {
    ...lesson,
    status: 'RETIRED',
    retiredAt: new Date().toISOString(),
    retiredBy: ctx.auth.actorId,
    retiredReason: reason,
  };

  write(ctx, {
    eventType: 'CALIBRATION_LESSON_RETIRED',
    entity: { refType: 'CalibrationLesson', refId: lesson.id },
    nextState: retired as unknown as Record<string, unknown>,
    reason,
  });

  return retired;
}

/**
 * The lessons that are actually being applied.
 *
 * The single reader every consumer of a calibration goes through, so "promoted
 * only" is one rule in one place rather than a filter each caller remembers.
 */
export function promotedLessons(ctx: EngineContext, kind?: SignalKind): CalibrationLesson[] {
  return lessonsOf(ctx).filter((lesson) => lesson.status === 'PROMOTED' && (kind === undefined || lesson.kind === kind));
}

export type LessonRegister = {
  lessons: CalibrationLesson[];
  counts: Record<LessonStatus, number>;
  /** What a promoted lesson of each kind changes. Published so the console says the same thing. */
  effects: Array<{ kind: SignalKind; effect: string }>;
  summary: string;
};

const KIND_EFFECT: Record<SignalKind, string> = {
  PRICE_POSITION:
    'Reported beside the estimate benchmark as where this business’s prices have sat against winning prices. It ' +
    'moves no rate.',
  WIN_RATE:
    'Published beside the bid/no-bid score as what that judgement has been worth. It does not change the score or the ' +
    'recommendation.',
  ESTIMATING_BIAS:
    'Applied to the estimate benchmark: the median a line is compared against is corrected by it, and every line says ' +
    'so and names the lesson.',
  EVALUATOR_ACCURACY:
    'Reported on an assurance review as how far the findable score has read from the buyer’s mark. It does not ' +
    'move the score.',
  RISK_CONTINGENCY:
    'Reported beside the cost baseline as what this business’s risk allowances have actually been worth. It moves ' +
    'no contingency: how much risk to carry on a particular job is a judgement about that job, and a median across ' +
    'others is evidence for it rather than a substitute for it.',
};

export function lessonRegister(ctx: EngineContext): LessonRegister {
  authorise(ctx, 'ESTIMATE_TENDER', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const lessons = lessonsOf(ctx).sort((a, b) => b.proposedAt.localeCompare(a.proposedAt));
  const counts = Object.fromEntries(
    LESSON_STATUS.map((status) => [status, lessons.filter((lesson) => lesson.status === status).length]),
  ) as Record<LessonStatus, number>;

  return {
    lessons,
    counts,
    effects: SIGNAL_KIND.map((kind) => ({ kind, effect: KIND_EFFECT[kind] })),
    summary:
      lessons.length === 0
        ? 'Nothing has been proposed. Until a lesson is promoted, nothing the record has learned reaches an estimate.'
        : `${lessons.length} lesson(s) — ${counts.PROMOTED} being applied, ${counts.PROPOSED} awaiting a decision, ` +
          `${counts.REJECTED} refused, ${counts.RETIRED} retired.`,
  };
}

export type CalibratedBenchmark = EstimateBenchmark & {
  /** The lesson applied, or nothing where none is promoted. */
  applied: CalibrationLesson | null;
  /**
   * Every line, with the median corrected by the promoted lesson.
   *
   * The uncorrected line is kept beside it rather than replaced. An estimator
   * asked to explain a variance has to be able to see both the history and the
   * correction, or the correction is a number the screen produced.
   */
  calibrated: Array<
    BenchmarkedLine & {
      calibratedMedianMinor: number | null;
      calibratedVariancePercent: number | null;
      calibratedVerdict: BenchmarkedLine['verdict'];
    }
  >;
  note: string;
};

/**
 * The loop, closed.
 *
 * `benchmarkEstimate` compares a rate against the median of what this business
 * has estimated before. That median inherits every bias the business has: if
 * its estimates ran eight per cent under the market, a line in line with the
 * median is eight per cent under the market too, and the benchmark agrees with
 * it.
 *
 * A **promoted** estimating-bias lesson corrects for that, and says on every
 * line that it has. Nothing happens until one is promoted: a proposed lesson
 * reaches no estimate, which is the whole of the promotion gate.
 *
 * The underlying benchmark is untouched. This reads it and adds; it does not
 * replace the comparison somebody may already be defending a price with.
 */
export function calibratedBenchmark(
  ctx: EngineContext,
  estimateId: string,
  today?: string,
): CalibratedBenchmark {
  const benchmark = benchmarkEstimate(ctx, estimateId, today);
  const lesson = promotedLessons(ctx, 'ESTIMATING_BIAS')[0] ?? null;
  const factor = lesson === null ? 1 : 1 + lesson.adjustmentPercent / 100;

  const calibrated = benchmark.lines.map((line) => {
    if (line.medianMinor === null || lesson === null) {
      return {
        ...line,
        calibratedMedianMinor: line.medianMinor,
        calibratedVariancePercent: line.variancePercent,
        calibratedVerdict: line.verdict,
      };
    }
    const median_ = Math.round(line.medianMinor * factor);
    const variance = median_ > 0 ? Number((((line.rateMinor - median_) / median_) * 100).toFixed(1)) : null;
    return {
      ...line,
      calibratedMedianMinor: median_,
      calibratedVariancePercent: variance,
      calibratedVerdict:
        variance === null ? line.verdict : Math.abs(variance) <= 10 ? 'IN_LINE' : variance > 0 ? 'ABOVE' : 'BELOW',
    };
  });

  return {
    ...benchmark,
    applied: lesson,
    calibrated,
    note:
      lesson === null
        ? 'No estimating-bias lesson has been promoted, so the medians are this business’s own estimates ' +
          'uncorrected — including whatever bias they carry.'
        : `${lesson.reference} corrects every median by ${lesson.adjustmentPercent}%, promoted by ${lesson.promotedBy} ` +
          `on ${(lesson.promotedAt ?? '').slice(0, 10)} from ${lesson.observations} observation(s): ${lesson.rationale}`,
  };
}

/**
 * What the record says about opportunities scored the way this one is.
 *
 * Published **beside** the bid/no-bid score rather than folded into it. A score
 * somebody can no longer reproduce from the ten factors is a score nobody can
 * argue with, and the algorithm is the thing a decision is defended by.
 */
export function calibratedOutlook(
  ctx: EngineContext,
  scores: Record<string, number>,
): { score: number | null; observed: CalibrationSignal | null; lesson: CalibrationLesson | null; reading: string } {
  const factor = QUALIFICATION_CRITERIA.find((criterion) => criterion.key === 'winProbability')!;
  const score = typeof scores[factor.key] === 'number' ? scores[factor.key]! : null;
  if (score === null) {
    return { score: null, observed: null, lesson: null, reading: 'No win-probability score was given.' };
  }

  const observed = calibrationSignals(ctx).signals.find((signal) => signal.id === `win:${score}`) ?? null;
  const lesson = promotedLessons(ctx, 'WIN_RATE').find((entry) => entry.signalId === `win:${score}`) ?? null;

  return {
    score,
    observed,
    lesson,
    reading:
      observed === null
        ? `Nothing settled has been scored ${score} of 5 for win probability, so the record has nothing to say about it yet.`
        : lesson === null
          ? `${observed.reading} Not promoted, so it is reported and applied to nothing.`
          : `${observed.reading} ${lesson.reference} was promoted by ${lesson.promotedBy}: ${lesson.rationale}`,
  };
}
