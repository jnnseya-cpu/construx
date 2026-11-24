import { DomainError } from '../../core/errors.ts';
import { ulid } from '../../core/ids.ts';
import { registerEvidence, write, type EngineContext } from '../../engines/context.ts';
import type { EntityRef } from '../../goldenthread/types.ts';
import { isRole } from '../../identity/roles.ts';
import { clauseById, isClauseId, isStandard, type Standard } from './clauses.ts';
import { activePeople, addMonths, guard, nameOf, nextReference, optionalText, settings, stateOf, states, text, today, type Person } from './ims.ts';

/**
 * The controlled document library: policies turned into working procedures.
 *
 * ISO 9001, 14001 and 45001 7.5 ask the same of documented information — that
 * it is identified, reviewed and approved before use, available where it is
 * needed, protected, and that changes are controlled. Here that is:
 *
 * - every document has a reference, an owner, the clauses it meets and the
 *   roles it is issued to;
 * - a revision is drafted, then approved by **somebody other than its author**,
 *   and only then is it in force; the revision it replaces is kept, superseded;
 * - every revision in force is acknowledged — read and understood — by each
 *   person in the roles it is issued to, and the register says who has not;
 * - a document in force has a review date, and a review either changes it (a new
 *   revision) or records that it still holds;
 * - a document withdrawn stays on the record, withdrawn, with its reason.
 */

export const DOCUMENT_TYPES = ['POLICY', 'MANUAL', 'PROCEDURE', 'WORK_INSTRUCTION', 'FORM', 'PLAN'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];
const PREFIX: Record<DocumentType, string> = { POLICY: 'POL', MANUAL: 'MAN', PROCEDURE: 'PRO', WORK_INSTRUCTION: 'WI', FORM: 'FRM', PLAN: 'PLN' };

export type Revision = {
  revision: number;
  content: string;
  changeSummary: string;
  file?: { hash: string; filename: string; evidenceId: string };
  author: string;
  draftedAt: string;
  status: 'DRAFT' | 'EFFECTIVE' | 'SUPERSEDED';
  approvedBy?: string;
  approvedAt?: string;
  approvalNote?: string;
  returns?: Array<{ by: string; at: string; reason: string }>;
  /** Drafted by an agent and accepted by a person, where it was. */
  draftedByAgent?: boolean;
};

export type ImsDocument = {
  id: string;
  reference: string;
  type: DocumentType;
  title: string;
  purpose?: string;
  standards: Standard[];
  clauses: string[];
  ownerId: string;
  /** The roles it is issued to; each active person in them must acknowledge the revision in force. */
  distribution: string[];
  revisions: Revision[];
  effectiveRevision: number | null;
  reviewDueOn: string | null;
  reviews: Array<{ on: string; by: string; note: string }>;
  status: 'DRAFT' | 'EFFECTIVE' | 'WITHDRAWN';
  withdrawn?: { by: string; at: string; reason: string };
  createdBy: string;
  createdAt: string;
};

export type Acknowledgement = { id: string; documentId: string; revision: number; personId: string; at: string };

export const documents = (ctx: EngineContext): Array<ImsDocument & { version: number }> =>
  ctx.ledger.list(ctx.projectId, 'ImsDocument').map((record) => ({ ...(record.state as unknown as ImsDocument), version: record.version }));

export function documentOf(ctx: EngineContext, id: string): ImsDocument & { version: number } {
  const found = stateOf<ImsDocument>(ctx, 'ImsDocument', id);
  if (!found) throw new DomainError('IMS_DOCUMENT_NOT_FOUND', 'No such controlled document in this management system.', 404);
  return found;
}

export const acknowledgements = (ctx: EngineContext): Acknowledgement[] => states<Acknowledgement>(ctx, 'ImsAcknowledgement');

