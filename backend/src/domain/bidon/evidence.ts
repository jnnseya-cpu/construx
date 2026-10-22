import { DomainError } from '../../core/errors.ts';
import { formatRef, ulid } from '../../core/ids.ts';
import { authorise, registerEvidence, write, type EngineContext } from '../../engines/context.ts';
import { requireModule, requireModuleReadable } from '../../identity/modules.ts';
// The platform's own semantic retrieval, reused rather than restated: one
// cosine implementation that refuses mismatched dimensions, and one similarity
// floor, so Bid-On's retriever and the record's cannot drift apart on either.
import { cosine, MINIMUM_SIMILARITY } from '../../datalayer/vectorindex.ts';
import { requireVisibleCustomer } from './customers.ts';

/**
 * The per-customer evidence library.
 *
 * ## Why evidence belongs to the customer and not the tenancy
 *
 * This is the single most important structural fact in the module. A provider
 * writes bids for firms that compete with each other. Both customers' policies,
 * certificates, case studies, CVs and accident statistics sit inside one
 * tenancy — the provider's — so tenant isolation cannot separate them. If an
 * evidence item hung off the tenant, the retriever would be one missing filter
 * away from citing one electrical contractor's accident rate in a competitor's
 * submission to the same buyer.
 *
 * So `customerAccountId` is on the record, not on a query somebody remembers to
 * write, and `retrieveFor` takes a customer and filters before it ranks. The
 * specification's acceptance criterion says the same thing: *"evidence
 * retrieval filters on customer_account_id in every query, so one customer's
 * material can never appear in another customer's answer."*
 *
 * ## Built on the evidence chain that already exists
 *
 * The bytes go to `EvidenceStore` at their own hash, and the file is registered
 * through `registerEvidence` so it is in the one evidence chain the platform
 * already keeps rather than a second one beside it. What this module adds is
 * what a questionnaire needs and the generic chain does not carry: which
 * customer it belongs to, what kind of evidence it is, the day it stops being
 * current, and the chunks a retriever ranks.
 *
 * ## Two refusals that are not validation
 *
 * **A certificate with no expiry is refused.** Every certificate and every
 * insurance schedule lapses, and an evidence item with no expiry cannot be
 * caught by the hard rule that refuses a submission citing something which will
 * not be current when the buyer reads it. A missing expiry is not a blank
 * field, it is a disabled safety check.
 *
 * **A CV with no data-subject consent is refused.** A CV is somebody's personal
 * data, going to a buyer, under a company's name. UK GDPR is a release blocker
 * in the specification's own words rather than a nice-to-have, and consent
 * captured at upload is the only point at which it can honestly be captured —
 * afterwards the file is already in the library and already citable.
 */

export const EVIDENCE_TYPE = [
  'POLICY',
  'CERTIFICATE',
  'CASE_STUDY',
  'CV',
  'STATS',
  'INSURANCE',
  'OTHER',
] as const;
export type EvidenceType = (typeof EVIDENCE_TYPE)[number];

/** Types that always lapse, and are refused without a date. */
const MUST_EXPIRE: readonly EvidenceType[] = ['CERTIFICATE', 'INSURANCE'];

/** Types that carry a named person's data, and are refused without consent. */
const MUST_CONSENT: readonly EvidenceType[] = ['CV'];

/**
 * One retrievable passage of an evidence item.
 *
 * `pageRef` is what makes a citation checkable. An answer that cites "the
 * health and safety policy" is unverifiable; one that cites page 4 of it is
 * something a reviewer can open and read in ten seconds, which is the
 * difference between a citation and a gesture at one.
 */
export type EvidenceChunk = {
  id: string;
  text: string;
  pageRef?: string;
  /**
   * The passage's embedding, where the library has been embedded.
   *
   * Stored on the chunk rather than in a separate index, for the reason
   * `datalayer/vectorindex.ts` gives about its own index: a second copy of text
   * the ledger already holds goes stale the moment a record is corrected. A
   * vector that lives on the passage is replaced when the passage is, and the
   * space it belongs to is named once on the item.
   */
  vector?: number[];
};

/**
 * Which model's space an item's vectors are in.
 *
 * On the item rather than the chunk because every chunk of one item is embedded
 * in one call by one model. Recorded at all because cosine similarity between
 * two models' vectors is not a smaller number — it is meaningless, and it looks
 * exactly like a real score. Nothing here compares across spaces.
 */
