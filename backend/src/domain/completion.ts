import { hashState } from '../core/canonical.ts';
import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, registerEvidence, write, type EngineContext } from '../engines/context.ts';

/**
 * CN-WF-12 — reporting, recovery, physical completion and turnover.
 *
 * Reused rather than rebuilt: the delay forecast with its costed corrective
 * measures (`engines/planning.ts`), the CVR and cashflow (`engines/cost.ts`),
 * the commissioning test and system acceptance (`engines/handover.ts`), the
 * document engine that renders a report once the numbers exist, the stage gate
 * (`domain/stagegate.ts`), and every position function the construction block
 * added. Four things were absent, and each is one of the workflow's outputs.
 *
 * **A report with no cut-off.** AC-CN-WF-12-01: "report numbers reconcile to
 * source snapshots at cut-off". Every position function on the platform answers
 * *now*. A monthly report built from four screens read on four different days
 * reconciles to nothing, and the discrepancy is always found by whoever is
 * arguing with it. A snapshot is defined as the ledger **as at a stated
 * instant** — the same definition the replay engine uses — so two people
 * running the same cut-off get the same numbers, and the content hash proves it.
 *
 * **A report that hides what it could not see.** The exception control, and the
 * reason the snapshot carries freshness rather than only counts. A source with
 * no records renders as a zero on every reporting tool ever built, and a zero
 * looks like good news. Here it is named as **not reported**, and a source
 * nobody has touched since before the last cut-off is named as **stale**, with
 * how many days.
 *
 * **A recovery option nobody chose.** The forecast already produces costed
 * measures. What it could not record was a person selecting one, which is the
 * guardrail: the platform "cannot declare completion or select recovery". An
 * approved plan names the measures taken, what they are expected to recover,
 * what they cost, and the person who chose them.
 *
 * **Turnover as a state rather than a boundary.** AC-CN-WF-12-02 and -03. A
 * system handed to commissioning without a defined boundary is the commonest
 * cause of an energisation incident: two parties each believe the other holds
 * the isolation. Readiness here is **rule-driven and evidence-linked** — the
 * checklist is a table, not a free-text tick — and commissioning is refused on a
 * system that has not been released, unless somebody with authority records an
 * exception saying exactly what is being accepted and why.
 */

// --- The cut-off snapshot ---------------------------------------------------

/**
 * What a period report covers.
 *
 * A fixed table rather than "every entity type in the ledger", because a report
 * that silently grew a section when an unrelated feature shipped would stop
 * being comparable to the one before it. `critical` marks the sources whose
 * absence is reported as a gap rather than merely counted: a project with no
 * progress records is not a project with nothing to report.
 */
const REPORT_SOURCE: ReadonlyArray<{ key: string; refType: string; critical: boolean }> = [
  { key: 'progress', refType: 'ProgressMeasurement', critical: true },
  { key: 'progressSubmissions', refType: 'ProgressSubmission', critical: false },
  { key: 'programme', refType: 'ProgrammeBaseline', critical: true },
  { key: 'diaries', refType: 'SiteDiary', critical: true },
  { key: 'quality', refType: 'QualityInspection', critical: true },
  { key: 'ncrs', refType: 'NCR', critical: false },
  { key: 'safety', refType: 'SafetyObservation', critical: true },
  { key: 'incidents', refType: 'Incident', critical: false },
  { key: 'permits', refType: 'Permit', critical: false },
  { key: 'changes', refType: 'ChangeRequest', critical: false },
  { key: 'valuations', refType: 'ValueChain', critical: false },
  { key: 'rfis', refType: 'RFI', critical: true },
  { key: 'deliveries', refType: 'Delivery', critical: false },
  { key: 'risks', refType: 'RiskRegisterItem', critical: true },
  { key: 'meetings', refType: 'SiteMeeting', critical: false },
];

/**
 * How long a source may go untouched before the report says so.
 *
 * A fortnight rather than a month: a monthly report whose safety data stopped a
 * fortnight ago is describing half a period it claims to cover, and the reader
 * has no way of knowing.
 */
const STALE_AFTER_DAYS = 14;

