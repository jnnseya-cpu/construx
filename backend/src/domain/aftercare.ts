import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, registerEvidence, write, type EngineContext } from '../engines/context.ts';
import * as handoveracceptance from './handoveracceptance.ts';
import * as reliability from './reliability.ts';

/**
 * H-WF-10 — Soft Landings, aftercare, seasonal testing and feedback.
 *
 * **What already exists and is reused.** CM-WF-06's `SeasonalTest` records are
 * the seasonal tests: `outstandingSeasonalTests` already lists what is owed,
 * with its window and the person who accepted responsibility, and this closes
 * those records rather than opening a second set. `domain/control.captureLesson`
 * already writes a lesson with a recommendation somebody could act on and an
 * impact in money or days; what it never had is an approval, which is what the
 * exception control here actually asks for. H-WF-09's `residualObligations`
 * already derives what is still owed after acceptance, so the aftercare
 * position reads it rather than keeping a list.
 *
 * **AC-H-WF-10-01: traceable to the original requirement.** Free, because
 * nothing is copied. Every residual obligation is derived from the record that
 * created it and carries that record's own reference; a seasonal test closed
 * here closes the CM-WF-06 record by its own identifier. There is no second
 * numbering anywhere in this workflow.
 *
 * **AC-H-WF-10-02: a comparison states its period, baseline and context.** A
 * performance figure without those three is not a comparison, it is a number
 * next to another number. A building running at 140% of its design energy
 * target is unremarkable if it was commissioned in July and measured through
 * February, or if half of it is not yet occupied — so the period, the baseline
 * it is measured against and the operating context are all required, and a
 * gap cannot be recorded without them.
 *
 * **AC-H-WF-10-03 and the reuse control.** "Lesson is not reused automatically
 * until approved and context-tagged." Approval names the sectors and stages
 * where reuse is valid. A lesson from a hospital's medical-gas commissioning is
 * not a lesson about a warehouse, and a register that lets it be read as one is
 * worse than no register.
 *
 * **The privacy control is real and it is narrow.** Occupant feedback is
 * recorded against a role and a location, never a person: there is no field on
 * the feedback type that a name could occupy. That is the same structural
 * approach H-WF-07 took to secrets, and for the same reason — a rule that
 * inspects a name has already handled one.
 */

// --- The aftercare plan -----------------------------------------------------

type AftercarePlanState = {
  planId: string;
  reference: string;
  durationMonths: number;
  startsOn: string;
  endsOn: string;
  helpdesk: string;
  escalation: string;
  responseTargets: string;
  reviewDates: string[];
  aftercareOwner: string;
  status: 'ACTIVE' | 'CLOSED';
};

function plans(ctx: EngineContext): AftercarePlanState[] {
  return ctx.ledger.list(ctx.projectId, 'AftercarePlan').map((record) => record.state as unknown as AftercarePlanState);
}

function addMonths(from: string, months: number): string {
  const date = new Date(Date.parse(from));
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
}

/**
 * Open the aftercare period.
 *
 * The review dates are the part that decides whether Soft Landings happens or
 * is merely intended. A plan with a helpdesk number and no scheduled reviews is
 * a reactive service: somebody rings when something breaks, nobody ever asks
 * whether the building is doing what it was designed to do, and the period ends
 * without a single comparison being made.
 */
