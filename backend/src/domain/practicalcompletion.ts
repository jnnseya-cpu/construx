import { hashState } from '../core/canonical.ts';
import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, registerEvidence, write, type EngineContext } from '../engines/context.ts';

/**
 * H-WF-08 — defects, practical/sectional completion and commercial closeout.
 *
 * **What already exists and is not rebuilt.** `engines/handover.raiseDefect`
 * raises a defect against an asset and finds the warranty that covers it;
 * `engines/handover.raiseSnag` and `dispatchSnags` run the snag list;
 * `engines/quality.closeSnag` closes one with evidence. `domain/valuechain`
 * already holds the five commercial values — SUBMITTED, ASSESSED, CERTIFIED,
 * AGREED, PAID — separately, which is the whole of the exception control that
 * says a final account states them separately, so it is read here rather than
 * duplicated. `domain/valuechain.deriveDeadline` already derives a date from a
 * named rule source and records the inputs it was computed from; the contract
 * dates a certificate triggers are derived deadlines and use it.
 *
 * What this adds is what none of those answer: the inspection that classifies
 * what is outstanding, the certificate itself, the dates it sets running, the
 * closure of a defect against accepted rectification, and the commercial
 * reconciliation that must not hold up a safety-critical closure.
 *
 * **The exception control the clause register exposed.** "Certificate trigger
 * dates derive from a *validated* project-specific contract pack." Every clause
 * the extraction engine writes carries `requiresLegalReview: true`, and until
 * this workflow there was nothing in the platform that could ever clear it —
 * so a certificate could have derived a defects-liability period from a machine
 * reading of a contract nobody had checked. `validateContractClause` is the act
 * that clears it, and the certificate refuses to derive a date from a category
 * still awaiting review.
 *
 * **AC-H-WF-08-02: recalculated once, and protected from silent edit.** The
 * dates are derived at the moment the certificate is issued and frozen under a
 * hash of the set. There is no path that edits one. A change is a *revision*
 * that names the authority and the reason, keeps the superseded set, and says
 * what moved — because the difference between "the defects period ends on the
 * 14th" and "it ended on the 14th until somebody changed it" is the difference
 * between a record and a draft.
 *
 * **Commercial closeout never blocks safety-critical closure.** Step 6 says so
 * explicitly, and it is the one rule here that is enforced by omission:
 * `completionBlockedReason` reads defects and inspections and does not read the
 * final account at all. A retention argument is not a reason to leave a
 * building uncertified.
 */

// --- What a completion inspection finds -------------------------------------

/**
 * The four things an inspector can find, and they are not severities.
 *
 * The classification decides what happens next, not how bad it looks: a blocker
 * stops the certificate, a minor defect goes on the list, outstanding work is
 * agreed as incomplete, and a post-completion obligation is somebody's job after
 * the building is handed over. Calling all four "snags" is how outstanding work
 * ends up being argued about a year later.
 */
export const ITEM_CLASSIFICATION = ['BLOCKER', 'MINOR_DEFECT', 'OUTSTANDING_WORK', 'POST_COMPLETION_OBLIGATION'] as const;
export type ItemClassification = (typeof ITEM_CLASSIFICATION)[number];

export type InspectionItem = {
  itemId: string;
  location: string;
  description: string;
  classification: ItemClassification;
  /** Who is to put it right. An item with no contractor is a note. */
  contractor: string;
  dueDate: string;
  /** When they can get at it. The commonest reason a defect is still open. */
  accessWindow: string;
  status: 'OPEN' | 'CLOSED' | 'DEFERRED';
  closure?: { rectification: string; acceptedBy: string; reinspectedBy: string; acceptedAt: string };
  deferral?: {
    reason: string;
    owner: string;
    by: string;
    risk: string;
    accessConstraint: string;
    acceptanceCondition: string;
    deferredAt: string;
  };
};

type InspectionState = {
  inspectionId: string;
  reference: string;
  scope: string;
  inspectedBy: string;
  attendees: string[];
  items: InspectionItem[];
  inspectedAt: string;
};

function inspections(ctx: EngineContext): InspectionState[] {
  return ctx.ledger
    .list(ctx.projectId, 'CompletionInspection')
    .map((record) => record.state as unknown as InspectionState);
}

/** Every inspection item on the project, flattened, with the inspection it came from. */
function allItems(ctx: EngineContext): Array<InspectionItem & { inspectionId: string; inspectionRef: string }> {
  return inspections(ctx).flatMap((inspection) =>
    inspection.items.map((item) => ({ ...item, inspectionId: inspection.inspectionId, inspectionRef: inspection.reference })),
  );
}

function requireInspectionFor(ctx: EngineContext, itemId: string) {
  for (const record of ctx.ledger.list(ctx.projectId, 'CompletionInspection')) {
    const state = record.state as unknown as InspectionState;
    const item = state.items.find((entry) => entry.itemId === itemId);
    if (item) return { record, state, item };
  }
  throw new DomainError('ITEM_NOT_FOUND', `No completion inspection item ${itemId}`, 404);
}

/**
 * Record a completion inspection and classify everything it found.
 *
 * Steps 1 and 2 together, because they are one act on site: an item classified
 * with nobody to fix it and no date is the list that gets re-walked in a month.
 */
