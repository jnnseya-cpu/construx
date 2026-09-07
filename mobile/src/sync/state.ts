/**
 * The sync state machine — §14.3, and Appendix A's canonical vocabulary.
 *
 * These eight states are the whole contract between what a person sees and
 * what the platform holds. They are declared once, here, because the single
 * most damaging bug in an offline client is a screen that says a record is
 * safe when it is not — and that bug is always a state that two files
 * disagreed about.
 *
 * The distinction that earns its place is **Awaiting Receipt**. A naive client
 * has "sending" and "sent"; this one has a state for *sent, outcome unknown*,
 * which is where a command sits when the request left the device and the
 * response never came back. It is not a failure — retrying with the same
 * idempotency key is safe and correct — and it is not a success, so nothing
 * may present it as one.
 */

export const SYNC_STATE = [
  'DRAFT',
  'QUEUED',
  'UPLOADING',
  'AWAITING_RECEIPT',
  'SYNCED',
  'CONFLICT',
  'REJECTED',
  'QUARANTINED',
] as const;

export type SyncState = (typeof SYNC_STATE)[number];

export type StateRule = {
  /** What the state means, in the words shown to a person. */
  label: string;
  /** The sentence under it. Plain, and never reassuring about something unfinished. */
  meaning: string;
  /** What the user may do from here. */
  commands: string[];
  /** What must hold before it may leave this state. */
  guard: string;
  /** Whether work in this state is safe on the device — i.e. would survive a wipe. */
  durableOnServer: boolean;
};

export const STATE_RULES: Record<SyncState, StateRule> = {
  DRAFT: {
    label: 'Draft',
    meaning: 'Saved on this device. Not sent, and not visible to anybody else.',
    commands: ['Validate', 'Delete draft'],
    guard: 'Never leaves the device unless autosave sync is configured.',
    durableOnServer: false,
  },
  QUEUED: {
    label: 'Queued',
    meaning: 'Committed locally and waiting to send. It will survive an app kill.',
    commands: ['Cancel (while unsent and policy permits)'],
    guard: 'Dependencies resolved before send.',
    durableOnServer: false,
  },
  UPLOADING: {
    label: 'Uploading',
    meaning: 'Sending now.',
    commands: ['Pause', 'Retry'],
    guard: 'Progress and last error visible.',
    durableOnServer: false,
  },
  AWAITING_RECEIPT: {
    label: 'Awaiting receipt',
    meaning: 'Sent, and the platform has not answered yet. Retrying is safe.',
    commands: ['Check status', 'Retry'],
    guard: 'The same idempotency key is required — a new one would write it twice.',
    durableOnServer: false,
  },
  SYNCED: {
    label: 'Synced',
    meaning: 'The platform has it, with a durable receipt. Safe to wipe this device.',
    commands: ['Read', 'Create amendment'],
    guard: 'Receipt and event ids retained.',
    durableOnServer: true,
  },
  CONFLICT: {
    label: 'Conflict',
    meaning: 'Somebody else changed this. Both versions are kept; nothing was discarded.',
    commands: ['Keep mine', 'Keep theirs', 'Merge', 'Amend'],
    guard: 'Both versions preserved. No automatic resolution for a material field.',
    durableOnServer: false,
  },
  REJECTED: {
    label: 'Rejected',
    meaning: 'The platform refused it, and said why.',
    commands: ['Correct the draft', 'Re-authenticate', 'Escalate'],
    guard: 'The original command and the reason are both retained.',
    durableOnServer: false,
  },
  QUARANTINED: {
    label: 'Quarantined',
    meaning: 'Held back. Access was withdrawn, a hash failed, or its parent is gone.',
    commands: ['Authorised recovery', 'Authorised export', 'Authorised delete'],
    guard: 'Cannot enter normal projections. No background upload until somebody decides.',
    durableOnServer: false,
  },
};

/**
 * Which transitions are legal.
 *
 * Written as a table rather than as conditionals scattered through the engine,
 * because the illegal transitions are the interesting ones and a table makes
 * them visible. Two in particular:
 *
 *   - **Nothing returns from `SYNCED`.** A synced record is corrected by a new
 *     command, never by moving the old one back into the queue. MOB-005.
 *   - **`QUARANTINED` is reachable from everywhere and leaves only by an
 *     authorised decision.** Access revoked while offline (§14.5, M-E2E-24) can
 *     catch a command at any point, and no amount of retrying gets it out.
 */
export const LEGAL_TRANSITIONS: Record<SyncState, SyncState[]> = {
  DRAFT: ['QUEUED', 'QUARANTINED'],
  QUEUED: ['UPLOADING', 'DRAFT', 'QUARANTINED'],
  UPLOADING: ['AWAITING_RECEIPT', 'QUEUED', 'REJECTED', 'CONFLICT', 'QUARANTINED'],
  AWAITING_RECEIPT: ['SYNCED', 'CONFLICT', 'REJECTED', 'QUEUED', 'QUARANTINED'],
  SYNCED: [],
  CONFLICT: ['QUEUED', 'REJECTED', 'QUARANTINED'],
  REJECTED: ['DRAFT', 'QUARANTINED'],
  QUARANTINED: ['QUEUED', 'REJECTED'],
};

export function canTransition(from: SyncState, to: SyncState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

/**
 * The state to show for a set of commands, for the persistent indicator.
 *
 * Worst-first, deliberately. A screen holding one conflict and forty synced
 * records is a screen with a conflict on it, and averaging that into "mostly
 * fine" is how a discarded site record goes unnoticed for a week.
 */
export function worstState(states: readonly SyncState[]): SyncState | undefined {
  const severity: SyncState[] = [
    'QUARANTINED',
    'CONFLICT',
    'REJECTED',
    'AWAITING_RECEIPT',
    'UPLOADING',
    'QUEUED',
    'DRAFT',
    'SYNCED',
  ];
  return severity.find((state) => states.includes(state));
}

/**
 * Whether anything here would be lost if the device were wiped now.
 *
 * The question the Sync Centre exists to answer, and the one a supervisor
 * actually asks before handing a handset back. Anything not `SYNCED` is at
 * risk, including the states that look active — an upload in flight is not a
 * record the platform holds.
 */
export function atRisk(states: readonly SyncState[]): number {
  return states.filter((state) => !STATE_RULES[state].durableOnServer).length;
}
