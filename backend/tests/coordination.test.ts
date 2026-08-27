import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as coordination from '../src/domain/coordination.ts';
import { scoreClashes } from '../src/engines/bim.ts';
import * as structure from '../src/domain/structure.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * D-WF-04 — multidiscipline coordination, clash and interface control.
 *
 * A clash report is the easiest document in construction to produce and the
 * hardest to act on. Four failures, and the tests are mostly about them.
 *
 * A result nobody can reproduce, because the models moved. Four thousand rows
 * that are forty problems. An accepted clash marked as resolved. And a closed
 * issue that comes back because it was closed on a revision that did not
 * actually fix it.
 */

let platform: Platform;
let seed: SeedResult;

/** Holds BIM_TWIN R, C, U, A, I, X — federates, runs, verifies and accepts. */
const asBim = () => platform.context(seed.users.bim!.auth, seed.projectId, { source: 'WEB' });
/** Holds BIM_TWIN R, C, U, I — federates and resolves; cannot verify or accept. */
const asDesigner = () => platform.context(seed.users.designer!.auth, seed.projectId, { source: 'WEB' });
/** Holds BIM_TWIN R only. */
const asPM = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

/** Two real models off the seeded project, with their real hashes. */
function models(): coordination.FederatedModel[] {
  const held = platform.ledger.list(seed.projectId, 'Model');
  return held.slice(0, 2).map((record, index) => ({
    modelId: record.refId,
    discipline: index === 0 ? 'STRUCTURE' : 'MECHANICAL',
    revision: index === 0 ? 'C' : 'B',
    fileHash: String(record.state.fileHash),
    units: 'MILLIMETRES' as const,
    coordinateSystem: 'OSGB36 / site grid',
  }));
}

/**
 * One problem seen four times.
 *
 * A duct through a beam clashes with every rebar it meets, and somebody moves
 * the duct once. Four raw clashes, one issue — that is the arithmetic the whole
 * module exists to do.
 */
const DUCT_THROUGH_BEAM = [1, 2, 3, 4].map((n) => ({
  elementA: `guid-beam-${n}`,
  elementB: 'guid-duct-14',
  disciplineA: 'STRUCTURE',
  disciplineB: 'MECHANICAL',
  systemA: 'Primary beams',
  systemB: 'Supply air',
  overlapVolume: 0.4,
  location: 'Gallery, grid D2',
}));

/** A second, smaller problem somewhere else. */
const PIPE_THROUGH_WALL = [
  {
    elementA: 'guid-wall-3',
    elementB: 'guid-pipe-88',
    disciplineA: 'ARCHITECTURE',
    disciplineB: 'MECHANICAL',
    systemA: 'Partitions',
    systemB: 'Chilled water',
    overlapVolume: 0.02,
    location: 'Plant room, grid B7',
  },
];

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);

  // BIM_TWIN is not phase-gated, but the demo finishes in OPERATIONS and
  // coordination is a design act — running it there would be a process error
  // the platform does not catch, so the fixture puts the project where the
  // workflow actually happens.
  structure.transitionPhase(platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'DESIGN',
    justification: 'Reopened to coordinate the federated models',
  });
});

// ── The record ──────────────────────────────────────────────────────────────

describe('coordination · the record', () => {
  it('registers its events across three entities', () => {
    for (const [code, entity] of [
      ['MODEL_FEDERATION_CREATED', 'FederationSet'],
      ['CLASH_RUN_COMPLETED', 'ClashRun'],
      ['COORDINATION_ISSUE_ASSIGNED', 'CoordinationIssue'],
      ['COORDINATION_ISSUE_REOPENED', 'CoordinationIssue'],
      ['COORDINATION_ISSUE_ACCEPTED', 'CoordinationIssue'],
      ['ISSUE_VERIFIED', 'CoordinationIssue'],
    ] as const) {
      const definition = lookupEventType(code);
      assert.ok(definition, `${code} is not in the catalogue`);
      assert.equal(definition.entity, entity);
      // No AI-only closure. The specification says so and it is the right rule:
      // an agent may cluster and explain clashes, and may not decide one is gone.
      assert.equal(definition.aiAllowed, false, `${code} must not be AI-authorable`);
    }
  });

  it('gives acceptance its own event, distinct from resolution', () => {
    // An audit reading the ledger must be able to tell a clash somebody fixed
    // from one somebody decided to live with, without inspecting state.
    assert.notEqual(lookupEventType('COORDINATION_ISSUE_ACCEPTED')?.code, lookupEventType('CLASH_RESOLVED')?.code);
    assert.equal(lookupEventType('COORDINATION_ISSUE_ACCEPTED')?.entity, 'CoordinationIssue');
    assert.equal(lookupEventType('CLASH_RESOLVED')?.entity, 'Clash');
  });

  it('classifies all three under BIM', () => {
    for (const entity of ['FederationSet', 'ClashRun', 'CoordinationIssue']) {
      assert.equal(classifyEntity(entity)?.area, 'BIM_TWIN', `${entity} is misclassified`);
    }
  });
});

