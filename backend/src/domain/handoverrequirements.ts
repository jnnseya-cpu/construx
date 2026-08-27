import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, write, type EngineContext } from '../engines/context.ts';
import { rolesAllow } from '../identity/roles.ts';

/**
 * H-WF-01 — handover strategy and the requirements matrix.
 *
 * The spine of the handover stage. Everything else in stage 11 reports into
 * this: the as-built verification, the O&M, the asset register, the regulatory
 * pack and the training all exist to satisfy requirements that live here, and
 * readiness is the arithmetic over them.
 *
 * **No requirement is closed by a file upload.** AC-H-WF-01-03, and it is the
 * rule the whole workflow turns on. The commonest failure of a handover matrix
 * is that it becomes a document-collection exercise: somebody attaches a PDF,
 * the row goes green, and nobody has read it. So each requirement carries an
 * **evidence rule** saying what would actually satisfy it, and acceptance is an
 * act by the **named acceptance party** rather than the presence of an
 * attachment. A reference to a document is an input to that decision, never a
 * substitute for it.
 *
 * **Readiness is derived, never stored.** The specification lists a
 * `READINESS_UPDATED` event; this platform does not register one, because a
 * stored readiness percentage is the number nobody updates after the requirement
 * it was computed from moved. Readiness is recomputed on every read from the
 * weighted mandatory requirements and their blockers, and AC-H-WF-01-02 —
 * drilling from the figure to the unmet requirement and its source — is a
 * property of computing it that way rather than a feature bolted on.
 *
 * **A statutory requirement is not waivable by ordinary project authority.** The
 * exception control, and it is absolute here: no role in the matrix can waive
 * one, because the authority that could is not a project authority at all. An
 * ordinary requirement can be waived by whoever governs the project, with a
 * reason and an expiry.
 *
 * **A changed source version triggers a delta review.** Contract and information
 * requirements are reissued during a project, and a matrix built against
 * revision 2 of the employer's information requirements is a matrix satisfying
 * obligations somebody has since changed. The affected requirements are flagged
 * rather than silently re-pointed: what changed is a question for a person.
 */

export const REQUIREMENT_STATUS = [
  'NOT_STARTED',
  'DRAFT',
  'SUBMITTED',
  'REJECTED',
  'ACCEPTED_WITH_CONDITIONS',
  'ACCEPTED',
] as const;
export type RequirementStatus = (typeof REQUIREMENT_STATUS)[number];

/** What the requirement waits on before it can be satisfied. */
export const REQUIREMENT_DEPENDENCY = [
  'PHYSICAL_COMPLETION',
  'TEST',
  'AS_BUILT',
  'MANUAL',
  'ASSET_DATA',
  'WARRANTY',
  'TRAINING',
  'STATUTORY',
  'TRANSFER',
] as const;
export type RequirementDependency = (typeof REQUIREMENT_DEPENDENCY)[number];

export type RequirementState = {
  requirementId: string;
  reference: string;
  /** The contract, EIR or regulation it comes from, and the clause within it. */
  source: string;
  sourceVersion: string;
  sourceClause: string;
  description: string;
  acceptanceCriteria: string;
  /** What would actually satisfy it. Never "a document is attached". */
  evidenceRule: string;
  systemTag?: string;
  area?: string;
  assetTag?: string;
  dependency: RequirementDependency;
  mandatory: boolean;
  /** Statutory requirements cannot be waived by any project authority. */
  statutory: boolean;
  weight: number;
  assignment?: { producer: string; checker: string; approver: string; requiredBy: string };
  acceptanceParty: string;
  status: RequirementStatus;
  submission?: { evidence: string; submittedBy: string; submittedAt: string };
  decision?: {
    decision: 'ACCEPTED' | 'ACCEPTED_WITH_CONDITIONS' | 'REJECTED';
    acceptedBy: string;
    forParty: string;
    reason: string;
    conditions?: string;
    decidedAt: string;
  };
  waiver?: { reason: string; approvedBy: string; expiresOn: string; approvedAt: string };
  deltaReview?: { fromVersion: string; toVersion: string; raisedAt: string };
  baselined: boolean;
};

function requirements(ctx: EngineContext): RequirementState[] {
  return ctx.ledger
    .list(ctx.projectId, 'HandoverRequirement')
    .map((record) => record.state as unknown as RequirementState);
}

