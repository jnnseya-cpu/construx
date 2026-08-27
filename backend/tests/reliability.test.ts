import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import * as reliability from '../src/domain/reliability.ts';
import * as structure from '../src/domain/structure.ts';
import * as systemisation from '../src/domain/systemisation.ts';
import { lookupEventType } from '../src/goldenthread/eventTypes.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * CM-WF-06 — reliability, soak, continuous performance and the seasonal plan.
 *
 * The only commissioning test that cannot be passed by doing something well
 * once. What is tested here is that the metrics are arithmetic over the trend
 * rather than a stored number, that a gap in the data is a hole in the evidence,
 * that a manual override counts against the result, and that a seasonal test is
 * an accepted obligation rather than an intention.
 */

let platform: Platform;
let seed: SeedResult;

const asQAQC = () => platform.context(seed.users.qaqc!.auth, seed.projectId, { source: 'WEB' });
const asPlanner = () => platform.context(seed.users.planner!.auth, seed.projectId, { source: 'WEB' });

/** A fixed base so the arithmetic in these tests is exact rather than approximate. */
const BASE = Date.parse('2026-07-06T00:00:00.000Z');
const at = (hours: number) => new Date(BASE + hours * 3_600_000).toISOString();

const RUN = {
  reference: 'RUN-001',
  systemTag: 'MEC-VENT',
  from: at(0),
  to: at(168),
  requiredHours: 160,
  operatingEnvelope: 'Full occupied-mode duty with the building at design occupancy and the chillers available.',
  availabilityTargetPercent: 98,
  permittedInterruptionMinutes: 60,
  dataGapToleranceMinutes: 120,
  resetRule: 'Any unplanned shutdown of the supply fan resets the run; a planned changeover under 30 minutes does not.',
  operationsAttendance: 'K. Mensah, estates duty engineer',
};

async function freshProject() {
  platform = new Platform();
  seed = await seedDemoProject(platform);
  structure.transitionPhase(platform.context(seed.users.owner!.auth, seed.projectId, { source: 'WEB' }), {
    to: 'COMMISSIONING',
    justification: 'Running the soak tests',
  });

  systemisation.defineSystem(asQAQC(), {
    tag: 'FAC-01',
    level: 'FACILITY',
    name: 'Riverside Laboratory',
    boundary: 'The whole demised premises within the site boundary, excluding incoming utility connections.',
  });
  systemisation.defineSystem(asQAQC(), {
    tag: 'MEC-VENT',
    level: 'SYSTEM',
    parentTag: 'FAC-01',
    name: 'Ventilation',
    boundary: 'All supply and extract air handling from intake louvre to terminal device.',
    assetTags: ['AHU-01'],
  });
}

/** The whole window covered, in two segments with no gap between them. */
function fullCoverage(runId: string) {
  reliability.importTrendSegment(asQAQC(), runId, {
    source: 'BMS trend export',
    from: at(0),
    to: at(84),
    points: 5040,
    datasetHash: 'a'.repeat(64),
  });
  reliability.importTrendSegment(asQAQC(), runId, {
    source: 'BMS trend export',
    from: at(84),
    to: at(168),
    points: 5040,
    datasetHash: 'b'.repeat(64),
  });
}

describe('CM-WF-06 the register', () => {
  beforeEach(freshProject);

  it('registers its seven event types, and none is available to an agent', () => {
    for (const [code, entity] of [
      ['RELIABILITY_TEST_STARTED', 'ReliabilityRun'],
      ['RELIABILITY_TREND_IMPORTED', 'ReliabilityRun'],
      ['RELIABILITY_INTERVENTION_LOGGED', 'ReliabilityRun'],
      ['PERFORMANCE_ANOMALY_DETECTED', 'ReliabilityRun'],
      ['RELIABILITY_ANOMALY_DECIDED', 'ReliabilityRun'],
      ['RELIABILITY_TEST_ACCEPTED', 'ReliabilityRun'],
      ['SEASONAL_TEST_PLANNED', 'SeasonalTest'],
    ] as const) {
      const definition = lookupEventType(code);
      assert.ok(definition, `${code} is not in the catalogue`);
      assert.equal(definition.entity, entity);
      // "Forecast failure risk; authorised engineer accepts test result."
      assert.equal(definition.aiAllowed, false);
    }
  });
});

