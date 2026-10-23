import { DomainError } from '../core/errors.ts';

/**
 * The canonical lifecycle state, and why it is not the phase.
 *
 * `phases.ts` holds `CONCEPT → … → OPERATIONS`: the **asset's** journey, and
 * what the specification calls the *primary stage*. It is the wrong shape for
 * four questions a business asks every day about the same project:
 *
 *   - has this been won?           (commercial outcome)
 *   - has delivery started?        (delivery status)
 *   - is it paused, and by whom?   (lifecycle state)
 *   - is it going well?            (health)
 *
 * A project in `DESIGN` may be a live job mobilising, a suspended job with
 * everyone demobilised, or a bid that has not been won at all. One field cannot
 * say which, and a platform that collapses them reports a suspended job as an
 * active one for as long as nobody looks.
 *
 * So this is a separate dimension with its own state machine, its own
 * transitions and its own approvals. It does not replace the phase and must not
 * grow into it: the phase says where the work is, this says what the project
 * *is*.
 *
 * ---
 *
 * ## Three transitions that are not ordinary
 *
 * `CLOSED_LOST`, `WITHDRAWN`, `CLOSED_COMPLETE` and `CANCELLED` are terminal in
 * normal operation. They can be left, but only through a **reopen control** —
 * a separate authorised act with its own reason, because reopening a closed
 * project is how a lost bid quietly becomes a live one and how a completed job
 * acquires new cost. The transition table marks them rather than forbidding
 * them, because forbidding them outright sends people to create a duplicate
 * project instead, which is worse.
 */

export type LifecycleState =
  | 'DRAFT'
  | 'PRE_AWARD'
  | 'NEGOTIATION'
  | 'AWARD_PENDING'
  | 'LIVE_MOBILISING'
  | 'LIVE_ACTIVE'
  | 'HANDOVER'
  | 'OPERATIONS'
  | 'ON_HOLD'
  | 'SUSPENDED'
  | 'CLOSED_LOST'
  | 'WITHDRAWN'
  | 'TERMINATED'
  | 'CLOSED_COMPLETE'
  | 'CANCELLED';

export type LifecycleStateDefinition = {
  state: LifecycleState;
  /** What a person sees. Never the code — see the UI principle in `docs/STATE.md`. */
  label: string;
  /** What must be true to enter it, in the words somebody reads on the gate. */
  entryCondition: string;
  /** Where it may go next without a reopen. */
  next: LifecycleState[];
  /**
   * States reachable only by an authorised reopen. Held apart from `next` so a
   * screen can offer the ordinary transitions as buttons and the reopen as what
   * it is: a separate, reasoned, approved act.
   */
  reopenTo?: LifecycleState[];
  /** Whether the project is live delivery work for portfolio reporting. */
  live: boolean;
  /**
   * Whether the contract value on this project is value the business holds or
   * has held.
   *
   * `live` answers "is the team on it now", which is the question capacity
   * reporting asks. This answers a different one, and the portfolio total was
   * answering neither: **is this money ours to count at all.**
   *
   * `false` for the three states where the project never became work — a bid
   * lost, a bid withdrawn, a draft cancelled. The contract value on those is
   * the sum somebody tendered, which is a real and useful number in a win-rate
   * report and is not turnover, a commitment or a figure that belongs in the
   * estate's total. A lost tender left in that total overstates the business by
   * the value of every bid it did not win, and does it silently.
   *
   * `true` everywhere else, including the terminal states that *were* ours:
   * a completed job is value the business held, and a terminated contract was a
   * commitment somebody has to account for. Also true through the pre-award
   * states, because a tender in progress is a figure a pipeline legitimately
   * reports — what is wrong is counting one that is over and lost.
   */
  holdsValue: boolean;
  /** Whether it is finished, one way or another. */
  terminal: boolean;
};

/**
 * The fifteen states, in the specification's own order.
 *
 * A closed table rather than a configurable one. Sector-specific *stage* maps
 * are configurable — the specification says so and `phases.ts` is where that
 * lives — but the lifecycle state is what portfolio reporting counts, and a
 * tenancy that could invent a sixteenth state would be a tenancy whose
 * "how many live jobs" cannot be compared with anybody else's, including its
 * own last quarter.
 */