export type SourceSnapshot = {
  key: string;
  refType: string;
  /** Events committed against this source at or before the cut-off. */
  events: number;
  /** Distinct records touched. */
  records: number;
  lastActivityAt?: string;
  staleDays?: number;
  stale: boolean;
  reported: boolean;
  /** Whether its absence is a gap in the report rather than merely a nil. */
  critical: boolean;
};

export type PeriodSnapshot = {
  snapshotId: string;
  reference: string;
  cutOff: string;
  audience: string;
  sources: SourceSnapshot[];
  /** Named rather than rendered as a zero. */
  notReported: string[];
  /**
   * The subset of `notReported` whose absence is a gap rather than a nil.
   *
   * A project with no deliveries recorded may genuinely have had none this
   * period; a project with no progress records has a reporting failure, and the
   * two must not look the same on the page.
   */
  criticalGaps: string[];
  stale: Array<{ key: string; days: number }>;
  /** Deltas against the previous snapshot, which is what a reader actually reads. */
  changesSince?: { reference: string; cutOff: string; deltas: Array<{ key: string; events: number }> };
  contentHash: string;
  createdAt: string;
};

function snapshotSources(ctx: EngineContext, cutOff: string): SourceSnapshot[] {
  // The ledger as at an instant, which is the same definition replay uses. Two
  // people running the same cut-off read the same events by construction rather
  // than by both remembering to filter.
  const events = ctx.ledger.events({ projectId: ctx.projectId, until: cutOff });
  const cutOffMs = Date.parse(cutOff);

  return REPORT_SOURCE.map((source) => {
    const mine = events.filter((event) => event.entity.refType === source.refType);
    const records = new Set(mine.map((event) => event.entity.refId));
    const last = mine[mine.length - 1]?.timestamp;
    const staleDays = last ? Math.floor((cutOffMs - Date.parse(last)) / 86_400_000) : undefined;
    return {
      key: source.key,
      refType: source.refType,
      events: mine.length,
      records: records.size,
      lastActivityAt: last,
      staleDays,
      stale: staleDays !== undefined && staleDays > STALE_AFTER_DAYS,
      reported: mine.length > 0,
      critical: source.critical,
    };
  });
}

/**
 * Take the snapshot.
 *
 * Writes what was read at the cut-off and nothing derived from it. The narrative
 * is the document engine's job; this is the arithmetic the narrative has to
 * reconcile to.
 */
export function createSnapshot(
  ctx: EngineContext,
  input: { cutOff: string; audience: string },
): {
  snapshotId: string;
  reference: string;
  contentHash: string;
  notReported: string[];
  criticalGaps: string[];
  stale: number;
} {
  // Update rather than create. Closing a reporting period maintains the project
  // record; it does not bring a project into existence, and reading the matrix
  // the other way would have put the monthly report in the hands of whoever sets
  // projects up rather than whoever runs them.
  authorise(ctx, 'PROJECT_SETUP', 'U', { lifecyclePhase: currentPhase(ctx) });

  if (Number.isNaN(Date.parse(input.cutOff))) {
    throw new DomainError('CUT_OFF_INVALID', `"${input.cutOff}" is not a date and time.`);
  }
  if (Date.parse(input.cutOff) > Date.now()) {
    throw new DomainError(
      'CUT_OFF_IN_FUTURE',
      `${input.cutOff} has not happened yet. A snapshot taken to a future cut-off reports a period that is still running ` +
        'as though it had closed.',
    );
  }
  if (!input.audience.trim()) {
    throw new DomainError(
      'AUDIENCE_REQUIRED',
      'Say who the report is for. The same numbers go to a client, a board and a funder in different shapes, and a report ' +
        'with no audience on it gets sent to the wrong one.',
    );
  }

  const existing = ctx.ledger.list(ctx.projectId, 'PeriodSnapshot').map((r) => r.state as unknown as PeriodSnapshot);
  const previous = [...existing].sort((a, b) => a.cutOff.localeCompare(b.cutOff)).pop();

  if (previous && Date.parse(input.cutOff) <= Date.parse(previous.cutOff)) {
    throw new DomainError(
      'CUT_OFF_NOT_AFTER_LAST',
      `The last cut-off was ${previous.cutOff}. A snapshot taken to an earlier instant would report movement backwards ` +
        'against it, which is not what happened.',
    );
  }

  const sources = snapshotSources(ctx, input.cutOff);
  const notReported = sources.filter((source) => !source.reported).map((source) => source.key);
  const criticalGaps = sources.filter((source) => !source.reported && source.critical).map((source) => source.key);
  const stale = sources.filter((source) => source.stale).map((source) => ({ key: source.key, days: source.staleDays! }));

  const changesSince = previous
    ? {
        reference: previous.reference,
        cutOff: previous.cutOff,
        deltas: sources.map((source) => ({
          key: source.key,
          events: source.events - (previous.sources.find((s) => s.key === source.key)?.events ?? 0),
        })),
      }
    : undefined;

  const snapshotId = ulid();
  const reference = `PR-${String(existing.length + 1).padStart(3, '0')}`;
  // Over what was read, not over the record: the hash has to be reproducible by
  // anybody re-running the same cut-off, and `snapshotId` and `createdAt` are
  // not.
  const contentHash = hashState({ cutOff: input.cutOff, sources });

  const evidence = registerEvidence(ctx, {
    type: 'PERIOD_REPORT_SNAPSHOT',
    hash: contentHash,
    description: `${reference} — ${input.audience} report at cut-off ${input.cutOff}`,
    linkedEntities: [{ refType: 'Project', refId: ctx.projectId }],
  });

  write(ctx, {
    eventType: 'REPORT_SNAPSHOT_CREATED',
    entity: { refType: 'PeriodSnapshot', refId: snapshotId },
    nextState: {
      snapshotId,
      projectId: ctx.projectId,
      reference,
      cutOff: input.cutOff,
      audience: input.audience,
      sources,
      notReported,
      criticalGaps,
      stale,
      changesSince,
      contentHash,
      createdBy: ctx.auth.actorId,
      createdAt: new Date().toISOString(),
    },
    evidenceRefs: [evidence],
  });

  return { snapshotId, reference, contentHash, notReported, criticalGaps, stale: stale.length };
}

