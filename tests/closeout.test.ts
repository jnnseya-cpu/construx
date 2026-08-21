import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as bim from '../src/engines/bim.ts';
import * as planning from '../src/engines/planning.ts';
import * as structure from '../src/domain/structure.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Closing things out.
 *
 * Three registers in this platform could previously only grow: clashes, site
 * observations and — because a work package could only arrive as a by-product
 * of AI-generated WBS — the scope breakdown itself. A list that only rises
 * stops being read, and the critical item sitting in it goes to site.
 *
 * The tests that matter here are not that closing works. They are that closing
 * cannot be used to make a register look better than the job: a critical clash
 * cannot be waved through as a false positive without saying why at length, and
 * an observation cannot claim an action nobody owns.
 */

let platform: Platform;
let seed: SeedResult;

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);

  // Field and design writes are phase-gated in operations. Reopening is the
  // gate working rather than a fixture trick — the same move the consistency
  // suite makes, and for the same reason.
  structure.transitionPhase(platform.context(seed.users.admin!.auth, seed.projectId), {
    to: 'CONSTRUCTION',
    justification: 'Reopened to exercise clash and observation closeout',
  });

  // The seed detects three clashes and these tests close more than three, so
  // they bring their own rather than competing with it for supply. Severity is
  // derived from discipline and overlap, so a structural clash with a large
  // overlap is reliably critical.
  const models = platform.ledger.list(seed.projectId, 'Model');
  await bim.detectClashes(ctx('bim'), {
    modelAId: models[0]!.refId,
    modelBId: models[1]!.refId,
    clashes: Array.from({ length: 6 }, (_, i) => ({
      elementA: `RC-BEAM-${100 + i}`,
      elementB: `DN300-PIPE-${i}`,
      disciplineA: 'STRUCTURE',
      disciplineB: 'MECHANICAL',
      overlapVolume: 0.55,
      location: `Test grid ${i}`,
    })),
  });
});

const ctx = (who: string) => platform.context(seed.users[who]!.auth, seed.projectId);

/** The next clash nobody has closed yet, so each test gets its own. */
function openClash(severity?: string) {
  return platform.ledger
    .list(seed.projectId, 'Clash')
    .find((c) => c.state.status === 'OPEN' && (severity === undefined || c.state.severity === severity));
}

