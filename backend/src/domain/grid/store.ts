/**
 * The persisted HV Grid Connection engagement — the 42-step, eight-gate playbook
 * bound to a project on the Golden Thread.
 *
 * `playbook.ts` is the pure catalogue and gate logic. This gives it a home: an
 * engagement that persists per project, the run state of each of the 42 steps, and
 * the gate decisions — all written through the one `write` path so tenant isolation,
 * the actor, the role-at-action and the hash chain apply for free.
 *
 * The spec's authority rule is enforced here, not merely described: a gate is
 * decided only once its digital steps are ready, and an **electrical gate (G4–G7)
 * cannot be approved without a verified authority record** — a decision flag alone
 * is refused with `AUTHORITY_REQUIRED`. No step or gate carries any switching,
 * set-point or relay capability; there is no code path that could.
 */

import { DomainError } from '../../core/errors.ts';
import { ulid } from '../../core/ids.ts';
import { authorise, runAI, write, type EngineContext } from '../../engines/context.ts';
import {
  coverage,
  gateMeta,
  gateState,
  GATE_IDS,
  GRID_STEPS,
  stepsOfGate,
  type GateId,
  type GateState,
  type GridStep,
  type StepStatus,
} from './playbook.ts';

export type { GateId } from './playbook.ts';

/** What an agent is doing on a step (spec §3). */
export type GridRunState =
  | 'PLANNED'
  | 'WORKING'
  | 'WAITING_EVIDENCE'
  | 'WAITING_AUTHORITY'
  | 'VALIDATED'
  | 'RELEASED'
  | 'STALE'
  | 'BLOCKED';

const RUN_STATES: ReadonlySet<string> = new Set<GridRunState>([
  'PLANNED', 'WORKING', 'WAITING_EVIDENCE', 'WAITING_AUTHORITY', 'VALIDATED', 'RELEASED', 'STALE', 'BLOCKED',
]);

type StepRecord = {
  runState: GridRunState;
  validated: boolean;
  owner?: string;
  blocker?: string;
  updatedAt: string;
  /** The last agent execution of this step — its grounded output, if any. */
  lastRun?: { at: string; summary: string; acuConsumed: number };
};

/**
 * The professional-conduct preface for a grid agent. It reasons as a competent
 * connection-delivery specialist, but never presents itself as chartered or
 * authorised electrical personnel, and never generates an instruction to operate,
 * switch or set plant — those are external facts the platform records, not acts an
 * agent takes.
 */
export const GRID_CONDUCT =
  'Apply the judgement and duty of care of an experienced HV grid-connection delivery specialist. Reason only from the ' +
  'project sources supplied; state no value, date, rating, setting or quantity that is not in them, and do not equate MW ' +
  'and MVA without a verified power-factor basis. You are not chartered or authorised electrical personnel: never claim ' +
  'to be, and never issue, imply or draft any instruction to switch, energise, set a relay or operate equipment — those ' +
  'are external authorised acts. Where evidence, authority or a reading is missing, say precisely what is needed rather ' +
  'than assuming it.';
type GateRecord = { authorityRecorded: boolean; authorityRef?: string; decisionApproved: boolean; decidedBy?: string; at?: string; note?: string; superseded?: boolean; expired?: boolean };

export type GridEngagementState = {
  id: string;
  reference: string;
  projectId: string;
  connection: string;
  route: string;
  pointOfConnection?: string;
  capacityNote?: string;
  steps: Record<string, StepRecord>;
  gates: Partial<Record<GateId, GateRecord>>;
  openedAt: string;
  openedBy: string;
  /**
   * When this engagement was archived, and by whom — set to take a finished or
   * mistaken (e.g. a test) engagement off the active list. This is not a delete:
   * the Golden Thread is append-only, so the record and everything filed against
   * it stay readable; archiving only hides it from the picker.
   */
  archivedAt?: string;
  archivedBy?: string;
  archiveReason?: string;
};

/** A step is playbook-VALIDATED only when independently validated; BLOCKED when blocked. */
function stepStatus(rec: StepRecord | undefined): StepStatus {
  if (!rec) return 'OPEN';
  if (rec.validated) return 'VALIDATED';
  if (rec.runState === 'BLOCKED') return 'BLOCKED';
  return 'OPEN';
}

function statusMap(state: GridEngagementState): Record<string, StepStatus> {
  const out: Record<string, StepStatus> = {};
  for (const s of GRID_STEPS) out[s.id] = stepStatus(state.steps[s.id]);
  return out;
}

function require(ctx: EngineContext, engagementId: string): GridEngagementState {
  return ctx.ledger.require({ refType: 'GridEngagement', refId: engagementId }).state as GridEngagementState;
}

