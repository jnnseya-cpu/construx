import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, write, type EngineContext } from '../engines/context.ts';
import { rolesAllow } from '../identity/roles.ts';
import type { EntityRecord } from '../goldenthread/ledger.ts';

/**
 * Site meetings, and the minutes that come out of them.
 *
 * Built because the platform could not generate meeting minutes without it, and
 * generating minutes from nothing is precisely the invented content the whole
 * document engine exists to refuse. A minutes document with no meeting behind
 * it would read exactly like one with a meeting behind it, and the reader six
 * months later — usually a lawyer — cannot tell them apart.
 *
 * What makes minutes worth anything is not the narrative. It is the **actions**:
 * who agreed to do what, by when, and whether it happened. Everything else in a
 * set of minutes is context for those four columns.
 *
 * Three rules follow from that, and each of them is a refusal.
 *
 * **An action has an owner and a date.** An action with neither is a topic
 * somebody mentioned. This is the same rule the platform already applies to a
 * site finding and a gate condition, for the same reason: the register fills
 * with things nobody owns and stops being read.
 *
 * **Minutes are issued once, and a correction is a new issue.** The commonest
 * abuse of minutes is quietly amending what was agreed after somebody objects
 * to it. Issued minutes are frozen; a correction is recorded against them with
 * who asked for it and why, and both remain readable.
 *
 * **An action carried from a previous meeting keeps its original date.** A
 * platform that re-dated carried actions on each cycle would show an action
 * raised in March and eleven weeks overdue as due next Tuesday, which is how a
 * register full of overdue actions reports itself as healthy.
 */

export const MEETING_TYPE = [
  'PROGRESS',
  'DESIGN_COORDINATION',
  'SITE_SAFETY',
  'COMMERCIAL',
  'PRE_START',
  'SUBCONTRACTOR',
  'CLIENT',
] as const;
export type MeetingType = (typeof MEETING_TYPE)[number];

export type Attendee = {
  name: string;
  organisation: string;
  role: string;
  /**
   * Whether they were there.
   *
   * Apologies are recorded rather than omitted: a decision taken in the absence
   * of the person it binds is a different decision from one taken in front of
   * them, and the minutes are where that is visible.
   */
  attended: boolean;
};

export type AgendaItem = {
  reference: string;
  subject: string;
  /** What was actually said and decided, not the agenda heading repeated. */
  discussion: string;
};

export type MeetingAction = {
  reference: string;
  what: string;
  owner: string;
  ownerOrganisation: string;
  by: string;
  /** Set where this action was carried from an earlier meeting. */
  raisedAtMeeting?: string;
  /** The date it was originally due, which a carry-forward never resets. */
  originallyDue?: string;
  status: 'OPEN' | 'CLOSED';
  closedAt?: string;
  closureNote?: string;
};

type MeetingState = {
  id: string;
  reference: string;
  type: MeetingType;
  title: string;
  heldAt: string;
  location: string;
  chair: string;
  attendees: Attendee[];
  agenda: AgendaItem[];
  actions: MeetingAction[];
  status: 'DRAFT' | 'ISSUED';
  issuedAt?: string;
  issuedBy?: string;
  corrections: Array<{ raisedBy: string; what: string; at: string }>;
};

function requireMeeting(ctx: EngineContext, meetingId: string): EntityRecord {
  const record = ctx.ledger.get({ refType: 'SiteMeeting', refId: meetingId });
  if (!record) throw new DomainError('MEETING_NOT_FOUND', `No meeting ${meetingId}`, 404);
  return record;
}

function stateOf(record: EntityRecord): MeetingState {
  return record.state as unknown as MeetingState;
}

function assertDraft(record: EntityRecord): void {
  if (record.state.status === 'ISSUED') {
    throw new DomainError(
      'MINUTES_ISSUED',
      `${String(record.state.reference)} was issued on ${String(record.state.issuedAt).slice(0, 10)}. Minutes are not amended ` +
        'after issue — the commonest abuse of a set of minutes is quietly changing what was agreed once somebody objects to ' +
        'it. Record a correction against them instead; both stay readable.',
    );
  }
}

