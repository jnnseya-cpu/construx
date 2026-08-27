import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as aftercare from '../src/domain/aftercare.ts';
import * as control from '../src/domain/control.ts';
import * as reliability from '../src/domain/reliability.ts';
import * as structure from '../src/domain/structure.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { classifyEntity } from '../src/identity/entityAccess.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * H-WF-10 — Soft Landings, aftercare, seasonal testing and feedback.
 *
 * CM-WF-06's seasonal tests and `control.captureLesson` are reused rather than
 * duplicated. What is tested here is what neither answered: the aftercare
 * period, the performance comparison that has to state its own context, the
 * feedback that carries no name by construction, and the lesson approval that
 * decides where reuse is valid.
 */

let platform: Platform;
let seed: SeedResult;

const asFM = () => platform.context(seed.users.fm!.auth, seed.projectId, { source: 'WEB' });
const asPM = () => platform.context(seed.users.pm!.auth, seed.projectId, { source: 'WEB' });
/** Holds RISK_REGISTER C and A — a lesson sits with whoever holds the risk register. */
const asSafety = () => platform.context(seed.users.safety!.auth, seed.projectId, { source: 'WEB' });
const asQAQC = () => platform.context(seed.users.qaqc!.auth, seed.projectId, { source: 'WEB' });

const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

async function freshProject() {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  structure.transitionPhase(platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'HANDOVER',
    justification: 'Starting the aftercare period',
  });
}

function plan(overrides: Record<string, unknown> = {}) {
  return aftercare.startAftercare(asFM(), {
    reference: 'AC-001',
    durationMonths: 12,
    startsOn: iso(0),
    helpdesk: 'Estates helpdesk, 0800 000 0000, 07:00 to 19:00',
    escalation: 'Escalate to the aftercare lead after four hours, then to the project director after one working day.',
    responseTargets: 'Four hours for a comfort call, one hour for a loss of heating or power',
    reviewDates: [iso(30), iso(90), iso(180), iso(270)],
    aftercareOwner: 'Main contractor aftercare lead',
    ...overrides,
  } as Parameters<typeof aftercare.startAftercare>[1]);
}

const COMPARISON = {
  reference: 'PERF-ENERGY-01',
  metric: 'Annual electricity consumption',
  unit: 'kWh/m2/yr',
  baselineSource: 'DESIGN_INTENT' as const,
  baselineValue: 90,
  measuredValue: 96,
  periodFrom: iso(-180),
  periodTo: iso(-1),
  operatingContext: 'Fully occupied from month three; a mild winter and the atrium AHU running on manual override',
  dataSource: 'Half-hourly meter data from the landlord submeter',
  assessedBy: 'Energy manager',
};

const FEEDBACK = {
  theme: 'THERMAL_COMFORT' as const,
  reportedByRole: 'Floor warden',
  location: 'Level 2 east',
  description: 'Consistently cold in the mornings until about ten, reported by several desks along the east facade',
  severity: 'MEDIUM' as const,
  occurrences: 14,
};

