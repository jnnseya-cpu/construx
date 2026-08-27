import { hashState } from '../core/canonical.ts';
import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, write, type EngineContext } from '../engines/context.ts';
import { calibrationBlockedReason } from './qualitycontrol.ts';

/**
 * CM-WF-02 — the test procedure, the pack and the release to test.
 *
 * Reused rather than rebuilt: the instrument register and
 * `qualitycontrol.calibrationBlockedReason`, which already answers "was this
 * instrument in calibration when the reading was taken"; the readiness-check
 * pattern from `domain/mobilisation.ts`; and CM-WF-01's system hierarchy and
 * test-pack requirements, which say what packs are owed and to which boundary.
 *
 * What this adds is the thing that makes a commissioning result defensible: a
 * **frozen revision**. A test executed against a procedure somebody edited
 * afterwards proves nothing, and the edit is invisible — the pack reads as
 * current, the result reads as a pass, and only the person who made the change
 * knows the two do not belong together. Release freezes the revision and hashes
 * it; a change afterwards cancels the release rather than amending it.
 *
 * The three blockers in the exception control are all the same failure in
 * different clothes: **the reading cannot be relied on.** An instrument past its
 * certificate did not measure anything. An open critical defect means the thing
 * under test is not the thing that will be handed over. A missing safe isolation
 * means the test is dangerous, and a dangerous test is not made safe by anybody
 * agreeing it may proceed.
 *
 * **The witness is a person and a time, not a checkbox.** AC-CM-WF-02-03: the
 * notification records who it went to and when, and their response records what
 * they said and when they said it. A waiver is not silence — it is an authorised
 * record naming the contract rule that permits it.
 */

// --- The procedure and its criteria -----------------------------------------

export type AcceptanceCriterion = {
  reference: string;
  criterion: string;
  /** The controlled document it comes from. AC-CM-WF-02-02. */
  source: string;
  /** What has to be measured, and in what unit, for the criterion to be answerable. */
  requiredReading: string;
  unit: string;
  /** Where the criterion is a tolerance, the limits it is judged against. */
  lowerLimit?: number;
  upperLimit?: number;
};

export type ProcedureStep = { step: number; instruction: string };

/**
 * Whether a reading satisfies a criterion.
 *
 * One definition, used by every workflow that takes a reading. A second one kept
 * beside it would be a second answer to "did this pass", and the two diverge the
 * first time either is edited — which is precisely the failure the whole
 * frozen-revision idea exists to prevent, one level down.
 */
export function satisfies(criterion: AcceptanceCriterion, value: number): boolean {
  return (
    (criterion.lowerLimit === undefined || value >= criterion.lowerLimit) &&
    (criterion.upperLimit === undefined || value <= criterion.upperLimit)
  );
}

export type TestPackState = {
  packId: string;
  reference: string;
  systemTag: string;
  requirementRef?: string;
  title: string;
  objective: string;
  steps: ProcedureStep[];
  criteria: AcceptanceCriterion[];
  instrumentIds: string[];
  revision: number;
  status: 'DRAFT' | 'READY' | 'BLOCKED' | 'RELEASED' | 'SUPERSEDED';
  releasedRevisionHash?: string;
};

function packContent(state: Record<string, unknown>): Record<string, unknown> {
  // What the executing engineer works to. The status, the readiness result and
  // the witness responses all change legitimately around it, and hashing those
  // would make every release stale for reasons that are not the procedure.
  return {
    reference: state.reference,
    systemTag: state.systemTag,
    title: state.title,
    objective: state.objective,
    steps: state.steps,
    criteria: state.criteria,
    instrumentIds: state.instrumentIds,
  };
}

function requirePack(ctx: EngineContext, packId: string) {
  const record = ctx.ledger.get({ refType: 'TestPack', refId: packId });
  if (!record) throw new DomainError('PACK_NOT_FOUND', `No test pack ${packId}`, 404);
  return record;
}