export function recordCompletionInspection(
  ctx: EngineContext,
  input: {
    reference: string;
    scope: string;
    inspectedBy: string;
    attendees: string[];
    evidenceHash: string;
    items: Array<{
      location: string;
      description: string;
      classification: ItemClassification;
      contractor: string;
      dueDate: string;
      accessWindow: string;
    }>;
  },
): { inspectionId: string; blockers: number; recorded: number } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'C', { lifecyclePhase: currentPhase(ctx) });

  if (!input.reference.trim() || input.scope.trim().length < 20) {
    throw new DomainError(
      'SCOPE_REQUIRED',
      'State what was inspected. An inspection whose scope is "the building" cannot be read later as evidence that any ' +
        'particular part of it was looked at.',
    );
  }
  if (!input.inspectedBy.trim()) throw new DomainError('INSPECTOR_REQUIRED', 'Name who carried out the inspection.');
  if (input.attendees.length === 0) {
    throw new DomainError(
      'ATTENDEES_REQUIRED',
      'Record who attended. A completion inspection the contractor was not at is one they will dispute.',
    );
  }
  if (input.items.length === 0) {
    throw new DomainError(
      'ITEMS_REQUIRED',
      'Record what was found, including a clean inspection — an inspection with no items recorded is indistinguishable ' +
        'from one nobody wrote up.',
    );
  }

  for (const item of input.items) {
    if (item.description.trim().length < 20) {
      throw new DomainError(
        'ITEM_UNDESCRIBED',
        `"${item.description}" does not say what is wrong. The contractor reads this to price and programme the fix.`,
      );
    }
    if (!item.location.trim()) throw new DomainError('ITEM_UNLOCATED', `Say where "${item.description}" is.`);
    if (!item.contractor.trim()) {
      throw new DomainError(
        'CONTRACTOR_REQUIRED',
        `Nobody is named to put right "${item.description}". An item with no contractor is the one still open at the end ` +
          'of the defects period.',
      );
    }
    if (Number.isNaN(Date.parse(item.dueDate))) {
      throw new DomainError('DUE_DATE_REQUIRED', `"${item.description}" has no date it is to be put right by.`);
    }
    if (!item.accessWindow.trim()) {
      throw new DomainError(
        'ACCESS_REQUIRED',
        `Say when the contractor can get at "${item.description}". Access is the commonest reason a defect is still open, ` +
          'and an occupied building is not available on demand.',
      );
    }
  }

  const evidence = registerEvidence(ctx, {
    type: 'COMPLETION_INSPECTION',
    hash: input.evidenceHash,
    description: `${input.reference} — completion inspection of ${input.scope.slice(0, 60)}`,
  });

  const inspectionId = ulid();
  const items: InspectionItem[] = input.items.map((item) => ({
    itemId: ulid(),
    location: item.location,
    description: item.description,
    classification: item.classification,
    contractor: item.contractor,
    dueDate: item.dueDate.slice(0, 10),
    accessWindow: item.accessWindow,
    status: 'OPEN',
  }));

  write(ctx, {
    eventType: 'COMPLETION_INSPECTION_COMPLETED',
    entity: { refType: 'CompletionInspection', refId: inspectionId },
    nextState: {
      inspectionId,
      projectId: ctx.projectId,
      reference: input.reference,
      scope: input.scope,
      inspectedBy: input.inspectedBy,
      attendees: input.attendees,
      items,
      inspectedAt: new Date().toISOString(),
    },
    evidenceRefs: [evidence],
  });

  return {
    inspectionId,
    blockers: items.filter((item) => item.classification === 'BLOCKER').length,
    recorded: items.length,
  };
}

/**
 * Close an item against rectification somebody accepted.
 *
 * AC-H-WF-08-03. The person who did the work is not the person who accepts it:
 * a defect closed by the contractor who caused it is a defect nobody checked.
 */
