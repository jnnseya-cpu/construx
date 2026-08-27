import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as decisioncontrol from '../src/domain/decisioncontrol.ts';
import * as meetings from '../src/domain/meetings.ts';
import * as structure from '../src/domain/structure.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * CN-WF-11 — meeting, action, communication and decision control.
 *
 * The meeting record, attendance, agenda, actions with an owner and a date,
 * carry-forward, closure with a note and the correction beside issued minutes
 * were already built and are covered by `meetings.test.ts`. What is tested here
 * is the three things that were not: one action with one identity across every
 * register, minutes that cannot be issued after they have drifted from what was
 * approved, and a decision that says what else was considered.
 */

let platform: Platform;
let seed: SeedResult;

/** Holds LOOKAHEAD_CONSTRAINTS C and U — minutes the meeting. */
const asPlanner = () => platform.context(seed.users.planner!.auth, seed.projectId, { source: 'WEB' });
/** Holds A — chairs, approves, issues and records the decision. */
const asPM = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });
/** Holds R only, and no Legal-L4 clearance. */
const asSafety = () => platform.context(seed.users.safety!.auth, seed.projectId, { source: 'WEB' });

const yesterday = new Date(Date.now() - 86_400_000).toISOString();

function minutedMeeting(title: string): string {
  const { meetingId } = meetings.openMeeting(asPlanner(), {
    type: 'PROGRESS',
    title,
    heldAt: yesterday,
    location: 'Site cabin, north compound',
    chair: 'R. Nolan',
    attendees: [
      { name: 'R. Nolan', organisation: 'Construx', role: 'Project Manager', attended: true },
      { name: 'D. Feeney', organisation: 'Groundworks Ltd', role: 'Site Agent', attended: true },
    ],
  });
  meetings.recordAgendaItem(asPlanner(), meetingId, {
    subject: 'Progress against the four-week lookahead',
    discussion: 'Grid 4-7 slab is two days behind on the reinforcement fix. Recovery agreed by adding a second gang Monday.',
  });
  return meetingId;
}

const DECISION = {
  subject: 'Ground-floor slab construction sequence',
  decision: 'Pour grids 4-7 in two bays with a construction joint on grid 5, rather than a single continuous pour.',
  rationale:
    'A single pour needs a fourteen-hour placement and a night shift the site has no lighting permit for, and the concrete ' +
    'supplier cannot guarantee continuity of supply beyond nine hours.',
  authority: {
    name: 'R. Nolan',
    role: 'Project Manager',
    basis: 'Delegated authority for temporary works and sequence under the project execution plan, clause 4.2.',
  },
  alternatives: [
    { option: 'Single continuous pour across grids 4-7', whyNot: 'Needs a night shift with no lighting permit in place.' },
    { option: 'Three bays with joints on grids 5 and 6', whyNot: 'Adds a second joint through the finished floor slab for no programme benefit.' },
  ],
  impacts: [
    { dimension: 'COST' as const, effect: 'ADVERSE' as const, detail: 'One additional construction joint and waterstop.' },
    { dimension: 'TIME' as const, effect: 'BENEFICIAL' as const, detail: 'Removes the night-shift permit from the critical path.' },
    { dimension: 'QUALITY' as const, effect: 'ADVERSE' as const, detail: 'A joint through a power-floated floor needs a detail agreed with the designer.' },
    { dimension: 'SAFETY' as const, effect: 'BENEFICIAL' as const, detail: 'No night working.' },
    { dimension: 'SCOPE' as const, effect: 'NONE' as const, detail: '' },
  ],
};

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  structure.transitionPhase(platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'CONSTRUCTION',
    justification: 'Running the meeting and decision cycle',
  });
});

describe('CN-WF-11 the register', () => {
  it('registers its two event types, and neither is available to an agent', () => {
    for (const [code, entity] of [
      ['MINUTES_APPROVED', 'MinutesVersion'],
      ['DECISION_RECORDED', 'DecisionRecord'],
      ['DECISION_INSTRUCTION_LINKED', 'DecisionRecord'],
    ] as const) {
      const definition = lookupEventType(code);
      assert.ok(definition, `${code} is not in the catalogue`);
      assert.equal(definition.entity, entity);
      // Governance decisions are human by construction, and no agent mandate
      // exceeds PROPOSE.
      assert.equal(definition.aiAllowed, false);
      assert.equal(definition.group, 'GOVERNANCE');
    }
  });

  it('classifies both under the area that runs the meeting', () => {
    assert.equal(classifyEntity('MinutesVersion')?.area, 'LOOKAHEAD_CONSTRAINTS');
    assert.equal(classifyEntity('DecisionRecord')?.area, 'LOOKAHEAD_CONSTRAINTS');
  });
});