export const LIFECYCLE_STATES: LifecycleStateDefinition[] = [
  {
    state: 'DRAFT',
    label: 'Draft',
    entryCondition: 'Project shell created',
    next: ['PRE_AWARD', 'CANCELLED'],
    live: false,
    holdsValue: true,
    terminal: false,
  },
  {
    state: 'PRE_AWARD',
    label: 'Tender opportunity',
    entryCondition: 'Minimum opportunity data validated',
    next: ['NEGOTIATION', 'AWARD_PENDING', 'CLOSED_LOST', 'WITHDRAWN', 'ON_HOLD'],
    live: false,
    holdsValue: true,
    terminal: false,
  },
  {
    state: 'NEGOTIATION',
    label: 'Tender negotiation',
    entryCondition: 'Submission issued or clarification active',
    next: ['PRE_AWARD', 'AWARD_PENDING', 'CLOSED_LOST', 'WITHDRAWN'],
    live: false,
    holdsValue: true,
    terminal: false,
  },
  {
    state: 'AWARD_PENDING',
    label: 'Award validation',
    entryCondition: 'Intent to award or executed contract pending',
    next: ['LIVE_MOBILISING', 'PRE_AWARD', 'CLOSED_LOST'],
    live: false,
    holdsValue: true,
    terminal: false,
  },
  {
    state: 'LIVE_MOBILISING',
    label: 'Live mobilisation',
    entryCondition: 'Award gate approved',
    next: ['LIVE_ACTIVE', 'SUSPENDED', 'TERMINATED'],
    live: true,
    holdsValue: true,
    terminal: false,
  },
  {
    state: 'LIVE_ACTIVE',
    label: 'Live delivery',
    entryCondition: 'Mobilisation release approved',
    next: ['HANDOVER', 'SUSPENDED', 'TERMINATED'],
    live: true,
    holdsValue: true,
    terminal: false,
  },
  {
    state: 'HANDOVER',
    label: 'Handover',
    entryCondition: 'Completion gate entered',
    next: ['OPERATIONS', 'CLOSED_COMPLETE'],
    live: true,
    holdsValue: true,
    terminal: false,
  },
  {
    state: 'OPERATIONS',
    label: 'Operations and maintenance',
    entryCondition: 'Asset accepted into service',
    next: ['CLOSED_COMPLETE', 'SUSPENDED'],
    live: true,
    holdsValue: true,
    terminal: false,
  },
  {
    state: 'ON_HOLD',
    label: 'On hold',
    entryCondition: 'Authorised hold',
    next: ['PRE_AWARD', 'AWARD_PENDING', 'LIVE_ACTIVE', 'WITHDRAWN'],
    live: false,
    holdsValue: true,
    terminal: false,
  },
  {
    state: 'SUSPENDED',
    label: 'Suspended',
    entryCondition: 'Delivery formally suspended',
    next: ['LIVE_MOBILISING', 'LIVE_ACTIVE', 'TERMINATED'],
    // Suspended work is not live work. A suspended job counted as live is how a
    // portfolio reports capacity it does not have.
    live: false,
    holdsValue: true,
    terminal: false,
  },
  {
    state: 'CLOSED_LOST',
    label: 'Closed lost',
    entryCondition: 'Loss approved',
    next: [],
    reopenTo: ['PRE_AWARD'],
    live: false,
    holdsValue: false,
    terminal: true,
  },
  {
    state: 'WITHDRAWN',
    label: 'Withdrawn',
    entryCondition: 'Withdrawal approved',
    next: [],
    reopenTo: ['PRE_AWARD'],
    live: false,
    holdsValue: false,
    terminal: true,
  },
  {
    state: 'TERMINATED',
    label: 'Terminated',
    entryCondition: 'Contract termination approved',
    next: ['CLOSED_COMPLETE'],
    live: false,
    holdsValue: true,
    terminal: true,
  },
  {
    state: 'CLOSED_COMPLETE',
    label: 'Closed complete',
    entryCondition: 'Closure evidence approved',
    next: [],
    reopenTo: ['OPERATIONS'],
    live: false,
    holdsValue: true,
    terminal: true,
  },
  {
    state: 'CANCELLED',
    label: 'Cancelled draft',
    entryCondition: 'Draft cancelled',
    next: [],
    reopenTo: ['DRAFT'],
    live: false,
    holdsValue: false,
    terminal: true,
  },
];

const BY_STATE = new Map(LIFECYCLE_STATES.map((definition) => [definition.state, definition]));

export const LIFECYCLE_STATE_CODES: LifecycleState[] = LIFECYCLE_STATES.map((definition) => definition.state);

/** The definition, or a refusal naming the states that exist. */
export function lifecycleState(state: string): LifecycleStateDefinition {
  const found = BY_STATE.get(state as LifecycleState);
  if (!found) {
    throw new DomainError('LIFECYCLE_STATE_UNKNOWN', `"${state}" is not a lifecycle state`, 422, [
      { field: 'lifecycleState', message: `Expected one of ${LIFECYCLE_STATE_CODES.join(', ')}` },
    ]);
  }
  return found;
}

/** What a person should see for a state code. Never the code itself. */
/**
 * Whether a project's contract value belongs in the estate's total.
 *
 * Read from the table rather than from a list of state names kept beside each
 * report: three reports aggregate contract value and a fourth will, and a rule
 * restated per caller is a rule that disagrees with itself the first time a
 * state is added.
 *
 * An unrecognised state counts. A project whose lifecycle nobody recognises is
 * a record to go and look at, and the safe reading of "we are not sure" is to
 * leave the money in the total where somebody will notice it, rather than to
 * quietly remove it.
 */
export function holdsContractValue(state: string): boolean {
  return BY_STATE.get(state as LifecycleState)?.holdsValue ?? true;
}

export function lifecycleLabel(state: string): string {
  return BY_STATE.get(state as LifecycleState)?.label ?? String(state ?? '');
}

