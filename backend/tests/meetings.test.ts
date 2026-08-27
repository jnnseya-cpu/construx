import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as meetings from '../src/domain/meetings.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Site meetings and the minutes that come out of them.
 *
 * The record exists because minutes could not otherwise be generated from
 * anything, and a minutes document with no meeting behind it reads exactly like
 * one with a meeting behind it. What is tested here is not that the fields
 * round-trip — it is the four refusals that make the record worth composing a
 * document from.
 */

let platform: Platform;
let seed: SeedResult;

/** Holds LOOKAHEAD_CONSTRAINTS R, C, U — takes the minutes. */
const asPlanner = () => platform.context(seed.users.planner!.auth, seed.projectId, { source: 'WEB' });
/** Holds LOOKAHEAD_CONSTRAINTS R, A — chairs, and issues. */
const asPM = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });
/** Holds LOOKAHEAD_CONSTRAINTS R and nothing else on it — reads, never writes. */
const asSafety = () => platform.context(seed.users.safety!.auth, seed.projectId, { source: 'WEB' });

/**
 * Dates relative to today rather than fixed.
 *
 * `openMeeting` refuses a meeting dated forward — minutes are a record of what
 * happened — so a fixture pinned to a hardcoded year is a fixture that starts
 * failing when the calendar reaches it.
 */
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
const HELD_AT = daysAgo(30);
const HELD_ON = HELD_AT.slice(0, 10);

const ROOM: meetings.Attendee[] = [
  { name: 'A. Okafor', organisation: 'Construx Build Ltd', role: 'Project manager', attended: true },
  { name: 'R. Sandhu', organisation: 'Meridian Developments', role: 'Client representative', attended: true },
  { name: 'T. Brennan', organisation: 'Kestrel Cladding', role: 'Package manager', attended: false },
];

