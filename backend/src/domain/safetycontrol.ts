import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, registerEvidence, write, type EngineContext } from '../engines/context.ts';
import type { EntityRecord } from '../goldenthread/ledger.ts';

/**
 * CN-WF-07 — RAMS, permit, toolbox, observation and incident control.
 *
 * `engines/safety.ts` already drafts a RAMS from a hazard library, approves it,
 * records the briefing, holds the competency register, issues a permit against
 * checked tickets, logs an observation and records an incident. None of that is
 * rebuilt. Four things were missing, and each of them is the *second half* of
 * something the platform could already start.
 *
 * **A method statement that was revised and nobody rebriefed.** The sixth step
 * of the flow and the first exception control. Conditions change, the method
 * changes, a new revision is issued — and the gang is working to the briefing
 * they had on Tuesday. A revision therefore **supersedes** rather than edits:
 * the new one starts unapproved and unbriefed, everybody who acknowledged the
 * old one is listed as owed a rebriefing by name, and the superseded revision
 * stays readable because somebody worked to it.
 *
 * **A permit that ran out and nobody handed back.** The second exception
 * control asks for extension and handback to follow authorised states, and they
 * now do. An extension cannot run past the competency of the people it
 * authorises — a permit extended over a lapsed ticket authorises work by
 * somebody nobody has checked. A handback records the state the area was left
 * in and who checked it, because the commonest injury after a confined-space
 * entry is to the person who goes in next.
 *
 * **An observation nobody closed.** AC-CN-WF-07-02 asks for an owner and
 * verification evidence on every control and action, and an observation logged
 * and left open is the leading indicator that leads nowhere.
 *
 * **An incident recorded and never investigated.** The fifth step. The
 * immediate facts are already captured well — including that the platform
 * *asks* whether it is RIDDOR reportable rather than deciding, which is the
 * guardrail the specification names. What was missing is everything after that
 * hour: immediate cause, underlying cause, root cause, and the actions that come
 * out of them. An incident cannot be closed without it, because an incident
 * closed on its immediate action alone has taught the project nothing.
 */

// --- RAMS revision and rebriefing -------------------------------------------

function requireRAMS(ctx: EngineContext, ramsId: string): EntityRecord {
  const record = ctx.ledger.get({ refType: 'RAMS', refId: ramsId });
  if (!record) throw new DomainError('RAMS_NOT_FOUND', `No method statement ${ramsId}`, 404);
  return record;
}

export function reviseRAMS(
  ctx: EngineContext,
  ramsId: string,
  input: { reason: string; whatChanged: string },
): { supersededId: string; revisionId: string; revision: number; owedRebriefing: string[] } {
  authorise(ctx, 'SAFETY_RAMS', 'C', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'SAFETY_L2' });

  const record = requireRAMS(ctx, ramsId);

  if (record.state.supersededBy) {
    throw new DomainError(
      'RAMS_ALREADY_SUPERSEDED',
      'This revision has already been superseded. Revise the one that stands, or the register carries two current methods ' +
        'for one activity and the gang picks.',
      409,
    );
  }
  if (!input.reason.trim() || !input.whatChanged.trim()) {
    throw new DomainError(
      'REVISION_UNEXPLAINED',
      'Say why the method changed and what changed in it. The rebriefing is about the difference, and a revision that does ' +
        'not state one gets briefed as "there is a new version".',
    );
  }

  // Everybody who worked to the old method is owed the difference.
  const owedRebriefing = ((record.state.acknowledgements as string[]) ?? []).slice();

  const revision = Number(record.state.revision ?? 1) + 1;
  const revisionId = ulid();

  write(ctx, {
    eventType: 'RAMS_REVISED',
    entity: { refType: 'RAMS', refId: revisionId },
    nextState: {
      ...record.state,
      id: revisionId,
      revision,
      supersedes: ramsId,
      supersessionReason: input.reason,
      whatChanged: input.whatChanged,
      // A new method is not an approved method, whatever the last one was.
      status: 'DRAFT',
      acknowledgements: [],
      owedRebriefing,
      revisedAt: new Date().toISOString(),
      revisedBy: ctx.auth.actorId,
    },
  });

  write(ctx, {
    eventType: 'RAMS_SUPERSEDED',
    entity: { refType: 'RAMS', refId: ramsId },
    nextState: {
      ...record.state,
      supersededBy: revisionId,
      supersededAt: new Date().toISOString(),
    },
  });

  return { supersededId: ramsId, revisionId, revision, owedRebriefing };
}

