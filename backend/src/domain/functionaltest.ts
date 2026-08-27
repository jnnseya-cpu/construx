import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, registerEvidence, write, type EngineContext } from '../engines/context.ts';
import { invalidatedTests } from './commissioningexception.ts';
import { functionalTestBlockedReason } from './prefunctional.ts';
import { calibrationBlockedReason } from './qualitycontrol.ts';
import { executionBlockedReason, satisfies, type AcceptanceCriterion } from './testpack.ts';

/**
 * CM-WF-05 — functional performance and integrated systems testing.
 *
 * The point at which the plant is asked to do the thing it was bought to do. The
 * criteria, units and limits come from CM-WF-02's released pack; the
 * calculated-result-beside-authorised-decision split is CM-WF-03's, unchanged;
 * failures raise into CM-WF-07's exception; and a system that has not been
 * released for functional testing is refused by CM-WF-04's guard. Almost nothing
 * here is a new idea — what is new is what a functional test records that a
 * factory test does not.
 *
 * **A response, not just a number.** AC-CM-WF-05-01: the system's behaviour has
 * to be reconstructable from timestamped raw evidence. A damper that eventually
 * closed and a damper that closed in eight seconds are the same reading and
 * different systems, so every step records what was observed, when, and where
 * the trend or alarm log that shows it lives. The trend dataset is referenced by
 * hash rather than summarised, because a summary of a trend is an opinion about
 * a trend.
 *
 * **An abort is not a fail.** The exception control, and it matters because the
 * two are recorded identically on most systems and mean opposite things. A test
 * abandoned because the chilled water was off tells you nothing about the plant;
 * recording it as a failure puts a defect against equipment that was never
 * tested. An abort keeps its partial data and its reason, and somebody decides
 * afterwards whether it becomes a failure.
 *
 * **A deviation from the script is an annotation, not an edit.** Engineers
 * deviate for good reasons and the deviation is often the most useful thing in
 * the record. What it may not do is quietly change what was proven, so it is
 * authorised by name and carries an explicit judgement on whether the result
 * still stands.
 *
 * **An integrated test cannot pass on unproven dependencies.** The last
 * exception control. A fire-alarm cause-and-effect test that passes while the
 * ventilation it commands is conditionally accepted has proved that the
 * ventilation did what it was told this once, which is not the same as the
 * ventilation working.
 */

export const FUNCTIONAL_TEST_KIND = ['FUNCTIONAL', 'INTEGRATED'] as const;
export type FunctionalTestKind = (typeof FUNCTIONAL_TEST_KIND)[number];

export type StepResult = {
  step: number;
  /** The criterion this step answers, where it answers one. */
  criterionRef?: string;
  /** What the system did, in the words of the person watching it. */
  actualResponse: string;
  value?: number;
  unit?: string;
  instrumentId?: string;
  /** Seconds from the stimulus to the response, where the criterion is a time. */
  responseTimeSeconds?: number;
  performedBy: string;
  observedAt: string;
  /** Computed where the step carries a value against a criterion with limits. */
  withinLimits?: boolean;
};

export type TrendDataset = {
  source: string;
  from: string;
  to: string;
  evidenceRef: string;
  points: number;
};

export type ScriptDeviation = {
  step: number;
  deviation: string;
  authorisedBy: string;
  /** Whether the result still stands. An engineer decides; the platform records. */
  invalidatesResult: boolean;
  annotatedAt: string;
};

export type FunctionalTestState = {
  testId: string;
  reference: string;
  kind: FunctionalTestKind;
  packId: string;
  systemTag: string;
  dependentSystems: string[];
  scenario?: string;
  witnesses: Array<{ name: string; organisation: string; attended: boolean }>;
  steps: StepResult[];
  trends: TrendDataset[];
  deviations: ScriptDeviation[];
  status: 'IN_PROGRESS' | 'ABORTED' | 'COMPLETE' | 'RETEST_REQUIRED';
  abort?: { reason: string; abortedBy: string; abortedAt: string };
  calculatedResult?: 'PASS' | 'FAIL';
  decision?: 'PASS' | 'FAIL' | 'CONDITIONAL';
  decisionNote?: string;
  decidedBy?: string;
  retestOf?: string;
};