export type SemanticModel = {
  provider: string;
  modelClass: string;
  dimensions: number;
  chunks: number;
  embeddedAt: string;
  embeddedBy: string;
};

export type EvidenceConsent = {
  /** Whose data it is. Named, because consent is given by a person. */
  subject: string;
  /** How it was obtained, in the words of whoever obtained it. */
  basis: string;
  givenAt: string;
  capturedBy: string;
};

export type BidOnEvidence = {
  id: string;
  reference: string;
  customerAccountId: string;
  type: EvidenceType;
  title: string;
  /** The content address in the evidence store. */
  hash: string;
  /** The `EvidenceItem` the platform's own chain holds for this file. */
  evidenceItemId: string;
  validFrom?: string;
  expiresOn?: string;
  /** Paragraphs read out of the file. Absent until extraction has run. */
  extractedText?: string[];
  chunks: EvidenceChunk[];
  /** Set once the passages have been embedded. Absent is the ordinary state. */
  semanticModel?: SemanticModel;
  consent?: EvidenceConsent;
  uploadedAt: string;
  uploadedBy: string;
  /** Withdrawn rather than deleted: a bid that cited it still cited it. */
  withdrawnAt?: string;
  withdrawnBy?: string;
  withdrawnReason?: string;
  /**
   * What this record used to say about itself, and why it changed.
   *
   * Every correction, in order, never overwritten. A title is how a reviewer
   * finds a document and how the export names it, so "it used to be called
   * something else" is a fact somebody reading a submission two years later
   * may need — and a field corrected in place tells them nothing.
   */
  corrections?: EvidenceCorrection[];
};

/** One correction to what a filed document says about itself. */
export type EvidenceCorrection = {
  at: string;
  by: string;
  reason: string;
  /** Field by field, what it was and what it became. */
  changed: Record<string, { from: unknown; to: unknown }>;
};

const TITLE_MIN = 4;
const REASON_MIN = 12;
/**
 * The shortest a passage may be and still be worth indexing.
 *
 * Exported because the Reader states it to the model it asks to read a
 * document: a provider told to return anything at all returns headings and
 * single words, and the floor is then enforced twice — once by asking, once by
 * `recordExtraction` dropping what came back anyway.
 */
export const CHUNK_MIN_CHARS = 40;

function requireText(value: string, min: number, code: string, what: string): string {
  const text = value.trim();
  if (text.length < min) throw new DomainError(code, `${what} needs at least ${min} characters`, 400);
  return text;
}

export function evidenceOf(ctx: EngineContext): BidOnEvidence[] {
  return ctx.ledger
    .listByTenant(ctx.tenantId, 'BidOnEvidence')
    .map((record) => record.state as unknown as BidOnEvidence);
}

/**
 * Load one evidence item, refusing it unless this person may see its customer.
 *
 * The customer check is what matters here and it is not optional: an evidence
 * id is a ULID a caller could hold from anywhere, and without this a bid writer
 * assigned to one customer could read another's insurance schedule by id.
 */
export function requireEvidence(ctx: EngineContext, evidenceId: string): BidOnEvidence {
  const record = ctx.ledger.get({ refType: 'BidOnEvidence', refId: evidenceId });
  if (!record || record.tenantId !== ctx.tenantId) {
    throw new DomainError('BID_ON_EVIDENCE_NOT_FOUND', `No evidence ${evidenceId}`, 404);
  }
  const evidence = record.state as unknown as BidOnEvidence;
  // Throws if this person is not assigned to that customer or a guest of it.
  requireVisibleCustomer(ctx, evidence.customerAccountId);
  return evidence;
}

// --- Filing --------------------------------------------------------------

/**
 * File an evidence item against a customer. `C` on `BID_SERVICES`.
 *
 * The file itself is already in the evidence store at `hash` — uploaded through
 * the platform's own upload route, which refuses bytes that do not hash to the
 * address they claim. This records what it is, whose it is and when it stops
 * being current.
 */