/** Create the controlled procedure and pack. */
export function createTestPack(
  ctx: EngineContext,
  input: {
    reference: string;
    systemTag: string;
    title: string;
    objective: string;
    steps: ProcedureStep[];
    criteria: AcceptanceCriterion[];
    instrumentIds: string[];
    requirementRef?: string;
  },
): { packId: string; revision: number } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'C', { lifecyclePhase: currentPhase(ctx) });

  if (!input.reference.trim() || !input.title.trim()) {
    throw new DomainError('PACK_UNREFERENCED', 'A test pack carries a reference and a title.');
  }
  if (!ctx.ledger.list(ctx.projectId, 'SystemNode').some((record) => record.state.tag === input.systemTag)) {
    throw new DomainError(
      'SYSTEM_NOT_FOUND',
      `${input.systemTag} is not a defined system. A pack against no boundary tests something nobody can name.`,
      404,
    );
  }
  if (input.steps.length === 0) {
    throw new DomainError('NO_STEPS', 'A procedure with no steps is a title.');
  }
  if (input.criteria.length === 0) {
    throw new DomainError(
      'NO_CRITERIA',
      'A test with no acceptance criteria cannot be passed or failed — it can only be attended.',
    );
  }

  for (const criterion of input.criteria) {
    if (!criterion.source.trim()) {
      throw new DomainError(
        'CRITERION_UNSOURCED',
        `${criterion.reference} cites no controlled source. "To the satisfaction of the engineer" is not an acceptance ` +
          'criterion, and a criterion nobody can trace cannot be argued from when the result is disputed.',
      );
    }
    if (!criterion.requiredReading.trim() || !criterion.unit.trim()) {
      throw new DomainError(
        'CRITERION_UNMEASURED',
        `${criterion.reference} says what good looks like but not what is measured to establish it. Every criterion maps to ` +
          'a raw reading and a unit, or the result is an opinion.',
      );
    }
    if (
      criterion.lowerLimit !== undefined &&
      criterion.upperLimit !== undefined &&
      criterion.lowerLimit > criterion.upperLimit
    ) {
      throw new DomainError(
        'CRITERION_CONTRADICTORY',
        `${criterion.reference} has a lower limit above its upper limit. No reading can satisfy it.`,
      );
    }
  }

  const packId = ulid();

  write(ctx, {
    eventType: 'TEST_PROCEDURE_CREATED',
    entity: { refType: 'TestPack', refId: packId },
    nextState: {
      packId,
      projectId: ctx.projectId,
      reference: input.reference,
      systemTag: input.systemTag,
      requirementRef: input.requirementRef,
      title: input.title,
      objective: input.objective,
      steps: input.steps,
      criteria: input.criteria,
      instrumentIds: input.instrumentIds,
      revision: 1,
      status: 'DRAFT',
      witnessNotifications: [],
      createdBy: ctx.auth.actorId,
      createdAt: new Date().toISOString(),
    },
  });

  return { packId, revision: 1 };
}

/**
 * Revise the procedure.
 *
 * The exception control: a change after release cancels and reissues readiness.
 * Not because the change is wrong, but because the readiness check was carried
 * out against the old steps, and a release carried across is a release of
 * something nobody checked.
 */
export function reviseTestPack(
  ctx: EngineContext,
  packId: string,
  input: { steps?: ProcedureStep[]; criteria?: AcceptanceCriterion[]; instrumentIds?: string[]; reason: string },
): { revision: number; releaseCancelled: boolean } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'U', { lifecyclePhase: currentPhase(ctx) });

  const record = requirePack(ctx, packId);
  if (input.reason.trim().length < 10) {
    throw new DomainError('REVISION_UNEXPLAINED', 'Say why the procedure changed. The reason is what the retest rests on.');
  }

  const wasReleased = record.state.status === 'RELEASED' || record.state.status === 'READY';
  const revision = Number(record.state.revision ?? 1) + 1;

  write(ctx, {
    eventType: 'TEST_PROCEDURE_REVISED',
    entity: { refType: 'TestPack', refId: packId },
    nextState: {
      ...record.state,
      steps: input.steps ?? record.state.steps,
      criteria: input.criteria ?? record.state.criteria,
      instrumentIds: input.instrumentIds ?? record.state.instrumentIds,
      revision,
      status: 'DRAFT',
      releasedRevisionHash: undefined,
      readiness: undefined,
      revisions: [
        ...((record.state.revisions as unknown[] | undefined) ?? []),
        { revision, reason: input.reason, revisedBy: ctx.auth.actorId, revisedAt: new Date().toISOString() },
      ],
    },
  });

  return { revision, releaseCancelled: wasReleased };
}