export function startAftercare(
  ctx: EngineContext,
  input: {
    reference: string;
    durationMonths: number;
    startsOn: string;
    helpdesk: string;
    escalation: string;
    responseTargets: string;
    reviewDates: string[];
    aftercareOwner: string;
  },
): { planId: string; endsOn: string; reviews: number } {
  authorise(ctx, 'HANDOVER_OM', 'C', { lifecyclePhase: currentPhase(ctx) });

  if (!input.reference.trim() || !input.aftercareOwner.trim()) {
    throw new DomainError('PLAN_UNIDENTIFIED', 'An aftercare plan carries a reference and names who owns it.');
  }
  if (!(input.durationMonths > 0)) {
    throw new DomainError('DURATION_REQUIRED', 'Say how long the aftercare period runs for.');
  }
  if (Number.isNaN(Date.parse(input.startsOn))) {
    throw new DomainError('START_REQUIRED', 'Say when it starts.');
  }
  if (!input.helpdesk.trim() || input.escalation.trim().length < 20) {
    throw new DomainError(
      'ESCALATION_REQUIRED',
      'Record the helpdesk route and what happens when nobody answers it. The escalation is the half that matters, and it ' +
        'is the half that gets left out.',
    );
  }
  if (!input.responseTargets.trim()) {
    throw new DomainError('RESPONSE_TARGETS_REQUIRED', 'State the response targets, or there is nothing to hold anybody to.');
  }
  if (input.reviewDates.length === 0) {
    throw new DomainError(
      'REVIEWS_REQUIRED',
      'Schedule the reviews. A plan with a number to ring and no dates in it is a reactive service — nobody ever asks ' +
        'whether the building is doing what it was designed to do, and the period ends with no comparison made.',
    );
  }
  for (const date of input.reviewDates) {
    if (Number.isNaN(Date.parse(date))) throw new DomainError('REVIEWS_REQUIRED', `"${date}" is not a date.`);
  }

  if (plans(ctx).some((plan) => plan.status === 'ACTIVE')) {
    throw new DomainError('ALREADY_ACTIVE', 'An aftercare plan is already running for this project.');
  }

  const planId = ulid();
  const endsOn = addMonths(input.startsOn.slice(0, 10), input.durationMonths);
  const reviewDates = [...input.reviewDates].map((date) => date.slice(0, 10)).sort();

  write(ctx, {
    eventType: 'AFTERCARE_STARTED',
    entity: { refType: 'AftercarePlan', refId: planId },
    nextState: {
      planId,
      projectId: ctx.projectId,
      reference: input.reference,
      durationMonths: input.durationMonths,
      startsOn: input.startsOn.slice(0, 10),
      endsOn,
      helpdesk: input.helpdesk,
      escalation: input.escalation,
      responseTargets: input.responseTargets,
      reviewDates,
      aftercareOwner: input.aftercareOwner,
      status: 'ACTIVE',
      startedBy: ctx.auth.actorId,
      startedAt: new Date().toISOString(),
    },
  });

  return { planId, endsOn, reviews: reviewDates.length };
}

// --- Seasonal testing -------------------------------------------------------

/**
 * Close a seasonal test that CM-WF-06 raised.
 *
 * The record being closed is the one CM-WF-06 created, by its own reference.
 * Nothing is renumbered and no second register exists, which is the whole of
 * AC-H-WF-10-01 for this class of obligation.
 */
export function completeSeasonalTest(
  ctx: EngineContext,
  reference: string,
  input: { testedOn: string; conditionsObserved: string; result: 'PASS' | 'FAIL'; findings: string; testedBy: string; evidenceHash: string },
): { reference: string; systemTag: string; result: string; stillOutstanding: number } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'X', { lifecyclePhase: currentPhase(ctx) });

  const record = ctx.ledger
    .list(ctx.projectId, 'SeasonalTest')
    .find((entry) => entry.state.reference === reference);
  if (!record) throw new DomainError('SEASONAL_TEST_NOT_FOUND', `No seasonal test ${reference}`, 404);
  if (record.state.status !== 'OUTSTANDING') {
    throw new DomainError('NOT_OUTSTANDING', `${reference} is not outstanding.`);
  }

  if (Number.isNaN(Date.parse(input.testedOn))) {
    throw new DomainError('TEST_DATE_REQUIRED', 'Record the date it was actually tested on.');
  }
  if (input.conditionsObserved.trim().length < 20) {
    throw new DomainError(
      'CONDITIONS_REQUIRED',
      'Record the conditions on the day. A seasonal test is a test *of the season* — one run in a mild February proves ' +
        'nothing about the design condition it was deferred for, and without the observed conditions nobody can tell ' +
        'which it was.',
    );
  }
  if (input.findings.trim().length < 20) {
    throw new DomainError('FINDINGS_REQUIRED', 'Record what was found, including a clean pass.');
  }
  if (!input.testedBy.trim() || !input.evidenceHash.trim()) {
    throw new DomainError('TEST_UNSIGNED', 'Name who tested it and attach the record.');
  }

  const windowFrom = String(record.state.windowFrom);
  const windowTo = String(record.state.windowTo);
  const testedOn = input.testedOn.slice(0, 10);
  const outsideWindow = testedOn < windowFrom || testedOn > windowTo;

  const evidence = registerEvidence(ctx, {
    type: 'SEASONAL_TEST_RESULT',
    hash: input.evidenceHash,
    description: `${reference} — ${String(record.state.systemTag)} seasonal test, ${input.result.toLowerCase()}`,
    linkedEntities: [{ refType: 'SeasonalTest', refId: record.refId }],
  });

  write(ctx, {
    eventType: 'SEASONAL_TEST_COMPLETED',
    entity: { refType: 'SeasonalTest', refId: record.refId },
    nextState: {
      ...record.state,
      // A failed seasonal test does not close the obligation. The building
      // still has not been shown to work in the condition it was deferred for.
      status: input.result === 'PASS' ? 'CLOSED' : 'OUTSTANDING',
      result: {
        testedOn,
        conditionsObserved: input.conditionsObserved,
        result: input.result,
        findings: input.findings,
        testedBy: input.testedBy,
        // Recorded rather than refused: a test run outside its window is still
        // evidence, and whether it is enough is the operator's judgement. Not
        // saying so would let it pass as though it were in season.
        outsideWindow,
        recordedAt: new Date().toISOString(),
      },
    },
    evidenceRefs: [evidence],
  });

  return {
    reference,
    systemTag: String(record.state.systemTag),
    result: input.result,
    stillOutstanding: reliability.outstandingSeasonalTests(ctx).length,
  };
}