describe('a clash register that can be closed', () => {
  it('records which discipline moved, because that is who pays', () => {
    const clash = openClash();
    assert.ok(clash, 'the seed detects clashes');

    const modelId = platform.ledger.list(seed.projectId, 'Model')[0]!.refId;
    const result = bim.resolveClash(ctx('bim'), {
      clashId: clash.refId,
      method: 'MODEL_REVISED',
      movedDiscipline: String(clash.state.disciplineB),
      resolvedInModelId: modelId,
      justification: 'Services rerouted below the transfer beam and reissued at revision C.',
      resolvedBy: 'BIM coordinator',
      evidenceHash: 'sha256:'.padEnd(71, 'a'),
    });

    assert.equal(result.method, 'MODEL_REVISED');
    assert.equal(result.modelNowOutOfDate, false);

    const after = platform.ledger.require({ refType: 'Clash', refId: clash.refId });
    assert.equal(after.state.status, 'RESOLVED');
    assert.equal(after.state.movedDiscipline, String(clash.state.disciplineB));
  });

  it('refuses a model revision that names a discipline not party to the clash', () => {
    const clash = openClash();
    assert.ok(clash);
    const modelId = platform.ledger.list(seed.projectId, 'Model')[0]!.refId;

    throwsCode(
      () =>
        bim.resolveClash(ctx('bim'), {
          clashId: clash.refId,
          method: 'MODEL_REVISED',
          movedDiscipline: 'LANDSCAPE',
          resolvedInModelId: modelId,
          justification: 'Landscape moved their planters out of the way of it.',
          resolvedBy: 'BIM coordinator',
          evidenceHash: 'sha256:'.padEnd(71, 'b'),
        }),
      'CLASH_DISCIPLINE_NOT_IN_CLASH',
    );
  });

  it('refuses a model revision with no model to point at', () => {
    const clash = openClash();
    assert.ok(clash);

    throwsCode(
      () =>
        bim.resolveClash(ctx('bim'), {
          clashId: clash.refId,
          method: 'MODEL_REVISED',
          movedDiscipline: String(clash.state.disciplineA),
          justification: 'Structure moved the opening, it is all sorted now.',
          resolvedBy: 'BIM coordinator',
          evidenceHash: 'sha256:'.padEnd(71, 'c'),
        }),
      'CLASH_RESOLUTION_UNANCHORED',
    );
  });

  it('makes dismissing a critical clash cost an explanation', () => {
    // The cheapest way to make a clash register look healthy is to mark the
    // expensive ones as detection artefacts. It is allowed — false positives
    // are real and common — but not in six words.
    const critical = openClash('CRITICAL');
    assert.ok(critical, 'the fixture detects critical clashes');

    throwsCode(
      () =>
        bim.resolveClash(ctx('bim'), {
          clashId: critical.refId,
          method: 'NOT_A_CLASH',
          justification: 'Not a real clash.',
          resolvedBy: 'BIM coordinator',
          evidenceHash: 'sha256:'.padEnd(71, 'd'),
        }),
      'CRITICAL_CLASH_DISMISSAL_UNEXPLAINED',
    );
  });

  it('will not close the same clash twice', () => {
    const clash = openClash();
    assert.ok(clash);
    const modelId = platform.ledger.list(seed.projectId, 'Model')[0]!.refId;

    const close = () =>
      bim.resolveClash(ctx('bim'), {
        clashId: clash.refId,
        method: 'MODEL_REVISED',
        movedDiscipline: String(clash.state.disciplineA),
        resolvedInModelId: modelId,
        justification: 'Opening enlarged and the duct now passes through it cleanly.',
        resolvedBy: 'BIM coordinator',
        evidenceHash: 'sha256:'.padEnd(71, 'e'),
      });

    close();
    throwsCode(close, 'CLASH_ALREADY_RESOLVED');
  });

  it('reports a site resolution as leaving the model behind', () => {
    const clash = openClash();
    assert.ok(clash);

    const result = bim.resolveClash(ctx('bim'), {
      clashId: clash.refId,
      method: 'RESOLVED_ON_SITE',
      justification: 'Duct dropped 150mm under the beam on site; model not updated to suit.',
      resolvedBy: 'Site engineer',
      evidenceHash: 'sha256:'.padEnd(71, 'f'),
    });

    assert.equal(result.modelNowOutOfDate, true);
    assert.ok(bim.clashPosition(ctx('bim')).modelOutOfDate >= 1);
  });

  it('reports the position by what is still critical, not by the total', () => {
    const position = bim.clashPosition(ctx('bim'));

    assert.ok(position.total > 0);
    assert.equal(position.open + position.resolved, position.total);
    assert.ok((position.byMethod.MODEL_REVISED ?? 0) >= 1);
    assert.ok(typeof position.averageDaysToResolve === 'number', 'something has been resolved, so there is an average');
    assert.ok(position.summary.length > 20);
  });

  it('refuses closeout to a role without clash approval', () => {
    // The BIM coordinator owns closeout of the federated model. Everybody else
    // can read the register; certifying that a fix landed in it is one role's
    // job, because it is the record a later rework argument runs on.
    const clash = openClash();
    assert.ok(clash);

    assert.throws(
      () =>
        bim.resolveClash(ctx('planner'), {
          clashId: clash.refId,
          method: 'WITHIN_TOLERANCE',
          justification: 'Overlap is insulation thickness, within the permitted tolerance.',
          resolvedBy: 'Planner',
          evidenceHash: 'sha256:'.padEnd(71, '1'),
        }),
      /No role of PLANNER holds "A" on BIM_TWIN/,
    );
  });
});