export function openMeeting(
  ctx: EngineContext,
  input: {
    type: MeetingType;
    title: string;
    heldAt: string;
    location: string;
    chair: string;
    attendees: Attendee[];
  },
): { meetingId: string; reference: string } {
  authorise(ctx, 'LOOKAHEAD_CONSTRAINTS', 'C');

  if (!input.title.trim() || !input.location.trim()) {
    throw new DomainError('MEETING_UNNAMED', 'A meeting record names what the meeting was and where it was held.');
  }
  if (Number.isNaN(Date.parse(input.heldAt))) {
    throw new DomainError('HELD_AT_INVALID', 'The date and time the meeting was held is not a date.');
  }
  // A meeting is minuted after it happens. A record dated forward is minutes of
  // a meeting nobody has been to, and the generated document would assert what
  // was agreed at it in exactly the same words as one that took place.
  if (Date.parse(input.heldAt) > Date.now()) {
    throw new DomainError(
      'MEETING_NOT_YET_HELD',
      `${input.heldAt} is in the future. Minutes are a record of what happened, and a meeting recorded before it takes ` +
        'place would produce a document asserting decisions nobody has taken yet, in the same words as one that did.',
    );
  }
  if (input.attendees.length === 0) {
    throw new DomainError('NOBODY_ATTENDED', 'A meeting with nobody at it produces no minutes.');
  }
  if (!input.attendees.some((attendee) => attendee.attended)) {
    throw new DomainError(
      'EVERYBODY_SENT_APOLOGIES',
      'Every person on the list sent apologies, so the meeting did not take place. Record it as cancelled rather than minuting it.',
    );
  }

  const sequence = ctx.ledger.list(ctx.projectId, 'SiteMeeting').length + 1;
  const reference = `${input.type.split('_')[0]}-${String(sequence).padStart(3, '0')}`;
  const meetingId = ulid();

  write(ctx, {
    eventType: 'MEETING_HELD',
    entity: { refType: 'SiteMeeting', refId: meetingId },
    nextState: {
      id: meetingId,
      projectId: ctx.projectId,
      reference,
      type: input.type,
      title: input.title,
      heldAt: input.heldAt,
      location: input.location,
      chair: input.chair,
      attendees: input.attendees,
      agenda: [],
      actions: [],
      corrections: [],
      status: 'DRAFT',
      openedBy: ctx.auth.actorId,
      openedAt: new Date().toISOString(),
    },
  });

  return { meetingId, reference };
}

/** What was discussed under one item, in the words used rather than the heading repeated. */
export function recordAgendaItem(
  ctx: EngineContext,
  meetingId: string,
  input: { subject: string; discussion: string },
): { reference: string } {
  authorise(ctx, 'LOOKAHEAD_CONSTRAINTS', 'U');

  const record = requireMeeting(ctx, meetingId);
  assertDraft(record);
  const state = stateOf(record);

  if (!input.discussion.trim()) {
    throw new DomainError(
      'DISCUSSION_REQUIRED',
      'Say what was actually discussed. An agenda heading with nothing under it records that the item was reached, not what ' +
        'was decided about it.',
    );
  }

  const reference = `${state.reference}.${state.agenda.length + 1}`;

  write(ctx, {
    eventType: 'MEETING_HELD',
    entity: { refType: 'SiteMeeting', refId: meetingId },
    nextState: {
      ...record.state,
      agenda: [...state.agenda, { reference, subject: input.subject, discussion: input.discussion }],
    },
  });

  return { reference };
}

/**
 * An action out of the meeting.
 *
 * `raisedAtMeeting` and `originallyDue` carry an action forward from an earlier
 * meeting without resetting its clock. An action raised in March and still open
 * in June is eleven weeks overdue, and a register that re-dated it on each cycle
 * would report itself as entirely healthy.
 */