function requireRequirement(ctx: EngineContext, requirementId: string) {
  const record = ctx.ledger.get({ refType: 'HandoverRequirement', refId: requirementId });
  if (!record) throw new DomainError('REQUIREMENT_NOT_FOUND', `No handover requirement ${requirementId}`, 404);
  return record;
}

/** Record one handover obligation as a requirement. */
export function createRequirement(
  ctx: EngineContext,
  input: {
    reference: string;
    source: string;
    sourceVersion: string;
    sourceClause: string;
    description: string;
    acceptanceCriteria: string;
    evidenceRule: string;
    acceptanceParty: string;
    dependency: RequirementDependency;
    mandatory: boolean;
    statutory: boolean;
    weight: number;
    systemTag?: string;
    area?: string;
    assetTag?: string;
  },
): { requirementId: string; reference: string } {
  authorise(ctx, 'HANDOVER_OM', 'C', { lifecyclePhase: currentPhase(ctx) });

  if (!input.reference.trim()) throw new DomainError('REQUIREMENT_UNREFERENCED', 'A requirement carries a reference.');
  if (requirements(ctx).some((entry) => entry.reference === input.reference)) {
    throw new DomainError('REFERENCE_TAKEN', `${input.reference} is already in the matrix.`);
  }
  if (!input.source.trim() || !input.sourceVersion.trim() || !input.sourceClause.trim()) {
    throw new DomainError(
      'SOURCE_REQUIRED',
      'Name the document, its version and the clause the obligation comes from. A requirement with no source is one ' +
        'nobody can check the platform did not invent, and the version is what makes a reissue detectable.',
    );
  }
  if (input.acceptanceCriteria.trim().length < 15) {
    throw new DomainError(
      'CRITERIA_REQUIRED',
      'Say what satisfying this requirement looks like. Without it the acceptance decision is a matter of taste.',
    );
  }
  if (input.evidenceRule.trim().length < 15) {
    throw new DomainError(
      'EVIDENCE_RULE_REQUIRED',
      'State what would actually satisfy this — the witnessed act, the verified record, the confirmed transfer. A handover ' +
        'matrix with no evidence rules becomes a document-collection exercise, where somebody attaches a PDF, the row goes ' +
        'green and nobody has read it.',
    );
  }
  if (!input.acceptanceParty.trim()) {
    throw new DomainError(
      'ACCEPTANCE_PARTY_REQUIRED',
      'Name the party that accepts it. A requirement everybody can close is one nobody owns.',
    );
  }
  if (input.weight <= 0) {
    throw new DomainError('WEIGHT_REQUIRED', 'A requirement carries a weight, which is what readiness is computed over.');
  }

  const requirementId = ulid();

  write(ctx, {
    eventType: 'HANDOVER_REQUIREMENT_CREATED',
    entity: { refType: 'HandoverRequirement', refId: requirementId },
    nextState: {
      requirementId,
      projectId: ctx.projectId,
      ...input,
      status: 'NOT_STARTED',
      baselined: false,
      createdBy: ctx.auth.actorId,
      createdAt: new Date().toISOString(),
    },
  });

  return { requirementId, reference: input.reference };
}

/** Map the deliverable to a producer, a checker, an approver and a date. */
export function assignDeliverable(
  ctx: EngineContext,
  requirementId: string,
  input: { producer: string; checker: string; approver: string; requiredBy: string },
): { reference: string } {
  authorise(ctx, 'HANDOVER_OM', 'U', { lifecyclePhase: currentPhase(ctx) });

  const record = requireRequirement(ctx, requirementId);
  const state = record.state as unknown as RequirementState;

  const missing = (['producer', 'checker', 'approver'] as const).filter((field) => !input[field].trim());
  if (missing.length > 0) {
    throw new DomainError(
      'ASSIGNMENT_INCOMPLETE',
      `No ${missing.join(', no ')} named. A deliverable produced, checked and approved by the same person has been checked ` +
        'by nobody.',
    );
  }
  if (input.producer === input.checker || input.checker === input.approver) {
    throw new DomainError(
      'SEPARATION_BREACHED',
      'The producer, the checker and the approver are three roles precisely so that one person cannot be all of them.',
    );
  }
  if (Number.isNaN(Date.parse(input.requiredBy))) {
    throw new DomainError('DATE_REQUIRED', 'A deliverable is required by a date. One with none is never late.');
  }

  write(ctx, {
    eventType: 'DELIVERABLE_ASSIGNED',
    entity: { refType: 'HandoverRequirement', refId: requirementId },
    nextState: { ...record.state, assignment: input, status: state.status === 'NOT_STARTED' ? 'DRAFT' : state.status },
  });

  return { reference: state.reference };
}

