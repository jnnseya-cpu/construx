import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';
import { LIFECYCLE_ORDER, type LifecyclePhase } from './phases.ts';

/**
 * Work that runs across stages rather than inside one.
 *
 * ## The failure this exists to prevent
 *
 * A project has one primary stage, and the primary stage is a reporting
 * answer — where the bulk of the work is, what workspace to open by default,
 * which column of the portfolio this job sits in. It is not a description of
 * what anybody is doing.
 *
 * Real projects overlap. Design is still running when the first pour goes in.
 * Procurement is buying the fit-out while the frame is going up. The tender
 * reconciliation is still open eight weeks after the job started. A model that
 * says a project is "in Construction" and nothing else has quietly asserted
 * that design finished, which is the assertion that puts a gang on site with
 * nothing to build from.
 *
 * §3.1 makes this a separate control dimension for exactly that reason, and
 * AC-06 is the test of it: *design and procurement are active; the primary
 * stage changes to Construction; both workstreams remain active unless
 * explicitly closed.* A stage change is a statement about where the project is.
 * It is not permission to decide that somebody else's work has finished.
 *
 * ## Which is why nothing here is closed by a stage change
 *
 * There is one way a workstream stops being active and it is a person saying
 * so, with a reason. `applyPhaseChange` does not touch these records and must
 * not learn how to — the test in `workstreams.test.ts` drives a phase change
 * and asserts the statuses are unmoved, which is the whole of AC-06.
 */

/**
 * The workstream types, as a closed catalogue.
 *
 * Every one of these is named in §3.3's own scenario table — the four ways a
 * project arrives at award, and what is genuinely running in each. A free-text
 * type would make two projects' workstreams incomparable, which defeats the
 * only reason to have the dimension: a portfolio view that can say how many
 * jobs still have an open tender reconciliation.
 */
export const WORKSTREAM_TYPES = {
  TENDER_RECONCILIATION: {
    label: 'Tender reconciliation',
    what: 'Closing the differences between what was tendered and what was contracted',
  },
  PRECONSTRUCTION: { label: 'Preconstruction', what: 'Early contractor involvement before the contract is let' },
  ESTIMATING: { label: 'Estimating', what: 'Pricing, take-off and the cost plan' },
  BUILDABILITY: { label: 'Buildability', what: 'Reviewing the design against how it will actually be built' },
  DESIGN: { label: 'Design', what: 'Producing and coordinating the information the work is built from' },
  PROCUREMENT: { label: 'Procurement', what: 'Enquiries, tender lists, buying and letting the packages' },
  MOBILISATION: { label: 'Mobilisation', what: 'Getting the site, the team and the systems ready to start' },
  CONSTRUCTION: { label: 'Construction', what: 'The physical work' },
  COMMISSIONING: { label: 'Commissioning', what: 'Testing, balancing and proving the systems' },
  HANDOVER: { label: 'Handover', what: 'Completion evidence, the O&M record and acceptance into use' },
  CALL_OFF_PURSUIT: {
    label: 'Call-off pursuit',
    what: 'Chasing the first instruction under a framework place that is not yet a job',
  },
  HISTORIC_DATA_ONBOARDING: {
    label: 'Historic data onboarding',
    what: 'Bringing a job that started elsewhere onto the record, under control',
  },
  OPERATIONS: { label: 'Operations and maintenance', what: 'Running the asset once it is in service' },
} as const;

export type WorkstreamType = keyof typeof WORKSTREAM_TYPES;
export const WORKSTREAM_TYPE_CODES = Object.keys(WORKSTREAM_TYPES) as WorkstreamType[];

/**
 * §3.1's workstream statuses, and what each one means for the project.
 *
 * `active` is the flag the portfolio counts, and `BLOCKED` is deliberately
 * active: a workstream waiting on somebody is work in progress that has stopped
 * moving, and counting it as inactive is how it disappears from the report that
 * would have got it unblocked.
 */
export const WORKSTREAM_STATUS = {
  NOT_STARTED: { label: 'Not started', active: false, open: true, closed: false },
  ACTIVE: { label: 'Active', active: true, open: true, closed: false },
  BLOCKED: { label: 'Blocked', active: true, open: true, closed: false },
  COMPLETE: { label: 'Complete', active: false, open: false, closed: true },
  CANCELLED: { label: 'Cancelled', active: false, open: false, closed: true },
} as const;

export type WorkstreamStatus = keyof typeof WORKSTREAM_STATUS;
export const WORKSTREAM_STATUS_CODES = Object.keys(WORKSTREAM_STATUS) as WorkstreamStatus[];

/**
 * What is actually running once a project converts, by where delivery starts.
 *
 * Read straight off §3.3's scenario table rather than invented. A contractor
 * entering at DESIGN is developing what they priced, so design and procurement
 * are live alongside the reconciliation and the mobilisation; one entering at
 * CONSTRUCTION took a novated design and is mobilising to build it.
 *
 * Opened rather than left to somebody to remember, because a dimension nobody
 * populates is a dimension that reports every project as having no work in it.
 */
