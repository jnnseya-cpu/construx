import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, registerEvidence, write, type EngineContext } from '../engines/context.ts';

/**
 * CM-WF-06 — reliability, soak, continuous performance and the seasonal plan.
 *
 * The last commissioning test, and the only one that cannot be passed by doing
 * something well once. A soak test asks whether the plant keeps working, and
 * everything that makes it hard is about the gaps: the hour the trend logger was
 * down, the night somebody put a valve in hand to stop an alarm, the fortnight
 * the run was quietly restarted after a failure.
 *
 * **Metrics are derived, never stored.** AC-CM-WF-06-01: they reproduce from the
 * raw trend data and the configuration. So availability here is computed from
 * the union of the trend segments actually imported, minus the downtime the
 * interventions record — and a figure nobody can recompute is not reported at
 * all. A stored availability percentage is the number that stays at 99.4% for
 * the whole of the fortnight the logger was off.
 *
 * **A data gap is a hole in the evidence, not a period of good behaviour.** The
 * exception control. Time the trend does not cover is time nobody can say
 * anything about, and the commonest failure of a soak test is that it is passed
 * on a dataset with a day missing from the middle. Gaps are derived from what
 * was imported rather than declared, so nobody has to remember to mention one.
 *
 * **A manual override is a fact about the result.** Putting a valve in hand to
 * stop an alarm is the single most effective way to pass a soak test, and it is
 * invisible in the trend unless somebody records it. Interventions carry their
 * kind, and an override counts against availability by the same rule as a
 * failure, because for the period it was in hand the system was not controlling
 * itself.
 *
 * **A seasonal test is an obligation, not a plan.** AC-CM-WF-06-03. Heating
 * cannot be proven in July. What matters is not that somebody wrote down an
 * intention but that a named party **accepted responsibility** for a test that
 * happens after handover, with the criteria fixed now — because criteria agreed
 * in November against a system already in use are agreed under pressure.
 */

export type TrendSegment = {
  from: string;
  to: string;
  points: number;
  evidenceRef: string;
  source: string;
};

export const INTERVENTION_KIND = ['MANUAL_OVERRIDE', 'CORRECTIVE', 'OPERATIONAL', 'EXTERNAL'] as const;
export type InterventionKind = (typeof INTERVENTION_KIND)[number];

export type Intervention = {
  at: string;
  kind: InterventionKind;
  description: string;
  downtimeMinutes: number;
  by: string;
};

export type RunAnomaly = {
  reference: string;
  kind: 'DATA_GAP' | 'DRIFT' | 'HIDDEN_INTERVENTION' | 'PERFORMANCE';
  detail: string;
  detectedBy: string;
  detectedAt: string;
  decision?: { decision: 'CONTINUE' | 'RESET' | 'RETEST'; rationale: string; authorisedBy: string; decidedAt: string };
};

export type ReliabilityRunState = {
  runId: string;
  reference: string;
  systemTag: string;
  from: string;
  to: string;
  requiredHours: number;
  operatingEnvelope: string;
  availabilityTargetPercent: number;
  /** Minutes of interruption the criteria permit before the run is affected. */
  permittedInterruptionMinutes: number;
  /** Minutes of missing trend the run tolerates before the evidence is holed. */
  dataGapToleranceMinutes: number;
  resetRule: string;
  segments: TrendSegment[];
  interventions: Intervention[];
  anomalies: RunAnomaly[];
  status: 'RUNNING' | 'PAUSED' | 'ACCEPTED' | 'RESET';
  acceptance?: { acceptedBy: string; note: string; acceptedAt: string; metrics: RunMetrics };
};

/** Everything reported about a run, derived from the segments and the configuration. */
export type RunMetrics = {
  windowMinutes: number;
  coveredMinutes: number;
  gapMinutes: number;
  downtimeMinutes: number;
  overrideMinutes: number;
  /**
   * Available time as a proportion of the time there is evidence for.
   *
   * Deliberately not over the whole window. The window minus the coverage is
   * the **gap**, and it is reported and judged separately: rolling the two
   * together would let a fortnight of missing trend read as a fortnight of
   * unavailability, which is a different — and much more specific — claim than
   * the truth, which is that nobody knows.
   */
  availabilityPercent: number;
  /** Continuous hours actually evidenced. */
  evidencedHours: number;
  gapWithinTolerance: boolean;
  meetsAvailability: boolean;
  meetsDuration: boolean;
};

