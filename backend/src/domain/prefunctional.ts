import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, write, type EngineContext } from '../engines/context.ts';

/**
 * CM-WF-04 — pre-functional and static completion checks.
 *
 * The step between "construction says it is finished" and "commissioning starts
 * testing it", and the one where the two disciplines disagree most. Construction
 * completion means the work is built. Static completion means it is safe to
 * energise and operate, which is a different question with different evidence
 * behind it.
 *
 * **Weighted readiness from accepted checks.** AC-CM-WF-04-01, and it is written
 * as a refusal of the alternative: readiness here can only be computed from
 * items somebody accepted, because the number this replaces — files uploaded
 * against a system — goes up when somebody attaches the wrong drawing twice.
 * Mandatory checks carry weight; advisory ones do not, so a system cannot reach
 * 100% by passing the easy half.
 *
 * **A failure has a route back.** AC-CM-WF-04-02. Every failed item names the
 * responsibility and whether it returns to construction or stays with
 * commissioning, and raising the exception is `commissioningexception.ts` —
 * built for CM-WF-07 and reused here rather than duplicated, so an open item has
 * one identity whichever workflow found it.
 *
 * **Not applicable is an approval, not a shrug.** The exception control. "N/A"
 * is the commonest way a check is skipped, and the ones skipped are
 * disproportionately the ones that would have failed. It needs a rationale and
 * the approver's name.
 *
 * **Rework invalidates what it reaches.** Construction returning to a system
 * after static completion means the system tested is no longer the system
 * installed. The platform does not guess the scope — a person names the checks
 * affected — but it will not let static completion stand over rework nobody
 * reassessed.
 */

/**
 * The pre-functional check list.
 *
 * From the specification's own required inputs. `weight` is what
 * AC-CM-WF-04-01's arithmetic runs on and `safetyCritical` marks the four whose
 * failure blocks release outright — guarding, isolation, earthing and pressure
 * integrity, exactly as the exception control names them.
 */
export const PRE_FUNCTIONAL_CHECK = [
  { key: 'INSTALLATION', what: 'Installed in accordance with the current drawing and manufacturer instruction', weight: 3, safetyCritical: false },
  { key: 'CLEANLINESS', what: 'Cleaned, flushed or purged as the specification requires', weight: 2, safetyCritical: false },
  { key: 'PRESSURE_INTEGRITY', what: 'Pressure or leak test passed and witnessed', weight: 3, safetyCritical: true },
  { key: 'ELECTRICAL', what: 'Electrical tests passed, including insulation resistance and polarity', weight: 3, safetyCritical: false },
  { key: 'EARTHING', what: 'Earthing and bonding continuous and proven', weight: 3, safetyCritical: true },
  { key: 'GUARDING', what: 'Guards, covers and interlocks fitted and secure', weight: 3, safetyCritical: true },
  { key: 'ISOLATION', what: 'Isolation points identified, lockable and labelled', weight: 3, safetyCritical: true },
  { key: 'LABELLING', what: 'Equipment, valves and cables labelled to the tagging convention', weight: 1, safetyCritical: false },
  { key: 'ACCESS', what: 'Safe access for operation and maintenance', weight: 2, safetyCritical: false },
  { key: 'LUBRICATION', what: 'Lubrication carried out to the manufacturer schedule', weight: 1, safetyCritical: false },
  { key: 'ALIGNMENT', what: 'Rotating equipment aligned and recorded', weight: 2, safetyCritical: false },
  { key: 'SETTINGS', what: 'Protective device and control settings applied as designed', weight: 2, safetyCritical: false },
  { key: 'AS_INSTALLED', what: 'As-installed markup reflects what is on site', weight: 2, safetyCritical: false },
] as const;

export type PreFunctionalCheckKey = (typeof PRE_FUNCTIONAL_CHECK)[number]['key'];

export type CheckItem = {
  key: PreFunctionalCheckKey;
  result: 'PASS' | 'FAIL' | 'OBSERVATION' | 'NOT_APPLICABLE';
  note: string;
  /** Photograph, certificate or record reference. */
  evidenceRef?: string;
  /** Where it failed: who puts it right, and whether it goes back to construction. */
  responsibility?: string;
  route?: 'RETURN_TO_CONSTRUCTION' | 'COMMISSIONING_EXCEPTION';
  /** Not applicable is an approval. */
  notApplicableRationale?: string;
  notApplicableApprovedBy?: string;
};