describe('AC-CN-WF-11-02 minutes preserve the exact approved version', () => {
  it('does not require approval on a project that has never approved a set', () => {
    // The guard binds only where the workflow is in use, so it cannot impose a
    // step on a project that predates it. This must run before the first
    // approval on this project, and does.
    const meetingId = minutedMeeting('Weekly progress — before approvals are in use');
    assert.equal(decisioncontrol.minutesIssueBlockedReason(asPM(), meetingId), null);
    assert.ok(meetings.issueMinutes(asPM(), meetingId).issuedAt);
  });

  it('hashes exactly what was approved, and issue then succeeds', () => {
    const meetingId = minutedMeeting('Weekly progress — approved then issued');
    const approval = decisioncontrol.approveMinutes(asPM(), meetingId, { approvedBy: 'R. Nolan' });
    assert.match(approval.contentHash, /^sha256:[0-9a-f]{64}$/);

    assert.equal(decisioncontrol.minutesIssueBlockedReason(asPM(), meetingId), null);
    assert.ok(meetings.issueMinutes(asPM(), meetingId).issuedAt);

    const version = decisioncontrol.approvedVersionOf(asPM(), meetingId)!;
    assert.equal(version.approvedBy, 'R. Nolan');
    assert.equal(version.content.agenda instanceof Array, true);
  });

  it('refuses to issue minutes that have changed since they were approved', () => {
    const meetingId = minutedMeeting('Weekly progress — amended after approval');
    decisioncontrol.approveMinutes(asPM(), meetingId, { approvedBy: 'R. Nolan' });

    // The classic abuse: an action quietly added to the approved text.
    meetings.recordAction(asPlanner(), meetingId, {
      what: 'Groundworks to submit a revised sequence for the slab',
      owner: 'D. Feeney',
      ownerOrganisation: 'Groundworks Ltd',
      by: new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10),
    });

    const refusal = throwsCode(() => meetings.issueMinutes(asPM(), meetingId), 'MINUTES_NOT_APPROVED');
    assert.match(refusal.message ?? '', /changed since/);

    // Approving the amended text records a second version beside the first, and
    // the earlier approval is not overwritten by it.
    decisioncontrol.approveMinutes(asPM(), meetingId, { approvedBy: 'R. Nolan' });
    assert.ok(meetings.issueMinutes(asPM(), meetingId).issuedAt);
  });

  it('refuses to issue a meeting nobody approved once the project approves minutes', () => {
    const meetingId = minutedMeeting('Weekly progress — never approved');
    const refusal = throwsCode(() => meetings.issueMinutes(asPM(), meetingId), 'MINUTES_NOT_APPROVED');
    assert.match(refusal.message ?? '', /has not been approved/);
  });

  it('keeps the approved version fixed while the action register moves on', () => {
    // The whole reason a version is a separate record: closing an action is
    // deliberately permitted after issue, so the meeting's own state stops being
    // what the chair approved the moment anybody discharges anything.
    const meetingId = minutedMeeting('Weekly progress — action closed after issue');
    const { reference } = meetings.recordAction(asPlanner(), meetingId, {
      what: 'Confirm the second gang for Monday',
      owner: 'D. Feeney',
      ownerOrganisation: 'Groundworks Ltd',
      by: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10),
    });
    decisioncontrol.approveMinutes(asPM(), meetingId, { approvedBy: 'R. Nolan' });
    meetings.issueMinutes(asPM(), meetingId);

    meetings.closeAction(asPM(), meetingId, { reference, closureNote: 'Gang confirmed and inducted Friday.' });

    const version = decisioncontrol.approvedVersionOf(asPM(), meetingId)!;
    const approved = version.content.actions.find((action) => action.reference === reference)!;
    assert.equal(approved.what, 'Confirm the second gang for Monday');
    // The version carries the wording, owner and date as agreed — not a status
    // that would have made the snapshot stale the moment the action moved.
    assert.equal('status' in approved, false);
  });

  it('refuses an unsigned approval, and a second approval of unchanged text', () => {
    const meetingId = minutedMeeting('Weekly progress — approval refusals');
    throwsCode(() => decisioncontrol.approveMinutes(asPM(), meetingId, { approvedBy: '  ' }), 'APPROVAL_UNSIGNED');
    decisioncontrol.approveMinutes(asPM(), meetingId, { approvedBy: 'R. Nolan' });
    throwsCode(() => decisioncontrol.approveMinutes(asPM(), meetingId, { approvedBy: 'R. Nolan' }), 'ALREADY_APPROVED');
  });

  it('refuses approval from the role that takes the minutes', () => {
    const meetingId = minutedMeeting('Weekly progress — minute-taker cannot approve');
    throwsCode(() => decisioncontrol.approveMinutes(asPlanner(), meetingId, { approvedBy: 'A. Planner' }), 'ACCESS_DENIED');
  });
});

