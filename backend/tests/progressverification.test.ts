import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as progressverification from '../src/domain/progressverification.ts';
import * as structure from '../src/domain/structure.ts';
import * as planning from '../src/engines/planning.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * CN-WF-04 — progress measurement, verification and productivity.
 *
 * The money path. A figure that is wrong here is wrong in the valuation, in
 * earned value and in the remaining duration at the same time.
 *
 * What is tested is the separation that makes those three trustworthy: a claim
 * and an acceptance made by different people, with the gap between them
 * preserved; the same work never claimed twice; more installed than exists
 * refused; and rework recorded as a cost that earns nothing.
 */

let platform: Platform;
let seed: SeedResult;

/** Holds FIELD_EXECUTION C — the gang claims. Cannot certify. */
const asSiteManager = () => platform.context(seed.users.siteManager!.auth, seed.projectId, { source: 'PWA' });
/** Holds A — certifies. Also holds WORKPACKAGES_TASKS U to set the basis. */
const asPM = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });
/** Holds FIELD_EXECUTION read and nothing more. */
const asPlanner = () => platform.context(seed.users.planner!.auth, seed.projectId, { source: 'WEB' });

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

let sequence = 0;
let workPackageId: string;

/** An activity measured in cubic metres against a control total of 500. */
function measuredTask(controlTotal = 500): string {
  sequence += 1;
  const taskId = planning.createTasks(asPM(), [
    { activityCode: `PV-${sequence}`, name: `Excavate zone ${sequence}`, workPackageId, durationDays: 10 },
  ])[0]!;
  progressverification.setMeasurementBasis(asPM(), {
    taskId,
    unit: 'm3',
    controlTotal,
    measurementRule: 'Net excavated volume to the design formation, measured from the survey model.',
    source: 'C-2101 rev P05, bill item 2.4.1',
  });
  return taskId;
}

function claim(
  taskId: string,
  overrides: Partial<Parameters<typeof progressverification.submitProgress>[1]> = {},
) {
  sequence += 1;
  return progressverification.submitProgress(asSiteManager(), {
    taskId,
    quantity: 120,
    unit: 'm3',
    location: `Grid A${sequence}`,
    periodFrom: day(-7),
    periodTo: day(-1),
    evidenceDescription: 'Survey pick-up, sheet 4',
    evidenceHash: `pv-evidence-${sequence}`,
    ...overrides,
  });
}

before(async () => {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  structure.transitionPhase(platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'CONSTRUCTION',
    justification: 'Measuring the work',
  });
  workPackageId = planning.createWorkPackage(asPM(), {
    wbsCode: 'PV-001',
    title: 'Bulk excavation',
    indicativeDurationDays: 40,
  }).workPackageId;
});

describe('CN-WF-04 the register', () => {
  it('registers its four event types', () => {
    for (const [code, entity] of [
      ['MEASUREMENT_BASIS_SET', 'MeasurementBasis'],
      ['PROGRESS_REPORTED', 'ProgressSubmission'],
      ['PROGRESS_VERIFIED', 'ProgressSubmission'],
      ['PROGRESS_ADJUSTED', 'ProgressSubmission'],
    ] as const) {
      const definition = lookupEventType(code);
      assert.ok(definition, `${code} is not in the catalogue`);
      assert.equal(definition.entity, entity);
      // "Never certify payment or progress alone."
      assert.equal(definition.aiAllowed, false);
    }
    assert.equal(lookupEventType('PROGRESS_VERIFIED')?.action, 'APPROVE');
  });

  it('splits the basis from the claim by area', () => {
    // The basis is a statement about scope; the claim is a field act.
    assert.equal(classifyEntity('MeasurementBasis')?.area, 'WORKPACKAGES_TASKS');
    assert.equal(classifyEntity('ProgressSubmission')?.area, 'FIELD_EXECUTION');
  });
});