function checkedStandardsAndClauses(standards: unknown, clauses: unknown): { standards: Standard[]; clauses: string[] } {
  const chosen = [...new Set(Array.isArray(standards) ? standards : [])];
  if (chosen.length === 0 || !chosen.every(isStandard)) {
    throw new DomainError('IMS_STANDARDS', 'Name the standards it serves: ISO9001, ISO14001, ISO45001.', 422, [{ field: 'standards', message: 'one or more' }]);
  }
  const mapped = [...new Set(Array.isArray(clauses) ? clauses : [])];
  const unknown = mapped.filter((id) => !isClauseId(id));
  if (unknown.length) throw new DomainError('IMS_CLAUSE_UNKNOWN', `Not a clause of the three standards: ${unknown.join(', ')}.`, 422, [{ field: 'clauses', message: 'from the clause list' }]);
  const outside = mapped.filter((id) => !chosen.includes(clauseById(id)!.standard));
  if (outside.length) throw new DomainError('IMS_CLAUSE_STANDARD', `${outside.join(', ')} belong${outside.length === 1 ? 's' : ''} to a standard this document does not serve.`, 422, [{ field: 'clauses', message: 'of the chosen standards' }]);
  return { standards: chosen as Standard[], clauses: mapped as string[] };
}

function checkedDistribution(value: unknown): string[] {
  const roles = [...new Set(Array.isArray(value) ? value.map(String) : [])];
  const unknown = roles.filter((role) => !isRole(role) || role === 'PLATFORM_ADMIN');
  if (unknown.length) throw new DomainError('IMS_DISTRIBUTION', `Not a role in the company: ${unknown.join(', ')}.`, 422, [{ field: 'distribution', message: 'roles' }]);
  return roles;
}

function checkedFile(ctx: EngineContext, file: unknown, title: string): Revision['file'] {
  if (!file) return undefined;
  const { hash, filename } = file as { hash?: string; filename?: string };
  const bare = String(hash ?? '').replace(/^sha256:/, '');
  if (!/^[a-f0-9]{64}$/i.test(bare)) throw new DomainError('IMS_FILE_HASH', 'An attached file is named by its SHA-256 hash.', 422, [{ field: 'file.hash', message: 'sha-256' }]);
  const name = text(filename, 'file.filename', 1, 'Name the attached file.', 300);
  const evidence = registerEvidence(ctx, { type: 'IMS_DOCUMENT', hash: String(hash), description: `Controlled document ${title}: ${name}` });
  return { hash: String(hash), filename: name, evidenceId: evidence.refId };
}

const contentOf = (value: unknown, hasFile: boolean): string => {
  const content = typeof value === 'string' ? value.trim() : '';
  if (!hasFile && content.length < 40) {
    throw new DomainError('IMS_CONTENT_REQUIRED', 'Write the document (at least a few sentences), or attach the file it is kept in.', 422, [{ field: 'content', message: 'the document' }]);
  }
  if (content.length > 100_000) throw new DomainError('IMS_FIELD_TOO_LONG', 'A document is limited to 100,000 characters; attach a file for anything longer.', 422, [{ field: 'content', message: 'too long' }]);
  return content;
};

export type DocumentInput = {
  type: string;
  title: string;
  purpose?: string;
  standards: string[];
  clauses?: string[];
  ownerId: string;
  distribution?: string[];
  content?: string;
  changeSummary?: string;
  file?: { hash: string; filename: string };
};