describe('AC-CM-WF-06-01 metrics reproduce from the trend and the configuration', () => {
  beforeEach(freshProject);

  it('derives coverage, availability and evidenced hours rather than storing them', () => {
    const { runId } = reliability.startReliabilityRun(asQAQC(), RUN);
    fullCoverage(runId);

    const run = reliability.reliabilityPosition(asQAQC()).runs[0]!;
    assert.equal(run.metrics.windowMinutes, 168 * 60);
    assert.equal(run.metrics.coveredMinutes, 168 * 60);
    assert.equal(run.metrics.gapMinutes, 0);
    assert.equal(run.metrics.availabilityPercent, 100);
    assert.equal(run.metrics.evidencedHours, 168);
  });

  it('counts overlapping segments once rather than twice', () => {
    // Two exports of the same fortnight is the commonest way a trend is
    // assembled, and a naive sum would report 200% coverage of the window.
    const { runId } = reliability.startReliabilityRun(asQAQC(), RUN);
    reliability.importTrendSegment(asQAQC(), runId, {
      source: 'BMS export A',
      from: at(0),
      to: at(100),
      points: 6000,
      datasetHash: 'c'.repeat(64),
    });
    reliability.importTrendSegment(asQAQC(), runId, {
      source: 'BMS export B',
      from: at(50),
      to: at(168),
      points: 7080,
      datasetHash: 'd'.repeat(64),
    });

    const run = reliability.reliabilityPosition(asQAQC()).runs[0]!;
    assert.equal(run.metrics.coveredMinutes, 168 * 60);
    assert.equal(run.metrics.gapMinutes, 0);
  });

  it('recomputes the same answer from the same state', () => {
    const { runId } = reliability.startReliabilityRun(asQAQC(), RUN);
    fullCoverage(runId);
    reliability.recordIntervention(asQAQC(), runId, {
      at: at(40),
      kind: 'CORRECTIVE',
      description: 'Supply fan tripped on high static and was restarted after the filter was changed.',
      downtimeMinutes: 45,
      by: 'K. Mensah',
    });

    const first = reliability.reliabilityPosition(asQAQC()).runs[0]!.metrics;
    const second = reliability.reliabilityPosition(asQAQC()).runs[0]!.metrics;
    assert.deepEqual(first, second);
    assert.equal(first.downtimeMinutes, 45);
    // 10,080 window minutes, 45 down: 99.6% to one decimal.
    assert.equal(first.availabilityPercent, 99.6);
  });

  it('refuses a run whose window cannot contain the duration it needs', () => {
    const refusal = throwsCode(
      () => reliability.startReliabilityRun(asQAQC(), { ...RUN, to: at(100) }),
      'WINDOW_TOO_SHORT',
    );
    assert.match(refusal.message ?? '', /finding that out at the end is the expensive way/);
  });

  it('refuses a run with no envelope, no reset rule or nobody from operations', () => {
    throwsCode(() => reliability.startReliabilityRun(asQAQC(), { ...RUN, operatingEnvelope: 'Full duty.' }), 'ENVELOPE_REQUIRED');
    throwsCode(() => reliability.startReliabilityRun(asQAQC(), { ...RUN, resetRule: '  ' }), 'RESET_RULE_REQUIRED');
    const refusal = throwsCode(
      () => reliability.startReliabilityRun(asQAQC(), { ...RUN, operationsAttendance: '  ' }),
      'OPERATIONS_ATTENDANCE_REQUIRED',
    );
    assert.match(refusal.message ?? '', /no reason to accept/);
  });

  it('refuses trend from outside the run window', () => {
    const { runId } = reliability.startReliabilityRun(asQAQC(), RUN);
    const refusal = throwsCode(
      () =>
        reliability.importTrendSegment(asQAQC(), runId, {
          source: 'BMS export',
          from: at(-24),
          to: at(24),
          points: 2880,
          datasetHash: 'e'.repeat(64),
        }),
      'SEGMENT_OUTSIDE_WINDOW',
    );
    assert.match(refusal.message ?? '', /does not evidence the run/);
  });
});