describe('H-WF-10 the aftercare plan', () => {
  beforeEach(freshProject);

  it('opens the aftercare period with its helpdesk, escalation and reviews', () => {
    const result = plan();
    assert.equal(result.reviews, 4);
    assert.ok(result.endsOn > iso(0));

    const position = aftercare.aftercarePosition(asFM());
    assert.equal(position.plan!.reference, 'AC-001');
    assert.equal(position.plan!.status, 'ACTIVE');
    assert.ok(position.plan!.nextReview);
  });

  it('refuses a plan with no scheduled reviews — that is a reactive service', () => {
    const error = throwsCode(() => plan({ reviewDates: [] }), 'REVIEWS_REQUIRED');
    assert.match(String(error.message), /ends with no comparison made/);
  });

  it('refuses a plan with no escalation route or no response targets', () => {
    const error = throwsCode(() => plan({ escalation: 'Call us' }), 'ESCALATION_REQUIRED');
    assert.match(String(error.message), /the half that gets left out/);
    throwsCode(() => plan({ responseTargets: '' }), 'RESPONSE_TARGETS_REQUIRED');
    throwsCode(() => plan({ helpdesk: '' }), 'ESCALATION_REQUIRED');
  });

  it('refuses a plan with no owner, no reference or no duration', () => {
    throwsCode(() => plan({ aftercareOwner: '' }), 'PLAN_UNIDENTIFIED');
    throwsCode(() => plan({ reference: '' }), 'PLAN_UNIDENTIFIED');
    throwsCode(() => plan({ durationMonths: 0 }), 'DURATION_REQUIRED');
  });

  it('refuses a second active plan', () => {
    plan();
    throwsCode(() => plan({ reference: 'AC-002' }), 'ALREADY_ACTIVE');
  });

  it('reports no plan on a project that has not started aftercare', () => {
    const position = aftercare.aftercarePosition(asFM());
    assert.equal(position.plan, null);
    assert.match(position.summary, /no aftercare plan/);
  });
});

describe('H-WF-10 seasonal testing', () => {
  beforeEach(freshProject);

  /** CM-WF-06 raises the obligation; this workflow closes it by its own reference. */
  function owed(reference = 'SEAS-001') {
    reliability.planSeasonalTest(asQAQC(), {
      reference,
      systemTag: 'AHU-01',
      condition: 'Outside air below 2°C sustained for six hours, unavailable at commissioning in July',
      criteria: 'Space temperature holds within 1K of setpoint across the whole east zone',
      owner: 'Controls subcontractor commissioning engineer',
      ownerOrganisation: 'Controls subcontractor',
      responsibilityAcceptedBy: 'Main contractor commissioning manager',
      windowFrom: iso(90),
      windowTo: iso(180),
    });
    return reference;
  }

  const RESULT = {
    testedOn: iso(120),
    conditionsObserved: 'Outside air held at minus one degree from 04:00 to 11:00, which meets the deferred condition',
    result: 'PASS' as const,
    findings: 'Space temperature held within 0.6K across the east zone for the whole period',
    testedBy: 'Controls subcontractor commissioning engineer',
    evidenceHash: 'a'.repeat(64),
  };

  it('closes the CM-WF-06 record by its own reference, with nothing renumbered', () => {
    const reference = owed();
    assert.equal(reliability.outstandingSeasonalTests(asFM()).length, 1);

    const result = aftercare.completeSeasonalTest(asQAQC(), reference, RESULT);
    assert.equal(result.reference, reference);
    assert.equal(result.systemTag, 'AHU-01');
    assert.equal(result.stillOutstanding, 0);
  });

  /**
   * A failed seasonal test does not discharge the obligation. The building
   * still has not been shown to work in the condition it was deferred for.
   */
  it('leaves the obligation outstanding after a fail', () => {
    const reference = owed();
    const result = aftercare.completeSeasonalTest(asQAQC(), reference, {
      ...RESULT,
      result: 'FAIL',
      findings: 'The east zone fell 2.4K below setpoint and did not recover within the period',
    });
    assert.equal(result.stillOutstanding, 1);
  });

  it('records a test run outside its window rather than refusing it', () => {
    const reference = owed();
    aftercare.completeSeasonalTest(asQAQC(), reference, { ...RESULT, testedOn: iso(30) });

    const position = aftercare.aftercarePosition(asFM());
    assert.equal(position.seasonalCompleted.length, 1);
    // Recorded, not hidden: whether it is enough is the operator's judgement,
    // and not saying so would let it pass as though it were in season.
    assert.equal(position.seasonalCompleted[0]!.outsideWindow, true);
  });

  it('refuses a result with no observed conditions — a seasonal test is a test of the season', () => {
    const reference = owed();
    const error = throwsCode(
      () => aftercare.completeSeasonalTest(asQAQC(), reference, { ...RESULT, conditionsObserved: 'Cold' }),
      'CONDITIONS_REQUIRED',
    );
    assert.match(String(error.message), /mild February proves nothing/);
  });

  it('refuses a result with no findings, no tester or no evidence', () => {
    const reference = owed();
    throwsCode(() => aftercare.completeSeasonalTest(asQAQC(), reference, { ...RESULT, findings: 'Fine' }), 'FINDINGS_REQUIRED');
    throwsCode(() => aftercare.completeSeasonalTest(asQAQC(), reference, { ...RESULT, testedBy: '' }), 'TEST_UNSIGNED');
    throwsCode(() => aftercare.completeSeasonalTest(asQAQC(), reference, { ...RESULT, evidenceHash: '' }), 'TEST_UNSIGNED');
    throwsCode(
      () => aftercare.completeSeasonalTest(asQAQC(), reference, { ...RESULT, testedOn: 'winter' }),
      'TEST_DATE_REQUIRED',
    );
  });

  it('refuses to close a test twice, and one that does not exist', () => {
    const reference = owed();
    aftercare.completeSeasonalTest(asQAQC(), reference, RESULT);
    throwsCode(() => aftercare.completeSeasonalTest(asQAQC(), reference, RESULT), 'NOT_OUTSTANDING');
    throwsCode(() => aftercare.completeSeasonalTest(asQAQC(), 'NOPE', RESULT), 'SEASONAL_TEST_NOT_FOUND');
  });

  it('surfaces what is still owed in the position', () => {
    owed('SEAS-001');
    owed('SEAS-002');
    aftercare.completeSeasonalTest(asQAQC(), 'SEAS-001', RESULT);

    const position = aftercare.aftercarePosition(asFM());
    assert.equal(position.seasonal.length, 1);
    assert.equal(position.seasonal[0]!.reference, 'SEAS-002');
    assert.match(position.summary, /1 seasonal test owed/);
  });
});