export function recordAction(
  ctx: EngineContext,
  meetingId: string,
  input: {
    what: string;
    owner: string;
    ownerOrganisation: string;
    by: string;
    raisedAtMeeting?: string;
    originallyDue?: string;
  },
): { reference: string; daysOverdue: number } {
  authorise(ctx, 'LOOKAHEAD_CONSTRAINTS', 'U');

  const record = requireMeeting(ctx, meetingId);
  assertDraft(record);
  const state = stateOf(record);

  if (!input.what.trim()) throw new DomainError('ACTION_EMPTY', 'Say what has to happen.');
  if (!input.owner.trim() || !input.ownerOrganisation.trim()) {
    throw new DomainError(
      'ACTION_UNOWNED',
      'An action needs a person and the organisation they answer to. Without both it is a topic somebody mentioned, and a ' +
        'register of those stops being read.',
    );
  }
  if (Number.isNaN(Date.parse(input.by))) {
    throw new DomainError(
      'ACTION_UNDATED',
      `"${input.by}" is not a date. An action with no date is never late, which is why it is never done.`,
    );
  }

  const reference = `${state.reference}/A${String(state.actions.length + 1).padStart(2, '0')}`;
  const due = input.originallyDue ?? input.by;
  const daysOverdue = Math.max(0, Math.floor((Date.parse(state.heldAt) - Date.parse(due)) / 86_400_000));

  const action: MeetingAction = {
    reference,
    what: input.what,
    owner: input.owner,
    ownerOrganisation: input.ownerOrganisation,
    by: input.by,
    raisedAtMeeting: input.raisedAtMeeting,
    originallyDue: input.originallyDue,
    status: 'OPEN',
  };

  write(ctx, {
    eventType: 'MEETING_HELD',
    entity: { refType: 'SiteMeeting', refId: meetingId },
    nextState: { ...record.state, actions: [...state.actions, action] },
  });

  return { reference, daysOverdue };
}

/** Close an action, with what actually happened rather than a tick. */
export function closeAction(
  ctx: EngineContext,
  meetingId: string,
  input: { reference: string; closureNote: string },
): void {
  // Either the person who keeps the register or the person who chairs it. The
  // matrix gives the minute-taker `U` and the chair `A`, and a chair who cannot
  // close the action they are chasing is the wrong reading of that split — the
  // separation it exists to protect is over *issuing* the minutes, not over
  // maintaining the register afterwards.
  authorise(ctx, 'LOOKAHEAD_CONSTRAINTS', rolesAllow(ctx.auth.roles, 'LOOKAHEAD_CONSTRAINTS', 'U') ? 'U' : 'A');

  const record = requireMeeting(ctx, meetingId);
  const state = stateOf(record);
  const action = state.actions.find((a) => a.reference === input.reference);

  if (!action) throw new DomainError('ACTION_NOT_FOUND', `No action ${input.reference} on ${state.reference}.`, 404);
  if (action.status === 'CLOSED') throw new DomainError('ACTION_ALREADY_CLOSED', `${input.reference} is already closed.`);
  if (!input.closureNote.trim()) {
    throw new DomainError(
      'CLOSURE_NOTE_REQUIRED',
      'Say what was done. An action closed with nothing beside it cannot be told apart from one closed to tidy the register.',
    );
  }

  // Closing an action is deliberately permitted after issue. The minutes record
  // what was agreed on the day and do not change; the action register is live,
  // and freezing it would mean every closure needed a new meeting.
  write(ctx, {
    eventType: 'MEETING_ACTION_CLOSED',
    entity: { refType: 'SiteMeeting', refId: meetingId },
    nextState: {
      ...record.state,
      actions: state.actions.map((a) =>
        a.reference === input.reference
          ? { ...a, status: 'CLOSED' as const, closedAt: new Date().toISOString(), closureNote: input.closureNote }
          : a,
      ),
    },
  });
}