export function fileEvidence(
  ctx: EngineContext,
  input: {
    customerAccountId: string;
    type: EvidenceType;
    title: string;
    hash: string;
    validFrom?: string;
    expiresOn?: string;
    consent?: { subject: string; basis: string };
  },
): BidOnEvidence {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'C', { dataSensitivity: 'COMMERCIAL_L3' });

  const customer = requireVisibleCustomer(ctx, input.customerAccountId);
  if (customer.status === 'CLOSED') {
    throw new DomainError('BID_ON_CUSTOMER_CLOSED', `${customer.reference} is closed.`, 409);
  }

  const title = requireText(input.title, TITLE_MIN, 'BID_ON_TITLE_TOO_SHORT', 'An evidence title');

  if (MUST_EXPIRE.includes(input.type) && !input.expiresOn) {
    throw new DomainError(
      'BID_ON_EXPIRY_REQUIRED',
      `A ${input.type.toLowerCase()} always lapses, so it is filed with the day it stops being current. Without that ` +
        'date nothing can refuse a submission that cites it after it has expired, and a missing expiry is not a ' +
        'blank field — it is a safety check switched off.',
      400,
    );
  }
  if (MUST_CONSENT.includes(input.type) && !input.consent) {
    throw new DomainError(
      'BID_ON_CONSENT_REQUIRED',
      'A CV is a named person’s data going to a buyer under a company’s name. It is filed with that person’s consent ' +
        'and who obtained it, captured now — afterwards the file is already in the library and already citable.',
      400,
    );
  }
  if (input.validFrom && input.expiresOn && input.expiresOn < input.validFrom) {
    throw new DomainError('BID_ON_DATES_REVERSED', 'Evidence cannot expire before it becomes valid', 400);
  }

  // The same file filed twice against one customer is two citations to one
  // document, and a reviewer checking the second one finds the first.
  const existing = evidenceOf(ctx).find(
    (entry) =>
      entry.customerAccountId === input.customerAccountId && entry.hash === input.hash && !entry.withdrawnAt,
  );
  if (existing) {
    throw new DomainError(
      'BID_ON_EVIDENCE_EXISTS',
      `${existing.reference} — ${existing.title} — is the same file, already filed for this customer. Two records ` +
        'of one document is two citations a reviewer has to check separately.',
      409,
    );
  }

  // Through the platform's own evidence chain, so the file is not in a second
  // register beside the one the audit trail already reads.
  const item = registerEvidence(ctx, {
    type: `BID_ON_${input.type}`,
    hash: input.hash,
    description: `${title} — ${customer.legalName}`,
  });

  const id = ulid();
  const evidence: BidOnEvidence = {
    id,
    reference: formatRef('EVD', evidenceOf(ctx).length + 1),
    customerAccountId: input.customerAccountId,
    type: input.type,
    title,
    hash: input.hash,
    evidenceItemId: item.refId,
    ...(input.validFrom ? { validFrom: input.validFrom } : {}),
    ...(input.expiresOn ? { expiresOn: input.expiresOn } : {}),
    chunks: [],
    ...(input.consent
      ? {
          consent: {
            subject: requireText(input.consent.subject, TITLE_MIN, 'BID_ON_TITLE_TOO_SHORT', 'A data subject'),
            basis: requireText(input.consent.basis, REASON_MIN, 'BID_ON_REASON_TOO_SHORT', 'A consent basis'),
            givenAt: new Date().toISOString(),
            capturedBy: ctx.auth.actorId,
          },
        }
      : {}),
    uploadedAt: new Date().toISOString(),
    uploadedBy: ctx.auth.actorId,
  };

  write(ctx, {
    eventType: 'BID_ON_EVIDENCE_FILED',
    entity: { refType: 'BidOnEvidence', refId: id },
    nextState: { ...evidence },
    // The event declares `requiresEvidence`, and the ledger enforces it. An
    // evidence record with no file behind it is a citation that opens to
    // nothing, which is the one thing this library must not be able to hold.
    evidenceRefs: [item],
  });

  return evidence;
}

/**
 * Record what was read out of the file, as retrievable chunks. `U`.
 *
 * Separate from filing, because reading a file is a separate act with its own
 * cost and its own failure mode — and because a document can be filed and
 * cited as an attachment without anything ever being read out of it. A
 * certificate is proof whether or not a model can read the scan.
 *
 * Chunks are what a retriever ranks, so a chunk too short to mean anything is
 * refused: a forty-character fragment ranks against a question as well as a
 * paragraph does and tells a drafter nothing.
 */