describe('H-WF-10 performance in use', () => {
  beforeEach(freshProject);

  it('records a comparison inside tolerance as a comparison, not a gap', () => {
    const result = aftercare.recordPerformanceComparison(asFM(), COMPARISON);
    assert.equal(result.gap, false);
    assert.equal(result.variancePercent, 6.7);

    const types = platform.ledger
      .events({ projectId: seed.projectId })
      .map((event) => event.eventType)
      .filter((type) => type === 'PERFORMANCE_COMPARED' || type === 'PERFORMANCE_GAP_IDENTIFIED');
    assert.deepEqual(types, ['PERFORMANCE_COMPARED']);
  });

  it('records a comparison outside tolerance as a gap', () => {
    const result = aftercare.recordPerformanceComparison(asFM(), { ...COMPARISON, measuredValue: 126 });
    assert.equal(result.gap, true);
    assert.equal(result.variancePercent, 40);

    const position = aftercare.aftercarePosition(asFM());
    assert.equal(position.comparisons[0]!.gap, true);
    assert.match(position.summary, /1 performance gap/);
  });

  /**
   * AC-H-WF-10-02. All three of period, baseline and operating context are
   * required, because a percentage against a target means nothing without them.
   */
  it('refuses a comparison with no period, no baseline or no operating context', () => {
    throwsCode(() => aftercare.recordPerformanceComparison(asFM(), { ...COMPARISON, periodFrom: 'winter' }), 'PERIOD_REQUIRED');
    throwsCode(
      () => aftercare.recordPerformanceComparison(asFM(), { ...COMPARISON, periodFrom: iso(-1), periodTo: iso(-180) }),
      'PERIOD_REQUIRED',
    );
    const baseline = throwsCode(
      () => aftercare.recordPerformanceComparison(asFM(), { ...COMPARISON, baselineValue: 0 }),
      'BASELINE_REQUIRED',
    );
    assert.match(String(baseline.message), /inventing a number/);
    const context = throwsCode(
      () => aftercare.recordPerformanceComparison(asFM(), { ...COMPARISON, operatingContext: 'Normal' }),
      'CONTEXT_REQUIRED',
    );
    assert.match(String(context.message), /half of it is not yet occupied/);
  });

  it('keeps the period, baseline and context on the record so a later reader has them', () => {
    aftercare.recordPerformanceComparison(asFM(), COMPARISON);
    const position = aftercare.aftercarePosition(asFM());
    const comparison = position.comparisons[0]!;
    assert.equal(comparison.baselineSource, 'DESIGN_INTENT');
    assert.equal(comparison.periodFrom, iso(-180));
    assert.match(comparison.operatingContext, /mild winter/);
  });

  it('refuses a comparison with no data source or no assessor', () => {
    throwsCode(() => aftercare.recordPerformanceComparison(asFM(), { ...COMPARISON, dataSource: '' }), 'SOURCE_REQUIRED');
    throwsCode(() => aftercare.recordPerformanceComparison(asFM(), { ...COMPARISON, assessedBy: '' }), 'SOURCE_REQUIRED');
  });
});