export type PreFunctionalCheckState = {
  checkId: string;
  reference: string;
  systemTag: string;
  equipmentTag?: string;
  location: string;
  items: CheckItem[];
  inspectedBy: string;
  readinessPercent: number;
  status: 'IN_PROGRESS' | 'STATIC_COMPLETE' | 'FUNCTIONAL_RELEASED' | 'INVALIDATED';
  staticCompletion?: { acceptedBy: string; acceptedAt: string };
  functionalRelease?: { releasedBy: string; releasedAt: string };
  invalidation?: { reason: string; affectedChecks: PreFunctionalCheckKey[]; recordedBy: string; recordedAt: string };
};

function requireCheck(ctx: EngineContext, checkId: string) {
  const record = ctx.ledger.get({ refType: 'PreFunctionalCheck', refId: checkId });
  if (!record) throw new DomainError('CHECK_NOT_FOUND', `No pre-functional check ${checkId}`, 404);
  return record;
}

function stateOf(record: { state: Record<string, unknown> }): PreFunctionalCheckState {
  return record.state as unknown as PreFunctionalCheckState;
}

/**
 * Weighted readiness.
 *
 * AC-CM-WF-04-01. Only accepted items count towards the numerator, and a
 * not-applicable item leaves the denominator: a check that does not apply is not
 * a check that passed, and inflating readiness with it is exactly the arithmetic
 * this replaces. Observations count as accepted — they are recorded findings
 * that do not stop the system — while failures count for nothing until they are
 * put right.
 */
export function readinessOf(items: CheckItem[]): { percent: number; accepted: number; total: number } {
  let accepted = 0;
  let total = 0;
  for (const definition of PRE_FUNCTIONAL_CHECK) {
    const item = items.find((entry) => entry.key === definition.key);
    if (!item || item.result === 'NOT_APPLICABLE') continue;
    total += definition.weight;
    if (item.result === 'PASS' || item.result === 'OBSERVATION') accepted += definition.weight;
  }
  return { percent: total === 0 ? 0 : Math.round((accepted / total) * 100), accepted, total };
}

/** Start the check against a subsystem or piece of equipment. */
export function startPreFunctionalCheck(
  ctx: EngineContext,
  input: { reference: string; systemTag: string; equipmentTag?: string; location: string; inspectedBy: string },
): { checkId: string } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'C', { lifecyclePhase: currentPhase(ctx) });

  if (!input.reference.trim() || !input.location.trim() || !input.inspectedBy.trim()) {
    throw new DomainError(
      'CHECK_UNIDENTIFIED',
      'A pre-functional check names its reference, where the equipment is and who inspected it.',
    );
  }
  if (!ctx.ledger.list(ctx.projectId, 'SystemNode').some((record) => record.state.tag === input.systemTag)) {
    throw new DomainError(
      'SYSTEM_NOT_FOUND',
      `${input.systemTag} is not a defined system. A check against no boundary cannot contribute to any system's readiness.`,
      404,
    );
  }

  const checkId = ulid();

  write(ctx, {
    eventType: 'PREFUNCTIONAL_CHECK_STARTED',
    entity: { refType: 'PreFunctionalCheck', refId: checkId },
    nextState: {
      checkId,
      projectId: ctx.projectId,
      reference: input.reference,
      systemTag: input.systemTag,
      equipmentTag: input.equipmentTag,
      location: input.location,
      items: [],
      inspectedBy: input.inspectedBy,
      readinessPercent: 0,
      status: 'IN_PROGRESS',
      startedBy: ctx.auth.actorId,
      startedAt: new Date().toISOString(),
    },
  });

  return { checkId };
}

