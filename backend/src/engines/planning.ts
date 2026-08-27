import { hashEvidence } from '../core/canonical.ts';
import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { startBlockedReason } from '../domain/mobilisation.ts';
import { directProgressBlockedReason } from '../domain/progressverification.ts';
import { baselineChangeBlockedReason } from '../domain/programmecontrol.ts';
import { authorise, currentPhase, registerEvidence, runAI, write, type EngineContext } from './context.ts';
import { isBusinessDay } from './maths/constructionAct.ts';
import {
  calculateCPM,
  completionProbability,
  durationAtConfidence,
  pert,
  type Activity,
  type Dependency,
} from './maths/cpm.ts';
import { simulateCompletion, type ThreePointActivity } from './maths/montecarlo.ts';
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

/**
 * Create a work package by hand.
 *
 * Until now a work package could only appear as a by-product of AI-generated
 * WBS, which quietly made the model a prerequisite for having a scope
 * breakdown. Most projects arrive with one already — from the contract
 * documents, an employer's requirements, or the last job of the same shape —
 * and a planner should not have to run a generator to type it in.
 *
 * Manual packages are marked as such. Which of them a person defined and which
 * a model proposed is a question that gets asked at every baseline review, and
 * it cannot be answered later from a list that treats them the same.
 */
export function createWorkPackage(
  ctx: EngineContext,
  input: {
    wbsCode: string;
    title: string;
    /** Where this sits under an existing package. Absent means top level. */
    parentWorkPackageId?: string;
    indicativeDurationDays: number;
    scopeNarrative?: string;
    responsibleParty?: string;
  },
): { workPackageId: string; wbsCode: string; depth: number } {
  authorise(ctx, 'WORKPACKAGES_TASKS', 'C', { lifecyclePhase: currentPhase(ctx) });

  const existing = ctx.ledger.list(ctx.projectId, 'WorkPackage');
  const code = input.wbsCode.trim();

  if (code.length === 0) throw new DomainError('WBS_CODE_REQUIRED', 'A work package needs a WBS code to be referred to by');

  // The same defect as a duplicate activity code, one level up: two packages
  // sharing a code means every cost and every task rolled up under it lands in
  // an arbitrary one of them.
  const clash = existing.find((record) => String(record.state.wbsCode).toLowerCase() === code.toLowerCase());
  if (clash) {
    throw new DomainError('WBS_CODE_IN_USE', `WBS code ${code} is already used by "${String(clash.state.title)}"`);
  }

  let depth = 0;
  if (input.parentWorkPackageId) {
    // Walk up from the parent. A cycle cannot be created by a new leaf, but a
    // parent id pointing at a package on a broken chain would produce a
    // hierarchy that no roll-up can terminate on.
    let cursor = ctx.ledger.require({ refType: 'WorkPackage', refId: input.parentWorkPackageId });
    const seen = new Set<string>([input.parentWorkPackageId]);
    depth = 1;
    while (typeof cursor.state.parentWorkPackageId === 'string') {
      const next = String(cursor.state.parentWorkPackageId);
      if (seen.has(next)) {
        throw new DomainError('WBS_HIERARCHY_CYCLIC', 'The parent package sits on a cyclic chain and cannot be built on');
      }
      seen.add(next);
      cursor = ctx.ledger.require({ refType: 'WorkPackage', refId: next });
      depth += 1;
    }
  }

  const workPackageId = ulid();
  write(ctx, {
    eventType: 'WORKPACKAGE_CREATED',
    entity: { refType: 'WorkPackage', refId: workPackageId },
    nextState: {
      id: workPackageId,
      projectId: ctx.projectId,
      wbsCode: code,
      title: input.title,
      parentWorkPackageId: input.parentWorkPackageId,
      depth,
      sequence: existing.length + 1,
      indicativeDurationDays: Math.max(1, Math.round(input.indicativeDurationDays)),
      scopeNarrative: input.scopeNarrative,
      responsibleParty: input.responsibleParty,
      status: 'PROPOSED',
      origin: 'MANUAL',
      // A person with the permission defined it deliberately. The approval flag
      // exists because a generated package is a proposal; this is not one.
      requiresPlannerApproval: false,
    },
  });

  return { workPackageId, wbsCode: code, depth };
}

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

/**
 * Float and criticality per activity, from the live network.
 *
 * Exported because the design-delay exposure needs to know whether the activity
 * an RFI blocks is on the critical chain and how much slack it has of its own.
 * Recomputed rather than read off the last baseline snapshot: the baseline is
 * what was agreed, and the question "is this delaying the job today" is asked of
 * the network as it stands.
 */
