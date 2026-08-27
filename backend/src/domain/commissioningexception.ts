import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, registerEvidence, write, type EngineContext } from '../engines/context.ts';
import { executionBlockedReason } from './testpack.ts';
import type { TestReading, VendorTestState } from './vendortest.ts';

/**
 * CM-WF-07 — commissioning exception, punch, defect and retest.
 *
 * Built before CM-WF-04 and CM-WF-05 although it is numbered after them, because
 * both of those raise exceptions and there has to be one owner of the entity
 * rather than two modules each keeping their own idea of what an open item is.
 *
 * **The chain is the point.** AC-CM-WF-07-01: criterion → raw result → action →
 * retest → closure, and every link is a reference rather than a retyped
 * sentence. The specification's first step says "create exception from failed
 * item **without re-entry**", and that is not a convenience: an exception whose
 * "failed reading" was typed in by hand is an exception that can disagree with
 * the test it came from, and the two are never reconciled afterwards. Raising
 * one against a vendor test reads the reading out of the test.
 *
 * **A fail is never edited into a pass.** The exception control, and the reason
 * closure works the way it does: closing an exception does not change the
 * original result. It *adds* a succeeding one. The failed reading, its
 * instrument, its performer and its timestamp all stay exactly where they were —
 * AC-CM-WF-07-03 — because the history of what failed is the only thing that
 * makes the retest mean anything.
 *
 * **Invalidation is the expensive part.** AC-CM-WF-07-02. A fan that failed its
 * duty test did not merely fail that test: every downstream test that assumed
 * the duty was right is now unproven, and the ones already passed are the
 * dangerous ones, because they read as complete. The platform will not decide
 * the scope — the specification is explicit that a human confirms it — but it
 * refuses to let an exception be closed while an assessment nobody made is
 * outstanding.
 *
 * **A safety-critical conditional acceptance is a different act.** It needs an
 * exceptional authority and an operating restriction, both named, because the
 * thing being accepted is a system that does not do what it was specified to do
 * while people are in the building.
 */

export const EXCEPTION_SEVERITY = ['SAFETY_CRITICAL', 'MAJOR', 'MINOR'] as const;
export type ExceptionSeverity = (typeof EXCEPTION_SEVERITY)[number];

export type ExceptionSource =
  | { kind: 'VENDOR_TEST'; testId: string; criterionRef: string }
  | { kind: 'PRE_FUNCTIONAL'; checkId: string; itemKey: string }
  | { kind: 'FUNCTIONAL'; testId: string; criterionRef: string };

export type RetestRecord = {
  retestId: string;
  packId: string;
  packRevisionHash: string;
  startedAt: string;
  startedBy: string;
  result?: 'PASS' | 'FAIL';
  resultRecordedAt?: string;
  evidence?: string;
};

export type CommissioningExceptionState = {
  exceptionId: string;
  reference: string;
  source: ExceptionSource;
  /** Carried from the failed item, never retyped. */
  rawResult: Record<string, unknown>;
  systemTag: string;
  equipmentTag?: string;
  location: string;
  severity: ExceptionSeverity;
  blocker: boolean;
  probableCause: string;
  responsibleParty: string;
  correctiveAction?: {
    containment: string;
    corrective: string;
    evidenceRef: string;
    changeLinkage?: string;
    completedBy: string;
    completedAt: string;
  };
  impact?: { invalidatedTests: string[]; rationale: string; confirmedBy: string; confirmedAt: string };
  retests: RetestRecord[];
  status: 'OPEN' | 'ACTION_TAKEN' | 'RETEST' | 'CLOSED' | 'CONDITIONALLY_ACCEPTED';
  closure?: { verifiedBy: string; verification: string; closedAt: string };
  conditionalAcceptance?: { authority: string; operatingRestriction: string; reviewBy: string; acceptedAt: string };
};

function requireException(ctx: EngineContext, exceptionId: string) {
  const record = ctx.ledger.get({ refType: 'CommissioningException', refId: exceptionId });
  if (!record) throw new DomainError('EXCEPTION_NOT_FOUND', `No commissioning exception ${exceptionId}`, 404);
  return record;
}