/** Baseline the matrix. After this a requirement is added by delta, not quietly. */
export function baselineMatrix(ctx: EngineContext, input: { baselinedBy: string }): { requirements: number } {
  authorise(ctx, 'HANDOVER_OM', 'A', { lifecyclePhase: currentPhase(ctx) });

  const all = requirements(ctx);
  if (all.length === 0) throw new DomainError('MATRIX_EMPTY', 'Nothing has been recorded, so there is no matrix.');
  if (!input.baselinedBy.trim()) throw new DomainError('BASELINE_UNSIGNED', 'Name who baselined it.');

  const unassigned = all.filter((entry) => !entry.assignment).map((entry) => entry.reference);
  if (unassigned.length > 0) {
    throw new DomainError(
      'DELIVERABLES_UNASSIGNED',
      `${unassigned.join(', ')} ${unassigned.length === 1 ? 'has' : 'have'} no producer, checker, approver or date. A ` +
        'baselined matrix full of unassigned rows is a list of things somebody hopes will happen.',
    );
  }

  const baselinedAt = new Date().toISOString();
  for (const entry of all) {
    if (entry.baselined) continue;
    const record = requireRequirement(ctx, entry.requirementId);
    write(ctx, {
      eventType: 'HANDOVER_MATRIX_BASELINED',
      entity: { refType: 'HandoverRequirement', refId: entry.requirementId },
      nextState: { ...record.state, baselined: true, baselinedBy: input.baselinedBy, baselinedAt },
    });
  }

  return { requirements: all.length };
}

/** Submit the deliverable against a requirement. */
export function submitRequirement(
  ctx: EngineContext,
  requirementId: string,
  input: { evidence: string; submittedBy: string },
): { status: RequirementStatus } {
  authorise(ctx, 'HANDOVER_OM', 'U', { lifecyclePhase: currentPhase(ctx) });

  const record = requireRequirement(ctx, requirementId);
  const state = record.state as unknown as RequirementState;

  if (state.status === 'ACCEPTED') {
    throw new DomainError('ALREADY_ACCEPTED', `${state.reference} has been accepted. Resubmitting changes a closed record.`);
  }
  if (!state.assignment) {
    throw new DomainError(
      'NOT_ASSIGNED',
      `${state.reference} has no producer, checker or approver, so there is nobody for the submission to go to.`,
    );
  }
  if (!input.evidence.trim() || !input.submittedBy.trim()) {
    throw new DomainError('SUBMISSION_INCOMPLETE', 'A submission references what is being submitted and who submitted it.');
  }

  write(ctx, {
    eventType: 'HANDOVER_REQUIREMENT_SUBMITTED',
    entity: { refType: 'HandoverRequirement', refId: requirementId },
    nextState: {
      ...record.state,
      status: 'SUBMITTED',
      submission: { evidence: input.evidence, submittedBy: input.submittedBy, submittedAt: new Date().toISOString() },
    },
  });

  return { status: 'SUBMITTED' };
}

/**
 * Decide a submitted requirement.
 *
 * AC-H-WF-01-03 in force: the decision is made by the acceptance party, against
 * the evidence rule, with a reason. A submission is what a decision is made
 * about, never what makes one.
 */