describe('H-WF-10 occupant feedback', () => {
  beforeEach(freshProject);

  it('records feedback against a role and a location', () => {
    const result = aftercare.recordFeedback(asFM(), FEEDBACK);
    assert.equal(result.theme, 'THERMAL_COMFORT');

    const position = aftercare.aftercarePosition(asFM());
    assert.equal(position.feedback.length, 1);
    assert.equal(position.feedback[0]!.location, 'Level 2 east');
    assert.equal(position.feedback[0]!.occurrences, 14);
  });

  /**
   * The privacy control, tested structurally rather than by asserting that a
   * validator stripped something. There is no field on the type a name could
   * occupy, so the ledger cannot hold one.
   */
  it('has no field a person could be named in', () => {
    aftercare.recordFeedback(asFM(), FEEDBACK);

    const state = platform.ledger.list(seed.projectId, 'OccupantFeedback')[0]!.state;
    for (const forbidden of ['name', 'person', 'occupantName', 'email', 'reportedBy', 'staffId']) {
      assert.equal(forbidden in state, false, `${forbidden} appears on the feedback record`);
    }
    // What it does carry is the role and the place, which is what makes it
    // actionable as a heating problem.
    assert.equal(state.reportedByRole, 'Floor warden');
    assert.equal(state.location, 'Level 2 east');
  });

  it('clusters feedback by theme and location, loudest first', () => {
    aftercare.recordFeedback(asFM(), FEEDBACK);
    aftercare.recordFeedback(asFM(), { ...FEEDBACK, occurrences: 3, severity: 'HIGH' });
    aftercare.recordFeedback(asFM(), {
      ...FEEDBACK,
      theme: 'ACOUSTICS',
      location: 'Level 4 atrium',
      description: 'Speech privacy is poor across the whole open area near the atrium void',
      occurrences: 2,
    });

    const clusters = aftercare.feedbackClusters(asFM());
    assert.equal(clusters.length, 2);
    assert.equal(clusters[0]!.theme, 'THERMAL_COMFORT');
    assert.equal(clusters[0]!.reports, 2);
    assert.equal(clusters[0]!.occurrences, 17);
    // The cluster carries the worst severity in it, not the latest.
    assert.equal(clusters[0]!.highest, 'HIGH');
  });

  it('refuses feedback with no location or role, and with no occurrence count', () => {
    const unplaced = throwsCode(() => aftercare.recordFeedback(asFM(), { ...FEEDBACK, location: '' }), 'FEEDBACK_UNPLACED');
    assert.match(String(unplaced.message), /turns a complaint into a heating problem/);
    throwsCode(() => aftercare.recordFeedback(asFM(), { ...FEEDBACK, reportedByRole: '' }), 'FEEDBACK_UNPLACED');
    throwsCode(() => aftercare.recordFeedback(asFM(), { ...FEEDBACK, occurrences: 0 }), 'OCCURRENCES_REQUIRED');
    throwsCode(() => aftercare.recordFeedback(asFM(), { ...FEEDBACK, description: 'Cold' }), 'FEEDBACK_UNDESCRIBED');
  });
});

