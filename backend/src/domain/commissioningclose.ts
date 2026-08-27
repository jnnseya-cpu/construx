import { DomainError } from '../core/errors.ts';
import { hashState } from '../core/canonical.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, registerEvidence, write, type EngineContext } from '../engines/context.ts';
import { outstandingSeasonalTests } from './reliability.ts';

/**
 * CM-WF-08 — training, documentation readiness and the commissioning gate.
 *
 * The end of the commissioning stage, and three things that decide whether the
 * operator can actually run the building.
 *
 * **Completeness is calculated from required records, not from files.**
 * AC-CM-WF-08-01, and the same principle CM-WF-04 applies to readiness. A
 * dossier scored on how many documents were uploaded reaches 100% when somebody
 * attaches the wrong O&M twice, and reaches 60% on a system whose six records
 * happen to be in one combined PDF. Here the dossier has a **required record
 * list per system**, each item present or absent by reference, and the
 * percentage is over that.
 *
 * **Training on superseded information is not training.** The exception control,
 * and it is the one nobody expects. Operators are trained in the last fortnight
 * before handover, which is exactly when as-builts and O&Ms are still moving. A
 * session delivered against revision B of a control description that is now at
 * revision C taught people to operate a building that does not exist. The
 * platform records what each session was delivered *against*, and invalidates
 * the session when that information is superseded.
 *
 * **An acceptance is a named person's acknowledgement.** AC-CM-WF-08-02. The
 * party accepting a system is the party that will be running it at three in the
 * morning, and "accepted" with nobody's name on it is the row nobody can be
 * asked about. A conditional acceptance carries its operating limits, the risk
 * owner, an expiry and the plan for closing it — all four, because a condition
 * missing any of them becomes permanent.
 *
 * **Obligations transfer by reference.** AC-CM-WF-08-03. The seasonal tests come
 * from `reliability.outstandingSeasonalTests` and the residual items from the
 * open exceptions; nothing is copied into a second list that then diverges from
 * the first. Handover inherits the identifiers, not the text.
 */

/**
 * What a commissioning dossier has to contain for one system.
 *
 * A fixed list from the specification's own required inputs. `critical` marks
 * the records whose absence blocks acceptance rather than merely lowering the
 * percentage — an operator can start without a spares list and cannot start
 * without the O&M or the test records.
 */
export const DOSSIER_RECORD = [
  { key: 'AS_BUILT', what: 'As-built drawings or model for the system', critical: true },
  { key: 'OM_MANUAL', what: 'Operation and maintenance manual', critical: true },
  { key: 'TEST_RECORDS', what: 'Accepted functional and performance test records', critical: true },
  { key: 'CERTIFICATES', what: 'Statutory and third-party certificates', critical: true },
  { key: 'FIRE_SAFETY_INFORMATION', what: 'Fire and safety information for the system', critical: true },
  { key: 'ASSET_DATA', what: 'Asset tags, locations, manufacturer, model and serial', critical: true },
  { key: 'WARRANTY', what: 'Warranty terms and start dates', critical: false },
  { key: 'SPARES', what: 'Recommended spares and consumables', critical: false },
  { key: 'MAINTENANCE', what: 'Planned maintenance tasks and frequencies', critical: false },
  { key: 'TRAINING_RECORDS', what: 'Operator training records and competence evidence', critical: true },
  { key: 'SETTINGS', what: 'Control setpoints, sequences and cause-and-effect as commissioned', critical: true },
  { key: 'ACCESS', what: 'Keys, credentials, isolation points and emergency procedures', critical: false },
] as const;

export type DossierRecordKey = (typeof DOSSIER_RECORD)[number]['key'];

export type DossierEntry = {
  key: DossierRecordKey;
  /** The controlled reference and revision of the record supplied. */
  reference: string;
  revision: string;
  evidenceRef: string;
};

// --- Training ---------------------------------------------------------------

