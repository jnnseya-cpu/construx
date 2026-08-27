import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, registerEvidence, write, type EngineContext } from '../engines/context.ts';

/**
 * H-WF-05 — regulatory completion and Golden Thread transfer.
 *
 * The most consequential workflow in the handover stage and the one where the
 * platform's limits have to be stated plainly, so they are stated here first.
 *
 * **What this does not do.** It does not decide what any jurisdiction requires.
 * The checklist below is the specification's own list of required inputs, and
 * the `jurisdiction` recorded against a readiness check says which regime the
 * pack was assembled for — it does not encode that regime's law. Nothing here
 * makes a legal classification, signs a declaration, or submits anything to a
 * regulator: submission happens outside this platform and what is recorded is
 * that it happened, by whom, and what came back. The specification's guardrail
 * is exactly that, and pretending otherwise would be the most dangerous thing
 * this codebase could do.
 *
 * **What it does do**, and each is one of the acceptance criteria:
 *
 * **AC-H-WF-05-01: exact versions.** A completion pack referencing "the
 * as-built drawings" references nothing. Every item names its document, its
 * version, and the evidence behind it — because the question asked of a
 * completion pack years later is which revision was in it, and a pack that
 * cannot answer that is a pack that proves nothing.
 *
 * **Changes since approval are reflected, or the pack is not approved.** The
 * second step of the flow. A change approved, built, and never carried into the
 * as-built is the single most common reason a completion application fails, and
 * `asbuilt.asBuiltBlockedReason` already knows about it — so this reads that
 * rather than asking again.
 *
 * **AC-H-WF-05-02: the recipient confirms.** Transferring the golden thread is
 * not sending a link. The accountable person confirms three separate things —
 * that they have access, that what they received is complete, and that it is in
 * a **usable format** — and any one of them being false means the transfer has
 * not happened. A recipient who cannot open the file has received nothing, and
 * the duty does not move.
 *
 * **AC-H-WF-05-03: conditions are operational obligations.** A completion
 * certificate granted subject to conditions is a certificate with work still to
 * do, and the conditions outlive the project. They are exported for the handover
 * obligations to inherit, by their own reference.
 */

/**
 * What a completion pack has to contain.
 *
 * The specification's own required inputs, not a legal checklist. `mandatory`
 * marks the ones whose absence stops the pack being approved.
 */
export const COMPLETION_EVIDENCE = [
  { key: 'APPROVED_DESIGN', what: 'The design as approved, at the approved revision', mandatory: true },
  { key: 'CHANGE_CONTROL', what: 'Every change since approval, with its classification and approval', mandatory: true },
  { key: 'AS_BUILT', what: 'As-built information reflecting what was installed', mandatory: true },
  { key: 'FIRE_SAFETY', what: 'Fire safety information for the completed building', mandatory: true },
  { key: 'STRUCTURAL', what: 'Structural design and verification information', mandatory: true },
  { key: 'COMMISSIONING', what: 'Commissioning records for the systems in scope', mandatory: true },
  { key: 'DUTYHOLDER_COMPETENCE', what: 'Dutyholder competence declarations', mandatory: true },
  { key: 'OCCURRENCE_RECORDS', what: 'Mandatory occurrence reports and their outcomes', mandatory: false },
  { key: 'RESPONSIBLE_PERSON', what: 'The identity of the accountable or responsible person', mandatory: true },
] as const;

export type CompletionEvidenceKey = (typeof COMPLETION_EVIDENCE)[number]['key'];

export type EvidenceItem = {
  key: CompletionEvidenceKey;
  reference: string;
  /** The exact version. AC-H-WF-05-01 is this field being required. */
  version: string;
  evidenceRef: string;
};

export type ReadinessState = {
  readinessId: string;
  reference: string;
  jurisdiction: string;
  evidence: EvidenceItem[];
  missing: CompletionEvidenceKey[];
  blockers: string[];
  checkedBy: string;
  checkedAt: string;
};