describe('AC-CN-WF-11-03 a decision with alternatives on it', () => {
  it('records the authority, the rationale, what else was considered and the impact of each', () => {
    const { reference } = decisioncontrol.recordDecision(asPM(), DECISION);
    assert.match(reference, /^DR-\d{4}$/);

    const position = decisioncontrol.decisionControlPosition(asPM());
    const recorded = position.decisions.find((entry) => entry.reference === reference)!;
    assert.equal(recorded.authority, 'R. Nolan (Project Manager)');
    assert.equal(recorded.alternativesConsidered, 2);
    assert.deepEqual(recorded.adverseImpacts, ['COST', 'QUALITY']);
  });

  it('refuses a decision with nothing else considered', () => {
    const refusal = throwsCode(
      () => decisioncontrol.recordDecision(asPM(), { ...DECISION, alternatives: [] }),
      'ALTERNATIVES_REQUIRED',
    );
    assert.match(refusal.message ?? '', /instruction being minuted/);
  });

  it('refuses an alternative listed with no reason it was not taken', () => {
    throwsCode(
      () =>
        decisioncontrol.recordDecision(asPM(), {
          ...DECISION,
          alternatives: [{ option: 'Precast planks', whyNot: '   ' }],
        }),
      'ALTERNATIVE_UNEXPLAINED',
    );
  });

  it('refuses a dimension nobody assessed, and accepts one assessed as none', () => {
    // The distinction the rule exists for: an impact nobody looked at and an
    // impact somebody assessed as nil are indistinguishable when the field is
    // simply left out.
    const refusal = throwsCode(
      () =>
        decisioncontrol.recordDecision(asPM(), {
          ...DECISION,
          impacts: DECISION.impacts.filter((impact) => impact.dimension !== 'SAFETY'),
        }),
      'IMPACTS_UNASSESSED',
    );
    assert.match(refusal.message ?? '', /safety/);
    assert.match(refusal.message ?? '', /Record NONE where there is none/);
  });

  it('refuses an adverse impact with nothing said about it', () => {
    throwsCode(
      () =>
        decisioncontrol.recordDecision(asPM(), {
          ...DECISION,
          impacts: DECISION.impacts.map((impact) =>
            impact.dimension === 'COST' ? { ...impact, detail: '  ' } : impact,
          ),
        }),
      'IMPACT_UNQUANTIFIED',
    );
  });

  it('refuses a decision attributed to nobody, and one with no reasoning', () => {
    throwsCode(
      () =>
        decisioncontrol.recordDecision(asPM(), {
          ...DECISION,
          authority: { ...DECISION.authority, basis: '  ' },
        }),
      'AUTHORITY_REQUIRED',
    );
    throwsCode(() => decisioncontrol.recordDecision(asPM(), { ...DECISION, rationale: 'Agreed.' }), 'RATIONALE_REQUIRED');
  });

  it('never turns a decision into an instruction, and says which are waiting for one', () => {
    // The specification's guardrail. `informationcontrol.issueInstruction` is the
    // only thing that issues an instruction and a person calls it; this records
    // the reference afterwards.
    const { decisionId, reference } = decisioncontrol.recordDecision(asPM(), {
      ...DECISION,
      subject: 'Relocation of the site accommodation',
      requiresInstruction: true,
    });

    let position = decisioncontrol.decisionControlPosition(asPM());
    assert.ok(position.awaitingInstruction.includes(reference));
    assert.match(position.summary, /awaiting an instruction/);

    decisioncontrol.linkInstruction(asPM(), decisionId, { instructionReference: 'INS-0007' });
    position = decisioncontrol.decisionControlPosition(asPM());
    assert.ok(!position.awaitingInstruction.includes(reference));

    throwsCode(
      () => decisioncontrol.linkInstruction(asPM(), decisionId, { instructionReference: 'INS-0008' }),
      'INSTRUCTION_ALREADY_LINKED',
    );
  });

  it('withholds a legally privileged decision from a role without the clearance', () => {
    // The exception control: sensitive or legal discussion receives a restricted
    // classification. The safety manager reads the meeting and the actions and
    // does not read this.
    const { reference } = decisioncontrol.recordDecision(asPM(), {
      ...DECISION,
      subject: 'Position on the delay claim ahead of the adjudication',
      confidentiality: 'LEGAL_L4',
    });

    assert.ok(decisioncontrol.decisionControlPosition(asPM()).decisions.some((d) => d.reference === reference));
    const restricted = decisioncontrol.decisionControlPosition(asSafety());
    assert.ok(!restricted.decisions.some((d) => d.reference === reference));
    // Withheld, not refused — the rest of the position still answers.
    assert.ok(restricted.actions.length > 0);
  });

  it('refuses to record a decision from a role that only reads the meeting', () => {
    throwsCode(() => decisioncontrol.recordDecision(asPlanner(), DECISION), 'ACCESS_DENIED');
  });
});

