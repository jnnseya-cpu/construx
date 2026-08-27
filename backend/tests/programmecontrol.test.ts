import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as programmecontrol from '../src/domain/programmecontrol.ts';
import * as structure from '../src/domain/structure.ts';
import * as planning from '../src/engines/planning.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * CN-WF-02 — baseline, lookahead, task and constraint control.
 *
 * Most of this workflow was already built, so what is tested here is only what
 * this module actually owns: the logic validation the baseline never had, the
 * separation of forecast from baseline, the four things a blocked task has to
 * say, and the decision record that out-of-sequence progress needs.
 */

let platform: Platform;
let seed: SeedResult;

/** Holds PROGRAMME_BASELINES A — approves the baseline and the forecast. */
const asPlanner = () => platform.context(seed.users.planner!.auth, seed.projectId, { source: 'WEB' });
const asPM = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });
/** Holds FIELD_EXECUTION C — updates the daily status. */
const asSiteManager = () => platform.context(seed.users.siteManager!.auth, seed.projectId, { source: 'WEB' });

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

let sequence = 0;

/** Two linked activities: A then B, finish-to-start. */
function chain(): { workPackageId: string; a: string; b: string } {
  sequence += 1;
  const { workPackageId } = planning.createWorkPackage(asPM(), {
    wbsCode: `PC-${String(sequence).padStart(3, '0')}`,
    title: `Programme control package ${sequence}`,
    indicativeDurationDays: 20,
  });
  const [a, b] = planning.createTasks(asPM(), [
    { activityCode: `PCA-${sequence}`, name: `Excavate ${sequence}`, workPackageId, durationDays: 10 },
    { activityCode: `PCB-${sequence}`, name: `Blind ${sequence}`, workPackageId, durationDays: 5 },
  ]);
  planning.linkTasks(asPM(), [{ predecessorId: a!, successorId: b!, type: 'FS', lag: 0 }]);
  return { workPackageId, a: a!, b: b! };
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  structure.transitionPhase(platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'CONSTRUCTION',
    justification: 'Running the weekly planning cycle',
  });
});

describe('CN-WF-02 the register', () => {
  it('registers its three new event types', () => {
    for (const [code, entity, action] of [
      ['PROGRAMME_FORECAST_APPROVED', 'ProgrammeForecast', 'APPROVE'],
      ['WEEKLY_PLAN_FROZEN', 'LookaheadPlan', 'FREEZE'],
      ['PROGRESS_STATUS_UPDATED', 'Task', 'UPDATE'],
    ] as const) {
      const definition = lookupEventType(code);
      assert.ok(definition, `${code} is not in the catalogue`);
      assert.equal(definition.entity, entity);
      assert.equal(definition.action, action);
    }
  });

  it('puts the forecast in the same area as the baseline it is measured against', () => {
    assert.equal(classifyEntity('ProgrammeForecast')?.area, 'PROGRAMME_BASELINES');
    assert.equal(classifyEntity('ProgrammeBaseline')?.area, 'PROGRAMME_BASELINES');
  });
});