/** Re-read a snapshot's cut-off and confirm it still produces the same figures. */
export function reconcileSnapshot(
  ctx: EngineContext,
  snapshotId: string,
): { reference: string; reconciles: boolean; contentHash: string; recomputedHash: string } {
  authorise(ctx, 'PROJECT_SETUP', 'R');

  const record = ctx.ledger.get({ refType: 'PeriodSnapshot', refId: snapshotId });
  if (!record) throw new DomainError('SNAPSHOT_NOT_FOUND', `No snapshot ${snapshotId}`, 404);
  const snapshot = record.state as unknown as PeriodSnapshot;

  const recomputedHash = hashState({ cutOff: snapshot.cutOff, sources: snapshotSources(ctx, snapshot.cutOff) });

  return {
    reference: snapshot.reference,
    reconciles: recomputedHash === snapshot.contentHash,
    contentHash: snapshot.contentHash,
    recomputedHash,
  };
}

// --- The recovery plan ------------------------------------------------------

export type RecoveryMeasure = {
  measure: string;
  recoveryDays: number;
  costMinor: number;
  /** Who carries it out. A measure with no owner is an intention. */
  owner: string;
};

/**
 * Approve a recovery plan.
 *
 * The forecast produces the options; a person selects them. The specification's
 * guardrail is exactly this — an agent "cannot declare completion or select
 * recovery" — so this is an approve, it names the human, and it records what the
 * plan is expected to recover against what the forecast said was lost.
 */