// ── A run nobody can reproduce ──────────────────────────────────────────────

describe('coordination · the federation set commits to bytes, not to labels', () => {
  it('refuses a set of one, because one model clashes with nothing', () => {
    throwsCode(
      () => coordination.createFederationSet(asBim(), { reference: 'FED-X', models: models().slice(0, 1) }),
      'FEDERATION_TOO_SMALL',
    );
  });

  it('refuses a model that is not on this project', () => {
    throwsCode(
      () =>
        coordination.createFederationSet(asBim(), {
          reference: 'FED-X',
          models: [{ ...models()[0]!, modelId: '01ZZZZZZZZZZZZZZZZZZZZZZZZ' }, models()[1]!],
        }),
      'MODEL_NOT_FOUND',
    );
  });

  it('refuses a hash that does not match the model the platform holds', () => {
    const refusal = throwsCode(
      () =>
        coordination.createFederationSet(asBim(), {
          reference: 'FED-X',
          models: [{ ...models()[0]!, fileHash: `sha256:${'0'.repeat(64)}` }, models()[1]!],
        }),
      'MODEL_HASH_MISMATCH',
    );
    assert.match(String(refusal.message), /"revision C" is a name somebody typed and a hash is not/);
  });

  it('refuses models in different units', () => {
    // Thousands of clashes that are all one error, with the real ones somewhere
    // in the middle of them.
    const mixed = models();
    mixed[1] = { ...mixed[1]!, units: 'METRES' };
    const refusal = throwsCode(
      () => coordination.createFederationSet(asBim(), { reference: 'FED-X', models: mixed }),
      'UNIT_MISMATCH',
    );
    assert.match(String(refusal.message), /STRUCTURE in millimetres, MECHANICAL in metres/);
  });

  it('refuses models on different coordinate systems', () => {
    const mixed = models();
    mixed[1] = { ...mixed[1]!, coordinateSystem: 'Project origin 0,0' };
    const refusal = throwsCode(
      () => coordination.createFederationSet(asBim(), { reference: 'FED-X', models: mixed }),
      'COORDINATE_MISMATCH',
    );
    assert.match(String(refusal.message), /a measurement of the misalignment rather than of the design/);
  });

  it('forms one from exact revisions and hashes', () => {
    const formed = coordination.createFederationSet(asBim(), { reference: 'FED-01', models: models() });
    assert.equal(formed.models, 2);
    const row = coordination.coordinationPosition(asPM()).federations.find((f) => f.reference === 'FED-01');
    assert.equal(row?.units, 'MILLIMETRES');
  });
});

// ── Four thousand rows are forty problems ───────────────────────────────────