export function recordExtraction(
  ctx: EngineContext,
  evidenceId: string,
  input: { extractedText: string[]; chunks: Array<{ text: string; pageRef?: string }> },
): BidOnEvidence {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'U', { dataSensitivity: 'COMMERCIAL_L3' });

  const evidence = requireEvidence(ctx, evidenceId);
  if (evidence.withdrawnAt) {
    throw new DomainError('BID_ON_EVIDENCE_WITHDRAWN', `${evidence.reference} has been withdrawn.`, 409);
  }

  const chunks = input.chunks
    .map((chunk) => ({ ...chunk, text: chunk.text.trim() }))
    .filter((chunk) => chunk.text.length >= CHUNK_MIN_CHARS);
  if (chunks.length === 0) {
    throw new DomainError(
      'BID_ON_NOTHING_EXTRACTED',
      `Nothing usable was read out of ${evidence.reference}. A chunk shorter than ${CHUNK_MIN_CHARS} characters ` +
        'ranks against a question as well as a paragraph does and tells a drafter nothing, so none was kept. The ' +
        'file is unchanged and is still citable as an attachment.',
      422,
    );
  }

  // Re-reading an item replaces its passages, so anything derived from the old
  // ones goes with them. `semanticModel` is dropped rather than kept: the new
  // chunks carry no vector, and an item that says it is embedded while its
  // passages are not is one that silently drops out of every semantic search
  // with nothing to explain why.
  const { semanticModel: _replaced, ...carried } = evidence;
  const next: BidOnEvidence = {
    ...carried,
    extractedText: input.extractedText.map((line) => line.trim()).filter(Boolean),
    chunks: chunks.map((chunk) => ({
      id: ulid(),
      text: chunk.text,
      ...(chunk.pageRef ? { pageRef: chunk.pageRef } : {}),
    })),
  };

  write(ctx, {
    eventType: 'BID_ON_EVIDENCE_EXTRACTED',
    entity: { refType: 'BidOnEvidence', refId: evidenceId },
    nextState: { ...next },
  });

  return next;
}

/**
 * Correct what a filed document says about itself. `U` on `BID_SERVICES`.
 *
 * ## Why this exists
 *
 * The platform had withdrawal and nothing else, so a mistyped title could only
 * be fixed by withdrawing the item and filing it again — which breaks every
 * citation already made against it and leaves two records of one document for a
 * reviewer to reconcile. A tender's appendices are filed in a batch of nine and
 * mistyping one is ordinary: on a real invitation two of them came through as
 * "Appendix 1", and the amendments reading was one paste away from reading the
 * contract particulars and reporting no amendments.
 *
 * ## What cannot be corrected, and why
 *
 * **The hash.** It is the document. Changing it would leave every citation
 * already made pointing at a record that now claims different bytes, which is
 * the one thing the content address exists to prevent. A wrong *file* is a
 * withdrawal and a fresh filing — those are two documents, and the record
 * should say so.
 *
 * The passages are not corrected here either: re-reading the document replaces
 * them, which is `readEvidence` or `recordExtraction` and is a different act.
 *
 * ## Nothing is overwritten
 *
 * Each correction is appended to `corrections` with what each field was, what
 * it became, who said so and why. A title corrected in place would leave a
 * reviewer unable to tell that the document they are reading used to be filed
 * as something else.
 */