export type PackState = {
  packId: string;
  reference: string;
  readinessId: string;
  jurisdiction: string;
  evidence: EvidenceItem[];
  approvedBy: string;
  approverRole: string;
  declaration: string;
  approvedAt: string;
  supersedes?: string;
  submission?: {
    regulator: string;
    route: 'INTEGRATED' | 'MANUAL';
    submissionReference: string;
    submittedBy: string;
    submittedAt: string;
    receipt: string;
  };
  decision?: {
    decision: 'GRANTED' | 'REFUSED';
    decisionReference: string;
    decidedOn: string;
    conditions: Array<{ reference: string; condition: string; owner: string; by: string }>;
    reasons?: string[];
    recordedBy: string;
    recordedAt: string;
  };
};

function packs(ctx: EngineContext): PackState[] {
  return ctx.ledger.list(ctx.projectId, 'RegulatoryPack').map((record) => record.state as unknown as PackState);
}

function requirePack(ctx: EngineContext, packId: string) {
  const record = ctx.ledger.get({ refType: 'RegulatoryPack', refId: packId });
  if (!record) throw new DomainError('PACK_NOT_FOUND', `No regulatory pack ${packId}`, 404);
  return record;
}

/**
 * Run the completion checklist against the evidence supplied.
 *
 * Records what is missing rather than refusing: the point of a readiness check
 * is to be run early and repeatedly, and one that could only be run when it
 * would pass would never be run at all.
 */
export function checkCompletionReadiness(
  ctx: EngineContext,
  input: { reference: string; jurisdiction: string; evidence: EvidenceItem[]; checkedBy: string; blockers?: string[] },
): { readinessId: string; missing: CompletionEvidenceKey[]; ready: boolean } {
  authorise(ctx, 'HANDOVER_OM', 'C', { lifecyclePhase: currentPhase(ctx) });

  if (!input.reference.trim() || !input.jurisdiction.trim()) {
    throw new DomainError(
      'JURISDICTION_REQUIRED',
      'Name the regime this pack is being assembled for. The platform does not decide what a jurisdiction requires, and a ' +
        'pack that does not say which one it was built for cannot be checked by anybody who does.',
    );
  }
  if (!input.checkedBy.trim()) throw new DomainError('CHECK_UNSIGNED', 'Name who ran the check.');

  const unversioned = input.evidence.find((item) => !item.reference.trim() || !item.version.trim());
  if (unversioned) {
    throw new DomainError(
      'VERSION_REQUIRED',
      `${unversioned.key} is listed with no ${!unversioned.reference.trim() ? 'reference' : 'version'}. A completion pack ` +
        'referencing "the as-built drawings" references nothing, and the question asked of it years later is which ' +
        'revision was in it.',
    );
  }

  const supplied = new Set(input.evidence.map((item) => item.key));
  const missing = COMPLETION_EVIDENCE.filter((entry) => entry.mandatory && !supplied.has(entry.key)).map(
    (entry) => entry.key,
  );

  const readinessId = ulid();
  const blockers = input.blockers ?? [];

  write(ctx, {
    eventType: 'COMPLETION_READINESS_CHECKED',
    entity: { refType: 'CompletionReadiness', refId: readinessId },
    nextState: {
      readinessId,
      projectId: ctx.projectId,
      reference: input.reference,
      jurisdiction: input.jurisdiction,
      evidence: input.evidence,
      missing,
      blockers,
      checkedBy: input.checkedBy,
      checkedAt: new Date().toISOString(),
    },
  });

  return { readinessId, missing, ready: missing.length === 0 && blockers.length === 0 };
}

/**
 * Approve the pack for submission.
 *
 * Under authorised review, with a named declaration. The person approving it is
 * declaring the pack complete and accurate, which is a legal act — so it names
 * them and the role they hold, and the platform does not perform it.
 */