function requireRun(ctx: EngineContext, runId: string) {
  const record = ctx.ledger.get({ refType: 'ReliabilityRun', refId: runId });
  if (!record) throw new DomainError('RUN_NOT_FOUND', `No reliability run ${runId}`, 404);
  return record;
}

function stateOf(record: { state: Record<string, unknown> }): ReliabilityRunState {
  return record.state as unknown as ReliabilityRunState;
}

/** Minutes covered by a set of intervals, overlaps counted once. */
function unionMinutes(segments: readonly TrendSegment[], windowFrom: number, windowTo: number): number {
  const clipped = segments
    .map((segment) => ({
      from: Math.max(Date.parse(segment.from), windowFrom),
      to: Math.min(Date.parse(segment.to), windowTo),
    }))
    .filter((segment) => segment.to > segment.from)
    .sort((a, b) => a.from - b.from);

  let covered = 0;
  let cursor = -Infinity;
  for (const segment of clipped) {
    const start = Math.max(segment.from, cursor);
    if (segment.to > start) {
      covered += segment.to - start;
      cursor = segment.to;
    }
  }
  return Math.round(covered / 60_000);
}

/**
 * The metrics, computed rather than read.
 *
 * Exported so a caller can recompute them from the same state and get the same
 * answer, which is AC-CM-WF-06-01 in the only form that means anything.
 */
export function metricsOf(state: ReliabilityRunState): RunMetrics {
  const windowFrom = Date.parse(state.from);
  const windowTo = Date.parse(state.to);
  const windowMinutes = Math.max(0, Math.round((windowTo - windowFrom) / 60_000));

  const coveredMinutes = unionMinutes(state.segments, windowFrom, windowTo);
  const gapMinutes = Math.max(0, windowMinutes - coveredMinutes);

  const downtimeMinutes = state.interventions.reduce((sum, entry) => sum + entry.downtimeMinutes, 0);
  const overrideMinutes = state.interventions
    .filter((entry) => entry.kind === 'MANUAL_OVERRIDE')
    .reduce((sum, entry) => sum + entry.downtimeMinutes, 0);

  const availableMinutes = Math.max(0, coveredMinutes - downtimeMinutes);
  const availabilityPercent = coveredMinutes === 0 ? 0 : Math.round((availableMinutes / coveredMinutes) * 1000) / 10;
  const evidencedHours = Math.round((availableMinutes / 60) * 10) / 10;

  return {
    windowMinutes,
    coveredMinutes,
    gapMinutes,
    downtimeMinutes,
    overrideMinutes,
    availabilityPercent,
    evidencedHours,
    gapWithinTolerance: gapMinutes <= state.dataGapToleranceMinutes,
    meetsAvailability: availabilityPercent >= state.availabilityTargetPercent,
    meetsDuration: evidencedHours >= state.requiredHours,
  };
}