export function closeInspectionItem(
  ctx: EngineContext,
  itemId: string,
  input: { rectification: string; acceptedBy: string; reinspectedBy: string; evidenceHash: string },
): { classification: ItemClassification; remainingOpen: number } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'A', { lifecyclePhase: currentPhase(ctx) });

  const { record, state, item } = requireInspectionFor(ctx, itemId);

  if (item.status === 'CLOSED') throw new DomainError('ALREADY_CLOSED', `${item.description} is already closed.`);
  if (input.rectification.trim().length < 20) {
    throw new DomainError(
      'RECTIFICATION_UNDESCRIBED',
      'Say what was actually done. "Rectified" records that somebody pressed a button, not that anything was put right.',
    );
  }
  if (!input.acceptedBy.trim() || !input.reinspectedBy.trim()) {
    throw new DomainError('CLOSURE_UNSIGNED', 'Name who re-inspected it and who accepted it.');
  }
  if (input.reinspectedBy === item.contractor) {
    throw new DomainError(
      'SELF_VERIFIED',
      `${item.contractor} carried out the work and cannot be the one who re-inspects it. A defect signed off by whoever ` +
        'caused it is a defect nobody checked.',
    );
  }
  if (!input.evidenceHash.trim()) {
    throw new DomainError(
      'RECTIFICATION_EVIDENCE_REQUIRED',
      'Attach the evidence the rectification was accepted on. Every closed item has to be able to show it.',
    );
  }

  const evidence = registerEvidence(ctx, {
    type: 'RECTIFICATION_EVIDENCE',
    hash: input.evidenceHash,
    description: `Rectification of ${item.description.slice(0, 60)} at ${item.location}`,
    linkedEntities: [{ refType: 'CompletionInspection', refId: state.inspectionId }],
  });

  const items = state.items.map((entry) =>
    entry.itemId === itemId
      ? {
          ...entry,
          status: 'CLOSED' as const,
          closure: {
            rectification: input.rectification,
            acceptedBy: input.acceptedBy,
            reinspectedBy: input.reinspectedBy,
            acceptedAt: new Date().toISOString(),
          },
        }
      : entry,
  );

  write(ctx, {
    eventType: 'DEFECT_CLOSED',
    entity: { refType: 'CompletionInspection', refId: state.inspectionId },
    nextState: { ...record.state, items },
    evidenceRefs: [evidence],
  });

  return {
    classification: item.classification,
    remainingOpen: allItems(ctx).filter((entry) => entry.status === 'OPEN').length,
  };
}

/**
 * Defer an item, with everything a deferral has to carry.
 *
 * The exception control: "Deferred defect has owner, risk, access and acceptance
 * condition." All four, because a deferral without them is a defect that has
 * been moved off the list rather than dealt with — and the acceptance condition
 * is the one people leave out, which is what makes it arguable later whether it
 * was ever going to be put right at all.
 */
export function deferInspectionItem(
  ctx: EngineContext,
  itemId: string,
  input: { reason: string; owner: string; by: string; risk: string; accessConstraint: string; acceptanceCondition: string },
): { classification: ItemClassification } {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'A', { lifecyclePhase: currentPhase(ctx) });

  const { record, state, item } = requireInspectionFor(ctx, itemId);

  if (item.status !== 'OPEN') throw new DomainError('NOT_OPEN', `${item.description} is not open.`);
  if (item.classification === 'BLOCKER') {
    throw new DomainError(
      'BLOCKER_NOT_DEFERRABLE',
      `${item.description} was classified a blocker. Deferring it is reclassifying it, and that is a decision about ` +
        'whether the building can be handed over — not a scheduling change.',
    );
  }
  if (input.reason.trim().length < 20 || input.risk.trim().length < 20) {
    throw new DomainError(
      'DEFERRAL_UNJUSTIFIED',
      'State why it is deferred and what the risk of leaving it is. A deferral with neither is an item moved off the list.',
    );
  }
  if (!input.owner.trim() || Number.isNaN(Date.parse(input.by))) {
    throw new DomainError('DEFERRAL_UNOWNED', 'A deferred item carries an owner and the date it is to be done by.');
  }
  if (!input.accessConstraint.trim()) {
    throw new DomainError('ACCESS_REQUIRED', 'Say what the access constraint is — it is usually the reason for the deferral.');
  }
  if (input.acceptanceCondition.trim().length < 20) {
    throw new DomainError(
      'ACCEPTANCE_CONDITION_REQUIRED',
      'State what will count as it being put right. This is the part people leave out, and without it there is nothing to ' +
        'settle the argument about whether it ever was.',
    );
  }

  const items = state.items.map((entry) =>
    entry.itemId === itemId
      ? { ...entry, status: 'DEFERRED' as const, deferral: { ...input, deferredAt: new Date().toISOString() } }
      : entry,
  );

  write(ctx, {
    eventType: 'DEFECT_DEFERRED',
    entity: { refType: 'CompletionInspection', refId: state.inspectionId },
    nextState: { ...record.state, items },
  });

  return { classification: item.classification };
}

// --- The contract pack a certificate is allowed to read ----------------------

type ClauseState = { id: string; contractId: string; category: string; clauseRef: string; requiresLegalReview: boolean };

function clauses(ctx: EngineContext): ClauseState[] {
  return ctx.ledger.list(ctx.projectId, 'ContractClause').map((record) => record.state as unknown as ClauseState);
}

/**
 * The categories a completion certificate sets dates from.
 *
 * Only these are required to be validated, rather than the whole pack. A
 * certificate does not depend on the termination clause, and refusing to issue
 * one until somebody has reviewed a clause it never reads would be a control
 * that gets worked around.
 */
const DATE_BEARING_CATEGORIES = ['DEFECTS_LIABILITY', 'RETENTION', 'INSURANCE', 'LIQUIDATED_DAMAGES'] as const;

/**
 * A person agrees, or disagrees, with what the extraction engine read.
 *
 * Nothing in the platform could clear `requiresLegalReview` before this. The
 * clause register is written by a model reading a contract, every entry says so,
 * and a certificate that derived a defects-liability period from an unreviewed
 * machine reading would be the exact failure the flag exists to prevent.
 */