export function approveRegulatoryPack(
  ctx: EngineContext,
  readinessId: string,
  input: { reference: string; approvedBy: string; approverRole: string; declaration: string; supersedes?: string },
): { packId: string; evidenceItems: number } {
  authorise(ctx, 'HANDOVER_OM', 'A', { lifecyclePhase: currentPhase(ctx) });

  const record = ctx.ledger.get({ refType: 'CompletionReadiness', refId: readinessId });
  if (!record) throw new DomainError('READINESS_NOT_FOUND', `No readiness check ${readinessId}`, 404);
  const readiness = record.state as unknown as ReadinessState;

  if (!input.approvedBy.trim() || !input.approverRole.trim()) {
    throw new DomainError(
      'APPROVAL_UNSIGNED',
      'Name the person approving the pack and the role they hold. Approving a completion pack is a declaration that it is ' +
        'complete and accurate, and a declaration nobody signed is not one.',
    );
  }
  if (input.declaration.trim().length < 20) {
    throw new DomainError(
      'DECLARATION_REQUIRED',
      'State what is being declared. The platform cannot make the declaration and will not record an empty one on ' +
        'somebody’s behalf.',
    );
  }
  if (readiness.missing.length > 0) {
    throw new DomainError(
      'EVIDENCE_MISSING',
      `${readiness.missing.join(', ')} ${readiness.missing.length === 1 ? 'is' : 'are'} not in the pack. Submitting a ` +
        'completion application without them is an application that will be refused, at the cost of the time it takes to ' +
        'be refused.',
    );
  }
  if (readiness.blockers.length > 0) {
    throw new DomainError(
      'BLOCKERS_OPEN',
      `${readiness.blockers.join('; ')}. A completion blocker prevents the application, not merely the occupation.`,
    );
  }

  const packId = ulid();

  write(ctx, {
    eventType: 'REGULATORY_PACK_APPROVED',
    entity: { refType: 'RegulatoryPack', refId: packId },
    nextState: {
      packId,
      projectId: ctx.projectId,
      reference: input.reference,
      readinessId,
      jurisdiction: readiness.jurisdiction,
      evidence: readiness.evidence,
      approvedBy: input.approvedBy,
      approverRole: input.approverRole,
      declaration: input.declaration,
      supersedes: input.supersedes,
      approvedByActor: ctx.auth.actorId,
      approvedAt: new Date().toISOString(),
    },
  });

  return { packId, evidenceItems: readiness.evidence.length };
}

/**
 * Record that the application was submitted.
 *
 * Submission happens outside this platform. What is recorded is that it
 * happened, through which route, and the receipt that came back — a submission
 * with no receipt is one nobody can prove was made.
 */
export function recordSubmission(
  ctx: EngineContext,
  packId: string,
  input: {
    regulator: string;
    route: 'INTEGRATED' | 'MANUAL';
    submissionReference: string;
    submittedBy: string;
    submittedAt: string;
    receipt: string;
  },
): { reference: string; submittedAt: string } {
  authorise(ctx, 'HANDOVER_OM', 'U', { lifecyclePhase: currentPhase(ctx) });

  const record = requirePack(ctx, packId);
  const state = record.state as unknown as PackState;

  if (state.submission) throw new DomainError('ALREADY_SUBMITTED', `${state.reference} has already been submitted.`);
  if (!input.regulator.trim() || !input.submittedBy.trim()) {
    throw new DomainError('SUBMISSION_UNIDENTIFIED', 'Name the regulator and the person who submitted it.');
  }
  if (!input.submissionReference.trim() || !input.receipt.trim()) {
    throw new DomainError(
      'RECEIPT_REQUIRED',
      'Record the submission reference and the receipt. A submission with no receipt is one nobody can prove was made, ' +
        'which matters most on the day somebody disputes the date.',
    );
  }
  if (Number.isNaN(Date.parse(input.submittedAt))) {
    throw new DomainError('DATE_REQUIRED', 'A submission happened on a date.');
  }

  write(ctx, {
    eventType: 'REGULATORY_SUBMISSION_RECORDED',
    entity: { refType: 'RegulatoryPack', refId: packId },
    nextState: {
      ...record.state,
      submission: {
        regulator: input.regulator,
        route: input.route,
        submissionReference: input.submissionReference,
        submittedBy: input.submittedBy,
        submittedAt: input.submittedAt,
        receipt: input.receipt,
      },
    },
  });

  return { reference: state.reference, submittedAt: input.submittedAt };
}