/** Configure and start the run. */
export function startReliabilityRun(
  ctx: EngineContext,
  input: {
    reference: string;
    systemTag: string;
    from: string;
    to: string;
    requiredHours: number;
    operatingEnvelope: string;
    availabilityTargetPercent: number;
    permittedInterruptionMinutes: number;
    dataGapToleranceMinutes: number;
    resetRule: string;
    operationsAttendance: string;
  },
): { runId: string; windowHours: number } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'C', { lifecyclePhase: currentPhase(ctx) });

  if (!input.reference.trim()) throw new DomainError('RUN_UNREFERENCED', 'A reliability run carries a reference.');

  if (Number.isNaN(Date.parse(input.from)) || Number.isNaN(Date.parse(input.to))) {
    throw new DomainError('WINDOW_REQUIRED', 'A run window is two instants.');
  }
  const windowHours = (Date.parse(input.to) - Date.parse(input.from)) / 3_600_000;
  if (windowHours <= 0) throw new DomainError('WINDOW_REQUIRED', 'The end of the window is not after the start of it.');
  if (input.requiredHours <= 0) {
    throw new DomainError(
      'DURATION_REQUIRED',
      'State the continuous hours the criteria require. A soak test with no duration on it is a period of operation.',
    );
  }
  if (input.requiredHours > windowHours) {
    throw new DomainError(
      'WINDOW_TOO_SHORT',
      `The window is ${Math.round(windowHours)} hours and the criteria need ${input.requiredHours}. The run cannot ` +
        'succeed as configured, and finding that out at the end is the expensive way.',
    );
  }
  if (input.operatingEnvelope.trim().length < 15) {
    throw new DomainError(
      'ENVELOPE_REQUIRED',
      'Describe the operating envelope. A soak test run at 20% load proves the plant can idle, and without the envelope ' +
        'nobody reading the result later can tell which test this was.',
    );
  }
  if (input.availabilityTargetPercent <= 0 || input.availabilityTargetPercent > 100) {
    throw new DomainError('TARGET_REQUIRED', 'The availability criterion is a percentage between 0 and 100.');
  }
  if (!input.resetRule.trim()) {
    throw new DomainError(
      'RESET_RULE_REQUIRED',
      'State what resets the run and what does not. Agreeing that afterwards is agreeing it with the answer already known.',
    );
  }
  if (!input.operationsAttendance.trim()) {
    throw new DomainError(
      'OPERATIONS_ATTENDANCE_REQUIRED',
      'Name who is attending from operations. A soak test nobody from operations watched is a test whose result they have ' +
        'no reason to accept.',
    );
  }

  // The trigger for this workflow is functional performance accepted, and it is
  // a real precondition rather than a sequence note: a system that has not been
  // proven to work cannot be proven to keep working.
  const proven = ctx.ledger
    .list(ctx.projectId, 'FunctionalTest')
    .some(
      (record) =>
        record.state.systemTag === input.systemTag &&
        record.state.kind === 'FUNCTIONAL' &&
        record.state.decision === 'PASS',
    );
  if (ctx.ledger.list(ctx.projectId, 'FunctionalTest').length > 0 && !proven) {
    throw new DomainError(
      'FUNCTIONAL_NOT_ACCEPTED',
      `${input.systemTag} has no passed functional test. A system that has not been proven to work cannot be proven to ` +
        'keep working, and a soak test started early is a fortnight spent finding that out.',
    );
  }

  const runId = ulid();

  write(ctx, {
    eventType: 'RELIABILITY_TEST_STARTED',
    entity: { refType: 'ReliabilityRun', refId: runId },
    nextState: {
      runId,
      projectId: ctx.projectId,
      reference: input.reference,
      systemTag: input.systemTag,
      from: input.from,
      to: input.to,
      requiredHours: input.requiredHours,
      operatingEnvelope: input.operatingEnvelope,
      availabilityTargetPercent: input.availabilityTargetPercent,
      permittedInterruptionMinutes: input.permittedInterruptionMinutes,
      dataGapToleranceMinutes: input.dataGapToleranceMinutes,
      resetRule: input.resetRule,
      operationsAttendance: input.operationsAttendance,
      segments: [],
      interventions: [],
      anomalies: [],
      status: 'RUNNING',
      startedBy: ctx.auth.actorId,
      startedAt: new Date().toISOString(),
    },
  });

  return { runId, windowHours: Math.round(windowHours * 10) / 10 };
}