function stateOf(record: { state: Record<string, unknown> }): CommissioningExceptionState {
  return record.state as unknown as CommissioningExceptionState;
}

/**
 * Read the raw result out of the item that failed.
 *
 * Step 1's "without re-entry". A caller supplying the failed reading by hand
 * could supply a different one, and nothing would ever reconcile the two.
 */
function rawResultOf(ctx: EngineContext, source: ExceptionSource): Record<string, unknown> {
  if (source.kind === 'PRE_FUNCTIONAL') {
    const record = ctx.ledger.get({ refType: 'PreFunctionalCheck', refId: source.checkId });
    if (!record) throw new DomainError('CHECK_NOT_FOUND', `No pre-functional check ${source.checkId}`, 404);
    const items = (record.state.items as Array<Record<string, unknown>> | undefined) ?? [];
    const item = items.find((entry) => entry.key === source.itemKey);
    if (!item) {
      throw new DomainError('CHECK_ITEM_NOT_FOUND', `${source.itemKey} is not an item on that check.`, 404);
    }
    if (item.result === 'PASS') {
      throw new DomainError(
        'ITEM_DID_NOT_FAIL',
        `${source.itemKey} passed. An exception raised against a passing item is an exception nobody can trace to anything.`,
      );
    }
    return { ...item };
  }

  const record = ctx.ledger.get({ refType: 'VendorTest', refId: source.testId });
  if (!record) throw new DomainError('TEST_NOT_FOUND', `No test ${source.testId}`, 404);
  const state = record.state as unknown as VendorTestState;
  const readings = state.readings.filter((reading) => reading.criterionRef === source.criterionRef);
  if (readings.length === 0) {
    throw new DomainError(
      'READING_NOT_FOUND',
      `No reading against ${source.criterionRef} on that test. The exception is raised from the failed reading, not beside it.`,
      404,
    );
  }
  const failed = readings.filter((reading: TestReading) => !reading.withinLimits);
  if (failed.length === 0) {
    throw new DomainError(
      'ITEM_DID_NOT_FAIL',
      `Every reading against ${source.criterionRef} is within limits. An exception raised against a passing criterion is ` +
        'one nobody can trace to anything.',
    );
  }
  return { criterionRef: source.criterionRef, readings: failed };
}

/** Raise the exception from the item that failed. */
export function raiseException(
  ctx: EngineContext,
  input: {
    reference: string;
    source: ExceptionSource;
    systemTag: string;
    equipmentTag?: string;
    location: string;
    severity: ExceptionSeverity;
    blocker: boolean;
    probableCause: string;
    responsibleParty: string;
  },
): { exceptionId: string; reference: string } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'C', { lifecyclePhase: currentPhase(ctx) });

  if (!input.reference.trim() || !input.location.trim()) {
    throw new DomainError('EXCEPTION_UNREFERENCED', 'An exception carries a reference and where the thing is.');
  }
  if (!input.responsibleParty.trim()) {
    throw new DomainError(
      'RESPONSIBILITY_REQUIRED',
      'Name the party responsible for putting it right. AC-CM-WF-04-02 is that every failure has a responsibility and a ' +
        'route back, and the route starts with somebody owning it.',
    );
  }
  if (input.probableCause.trim().length < 10) {
    throw new DomainError(
      'CAUSE_REQUIRED',
      'Record the probable cause. It is allowed to be wrong — that is what "probable" means — and it is what the corrective ' +
        'action is judged against later.',
    );
  }
  if (ctx.ledger.list(ctx.projectId, 'CommissioningException').some((r) => r.state.reference === input.reference)) {
    throw new DomainError('REFERENCE_TAKEN', `${input.reference} is already raised on this project.`);
  }

  const rawResult = rawResultOf(ctx, input.source);
  const exceptionId = ulid();

  write(ctx, {
    eventType: 'COMMISSIONING_EXCEPTION_RAISED',
    entity: { refType: 'CommissioningException', refId: exceptionId },
    nextState: {
      exceptionId,
      projectId: ctx.projectId,
      reference: input.reference,
      source: input.source,
      rawResult,
      systemTag: input.systemTag,
      equipmentTag: input.equipmentTag,
      location: input.location,
      severity: input.severity,
      blocker: input.blocker,
      probableCause: input.probableCause,
      responsibleParty: input.responsibleParty,
      retests: [],
      status: 'OPEN',
      raisedBy: ctx.auth.actorId,
      raisedAt: new Date().toISOString(),
    },
  });

  return { exceptionId, reference: input.reference };
}