/** Record one item of the checklist. */
export function recordCheckItem(
  ctx: EngineContext,
  checkId: string,
  input: CheckItem,
): { readinessPercent: number; safetyCriticalFailure: boolean } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'U', { lifecyclePhase: currentPhase(ctx) });

  const record = requireCheck(ctx, checkId);
  const state = stateOf(record);

  const definition = PRE_FUNCTIONAL_CHECK.find((entry) => entry.key === input.key);
  if (!definition) throw new DomainError('CHECK_ITEM_UNKNOWN', `${input.key} is not a pre-functional check item.`);

  if (state.status === 'FUNCTIONAL_RELEASED') {
    throw new DomainError(
      'ALREADY_RELEASED',
      'This system has been released for functional testing. A check item changed afterwards changes the basis of a ' +
        'release somebody has already acted on; record the rework instead.',
    );
  }

  if (input.result === 'NOT_APPLICABLE') {
    if (!input.notApplicableRationale?.trim() || !input.notApplicableApprovedBy?.trim()) {
      throw new DomainError(
        'NOT_APPLICABLE_UNAPPROVED',
        `${input.key} is marked not applicable with no rationale or approver. "N/A" is the commonest way a check is ` +
          'skipped, and the ones skipped are disproportionately the ones that would have failed.',
      );
    }
  }

  if ((input.result === 'FAIL' || input.result === 'OBSERVATION') && !input.note.trim()) {
    throw new DomainError('FINDING_UNDESCRIBED', `${input.key} is not a pass and nothing says what was found.`);
  }

  if (input.result === 'FAIL') {
    if (!input.responsibility?.trim() || !input.route) {
      throw new DomainError(
        'FAILURE_UNROUTED',
        `${input.key} failed with no ${!input.responsibility?.trim() ? 'responsibility' : 'route back'}. Every failure ` +
          'names who puts it right and whether it returns to construction or is carried as a commissioning exception; ' +
          'without that it is a finding in a folder.',
      );
    }
  }

  const items = [...state.items.filter((entry) => entry.key !== input.key), input];
  const readiness = readinessOf(items);
  const safetyCriticalFailure = input.result === 'FAIL' && definition.safetyCritical;

  write(ctx, {
    eventType: 'PREFUNCTIONAL_ITEM_RECORDED',
    entity: { refType: 'PreFunctionalCheck', refId: checkId },
    nextState: { ...record.state, items, readinessPercent: readiness.percent },
  });

  return { readinessPercent: readiness.percent, safetyCriticalFailure };
}

/**
 * Accept static completion.
 *
 * The point at which the system stops being construction's and becomes
 * commissioning's. Refused while a safety-critical item has failed, because a
 * system with an interlock missing or an isolation unlabelled is not a system
 * anybody should be energising.
 */
export function acceptStaticCompletion(
  ctx: EngineContext,
  checkId: string,
  input: { acceptedBy: string },
): { readinessPercent: number; observations: number } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'A', { lifecyclePhase: currentPhase(ctx) });

  const record = requireCheck(ctx, checkId);
  const state = stateOf(record);

  if (state.status === 'STATIC_COMPLETE' || state.status === 'FUNCTIONAL_RELEASED') {
    throw new DomainError('ALREADY_ACCEPTED', `${state.reference} has already reached static completion.`);
  }
  if (!input.acceptedBy.trim()) throw new DomainError('ACCEPTANCE_UNSIGNED', 'Name who accepted static completion.');

  const answered = new Set(state.items.map((item) => item.key));
  const unanswered = PRE_FUNCTIONAL_CHECK.filter((definition) => !answered.has(definition.key));
  if (unanswered.length > 0) {
    throw new DomainError(
      'CHECKLIST_INCOMPLETE',
      `No result against ${unanswered.map((definition) => definition.key).join(', ')}. An unanswered item is not a passed ` +
        'one, and static completion is the assertion that every one of them was looked at.',
    );
  }

  const safetyFailures = state.items.filter((item) => {
    const definition = PRE_FUNCTIONAL_CHECK.find((entry) => entry.key === item.key)!;
    return item.result === 'FAIL' && definition.safetyCritical;
  });
  if (safetyFailures.length > 0) {
    throw new DomainError(
      'SAFETY_CRITICAL_FAILURE',
      `${safetyFailures.map((item) => item.key).join(', ')} failed. Guarding, isolation, earthing and pressure integrity ` +
        'are not items to be carried: a system with an interlock missing or an isolation unlabelled is not one anybody ' +
        'should be energising.',
    );
  }

  const failures = state.items.filter((item) => item.result === 'FAIL');
  if (failures.length > 0) {
    throw new DomainError(
      'OPEN_FAILURES',
      `${failures.map((item) => item.key).join(', ')} ${failures.length === 1 ? 'is' : 'are'} still failed. Static ` +
        'completion is not a percentage — it is the statement that the system is safe to operate.',
    );
  }

  const readiness = readinessOf(state.items);

  write(ctx, {
    eventType: 'STATIC_COMPLETION_ACCEPTED',
    entity: { refType: 'PreFunctionalCheck', refId: checkId },
    nextState: {
      ...record.state,
      status: 'STATIC_COMPLETE',
      readinessPercent: readiness.percent,
      staticCompletion: { acceptedBy: input.acceptedBy, acceptedAt: new Date().toISOString() },
    },
  });

  return {
    readinessPercent: readiness.percent,
    observations: state.items.filter((item) => item.result === 'OBSERVATION').length,
  };
}