// --- Readiness --------------------------------------------------------------

/**
 * The readiness checklist.
 *
 * Nine items, from the specification's own list. `blocking` marks the ones the
 * exception control says stop a release outright — the rest are recorded as
 * outstanding and let the commissioning manager decide.
 */
export const READINESS_ITEM = [
  { key: 'CONSTRUCTION_COMPLETE', what: 'Construction of the system in scope is complete', blocking: true },
  { key: 'DEFECTS', what: 'No critical defect is open against the system', blocking: true },
  { key: 'CLEANING', what: 'The system has been cleaned or flushed as the specification requires', blocking: false },
  { key: 'ENERGISATION', what: 'The utilities the test needs are available and energised', blocking: true },
  { key: 'ACCESS', what: 'Safe access to every point the procedure reaches', blocking: false },
  { key: 'DOCUMENTS', what: 'The design and vendor documents the criteria cite are current', blocking: false },
  { key: 'VENDOR', what: 'Vendor attendance is confirmed where the procedure needs it', blocking: false },
  { key: 'INSTRUMENTS', what: 'Every instrument is within its calibration certificate', blocking: true },
  { key: 'PERMITS', what: 'Permits and safe isolations are in place for the work', blocking: true },
] as const;

export type ReadinessItemKey = (typeof READINESS_ITEM)[number]['key'];

export type ReadinessResult = {
  checkedAt: string;
  checkedBy: string;
  items: Array<{ key: ReadinessItemKey; ready: boolean; note: string; blocking: boolean }>;
  blockers: string[];
  outstanding: string[];
  ready: boolean;
};

/**
 * Run the readiness check.
 *
 * Instruments are not asked about: the register already knows whether each one
 * was in calibration, and a checklist that let somebody tick "instruments" over
 * an expired certificate would be a checklist that could be wrong.
 */
export function checkTestReadiness(
  ctx: EngineContext,
  packId: string,
  input: {
    checkedBy: string;
    items: Array<{ key: ReadinessItemKey; ready: boolean; note: string }>;
    on?: string;
  },
): ReadinessResult {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'U', { lifecyclePhase: currentPhase(ctx) });

  const record = requirePack(ctx, packId);
  if (!input.checkedBy.trim()) {
    throw new DomainError('CHECK_UNSIGNED', 'Name the person who carried out the readiness check.');
  }

  const on = input.on ?? new Date().toISOString().slice(0, 10);
  const declared = new Map(input.items.map((item) => [item.key, item]));

  const items = READINESS_ITEM.map((item) => {
    if (item.key === 'INSTRUMENTS') {
      // Derived, never declared. The register is the only thing that knows.
      const instrumentIds = (record.state.instrumentIds as string[] | undefined) ?? [];
      const problems = instrumentIds
        .map((instrumentId) => calibrationBlockedReason(ctx, instrumentId, on))
        .filter((reason): reason is string => reason !== null);
      return {
        key: item.key,
        ready: problems.length === 0,
        note: problems.length === 0 ? `${instrumentIds.length} instrument(s) in calibration on ${on}` : problems.join(' '),
        blocking: item.blocking,
      };
    }
    const given = declared.get(item.key);
    if (!given) {
      throw new DomainError(
        'READINESS_INCOMPLETE',
        `No answer against ${item.key}: ${item.what}. An unanswered item is not a passed one, and the difference is the ` +
          'whole reason a checklist exists.',
      );
    }
    if (!given.ready && !given.note.trim()) {
      throw new DomainError(
        'BLOCKER_UNDESCRIBED',
        `${item.key} is not ready and nothing says why. A blocker with no description cannot be cleared by anybody except ` +
          'the person who raised it.',
      );
    }
    return { key: item.key, ready: given.ready, note: given.note, blocking: item.blocking };
  });

  const blockers = items.filter((item) => !item.ready && item.blocking).map((item) => item.key);
  const outstanding = items.filter((item) => !item.ready && !item.blocking).map((item) => item.key);
  const result: ReadinessResult = {
    checkedAt: new Date().toISOString(),
    checkedBy: input.checkedBy,
    items,
    blockers,
    outstanding,
    ready: blockers.length === 0,
  };

  write(ctx, {
    eventType: 'TEST_READINESS_CHECKED',
    entity: { refType: 'TestPack', refId: packId },
    nextState: { ...record.state, status: result.ready ? 'READY' : 'BLOCKED', readiness: result },
  });

  return result;
}