describe('CN-WF-02 the logic nobody validated', () => {
  it('names an activity nothing decides the start of', () => {
    const { a } = chain();
    const validation = programmecontrol.validateProgrammeLogic(asPlanner());
    const openEnds = validation.findings.filter((finding) => finding.kind === 'OPEN_END_START');
    assert.ok(openEnds.some((finding) => finding.taskId === a));
    // Named, never counted.
    assert.ok(openEnds.every((finding) => finding.taskName));
  });

  it('names an activity nothing waits on', () => {
    const { b } = chain();
    const validation = programmecontrol.validateProgrammeLogic(asPlanner());
    assert.ok(validation.findings.some((finding) => finding.kind === 'OPEN_END_FINISH' && finding.taskId === b));
  });

  it('reports a link naming an activity that is not on the programme as critical', () => {
    const { a } = chain();
    planning.linkTasks(asPM(), [{ predecessorId: a, successorId: 'not-an-activity', type: 'FS', lag: 0 }]);
    const validation = programmecontrol.validateProgrammeLogic(asPlanner());
    const dangling = validation.findings.find((finding) => finding.kind === 'DANGLING_LOGIC');
    assert.ok(dangling);
    assert.equal(dangling.severity, 'CRITICAL');
    assert.ok(validation.blocking.includes('DANGLING_LOGIC'));
    // The critical path is still computed, over the links that resolve — which
    // is exactly why the finding matters.
    assert.ok(validation.projectDurationDays > 0);
  });

  it('is reproducible from the stored logic', () => {
    // AC-CN-WF-02-01. Two runs over the same programme give the same hash and
    // the same critical path.
    const first = programmecontrol.validateProgrammeLogic(asPlanner());
    const second = programmecontrol.validateProgrammeLogic(asPlanner());
    assert.equal(first.logicHash, second.logicHash);
    assert.deepEqual(
      first.criticalPath.map((entry) => entry.taskId),
      second.criticalPath.map((entry) => entry.taskId),
    );
  });

  it('changes its hash when the programme moves, and not otherwise', () => {
    const before = programmecontrol.validateProgrammeLogic(asPlanner()).logicHash;
    chain();
    const after = programmecontrol.validateProgrammeLogic(asPlanner()).logicHash;
    assert.notEqual(before, after);
  });
});

describe('CN-WF-02 a forecast never overwrites the baseline', () => {
  it('refuses a second baseline without the change request that authorised it', () => {
    // The demo project already carries an approved baseline.
    const refusal = throwsCode(
      () =>
        planning.approveBaseline(asPlanner(), {
          version: 'REV-2',
          reason: 'Recovering the delay',
          contractualCompletionDate: day(400),
        }),
      'REBASELINE_UNAUTHORISED',
    );
    assert.match(refusal.message ?? '', /change request/);
    assert.match(refusal.message ?? '', /always reports zero/);
  });

  it('lets a re-baseline through when a change request authorises it', () => {
    const result = planning.approveBaseline(asPlanner(), {
      version: 'REV-2',
      reason: 'Re-baselined under the agreed extension of time',
      contractualCompletionDate: day(400),
      changeRequestRef: 'CR-0031',
    });
    assert.ok(result.baselineId);
  });

  it('does not count the live recalculation as a baseline', () => {
    // `recalculateProgramme` writes onto a ProgrammeBaseline record marked LIVE
    // so a screen can read the current position. Counting it would quote every
    // variance against a recalculation rather than the contract programme.
    planning.recalculateProgramme(asPlanner(), {});
    const position = programmecontrol.programmeControlPosition(asPlanner());
    assert.equal(position.baseline?.version, 'REV-2');
  });

  it('records a forecast as its own record, with the variance against the baseline it was taken from', () => {
    const result = programmecontrol.approveForecast(asPlanner(), {
      version: 'FC-01',
      reason: 'Two weeks lost to the service diversion',
      forecastCompletionDate: day(420),
    });
    assert.equal(typeof result.varianceDays, 'number');

    const position = programmecontrol.programmeControlPosition(asPlanner());
    assert.equal(position.forecast?.version, 'FC-01');
    // Both still there, and distinct. AC-CN-WF-02-03 is a distinction between
    // records before it is a distinction between colours.
    assert.equal(position.baseline?.version, 'REV-2');
  });

  it('reports the forecast as stale once the programme moves under it', () => {
    assert.equal(programmecontrol.programmeControlPosition(asPlanner()).forecastCurrent, true);
    chain();
    const position = programmecontrol.programmeControlPosition(asPlanner());
    assert.equal(position.forecastCurrent, false);
    assert.match(position.summary, /moved since the forecast/);
  });

  it('refuses an unnamed or undated forecast', () => {
    throwsCode(
      () => programmecontrol.approveForecast(asPlanner(), { version: ' ', reason: 'x', forecastCompletionDate: day(1) }),
      'FORECAST_UNNAMED',
    );
    throwsCode(
      () =>
        programmecontrol.approveForecast(asPlanner(), {
          version: 'FC-02',
          reason: 'Revised',
          forecastCompletionDate: 'soon',
        }),
      'FORECAST_UNDATED',
    );
  });
});

