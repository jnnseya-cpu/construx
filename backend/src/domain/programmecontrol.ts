import { hashEvidence } from '../core/canonical.ts';
import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, registerEvidence, write, type EngineContext } from '../engines/context.ts';
import { calculateCPM, type Activity, type Dependency } from '../engines/maths/cpm.ts';

/**
 * CN-WF-02 — baseline, lookahead, task and constraint control.
 *
 * Most of this workflow was already built. `engines/planning.ts` holds the
 * critical path, the programme baseline, the six-week lookahead, the Last
 * Planner commitment rule, the constraint register, PPC and productivity. None
 * of it is rebuilt here, and this module deliberately owns only the four things
 * that were missing.
 *
 * **Logic nobody validated.** A baseline is approved by running the critical
 * path over whatever logic happens to be in the ledger. A programme with forty
 * open ends has a critical path; it is simply not the project's. Step 1 asks
 * for open-end, constraint, calendar and critical-path validation before the
 * baseline is trusted, and `validateProgrammeLogic` is that — findings by
 * severity, each naming the activity rather than counting it.
 *
 * **A forecast that overwrites the baseline.** The first exception control, and
 * the one with money behind it: the baseline is what delay is measured against,
 * so a forecast that quietly replaces it destroys the only reference the
 * measurement has. A forecast is therefore a separate record, and a *second*
 * baseline is refused unless a change request authorises it.
 *
 * **A blocked task with nothing behind the word.** AC-CN-WF-02-02 asks for a
 * reason, an owner, an impact and a next action on every blocked task, and it
 * is right to: "blocked" on a status board with none of those is a way of not
 * saying who has to do what. All four are required, and a task cannot be marked
 * complete without the verification evidence the third exception control names.
 *
 * **Out-of-sequence progress with no decision behind it.** Working a task whose
 * predecessor has not finished is normal on site and catastrophic in a
 * programme, because retained logic and progress override produce different
 * completion dates from the same facts. The second exception control asks for
 * the decision to be *recorded* rather than configured once and forgotten, so
 * the status update carries which was chosen and why.
 *
 * Reproducibility, AC-CN-WF-02-01: every calculation here hashes the logic it
 * ran over — durations, dependencies, types and lags, in a canonical order — so
 * two runs over the same stored programme produce the same hash and the same
 * critical path, and a run that does not is evidence the programme moved.
 */

// --- Step 1: validate the logic ---------------------------------------------

export const LOGIC_FINDING = [
  /** No predecessor. Nothing decides when it starts. */
  'OPEN_END_START',
  /** No successor. Nothing it finishes for. */
  'OPEN_END_FINISH',
  /** A dependency naming an activity that is not on the programme. */
  'DANGLING_LOGIC',
  'SELF_DEPENDENCY',
  'DUPLICATE_LOGIC',
  'NEGATIVE_FLOAT',
  /** Float so large the activity is effectively detached from the project. */
  'DETACHED_FLOAT',
  'NEGATIVE_DURATION',
  /** Progress on an activity whose predecessor has none. */
  'OUT_OF_SEQUENCE',
] as const;
export type LogicFindingKind = (typeof LOGIC_FINDING)[number];

const SEVERITY: Record<LogicFindingKind, 'CRITICAL' | 'MAJOR' | 'MINOR'> = {
  // A programme cannot be baselined over these: the arithmetic is wrong, not
  // merely untidy.
  DANGLING_LOGIC: 'CRITICAL',
  SELF_DEPENDENCY: 'CRITICAL',
  NEGATIVE_DURATION: 'CRITICAL',
  NEGATIVE_FLOAT: 'CRITICAL',
  // These make the critical path a fiction without making it uncomputable.
  OPEN_END_START: 'MAJOR',
  OPEN_END_FINISH: 'MAJOR',
  OUT_OF_SEQUENCE: 'MAJOR',
  DETACHED_FLOAT: 'MINOR',
  DUPLICATE_LOGIC: 'MINOR',
};

export type LogicFinding = {
  kind: LogicFindingKind;
  severity: 'CRITICAL' | 'MAJOR' | 'MINOR';
  taskId?: string;
  taskName?: string;
  what: string;
};