/** Draft a new controlled document. It is not in force until somebody other than its author approves it. */
export function draftDocument(ctx: EngineContext, input: DocumentInput, options: { draftedByAgent?: boolean } = {}): ImsDocument {
  guard(ctx, 'C');
  if (!(DOCUMENT_TYPES as readonly string[]).includes(input.type)) {
    throw new DomainError('IMS_DOCUMENT_TYPE', `The type is one of ${DOCUMENT_TYPES.join(', ')}.`, 422, [{ field: 'type', message: 'choose one' }]);
  }
  const type = input.type as DocumentType;
  const title = text(input.title, 'title', 3, 'Give the document a title.', 200);
  const { standards, clauses } = checkedStandardsAndClauses(input.standards, input.clauses ?? []);
  const ownerId = text(input.ownerId, 'ownerId', 1, 'Name the person who owns the document.', 200);
  const distribution = checkedDistribution(input.distribution ?? []);
  const file = checkedFile(ctx, input.file, title);
  const content = contentOf(input.content, Boolean(file));
  const now = new Date().toISOString();
  const document: ImsDocument = {
    id: ulid(),
    reference: nextReference(ctx, 'ImsDocument', PREFIX[type], (state) => state.type === type),
    type,
    title,
    ...(optionalText(input.purpose) ? { purpose: optionalText(input.purpose)! } : {}),
    standards,
    clauses,
    ownerId,
    distribution,
    revisions: [
      {
        revision: 1,
        content,
        changeSummary: optionalText(input.changeSummary, 1000) ?? 'First issue',
        ...(file ? { file } : {}),
        author: ctx.auth.actorId,
        draftedAt: now,
        status: 'DRAFT',
        ...(options.draftedByAgent ? { draftedByAgent: true } : {}),
      },
    ],
    effectiveRevision: null,
    reviewDueOn: null,
    reviews: [],
    status: 'DRAFT',
    createdBy: ctx.auth.actorId,
    createdAt: now,
  };
  write(ctx, {
    eventType: 'IMS_DOCUMENT_DRAFTED',
    entity: { refType: 'ImsDocument', refId: document.id },
    nextState: document as unknown as Record<string, unknown>,
    reason: `${document.reference} ${title}: first draft`,
    ...(file ? { evidenceRefs: [{ refType: 'EvidenceItem', refId: file.evidenceId } as EntityRef] } : {}),
  });
  return document;
}

/**
 * Draft a change. One draft at a time: while a draft is open it is redrafted in
 * place (its author becomes whoever last wrote it), so there is never a question
 * of which of two drafts an approval meant.
 */
export function redraftDocument(
  ctx: EngineContext,
  id: string,
  input: { content?: string; changeSummary: string; file?: { hash: string; filename: string }; title?: string; purpose?: string; standards?: string[]; clauses?: string[]; ownerId?: string; distribution?: string[] },
): ImsDocument {
  guard(ctx, 'U');
  const document = documentOf(ctx, id);
  if (document.status === 'WITHDRAWN') throw new DomainError('IMS_DOCUMENT_WITHDRAWN', `${document.reference} was withdrawn; draft a new document instead.`, 409);
  const changeSummary = text(input.changeSummary, 'changeSummary', 5, 'Say what changes and why — a reader of the new revision needs it.', 1000);
  const title = input.title === undefined ? document.title : text(input.title, 'title', 3, 'Give the document a title.', 200);
  const mapping = checkedStandardsAndClauses(input.standards ?? document.standards, input.clauses ?? document.clauses);
  const file = checkedFile(ctx, input.file, title);
  const open = document.revisions.find((revision) => revision.status === 'DRAFT');
  const base = open ?? document.revisions.find((revision) => revision.revision === document.effectiveRevision);
  // A new file replaces the old one; new text with no file drops it; neither keeps what the base had.
  const keptFile = file ?? (input.content === undefined ? base?.file : undefined);
  const content = input.content === undefined ? contentOf(base?.content ?? '', Boolean(keptFile)) : contentOf(input.content, Boolean(keptFile));
  const draft: Revision = {
    revision: open ? open.revision : Math.max(...document.revisions.map((revision) => revision.revision)) + 1,
    content,
    changeSummary,
    ...(keptFile ? { file: keptFile } : {}),
    author: ctx.auth.actorId,
    draftedAt: new Date().toISOString(),
    status: 'DRAFT',
    ...(open?.returns ? { returns: open.returns } : {}),
  };
  const next: ImsDocument = {
    ...document,
    title,
    ...(input.purpose !== undefined ? { purpose: optionalText(input.purpose) } : {}),
    standards: mapping.standards,
    clauses: mapping.clauses,
    ownerId: input.ownerId === undefined ? document.ownerId : text(input.ownerId, 'ownerId', 1, 'Name the owner.', 200),
    distribution: input.distribution === undefined ? document.distribution : checkedDistribution(input.distribution),
    revisions: [...document.revisions.filter((revision) => revision.status !== 'DRAFT'), draft],
  };
  delete (next as { version?: number }).version;
  write(ctx, {
    eventType: 'IMS_DOCUMENT_REDRAFTED',
    entity: { refType: 'ImsDocument', refId: id },
    nextState: next as unknown as Record<string, unknown>,
    reason: `${document.reference} revision ${draft.revision} drafted: ${changeSummary}`,
    ...(file ? { evidenceRefs: [{ refType: 'EvidenceItem', refId: file.evidenceId } as EntityRef] } : {}),
  });
  return next;
}