describe('CN-WF-04 the measurement basis', () => {
  it('refuses a claim against an activity with no basis', () => {
    const bare = planning.createTasks(asPM(), [
      { activityCode: 'PV-BARE', name: 'Unmeasured', workPackageId, durationDays: 5 },
    ])[0]!;
    throwsCode(
      () =>
        progressverification.submitProgress(asSiteManager(), {
          taskId: bare,
          quantity: 10,
          unit: 'm3',
          location: 'Anywhere',
          periodFrom: day(-3),
          periodTo: day(-1),
          evidenceDescription: 'x',
          evidenceHash: 'x',
        }),
      'MEASUREMENT_BASIS_REQUIRED',
    );
  });

  it('refuses a basis with no rule, no source or no total', () => {
    const taskId = planning.createTasks(asPM(), [
      { activityCode: 'PV-BAD', name: 'Badly measured', workPackageId, durationDays: 5 },
    ])[0]!;
    const good = {
      taskId,
      unit: 'm3',
      controlTotal: 100,
      measurementRule: 'Net volume',
      source: 'C-2101 P05',
    };
    throwsCode(
      () => progressverification.setMeasurementBasis(asPM(), { ...good, measurementRule: '  ' }),
      'MEASUREMENT_RULE_REQUIRED',
    );
    throwsCode(() => progressverification.setMeasurementBasis(asPM(), { ...good, source: '' }), 'CONTROL_TOTAL_UNSOURCED');
    throwsCode(
      () => progressverification.setMeasurementBasis(asPM(), { ...good, controlTotal: 0 }),
      'CONTROL_TOTAL_REQUIRED',
    );
  });

  it('refuses a claim in a different unit from the one the activity is measured in', () => {
    const taskId = measuredTask();
    throwsCode(() => claim(taskId, { unit: 'm2' }), 'UNIT_MISMATCH');
  });

  it('refuses to lower the control total below what is already accepted', () => {
    const taskId = measuredTask(500);
    const { submissionId } = claim(taskId, { quantity: 300 });
    progressverification.verifyProgress(asPM(), submissionId, { decision: 'ACCEPTED', rationale: 'Survey agrees.' });
    throwsCode(
      () =>
        progressverification.setMeasurementBasis(asPM(), {
          taskId,
          unit: 'm3',
          controlTotal: 200,
          measurementRule: 'Net volume',
          source: 'C-2101 P06',
        }),
      'CONTROL_TOTAL_BELOW_ACCEPTED',
    );
  });
});

describe('AC-CN-WF-04-01 submitted and accepted stay separately auditable', () => {
  it('preserves the claim when the verifier adjusts it', () => {
    // The gap between the two is the finding, and it is what a productivity
    // argument and a payment dispute both turn on.
    const taskId = measuredTask();
    const { submissionId, reference } = claim(taskId, { quantity: 240 });
    const result = progressverification.verifyProgress(asPM(), submissionId, {
      decision: 'ADJUSTED',
      acceptedQuantity: 180,
      rationale: 'The survey shows 180m³ to formation; the remainder is over-dig outside the design profile.',
      evidenceDescription: 'Verifier survey comparison, sheet 4a',
      evidenceHash: 'adjust-evidence-1',
    });
    assert.equal(result.submittedQuantity, 240);
    assert.equal(result.acceptedQuantity, 180);

    const position = progressverification.progressVerificationPosition(asPM());
    const adjustment = position.adjustments.find((entry) => entry.reference === reference)!;
    assert.equal(adjustment.submitted, 240);
    assert.equal(adjustment.accepted, 180);
    assert.match(adjustment.rationale, /over-dig/);
  });

  it('refuses an adjustment with no evidence behind it', () => {
    const taskId = measuredTask();
    const { submissionId } = claim(taskId);
    throwsCode(
      () =>
        progressverification.verifyProgress(asPM(), submissionId, {
          decision: 'ADJUSTED',
          acceptedQuantity: 80,
          rationale: 'Looks less than that.',
        }),
      'ADJUSTMENT_UNEVIDENCED',
    );
  });

  it('refuses an adjustment that adjusts nothing', () => {
    const taskId = measuredTask();
    const { submissionId } = claim(taskId, { quantity: 100 });
    throwsCode(
      () =>
        progressverification.verifyProgress(asPM(), submissionId, {
          decision: 'ADJUSTED',
          acceptedQuantity: 100,
          rationale: 'Agreed.',
          evidenceDescription: 'x',
          evidenceHash: 'x',
        }),
      'ADJUSTMENT_CHANGES_NOTHING',
    );
  });

  it('refuses the claimant as the verifier', () => {
    const taskId = measuredTask();
    const { submissionId } = claim(taskId);
    throwsCode(
      () => progressverification.verifyProgress(asSiteManager(), submissionId, { decision: 'ACCEPTED', rationale: 'Mine.' }),
      'ACCESS_DENIED',
    );
  });

  it('refuses a second decision on the same claim', () => {
    const taskId = measuredTask();
    const { submissionId } = claim(taskId);
    progressverification.verifyProgress(asPM(), submissionId, { decision: 'ACCEPTED', rationale: 'Agreed.' });
    throwsCode(
      () => progressverification.verifyProgress(asPM(), submissionId, { decision: 'REJECTED', rationale: 'Changed my mind.' }),
      'ALREADY_VERIFIED',
    );
  });

  it('refuses an unexplained decision', () => {
    const taskId = measuredTask();
    const { submissionId } = claim(taskId);
    throwsCode(
      () => progressverification.verifyProgress(asPM(), submissionId, { decision: 'ACCEPTED', rationale: '  ' }),
      'DECISION_UNEXPLAINED',
    );
  });
});