function requireTest(ctx: EngineContext, testId: string) {
  const record = ctx.ledger.get({ refType: 'FunctionalTest', refId: testId });
  if (!record) throw new DomainError('TEST_NOT_FOUND', `No functional test ${testId}`, 404);
  return record;
}

function stateOf(record: { state: Record<string, unknown> }): FunctionalTestState {
  return record.state as unknown as FunctionalTestState;
}

function criteriaOf(ctx: EngineContext, packId: string): AcceptanceCriterion[] {
  const pack = ctx.ledger.get({ refType: 'TestPack', refId: packId });
  if (!pack) throw new DomainError('PACK_NOT_FOUND', `No test pack ${packId}`, 404);
  return (pack.state.criteria as AcceptanceCriterion[] | undefined) ?? [];
}

/** The accepted decision on a system's functional test, or undefined. */
function decisionFor(ctx: EngineContext, systemTag: string): FunctionalTestState | undefined {
  return ctx.ledger
    .list(ctx.projectId, 'FunctionalTest')
    .map(stateOf)
    .filter((state) => state.systemTag === systemTag && state.kind === 'FUNCTIONAL' && state.status === 'COMPLETE')
    .pop();
}

/** Start a functional or integrated test. */
export function startFunctionalTest(
  ctx: EngineContext,
  input: {
    reference: string;
    kind: FunctionalTestKind;
    packId: string;
    systemTag: string;
    dependentSystems?: string[];
    scenario?: string;
    witnesses: Array<{ name: string; organisation: string; attended: boolean }>;
    retestOf?: string;
  },
): { testId: string } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'C', { lifecyclePhase: currentPhase(ctx) });

  if (!input.reference.trim()) throw new DomainError('TEST_UNREFERENCED', 'A functional test carries a reference.');

  const released = executionBlockedReason(ctx, input.packId);
  if (released) throw new DomainError('PACK_NOT_RELEASED', released);

  // AC-CM-WF-04-03, enforced where it bites rather than only reported.
  const staticBlock = functionalTestBlockedReason(ctx, input.systemTag);
  if (staticBlock) throw new DomainError('SYSTEM_NOT_RELEASED', staticBlock);

  // AC-CM-WF-07-02: an invalidation is actionable, not merely visible. A test an
  // open exception has invalidated cannot be re-run as though nothing happened —
  // the retest route exists for exactly that.
  const invalidation = invalidatedTests(ctx).find((entry) => entry.testRef === input.reference);
  if (invalidation && !input.retestOf) {
    throw new DomainError(
      'TEST_INVALIDATED',
      `${input.reference} was invalidated by ${invalidation.by}: ${invalidation.rationale} Run it as a retest against ` +
        'that exception, so the failure and the succeeding result stay connected.',
    );
  }

  const dependentSystems = input.dependentSystems ?? [];

  if (input.kind === 'INTEGRATED') {
    if (dependentSystems.length === 0) {
      throw new DomainError(
        'DEPENDENCIES_REQUIRED',
        'An integrated test names the systems it depends on. One that depends on nothing is a functional test.',
      );
    }
    if (!input.scenario?.trim()) {
      throw new DomainError(
        'SCENARIO_REQUIRED',
        'Name the scenario being run. "Integrated testing" is not a scenario; "fire alarm zone 3 in alarm with the ' +
          'building occupied" is.',
      );
    }

    // The last exception control, checked at the start rather than at the end,
    // because the wasted day is the point of checking it.
    const unproven = dependentSystems.filter((tag) => {
      const decision = decisionFor(ctx, tag);
      return !decision || decision.decision !== 'PASS';
    });
    if (unproven.length > 0) {
      throw new DomainError(
        'DEPENDENCY_UNPROVEN',
        `${unproven.join(', ')} ${unproven.length === 1 ? 'has' : 'have'} no passed functional test. An integrated test ` +
          'that passes over a dependent system still conditional or failed proves the dependency did what it was told this ' +
          'once, which is not the same as the dependency working.',
      );
    }
  }

  const testId = ulid();

  write(ctx, {
    eventType: input.kind === 'FUNCTIONAL' ? 'FUNCTIONAL_TEST_STARTED' : 'INTEGRATED_TEST_STARTED',
    entity: { refType: 'FunctionalTest', refId: testId },
    nextState: {
      testId,
      projectId: ctx.projectId,
      reference: input.reference,
      kind: input.kind,
      packId: input.packId,
      systemTag: input.systemTag,
      dependentSystems,
      scenario: input.scenario,
      witnesses: input.witnesses,
      steps: [],
      trends: [],
      deviations: [],
      status: 'IN_PROGRESS',
      retestOf: input.retestOf,
      startedBy: ctx.auth.actorId,
      startedAt: new Date().toISOString(),
    },
  });

  return { testId };
}