export function approveRecoveryPlan(
  ctx: EngineContext,
  input: {
    delayDaysForecast: number;
    measures: RecoveryMeasure[];
    approvedBy: string;
    rationale: string;
    /** The forecast the plan answers, where one was run. */
    forecastRef?: string;
  },
): { planId: string; reference: string; recoveryDays: number; costMinor: number; shortfallDays: number } {
  authorise(ctx, 'PROGRAMME_BASELINES', 'A', { lifecyclePhase: currentPhase(ctx) });

  if (input.measures.length === 0) {
    throw new DomainError('NO_MEASURES', 'A recovery plan with no measures in it is a statement that nothing will be done.');
  }
  const unowned = input.measures.find((measure) => !measure.owner.trim() || !measure.measure.trim());
  if (unowned) {
    throw new DomainError(
      'MEASURE_UNOWNED',
      `"${unowned.measure || '(unnamed)'}" has no owner. A recovery measure nobody is carrying out is an intention, and a ` +
        'plan made of those recovers nothing.',
    );
  }
  if (input.measures.some((measure) => measure.recoveryDays <= 0)) {
    throw new DomainError('MEASURE_RECOVERS_NOTHING', 'Every measure states the days it is expected to recover.');
  }
  if (input.rationale.trim().length < 20) {
    throw new DomainError(
      'RATIONALE_REQUIRED',
      'Say why these measures and not the others. A recovery plan is a commitment of money against a forecast, and the ' +
        'reasoning is what it is judged on when it does not work.',
    );
  }
  if (!input.approvedBy.trim()) {
    throw new DomainError(
      'APPROVAL_UNSIGNED',
      'Name the person selecting the recovery. The platform forecasts and costs the options; it never chooses between them.',
    );
  }

  const recoveryDays = input.measures.reduce((sum, measure) => sum + measure.recoveryDays, 0);
  const costMinor = input.measures.reduce((sum, measure) => sum + measure.costMinor, 0);
  // Reported rather than refused. A plan that recovers part of a delay is a real
  // plan; one presented as recovering all of it when it does not is the problem.
  const shortfallDays = Math.max(0, input.delayDaysForecast - recoveryDays);

  const planId = ulid();
  const sequence = ctx.ledger.list(ctx.projectId, 'RecoveryPlan').length + 1;
  const reference = `RP-${String(sequence).padStart(3, '0')}`;

  write(ctx, {
    eventType: 'RECOVERY_PLAN_APPROVED',
    entity: { refType: 'RecoveryPlan', refId: planId },
    nextState: {
      planId,
      projectId: ctx.projectId,
      reference,
      delayDaysForecast: input.delayDaysForecast,
      measures: input.measures,
      recoveryDays,
      costMinor,
      shortfallDays,
      rationale: input.rationale,
      approvedBy: input.approvedBy,
      forecastRef: input.forecastRef,
      approvedByActor: ctx.auth.actorId,
      approvedAt: new Date().toISOString(),
    },
  });

  return { planId, reference, recoveryDays, costMinor, shortfallDays };
}

// --- System turnover --------------------------------------------------------

/**
 * The readiness checklist.
 *
 * Rule-driven and evidence-linked, which is AC-CN-WF-12-02: each item names what
 * has to be true and what proves it, so completeness is computed rather than
 * declared. A tick box a person fills in is a declaration; this is a rule.
 */
export const TURNOVER_CHECK = [
  { key: 'WORK_COMPLETE', what: 'The physical work within the boundary is complete', evidence: 'Verified progress at 100% for the systems in scope' },
  { key: 'TESTS_PASSED', what: 'Every construction test on the system has passed', evidence: 'Quality inspection and test records' },
  { key: 'NCRS_CLOSED', what: 'No non-conformance is open against the system', evidence: 'NCR register' },
  { key: 'AS_BUILT', what: 'As-built information reflects what was installed', evidence: 'As-built drawing or model reference' },
  { key: 'DEFECTS_CLASSIFIED', what: 'Every residual defect is classified, owned and has a completion condition', evidence: 'Defect schedule' },
  { key: 'BOUNDARY_DEFINED', what: 'The physical and functional boundary is defined', evidence: 'Boundary description and drawing' },
  { key: 'ISOLATIONS', what: 'Isolations and their holders are stated', evidence: 'Isolation schedule' },
  { key: 'RETAINED_OBLIGATIONS', what: 'What construction retains after turnover is stated', evidence: 'Retained responsibilities' },
] as const;

export type TurnoverCheckKey = (typeof TURNOVER_CHECK)[number]['key'];

export type ResidualDefect = {
  reference: string;
  description: string;
  /** Whether it prevents commissioning, restricts it, or does not affect it. */
  classification: 'BLOCKING' | 'RESTRICTING' | 'NON_BLOCKING';
  owner: string;
  /** What has to be true for it to be closed, and by when. */
  completionCondition: string;
  by: string;
};

export type SystemTurnoverState = {
  turnoverId: string;
  systemId: string;
  systemName: string;
  boundary: string;
  isolations: Array<{ point: string; heldBy: string }>;
  retainedObligations: string[];
  residualDefects: ResidualDefect[];
  evidenceRefs: Array<{ check: TurnoverCheckKey; reference: string }>;
  status: 'RELEASED';
  releasedBy: string;
  releasedAt: string;
};

