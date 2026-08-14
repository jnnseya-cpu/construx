import { hashEvidence } from '../core/canonical.ts';
import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, registerEvidence, runAI, write, type EngineContext } from './context.ts';
import {
  calculateCPM,
  completionProbability,
  durationAtConfidence,
  pert,
  type Activity,
  type Dependency,
} from './maths/cpm.ts';
import { forecastDelayRisk, type DelayDriver } from './maths/risk.ts';

/**
 * Engine B — Planning & Delivery.
 *
 * The programme is recalculated from the network every time, never edited as a
 * set of dates. That is what makes "what changed and why" answerable: the dates
 * are an output, and the inputs that produced them are all in the ledger.
 */

export type TaskInput = {
  id?: string;
  activityCode: string;
  name: string;
  workPackageId: string;
  durationDays: number;
  costCode?: string;
  locationZone?: string;
  /** Three-point durations enable a probabilistic completion date. */
  optimisticDays?: number;
  pessimisticDays?: number;
};

export function createTasks(ctx: EngineContext, tasks: TaskInput[]): string[] {
  authorise(ctx, 'WORKPACKAGES_TASKS', 'C', { lifecyclePhase: currentPhase(ctx) });

  return tasks.map((task) => {
    const id = task.id ?? ulid();
    write(ctx, {
      eventType: 'TASK_CREATED',
      entity: { refType: 'Task', refId: id },
      nextState: {
        id,
        activityCode: task.activityCode,
        name: task.name,
        workPackageId: task.workPackageId,
        durationDays: task.durationDays,
        optimisticDays: task.optimisticDays ?? Math.max(1, Math.round(task.durationDays * 0.8)),
        pessimisticDays: task.pessimisticDays ?? Math.round(task.durationDays * 1.5),
        costCode: task.costCode,
        locationZone: task.locationZone,
        percentComplete: 0,
        status: 'NOT_STARTED',
      },
    });
    return id;
  });
}

export function linkTasks(ctx: EngineContext, dependencies: Dependency[]): string[] {
  authorise(ctx, 'WORKPACKAGES_TASKS', 'C', { lifecyclePhase: currentPhase(ctx) });

  return dependencies.map((dep) => {
    const id = ulid();
    write(ctx, {
      eventType: 'DEPENDENCY_CREATED',
      entity: { refType: 'Dependency', refId: id },
      nextState: { id, ...dep },
    });
    return id;
  });
}

function loadNetwork(ctx: EngineContext): { activities: Activity[]; dependencies: Dependency[] } {
  const activities = ctx.ledger.list(ctx.projectId, 'Task').map((record) => ({
    id: record.refId,
    name: String(record.state.name),
    duration: Number(record.state.durationDays),
  }));

  const dependencies = ctx.ledger.list(ctx.projectId, 'Dependency').map((record) => ({
    predecessorId: String(record.state.predecessorId),
    successorId: String(record.state.successorId),
    type: record.state.type as Dependency['type'],
    lag: Number(record.state.lag ?? 0),
  }));

  return { activities, dependencies };
}

export type ProgrammeCalculation = {
  projectDurationDays: number;
  criticalPath: Array<{ taskId: string; name: string; earlyStart: number; earlyFinish: number; totalFloat: number }>;
  /** Probability of hitting the contractual date, from aggregated PERT variance. */
  probabilityOnTime?: number;
  p80DurationDays: number;
  nearCritical: Array<{ taskId: string; name: string; totalFloat: number }>;
  cycles: string[][];
};

/**
 * Recalculate the programme from the network. Reports near-critical activities
 * too: the path that is about to become critical is more useful than the one
 * that already is.
 */