export type TrainingAttendee = {
  name: string;
  role: string;
  organisation: string;
  /** Whether they were assessed as competent, not merely present. */
  competent: boolean;
};

export type TrainingSessionState = {
  sessionId: string;
  reference: string;
  systemTag: string;
  role: string;
  /** The controlled information the session taught, at the revision taught. */
  deliveredAgainst: Array<{ reference: string; revision: string }>;
  deliveredBy: string;
  deliveredAt: string;
  attendees: TrainingAttendee[];
  status: 'DELIVERED' | 'INVALIDATED';
  invalidation?: { supersededReference: string; newRevision: string; recordedBy: string; recordedAt: string };
};

/** Record a delivered training session against the information it taught. */
export function recordTraining(
  ctx: EngineContext,
  input: {
    reference: string;
    systemTag: string;
    role: string;
    deliveredAgainst: Array<{ reference: string; revision: string }>;
    deliveredBy: string;
    deliveredAt: string;
    attendees: TrainingAttendee[];
  },
): { sessionId: string; competent: number; attended: number } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'C', { lifecyclePhase: currentPhase(ctx) });

  if (!input.reference.trim() || !input.role.trim()) {
    throw new DomainError(
      'SESSION_UNIDENTIFIED',
      'A training session carries a reference and the role it was for. Training "for the client" is training nobody can ' +
        'show was the right training for the person doing the job.',
    );
  }
  if (input.deliveredAgainst.length === 0) {
    throw new DomainError(
      'INFORMATION_REQUIRED',
      'Record the information the session was delivered against, at the revision taught. Operators are trained in the last ' +
        'fortnight before handover, which is exactly when as-builts and control descriptions are still moving, and a ' +
        'session with no revision on it cannot be told apart from one taught on superseded information.',
    );
  }
  if (input.deliveredAgainst.some((entry) => !entry.reference.trim() || !entry.revision.trim())) {
    throw new DomainError('INFORMATION_REQUIRED', 'Every document taught from names its reference and its revision.');
  }
  if (Number.isNaN(Date.parse(input.deliveredAt))) {
    throw new DomainError('DATE_REQUIRED', 'A session was delivered on a date.');
  }
  if (input.attendees.length === 0) {
    throw new DomainError('NOBODY_ATTENDED', 'A session with nobody at it trained nobody.');
  }
  if (input.attendees.some((attendee) => !attendee.name.trim() || !attendee.role.trim())) {
    throw new DomainError(
      'ATTENDEE_UNNAMED',
      'Name every attendee and the role they hold. A headcount is not competence evidence.',
    );
  }
  if (!input.deliveredBy.trim()) throw new DomainError('TRAINER_REQUIRED', 'Name who delivered it.');

  const sessionId = ulid();

  write(ctx, {
    eventType: 'TRAINING_DELIVERED',
    entity: { refType: 'TrainingSession', refId: sessionId },
    nextState: {
      sessionId,
      projectId: ctx.projectId,
      reference: input.reference,
      systemTag: input.systemTag,
      role: input.role,
      deliveredAgainst: input.deliveredAgainst,
      deliveredBy: input.deliveredBy,
      deliveredAt: input.deliveredAt,
      attendees: input.attendees,
      status: 'DELIVERED',
      recordedBy: ctx.auth.actorId,
      recordedAt: new Date().toISOString(),
    },
  });

  return {
    sessionId,
    competent: input.attendees.filter((attendee) => attendee.competent).length,
    attended: input.attendees.length,
  };
}

/**
 * Supersede a document, invalidating every session taught from the old revision.
 *
 * The exception control, applied rather than reported. A session taught against
 * revision B of a control description now at revision C taught people to operate
 * a building that does not exist, and the only honest state for it is
 * invalidated.
 */