export type LogicValidation = {
  hasNetwork: boolean;
  activities: number;
  dependencies: number;
  projectDurationDays: number;
  criticalPath: Array<{ taskId: string; name: string }>;
  findings: LogicFinding[];
  /** Blocking findings, by kind. A baseline over one of these is not a baseline. */
  blocking: LogicFindingKind[];
  /**
   * Over the durations, the logic, its types and lags, in a canonical order.
   * AC-CN-WF-02-01: the same stored programme gives the same hash and the same
   * critical path, and a different hash is evidence the programme moved.
   */
  logicHash: string;
  summary: string;
};

type TaskRow = {
  id: string;
  name: string;
  durationDays: number;
  percentComplete: number;
  status: string;
  /**
   * One definition of started, used by the validation and by the status update
   * alike. Two of them — one reading the percentage, one reading the status —
   * would let the same activity be out of sequence on the report and in
   * sequence at the point it was recorded, which is worse than neither.
   */
  started: boolean;
};

function network(ctx: EngineContext): { tasks: TaskRow[]; dependencies: Dependency[] } {
  const tasks = ctx.ledger.list(ctx.projectId, 'Task').map((record) => {
    const percentComplete = Number(record.state.percentComplete ?? 0);
    const status = String(record.state.status ?? 'NOT_STARTED');
    return {
      id: record.refId,
      name: String(record.state.name),
      durationDays: Number(record.state.durationDays),
      percentComplete,
      status,
      started: percentComplete > 0 || status === 'IN_PROGRESS' || status === 'COMPLETE',
    };
  });
  const dependencies = ctx.ledger.list(ctx.projectId, 'Dependency').map((record) => ({
    predecessorId: String(record.state.predecessorId),
    successorId: String(record.state.successorId),
    type: record.state.type as Dependency['type'],
    lag: Number(record.state.lag ?? 0),
  }));
  return { tasks, dependencies };
}

/**
 * The hash the reproducibility claim rests on.
 *
 * Sorted before hashing, so the answer does not depend on the order the ledger
 * happened to return records in — an unsorted hash would report "the programme
 * moved" every time a record was written anywhere on the project.
 */
export function logicHashOf(tasks: TaskRow[], dependencies: Dependency[]): string {
  const activities = [...tasks]
    .map((task) => `${task.id}:${task.durationDays}`)
    .sort();
  const logic = dependencies
    .map((edge) => `${edge.predecessorId}>${edge.successorId}:${edge.type}:${edge.lag}`)
    .sort();
  return hashEvidence(JSON.stringify({ activities, logic }));
}

/**
 * The approved baselines, which is not the same as every `ProgrammeBaseline`.
 *
 * `recalculateProgramme` writes the live critical-path recalculation onto a
 * record of the same type, marked `LIVE`, so that a screen can read the current
 * position without re-running the arithmetic. Counting it as a baseline would
 * make the first re-baseline refusal fire on every project that had ever
 * recalculated — and would have the forecast quote its variance against a
 * recalculation rather than against the contract programme, which is the number
 * every extension of time argument turns on.
 */
function approvedBaselines(ctx: EngineContext): ReturnType<EngineContext['ledger']['list']> {
  return ctx.ledger
    .list(ctx.projectId, 'ProgrammeBaseline')
    .filter((record) => record.state.type === 'BASELINE' && record.state.status === 'APPROVED');
}