/**
 * Release a system to commissioning.
 *
 * The completeness rule is applied here rather than reported: a system released
 * without a boundary is the commonest cause of an energisation incident, because
 * two parties each believe the other holds the isolation.
 */
export function releaseSystemForTurnover(
  ctx: EngineContext,
  input: {
    systemId: string;
    systemName: string;
    boundary: string;
    isolations: Array<{ point: string; heldBy: string }>;
    retainedObligations: string[];
    residualDefects: ResidualDefect[];
    evidenceRefs: Array<{ check: TurnoverCheckKey; reference: string }>;
    releasedBy: string;
  },
): { turnoverId: string; blocking: number; restricting: number } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'A', { lifecyclePhase: currentPhase(ctx) });

  if (!input.systemId.trim() || !input.systemName.trim()) {
    throw new DomainError('SYSTEM_REQUIRED', 'Name the system being turned over.');
  }
  if (ctx.ledger.list(ctx.projectId, 'SystemTurnover').some((r) => r.state.systemId === input.systemId)) {
    throw new DomainError(
      'ALREADY_RELEASED',
      `${input.systemName} has already been released to commissioning. A second release would replace the boundary the ` +
        'commissioning team is working to without telling them.',
    );
  }
  if (input.boundary.trim().length < 20) {
    throw new DomainError(
      'BOUNDARY_REQUIRED',
      'Describe the boundary — what is inside it, what is outside, and where the two meet. A partial turnover with no ' +
        'boundary is how two parties each conclude the other holds the isolation.',
    );
  }
  if (input.isolations.length === 0) {
    throw new DomainError(
      'ISOLATIONS_REQUIRED',
      'State the isolations and who holds each. "None" is not an omission a turnover can carry silently — record the ' +
        'isolation points that exist, or the system is not ready to be described.',
    );
  }
  const unheld = input.isolations.find((isolation) => !isolation.point.trim() || !isolation.heldBy.trim());
  if (unheld) {
    throw new DomainError('ISOLATION_UNHELD', `"${unheld.point || '(unnamed)'}" names no holder.`);
  }
  if (input.retainedObligations.length === 0) {
    throw new DomainError(
      'RETAINED_OBLIGATIONS_REQUIRED',
      'State what construction still owes after turnover. Turnover transfers the system, not every obligation attached to ' +
        'it, and an unstated retained obligation is one nobody discharges.',
    );
  }

  for (const defect of input.residualDefects) {
    if (!defect.owner.trim() || !defect.completionCondition.trim() || Number.isNaN(Date.parse(defect.by))) {
      throw new DomainError(
        'DEFECT_UNCONDITIONED',
        `${defect.reference || 'A residual defect'} has no ${!defect.owner.trim() ? 'owner' : !defect.completionCondition.trim() ? 'completion condition' : 'date'}. ` +
          'Accepting or deferring a defect needs a classification, an owner and what has to be true to close it — otherwise ' +
          'it is being carried into commissioning by nobody.',
      );
    }
  }

  const blocking = input.residualDefects.filter((defect) => defect.classification === 'BLOCKING');
  if (blocking.length > 0) {
    throw new DomainError(
      'BLOCKING_DEFECTS',
      `${blocking.length} defect${blocking.length === 1 ? '' : 's'} classified as blocking: ` +
        `${blocking.map((defect) => defect.reference).join(', ')}. A defect that prevents commissioning cannot be carried ` +
        'through the release that starts it.',
    );
  }

  const provided = new Set(input.evidenceRefs.map((entry) => entry.check));
  const missing = TURNOVER_CHECK.filter((check) => !provided.has(check.key));
  if (missing.length > 0) {
    throw new DomainError(
      'TURNOVER_INCOMPLETE',
      `No evidence against ${missing.map((check) => check.key).join(', ')}. Completeness here is a rule rather than a tick: ` +
        `${missing[0]!.what} — ${missing[0]!.evidence}.`,
    );
  }
  const unreferenced = input.evidenceRefs.find((entry) => !entry.reference.trim());
  if (unreferenced) {
    throw new DomainError(
      'EVIDENCE_UNREFERENCED',
      `${unreferenced.check} is recorded with no reference to the evidence behind it, which is the same as not recording it.`,
    );
  }

  const turnoverId = ulid();
  const releasedAt = new Date().toISOString();

  write(ctx, {
    eventType: 'SYSTEM_READY_FOR_TURNOVER',
    entity: { refType: 'SystemTurnover', refId: turnoverId },
    nextState: {
      turnoverId,
      projectId: ctx.projectId,
      systemId: input.systemId,
      systemName: input.systemName,
      boundary: input.boundary,
      isolations: input.isolations,
      retainedObligations: input.retainedObligations,
      residualDefects: input.residualDefects,
      evidenceRefs: input.evidenceRefs,
      status: 'RELEASED',
      releasedBy: input.releasedBy,
      releasedByActor: ctx.auth.actorId,
      releasedAt,
    },
  });

  return {
    turnoverId,
    blocking: 0,
    restricting: input.residualDefects.filter((defect) => defect.classification === 'RESTRICTING').length,
  };
}