/**
 * Record what the system did at one step.
 *
 * The response in words is required even where a value is taken, because the
 * value is what was measured and the response is what happened, and the second
 * is what a person reading this in two years needs.
 */
export function recordStepResult(
  ctx: EngineContext,
  testId: string,
  input: Omit<StepResult, 'withinLimits' | 'observedAt'> & { observedAt?: string },
): { withinLimits?: boolean; steps: number } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'U', { lifecyclePhase: currentPhase(ctx) });

  const record = requireTest(ctx, testId);
  const state = stateOf(record);
  if (state.status !== 'IN_PROGRESS') {
    throw new DomainError(
      'TEST_NOT_RUNNING',
      `${state.reference} is ${state.status.toLowerCase().replace('_', ' ')}. A step recorded afterwards changes a result ` +
        'somebody has already relied on.',
    );
  }

  if (!input.actualResponse.trim()) {
    throw new DomainError(
      'RESPONSE_REQUIRED',
      'Say what the system did. A damper that eventually closed and one that closed in eight seconds give the same reading ' +
        'and are different systems.',
    );
  }
  if (!input.performedBy.trim()) throw new DomainError('PERFORMER_REQUIRED', 'Name who observed it.');

  const observedAt = input.observedAt ?? new Date().toISOString();

  let withinLimits: boolean | undefined;
  if (input.criterionRef !== undefined) {
    const criterion = criteriaOf(ctx, state.packId).find((entry) => entry.reference === input.criterionRef);
    if (!criterion) {
      throw new DomainError('CRITERION_NOT_FOUND', `${input.criterionRef} is not a criterion in the released pack.`, 404);
    }
    if (input.value !== undefined) {
      if (input.unit !== criterion.unit) {
        throw new DomainError(
          'UNIT_MISMATCH',
          `${input.criterionRef} is measured in ${criterion.unit} and the step records ${input.unit ?? 'no unit'}.`,
        );
      }
      if (input.instrumentId) {
        const calibration = calibrationBlockedReason(ctx, input.instrumentId, observedAt.slice(0, 10));
        if (calibration) throw new DomainError('INSTRUMENT_NOT_CALIBRATED', calibration);
      }
      withinLimits = satisfies(criterion, input.value);
    } else if (input.responseTimeSeconds !== undefined) {
      withinLimits = satisfies(criterion, input.responseTimeSeconds);
    } else {
      throw new DomainError(
        'MEASUREMENT_REQUIRED',
        `Step ${input.step} answers ${input.criterionRef} but records neither a value nor a response time. A criterion ` +
          'answered by a description alone cannot be recalculated by anybody.',
      );
    }
  }

  const steps = [...state.steps, { ...input, observedAt, withinLimits }];

  write(ctx, {
    eventType: 'FUNCTIONAL_STEP_RECORDED',
    entity: { refType: 'FunctionalTest', refId: testId },
    nextState: { ...record.state, steps },
  });

  return { withinLimits, steps: steps.length };
}

/**
 * Attach the trend or alarm dataset the response can be reconstructed from.
 *
 * Referenced by hash, never summarised. A summary of a trend is an opinion about
 * a trend, and AC-CM-WF-05-01 asks for the raw evidence.
 */