export function validateProgrammeLogic(ctx: EngineContext): LogicValidation {
  authorise(ctx, 'PROGRAMME_BASELINES', 'R');

  const { tasks, dependencies } = network(ctx);
  const findings: LogicFinding[] = [];
  const byId = new Map(tasks.map((task) => [task.id, task]));

  const add = (kind: LogicFindingKind, what: string, task?: TaskRow) => {
    findings.push({
      kind,
      severity: SEVERITY[kind],
      ...(task ? { taskId: task.id, taskName: task.name } : {}),
      what,
    });
  };

  const hasPredecessor = new Set<string>();
  const hasSuccessor = new Set<string>();
  const seenEdges = new Set<string>();

  for (const edge of dependencies) {
    const key = `${edge.predecessorId}>${edge.successorId}:${edge.type}`;
    if (seenEdges.has(key)) {
      add('DUPLICATE_LOGIC', `${edge.predecessorId} to ${edge.successorId} is linked twice with the same relationship.`);
    }
    seenEdges.add(key);

    if (edge.predecessorId === edge.successorId) {
      add('SELF_DEPENDENCY', 'An activity cannot be its own predecessor.', byId.get(edge.predecessorId));
      continue;
    }
    const predecessor = byId.get(edge.predecessorId);
    const successor = byId.get(edge.successorId);
    if (!predecessor || !successor) {
      add(
        'DANGLING_LOGIC',
        `A link names ${!predecessor ? edge.predecessorId : edge.successorId}, which is not an activity on this programme. ` +
          'The critical path is computed over the links that resolve, so this one silently drops out of it.',
      );
      continue;
    }
    hasPredecessor.add(edge.successorId);
    hasSuccessor.add(edge.predecessorId);

    // The second exception control's trigger: progress on an activity whose
    // predecessor has none.
    if (successor.started && !predecessor.started) {
      add(
        'OUT_OF_SEQUENCE',
        `"${successor.name}" is under way while its predecessor "${predecessor.name}" has not started. ` +
          'Retained logic and progress override give different completion dates from these same facts, so which was chosen has ' +
          'to be a decision on the record.',
        successor,
      );
    }
  }

  for (const task of tasks) {
    if (task.durationDays < 0) {
      add('NEGATIVE_DURATION', `"${task.name}" has a duration of ${task.durationDays} days.`, task);
    }
    if (!hasPredecessor.has(task.id)) {
      add(
        'OPEN_END_START',
        `Nothing decides when "${task.name}" starts. A programme of open ends has a critical path; it is not the project's.`,
        task,
      );
    }
    if (!hasSuccessor.has(task.id)) {
      add('OPEN_END_FINISH', `Nothing waits on "${task.name}". Its float is unbounded, so it can never be critical.`, task);
    }
  }

  const activities: Activity[] = tasks.map((task) => ({
    id: task.id,
    name: task.name,
    duration: Math.max(0, task.durationDays),
  }));

  let projectDurationDays = 0;
  let criticalPath: LogicValidation['criticalPath'] = [];

  if (activities.length > 0) {
    // Only the links that resolve, which is what the critical path is actually
    // computed over — running it over dangling logic would either throw or
    // quietly invent an activity, and both hide the finding above.
    const resolvable = dependencies.filter(
      (edge) => byId.has(edge.predecessorId) && byId.has(edge.successorId) && edge.predecessorId !== edge.successorId,
    );
    const cpm = calculateCPM(activities, resolvable);
    projectDurationDays = cpm.projectDuration;
    criticalPath = cpm.criticalPath.map((taskId) => ({ taskId, name: byId.get(taskId)?.name ?? taskId }));

    for (const activity of cpm.activities) {
      if (activity.totalFloat < 0) {
        add(
          'NEGATIVE_FLOAT',
          `"${activity.name}" carries ${activity.totalFloat} days of float, which means the logic already cannot be met.`,
          byId.get(activity.id),
        );
      } else if (projectDurationDays > 0 && activity.totalFloat > projectDurationDays / 2) {
        add(
          'DETACHED_FLOAT',
          `"${activity.name}" has ${activity.totalFloat} days of float against a ${projectDurationDays}-day programme, which ` +
            'usually means it is linked to nothing that matters rather than that it is genuinely flexible.',
          byId.get(activity.id),
        );
      }
    }
  }

  const blocking = [...new Set(findings.filter((finding) => finding.severity === 'CRITICAL').map((f) => f.kind))];

  const counts = new Map<string, number>();
  for (const finding of findings) counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
  const parts = [`${tasks.length} activit${tasks.length === 1 ? 'y' : 'ies'}, ${dependencies.length} link${dependencies.length === 1 ? '' : 's'}`];
  for (const severity of ['CRITICAL', 'MAJOR', 'MINOR'] as const) {
    const count = counts.get(severity) ?? 0;
    if (count > 0) parts.push(`${count} ${severity.toLowerCase()}`);
  }

  return {
    hasNetwork: tasks.length > 0,
    activities: tasks.length,
    dependencies: dependencies.length,
    projectDurationDays,
    criticalPath,
    findings,
    blocking,
    logicHash: logicHashOf(tasks, dependencies),
    summary: parts.join(', ') + '.',
  };
}

