import { DomainError } from '../../core/errors.ts';
import { authorise, write, type EngineContext } from '../../engines/context.ts';
import { requireModule, requireModuleReadable } from '../../identity/modules.ts';
import { deadlineInForce } from '../tenderintake.ts';
import { maySeeCustomer, type CustomerAccount } from './customers.ts';
import { requireOpenEngagement } from './engagements.ts';
import { createBid, requireBid, type Bid, type BidQuestion, type SourceDigest } from './bids.ts';

/**
 * Importing a tender the standard section already holds.
 *
 * ## Why this is a shortcut and never a requirement
 *
 * Bid-On works on its own: a bid can be started from a questionnaire uploaded
 * here, with no tender in the standard section at all, and such a bid never
 * appears there. This exists so that a provider whose customer's tender is
 * *already* recorded does not upload the same questionnaire twice — nothing
 * more.
 * Both routes produce the same bid and use the same agents, review and export,
 * which is what makes the shortcut safe to skip.
 *
 * ## The import is one-way, and that is the load-bearing decision
 *
 * Bid-On copies what it needs and links back. It never writes to the source
 * tender, and nothing in the standard section is aware this happened. The
 * reason is not tidiness:
 *
 * **A bid in progress must not change underneath somebody.** If the bid read
 * the source live, editing a deadline in the standard section would move every
 * certificate-expiry verdict in the pack without anybody touching the bid, and
 * removing a document from the invitation would change what the bid says it was
 * answering. So the fields are copied at import, and the files are taken by
 * their content address, which the evidence store makes immutable: the bytes
 * cannot change under a hash, so what the bid holds cannot be edited out from
 * the other side.
 *
 * **What a "document" is here, exactly.** The invitation's `documents` field is
 * the transmittal's own list in words — "Pricing schedule, native spreadsheet"
 * — and a description is not a file. Files arrive separately through
 * `recordTenderDocument`, and the import carries the ones that section linked to
 * the invitation, as hashes, which is what lets `parseQuestionnaire` read the
 * pack without anybody uploading it again. Where none is linked, the import
 * carries the record and says plainly that the questionnaire itself still has to
 * be given to the parser. Claiming otherwise would be the more comfortable
 * sentence and a false one.
 *
 * **A change at source is a banner, not a re-parse.** `sourceDigest` records
 * what the tender looked like when it was imported. When it no longer matches,
 * the bid says so and waits: nothing re-parses until a person presses resync,
 * because a silent re-parse would overwrite approved answers with drafts, and
 * an approved answer is one somebody put their name to.
 *
 * **On resync, approved answers survive.** Only questions whose *wording*
 * changed go back to draft. A question whose number moved, or whose section
 * heading was retyped, is the same question — and throwing away a good answer
 * because a buyer fixed a typo is how a resync becomes something nobody dares
 * press.
 */

/**
 * The invitation as the standard section records it.
 *
 * Narrow on purpose: these are the only fields Bid-On reads, and spelling them
 * out is what makes it checkable that the import touches nothing else. The
 * authority on the shape is `recordInvitation` in `domain/tenderintake.ts`.
 */
type InvitationState = {
  id: string;
  reference?: string;
  clientName?: string;
  title?: string;
  issue?: { documents?: string[] };
  addenda?: unknown[];
};

/**
 * The invitation, read through the standard section's own authorisation.
 *
 * `authorise(ESTIMATE_TENDER, 'R')` is the specification's access rule —
 * *"the user must already have read access to that tender in the standard
 * section"* — and it is checked here rather than assumed from holding
 * `BID_SERVICES`.
 *
 * The two are not the same grant. Every *role* that carries `BID_SERVICES`
 * happens also to carry `ESTIMATE_TENDER` `R` today, so for a person signed in
 * at a seat the check passes quietly — but the scopes differ
 * (`bidservices:read` against `commercial:read`), so a token issued for Bid-On
 * is refused here, which `bidonimport.test.ts` pins down. Inferring one from
 * the other would turn the module into a way around the standard section's own
 * permissions, and it would do it silently the day a role is added that holds
 * one and not the other.
 */
