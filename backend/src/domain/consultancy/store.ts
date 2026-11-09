/**
 * The stateful consultancy engagement — persisted in the Golden Thread — and its
 * workboard.
 *
 * Vertical 1 produced the appraisal and the Five Case deliverable as pure
 * functions. This gives the work a home: an engagement that persists, a
 * work-package checklist of required digital tasks, agent-run states per task,
 * and a workboard that reports blockers, owners, next permissible action and the
 * **verified digital coverage** the spec (§7) defines — completed *and validated*
 * required tasks over all required digital tasks, with blocked tasks staying in
 * the denominator.
 *
 * Two state machines, kept separate as the spec (§4) insists: the engagement's
 * **workflow state** (where the commission is) and each task's **agent-run
 * state** (what the automation is doing). A blocked task can coexist with
 * progressing siblings; the workboard shows both without conflating them.
 *
 * Everything is written through the one `write` path, so tenant isolation, the
 * actor, the role-at-action and the hash chain are applied for free. A bidder's
 * engagement is its own record under its own tenant; the `partySide` recorded
 * here is the basis the buyer/bidder workspace isolation builds on.
 */

import { DomainError } from '../../core/errors.ts';
import { ulid } from '../../core/ids.ts';
import { authorise, currentPhase, runAI, write, type EngineContext } from '../../engines/context.ts';
import { CONSULTANCY_CONDUCT } from './businesscase.ts';
import {
  intakeBlockers,
  type Assignment,
  type BusinessCaseProfile,
  type MinimumIntake,
  type WorkRoute,
} from './engagement.ts';
import { runnable } from './orchestrator.ts';

/** What the automation is doing on a task (spec §4). */
export type AgentRunState =
  | 'QUEUED'
  | 'RUNNING'
  | 'WAITING_INPUT'
  | 'WAITING_AUTHORITY'
  | 'RETRYABLE_FAILURE'
  | 'BLOCKED'
  | 'COMPLETE'
  | 'CANCELLED';

/** Where the commission is (separate from any task's run state). */
export type WorkflowState =
  | 'INTAKE'
  | 'IN_PROGRESS'
  | 'IN_REVIEW'
  | 'ISSUED'
  | 'MONITORING'
  | 'CLOSED'
  | 'CANCELLED';

/** The run states that count as a blocker on the workboard. */
const BLOCKING_STATES: ReadonlySet<AgentRunState> = new Set([
  'WAITING_INPUT',
  'WAITING_AUTHORITY',
  'BLOCKED',
  'RETRYABLE_FAILURE',
]);

const RUN_STATES: ReadonlySet<string> = new Set<AgentRunState>([
  'QUEUED', 'RUNNING', 'WAITING_INPUT', 'WAITING_AUTHORITY', 'RETRYABLE_FAILURE', 'BLOCKED', 'COMPLETE', 'CANCELLED',
]);

export type EngagementState = {
  id: string;
  reference: string;
  route: WorkRoute;
  assignment: Assignment;
  profile: BusinessCaseProfile;
  intake: Partial<MinimumIntake>;
  partySide?: string;
  sponsor?: string;
  sector?: string;
  stage?: string;
  workflowState: WorkflowState;
  scopeVersion: number;
  /** A short log of the typed actions taken against the engagement. */
  actions: Array<{ kind: string; note?: string; at: string; by: string }>;
  /** Set when a tender is won and promoted (C05): the winning bid, signed terms and transferred commitments. */
  award?: { winningBidRef: string; signedTermsRef: string; transferredCommitments: string[]; awardedAt: string; awardedBy: string };
  /** Set when a reappraisal is triggered (C08): the event, the baseline it is measured against, and the delta. */
  reappraisal?: { event: string; baseline: Record<string, number>; revised: Record<string, number>; delta: Record<string, number>; baselineVersion: number; at: string; by: string };
  openedAt: string;
  openedBy: string;
};