/**
 * Why the method statement position for this package blocks a start, or null.
 *
 * The first exception control. Called by CN-WF-01's readiness verification,
 * which already checks that a RAMS is approved and briefed — this adds the case
 * that check could not see: a *superseded* revision whose replacement nobody has
 * been briefed on. The gang is working to Tuesday's briefing and the method
 * changed on Thursday.
 */
export function ramsCurrencyBlockedReason(ctx: EngineContext, workPackageId: string): string | null {
  const all = ctx.ledger
    .list(ctx.projectId, 'RAMS')
    .filter((record) => record.state.workPackageId === workPackageId);

  const current = all.filter((record) => record.state.supersededBy === undefined);
  if (current.length === 0) return null;

  const unbriefed = current.filter(
    (record) => record.state.supersedes !== undefined && ((record.state.acknowledgements as string[]) ?? []).length === 0,
  );
  if (unbriefed.length === 0) return null;

  const owed = unbriefed.flatMap((record) => (record.state.owedRebriefing as string[]) ?? []);
  return (
    `The method statement for this package was revised to revision ${String(unbriefed[0]!.state.revision)} and nobody has ` +
    `been rebriefed on it${owed.length > 0 ? `; ${owed.join(', ')} worked to the superseded method` : ''}. Work started on ` +
    'the old briefing is work to a method the project has already decided is not the right one.'
  );
}

// --- Permit extension and handback ------------------------------------------

function requirePermit(ctx: EngineContext, permitId: string): EntityRecord {
  const record = ctx.ledger.get({ refType: 'Permit', refId: permitId });
  if (!record) throw new DomainError('PERMIT_NOT_FOUND', `No permit ${permitId}`, 404);
  return record;
}

export function extendPermit(
  ctx: EngineContext,
  permitId: string,
  input: { validTo: string; reason: string },
): { reference: string; validTo: string } {
  // Approve. Extending a permit is the same authority as issuing one.
  authorise(ctx, 'SAFETY_RAMS', 'A', { lifecyclePhase: currentPhase(ctx) });

  const record = requirePermit(ctx, permitId);

  if (record.state.status !== 'ISSUED') {
    throw new DomainError(
      'PERMIT_NOT_OPEN',
      `${String(record.state.reference)} is ${String(record.state.status).toLowerCase()}. A permit that has been handed back ` +
        'is finished; extending it would reopen an area somebody has already declared safe.',
      409,
    );
  }
  if (Number.isNaN(Date.parse(input.validTo))) {
    throw new DomainError('PERMIT_DATES_REQUIRED', 'An extension runs to a date.');
  }
  if (input.validTo <= String(record.state.validTo)) {
    throw new DomainError(
      'EXTENSION_NOT_AN_EXTENSION',
      `${String(record.state.reference)} already runs to ${String(record.state.validTo)}. An extension that shortens a ` +
        'permit is a revocation, and it is a different act with different consequences for the people under it.',
    );
  }
  if (!input.reason.trim()) {
    throw new DomainError('EXTENSION_UNEXPLAINED', 'Say why the work needs longer.');
  }

  // A permit extended over a lapsed ticket authorises work by somebody nobody
  // has checked, which is the exact failure the competency check at issue was
  // written to prevent.
  const competencies = ctx.ledger.list(ctx.projectId, 'Competency').map((entry) => entry.state);
  const lapsing: string[] = [];
  for (const operativeId of (record.state.operativeIds as string[]) ?? []) {
    const held = competencies.filter((entry) => entry.operativeId === operativeId);
    const covers = held.some((entry) => String(entry.expiresAt ?? '') >= input.validTo);
    if (!covers) {
      const latest = held
        .map((entry) => String(entry.expiresAt ?? ''))
        .sort()
        .at(-1);
      lapsing.push(`${operativeId} (${latest ?? 'no ticket recorded'})`);
    }
  }
  if (lapsing.length > 0) {
    throw new DomainError(
      'COMPETENCY_LAPSES_IN_EXTENSION',
      `${lapsing.join('; ')} would not be in date for the whole of the extension to ${input.validTo}. A permit extended over ` +
        'a lapsed ticket authorises work by somebody nobody has checked.',
      422,
    );
  }

  const extensions = (record.state.extensions as unknown[]) ?? [];

  write(ctx, {
    eventType: 'PERMIT_EXTENDED',
    entity: { refType: 'Permit', refId: permitId },
    nextState: {
      ...record.state,
      validTo: input.validTo,
      extensions: [
        ...extensions,
        {
          from: String(record.state.validTo),
          to: input.validTo,
          reason: input.reason,
          at: new Date().toISOString(),
          by: ctx.auth.actorId,
        },
      ],
    },
  });

  return { reference: String(record.state.reference), validTo: input.validTo };
}