export function attachTrendDataset(
  ctx: EngineContext,
  testId: string,
  input: { source: string; from: string; to: string; points: number; datasetHash: string },
): { evidenceRef: string } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'U', { lifecyclePhase: currentPhase(ctx) });

  const record = requireTest(ctx, testId);
  const state = stateOf(record);

  if (!input.source.trim() || !input.datasetHash.trim()) {
    throw new DomainError('DATASET_UNREFERENCED', 'A trend dataset names its source and carries the hash of the data.');
  }
  if (Number.isNaN(Date.parse(input.from)) || Number.isNaN(Date.parse(input.to))) {
    throw new DomainError('WINDOW_REQUIRED', 'A trend dataset covers a window between two instants.');
  }
  if (Date.parse(input.to) <= Date.parse(input.from)) {
    throw new DomainError('WINDOW_REQUIRED', 'The end of the window is not after the start of it.');
  }
  if (input.points <= 0) {
    throw new DomainError('DATASET_EMPTY', 'A trend dataset with no points in it proves nothing about the response.');
  }

  const evidence = registerEvidence(ctx, {
    type: 'COMMISSIONING_TREND_DATASET',
    hash: input.datasetHash,
    description: `${state.reference} trend from ${input.source}, ${input.points} points between ${input.from} and ${input.to}`,
    linkedEntities: [{ refType: 'FunctionalTest', refId: testId }],
  });

  write(ctx, {
    eventType: 'FUNCTIONAL_STEP_RECORDED',
    entity: { refType: 'FunctionalTest', refId: testId },
    nextState: {
      ...record.state,
      trends: [
        ...state.trends,
        { source: input.source, from: input.from, to: input.to, evidenceRef: evidence.refId, points: input.points },
      ],
    },
    evidenceRefs: [evidence],
  });

  return { evidenceRef: evidence.refId };
}

/** Annotate a deviation from the script, with an explicit judgement on the result. */
export function recordScriptDeviation(
  ctx: EngineContext,
  testId: string,
  input: { step: number; deviation: string; authorisedBy: string; invalidatesResult: boolean },
): { deviations: number } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'U', { lifecyclePhase: currentPhase(ctx) });

  const record = requireTest(ctx, testId);
  const state = stateOf(record);

  if (input.deviation.trim().length < 10) {
    throw new DomainError(
      'DEVIATION_UNDESCRIBED',
      'Say what was done differently. Engineers deviate for good reasons and the deviation is often the most useful thing ' +
        'in the record; what it may not do is quietly change what was proven.',
    );
  }
  if (!input.authorisedBy.trim()) {
    throw new DomainError(
      'DEVIATION_UNAUTHORISED',
      'A script deviation is authorised by name. One nobody authorised is the test not having been run as written.',
    );
  }

  write(ctx, {
    eventType: 'TEST_SCRIPT_DEVIATION_RECORDED',
    entity: { refType: 'FunctionalTest', refId: testId },
    nextState: {
      ...record.state,
      deviations: [
        ...state.deviations,
        {
          step: input.step,
          deviation: input.deviation,
          authorisedBy: input.authorisedBy,
          invalidatesResult: input.invalidatesResult,
          annotatedAt: new Date().toISOString(),
        },
      ],
    },
  });

  return { deviations: state.deviations.length + 1 };
}

/**
 * Abort the test.
 *
 * Not a failure. A test abandoned because the chilled water was off tells you
 * nothing about the plant, and recording it as a fail puts a defect against
 * equipment nobody tested. The partial data stays.
 */
export function abortTest(
  ctx: EngineContext,
  testId: string,
  input: { reason: string; abortedBy: string },
): { stepsRetained: number } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'U', { lifecyclePhase: currentPhase(ctx) });

  const record = requireTest(ctx, testId);
  const state = stateOf(record);
  if (state.status !== 'IN_PROGRESS') throw new DomainError('TEST_NOT_RUNNING', 'That test is not running.');

  if (input.reason.trim().length < 10) {
    throw new DomainError(
      'ABORT_UNEXPLAINED',
      'Say why the test stopped. An abort with no reason cannot be told apart from a failure, and the two mean opposite ' +
        'things about the equipment.',
    );
  }
  if (!input.abortedBy.trim()) throw new DomainError('ABORT_UNSIGNED', 'Name who stopped it.');

  write(ctx, {
    eventType: 'FUNCTIONAL_TEST_ABORTED',
    entity: { refType: 'FunctionalTest', refId: testId },
    nextState: {
      ...record.state,
      status: 'ABORTED',
      abort: { reason: input.reason, abortedBy: input.abortedBy, abortedAt: new Date().toISOString() },
    },
  });

  return { stepsRetained: state.steps.length };
}

/**
 * Complete the test.
 *
 * AC-CM-WF-05-02: the calculation and the decision are two fields, and the
 * refusal below is what makes that more than a convention. A deviation somebody
 * marked as invalidating the result is honoured — the platform will not let a
 * pass be recorded against a run the engineer said no longer proves anything.
 */