export const CONVERSION_WORKSTREAMS: Record<'DESIGN' | 'CONSTRUCTION', WorkstreamType[]> = {
  DESIGN: ['TENDER_RECONCILIATION', 'DESIGN', 'PROCUREMENT', 'MOBILISATION'],
  CONSTRUCTION: ['TENDER_RECONCILIATION', 'MOBILISATION', 'CONSTRUCTION'],
};

export type Workstream = {
  id: string;
  projectId: string;
  type: WorkstreamType;
  label: string;
  status: WorkstreamStatus;
  /** The stage the project was at when this was opened — §10.1's stage_context. */
  stageContext: LifecyclePhase | null;
  ownerId: string | null;
  plannedStart?: string;
  plannedFinish?: string;
  openedAt: string;
  openedBy: string;
  statusAt: string;
  statusBy: string;
  statusReason: string;
  history: Array<{ from: WorkstreamStatus | null; to: WorkstreamStatus; at: string; by: string; reason: string }>;
};

function requireType(type: string): WorkstreamType {
  if (!(type in WORKSTREAM_TYPES)) {
    throw new DomainError(
      'WORKSTREAM_TYPE_UNKNOWN',
      `"${type}" is not a workstream type. The catalogue is closed so that two projects' workstreams mean the same thing.`,
      422,
      [{ field: 'type', message: `One of ${WORKSTREAM_TYPE_CODES.join(', ')}` }],
    );
  }
  return type as WorkstreamType;
}

function records(ctx: EngineContext): Array<{ refId: string; state: Workstream }> {
  return ctx.ledger.list(ctx.projectId, 'Workstream').map((record) => ({
    refId: record.refId,
    state: record.state as unknown as Workstream,
  }));
}

/**
 * Open a workstream, or return the one already open of that type.
 *
 * One live workstream per type per project. A second "Design" workstream is
 * two answers to whether design is finished, and the first time they disagree
 * the dimension is worthless. A *closed* one does not block a new one — work
 * genuinely does restart, and that is a second record with its own history
 * rather than a resurrection of the first.
 */
export function activateWorkstream(
  ctx: EngineContext,
  input: {
    type: string;
    ownerId?: string;
    plannedStart?: string;
    plannedFinish?: string;
    reason?: string;
    /** Opened at NOT_STARTED where it is planned rather than running. */
    status?: 'NOT_STARTED' | 'ACTIVE';
  },
): { workstreamId: string; type: WorkstreamType; status: WorkstreamStatus; alreadyOpen: boolean } {
  authorise(ctx, 'PROJECT_SETUP', 'U');

  const type = requireType(input.type);
  const open = records(ctx).find(
    (record) => record.state.type === type && !WORKSTREAM_STATUS[record.state.status].closed,
  );
  if (open) {
    return { workstreamId: open.refId, type, status: open.state.status, alreadyOpen: true };
  }

  const now = new Date().toISOString();
  const status: WorkstreamStatus = input.status === 'NOT_STARTED' ? 'NOT_STARTED' : 'ACTIVE';
  const reason = (input.reason ?? '').trim() || `${WORKSTREAM_TYPES[type].label} opened on this project.`;
  const workstreamId = ulid();
  const phase = ctx.ledger.get({ refType: 'Project', refId: ctx.projectId })?.state.phase;

  const state: Workstream = {
    id: workstreamId,
    projectId: ctx.projectId,
    type,
    label: WORKSTREAM_TYPES[type].label,
    status,
    stageContext: LIFECYCLE_ORDER.includes(phase as LifecyclePhase) ? (phase as LifecyclePhase) : null,
    ownerId: input.ownerId ?? null,
    ...(input.plannedStart ? { plannedStart: input.plannedStart } : {}),
    ...(input.plannedFinish ? { plannedFinish: input.plannedFinish } : {}),
    openedAt: now,
    openedBy: ctx.auth.actorId,
    statusAt: now,
    statusBy: ctx.auth.actorId,
    statusReason: reason,
    history: [{ from: null, to: status, at: now, by: ctx.auth.actorId, reason }],
  };

  write(ctx, {
    eventType: 'WORKSTREAM_ACTIVATED',
    entity: { refType: 'Workstream', refId: workstreamId },
    nextState: state as unknown as Record<string, unknown>,
  });

  return { workstreamId, type, status, alreadyOpen: false };
}

/**
 * Move a workstream's status — the only way one stops being active.
 *
 * AC-06 in the negative: there is no other caller. A stage change does not
 * reach this function, a conversion does not close anything through it, and no
 * scheduled job walks the register tidying up. Closing somebody's work is a
 * decision somebody makes, and it carries their reason.
 */