describe('CN-WF-02 a blocked task says all four things', () => {
  it('refuses blocked with nothing behind the word', () => {
    const { a } = chain();
    throwsCode(
      () => programmecontrol.updateTaskStatus(asSiteManager(), { taskId: a, status: 'BLOCKED' }),
      'BLOCKED_DETAIL_REQUIRED',
    );
  });

  it('refuses blocked missing any one of reason, owner, impact or next action', () => {
    // AC-CN-WF-02-02. All four, or it is a colour on a chart.
    const { a } = chain();
    const full = {
      reason: 'The service diversion is not complete',
      owner: 'M. Osei',
      impact: 'Four days on the critical path',
      nextAction: 'Utility to confirm the diversion date at Thursday’s meeting',
    };
    for (const field of ['reason', 'owner', 'impact', 'nextAction'] as const) {
      throwsCode(
        () =>
          programmecontrol.updateTaskStatus(asSiteManager(), {
            taskId: a,
            status: 'BLOCKED',
            blocked: { ...full, [field]: '  ' },
          }),
        'BLOCKED_DETAIL_REQUIRED',
      );
    }
  });

  it('takes a block with all four and surfaces it', () => {
    const { a } = chain();
    programmecontrol.updateTaskStatus(asSiteManager(), {
      taskId: a,
      status: 'BLOCKED',
      blocked: {
        reason: 'The service diversion is not complete',
        owner: 'M. Osei',
        impact: 'Four days on the critical path',
        nextAction: 'Utility to confirm the diversion date at Thursday’s meeting',
      },
    });
    const position = programmecontrol.programmeControlPosition(asPlanner());
    const blocked = position.blocked.find((entry) => entry.taskId === a)!;
    assert.equal(blocked.owner, 'M. Osei');
    assert.match(blocked.impact, /critical path/);
    assert.match(blocked.nextAction, /Thursday/);
  });
});

describe('CN-WF-02 complete needs its evidence', () => {
  it('refuses complete with nothing behind it', () => {
    // The third exception control. A complete with no evidence is the one
    // somebody finds three weeks later, buried.
    const { a } = chain();
    throwsCode(
      () => programmecontrol.updateTaskStatus(asSiteManager(), { taskId: a, status: 'COMPLETE' }),
      'VERIFICATION_REQUIRED',
    );
  });

  it('accepts complete with verification, and registers it as evidence', () => {
    const { a } = chain();
    const result = programmecontrol.updateTaskStatus(asSiteManager(), {
      taskId: a,
      status: 'COMPLETE',
      verification: { description: 'Formation level survey, sheet 4, signed off by QA', hash: `verify-${a}` },
    });
    assert.equal(result.status, 'COMPLETE');
    const events = platform.ledger
      .events({ projectId: seed.projectId })
      .filter((event) => event.eventType === 'PROGRESS_STATUS_UPDATED' && event.entity.refId === a);
    assert.ok(events.some((event) => (event.evidenceRefs?.length ?? 0) > 0));
  });
});

