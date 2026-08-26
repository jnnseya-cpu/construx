import { hashEvidence } from '../core/canonical.ts';
import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, registerEvidence, write, type EngineContext } from '../engines/context.ts';
import type { EntityRecord } from '../goldenthread/ledger.ts';

/**
 * Reading the tender documents — T-WF-02.
 *
 * Between deciding to bid and pricing it, somebody reads the whole document set.
 * That reading is where the job is won or lost, and it is almost never recorded:
 * the estimator finds the drawing that contradicts the specification, remembers
 * it for a fortnight, and prices around it. Nobody else ever knows.
 *
 * Three things come out of the reading and all three have to survive it.
 *
 * **What is missing.** A specification citing a soil investigation report that
 * is not in the pack is not a note to chase — it is a package that cannot be
 * priced. The register knows which documents inform which packages, so an
 * unreadable or absent document **blocks the packages that depend on it**, by
 * name, rather than producing a warning somebody prices through.
 *
 * **What nobody owns, and what two people own.** A scope matrix maps every
 * obligation onto the packages that carry it. An obligation mapped to nothing is
 * a gap — it will be built and nobody priced it. An obligation mapped to two is
 * an overlap, and it is priced twice, which loses the bid rather than the job.
 *
 * **What the contract actually says.** Every obligation extracted from it links
 * to a clause and a page, and carries a reviewer's status: `AC-T-WF-02-01`. An
 * interpretation nobody signed is somebody's opinion of a contract, and the
 * executed wording is what binds.
 *
 * ---
 *
 * **An exclusion has to come from somewhere.** `AC-T-WF-02-02`: every pricing
 * exclusion and assumption names the scope gap or the contract risk it answers.
 * An exclusion with no source is a sentence the estimator added on the last
 * afternoon, and it is the one the client strikes out.
 *
 * **The edition and the amendments are Critical when they are unclear.** "JCT
 * Design and Build 2016 as amended" with no schedule of amendments in the pack
 * is not a contract form. It is a promise that somebody will send you one, and
 * the amendments are where the liabilities live.
 *
 * **The freeze is what pricing is built on.** After it, an addendum does not
 * edit the review — it produces an impact delta naming what it touched, which is
 * `AC-T-WF-02-03`.
 */

// --- The document register ---------------------------------------------------

export type TenderDocument = {
  reference: string;
  title: string;
  revision: string;
  /** Whether the file the platform holds can actually be read. */
  readable: boolean;
  /** The packages this document is needed to price. */
  informsPackages: string[];
  /** Documents this one cites by reference. */
  cites?: string[];
};

export const FINDING_SEVERITY = ['CRITICAL', 'MAJOR', 'MINOR'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITY)[number];

export type DocumentFinding = {
  severity: FindingSeverity;
  subject: string;
  detail: string;
  /** Packages this finding stops being priced. */
  blocksPackages: string[];
};

/**
 * The contract form, as the tender documents state it.
 *
 * `amendmentsStated` is whether the documents say the standard form has been
 * amended. `amendmentDocument` is the reference of the schedule that says how.
 * Saying the first without supplying the second is the ambiguity the exception
 * control calls Critical, and it is Critical because amendments are where the
 * liabilities live.
 */
export type ContractForm = {
  suite: string;
  edition: string;
  amendmentsStated: boolean;
  amendmentDocument?: string;
};

/**
 * Validate the register: what is missing, what cannot be read, and what the
 * contract form does not say.
 *
 * Pure, so the answer can be shown before anything is recorded — somebody
 * assembling a pack should see what it is short of while they can still ask for
 * it.
 */