function openDraft(document: ImsDocument): Revision {
  const draft = document.revisions.find((revision) => revision.status === 'DRAFT');
  if (!draft) throw new DomainError('IMS_NO_DRAFT', `${document.reference} has no draft awaiting approval.`, 409);
  return draft;
}

/** Approve the open draft: it comes into force, the revision it replaces is superseded, and its review date is set. */
export function approveDocument(ctx: EngineContext, id: string, input: { note: string }): ImsDocument {
  guard(ctx, 'A');
  const document = documentOf(ctx, id);
  const draft = openDraft(document);
  if (draft.author === ctx.auth.actorId) {
    throw new DomainError('IMS_APPROVAL_SAME_PERSON', 'A document is approved by somebody other than the person who drafted it.', 403);
  }
  const note = text(input.note, 'note', 5, 'Say what was checked before approving it.', 1000);
  const now = new Date().toISOString();
  const next: ImsDocument = {
    ...document,
    revisions: document.revisions.map((revision) =>
      revision.revision === draft.revision
        ? { ...revision, status: 'EFFECTIVE', approvedBy: ctx.auth.actorId, approvedAt: now, approvalNote: note }
        : revision.status === 'EFFECTIVE'
          ? { ...revision, status: 'SUPERSEDED' }
          : revision,
    ),
    effectiveRevision: draft.revision,
    reviewDueOn: addMonths(now.slice(0, 10), settings(ctx).documentReviewMonths),
    status: 'EFFECTIVE',
  };
  delete (next as { version?: number }).version;
  write(ctx, { eventType: 'IMS_DOCUMENT_APPROVED', entity: { refType: 'ImsDocument', refId: id }, nextState: next as unknown as Record<string, unknown>, reason: `${document.reference} revision ${draft.revision} approved: ${note}` });
  return next;
}

/** Send the draft back to its author with what is wrong. It stays a draft. */
export function returnDocument(ctx: EngineContext, id: string, input: { reason: string }): ImsDocument {
  guard(ctx, 'A');
  const document = documentOf(ctx, id);
  const draft = openDraft(document);
  const reason = text(input.reason, 'reason', 5, 'Say what has to change before it can be approved.', 1000);
  const next: ImsDocument = {
    ...document,
    revisions: document.revisions.map((revision) =>
      revision.revision === draft.revision ? { ...revision, returns: [...(revision.returns ?? []), { by: ctx.auth.actorId, at: new Date().toISOString(), reason }] } : revision,
    ),
  };
  delete (next as { version?: number }).version;
  write(ctx, { eventType: 'IMS_DOCUMENT_RETURNED', entity: { refType: 'ImsDocument', refId: id }, nextState: next as unknown as Record<string, unknown>, reason: `${document.reference} revision ${draft.revision} returned: ${reason}` });
  return next;
}

/** A periodic review that finds the document still right. A review that finds it wrong is a redraft. */
export function confirmReview(ctx: EngineContext, id: string, input: { note: string }): ImsDocument {
  guard(ctx, 'U');
  const document = documentOf(ctx, id);
  if (document.status !== 'EFFECTIVE') throw new DomainError('IMS_DOCUMENT_NOT_EFFECTIVE', `${document.reference} has no revision in force to review.`, 409);
  const note = text(input.note, 'note', 5, 'Say what the review checked it against.', 1000);
  const on = today();
  const next: ImsDocument = {
    ...document,
    reviews: [...document.reviews, { on, by: ctx.auth.actorId, note }],
    reviewDueOn: addMonths(on, settings(ctx).documentReviewMonths),
  };
  delete (next as { version?: number }).version;
  write(ctx, { eventType: 'IMS_DOCUMENT_REVIEWED', entity: { refType: 'ImsDocument', refId: id }, nextState: next as unknown as Record<string, unknown>, reason: `${document.reference} reviewed, no change: ${note}` });
  return next;
}