export function handBackPermit(
  ctx: EngineContext,
  permitId: string,
  input: { areaCondition: string; checkedBy: string; outstandingHazards?: string },
): { reference: string; handedBack: true } {
  authorise(ctx, 'SAFETY_RAMS', 'A', { lifecyclePhase: currentPhase(ctx) });

  const record = requirePermit(ctx, permitId);

  if (record.state.status !== 'ISSUED') {
    throw new DomainError('PERMIT_NOT_OPEN', `${String(record.state.reference)} is not open.`, 409);
  }
  if (!input.areaCondition.trim() || !input.checkedBy.trim()) {
    throw new DomainError(
      'HANDBACK_UNCHECKED',
      'Say what state the area was left in and who checked it. The commonest injury after a confined-space entry is to the ' +
        'person who goes in next, and this sentence is what they are relying on.',
    );
  }

  write(ctx, {
    eventType: 'PERMIT_HANDED_BACK',
    entity: { refType: 'Permit', refId: permitId },
    nextState: {
      ...record.state,
      status: 'HANDED_BACK',
      handback: {
        areaCondition: input.areaCondition,
        checkedBy: input.checkedBy,
        ...(input.outstandingHazards?.trim() ? { outstandingHazards: input.outstandingHazards } : {}),
        at: new Date().toISOString(),
        by: ctx.auth.actorId,
      },
    },
  });

  return { reference: String(record.state.reference), handedBack: true };
}

/** Permits still open past the date they expired. Nobody handed these back. */
export function expiredPermits(
  ctx: EngineContext,
  on = new Date().toISOString().slice(0, 10),
): Array<{ permitId: string; reference: string; activity: string; location: string; expiredOn: string }> {
  return ctx.ledger
    .list(ctx.projectId, 'Permit')
    .filter((record) => record.state.status === 'ISSUED' && String(record.state.validTo).slice(0, 10) < on)
    .map((record) => ({
      permitId: record.refId,
      reference: String(record.state.reference),
      activity: String(record.state.activity),
      location: String(record.state.location),
      expiredOn: String(record.state.validTo).slice(0, 10),
    }));
}

// --- Closing a safety action ------------------------------------------------

export function closeSafetyAction(
  ctx: EngineContext,
  observationId: string,
  input: { owner: string; actionTaken: string; verificationEvidence: string; evidenceHash: string },
): { observationId: string; closed: true } {
  authorise(ctx, 'SAFETY_RAMS', 'U', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'SAFETY_L2' });

  const record = ctx.ledger.get({ refType: 'SafetyObservation', refId: observationId });
  if (!record) throw new DomainError('OBSERVATION_NOT_FOUND', `No safety observation ${observationId}`, 404);
  if (record.state.status === 'CLOSED') {
    throw new DomainError('OBSERVATION_CLOSED', 'This observation is already closed.');
  }

  // AC-CN-WF-07-02. An owner and verification on every control and action.
  const missing = (['owner', 'actionTaken', 'verificationEvidence'] as const).filter((field) => !input[field].trim());
  if (missing.length > 0) {
    throw new DomainError(
      'ACTION_UNVERIFIED',
      `The closure has no ${missing.join(', no ')}. An observation logged and closed with "done" is the leading indicator ` +
        'that leads nowhere.',
    );
  }

  const evidence = registerEvidence(ctx, {
    type: 'SAFETY_ACTION_VERIFICATION',
    hash: input.evidenceHash,
    description: `Verification of the action on observation ${observationId}: ${input.verificationEvidence}`,
    linkedEntities: [{ refType: 'SafetyObservation', refId: observationId }],
  });

  write(ctx, {
    eventType: 'SAFETY_ACTION_CLOSED',
    entity: { refType: 'SafetyObservation', refId: observationId },
    nextState: {
      ...record.state,
      status: 'CLOSED',
      action: {
        owner: input.owner,
        actionTaken: input.actionTaken,
        verificationEvidence: input.verificationEvidence,
        closedAt: new Date().toISOString(),
        closedBy: ctx.auth.actorId,
      },
    },
    evidenceRefs: [evidence],
  });

  return { observationId, closed: true };
}