/** Open a grid-connection engagement against a project; the 42 steps start PLANNED. */
export function openGridEngagement(
  ctx: EngineContext,
  input: { connection: string; route: string; pointOfConnection?: string; capacityNote?: string },
): { engagementId: string; reference: string } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'C');
  const id = ulid();
  const seq = ctx.ledger.list(ctx.projectId, 'GridEngagement').length + 1;
  const reference = `GRID-${String(seq).padStart(4, '0')}`;
  const now = new Date().toISOString();
  const steps: Record<string, StepRecord> = {};
  for (const s of GRID_STEPS) steps[s.id] = { runState: 'PLANNED', validated: false, updatedAt: now };
  const state: GridEngagementState = {
    id,
    reference,
    projectId: ctx.projectId,
    connection: input.connection,
    route: input.route,
    ...(input.pointOfConnection ? { pointOfConnection: input.pointOfConnection } : {}),
    ...(input.capacityNote ? { capacityNote: input.capacityNote } : {}),
    steps,
    gates: {},
    openedAt: now,
    openedBy: ctx.auth.actorId,
  };
  write(ctx, { eventType: 'GRID_ENGAGEMENT_OPENED', entity: { refType: 'GridEngagement', refId: id }, nextState: state });
  return { engagementId: id, reference };
}

/** Update a step's agent-run state, validation, owner or blocker. */
export function updateStep(
  ctx: EngineContext,
  engagementId: string,
  stepId: string,
  patch: { runState?: GridRunState; validated?: boolean; owner?: string; blocker?: string },
): GridEngagementState {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'U');
  if (!GRID_STEPS.some((s) => s.id === stepId)) throw new DomainError('UNKNOWN_STEP', `${stepId} is not a playbook step`);
  if (patch.runState !== undefined && !RUN_STATES.has(patch.runState)) {
    throw new DomainError('BAD_RUN_STATE', `${patch.runState} is not a valid agent-run state`);
  }
  const state = require(ctx, engagementId);
  const current = state.steps[stepId] ?? { runState: 'PLANNED' as GridRunState, validated: false, updatedAt: new Date().toISOString() };
  const next: StepRecord = {
    ...current,
    ...(patch.runState !== undefined ? { runState: patch.runState } : {}),
    ...(patch.validated !== undefined ? { validated: patch.validated } : {}),
    ...(patch.owner !== undefined ? { owner: patch.owner } : {}),
    ...(patch.blocker !== undefined ? { blocker: patch.blocker } : {}),
    updatedAt: new Date().toISOString(),
  };
  const updated: GridEngagementState = { ...state, steps: { ...state.steps, [stepId]: next } };
  write(ctx, { eventType: 'GRID_ENGAGEMENT_UPDATED', entity: { refType: 'GridEngagement', refId: engagementId }, nextState: updated });
  return updated;
}

/**
 * Record a gate decision. The gate must be at digital readiness, and an electrical
 * gate requires a verified authority record — a bare decision flag is refused.
 */
export function decideGate(
  ctx: EngineContext,
  engagementId: string,
  gateId: GateId,
  input: { decisionApproved?: boolean; authorityRef?: string; note?: string },
): GridEngagementState {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'A');
  if (!GATE_IDS.includes(gateId)) throw new DomainError('UNKNOWN_GATE', `${gateId} is not a gate`);
  const state = require(ctx, engagementId);
  const statuses = statusMap(state);

  // The gate must have reached digital readiness before any decision is recorded.
  const readiness = gateState(gateId, statuses, {});
  if (readiness !== 'CANDIDATE_READY' && readiness !== 'AWAITING_AUTHORITY') {
    throw new DomainError('GATE_BLOCKED', `${gateId} is ${readiness} — its required digital steps are not all validated`);
  }

  const electrical = gateMeta(gateId).electricalAuthority;
  if (electrical && !input.authorityRef) {
    // Digital readiness never advances an electrical gate; a verified authority record is required.
    throw new DomainError('AUTHORITY_REQUIRED', `${gateId} is an electrical-authority gate and advances only with a verified authority record`);
  }

  const record: GateRecord = {
    authorityRecorded: Boolean(input.authorityRef),
    ...(input.authorityRef ? { authorityRef: input.authorityRef } : {}),
    decisionApproved: input.decisionApproved ?? true,
    decidedBy: ctx.auth.actorId,
    at: new Date().toISOString(),
    ...(input.note ? { note: input.note } : {}),
  };
  const updated: GridEngagementState = { ...state, gates: { ...state.gates, [gateId]: record } };
  write(ctx, { eventType: 'GRID_GATE_DECIDED', entity: { refType: 'GridEngagement', refId: engagementId }, nextState: updated });
  return updated;
}