// --- Performance in use -----------------------------------------------------

/**
 * Compare measured performance against the design or commissioning target.
 *
 * AC-H-WF-10-02, enforced rather than described. The period, the baseline and
 * the operating context are all required, because a percentage against a target
 * means nothing without them: a building at 140% of its design energy figure is
 * unremarkable if it was measured through a winter it was commissioned before,
 * or if a third of it is unoccupied, and a register full of gaps recorded
 * without their context produces a year of arguments and no fixes.
 */
export function recordPerformanceComparison(
  ctx: EngineContext,
  input: {
    reference: string;
    metric: string;
    unit: string;
    /** Where the target came from: the design intent, or the commissioning result. */
    baselineSource: 'DESIGN_INTENT' | 'COMMISSIONING_RESULT';
    baselineValue: number;
    measuredValue: number;
    periodFrom: string;
    periodTo: string;
    /** Occupancy, weather, operating hours — what was true while it was measured. */
    operatingContext: string;
    dataSource: string;
    assessedBy: string;
  },
): { comparisonId: string; variancePercent: number; gap: boolean } {
  authorise(ctx, 'HANDOVER_OM', 'C', { lifecyclePhase: currentPhase(ctx) });

  if (!input.reference.trim() || !input.metric.trim() || !input.unit.trim()) {
    throw new DomainError('METRIC_UNIDENTIFIED', 'Name the metric and its unit.');
  }
  if (Number.isNaN(Date.parse(input.periodFrom)) || Number.isNaN(Date.parse(input.periodTo))) {
    throw new DomainError(
      'PERIOD_REQUIRED',
      'State the period the data covers. A figure with no period behind it cannot be compared with the next one.',
    );
  }
  if (input.periodTo.slice(0, 10) < input.periodFrom.slice(0, 10)) {
    throw new DomainError('PERIOD_REQUIRED', 'The period ends before it starts.');
  }
  if (!(input.baselineValue !== 0)) {
    throw new DomainError(
      'BASELINE_REQUIRED',
      'A baseline of zero gives no comparison — the variance against it is undefined, and reporting one would be inventing ' +
        'a number.',
    );
  }
  if (input.operatingContext.trim().length < 20) {
    throw new DomainError(
      'CONTEXT_REQUIRED',
      'Record the operating context — occupancy, weather, hours. A building at 140% of its design figure is unremarkable ' +
        'if half of it is not yet occupied, and a gap recorded without that is a year of arguments and no fix.',
    );
  }
  if (!input.dataSource.trim() || !input.assessedBy.trim()) {
    throw new DomainError('SOURCE_REQUIRED', 'Name where the measurement came from and who assessed it.');
  }

  const variancePercent = Math.round(((input.measuredValue - input.baselineValue) / Math.abs(input.baselineValue)) * 1000) / 10;
  // Ten per cent either way. Recorded on the event rather than left implicit,
  // so a later change of threshold does not silently reclassify history.
  const THRESHOLD_PERCENT = 10;
  const gap = Math.abs(variancePercent) > THRESHOLD_PERCENT;

  const comparisonId = ulid();

  write(ctx, {
    eventType: gap ? 'PERFORMANCE_GAP_IDENTIFIED' : 'PERFORMANCE_COMPARED',
    entity: { refType: 'PerformanceComparison', refId: comparisonId },
    nextState: {
      comparisonId,
      projectId: ctx.projectId,
      reference: input.reference,
      metric: input.metric,
      unit: input.unit,
      baselineSource: input.baselineSource,
      baselineValue: input.baselineValue,
      measuredValue: input.measuredValue,
      variancePercent,
      thresholdPercent: THRESHOLD_PERCENT,
      gap,
      periodFrom: input.periodFrom.slice(0, 10),
      periodTo: input.periodTo.slice(0, 10),
      operatingContext: input.operatingContext,
      dataSource: input.dataSource,
      assessedBy: input.assessedBy,
      recordedAt: new Date().toISOString(),
    },
  });

  return { comparisonId, variancePercent, gap };
}