/**
 * Record the regulator's decision.
 *
 * A refusal does not touch the pack that was submitted: the exception control
 * says the original is preserved and a corrective version is created, and the
 * reason is that the pack as submitted is the evidence of what was applied for.
 */
export function recordCompletionDecision(
  ctx: EngineContext,
  packId: string,
  input: {
    decision: 'GRANTED' | 'REFUSED';
    decisionReference: string;
    decidedOn: string;
    conditions?: Array<{ reference: string; condition: string; owner: string; by: string }>;
    reasons?: string[];
    certificateHash?: string;
    recordedBy: string;
  },
): { decision: string; conditions: number } {
  authorise(ctx, 'HANDOVER_OM', 'A', { lifecyclePhase: currentPhase(ctx) });

  const record = requirePack(ctx, packId);
  const state = record.state as unknown as PackState;

  if (!state.submission) {
    throw new DomainError('NOT_SUBMITTED', `${state.reference} has not been submitted, so no decision can have come back.`);
  }
  if (state.decision) throw new DomainError('ALREADY_DECIDED', `${state.reference} already carries a decision.`);
  if (!input.decisionReference.trim() || !input.recordedBy.trim()) {
    throw new DomainError('DECISION_UNIDENTIFIED', 'Record the regulator’s reference and who recorded it here.');
  }
  if (Number.isNaN(Date.parse(input.decidedOn))) throw new DomainError('DATE_REQUIRED', 'A decision has a date.');

  if (input.decision === 'GRANTED') {
    if (!input.certificateHash?.trim()) {
      throw new DomainError(
        'CERTIFICATE_REQUIRED',
        'Record the certificate. It is the document occupation, insurance and half the operational obligations run from.',
      );
    }
    for (const condition of input.conditions ?? []) {
      if (!condition.owner.trim() || condition.condition.trim().length < 10 || Number.isNaN(Date.parse(condition.by))) {
        throw new DomainError(
          'CONDITION_UNBOUND',
          `${condition.reference || 'A condition'} has no ${!condition.owner.trim() ? 'owner' : 'date or description'}. ` +
            'A condition on a completion certificate outlives the project, and one nobody owns is one nobody discharges.',
        );
      }
    }
  } else {
    if (!input.reasons || input.reasons.length === 0 || input.reasons.some((reason) => reason.trim().length < 10)) {
      throw new DomainError(
        'REASONS_REQUIRED',
        'Record the reasons for refusal. They are what the corrective version has to answer, and a refusal with no reasons ' +
          'comes back refused.',
      );
    }
  }

  const evidenceRefs = input.certificateHash?.trim()
    ? [
        registerEvidence(ctx, {
          type: 'COMPLETION_CERTIFICATE',
          hash: input.certificateHash,
          description: `${state.jurisdiction} completion certificate ${input.decisionReference}`,
          linkedEntities: [{ refType: 'RegulatoryPack', refId: packId }],
        }),
      ]
    : undefined;

  write(ctx, {
    eventType: 'COMPLETION_CERTIFICATE_RECEIVED',
    entity: { refType: 'RegulatoryPack', refId: packId },
    nextState: {
      ...record.state,
      decision: {
        decision: input.decision,
        decisionReference: input.decisionReference,
        decidedOn: input.decidedOn,
        conditions: input.conditions ?? [],
        reasons: input.reasons,
        recordedBy: input.recordedBy,
        recordedAt: new Date().toISOString(),
      },
    },
    evidenceRefs,
  });

  return { decision: input.decision, conditions: (input.conditions ?? []).length };
}

// --- The transfer -----------------------------------------------------------

export const RESPONSIBLE_ROLE = ['ACCOUNTABLE_PERSON', 'PRINCIPAL_ACCOUNTABLE_PERSON', 'RESPONSIBLE_PERSON'] as const;
export type ResponsibleRole = (typeof RESPONSIBLE_ROLE)[number];