export function supersedeTrainingInformation(
  ctx: EngineContext,
  input: { reference: string; supersededRevision: string; newRevision: string; recordedBy: string },
): { invalidated: string[] } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'U', { lifecyclePhase: currentPhase(ctx) });

  if (!input.reference.trim() || !input.newRevision.trim()) {
    throw new DomainError('SUPERSESSION_UNIDENTIFIED', 'Name the document and the revision that replaces the old one.');
  }
  if (!input.recordedBy.trim()) throw new DomainError('SUPERSESSION_UNSIGNED', 'Name who recorded it.');

  const invalidated: string[] = [];
  const recordedAt = new Date().toISOString();

  for (const record of ctx.ledger.list(ctx.projectId, 'TrainingSession')) {
    const state = record.state as unknown as TrainingSessionState;
    if (state.status === 'INVALIDATED') continue;
    const taught = state.deliveredAgainst.some(
      (entry) => entry.reference === input.reference && entry.revision === input.supersededRevision,
    );
    if (!taught) continue;

    write(ctx, {
      eventType: 'TRAINING_INVALIDATED',
      entity: { refType: 'TrainingSession', refId: state.sessionId },
      nextState: {
        ...record.state,
        status: 'INVALIDATED',
        invalidation: {
          supersededReference: `${input.reference} rev ${input.supersededRevision}`,
          newRevision: input.newRevision,
          recordedBy: input.recordedBy,
          recordedAt,
        },
      },
    });
    invalidated.push(state.reference);
  }

  return { invalidated };
}

// --- The dossier ------------------------------------------------------------

export type DossierState = {
  dossierId: string;
  systemTag: string;
  entries: DossierEntry[];
  completenessPercent: number;
  missingCritical: DossierRecordKey[];
  /** Over the entries as supplied, so a later addition is visibly a later one. */
  indexHash: string;
  compiledBy: string;
  compiledAt: string;
};

function completenessOf(entries: readonly DossierEntry[]): {
  percent: number;
  missing: DossierRecordKey[];
  missingCritical: DossierRecordKey[];
} {
  const supplied = new Set(entries.map((entry) => entry.key));
  const missing = DOSSIER_RECORD.filter((record) => !supplied.has(record.key)).map((record) => record.key);
  const missingCritical = DOSSIER_RECORD.filter((record) => record.critical && !supplied.has(record.key)).map(
    (record) => record.key,
  );
  return {
    percent: Math.round(((DOSSIER_RECORD.length - missing.length) / DOSSIER_RECORD.length) * 100),
    missing,
    missingCritical,
  };
}

/**
 * Compile the dossier for one system.
 *
 * The index is hashed so the dossier as handed over is identifiable. Adding a
 * record afterwards produces a different index, which is the point: a dossier
 * that can be quietly topped up is not a dossier anybody accepted.
 */