export function networkFloat(ctx: EngineContext): {
  floatByTask: Map<string, number>;
  critical: Set<string>;
  activityNames: Map<string, string>;
  hasNetwork: boolean;
} {
  const { activities, dependencies } = loadNetwork(ctx);
  if (activities.length === 0) {
    return { floatByTask: new Map(), critical: new Set(), activityNames: new Map(), hasNetwork: false };
  }
  const cpm = calculateCPM(activities, dependencies);
  return {
    floatByTask: new Map(cpm.activities.map((a) => [a.id, a.totalFloat])),
    critical: new Set(cpm.criticalPath),
    activityNames: new Map(cpm.activities.map((a) => [a.id, a.name])),
    hasNetwork: true,
  };
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
  input: {
    version: string;
    reason: string;
    contractualCompletionDate: string;
    /**
     * CN-WF-02's first exception control: re-baselining is a change to the
     * contract programme, so a second baseline needs the change request that
     * authorised it. The first baseline needs nothing — there is no programme
     * to change.
     */
    changeRequestRef?: string;
  },
): { baselineId: string; durationDays: number } {
  authorise(ctx, 'PROGRAMME_BASELINES', 'A', { lifecyclePhase: currentPhase(ctx) });

  const blocked = baselineChangeBlockedReason(ctx, input.changeRequestRef);
  if (blocked) throw new DomainError('REBASELINE_UNAUTHORISED', blocked, 409);

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
      ...(input.changeRequestRef ? { changeRequestRef: input.changeRequestRef } : {}),
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

  // AC-CN-WF-01-02. A package assessed and found not ready cannot be worked on.
  // The rule is exactly the acceptance criterion and no wider: a package this
  // workflow has never seen is untouched, because refusing progress on every
  // project that does not run mobilisation would be inventing a requirement.
  if (typeof task.state.workPackageId === 'string') {
    const blocked = startBlockedReason(ctx, task.state.workPackageId);
    if (blocked) throw new DomainError('WORK_NOT_AUTHORISED', blocked, 409);
  }

  // CN-WF-04. Where an activity has a measurement basis it is under the
  // claim-and-certify workflow, and two doors to one money field is how the
  // valuation and the programme come to disagree with nothing saying which is
  // right. An activity with no basis is untouched.
  const measured = directProgressBlockedReason(ctx, input.taskId);
  if (measured) throw new DomainError('PROGRESS_REQUIRES_VERIFICATION', measured, 409);

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

// --- The daily site diary ------------------------------------------------------
//
// `SITE_DIARY_RECORDED` sat in the closed catalogue with nothing able to emit
// it. The project control standard asked every project for a diary, described
// it as "the contemporaneous record no delay claim survives without", and
// reported it missing — correctly, and permanently, because there was no
// command that could write one.
//
// This is the record that decides delay and disruption claims. A programme
// shows what was planned; the diary is the only evidence of what actually
// happened on a given day, and its value is almost entirely a function of when
// it was written.

/**
 * The diaries that stand, with corrected entries resolved out.
 *
 * Supersession is derived rather than stamped: a corrected entry names the one
 * it replaces, and anything named that way is no longer the record for its day.
 * The superseded entry stays readable in full, because somebody may have acted
 * on it and an append-only ledger never removes what was relied upon.
 */
export function currentDiaries(ctx: EngineContext): ReturnType<EngineContext['ledger']['list']> {
  const all = ctx.ledger.list(ctx.projectId, 'SiteDiary');
  const replaced = new Set(all.map((record) => record.state.supersedes).filter((id): id is string => typeof id === 'string'));
  // A draft is not the record for its day. CN-WF-03 lets a shift be captured
  // before it is submitted, and counting an unsubmitted draft as the day's
  // diary would close a gap in the evidence that is still open.
  return all.filter((record) => !replaced.has(record.refId) && record.state.status !== 'DRAFT');
}

export type DiaryLabour = { trade: string; headcount: number; hours: number; subcontractorId?: string };
export type DiaryPlant = { description: string; hoursWorked: number; hoursIdle: number; downtimeReason?: string };

export type DiaryWeather = {
  /** Free description — "heavy rain from 11:00", not a code. */
  conditions: string;
  temperatureC?: number;
  /** Whether weather actually stopped work, which is the fact a claim turns on. */
  workingStopped: boolean;
  hoursLost?: number;
};

/**
 * Record the day.
 *
 * Three rules, each of which exists because the record is evidence rather than
 * administration.
 *
 * **It cannot be dated in the future.** A diary is a record of what happened,
 * and one written in advance is a plan wearing a diary's clothes.
 *
 * **It states when it was written, and whether that was contemporaneous.** A
 * diary compiled three weeks later from memory carries a fraction of the weight
 * of one written on the day, and every experienced adjudicator asks. Recording
 * the gap and flagging it is honest; silently presenting a late entry as
 * contemporaneous evidence is not, and it is the kind of thing that loses an
 * otherwise good claim.
 *
 * **Weather is required, including the fact that it was fine.** Weather is the
 * most common ground for an extension of time, and a diary with weather only on
 * the bad days is a diary that proves nothing about the good ones.
 */
/**
 * The diary's evidential rules, in one place.
 *
 * `recordSiteDiary` is the one-shot desk entry; `domain/dailylog.ts` submits
 * one captured on a device over a shift. Both have to apply the same rules, and
 * two copies of "a diary cannot be dated ahead" would eventually be one copy
 * and one omission.
 */
export type DiaryContentCheck = {
  diaryDate: string;
  daysLate: number;
  /** Written the same day or the next working morning. */
  contemporaneous: boolean;
  labourHours: number;
  plantIdleHours: number;
  /**
   * Totals that are improbable rather than impossible — reported so a person
   * confirms them, never refused. Refusing the merely unlikely teaches people
   * to enter numbers the form will accept instead of the ones they measured.
   */
  anomalies: string[];
};

export function checkDiaryContent(
  input: { diaryDate: string; weather: DiaryWeather; labour: DiaryLabour[]; plant: DiaryPlant[] },
  now = new Date(),
): DiaryContentCheck {
  const diaryDate = input.diaryDate.slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  if (diaryDate > today) {
    throw new DomainError('DIARY_DATE_IN_FUTURE', 'A site diary records a day that has happened; it cannot be dated ahead');
  }
  if (!input.weather.conditions.trim()) {
    throw new DomainError(
      'DIARY_WEATHER_REQUIRED',
      'Record the weather even when it was fine. A diary with weather only on the bad days proves nothing about the good ones.',
    );
  }

  const anomalies: string[] = [];
  for (const line of input.labour) {
    if (line.headcount < 0 || line.hours < 0) {
      throw new DomainError('DIARY_TOTALS_IMPOSSIBLE', `${line.trade}: a negative headcount or hours cannot be recorded.`);
    }
    if (line.hours > 24) {
      throw new DomainError('DIARY_TOTALS_IMPOSSIBLE', `${line.trade}: ${line.hours} hours in one day is not a shift.`);
    }
    if (line.hours > 0 && line.headcount === 0) {
      anomalies.push(`${line.trade} records ${line.hours} hours against nobody`);
    }
    if (line.hours > 12) anomalies.push(`${line.trade} worked ${line.hours} hours, which is a long shift to confirm`);
  }
  for (const line of input.plant) {
    if (line.hoursWorked < 0 || line.hoursIdle < 0) {
      throw new DomainError('DIARY_TOTALS_IMPOSSIBLE', `${line.description}: negative plant hours cannot be recorded.`);
    }
    if (line.hoursWorked + line.hoursIdle > 24) {
      throw new DomainError(
        'DIARY_TOTALS_IMPOSSIBLE',
        `${line.description}: ${line.hoursWorked + line.hoursIdle} hours worked and idle is more than the day is long.`,
      );
    }
    if (line.hoursIdle > line.hoursWorked && line.hoursIdle > 0 && !line.downtimeReason?.trim()) {
      anomalies.push(`${line.description} was idle longer than it worked with no downtime reason`);
    }
  }

  const daysLate = Math.round((Date.parse(today) - Date.parse(diaryDate)) / 86_400_000);

  return {
    diaryDate,
    daysLate,
    contemporaneous: daysLate <= 1,
    labourHours: Number(input.labour.reduce((sum, line) => sum + line.headcount * line.hours, 0).toFixed(2)),
    plantIdleHours: Number(input.plant.reduce((sum, line) => sum + line.hoursIdle, 0).toFixed(2)),
    anomalies,
  };
}

export function recordSiteDiary(
  ctx: EngineContext,
  input: {
    diaryDate: string;
    weather: DiaryWeather;
    labour: DiaryLabour[];
    plant: DiaryPlant[];
    /** Work done, against tasks where the diarist can name them. */
    progressNarrative: string;
    workedTaskIds?: string[];
    deliveries?: string[];
    /** Anything that stopped or slowed work. These become delay evidence. */
    blockers?: string[];
    visitors?: string[];
    safetyEvents?: string[];
    evidenceHash: string;
    /** Naming an earlier entry for the same date makes this an amendment. */
    supersedes?: string;
    supersessionReason?: string;
  },
  now = new Date(),
): { diaryId: string; contemporaneous: boolean; daysLate: number; labourHours: number } {
  authorise(ctx, 'FIELD_EXECUTION', 'C', { lifecyclePhase: currentPhase(ctx) });

  const check = checkDiaryContent(input, now);
  const diaryDate = check.diaryDate;

  const existing = currentDiaries(ctx).filter((record) => String(record.state.diaryDate) === diaryDate);

  if (existing.length > 0) {
    // Append-only means a correction is a new record that says what it replaces
    // and why — never a silent second entry for the same day, which is how two
    // versions of a day end up in front of an adjudicator.
    if (!input.supersedes || !input.supersessionReason) {
      throw new DomainError(
        'DIARY_ALREADY_RECORDED',
        `A diary already exists for ${diaryDate}. An amendment must name the entry it supersedes and the reason.`,
      );
    }
    if (!existing.some((record) => record.refId === input.supersedes)) {
      throw new DomainError('DIARY_SUPERSEDES_UNKNOWN', 'The entry being superseded is not the current diary for that date');
    }
  }

  // Written the same day or the next working morning is contemporaneous. Beyond
  // that it is a reconstruction, and it is labelled as one.
  const { daysLate, contemporaneous, labourHours, plantIdleHours } = check;

  const evidence = registerEvidence(ctx, {
    type: 'SITE_DIARY_RECORD',
    hash: input.evidenceHash,
    description: `Site diary for ${diaryDate}`,
  });

  const diaryId = ulid();
  write(ctx, {
    eventType: 'SITE_DIARY_RECORDED',
    entity: { refType: 'SiteDiary', refId: diaryId },
    nextState: {
      id: diaryId,
      projectId: ctx.projectId,
      diaryDate,
      weather: input.weather,
      labour: input.labour,
      plant: input.plant,
      labourHours,
      plantIdleHours,
      anomalies: check.anomalies,
      progressNarrative: input.progressNarrative,
      workedTaskIds: input.workedTaskIds ?? [],
      deliveries: input.deliveries ?? [],
      blockers: input.blockers ?? [],
      visitors: input.visitors ?? [],
      safetyEvents: input.safetyEvents ?? [],
      recordedAt: now.toISOString(),
      recordedBy: ctx.auth.actorId,
      daysLate,
      contemporaneous,
      supersedes: input.supersedes,
      supersessionReason: input.supersessionReason,
      status: 'RECORDED',
    },
    evidenceRefs: [evidence],
  });

  // Nothing is written back to the superseded entry. `SITE_DIARY_RECORDED`
  // creates rather than updates, and more to the point the original record is
  // evidence: the fact that it was replaced belongs on the replacement, which is
  // what a corrected record looks like on paper too. Readers resolve it.
  return { diaryId, contemporaneous, daysLate, labourHours };
}

/**
 * The diary as evidence rather than as a list of days.
 *
 * A delay claim stands on an unbroken contemporaneous record. This reports the
 * two things that decide whether it is one: the days with no entry at all, and
 * the entries written long enough after the event to be challenged. Both are
 * invisible when you read the diary a page at a time, and both are the first
 * thing the other side's expert looks for.
 */
export function diaryPosition(
  ctx: EngineContext,
  window: { from: string; to: string },
): {
  daysInWindow: number;
  recorded: number;
  /** Working days with no diary at all, most recent first. */
  missingDates: string[];
  lateEntries: Array<{ diaryDate: string; daysLate: number }>;
  weatherDaysLost: number;
  totalLabourHours: number;
  /** Days a blocker was recorded — where a delay claim would start from. */
  blockedDays: Array<{ diaryDate: string; blockers: string[] }>;
  completeness: string;
} {
  authorise(ctx, 'FIELD_EXECUTION', 'R');

  const diaries = currentDiaries(ctx).map((record) => record.state);

  const inWindow = diaries.filter((d) => String(d.diaryDate) >= window.from && String(d.diaryDate) <= window.to);
  const byDate = new Set(inWindow.map((d) => String(d.diaryDate)));

  // Only working days are counted as missing. Nobody keeps a diary on a Sunday
  // the site was shut, and reporting those as gaps would bury the real ones.
  const missing: string[] = [];
  let daysInWindow = 0;
  for (let day = new Date(`${window.from}T00:00:00.000Z`); day <= new Date(`${window.to}T00:00:00.000Z`); day.setUTCDate(day.getUTCDate() + 1)) {
    const date = day.toISOString().slice(0, 10);
    if (!isBusinessDay(date)) continue;
    daysInWindow += 1;
    if (!byDate.has(date)) missing.push(date);
  }

  const lateEntries = inWindow
    .filter((d) => d.contemporaneous !== true)
    .map((d) => ({ diaryDate: String(d.diaryDate), daysLate: Number(d.daysLate ?? 0) }))
    .sort((a, b) => b.daysLate - a.daysLate);

  const weatherDaysLost = inWindow.filter((d) => (d.weather as DiaryWeather | undefined)?.workingStopped === true).length;
  const totalLabourHours = inWindow.reduce((sum, d) => sum + Number(d.labourHours ?? 0), 0);

  const blockedDays = inWindow
    .filter((d) => Array.isArray(d.blockers) && (d.blockers as string[]).length > 0)
    .map((d) => ({ diaryDate: String(d.diaryDate), blockers: d.blockers as string[] }))
    .sort((a, b) => b.diaryDate.localeCompare(a.diaryDate));

  const completeness =
    daysInWindow === 0
      ? 'No working days in the window.'
      : missing.length === 0
        ? `Unbroken across ${daysInWindow} working ${daysInWindow === 1 ? 'day' : 'days'}.`
        : `${missing.length} of ${daysInWindow} working ${daysInWindow === 1 ? 'day has' : 'days have'} no diary. A gap is where a delay claim is attacked.`;

  return {
    daysInWindow,
    recorded: inWindow.length,
    missingDates: missing.sort((a, b) => b.localeCompare(a)),
    lateEntries,
    weatherDaysLost,
    totalLabourHours: Number(totalLabourHours.toFixed(2)),
    blockedDays,
    completeness,
  };
}

// --- Lookahead planning and PPC -------------------------------------------------
//
// `LOOKAHEAD_PUBLISHED` and `CONSTRAINT_RAISED` were both in the catalogue with
// nothing able to emit them, so the platform had a delay-risk model that read
// open constraints from a log nothing could write to. It always read zero.
//
// This is Last Planner rather than a rolling bar chart, and the difference is
// the promise. A lookahead lists what *could* be done in the next few weeks; a
// commitment is a named person saying they *will* do a specific thing by a
// specific date. Percent Plan Complete measures how many of those promises were
// kept, and the reasons the rest were not are the entire point — a team that
// keeps 50% of its promises cannot plan at all, and the reasons say why.

export type ConstraintCategory =
  | 'DESIGN'
  | 'MATERIALS'
  | 'LABOUR'
  | 'PLANT'
  | 'ACCESS'
  | 'PERMIT'
  | 'PREDECESSOR'
  | 'INFORMATION'
  | 'APPROVAL';

// --- Site walk ---------------------------------------------------------------

/**
 * What a walk turns up. Deliberately not safety — that has its own route, its
 * own sensitivity and its own classification, and folding the two together
 * would put safety observations behind the wrong permission.
 */
export type SiteObservationCategory =
  | 'QUALITY'
  | 'PROGRESS'
  | 'HOUSEKEEPING'
  | 'ACCESS'
  | 'ENVIRONMENTAL'
  | 'WORKMANSHIP'
  | 'MATERIALS';

/**
 * Capture an observation from a site walk.
 *
 * Deterministic and free. A walk produces twenty of these in an hour, and
 * charging AI against each one would teach people not to record them — which
 * costs far more than the classification is worth. The judgement here is the
 * walker's, and it is already in their head at the moment they are standing in
 * front of the thing.
 *
 * Evidence is required because an observation without a photograph is an
 * assertion, and the whole reason to record one is that somebody will want to
 * see the state of the work on the day it was seen.
 */
export function captureSiteObservation(
  ctx: EngineContext,
  input: {
    category: SiteObservationCategory;
    description: string;
    location: string;
    /** The activity it was seen against, where the walker can name one. */
    taskId?: string;
    observedBy: string;
    /** Set where somebody has to do something about it. */
    requiresAction: boolean;
    actionOwner?: string;
    actionByDate?: string;
    evidenceHash: string;
  },
  now = new Date(),
): { observationId: string; reference: string; requiresAction: boolean } {
  authorise(ctx, 'FIELD_EXECUTION', 'C', { lifecyclePhase: currentPhase(ctx) });

  if (input.description.trim().length < 10) {
    throw new DomainError('OBSERVATION_INSUBSTANTIAL', 'Say what was seen, in terms somebody who was not there can act on');
  }

  // An action nobody owns is not an action. The same rule the constraints log
  // runs on, for the same reason: it is what stops the list becoming wallpaper.
  if (input.requiresAction && (!input.actionOwner || !input.actionByDate)) {
    throw new DomainError(
      'OBSERVATION_ACTION_UNOWNED',
      'An observation that requires action needs an owner and a date it is needed by',
    );
  }

  if (input.taskId) ctx.ledger.require({ refType: 'Task', refId: input.taskId });

  const observationId = ulid();
  const sequence = ctx.ledger.list(ctx.projectId, 'SiteObservation').length + 1;
  const reference = `OBS-${String(sequence).padStart(4, '0')}`;

  const evidence = registerEvidence(ctx, {
    type: 'SITE_OBSERVATION_MEDIA',
    hash: input.evidenceHash,
    description: `${input.category} observation at ${input.location}`,
    linkedEntities: input.taskId ? [{ refType: 'Task', refId: input.taskId }] : [],
  });

  write(ctx, {
    eventType: 'SITE_OBSERVATION_CAPTURED',
    entity: { refType: 'SiteObservation', refId: observationId },
    nextState: {
      id: observationId,
      projectId: ctx.projectId,
      reference,
      category: input.category,
      description: input.description,
      location: input.location,
      taskId: input.taskId,
      observedBy: input.observedBy,
      observedAt: now.toISOString(),
      requiresAction: input.requiresAction,
      actionOwner: input.actionOwner,
      actionByDate: input.actionByDate,
      status: input.requiresAction ? 'OPEN' : 'NOTED',
    },
    evidenceRefs: [evidence],
  });

  return { observationId, reference, requiresAction: input.requiresAction };
}

/**
 * Close an observation out, saying what was done.
 *
 * The same argument as the clash register and the constraints log: a list that
 * only grows stops being read. An observation that required action and was
 * never closed is the one that matters, and it can only be found if closing is
 * possible.
 */
export function closeSiteObservation(
  ctx: EngineContext,
  input: { observationId: string; actionTaken: string; closedBy: string; evidenceHash?: string },
  now = new Date(),
): { observationId: string; reference: string; daysOpen: number; closedLate: boolean } {
  authorise(ctx, 'FIELD_EXECUTION', 'U', { lifecyclePhase: currentPhase(ctx) });

  const observation = ctx.ledger.require({ refType: 'SiteObservation', refId: input.observationId });
  if (observation.state.status === 'CLOSED') {
    throw new DomainError('OBSERVATION_ALREADY_CLOSED', `${String(observation.state.reference)} is already closed`);
  }
  if (input.actionTaken.trim().length < 10) {
    throw new DomainError('OBSERVATION_ACTION_INSUBSTANTIAL', 'Say what was actually done about it');
  }

  const observedAt = String(observation.state.observedAt);
  const daysOpen = Math.max(0, Math.round((now.getTime() - Date.parse(observedAt)) / 86_400_000));
  const actionByDate = typeof observation.state.actionByDate === 'string' ? observation.state.actionByDate : undefined;
  const closedLate = actionByDate !== undefined && now.toISOString().slice(0, 10) > actionByDate;

  const evidenceRefs = input.evidenceHash
    ? [
        registerEvidence(ctx, {
          type: 'SITE_OBSERVATION_CLOSEOUT',
          hash: input.evidenceHash,
          description: `Closeout of ${String(observation.state.reference)}`,
          linkedEntities: [{ refType: 'SiteObservation', refId: input.observationId }],
        }),
      ]
    : undefined;

  write(ctx, {
    eventType: 'SITE_OBSERVATION_CLOSED',
    entity: { refType: 'SiteObservation', refId: input.observationId },
    nextState: {
      ...observation.state,
      status: 'CLOSED',
      actionTaken: input.actionTaken,
      closedBy: input.closedBy,
      closedAt: now.toISOString(),
      daysOpen,
      closedLate,
    },
    evidenceRefs,
  });

  return { observationId: input.observationId, reference: String(observation.state.reference), daysOpen, closedLate };
}

/**
 * The walk register, ordered by what is overdue rather than by what is recent.
 */
export function siteWalkPosition(
  ctx: EngineContext,
  today = new Date().toISOString().slice(0, 10),
): {
  total: number;
  open: number;
  byCategory: Record<string, number>;
  overdue: Array<{ reference: string; category: string; description: string; actionOwner?: string; actionByDate?: string; daysOverdue: number }>;
  closedLate: number;
  averageDaysToClose?: number;
  summary: string;
} {
  authorise(ctx, 'FIELD_EXECUTION', 'R');

  const observations = ctx.ledger.list(ctx.projectId, 'SiteObservation').map((record) => record.state);
  const open = observations.filter((o) => o.status === 'OPEN');

  const byCategory: Record<string, number> = {};
  for (const observation of open) {
    const category = String(observation.category);
    byCategory[category] = (byCategory[category] ?? 0) + 1;
  }

  const overdue = open
    .filter((o) => typeof o.actionByDate === 'string' && today > String(o.actionByDate))
    .map((o) => ({
      reference: String(o.reference),
      category: String(o.category),
      description: String(o.description),
      actionOwner: o.actionOwner === undefined ? undefined : String(o.actionOwner),
      actionByDate: String(o.actionByDate),
      daysOverdue: Math.round((Date.parse(today) - Date.parse(String(o.actionByDate))) / 86_400_000),
    }))
    .sort((a, b) => b.daysOverdue - a.daysOverdue);

  const closed = observations.filter((o) => o.status === 'CLOSED');
  const averageDaysToClose =
    closed.length === 0
      ? undefined
      : Number((closed.reduce((sum, o) => sum + Number(o.daysOpen ?? 0), 0) / closed.length).toFixed(1));

  const summary =
    observations.length === 0
      ? 'No site walk recorded.'
      : overdue.length > 0
        ? `${overdue.length} observation${overdue.length === 1 ? '' : 's'} past the date somebody agreed to deal with them, the oldest by ${overdue[0]!.daysOverdue} days.`
        : `${open.length} open, none overdue.`;

  return {
    total: observations.length,
    open: open.length,
    byCategory,
    overdue,
    closedLate: closed.filter((o) => o.closedLate === true).length,
    averageDaysToClose,
    summary,
  };
}

/**
 * Raise a constraint against an activity.
 *
 * A constraint is something that must be cleared before work can start, owned
 * by a named person with a date it is needed by. Both are required: a
 * constraints log without owners is a list of complaints, and one without need-by
 * dates cannot be prioritised, which is how the log becomes wallpaper.
 */
export function raiseConstraint(
  ctx: EngineContext,
  input: {
    taskId: string;
    category: ConstraintCategory;
    description: string;
    /** Who has to clear it. Not the person who raised it. */
    owner: string;
    needByDate: string;
  },
  now = new Date(),
): { constraintId: string; reference: string; blocksCriticalPath: boolean } {
  authorise(ctx, 'LOOKAHEAD_CONSTRAINTS', 'C', { lifecyclePhase: currentPhase(ctx) });

  const task = ctx.ledger.require({ refType: 'Task', refId: input.taskId });
  if (!input.owner.trim()) {
    throw new DomainError('CONSTRAINT_OWNER_REQUIRED', 'A constraint needs somebody who has to clear it, or it is a complaint');
  }

  // Whether it sits on the critical path decides how it is treated, and the
  // network already knows. Asking the person raising it would be asking them to
  // guess at something the platform can answer.
  const { activities, dependencies } = loadNetwork(ctx);
  const cpm = calculateCPM(activities, dependencies);
  const blocksCriticalPath = cpm.criticalPath.includes(input.taskId);

  const sequence = ctx.ledger.list(ctx.projectId, 'Constraint').length + 1;
  const reference = `CON-${String(sequence).padStart(4, '0')}`;
  const constraintId = ulid();

  write(ctx, {
    eventType: 'CONSTRAINT_RAISED',
    entity: { refType: 'Constraint', refId: constraintId },
    nextState: {
      id: constraintId,
      projectId: ctx.projectId,
      reference,
      taskId: input.taskId,
      taskName: task.state.name,
      category: input.category,
      description: input.description,
      owner: input.owner,
      needByDate: input.needByDate,
      blocksCriticalPath,
      status: 'OPEN',
      raisedAt: now.toISOString(),
      raisedBy: ctx.auth.actorId,
    },
  });

  return { constraintId, reference, blocksCriticalPath };
}

/** Clear a constraint, with what actually cleared it. */
export function closeConstraint(
  ctx: EngineContext,
  input: { constraintId: string; resolution: string },
  now = new Date(),
): { constraintId: string; daysOpen: number; clearedLate: boolean } {
  authorise(ctx, 'LOOKAHEAD_CONSTRAINTS', 'U', { lifecyclePhase: currentPhase(ctx) });

  const constraint = ctx.ledger.require({ refType: 'Constraint', refId: input.constraintId });
  if (constraint.state.status === 'CLOSED') {
    throw new DomainError('CONSTRAINT_ALREADY_CLOSED', `${String(constraint.state.reference)} is already closed`);
  }
  if (input.resolution.trim().length < 10) {
    throw new DomainError('CONSTRAINT_RESOLUTION_REQUIRED', 'Say what cleared it. "Resolved" tells the next job nothing.');
  }

  const raisedAt = String(constraint.state.raisedAt);
  const daysOpen = Math.max(0, Math.round((now.getTime() - Date.parse(raisedAt)) / 86_400_000));
  const clearedLate = now.toISOString().slice(0, 10) > String(constraint.state.needByDate);

  write(ctx, {
    eventType: 'CONSTRAINT_CLOSED',
    entity: { refType: 'Constraint', refId: input.constraintId },
    nextState: {
      ...constraint.state,
      status: 'CLOSED',
      resolution: input.resolution,
      closedAt: now.toISOString(),
      closedBy: ctx.auth.actorId,
      daysOpen,
      clearedLate,
    },
  });

  return { constraintId: input.constraintId, daysOpen, clearedLate };
}

export type Commitment = {
  taskId: string;
  /** What is promised, in terms somebody can say yes or no to at the end of the week. */
  promise: string;
  /** The person making the promise. A commitment with no name is a wish. */
  promisedBy: string;
  dueDate: string;
};

/**
 * Publish a lookahead.
 *
 * The rule that makes this Last Planner: **a task with an open constraint
 * cannot be committed to.** Promising work that is blocked is how a plan becomes
 * a list of intentions, and it is the single commonest reason PPC collapses. The
 * constraint has to be cleared first, or the promise has to wait.
 *
 * Activities can still appear in the lookahead while constrained — that is what
 * the lookahead is for, making the constraint visible early enough to clear it.
 * What is refused is the promise.
 */
export function publishLookahead(
  ctx: EngineContext,
  input: {
    weekStarting: string;
    /** Six is the usual window: long enough to clear a constraint, short enough to mean something. */
    weeks?: number;
    plannedTaskIds: string[];
    commitments: Commitment[];
  },
): { lookaheadId: string; weekStarting: string; committed: number; planned: number } {
  authorise(ctx, 'LOOKAHEAD_CONSTRAINTS', 'C', { lifecyclePhase: currentPhase(ctx) });

  // Structural validity first: a promise with no name against it is invalid
  // whatever the constraint position, and reporting the constraint instead
  // would send somebody to clear a constraint that was not the problem.
  for (const commitment of input.commitments) {
    if (!commitment.promisedBy.trim()) {
      throw new DomainError('COMMITMENT_UNOWNED', 'A commitment with no name against it is a wish, not a promise');
    }
  }

  const openConstraints = ctx.ledger
    .list(ctx.projectId, 'Constraint')
    .filter((record) => record.state.status !== 'CLOSED');

  const blocked = input.commitments
    .map((commitment) => ({
      commitment,
      constraints: openConstraints.filter((c) => String(c.state.taskId) === commitment.taskId),
    }))
    .filter((entry) => entry.constraints.length > 0);

  if (blocked.length > 0) {
    const first = blocked[0]!;
    throw new DomainError(
      'COMMITMENT_CONSTRAINED',
      `${blocked.length} ${blocked.length === 1 ? 'commitment is' : 'commitments are'} made against work that is still constrained — ` +
        `${String(first.constraints[0]!.state.reference)} (${String(first.constraints[0]!.state.category).toLowerCase()}) on "${first.commitment.promise}". ` +
        'Clear the constraint or leave the work in the lookahead without a promise against it.',
    );
  }

  const lookaheadId = ulid();
  write(ctx, {
    eventType: 'LOOKAHEAD_PUBLISHED',
    entity: { refType: 'LookaheadPlan', refId: lookaheadId },
    nextState: {
      id: lookaheadId,
      projectId: ctx.projectId,
      weekStarting: input.weekStarting.slice(0, 10),
      weeks: input.weeks ?? 6,
      plannedTaskIds: input.plannedTaskIds,
      commitments: input.commitments.map((c) => ({ ...c, status: 'PROMISED' })),
      status: 'PUBLISHED',
      publishedAt: new Date().toISOString(),
      publishedBy: ctx.auth.actorId,
    },
  });

  return {
    lookaheadId,
    weekStarting: input.weekStarting.slice(0, 10),
    committed: input.commitments.length,
    planned: input.plannedTaskIds.length,
  };
}

/**
 * Productivity, measured rather than felt.
 *
 * The arithmetic already existed inside `forecastDelay`, where it was one input
 * to a risk model and nothing could read it on its own — which is why the site
 * command centre reported "productivity against baseline is not derived". It was
 * derived; it was just not published.
 *
 * The factor is earned days over elapsed days. Below 1.0 an activity is taking
 * longer than the work done justifies, and above it the activity is ahead. It is
 * a ratio and not a percentage complete, because 60% complete in half the
 * planned time and 60% complete in twice the planned time are the same progress
 * report and opposite facts.
 *
 * Three refusals keep the number honest:
 *
 * **An activity nobody has started is excluded, not scored 1.0.** Zero elapsed
 * days gives no evidence either way, and counting it as on-plan flatters a
 * project whose work has not begun.
 *
 * **An activity with progress but no elapsed days is a data fault, not
 * infinite productivity.** It is reported as unmeasurable and named.
 *
 * **The project figure is weighted by planned duration.** An unweighted mean
 * lets a one-day snagging item cancel out a twelve-week structure — arithmetic
 * that produces a comfortable number from an uncomfortable job.
 */
export type ProductivityPosition = {
  measured: number;
  notStarted: number;
  unmeasurable: Array<{ taskId: string; taskName: string; reason: string }>;
  /** Weighted by planned duration, so a long activity counts for more. */
  projectFactor: number | null;
  earnedDays: number;
  elapsedDays: number;
  /** Worst first — where the recovery conversation actually is. */
  activities: Array<{
    taskId: string;
    taskName: string;
    plannedDays: number;
    percentComplete: number;
    elapsedDays: number;
    earnedDays: number;
    factor: number;
    onCriticalPath: boolean;
    /** Days this activity is behind what its elapsed time should have bought. */
    daysBehind: number;
  }>;
  summary: string;
};

export function productivityPosition(ctx: EngineContext): ProductivityPosition {
  authorise(ctx, 'FIELD_EXECUTION', 'R');

  const network = networkFloat(ctx);
  const unmeasurable: ProductivityPosition['unmeasurable'] = [];
  let notStarted = 0;

  const activities = ctx.ledger
    .list(ctx.projectId, 'Task')
    .map((record) => {
      const plannedDays = Number(record.state.durationDays ?? 0);
      const percentComplete = Number(record.state.percentComplete ?? 0);
      const elapsedDays = Number(record.state.elapsedDays ?? 0);
      const earnedDays = plannedDays * (percentComplete / 100);

      if (elapsedDays === 0 && percentComplete === 0) {
        notStarted += 1;
        return undefined;
      }
      if (elapsedDays === 0) {
        unmeasurable.push({
          taskId: record.refId,
          taskName: String(record.state.name),
          reason: `${percentComplete}% complete against no elapsed time. Progress was recorded without the days it took.`,
        });
        return undefined;
      }

      const factor = earnedDays / elapsedDays;
      return {
        taskId: record.refId,
        taskName: String(record.state.name),
        plannedDays,
        percentComplete,
        elapsedDays,
        earnedDays: Number(earnedDays.toFixed(2)),
        factor: Number(factor.toFixed(3)),
        onCriticalPath: network.critical.has(record.refId),
        daysBehind: Number(Math.max(0, elapsedDays - earnedDays).toFixed(2)),
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
    .sort((a, b) => a.factor - b.factor);

  const earnedDays = activities.reduce((sum, a) => sum + a.earnedDays, 0);
  const elapsedDays = activities.reduce((sum, a) => sum + a.elapsedDays, 0);
  const projectFactor = elapsedDays > 0 ? Number((earnedDays / elapsedDays).toFixed(3)) : null;

  const criticalBehind = activities.filter((a) => a.onCriticalPath && a.factor < 1);

  return {
    measured: activities.length,
    notStarted,
    unmeasurable,
    projectFactor,
    earnedDays: Number(earnedDays.toFixed(2)),
    elapsedDays: Number(elapsedDays.toFixed(2)),
    activities,
    summary:
      activities.length === 0
        ? 'Nothing has both progress and elapsed time recorded against it, so there is no productivity to measure.'
        : projectFactor === null
          ? 'No elapsed time is recorded.'
          : `${(projectFactor).toFixed(2)} days earned per day spent across ${activities.length} measured ${
              activities.length === 1 ? 'activity' : 'activities'
            }. ${
              criticalBehind.length > 0
                ? `${criticalBehind.length} on the critical path ${criticalBehind.length === 1 ? 'is' : 'are'} below 1.0 — that is where the completion date moves.`
                : 'Nothing on the critical path is below 1.0.'
            }`,
  };
}

/**
 * Reasons a promise was not kept.
 *
 * A fixed list on purpose. Free text produces a hundred variants of "waiting on
 * the designer" and the whole value of PPC is being able to count them: the
 * reason that recurs is the one to fix, and it is invisible unless the same
 * words are used every week.
 */
export type NonCompletionReason =
  | 'PREREQUISITE_WORK'
  | 'DESIGN_INFORMATION'
  | 'MATERIALS'
  | 'LABOUR'
  | 'PLANT'
  | 'ACCESS'
  | 'WEATHER'
  | 'CHANGED_PRIORITY'
  | 'OVERCOMMITTED'
  | 'APPROVAL';

/**
 * Review the week and compute PPC.
 *
 * PPC is completed promises over promises made, and it is deliberately harsh:
 * a promise 90% done counts as not kept. That is the point. A measure that gave
 * partial credit would report a comfortable number for a team that finishes
 * nothing, and the reason planning fails is almost never that people are 10%
 * short.
 */
export function reviewLookahead(
  ctx: EngineContext,
  input: {
    lookaheadId: string;
    outcomes: Array<{ taskId: string; completed: boolean; reason?: NonCompletionReason; note?: string }>;
  },
): {
  lookaheadId: string;
  promised: number;
  completed: number;
  ppcPercent: number;
  reasons: Array<{ reason: NonCompletionReason; count: number }>;
  assessment: string;
} {
  authorise(ctx, 'LOOKAHEAD_CONSTRAINTS', 'U', { lifecyclePhase: currentPhase(ctx) });

  const lookahead = ctx.ledger.require({ refType: 'LookaheadPlan', refId: input.lookaheadId });
  if (lookahead.state.status === 'REVIEWED') {
    throw new DomainError('LOOKAHEAD_ALREADY_REVIEWED', 'This week has already been reviewed');
  }

  const commitments = (lookahead.state.commitments ?? []) as Array<Commitment & { status: string }>;
  const byTask = new Map(input.outcomes.map((outcome) => [outcome.taskId, outcome]));

  const missing = commitments.filter((c) => !byTask.has(c.taskId));
  if (missing.length > 0) {
    // Every promise gets an answer. Leaving one out is how PPC quietly rises:
    // the promises nobody wants to discuss are the ones that were not kept.
    throw new DomainError(
      'REVIEW_INCOMPLETE',
      `${missing.length} ${missing.length === 1 ? 'commitment has' : 'commitments have'} no outcome recorded. Every promise gets an answer, including the ones nobody wants to discuss.`,
    );
  }

  for (const outcome of input.outcomes) {
    if (!outcome.completed && !outcome.reason) {
      throw new DomainError(
        'NON_COMPLETION_REASON_REQUIRED',
        'A promise that was not kept needs its reason. Counting the reasons is what makes PPC worth measuring.',
      );
    }
  }

  const reviewed = commitments.map((commitment) => {
    const outcome = byTask.get(commitment.taskId)!;
    return {
      ...commitment,
      status: outcome.completed ? 'COMPLETED' : 'NOT_COMPLETED',
      reason: outcome.reason,
      note: outcome.note,
    };
  });

  const completed = reviewed.filter((c) => c.status === 'COMPLETED').length;
  const ppcPercent = commitments.length === 0 ? 0 : Number(((completed / commitments.length) * 100).toFixed(1));

  const counts = new Map<NonCompletionReason, number>();
  for (const entry of reviewed) {
    if (entry.status === 'COMPLETED' || !entry.reason) continue;
    counts.set(entry.reason as NonCompletionReason, (counts.get(entry.reason as NonCompletionReason) ?? 0) + 1);
  }
  const reasons = [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);

  // The bands are the ones the Last Planner literature uses and they are blunt
  // for a reason: below 50% the plan is not a plan, and saying so is more useful
  // than a percentage nobody interprets.
  const assessment =
    commitments.length === 0
      ? 'No commitments were made, so there is nothing to measure. A lookahead without promises is a bar chart.'
      : ppcPercent >= 85
        ? `${ppcPercent}% — the plan is reliable enough to build the next one on.`
        : ppcPercent >= 65
          ? `${ppcPercent}% — promises are being made that the week cannot keep. The reasons below say which.`
          : `${ppcPercent}% — the plan is not a plan. Under two thirds of promises kept means downstream trades cannot rely on any of it.`;

  write(ctx, {
    eventType: 'LOOKAHEAD_REVIEWED',
    entity: { refType: 'LookaheadPlan', refId: input.lookaheadId },
    nextState: {
      ...lookahead.state,
      status: 'REVIEWED',
      commitments: reviewed,
      completedCount: completed,
      ppcPercent,
      reasons,
      reviewedAt: new Date().toISOString(),
      reviewedBy: ctx.auth.actorId,
    },
  });

  return { lookaheadId: input.lookaheadId, promised: commitments.length, completed, ppcPercent, reasons, assessment };
}

export type PPCTrend = {
  weeks: Array<{ weekStarting: string; promised: number; completed: number; ppcPercent: number }>;
  /** Across every reviewed week, which is the figure that means something. */
  meanPpcPercent: number | null;
  /** The reason that recurs — the one worth fixing. */
  topReasons: Array<{ reason: NonCompletionReason; count: number; share: number }>;
  openConstraints: Array<{ reference: string; category: string; owner: string; needByDate: string; overdue: boolean; blocksCriticalPath: boolean }>;
  /** How long the business takes to unblock its own work. */
  meanDaysToClear: number | null;
  summary: string;
};

/**
 * The trend, which is the only form of PPC worth reading.
 *
 * One week's figure says almost nothing. The trend says whether the team is
 * learning, and the recurring reason says what to fix. A single reason
 * accounting for most failures is a business problem rather than a planning
 * problem, and no individual week shows it.
 */
export function ppcTrend(ctx: EngineContext, today = new Date().toISOString().slice(0, 10)): PPCTrend {
  authorise(ctx, 'LOOKAHEAD_CONSTRAINTS', 'R');

  const reviewed = ctx.ledger
    .list(ctx.projectId, 'LookaheadPlan')
    .filter((record) => record.state.status === 'REVIEWED')
    .sort((a, b) => String(a.state.weekStarting).localeCompare(String(b.state.weekStarting)));

  const weeks = reviewed.map((record) => ({
    weekStarting: String(record.state.weekStarting),
    promised: ((record.state.commitments ?? []) as unknown[]).length,
    completed: Number(record.state.completedCount ?? 0),
    ppcPercent: Number(record.state.ppcPercent ?? 0),
  }));

  const totalPromised = weeks.reduce((sum, w) => sum + w.promised, 0);
  const totalCompleted = weeks.reduce((sum, w) => sum + w.completed, 0);
  // Weighted by promises rather than averaging the weekly percentages: a week
  // with two commitments should not count as much as a week with thirty.
  const meanPpcPercent = totalPromised === 0 ? null : Number(((totalCompleted / totalPromised) * 100).toFixed(1));

  const counts = new Map<NonCompletionReason, number>();
  for (const record of reviewed) {
    for (const entry of (record.state.reasons ?? []) as Array<{ reason: NonCompletionReason; count: number }>) {
      counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + entry.count);
    }
  }
  const totalFailures = [...counts.values()].reduce((sum, n) => sum + n, 0);
  const topReasons = [...counts.entries()]
    .map(([reason, count]) => ({ reason, count, share: totalFailures === 0 ? 0 : Number(((count / totalFailures) * 100).toFixed(1)) }))
    .sort((a, b) => b.count - a.count);

  const constraints = ctx.ledger.list(ctx.projectId, 'Constraint');
  const openConstraints = constraints
    .filter((c) => c.state.status !== 'CLOSED')
    .map((c) => ({
      reference: String(c.state.reference),
      category: String(c.state.category),
      owner: String(c.state.owner),
      needByDate: String(c.state.needByDate),
      overdue: today > String(c.state.needByDate),
      blocksCriticalPath: c.state.blocksCriticalPath === true,
    }))
    .sort((a, b) => a.needByDate.localeCompare(b.needByDate));

  const closed = constraints.filter((c) => c.state.status === 'CLOSED');
  const meanDaysToClear =
    closed.length === 0
      ? null
      : Number((closed.reduce((sum, c) => sum + Number(c.state.daysOpen ?? 0), 0) / closed.length).toFixed(1));

  const summary =
    weeks.length === 0
      ? 'No week has been reviewed yet, so there is no PPC to report. A figure would be invented.'
      : topReasons.length === 0
        ? `${meanPpcPercent}% across ${weeks.length} reviewed ${weeks.length === 1 ? 'week' : 'weeks'}, with every promise kept.`
        : `${meanPpcPercent}% across ${weeks.length} reviewed ${weeks.length === 1 ? 'week' : 'weeks'}. ` +
          `${topReasons[0]!.reason.replace(/_/g, ' ').toLowerCase()} accounts for ${topReasons[0]!.share}% of broken promises — ` +
          'the recurring reason is the one worth fixing.';

  return { weeks, meanPpcPercent, topReasons, openConstraints, meanDaysToClear, summary };
}

/**
 * Simulate the completion date across the whole network.
 *
 * The published P80 sums variance along the deterministic critical path, which
 * is the textbook method and systematically optimistic: the critical path is
 * only critical for the durations you assumed, and finishing by a date needs
 * *every* path to make it. This runs the network end to end many times so a
 * path that only becomes critical under stress is counted when it does.
 *
 * Reads only. A forecast is not a commercial position, and writing one would
 * mean the number moved every time somebody looked at it.
 */
export function simulateProgramme(
  ctx: EngineContext,
  options: { iterations?: number; contractualDurationDays?: number } = {},
): ReturnType<typeof simulateCompletion> & { analyticP80Days: number } {
  authorise(ctx, 'PROGRAMME_BASELINES', 'R');

  const { activities, dependencies } = loadNetwork(ctx);
  if (activities.length === 0) throw new DomainError('PROGRAMME_EMPTY', 'No activities exist to simulate');

  const taskRecords = new Map(ctx.ledger.list(ctx.projectId, 'Task').map((r) => [r.refId, r.state]));

  const threePoint: ThreePointActivity[] = activities.map((activity) => {
    const state = taskRecords.get(activity.id);
    const duration = Number(state?.durationDays ?? activity.duration);
    return {
      ...activity,
      optimistic: Number(state?.optimisticDays ?? duration),
      mostLikely: duration,
      pessimistic: Number(state?.pessimisticDays ?? duration),
    };
  });

  // The analytic figure the platform publishes, computed the same way it is
  // published, so the comparison is against the real number rather than a
  // second derivation of it.
  const cpm = calculateCPM(activities, dependencies);
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
  const analyticP80Days = durationAtConfidence(cpm.projectDuration, varianceSum, 0.8);

  return {
    ...simulateCompletion(threePoint, dependencies, {
      // Seeded from the project, so the same programme gives the same forecast
      // twice. An unreproducible number cannot be audited against the platform
      // that produced it.
      seed: ctx.projectId,
      iterations: options.iterations,
      contractualDurationDays: options.contractualDurationDays,
      analyticP80Days,
    }),
    analyticP80Days,
  };
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