export function correctEvidence(
  ctx: EngineContext,
  evidenceId: string,
  input: { reason: string; title?: string; type?: EvidenceType; validFrom?: string; expiresOn?: string },
): BidOnEvidence {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'U', { dataSensitivity: 'COMMERCIAL_L3' });

  const evidence = requireEvidence(ctx, evidenceId);
  if (evidence.withdrawnAt) {
    throw new DomainError(
      'BID_ON_EVIDENCE_WITHDRAWN',
      `${evidence.reference} has been withdrawn. Correcting what a withdrawn item says about itself would change a ` +
        'record nothing may cite, and leave the reason it was withdrawn describing a document that no longer reads ' +
        'the same way.',
      409,
    );
  }

  const reason = requireText(input.reason, REASON_MIN, 'BID_ON_REASON_TOO_SHORT', 'A correction reason');
  const title = input.title === undefined ? evidence.title : requireText(input.title, TITLE_MIN, 'BID_ON_TITLE_TOO_SHORT', 'An evidence title');
  const type = input.type ?? evidence.type;
  const validFrom = input.validFrom === undefined ? evidence.validFrom : input.validFrom.trim() || undefined;
  const expiresOn = input.expiresOn === undefined ? evidence.expiresOn : input.expiresOn.trim() || undefined;

  // The filing rules hold on a correction too. A `CERTIFICATE` reclassified
  // from `OTHER` without the day it lapses is the same safety check switched
  // off, arrived at by a different route.
  if (MUST_EXPIRE.includes(type) && !expiresOn) {
    throw new DomainError(
      'BID_ON_EXPIRY_REQUIRED',
      `A ${type.toLowerCase()} always lapses, so it is filed with the day it stops being current. Correct the ` +
        'expiry in the same act as the kind, or nothing can refuse a submission that cites it after it has expired.',
      400,
    );
  }
  if (validFrom && expiresOn && expiresOn < validFrom) {
    throw new DomainError('BID_ON_DATES_REVERSED', 'Evidence cannot expire before it becomes valid', 400);
  }

  const changed: Record<string, { from: unknown; to: unknown }> = {};
  if (title !== evidence.title) changed.title = { from: evidence.title, to: title };
  if (type !== evidence.type) changed.type = { from: evidence.type, to: type };
  if (validFrom !== evidence.validFrom) changed.validFrom = { from: evidence.validFrom, to: validFrom };
  if (expiresOn !== evidence.expiresOn) changed.expiresOn = { from: evidence.expiresOn, to: expiresOn };

  if (Object.keys(changed).length === 0) {
    // Refused by name rather than left to the ledger's own no-op refusal, which
    // would say nothing about what the caller was trying to do.
    throw new DomainError(
      'BID_ON_NOTHING_CORRECTED',
      `Nothing about ${evidence.reference} would change. A correction that corrects nothing still appends a reason ` +
        'to the record, which later reads as a decision somebody took about this document.',
      409,
    );
  }

  const next: BidOnEvidence = {
    ...evidence,
    title,
    type,
    ...(validFrom ? { validFrom } : {}),
    ...(expiresOn ? { expiresOn } : {}),
    corrections: [
      ...(evidence.corrections ?? []),
      { at: new Date().toISOString(), by: ctx.auth.actorId, reason, changed },
    ],
  };
  // A date cleared is a date gone from the record, not an empty string on it.
  if (!validFrom) delete next.validFrom;
  if (!expiresOn) delete next.expiresOn;

  write(ctx, {
    eventType: 'BID_ON_EVIDENCE_CORRECTED',
    entity: { refType: 'BidOnEvidence', refId: evidenceId },
    nextState: { ...next },
  });

  return next;
}

/** Take an item out of use. Withdrawn, never deleted: a bid that cited it still did. */
export function withdrawEvidence(
  ctx: EngineContext,
  evidenceId: string,
  input: { reason: string },
): BidOnEvidence {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'U', { dataSensitivity: 'COMMERCIAL_L3' });

  const evidence = requireEvidence(ctx, evidenceId);
  if (evidence.withdrawnAt) {
    throw new DomainError('BID_ON_EVIDENCE_WITHDRAWN', `${evidence.reference} is already withdrawn.`, 409);
  }

  const withdrawn: BidOnEvidence = {
    ...evidence,
    withdrawnAt: new Date().toISOString(),
    withdrawnBy: ctx.auth.actorId,
    withdrawnReason: requireText(input.reason, REASON_MIN, 'BID_ON_REASON_TOO_SHORT', 'A reason'),
  };

  write(ctx, {
    eventType: 'BID_ON_EVIDENCE_WITHDRAWN',
    entity: { refType: 'BidOnEvidence', refId: evidenceId },
    nextState: { ...withdrawn },
  });

  return withdrawn;
}

// --- Reads ---------------------------------------------------------------

/** Whether an item is usable on a submission read on a given day. */
export function evidenceCurrentOn(evidence: BidOnEvidence, asAt: string): boolean {
  if (evidence.withdrawnAt) return false;
  const day = asAt.slice(0, 10);
  if (evidence.validFrom && evidence.validFrom.slice(0, 10) > day) return false;
  if (evidence.expiresOn && evidence.expiresOn.slice(0, 10) < day) return false;
  return true;
}

export type EvidenceSummary = Omit<BidOnEvidence, 'extractedText' | 'chunks'> & {
  chunkCount: number;
  extracted: boolean;
  currentNow: boolean;
  /** Days until it lapses, where it does. Negative means it already has. */
  daysLeft: number | null;
};

export type EvidenceLibrary = {
  evidence: EvidenceSummary[];
  byType: Array<{ type: EvidenceType; held: number; current: number }>;
  limits: string[];
  summary: string;
};

/**
 * One customer's library, and nobody else's.
 *
 * The customer is a required argument rather than an optional filter. An
 * optional filter is one forgotten parameter away from returning the provider's
 * whole book, and the one place it would be forgotten is the retriever.
 */