describe('coordination · raw clashes are grouped into the thing somebody fixes', () => {
  let federationSetId: string;

  before(() => {
    federationSetId = coordination.createFederationSet(asBim(), { reference: 'FED-GROUP', models: models() }).federationSetId;
  });

  it('makes one issue out of the same problem counted four times', () => {
    const run = coordination.runClashDetection(asBim(), federationSetId, {
      ruleSet: 'Hard clash, 0mm tolerance; clearance rules per BSRIA BG6',
      clashes: [...DUCT_THROUGH_BEAM, ...PIPE_THROUGH_WALL],
    });
    assert.equal(run.clashes, 5);
    assert.equal(run.issues, 2);
    assert.equal(run.newIssues, 2);
  });

  it('identifies the same problem however the clash engine ordered the pair', () => {
    // A duct through a beam and a beam through a duct are one problem, and a
    // register that treated them as two would double every count in it.
    assert.equal(
      coordination.signatureOf({ location: 'Gallery, grid D2', systemA: 'Primary beams', systemB: 'Supply air' }),
      coordination.signatureOf({ location: 'gallery, GRID D2', systemA: 'supply air', systemB: 'primary beams' }),
    );
  });

  it('takes its severity from the BIM engine rather than a scale of its own', () => {
    // Two severity scales over one set of clashes would let the same overlap
    // read CRITICAL on one screen and MEDIUM on another.
    const expected = scoreClashes(DUCT_THROUGH_BEAM)[0]!.severity;
    const issue = coordination
      .coordinationPosition(asPM())
      .issues.find((entry) => entry.location === 'Gallery, grid D2');
    assert.equal(issue?.severity, expected);
    assert.equal(issue?.clashCount, 4);
  });

  it('refuses a run with no rule set behind it', () => {
    const refusal = throwsCode(
      () => coordination.runClashDetection(asBim(), federationSetId, { ruleSet: '  ', clashes: DUCT_THROUGH_BEAM }),
      'RULE_SET_REQUIRED',
    );
    assert.match(String(refusal.message), /whether the difference is the design or the settings/);
  });

  it('copies the exact model revisions onto the run itself', () => {
    // AC-D-WF-04-01. A run that pointed at its set and nothing else would stop
    // being readable the moment anything happened to the set.
    const run = platform.ledger.list(seed.projectId, 'ClashRun').at(-1);
    const onRun = run!.state.models as Array<Record<string, unknown>>;
    assert.equal(onRun.length, 2);
    assert.ok(onRun.every((entry) => String(entry.fileHash).startsWith('sha256:')));
    assert.deepEqual(onRun.map((entry) => entry.revision).sort(), ['B', 'C']);
  });
});

// ── The lifecycle ───────────────────────────────────────────────────────────

describe('coordination · an issue is owned, resolved and verified by different people', () => {
  let issueId: string;

  before(() => {
    const federationSetId = coordination.createFederationSet(asBim(), { reference: 'FED-LIFE', models: models() })
      .federationSetId;
    coordination.runClashDetection(asBim(), federationSetId, {
      ruleSet: 'Hard clash, 0mm tolerance',
      clashes: DUCT_THROUGH_BEAM,
    });
    issueId = coordination
      .coordinationPosition(asPM())
      .issues.find((entry) => entry.state === 'OPEN' && entry.location === 'Gallery, grid D2')!.issueId;
  });

  it('refuses an issue owned by a discipline rather than a person', () => {
    const refusal = throwsCode(
      () =>
        coordination.assignIssue(asDesigner(), issueId, {
          owner: '',
          affectedParties: ['Halden MEP'],
          by: day(14),
          targetRevision: 'D',
        }),
      'ISSUE_UNOWNED',
    );
    assert.match(String(refusal.message), /every member of it believes somebody else has/);
  });

  it('refuses one that names nobody on the other side of the clash', () => {
    throwsCode(
      () =>
        coordination.assignIssue(asDesigner(), issueId, {
          owner: 'K. Adeyemi',
          affectedParties: [],
          by: day(14),
          targetRevision: 'D',
        }),
      'AFFECTED_PARTIES_REQUIRED',
    );
  });

  it('refuses one with no target revision for the next run to check', () => {
    const refusal = throwsCode(
      () =>
        coordination.assignIssue(asDesigner(), issueId, {
          owner: 'K. Adeyemi',
          affectedParties: ['Caldervale Engineering'],
          by: day(14),
          targetRevision: '',
        }),
      'TARGET_REVISION_REQUIRED',
    );
    assert.match(String(refusal.message), /"fixed" becomes a claim/);
  });

  it('assigns it, and walks the ladder in order', () => {
    coordination.assignIssue(asDesigner(), issueId, {
      owner: 'K. Adeyemi',
      affectedParties: ['Caldervale Engineering', 'Halden MEP'],
      by: day(14),
      targetRevision: 'D',
    });
    assert.equal(
      coordination.advanceIssue(asDesigner(), issueId, { to: 'IN_RESOLUTION', note: 'Duct rerouted below the beam soffit.' })
        .state,
      'IN_RESOLUTION',
    );
    assert.equal(
      coordination.advanceIssue(asDesigner(), issueId, {
        to: 'READY_FOR_VERIFICATION',
        note: 'Issued at MEP revision D for checking against the structural model.',
      }).state,
      'READY_FOR_VERIFICATION',
    );
  });

  it('refuses a jump that skips a state, and says what is permitted', () => {
    const refusal = throwsCode(
      () => coordination.advanceIssue(asBim(), issueId, { to: 'CLOSED', note: 'Done' }),
      'ISSUE_TRANSITION_REFUSED',
    );
    assert.match(String(refusal.message), /permitted moves are verified or in resolution/);
  });

  it('will not let the party who says they fixed it verify that it is fixed', () => {
    // The designer holds C and U on this area and not A. Verifying that a clash
    // is actually gone is the coordination authority's, not the party's.
    assert.throws(
      () => coordination.advanceIssue(asDesigner(), issueId, { to: 'VERIFIED', note: 'It is fine now' }),
      /ACCESS_DENIED|No role/,
    );
  });

  it('lets verification send it back, which is why the state exists', () => {
    coordination.advanceIssue(asBim(), issueId, {
      to: 'IN_RESOLUTION',
      note: 'Checked against structural revision C: the duct still clips the beam at the second bay.',
    });
    coordination.advanceIssue(asDesigner(), issueId, { to: 'READY_FOR_VERIFICATION', note: 'Reissued at revision E.' });
    assert.equal(coordination.advanceIssue(asBim(), issueId, { to: 'VERIFIED', note: 'Confirmed clear.' }).state, 'VERIFIED');
  });

  it('refuses a step with nothing written against it', () => {
    throwsCode(() => coordination.advanceIssue(asBim(), issueId, { to: 'CLOSED', note: '   ' }), 'NOTE_REQUIRED');
    coordination.advanceIssue(asBim(), issueId, { to: 'CLOSED', note: 'Closed against MEP revision E.' });
  });
});