/**
 * The grounded brief an agent executes a step against — pure and provider-free, so
 * the grounding is testable without a provider. It carries the engagement's
 * connection identity and the step's own instruction and expected output, under the
 * conduct rule. No switching, set-point or relay action can be expressed in it.
 */
export function stepExecutionBrief(state: GridEngagementState, stepId: string): {
  connection: { reference: string; connection: string; route: string; pointOfConnection?: string };
  step: { id: string; gate: GateId; capability: string; executes: string; output: string };
} {
  const step = GRID_STEPS.find((s) => s.id === stepId);
  if (!step) throw new DomainError('UNKNOWN_STEP', `${stepId} is not a playbook step`);
  return {
    connection: { reference: state.reference, connection: state.connection, route: state.route, ...(state.pointOfConnection ? { pointOfConnection: state.pointOfConnection } : {}) },
    step: { id: step.id, gate: step.gate, capability: step.capability, executes: step.executes, output: step.output },
  };
}

/**
 * Execute a playbook step with its owning agent, grounded in the project sources.
 * A completed run records the grounded output on the step; it does not set
 * `validated` — the agent produces a readiness candidate, and independent validation
 * is a separate act (spec §4, §8). A run with no reasoning provider configured
 * releases its hold uncharged and parks the step WAITING_EVIDENCE rather than faking
 * a result. No run can switch, energise or set plant — there is no such tool.
 */
export async function runStep(ctx: EngineContext, engagementId: string, stepId: string): Promise<GridEngagementState> {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'U');
  const state = require(ctx, engagementId);
  const step = GRID_STEPS.find((s) => s.id === stepId);
  if (!step) throw new DomainError('UNKNOWN_STEP', `${stepId} is not a playbook step`);
  const current = state.steps[stepId];
  if (current && (current.validated || current.runState === 'RELEASED')) {
    throw new DomainError('STEP_NOT_RUNNABLE', `step ${stepId} is ${current.validated ? 'validated' : 'released'} and cannot be re-run`);
  }

  const brief = stepExecutionBrief(state, stepId);
  const patch = (next: Partial<StepRecord>): GridEngagementState => {
    const base = state.steps[stepId] ?? { runState: 'PLANNED' as GridRunState, validated: false, updatedAt: new Date().toISOString() };
    const updated: GridEngagementState = { ...state, steps: { ...state.steps, [stepId]: { ...base, ...next, updatedAt: new Date().toISOString() } } };
    write(ctx, { eventType: 'GRID_ENGAGEMENT_UPDATED', entity: { refType: 'GridEngagement', refId: engagementId }, nextState: updated });
    return updated;
  };

  try {
    const result = await runAI(ctx, {
      engine: 'EXECUTIVE',
      taskType: `grid_step:${brief.step.gate}:${step.capability}:${stepId}`,
      capability: 'REASONING',
      inputRefs: [{ refType: 'GridEngagement', refId: engagementId }],
      request: {
        task:
          `${GRID_CONDUCT} You are the ${step.capability} agent executing step ${stepId} of the HV grid-connection ` +
          `delivery playbook for connection ${brief.connection.reference}. Execute: ${step.executes}. Produce the ` +
          `controlled output (${step.output}), grounded strictly in the project sources; name what is still needed rather ` +
          'than inventing it.',
        payload: brief,
      },
      toWrites: () => [],
      requireModel: { code: 'NO_REASONING_PROVIDER', message: 'No reasoning provider is configured to execute this step' },
    });
    const summary = String((result.output as { narrative?: unknown; text?: unknown }).narrative ?? (result.output as { text?: unknown }).text ?? '').trim().slice(0, 8000);
    return patch({ runState: 'WORKING', blocker: undefined, lastRun: { at: new Date().toISOString(), summary, acuConsumed: result.acuConsumed } });
  } catch (error) {
    if (error instanceof DomainError && error.code === 'NO_REASONING_PROVIDER') {
      return patch({ runState: 'WAITING_EVIDENCE', blocker: 'Awaiting a reasoning provider to execute this step' });
    }
    throw error;
  }
}

/**
 * Record a reappraisal trigger — a drawing/vendor revision, a withdrawn outage, a
 * failed test, a new notification (spec §6.3) — that reopens impacted work: the named
 * steps drop to STALE and lose their validation, and the named gates are marked
 * SUPERSEDED so a reopened candidate cannot read as still approved.
 */