// --- The witness ------------------------------------------------------------

export type WitnessNotification = {
  notificationId: string;
  recipient: string;
  organisation: string;
  notifiedAt: string;
  testDate: string;
  noticeDays: number;
  response?: { attending: boolean; respondedAt: string; note: string };
  waiver?: { waivedBy: string; contractRule: string; waivedAt: string };
};

/** Notify a witness. Recipient-specific and time-stamped, per AC-CM-WF-02-03. */
export function notifyWitness(
  ctx: EngineContext,
  packId: string,
  input: { recipient: string; organisation: string; testDate: string; noticeDays: number },
): { notificationId: string; shortNotice: boolean } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'U', { lifecyclePhase: currentPhase(ctx) });

  const record = requirePack(ctx, packId);
  if (!input.recipient.trim() || !input.organisation.trim()) {
    throw new DomainError(
      'RECIPIENT_REQUIRED',
      'Name the person notified and who they act for. "The client was notified" is what is said when nobody was.',
    );
  }
  if (Number.isNaN(Date.parse(input.testDate))) {
    throw new DomainError('TEST_DATE_REQUIRED', 'A notification names the date of the test it is notice of.');
  }

  const notifiedAt = new Date().toISOString();
  const daysGiven = Math.floor((Date.parse(input.testDate) - Date.parse(notifiedAt)) / 86_400_000);

  const notification: WitnessNotification = {
    notificationId: ulid(),
    recipient: input.recipient,
    organisation: input.organisation,
    notifiedAt,
    testDate: input.testDate,
    noticeDays: input.noticeDays,
  };

  write(ctx, {
    eventType: 'WITNESS_NOTIFIED',
    entity: { refType: 'TestPack', refId: packId },
    nextState: {
      ...record.state,
      witnessNotifications: [
        ...((record.state.witnessNotifications as WitnessNotification[] | undefined) ?? []),
        notification,
      ],
    },
  });

  // Reported, not refused. Short notice happens and the contractual consequence
  // is somebody else's to draw; what the platform owes is that it is visible.
  return { notificationId: notification.notificationId, shortNotice: daysGiven < input.noticeDays };
}

/** Record what the witness said, or that the requirement was waived. */
export function recordWitnessResponse(
  ctx: EngineContext,
  packId: string,
  input:
    | { notificationId: string; attending: boolean; note: string }
    | { notificationId: string; waivedBy: string; contractRule: string },
): { recorded: true } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'U', { lifecyclePhase: currentPhase(ctx) });

  const record = requirePack(ctx, packId);
  const notifications = (record.state.witnessNotifications as WitnessNotification[] | undefined) ?? [];
  const notification = notifications.find((entry) => entry.notificationId === input.notificationId);
  if (!notification) throw new DomainError('NOTIFICATION_NOT_FOUND', 'No such witness notification.', 404);

  const respondedAt = new Date().toISOString();

  if ('waivedBy' in input) {
    if (!input.waivedBy.trim() || !input.contractRule.trim()) {
      throw new DomainError(
        'WAIVER_UNAUTHORISED',
        'A witness waiver names the person authorising it and the contract rule that permits it. A waiver is not silence — ' +
          'the witness who did not turn up has not waived anything.',
      );
    }
  }

  write(ctx, {
    eventType: 'WITNESS_RESPONSE_RECORDED',
    entity: { refType: 'TestPack', refId: packId },
    nextState: {
      ...record.state,
      witnessNotifications: notifications.map((entry) =>
        entry.notificationId === input.notificationId
          ? 'waivedBy' in input
            ? { ...entry, waiver: { waivedBy: input.waivedBy, contractRule: input.contractRule, waivedAt: respondedAt } }
            : { ...entry, response: { attending: input.attending, respondedAt, note: input.note } }
          : entry,
      ),
    },
  });

  return { recorded: true };
}