/** Release the system for functional testing. */
export function releaseForFunctionalTesting(
  ctx: EngineContext,
  checkId: string,
  input: { releasedBy: string },
): { systemTag: string } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'A', { lifecyclePhase: currentPhase(ctx) });

  const record = requireCheck(ctx, checkId);
  const state = stateOf(record);

  if (state.status === 'INVALIDATED') {
    throw new DomainError(
      'STATIC_COMPLETION_INVALIDATED',
      `${state.reference} was invalidated by rework: ${state.invalidation?.reason ?? ''} Reassess the affected checks first.`,
    );
  }
  if (state.status !== 'STATIC_COMPLETE') {
    throw new DomainError(
      'NOT_STATICALLY_COMPLETE',
      'Static completion has not been accepted, so there is nothing to release. Functional testing on a system nobody has ' +
        'declared safe to operate is how somebody is hurt at first energisation.',
    );
  }
  if (!input.releasedBy.trim()) throw new DomainError('RELEASE_UNSIGNED', 'Name who released it for functional testing.');

  write(ctx, {
    eventType: 'FUNCTIONAL_TEST_RELEASED',
    entity: { refType: 'PreFunctionalCheck', refId: checkId },
    nextState: {
      ...record.state,
      status: 'FUNCTIONAL_RELEASED',
      functionalRelease: { releasedBy: input.releasedBy, releasedAt: new Date().toISOString() },
    },
  });

  return { systemTag: state.systemTag };
}

/**
 * Record construction rework, which invalidates the static completion it reaches.
 *
 * The exception control, and the reason it is not automatic in the sense of
 * guessing: the platform cannot know which checks a piece of rework affects, and
 * a rule that invalidated everything would be ignored within a fortnight. A
 * person names the checks; the platform makes the consequence unavoidable.
 */
export function recordRework(
  ctx: EngineContext,
  checkId: string,
  input: { reason: string; affectedChecks: PreFunctionalCheckKey[]; recordedBy: string },
): { invalidated: number; status: string } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'U', { lifecyclePhase: currentPhase(ctx) });

  const record = requireCheck(ctx, checkId);
  const state = stateOf(record);

  if (input.reason.trim().length < 10) {
    throw new DomainError('REWORK_UNEXPLAINED', 'Say what was reworked. It is what the reassessment is scoped from.');
  }
  if (input.affectedChecks.length === 0) {
    throw new DomainError(
      'AFFECTED_CHECKS_REQUIRED',
      'Name the checks the rework reaches. Rework that affects nothing is not rework, and a list nobody wrote means the ' +
        'system tested is no longer the system installed with no record of the difference.',
    );
  }
  if (!input.recordedBy.trim()) throw new DomainError('REWORK_UNSIGNED', 'Name who recorded it.');

  // The affected items go back to unanswered rather than being marked failed:
  // nobody has looked at them since the rework, and "not looked at" is the true
  // state.
  const items = state.items.filter((item) => !input.affectedChecks.includes(item.key));

  write(ctx, {
    eventType: 'STATIC_COMPLETION_INVALIDATED',
    entity: { refType: 'PreFunctionalCheck', refId: checkId },
    nextState: {
      ...record.state,
      status: 'INVALIDATED',
      items,
      readinessPercent: readinessOf(items).percent,
      invalidation: {
        reason: input.reason,
        affectedChecks: input.affectedChecks,
        recordedBy: input.recordedBy,
        recordedAt: new Date().toISOString(),
      },
    },
  });

  return { invalidated: input.affectedChecks.length, status: 'INVALIDATED' };
}

/**
 * Why functional testing may not start on this system, or null.
 *
 * AC-CM-WF-04-03, exported for CM-WF-05. Binds only where the project runs
 * pre-functional checks at all.
 */