export function validateDocuments(documents: TenderDocument[], form: ContractForm): DocumentFinding[] {
  const findings: DocumentFinding[] = [];
  const held = new Set(documents.map((d) => d.reference));

  if (form.amendmentsStated && !form.amendmentDocument) {
    findings.push({
      severity: 'CRITICAL',
      subject: `${form.suite} ${form.edition} is stated as amended, and the amendments are not in the pack`,
      detail:
        'A standard form "as amended" with no schedule of amendments is not a contract form. The amendments are where the ' +
        'liabilities live — the fitness-for-purpose obligation, the uncapped damages, the payment terms — and pricing the ' +
        'standard form prices a different contract.',
      // Everything. There is no package that can be safely priced against an
      // unknown set of amendments.
      blocksPackages: [...new Set(documents.flatMap((d) => d.informsPackages))],
    });
  }
  if (form.amendmentDocument && !held.has(form.amendmentDocument)) {
    findings.push({
      severity: 'CRITICAL',
      subject: `The schedule of amendments ${form.amendmentDocument} is named and not in the register`,
      detail: 'The documents point at it and the pack does not contain it.',
      blocksPackages: [...new Set(documents.flatMap((d) => d.informsPackages))],
    });
  }

  for (const document of documents) {
    if (!document.readable) {
      findings.push({
        severity: 'CRITICAL',
        subject: `${document.reference} cannot be read`,
        detail:
          `${document.title} rev ${document.revision} is in the register and the file cannot be opened. ` +
          'A package priced against a document nobody could read was priced against a guess.',
        blocksPackages: document.informsPackages,
      });
    }

    for (const cited of document.cites ?? []) {
      if (held.has(cited)) continue;
      findings.push({
        severity: 'CRITICAL',
        subject: `${document.reference} cites ${cited}, which is not in the pack`,
        detail:
          `${document.title} relies on ${cited}. Until it arrives, the packages ${document.title} informs are being priced ` +
          'without something the document itself says is needed.',
        blocksPackages: document.informsPackages,
      });
    }
  }

  // The same document at two revisions. Not automatically wrong — a pack often
  // carries a superseded sheet — but it is wrong often enough, and silently
  // enough, to be worth naming.
  const revisions = new Map<string, string[]>();
  for (const document of documents) {
    revisions.set(document.reference, [...(revisions.get(document.reference) ?? []), document.revision]);
  }
  for (const [reference, list] of revisions) {
    if (list.length < 2) continue;
    findings.push({
      severity: 'MAJOR',
      subject: `${reference} appears at ${list.length} revisions`,
      detail: `Revisions ${list.join(', ')} are both in the pack. Which one was priced against is not answerable from the register.`,
      blocksPackages: [],
    });
  }

  return findings;
}

// --- The scope matrix --------------------------------------------------------

export type ScopeItem = {
  reference: string;
  description: string;
  /** Where the obligation comes from. */
  source: { document: string; clause?: string; page?: number };
  /** The packages that carry it. None is a gap; more than one is an overlap. */
  packages: string[];
};

export type ScopeFinding = {
  reference: string;
  kind: 'GAP' | 'OVERLAP';
  description: string;
  packages: string[];
  detail: string;
};

/**
 * Gaps and overlaps, from the mapping.
 *
 * Both are expensive and they are expensive in opposite directions. A gap is
 * built and nobody priced it, which costs the job. An overlap is priced twice,
 * which costs the bid — and losing on price for work you counted twice is the
 * quieter of the two failures because nobody ever finds out why.
 */
export function scopeFindings(items: ScopeItem[]): ScopeFinding[] {
  return items
    .filter((item) => item.packages.length !== 1)
    .map((item) =>
      item.packages.length === 0
        ? {
            reference: item.reference,
            kind: 'GAP' as const,
            description: item.description,
            packages: [],
            detail: 'No package carries this. It will be built and nobody priced it.',
          }
        : {
            reference: item.reference,
            kind: 'OVERLAP' as const,
            description: item.description,
            packages: item.packages,
            detail: `Carried by ${item.packages.join(' and ')}. It is priced twice, which loses the bid rather than the job.`,
          },
    );
}

// --- Contract obligations ----------------------------------------------------

export const REVIEWER_STATUS = ['DRAFT', 'ACCEPTED', 'REJECTED'] as const;
export type ReviewerStatus = (typeof REVIEWER_STATUS)[number];

/**
 * One obligation read out of the contract.
 *
 * `AC-T-WF-02-01` asks every extracted obligation to link to a clause or page
 * *and* carry a reviewer status. Both, because an extraction with a citation
 * nobody checked is still somebody's reading of a contract, and the executed
 * wording is what binds — which is why `wording` holds the clause verbatim
 * beside the interpretation rather than instead of it.
 */