/** Import a segment of trend data. Coverage and gaps are derived from these. */
export function importTrendSegment(
  ctx: EngineContext,
  runId: string,
  input: { source: string; from: string; to: string; points: number; datasetHash: string },
): { coveredMinutes: number; gapMinutes: number } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'U', { lifecyclePhase: currentPhase(ctx) });

  const record = requireRun(ctx, runId);
  const state = stateOf(record);

  if (state.status === 'ACCEPTED') {
    throw new DomainError(
      'RUN_ACCEPTED',
      'This run has been accepted. Trend added afterwards changes the metrics behind a decision somebody has already made.',
    );
  }
  if (Number.isNaN(Date.parse(input.from)) || Number.isNaN(Date.parse(input.to)) || Date.parse(input.to) <= Date.parse(input.from)) {
    throw new DomainError('WINDOW_REQUIRED', 'A trend segment covers a window between two instants.');
  }
  if (input.points <= 0) throw new DomainError('SEGMENT_EMPTY', 'A segment with no points in it evidences nothing.');
  if (!input.datasetHash.trim()) {
    throw new DomainError(
      'DATASET_UNREFERENCED',
      'A trend segment carries the hash of the data. The metrics are recomputed from it, and data nobody can identify ' +
        'cannot be recomputed from.',
    );
  }
  if (Date.parse(input.from) < Date.parse(state.from) || Date.parse(input.to) > Date.parse(state.to)) {
    throw new DomainError(
      'SEGMENT_OUTSIDE_WINDOW',
      `The segment falls outside the run window ${state.from} to ${state.to}. Trend from before the run started does not ` +
        'evidence the run.',
    );
  }

  const evidence = registerEvidence(ctx, {
    type: 'RELIABILITY_TREND_SEGMENT',
    hash: input.datasetHash,
    description: `${state.reference} trend from ${input.source}, ${input.points} points between ${input.from} and ${input.to}`,
    linkedEntities: [{ refType: 'ReliabilityRun', refId: runId }],
  });

  const segments = [
    ...state.segments,
    { source: input.source, from: input.from, to: input.to, points: input.points, evidenceRef: evidence.refId },
  ];
  const metrics = metricsOf({ ...state, segments });

  write(ctx, {
    eventType: 'RELIABILITY_TREND_IMPORTED',
    entity: { refType: 'ReliabilityRun', refId: runId },
    nextState: { ...record.state, segments },
    evidenceRefs: [evidence],
  });

  return { coveredMinutes: metrics.coveredMinutes, gapMinutes: metrics.gapMinutes };
}

/** Log an intervention or period of downtime. */
export function recordIntervention(
  ctx: EngineContext,
  runId: string,
  input: { at: string; kind: InterventionKind; description: string; downtimeMinutes: number; by: string },
): { downtimeMinutes: number; availabilityPercent: number } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'U', { lifecyclePhase: currentPhase(ctx) });

  const record = requireRun(ctx, runId);
  const state = stateOf(record);

  if (state.status === 'ACCEPTED') throw new DomainError('RUN_ACCEPTED', 'This run has been accepted.');
  if (Number.isNaN(Date.parse(input.at))) throw new DomainError('TIME_REQUIRED', 'An intervention happened at a time.');
  if (input.description.trim().length < 10) {
    throw new DomainError(
      'INTERVENTION_UNDESCRIBED',
      'Say what was done. An intervention recorded as "reset" is the one nobody can tell apart from a fault.',
    );
  }
  if (input.downtimeMinutes < 0) throw new DomainError('DOWNTIME_INVALID', 'Downtime is not negative.');
  if (!input.by.trim()) throw new DomainError('INTERVENTION_UNSIGNED', 'Name who intervened.');

  const interventions = [...state.interventions, { ...input }];
  const metrics = metricsOf({ ...state, interventions });

  write(ctx, {
    eventType: 'RELIABILITY_INTERVENTION_LOGGED',
    entity: { refType: 'ReliabilityRun', refId: runId },
    nextState: { ...record.state, interventions },
  });

  return { downtimeMinutes: metrics.downtimeMinutes, availabilityPercent: metrics.availabilityPercent };
}