export type TaskState = {
  id: string;
  engagementId: string;
  key: string;
  capability: string;
  title: string;
  dependsOn: string[];
  /** A required *digital* task counts toward workboard coverage; a non-digital gate does not. */
  requiredDigital: boolean;
  runState: AgentRunState;
  /** Independent Challenge passed — a task is only *covered* when complete AND validated. */
  validated: boolean;
  owner?: string;
  blocker?: string;
  /**
   * The last agent execution of this task — its grounded output and whether the
   * client requirement was present to ground it. Set by `runTask`; absent until
   * the task has been executed by an agent.
   */
  lastRun?: {
    at: string;
    /** Whether the engagement carried an attached client requirement the agent worked to. */
    groundedInRequirement: boolean;
    /** The agent's output for this work-package, as it was committed. */
    summary: string;
    acuConsumed: number;
  };
  updatedAt: string;
};

function engagement(ctx: EngineContext, engagementId: string): EngagementState {
  const record = ctx.ledger.require({ refType: 'ConsultancyEngagement', refId: engagementId });
  return record.state as EngagementState;
}

function tasksOf(ctx: EngineContext, engagementId: string): TaskState[] {
  return ctx.ledger
    .list(ctx.projectId, 'ConsultancyTask')
    .map((r) => r.state as TaskState)
    .filter((t) => t.engagementId === engagementId);
}

/**
 * Open a consultancy engagement. The intake is checked immediately: any missing
 * mandatory input is returned as a blocker (spec test C02) and the engagement
 * opens in `INTAKE`, never silently authorised — a timeout, or a missing field,
 * never implies approval.
 */
export function openEngagement(
  ctx: EngineContext,
  input: {
    route: WorkRoute;
    assignment: Assignment;
    profile?: BusinessCaseProfile;
    intake: Partial<MinimumIntake>;
    sponsor?: string;
    sector?: string;
    stage?: string;
  },
): { engagementId: string; reference: string; workflowState: WorkflowState; blockers: string[] } {
  authorise(ctx, 'BUSINESS_DEVELOPMENT', 'C', { lifecyclePhase: currentPhase(ctx) });

  const engagementId = ulid();
  const seq = ctx.ledger.list(ctx.projectId, 'ConsultancyEngagement').length + 1;
  const reference = `ENG-${String(seq).padStart(4, '0')}`;
  const blockers = intakeBlockers(input.intake);
  const now = new Date().toISOString();

  const state: EngagementState = {
    id: engagementId,
    reference,
    route: input.route,
    assignment: input.assignment,
    profile: input.profile ?? 'PUBLIC_FIVE_CASE',
    intake: input.intake,
    partySide: input.intake.partySide,
    sponsor: input.sponsor,
    sector: input.sector,
    stage: input.stage,
    workflowState: 'INTAKE',
    scopeVersion: 1,
    actions: [],
    openedAt: now,
    openedBy: ctx.auth.actorId,
  };

  write(ctx, {
    eventType: 'CONSULTANCY_ENGAGEMENT_OPENED',
    entity: { refType: 'ConsultancyEngagement', refId: engagementId },
    nextState: state,
  });

  return { engagementId, reference, workflowState: 'INTAKE', blockers };
}

/** The typed actions the spec's `POST .../actions` carries (§6). */
export type EngagementAction =
  | { kind: 'AUTHORISE'; note?: string }
  | { kind: 'SCOPE_CHANGE'; note?: string }
  | { kind: 'ISSUE'; note?: string }
  | { kind: 'REAPPRAISE'; note?: string }
  | { kind: 'CANCEL'; note?: string };

/**
 * Record a typed action against the engagement and move its workflow state.
 *
 * Conservative transitions. **AUTHORISE** is refused while mandatory intake is
 * outstanding — authorising execution needs the decision authority and the
 * minimum intake, and a missing field must block it rather than be assumed.
 * **SCOPE_CHANGE** bumps the scope version (the signal that pending steps built
 * on the old scope are stale). **CANCEL** is terminal.
 */