// --- Occupant feedback ------------------------------------------------------

export const FEEDBACK_THEME = [
  'THERMAL_COMFORT',
  'AIR_QUALITY',
  'LIGHTING',
  'ACOUSTICS',
  'CONTROLS_USABILITY',
  'CLEANLINESS',
  'ACCESSIBILITY',
  'OTHER',
] as const;
export type FeedbackTheme = (typeof FEEDBACK_THEME)[number];

/**
 * Record occupant or operator feedback.
 *
 * **The privacy control is structural.** The specification says personal and
 * user feedback is privacy-controlled; the way that is met here is that there
 * is **no field a name could go in**. Feedback is recorded against a role and a
 * location, which is what makes it actionable — "the second-floor east
 * occupants are cold" is a heating problem, and which of them said so is not
 * information the building needs. A validator that inspected a name would have
 * already handled one.
 */
export function recordFeedback(
  ctx: EngineContext,
  input: {
    theme: FeedbackTheme;
    /** The role reporting it, never the person. */
    reportedByRole: string;
    location: string;
    description: string;
    severity: 'LOW' | 'MEDIUM' | 'HIGH';
    occurrences: number;
  },
): { feedbackId: string; theme: FeedbackTheme } {
  authorise(ctx, 'HANDOVER_OM', 'C', { lifecyclePhase: currentPhase(ctx) });

  if (!input.reportedByRole.trim() || !input.location.trim()) {
    throw new DomainError(
      'FEEDBACK_UNPLACED',
      'Record the role and the location. Feedback with neither cannot be acted on, and it is the location that turns a ' +
        'complaint into a heating problem.',
    );
  }
  if (input.description.trim().length < 20) {
    throw new DomainError('FEEDBACK_UNDESCRIBED', 'Record what was actually reported.');
  }
  if (!(input.occurrences > 0)) {
    throw new DomainError('OCCURRENCES_REQUIRED', 'Say how many times it has been reported — one report and forty differ.');
  }

  const feedbackId = ulid();

  write(ctx, {
    eventType: 'OCCUPANT_FEEDBACK_RECORDED',
    entity: { refType: 'OccupantFeedback', refId: feedbackId },
    nextState: {
      feedbackId,
      projectId: ctx.projectId,
      theme: input.theme,
      reportedByRole: input.reportedByRole,
      location: input.location,
      description: input.description,
      severity: input.severity,
      occurrences: input.occurrences,
      status: 'OPEN',
      recordedAt: new Date().toISOString(),
    },
  });

  return { feedbackId, theme: input.theme };
}