/** Issue the minutes. After this they are the record of what was agreed. */
export function issueMinutes(ctx: EngineContext, meetingId: string): { issuedAt: string; actions: number } {
  authorise(ctx, 'LOOKAHEAD_CONSTRAINTS', 'A');

  const record = requireMeeting(ctx, meetingId);
  assertDraft(record);
  const state = stateOf(record);

  if (state.agenda.length === 0) {
    throw new DomainError('NOTHING_MINUTED', 'Nothing was recorded as discussed, so there is nothing to issue.');
  }

  const issuedAt = new Date().toISOString();

  write(ctx, {
    eventType: 'MINUTES_ISSUED',
    entity: { refType: 'SiteMeeting', refId: meetingId },
    nextState: { ...record.state, status: 'ISSUED', issuedAt, issuedBy: ctx.auth.actorId },
  });

  return { issuedAt, actions: state.actions.length };
}

/**
 * A correction to issued minutes.
 *
 * Recorded beside them rather than applied to them. Somebody disagreeing with
 * what the minutes say is a fact about the meeting, and silently rewriting the
 * text destroys the only thing minutes are for.
 */
export function recordCorrection(
  ctx: EngineContext,
  meetingId: string,
  input: { raisedBy: string; what: string },
): void {
  authorise(ctx, 'LOOKAHEAD_CONSTRAINTS', 'U');

  const record = requireMeeting(ctx, meetingId);
  const state = stateOf(record);

  if (state.status !== 'ISSUED') {
    throw new DomainError(
      'MINUTES_NOT_ISSUED',
      'These minutes have not been issued, so there is nothing to correct — edit the draft.',
    );
  }
  if (!input.raisedBy.trim() || !input.what.trim()) {
    throw new DomainError('CORRECTION_UNATTRIBUTED', 'A correction names who raised it and what they say is wrong.');
  }

  write(ctx, {
    eventType: 'MINUTES_CORRECTED',
    entity: { refType: 'SiteMeeting', refId: meetingId },
    nextState: {
      ...record.state,
      corrections: [...state.corrections, { raisedBy: input.raisedBy, what: input.what, at: new Date().toISOString() }],
    },
  });
}

// --- The position -----------------------------------------------------------

export type MeetingPosition = {
  meetings: Array<{
    meetingId: string;
    reference: string;
    type: string;
    title: string;
    heldAt: string;
    status: string;
    attended: number;
    apologies: number;
    openActions: number;
    overdueActions: number;
    corrections: number;
  }>;
  /** Every open action across every meeting, which is what a chair reads first. */
  openActions: Array<MeetingAction & { meeting: string; daysOverdue: number }>;
  summary: string;
};

export function meetingPosition(ctx: EngineContext, today = new Date().toISOString().slice(0, 10)): MeetingPosition {
  authorise(ctx, 'LOOKAHEAD_CONSTRAINTS', 'R');

  const records = ctx.ledger.list(ctx.projectId, 'SiteMeeting');
  const openActions: MeetingPosition['openActions'] = [];

  const meetings = records.map((record) => {
    const state = stateOf(record);
    const open = state.actions.filter((action) => action.status === 'OPEN');
    for (const action of open) {
      const due = action.originallyDue ?? action.by;
      openActions.push({
        ...action,
        meeting: state.reference,
        daysOverdue: Math.max(0, Math.floor((Date.parse(today) - Date.parse(due)) / 86_400_000)),
      });
    }
    return {
      meetingId: state.id,
      reference: state.reference,
      type: state.type,
      title: state.title,
      heldAt: state.heldAt,
      status: state.status,
      attended: state.attendees.filter((attendee) => attendee.attended).length,
      apologies: state.attendees.filter((attendee) => !attendee.attended).length,
      openActions: open.length,
      overdueActions: open.filter((action) => (action.originallyDue ?? action.by) < today).length,
      corrections: state.corrections.length,
    };
  });

  openActions.sort((a, b) => b.daysOverdue - a.daysOverdue);
  const overdue = openActions.filter((action) => action.daysOverdue > 0).length;

  const parts = [`${meetings.length} meeting${meetings.length === 1 ? '' : 's'}`];
  if (openActions.length > 0) parts.push(`${openActions.length} action${openActions.length === 1 ? '' : 's'} open`);
  if (overdue > 0) parts.push(`${overdue} past the date it was agreed for`);

  return { meetings, openActions, summary: parts.join(', ') + '.' };
}