export function recordAction(
  ctx: EngineContext,
  engagementId: string,
  action: EngagementAction,
): { workflowState: WorkflowState; scopeVersion: number } {
  authorise(ctx, 'BUSINESS_DEVELOPMENT', action.kind === 'AUTHORISE' ? 'A' : 'U', { lifecyclePhase: currentPhase(ctx) });
  const current = engagement(ctx, engagementId);
  if (current.workflowState === 'CANCELLED' || current.workflowState === 'CLOSED') {
    throw new DomainError('ENGAGEMENT_CLOSED', `Engagement ${current.reference} is ${current.workflowState.toLowerCase()} and cannot be actioned`);
  }

  let workflowState: WorkflowState = current.workflowState;
  let scopeVersion = current.scopeVersion;

  switch (action.kind) {
    case 'AUTHORISE': {
      const blockers = intakeBlockers(current.intake);
      if (blockers.length > 0) {
        throw new DomainError('INTAKE_INCOMPLETE', `Cannot authorise: ${blockers.join('; ')}`);
      }
      workflowState = 'IN_PROGRESS';
      break;
    }
    case 'SCOPE_CHANGE':
      scopeVersion += 1;
      break;
    case 'ISSUE':
      workflowState = 'ISSUED';
      break;
    case 'REAPPRAISE':
      workflowState = 'IN_PROGRESS';
      break;
    case 'CANCEL':
      workflowState = 'CANCELLED';
      break;
  }

  const next: EngagementState = {
    ...current,
    workflowState,
    scopeVersion,
    actions: [...current.actions, { kind: action.kind, note: action.note, at: new Date().toISOString(), by: ctx.auth.actorId }],
  };
  write(ctx, {
    eventType: 'CONSULTANCY_ENGAGEMENT_UPDATED',
    entity: { refType: 'ConsultancyEngagement', refId: engagementId },
    nextState: next,
  });
  return { workflowState, scopeVersion };
}

/** Register a required digital work-package task against the engagement. */
export function registerTask(
  ctx: EngineContext,
  engagementId: string,
  input: { key: string; capability: string; title: string; dependsOn?: string[]; requiredDigital?: boolean },
): { taskId: string } {
  authorise(ctx, 'BUSINESS_DEVELOPMENT', 'U', { lifecyclePhase: currentPhase(ctx) });
  engagement(ctx, engagementId); // existence + tenant check
  const taskId = ulid();
  const state: TaskState = {
    id: taskId,
    engagementId,
    key: input.key,
    capability: input.capability,
    title: input.title,
    dependsOn: input.dependsOn ?? [],
    requiredDigital: input.requiredDigital ?? true,
    runState: 'QUEUED',
    validated: false,
    updatedAt: new Date().toISOString(),
  };
  write(ctx, {
    eventType: 'CONSULTANCY_TASK_REGISTERED',
    entity: { refType: 'ConsultancyTask', refId: taskId },
    nextState: state,
  });
  return { taskId };
}

/** Update a task's agent-run state, validation, owner or blocker. */
export function updateTask(
  ctx: EngineContext,
  taskId: string,
  patch: { runState?: AgentRunState; validated?: boolean; owner?: string; blocker?: string },
): TaskState {
  authorise(ctx, 'BUSINESS_DEVELOPMENT', 'U', { lifecyclePhase: currentPhase(ctx) });
  if (patch.runState !== undefined && !RUN_STATES.has(patch.runState)) {
    throw new DomainError('BAD_RUN_STATE', `${patch.runState} is not a valid agent-run state`);
  }
  const record = ctx.ledger.require({ refType: 'ConsultancyTask', refId: taskId });
  const current = record.state as TaskState;
  const next: TaskState = {
    ...current,
    ...(patch.runState !== undefined ? { runState: patch.runState } : {}),
    ...(patch.validated !== undefined ? { validated: patch.validated } : {}),
    ...(patch.owner !== undefined ? { owner: patch.owner } : {}),
    ...(patch.blocker !== undefined ? { blocker: patch.blocker } : {}),
    updatedAt: new Date().toISOString(),
  };
  write(ctx, {
    eventType: 'CONSULTANCY_TASK_UPDATED',
    entity: { refType: 'ConsultancyTask', refId: taskId },
    nextState: next,
  });
  return next;
}

/**
 * The grounded brief an agent executes a task against — **the point at which the
 * client requirement is wired into execution**. Pure and side-effect free so the
 * grounding is testable without a provider: the engagement's attached requirement
 * is carried in verbatim (and surfaced explicitly as `clientRequirement`), the
 * intake and the task's own capability and title with it. An agent works to the
 * requirement as written, not to a field derived from it.
 */