export function completeFunctionalTest(
  ctx: EngineContext,
  testId: string,
  input: { decision: 'PASS' | 'FAIL' | 'CONDITIONAL'; decidedBy: string; decisionNote: string },
): { calculatedResult: 'PASS' | 'FAIL'; decision: string } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'A', { lifecyclePhase: currentPhase(ctx) });

  const record = requireTest(ctx, testId);
  const state = stateOf(record);

  if (state.status === 'COMPLETE') throw new DomainError('ALREADY_COMPLETE', `${state.reference} is complete.`);
  if (state.status === 'ABORTED') {
    // Deliberately permitted: somebody decides afterwards what an abort means.
    // What is refused is a pass, because nothing was proven.
    if (input.decision === 'PASS') {
      throw new DomainError(
        'ABORTED_CANNOT_PASS',
        `${state.reference} was aborted: ${state.abort?.reason ?? ''} A pass over an abandoned run asserts a result nobody ` +
          'observed.',
      );
    }
  }
  if (!input.decidedBy.trim() || input.decisionNote.trim().length < 10) {
    throw new DomainError(
      'DECISION_UNSIGNED',
      'Name the authority deciding, and say what the decision rests on. On a functional test the reasoning is what the ' +
        'retest is scoped from.',
    );
  }

  const criteria = criteriaOf(ctx, state.packId);
  const answered = new Set(state.steps.map((step) => step.criterionRef).filter(Boolean));
  const unanswered = criteria.filter((criterion) => !answered.has(criterion.reference));
  if (state.status === 'IN_PROGRESS' && unanswered.length > 0) {
    throw new DomainError(
      'CRITERIA_UNANSWERED',
      `No step answers ${unanswered.map((criterion) => criterion.reference).join(', ')}. A functional test completed ` +
        'without every criterion answered leaves the unanswered ones reading as passed.',
    );
  }

  const measured = state.steps.filter((step) => step.withinLimits !== undefined);
  const invalidating = state.deviations.filter((deviation) => deviation.invalidatesResult);
  const calculatedResult: 'PASS' | 'FAIL' =
    state.status === 'ABORTED' || invalidating.length > 0 || measured.some((step) => !step.withinLimits)
      ? 'FAIL'
      : 'PASS';

  if (input.decision === 'PASS' && calculatedResult === 'FAIL') {
    const outside = measured.filter((step) => !step.withinLimits);
    const detail = invalidating.length > 0
      ? `${invalidating.map((deviation) => `step ${deviation.step}`).join(', ')} deviated from the script in a way ` +
        `${invalidating[0]!.authorisedBy} recorded as invalidating the result`
      : `${outside.map((step) => `${step.criterionRef} at step ${step.step}`).join(', ')} outside the limit`;
    throw new DomainError(
      'DECISION_CONTRADICTS_EVIDENCE',
      `Cannot record a pass: ${detail}. The calculation and the decision are separate fields precisely so that one is not ` +
        'used to overwrite the other.',
    );
  }

  write(ctx, {
    eventType: state.kind === 'FUNCTIONAL' ? 'FUNCTIONAL_TEST_COMPLETED' : 'INTEGRATED_TEST_COMPLETED',
    entity: { refType: 'FunctionalTest', refId: testId },
    nextState: {
      ...record.state,
      status: 'COMPLETE',
      calculatedResult,
      decision: input.decision,
      decisionNote: input.decisionNote,
      decidedBy: input.decidedBy,
      decidedByActor: ctx.auth.actorId,
      decidedAt: new Date().toISOString(),
    },
  });

  return { calculatedResult, decision: input.decision };
}

/**
 * Route a failure to a retest.
 *
 * AC-CM-WF-05-03: the retest links the failed test and the condition that
 * changed. The corrective action itself lives on the CM-WF-07 exception, which
 * is why this takes its reference rather than restating what was done.
 */