/** Flag an anomaly. An agent may propose one; an engineer records it. */
export function flagAnomaly(
  ctx: EngineContext,
  runId: string,
  input: { reference: string; kind: RunAnomaly['kind']; detail: string; detectedBy: string },
): { reference: string } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'U', { lifecyclePhase: currentPhase(ctx) });

  const record = requireRun(ctx, runId);
  const state = stateOf(record);

  if (input.detail.trim().length < 10) {
    throw new DomainError('ANOMALY_UNDESCRIBED', 'Say what was seen. An anomaly with no description cannot be decided on.');
  }
  if (!input.detectedBy.trim()) throw new DomainError('ANOMALY_UNSIGNED', 'Name who or what detected it.');
  if (state.anomalies.some((anomaly) => anomaly.reference === input.reference)) {
    throw new DomainError('ANOMALY_TAKEN', `${input.reference} is already flagged on this run.`);
  }

  write(ctx, {
    eventType: 'PERFORMANCE_ANOMALY_DETECTED',
    entity: { refType: 'ReliabilityRun', refId: runId },
    nextState: {
      ...record.state,
      status: 'PAUSED',
      anomalies: [
        ...state.anomalies,
        {
          reference: input.reference,
          kind: input.kind,
          detail: input.detail,
          detectedBy: input.detectedBy,
          detectedAt: new Date().toISOString(),
        },
      ],
    },
  });

  return { reference: input.reference };
}

/**
 * Decide what an anomaly does to the run.
 *
 * AC-CM-WF-06-02: authorised and auditable. Continue, reset or retest is the
 * single most consequential decision in a soak test — a reset costs the whole
 * duration again — and the one most often taken by whoever is standing nearest
 * the panel.
 */
export function decideAnomaly(
  ctx: EngineContext,
  runId: string,
  input: { reference: string; decision: 'CONTINUE' | 'RESET' | 'RETEST'; rationale: string; authorisedBy: string },
): { status: string } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'A', { lifecyclePhase: currentPhase(ctx) });

  const record = requireRun(ctx, runId);
  const state = stateOf(record);
  const anomaly = state.anomalies.find((entry) => entry.reference === input.reference);
  if (!anomaly) throw new DomainError('ANOMALY_NOT_FOUND', `No anomaly ${input.reference} on this run.`, 404);
  if (anomaly.decision) throw new DomainError('ANOMALY_DECIDED', `${input.reference} has already been decided.`);

  if (input.rationale.trim().length < 15) {
    throw new DomainError(
      'RATIONALE_REQUIRED',
      `Say why the run ${input.decision.toLowerCase() === 'continue' ? 'continues' : 'does not'}. A reset costs the whole ` +
        'duration again and a continue carries the anomaly into the result; both are decisions somebody has to stand behind.',
    );
  }
  if (!input.authorisedBy.trim()) {
    throw new DomainError('DECISION_UNAUTHORISED', 'Name the authority. This is not a decision for whoever is nearest the panel.');
  }

  const decided = state.anomalies.map((entry) =>
    entry.reference === input.reference
      ? {
          ...entry,
          decision: {
            decision: input.decision,
            rationale: input.rationale,
            authorisedBy: input.authorisedBy,
            decidedAt: new Date().toISOString(),
          },
        }
      : entry,
  );

  const outstanding = decided.some((entry) => !entry.decision);
  const status = input.decision === 'RESET' ? 'RESET' : outstanding ? 'PAUSED' : 'RUNNING';

  write(ctx, {
    eventType: 'RELIABILITY_ANOMALY_DECIDED',
    entity: { refType: 'ReliabilityRun', refId: runId },
    nextState: { ...record.state, anomalies: decided, status },
  });

  return { status };
}

/**
 * Accept the run.
 *
 * Every refusal is arithmetic rather than opinion, and the metrics are written
 * onto the acceptance so the figures the decision rested on are recoverable even
 * if the run is later extended.
 */