export function functionalTestBlockedReason(ctx: EngineContext, systemTag: string): string | null {
  const checks = ctx.ledger.list(ctx.projectId, 'PreFunctionalCheck');
  if (checks.length === 0) return null;

  const mine = checks.map(stateOf).filter((state) => state.systemTag === systemTag);
  if (mine.length === 0) {
    return (
      `No pre-functional check has been carried out on ${systemTag}. This project checks systems statically before ` +
      'testing them, and functional testing on one nobody has declared safe to operate is how somebody is hurt at first ' +
      'energisation.'
    );
  }

  const outstanding = mine.filter((state) => state.status !== 'FUNCTIONAL_RELEASED');
  if (outstanding.length === mine.length) {
    const invalidated = outstanding.find((state) => state.status === 'INVALIDATED');
    return invalidated
      ? `${invalidated.reference} was invalidated by rework: ${invalidated.invalidation?.reason ?? ''}`
      : `${outstanding[0]!.reference} has not been released for functional testing (${outstanding[0]!.status.toLowerCase().replace('_', ' ')}).`;
  }

  return null;
}

// --- The position -----------------------------------------------------------

export type PreFunctionalPosition = {
  checks: Array<{
    checkId: string;
    reference: string;
    systemTag: string;
    location: string;
    status: string;
    readinessPercent: number;
    failures: PreFunctionalCheckKey[];
    safetyCriticalFailures: PreFunctionalCheckKey[];
    notApplicable: PreFunctionalCheckKey[];
    unanswered: number;
  }>;
  /** Weighted readiness per system, from accepted checks rather than file count. */
  systemReadiness: Array<{ systemTag: string; percent: number; checks: number; released: number }>;
  invalidated: Array<{ reference: string; reason: string; affectedChecks: string[] }>;
  summary: string;
};

export function preFunctionalPosition(ctx: EngineContext): PreFunctionalPosition {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'R');

  const states = ctx.ledger.list(ctx.projectId, 'PreFunctionalCheck').map(stateOf);

  const checks = states.map((state) => {
    const failures = state.items.filter((item) => item.result === 'FAIL').map((item) => item.key);
    return {
      checkId: state.checkId,
      reference: state.reference,
      systemTag: state.systemTag,
      location: state.location,
      status: state.status,
      readinessPercent: readinessOf(state.items).percent,
      failures,
      safetyCriticalFailures: failures.filter(
        (key) => PRE_FUNCTIONAL_CHECK.find((definition) => definition.key === key)!.safetyCritical,
      ),
      notApplicable: state.items.filter((item) => item.result === 'NOT_APPLICABLE').map((item) => item.key),
      unanswered: PRE_FUNCTIONAL_CHECK.length - state.items.length,
    };
  });

  const bySystem = new Map<string, { accepted: number; total: number; checks: number; released: number }>();
  for (const state of states) {
    const readiness = readinessOf(state.items);
    const entry = bySystem.get(state.systemTag) ?? { accepted: 0, total: 0, checks: 0, released: 0 };
    entry.accepted += readiness.accepted;
    entry.total += readiness.total;
    entry.checks += 1;
    if (state.status === 'FUNCTIONAL_RELEASED') entry.released += 1;
    bySystem.set(state.systemTag, entry);
  }

  const invalidated = states
    .filter((state) => state.status === 'INVALIDATED')
    .map((state) => ({
      reference: state.reference,
      reason: state.invalidation?.reason ?? '',
      affectedChecks: state.invalidation?.affectedChecks ?? [],
    }));

  const safetyFailures = checks.reduce((sum, check) => sum + check.safetyCriticalFailures.length, 0);
  const parts = [`${states.length} pre-functional check${states.length === 1 ? '' : 's'}`];
  if (safetyFailures > 0) parts.push(`${safetyFailures} safety-critical failure`);
  if (invalidated.length > 0) parts.push(`${invalidated.length} invalidated by rework`);

  return {
    checks,
    systemReadiness: [...bySystem.entries()].map(([systemTag, entry]) => ({
      systemTag,
      percent: entry.total === 0 ? 0 : Math.round((entry.accepted / entry.total) * 100),
      checks: entry.checks,
      released: entry.released,
    })),
    invalidated,
    summary: parts.join(', ') + '.',
  };
}