export function recalculateProgramme(
  ctx: EngineContext,
  options: { contractualDurationDays?: number } = {},
): ProgrammeCalculation {
  authorise(ctx, 'PROGRAMME_BASELINES', 'R');

  const { activities, dependencies } = loadNetwork(ctx);
  if (activities.length === 0) throw new DomainError('PROGRAMME_EMPTY', 'No activities exist to schedule');

  const cpm = calculateCPM(activities, dependencies);
  if (cpm.cycles.length > 0) {
    throw new DomainError('PROGRAMME_CYCLIC', `Dependency cycle detected involving: ${cpm.cycles[0]?.join(', ')}`);
  }

  const taskRecords = new Map(ctx.ledger.list(ctx.projectId, 'Task').map((r) => [r.refId, r.state]));

  // Variance is summed along the critical path only — that is the path that
  // determines the completion date.
  const varianceSum = cpm.criticalPath.reduce((sum, taskId) => {
    const state = taskRecords.get(taskId);
    if (!state) return sum;
    const { variance } = pert(
      Number(state.optimisticDays ?? state.durationDays),
      Number(state.durationDays),
      Number(state.pessimisticDays ?? state.durationDays),
    );
    return sum + variance;
  }, 0);

  const calculation: ProgrammeCalculation = {
    projectDurationDays: cpm.projectDuration,
    criticalPath: cpm.activities
      .filter((a) => a.critical)
      .sort((a, b) => a.earlyStart - b.earlyStart)
      .map((a) => ({ taskId: a.id, name: a.name, earlyStart: a.earlyStart, earlyFinish: a.earlyFinish, totalFloat: a.totalFloat })),
    p80DurationDays: durationAtConfidence(cpm.projectDuration, varianceSum, 0.8),
    nearCritical: cpm.activities
      .filter((a) => !a.critical && a.totalFloat <= 5)
      .sort((a, b) => a.totalFloat - b.totalFloat)
      .map((a) => ({ taskId: a.id, name: a.name, totalFloat: a.totalFloat })),
    cycles: cpm.cycles,
  };

  if (options.contractualDurationDays !== undefined) {
    calculation.probabilityOnTime = completionProbability(cpm.projectDuration, varianceSum, options.contractualDurationDays);
  }

  write(ctx, {
    eventType: 'PROGRAMME_RECALCULATED',
    entity: { refType: 'ProgrammeBaseline', refId: `${ctx.projectId}-live` },
    nextState: {
      id: `${ctx.projectId}-live`,
      projectId: ctx.projectId,
      type: 'LIVE',
      status: 'LIVE',
      calculatedAt: new Date().toISOString(),
      projectDurationDays: calculation.projectDurationDays,
      p80DurationDays: calculation.p80DurationDays,
      probabilityOnTime: calculation.probabilityOnTime,
      criticalPathTaskIds: calculation.criticalPath.map((c) => c.taskId),
      activityCount: activities.length,
    },
  });

  return calculation;
}

/** Freeze a baseline. Everything afterwards is measured against this. */
export function approveBaseline(
  ctx: EngineContext,
  input: { version: string; reason: string; contractualCompletionDate: string },
): { baselineId: string; durationDays: number } {
  authorise(ctx, 'PROGRAMME_BASELINES', 'A', { lifecyclePhase: currentPhase(ctx) });

  const { activities, dependencies } = loadNetwork(ctx);
  const cpm = calculateCPM(activities, dependencies);

  const baselineId = ulid();
  const snapshot = {
    activities: cpm.activities.map((a) => ({
      taskId: a.id,
      name: a.name,
      duration: a.duration,
      earlyStart: a.earlyStart,
      earlyFinish: a.earlyFinish,
      totalFloat: a.totalFloat,
      critical: a.critical,
    })),
    dependencies,
  };

  const evidence = registerEvidence(ctx, {
    type: 'PROGRAMME_BASELINE_SNAPSHOT',
    hash: hashEvidence(JSON.stringify(snapshot)),
    description: `Baseline ${input.version}: ${input.reason}`,
  });

  write(ctx, {
    eventType: 'PROGRAMME_BASELINE_APPROVED',
    entity: { refType: 'ProgrammeBaseline', refId: baselineId },
    nextState: {
      id: baselineId,
      projectId: ctx.projectId,
      version: input.version,
      type: 'BASELINE',
      status: 'APPROVED',
      reason: input.reason,
      contractualCompletionDate: input.contractualCompletionDate,
      durationDays: cpm.projectDuration,
      criticalPathTaskIds: cpm.criticalPath,
      snapshot,
      approvedAt: new Date().toISOString(),
      approvedBy: ctx.auth.actorId,
    },
    evidenceRefs: [evidence],
  });

  return { baselineId, durationDays: cpm.projectDuration };
}

/**
 * AI-generated work breakdown structure. The engine proposes; a planner
 * approves. Nothing enters the programme without a human decision.
 */