export function validateContractClause(
  ctx: EngineContext,
  clauseId: string,
  input: { agrees: boolean; correctedClauseRef?: string; periodDays?: number; note: string; validatedBy: string },
): { category: string; clauseRef: string; validated: boolean } {
  authorise(ctx, 'CONTRACTS_CLAIMS', 'A', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'LEGAL_L4' });

  const record = ctx.ledger.get({ refType: 'ContractClause', refId: clauseId });
  if (!record) throw new DomainError('CLAUSE_NOT_FOUND', `No contract clause ${clauseId}`, 404);
  const state = record.state as unknown as ClauseState;

  if (input.note.trim().length < 10) {
    throw new DomainError('REVIEW_NOTE_REQUIRED', 'Record what the reviewer checked. A validation with no note is a tick.');
  }
  if (!input.validatedBy.trim()) throw new DomainError('REVIEW_UNSIGNED', 'Name who reviewed it.');
  if (!input.agrees && !input.correctedClauseRef?.trim()) {
    throw new DomainError(
      'CORRECTION_REQUIRED',
      'Disagreeing with the extraction means saying what the clause actually is. A rejection that leaves nothing in its ' +
        'place puts the pack back where it started.',
    );
  }
  if (input.periodDays !== undefined && !(input.periodDays > 0)) {
    throw new DomainError('PERIOD_REQUIRED', 'A period of zero days is not a period.');
  }

  write(ctx, {
    eventType: 'CONTRACT_CLAUSE_VALIDATED',
    entity: { refType: 'ContractClause', refId: clauseId },
    nextState: {
      ...record.state,
      requiresLegalReview: false,
      clauseRef: input.correctedClauseRef?.trim() || state.clauseRef,
      periodDays: input.periodDays,
      validation: {
        agrees: input.agrees,
        note: input.note,
        validatedBy: input.validatedBy,
        validatedAt: new Date().toISOString(),
        // Kept whether or not it was corrected: what the machine read is part of
        // the record of how the date was arrived at.
        extractedClauseRef: state.clauseRef,
      },
    },
  });

  return { category: state.category, clauseRef: input.correctedClauseRef?.trim() || state.clauseRef, validated: true };
}

/** Which date-bearing categories a certificate could read, and which it could not. */
export function contractPackValidation(ctx: EngineContext): {
  validated: string[];
  awaitingReview: string[];
  absent: string[];
  usable: boolean;
} {
  const registered = clauses(ctx);
  const validated: string[] = [];
  const awaitingReview: string[] = [];
  const absent: string[] = [];

  for (const category of DATE_BEARING_CATEGORIES) {
    const matches = registered.filter((clause) => clause.category === category);
    if (matches.length === 0) absent.push(category);
    else if (matches.every((clause) => clause.requiresLegalReview === false)) validated.push(category);
    else awaitingReview.push(category);
  }

  return { validated, awaitingReview, absent, usable: awaitingReview.length === 0 && absent.length === 0 };
}

// --- The certificate ---------------------------------------------------------

export const COMPLETION_KIND = ['PRACTICAL', 'SECTIONAL'] as const;
export type CompletionKind = (typeof COMPLETION_KIND)[number];

/** The dates a certificate sets running, and what each one is counted from. */
export const TRIGGERED_DATE = [
  { key: 'POSSESSION', label: 'Possession passes to the client', category: 'INSURANCE' },
  { key: 'INSURANCE_TRANSFER', label: 'Insurance responsibility transfers', category: 'INSURANCE' },
  { key: 'LIQUIDATED_DAMAGES_END', label: 'Liquidated damages stop running', category: 'LIQUIDATED_DAMAGES' },
  { key: 'DEFECTS_PERIOD_END', label: 'Defects liability period ends', category: 'DEFECTS_LIABILITY' },
  { key: 'RETENTION_FIRST_RELEASE', label: 'First half of retention falls due', category: 'RETENTION' },
  { key: 'RETENTION_FINAL_RELEASE', label: 'Balance of retention falls due', category: 'RETENTION' },
] as const;
export type TriggeredDateKey = (typeof TRIGGERED_DATE)[number]['key'];

export type TriggeredDate = { key: TriggeredDateKey; label: string; date: string; periodDays: number; ruleSource: string };

type CompletionState = {
  completionId: string;
  reference: string;
  kind: CompletionKind;
  sectionReference?: string;
  scopeBoundary: string;
  completionDate: string;
  authority: string;
  decidedBy: string;
  /** Recorded, and never the decision. */
  aiReadinessScore?: { score: number; basis: string };
  triggeredDates: TriggeredDate[];
  /** Hash over the frozen set. A silent edit changes it. */
  datesHash: string;
  revisions: Array<{ authority: string; reason: string; moved: string[]; revisedAt: string; previousHash: string }>;
  issuedAt: string;
};

function completions(ctx: EngineContext): CompletionState[] {
  return ctx.ledger.list(ctx.projectId, 'CompletionRecord').map((record) => record.state as unknown as CompletionState);
}