/** Feedback grouped by theme and location — the clustering the specification asks an agent to draft. */
export function feedbackClusters(
  ctx: EngineContext,
): Array<{ theme: FeedbackTheme; location: string; reports: number; occurrences: number; highest: string }> {
  const grouped = new Map<string, { theme: FeedbackTheme; location: string; reports: number; occurrences: number; highest: string }>();
  const rank = { LOW: 0, MEDIUM: 1, HIGH: 2 } as const;

  for (const record of ctx.ledger.list(ctx.projectId, 'OccupantFeedback')) {
    if (record.state.status !== 'OPEN') continue;
    const theme = record.state.theme as FeedbackTheme;
    const location = String(record.state.location);
    const key = `${theme}:${location}`;
    const severity = String(record.state.severity) as keyof typeof rank;
    const existing = grouped.get(key);
    if (existing) {
      existing.reports += 1;
      existing.occurrences += Number(record.state.occurrences);
      if (rank[severity] > rank[existing.highest as keyof typeof rank]) existing.highest = severity;
    } else {
      grouped.set(key, { theme, location, reports: 1, occurrences: Number(record.state.occurrences), highest: severity });
    }
  }

  return [...grouped.values()].sort((a, b) => b.occurrences - a.occurrences);
}

// --- Post-occupancy evaluation ----------------------------------------------

/**
 * Complete the post-occupancy review.
 *
 * Refuses to run before there is anything to review. A post-occupancy
 * evaluation written without a performance comparison or a single piece of
 * feedback is a document produced to close an action, and it is the reason the
 * exercise has the reputation it has.
 */
export function completePostOccupancyReview(
  ctx: EngineContext,
  input: {
    reference: string;
    reviewedBy: string;
    period: string;
    findings: string;
    correctiveActions: Array<{ description: string; owner: string; by: string; priority: 'LOW' | 'MEDIUM' | 'HIGH' }>;
    evidenceHash: string;
  },
): { reviewId: string; actions: number; gapsConsidered: number; feedbackConsidered: number } {
  authorise(ctx, 'HANDOVER_OM', 'A', { lifecyclePhase: currentPhase(ctx) });

  const comparisons = ctx.ledger.list(ctx.projectId, 'PerformanceComparison');
  const feedback = ctx.ledger.list(ctx.projectId, 'OccupantFeedback');

  if (comparisons.length === 0 && feedback.length === 0) {
    throw new DomainError(
      'NOTHING_TO_REVIEW',
      'No performance comparison and no feedback has been recorded. A post-occupancy evaluation written with neither is a ' +
        'document produced to close an action, which is why the exercise has the reputation it has.',
    );
  }
  if (!input.reference.trim() || !input.reviewedBy.trim() || !input.period.trim()) {
    throw new DomainError('REVIEW_UNIDENTIFIED', 'A review carries a reference, a reviewer and the period it covers.');
  }
  if (input.findings.trim().length < 20) {
    throw new DomainError('FINDINGS_REQUIRED', 'Record what the review found.');
  }
  if (!input.evidenceHash.trim()) {
    throw new DomainError('REVIEW_EVIDENCE_REQUIRED', 'Attach the review.');
  }
  for (const action of input.correctiveActions) {
    if (action.description.trim().length < 20) {
      throw new DomainError('ACTION_UNDESCRIBED', `"${action.description}" does not say what has to happen.`);
    }
    if (!action.owner.trim() || Number.isNaN(Date.parse(action.by))) {
      throw new DomainError(
        'ACTION_UNOWNED',
        `"${action.description}" has no owner or no date. A prioritised corrective action with neither is a priority ` +
          'nobody holds.',
      );
    }
  }

  const evidence = registerEvidence(ctx, {
    type: 'POST_OCCUPANCY_REVIEW',
    hash: input.evidenceHash,
    description: `${input.reference} — post-occupancy review, ${input.period}`,
  });

  const reviewId = ulid();
  const gaps = comparisons.filter((record) => record.state.gap === true).length;

  write(ctx, {
    eventType: 'POST_OCCUPANCY_REVIEWED',
    entity: { refType: 'PostOccupancyReview', refId: reviewId },
    nextState: {
      reviewId,
      projectId: ctx.projectId,
      reference: input.reference,
      reviewedBy: input.reviewedBy,
      period: input.period,
      findings: input.findings,
      correctiveActions: input.correctiveActions.map((action) => ({ ...action, by: action.by.slice(0, 10) })),
      // What it was written against, so a later reader can tell whether the
      // review had anything to look at.
      gapsConsidered: gaps,
      feedbackConsidered: feedback.length,
      reviewedAt: new Date().toISOString(),
    },
    evidenceRefs: [evidence],
  });

  return {
    reviewId,
    actions: input.correctiveActions.length,
    gapsConsidered: gaps,
    feedbackConsidered: feedback.length,
  };
}