export function compileDossier(
  ctx: EngineContext,
  input: { systemTag: string; entries: DossierEntry[]; compiledBy: string },
): { dossierId: string; completenessPercent: number; missing: DossierRecordKey[]; indexHash: string } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'C', { lifecyclePhase: currentPhase(ctx) });

  if (!ctx.ledger.list(ctx.projectId, 'SystemNode').some((record) => record.state.tag === input.systemTag)) {
    throw new DomainError('SYSTEM_NOT_FOUND', `${input.systemTag} is not a defined system.`, 404);
  }
  if (!input.compiledBy.trim()) throw new DomainError('DOSSIER_UNSIGNED', 'Name who compiled it.');

  const unreferenced = input.entries.find((entry) => !entry.reference.trim() || !entry.revision.trim());
  if (unreferenced) {
    throw new DomainError(
      'ENTRY_UNREFERENCED',
      `${unreferenced.key} is listed with no ${!unreferenced.reference.trim() ? 'reference' : 'revision'}. A dossier entry ` +
        'that cannot be resolved to a controlled document at a revision is a filename.',
    );
  }
  const duplicate = input.entries.find(
    (entry, index) => input.entries.findIndex((other) => other.key === entry.key) !== index,
  );
  if (duplicate) {
    throw new DomainError(
      'ENTRY_DUPLICATED',
      `${duplicate.key} is supplied twice. Completeness is counted from the required records, so a second copy of one ` +
        'record adds nothing and hides which is current.',
    );
  }

  const completeness = completenessOf(input.entries);
  const dossierId = ulid();
  const indexHash = hashState(input.entries.map((entry) => ({ key: entry.key, reference: entry.reference, revision: entry.revision })));

  const evidence = registerEvidence(ctx, {
    type: 'COMMISSIONING_DOSSIER_INDEX',
    hash: indexHash,
    description: `Commissioning dossier for ${input.systemTag}: ${input.entries.length} of ${DOSSIER_RECORD.length} required records`,
    linkedEntities: [{ refType: 'Project', refId: ctx.projectId }],
  });

  write(ctx, {
    eventType: 'COMMISSIONING_DOSSIER_COMPILED',
    entity: { refType: 'CommissioningDossier', refId: dossierId },
    nextState: {
      dossierId,
      projectId: ctx.projectId,
      systemTag: input.systemTag,
      entries: input.entries,
      completenessPercent: completeness.percent,
      missing: completeness.missing,
      missingCritical: completeness.missingCritical,
      indexHash,
      compiledBy: input.compiledBy,
      compiledAt: new Date().toISOString(),
    },
    evidenceRefs: [evidence],
  });

  return {
    dossierId,
    completenessPercent: completeness.percent,
    missing: completeness.missing,
    indexHash,
  };
}

// --- System acceptance ------------------------------------------------------

export type SystemAcceptanceState = {
  acceptanceId: string;
  systemTag: string;
  decision: 'ACCEPTED' | 'CONDITIONAL' | 'REJECTED';
  /** AC-CM-WF-08-02: the person who will be running it, by name. */
  acknowledgedBy: string;
  acknowledgedForOrganisation: string;
  conditions?: { operatingLimits: string; riskOwner: string; expiresOn: string; closurePlan: string };
  note: string;
  acceptedAt: string;
};

/**
 * Accept a system into operation.
 *
 * Blocked by a critical open exception — the exception control — and refused
 * without a dossier whose critical records are present, because the operator
 * cannot run a system whose O&M or test records nobody has supplied.
 */