export function decideRequirement(
  ctx: EngineContext,
  requirementId: string,
  input: {
    decision: 'ACCEPTED' | 'ACCEPTED_WITH_CONDITIONS' | 'REJECTED';
    acceptedBy: string;
    forParty: string;
    reason: string;
    conditions?: string;
  },
): { status: RequirementStatus } {
  authorise(ctx, 'HANDOVER_OM', 'A', { lifecyclePhase: currentPhase(ctx) });

  const record = requireRequirement(ctx, requirementId);
  const state = record.state as unknown as RequirementState;

  if (state.status !== 'SUBMITTED') {
    throw new DomainError(
      'NOT_SUBMITTED',
      `${state.reference} is ${state.status.toLowerCase().replace(/_/g, ' ')}. A requirement is decided on what was ` +
        'submitted against it, and nothing has been.',
    );
  }
  if (!input.acceptedBy.trim()) throw new DomainError('DECISION_UNSIGNED', 'Name the person deciding.');
  if (input.forParty !== state.acceptanceParty) {
    throw new DomainError(
      'WRONG_ACCEPTANCE_PARTY',
      `${state.reference} is accepted by ${state.acceptanceParty}, and this decision is recorded for ${input.forParty}. ` +
        'A requirement closed by anybody other than the party that has to live with it is closed by nobody.',
    );
  }
  if (input.reason.trim().length < 15) {
    throw new DomainError(
      'REASON_REQUIRED',
      `Say how ${state.reference} meets its evidence rule — "${state.evidenceRule}" — or why it does not. A row turned ` +
        'green because a document was attached is the failure this rule exists to stop.',
    );
  }
  if (input.decision === 'ACCEPTED_WITH_CONDITIONS' && !input.conditions?.trim()) {
    throw new DomainError('CONDITIONS_REQUIRED', 'An acceptance with conditions states the conditions.');
  }

  write(ctx, {
    eventType: 'HANDOVER_REQUIREMENT_DECIDED',
    entity: { refType: 'HandoverRequirement', refId: requirementId },
    nextState: {
      ...record.state,
      status: input.decision,
      decision: {
        decision: input.decision,
        acceptedBy: input.acceptedBy,
        forParty: input.forParty,
        reason: input.reason,
        conditions: input.conditions,
        decidedAt: new Date().toISOString(),
      },
    },
  });

  return { status: input.decision };
}

/**
 * Waive a requirement.
 *
 * The exception control, and it is absolute for a statutory one: no role in the
 * matrix can waive it, because the authority that could is not a project
 * authority at all.
 */
export function waiveRequirement(
  ctx: EngineContext,
  requirementId: string,
  input: { reason: string; approvedBy: string; expiresOn: string },
): { reference: string } {
  authorise(ctx, 'PROJECT_SETUP', 'A', { lifecyclePhase: currentPhase(ctx) });

  const record = requireRequirement(ctx, requirementId);
  const state = record.state as unknown as RequirementState;

  if (state.statutory) {
    throw new DomainError(
      'STATUTORY_NOT_WAIVABLE',
      `${state.reference} comes from ${state.source} ${state.sourceClause} and is statutory. No project authority can ` +
        'waive it — the authority that could is not a project authority, and recording a waiver here would say otherwise.',
    );
  }
  if (input.reason.trim().length < 15) {
    throw new DomainError('REASON_REQUIRED', 'Say why the requirement is being set aside and what stands in its place.');
  }
  if (!input.approvedBy.trim()) throw new DomainError('WAIVER_UNSIGNED', 'Name who approved it.');
  if (Number.isNaN(Date.parse(input.expiresOn))) {
    throw new DomainError('EXPIRY_REQUIRED', 'A waiver expires on a date. One with none is a deletion.');
  }

  write(ctx, {
    eventType: 'HANDOVER_REQUIREMENT_WAIVED',
    entity: { refType: 'HandoverRequirement', refId: requirementId },
    nextState: {
      ...record.state,
      waiver: {
        reason: input.reason,
        approvedBy: input.approvedBy,
        expiresOn: input.expiresOn,
        approvedAt: new Date().toISOString(),
      },
    },
  });

  return { reference: state.reference };
}

/**
 * A source document has been reissued.
 *
 * Every requirement drawn from the old version is flagged for delta review
 * rather than silently re-pointed: what actually changed is a question for a
 * person, and a matrix that quietly followed a reissue would be satisfying
 * obligations nobody has read.
 */