describe('AC-CN-WF-04-03 nothing is claimed twice', () => {
  it('refuses the same activity, location and period arriving again', () => {
    const taskId = measuredTask();
    const first = claim(taskId, { location: 'Grid C4', periodFrom: day(-7), periodTo: day(-1) });
    assert.ok(first.submissionId);
    throwsCode(
      () => claim(taskId, { location: 'Grid C4', periodFrom: day(-7), periodTo: day(-1) }),
      'DUPLICATE_CLAIM',
    );
  });

  it('lets the same location be claimed again for a different period', () => {
    const taskId = measuredTask();
    claim(taskId, { location: 'Grid D2', periodFrom: day(-14), periodTo: day(-8) });
    const second = claim(taskId, { location: 'Grid D2', periodFrom: day(-7), periodTo: day(-1) });
    assert.ok(second.submissionId);
  });

  it('refuses a claim with no location to check against last week', () => {
    const taskId = measuredTask();
    throwsCode(() => claim(taskId, { location: '  ' }), 'LOCATION_REQUIRED');
  });

  it('refuses a claim of nothing, or with no evidence', () => {
    const taskId = measuredTask();
    throwsCode(() => claim(taskId, { quantity: 0 }), 'NOTHING_CLAIMED');
    throwsCode(() => claim(taskId, { evidenceHash: '' }), 'EVIDENCE_REQUIRED');
  });

  it('refuses a period that ends before it starts', () => {
    const taskId = measuredTask();
    throwsCode(() => claim(taskId, { periodFrom: day(-1), periodTo: day(-7) }), 'PERIOD_REQUIRED');
  });
});

describe('CN-WF-04 more installed than exists blocks acceptance', () => {
  it('records the claim but refuses to certify past the control total', () => {
    // The claim is a fact about what somebody measured. Refusing to record it
    // would lose the evidence that the scope has moved.
    const taskId = measuredTask(200);
    const first = claim(taskId, { quantity: 150, location: 'Bay 1' });
    progressverification.verifyProgress(asPM(), first.submissionId, { decision: 'ACCEPTED', rationale: 'Agreed.' });

    const second = claim(taskId, { quantity: 90, location: 'Bay 2' });
    assert.equal(second.exceedsControlTotal, true);

    const refusal = throwsCode(
      () => progressverification.verifyProgress(asPM(), second.submissionId, { decision: 'ACCEPTED', rationale: 'Agreed.' }),
      'EXCEEDS_CONTROL_TOTAL',
    );
    assert.match(refusal.message ?? '', /C-2101 rev P05/);
    assert.match(refusal.message ?? '', /change nobody has raised/);
  });

  it('lets the verifier adjust it down to what exists', () => {
    const taskId = measuredTask(200);
    const first = claim(taskId, { quantity: 150, location: 'Bay 1' });
    progressverification.verifyProgress(asPM(), first.submissionId, { decision: 'ACCEPTED', rationale: 'Agreed.' });
    const second = claim(taskId, { quantity: 90, location: 'Bay 2' });
    const result = progressverification.verifyProgress(asPM(), second.submissionId, {
      decision: 'ADJUSTED',
      acceptedQuantity: 50,
      rationale: 'Only 50m³ remains within the bill quantity; the balance is a scope query.',
      evidenceDescription: 'Remeasure against the bill',
      evidenceHash: 'remeasure-1',
    });
    assert.equal(result.cumulative, 200);
  });
});