describe('a data gap is a hole in the evidence', () => {
  beforeEach(freshProject);

  it('derives the gap from what was imported rather than asking about it', () => {
    const { runId } = reliability.startReliabilityRun(asQAQC(), RUN);
    reliability.importTrendSegment(asQAQC(), runId, {
      source: 'BMS export',
      from: at(0),
      to: at(80),
      points: 4800,
      datasetHash: 'f'.repeat(64),
    });
    reliability.importTrendSegment(asQAQC(), runId, {
      source: 'BMS export',
      from: at(86),
      to: at(168),
      points: 4920,
      datasetHash: '1'.repeat(64),
    });

    const run = reliability.reliabilityPosition(asQAQC()).runs[0]!;
    assert.equal(run.metrics.gapMinutes, 6 * 60);
    assert.equal(run.metrics.gapWithinTolerance, false);
  });

  it('refuses acceptance on a dataset with a day missing from the middle', () => {
    const { runId } = reliability.startReliabilityRun(asQAQC(), RUN);
    reliability.importTrendSegment(asQAQC(), runId, {
      source: 'BMS export',
      from: at(0),
      to: at(72),
      points: 4320,
      datasetHash: '2'.repeat(64),
    });
    reliability.importTrendSegment(asQAQC(), runId, {
      source: 'BMS export',
      from: at(96),
      to: at(168),
      points: 4320,
      datasetHash: '3'.repeat(64),
    });

    const refusal = throwsCode(
      () =>
        reliability.acceptReliabilityRun(asQAQC(), runId, {
          acceptedBy: 'S. Kaur',
          note: 'The plant ran without incident throughout.',
        }),
      'DATA_GAP',
    );
    assert.match(refusal.message ?? '', /1440 minutes of the window carry no trend data/);
    assert.match(refusal.message ?? '', /proves nothing about that day/);
  });
});

describe('a manual override is a fact about the result', () => {
  beforeEach(freshProject);

  it('counts it against availability and names it in the refusal', () => {
    const { runId } = reliability.startReliabilityRun(asQAQC(), RUN);
    fullCoverage(runId);
    reliability.recordIntervention(asQAQC(), runId, {
      at: at(30),
      kind: 'MANUAL_OVERRIDE',
      description: 'Frost coil valve driven to 100% in hand overnight to stop a recurring low-limit alarm.',
      downtimeMinutes: 600,
      by: 'K. Mensah',
    });

    const refusal = throwsCode(
      () =>
        reliability.acceptReliabilityRun(asQAQC(), runId, {
          acceptedBy: 'S. Kaur',
          note: 'The plant ran through the week with one valve in hand.',
        }),
      'AVAILABILITY_NOT_MET',
    );
    assert.match(refusal.message ?? '', /600 minutes in manual override/);
    assert.match(refusal.message ?? '', /not controlling itself/);
  });

  it('refuses an intervention recorded as "reset" with nothing behind it', () => {
    const { runId } = reliability.startReliabilityRun(asQAQC(), RUN);
    const refusal = throwsCode(
      () =>
        reliability.recordIntervention(asQAQC(), runId, {
          at: at(30),
          kind: 'CORRECTIVE',
          description: 'Reset',
          downtimeMinutes: 5,
          by: 'K. Mensah',
        }),
      'INTERVENTION_UNDESCRIBED',
    );
    assert.match(refusal.message ?? '', /nobody can tell apart from a fault/);
  });
});