export function requireRetest(
  ctx: EngineContext,
  testId: string,
  input: { exceptionReference: string; changedCondition: string; requestedBy: string },
): { reference: string } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'U', { lifecyclePhase: currentPhase(ctx) });

  const record = requireTest(ctx, testId);
  const state = stateOf(record);

  if (state.status !== 'COMPLETE' && state.status !== 'ABORTED') {
    throw new DomainError('TEST_NOT_DECIDED', 'Decide the test first. A retest of a running test is the same run.');
  }
  if (state.decision === 'PASS') {
    throw new DomainError('TEST_PASSED', `${state.reference} passed. There is nothing to retest.`);
  }
  if (input.changedCondition.trim().length < 10) {
    throw new DomainError(
      'CONDITION_UNCHANGED',
      'Say what is different this time. A retest with nothing changed is the same test, and it produces the same result.',
    );
  }
  if (
    !ctx.ledger
      .list(ctx.projectId, 'CommissioningException')
      .some((entry) => entry.state.reference === input.exceptionReference)
  ) {
    throw new DomainError(
      'EXCEPTION_NOT_FOUND',
      `No commissioning exception ${input.exceptionReference}. A failed functional test is carried as an exception, so the ` +
        'failure, the corrective action and the succeeding result stay one chain.',
      404,
    );
  }
  if (!input.requestedBy.trim()) throw new DomainError('RETEST_UNSIGNED', 'Name who is calling for the retest.');

  write(ctx, {
    eventType: 'RETEST_REQUIRED',
    entity: { refType: 'FunctionalTest', refId: testId },
    nextState: {
      ...record.state,
      status: 'RETEST_REQUIRED',
      retest: {
        exceptionReference: input.exceptionReference,
        changedCondition: input.changedCondition,
        requestedBy: input.requestedBy,
        requestedAt: new Date().toISOString(),
      },
    },
  });

  return { reference: state.reference };
}

// --- The position -----------------------------------------------------------

export type FunctionalTestPosition = {
  tests: Array<{
    testId: string;
    reference: string;
    kind: FunctionalTestKind;
    systemTag: string;
    status: string;
    calculatedResult?: string;
    decision?: string;
    steps: number;
    stepsOutsideLimits: number;
    trends: number;
    deviations: number;
    invalidatingDeviations: number;
  }>;
  /** Systems with a passed functional test, which is what an integrated test needs. */
  proven: string[];
  aborted: Array<{ reference: string; reason: string; stepsRetained: number }>;
  awaitingRetest: Array<{ reference: string; exceptionReference: string; changedCondition: string }>;
  summary: string;
};

export function functionalTestPosition(ctx: EngineContext): FunctionalTestPosition {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'R');

  const records = ctx.ledger.list(ctx.projectId, 'FunctionalTest');
  const states = records.map(stateOf);

  const proven = [
    ...new Set(
      states
        .filter((state) => state.kind === 'FUNCTIONAL' && state.status === 'COMPLETE' && state.decision === 'PASS')
        .map((state) => state.systemTag),
    ),
  ];

  const awaitingRetest = records
    .filter((record) => record.state.status === 'RETEST_REQUIRED')
    .map((record) => {
      const retest = record.state.retest as { exceptionReference: string; changedCondition: string } | undefined;
      return {
        reference: String(record.state.reference),
        exceptionReference: retest?.exceptionReference ?? '',
        changedCondition: retest?.changedCondition ?? '',
      };
    });

  const aborted = states
    .filter((state) => state.status === 'ABORTED')
    .map((state) => ({
      reference: state.reference,
      reason: state.abort?.reason ?? '',
      stepsRetained: state.steps.length,
    }));

  const parts = [`${states.length} functional or integrated test${states.length === 1 ? '' : 's'}`];
  if (proven.length > 0) parts.push(`${proven.length} system proven`);
  if (aborted.length > 0) parts.push(`${aborted.length} aborted and not yet decided`);
  if (awaitingRetest.length > 0) parts.push(`${awaitingRetest.length} awaiting retest`);

  return {
    tests: states.map((state) => ({
      testId: state.testId,
      reference: state.reference,
      kind: state.kind,
      systemTag: state.systemTag,
      status: state.status,
      calculatedResult: state.calculatedResult,
      decision: state.decision,
      steps: state.steps.length,
      stepsOutsideLimits: state.steps.filter((step) => step.withinLimits === false).length,
      trends: state.trends.length,
      deviations: state.deviations.length,
      invalidatingDeviations: state.deviations.filter((deviation) => deviation.invalidatesResult).length,
    })),
    proven,
    aborted,
    awaitingRetest,
    summary: parts.join(', ') + '.',
  };
}