// --- Incident investigation -------------------------------------------------

export type IncidentAction = { what: string; owner: string; by: string };

export function investigateIncident(
  ctx: EngineContext,
  incidentId: string,
  input: {
    /** What physically happened. The unguarded edge, the reversing vehicle. */
    immediateCause: string;
    /** The condition that allowed it. The missing barrier, the absent banksman. */
    underlyingCause: string;
    /** The decision that produced the condition. Almost never a person. */
    rootCause: string;
    actions: IncidentAction[];
    investigatedBy: string;
    evidenceHash: string;
  },
): { reference: string; actions: number } {
  authorise(ctx, 'SAFETY_RAMS', 'U', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'SAFETY_L2' });

  const record = ctx.ledger.get({ refType: 'Incident', refId: incidentId });
  if (!record) throw new DomainError('INCIDENT_NOT_FOUND', `No incident ${incidentId}`, 404);

  const missing = (['immediateCause', 'underlyingCause', 'rootCause', 'investigatedBy'] as const).filter(
    (field) => !input[field].trim(),
  );
  if (missing.length > 0) {
    throw new DomainError(
      'INVESTIGATION_INCOMPLETE',
      `The investigation has no ${missing.join(', no ')}. The immediate cause is what happened, the underlying cause is the ` +
        'condition that allowed it and the root cause is the decision that produced the condition — and an investigation ' +
        'that stops at the first of those concludes that somebody was careless.',
    );
  }
  if (input.actions.length === 0) {
    throw new DomainError(
      'ACTIONS_REQUIRED',
      'An investigation with no actions out of it has established a cause and changed nothing.',
    );
  }
  for (const action of input.actions) {
    if (!action.what.trim() || !action.owner.trim() || Number.isNaN(Date.parse(action.by))) {
      throw new DomainError('ACTIONS_REQUIRED', 'Every action names what, who and by when.');
    }
  }
  if (!input.evidenceHash.trim()) {
    throw new DomainError('EVIDENCE_REQUIRED', 'An investigation carries the report it produced.');
  }

  const evidence = registerEvidence(ctx, {
    type: 'INCIDENT_INVESTIGATION',
    hash: input.evidenceHash,
    description: `Investigation of ${String(record.state.reference)}`,
    linkedEntities: [{ refType: 'Incident', refId: incidentId }],
  });

  write(ctx, {
    eventType: 'INCIDENT_INVESTIGATED',
    entity: { refType: 'Incident', refId: incidentId },
    nextState: {
      ...record.state,
      status: 'INVESTIGATED',
      investigation: {
        immediateCause: input.immediateCause,
        underlyingCause: input.underlyingCause,
        rootCause: input.rootCause,
        actions: input.actions.map((action) => ({ ...action, by: action.by.slice(0, 10), status: 'OPEN' })),
        investigatedBy: input.investigatedBy,
        at: new Date().toISOString(),
        recordedBy: ctx.auth.actorId,
      },
    },
    evidenceRefs: [evidence],
  });

  return { reference: String(record.state.reference), actions: input.actions.length };
}

export function closeIncident(
  ctx: EngineContext,
  incidentId: string,
  input: { note: string },
): { reference: string; closed: true } {
  authorise(ctx, 'SAFETY_RAMS', 'A', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'SAFETY_L2' });

  const record = ctx.ledger.get({ refType: 'Incident', refId: incidentId });
  if (!record) throw new DomainError('INCIDENT_NOT_FOUND', `No incident ${incidentId}`, 404);
  if (record.state.status === 'CLOSED') {
    throw new DomainError('INCIDENT_CLOSED', `${String(record.state.reference)} is already closed.`);
  }
  if (!record.state.investigation) {
    throw new DomainError(
      'INVESTIGATION_REQUIRED',
      `${String(record.state.reference)} has not been investigated. An incident closed on its immediate action alone has ` +
        'taught the project nothing, and the next one is the same incident.',
      409,
    );
  }
  if (!input.note.trim()) {
    throw new DomainError('CLOSURE_UNEXPLAINED', 'Say what closes it.');
  }

  write(ctx, {
    eventType: 'INCIDENT_INVESTIGATED',
    entity: { refType: 'Incident', refId: incidentId },
    nextState: {
      ...record.state,
      status: 'CLOSED',
      closureNote: input.note,
      closedAt: new Date().toISOString(),
      closedBy: ctx.auth.actorId,
    },
  });

  return { reference: String(record.state.reference), closed: true };
}