export function withdrawDocument(ctx: EngineContext, id: string, input: { reason: string }): ImsDocument {
  guard(ctx, 'A');
  const document = documentOf(ctx, id);
  if (document.status === 'WITHDRAWN') throw new DomainError('IMS_DOCUMENT_WITHDRAWN', `${document.reference} is already withdrawn.`, 409);
  const reason = text(input.reason, 'reason', 5, 'Say why it is withdrawn and what replaces it, if anything.', 1000);
  const next: ImsDocument = { ...document, status: 'WITHDRAWN', withdrawn: { by: ctx.auth.actorId, at: new Date().toISOString(), reason }, reviewDueOn: null };
  delete (next as { version?: number }).version;
  write(ctx, { eventType: 'IMS_DOCUMENT_WITHDRAWN', entity: { refType: 'ImsDocument', refId: id }, nextState: next as unknown as Record<string, unknown>, reason: `${document.reference} withdrawn: ${reason}` });
  return next;
}

/** "Read and understood": a person's own statement about the revision in force. */
export function acknowledgeDocument(ctx: EngineContext, id: string): Acknowledgement {
  guard(ctx, 'R');
  const document = documentOf(ctx, id);
  if (document.status !== 'EFFECTIVE' || document.effectiveRevision === null) {
    throw new DomainError('IMS_DOCUMENT_NOT_EFFECTIVE', `${document.reference} has no revision in force to acknowledge.`, 409);
  }
  const ackId = `${document.id}-r${document.effectiveRevision}-${ctx.auth.actorId}`;
  if (stateOf(ctx, 'ImsAcknowledgement', ackId)) {
    throw new DomainError('IMS_ALREADY_ACKNOWLEDGED', `You have already acknowledged ${document.reference} revision ${document.effectiveRevision}.`, 409);
  }
  const acknowledgement: Acknowledgement = { id: ackId, documentId: document.id, revision: document.effectiveRevision, personId: ctx.auth.actorId, at: new Date().toISOString() };
  write(ctx, {
    eventType: 'IMS_DOCUMENT_ACKNOWLEDGED',
    entity: { refType: 'ImsAcknowledgement', refId: ackId },
    nextState: acknowledgement as unknown as Record<string, unknown>,
    reason: `${document.reference} revision ${document.effectiveRevision} read and understood`,
  });
  return acknowledgement;
}

export type DocumentPosition = ImsDocument & {
  version: number;
  owner: string;
  inForce: Revision | null;
  draft: Revision | null;
  reviewOverdue: boolean;
  acknowledgement: { required: number; acknowledged: number; outstanding: Array<{ id: string; name: string }>; mine: boolean; mustAcknowledge: boolean };
};

/** Each document with who owns it, what is in force, whether its review is overdue, and who has not acknowledged it. */
export function documentRegister(ctx: EngineContext, people: readonly Person[]): DocumentPosition[] {
  guard(ctx, 'R');
  const acks = acknowledgements(ctx);
  const staff = activePeople(people);
  const on = today();
  return documents(ctx).map((document) => {
    const inForce = document.revisions.find((revision) => revision.status === 'EFFECTIVE') ?? null;
    const required = inForce ? staff.filter((person) => person.roles.some((role) => document.distribution.includes(role))) : [];
    const done = new Set(acks.filter((ack) => ack.documentId === document.id && ack.revision === inForce?.revision).map((ack) => ack.personId));
    return {
      ...document,
      owner: nameOf(people, document.ownerId),
      inForce,
      draft: document.revisions.find((revision) => revision.status === 'DRAFT') ?? null,
      reviewOverdue: document.status === 'EFFECTIVE' && document.reviewDueOn !== null && document.reviewDueOn < on,
      acknowledgement: {
        required: required.length,
        acknowledged: required.filter((person) => done.has(person.id)).length,
        outstanding: required.filter((person) => !done.has(person.id)).map((person) => ({ id: person.id, name: person.name })),
        mine: done.has(ctx.auth.actorId),
        mustAcknowledge: Boolean(inForce) && ctx.auth.roles.some((role) => document.distribution.includes(role)) && !done.has(ctx.auth.actorId),
      },
    };
  });
}