export type ContractObligation = {
  reference: string;
  clause: string;
  page?: number;
  /** The executed wording, carried verbatim. Never replaced by the summary. */
  wording: string;
  /** What it means for this bid, in the reader's words. */
  interpretation: string;
  category: 'PAYMENT' | 'CHANGE' | 'DELAY' | 'INSURANCE' | 'SECURITY' | 'LIABILITY' | 'DEADLINE' | 'OTHER';
  /** How the bid answers it: a price, a programme allowance, or a question. */
  response: 'PRICED' | 'PROGRAMMED' | 'CLARIFICATION' | 'ACCEPTED_RISK';
  owner: string;
  status: ReviewerStatus;
  reviewedBy?: string;
  reviewedAt?: string;
};

// --- Qualifications ----------------------------------------------------------

export type Qualification = {
  reference: string;
  kind: 'EXCLUSION' | 'ASSUMPTION';
  text: string;
  /** `AC-T-WF-02-02`: the scope gap or contract obligation this answers. */
  tracesTo: string;
  recordedBy: string;
  recordedAt: string;
};

// --- The review --------------------------------------------------------------

function requireReview(ctx: EngineContext, reviewId: string): EntityRecord {
  const record = ctx.ledger.get({ refType: 'TenderReview', refId: reviewId });
  if (!record) throw new DomainError('REVIEW_NOT_FOUND', `No tender review ${reviewId}`, 404);
  return record;
}

function assertOpen(record: EntityRecord): void {
  if (record.state.status === 'FROZEN') {
    throw new DomainError(
      'REVIEW_FROZEN',
      'This review is frozen and the pricing is built on it. A change after the freeze comes in as an addendum impact, not as an edit.',
    );
  }
}