export function acceptSystem(
  ctx: EngineContext,
  input: {
    systemTag: string;
    decision: 'ACCEPTED' | 'CONDITIONAL' | 'REJECTED';
    acknowledgedBy: string;
    acknowledgedForOrganisation: string;
    note: string;
    conditions?: { operatingLimits: string; riskOwner: string; expiresOn: string; closurePlan: string };
  },
): { acceptanceId: string; decision: string } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'A', { lifecyclePhase: currentPhase(ctx) });

  if (!input.acknowledgedBy.trim() || !input.acknowledgedForOrganisation.trim()) {
    throw new DomainError(
      'ACKNOWLEDGEMENT_REQUIRED',
      'Name the operator or owner accepting the system and who they act for. The party accepting it is the party running ' +
        'it at three in the morning, and "accepted" with nobody’s name on it is the row nobody can be asked about.',
    );
  }
  if (input.note.trim().length < 10) {
    throw new DomainError('NOTE_REQUIRED', 'Say what is being accepted, or why it is not.');
  }
  if (ctx.ledger.list(ctx.projectId, 'SystemAcceptance').some((record) => record.state.systemTag === input.systemTag)) {
    throw new DomainError('ALREADY_DECIDED', `${input.systemTag} has already been accepted or rejected.`);
  }

  if (input.decision !== 'REJECTED') {
    const critical = ctx.ledger
      .list(ctx.projectId, 'CommissioningException')
      .filter(
        (record) =>
          record.state.systemTag === input.systemTag &&
          record.state.severity === 'SAFETY_CRITICAL' &&
          record.state.status !== 'CLOSED' &&
          record.state.status !== 'CONDITIONALLY_ACCEPTED',
      )
      .map((record) => String(record.state.reference));
    if (critical.length > 0) {
      throw new DomainError(
        'CRITICAL_EXCEPTION_OPEN',
        `${critical.join(', ')} ${critical.length === 1 ? 'is' : 'are'} open and safety-critical against ${input.systemTag}. ` +
          'A system accepted over one of those is a system somebody operates believing it was checked.',
      );
    }

    const dossier = ctx.ledger
      .list(ctx.projectId, 'CommissioningDossier')
      .filter((record) => record.state.systemTag === input.systemTag)
      .pop();
    if (!dossier) {
      throw new DomainError(
        'NO_DOSSIER',
        `No commissioning dossier has been compiled for ${input.systemTag}. Acceptance is of a system and its information ` +
          'together; the operator cannot run one without the other.',
      );
    }
    const missingCritical = (dossier.state.missingCritical as string[] | undefined) ?? [];
    if (missingCritical.length > 0) {
      throw new DomainError(
        'DOSSIER_INCOMPLETE',
        `The dossier for ${input.systemTag} is missing ${missingCritical.join(', ')}. Completeness is counted from the ` +
          'required records rather than the file count, and these are the ones an operator cannot start without.',
      );
    }
  }

  if (input.decision === 'CONDITIONAL') {
    const conditions = input.conditions;
    if (
      !conditions ||
      conditions.operatingLimits.trim().length < 10 ||
      !conditions.riskOwner.trim() ||
      !conditions.closurePlan.trim() ||
      Number.isNaN(Date.parse(conditions.expiresOn ?? ''))
    ) {
      throw new DomainError(
        'CONDITIONS_INCOMPLETE',
        'A conditional acceptance states the operating limits, the risk owner, the expiry and the plan for closing it. All ' +
          'four, because a condition missing any of them becomes permanent.',
      );
    }
  }

  const acceptanceId = ulid();

  write(ctx, {
    eventType: 'SYSTEM_COMMISSIONING_ACCEPTED',
    entity: { refType: 'SystemAcceptance', refId: acceptanceId },
    nextState: {
      acceptanceId,
      projectId: ctx.projectId,
      systemTag: input.systemTag,
      decision: input.decision,
      acknowledgedBy: input.acknowledgedBy,
      acknowledgedForOrganisation: input.acknowledgedForOrganisation,
      conditions: input.conditions,
      note: input.note,
      acceptedByActor: ctx.auth.actorId,
      acceptedAt: new Date().toISOString(),
    },
  });

  return { acceptanceId, decision: input.decision };
}

// --- Commissioning complete -------------------------------------------------

export type HandoverObligation = {
  /** The stable identifier the obligation already has. Nothing is renumbered. */
  reference: string;
  kind: 'SEASONAL_TEST' | 'CONDITIONAL_ACCEPTANCE' | 'OPEN_EXCEPTION';
  systemTag: string;
  detail: string;
  owner: string;
  by?: string;
};

/**
 * Every obligation the handover stage inherits.
 *
 * AC-CM-WF-08-03, and it is a **read** rather than a copy. The seasonal tests
 * come from CM-WF-06 and the residual items from CM-WF-07, each keeping the
 * identifier it already has; a second list written here would be the one that
 * disagrees with the first within a month.
 */