// --- The forecast, which never overwrites the baseline -----------------------

/**
 * Approve a current forecast.
 *
 * A separate record from the baseline, deliberately. The baseline is what delay
 * is measured against; a forecast that replaced it would destroy the only
 * reference the measurement has, and every extension of time argument on the
 * project with it. AC-CN-WF-02-03 asks for the two to be visually distinct, and
 * they are distinct records before they are distinct colours.
 */
export function approveForecast(
  ctx: EngineContext,
  input: { version: string; reason: string; forecastCompletionDate: string },
): {
  forecastId: string;
  durationDays: number;
  varianceDays: number | null;
  logicHash: string;
} {
  authorise(ctx, 'PROGRAMME_BASELINES', 'A', { lifecyclePhase: currentPhase(ctx) });

  if (!input.version.trim() || !input.reason.trim()) {
    throw new DomainError('FORECAST_UNNAMED', 'A forecast carries a version and says what moved since the last one.');
  }
  if (Number.isNaN(Date.parse(input.forecastCompletionDate))) {
    throw new DomainError('FORECAST_UNDATED', 'A forecast states the date it forecasts.');
  }

  const baselines = approvedBaselines(ctx);
  if (baselines.length === 0) {
    throw new DomainError(
      'NO_BASELINE',
      'There is no approved baseline on this project, so a forecast has nothing to be a forecast against. Approve the ' +
        'baseline first — the whole value of a forecast is the variance.',
      409,
    );
  }

  const validation = validateProgrammeLogic(ctx);
  const baseline = baselines[baselines.length - 1]!;
  const baselineDuration = Number(baseline.state.durationDays ?? 0);

  const forecastId = ulid();

  write(ctx, {
    eventType: 'PROGRAMME_FORECAST_APPROVED',
    entity: { refType: 'ProgrammeForecast', refId: forecastId },
    nextState: {
      id: forecastId,
      projectId: ctx.projectId,
      version: input.version.trim(),
      reason: input.reason,
      forecastCompletionDate: input.forecastCompletionDate,
      durationDays: validation.projectDurationDays,
      // Against the baseline it was taken from, named, so a later reader is not
      // comparing it against a baseline that did not exist at the time.
      againstBaselineId: String(baseline.state.id ?? baseline.refId),
      againstBaselineVersion: String(baseline.state.version ?? ''),
      varianceDays: validation.projectDurationDays - baselineDuration,
      criticalPathTaskIds: validation.criticalPath.map((entry) => entry.taskId),
      logicHash: validation.logicHash,
      approvedAt: new Date().toISOString(),
      approvedBy: ctx.auth.actorId,
    },
  });

  return {
    forecastId,
    durationDays: validation.projectDurationDays,
    varianceDays: validation.projectDurationDays - baselineDuration,
    logicHash: validation.logicHash,
  };
}

/**
 * Whether a second baseline may be approved, and why not.
 *
 * The first exception control. Called by `planning.approveBaseline` so the
 * refusal sits on the act rather than on a screen — a rule enforced only where
 * somebody clicks is a rule the API does not have.
 */
export function baselineChangeBlockedReason(ctx: EngineContext, changeRequestRef?: string): string | null {
  const baselines = approvedBaselines(ctx);
  if (baselines.length === 0) return null;
  if (changeRequestRef?.trim()) return null;

  const current = baselines[baselines.length - 1]!;
  return (
    `${String(current.state.version)} is already the approved baseline. Re-baselining is a change to the contract programme, ` +
    'so it goes through a change request and its approval rather than through this command — a baseline replaced quietly is ' +
    'a delay that measures itself against its own new position and always reports zero. Record the forecast instead, which ' +
    'is what a movement in the programme normally is.'
  );
}