describe('CN-WF-04 rework earns nothing', () => {
  it('records the redone work and leaves the accepted quantity alone', () => {
    const taskId = measuredTask(500);
    const first = claim(taskId, { quantity: 100, location: 'Bay 7' });
    progressverification.verifyProgress(asPM(), first.submissionId, { decision: 'ACCEPTED', rationale: 'Agreed.' });
    const before = progressverification.acceptedProgressFor(asPM(), taskId);

    const redo = claim(taskId, { quantity: 40, location: 'Bay 7', rework: true, periodFrom: day(-6), periodTo: day(-2) });
    progressverification.verifyProgress(asPM(), redo.submissionId, {
      decision: 'ACCEPTED',
      rationale: 'Re-excavated after the trench collapsed; no new formation gained.',
    });

    const after = progressverification.acceptedProgressFor(asPM(), taskId);
    assert.equal(after.acceptedQuantity, before.acceptedQuantity);
    assert.equal(after.reworkQuantity, 40);
    // The cost is visible; the progress is not inflated.
    assert.ok(progressverification.progressVerificationPosition(asPM()).rework.some((entry) => entry.quantity === 40));
  });

  it('lets rework be claimed for a location and period already claimed as progress', () => {
    // Redoing a bay is the same place and often the same week. Treating it as a
    // duplicate would make it unrecordable, which is how rework disappears.
    const taskId = measuredTask(500);
    claim(taskId, { quantity: 60, location: 'Bay 9', periodFrom: day(-7), periodTo: day(-1) });
    const redo = claim(taskId, {
      quantity: 20,
      location: 'Bay 9',
      periodFrom: day(-7),
      periodTo: day(-1),
      rework: true,
    });
    assert.ok(redo.submissionId);
  });
});

describe('AC-CN-WF-04-02 one accepted figure, read by everything', () => {
  it('moves the activity percentage only on acceptance', () => {
    const taskId = measuredTask(400);
    const { submissionId } = claim(taskId, { quantity: 100, location: 'Bay 11' });

    // Claimed, not yet certified: the programme has not moved.
    assert.equal(Number(platform.ledger.require({ refType: 'Task', refId: taskId }).state.percentComplete ?? 0), 0);

    progressverification.verifyProgress(asPM(), submissionId, { decision: 'ACCEPTED', rationale: 'Agreed.' });
    const task = platform.ledger.require({ refType: 'Task', refId: taskId });
    assert.equal(Number(task.state.percentComplete), 25);
    // And says which accepted version that percentage came from.
    assert.equal(Number(task.state.acceptedProgressVersion), 1);
  });

  it('closes the direct progress command for a measured activity', () => {
    // Two doors to one money field is how the valuation and the programme come
    // to disagree with nothing saying which is right.
    const taskId = measuredTask();
    const refusal = throwsCode(
      () =>
        planning.recordProgress(asPM(), {
          taskId,
          percentComplete: 50,
          elapsedDays: 5,
          evidenceDescription: 'Straight in',
          evidenceHash: 'direct-1',
        }),
      'PROGRESS_REQUIRES_VERIFICATION',
    );
    assert.match(refusal.message ?? '', /certified by somebody else/);
  });

  it('leaves an unmeasured activity on the direct path', () => {
    const bare = planning.createTasks(asPM(), [
      { activityCode: 'PV-DIRECT', name: 'Unmeasured, direct', workPackageId, durationDays: 5 },
    ])[0]!;
    planning.recordProgress(asPM(), {
      taskId: bare,
      percentComplete: 30,
      elapsedDays: 2,
      evidenceDescription: 'Straight in',
      evidenceHash: 'direct-2',
    });
    assert.equal(progressverification.directProgressBlockedReason(asPM(), bare), null);
  });

  it('reports a rejected claim as earning nothing while keeping what was claimed', () => {
    const taskId = measuredTask();
    const { submissionId } = claim(taskId, { quantity: 75, location: 'Bay 13' });
    progressverification.verifyProgress(asPM(), submissionId, {
      decision: 'REJECTED',
      rationale: 'The bay was not excavated in this period; the claim duplicates last month in a different location.',
    });
    const accepted = progressverification.acceptedProgressFor(asPM(), taskId);
    assert.equal(accepted.acceptedQuantity, 0);
    assert.equal(accepted.submittedQuantity, 75);
  });
});

describe('CN-WF-04 the position', () => {
  it('puts what is holding a valuation up at the top', () => {
    const taskId = measuredTask();
    claim(taskId, { quantity: 30, location: 'Bay 21' });
    const position = progressverification.progressVerificationPosition(asPM());
    assert.ok(position.awaiting.length > 0);
    assert.match(position.summary, /awaiting verification/);
    // Activities sort by what is outstanding against them.
    assert.ok(position.activities[0]!.awaitingVerification >= position.activities.at(-1)!.awaitingVerification);
  });

  it('is readable by a role that can neither claim nor certify', () => {
    assert.ok(progressverification.progressVerificationPosition(asPlanner()).activities.length > 0);
  });
});