export function handoverObligations(ctx: EngineContext): HandoverObligation[] {
  const obligations: HandoverObligation[] = [];

  for (const seasonal of outstandingSeasonalTests(ctx)) {
    obligations.push({
      reference: seasonal.reference,
      kind: 'SEASONAL_TEST',
      systemTag: seasonal.systemTag,
      detail: `${seasonal.condition} — ${seasonal.criteria}`,
      owner: seasonal.responsibilityAcceptedBy,
      by: seasonal.windowTo,
    });
  }

  for (const record of ctx.ledger.list(ctx.projectId, 'CommissioningException')) {
    const state = record.state as Record<string, unknown>;
    if (state.status === 'CLOSED') continue;
    const conditional = state.conditionalAcceptance as { operatingRestriction: string; reviewBy: string } | undefined;
    obligations.push({
      reference: String(state.reference),
      kind: conditional ? 'CONDITIONAL_ACCEPTANCE' : 'OPEN_EXCEPTION',
      systemTag: String(state.systemTag),
      detail: conditional ? conditional.operatingRestriction : String(state.probableCause),
      owner: String(state.responsibleParty),
      by: conditional?.reviewBy,
    });
  }

  for (const record of ctx.ledger.list(ctx.projectId, 'SystemAcceptance')) {
    const state = record.state as Record<string, unknown>;
    const conditions = state.conditions as { operatingLimits: string; riskOwner: string; expiresOn: string } | undefined;
    if (state.decision !== 'CONDITIONAL' || !conditions) continue;
    obligations.push({
      reference: `${String(state.systemTag)}/ACCEPTANCE`,
      kind: 'CONDITIONAL_ACCEPTANCE',
      systemTag: String(state.systemTag),
      detail: conditions.operatingLimits,
      owner: conditions.riskOwner,
      by: conditions.expiresOn,
    });
  }

  return obligations;
}

/**
 * Close the commissioning stage.
 *
 * The 10.4 gate decision itself is `stagegate.decideGate`, which is shared by
 * every stage and not duplicated here. What this records is the stage's own exit
 * event and the obligations the next stage inherits — by reference, so nothing
 * is renumbered on the way across.
 */
export function completeCommissioning(
  ctx: EngineContext,
  input: { acceptedBy: string; statement: string },
): { systemsAccepted: number; obligations: number } {
  authorise(ctx, 'PROJECT_SETUP', 'A', { lifecyclePhase: currentPhase(ctx) });

  if (ctx.ledger.list(ctx.projectId, 'CommissioningCompletion').length > 0) {
    throw new DomainError('ALREADY_COMPLETE', 'Commissioning has already been completed on this project.');
  }
  if (!input.acceptedBy.trim() || input.statement.trim().length < 20) {
    throw new DomainError(
      'COMPLETION_UNSIGNED',
      'Name the party accepting commissioning complete and state what is being accepted.',
    );
  }

  const systems = ctx.ledger.list(ctx.projectId, 'SystemNode').filter((record) => record.state.level === 'SYSTEM');
  if (systems.length === 0) {
    throw new DomainError('NO_SYSTEMS', 'No systems have been defined, so there is nothing to have commissioned.');
  }

  const acceptances = ctx.ledger.list(ctx.projectId, 'SystemAcceptance');
  const decided = new Set(acceptances.map((record) => String(record.state.systemTag)));
  const undecided = systems.map((record) => String(record.state.tag)).filter((tag) => !decided.has(tag));
  if (undecided.length > 0) {
    throw new DomainError(
      'SYSTEMS_UNDECIDED',
      `${undecided.join(', ')} ${undecided.length === 1 ? 'has' : 'have'} no acceptance decision. The stage is left when ` +
        'every system is accepted or accepted under a controlled condition, and a system nobody decided on is neither.',
    );
  }

  const rejected = acceptances
    .filter((record) => record.state.decision === 'REJECTED')
    .map((record) => String(record.state.systemTag));
  if (rejected.length > 0) {
    throw new DomainError(
      'SYSTEMS_REJECTED',
      `${rejected.join(', ')} ${rejected.length === 1 ? 'was' : 'were'} rejected. Completing the stage over a rejected ` +
        'system hands the operator something nobody accepted.',
    );
  }

  const obligations = handoverObligations(ctx);
  const completionId = ulid();
  const acceptedAt = new Date().toISOString();

  write(ctx, {
    eventType: 'COMMISSIONING_COMPLETE',
    entity: { refType: 'CommissioningCompletion', refId: completionId },
    nextState: {
      completionId,
      projectId: ctx.projectId,
      acceptedBy: input.acceptedBy,
      acceptedByActor: ctx.auth.actorId,
      statement: input.statement,
      systemsAccepted: acceptances.length,
      // Stored as identifiers and their kind, never as copied text: the detail
      // is read back from the record that owns it.
      inheritedObligations: obligations.map((obligation) => ({
        reference: obligation.reference,
        kind: obligation.kind,
        systemTag: obligation.systemTag,
      })),
      acceptedAt,
    },
  });

  return { systemsAccepted: acceptances.length, obligations: obligations.length };
}