export function openReview(
  ctx: EngineContext,
  input: { title: string; form: ContractForm },
): { reviewId: string; reference: string } {
  authorise(ctx, 'ESTIMATE_TENDER', 'C', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  if (!input.form.suite.trim() || !input.form.edition.trim()) {
    throw new DomainError(
      'CONTRACT_FORM_REQUIRED',
      'Name the contract form and its edition. "JCT" is a publisher, not a contract — the edition changes what the clauses say.',
    );
  }

  const sequence = ctx.ledger.list(ctx.projectId, 'TenderReview').length + 1;
  const reference = `TR-${String(sequence).padStart(3, '0')}`;
  const reviewId = ulid();

  write(ctx, {
    eventType: 'TENDER_DOCUMENT_VALIDATED',
    entity: { refType: 'TenderReview', refId: reviewId },
    nextState: {
      id: reviewId,
      projectId: ctx.projectId,
      reference,
      title: input.title,
      form: input.form,
      documents: [],
      findings: [],
      scopeItems: [],
      obligations: [],
      qualifications: [],
      addenda: [],
      status: 'OPEN',
      openedAt: new Date().toISOString(),
      openedBy: ctx.auth.actorId,
    },
  });

  return { reviewId, reference };
}

/**
 * Record the document register and validate it.
 *
 * Replaces rather than appends: a register is the state of a pack at a moment,
 * and half a register is worse than none because the missing-reference check
 * would report every document the second half cites.
 */
export function recordDocuments(
  ctx: EngineContext,
  reviewId: string,
  documents: TenderDocument[],
): { findings: DocumentFinding[]; blockedPackages: string[] } {
  authorise(ctx, 'ESTIMATE_TENDER', 'U', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireReview(ctx, reviewId);
  assertOpen(record);

  if (documents.length === 0) {
    throw new DomainError('DOCUMENTS_REQUIRED', 'A tender with no documents in it has not been received');
  }

  const findings = validateDocuments(documents, record.state.form as ContractForm);
  const blockedPackages = [...new Set(findings.flatMap((f) => f.blocksPackages))].sort();

  write(ctx, {
    eventType: 'TENDER_DOCUMENT_VALIDATED',
    entity: { refType: 'TenderReview', refId: reviewId },
    nextState: { ...record.state, documents, findings, blockedPackages },
  });

  return { findings, blockedPackages };
}

/**
 * Map the scope onto the packages that carry it.
 *
 * Also replaces: a partial matrix reports every unmapped obligation as a gap,
 * and a register full of false gaps is one nobody reads.
 */
export function mapScope(
  ctx: EngineContext,
  reviewId: string,
  items: ScopeItem[],
): { gaps: ScopeFinding[]; overlaps: ScopeFinding[] } {
  authorise(ctx, 'ESTIMATE_TENDER', 'U', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireReview(ctx, reviewId);
  assertOpen(record);

  for (const item of items) {
    if (!item.source?.document?.trim()) {
      throw new DomainError(
        'SCOPE_SOURCE_REQUIRED',
        `${item.reference} does not say which document imposes it. An obligation with no source is an assumption.`,
      );
    }
  }

  const findings = scopeFindings(items);
  const gaps = findings.filter((f) => f.kind === 'GAP');
  const overlaps = findings.filter((f) => f.kind === 'OVERLAP');

  write(ctx, {
    eventType: 'SCOPE_GAP_IDENTIFIED',
    entity: { refType: 'TenderReview', refId: reviewId },
    nextState: { ...record.state, scopeItems: items, scopeFindings: findings },
  });

  return { gaps, overlaps };
}

/**
 * Record what the contract says, and what the reader takes it to mean.
 *
 * The verbatim wording travels with the interpretation rather than instead of
 * it. The exception control is explicit that an AI clause summary never replaces
 * the executed wording, and the same is true of a human summary — the difference
 * between "payment within 30 days" and what clause 4.9.2 actually provides is
 * where the argument is.
 */
export function interpretContract(
  ctx: EngineContext,
  reviewId: string,
  obligations: Array<Omit<ContractObligation, 'status' | 'reviewedBy' | 'reviewedAt'>>,
): { recorded: number; unreviewed: number } {
  authorise(ctx, 'CONTRACTS_CLAIMS', 'C', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'LEGAL_L4' });

  const record = requireReview(ctx, reviewId);
  assertOpen(record);

  for (const obligation of obligations) {
    if (!obligation.clause?.trim()) {
      throw new DomainError(
        'CLAUSE_REQUIRED',
        `${obligation.reference} does not cite a clause. An obligation nobody can find in the contract cannot be argued from.`,
      );
    }
    if (!obligation.wording?.trim()) {
      throw new DomainError(
        'WORDING_REQUIRED',
        `${obligation.reference} carries an interpretation and not the wording. The executed wording is what binds, and a summary never replaces it.`,
      );
    }
    if (!obligation.owner?.trim()) {
      throw new DomainError('OBLIGATION_OWNER_REQUIRED', `${obligation.reference} has nobody answering for it`);
    }
  }

  const existing = (record.state.obligations as ContractObligation[]) ?? [];
  const recorded: ContractObligation[] = [
    ...existing,
    ...obligations.map((obligation) => ({ ...obligation, status: 'DRAFT' as ReviewerStatus })),
  ];

  write(ctx, {
    eventType: 'CONTRACT_INTERPRETED',
    entity: { refType: 'TenderReview', refId: reviewId },
    nextState: { ...record.state, obligations: recorded },
  });

  return { recorded: recorded.length, unreviewed: recorded.filter((o) => o.status === 'DRAFT').length };
}

/**
 * A legal or commercial owner accepts or rejects the reading.
 *
 * `AC-T-WF-02-01`'s second half. The reviewer is not the person who extracted
 * it: an interpretation checked by its author is an interpretation.
 */
export function reviewObligation(
  ctx: EngineContext,
  reviewId: string,
  obligationReference: string,
  input: { status: 'ACCEPTED' | 'REJECTED'; note?: string },
): { reference: string; unreviewed: number } {
  authorise(ctx, 'CONTRACTS_CLAIMS', 'A', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'LEGAL_L4' });

  const record = requireReview(ctx, reviewId);
  assertOpen(record);

  const obligations = (record.state.obligations as ContractObligation[]) ?? [];
  const obligation = obligations.find((o) => o.reference === obligationReference);
  if (!obligation) throw new DomainError('OBLIGATION_NOT_FOUND', `No obligation ${obligationReference} on this review`, 404);
  if (obligation.status !== 'DRAFT') {
    throw new DomainError('OBLIGATION_REVIEWED', `${obligationReference} has already been ${obligation.status.toLowerCase()}`);
  }

  const next = obligations.map((o) =>
    o.reference === obligationReference
      ? { ...o, status: input.status, reviewedBy: ctx.auth.actorId, reviewedAt: new Date().toISOString(), note: input.note }
      : o,
  );

  write(ctx, {
    eventType: 'CONTRACT_INTERPRETED',
    entity: { refType: 'TenderReview', refId: reviewId },
    nextState: { ...record.state, obligations: next },
  });

  return { reference: obligationReference, unreviewed: next.filter((o) => o.status === 'DRAFT').length };
}

/**
 * Record a pricing exclusion or assumption, and where it came from.
 *
 * `AC-T-WF-02-02`. Every one names the scope gap or the contract obligation it
 * answers, and one that names neither is refused — because an exclusion with no
 * source is a sentence somebody added on the last afternoon, and it is the one
 * the client strikes out.
 */
export function recordQualification(
  ctx: EngineContext,
  reviewId: string,
  input: { kind: 'EXCLUSION' | 'ASSUMPTION'; text: string; tracesTo: string },
): { reference: string } {
  authorise(ctx, 'ESTIMATE_TENDER', 'U', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireReview(ctx, reviewId);
  assertOpen(record);

  if (input.text.trim().length < 15) {
    throw new DomainError('QUALIFICATION_INSUBSTANTIAL', 'Say what is excluded or assumed, in the words the client will read');
  }

  const scopeReferences = new Set(((record.state.scopeItems as ScopeItem[]) ?? []).map((i) => i.reference));
  const obligationReferences = new Set(((record.state.obligations as ContractObligation[]) ?? []).map((o) => o.reference));

  if (!scopeReferences.has(input.tracesTo) && !obligationReferences.has(input.tracesTo)) {
    throw new DomainError(
      'QUALIFICATION_UNTRACEABLE',
      `${input.tracesTo} is neither a scope item nor a contract obligation on this review. ` +
        'Every exclusion answers something that was found in the documents; one that answers nothing is a sentence added on the last afternoon, and it is the one the client strikes out.',
    );
  }

  const existing = (record.state.qualifications as Qualification[]) ?? [];
  const qualification: Qualification = {
    reference: `Q-${String(existing.length + 1).padStart(3, '0')}`,
    kind: input.kind,
    text: input.text.trim(),
    tracesTo: input.tracesTo,
    recordedBy: ctx.auth.actorId,
    recordedAt: new Date().toISOString(),
  };

  write(ctx, {
    eventType: 'CONTRACT_INTERPRETED',
    entity: { refType: 'TenderReview', refId: reviewId },
    nextState: { ...record.state, qualifications: [...existing, qualification] },
  });

  return { reference: qualification.reference };
}

// --- Freeze ------------------------------------------------------------------

/**
 * Freeze the review the pricing is built on.
 *
 * Refused while a package is blocked, because that is the exception control
 * doing its job: an unreadable or missing document stops the packages that
 * depend on it being priced, and freezing a review that says so would be
 * declaring the pack complete while it says otherwise.
 */
export function freezeReview(ctx: EngineContext, reviewId: string): { contentHash: string; frozenAt: string } {
  authorise(ctx, 'ESTIMATE_TENDER', 'A', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireReview(ctx, reviewId);
  assertOpen(record);

  const blocked = (record.state.blockedPackages as string[]) ?? [];
  if (blocked.length > 0) {
    throw new DomainError(
      'PACKAGES_BLOCKED',
      `${blocked.length} package${blocked.length === 1 ? '' : 's'} cannot be priced: ${blocked.join(', ')}. ` +
        'A document is missing or unreadable. Freezing this review would declare the pack complete while the register says it is not.',
    );
  }

  const obligations = (record.state.obligations as ContractObligation[]) ?? [];
  const unreviewed = obligations.filter((o) => o.status === 'DRAFT');
  if (unreviewed.length > 0) {
    throw new DomainError(
      'OBLIGATIONS_UNREVIEWED',
      `${unreviewed.length} contract obligation${unreviewed.length === 1 ? '' : 's'} ${unreviewed.length === 1 ? 'has' : 'have'} not been ` +
        `accepted or rejected: ${unreviewed.map((o) => `${o.reference} (cl. ${o.clause})`).join(', ')}. ` +
        "An interpretation nobody signed is somebody's opinion of a contract.",
    );
  }

  const snapshot = {
    form: record.state.form,
    documents: record.state.documents,
    scopeItems: record.state.scopeItems,
    obligations,
    qualifications: record.state.qualifications,
  };
  const contentHash = hashEvidence(JSON.stringify(snapshot));
  const frozenAt = new Date().toISOString();

  const evidence = registerEvidence(ctx, {
    type: 'TENDER_REVIEW_SNAPSHOT',
    hash: contentHash,
    description: `${String(record.state.reference)} frozen — the information the price is built on`,
    linkedEntities: [{ refType: 'TenderReview', refId: reviewId }],
  });

  write(ctx, {
    eventType: 'TENDER_REVIEW_FROZEN',
    entity: { refType: 'TenderReview', refId: reviewId },
    nextState: { ...record.state, status: 'FROZEN', contentHash, frozenAt, frozenBy: ctx.auth.actorId },
    evidenceRefs: [evidence],
  });

  return { contentHash, frozenAt };
}

// --- Addendum impact ---------------------------------------------------------

export type AddendumImpact = {
  addendum: string;
  /** Packages whose price is affected, because a document informing them moved. */
  affectedPackages: string[];
  /** Scope items whose source document was reissued. */
  affectedScopeItems: string[];
  /** Obligations whose clause the addendum changed — their review is void. */
  voidedObligations: string[];
  /** Qualifications resting on something the addendum moved. */
  affectedQualifications: string[];
  summary: string;
};

/**
 * What an addendum touches, after the freeze.
 *
 * `AC-T-WF-02-03`. Derived from the frozen review rather than asserted: the
 * addendum names the documents and clauses it changed, and the impact is
 * whatever depended on them. Asking somebody to list the affected packages is
 * asking them to remember the mapping they built a fortnight ago.
 */
export function assessAddendum(
  ctx: EngineContext,
  reviewId: string,
  input: { addendum: string; changedDocuments: string[]; changedClauses?: string[] },
): AddendumImpact {
  authorise(ctx, 'ESTIMATE_TENDER', 'U', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireReview(ctx, reviewId);
  if (record.state.status !== 'FROZEN') {
    throw new DomainError(
      'REVIEW_NOT_FROZEN',
      'An addendum impact is measured against the frozen review. Until the review is frozen, an addendum is just more information — record it in the register.',
    );
  }

  const changed = new Set(input.changedDocuments);
  const changedClauses = new Set(input.changedClauses ?? []);

  const documents = (record.state.documents as TenderDocument[]) ?? [];
  const affectedPackages = [
    ...new Set(documents.filter((d) => changed.has(d.reference)).flatMap((d) => d.informsPackages)),
  ].sort();

  const scopeItems = (record.state.scopeItems as ScopeItem[]) ?? [];
  const affectedScopeItems = scopeItems.filter((i) => changed.has(i.source.document)).map((i) => i.reference);

  const obligations = (record.state.obligations as ContractObligation[]) ?? [];
  const voidedObligations = obligations.filter((o) => changedClauses.has(o.clause)).map((o) => o.reference);

  const touched = new Set([...affectedScopeItems, ...voidedObligations]);
  const qualifications = (record.state.qualifications as Qualification[]) ?? [];
  const affectedQualifications = qualifications.filter((q) => touched.has(q.tracesTo)).map((q) => q.reference);

  const parts: string[] = [];
  if (affectedPackages.length > 0) parts.push(`${affectedPackages.length} package${affectedPackages.length === 1 ? '' : 's'} to reprice`);
  if (voidedObligations.length > 0) {
    parts.push(`${voidedObligations.length} contract interpretation${voidedObligations.length === 1 ? '' : 's'} void and needing review again`);
  }
  if (affectedQualifications.length > 0) {
    parts.push(`${affectedQualifications.length} qualification${affectedQualifications.length === 1 ? '' : 's'} resting on something that moved`);
  }
  if (parts.length === 0) parts.push('nothing in the frozen review depends on what it changed');

  const impact: AddendumImpact = {
    addendum: input.addendum,
    affectedPackages,
    affectedScopeItems,
    voidedObligations,
    affectedQualifications,
    summary: `${input.addendum}: ${parts.join(', ')}.`,
  };

  write(ctx, {
    eventType: 'ADDENDUM_IMPACT_ASSESSED',
    entity: { refType: 'TenderReview', refId: reviewId },
    nextState: { ...record.state, addenda: [...((record.state.addenda as AddendumImpact[]) ?? []), impact] },
  });

  return impact;
}

// --- The position ------------------------------------------------------------

export type TenderReviewPosition = {
  reviews: Array<{
    reviewId: string;
    reference: string;
    title: string;
    status: string;
    form: ContractForm;
    findings: DocumentFinding[];
    blockedPackages: string[];
    gaps: ScopeFinding[];
    overlaps: ScopeFinding[];
    obligations: { total: number; accepted: number; rejected: number; unreviewed: number };
    qualifications: Qualification[];
    addenda: AddendumImpact[];
    contentHash?: string;
  }>;
  summary: string;
};

export function tenderReviewPosition(ctx: EngineContext): TenderReviewPosition {
  authorise(ctx, 'ESTIMATE_TENDER', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const reviews = ctx.ledger.list(ctx.projectId, 'TenderReview').map((record) => {
    const obligations = (record.state.obligations as ContractObligation[]) ?? [];
    const findings = (record.state.scopeFindings as ScopeFinding[]) ?? [];

    return {
      reviewId: String(record.state.id),
      reference: String(record.state.reference),
      title: String(record.state.title),
      status: String(record.state.status),
      form: record.state.form as ContractForm,
      findings: (record.state.findings as DocumentFinding[]) ?? [],
      blockedPackages: (record.state.blockedPackages as string[]) ?? [],
      gaps: findings.filter((f) => f.kind === 'GAP'),
      overlaps: findings.filter((f) => f.kind === 'OVERLAP'),
      obligations: {
        total: obligations.length,
        accepted: obligations.filter((o) => o.status === 'ACCEPTED').length,
        rejected: obligations.filter((o) => o.status === 'REJECTED').length,
        unreviewed: obligations.filter((o) => o.status === 'DRAFT').length,
      },
      qualifications: (record.state.qualifications as Qualification[]) ?? [],
      addenda: (record.state.addenda as AddendumImpact[]) ?? [],
      contentHash: record.state.contentHash as string | undefined,
    };
  });

  const blocked = [...new Set(reviews.flatMap((r) => r.blockedPackages))];
  const gaps = reviews.reduce((sum, r) => sum + r.gaps.length, 0);
  const overlaps = reviews.reduce((sum, r) => sum + r.overlaps.length, 0);
  const unreviewed = reviews.reduce((sum, r) => sum + r.obligations.unreviewed, 0);

  const parts = [`${reviews.length} tender review${reviews.length === 1 ? '' : 's'}`];
  if (blocked.length > 0) parts.push(`${blocked.length} package${blocked.length === 1 ? '' : 's'} blocked from pricing`);
  if (gaps > 0) parts.push(`${gaps} scope gap${gaps === 1 ? '' : 's'}`);
  if (overlaps > 0) parts.push(`${overlaps} overlap${overlaps === 1 ? '' : 's'}`);
  if (unreviewed > 0) parts.push(`${unreviewed} contract interpretation${unreviewed === 1 ? '' : 's'} unsigned`);
  if (parts.length === 1) parts.push('nothing outstanding');

  return { reviews, summary: `${parts.join(', ')}.` };
}