describe('AC-CM-WF-06-02 continue, reset or retest is authorised', () => {
  beforeEach(freshProject);

  it('pauses the run on an anomaly and resumes it on an authorised continue', () => {
    const { runId } = reliability.startReliabilityRun(asQAQC(), RUN);
    fullCoverage(runId);
    reliability.flagAnomaly(asQAQC(), runId, {
      reference: 'AN-001',
      kind: 'DRIFT',
      detail: 'Supply temperature drifted 1.8°C above setpoint over four days before recovering.',
      detectedBy: 'Performance agent, confirmed by K. Mensah',
    });

    assert.deepEqual(reliability.reliabilityPosition(asQAQC()).runs[0]!.openAnomalies, ['AN-001']);
    throwsCode(
      () =>
        reliability.acceptReliabilityRun(asQAQC(), runId, {
          acceptedBy: 'S. Kaur',
          note: 'Ran the full duration within availability.',
        }),
      'ANOMALIES_UNDECIDED',
    );

    const result = reliability.decideAnomaly(asQAQC(), runId, {
      reference: 'AN-001',
      decision: 'CONTINUE',
      rationale: 'The drift tracked an unusually warm spell outside the design envelope and recovered without intervention.',
      authorisedBy: 'S. Kaur',
    });
    assert.equal(result.status, 'RUNNING');

    const accepted = reliability.acceptReliabilityRun(asQAQC(), runId, {
      acceptedBy: 'S. Kaur',
      note: 'Full duration evidenced at 100% availability with one drift anomaly reviewed and accepted.',
    });
    assert.equal(accepted.metrics.meetsDuration, true);
  });

  it('refuses a decision with no reasoning or no authority', () => {
    const { runId } = reliability.startReliabilityRun(asQAQC(), RUN);
    reliability.flagAnomaly(asQAQC(), runId, {
      reference: 'AN-002',
      kind: 'HIDDEN_INTERVENTION',
      detail: 'A step change in the return temperature suggests a valve was driven in hand overnight.',
      detectedBy: 'Performance agent',
    });
    const refusal = throwsCode(
      () =>
        reliability.decideAnomaly(asQAQC(), runId, {
          reference: 'AN-002',
          decision: 'CONTINUE',
          rationale: 'Fine.',
          authorisedBy: 'S. Kaur',
        }),
      'RATIONALE_REQUIRED',
    );
    assert.match(refusal.message ?? '', /both are decisions somebody has to stand behind/);

    const unauthorised = throwsCode(
      () =>
        reliability.decideAnomaly(asQAQC(), runId, {
          reference: 'AN-002',
          decision: 'CONTINUE',
          rationale: 'The step change matches a scheduled changeover recorded in the interventions log.',
          authorisedBy: '  ',
        }),
      'DECISION_UNAUTHORISED',
    );
    assert.match(unauthorised.message ?? '', /nearest the panel/);
  });

  it('will not accept the part of a run that was reset', () => {
    const { runId } = reliability.startReliabilityRun(asQAQC(), RUN);
    fullCoverage(runId);
    reliability.flagAnomaly(asQAQC(), runId, {
      reference: 'AN-003',
      kind: 'PERFORMANCE',
      detail: 'Supply fan tripped twice on high static within an hour and would not restart.',
      detectedBy: 'K. Mensah',
    });
    reliability.decideAnomaly(asQAQC(), runId, {
      reference: 'AN-003',
      decision: 'RESET',
      rationale: 'An unplanned shutdown of the supply fan resets the run under the agreed rule.',
      authorisedBy: 'S. Kaur',
    });

    const refusal = throwsCode(
      () => reliability.acceptReliabilityRun(asQAQC(), runId, { acceptedBy: 'S. Kaur', note: 'Most of it ran fine.' }),
      'RUN_RESET',
    );
    assert.match(refusal.message ?? '', /rather than accepting the part of it that ran/);
  });

  it('refuses a decision from a role that only reads the commissioning record', () => {
    const { runId } = reliability.startReliabilityRun(asQAQC(), RUN);
    reliability.flagAnomaly(asQAQC(), runId, {
      reference: 'AN-004',
      kind: 'DRIFT',
      detail: 'Setpoint drift observed over four days.',
      detectedBy: 'K. Mensah',
    });
    throwsCode(
      () =>
        reliability.decideAnomaly(asPlanner(), runId, {
          reference: 'AN-004',
          decision: 'CONTINUE',
          rationale: 'It looked fine to me on the graph when I saw it.',
          authorisedBy: 'A. Planner',
        }),
      'ACCESS_DENIED',
    );
  });

  it('refuses acceptance short of the duration the criteria require', () => {
    const { runId } = reliability.startReliabilityRun(asQAQC(), { ...RUN, dataGapToleranceMinutes: 10_000 });
    reliability.importTrendSegment(asQAQC(), runId, {
      source: 'BMS export',
      from: at(0),
      to: at(100),
      points: 6000,
      datasetHash: '4'.repeat(64),
    });
    const refusal = throwsCode(
      () => reliability.acceptReliabilityRun(asQAQC(), runId, { acceptedBy: 'S. Kaur', note: 'Ran well for four days.' }),
      'DURATION_NOT_MET',
    );
    assert.match(refusal.message ?? '', /100 hours evidenced against 160 required/);
  });
});