export function setWorkstreamStatus(
  ctx: EngineContext,
  input: { workstreamId: string; status: string; reason: string; ownerId?: string },
): { workstreamId: string; from: WorkstreamStatus; to: WorkstreamStatus } {
  authorise(ctx, 'PROJECT_SETUP', 'U');

  if (!(input.status in WORKSTREAM_STATUS)) {
    throw new DomainError('WORKSTREAM_STATUS_UNKNOWN', `"${input.status}" is not a workstream status`, 422, [
      { field: 'status', message: `One of ${WORKSTREAM_STATUS_CODES.join(', ')}` },
    ]);
  }
  const to = input.status as WorkstreamStatus;

  const record = ctx.ledger.require({ refType: 'Workstream', refId: input.workstreamId });
  const state = record.state as unknown as Workstream;
  const from = state.status;

  if (from === to) {
    throw new DomainError(
      'WORKSTREAM_NO_CHANGE',
      `${state.label} is already ${WORKSTREAM_STATUS[to].label.toLowerCase()}.`,
      409,
    );
  }
  if (WORKSTREAM_STATUS[from].closed) {
    throw new DomainError(
      'WORKSTREAM_CLOSED',
      `${state.label} was ${WORKSTREAM_STATUS[from].label.toLowerCase()} on ${state.statusAt.slice(0, 10)}. ` +
        'Work that restarts is a new workstream with its own history, not a reopened one — otherwise the record ' +
        'cannot say the work stopped and started again.',
      409,
    );
  }
  // A close is a statement that somebody else's work is finished, so it carries
  // the sentence saying why. Everything else moves on a short note.
  const reason = (input.reason ?? '').trim();
  if (WORKSTREAM_STATUS[to].closed && reason.length < 10) {
    throw new DomainError(
      'WORKSTREAM_REASON_REQUIRED',
      `Closing ${state.label} needs the sentence saying what finished, or why it was cancelled.`,
      422,
      [{ field: 'reason', message: 'Required, and long enough to be read' }],
    );
  }
  if (!reason) {
    throw new DomainError('WORKSTREAM_REASON_REQUIRED', 'Say why the status moved.', 422, [
      { field: 'reason', message: 'Required' },
    ]);
  }

  const now = new Date().toISOString();
  write(ctx, {
    eventType: 'WORKSTREAM_STATUS_CHANGED',
    entity: { refType: 'Workstream', refId: input.workstreamId },
    nextState: {
      ...state,
      status: to,
      ownerId: input.ownerId ?? state.ownerId,
      statusAt: now,
      statusBy: ctx.auth.actorId,
      statusReason: reason,
      history: [...state.history, { from, to, at: now, by: ctx.auth.actorId, reason }],
    } as unknown as Record<string, unknown>,
  });

  return { workstreamId: input.workstreamId, from, to };
}

/**
 * Open the workstreams a conversion starts with — §3.3's scenario table.
 *
 * Returns what it opened rather than writing and forgetting, so the conversion
 * receipt can say it. Idempotent through `activateWorkstream`: a type already
 * open is left exactly as it is, which matters because a retried conversion
 * must not produce a second Design workstream.
 */
export function openConversionWorkstreams(
  ctx: EngineContext,
  deliveryEntry: 'DESIGN' | 'CONSTRUCTION',
): Array<{ workstreamId: string; type: WorkstreamType }> {
  return CONVERSION_WORKSTREAMS[deliveryEntry].map((type) => {
    const opened = activateWorkstream(ctx, {
      type,
      reason: `Opened by the contract award — the project entered delivery at ${deliveryEntry}.`,
    });
    return { workstreamId: opened.workstreamId, type };
  });
}

/** The workstreams that are still somebody's problem. */
export function activeWorkstreams(ctx: EngineContext): Workstream[] {
  return records(ctx)
    .map((record) => record.state)
    .filter((state) => WORKSTREAM_STATUS[state.status].active);
}

/** The register as a position, with what is running and what has stopped. */
export function projectWorkstreams(ctx: EngineContext): {
  workstreams: Workstream[];
  active: number;
  blocked: number;
  closed: number;
  types: Array<{ code: WorkstreamType; label: string; what: string }>;
  statuses: Array<{ code: WorkstreamStatus; label: string; active: boolean }>;
  summary: string;
} {
  authorise(ctx, 'PROJECT_SETUP', 'R');

  const all = records(ctx).map((record) => record.state);
  const active = all.filter((state) => WORKSTREAM_STATUS[state.status].active);
  const blocked = all.filter((state) => state.status === 'BLOCKED');
  const closed = all.filter((state) => WORKSTREAM_STATUS[state.status].closed);

  return {
    workstreams: all,
    active: active.length,
    blocked: blocked.length,
    closed: closed.length,
    // Published with the register so a chooser offers exactly the catalogue the
    // engine validates against rather than a second copy of the same names.
    types: WORKSTREAM_TYPE_CODES.map((code) => ({ code, label: WORKSTREAM_TYPES[code].label, what: WORKSTREAM_TYPES[code].what })),
    statuses: WORKSTREAM_STATUS_CODES.map((code) => ({
      code,
      label: WORKSTREAM_STATUS[code].label,
      active: WORKSTREAM_STATUS[code].active,
    })),
    summary:
      all.length === 0
        ? 'No workstreams are open on this project, so the primary stage is the only statement about what is running.'
        : `${active.length} workstream${active.length === 1 ? '' : 's'} running` +
          (blocked.length > 0 ? `, ${blocked.length} of them blocked` : '') +
          `, ${closed.length} closed. The primary stage says where the project is; these say what is actually being done.`,
  };
}