// --- Lessons into organisation memory ---------------------------------------

/**
 * Approve a captured lesson for reuse, and say where reuse is valid.
 *
 * `domain/control.captureLesson` already writes the lesson — with a
 * recommendation somebody could act on and an impact in money or days — and is
 * not duplicated. What it never had is this: the exception control says a
 * lesson is not reused automatically until approved *and context-tagged*, and
 * until now nothing could approve one.
 *
 * AC-H-WF-10-03 is the tagging. A lesson from a hospital's medical-gas
 * commissioning is not a lesson about a warehouse, and an organisation memory
 * that serves it up as one is worse than an empty one — it is wrong with
 * authority.
 */
export function approveLesson(
  ctx: EngineContext,
  lessonId: string,
  input: { approvedBy: string; sectors: string[]; stages: string[]; applicabilityNote: string },
): { lessonId: string; sectors: string[]; stages: string[] } {
  authorise(ctx, 'RISK_REGISTER', 'A');

  const record = ctx.ledger.get({ refType: 'LessonLearned', refId: lessonId });
  if (!record) throw new DomainError('LESSON_NOT_FOUND', `No lesson ${lessonId}`, 404);
  if (record.state.approval) throw new DomainError('ALREADY_APPROVED', 'That lesson has already been approved.');

  if (!input.approvedBy.trim()) throw new DomainError('APPROVAL_UNSIGNED', 'Name who approved it.');
  if (input.sectors.length === 0 || input.stages.length === 0) {
    throw new DomainError(
      'APPLICABILITY_REQUIRED',
      'Name the sectors and the stages where this lesson applies. A lesson from a hospital\'s medical-gas commissioning is ' +
        'not a lesson about a warehouse, and a memory that serves it up as one is wrong with authority.',
    );
  }
  if (input.applicabilityNote.trim().length < 20) {
    throw new DomainError(
      'APPLICABILITY_REQUIRED',
      'Say why it transfers to those sectors and stages. The tags say where; this says why, and it is what the next reader ' +
        'checks their own job against.',
    );
  }

  write(ctx, {
    eventType: 'LESSON_APPROVED',
    entity: { refType: 'LessonLearned', refId: lessonId },
    nextState: {
      ...record.state,
      approval: {
        approvedBy: input.approvedBy,
        sectors: input.sectors,
        stages: input.stages,
        applicabilityNote: input.applicabilityNote,
        approvedAt: new Date().toISOString(),
      },
      // The flag the reuse path reads. Unapproved lessons stay in the register
      // and stay out of the memory.
      reusable: true,
    },
  });

  return { lessonId, sectors: input.sectors, stages: input.stages };
}

/**
 * The approved lessons that apply to a sector and stage.
 *
 * The read side of the control. An unapproved lesson is never returned, and an
 * approved one is returned only where its own tags say it applies.
 */
export function reusableLessons(
  ctx: EngineContext,
  filter: { sector?: string; stage?: string } = {},
): Array<{ lessonId: string; title: string; recommendation: string; sectors: string[]; stages: string[]; applicabilityNote: string }> {
  authorise(ctx, 'RISK_REGISTER', 'R');

  return ctx.ledger
    .list(ctx.projectId, 'LessonLearned')
    .filter((record) => record.state.reusable === true)
    .map((record) => {
      const approval = record.state.approval as Record<string, unknown>;
      return {
        lessonId: record.refId,
        title: String(record.state.title),
        recommendation: String(record.state.recommendation),
        sectors: (approval.sectors ?? []) as string[],
        stages: (approval.stages ?? []) as string[],
        applicabilityNote: String(approval.applicabilityNote),
      };
    })
    .filter((lesson) => !filter.sector || lesson.sectors.includes(filter.sector))
    .filter((lesson) => !filter.stage || lesson.stages.includes(filter.stage));
}

// --- The position -----------------------------------------------------------