/** Record the containment and corrective action, with the evidence behind them. */
export function completeCorrectiveAction(
  ctx: EngineContext,
  exceptionId: string,
  input: { containment: string; corrective: string; evidenceHash: string; changeLinkage?: string; completedBy: string },
): { status: string } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'U', { lifecyclePhase: currentPhase(ctx) });

  const record = requireException(ctx, exceptionId);
  const state = stateOf(record);
  if (state.status === 'CLOSED') throw new DomainError('EXCEPTION_CLOSED', `${state.reference} is closed.`);

  if (input.containment.trim().length < 10 || input.corrective.trim().length < 10) {
    throw new DomainError(
      'ACTION_INCOMPLETE',
      'Record what stopped it getting worse and what puts it right. They are different acts and a commissioning exception ' +
        'that records only the second leaves the plant running wrong in the meantime.',
    );
  }
  if (!input.evidenceHash.trim()) {
    throw new DomainError(
      'EVIDENCE_REQUIRED',
      'A corrective action carries the evidence it was carried out. Without it the retest is the only proof, and the retest ' +
        'has not happened yet.',
    );
  }
  if (!input.completedBy.trim()) throw new DomainError('ACTION_UNSIGNED', 'Name who carried it out.');

  const evidence = registerEvidence(ctx, {
    type: 'COMMISSIONING_CORRECTIVE_ACTION',
    hash: input.evidenceHash,
    description: `Corrective action on ${state.reference}: ${input.corrective}`,
    linkedEntities: [{ refType: 'CommissioningException', refId: exceptionId }],
  });

  write(ctx, {
    eventType: 'CORRECTIVE_ACTION_COMPLETED',
    entity: { refType: 'CommissioningException', refId: exceptionId },
    nextState: {
      ...record.state,
      status: 'ACTION_TAKEN',
      correctiveAction: {
        containment: input.containment,
        corrective: input.corrective,
        evidenceRef: evidence.refId,
        changeLinkage: input.changeLinkage,
        completedBy: input.completedBy,
        completedAt: new Date().toISOString(),
      },
    },
    evidenceRefs: [evidence],
  });

  return { status: 'ACTION_TAKEN' };
}

/**
 * Confirm which tests this invalidates.
 *
 * The platform proposes nothing here. The specification says an agent
 * "identifies affected tests, assets and documents; human confirms scope", and
 * the human confirmation is the record: a scope nobody confirmed is a scope
 * nobody will act on. An empty list is a legitimate answer and has to be
 * explained, because "nothing else is affected" is a finding, not a default.
 */
export function assessImpact(
  ctx: EngineContext,
  exceptionId: string,
  input: { invalidatedTests: string[]; rationale: string; confirmedBy: string },
): { invalidated: number } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'A', { lifecyclePhase: currentPhase(ctx) });

  const record = requireException(ctx, exceptionId);
  const state = stateOf(record);
  if (state.status === 'CLOSED') throw new DomainError('EXCEPTION_CLOSED', `${state.reference} is closed.`);

  if (input.rationale.trim().length < 15) {
    throw new DomainError(
      'RATIONALE_REQUIRED',
      'Say why these tests and not others. "Nothing else is affected" is a finding somebody has to stand behind, not a ' +
        'default the platform may assume.',
    );
  }
  if (!input.confirmedBy.trim()) {
    throw new DomainError('ASSESSMENT_UNSIGNED', 'Name the engineer confirming the scope.');
  }

  write(ctx, {
    eventType: 'EXCEPTION_IMPACT_ASSESSED',
    entity: { refType: 'CommissioningException', refId: exceptionId },
    nextState: {
      ...record.state,
      impact: {
        invalidatedTests: input.invalidatedTests,
        rationale: input.rationale,
        confirmedBy: input.confirmedBy,
        confirmedAt: new Date().toISOString(),
      },
    },
  });

  return { invalidated: input.invalidatedTests.length };
}

