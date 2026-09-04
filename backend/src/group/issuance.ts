import { hashEvidence } from '../core/canonical.ts';
import { DomainError, ForbiddenError, NotFoundError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import type { AuthContext } from '../identity/auth.ts';
import { classifyEntity } from '../identity/entityAccess.ts';
import type { ClientBranding, DocumentBlock, ExportDocument } from '../export/exporter.ts';
import { VERIFICATION_SCHEME } from '../export/exporter.ts';
import { renderPdf } from '../export/pdf.ts';
import { issueTag } from '../evidence/envelope.ts';
import type { Platform } from '../platform.ts';
import { allocateDocumentNumber, approvalRequiredFor, DOCUMENT_TYPES, issuerProfile, legalReadiness, type IssuerBlock } from './profile.ts';

/**
 * The document lifecycle and atomic issuance (enterprise specification §8.2,
 * §8.3): draft → generated → awaiting approval → approved → issued.
 *
 * A document here is a legal instrument the company issues under its own
 * name — a quotation, an invoice, a contract, a certificate — as distinct
 * from the reports and site documents the exporter already produces
 * synchronously. What this adds is what a legal instrument needs and a
 * report does not:
 *
 * - **A frozen manifest.** Generating a revision snapshots the body, the
 *   issuer profile version, the brand and the source record's version into a
 *   hash. What was approved is that hash; what is issued is that hash.
 * - **Approval bound to the revision.** An approval names the hash it
 *   approved. Regenerating makes a new revision without an approval, so a
 *   changed total cannot ride out under an old signature.
 * - **Issuance as one outcome.** Issuing reserves the number and a pending
 *   issuance first, then renders the numbered bytes, then marks it issued.
 *   A retry of the same request finds the pending issuance and finishes it
 *   with the same number; an abandoned one is voided and its number stays
 *   on the record, never reused. There is one issuance per document.
 * - **Immutability after issue.** An issued document cannot be regenerated.
 *   A correction is a new document that says which one it supersedes.
 *
 * The issuer is the tenancy the document was built in, resolved on the
 * server. A caller cannot name an issuer, a brand or a signatory by id — a
 * sibling company's configuration is not reachable from here (AT-16).
 */

export const DOCUMENT_STATUSES = ['DRAFT', 'GENERATED', 'AWAITING_APPROVAL', 'APPROVED', 'ISSUED'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/** What a document says, as the rows it prints. Strings and numbers only: the body is data, never markup. */
export type DocumentBody = Record<string, string | number>;

export type DocumentManifest = {
  issuerProfileVersion: number;
  issuer: IssuerBlock;
  brand: { clientName: string; primaryColour: string; profileVersion: number } | null;
  templateVersion: number;
  locale: string;
  source: { refType: string; refId: string; version: number } | null;
  body: DocumentBody;
  rendererVersion: string;
};

export type DocumentRevision = {
  revision: number;
  hash: string;
  generatedAt: string;
  generatedBy: string;
  manifest: DocumentManifest;
  approval?: { by: string; at: string; hash: string; title: string };
  rejection?: { by: string; at: string; reason: string };
};

export type LifecycleDocument = {
  id: string;
  tenantId: string;
  productCode: 'construx';
  documentType: string;
  title: string;
  status: DocumentStatus;
  /** The current revision number; 0 before anything has been generated. */
  revision: number;
  /** Record version, for a caller that wants to say which state it acted on. */
  version: number;
  source: { refType: string; refId: string } | null;
  supersedes: string | null;
  body: DocumentBody;
  revisions: DocumentRevision[];
  issuance: { id: string; number: string; issuedAt: string; hash: string } | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  correlationId: string;
};

export type Issuance = {
  id: string;
  /** The request's idempotency key, scoped to the tenancy. */
  key: string;
  tenantId: string;
  documentId: string;
  documentType: string;
  revision: number;
  hash: string;
  number: string;
  seq: number;
  status: 'PENDING' | 'ISSUED' | 'VOID';
  issuerProfileVersion: number;
  approval: DocumentRevision['approval'] | null;
  reservedAt: string;
  reservedBy: string;
  attempts: number;
  lastError?: string;
  issuedAt?: string;
  issuedBy?: string;
  /** SHA-256 of the issued bytes, and whether the bytes are held in the evidence store. */
  renderHash?: string;
  stored?: boolean;
  voidedAt?: string;
  voidedBy?: string;
  voidReason?: string;
};

export const RENDERER_VERSION = 'construx-pdf-1';
const governance = (tenantId: string) => `${tenantId}-governance`;

// --- reads ----------------------------------------------------------------------------

export function documentsOf(platform: Platform, tenantId: string): LifecycleDocument[] {
  return platform.ledger
    .listByTenant(tenantId, 'Document')
    .map((record) => record.state as unknown as LifecycleDocument)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function documentOf(platform: Platform, tenantId: string, documentId: string): LifecycleDocument {
  const record = platform.ledger.get({ refType: 'Document', refId: documentId });
  // The same answer whether the document belongs to somebody else or to
  // nobody: a foreign id does not confirm that anything exists (§5.2).
  if (!record || record.tenantId !== tenantId) throw new NotFoundError(`No document ${documentId} in this company`);
  return record.state as unknown as LifecycleDocument;
}

export function issuancesOf(platform: Platform, tenantId: string): Issuance[] {
  return platform.ledger
    .listByTenant(tenantId, 'Issuance')
    .map((record) => record.state as unknown as Issuance)
    .sort((a, b) => b.reservedAt.localeCompare(a.reservedAt));
}

function issuanceOf(platform: Platform, tenantId: string, issuanceId: string): Issuance {
  const record = platform.ledger.get({ refType: 'Issuance', refId: issuanceId });
  if (!record || record.tenantId !== tenantId) throw new NotFoundError(`No issuance ${issuanceId} in this company`);
  return record.state as unknown as Issuance;
}

// --- commits --------------------------------------------------------------------------

function commitDocument(platform: Platform, actor: AuthContext, document: LifecycleDocument, eventType: 'DOCUMENT_DRAFTED' | 'DOCUMENT_GENERATED' | 'DOCUMENT_SUBMITTED' | 'DOCUMENT_APPROVED' | 'DOCUMENT_REJECTED' | 'DOCUMENT_ISSUED'): LifecycleDocument {
  platform.ledger.commit({
    tenantId: document.tenantId,
    projectId: governance(document.tenantId),
    actor: { refType: 'User', refId: actor.actorId },
    source: 'WEB',
    correlationId: document.correlationId,
    eventType,
    entity: { refType: 'Document', refId: document.id },
    nextState: { ...document } as unknown as Record<string, unknown>,
  });
  return document;
}

function commitIssuance(platform: Platform, actor: AuthContext, issuance: Issuance, eventType: 'ISSUANCE_RESERVED' | 'ISSUANCE_ATTEMPT_FAILED' | 'ISSUANCE_COMPLETED' | 'ISSUANCE_VOIDED'): Issuance {
  platform.ledger.commit({
    tenantId: issuance.tenantId,
    projectId: governance(issuance.tenantId),
    actor: { refType: 'User', refId: actor.actorId },
    source: 'WEB',
    correlationId: ulid(),
    eventType,
    entity: { refType: 'Issuance', refId: issuance.id },
    nextState: { ...issuance } as unknown as Record<string, unknown>,
  });
  return issuance;
}

function assertBody(body: unknown): DocumentBody {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DomainError('DOCUMENT_BODY_INVALID', 'The body is an object of labels to values');
  const out: DocumentBody = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (typeof value !== 'string' && typeof value !== 'number') throw new DomainError('DOCUMENT_BODY_INVALID', `${key} must be text or a number; the body is data, not markup`);
    if (key.length > 80 || (typeof value === 'string' && value.length > 2000)) throw new DomainError('DOCUMENT_BODY_INVALID', `${key} is too long`);
    out[key] = value;
  }
  if (Object.keys(out).length > 200) throw new DomainError('DOCUMENT_BODY_INVALID', 'A body holds at most 200 rows');
  return out;
}

// --- the lifecycle --------------------------------------------------------------------

/** A draft: unnumbered, unapproved, changeable. */
export function createDraft(
  platform: Platform,
  actor: AuthContext,
  input: { documentType: string; title: string; body?: DocumentBody; source?: { refType: string; refId: string }; supersedes?: string },
): LifecycleDocument {
  if (!(DOCUMENT_TYPES as readonly string[]).includes(input.documentType)) {
    throw new DomainError('DOCUMENT_TYPE_UNKNOWN', `${input.documentType} is not a document type. One of: ${DOCUMENT_TYPES.join(', ')}`);
  }
  const title = input.title.trim();
  if (title.length < 2 || title.length > 200) throw new DomainError('DOCUMENT_TITLE_INVALID', 'A title is 2 to 200 characters');
  let source: LifecycleDocument['source'] = null;
  if (input.source) {
    // The source record must be ours. A record id from another company is
    // answered exactly as a record that does not exist.
    if (!classifyEntity(input.source.refType)) throw new DomainError('SOURCE_TYPE_UNKNOWN', `${input.source.refType} is not a record type`, 422);
    const record = platform.ledger.get({ refType: input.source.refType, refId: input.source.refId });
    if (!record || record.tenantId !== actor.tenantId) throw new NotFoundError(`No ${input.source.refType} ${input.source.refId} in this company`);
    source = { refType: input.source.refType, refId: input.source.refId };
  }
  let supersedes: string | null = null;
  if (input.supersedes) {
    const previous = documentOf(platform, actor.tenantId, input.supersedes);
    if (previous.status !== 'ISSUED') throw new DomainError('SUPERSEDES_NOT_ISSUED', 'Only an issued document is superseded; an unissued one is simply changed', 409);
    supersedes = previous.id;
  }
  const now = new Date().toISOString();
  const document: LifecycleDocument = {
    id: ulid(),
    tenantId: actor.tenantId,
    productCode: 'construx',
    documentType: input.documentType,
    title,
    status: 'DRAFT',
    revision: 0,
    version: 1,
    source,
    supersedes,
    body: assertBody(input.body ?? {}),
    revisions: [],
    issuance: null,
    createdBy: actor.actorId,
    createdAt: now,
    updatedAt: now,
    correlationId: ulid(),
  };
  return commitDocument(platform, actor, document, 'DOCUMENT_DRAFTED');
}

function assertNotIssued(document: LifecycleDocument): void {
  if (document.status === 'ISSUED') {
    throw new DomainError('DOCUMENT_ISSUED', `${document.title} is issued as ${document.issuance?.number ?? '—'} and cannot change. A correction is a new document that supersedes it.`, 409);
  }
}

function pendingIssuanceFor(platform: Platform, document: LifecycleDocument): Issuance | undefined {
  return issuancesOf(platform, document.tenantId).find((issuance) => issuance.documentId === document.id && issuance.status === 'PENDING');
}

/**
 * Generate a revision: freeze the body, the issuer, the brand and the source
 * version into a manifest and hash it. A new revision carries no approval
 * (AT-15): whatever was approved before was a different hash.
 */
export function generateRevision(
  platform: Platform,
  actor: AuthContext,
  documentId: string,
  input: { body?: DocumentBody; expectedVersion?: number; locale?: string } = {},
): LifecycleDocument {
  const document = documentOf(platform, actor.tenantId, documentId);
  assertNotIssued(document);
  if (input.expectedVersion !== undefined && input.expectedVersion !== document.version) {
    throw new DomainError('VERSION_CONFLICT', `The document is at version ${document.version}, not ${input.expectedVersion}; read it again before changing it`, 409);
  }
  if (pendingIssuanceFor(platform, document)) {
    throw new DomainError('ISSUANCE_PENDING', 'An issuance is pending on this document; finish or void it before generating again', 409);
  }
  const profile = issuerProfile(platform, actor.tenantId);
  const brand: ClientBranding | undefined = platform.exports.brandingIfConfigured(actor.tenantId);
  const body = input.body ? assertBody(input.body) : document.body;
  let source: DocumentManifest['source'] = null;
  if (document.source) {
    const record = platform.ledger.get({ refType: document.source.refType, refId: document.source.refId });
    if (!record || record.tenantId !== actor.tenantId) throw new NotFoundError(`The source ${document.source.refType} no longer exists in this company`);
    source = { ...document.source, version: record.version };
  }
  const manifest: DocumentManifest = {
    issuerProfileVersion: profile.version,
    issuer: profile.issuer,
    brand: brand ? { clientName: brand.clientName, primaryColour: brand.primaryColour, profileVersion: brand.profileVersion ?? 0 } : null,
    templateVersion: 1,
    locale: (input.locale ?? 'en-GB').slice(0, 10),
    source,
    body,
    rendererVersion: RENDERER_VERSION,
  };
  const now = new Date().toISOString();
  const revision: DocumentRevision = {
    revision: document.revision + 1,
    hash: hashEvidence(JSON.stringify({ documentId: document.id, documentType: document.documentType, title: document.title, manifest })),
    generatedAt: now,
    generatedBy: actor.actorId,
    manifest,
  };
  const next: LifecycleDocument = {
    ...document,
    status: 'GENERATED',
    revision: revision.revision,
    version: document.version + 1,
    body,
    revisions: [...document.revisions, revision],
    updatedAt: now,
  };
  return commitDocument(platform, actor, next, 'DOCUMENT_GENERATED');
}

/** Put the current revision before its approver. Refused for a type that needs no approval. */
export function submitForApproval(platform: Platform, actor: AuthContext, documentId: string): LifecycleDocument {
  const document = documentOf(platform, actor.tenantId, documentId);
  assertNotIssued(document);
  if (document.status !== 'GENERATED') throw new DomainError('DOCUMENT_NOT_GENERATED', `A ${document.status.toLowerCase().replace('_', ' ')} document is not submitted; generate a revision first`, 409);
  const profile = issuerProfile(platform, actor.tenantId);
  if (!approvalRequiredFor(profile, document.documentType)) {
    throw new DomainError('APPROVAL_NOT_REQUIRED', `A ${document.documentType} goes from generated to issued under this company's policy; nothing to submit`, 409);
  }
  return commitDocument(platform, actor, { ...document, status: 'AWAITING_APPROVAL', version: document.version + 1, updatedAt: new Date().toISOString() }, 'DOCUMENT_SUBMITTED');
}

/**
 * Approve exactly one revision by its hash. The approver must be a named
 * signatory for the type where the company has named any; the hash must be
 * the current revision's, or the approval is of something that no longer
 * exists (VERSION_CONFLICT).
 */
export function approveDocument(platform: Platform, actor: AuthContext, documentId: string, input: { revision: number; hash: string }): LifecycleDocument {
  const document = documentOf(platform, actor.tenantId, documentId);
  assertNotIssued(document);
  if (document.status !== 'AWAITING_APPROVAL' && document.status !== 'GENERATED') {
    throw new DomainError('DOCUMENT_NOT_GENERATED', `A ${document.status.toLowerCase()} document has no revision to approve`, 409);
  }
  const current = document.revisions[document.revisions.length - 1]!;
  if (input.revision !== current.revision || input.hash !== current.hash) {
    throw new DomainError('VERSION_CONFLICT', `The approval names revision ${input.revision} (${input.hash.slice(0, 18)}…) but the current revision is ${current.revision} (${current.hash.slice(0, 18)}…). Read it again and approve what is there.`, 409);
  }
  const profile = issuerProfile(platform, actor.tenantId);
  const signatories = profile.signatories.filter((signatory) => signatory.documents.includes(document.documentType));
  const signatory = signatories.find((candidate) => candidate.userId === actor.actorId);
  if (signatories.length > 0 && !signatory) {
    throw new ForbiddenError(`A ${document.documentType} is approved by one of its named signatories`, 'SIGNATORY_REQUIRED');
  }
  assertMayDecide(platform, actor, document.documentType, signatories.length > 0);
  const now = new Date().toISOString();
  const approval = { by: actor.actorId, at: now, hash: current.hash, title: signatory?.title ?? platform.user(actor.actorId).roles.join(', ') };
  const revisions = document.revisions.map((revision) => (revision.revision === current.revision ? { ...revision, approval } : revision));
  return commitDocument(platform, actor, { ...document, status: 'APPROVED', version: document.version + 1, revisions, updatedAt: now }, 'DOCUMENT_APPROVED');
}

/**
 * Who decides on a document where the company has named no signatory for the
 * type: its administrators. The permission key `documents.approve` is held by
 * a named signatory or an administrator — never by everyone who can export.
 */
function assertMayDecide(platform: Platform, actor: AuthContext, documentType: string, signatoryNamed: boolean): void {
  if (signatoryNamed) return;
  const user = platform.user(actor.actorId);
  if (!user.roles.includes('ENTERPRISE_ADMIN') && !user.roles.includes('OWNER')) {
    throw new ForbiddenError(`No signatory is named for a ${documentType}, so a company administrator approves or sends it back`, 'SIGNATORY_REQUIRED');
  }
}

/** Send it back: the current revision is marked rejected and the document is a draft again. */
export function rejectDocument(platform: Platform, actor: AuthContext, documentId: string, reason: string): LifecycleDocument {
  const document = documentOf(platform, actor.tenantId, documentId);
  assertNotIssued(document);
  const named = issuerProfile(platform, actor.tenantId).signatories.filter((signatory) => signatory.documents.includes(document.documentType));
  if (named.length > 0 && !named.some((signatory) => signatory.userId === actor.actorId)) {
    throw new ForbiddenError(`A ${document.documentType} is sent back by one of its named signatories`, 'SIGNATORY_REQUIRED');
  }
  assertMayDecide(platform, actor, document.documentType, named.length > 0);
  if (document.status === 'DRAFT') throw new DomainError('DOCUMENT_NOT_GENERATED', 'A draft has nothing to reject', 409);
  if (reason.trim().length < 5) throw new DomainError('REASON_REQUIRED', 'Say why it is going back');
  if (pendingIssuanceFor(platform, document)) throw new DomainError('ISSUANCE_PENDING', 'An issuance is pending on this document; void it first', 409);
  const now = new Date().toISOString();
  const current = document.revisions[document.revisions.length - 1]!;
  const revisions = document.revisions.map((revision) =>
    revision.revision === current.revision ? { ...revision, rejection: { by: actor.actorId, at: now, reason: reason.trim().slice(0, 1000) } } : revision,
  );
  return commitDocument(platform, actor, { ...document, status: 'DRAFT', version: document.version + 1, revisions, updatedAt: now }, 'DOCUMENT_REJECTED');
}

// --- rendering ------------------------------------------------------------------------

function fallbackBranding(issuer: IssuerBlock): ClientBranding {
  return {
    clientName: issuer.tradingName || issuer.registeredName,
    issuingEntity: issuer.registeredName,
    primaryColour: '#1f3a5f',
    legalFooter: issuer.footerLegalText,
    documentReferencePrefix: 'DOC',
  };
}

/** The numbered document, as blocks, from the frozen manifest and nothing else. */
export function issuedDocumentModel(platform: Platform, document: LifecycleDocument, issuance: Issuance): ExportDocument {
  const revision = document.revisions.find((held) => held.revision === issuance.revision)!;
  const manifest = revision.manifest;
  const issuer = manifest.issuer;
  const branding = platform.exports.brandingIfConfigured(document.tenantId) ?? fallbackBranding(issuer);
  const address = [issuer.registeredAddress.line1, issuer.registeredAddress.line2, issuer.registeredAddress.city, issuer.registeredAddress.postcode, issuer.registeredAddress.country].filter(Boolean).join(', ');
  const blocks: DocumentBlock[] = [
    { kind: 'HEADING', level: 1, text: document.title },
    {
      kind: 'KEY_VALUES',
      rows: [
        { label: 'Document', value: `${document.documentType} ${issuance.number}` },
        { label: 'Issued by', value: issuer.registeredName + (issuer.tradingName && issuer.tradingName !== issuer.registeredName ? ` (trading as ${issuer.tradingName})` : '') },
        ...(issuer.registrationNo ? [{ label: 'Registration', value: issuer.registrationNo }] : []),
        ...(issuer.vatNumber ? [{ label: 'VAT', value: issuer.vatNumber }] : []),
        ...(address ? [{ label: 'Registered address', value: address }] : []),
        { label: 'Revision', value: `${issuance.revision} · ${issuance.hash.slice(0, 23)}…` },
        ...(issuance.approval ? [{ label: 'Approved', value: `${issuance.approval.title} · ${issuance.approval.at.slice(0, 16).replace('T', ' ')}` }] : []),
        { label: 'Issuer profile', value: `version ${issuance.issuerProfileVersion}` },
      ],
    },
    { kind: 'KEY_VALUES', rows: Object.entries(manifest.body).map(([label, value]) => ({ label, value: String(value) })) },
    ...(document.supersedes ? [{ kind: 'PARAGRAPH' as const, text: `Supersedes document ${document.supersedes}.` }] : []),
    ...(issuer.footerLegalText ? [{ kind: 'PARAGRAPH' as const, text: issuer.footerLegalText }] : []),
  ];
  const contentHash = issuance.hash;
  return {
    id: issuance.id,
    reference: issuance.number,
    title: document.title,
    branding: { ...branding, issuingEntity: issuer.registeredName, legalFooter: issuer.footerLegalText || branding.legalFooter },
    issuer: { companyId: document.tenantId, profileVersion: issuance.issuerProfileVersion, documentType: 'report' },
    audience: 'CLIENT',
    format: 'PDF',
    generatedAt: issuance.issuedAt ?? issuance.reservedAt,
    generatedBy: issuance.issuedBy ?? issuance.reservedBy,
    projectId: governance(document.tenantId),
    blocks,
    contentHash,
    verification: `${VERIFICATION_SCHEME}:${document.tenantId}:${issueTag({ contentHash, reference: issuance.number, tenantId: document.tenantId })}`,
  };
}

export type Renderer = (model: ExportDocument) => Uint8Array;

// --- issuance -------------------------------------------------------------------------

/**
 * Issue the document. One outcome per request: the number and a pending
 * issuance are recorded first, the bytes are rendered against the frozen
 * manifest, then the issuance is marked issued. Replaying the same key after
 * success returns the same issuance; retrying after a failed render resumes
 * the pending one with the same number; a different document under the same
 * key is IDEMPOTENCY_CONFLICT.
 */
export function issueDocument(
  platform: Platform,
  actor: AuthContext,
  documentId: string,
  input: { idempotencyKey: string },
  render: Renderer = renderPdf,
): { issuance: Issuance; document: LifecycleDocument; replayed: boolean } {
  const key = input.idempotencyKey.trim();
  if (key.length < 8 || key.length > 128) throw new DomainError('IDEMPOTENCY_KEY_INVALID', 'An idempotency key is 8 to 128 characters');
  const document = documentOf(platform, actor.tenantId, documentId);
  const issuances = issuancesOf(platform, actor.tenantId);
  const sameKey = issuances.find((issuance) => issuance.key === key);
  if (sameKey && sameKey.documentId !== document.id) {
    throw new DomainError('IDEMPOTENCY_CONFLICT', 'That idempotency key was used to issue a different document', 409);
  }
  if (document.status === 'ISSUED') {
    const done = issuances.find((issuance) => issuance.id === document.issuance?.id)!;
    if (done.key === key) return { issuance: done, document, replayed: true };
    throw new DomainError('DOCUMENT_ISSUED', `${document.title} is already issued as ${done.number}`, 409);
  }

  let pending = pendingIssuanceFor(platform, document);
  if (!pending) {
    const profile = issuerProfile(platform, actor.tenantId);
    const current = document.revisions[document.revisions.length - 1];
    const ready = document.status === 'APPROVED' || (document.status === 'GENERATED' && !approvalRequiredFor(profile, document.documentType));
    if (!current || !ready) {
      throw new DomainError('DOCUMENT_NOT_APPROVED', `A ${document.documentType} is issued once its current revision is approved; this one is ${document.status.toLowerCase().replace('_', ' ')}`, 409);
    }
    // The approval is of a hash; the revision it sits on is what goes out.
    if (document.status === 'APPROVED' && current.approval?.hash !== current.hash) {
      throw new DomainError('DOCUMENT_NOT_APPROVED', 'The current revision carries no approval of its own hash', 409);
    }
    // What goes out is the frozen manifest, issuer block included. A profile
    // changed since generation — new registered details, a new brand — means
    // the frozen issuer is no longer the company's; regenerate and re-approve
    // so what was approved is exactly what is issued.
    if (current.manifest.issuerProfileVersion !== profile.version) {
      throw new DomainError(
        'ISSUER_PROFILE_CHANGED',
        `The issuer profile is at version ${profile.version} but this revision was generated under version ${current.manifest.issuerProfileVersion}. Generate a new revision so the document carries the current issuer, then approve it.`,
        409,
      );
    }
    const readiness = legalReadiness(profile);
    if (!readiness.complete) {
      throw new DomainError('LEGAL_PROFILE_INCOMPLETE', `The registered issuer details are incomplete (${readiness.missing.join(', ')}). Set them on the company profile before issuing.`, 422);
    }
    // A signatory named on the approval who has since been removed from the
    // profile invalidates it (§8.2): the approval was theirs to give.
    if (current.approval && profile.signatories.some((signatory) => signatory.documents.includes(document.documentType)) && !profile.signatories.some((signatory) => signatory.userId === current.approval!.by && signatory.documents.includes(document.documentType))) {
      throw new DomainError('DOCUMENT_NOT_APPROVED', 'The approving signatory is no longer named for this document type; the revision needs a new approval', 409);
    }
    const allocated = allocateDocumentNumber(platform, actor, document.documentType);
    pending = {
      id: ulid(),
      key,
      tenantId: actor.tenantId,
      documentId: document.id,
      documentType: document.documentType,
      revision: current.revision,
      hash: current.hash,
      number: allocated.number,
      seq: allocated.seq,
      status: 'PENDING',
      issuerProfileVersion: allocated.profileVersion,
      approval: current.approval ?? null,
      reservedAt: new Date().toISOString(),
      reservedBy: actor.actorId,
      attempts: 0,
    };
    commitIssuance(platform, actor, pending, 'ISSUANCE_RESERVED');
  }

  // Render against the frozen manifest. A failure leaves the pending
  // issuance and its number exactly where they are, for the retry.
  let bytes: Uint8Array;
  try {
    bytes = render(issuedDocumentModel(platform, document, pending));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    commitIssuance(platform, actor, { ...pending, attempts: pending.attempts + 1, lastError: message.slice(0, 300) }, 'ISSUANCE_ATTEMPT_FAILED');
    throw new DomainError('ISSUANCE_RENDER_FAILED', `The document could not be rendered (${message}). The number ${pending.number} is reserved for it; retry the same request.`, 503);
  }
  const renderHash = hashEvidence(Buffer.from(bytes));
  let stored = false;
  if (platform.evidence.configured) {
    platform.evidence.put(actor.tenantId, renderHash, Buffer.from(bytes), 'application/pdf');
    stored = true;
  }
  const now = new Date().toISOString();
  const issued: Issuance = { ...pending, status: 'ISSUED', attempts: pending.attempts + 1, issuedAt: now, issuedBy: actor.actorId, renderHash, stored };
  commitIssuance(platform, actor, issued, 'ISSUANCE_COMPLETED');
  const final = commitDocument(
    platform,
    actor,
    { ...document, status: 'ISSUED', version: document.version + 1, issuance: { id: issued.id, number: issued.number, issuedAt: now, hash: issued.hash }, updatedAt: now },
    'DOCUMENT_ISSUED',
  );
  return { issuance: issued, document: final, replayed: false };
}

/** Abandon a pending issuance. The number stays recorded as void and is never handed out again. */
export function voidIssuance(platform: Platform, actor: AuthContext, issuanceId: string, reason: string): Issuance {
  const issuance = issuanceOf(platform, actor.tenantId, issuanceId);
  if (issuance.status !== 'PENDING') throw new DomainError('ISSUANCE_NOT_PENDING', `Issuance ${issuance.number} is ${issuance.status.toLowerCase()}; only a pending one is voided`, 409);
  if (reason.trim().length < 5) throw new DomainError('REASON_REQUIRED', 'Say why the number is being voided; it stays on the record');
  return commitIssuance(platform, actor, { ...issuance, status: 'VOID', voidedAt: new Date().toISOString(), voidedBy: actor.actorId, voidReason: reason.trim().slice(0, 500) }, 'ISSUANCE_VOIDED');
}

/**
 * The issued bytes. Served from the evidence store where they were kept;
 * otherwise re-rendered from the frozen manifest, which changes only the
 * PDF's own timestamp — and the response says which it was.
 */
export function issuedBytes(platform: Platform, actor: AuthContext, documentId: string, render: Renderer = renderPdf): { bytes: Buffer; contentType: string; filename: string; served: 'STORED' | 'RE_RENDERED'; renderHash: string } {
  const document = documentOf(platform, actor.tenantId, documentId);
  if (document.status !== 'ISSUED' || !document.issuance) throw new DomainError('DOCUMENT_NOT_ISSUED', `${document.title} is not issued; there are no issued bytes to download`, 409);
  const issuance = issuanceOf(platform, actor.tenantId, document.issuance.id);
  const filename = `${issuance.number}.pdf`;
  if (issuance.stored && issuance.renderHash && platform.evidence.has(actor.tenantId, issuance.renderHash)) {
    const held = platform.evidence.get(actor.tenantId, issuance.renderHash);
    return { bytes: held.bytes, contentType: held.contentType, filename, served: 'STORED', renderHash: issuance.renderHash };
  }
  const bytes = Buffer.from(render(issuedDocumentModel(platform, document, issuance)));
  return { bytes, contentType: 'application/pdf', filename, served: 'RE_RENDERED', renderHash: issuance.renderHash ?? hashEvidence(bytes) };
}