describe('a work package somebody typed in', () => {
  it('creates one without generating a WBS first', () => {
    const result = planning.createWorkPackage(ctx('planner'), {
      wbsCode: 'MAN-100',
      title: 'Temporary works to the north cofferdam',
      indicativeDurationDays: 24,
      scopeNarrative: 'Design, install, monitor and remove the sheet-piled cofferdam.',
      responsibleParty: 'Temporary works coordinator',
    });

    assert.equal(result.wbsCode, 'MAN-100');
    assert.equal(result.depth, 0);

    const record = platform.ledger.require({ refType: 'WorkPackage', refId: result.workPackageId });
    assert.equal(record.state.origin, 'MANUAL');
    assert.equal(record.state.requiresPlannerApproval, false, 'a person defined it deliberately');
  });

  it('keeps the origin distinguishable from a generated one', async () => {
    // Which packages a person defined and which a model proposed is asked at
    // every baseline review, and cannot be answered from a list that treats
    // them the same.
    await planning.generateWBS(ctx('planner'), {
      projectType: 'Water treatment works',
      sectorType: 'INFRASTRUCTURE',
      scopeNarrative: 'Phase 2 treatment capacity uplift with a new inlet works and filter gallery.',
      targetDurationDays: 300,
    });

    const packages = platform.ledger.list(seed.projectId, 'WorkPackage').map((r) => r.state);
    assert.ok(packages.some((p) => p.origin === 'MANUAL'));
    assert.ok(packages.some((p) => p.origin === 'AI_GENERATED'));

    // And the approval flag follows the origin, which is the point of keeping
    // them apart: a generated package is a proposal, a typed one is a decision.
    assert.ok(packages.every((p) => p.requiresPlannerApproval === (p.origin === 'AI_GENERATED')));
  });

  it('refuses a WBS code already in use', () => {
    throwsCode(
      () =>
        planning.createWorkPackage(ctx('planner'), {
          wbsCode: 'man-100',
          title: 'Something else entirely',
          indicativeDurationDays: 5,
        }),
      'WBS_CODE_IN_USE',
    );
  });

  it('nests under a parent and records the depth', () => {
    const parent = planning.createWorkPackage(ctx('planner'), {
      wbsCode: 'MAN-200',
      title: 'Mechanical installation',
      indicativeDurationDays: 60,
    });
    const child = planning.createWorkPackage(ctx('planner'), {
      wbsCode: 'MAN-210',
      title: 'Pipework to the inlet works',
      parentWorkPackageId: parent.workPackageId,
      indicativeDurationDays: 20,
    });
    const grandchild = planning.createWorkPackage(ctx('planner'), {
      wbsCode: 'MAN-211',
      title: 'Valve chamber pipework',
      parentWorkPackageId: child.workPackageId,
      indicativeDurationDays: 8,
    });

    assert.equal(child.depth, 1);
    assert.equal(grandchild.depth, 2);
  });

  it('refuses a parent that does not exist', () => {
    assert.throws(
      () =>
        planning.createWorkPackage(ctx('planner'), {
          wbsCode: 'MAN-300',
          title: 'Orphan',
          parentWorkPackageId: 'no-such-package',
          indicativeDurationDays: 5,
        }),
      /not found|NOT_FOUND/i,
    );
  });
});

