import assert from 'node:assert/strict';
import { before, beforeEach, describe, it } from 'node:test';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';
import type { EngineContext } from '../src/engines/context.ts';
import {
  openEngagement,
  recordAction,
  registerTask,
  updateTask,
  workboard,
} from '../src/domain/consultancy/store.ts';
import type { MinimumIntake } from '../src/domain/consultancy/engagement.ts';

/**
 * The stateful consultancy engagement persists in the Golden Thread, tracks its
 * work-package tasks and agent-run states, and reports a workboard whose
 * coverage is the spec's completion measure — completed and validated required
 * tasks over all required, with blocked tasks staying in the denominator.
 */

let platform: Platform;
let seed: SeedResult;

// ENTERPRISE_ADMIN holds BUSINESS_DEVELOPMENT create/update/approve/read.
const ctx = (): EngineContext => platform.context(seed.users.admin!.auth, seed.projectId, { correlationId: 'consult-test' });

const COMPLETE_INTAKE: MinimumIntake = {
  decisionRequested: 'Reinstate an hourly service and introduce a Sunday service',
  decisionAuthority: 'North Lincolnshire Council',
  client: 'North Lincolnshire Council',
  partySide: 'BIDDER',
  assetOrService: 'Doncaster–Scunthorpe rail service',
  location: 'North Lincolnshire',
};

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
});

describe('opening an engagement (spec §1, test C02)', () => {
  it('opens in INTAKE and returns missing mandatory inputs as blockers, persisted on the workboard', () => {
    const { engagementId, reference, workflowState, blockers } = openEngagement(ctx(), {
      route: 'RESPOND_TO_RFQ',
      assignment: 'COMBINED',
      intake: { client: 'North Lincolnshire Council' }, // deliberately incomplete
    });
    assert.match(reference, /^ENG-\d{4}$/);
    assert.equal(workflowState, 'INTAKE');
    assert.ok(blockers.length > 0, 'an incomplete intake has blockers');

    const board = workboard(ctx(), engagementId);
    assert.equal(board.engagement.workflowState, 'INTAKE');
    assert.ok(board.blockers.some((b) => b.source === 'INTAKE'), 'intake blockers surface on the workboard');
    assert.ok(board.nextActions.some((a) => /Provide missing intake/.test(a)));
  });

  it('records the party side — the basis of buyer/bidder isolation', () => {
    const { engagementId } = openEngagement(ctx(), { route: 'RESPOND_TO_RFQ', assignment: 'COMBINED', intake: COMPLETE_INTAKE });
    assert.equal(workboard(ctx(), engagementId).engagement.partySide, 'BIDDER');
  });

  it('attaches the client requirement at intake, persists it on the workboard, and does not let it gate authorisation', () => {
    const brief = 'Request for Quotation: a Feasibility Study and Business Case to assess additional rail services between Doncaster and Scunthorpe.';
    const { engagementId, blockers } = openEngagement(ctx(), {
      route: 'RESPOND_TO_RFQ',
      assignment: 'COMBINED',
      intake: { ...COMPLETE_INTAKE, clientRequirement: brief },
    });
    // The requirement is captured evidence, not a mandatory gate: a complete
    // intake with it attached has no blockers and can be authorised.
    assert.equal(blockers.length, 0, 'the attached requirement does not add a blocker');
    const board = workboard(ctx(), engagementId);
    assert.equal(board.engagement.intake.clientRequirement, brief, 'the brief round-trips through the golden thread');
    assert.equal(recordAction(ctx(), engagementId, { kind: 'AUTHORISE' }).workflowState, 'IN_PROGRESS');
  });
});

describe('authorising and the workflow state machine', () => {
  it('refuses AUTHORISE while mandatory intake is outstanding, and allows it once complete', () => {
    const incomplete = openEngagement(ctx(), { route: 'DELIVER_COMMISSION', assignment: 'COMBINED', intake: { client: 'NLC' } });
    assert.throws(() => recordAction(ctx(), incomplete.engagementId, { kind: 'AUTHORISE' }), (e) => (e as { code?: string }).code === 'INTAKE_INCOMPLETE');

    const complete = openEngagement(ctx(), { route: 'DELIVER_COMMISSION', assignment: 'COMBINED', intake: COMPLETE_INTAKE });
    const after = recordAction(ctx(), complete.engagementId, { kind: 'AUTHORISE' });
    assert.equal(after.workflowState, 'IN_PROGRESS');
  });

  it('bumps the scope version on a scope change and refuses actions after cancellation', () => {
    const { engagementId } = openEngagement(ctx(), { route: 'DELIVER_COMMISSION', assignment: 'COMBINED', intake: COMPLETE_INTAKE });
    const scoped = recordAction(ctx(), engagementId, { kind: 'SCOPE_CHANGE', note: 'added monitoring framework' });
    assert.equal(scoped.scopeVersion, 2);
    const cancelled = recordAction(ctx(), engagementId, { kind: 'CANCEL' });
    assert.equal(cancelled.workflowState, 'CANCELLED');
    assert.throws(() => recordAction(ctx(), engagementId, { kind: 'AUTHORISE' }), (e) => (e as { code?: string }).code === 'ENGAGEMENT_CLOSED');
  });
});