/**
 * Accept commissioning on a system that has not been released.
 *
 * The exception AC-CN-WF-12-03 permits, and it is deliberately a record rather
 * than a flag: somebody with authority says what is being accepted, why, and
 * what is not yet in place. An exception nobody signed is indistinguishable from
 * the rule never having been applied.
 */
export function recordTurnoverException(
  ctx: EngineContext,
  input: { systemId: string; systemName: string; whatIsMissing: string; why: string; acceptedBy: string; expiresOn: string },
): { exceptionId: string } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'A', { lifecyclePhase: currentPhase(ctx) });

  if (input.whatIsMissing.trim().length < 10 || input.why.trim().length < 20) {
    throw new DomainError(
      'EXCEPTION_UNEXPLAINED',
      'Say what is not in place and why commissioning may start anyway. An exception recorded as "agreed" is the rule ' +
        'being switched off rather than a decision anybody can review.',
    );
  }
  if (!input.acceptedBy.trim()) {
    throw new DomainError('EXCEPTION_UNSIGNED', 'Name the person accepting it.');
  }
  if (Number.isNaN(Date.parse(input.expiresOn))) {
    throw new DomainError(
      'EXCEPTION_UNBOUNDED',
      'An exception with no expiry becomes the permanent state. Say the date by which the missing item is in place.',
    );
  }

  const exceptionId = ulid();

  write(ctx, {
    eventType: 'TURNOVER_EXCEPTION_ACCEPTED',
    entity: { refType: 'TurnoverException', refId: exceptionId },
    nextState: {
      exceptionId,
      projectId: ctx.projectId,
      systemId: input.systemId,
      systemName: input.systemName,
      whatIsMissing: input.whatIsMissing,
      why: input.why,
      acceptedBy: input.acceptedBy,
      acceptedByActor: ctx.auth.actorId,
      expiresOn: input.expiresOn,
      acceptedAt: new Date().toISOString(),
    },
  });

  return { exceptionId };
}

/**
 * Why commissioning may not start on this system, or null.
 *
 * AC-CN-WF-12-03, wired into `handover.recordCommissioningTest`. Binds only
 * where the project runs turnover at all, so it imposes nothing on a project
 * that predates it.
 */
export function commissioningBlockedReason(ctx: EngineContext, systemId: string): string | null {
  const turnovers = ctx.ledger.list(ctx.projectId, 'SystemTurnover');
  if (turnovers.length === 0) return null;

  if (turnovers.some((record) => record.state.systemId === systemId)) return null;

  const exception = ctx.ledger
    .list(ctx.projectId, 'TurnoverException')
    .find((record) => record.state.systemId === systemId && String(record.state.expiresOn) >= new Date().toISOString().slice(0, 10));
  if (exception) return null;

  const expired = ctx.ledger
    .list(ctx.projectId, 'TurnoverException')
    .find((record) => record.state.systemId === systemId);

  return expired
    ? `The exception ${String(expired.state.acceptedBy)} accepted for this system expired on ` +
        `${String(expired.state.expiresOn)}. Release the system for turnover, or record a fresh exception saying what is ` +
        'still missing.'
    : 'This system has not been released for turnover. Commissioning on a system with no agreed boundary means two parties ' +
        'each believe the other holds the isolation, which is how people are hurt at energisation.';
}