describe('the site walk', () => {
  const hash = (c: string) => `sha256:${c.repeat(64)}`;

  it('captures an observation against an activity, with evidence', () => {
    const taskId = platform.ledger.list(seed.projectId, 'Task')[0]!.refId;

    const result = planning.captureSiteObservation(ctx('qaqc'), {
      category: 'WORKMANSHIP',
      description: 'Blockwork to the east wall is out of plumb by roughly 15mm over three courses.',
      location: 'Inlet works, east elevation',
      taskId,
      observedBy: 'QA engineer',
      requiresAction: true,
      actionOwner: 'Groundworks foreman',
      actionByDate: '2026-08-25',
      evidenceHash: hash('1'),
    });

    assert.match(result.reference, /^OBS-\d{4}$/);
    assert.equal(result.requiresAction, true);

    const record = platform.ledger.require({ refType: 'SiteObservation', refId: result.observationId });
    assert.equal(record.state.status, 'OPEN');
    assert.equal(record.state.taskId, taskId);
  });

  it('costs nothing, because a walk produces twenty of these in an hour', () => {
    // Charging AI against each observation would teach people not to record
    // them, which costs more than any classification is worth.
    const before = platform.wallet(seed.tenantId).snapshot().balanceMinor;

    planning.captureSiteObservation(ctx('qaqc'), {
      category: 'HOUSEKEEPING',
      description: 'Offcuts and banding accumulating around the rebar stack.',
      location: 'Laydown area',
      observedBy: 'QA engineer',
      requiresAction: false,
      evidenceHash: hash('2'),
    });

    assert.equal(platform.wallet(seed.tenantId).snapshot().balanceMinor, before);
  });

  it('refuses an action nobody owns', () => {
    throwsCode(
      () =>
        planning.captureSiteObservation(ctx('qaqc'), {
          category: 'ACCESS',
          description: 'Scaffold gate to the south face is padlocked and nobody has the key.',
          location: 'South face',
          observedBy: 'QA engineer',
          requiresAction: true,
          evidenceHash: hash('3'),
        }),
      'OBSERVATION_ACTION_UNOWNED',
    );
  });

  it('refuses an observation nobody who was not there could act on', () => {
    throwsCode(
      () =>
        planning.captureSiteObservation(ctx('qaqc'), {
          category: 'QUALITY',
          description: 'Bad.',
          location: 'Site',
          observedBy: 'QA engineer',
          requiresAction: false,
          evidenceHash: hash('4'),
        }),
      'OBSERVATION_INSUBSTANTIAL',
    );
  });

  it('closes one out and records whether it was late', () => {
    const captured = planning.captureSiteObservation(
      ctx('qaqc'),
      {
        category: 'MATERIALS',
        description: 'Cement delivery left uncovered overnight in the rain.',
        location: 'Laydown area',
        observedBy: 'QA engineer',
        requiresAction: true,
        actionOwner: 'Materials controller',
        actionByDate: '2026-08-10',
        evidenceHash: hash('5'),
      },
      new Date('2026-08-08T09:00:00Z'),
    );

    const closed = planning.closeSiteObservation(
      ctx('qaqc'),
      {
        observationId: captured.observationId,
        actionTaken: 'Affected bags quarantined and returned; remaining stock sheeted and palletised.',
        closedBy: 'Materials controller',
      },
      new Date('2026-08-14T09:00:00Z'),
    );

    assert.equal(closed.daysOpen, 6);
    assert.equal(closed.closedLate, true, 'closed four days after the date somebody agreed to');
  });

  it('will not close the same observation twice', () => {
    const captured = planning.captureSiteObservation(ctx('qaqc'), {
      category: 'ENVIRONMENTAL',
      description: 'Silty runoff reaching the highway drain from the haul road.',
      location: 'Site entrance',
      observedBy: 'QA engineer',
      requiresAction: true,
      actionOwner: 'Environmental advisor',
      actionByDate: '2026-09-30',
      evidenceHash: hash('6'),
    });

    const close = () =>
      planning.closeSiteObservation(ctx('qaqc'), {
        observationId: captured.observationId,
        actionTaken: 'Wheel wash reinstated and a silt trap fitted to the gully.',
        closedBy: 'Environmental advisor',
      });

    close();
    throwsCode(close, 'OBSERVATION_ALREADY_CLOSED');
  });

  it('orders the register by what is overdue rather than by what is recent', () => {
    const position = planning.siteWalkPosition(ctx('pm'), '2026-09-01');

    assert.ok(position.total >= 4);
    assert.ok(position.overdue.length >= 1, 'the workmanship observation is past its date by 1 September');
    assert.ok(position.overdue[0]!.daysOverdue >= position.overdue.at(-1)!.daysOverdue);
    assert.match(position.summary, /past the date somebody agreed/);
    assert.ok(position.closedLate >= 1);
  });

  it('counts only what is open by category, because a closed one is not a backlog', () => {
    const position = planning.siteWalkPosition(ctx('pm'), '2026-09-01');
    const openTotal = Object.values(position.byCategory).reduce((sum, n) => sum + n, 0);
    assert.equal(openTotal, position.open);
  });
});