export function taskExecutionBrief(
  eng: EngagementState,
  task: TaskState,
): {
  task: { key: string; capability: string; title: string };
  engagement: { reference: string; route: WorkRoute; assignment: Assignment };
  intake: Partial<MinimumIntake>;
  clientRequirement: string | null;
} {
  return {
    task: { key: task.key, capability: task.capability, title: task.title },
    engagement: { reference: eng.reference, route: eng.route, assignment: eng.assignment },
    intake: eng.intake,
    clientRequirement: eng.intake.clientRequirement ?? null,
  };
}

/**
 * Execute a work-package task with an agent, grounded in the client requirement.
 *
 * The guards run before anything is reserved or charged: the engagement must be
 * authorised (IN_PROGRESS), the task must not already be finished, and it must be
 * *runnable* — every dependency COMPLETE and validated — or it is parked in
 * WAITING_INPUT naming what it waits on, with no execution. Only then does the
 * agent run, against `taskExecutionBrief` so the client's requirement is the
 * ground truth. A run with no reasoning provider configured releases its hold
 * uncharged and parks the task in WAITING_INPUT rather than faking a result.
 *
 * Completing the agent run sets COMPLETE but leaves `validated` false: a task is
 * *covered* only once COMPLETE **and** independently validated (spec §7), so an
 * executed task still owes its Independent Challenge before it counts.
 */
export async function runTask(ctx: EngineContext, taskId: string): Promise<TaskState> {
  authorise(ctx, 'BUSINESS_DEVELOPMENT', 'U', { lifecyclePhase: currentPhase(ctx) });
  const record = ctx.ledger.require({ refType: 'ConsultancyTask', refId: taskId });
  const task = record.state as TaskState;
  if (task.runState === 'COMPLETE' || task.runState === 'CANCELLED') {
    throw new DomainError('TASK_NOT_RUNNABLE', `This task is ${task.runState} and cannot be executed again`);
  }
  const eng = engagement(ctx, task.engagementId);
  if (eng.workflowState !== 'IN_PROGRESS') {
    throw new DomainError('ENGAGEMENT_NOT_AUTHORISED', 'The engagement must be authorised (IN_PROGRESS) before its tasks are executed');
  }

  // Only run when the orchestrator says this task is runnable; otherwise park it
  // in WAITING_INPUT naming the unfinished dependencies, without executing.
  const siblings = tasksOf(ctx, task.engagementId);
  const ready = runnable(siblings.map((t) => ({ key: t.key, dependsOn: t.dependsOn, runState: t.runState, validated: t.validated, requiredDigital: t.requiredDigital })));
  if (!ready.includes(task.key)) {
    const doneKeys = new Set(siblings.filter((t) => t.runState === 'COMPLETE' && t.validated).map((t) => t.key));
    const unmet = task.dependsOn.filter((d) => !doneKeys.has(d));
    const parked: TaskState = {
      ...task,
      runState: 'WAITING_INPUT',
      blocker: unmet.length ? `Waiting on: ${unmet.join(', ')}` : 'Not yet runnable',
      updatedAt: new Date().toISOString(),
    };
    write(ctx, { eventType: 'CONSULTANCY_TASK_UPDATED', entity: { refType: 'ConsultancyTask', refId: taskId }, nextState: parked });
    return parked;
  }

  const brief = taskExecutionBrief(eng, task);
  try {
    const result = await runAI(ctx, {
      engine: 'EXECUTIVE',
      taskType: `consultancy_task:${task.capability}:${task.key}`,
      capability: 'REASONING',
      inputRefs: [{ refType: 'ConsultancyEngagement', refId: eng.id }],
      request: {
        task:
          `${CONSULTANCY_CONDUCT} You are executing the work-package "${task.title}" (capability ${task.capability}) for ` +
          `engagement ${eng.reference}. Work strictly to the client's requirement and the engagement intake supplied below. ` +
          'Produce the specialist output this work-package owes, grounded in the requirement; if you cannot complete it, say ' +
          'precisely what is still needed rather than inventing it.',
        payload: brief,
      },
      toWrites: () => [],
      requireModel: { code: 'NO_REASONING_PROVIDER', message: 'No reasoning provider is configured to execute this task' },
    });
    const summary = String(
      (result.output as { narrative?: unknown; text?: unknown }).narrative ??
        (result.output as { text?: unknown }).text ??
        '',
    ).trim().slice(0, 8000);
    const done: TaskState = {
      ...task,
      runState: 'COMPLETE',
      blocker: undefined,
      lastRun: { at: new Date().toISOString(), groundedInRequirement: brief.clientRequirement !== null, summary, acuConsumed: result.acuConsumed },
      updatedAt: new Date().toISOString(),
    };
    write(ctx, { eventType: 'CONSULTANCY_TASK_UPDATED', entity: { refType: 'ConsultancyTask', refId: taskId }, nextState: done });
    return done;
  } catch (error) {
    // No provider to run the agent: park the task honestly, nothing charged.
    if (error instanceof DomainError && error.code === 'NO_REASONING_PROVIDER') {
      const parked: TaskState = {
        ...task,
        runState: 'WAITING_INPUT',
        blocker: 'Awaiting a reasoning provider to execute this task',
        updatedAt: new Date().toISOString(),
      };
      write(ctx, { eventType: 'CONSULTANCY_TASK_UPDATED', entity: { refType: 'ConsultancyTask', refId: taskId }, nextState: parked });
      return parked;
    }
    throw error;
  }
}