describe('AC-CN-WF-11-01 one action, one identity', () => {
  it('gathers actions from every register and gives each exactly one row', () => {
    const register = decisioncontrol.actionRegister(asPM());
    const ids = register.map((action) => action.actionId);
    assert.equal(new Set(ids).size, ids.length, 'an action appears more than once');

    // The demo project raises actions in more than one place, and the register
    // is the first thing that reads them together.
    const sources = new Set(register.map((action) => action.source));
    assert.ok(sources.size > 1, `only ${[...sources].join(', ')} reached the register`);
  });

  it('derives the identity from the source rather than allocating a new one', () => {
    const meetingId = minutedMeeting('Weekly progress — stable identity');
    const { reference } = meetings.recordAction(asPlanner(), meetingId, {
      what: 'Issue the revised temporary works design',
      owner: 'K. Osei',
      ownerOrganisation: 'Construx',
      by: new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10),
    });

    const first = decisioncontrol.actionRegister(asPM()).find((action) => action.actionId === reference);
    assert.ok(first, 'the action did not reach the register under its own reference');
    assert.equal(first.source, 'MEETING');

    // Read again after the register has moved on: the identity is the same
    // because it is derived, not allocated.
    decisioncontrol.approveMinutes(asPM(), meetingId, { approvedBy: 'R. Nolan' });
    const second = decisioncontrol.actionRegister(asPM()).find((action) => action.actionId === reference);
    assert.equal(second?.actionId, first.actionId);
  });

  it('escalates by how late it is, up the role hierarchy', () => {
    const meetingId = minutedMeeting('Weekly progress — an action long past its date');
    const { reference } = meetings.recordAction(asPlanner(), meetingId, {
      what: 'Close out the temporary works check on the crane base',
      owner: 'K. Osei',
      ownerOrganisation: 'Construx',
      by: new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10),
    });

    const action = decisioncontrol.actionRegister(asPM()).find((entry) => entry.actionId === reference)!;
    assert.ok(action.daysOverdue >= 30);
    assert.equal(action.escalateTo, 'OWNER');

    const position = decisioncontrol.decisionControlPosition(asPM());
    assert.ok(position.escalations.some((entry) => entry.actionId === reference));
    // The same list, read by owner, which is what a role dashboard shows.
    const owner = position.byOwner.find((entry) => entry.owner === 'K. Osei')!;
    assert.ok(owner.overdue >= 1);
  });

  it('does not escalate an action on the day it falls due', () => {
    const meetingId = minutedMeeting('Weekly progress — due today');
    const { reference } = meetings.recordAction(asPlanner(), meetingId, {
      what: 'Confirm the delivery slot for the precast stairs',
      owner: 'P. Ahmed',
      ownerOrganisation: 'Construx',
      by: new Date().toISOString().slice(0, 10),
    });

    const action = decisioncontrol.actionRegister(asPM()).find((entry) => entry.actionId === reference)!;
    assert.equal(action.daysOverdue, 0);
    assert.equal(action.escalateTo, undefined);
  });

  it('omits a source the reader cannot see rather than refusing the whole register', () => {
    // A register that threw on the first safety entry a planner could not read
    // would be unusable for everyone; a safety action still never reaches a role
    // without safety read.
    const planner = decisioncontrol.actionRegister(asPlanner());
    assert.ok(planner.every((action) => action.source !== 'SAFETY_OBSERVATION'));
    assert.ok(planner.some((action) => action.source === 'MEETING'));

    const safety = decisioncontrol.actionRegister(asSafety());
    assert.ok(safety.some((action) => action.source === 'SAFETY_OBSERVATION'));
  });
});