describe('H-WF-10 post-occupancy review', () => {
  beforeEach(freshProject);

  const REVIEW = {
    reference: 'POE-001',
    reviewedBy: 'Client estates director',
    period: 'First twelve months of occupation',
    findings: 'Energy is within tolerance and thermal comfort on the east facade is not',
    correctiveActions: [
      {
        description: 'Rebalance the level 2 east perimeter heating and revise the morning boost schedule',
        owner: 'Controls subcontractor',
        by: iso(45),
        priority: 'HIGH' as const,
      },
    ],
    evidenceHash: 'f'.repeat(64),
  };

  it('completes a review against the comparisons and feedback it had to look at', () => {
    aftercare.recordPerformanceComparison(asFM(), { ...COMPARISON, measuredValue: 126 });
    aftercare.recordFeedback(asFM(), FEEDBACK);

    const result = aftercare.completePostOccupancyReview(asFM(), REVIEW);
    assert.equal(result.actions, 1);
    assert.equal(result.gapsConsidered, 1);
    assert.equal(result.feedbackConsidered, 1);
  });

  it('refuses a review written with nothing to review', () => {
    const error = throwsCode(() => aftercare.completePostOccupancyReview(asFM(), REVIEW), 'NOTHING_TO_REVIEW');
    assert.match(String(error.message), /the reputation it has/);
  });

  it('refuses a corrective action with no owner or no date', () => {
    aftercare.recordFeedback(asFM(), FEEDBACK);
    const error = throwsCode(
      () =>
        aftercare.completePostOccupancyReview(asFM(), {
          ...REVIEW,
          correctiveActions: [{ ...REVIEW.correctiveActions[0]!, owner: '' }],
        }),
      'ACTION_UNOWNED',
    );
    assert.match(String(error.message), /a priority nobody holds/);
  });

  it('refuses a review with no findings or no evidence', () => {
    aftercare.recordFeedback(asFM(), FEEDBACK);
    throwsCode(() => aftercare.completePostOccupancyReview(asFM(), { ...REVIEW, findings: 'Fine' }), 'FINDINGS_REQUIRED');
    throwsCode(
      () => aftercare.completePostOccupancyReview(asFM(), { ...REVIEW, evidenceHash: '' }),
      'REVIEW_EVIDENCE_REQUIRED',
    );
  });
});