export async function generateWBS(
  ctx: EngineContext,
  input: { projectType: string; sectorType: string; scopeNarrative: string; targetDurationDays: number },
): Promise<{ workPackageIds: string[]; acuConsumed: number }> {
  authorise(ctx, 'WORKPACKAGES_TASKS', 'C', { lifecyclePhase: currentPhase(ctx) });

  const workPackageIds: string[] = [];

  // Standard construction sequences by sector. The model tailors and weights
  // these; it does not invent a structure from nothing, which is what makes the
  // output reviewable by a planner.
  const templates: Record<string, string[]> = {
    BUILDING: [
      'Enabling works and site setup',
      'Substructure',
      'Superstructure frame',
      'Building envelope',
      'Internal walls and partitions',
      'Mechanical, electrical and public health',
      'Internal finishes',
      'External works and landscaping',
      'Testing and commissioning',
    ],
    INFRASTRUCTURE: [
      'Site establishment and diversions',
      'Earthworks and ground treatment',
      'Drainage and utilities',
      'Structures',
      'Pavement or trackform',
      'Systems and control',
      'Reinstatement and landscaping',
      'Testing, commissioning and handover',
    ],
    SPECIALISED: [
      'Survey and pre-construction',
      'Demolition or strip-out',
      'Specialist installation',
      'Integration and interface works',
      'Testing and certification',
    ],
  };

  const template = templates[input.sectorType] ?? templates.BUILDING ?? [];

  const result = await runAI(ctx, {
    engine: 'PLANNING',
    taskType: 'wbs_generation',
    capability: 'REASONING',
    inputRefs: [{ refType: 'Project', refId: ctx.projectId }],
    request: {
      task: 'Weight a standard work breakdown structure to this project and apportion duration',
      payload: {
        projectType: input.projectType,
        sectorType: input.sectorType,
        scopeNarrative: input.scopeNarrative,
        targetDurationDays: input.targetDurationDays,
        candidateStructure: template,
      },
    },
    toWrites: (output) => {
      const weighting = Number(output.judgement ?? 0.5);
      return template.map((title, index) => {
        const workPackageId = ulid();
        workPackageIds.push(workPackageId);

        // Front and back of a build carry less duration than the middle; the
        // model's weighting nudges the distribution rather than defining it.
        const position = template.length === 1 ? 0.5 : index / (template.length - 1);
        const shape = 0.6 + 0.8 * Math.sin(Math.PI * position);
        const share = shape / template.reduce((s, _, i) => s + (0.6 + 0.8 * Math.sin((Math.PI * i) / Math.max(1, template.length - 1))), 0);

        return {
          eventType: 'WBS_GENERATED',
          entity: { refType: 'WorkPackage', refId: workPackageId },
          nextState: {
            id: workPackageId,
            projectId: ctx.projectId,
            wbsCode: `${(index + 1) * 100}`,
            title,
            sequence: index + 1,
            indicativeDurationDays: Math.max(1, Math.round(input.targetDurationDays * share * (0.9 + weighting * 0.2))),
            status: 'PROPOSED',
            origin: 'AI_GENERATED',
            requiresPlannerApproval: true,
          },
        };
      });
    },
  });

  return { workPackageIds, acuConsumed: result.acuConsumed };
}

/**
 * Delay risk forecast with corrective measures. Predictive, not forensic — the
 * point is to act before the delay materialises.
 */
export async function forecastDelay(
  ctx: EngineContext,
  input: { dailyPreliminariesMinor: number; contractualDurationDays: number },
): Promise<{ snapshotId: string; snapshot: ReturnType<typeof forecastDelayRisk>; acuConsumed: number }> {
  authorise(ctx, 'PROGRAMME_BASELINES', 'X', { lifecyclePhase: currentPhase(ctx) });

  const { activities, dependencies } = loadNetwork(ctx);
  const cpm = calculateCPM(activities, dependencies);
  const floatByTask = new Map(cpm.activities.map((a) => [a.id, a.totalFloat]));
  const criticalSet = new Set(cpm.criticalPath);

  const constraints = ctx.ledger.list(ctx.projectId, 'Constraint');
  const openConstraintsByTask = new Map<string, number>();
  for (const constraint of constraints) {
    if (constraint.state.status === 'CLOSED') continue;
    const taskId = String(constraint.state.taskId);
    openConstraintsByTask.set(taskId, (openConstraintsByTask.get(taskId) ?? 0) + 1);
  }

  const drivers: DelayDriver[] = ctx.ledger.list(ctx.projectId, 'Task').map((record) => {
    const planned = Number(record.state.durationDays);
    const percentComplete = Number(record.state.percentComplete ?? 0);
    const elapsed = Number(record.state.elapsedDays ?? 0);
    // Productivity: earned days over elapsed days. Below 1.0 means slipping.
    const productivityFactor = elapsed > 0 ? Math.max(0.1, (planned * (percentComplete / 100)) / elapsed) : 1;

    return {
      taskId: record.refId,
      taskName: String(record.state.name),
      slippageDays: Number(record.state.slippageDays ?? 0),
      totalFloat: floatByTask.get(record.refId) ?? 0,
      openConstraints: openConstraintsByTask.get(record.refId) ?? 0,
      productivityFactor,
      onCriticalPath: criticalSet.has(record.refId),
    };
  });

  const measured = drivers.filter((d) => d.slippageDays !== 0 || d.productivityFactor !== 1).length;
  const dataCompleteness = drivers.length === 0 ? 0 : Math.max(0.2, measured / drivers.length);

  const snapshot = forecastDelayRisk(
    ctx.projectId,
    drivers,
    Math.max(0, input.contractualDurationDays - cpm.projectDuration),
    input.dailyPreliminariesMinor,
    dataCompleteness,
  );

  const snapshotId = ulid();

  const result = await runAI(ctx, {
    engine: 'PLANNING',
    taskType: 'delay_risk_forecast',
    capability: 'REASONING',
    inputRefs: drivers.slice(0, 20).map((d) => ({ refType: 'Task', refId: d.taskId })),
    request: {
      task: 'Explain the delay drivers and rank the corrective measures for this project context',
      payload: { snapshot, contractualDurationDays: input.contractualDurationDays },
    },
    toWrites: (output) => [
      {
        eventType: 'DELAY_RISK_FORECAST',
        entity: { refType: 'DelayRiskSnapshot', refId: snapshotId },
        nextState: {
          ...snapshot,
          id: snapshotId,
          projectId: ctx.projectId,
          currentProgrammeDurationDays: cpm.projectDuration,
          contractualDurationDays: input.contractualDurationDays,
          narrative: String(output.narrative ?? ''),
        },
      },
    ],
  });

  return { snapshotId, snapshot, acuConsumed: result.acuConsumed };
}