// ── Accepted is not resolved ────────────────────────────────────────────────

describe('coordination · an accepted clash is never marked resolved', () => {
  let issueId: string;

  before(() => {
    const federationSetId = coordination.createFederationSet(asBim(), { reference: 'FED-ACCEPT', models: models() })
      .federationSetId;
    coordination.runClashDetection(asBim(), federationSetId, {
      ruleSet: 'Hard clash, 0mm tolerance',
      clashes: PIPE_THROUGH_WALL,
    });
    issueId = coordination
      .coordinationPosition(asPM())
      .issues.find((entry) => entry.location === 'Plant room, grid B7')!.issueId;
  });

  it('refuses an acceptance with no reason', () => {
    throwsCode(() => coordination.acceptIssue(asBim(), issueId, { reason: '', riskOwner: 'FM' }), 'ACCEPTANCE_UNEXPLAINED');
  });

  it('refuses one with nobody carrying the risk', () => {
    const refusal = throwsCode(
      () => coordination.acceptIssue(asBim(), issueId, { reason: 'It is a 20mm clip', riskOwner: '  ' }),
      'RISK_OWNER_REQUIRED',
    );
    // Accepting moves the clash out of the model and into somebody's
    // operational life.
    assert.match(String(refusal.message), /the valve cannot be reached/);
  });

  it('will not let the designer accept — that is the coordination authority’s', () => {
    assert.throws(
      () => coordination.acceptIssue(asDesigner(), issueId, { reason: 'Fine', riskOwner: 'FM' }),
      /ACCESS_DENIED|No role/,
    );
  });

  it('records the acceptance without moving the issue to closed', () => {
    const accepted = coordination.acceptIssue(asBim(), issueId, {
      reason:
        'A 20mm overlap between the partition head and the chilled water flow. The partition is a demountable system and ' +
        'the head detail accommodates it; rerouting the pipe would cross the fire compartment line.',
      riskOwner: 'Ashworth Water Authority facilities team',
    });
    // The state is untouched. This is the rule that matters most in the
    // workflow: resolved means the geometry changed.
    assert.equal(accepted.state, 'OPEN');
    assert.equal(accepted.accepted, true);

    const issue = coordination.coordinationPosition(asPM()).issues.find((entry) => entry.issueId === issueId);
    assert.equal(issue?.state, 'OPEN');
    assert.equal(issue?.accepted, true);
    assert.equal(issue?.riskOwner, 'Ashworth Water Authority facilities team');
  });

  it('takes it off the blocker list, because somebody with the authority decided', () => {
    // A blocker list that included decisions would never clear, and a list that
    // never clears stops being read.
    const position = coordination.coordinationPosition(asPM());
    assert.equal(position.blockers.some((entry) => entry.location === 'Plant room, grid B7'), false);
    assert.ok(position.acceptedNotResolved >= 1);
    assert.match(position.summary, /accepted rather than resolved/);
  });

  it('refuses to walk an accepted issue through verification', () => {
    const refusal = throwsCode(
      () => coordination.advanceIssue(asBim(), issueId, { to: 'ASSIGNED', note: 'Carry on' }),
      'ISSUE_ACCEPTED',
    );
    assert.match(String(refusal.message), /nothing to verify, because the geometry did not change/);
  });
});