// --- Construction completion ------------------------------------------------

/**
 * Accept construction completion.
 *
 * The stage 9 exit. Only an authorised party may issue it — the specification
 * says so and the matrix already answers who: the roles holding approve on the
 * project itself. The refusals are the stage's stated exit conditions, checked
 * rather than asserted.
 */
export function acceptConstructionCompletion(
  ctx: EngineContext,
  input: { acceptedBy: string; statement: string; certificateHash: string },
): { completionId: string; systems: number; retainedObligations: number; acceptedAt: string } {
  authorise(ctx, 'PROJECT_SETUP', 'A', { lifecyclePhase: currentPhase(ctx) });

  if (ctx.ledger.list(ctx.projectId, 'ConstructionCompletion').length > 0) {
    throw new DomainError('ALREADY_ACCEPTED', 'Construction completion has already been accepted on this project.');
  }
  if (!input.acceptedBy.trim() || input.statement.trim().length < 20) {
    throw new DomainError(
      'COMPLETION_UNSIGNED',
      'Name the party accepting completion and state what is being accepted. A completion certificate is the document the ' +
        'defects period, the retention release and half the insurance run from.',
    );
  }
  if (!input.certificateHash.trim()) {
    throw new DomainError('CERTIFICATE_REQUIRED', 'The issued certificate is the evidence. Record it.');
  }

  const turnovers = ctx.ledger.list(ctx.projectId, 'SystemTurnover');
  if (turnovers.length === 0) {
    throw new DomainError(
      'NOTHING_TURNED_OVER',
      'No system has been released to commissioning. The stage is left when the works are physically complete by system ' +
        'or area and turnover is released, and neither has been recorded.',
    );
  }

  // The exit condition names residual obligations being controlled, not
  // discharged: construction legitimately retains obligations past completion.
  // What it may not do is retain one nobody owns.
  const uncontrolled: string[] = [];
  for (const record of turnovers) {
    const defects = (record.state.residualDefects as ResidualDefect[] | undefined) ?? [];
    for (const defect of defects) {
      if (!defect.owner.trim()) uncontrolled.push(`${String(record.state.systemName)}: ${defect.reference}`);
    }
  }
  if (uncontrolled.length > 0) {
    throw new DomainError(
      'OBLIGATIONS_UNCONTROLLED',
      `${uncontrolled.join(', ')} ${uncontrolled.length === 1 ? 'is' : 'are'} carried into completion with no owner.`,
    );
  }

  const open = ctx.ledger
    .list(ctx.projectId, 'TurnoverException')
    .filter((record) => String(record.state.expiresOn) < new Date().toISOString().slice(0, 10));
  if (open.length > 0) {
    throw new DomainError(
      'EXCEPTIONS_EXPIRED',
      `${open.length} turnover exception${open.length === 1 ? ' has' : 's have'} passed the date the missing item was due. ` +
        'Accepting completion over an expired exception accepts the thing the exception was covering, without saying so.',
    );
  }

  const completionId = ulid();
  const acceptedAt = new Date().toISOString();
  const retainedObligations = turnovers.reduce(
    (sum, record) => sum + ((record.state.retainedObligations as string[] | undefined)?.length ?? 0),
    0,
  );

  const evidence = registerEvidence(ctx, {
    type: 'CONSTRUCTION_COMPLETION_CERTIFICATE',
    hash: input.certificateHash,
    description: `Construction completion accepted by ${input.acceptedBy} across ${turnovers.length} system(s)`,
    linkedEntities: [{ refType: 'Project', refId: ctx.projectId }],
  });

  write(ctx, {
    eventType: 'CONSTRUCTION_COMPLETION_ACCEPTED',
    entity: { refType: 'ConstructionCompletion', refId: completionId },
    nextState: {
      completionId,
      projectId: ctx.projectId,
      acceptedBy: input.acceptedBy,
      acceptedByActor: ctx.auth.actorId,
      statement: input.statement,
      systems: turnovers.map((record) => ({
        systemId: String(record.state.systemId),
        systemName: String(record.state.systemName),
        boundary: String(record.state.boundary),
        retainedObligations: record.state.retainedObligations,
      })),
      retainedObligations,
      acceptedAt,
    },
    evidenceRefs: [evidence],
  });

  return { completionId, systems: turnovers.length, retainedObligations, acceptedAt };
}