export function recordSourceReissue(
  ctx: EngineContext,
  input: { source: string; fromVersion: string; toVersion: string; recordedBy: string },
): { flagged: string[] } {
  authorise(ctx, 'HANDOVER_OM', 'U', { lifecyclePhase: currentPhase(ctx) });

  if (!input.source.trim() || !input.toVersion.trim()) {
    throw new DomainError('REISSUE_UNIDENTIFIED', 'Name the document and the version that replaces the old one.');
  }
  if (!input.recordedBy.trim()) throw new DomainError('REISSUE_UNSIGNED', 'Name who recorded it.');

  const flagged: string[] = [];
  const raisedAt = new Date().toISOString();

  for (const state of requirements(ctx)) {
    if (state.source !== input.source || state.sourceVersion !== input.fromVersion) continue;
    const record = requireRequirement(ctx, state.requirementId);
    write(ctx, {
      eventType: 'HANDOVER_REQUIREMENT_DELTA_FLAGGED',
      entity: { refType: 'HandoverRequirement', refId: state.requirementId },
      nextState: {
        ...record.state,
        deltaReview: { fromVersion: input.fromVersion, toVersion: input.toVersion, raisedAt },
      },
    });
    flagged.push(state.reference);
  }

  return { flagged };
}

/**
 * Define a sectional or partial handover.
 *
 * The exception control: a partial handover needs an independent boundary and
 * its own subset of requirements. Handing over a floor against the whole
 * project's matrix means either accepting it against requirements that do not
 * apply, or quietly ignoring the ones that do.
 */
export function defineHandoverSection(
  ctx: EngineContext,
  input: { reference: string; boundary: string; requirementRefs: string[]; definedBy: string },
): { sectionId: string; requirements: number } {
  authorise(ctx, 'HANDOVER_OM', 'A', { lifecyclePhase: currentPhase(ctx) });

  if (!input.reference.trim()) throw new DomainError('SECTION_UNREFERENCED', 'A section carries a reference.');
  if (input.boundary.trim().length < 20) {
    throw new DomainError(
      'BOUNDARY_REQUIRED',
      'Describe the boundary of the section — what is inside it, what is not, and where responsibility changes. A partial ' +
        'handover with no boundary is the whole project handed over one floor at a time.',
    );
  }
  if (input.requirementRefs.length === 0) {
    throw new DomainError(
      'SUBSET_REQUIRED',
      'Name the requirements that apply to this section. Accepting it against the whole matrix means accepting it against ' +
        'requirements that do not apply to it.',
    );
  }
  const known = new Set(requirements(ctx).map((entry) => entry.reference));
  const unknown = input.requirementRefs.filter((reference) => !known.has(reference));
  if (unknown.length > 0) {
    throw new DomainError('REQUIREMENT_NOT_FOUND', `${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not in the matrix.`, 404);
  }
  if (!input.definedBy.trim()) throw new DomainError('SECTION_UNSIGNED', 'Name who defined it.');

  const sectionId = ulid();

  write(ctx, {
    eventType: 'HANDOVER_SECTION_DEFINED',
    entity: { refType: 'HandoverSection', refId: sectionId },
    nextState: {
      sectionId,
      projectId: ctx.projectId,
      reference: input.reference,
      boundary: input.boundary,
      requirementRefs: input.requirementRefs,
      definedBy: input.definedBy,
      definedAt: new Date().toISOString(),
    },
  });

  return { sectionId, requirements: input.requirementRefs.length };
}

// --- Readiness --------------------------------------------------------------

export type UnmetRequirement = {
  reference: string;
  source: string;
  sourceClause: string;
  description: string;
  status: RequirementStatus;
  dependency: RequirementDependency;
  owner: string;
  requiredBy?: string;
  overdue: boolean;
  statutory: boolean;
  /** Why it counts as unmet, in the words a reader needs. */
  why: string;
};

export type HandoverReadiness = {
  /** Weighted over mandatory requirements only. Advisory ones do not inflate it. */
  percent: number;
  weightAccepted: number;
  weightTotal: number;
  /** AC-H-WF-01-02: the figure drills straight to these. */
  unmet: UnmetRequirement[];
  blockers: string[];
  overdue: string[];
  deltaReview: string[];
  liveWaivers: Array<{ reference: string; reason: string; expiresOn: string }>;
  sections: Array<{ reference: string; boundary: string; percent: number; unmet: number }>;
  baselined: boolean;
  summary: string;
};