// ── A closed issue that comes back ──────────────────────────────────────────

describe('coordination · a later run reopens what it finds again', () => {
  let federationSetId: string;
  let issueId: string;

  before(() => {
    federationSetId = coordination.createFederationSet(asBim(), { reference: 'FED-AGAIN', models: models() })
      .federationSetId;
    coordination.runClashDetection(asBim(), federationSetId, {
      ruleSet: 'Hard clash, 0mm tolerance',
      clashes: DUCT_THROUGH_BEAM,
    });
    issueId = coordination
      .coordinationPosition(asPM())
      .issues.find((entry) => entry.state === 'OPEN' && entry.reference.startsWith('FED-AGAIN'))!.issueId;

    coordination.assignIssue(asDesigner(), issueId, {
      owner: 'K. Adeyemi',
      affectedParties: ['Caldervale Engineering'],
      by: day(14),
      targetRevision: 'D',
    });
    coordination.advanceIssue(asDesigner(), issueId, { to: 'IN_RESOLUTION', note: 'Rerouting.' });
    coordination.advanceIssue(asDesigner(), issueId, { to: 'READY_FOR_VERIFICATION', note: 'Issued at revision D.' });
    coordination.advanceIssue(asBim(), issueId, { to: 'VERIFIED', note: 'Clear against revision D.' });
    coordination.advanceIssue(asBim(), issueId, { to: 'CLOSED', note: 'Closed.' });
  });

  it('reopens it when the next run finds it again', () => {
    // Closed on the strength of a revision that did not fix it, which is the
    // commonest way a clash reaches site.
    const again = coordination.runClashDetection(asBim(), federationSetId, {
      ruleSet: 'Hard clash, 0mm tolerance',
      clashes: DUCT_THROUGH_BEAM,
    });
    assert.equal(again.newIssues, 0, 'it was recognised as the same problem, not raised as a new one');
    assert.equal(again.reopened.length, 1);

    const issue = coordination.coordinationPosition(asPM()).issues.find((entry) => entry.issueId === issueId);
    assert.equal(issue?.state, 'OPEN');
    assert.equal(issue?.reopenings, 1);
    assert.equal(issue?.timesSeen, 2);
  });

  it('says on the history what reopened it and what state it had been in', () => {
    const record = platform.ledger.get({ refType: 'CoordinationIssue', refId: issueId });
    const history = record!.state.history as Array<Record<string, unknown>>;
    const reopening = history.at(-1)!;
    assert.equal(reopening.from, 'CLOSED');
    assert.equal(reopening.to, 'OPEN');
    assert.match(String(reopening.note), /Found again by FED-AGAIN\/R2/);
  });

  it('reports what a previous run found and this one did not, rather than closing it', () => {
    // A clash disappearing from a run is evidence, not a decision. Closing on it
    // would let a model somebody broke close forty issues.
    const third = coordination.runClashDetection(asBim(), federationSetId, {
      ruleSet: 'Hard clash, 0mm tolerance',
      clashes: [],
    });
    assert.equal(third.issues, 0);
    assert.ok(third.noLongerFound.length >= 1);

    const issue = coordination.coordinationPosition(asPM()).issues.find((entry) => entry.issueId === issueId);
    assert.equal(issue?.state, 'OPEN', 'a run finding nothing closed an issue');
  });
});

// ── What blocks a gate ──────────────────────────────────────────────────────

describe('coordination · critical and unresolved is a stage blocker', () => {
  it('lists critical issues that are neither resolved nor accepted', () => {
    // AC-D-WF-04-02.
    const position = coordination.coordinationPosition(asPM());
    for (const blocker of position.blockers) {
      const issue = position.issues.find((entry) => entry.reference === blocker.reference)!;
      assert.equal(issue.severity, 'CRITICAL');
      assert.equal(issue.accepted, false);
      assert.equal(['VERIFIED', 'CLOSED'].includes(issue.state), false);
    }
  });

  it('is readable by a role holding only read, and not writable by it', () => {
    assert.ok(coordination.coordinationPosition(asPM()).issues.length > 0);
    assert.throws(
      () => coordination.createFederationSet(asPM(), { reference: 'FED-PM', models: models() }),
      /ACCESS_DENIED|No role/,
    );
  });
});