// --- The position -----------------------------------------------------------

export type CompletionPosition = {
  snapshots: Array<{
    reference: string;
    cutOff: string;
    audience: string;
    notReported: string[];
    criticalGaps: string[];
    stale: number;
  }>;
  latest?: PeriodSnapshot;
  recoveryPlans: Array<{ reference: string; recoveryDays: number; costMinor: number; shortfallDays: number; approvedBy: string }>;
  turnovers: Array<{
    systemName: string;
    boundary: string;
    restrictingDefects: number;
    retainedObligations: number;
    releasedAt: string;
  }>;
  exceptions: Array<{ systemName: string; whatIsMissing: string; acceptedBy: string; expiresOn: string; expired: boolean }>;
  completionAccepted?: { acceptedBy: string; acceptedAt: string; systems: number };
  summary: string;
};

export function completionPosition(
  ctx: EngineContext,
  today = new Date().toISOString().slice(0, 10),
): CompletionPosition {
  authorise(ctx, 'PROJECT_SETUP', 'R');

  const snapshots = ctx.ledger
    .list(ctx.projectId, 'PeriodSnapshot')
    .map((record) => record.state as unknown as PeriodSnapshot)
    .sort((a, b) => a.cutOff.localeCompare(b.cutOff));

  const turnovers = ctx.ledger.list(ctx.projectId, 'SystemTurnover').map((record) => record.state);
  const exceptions = ctx.ledger.list(ctx.projectId, 'TurnoverException').map((record) => record.state);
  const completion = ctx.ledger.list(ctx.projectId, 'ConstructionCompletion')[0]?.state;

  const latest = snapshots[snapshots.length - 1];
  const parts: string[] = [];
  if (!latest) {
    parts.push('No period report has been taken');
  } else {
    parts.push(`Last cut-off ${latest.cutOff.slice(0, 10)}`);
    if (latest.criticalGaps.length > 0) parts.push(`no ${latest.criticalGaps.join(', ')} reported at all`);
    else if (latest.notReported.length > 0) parts.push(`${latest.notReported.length} source not reported at all`);
    if (latest.stale.length > 0) parts.push(`${latest.stale.length} stale`);
  }
  if (turnovers.length > 0) parts.push(`${turnovers.length} system released to commissioning`);
  const expired = exceptions.filter((state) => String(state.expiresOn) < today);
  if (expired.length > 0) parts.push(`${expired.length} turnover exception past its date`);
  if (completion) parts.push('construction completion accepted');

  return {
    snapshots: snapshots.map((snapshot) => ({
      reference: snapshot.reference,
      cutOff: snapshot.cutOff,
      audience: snapshot.audience,
      notReported: snapshot.notReported,
      criticalGaps: snapshot.criticalGaps,
      stale: snapshot.stale.length,
    })),
    latest,
    recoveryPlans: ctx.ledger.list(ctx.projectId, 'RecoveryPlan').map((record) => ({
      reference: String(record.state.reference),
      recoveryDays: Number(record.state.recoveryDays),
      costMinor: Number(record.state.costMinor),
      shortfallDays: Number(record.state.shortfallDays),
      approvedBy: String(record.state.approvedBy),
    })),
    turnovers: turnovers.map((state) => ({
      systemName: String(state.systemName),
      boundary: String(state.boundary),
      restrictingDefects: ((state.residualDefects as ResidualDefect[] | undefined) ?? []).filter(
        (defect) => defect.classification === 'RESTRICTING',
      ).length,
      retainedObligations: ((state.retainedObligations as string[] | undefined) ?? []).length,
      releasedAt: String(state.releasedAt),
    })),
    exceptions: exceptions.map((state) => ({
      systemName: String(state.systemName),
      whatIsMissing: String(state.whatIsMissing),
      acceptedBy: String(state.acceptedBy),
      expiresOn: String(state.expiresOn),
      expired: String(state.expiresOn) < today,
    })),
    completionAccepted: completion
      ? {
          acceptedBy: String(completion.acceptedBy),
          acceptedAt: String(completion.acceptedAt),
          systems: ((completion.systems as unknown[] | undefined) ?? []).length,
        }
      : undefined,
    summary: parts.join(', ') + '.',
  };
}