function openProgressMeeting(): string {
  return meetings.openMeeting(asPlanner(), {
    type: 'PROGRESS',
    title: 'Monthly progress meeting',
    heldAt: HELD_AT,
    location: 'Site office, meeting room 1',
    chair: 'A. Okafor',
    attendees: ROOM,
  }).meetingId;
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

// ── The record itself ───────────────────────────────────────────────────────

describe('site meeting · the record', () => {
  it('is registered in the closed event catalogue', () => {
    for (const code of ['MEETING_HELD', 'MEETING_ACTION_CLOSED', 'MINUTES_ISSUED', 'MINUTES_CORRECTED']) {
      const definition = lookupEventType(code);
      assert.ok(definition, `${code} is not in the catalogue`);
      assert.equal(definition.entity, 'SiteMeeting');
      // Nothing about a meeting is authored by an agent. What was agreed in a
      // room is a fact about people, and an AI actor writing it would be
      // inventing testimony.
      assert.equal(definition.aiAllowed, false, `${code} must not be AI-authorable`);
    }
  });

  it('is classified under the area that already governs actions somebody owns', () => {
    assert.equal(classifyEntity('SiteMeeting')?.area, 'LOOKAHEAD_CONSTRAINTS');
  });

  it('references the meeting by type and sequence so the site can cite it', () => {
    const opened = meetings.openMeeting(asPlanner(), {
      type: 'DESIGN_COORDINATION',
      title: 'Cladding interface coordination',
      heldAt: daysAgo(29),
      location: 'Teams',
      chair: 'R. Sandhu',
      attendees: ROOM,
    });
    assert.match(opened.reference, /^DESIGN-\d{3}$/);
  });

  it('records apologies rather than dropping them, because who was absent changes what a decision is', () => {
    const meetingId = openProgressMeeting();
    const position = meetings.meetingPosition(asPM());
    const row = position.meetings.find((meeting) => meeting.meetingId === meetingId);
    assert.equal(row?.attended, 2);
    assert.equal(row?.apologies, 1);
  });
});

// ── The four refusals ───────────────────────────────────────────────────────

describe('site meeting · refuses a meeting nobody was at', () => {
  it('refuses an empty room', () => {
    throwsCode(
      () =>
        meetings.openMeeting(asPlanner(), {
          type: 'PROGRESS',
          title: 'Progress',
          heldAt: HELD_AT,
          location: 'Site office',
          chair: 'A. Okafor',
          attendees: [],
        }),
      'NOBODY_ATTENDED',
    );
  });

  it('refuses a room where every single person sent apologies', () => {
    // Not the same failure as an empty list. A list of six people who all sent
    // apologies is a meeting that was arranged and did not happen, and minuting
    // it would produce a document asserting decisions nobody was there to take.
    throwsCode(
      () =>
        meetings.openMeeting(asPlanner(), {
          type: 'PROGRESS',
          title: 'Progress',
          heldAt: HELD_AT,
          location: 'Site office',
          chair: 'A. Okafor',
          attendees: ROOM.map((attendee) => ({ ...attendee, attended: false })),
        }),
      'EVERYBODY_SENT_APOLOGIES',
    );
  });

  it('refuses a meeting dated in the future', () => {
    // Found by rendering a set of minutes. The document asserted what was
    // agreed at a meeting that had not happened, in exactly the same words it
    // would have used for one that had.
    throwsCode(
      () =>
        meetings.openMeeting(asPlanner(), {
          type: 'PROGRESS',
          title: 'Progress',
          heldAt: daysAgo(-7),
          location: 'Site office',
          chair: 'A. Okafor',
          attendees: ROOM,
        }),
      'MEETING_NOT_YET_HELD',
    );
  });

  it('refuses an agenda heading with nothing recorded under it', () => {
    const meetingId = openProgressMeeting();
    throwsCode(
      () => meetings.recordAgendaItem(asPlanner(), meetingId, { subject: 'Programme', discussion: '   ' }),
      'DISCUSSION_REQUIRED',
    );
  });

  it('refuses an action with no owner and an action with no date', () => {
    const meetingId = openProgressMeeting();
    throwsCode(
      () =>
        meetings.recordAction(asPlanner(), meetingId, {
          what: 'Confirm the cladding delivery sequence',
          owner: '',
          ownerOrganisation: 'Kestrel Cladding',
          by: '2027-06-24',
        }),
      'ACTION_UNOWNED',
    );
    throwsCode(
      () =>
        meetings.recordAction(asPlanner(), meetingId, {
          what: 'Confirm the cladding delivery sequence',
          owner: 'T. Brennan',
          ownerOrganisation: 'Kestrel Cladding',
          by: 'as soon as possible',
        }),
      'ACTION_UNDATED',
    );
  });
});

// ── Carry-forward keeps its own clock ───────────────────────────────────────

describe('site meeting · a carried action keeps the date it was originally given', () => {
  let meetingId: string;

  before(() => {
    meetingId = openProgressMeeting();
    meetings.recordAgendaItem(asPlanner(), meetingId, {
      subject: 'Actions carried forward',
      discussion: 'Two actions from the May meeting remain open and were reviewed in turn.',
    });
  });

  it('reports an action carried from March as months overdue, not as due next fortnight', () => {
    const carried = meetings.recordAction(asPlanner(), meetingId, {
      what: 'Issue the revised roof build-up to the cladding subcontractor',
      owner: 'D. Whyte',
      ownerOrganisation: 'Meridian Design',
      // Re-dated in this meeting, as happens on every register.
      by: daysAgo(-14).slice(0, 10),
      raisedAtMeeting: 'PROGRESS-002',
      originallyDue: daysAgo(112).slice(0, 10),
    });

    // Measured against 20 March, not 24 June. A register that reset the clock on
    // each cycle would report a twelve-week-old failure as entirely healthy —
    // which is exactly how registers full of overdue actions report themselves
    // as clean.
    assert.equal(carried.daysOverdue, 82);

    const position = meetings.meetingPosition(asPM(), HELD_ON);
    const open = position.openActions.find((action) => action.reference === carried.reference);
    assert.equal(open?.daysOverdue, 82);
  });

  it('sorts the open action list by how far past its date it is, not by when it was raised', () => {
    meetings.recordAction(asPlanner(), meetingId, {
      what: 'Book the concrete pour inspection',
      owner: 'S. Iqbal',
      ownerOrganisation: 'Construx Build Ltd',
      by: daysAgo(-35).slice(0, 10),
    });

    const position = meetings.meetingPosition(asPM(), HELD_ON);
    const overdue = position.openActions.map((action) => action.daysOverdue);
    assert.deepEqual([...overdue].sort((a, b) => b - a), overdue);
    assert.equal(position.openActions[0]?.daysOverdue, 82);
  });
});

// ── Issue, and what issue means ─────────────────────────────────────────────

describe('site meeting · minutes are issued once', () => {
  let meetingId: string;

  before(() => {
    meetingId = openProgressMeeting();
    meetings.recordAgendaItem(asPlanner(), meetingId, {
      subject: 'Health and safety',
      discussion: 'No RIDDOR-reportable events in the period. Two near misses were reviewed and both are closed.',
    });
    meetings.recordAction(asPlanner(), meetingId, {
      what: 'Reissue the site induction slides with the revised traffic route',
      owner: 'M. Osei',
      ownerOrganisation: 'Construx Build Ltd',
      by: daysAgo(-4).slice(0, 10),
    });
  });

  it('refuses to issue minutes of a meeting where nothing was recorded as discussed', () => {
    const empty = openProgressMeeting();
    throwsCode(() => meetings.issueMinutes(asPM(), empty), 'NOTHING_MINUTED');
  });

  it('will not let the minute-taker issue them — the chair holds A, the minute-taker holds U', () => {
    // The split is not invented beside the permission matrix; it falls out of
    // it. The planner who wrote the minutes cannot also be the person who
    // declares them the record of what was agreed.
    assert.throws(() => meetings.issueMinutes(asPlanner(), meetingId), /ACCESS_DENIED|No role/);
  });

  it('issues them, and then refuses every further amendment to the narrative', () => {
    const issued = meetings.issueMinutes(asPM(), meetingId);
    assert.equal(issued.actions, 1);

    throwsCode(
      () => meetings.recordAgendaItem(asPlanner(), meetingId, { subject: 'Late addition', discussion: 'Also agreed.' }),
      'MINUTES_ISSUED',
    );
    throwsCode(
      () =>
        meetings.recordAction(asPlanner(), meetingId, {
          what: 'A thing somebody thought of afterwards',
          owner: 'A. Okafor',
          ownerOrganisation: 'Construx Build Ltd',
          by: daysAgo(-21).slice(0, 10),
        }),
      'MINUTES_ISSUED',
    );
  });

  it('still lets an action be closed after issue, because the register is live and the minutes are not', () => {
    const position = meetings.meetingPosition(asPM());
    const action = position.openActions.find((a) => a.what.startsWith('Reissue the site induction'));
    assert.ok(action);

    meetings.closeAction(asPlanner(), meetingId, {
      reference: action.reference,
      closureNote: 'Slides reissued at revision C on 16 June and the induction pack replaced on site.',
    });

    const after = meetings.meetingPosition(asPM());
    assert.equal(after.openActions.some((a) => a.reference === action.reference), false);
  });

  it('lets the chair close an action too, which the matrix alone would have refused', () => {
    // The PM holds A on this area and not U. Reading the split as "only the
    // minute-taker may touch the register" would mean the chair chasing an
    // action cannot record that it is done, which is the wrong reading of a
    // separation that exists to protect *issuing*.
    const fresh = openProgressMeeting();
    const raised = meetings.recordAction(asPlanner(), fresh, {
      what: 'Confirm the scaffold handover certificate',
      owner: 'L. Grant',
      ownerOrganisation: 'Apex Access',
      by: daysAgo(-10).slice(0, 10),
    });
    meetings.closeAction(asPM(), fresh, {
      reference: raised.reference,
      closureNote: 'Handover certificate 4471 received and filed against the scaffold inspection register.',
    });
    assert.equal(
      meetings.meetingPosition(asPM()).openActions.some((a) => a.reference === raised.reference),
      false,
    );
  });

  it('refuses a closure with nothing said about what was actually done', () => {
    const fresh = openProgressMeeting();
    const raised = meetings.recordAction(asPlanner(), fresh, {
      what: 'Chase the structural calculations',
      owner: 'D. Whyte',
      ownerOrganisation: 'Meridian Design',
      by: daysAgo(-10).slice(0, 10),
    });
    throwsCode(
      () => meetings.closeAction(asPlanner(), fresh, { reference: raised.reference, closureNote: '' }),
      'CLOSURE_NOTE_REQUIRED',
    );
  });
});

// ── Corrections sit beside, never on top ────────────────────────────────────

describe('site meeting · a correction is recorded beside the minutes, not applied to them', () => {
  let meetingId: string;

  before(() => {
    meetingId = openProgressMeeting();
    meetings.recordAgendaItem(asPlanner(), meetingId, {
      subject: 'Commercial',
      discussion: 'The client confirmed valuation 11 would be certified at the sum applied for.',
    });
    meetings.issueMinutes(asPM(), meetingId);
  });

  it('refuses a correction against minutes that were never issued', () => {
    const draft = openProgressMeeting();
    throwsCode(
      () => meetings.recordCorrection(asPlanner(), draft, { raisedBy: 'R. Sandhu', what: 'Not what was said' }),
      'MINUTES_NOT_ISSUED',
    );
  });

  it('records the objection without touching the sentence objected to', () => {
    meetings.recordCorrection(asPlanner(), meetingId, {
      raisedBy: 'R. Sandhu, Meridian Developments',
      what: 'The client confirmed no such thing; certification remains subject to the QS assessment.',
    });

    const record = platform.ledger.get({ refType: 'SiteMeeting', refId: meetingId });
    const state = record!.state as unknown as { agenda: Array<{ discussion: string }>; corrections: unknown[] };
    // Both readable, neither overwritten. Somebody disagreeing with what the
    // minutes say is itself a fact about the meeting, and a platform that
    // rewrote the text would destroy the only thing minutes are for.
    assert.match(state.agenda[0]!.discussion, /would be certified at the sum applied for/);
    assert.equal(state.corrections.length, 1);
  });

  it('refuses an anonymous correction', () => {
    throwsCode(
      () => meetings.recordCorrection(asPlanner(), meetingId, { raisedBy: '  ', what: 'Wrong' }),
      'CORRECTION_UNATTRIBUTED',
    );
  });
});

// ── Reading it ──────────────────────────────────────────────────────────────

describe('site meeting · the position', () => {
  it('is readable by a role that holds nothing but R on the area', () => {
    // The safety lead holds LOOKAHEAD_CONSTRAINTS R only. Somebody who has to
    // act on an action out of a meeting must be able to read the register
    // without being able to write to it.
    const position = meetings.meetingPosition(asSafety());
    assert.ok(position.meetings.length > 0);
    assert.match(position.summary, /meetings/);
  });

  it('refuses a meeting record from a role with no write on the area at all', () => {
    assert.throws(
      () =>
        meetings.openMeeting(asSafety(), {
          type: 'PROGRESS',
          title: 'Progress',
          heldAt: HELD_AT,
          location: 'Site office',
          chair: 'A. Okafor',
          attendees: ROOM,
        }),
      /ACCESS_DENIED|No role/,
    );
  });
});