/** Record progress against a task. Progress without evidence is not progress. */
export function recordProgress(
  ctx: EngineContext,
  input: {
    taskId: string;
    percentComplete: number;
    elapsedDays: number;
    quantityComplete?: number;
    evidenceDescription: string;
    evidenceHash: string;
  },
): void {
  authorise(ctx, 'FIELD_EXECUTION', 'C', { lifecyclePhase: currentPhase(ctx) });

  const task = ctx.ledger.require({ refType: 'Task', refId: input.taskId });
  if (input.percentComplete < Number(task.state.percentComplete ?? 0)) {
    throw new DomainError('PROGRESS_REGRESSION', 'Progress cannot go backwards without a formal correction');
  }

  const evidence = registerEvidence(ctx, {
    type: 'PROGRESS_EVIDENCE',
    hash: input.evidenceHash,
    description: input.evidenceDescription,
    linkedEntities: [{ refType: 'Task', refId: input.taskId }],
  });

  const measurementId = ulid();
  write(ctx, {
    eventType: 'PROGRESS_RECORDED',
    entity: { refType: 'ProgressMeasurement', refId: measurementId },
    nextState: {
      id: measurementId,
      taskId: input.taskId,
      method: input.quantityComplete !== undefined ? 'QUANTITY' : 'PERCENT',
      percentComplete: input.percentComplete,
      quantityComplete: input.quantityComplete,
      recordedAt: new Date().toISOString(),
      recordedBy: ctx.auth.actorId,
    },
    evidenceRefs: [evidence],
  });

  const plannedDuration = Number(task.state.durationDays);
  const earnedDays = plannedDuration * (input.percentComplete / 100);

  write(ctx, {
    eventType: 'TASK_UPDATED',
    entity: { refType: 'Task', refId: input.taskId },
    nextState: {
      ...task.state,
      percentComplete: input.percentComplete,
      elapsedDays: input.elapsedDays,
      // Slippage is elapsed time not converted into earned progress.
      slippageDays: Number(Math.max(0, input.elapsedDays - earnedDays).toFixed(2)),
      status: input.percentComplete >= 100 ? 'COMPLETE' : input.percentComplete > 0 ? 'IN_PROGRESS' : 'NOT_STARTED',
    },
  });
}

/**
 * What-if analysis. Runs the network against a hypothetical change without
 * writing anything — scenarios must never contaminate the live programme.
 */
export function whatIf(
  ctx: EngineContext,
  changes: Array<{ taskId: string; newDurationDays: number }>,
): { baselineDurationDays: number; scenarioDurationDays: number; deltaDays: number; newCriticalPath: string[] } {
  authorise(ctx, 'PROGRAMME_BASELINES', 'R');

  const { activities, dependencies } = loadNetwork(ctx);
  const baseline = calculateCPM(activities, dependencies);

  const changeMap = new Map(changes.map((c) => [c.taskId, c.newDurationDays]));
  const scenarioActivities = activities.map((a) => ({ ...a, duration: changeMap.get(a.id) ?? a.duration }));
  const scenario = calculateCPM(scenarioActivities, dependencies);

  return {
    baselineDurationDays: baseline.projectDuration,
    scenarioDurationDays: scenario.projectDuration,
    deltaDays: scenario.projectDuration - baseline.projectDuration,
    newCriticalPath: scenario.criticalPath,
  };
}