function unmetOf(state: RequirementState, today: string): UnmetRequirement | undefined {
  const waived = state.waiver && state.waiver.expiresOn.slice(0, 10) >= today;
  if (state.status === 'ACCEPTED' || waived) return undefined;

  const requiredBy = state.assignment?.requiredBy;
  const why =
    state.status === 'ACCEPTED_WITH_CONDITIONS'
      ? `Accepted subject to: ${state.decision?.conditions ?? ''}`
      : state.status === 'REJECTED'
        ? `Rejected: ${state.decision?.reason ?? ''}`
        : state.status === 'SUBMITTED'
          ? `Submitted and awaiting a decision from ${state.acceptanceParty}`
          : `Not yet submitted — ${state.evidenceRule}`;

  return {
    reference: state.reference,
    source: state.source,
    sourceClause: state.sourceClause,
    description: state.description,
    status: state.status,
    dependency: state.dependency,
    owner: state.assignment?.producer ?? '(unassigned)',
    requiredBy,
    overdue: Boolean(requiredBy && requiredBy.slice(0, 10) < today),
    statutory: state.statutory,
    why,
  };
}

/**
 * Readiness, recomputed on every read.
 *
 * `ACCEPTED_WITH_CONDITIONS` counts as unmet rather than met. That is a
 * deliberate reading of the specification's status path: a conditional
 * acceptance is a requirement somebody has agreed to close *later*, and a
 * readiness figure that counted it as done would show a project ready to hand
 * over with its conditions still open.
 */
export function handoverReadiness(
  ctx: EngineContext,
  today = new Date().toISOString().slice(0, 10),
): HandoverReadiness {
  authorise(ctx, 'HANDOVER_OM', 'R');

  const all = requirements(ctx);
  const unmet: UnmetRequirement[] = [];

  let weightAccepted = 0;
  let weightTotal = 0;

  for (const state of all) {
    const entry = unmetOf(state, today);
    if (entry) unmet.push(entry);
    if (!state.mandatory) continue;
    weightTotal += state.weight;
    if (!entry) weightAccepted += state.weight;
  }

  const sections = ctx.ledger.list(ctx.projectId, 'HandoverSection').map((record) => {
    const refs = new Set((record.state.requirementRefs as string[] | undefined) ?? []);
    const mine = all.filter((state) => refs.has(state.reference));
    const mandatory = mine.filter((state) => state.mandatory);
    const met = mandatory.filter((state) => !unmetOf(state, today));
    const total = mandatory.reduce((sum, state) => sum + state.weight, 0);
    const accepted = met.reduce((sum, state) => sum + state.weight, 0);
    return {
      reference: String(record.state.reference),
      boundary: String(record.state.boundary),
      percent: total === 0 ? 0 : Math.round((accepted / total) * 100),
      unmet: mine.filter((state) => unmetOf(state, today)).length,
    };
  });

  const blockers = unmet.filter((entry) => entry.statutory || entry.overdue).map((entry) => entry.reference);
  const percent = weightTotal === 0 ? 0 : Math.round((weightAccepted / weightTotal) * 100);

  const parts = [`${percent}% of the weighted mandatory requirements accepted`];
  if (unmet.length > 0) parts.push(`${unmet.length} unmet`);
  const overdue = unmet.filter((entry) => entry.overdue).map((entry) => entry.reference);
  if (overdue.length > 0) parts.push(`${overdue.length} past the date it was required`);
  const deltaReview = all.filter((state) => state.deltaReview).map((state) => state.reference);
  if (deltaReview.length > 0) parts.push(`${deltaReview.length} awaiting delta review after a source reissue`);

  return {
    percent,
    weightAccepted,
    weightTotal,
    unmet,
    blockers,
    overdue,
    deltaReview,
    liveWaivers: all
      .filter((state) => state.waiver && state.waiver.expiresOn.slice(0, 10) >= today)
      .map((state) => ({
        reference: state.reference,
        reason: state.waiver!.reason,
        expiresOn: state.waiver!.expiresOn,
      })),
    sections,
    baselined: all.length > 0 && all.every((state) => state.baselined),
    summary: parts.join(', ') + '.',
  };
}

/** Whether these roles may decide a handover requirement, for a queue that shows only what a reader can act on. */
export function mayDecideRequirements(ctx: EngineContext): boolean {
  return rolesAllow(ctx.auth.roles, 'HANDOVER_OM', 'A');
}