export function evidenceLibrary(
  ctx: EngineContext,
  customerAccountId: string,
  filter: { type?: EvidenceType; expiringWithinDays?: number; asAt?: string } = {},
): EvidenceLibrary {
  requireModuleReadable(ctx.grantedModules, ctx.heldModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  requireVisibleCustomer(ctx, customerAccountId);
  const day = (filter.asAt ?? new Date().toISOString()).slice(0, 10);

  const mine = evidenceOf(ctx).filter((entry) => entry.customerAccountId === customerAccountId);
  const summarise = (entry: BidOnEvidence): EvidenceSummary => {
    const { extractedText: _text, chunks, ...rest } = entry;
    return {
      ...rest,
      chunkCount: chunks.length,
      extracted: chunks.length > 0,
      currentNow: evidenceCurrentOn(entry, day),
      daysLeft: entry.expiresOn
        ? Math.ceil((Date.parse(entry.expiresOn.slice(0, 10)) - Date.parse(day)) / 86_400_000)
        : null,
    };
  };

  let evidence = mine.map(summarise);
  if (filter.type) evidence = evidence.filter((entry) => entry.type === filter.type);
  if (filter.expiringWithinDays !== undefined) {
    evidence = evidence.filter(
      (entry) => entry.daysLeft !== null && entry.daysLeft <= filter.expiringWithinDays!,
    );
  }
  evidence.sort((a, b) => a.type.localeCompare(b.type) || a.title.localeCompare(b.title));

  const byType = EVIDENCE_TYPE.map((type) => ({
    type,
    held: mine.filter((entry) => entry.type === type && !entry.withdrawnAt).length,
    current: mine.filter((entry) => entry.type === type && evidenceCurrentOn(entry, day)).length,
  })).filter((row) => row.held > 0);

  const limits: string[] = [];
  const lapsed = mine.filter((entry) => !entry.withdrawnAt && entry.expiresOn && entry.expiresOn < day);
  if (lapsed.length > 0) {
    limits.push(
      `${lapsed.length} item(s) have lapsed: ${lapsed.map((entry) => entry.reference).join(', ')}. An answer citing ` +
        'one is a hard red, because evidence that is not current on the day the buyer reads it is not evidence.',
    );
  }
  const unread = mine.filter((entry) => !entry.withdrawnAt && entry.chunks.length === 0);
  if (unread.length > 0) {
    limits.push(
      `${unread.length} item(s) have had nothing read out of them, so a drafter cannot cite a passage from them. ` +
        'They are still attachable as documents.',
    );
  }
  const unembedded = mine.filter(
    (entry) => !entry.withdrawnAt && entry.chunks.length > 0 && !entry.semanticModel,
  );
  if (unembedded.length > 0) {
    limits.push(
      `${unembedded.length} item(s) with passages are not embedded, so they are found by distinctive-term overlap ` +
        'rather than by meaning: a passage that answers a question in other words will be missed. Embedding them is ' +
        'a one-off cost per item and is quoted before it runs.',
    );
  }

  return {
    evidence,
    byType,
    limits,
    summary:
      mine.length === 0
        ? 'Nothing filed for this customer yet. The library is what every answer is drafted from, so it is the first ' +
          'thing to build and the thing that makes the second bid faster than the first.'
        : `${mine.filter((entry) => evidenceCurrentOn(entry, day)).length} current item(s) of ${mine.length} filed.`,
  };
}

export type RetrievedChunk = {
  evidenceId: string;
  reference: string;
  title: string;
  type: EvidenceType;
  chunkId: string;
  text: string;
  pageRef?: string;
  expiresOn?: string;
  /** How well it matched, 0–1. Cosine similarity, or term overlap. */
  score: number;
};

/** How a result was ranked. On every answer, because the two are not equivalent. */
export type RetrievalMethod = 'EMBEDDING' | 'TERM_OVERLAP';

export type Retrieval = {
  chunks: RetrievedChunk[];
  considered: number;
  method: RetrievalMethod;
  /** The model whose space the comparison was made in, on the semantic path. */
  model?: string;
  /**
   * Passages excluded because they are in no space, or in another model's.
   *
   * Counted and named rather than quietly dropped. A semantic search that
   * silently ignores half a library looks like a library half the size, and the
   * remedy — embed the rest — is only obvious to somebody told the passages
   * exist.
   */
  skipped: number;
  note: string;
  /**
   * The same finding with none of the plumbing in it, for a customer to read.
   *
   * `note` is written for the provider and names the ranking method, the model
   * and how many passages were skipped. None of that belongs in a message to
   * the contractor whose evidence it is: "embed this library to rank by
   * meaning" is an instruction to the provider, and putting it in front of a
   * customer is both confusing and an admission of an internal setting they
   * cannot act on. So the gap-raising paths quote this instead.
   */
  clientNote: string;
};

/**
 * What this customer's library has for one question.
 *
 * Three rules, and the first is the one the acceptance criterion names.
 *
 * **It filters on the customer before it ranks.** Not after, and not in the
 * caller. One customer's material can never appear in another customer's
 * answer, and the only way to be sure of that is for the function that does the
 * ranking to take the customer as an argument it cannot ignore.
 *
 * **Expired evidence is not offered.** Judged against the bid's deadline rather
 * than today, because that is the day the buyer reads it. A certificate that
 * lapses the week before return is not evidence for that submission, and
 * offering it to a drafter is how it ends up cited.
 *
 * **Below a floor, nothing comes back.** Ranking always returns the
 * nearest neighbours, and the nearest of several irrelevant passages reads
 * exactly like a relevant one once a model has written a paragraph from it.
 * Returning nothing is what makes a gap a gap instead of a confident wrong
 * answer, and the gap is the thing the customer can actually fix.
 *
 * ## Two ways of ranking, and neither pretends to be the other
 *
 * Given a `queryVector` this is semantic search: cosine similarity against the
 * passages' own embeddings, floored at `MINIMUM_SIMILARITY`, comparing only
 * within one model's space. Given none it is distinctive-term overlap, floored
 * at `MINIMUM_MATCH`. `method` is on every answer and the note says which ran,
 * because the whole argument in `datalayer/embedding.ts` is that a cheaper
 * answer wearing the expensive one's clothes is worse than no answer: term
 * overlap is a real and useful thing to offer, and calling it semantic search
 * would not be.
 *
 * The query vector is supplied rather than obtained here on purpose. Embedding
 * costs money, so the call that spends it is `engine.retrieveSemantic`, which
 * is quoted and metered like every other model call; this function stays a read
 * that spends nothing and can therefore be called by a screen.
 */
export function retrieveFor(
  ctx: EngineContext,
  input: {
    customerAccountId: string;
    question: string;
    /** The day the buyer reads it. Expiry is judged against this. */
    asAt: string;
    types?: EvidenceType[];
    limit?: number;
    /** The question's embedding. Its presence is what selects semantic search. */
    queryVector?: number[];
    /** The space that vector is in. Only passages in the same one are compared. */
    queryModel?: { provider: string; modelClass: string };
  },
): Retrieval {
  requireModuleReadable(ctx.grantedModules, ctx.heldModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  requireVisibleCustomer(ctx, input.customerAccountId);

  // The filter, before anything is ranked.
  const usable = evidenceOf(ctx)
    .filter((entry) => entry.customerAccountId === input.customerAccountId)
    .filter((entry) => evidenceCurrentOn(entry, input.asAt))
    .filter((entry) => !input.types || input.types.includes(entry.type));

  const semantic = input.queryVector !== undefined && input.queryVector.length > 0;
  const method: RetrievalMethod = semantic ? 'EMBEDDING' : 'TERM_OVERLAP';
  const floor = semantic ? MINIMUM_SIMILARITY : MINIMUM_MATCH;
  const terms = semantic ? [] : distinctTerms(input.question);

  const scored: RetrievedChunk[] = [];
  let considered = 0;
  let skipped = 0;

  for (const evidence of usable) {
    // On the semantic path, an item embedded by another model is not comparable
    // at all. Skipped by name rather than scored, because a cosine between two
    // models' vectors is not a weaker score — it is a number with no meaning
    // that sorts beside real ones.
    const comparable =
      !semantic ||
      (evidence.semanticModel !== undefined &&
        (input.queryModel === undefined ||
          (evidence.semanticModel.provider === input.queryModel.provider &&
            evidence.semanticModel.modelClass === input.queryModel.modelClass)));

    for (const chunk of evidence.chunks) {
      if (semantic && (!comparable || !chunk.vector || chunk.vector.length !== input.queryVector!.length)) {
        skipped += 1;
        continue;
      }
      considered += 1;
      const score = semantic
        ? Math.round(cosine(input.queryVector!, chunk.vector!) * 1000) / 1000
        : overlap(terms, chunk.text);
      if (score < floor) continue;
      scored.push({
        evidenceId: evidence.id,
        reference: evidence.reference,
        title: evidence.title,
        type: evidence.type,
        chunkId: chunk.id,
        text: chunk.text,
        ...(chunk.pageRef ? { pageRef: chunk.pageRef } : {}),
        ...(evidence.expiresOn ? { expiresOn: evidence.expiresOn } : {}),
        score,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const chunks = scored.slice(0, input.limit ?? 8);

  const how = semantic
    ? `Ranked by meaning against ${input.queryModel?.modelClass ?? 'the configured embedding model'}.`
    : 'Ranked on distinctive-term overlap, which is not semantic search and is not presented as it: a passage that ' +
      'answers the question in other words will not be found. Embed this library to rank by meaning.';

  const left =
    skipped > 0
      ? ` ${skipped} passage(s) were not compared because they are not embedded, or are embedded by a different ` +
        'model and are therefore in a different space. Embed them and they come into this search.'
      : '';

  const found =
    chunks.length === 0
      ? considered === 0
        ? 'This customer has no readable evidence that is current on the deadline, so there is nothing to draft ' +
          'from. That is a gap to ask them for rather than a question to answer from general knowledge.'
        : `Nothing in ${considered} passage(s) matched this question closely enough to cite. Ranking always ` +
          'returns the nearest passages, and the nearest of several irrelevant ones reads exactly like a relevant ' +
          'one once a model has written a paragraph from it — so this returns nothing instead, which is what ' +
          'makes it a gap the customer can fix.'
      : `${chunks.length} passage(s) of ${considered} considered, every one from this customer and current on the ` +
        'deadline.';

  return {
    chunks,
    considered,
    method,
    ...(semantic && input.queryModel ? { model: `${input.queryModel.provider}/${input.queryModel.modelClass}` } : {}),
    skipped,
    note: `${found} ${how}${left}`,
    // The finding alone. No ranking method, no model, no skipped count — a
    // contractor cannot act on any of those and should not be shown them.
    clientNote:
      chunks.length === 0
        ? considered === 0
          ? 'We hold nothing on file for you that is current on the day this is returned.'
          : 'Nothing on file is close enough to this question for us to cite it.'
        : found,
  };
}

/**
 * The term-overlap floor: the share of a question's distinctive words a passage
 * has to actually use.
 *
 * This is the floor on the path that runs with **no embedding provider
 * configured**, which is the ordinary state of a deployment that has not turned
 * semantic search on. It is weaker than the semantic path and is never dressed
 * up as it — `method` says `TERM_OVERLAP` and the note says a passage that
 * answers the question in other words will not be found.
 *
 * The floor matters more than which path is in use. A retriever with no floor
 * returns neighbours whatever the corpus holds, and a drafter handed the least
 * irrelevant passage in the library writes a confident paragraph from it. Both
 * paths have one: this, and `MINIMUM_SIMILARITY` from the platform's own vector
 * index, which is reused rather than restated so the two cannot drift.
 */
const MINIMUM_MATCH = 0.2;

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'your', 'you', 'please', 'provide', 'detail', 'details', 'describe', 'how', 'what',
  'that', 'this', 'from', 'have', 'has', 'are', 'any', 'all', 'will', 'would', 'must', 'should', 'within', 'their',
  'our', 'its', 'been', 'where', 'which', 'when', 'who', 'whom', 'about', 'into', 'over', 'under', 'per', 'can',
  'does', 'did', 'not', 'may', 'each', 'other', 'than', 'then', 'there', 'they', 'them', 'also', 'such', 'these',
]);

/**
 * The words in a question worth matching on.
 *
 * Exported because the carry-forward matches one question's wording against
 * another's and must do it the same way retrieval matches a question against a
 * passage. Two implementations of "distinctive terms" would mean a question
 * that retrieves evidence well and finds no prior answer, for no reason a
 * reader could discover.
 */
export function distinctTerms(text: string): string[] {
  return [
    ...new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((word) => word.length >= 4 && !STOPWORDS.has(word)),
    ),
  ];
}

/** The share of the question's distinctive terms a passage actually uses. */
export function overlap(terms: string[], text: string): number {
  if (terms.length === 0) return 0;
  const body = text.toLowerCase();
  const found = terms.filter((term) => body.includes(term)).length;
  return Math.round((found / terms.length) * 100) / 100;
}