/** Start a controlled retest against a released pack revision. */
export function startRetest(
  ctx: EngineContext,
  exceptionId: string,
  input: { packId: string; startedBy: string },
): { retestId: string; packRevisionHash: string } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'U', { lifecyclePhase: currentPhase(ctx) });

  const record = requireException(ctx, exceptionId);
  const state = stateOf(record);
  if (state.status === 'CLOSED') throw new DomainError('EXCEPTION_CLOSED', `${state.reference} is closed.`);

  if (!state.correctiveAction) {
    throw new DomainError(
      'NO_CORRECTIVE_ACTION',
      'Nothing has been recorded as done about this. A retest before the corrective action is the same test again, and it ' +
        'fails again.',
    );
  }

  // The same rule as everywhere else, and here it is what makes the retest a
  // controlled one: a defined pack revision, released by somebody.
  const blocked = executionBlockedReason(ctx, input.packId);
  if (blocked) throw new DomainError('PACK_NOT_RELEASED', blocked);

  const pack = ctx.ledger.require({ refType: 'TestPack', refId: input.packId });
  if (!input.startedBy.trim()) throw new DomainError('RETEST_UNSIGNED', 'Name who is running the retest.');

  const retest: RetestRecord = {
    retestId: ulid(),
    packId: input.packId,
    packRevisionHash: String(pack.state.releasedRevisionHash),
    startedAt: new Date().toISOString(),
    startedBy: input.startedBy,
  };

  write(ctx, {
    eventType: 'RETEST_STARTED',
    entity: { refType: 'CommissioningException', refId: exceptionId },
    nextState: { ...record.state, status: 'RETEST', retests: [...state.retests, retest] },
  });

  return { retestId: retest.retestId, packRevisionHash: retest.packRevisionHash };
}

/**
 * Record what the retest found.
 *
 * A failing retest is recorded as a failing retest. It does not reopen anything
 * — the exception was never closed — and it does not replace the previous
 * attempt: the sequence of attempts is what "repeated failure" is counted from.
 */
export function recordRetestResult(
  ctx: EngineContext,
  exceptionId: string,
  input: { retestId: string; result: 'PASS' | 'FAIL'; evidence: string },
): { attempts: number; result: string } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'U', { lifecyclePhase: currentPhase(ctx) });

  const record = requireException(ctx, exceptionId);
  const state = stateOf(record);
  const retest = state.retests.find((entry) => entry.retestId === input.retestId);
  if (!retest) throw new DomainError('RETEST_NOT_FOUND', 'No such retest on this exception.', 404);
  if (retest.result) throw new DomainError('RESULT_RECORDED', 'That retest already has a result.');
  if (!input.evidence.trim()) {
    throw new DomainError('EVIDENCE_REQUIRED', 'Reference the record the retest result comes from.');
  }

  write(ctx, {
    eventType: 'RETEST_RESULT_RECORDED',
    entity: { refType: 'CommissioningException', refId: exceptionId },
    nextState: {
      ...record.state,
      retests: state.retests.map((entry) =>
        entry.retestId === input.retestId
          ? { ...entry, result: input.result, resultRecordedAt: new Date().toISOString(), evidence: input.evidence }
          : entry,
      ),
    },
  });

  return { attempts: state.retests.length, result: input.result };
}

/**
 * Close the exception.
 *
 * Closure **adds** a verified succeeding result. It changes nothing about the
 * failure: the original reading, its instrument, its performer and its timestamp
 * are all still there, which is AC-CM-WF-07-03 and the reason the retest means
 * anything at all.
 */