export function acceptReliabilityRun(
  ctx: EngineContext,
  runId: string,
  input: { acceptedBy: string; note: string },
): { metrics: RunMetrics } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'A', { lifecyclePhase: currentPhase(ctx) });

  const record = requireRun(ctx, runId);
  const state = stateOf(record);

  if (state.status === 'ACCEPTED') throw new DomainError('RUN_ACCEPTED', `${state.reference} is already accepted.`);
  if (state.status === 'RESET') {
    throw new DomainError('RUN_RESET', `${state.reference} was reset. Start the run again rather than accepting the part of it that ran.`);
  }
  if (!input.acceptedBy.trim() || input.note.trim().length < 10) {
    throw new DomainError(
      'ACCEPTANCE_UNSIGNED',
      'Name the authorised engineer accepting the result and say what it rests on.',
    );
  }

  const undecided = state.anomalies.filter((anomaly) => !anomaly.decision);
  if (undecided.length > 0) {
    throw new DomainError(
      'ANOMALIES_UNDECIDED',
      `${undecided.map((anomaly) => anomaly.reference).join(', ')} ${undecided.length === 1 ? 'has' : 'have'} no decision. ` +
        'Accepting over an undecided anomaly accepts it without saying so.',
    );
  }

  const metrics = metricsOf(state);

  if (!metrics.gapWithinTolerance) {
    throw new DomainError(
      'DATA_GAP',
      `${metrics.gapMinutes} minutes of the window carry no trend data, against a tolerance of ` +
        `${state.dataGapToleranceMinutes}. Time the trend does not cover is time nobody can say anything about, and a soak ` +
        'test passed on a dataset with a day missing from the middle proves nothing about that day.',
    );
  }
  // Availability before duration, and the order is not arbitrary. A run that
  // lost ten hours to a valve in hand is also short of its duration, and telling
  // somebody to run it for longer would be advice that fixes nothing. What
  // failed is the plant, and that is what the refusal has to say.
  if (!metrics.meetsAvailability) {
    throw new DomainError(
      'AVAILABILITY_NOT_MET',
      `Availability ${metrics.availabilityPercent}% against a target of ${state.availabilityTargetPercent}%` +
        (metrics.overrideMinutes > 0
          ? `, including ${metrics.overrideMinutes} minutes in manual override — for which the system was not controlling itself.`
          : '.'),
    );
  }
  if (!metrics.meetsDuration) {
    throw new DomainError(
      'DURATION_NOT_MET',
      `${metrics.evidencedHours} hours evidenced against ${state.requiredHours} required.`,
    );
  }

  write(ctx, {
    eventType: 'RELIABILITY_TEST_ACCEPTED',
    entity: { refType: 'ReliabilityRun', refId: runId },
    nextState: {
      ...record.state,
      status: 'ACCEPTED',
      acceptance: { acceptedBy: input.acceptedBy, note: input.note, acceptedAt: new Date().toISOString(), metrics },
    },
  });

  return { metrics };
}

// --- The seasonal plan ------------------------------------------------------

/**
 * Plan a test that cannot happen before handover.
 *
 * AC-CM-WF-06-03. The criteria are fixed now rather than later: criteria agreed
 * in November against a system already in use are agreed under pressure, and the
 * party that has to meet them is by then the one least able to argue.
 */
export function planSeasonalTest(
  ctx: EngineContext,
  input: {
    reference: string;
    systemTag: string;
    condition: string;
    criteria: string;
    owner: string;
    ownerOrganisation: string;
    /** The party accepting the obligation, which is not always the owner. */
    responsibilityAcceptedBy: string;
    windowFrom: string;
    windowTo: string;
  },
): { seasonalTestId: string } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'A', { lifecyclePhase: currentPhase(ctx) });

  if (!input.reference.trim()) throw new DomainError('TEST_UNREFERENCED', 'A seasonal test carries a reference.');
  if (input.condition.trim().length < 10) {
    throw new DomainError(
      'CONDITION_REQUIRED',
      'Say what condition is unavailable. "Seasonal" is not a condition; "outside air below 2°C sustained for six hours" ' +
        'is, and it is what tells anybody whether the window was met.',
    );
  }
  if (input.criteria.trim().length < 15) {
    throw new DomainError(
      'CRITERIA_REQUIRED',
      'Fix the acceptance criteria now. Criteria agreed later against a system already in use are agreed under pressure, ' +
        'and the party that has to meet them is by then the one least able to argue.',
    );
  }
  if (!input.owner.trim() || !input.ownerOrganisation.trim()) {
    throw new DomainError('OWNER_REQUIRED', 'Name who carries out the test and the organisation they answer to.');
  }
  if (!input.responsibilityAcceptedBy.trim()) {
    throw new DomainError(
      'RESPONSIBILITY_UNACCEPTED',
      'Name the party accepting the obligation. A deferred test nobody accepted is a deferred test nobody does, and it ' +
        'surfaces two winters later as a defect.',
    );
  }
  if (Number.isNaN(Date.parse(input.windowFrom)) || Number.isNaN(Date.parse(input.windowTo))) {
    throw new DomainError('WINDOW_REQUIRED', 'A seasonal test has a window it can be carried out in.');
  }
  if (Date.parse(input.windowTo) <= Date.parse(input.windowFrom)) {
    throw new DomainError('WINDOW_REQUIRED', 'The end of the window is not after the start of it.');
  }

  const seasonalTestId = ulid();

  write(ctx, {
    eventType: 'SEASONAL_TEST_PLANNED',
    entity: { refType: 'SeasonalTest', refId: seasonalTestId },
    nextState: {
      seasonalTestId,
      projectId: ctx.projectId,
      reference: input.reference,
      systemTag: input.systemTag,
      condition: input.condition,
      criteria: input.criteria,
      owner: input.owner,
      ownerOrganisation: input.ownerOrganisation,
      responsibilityAcceptedBy: input.responsibilityAcceptedBy,
      windowFrom: input.windowFrom,
      windowTo: input.windowTo,
      status: 'OUTSTANDING',
      plannedBy: ctx.auth.actorId,
      plannedAt: new Date().toISOString(),
    },
  });

  return { seasonalTestId };
}