// --- The position -----------------------------------------------------------

export type SafetyControlPosition = {
  /** Revised methods nobody has been rebriefed on. Work is running on the old one. */
  awaitingRebriefing: Array<{ ramsId: string; revision: number; whatChanged: string; owed: string[] }>;
  /** Open past their expiry. Nobody handed these areas back. */
  expiredPermits: Array<{ reference: string; activity: string; location: string; expiredOn: string }>;
  /** Observations logged and never closed out. */
  openObservations: Array<{ observationId: string; description: string; severity: string; location: string }>;
  /** Incidents recorded and never investigated, and the actions still owed. */
  uninvestigated: Array<{ reference: string; category: string; occurredAt: string; escalated: boolean }>;
  outstandingActions: Array<{ incident: string; what: string; owner: string; by: string; overdue: boolean }>;
  summary: string;
};

export function safetyControlPosition(
  ctx: EngineContext,
  today = new Date().toISOString().slice(0, 10),
): SafetyControlPosition {
  authorise(ctx, 'SAFETY_RAMS', 'R');

  const awaitingRebriefing = ctx.ledger
    .list(ctx.projectId, 'RAMS')
    .filter(
      (record) =>
        record.state.supersededBy === undefined &&
        record.state.supersedes !== undefined &&
        ((record.state.acknowledgements as string[]) ?? []).length === 0,
    )
    .map((record) => ({
      ramsId: record.refId,
      revision: Number(record.state.revision ?? 1),
      whatChanged: String(record.state.whatChanged ?? ''),
      owed: (record.state.owedRebriefing as string[]) ?? [],
    }));

  const openObservations = ctx.ledger
    .list(ctx.projectId, 'SafetyObservation')
    .filter((record) => record.state.status !== 'CLOSED')
    .map((record) => ({
      observationId: record.refId,
      description: String(record.state.description),
      severity: String(record.state.severity ?? 'MEDIUM'),
      location: String(record.state.location ?? ''),
    }));

  const uninvestigated: SafetyControlPosition['uninvestigated'] = [];
  const outstandingActions: SafetyControlPosition['outstandingActions'] = [];

  for (const record of ctx.ledger.list(ctx.projectId, 'Incident')) {
    const investigation = record.state.investigation as Record<string, unknown> | undefined;
    if (!investigation) {
      uninvestigated.push({
        reference: String(record.state.reference),
        category: String(record.state.category),
        occurredAt: String(record.state.occurredAt),
        escalated: record.state.escalated === true,
      });
      continue;
    }
    for (const action of (investigation.actions as IncidentAction[]) ?? []) {
      outstandingActions.push({
        incident: String(record.state.reference),
        what: action.what,
        owner: action.owner,
        by: action.by,
        overdue: action.by < today,
      });
    }
  }

  const parts: string[] = [];
  if (awaitingRebriefing.length > 0) parts.push(`${awaitingRebriefing.length} revised method(s) nobody has been rebriefed on`);
  const expired = expiredPermits(ctx, today);
  if (expired.length > 0) parts.push(`${expired.length} permit(s) open past their expiry`);
  if (openObservations.length > 0) parts.push(`${openObservations.length} observation(s) open`);
  if (uninvestigated.length > 0) parts.push(`${uninvestigated.length} incident(s) not investigated`);
  const overdue = outstandingActions.filter((action) => action.overdue).length;
  if (overdue > 0) parts.push(`${overdue} incident action(s) past their date`);
  if (parts.length === 0) parts.push('Nothing awaiting a rebriefing, no permit past its expiry and every incident investigated');

  return {
    awaitingRebriefing,
    expiredPermits: expired.map(({ reference, activity, location, expiredOn }) => ({
      reference,
      activity,
      location,
      expiredOn,
    })),
    openObservations,
    uninvestigated,
    outstandingActions,
    summary: parts.join(', ') + '.',
  };
}