describe('CN-WF-02 out-of-sequence progress is a decision on the record', () => {
  it('refuses work on a successor whose predecessor has not started', () => {
    const { b } = chain();
    const refusal = throwsCode(
      () => programmecontrol.updateTaskStatus(asSiteManager(), { taskId: b, status: 'IN_PROGRESS' }),
      'SEQUENCE_DECISION_REQUIRED',
    );
    // Retained logic and progress override give different completion dates from
    // the same facts, which is why it cannot be a setting.
    assert.match(refusal.message ?? '', /different completion dates/);
  });

  it('refuses a sequence decision with no rationale', () => {
    const { b } = chain();
    throwsCode(
      () =>
        programmecontrol.updateTaskStatus(asSiteManager(), {
          taskId: b,
          status: 'IN_PROGRESS',
          sequence: { decision: 'PROGRESS_OVERRIDE', rationale: '  ' },
        }),
      'SEQUENCE_DECISION_REQUIRED',
    );
  });

  it('takes the decision and records which was chosen and why', () => {
    const { b } = chain();
    const result = programmecontrol.updateTaskStatus(asSiteManager(), {
      taskId: b,
      status: 'IN_PROGRESS',
      sequence: {
        decision: 'PROGRESS_OVERRIDE',
        rationale:
          'The blinding is being poured from the far end, which no longer depends on the excavation finishing; the ' +
          'remaining excavation is behind the pour front.',
      },
    });
    assert.equal(result.outOfSequence, true);

    const position = programmecontrol.programmeControlPosition(asPlanner());
    const entry = position.outOfSequence.find((row) => row.taskId === b)!;
    assert.equal(entry.decision, 'PROGRESS_OVERRIDE');
    assert.match(entry.rationale ?? '', /behind the pour front/);
  });

  it('does not ask for a decision where the sequence is being followed', () => {
    const { a, b } = chain();
    programmecontrol.updateTaskStatus(asSiteManager(), {
      taskId: a,
      status: 'COMPLETE',
      verification: { description: 'Formation survey', hash: `verify-seq-${a}` },
    });
    const result = programmecontrol.updateTaskStatus(asSiteManager(), { taskId: b, status: 'IN_PROGRESS' });
    assert.equal(result.outOfSequence, false);
  });

  it('surfaces the out-of-sequence work in the logic validation too', () => {
    const validation = programmecontrol.validateProgrammeLogic(asPlanner());
    assert.ok(validation.findings.some((finding) => finding.kind === 'OUT_OF_SEQUENCE'));
  });
});

describe('CN-WF-02 the week stops moving', () => {
  let lookaheadId: string;

  before(() => {
    const { a } = chain();
    lookaheadId = planning.publishLookahead(asPlanner(), {
      weekStarting: day(1),
      plannedTaskIds: [a],
      commitments: [{ taskId: a, promise: 'Excavation complete to formation', promisedBy: 'A. Okafor', dueDate: day(7) }],
    }).lookaheadId;
  });

  it('freezes the week and records what it was frozen on', () => {
    const result = programmecontrol.freezeWeeklyPlan(asPlanner(), lookaheadId, {
      weekEnding: day(7),
      note: 'Agreed at the Thursday planning meeting with all four subcontractors present.',
    });
    assert.equal(result.committed, 1);

    const position = programmecontrol.programmeControlPosition(asPlanner());
    assert.ok(position.frozenWeeks.some((week) => week.lookaheadId === lookaheadId));
  });

  it('refuses to freeze it twice', () => {
    // A frozen week that can be reopened is one whose promises get edited to
    // match what happened, and PPC over an edited plan measures nothing.
    throwsCode(
      () => programmecontrol.freezeWeeklyPlan(asPlanner(), lookaheadId, { weekEnding: day(7), note: 'Again.' }),
      'WEEK_ALREADY_FROZEN',
    );
  });

  it('refuses an unexplained freeze', () => {
    const { a } = chain();
    const fresh = planning.publishLookahead(asPlanner(), {
      weekStarting: day(8),
      plannedTaskIds: [a],
      commitments: [],
    }).lookaheadId;
    throwsCode(
      () => programmecontrol.freezeWeeklyPlan(asPlanner(), fresh, { weekEnding: day(14), note: '   ' }),
      'FREEZE_UNEXPLAINED',
    );
  });

  it('refuses to freeze a plan that does not exist', () => {
    throwsCode(
      () => programmecontrol.freezeWeeklyPlan(asPlanner(), 'not-a-plan', { weekEnding: day(7), note: 'Frozen.' }),
      'LOOKAHEAD_NOT_FOUND',
    );
  });
});