export function closeException(
  ctx: EngineContext,
  exceptionId: string,
  input: { verifiedBy: string; verification: string },
): { reference: string; attempts: number; failuresRetained: number } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'A', { lifecyclePhase: currentPhase(ctx) });

  const record = requireException(ctx, exceptionId);
  const state = stateOf(record);
  if (state.status === 'CLOSED') throw new DomainError('EXCEPTION_CLOSED', `${state.reference} is already closed.`);

  if (!input.verifiedBy.trim() || input.verification.trim().length < 10) {
    throw new DomainError(
      'VERIFICATION_REQUIRED',
      'Name who verified the succeeding result and what they saw. A commissioning exception closed on an assurance is the ' +
        'one found again at handover.',
    );
  }
  if (!state.impact) {
    throw new DomainError(
      'IMPACT_UNASSESSED',
      'Nobody has confirmed which other tests this invalidates. Closing first means the tests that assumed this one was ' +
        'right stay marked as passed, and those are the dangerous ones because they read as complete.',
    );
  }

  const passed = state.retests.filter((retest) => retest.result === 'PASS');
  if (passed.length === 0) {
    throw new DomainError(
      'NO_SUCCEEDING_RESULT',
      'No retest has passed. A fail is never edited into a pass — closure adds a verified succeeding result, and there is ' +
        'not one yet.',
    );
  }

  write(ctx, {
    eventType: 'EXCEPTION_CLOSED',
    entity: { refType: 'CommissioningException', refId: exceptionId },
    nextState: {
      ...record.state,
      status: 'CLOSED',
      closure: { verifiedBy: input.verifiedBy, verification: input.verification, closedAt: new Date().toISOString() },
    },
  });

  return {
    reference: state.reference,
    attempts: state.retests.length,
    failuresRetained: state.retests.filter((retest) => retest.result === 'FAIL').length,
  };
}

/**
 * Accept a safety-critical exception conditionally.
 *
 * Separate from closure and deliberately harder. What is being accepted is a
 * system that does not do what it was specified to do while people are in the
 * building, so it needs an exceptional authority by name, an operating
 * restriction that says what may not happen until it clears, and a date it is
 * reviewed by.
 */
export function acceptConditionally(
  ctx: EngineContext,
  exceptionId: string,
  input: { authority: string; operatingRestriction: string; reviewBy: string },
): { reference: string } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'A', { lifecyclePhase: currentPhase(ctx) });

  const record = requireException(ctx, exceptionId);
  const state = stateOf(record);
  if (state.status === 'CLOSED') throw new DomainError('EXCEPTION_CLOSED', `${state.reference} is closed.`);

  if (!input.authority.trim()) {
    throw new DomainError(
      'EXCEPTIONAL_AUTHORITY_REQUIRED',
      'Name the authority accepting it. A safety-critical acceptance signed by the person who raised the exception is not ' +
        'an exceptional authority.',
    );
  }
  if (input.operatingRestriction.trim().length < 15) {
    throw new DomainError(
      'RESTRICTION_REQUIRED',
      'State what may not happen while this stands. A safety-critical conditional acceptance with no operating restriction ' +
        'is an unconditional one.',
    );
  }
  if (Number.isNaN(Date.parse(input.reviewBy))) {
    throw new DomainError('REVIEW_DATE_REQUIRED', 'A conditional acceptance is reviewed by a date. One with none never is.');
  }

  write(ctx, {
    eventType: 'EXCEPTION_CONDITIONALLY_ACCEPTED',
    entity: { refType: 'CommissioningException', refId: exceptionId },
    nextState: {
      ...record.state,
      status: 'CONDITIONALLY_ACCEPTED',
      conditionalAcceptance: {
        authority: input.authority,
        operatingRestriction: input.operatingRestriction,
        reviewBy: input.reviewBy,
        acceptedAt: new Date().toISOString(),
      },
    },
  });

  return { reference: state.reference };
}

/** Tests some open exception has invalidated. AC-CM-WF-07-02, read by whatever runs a test. */
export function invalidatedTests(ctx: EngineContext): Array<{ testRef: string; by: string; rationale: string }> {
  return ctx.ledger
    .list(ctx.projectId, 'CommissioningException')
    .map(stateOf)
    .filter((state) => state.status !== 'CLOSED' && state.impact)
    .flatMap((state) =>
      state.impact!.invalidatedTests.map((testRef) => ({
        testRef,
        by: state.reference,
        rationale: state.impact!.rationale,
      })),
    );
}