describe('AC-CM-WF-06-03 a seasonal test is an accepted obligation', () => {
  beforeEach(freshProject);

  it('fixes the criteria now and names the party accepting responsibility', () => {
    reliability.planSeasonalTest(asQAQC(), {
      reference: 'ST-001',
      systemTag: 'MEC-VENT',
      condition: 'Outside air below 2°C sustained for six hours, which cannot occur before handover in July.',
      criteria: 'Frost protection holds the coil above 5°C with the supply air within 1.5°C of setpoint throughout.',
      owner: 'D. Okonjo',
      ownerOrganisation: 'Mechanical subcontractor',
      responsibilityAcceptedBy: 'Main contractor, under the aftercare obligations in the employer’s requirements',
      windowFrom: '2026-11-01',
      windowTo: '2027-03-31',
    });

    const seasonal = reliability.reliabilityPosition(asQAQC()).seasonal[0]!;
    assert.equal(seasonal.reference, 'ST-001');
    assert.match(seasonal.criteria, /within 1.5°C of setpoint/);
    assert.match(seasonal.responsibilityAcceptedBy, /Main contractor/);
    assert.match(reliability.reliabilityPosition(asQAQC()).summary, /seasonal test owed after handover/);
  });

  it('refuses a plan with vague criteria, a vague condition or nobody accepting it', () => {
    const base = {
      reference: 'ST-002',
      systemTag: 'MEC-VENT',
      condition: 'Outside air below 2°C sustained for six hours.',
      criteria: 'Frost protection holds the coil above 5°C with the supply air within 1.5°C of setpoint.',
      owner: 'D. Okonjo',
      ownerOrganisation: 'Mechanical subcontractor',
      responsibilityAcceptedBy: 'Main contractor',
      windowFrom: '2026-11-01',
      windowTo: '2027-03-31',
    };
    const condition = throwsCode(
      () => reliability.planSeasonalTest(asQAQC(), { ...base, condition: 'Winter' }),
      'CONDITION_REQUIRED',
    );
    assert.match(condition.message ?? '', /"Seasonal" is not a condition/);

    const criteria = throwsCode(
      () => reliability.planSeasonalTest(asQAQC(), { ...base, criteria: 'It works.' }),
      'CRITERIA_REQUIRED',
    );
    assert.match(criteria.message ?? '', /agreed under pressure/);

    const unaccepted = throwsCode(
      () => reliability.planSeasonalTest(asQAQC(), { ...base, responsibilityAcceptedBy: '  ' }),
      'RESPONSIBILITY_UNACCEPTED',
    );
    assert.match(unaccepted.message ?? '', /two winters later as a defect/);
  });

  it('exposes outstanding tests as one list, for the handover stage to inherit by reference', () => {
    reliability.planSeasonalTest(asQAQC(), {
      reference: 'ST-003',
      systemTag: 'MEC-VENT',
      condition: 'Peak summer cooling load, with outside air above 28°C sustained.',
      criteria: 'Space temperature held within 2°C of setpoint at design occupancy across all zones.',
      owner: 'D. Okonjo',
      ownerOrganisation: 'Mechanical subcontractor',
      responsibilityAcceptedBy: 'Main contractor',
      windowFrom: '2027-06-01',
      windowTo: '2027-08-31',
    });
    assert.equal(reliability.outstandingSeasonalTests(asQAQC()).length, 1);
  });
});