describe('H-WF-10 lessons into organisation memory', () => {
  beforeEach(freshProject);

  function lesson(): string {
    const { lessonId } = control.captureLesson(asSafety(), {
      title: 'Medical gas commissioning witness slots were booked too late',
      category: 'HANDOVER',
      kind: 'WENT_WRONG',
      stage: 'DELIVERY',
      whatHappened: 'The specialist witness was booked six weeks out and the test packs were ready in three',
      recommendation: 'Book the specialist witness at the point the test pack is drafted, not when it is released',
      scheduleImpactDays: 21,
    });
    return lessonId;
  }

  it('keeps an unapproved lesson out of organisation memory', () => {
    lesson();
    assert.deepEqual(aftercare.reusableLessons(asSafety()), []);
  });

  it('approves a lesson with the sectors and stages where reuse is valid', () => {
    const lessonId = lesson();
    const result = aftercare.approveLesson(asSafety(), lessonId, {
      approvedBy: 'Head of quality',
      sectors: ['Healthcare'],
      stages: ['COMMISSIONING', 'HANDOVER'],
      applicabilityNote: 'Applies wherever a specialist third-party witness is required to attend a test',
    });
    assert.deepEqual(result.sectors, ['Healthcare']);

    const reusable = aftercare.reusableLessons(asSafety());
    assert.equal(reusable.length, 1);
    assert.match(reusable[0]!.recommendation, /at the point the test pack is drafted/);
  });

  /**
   * AC-H-WF-10-03. The tags are the control: a lesson from a hospital's
   * medical-gas commissioning is not a lesson about a warehouse.
   */
  it('serves an approved lesson only to the sectors and stages its own tags name', () => {
    const lessonId = lesson();
    aftercare.approveLesson(asSafety(), lessonId, {
      approvedBy: 'Head of quality',
      sectors: ['Healthcare'],
      stages: ['COMMISSIONING'],
      applicabilityNote: 'Applies wherever a specialist third-party witness is required to attend a test',
    });

    assert.equal(aftercare.reusableLessons(asSafety(), { sector: 'Healthcare' }).length, 1);
    assert.equal(aftercare.reusableLessons(asSafety(), { sector: 'Warehousing' }).length, 0);
    assert.equal(aftercare.reusableLessons(asSafety(), { stage: 'COMMISSIONING' }).length, 1);
    assert.equal(aftercare.reusableLessons(asSafety(), { stage: 'CONCEPT' }).length, 0);
  });

  it('refuses an approval with no sectors, no stages or no reason it transfers', () => {
    const lessonId = lesson();
    const base = { approvedBy: 'Head of quality', sectors: ['Healthcare'], stages: ['COMMISSIONING'] };
    const noSector = throwsCode(
      () => aftercare.approveLesson(asSafety(), lessonId, { ...base, sectors: [], applicabilityNote: 'It transfers widely enough' }),
      'APPLICABILITY_REQUIRED',
    );
    assert.match(String(noSector.message), /wrong with authority/);
    throwsCode(
      () => aftercare.approveLesson(asSafety(), lessonId, { ...base, stages: [], applicabilityNote: 'It transfers widely enough' }),
      'APPLICABILITY_REQUIRED',
    );
    throwsCode(
      () => aftercare.approveLesson(asSafety(), lessonId, { ...base, applicabilityNote: 'Useful' }),
      'APPLICABILITY_REQUIRED',
    );
  });

  it('refuses a second approval and a lesson that does not exist', () => {
    const lessonId = lesson();
    const approval = {
      approvedBy: 'Head of quality',
      sectors: ['Healthcare'],
      stages: ['COMMISSIONING'],
      applicabilityNote: 'Applies wherever a specialist third-party witness attends a test',
    };
    aftercare.approveLesson(asSafety(), lessonId, approval);
    throwsCode(() => aftercare.approveLesson(asSafety(), lessonId, approval), 'ALREADY_APPROVED');
    throwsCode(() => aftercare.approveLesson(asSafety(), 'NOPE', approval), 'LESSON_NOT_FOUND');
  });
});

describe('H-WF-10 catalogue and classification', () => {
  it('registers every aftercare event with no AI mandate', () => {
    for (const [code, entity] of [
      ['AFTERCARE_STARTED', 'AftercarePlan'],
      ['SEASONAL_TEST_COMPLETED', 'SeasonalTest'],
      ['PERFORMANCE_COMPARED', 'PerformanceComparison'],
      ['PERFORMANCE_GAP_IDENTIFIED', 'PerformanceComparison'],
      ['OCCUPANT_FEEDBACK_RECORDED', 'OccupantFeedback'],
      ['POST_OCCUPANCY_REVIEWED', 'PostOccupancyReview'],
      ['LESSON_APPROVED', 'LessonLearned'],
    ] as const) {
      const definition = lookupEventType(code);
      assert.ok(definition, `${code} is not in the catalogue`);
      assert.equal(definition.entity, entity);
      // "Recommend optimisation with evidence; operator authorises changes."
      assert.equal(definition.aiAllowed, false, `${code} must carry no AI mandate`);
    }
  });

  it('classifies occupant feedback as internal', () => {
    assert.equal(classifyEntity('OccupantFeedback')?.sensitivity, 'INTERNAL');
    assert.equal(classifyEntity('AftercarePlan')?.area, 'HANDOVER_OM');
    assert.equal(classifyEntity('PerformanceComparison')?.area, 'HANDOVER_OM');
    assert.equal(classifyEntity('PostOccupancyReview')?.area, 'HANDOVER_OM');
  });
});