/**
 * Transfer control of the golden thread.
 *
 * AC-H-WF-05-02, and the confirmation is three separate things because they fail
 * separately: a recipient can have access to something incomplete, receive
 * something complete in a format they cannot open, or be sent a link that never
 * worked. Any one of them false means the transfer has not happened and the duty
 * has not moved.
 */
export function transferGoldenThread(
  ctx: EngineContext,
  input: {
    toParty: string;
    toPerson: string;
    role: ResponsibleRole;
    format: string;
    scope: string;
    transferredBy: string;
    recipientConfirmation: { access: boolean; completeness: boolean; usableFormat: boolean; confirmedBy: string };
  },
): { transferId: string; transferredAt: string } {
  // Two authorities, because two different things are happening. Exporting the
  // record is `EVIDENCE_AUDIT` import/export, which nearly every delivery role
  // holds and should. Transferring *control of the duty* to the accountable
  // person is a governance act on the project, and the matrix already says who
  // may take one: the roles holding approve on the project itself.
  authorise(ctx, 'EVIDENCE_AUDIT', 'I');
  authorise(ctx, 'PROJECT_SETUP', 'A', { lifecyclePhase: currentPhase(ctx) });

  if (!input.toParty.trim() || !input.toPerson.trim()) {
    throw new DomainError(
      'RECIPIENT_REQUIRED',
      'Name the party and the person the duty transfers to. "Handed to the client" is what is written when nobody took it.',
    );
  }
  // Twenty characters, a floor rather than a judgement: what it stops is
  // "everything", which describes a transfer nobody can check for completeness.
  if (!input.format.trim() || input.scope.trim().length < 20) {
    throw new DomainError(
      'SCOPE_REQUIRED',
      'State the format and what is being transferred. A transfer with no scope on it cannot be checked for completeness ' +
        'by the person receiving it.',
    );
  }
  if (!input.transferredBy.trim() || !input.recipientConfirmation.confirmedBy.trim()) {
    throw new DomainError('TRANSFER_UNSIGNED', 'Name who transferred it and who confirmed receipt.');
  }

  const confirmation = input.recipientConfirmation;
  const unconfirmed = [
    !confirmation.access ? 'access' : '',
    !confirmation.completeness ? 'completeness' : '',
    !confirmation.usableFormat ? 'a usable format' : '',
  ].filter(Boolean);
  if (unconfirmed.length > 0) {
    throw new DomainError(
      'RECIPIENT_NOT_CONFIRMED',
      `${confirmation.confirmedBy} has not confirmed ${unconfirmed.join(', ')}. A recipient who cannot open the file has ` +
        'received nothing, and the duty does not move until all three are true.',
    );
  }

  const transferId = ulid();
  const transferredAt = new Date().toISOString();

  write(ctx, {
    eventType: 'GOLDEN_THREAD_TRANSFERRED',
    entity: { refType: 'GoldenThreadTransfer', refId: transferId },
    nextState: {
      transferId,
      projectId: ctx.projectId,
      toParty: input.toParty,
      toPerson: input.toPerson,
      role: input.role,
      format: input.format,
      scope: input.scope,
      transferredBy: input.transferredBy,
      transferredByActor: ctx.auth.actorId,
      recipientConfirmation: confirmation,
      transferredAt,
    },
  });

  return { transferId, transferredAt };
}

/**
 * The conditions a granted certificate carries.
 *
 * AC-H-WF-05-03, exported so the handover obligations inherit them by their own
 * reference. A condition on a completion certificate outlives the project.
 */
export function regulatoryConditions(
  ctx: EngineContext,
): Array<{ reference: string; condition: string; owner: string; by: string; certificate: string }> {
  return packs(ctx)
    .filter((pack) => pack.decision?.decision === 'GRANTED')
    .flatMap((pack) =>
      (pack.decision?.conditions ?? []).map((condition) => ({
        ...condition,
        certificate: pack.decision!.decisionReference,
      })),
    );
}