export type Workboard = {
  engagement: EngagementState;
  tasks: TaskState[];
  blockers: Array<{ source: 'INTAKE' | 'TASK'; detail: string; owner?: string; taskKey?: string }>;
  coverage: { requiredDigital: number; coveredAndValidated: number; percent: number };
  nextActions: string[];
};

/**
 * The engagement workboard: live state, blockers with owners, verified digital
 * coverage and the next permissible actions.
 *
 * Coverage is the spec's completion measure (§7): completed **and validated**
 * required digital tasks over all required digital tasks. A blocked or failed
 * task stays in the denominator — it is work still owed, so it cannot be
 * rounded away. The percentage is 0 when nothing is required yet, never
 * undefined, so a caller can always render a bar.
 */
export function workboard(ctx: EngineContext, engagementId: string): Workboard {
  authorise(ctx, 'BUSINESS_DEVELOPMENT', 'R', { lifecyclePhase: currentPhase(ctx) });
  const eng = engagement(ctx, engagementId);
  const tasks = tasksOf(ctx, engagementId);

  const blockers: Workboard['blockers'] = [];
  for (const b of intakeBlockers(eng.intake)) blockers.push({ source: 'INTAKE', detail: b });
  for (const t of tasks) {
    if (BLOCKING_STATES.has(t.runState)) {
      blockers.push({ source: 'TASK', detail: t.blocker ?? `${t.title} is ${t.runState}`, owner: t.owner, taskKey: t.key });
    }
  }

  const required = tasks.filter((t) => t.requiredDigital);
  const covered = required.filter((t) => t.runState === 'COMPLETE' && t.validated);
  const percent = required.length === 0 ? 0 : Math.round((covered.length / required.length) * 100);

  const nextActions: string[] = [];
  if (eng.workflowState === 'INTAKE') {
    const open = intakeBlockers(eng.intake);
    if (open.length > 0) nextActions.push(`Provide missing intake: ${open.join('; ')}`);
    else nextActions.push('Authorise the engagement to begin execution');
  }
  for (const b of blockers.filter((x) => x.source === 'TASK')) {
    nextActions.push(`Resolve "${b.detail}"${b.owner ? ` (owner: ${b.owner})` : ''}`);
  }
  if (eng.workflowState === 'IN_PROGRESS' && required.length > 0 && covered.length === required.length) {
    nextActions.push('All required digital tasks complete and validated — ready for review and issue');
  }

  return {
    engagement: eng,
    tasks,
    blockers,
    coverage: { requiredDigital: required.length, coveredAndValidated: covered.length, percent },
    nextActions,
  };
}