function addDays(from: string, days: number): string {
  return new Date(Date.parse(from) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Issue a practical or sectional completion certificate and set its dates running.
 *
 * AC-H-WF-08-01: the record shows the authority, the scope boundary, the date
 * and the evidence — all four are required, and none of them is derivable.
 *
 * Step 3 says the determination is made "through authorised contract role" and
 * that the AI readiness score is advisory. Both are honoured literally: the
 * authority is `CONTRACTS_CLAIMS 'A'`, which the project director, commercial
 * manager, owner and QS hold and the project manager does not; and a readiness
 * score may be recorded alongside the decision but cannot be supplied in place
 * of one.
 */
export function issueCompletionCertificate(
  ctx: EngineContext,
  input: {
    reference: string;
    kind: CompletionKind;
    sectionReference?: string;
    scopeBoundary: string;
    completionDate: string;
    /** The contractual role determining it — the clause and the person. */
    authority: string;
    decidedBy: string;
    evidenceHash: string;
    aiReadinessScore?: { score: number; basis: string };
    periods: Array<{ key: TriggeredDateKey; periodDays: number; ruleSource: string }>;
  },
): { completionId: string; triggeredDates: TriggeredDate[]; datesHash: string } {
  authorise(ctx, 'CONTRACTS_CLAIMS', 'A', { lifecyclePhase: currentPhase(ctx) });

  if (!input.reference.trim() || !input.authority.trim() || !input.decidedBy.trim()) {
    throw new DomainError(
      'AUTHORITY_REQUIRED',
      'A completion certificate names the contractual authority determining it and the person exercising it. AC-H-WF-08-01 ' +
        'asks for the authority, and "the system issued it" is not one.',
    );
  }
  if (input.scopeBoundary.trim().length < 20) {
    throw new DomainError(
      'SCOPE_BOUNDARY_REQUIRED',
      'State the scope boundary — what is complete and, for a sectional certificate, what is expressly not. This is the ' +
        'sentence the damages argument turns on.',
    );
  }
  if (input.kind === 'SECTIONAL' && !input.sectionReference?.trim()) {
    throw new DomainError('SECTION_REQUIRED', 'A sectional completion names the section it certifies.');
  }
  if (Number.isNaN(Date.parse(input.completionDate))) {
    throw new DomainError('COMPLETION_DATE_REQUIRED', 'A certificate carries the date completion was achieved.');
  }
  if (!input.evidenceHash.trim()) {
    throw new DomainError('CERTIFICATE_EVIDENCE_REQUIRED', 'Attach the certificate. AC-H-WF-08-01 asks for the evidence.');
  }

  if (completions(ctx).some((record) => record.reference === input.reference)) {
    throw new DomainError('REFERENCE_TAKEN', `${input.reference} has already been issued.`);
  }

  // Step 3, read literally. A score is a reading of the evidence; a
  // determination is an act by somebody who carries the consequence.
  if (input.aiReadinessScore && input.aiReadinessScore.basis.trim().length < 20) {
    throw new DomainError(
      'ADVISORY_BASIS_REQUIRED',
      'A readiness score recorded without its basis reads as a verdict. It is advisory, and what it was computed from is ' +
        'the part that lets a person disagree with it.',
    );
  }

  const blockers = allItems(ctx).filter((item) => item.classification === 'BLOCKER' && item.status === 'OPEN');
  if (blockers.length > 0) {
    throw new DomainError(
      'BLOCKERS_OPEN',
      `${blockers.map((item) => `${item.description} at ${item.location}`).join('; ')} — classified as blocking completion ` +
        'and still open.',
    );
  }

  // The exception control. Dates come from a pack a person has read.
  const pack = contractPackValidation(ctx);
  if (!pack.usable) {
    const problems = [
      pack.awaitingReview.length > 0 ? `${pack.awaitingReview.join(', ')} still awaiting legal review` : '',
      pack.absent.length > 0 ? `no clause registered for ${pack.absent.join(', ')}` : '',
    ].filter(Boolean);
    throw new DomainError(
      'CONTRACT_PACK_UNVALIDATED',
      `Trigger dates derive from the project's contract pack, and ${problems.join('; ')}. The clause register is written ` +
        'by a model reading the contract; a defects-liability period nobody has checked is not a date to start a liability ' +
        'running from.',
    );
  }

  const supplied = new Map(input.periods.map((period) => [period.key, period]));
  const missing = TRIGGERED_DATE.filter((entry) => !supplied.has(entry.key));
  if (missing.length > 0) {
    throw new DomainError(
      'PERIODS_REQUIRED',
      `No period given for ${missing.map((entry) => entry.label.toLowerCase()).join(', ')}. A certificate that sets some ` +
        'of its dates and leaves the rest undefined is the one nobody can answer questions about.',
    );
  }
  for (const period of input.periods) {
    if (!(period.periodDays >= 0)) throw new DomainError('PERIOD_REQUIRED', `${period.key} has no period.`);
    if (period.ruleSource.trim().length < 3) {
      throw new DomainError(
        'RULE_SOURCE_REQUIRED',
        `${period.key} has no rule source. A contract administrator challenged on a date answers with a clause.`,
      );
    }
  }

  const triggeredDates: TriggeredDate[] = TRIGGERED_DATE.map((entry) => {
    const period = supplied.get(entry.key)!;
    return {
      key: entry.key,
      label: entry.label,
      date: addDays(input.completionDate, period.periodDays),
      periodDays: period.periodDays,
      ruleSource: period.ruleSource,
    };
  });

  const datesHash = hashState(triggeredDates);
  const completionId = ulid();

  const evidence = registerEvidence(ctx, {
    type: 'COMPLETION_CERTIFICATE',
    hash: input.evidenceHash,
    description: `${input.reference} — ${input.kind.toLowerCase()} completion, ${input.completionDate.slice(0, 10)}`,
  });

  write(ctx, {
    eventType: 'PRACTICAL_COMPLETION_RECORDED',
    entity: { refType: 'CompletionRecord', refId: completionId },
    nextState: {
      completionId,
      projectId: ctx.projectId,
      reference: input.reference,
      kind: input.kind,
      sectionReference: input.sectionReference,
      scopeBoundary: input.scopeBoundary,
      completionDate: input.completionDate.slice(0, 10),
      authority: input.authority,
      decidedBy: input.decidedBy,
      aiReadinessScore: input.aiReadinessScore,
      triggeredDates,
      datesHash,
      revisions: [],
      issuedAt: new Date().toISOString(),
      issuedBy: ctx.auth.actorId,
    },
    evidenceRefs: [evidence],
  });

  // A separate event because it is a separate fact with its own audience. The
  // certificate concerns the contract; the defects period concerns whoever now
  // has to run the building and report faults against it.
  const defectsEnd = triggeredDates.find((entry) => entry.key === 'DEFECTS_PERIOD_END')!;
  const after = ctx.ledger.get({ refType: 'CompletionRecord', refId: completionId })!;
  write(ctx, {
    eventType: 'DEFECTS_PERIOD_STARTED',
    entity: { refType: 'CompletionRecord', refId: completionId },
    nextState: {
      ...after.state,
      defectsPeriod: {
        from: input.completionDate.slice(0, 10),
        to: defectsEnd.date,
        ruleSource: defectsEnd.ruleSource,
      },
    },
  });

  return { completionId, triggeredDates, datesHash };
}

/**
 * Revise a triggered date set, visibly.
 *
 * AC-H-WF-08-02's second half. There is no path that edits a date in place: a
 * change names the authority and the reason, records which dates moved, and
 * keeps the hash of the set it replaced. The difference between "the defects
 * period ends on the 14th" and "it ended on the 14th until somebody changed it"
 * is the difference between a record and a draft.
 */
export function reviseTriggeredDates(
  ctx: EngineContext,
  completionId: string,
  input: { authority: string; reason: string; periods: Array<{ key: TriggeredDateKey; periodDays: number; ruleSource: string }> },
): { moved: string[]; datesHash: string } {
  authorise(ctx, 'CONTRACTS_CLAIMS', 'A', { lifecyclePhase: currentPhase(ctx) });

  const record = ctx.ledger.get({ refType: 'CompletionRecord', refId: completionId });
  if (!record) throw new DomainError('COMPLETION_NOT_FOUND', `No completion record ${completionId}`, 404);
  const state = record.state as unknown as CompletionState;

  if (!input.authority.trim() || input.reason.trim().length < 20) {
    throw new DomainError(
      'REVISION_UNJUSTIFIED',
      'A triggered date is only moved under a named authority and a stated reason. These dates run liabilities; a silent ' +
        'correction to one is indistinguishable from a party moving its own deadline.',
    );
  }
  if (input.periods.length === 0) throw new DomainError('PERIODS_REQUIRED', 'Say which dates move.');

  const supplied = new Map(input.periods.map((period) => [period.key, period]));
  const revised: TriggeredDate[] = state.triggeredDates.map((existing) => {
    const period = supplied.get(existing.key);
    if (!period) return existing;
    return {
      ...existing,
      date: addDays(state.completionDate, period.periodDays),
      periodDays: period.periodDays,
      ruleSource: period.ruleSource,
    };
  });

  const moved = revised
    .filter((entry, index) => entry.date !== state.triggeredDates[index]!.date)
    .map((entry) => `${entry.label}: ${state.triggeredDates.find((old) => old.key === entry.key)!.date} → ${entry.date}`);

  if (moved.length === 0) {
    throw new DomainError(
      'NOTHING_MOVED',
      'The periods supplied produce the dates already recorded. A revision that changes nothing should not be in the ' +
        'record as though something happened.',
    );
  }

  write(ctx, {
    eventType: 'CONTRACT_DATES_REVISED',
    entity: { refType: 'CompletionRecord', refId: completionId },
    nextState: {
      ...record.state,
      triggeredDates: revised,
      datesHash: hashState(revised),
      revisions: [
        ...state.revisions,
        {
          authority: input.authority,
          reason: input.reason,
          moved,
          revisedAt: new Date().toISOString(),
          previousHash: state.datesHash,
        },
      ],
    },
  });

  return { moved, datesHash: hashState(revised) };
}

// --- Commercial closeout -----------------------------------------------------

export const SECURITY_KIND = ['RETENTION', 'PERFORMANCE_BOND', 'PARENT_COMPANY_GUARANTEE', 'COLLATERAL_WARRANTY', 'INSURANCE_CERTIFICATE'] as const;
export type SecurityKind = (typeof SECURITY_KIND)[number];

/**
 * Record where a security stands at closeout.
 *
 * Deliberately does not carry a value. The money lives in `domain/valuechain`,
 * which already states submitted, assessed, certified, agreed and paid
 * separately; putting an amount here as well would create a second figure for
 * the same thing, and the two would disagree within a month.
 */
export function recordSecurityPosition(
  ctx: EngineContext,
  input: { kind: SecurityKind; reference: string; holder: string; status: string; expiresOn?: string; note: string },
): { securityId: string } {
  authorise(ctx, 'CONTRACTS_CLAIMS', 'C', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  if (!input.reference.trim() || !input.holder.trim()) {
    throw new DomainError('SECURITY_UNIDENTIFIED', 'A security carries a reference and says who holds it.');
  }
  if (!input.status.trim()) throw new DomainError('STATUS_REQUIRED', 'Say where it stands.');
  if (input.expiresOn !== undefined && Number.isNaN(Date.parse(input.expiresOn))) {
    throw new DomainError('EXPIRY_INVALID', 'An expiry date that cannot be parsed is worse than none.');
  }

  const securityId = ulid();

  write(ctx, {
    eventType: 'SECURITY_POSITION_RECORDED',
    entity: { refType: 'CommercialSecurity', refId: securityId },
    nextState: {
      securityId,
      projectId: ctx.projectId,
      ...input,
      expiresOn: input.expiresOn?.slice(0, 10),
      recordedBy: ctx.auth.actorId,
      recordedAt: new Date().toISOString(),
    },
  });

  return { securityId };
}

/**
 * Agree the final account.
 *
 * The money is not recorded here. `domain/valuechain` already holds it under the
 * five stages, so this reads that chain and refuses to record agreement that the
 * commercial record does not show — which is the exception control ("final
 * account states submitted/assessed/agreed/paid separately") enforced rather
 * than restated.
 */
export function agreeFinalAccount(
  ctx: EngineContext,
  input: { subjectRef: string; agreedBy: string; forContractor: string; note: string },
): { subjectRef: string; agreedMinor: number; outstandingMinor: number } {
  authorise(ctx, 'CONTRACTS_CLAIMS', 'A', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const chain = ctx.ledger.list(ctx.projectId, 'ValueChain').find((record) => record.state.subjectRef === input.subjectRef);
  if (!chain) {
    throw new DomainError(
      'NO_VALUE_CHAIN',
      `Nothing has been valued against ${input.subjectRef}. A final account is agreed against the figures that were ` +
        'submitted and assessed, not declared on its own.',
    );
  }

  const values = (chain.state.values ?? []) as Array<{ stage: string; amountMinor: number }>;
  const at = (stage: string) => values.find((entry) => entry.stage === stage);

  const submitted = at('SUBMITTED');
  const assessed = at('ASSESSED');
  const agreed = at('AGREED');
  if (!submitted || !assessed) {
    throw new DomainError(
      'ACCOUNT_NOT_ASSESSED',
      `${input.subjectRef} has not been ${submitted ? 'assessed' : 'submitted'}. The states are recorded separately on ` +
        'purpose, and agreement is the one that cannot be reached first.',
    );
  }
  if (!agreed) {
    throw new DomainError(
      'AGREEMENT_NOT_RECORDED',
      `No agreed figure has been recorded against ${input.subjectRef}. Record it through the value chain — this is the ` +
        'contractual act that reads it, not a second place to enter the number.',
    );
  }
  if (!input.agreedBy.trim() || !input.forContractor.trim()) {
    throw new DomainError('PARTIES_REQUIRED', 'A final account is agreed between two named parties.');
  }
  if (input.note.trim().length < 20) {
    throw new DomainError('BASIS_REQUIRED', 'Record what was settled and on what basis.');
  }

  const paid = at('PAID');
  const outstandingMinor = agreed.amountMinor - (paid?.amountMinor ?? 0);

  write(ctx, {
    eventType: 'FINAL_ACCOUNT_AGREED',
    entity: { refType: 'FinalAccount', refId: ulid() },
    nextState: {
      projectId: ctx.projectId,
      subjectRef: input.subjectRef,
      submittedMinor: submitted.amountMinor,
      assessedMinor: assessed.amountMinor,
      agreedMinor: agreed.amountMinor,
      paidMinor: paid?.amountMinor,
      outstandingMinor,
      agreedBy: input.agreedBy,
      forContractor: input.forContractor,
      note: input.note,
      agreedAt: new Date().toISOString(),
    },
  });

  return { subjectRef: input.subjectRef, agreedMinor: agreed.amountMinor, outstandingMinor };
}

// --- What blocks the certificate --------------------------------------------

/**
 * Why completion cannot be certified, or null.
 *
 * Reads defects and the contract pack. It does **not** read the final account,
 * the retention position or any security, and that omission is the rule: step 6
 * says the commercial reconciliation happens "without delaying safety-critical
 * closure". A retention argument is not a reason to leave a building
 * uncertified, and a blocked-reason function that mentioned one would make it
 * into one.
 *
 * Binds only where the project runs completion inspections at all.
 */
export function completionBlockedReason(ctx: EngineContext): string | null {
  const items = allItems(ctx);
  if (items.length === 0) return null;

  const blockers = items.filter((item) => item.classification === 'BLOCKER' && item.status === 'OPEN');
  if (blockers.length > 0) {
    return `${blockers.map((item) => `${item.description} at ${item.location}`).join('; ')} — open and classified as blocking completion.`;
  }

  const pack = contractPackValidation(ctx);
  if (!pack.usable) {
    const awaiting = pack.awaitingReview.length > 0 ? `${pack.awaitingReview.join(', ')} awaiting legal review` : '';
    const absent = pack.absent.length > 0 ? `no clause registered for ${pack.absent.join(', ')}` : '';
    return `The contract pack cannot set trigger dates: ${[awaiting, absent].filter(Boolean).join('; ')}.`;
  }

  return null;
}

// --- The position -----------------------------------------------------------

export type PracticalCompletionPosition = {
  inspections: Array<{ reference: string; scope: string; inspectedBy: string; items: number; blockers: number }>;
  items: Array<{
    itemId: string;
    location: string;
    description: string;
    classification: ItemClassification;
    contractor: string;
    dueDate: string;
    status: string;
    overdue: boolean;
  }>;
  openByClassification: Record<string, number>;
  deferred: Array<{ description: string; owner: string; by: string; risk: string; acceptanceCondition: string }>;
  certificates: Array<{
    reference: string;
    kind: CompletionKind;
    sectionReference?: string;
    completionDate: string;
    authority: string;
    decidedBy: string;
    triggeredDates: TriggeredDate[];
    datesHash: string;
    revisions: number;
    /** Recorded alongside the decision, never as it. */
    advisoryReadiness?: { score: number; basis: string };
  }>;
  contractPack: { validated: string[]; awaitingReview: string[]; absent: string[]; usable: boolean };
  securities: Array<{ kind: SecurityKind; reference: string; holder: string; status: string; expiresOn?: string }>;
  finalAccounts: Array<{ subjectRef: string; agreedMinor: number; outstandingMinor: number; agreedBy: string }>;
  blockedReason: string | null;
  summary: string;
};

export function practicalCompletionPosition(
  ctx: EngineContext,
  today = new Date().toISOString().slice(0, 10),
): PracticalCompletionPosition {
  authorise(ctx, 'QUALITY_COMMISSIONING', 'R');

  const items = allItems(ctx);
  const openByClassification: Record<string, number> = {};
  for (const classification of ITEM_CLASSIFICATION) {
    openByClassification[classification] = items.filter(
      (item) => item.classification === classification && item.status === 'OPEN',
    ).length;
  }

  const certificates = completions(ctx).map((record) => ({
    reference: record.reference,
    kind: record.kind,
    sectionReference: record.sectionReference,
    completionDate: record.completionDate,
    authority: record.authority,
    decidedBy: record.decidedBy,
    triggeredDates: record.triggeredDates,
    datesHash: record.datesHash,
    revisions: record.revisions.length,
    advisoryReadiness: record.aiReadinessScore,
  }));

  const securities = ctx.ledger.list(ctx.projectId, 'CommercialSecurity').map((record) => ({
    kind: record.state.kind as SecurityKind,
    reference: String(record.state.reference),
    holder: String(record.state.holder),
    status: String(record.state.status),
    expiresOn: record.state.expiresOn === undefined ? undefined : String(record.state.expiresOn),
  }));

  const finalAccounts = ctx.ledger.list(ctx.projectId, 'FinalAccount').map((record) => ({
    subjectRef: String(record.state.subjectRef),
    agreedMinor: Number(record.state.agreedMinor),
    outstandingMinor: Number(record.state.outstandingMinor),
    agreedBy: String(record.state.agreedBy),
  }));

  const open = items.filter((item) => item.status === 'OPEN').length;
  const parts = [`${items.length} inspection item${items.length === 1 ? '' : 's'}`, `${open} open`];
  if (certificates.length > 0) parts.push(`${certificates.length} certificate${certificates.length === 1 ? '' : 's'} issued`);
  if (finalAccounts.length > 0) parts.push(`${finalAccounts.length} final account agreed`);

  return {
    inspections: inspections(ctx).map((inspection) => ({
      reference: inspection.reference,
      scope: inspection.scope,
      inspectedBy: inspection.inspectedBy,
      items: inspection.items.length,
      blockers: inspection.items.filter((item) => item.classification === 'BLOCKER').length,
    })),
    items: items.map((item) => ({
      itemId: item.itemId,
      location: item.location,
      description: item.description,
      classification: item.classification,
      contractor: item.contractor,
      dueDate: item.dueDate,
      status: item.status,
      overdue: item.status === 'OPEN' && item.dueDate < today,
    })),
    openByClassification,
    deferred: items
      .filter((item) => item.deferral)
      .map((item) => ({
        description: item.description,
        owner: item.deferral!.owner,
        by: item.deferral!.by,
        risk: item.deferral!.risk,
        acceptanceCondition: item.deferral!.acceptanceCondition,
      })),
    certificates,
    contractPack: contractPackValidation(ctx),
    securities,
    finalAccounts,
    blockedReason: completionBlockedReason(ctx),
    summary: parts.join(', ') + '.',
  };
}