// --- Release ----------------------------------------------------------------

/**
 * Release to test, or refuse with the blockers.
 *
 * Freezes the revision by hashing the procedure. AC-CM-WF-02-01 then has
 * something to enforce: `releasedRevisionOf` returns the hash a result has to
 * have been executed against.
 */
export function releaseForTest(
  ctx: EngineContext,
  packId: string,
  input: { releasedBy: string },
): { revision: number; releasedRevisionHash: string } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'A', { lifecyclePhase: currentPhase(ctx) });

  const record = requirePack(ctx, packId);
  if (!input.releasedBy.trim()) {
    throw new DomainError('RELEASE_UNSIGNED', 'Name the commissioning manager releasing the test.');
  }
  if (record.state.status === 'RELEASED') {
    throw new DomainError('ALREADY_RELEASED', `${String(record.state.reference)} is already released.`);
  }

  const readiness = record.state.readiness as ReadinessResult | undefined;
  if (!readiness) {
    throw new DomainError(
      'NOT_CHECKED',
      'No readiness check has been run against this revision. A release without one is a release against nothing.',
    );
  }
  if (readiness.blockers.length > 0) {
    const detail = readiness.items
      .filter((item) => readiness.blockers.includes(item.key))
      .map((item) => `${item.key}: ${item.note}`)
      .join('; ');
    // Recorded rather than only thrown: a blocked test is a fact about the
    // programme, and the pattern of them is how a late commissioning stage is
    // diagnosed.
    write(ctx, {
      eventType: 'TEST_BLOCKED',
      entity: { refType: 'TestPack', refId: packId },
      nextState: {
        ...record.state,
        status: 'BLOCKED',
        blocks: [
          ...((record.state.blocks as unknown[] | undefined) ?? []),
          { at: new Date().toISOString(), blockers: readiness.blockers, detail, attemptedBy: ctx.auth.actorId },
        ],
      },
    });
    throw new DomainError('RELEASE_BLOCKED', `Cannot release ${String(record.state.reference)}. ${detail}`);
  }

  const witnesses = (record.state.witnessNotifications as WitnessNotification[] | undefined) ?? [];
  if (witnesses.length === 0) {
    throw new DomainError(
      'WITNESS_NOT_NOTIFIED',
      'No witness has been notified. Releasing first and notifying afterwards is how a test is executed in front of nobody ' +
        'and repeated a fortnight later.',
    );
  }
  const unanswered = witnesses.filter((entry) => !entry.response && !entry.waiver);
  if (unanswered.length === witnesses.length) {
    throw new DomainError(
      'WITNESS_UNANSWERED',
      `${unanswered[0]!.recipient} has not responded and the requirement has not been waived. A waiver is an authorised ` +
        'record naming the contract rule, not the absence of a reply.',
    );
  }

  const revision = Number(record.state.revision ?? 1);
  const releasedRevisionHash = hashState(packContent(record.state));

  write(ctx, {
    eventType: 'TEST_RELEASED',
    entity: { refType: 'TestPack', refId: packId },
    nextState: {
      ...record.state,
      status: 'RELEASED',
      releasedRevisionHash,
      releasedBy: input.releasedBy,
      releasedByActor: ctx.auth.actorId,
      releasedAt: new Date().toISOString(),
    },
  });

  return { revision, releasedRevisionHash };
}