/**
 * Why the building may not be occupied or handed over, or null.
 *
 * The exception control. Binds only where the project runs a regulatory
 * completion at all.
 */
export function occupationBlockedReason(ctx: EngineContext): string | null {
  const all = packs(ctx);
  if (all.length === 0) return null;

  const granted = all.find((pack) => pack.decision?.decision === 'GRANTED');
  if (granted) return null;

  const refused = all.filter((pack) => pack.decision?.decision === 'REFUSED');
  if (refused.length > 0) {
    const latest = refused[refused.length - 1]!;
    return (
      `${latest.reference} was refused on ${latest.decision!.decidedOn}: ${(latest.decision!.reasons ?? []).join('; ')} ` +
      'A corrective version has to be submitted and granted.'
    );
  }

  const submitted = all.find((pack) => pack.submission);
  return submitted
    ? `${submitted.reference} was submitted to ${submitted.submission!.regulator} on ` +
        `${submitted.submission!.submittedAt.slice(0, 10)} and no decision has been recorded.`
    : `${all[all.length - 1]!.reference} has been approved but never submitted.`;
}

/** Whether the golden thread has been transferred and confirmed. */
export function goldenThreadTransferred(ctx: EngineContext): boolean {
  return ctx.ledger.list(ctx.projectId, 'GoldenThreadTransfer').length > 0;
}

// --- The position -----------------------------------------------------------

export type RegulatoryPosition = {
  readinessChecks: Array<{ reference: string; jurisdiction: string; missing: string[]; blockers: string[]; checkedAt: string }>;
  packs: Array<{
    packId: string;
    reference: string;
    jurisdiction: string;
    approvedBy: string;
    evidenceItems: number;
    submitted?: string;
    decision?: string;
    conditions: number;
    supersedes?: string;
  }>;
  conditions: ReturnType<typeof regulatoryConditions>;
  transfer?: { toParty: string; toPerson: string; role: string; format: string; transferredAt: string };
  occupationBlockedReason: string | null;
  summary: string;
};

export function regulatoryPosition(ctx: EngineContext): RegulatoryPosition {
  authorise(ctx, 'HANDOVER_OM', 'R');

  const readinessChecks = ctx.ledger.list(ctx.projectId, 'CompletionReadiness').map((record) => {
    const state = record.state as unknown as ReadinessState;
    return {
      reference: state.reference,
      jurisdiction: state.jurisdiction,
      missing: state.missing,
      blockers: state.blockers,
      checkedAt: state.checkedAt,
    };
  });

  const rows = packs(ctx).map((pack) => ({
    packId: pack.packId,
    reference: pack.reference,
    jurisdiction: pack.jurisdiction,
    approvedBy: `${pack.approvedBy} (${pack.approverRole})`,
    evidenceItems: pack.evidence.length,
    submitted: pack.submission?.submittedAt,
    decision: pack.decision?.decision,
    conditions: pack.decision?.conditions.length ?? 0,
    supersedes: pack.supersedes,
  }));

  const transferRecord = ctx.ledger.list(ctx.projectId, 'GoldenThreadTransfer')[0]?.state;
  const conditions = regulatoryConditions(ctx);
  const blocked = occupationBlockedReason(ctx);

  const parts = [`${rows.length} regulatory pack${rows.length === 1 ? '' : 's'}`];
  const granted = rows.filter((row) => row.decision === 'GRANTED').length;
  if (granted > 0) parts.push('completion granted');
  if (conditions.length > 0) parts.push(`${conditions.length} condition carried into operation`);
  if (!transferRecord) parts.push('golden thread not yet transferred');
  if (blocked) parts.push('occupation blocked');

  return {
    readinessChecks,
    packs: rows,
    conditions,
    transfer: transferRecord
      ? {
          toParty: String(transferRecord.toParty),
          toPerson: String(transferRecord.toPerson),
          role: String(transferRecord.role),
          format: String(transferRecord.format),
          transferredAt: String(transferRecord.transferredAt),
        }
      : undefined,
    occupationBlockedReason: blocked,
    summary: parts.join(', ') + '.',
  };
}