// --- Step 5: freeze the week, then update status daily ----------------------

export function freezeWeeklyPlan(
  ctx: EngineContext,
  lookaheadId: string,
  input: { weekEnding: string; note: string },
): { lookaheadId: string; committed: number; frozenAt: string } {
  authorise(ctx, 'LOOKAHEAD_CONSTRAINTS', 'U', { lifecyclePhase: currentPhase(ctx) });

  const record = ctx.ledger.get({ refType: 'LookaheadPlan', refId: lookaheadId });
  if (!record) throw new DomainError('LOOKAHEAD_NOT_FOUND', `No lookahead plan ${lookaheadId}`, 404);

  if (record.state.frozenAt) {
    throw new DomainError(
      'WEEK_ALREADY_FROZEN',
      `This week was frozen on ${String(record.state.frozenAt).slice(0, 10)}. A frozen week that can be reopened is a week ` +
        'whose promises are edited to match what happened, and PPC over an edited plan measures nothing.',
      409,
    );
  }
  if (record.state.status === 'REVIEWED') {
    throw new DomainError('LOOKAHEAD_ALREADY_REVIEWED', 'This week has been reviewed. Freezing it now would be after the fact.');
  }
  if (!input.note.trim()) {
    throw new DomainError('FREEZE_UNEXPLAINED', 'Say what the week was frozen on — the plan is a commitment by the whole team.');
  }
  if (Number.isNaN(Date.parse(input.weekEnding))) {
    throw new DomainError('WEEK_ENDING_REQUIRED', 'A frozen week ends on a date.');
  }

  const commitments = (record.state.commitments as unknown[]) ?? [];
  const frozenAt = new Date().toISOString();

  write(ctx, {
    eventType: 'WEEKLY_PLAN_FROZEN',
    entity: { refType: 'LookaheadPlan', refId: lookaheadId },
    nextState: {
      ...record.state,
      status: 'FROZEN',
      weekEnding: input.weekEnding.slice(0, 10),
      freezeNote: input.note,
      frozenAt,
      frozenBy: ctx.auth.actorId,
    },
  });

  return { lookaheadId, committed: commitments.length, frozenAt };
}

export const TASK_STATUS = ['NOT_STARTED', 'IN_PROGRESS', 'BLOCKED', 'COMPLETE'] as const;
export type TaskStatus = (typeof TASK_STATUS)[number];

/** What a blocked task has to say. AC-CN-WF-02-02, in full. */
export type BlockedDetail = {
  reason: string;
  owner: string;
  impact: string;
  nextAction: string;
};

/**
 * The decision the second exception control asks to be recorded.
 *
 * Not a project setting. The two produce different completion dates from the
 * same facts, and which is right depends on the activity — whether the
 * remaining work genuinely still depends on the predecessor, or whether the
 * sequence has simply changed. Configured once, it is a decision nobody took;
 * recorded per activity, it is one somebody can be asked about.
 */
export const SEQUENCE_DECISION = ['RETAINED_LOGIC', 'PROGRESS_OVERRIDE'] as const;
export type SequenceDecision = (typeof SEQUENCE_DECISION)[number];