// --- The position -----------------------------------------------------------

export type ExceptionPosition = {
  exceptions: Array<{
    exceptionId: string;
    reference: string;
    systemTag: string;
    severity: ExceptionSeverity;
    blocker: boolean;
    status: string;
    responsibleParty: string;
    attempts: number;
    failedAttempts: number;
    invalidates: number;
  }>;
  /** Open blockers, which is what stops a system being accepted. */
  blocking: string[];
  invalidated: Array<{ testRef: string; by: string; rationale: string }>;
  /**
   * Systems and parties failing repeatedly.
   *
   * The exception control: repeated failure escalates supplier and system risk.
   * Counted from attempts rather than exceptions, because one exception retested
   * four times is the signal, not four separate items.
   */
  repeatedFailure: Array<{ subject: string; kind: 'SYSTEM' | 'PARTY'; failedAttempts: number }>;
  conditionallyAccepted: Array<{ reference: string; restriction: string; reviewBy: string; overdue: boolean }>;
  summary: string;
};

/** Two failed attempts on one subject is a pattern rather than bad luck. */
const REPEATED_FAILURE_AT = 2;

export function exceptionPosition(
  ctx: EngineContext,
  today = new Date().toISOString().slice(0, 10),
): ExceptionPosition {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'R');

  const states = ctx.ledger.list(ctx.projectId, 'CommissioningException').map(stateOf);

  const bySystem = new Map<string, number>();
  const byParty = new Map<string, number>();
  for (const state of states) {
    const failed = state.retests.filter((retest) => retest.result === 'FAIL').length;
    if (failed === 0) continue;
    bySystem.set(state.systemTag, (bySystem.get(state.systemTag) ?? 0) + failed);
    byParty.set(state.responsibleParty, (byParty.get(state.responsibleParty) ?? 0) + failed);
  }

  const repeatedFailure = [
    ...[...bySystem.entries()].map(([subject, failedAttempts]) => ({ subject, kind: 'SYSTEM' as const, failedAttempts })),
    ...[...byParty.entries()].map(([subject, failedAttempts]) => ({ subject, kind: 'PARTY' as const, failedAttempts })),
  ]
    .filter((entry) => entry.failedAttempts >= REPEATED_FAILURE_AT)
    .sort((a, b) => b.failedAttempts - a.failedAttempts);

  const blocking = states
    .filter((state) => state.blocker && state.status !== 'CLOSED' && state.status !== 'CONDITIONALLY_ACCEPTED')
    .map((state) => state.reference);

  const conditionallyAccepted = states
    .filter((state) => state.conditionalAcceptance)
    .map((state) => ({
      reference: state.reference,
      restriction: state.conditionalAcceptance!.operatingRestriction,
      reviewBy: state.conditionalAcceptance!.reviewBy,
      overdue: state.conditionalAcceptance!.reviewBy.slice(0, 10) < today,
    }));

  const open = states.filter((state) => state.status !== 'CLOSED').length;
  const parts = [`${open} open exception${open === 1 ? '' : 's'}`];
  if (blocking.length > 0) parts.push(`${blocking.length} blocking`);
  if (repeatedFailure.length > 0) parts.push(`${repeatedFailure.length} subject failing repeatedly`);
  if (conditionallyAccepted.length > 0) parts.push(`${conditionallyAccepted.length} conditionally accepted`);

  return {
    exceptions: states.map((state) => ({
      exceptionId: state.exceptionId,
      reference: state.reference,
      systemTag: state.systemTag,
      severity: state.severity,
      blocker: state.blocker,
      status: state.status,
      responsibleParty: state.responsibleParty,
      attempts: state.retests.length,
      failedAttempts: state.retests.filter((retest) => retest.result === 'FAIL').length,
      invalidates: state.impact?.invalidatedTests.length ?? 0,
    })),
    blocking,
    invalidated: invalidatedTests(ctx),
    repeatedFailure,
    conditionallyAccepted,
    summary: parts.join(', ') + '.',
  };
}