export function recordTrigger(
  ctx: EngineContext,
  engagementId: string,
  input: { event: string; affectedSteps?: string[]; affectedGates?: GateId[] },
): GridEngagementState {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'U');
  const state = require(ctx, engagementId);
  const now = new Date().toISOString();

  const steps = { ...state.steps };
  for (const id of input.affectedSteps ?? []) {
    if (!GRID_STEPS.some((s) => s.id === id)) throw new DomainError('UNKNOWN_STEP', `${id} is not a playbook step`);
    const base = steps[id] ?? { runState: 'PLANNED' as GridRunState, validated: false, updatedAt: now };
    steps[id] = { ...base, runState: 'STALE', validated: false, blocker: `Reopened: ${input.event}`, updatedAt: now };
  }

  const gates = { ...state.gates };
  for (const g of input.affectedGates ?? []) {
    if (!GATE_IDS.includes(g)) throw new DomainError('UNKNOWN_GATE', `${g} is not a gate`);
    const base = gates[g] ?? { authorityRecorded: false, decisionApproved: false };
    gates[g] = { ...base, superseded: true, note: `Reopened: ${input.event}` };
  }

  const updated: GridEngagementState = { ...state, steps, gates };
  write(ctx, { eventType: 'GRID_ENGAGEMENT_UPDATED', entity: { refType: 'GridEngagement', refId: engagementId }, nextState: updated });
  return updated;
}

/** The grid engagements on a project, for the picker, each with its headline coverage. */
export function listGridEngagements(ctx: EngineContext): Array<{ engagementId: string; reference: string; connection: string; route: string; percent: number }> {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'R');
  return ctx.ledger
    .list(ctx.projectId, 'GridEngagement')
    .map((r) => r.state as GridEngagementState)
    // Archived engagements are off the active list — still on the ledger, just not offered.
    .filter((s) => !s.archivedAt)
    .map((s) => ({ engagementId: s.id, reference: s.reference, connection: s.connection, route: s.route, percent: coverage(statusMap(s)).percent }));
}

/**
 * Take an engagement off the active list — for a finished one, or a test created
 * while trying the module out. Not a delete: the record and everything filed
 * against it remain on the append-only Golden Thread; this sets an `archivedAt`
 * marker so the picker no longer offers it. Idempotent.
 */
export function archiveGridEngagement(ctx: EngineContext, engagementId: string, input: { reason?: string } = {}): GridEngagementState {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'U');
  const state = require(ctx, engagementId);
  if (state.archivedAt) return state; // already archived — nothing to do
  const updated: GridEngagementState = {
    ...state,
    archivedAt: new Date().toISOString(),
    archivedBy: ctx.auth.actorId,
    ...(input.reason && input.reason.trim() ? { archiveReason: input.reason.trim() } : {}),
  };
  write(ctx, { eventType: 'GRID_ENGAGEMENT_UPDATED', entity: { refType: 'GridEngagement', refId: engagementId }, nextState: updated });
  return updated;
}

export type GridWorkboard = {
  engagement: GridEngagementState;
  steps: Array<GridStep & { runState: GridRunState; validated: boolean; owner?: string; blocker?: string; lastRun?: { at: string; summary: string; acuConsumed: number } }>;
  gates: Array<{ id: GateId; title: string; electricalAuthority: boolean; state: GateState }>;
  coverage: { requiredDigital: number; validated: number; percent: number };
  nextActions: string[];
};

/** The engagement workboard: every step with its run state, each gate's computed state, coverage. */
export function gridWorkboard(ctx: EngineContext, engagementId: string): GridWorkboard {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'R');
  const state = require(ctx, engagementId);
  const statuses = statusMap(state);

  const steps = GRID_STEPS.map((s) => {
    const rec = state.steps[s.id];
    return { ...s, runState: rec?.runState ?? 'PLANNED', validated: rec?.validated ?? false, owner: rec?.owner, blocker: rec?.blocker, lastRun: rec?.lastRun };
  });

  const gates = GATE_IDS.map((g) => {
    const meta = gateMeta(g);
    return { id: g, title: meta.title, electricalAuthority: meta.electricalAuthority, state: gateState(g, statuses, state.gates[g] ?? {}) };
  });

  const nextActions: string[] = [];
  for (const g of gates) {
    if (g.state === 'CANDIDATE_READY') nextActions.push(`${g.id} (${g.title}) is ready for a decision`);
    if (g.state === 'AWAITING_AUTHORITY') nextActions.push(`${g.id} (${g.title}) needs a verified authority record to advance`);
    if (g.state === 'BLOCKED') {
      const blocked = stepsOfGate(g.id).filter((s) => stepStatus(state.steps[s.id]) === 'BLOCKED').map((s) => s.id);
      nextActions.push(`${g.id} (${g.title}) is blocked on step(s) ${blocked.join(', ')}`);
    }
  }

  return { engagement: state, steps, gates, coverage: coverage(statuses), nextActions };
}