export function updateTaskStatus(
  ctx: EngineContext,
  input: {
    taskId: string;
    status: TaskStatus;
    note?: string;
    /** Required where the status is BLOCKED. */
    blocked?: BlockedDetail;
    /** Required where the status is COMPLETE. */
    verification?: { description: string; hash: string };
    /** Required where the work is out of sequence. */
    sequence?: { decision: SequenceDecision; rationale: string };
  },
): { taskId: string; status: TaskStatus; outOfSequence: boolean } {
  authorise(ctx, 'FIELD_EXECUTION', 'C', { lifecyclePhase: currentPhase(ctx) });

  const task = ctx.ledger.require({ refType: 'Task', refId: input.taskId });

  if (input.status === 'BLOCKED') {
    const blocked = input.blocked;
    if (!blocked) {
      throw new DomainError(
        'BLOCKED_DETAIL_REQUIRED',
        'A task marked blocked names the reason, who has to clear it, what it costs and what happens next. "Blocked" on a ' +
          'status board with none of those is a way of not saying who has to do what.',
      );
    }
    const missing = (['reason', 'owner', 'impact', 'nextAction'] as const).filter((field) => !blocked[field].trim());
    if (missing.length > 0) {
      throw new DomainError(
        'BLOCKED_DETAIL_REQUIRED',
        `The block on "${String(task.state.name)}" has no ${missing.join(', no ')}. All four, or it is a colour on a chart.`,
      );
    }
  }

  // The third exception control. A task complete with nothing behind it is the
  // one the inspection finds three weeks later, when it is buried.
  if (input.status === 'COMPLETE') {
    if (!input.verification?.description.trim() || !input.verification.hash.trim()) {
      throw new DomainError(
        'VERIFICATION_REQUIRED',
        `"${String(task.state.name)}" cannot be marked complete without the evidence that verifies it. A complete with ` +
          'nothing behind it is the one somebody finds three weeks later, buried.',
        409,
      );
    }
  }

  // Out of sequence: does this activity have an unstarted predecessor?
  const { tasks, dependencies } = network(ctx);
  const byId = new Map(tasks.map((entry) => [entry.id, entry]));
  const unstartedPredecessors = dependencies
    .filter((edge) => edge.successorId === input.taskId)
    .map((edge) => byId.get(edge.predecessorId))
    .filter((predecessor): predecessor is TaskRow => predecessor !== undefined && !predecessor.started);

  const working = input.status === 'IN_PROGRESS' || input.status === 'COMPLETE';
  const outOfSequence = working && unstartedPredecessors.length > 0;

  if (outOfSequence) {
    if (!input.sequence || !input.sequence.rationale.trim()) {
      throw new DomainError(
        'SEQUENCE_DECISION_REQUIRED',
        `"${String(task.state.name)}" is being worked while ${unstartedPredecessors.map((entry) => `"${entry.name}"`).join(', ')} ` +
          `${unstartedPredecessors.length === 1 ? 'has' : 'have'} not started. Retained logic and progress override give ` +
          'different completion dates from these same facts, so say which was chosen and why. A setting configured once at ' +
          'the start of a project is a decision nobody took.',
        409,
      );
    }
  }

  const evidenceRefs = input.verification
    ? [
        registerEvidence(ctx, {
          type: 'TASK_VERIFICATION',
          hash: input.verification.hash,
          description: input.verification.description,
          linkedEntities: [{ refType: 'Task', refId: input.taskId }],
        }),
      ]
    : [];

  write(ctx, {
    eventType: 'PROGRESS_STATUS_UPDATED',
    entity: { refType: 'Task', refId: input.taskId },
    nextState: {
      ...task.state,
      status: input.status,
      // 100 on complete, and never moved backwards by a status change: a status
      // is a statement about the state of the work, and progress has its own
      // command with its own regression rule.
      percentComplete: input.status === 'COMPLETE' ? 100 : Number(task.state.percentComplete ?? 0),
      ...(input.status === 'BLOCKED' ? { blocked: { ...input.blocked, at: new Date().toISOString(), by: ctx.auth.actorId } } : { blocked: undefined }),
      ...(input.sequence
        ? { sequenceDecision: { ...input.sequence, at: new Date().toISOString(), by: ctx.auth.actorId } }
        : {}),
      ...(input.note ? { statusNote: input.note } : {}),
      statusUpdatedAt: new Date().toISOString(),
      statusUpdatedBy: ctx.auth.actorId,
    },
    ...(evidenceRefs.length > 0 ? { evidenceRefs } : {}),
  });

  return { taskId: input.taskId, status: input.status, outOfSequence };
}

// --- The position -----------------------------------------------------------