export type AftercarePosition = {
  plan: {
    reference: string;
    startsOn: string;
    endsOn: string;
    helpdesk: string;
    aftercareOwner: string;
    reviewDates: string[];
    nextReview: string | null;
    status: string;
  } | null;
  seasonal: ReturnType<typeof reliability.outstandingSeasonalTests>;
  seasonalCompleted: Array<{ reference: string; systemTag: string; result: string; outsideWindow: boolean }>;
  comparisons: Array<{
    reference: string;
    metric: string;
    baselineSource: string;
    variancePercent: number;
    gap: boolean;
    periodFrom: string;
    periodTo: string;
    operatingContext: string;
  }>;
  feedback: ReturnType<typeof feedbackClusters>;
  reviews: Array<{ reference: string; period: string; actions: number; reviewedBy: string }>;
  approvedLessons: number;
  /** Still owed after acceptance, derived by H-WF-09 rather than copied. */
  residual: ReturnType<typeof handoveracceptance.residualObligations>;
  summary: string;
};

export function aftercarePosition(
  ctx: EngineContext,
  today = new Date().toISOString().slice(0, 10),
): AftercarePosition {
  authorise(ctx, 'HANDOVER_OM', 'R');

  const active = plans(ctx).find((plan) => plan.status === 'ACTIVE') ?? plans(ctx)[0] ?? null;

  const seasonalRecords = ctx.ledger.list(ctx.projectId, 'SeasonalTest');
  const seasonalCompleted = seasonalRecords
    .filter((record) => record.state.result !== undefined)
    .map((record) => {
      const result = record.state.result as Record<string, unknown>;
      return {
        reference: String(record.state.reference),
        systemTag: String(record.state.systemTag),
        result: String(result.result),
        outsideWindow: result.outsideWindow === true,
      };
    });

  const comparisons = ctx.ledger.list(ctx.projectId, 'PerformanceComparison').map((record) => ({
    reference: String(record.state.reference),
    metric: String(record.state.metric),
    baselineSource: String(record.state.baselineSource),
    variancePercent: Number(record.state.variancePercent),
    gap: record.state.gap === true,
    periodFrom: String(record.state.periodFrom),
    periodTo: String(record.state.periodTo),
    operatingContext: String(record.state.operatingContext),
  }));

  const reviews = ctx.ledger.list(ctx.projectId, 'PostOccupancyReview').map((record) => ({
    reference: String(record.state.reference),
    period: String(record.state.period),
    actions: ((record.state.correctiveActions ?? []) as unknown[]).length,
    reviewedBy: String(record.state.reviewedBy),
  }));

  const outstanding = reliability.outstandingSeasonalTests(ctx);
  const gaps = comparisons.filter((comparison) => comparison.gap).length;

  const parts: string[] = [];
  parts.push(active ? `aftercare to ${active.endsOn}` : 'no aftercare plan');
  if (outstanding.length > 0) parts.push(`${outstanding.length} seasonal test${outstanding.length === 1 ? '' : 's'} owed`);
  if (gaps > 0) parts.push(`${gaps} performance gap${gaps === 1 ? '' : 's'}`);

  let residual: ReturnType<typeof handoveracceptance.residualObligations> = [];
  try {
    residual = handoveracceptance.residualObligations(ctx);
  } catch {
    // A reader with aftercare access but not the handover read is shown the
    // aftercare position without the residual list, rather than an error.
    residual = [];
  }
  if (residual.length > 0) parts.push(`${residual.length} residual obligation${residual.length === 1 ? '' : 's'}`);

  return {
    plan: active
      ? {
          reference: active.reference,
          startsOn: active.startsOn,
          endsOn: active.endsOn,
          helpdesk: active.helpdesk,
          aftercareOwner: active.aftercareOwner,
          reviewDates: active.reviewDates,
          nextReview: active.reviewDates.find((date) => date >= today) ?? null,
          status: active.status,
        }
      : null,
    seasonal: outstanding,
    seasonalCompleted,
    comparisons,
    feedback: feedbackClusters(ctx),
    reviews,
    approvedLessons: ctx.ledger.list(ctx.projectId, 'LessonLearned').filter((r) => r.state.reusable === true).length,
    residual,
    summary: parts.join(', ') + '.',
  };
}