/**
 * Whether the project's process stops here.
 *
 * Asked for in those words — "if it update failed, their process can be stop
 * there" — about a tender that was not won. The states it is true of are
 * exactly the ones that are both **terminal** and do not **hold value**: a bid
 * lost, a bid withdrawn, a draft cancelled. Those three never became work, so
 * there is no work to carry on with, and anything filed against one afterwards
 * is either a mistake or somebody quietly working a job the business did not
 * win.
 *
 * Derived from the two flags rather than declared as a third, so it cannot
 * disagree with them. `CLOSED_COMPLETE` and `TERMINATED` are terminal and *did*
 * hold value: a final account, a defect and thirty years of O&M all legitimately
 * land on a finished job, and stopping those would be a different and much
 * worse bug.
 *
 * Reopening is the way back, and it is deliberately a separate authorised act —
 * see `reopenTo` above.
 */
export function stopsWork(state: string): boolean {
  const definition = BY_STATE.get(state as LifecycleState);
  // An unrecognised state does not stop anything. The safe reading of "we are
  // not sure what this project is" is to let the work continue and let somebody
  // notice, never to freeze a live job on a value nothing recognises.
  return definition ? definition.terminal && !definition.holdsValue : false;
}

/**
 * Check a lifecycle transition, and say whether it needs the reopen control.
 *
 * Returns rather than throws on a reopen, because reopening is permitted — it
 * just is not the same act as advancing, and the caller has to have established
 * its own authority for it. A function that silently allowed both would make
 * "reopen a closed job" indistinguishable from "move it on" in the one place
 * the difference is enforceable.
 */
export function assertLifecycleTransition(
  from: string,
  to: string,
): { requiresReopen: boolean; from: LifecycleStateDefinition; to: LifecycleStateDefinition } {
  const source = lifecycleState(from);
  const target = lifecycleState(to);

  if (source.state === target.state) {
    throw new DomainError('LIFECYCLE_NO_CHANGE', `This project is already ${source.label.toLowerCase()}`, 409);
  }

  if (source.next.includes(target.state)) return { requiresReopen: false, from: source, to: target };
  if ((source.reopenTo ?? []).includes(target.state)) return { requiresReopen: true, from: source, to: target };

  const permitted = [...source.next, ...(source.reopenTo ?? [])];
  throw new DomainError(
    'LIFECYCLE_TRANSITION_FORBIDDEN',
    `A project that is ${source.label.toLowerCase()} cannot become ${target.label.toLowerCase()}. ` +
      (permitted.length === 0
        ? 'That state is final.'
        : `It can become: ${permitted.map((code) => lifecycleLabel(code)).join(', ')}.`),
    409,
  );
}

/**
 * The commercial outcome of a bid — a dimension of its own.
 *
 * Separate from the lifecycle state because the two answer different questions
 * and move at different times: a bid can be `PENDING` while the project sits in
 * `NEGOTIATION`, and `WON` while it sits in `AWARD_PENDING` waiting for an
 * executed contract. Collapsing them means a business cannot tell "we have won
 * it" from "we have started it", which is the gap every mobilisation cost falls
 * into.
 */
export type CommercialOutcome =
  | 'PENDING'
  | 'WON'
  | 'LOST'
  | 'WITHDRAWN'
  | 'NO_BID'
  | 'FRAMEWORK_APPOINTED';

export const COMMERCIAL_OUTCOMES: Record<CommercialOutcome, { label: string; closes: boolean }> = {
  PENDING: { label: 'Pending', closes: false },
  WON: { label: 'Won', closes: false },
  LOST: { label: 'Lost', closes: true },
  WITHDRAWN: { label: 'Withdrawn', closes: true },
  // A no-bid is a decision not to price, taken before any submission. It is not
  // a loss, and counting it as one understates a hit rate as surely as ignoring
  // losses overstates it.
  NO_BID: { label: 'No-bid', closes: true },
  FRAMEWORK_APPOINTED: { label: 'Framework appointed', closes: false },
};

/** Where delivery has got to. Nothing to do with whether the bid was won. */
export type DeliveryStatus = 'NOT_STARTED' | 'MOBILISING' | 'ACTIVE' | 'SUSPENDED' | 'COMPLETE';

export const DELIVERY_STATUSES: Record<DeliveryStatus, string> = {
  NOT_STARTED: 'Not started',
  MOBILISING: 'Mobilising',
  ACTIVE: 'Active',
  SUSPENDED: 'Suspended',
  COMPLETE: 'Complete',
};

/**
 * Health, and why it is deliberately the thinnest thing in this file.
 *
 * It is a performance signal, not a lifecycle state, and the specification is
 * explicit about that. It carries `UNKNOWN` as a real value rather than
 * defaulting to green: a project nobody has assessed is not a project that is
 * fine, and a dashboard showing green for silence is the single most
 * comfortable lie an estate view can tell.
 */
export type ProjectHealth = 'GREEN' | 'AMBER' | 'RED' | 'UNKNOWN';