describe('the work-package checklist and verified digital coverage (spec §7)', () => {
  let engagementId: string;

  beforeEach(() => {
    engagementId = openEngagement(ctx(), { route: 'DELIVER_COMMISSION', assignment: 'COMBINED', intake: COMPLETE_INTAKE }).engagementId;
    recordAction(ctx(), engagementId, { kind: 'AUTHORISE' });
  });

  it('counts a task as covered only when it is COMPLETE and validated; a blocked task stays in the denominator', () => {
    const t1 = registerTask(ctx(), engagementId, { key: 'evidence', capability: 'EVIDENCE', title: 'Evidence register' });
    const t2 = registerTask(ctx(), engagementId, { key: 'options', capability: 'ECONOMICS', title: 'Options appraisal' });
    registerTask(ctx(), engagementId, { key: 'ops', capability: 'OPERATIONS', title: 'Operational feasibility' });

    // One complete-but-not-validated, one complete+validated, one blocked.
    updateTask(ctx(), t1.taskId, { runState: 'COMPLETE' }); // not validated → not covered
    updateTask(ctx(), t2.taskId, { runState: 'COMPLETE', validated: true }); // covered
    const board1 = workboard(ctx(), engagementId);
    assert.equal(board1.coverage.requiredDigital, 3);
    assert.equal(board1.coverage.coveredAndValidated, 1, 'only the complete AND validated task counts');
    assert.equal(board1.coverage.percent, 33);

    // Block the third task: it must stay in the denominator and show as a blocker with its owner.
    const t3 = board1.tasks.find((t) => t.key === 'ops')!;
    updateTask(ctx(), t3.id, { runState: 'BLOCKED', blocker: 'Awaiting Network Rail Sunday paths', owner: 'OPERATOR' });
    const board2 = workboard(ctx(), engagementId);
    assert.equal(board2.coverage.requiredDigital, 3, 'a blocked task stays in the denominator');
    assert.ok(board2.blockers.some((b) => b.source === 'TASK' && /Sunday paths/.test(b.detail) && b.owner === 'OPERATOR'));
    assert.ok(board2.nextActions.some((a) => /Sunday paths/.test(a)));
  });

  it('reports 100% and readiness once every required digital task is complete and validated', () => {
    const a = registerTask(ctx(), engagementId, { key: 'a', capability: 'EVIDENCE', title: 'A' });
    const b = registerTask(ctx(), engagementId, { key: 'b', capability: 'ECONOMICS', title: 'B' });
    updateTask(ctx(), a.taskId, { runState: 'COMPLETE', validated: true });
    updateTask(ctx(), b.taskId, { runState: 'COMPLETE', validated: true });
    const board = workboard(ctx(), engagementId);
    assert.equal(board.coverage.percent, 100);
    assert.ok(board.nextActions.some((x) => /ready for review and issue/.test(x)));
  });

  it('excludes a non-required-digital gate from the coverage denominator', () => {
    registerTask(ctx(), engagementId, { key: 'signoff', capability: 'AUTHORITY', title: 'External sign-off', requiredDigital: false });
    const board = workboard(ctx(), engagementId);
    assert.equal(board.coverage.requiredDigital, 0, 'a non-digital gate does not count toward digital coverage');
  });

  it('rejects an invalid agent-run state', () => {
    const t = registerTask(ctx(), engagementId, { key: 'x', capability: 'EVIDENCE', title: 'X' });
    assert.throws(() => updateTask(ctx(), t.taskId, { runState: 'DONE' as never }), (e) => (e as { code?: string }).code === 'BAD_RUN_STATE');
  });

  it('scopes a workboard to its own engagement — another engagement’s tasks do not leak in', () => {
    registerTask(ctx(), engagementId, { key: 'mine', capability: 'EVIDENCE', title: 'Mine' });
    const other = openEngagement(ctx(), { route: 'DELIVER_COMMISSION', assignment: 'COMBINED', intake: COMPLETE_INTAKE }).engagementId;
    registerTask(ctx(), other, { key: 'theirs', capability: 'EVIDENCE', title: 'Theirs' });
    const board = workboard(ctx(), engagementId);
    assert.ok(board.tasks.every((t) => t.key !== 'theirs'), 'the other engagement’s task is not on this workboard');
    assert.ok(board.tasks.some((t) => t.key === 'mine'));
  });
});