export type ProgrammeControlPosition = {
  baseline: { version: string; durationDays: number; approvedAt: string } | null;
  forecast: { version: string; durationDays: number; varianceDays: number; approvedAt: string } | null;
  /** Whether the stored logic still hashes to what the forecast ran over. */
  forecastCurrent: boolean;
  logic: { findings: number; blocking: LogicFindingKind[]; logicHash: string; summary: string };
  blocked: Array<{ taskId: string; name: string; reason: string; owner: string; impact: string; nextAction: string }>;
  outOfSequence: Array<{ taskId: string; name: string; decision?: string; rationale?: string }>;
  frozenWeeks: Array<{ lookaheadId: string; weekStarting: string; weekEnding: string; committed: number }>;
  summary: string;
};

export function programmeControlPosition(ctx: EngineContext): ProgrammeControlPosition {
  authorise(ctx, 'PROGRAMME_BASELINES', 'R');

  const validation = validateProgrammeLogic(ctx);

  const baselines = approvedBaselines(ctx);
  const latestBaseline = baselines[baselines.length - 1];
  const forecasts = ctx.ledger.list(ctx.projectId, 'ProgrammeForecast');
  const latestForecast = forecasts[forecasts.length - 1];

  const blocked: ProgrammeControlPosition['blocked'] = [];
  const outOfSequence: ProgrammeControlPosition['outOfSequence'] = [];

  for (const record of ctx.ledger.list(ctx.projectId, 'Task')) {
    const state = record.state as Record<string, unknown>;
    const block = state.blocked as BlockedDetail | undefined;
    if (state.status === 'BLOCKED' && block) {
      blocked.push({
        taskId: record.refId,
        name: String(state.name),
        reason: block.reason,
        owner: block.owner,
        impact: block.impact,
        nextAction: block.nextAction,
      });
    }
    const sequence = state.sequenceDecision as { decision: string; rationale: string } | undefined;
    if (sequence) {
      outOfSequence.push({
        taskId: record.refId,
        name: String(state.name),
        decision: sequence.decision,
        rationale: sequence.rationale,
      });
    }
  }

  const frozenWeeks = ctx.ledger
    .list(ctx.projectId, 'LookaheadPlan')
    .filter((record) => record.state.frozenAt !== undefined)
    .map((record) => ({
      lookaheadId: record.refId,
      weekStarting: String(record.state.weekStarting),
      weekEnding: String(record.state.weekEnding ?? ''),
      committed: ((record.state.commitments as unknown[]) ?? []).length,
    }));

  const forecastCurrent =
    latestForecast === undefined || String(latestForecast.state.logicHash) === validation.logicHash;

  const parts: string[] = [];
  parts.push(latestBaseline ? `baseline ${String(latestBaseline.state.version)}` : 'no baseline');
  if (latestForecast) {
    const variance = Number(latestForecast.state.varianceDays ?? 0);
    parts.push(
      `forecast ${String(latestForecast.state.version)} ${variance === 0 ? 'level with it' : `${Math.abs(variance)} days ${variance > 0 ? 'behind' : 'ahead'}`}`,
    );
  }
  if (!forecastCurrent) parts.push('the programme has moved since the forecast was taken');
  if (validation.blocking.length > 0) parts.push(`${validation.blocking.length} blocking logic fault(s)`);
  if (blocked.length > 0) parts.push(`${blocked.length} task(s) blocked`);

  return {
    baseline: latestBaseline
      ? {
          version: String(latestBaseline.state.version),
          durationDays: Number(latestBaseline.state.durationDays ?? 0),
          approvedAt: String(latestBaseline.state.approvedAt),
        }
      : null,
    forecast: latestForecast
      ? {
          version: String(latestForecast.state.version),
          durationDays: Number(latestForecast.state.durationDays ?? 0),
          varianceDays: Number(latestForecast.state.varianceDays ?? 0),
          approvedAt: String(latestForecast.state.approvedAt),
        }
      : null,
    forecastCurrent,
    logic: {
      findings: validation.findings.length,
      blocking: validation.blocking,
      logicHash: validation.logicHash,
      summary: validation.summary,
    },
    blocked,
    outOfSequence,
    frozenWeeks,
    summary: parts.join(', ') + '.',
  };
}
