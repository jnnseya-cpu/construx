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
import { authorise, write, type EngineContext } from '../../engines/context.ts';
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

type StepRecord = { runState: GridRunState; validated: boolean; owner?: string; blocker?: string; updatedAt: string };
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

/** The grid engagements on a project, for the picker, each with its headline coverage. */
export function listGridEngagements(ctx: EngineContext): Array<{ engagementId: string; reference: string; connection: string; route: string; percent: number }> {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'R');
  return ctx.ledger.list(ctx.projectId, 'GridEngagement').map((r) => {
    const s = r.state as GridEngagementState;
    return { engagementId: s.id, reference: s.reference, connection: s.connection, route: s.route, percent: coverage(statusMap(s)).percent };
  });
}

export type GridWorkboard = {
  engagement: GridEngagementState;
  steps: Array<GridStep & { runState: GridRunState; validated: boolean; owner?: string; blocker?: string }>;
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
    return { ...s, runState: rec?.runState ?? 'PLANNED', validated: rec?.validated ?? false, owner: rec?.owner, blocker: rec?.blocker };
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