function requireInvitation(ctx: EngineContext, tenderId: string): InvitationState {
  authorise(ctx, 'ESTIMATE_TENDER', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const record = ctx.ledger.get({ refType: 'TenderInvitation', refId: tenderId });
  if (!record || record.tenantId !== ctx.tenantId) {
    // Same tenant only, and a 404 rather than a denial: a tender in another
    // tenancy is not a permission this tenancy could be granted.
    throw new DomainError('BID_ON_TENDER_NOT_FOUND', `No tender invitation ${tenderId} in this tenancy`, 404);
  }
  return record.state as unknown as InvitationState;
}

/**
 * The reading, taken from the invitation as it stands.
 *
 * The deadline comes from `deadlineInForce`, not from the issue, which is the
 * standard section's own rule: an addendum that moves the return date supersedes
 * the invitation without rewriting it. Reading `issue.returnDeadline` here would
 * judge every certificate in the pack against a date the buyer has already
 * moved.
 */
function digestOf(
  invitation: InvitationState,
  index: TenderFileIndex,
): Omit<SourceDigest, 'takenAt' | 'questionWording'> {
  const deadline = invitation.issue
    ? deadlineInForce(invitation as unknown as Record<string, unknown>)
    : undefined;
  return {
    reference: String(invitation.reference ?? ''),
    clientName: String(invitation.clientName ?? ''),
    title: String(invitation.title ?? ''),
    deadline: String(deadline?.instant ?? '').slice(0, 10),
    // Sorted, so that the same set of documents in a different order is not
    // reported as a change at source.
    documents: [...(invitation.issue?.documents ?? [])].map(String).sort(),
    files: index.get(invitation.id)?.length ?? 0,
    addenda: (invitation.addenda ?? []).length,
  };
}

/**
 * What has moved between the reading a bid holds and the tender as it stands.
 *
 * One function, used by the module screen and by the per-bid read, so the
 * banner on the register and the banner on the pack cannot disagree about
 * whether a resync is outstanding.
 *
 * Only the fields a bid actually depends on. A note retyped in the standard
 * section is not drift: reporting it would train people to ignore the banner,
 * and the banner's whole job is to be believed the one time it matters.
 */
function compareDigest(
  was: SourceDigest,
  now: Omit<SourceDigest, 'takenAt' | 'questionWording'>,
): Array<{ field: string; was: string; now: string }> {
  const changed: Array<{ field: string; was: string; now: string }> = [];
  if (now.deadline !== was.deadline) changed.push({ field: 'deadline', was: was.deadline, now: now.deadline });
  if (now.clientName !== was.clientName) changed.push({ field: 'buyer', was: was.clientName, now: now.clientName });
  if (now.reference !== was.reference) changed.push({ field: 'reference', was: was.reference, now: now.reference });
  if (now.addenda !== was.addenda) {
    changed.push({ field: 'addenda', was: String(was.addenda), now: String(now.addenda) });
  }
  // Added documents only. A document the standard section has since removed is
  // still in the pack by content address and still cited by an approved answer,
  // and calling that drift would ask somebody to resync away their own evidence.
  const added = now.documents.filter((document) => !was.documents.includes(document));
  if (added.length > 0) {
    changed.push({ field: 'documents', was: `${was.documents.length} copied`, now: `${added.length} new` });
  }
  // A file registered against the invitation after the import is a pack the
  // parser could read without anybody uploading anything, and nothing else
  // would ever tell somebody it had arrived.
  if (now.files > was.files) {
    changed.push({ field: 'files', was: `${was.files} carried`, now: `${now.files} in the store` });
  }
  return changed;
}

export type SourceFile = { hash: string; description: string };
type TenderFileIndex = Map<string, SourceFile[]>;

/**
 * Every registered tender document in the tenancy, by the invitation it was
 * filed against.
 *
 * Read from the evidence registry's own `linkedEntities` and never inferred
 * from a project and a type. Inferring would gather every tender document in
 * the tenancy and attach another buyer's pack to this bid — which in a module
 * built to keep one customer's material away from another is the one mistake
 * that must not be possible.
 *
 * Built in one pass and handed to every invitation on a listing, because
 * resolving it per tender would scan the whole registry once per row.
 */
function tenderFileIndex(ctx: EngineContext): TenderFileIndex {
  const index: TenderFileIndex = new Map();
  for (const record of ctx.ledger.listByTenant(ctx.tenantId, 'EvidenceItem')) {
    const item = record.state as unknown as {
      type?: string;
      hash?: string;
      description?: string;
      linkedEntities?: Array<{ refType?: string; refId?: string }>;
    };
    if (item.type !== 'TENDER_DOCUMENT' || typeof item.hash !== 'string') continue;
    for (const link of item.linkedEntities ?? []) {
      if (link.refType !== 'TenderInvitation' || !link.refId) continue;
      const file: SourceFile = {
        hash: item.hash,
        description: String(item.description ?? 'Tender document'),
      };
      index.set(link.refId, [...(index.get(link.refId) ?? []), file]);
    }
  }
  return index;
}

export type ImportableTender = {
  tenderId: string;
  reference: string;
  clientName: string;
  title: string;
  deadline: string;
  documents: string[];
  /** Files in the evidence store linked to this invitation, which the import carries. */
  files: number;
  addenda: number;
  /** Bids already imported from it, so a second import is a choice not an accident. */
  importedAs: Array<{
    bidId: string;
    reference: string;
    status: string;
    /** Whether this bid's reading of the tender is now out of date. */
    sourceChanged: boolean;
    /** What moved, in the words the banner uses. Empty where nothing did. */
    changed: Array<{ field: string; was: string; now: string }>;
  }>;
};

/**
 * Every standard tender this person could import, with what is already imported
 * from each.
 *
 * The `importedAs` list is why this is not a plain lookup. One tender is
 * legitimately imported more than once — a prequalification stage and a later
 * ITT stage are two bids off one invitation — so a duplicate is not refused.
 * What it must not be is accidental, and the only thing that prevents that is
 * showing what already exists at the moment somebody chooses.
 */
export function importableTenders(
  ctx: EngineContext,
  filter: { search?: string } = {},
): { tenders: ImportableTender[]; limits: string[]; summary: string } {
  requireModuleReadable(ctx.grantedModules, ctx.heldModules, 'BID_ON');
  authorise(ctx, 'ESTIMATE_TENDER', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  // The customers this person is assigned to, because `importedAs` names a bid
  // and a bid belongs to a customer. Without this filter the screen would say
  // "already imported as BON-0007" for a competitor's bid, which is exactly the
  // leak the module exists to prevent — the reference and the buyer together
  // are enough to know a rival is bidding the same framework.
  const visible = new Set(
    ctx.ledger
      .listByTenant(ctx.tenantId, 'BidOnCustomer')
      .map((record) => record.state as unknown as CustomerAccount)
      .filter((customer) => maySeeCustomer(customer, ctx.auth.actorId))
      .map((customer) => customer.id),
  );

  const all = ctx.ledger
    .listByTenant(ctx.tenantId, 'BidOnBid')
    .map((record) => record.state as unknown as Bid)
    .filter((bid) => bid.sourceTenderId);
  const imported = all.filter((bid) => visible.has(bid.customerAccountId));

  // One pass over the registry for the whole listing rather than one per row.
  const files = tenderFileIndex(ctx);

  const search = (filter.search ?? '').trim().toLowerCase();
  const tenders = ctx.ledger
    .list(`${ctx.tenantId}-governance`, 'TenderInvitation')
    .map((record) => record.state as unknown as InvitationState)
    .map((invitation) => {
      const digest = digestOf(invitation, files);
      return {
        tenderId: invitation.id,
        ...digest,
        importedAs: imported
          .filter((bid) => bid.sourceTenderId === invitation.id)
          .map((bid) => {
            // Computed here rather than left to a read per bid, so that the
            // banner is on the screen somebody is already looking at. A
            // notification nobody opens the pack to see is a notification that
            // did not happen.
            const changed = bid.sourceDigest ? compareDigest(bid.sourceDigest, digest) : [];
            return {
              bidId: bid.id,
              reference: bid.reference,
              status: bid.status,
              sourceChanged: changed.length > 0,
              changed,
            };
          }),
      };
    })
    .filter((tender) =>
      search
        ? `${tender.reference} ${tender.clientName} ${tender.title}`.toLowerCase().includes(search)
        : true,
    )
    .sort((a, b) => a.deadline.localeCompare(b.deadline));

  const limits: string[] = [
    'Importing copies what Bid-On needs and links back. It never writes to the tender, and a later change there ' +
      'cannot alter a bid in progress.',
  ];
  const fileless = tenders.filter((tender) => tender.files === 0).length;
  if (fileless > 0) {
    limits.push(
      `${fileless} of these have no file registered against them in the standard section — only the transmittal's ` +
        'list of what it contained, in words. Importing one carries that record and the deadline, and the ' +
        'questionnaire itself still has to be given to the parser as text or as a file.',
    );
  }
  const already = tenders.filter((tender) => tender.importedAs.length > 0).length;
  if (already > 0) {
    limits.push(
      `${already} of these have already been imported. A second import is allowed — a prequalification stage and a ` +
        'later ITT stage are two bids off one invitation — so check the column before starting another.',
    );
  }
  const hidden = all.length - imported.length;
  if (hidden > 0) {
    limits.push(
      `${hidden} bid(s) imported from these tenders belong to customers you are not assigned to and are not shown ` +
        'in the imported column. A tender may therefore read as un-imported when it is not.',
    );
  }
  const drifted = tenders.flatMap((tender) => tender.importedAs).filter((entry) => entry.sourceChanged).length;
  if (drifted > 0) {
    limits.push(
      `${drifted} imported bid(s) are working from a reading of the tender that has since changed. Nothing has ` +
        're-parsed: resync each one when you are ready, and approved answers are kept.',
    );
  }

  return {
    tenders,
    limits,
    summary:
      tenders.length === 0
        ? 'No invitation is recorded in the standard section. A bid can be started here from a questionnaire ' +
          'instead; importing is a shortcut, not a requirement.'
        : `${tenders.length} invitation(s) available to import.`,
  };
}

/**
 * Create a bid from a standard tender. `C` on `BID_SERVICES`.
 *
 * Two things are carried: the transmittal's list of what it contained, as the
 * invitation recorded it in words, and the **hashes** of any files the standard
 * section registered against that invitation. The hashes are what make this
 * worth doing — `parseQuestionnaire` takes one, so the pack can be read without
 * anybody uploading it a second time, and bytes cannot change under a hash.
 *
 * `note` says which of the two happened, because a tender with no file
 * registered produces a bid that still needs the questionnaire given to the
 * parser, and somebody has to be told that at the moment they import rather
 * than when the parse refuses.
 */
export function importBid(
  ctx: EngineContext,
  input: { tenderId: string; engagementId: string; documentIds?: string[]; scheme?: Bid['scheme'] },
): {
  bid: Bid;
  copied: string[];
  files: Array<{ hash: string; description: string }>;
  /** Whether it produced a rolling submission, because the two behave differently. */
  rolling: boolean;
  note: string;
} {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'C', { dataSensitivity: 'COMMERCIAL_L3' });

  const invitation = requireInvitation(ctx, input.tenderId);
  requireOpenEngagement(ctx, input.engagementId);

  const index = tenderFileIndex(ctx);
  /*
   * No deadline recorded is not an error any more.
   *
   * It used to be refused, on the reasoning that every certificate-expiry check
   * in a pack is judged against a return date. That reasoning holds for an ITT
   * and is wrong for the thing the standard section increasingly records: a
   * dynamic market under the Procurement Act accepts applications at any point
   * in its life and has no return date to record. Refusing the import left the
   * only options as inventing a date or not using the module.
   *
   * So a tender with no deadline imports as a **rolling** bid, judged against
   * the day it is read. The import says which it produced, because the two
   * behave differently for the rest of the bid's life.
   */
  const digest = digestOf(invitation, index);
  const rolling = digest.deadline === '';

  // The documents to carry over: the ones named, or all of them.
  const available = digest.documents;
  const copied = input.documentIds?.length
    ? available.filter((document) => input.documentIds!.includes(document))
    : available;
  if (input.documentIds?.length && copied.length === 0) {
    throw new DomainError(
      'BID_ON_DOCUMENTS_NOT_FOUND',
      'None of the named documents is on that invitation. Importing with nothing would produce a bid with no ' +
        'questionnaire to read.',
      400,
    );
  }

  const bid = createBid(ctx, {
    engagementId: input.engagementId,
    buyerName: digest.clientName || digest.reference || 'Unnamed buyer',
    scheme: input.scheme ?? 'ITT',
    ...(rolling ? { rolling: true as const } : { deadline: digest.deadline }),
    ...(digest.reference ? { buyerReference: digest.reference } : {}),
    sourceTenderId: input.tenderId,
  });

  const files = index.get(input.tenderId) ?? [];

  const imported: Bid = {
    ...bid,
    sourceDigest: { ...digest, documents: copied, takenAt: new Date().toISOString() },
    sourceDocuments: copied,
    ...(files.length > 0 ? { sourceFiles: files } : {}),
  };

  write(ctx, {
    eventType: 'BID_ON_BID_IMPORTED',
    entity: { refType: 'BidOnBid', refId: bid.id },
    nextState: { ...imported },
  });

  return {
    bid: imported,
    copied,
    files,
    rolling,
    note:
      (rolling
        ? `${bid.reference} is a rolling submission: that tender records no return date, so every expiry and ` +
          'declaration in the pack is judged against the day it is read rather than against a date nobody set. '
        : '') +
      (files.length > 0
        ? `${bid.reference} carries ${files.length} file(s) already in the evidence store. Read the questionnaire ` +
          'from one of them — nothing has to be uploaded again.'
        : `${bid.reference} carries the transmittal's list of ${copied.length} document(s). No file is registered ` +
          'against that tender in the standard section, so the questionnaire itself still has to be given to the ' +
          'parser as pasted text or as a file.'),
  };
}

export type SourceStanding = {
  linked: boolean;
  /** Set only where the source has moved since the import. */
  changed?: { field: string; was: string; now: string }[];
  note: string;
};

/**
 * Whether the tender this bid came from has moved since it was imported.
 *
 * A read, and it deliberately changes nothing. The specification: *"a change
 * event from the standard section shows a 'source updated' banner in Bid-On;
 * nothing re-parses until a user clicks resync, so approved answers are never
 * overwritten silently."*
 *
 * Comparing a stored digest rather than subscribing to an event, because the
 * platform has no broker and the comparison is strictly better than a
 * notification would be: a missed event leaves a bid silently stale for ever,
 * while a digest that no longer matches is wrong on every read until somebody
 * acts on it.
 */
export function sourceStanding(ctx: EngineContext, bidId: string): SourceStanding {
  requireModuleReadable(ctx.grantedModules, ctx.heldModules, 'BID_ON');

  const bid = requireBid(ctx, bidId);
  if (!bid.sourceTenderId || !bid.sourceDigest) {
    return {
      linked: false,
      note:
        'This bid was started here rather than imported, so there is no source to drift from. It never appears in ' +
        'the standard Tenders section.',
    };
  }

  const invitation = requireInvitation(ctx, bid.sourceTenderId);
  const was = bid.sourceDigest;
  const changed = compareDigest(was, digestOf(invitation, tenderFileIndex(ctx)));

  if (changed.length === 0) {
    return { linked: true, note: `Unchanged since it was imported on ${was.takenAt.slice(0, 10)}.` };
  }

  return {
    linked: true,
    changed,
    note:
      `The tender has changed since this bid was imported on ${was.takenAt.slice(0, 10)}: ` +
      `${changed.map((entry) => `${entry.field} ${entry.was} → ${entry.now}`).join('; ')}. ` +
      'Nothing has re-parsed. Resync when you are ready — approved answers are kept and only questions whose ' +
      'wording changed go back to draft.',
  };
}

/**
 * Pull the source's changes in. `U` on `BID_SERVICES`.
 *
 * Takes the new question wording as its argument rather than re-reading the
 * documents itself, because re-reading them is a parse and a parse is an AI
 * call with a cost and a confirmation step of its own. The sequence a person
 * follows is: see the banner, re-read the changed document, resync with what it
 * now says. Folding the parse in here would make resync a button that silently
 * spends money.
 *
 * **Approved answers survive.** Only a question whose wording actually changed
 * loses its answers' approval, and the answer versions themselves are kept —
 * nothing is deleted, the latest simply goes back to `IN_REVIEW` so a person
 * reads it against the new wording. A question whose number moved or whose
 * section heading was retyped is the same question, and throwing away a good
 * answer because a buyer fixed a typo is how a resync becomes something nobody
 * dares press.
 */
export function resyncBid(
  ctx: EngineContext,
  bidId: string,
  input: { questions?: Array<{ number: string; text: string }> } = {},
): {
  bid: Bid;
  rewordedQuestions: string[];
  answersReopened: number;
  /** The source gained a return date, so a rolling submission is now a dated one. */
  becameDated: boolean;
  note: string;
} {
  requireModule(ctx.grantedModules, 'BID_ON');
  authorise(ctx, 'BID_SERVICES', 'U', { dataSensitivity: 'COMMERCIAL_L3' });

  const bid = requireBid(ctx, bidId);
  if (!bid.sourceTenderId || !bid.sourceDigest) {
    throw new DomainError(
      'BID_ON_NOT_IMPORTED',
      `${bid.reference} was started here rather than imported, so there is no source to resync from.`,
      409,
    );
  }
  if (['EXPORTED', 'SUBMITTED', 'WON', 'LOST'].includes(bid.status)) {
    throw new DomainError(
      'BID_ON_BID_SENT',
      `${bid.reference} is ${bid.status.toLowerCase()}. Resyncing a pack that has gone would change the record of ` +
        'what was sent.',
      409,
    );
  }
  // A paused engagement freezes everything under it, and a resync moves the
  // deadline and reopens answers — which is a change to the work, not
  // record-keeping about it. The module's rule is that a pause means every bid
  // stays exactly where it was, and an exception here would be a way around it.
  requireOpenEngagement(ctx, bid.engagementId);

  const invitation = requireInvitation(ctx, bid.sourceTenderId);
  const index = tenderFileIndex(ctx);
  const now = digestOf(invitation, index);

  // Which questions the buyer actually reworded. Compared on text against the
  // buyer's own number, which is the only stable identity a question has.
  const wording = new Map((input.questions ?? []).map((question) => [question.number, question.text.trim()]));
  const reworded = bid.questions.filter((question) => {
    const next = wording.get(question.number);
    return next !== undefined && next !== question.text;
  });

  const rewordedIds = new Set(reworded.map((question) => question.id));
  let answersReopened = 0;

  const questions: BidQuestion[] = bid.questions.map((question) =>
    rewordedIds.has(question.id) ? { ...question, text: wording.get(question.number)! } : question,
  );

  // The latest answer to a reworded question goes back for review. Every
  // version is kept: the answer that was approved against the old wording is
  // what a dispute about the old wording would turn on.
  const latestByQuestion = new Map<string, string>();
  for (const answer of bid.answers) {
    const current = latestByQuestion.get(answer.questionId);
    const currentVersion = current ? bid.answers.find((entry) => entry.id === current)!.version : -1;
    if (answer.version > currentVersion) latestByQuestion.set(answer.questionId, answer.id);
  }
  const reopen = new Set(
    [...latestByQuestion.entries()]
      .filter(([questionId]) => rewordedIds.has(questionId))
      .map(([, answerId]) => answerId),
  );

  const answers = bid.answers.map((answer) => {
    if (!reopen.has(answer.id) || answer.status !== 'APPROVED') return answer;
    answersReopened += 1;
    return {
      ...answer,
      status: 'IN_REVIEW' as const,
      reviewNote:
        `${answer.reviewNote ?? ''} — reopened on resync: the buyer reworded this question after it was approved.`.trim(),
    };
  });

  // Files registered against the invitation since the import come with it. A
  // hash the store already holds is the whole reason an import is worth doing,
  // and one that arrived a week later is worth exactly as much.
  const files = index.get(bid.sourceTenderId) ?? [];

  const resynced: Bid = {
    ...bid,
    questions,
    answers,
    ...(files.length > 0 ? { sourceFiles: files } : {}),
    // Only drafting again where something actually moved.
    status: reworded.length > 0 ? 'DRAFTING' : bid.status,
    /*
     * The deadline follows the source, because every expiry verdict in the pack
     * is judged against it and a stale one scores certificates against a date
     * the buyer has moved.
     *
     * Including the transition that matters most: a dynamic market that has
     * since issued a dated tender notice to its members. The bid stops being
     * rolling and becomes dated, which changes what every verdict in it means —
     * a certificate that was current "today" may lapse before the new return
     * date. That is reported in the note rather than left for somebody to
     * notice from a changed column.
     */
    ...(now.deadline
      ? { deadline: now.deadline }
      : bid.deadline
        ? { deadline: bid.deadline }
        : {}),
    ...(now.deadline ? {} : bid.rolling ? { rolling: true as const } : {}),
    sourceDigest: {
      ...now,
      documents: now.documents,
      questionWording: Object.fromEntries(questions.map((question) => [question.number, question.text])),
      takenAt: new Date().toISOString(),
    },
  };

  write(ctx, {
    eventType: 'BID_ON_BID_RESYNCED',
    entity: { refType: 'BidOnBid', refId: bidId },
    nextState: { ...resynced },
  });

  const became = bid.rolling === true && now.deadline !== '';
  return {
    bid: resynced,
    rewordedQuestions: reworded.map((question) => question.number),
    answersReopened,
    becameDated: became,
    note:
      (became
        ? `${bid.reference} was a rolling submission and the source now carries a return date of ${now.deadline}. ` +
          'Every expiry and declaration in the pack is judged against that date from now on instead of against the ' +
          'day it is read, so re-read the certificates: one that was current today may lapse before the return. '
        : '') +
      (reworded.length === 0
        ? 'Nothing was reworded, so no answer was reopened. The deadline, the document list and the files now match ' +
          'the source.'
        : `${reworded.length} question(s) were reworded (${reworded.map((q) => q.number).join(', ')}) and ` +
          `${answersReopened} approved answer(s) went back for review. Every version is kept — the answer approved ` +
          'against the old wording is what a dispute about the old wording would turn on.'),
  };
}