/**
 * Every seasonal test still owed.
 *
 * The exception control: it stays visible after handover until it is closed.
 * Exported so the handover stage inherits them by reference rather than copying
 * them into a second list that then diverges.
 */
export function outstandingSeasonalTests(
  ctx: EngineContext,
): Array<{ reference: string; systemTag: string; condition: string; criteria: string; owner: string; windowFrom: string; windowTo: string; responsibilityAcceptedBy: string }> {
  return ctx.ledger
    .list(ctx.projectId, 'SeasonalTest')
    .filter((record) => record.state.status === 'OUTSTANDING')
    .map((record) => ({
      reference: String(record.state.reference),
      systemTag: String(record.state.systemTag),
      condition: String(record.state.condition),
      criteria: String(record.state.criteria),
      owner: `${String(record.state.owner)} (${String(record.state.ownerOrganisation)})`,
      windowFrom: String(record.state.windowFrom),
      windowTo: String(record.state.windowTo),
      responsibilityAcceptedBy: String(record.state.responsibilityAcceptedBy),
    }));
}

// --- The position -----------------------------------------------------------

export type ReliabilityPosition = {
  runs: Array<{
    runId: string;
    reference: string;
    systemTag: string;
    status: string;
    metrics: RunMetrics;
    openAnomalies: string[];
  }>;
  seasonal: ReturnType<typeof outstandingSeasonalTests>;
  summary: string;
};

export function reliabilityPosition(ctx: EngineContext): ReliabilityPosition {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'R');

  const states = ctx.ledger.list(ctx.projectId, 'ReliabilityRun').map(stateOf);
  const seasonal = outstandingSeasonalTests(ctx);

  const runs = states.map((state) => ({
    runId: state.runId,
    reference: state.reference,
    systemTag: state.systemTag,
    status: state.status,
    // Recomputed on every read rather than served from the record: a stored
    // availability figure is the one that stays at 99.4% for the whole of the
    // fortnight the logger was off.
    metrics: metricsOf(state),
    openAnomalies: state.anomalies.filter((anomaly) => !anomaly.decision).map((anomaly) => anomaly.reference),
  }));

  const accepted = runs.filter((run) => run.status === 'ACCEPTED').length;
  const holed = runs.filter((run) => !run.metrics.gapWithinTolerance).length;

  const parts = [`${runs.length} reliability run${runs.length === 1 ? '' : 's'}`, `${accepted} accepted`];
  if (holed > 0) parts.push(`${holed} with more missing trend than the tolerance allows`);
  if (seasonal.length > 0) parts.push(`${seasonal.length} seasonal test owed after handover`);

  return { runs, seasonal, summary: parts.join(', ') + '.' };
}