/**
 * Why this pack may not be executed, or null.
 *
 * AC-CM-WF-02-01, exported for whatever starts a test. Also catches the case the
 * frozen hash exists for: a procedure edited after release, where the pack reads
 * as released and the steps are no longer the ones anybody checked.
 */
export function executionBlockedReason(ctx: EngineContext, packId: string): string | null {
  const record = ctx.ledger.get({ refType: 'TestPack', refId: packId });
  if (!record) return `No test pack ${packId}.`;

  if (record.state.status !== 'RELEASED') {
    const readiness = record.state.readiness as ReadinessResult | undefined;
    const because = readiness?.blockers.length ? ` Outstanding: ${readiness.blockers.join(', ')}.` : '';
    return (
      `${String(record.state.reference)} is ${String(record.state.status).toLowerCase()}, not released. A test executed ` +
      `against an unreleased pack proves nothing, because nobody has said the procedure is the one to work to.${because}`
    );
  }

  const current = hashState(packContent(record.state));
  if (current !== record.state.releasedRevisionHash) {
    return (
      `${String(record.state.reference)} has changed since it was released. The pack reads as released and the steps are ` +
      'no longer the ones anybody checked. Revise it, which cancels the release, and check readiness against the new ' +
      'revision.'
    );
  }

  return null;
}

// --- The position -----------------------------------------------------------

export type TestPackPosition = {
  packs: Array<{
    packId: string;
    reference: string;
    systemTag: string;
    revision: number;
    status: string;
    criteria: number;
    blockers: string[];
    outstanding: string[];
    witnessesNotified: number;
    witnessesConfirmed: number;
    waivers: number;
  }>;
  blocked: Array<{ reference: string; blockers: string[]; detail: string }>;
  /** Packs required by the approved plan that nobody has raised a pack for. */
  packsNotRaised: string[];
  summary: string;
};

export function testPackPosition(ctx: EngineContext): TestPackPosition {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'R');

  const records = ctx.ledger.list(ctx.projectId, 'TestPack');
  const packs = records.map((record) => {
    const readiness = record.state.readiness as ReadinessResult | undefined;
    const witnesses = (record.state.witnessNotifications as WitnessNotification[] | undefined) ?? [];
    return {
      packId: String(record.state.packId),
      reference: String(record.state.reference),
      systemTag: String(record.state.systemTag),
      revision: Number(record.state.revision ?? 1),
      status: String(record.state.status),
      criteria: ((record.state.criteria as unknown[] | undefined) ?? []).length,
      blockers: readiness?.blockers ?? [],
      outstanding: readiness?.outstanding ?? [],
      witnessesNotified: witnesses.length,
      witnessesConfirmed: witnesses.filter((entry) => entry.response?.attending).length,
      waivers: witnesses.filter((entry) => entry.waiver).length,
    };
  });

  const blocked = records
    .filter((record) => record.state.status === 'BLOCKED')
    .map((record) => {
      const blocks = (record.state.blocks as Array<{ blockers: string[]; detail: string }> | undefined) ?? [];
      const last = blocks[blocks.length - 1];
      const readiness = record.state.readiness as ReadinessResult | undefined;
      return {
        reference: String(record.state.reference),
        blockers: last?.blockers ?? readiness?.blockers ?? [],
        detail: last?.detail ?? '',
      };
    });

  const raised = new Set(packs.map((pack) => pack.reference));
  const packsNotRaised = ctx.ledger
    .list(ctx.projectId, 'TestPackRequirement')
    .map((record) => String(record.state.reference))
    .filter((reference) => !raised.has(reference));

  const released = packs.filter((pack) => pack.status === 'RELEASED').length;
  const parts = [`${packs.length} pack${packs.length === 1 ? '' : 's'}`, `${released} released`];
  if (blocked.length > 0) parts.push(`${blocked.length} blocked`);
  if (packsNotRaised.length > 0) parts.push(`${packsNotRaised.length} the plan requires that nobody has raised`);

  return { packs, blocked, packsNotRaised, summary: parts.join(', ') + '.' };
}