// --- The position -----------------------------------------------------------

export type CommissioningClosePosition = {
  dossiers: Array<{
    systemTag: string;
    completenessPercent: number;
    missing: string[];
    missingCritical: string[];
    indexHash: string;
  }>;
  training: Array<{
    reference: string;
    systemTag: string;
    role: string;
    attended: number;
    competent: number;
    status: string;
    invalidatedBy?: string;
  }>;
  /** Roles trained on information that has since been superseded. */
  retrainingOwed: string[];
  acceptances: Array<{ systemTag: string; decision: string; acknowledgedBy: string; expiresOn?: string }>;
  obligations: HandoverObligation[];
  complete: boolean;
  summary: string;
};

export function commissioningClosePosition(ctx: EngineContext): CommissioningClosePosition {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'R');

  const training = ctx.ledger.list(ctx.projectId, 'TrainingSession').map((record) => {
    const state = record.state as unknown as TrainingSessionState;
    return {
      reference: state.reference,
      systemTag: state.systemTag,
      role: state.role,
      attended: state.attendees.length,
      competent: state.attendees.filter((attendee) => attendee.competent).length,
      status: state.status,
      invalidatedBy: state.invalidation?.supersededReference,
    };
  });

  const dossiers = ctx.ledger.list(ctx.projectId, 'CommissioningDossier').map((record) => ({
    systemTag: String(record.state.systemTag),
    completenessPercent: Number(record.state.completenessPercent),
    missing: (record.state.missing as string[] | undefined) ?? [],
    missingCritical: (record.state.missingCritical as string[] | undefined) ?? [],
    indexHash: String(record.state.indexHash),
  }));

  const acceptances = ctx.ledger.list(ctx.projectId, 'SystemAcceptance').map((record) => {
    const conditions = record.state.conditions as { expiresOn: string } | undefined;
    return {
      systemTag: String(record.state.systemTag),
      decision: String(record.state.decision),
      acknowledgedBy: `${String(record.state.acknowledgedBy)} (${String(record.state.acknowledgedForOrganisation)})`,
      expiresOn: conditions?.expiresOn,
    };
  });

  const obligations = handoverObligations(ctx);
  const retrainingOwed = [...new Set(training.filter((entry) => entry.status === 'INVALIDATED').map((entry) => entry.role))];
  const complete = ctx.ledger.list(ctx.projectId, 'CommissioningCompletion').length > 0;

  const parts: string[] = [];
  parts.push(`${acceptances.length} system decision${acceptances.length === 1 ? '' : 's'}`);
  const incomplete = dossiers.filter((dossier) => dossier.missingCritical.length > 0).length;
  if (incomplete > 0) parts.push(`${incomplete} dossier missing a record an operator cannot start without`);
  if (retrainingOwed.length > 0) parts.push(`${retrainingOwed.length} role trained on information since superseded`);
  if (obligations.length > 0) parts.push(`${obligations.length} obligation for handover to inherit`);
  if (complete) parts.push('commissioning complete');

  return { dossiers, training, retrainingOwed, acceptances, obligations, complete, summary: parts.join(', ') + '.' };
}
