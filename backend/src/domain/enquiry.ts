import { hashEvidence } from '../core/canonical.ts';
import { DomainError, ForbiddenError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { authorise, currentPhase, registerEvidence, write, type EngineContext } from '../engines/context.ts';
import type { CapabilityArea } from '../identity/roles.ts';
import type { EntityRecord } from '../goldenthread/ledger.ts';
import { tenderReadinessFor } from './designbaseline.ts';

/**
 * The enquiry pack, who it went to, and the workspace that closes — T-WF-04.
 *
 * The RFQ already existed and is not rebuilt: eligibility against the supplier
 * register, design maturity governing the pricing basis, acknowledgements, and
 * the reconciliation of who was asked against who answered. What did not exist
 * is the part that decides whether a comparison is defensible at all.
 *
 * **A pack has revisions, and the bid was priced against one of them.** An
 * addendum goes out on the Tuesday and two of five bidders price the Monday
 * pack. Nothing in the returns says so. The comparison then ranks five prices
 * for two different scopes, and the cheapest is cheapest because it is pricing
 * less work. `AC-T-WF-04-01`: every recipient's issue record names the exact
 * revision and its content hash, so which pack a firm actually holds is a fact
 * rather than an assumption.
 *
 * **A bidder sees their own package and nothing else.** `AC-T-WF-04-02`. Not a
 * filter applied when rendering a page — a refusal in the domain, because the
 * commercially fatal disclosure is one bidder learning who else was asked.
 *
 * **The return period closes, and the late return goes through a person.**
 * `AC-T-WF-04-03`. A workspace that silently accepts a return after the
 * deadline is a workspace that cannot say whether it did, and "we took it
 * because they rang" is not a record. Accepting one is an approval act carrying
 * a named authority, and the lock stays visible underneath it.
 *
 * ---
 *
 * **Incomplete does not mean blocked, it means authorised.** The specification
 * says a package cannot issue below full mandatory completeness *unless an
 * authorised exception is included*. Refusing outright would be simpler and
 * wrong: packages go out short of a document constantly, and a platform that
 * only says no teaches people to route around it. So the exception exists, it
 * names what is missing and who accepted the risk, and it is carried to every
 * recipient in the issue record rather than living in somebody's sent items.
 *
 * **Revoking access does not delete the evidence.** A firm removed from the
 * enquiry still received revision 2 on the Thursday, and that stays true. The
 * revocation is an additional fact, never a correction of the earlier one.
 */

// --- The pack ---------------------------------------------------------------

export type PackDocument = {
  reference: string;
  title: string;
  revision: string;
  /** What the document is, so a missing mandatory one can be named as what it is. */
  kind: string;
};

/**
 * The document kinds a package cannot be priced without.
 *
 * Not a configured list per project, because the failure is the same everywhere
 * and a per-project list is a per-project opportunity to leave one out. What is
 * configurable is the exception: a package may issue without one of these when
 * somebody with the authority says so and says why.
 */
export const MANDATORY_KINDS = ['SCOPE', 'PRICING_SCHEDULE', 'DRAWINGS', 'SPECIFICATION', 'PROGRAMME', 'CONTRACT_TERMS'] as const;
export type MandatoryKind = (typeof MANDATORY_KINDS)[number];

export type PackException = {
  /** The kinds being issued without. */
  missing: string[];
  /**
   * Set where the pack goes out on design information that is not frozen, or
   * that has been revised since it was. AC-D-WF-08-03: a package may still
   * issue — a programme sometimes leaves no choice — but the departure travels
   * with the pack to the bidder rather than staying in somebody's head.
   *
   * On the same exception as the missing documents deliberately, so the firm
   * pricing it reads one list of what they are pricing without rather than two
   * mechanisms disagreeing about whose warning is authoritative.
   */
  supersededDesign?: string;
  reason: string;
  /** The person accepting the risk. Not the person composing the pack. */
  authorisedBy: string;
};

export type PackRevision = {
  /** 1, 2, 3 — the number on the front of the document the bidder holds. */
  revision: number;
  documents: PackDocument[];
  exception?: PackException;
  /** Over the documents and the exception, so a revision identifies its contents. */
  contentHash: string;
  composedBy: string;
  composedAt: string;
  approvedBy?: string;
  approvedAt?: string;
  /** What changed from the previous revision, in the composer's own words. */
  note?: string;
};

// --- Per-recipient state ----------------------------------------------------

/**
 * How far an enquiry has got with one firm.
 *
 * Ordered. A state only moves forward, because a delivery receipt arriving
 * after an acknowledgement is an out-of-order webhook rather than a firm
 * un-acknowledging.
 */
export const ISSUE_STATE = ['SENT', 'DELIVERED', 'OPENED', 'ACKNOWLEDGED', 'DECLINED'] as const;
export type IssueState = (typeof ISSUE_STATE)[number];

/** DECLINED is terminal and reachable from anywhere; the rest are a ladder. */
function rank(state: IssueState): number {
  return state === 'DECLINED' ? Number.MAX_SAFE_INTEGER : ISSUE_STATE.indexOf(state);
}

export type BidderIssue = {
  partyId: string;
  name: string;
  /** The revision this firm was issued. The whole point of the record. */
  revision: number;
  contentHash: string;
  issuedAt: string;
  issuedBy: string;
  state: IssueState;
  /** When each state was reached, so a dispute about timing has an answer. */
  history: Array<{ state: IssueState; at: string }>;
  /** Set when a later revision has gone out and this firm has not acknowledged it. */
  reacknowledgementDue?: number;
  revoked?: { at: string; reason: string; by: string };
};

type EnquiryState = {
  id: string;
  reference: string;
  packageReference: string;
  title: string;
  returnDeadline: string;
  revisions: PackRevision[];
  issues: BidderIssue[];
  status: 'DRAFT' | 'ISSUED' | 'CLOSED';
  closedAt?: string;
  lateReturns: Array<{ partyId: string; acceptedAt: string; acceptedBy: string; reason: string; authority: string }>;
};

function requireEnquiry(ctx: EngineContext, enquiryId: string): EntityRecord {
  const record = ctx.ledger.get({ refType: 'Enquiry', refId: enquiryId });
  if (!record) throw new DomainError('ENQUIRY_NOT_FOUND', `No enquiry ${enquiryId}`, 404);
  return record;
}

function stateOf(record: EntityRecord): EnquiryState {
  return record.state as unknown as EnquiryState;
}

function latestRevision(state: EnquiryState): PackRevision | undefined {
  return state.revisions.at(-1);
}

export function openEnquiry(
  ctx: EngineContext,
  input: {
    packageReference: string;
    title: string;
    returnDeadline: string;
    /**
     * The capability area whose authority this enquiry is raised under.
     *
     * Defaults to `PROCUREMENT_AWARD`, which is the main works and is gated to
     * the Tender and Construction phases — buying the frame in O&M is a process
     * error and the gate is right to say so.
     *
     * ETABLIX passes `SITE_SERVICES`, which is not the same question. Welfare,
     * cleaning, security and transport are bought before construction starts,
     * re-let while it runs and demobilised after handover, so a phase window
     * drawn around the main works closes the wrong door. The enquiry machinery
     * is identical either way; only the authority to buy differs, and stating
     * it is more honest than letting one module inherit another's window.
     */
    area?: CapabilityArea;
  },
): { enquiryId: string; reference: string } {
  const area = input.area ?? 'PROCUREMENT_AWARD';
  authorise(ctx, area, 'C', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  if (!input.packageReference.trim() || !input.title.trim()) {
    throw new DomainError('ENQUIRY_UNNAMED', 'An enquiry names the package it buys and what it is.');
  }
  if (Number.isNaN(Date.parse(input.returnDeadline))) {
    throw new DomainError('DEADLINE_INVALID', 'The return deadline is not a date.');
  }

  const sequence = ctx.ledger.list(ctx.projectId, 'Enquiry').length + 1;
  const reference = `ENQ-${String(sequence).padStart(3, '0')}`;
  const enquiryId = ulid();

  write(ctx, {
    eventType: 'ENQUIRY_PACK_REVISED',
    entity: { refType: 'Enquiry', refId: enquiryId },
    nextState: {
      id: enquiryId,
      projectId: ctx.projectId,
      reference,
      packageReference: input.packageReference,
      title: input.title,
      returnDeadline: input.returnDeadline,
      // On the record, so a reader can tell a site-services enquiry from a
      // main-works one without inferring it from the package reference.
      area,
      revisions: [],
      issues: [],
      lateReturns: [],
      status: 'DRAFT',
      openedAt: new Date().toISOString(),
      openedBy: ctx.auth.actorId,
    },
  });

  return { enquiryId, reference };
}

/**
 * Compose a revision of the pack.
 *
 * The first is revision 1. Each later one is the addendum mechanism: composing
 * after issue produces a new revision and makes every firm's acknowledgement of
 * the old one stale, which is the specification's third exception control and
 * is the single thing that stops five prices being compared across two scopes.
 */
export function composeRevision(
  ctx: EngineContext,
  enquiryId: string,
  input: { documents: PackDocument[]; exception?: PackException; note?: string },
): { revision: number; contentHash: string; missing: string[]; requiresReacknowledgement: string[] } {
  authorise(ctx, 'PROCUREMENT_AWARD', 'C', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireEnquiry(ctx, enquiryId);
  const state = stateOf(record);

  if (state.status === 'CLOSED') {
    throw new DomainError(
      'ENQUIRY_CLOSED',
      `${state.reference} closed for returns on ${String(state.closedAt).slice(0, 10)}. Issuing a new revision after the ` +
        'deadline is a new enquiry, because nobody still pricing it has time to use one.',
    );
  }

  if (input.documents.length === 0) {
    throw new DomainError('PACK_EMPTY', 'A pack with no documents in it asks a firm to price nothing.');
  }

  const held = new Set(input.documents.map((document) => document.kind));
  const missing = MANDATORY_KINDS.filter((kind) => !held.has(kind));
  const excepted = new Set(input.exception?.missing ?? []);
  const unexcepted = missing.filter((kind) => !excepted.has(kind));

  if (unexcepted.length > 0) {
    throw new DomainError(
      'PACK_INCOMPLETE',
      `${state.reference} has no ${unexcepted.map((kind) => kind.toLowerCase().replace(/_/g, ' ')).join(', no ')}. ` +
        'A package issued short of one of these produces returns that cannot be compared. Include it, or record an authorised ' +
        'exception naming what is missing, why, and who is accepting the risk.',
    );
  }

  // AC-D-WF-08-03. Where this project designs the package itself, the pack
  // cannot go out on information the design stage has not frozen — or has
  // frozen and since revised — unless somebody with the authority says so and
  // the firm pricing it is told. A project running no design packages at all is
  // pricing client information and this does not apply to it.
  const designGap = tenderReadinessFor(ctx, state.packageReference);
  if (designGap && !input.exception?.supersededDesign?.trim()) {
    throw new DomainError(
      'DESIGN_NOT_BASELINED',
      `${state.reference} buys ${state.packageReference}, and ${designGap} Issuing on it produces prices against a revision ` +
        'the project has already left behind, which is the difference that turns up as a variation. Record an authorised ' +
        'exception saying so, and the firms will see it on the pack.',
      409,
    );
  }

  if (input.exception) {
    if (input.exception.supersededDesign !== undefined && !designGap) {
      throw new DomainError(
        'EXCEPTION_NOT_NEEDED',
        `${state.packageReference} is frozen and current, so there is no design departure to except. An exception on every ` +
          'pack is an exception on none.',
      );
    }
    if (!input.exception.reason.trim() || !input.exception.authorisedBy.trim()) {
      throw new DomainError(
        'EXCEPTION_UNAUTHORISED',
        'An exception names why the package is going out short and who accepted that. Without both it is a note, and the ' +
          'question afterwards is always who agreed.',
      );
    }
    // Guarding against an exception that excepts nothing real — which would
    // otherwise become a habit of attaching one to every pack.
    const pointless = [...excepted].filter((kind) => !missing.includes(kind as MandatoryKind));
    if (pointless.length > 0) {
      throw new DomainError(
        'EXCEPTION_NOT_NEEDED',
        `The exception names ${pointless.join(', ')}, which ${pointless.length === 1 ? 'is' : 'are'} in the pack.`,
      );
    }
  }

  const revision = state.revisions.length + 1;
  const contentHash = hashEvidence(JSON.stringify({ documents: input.documents, exception: input.exception }));

  const composed: PackRevision = {
    revision,
    documents: input.documents,
    exception: input.exception,
    contentHash,
    composedBy: ctx.auth.actorId,
    composedAt: new Date().toISOString(),
    note: input.note,
  };

  // Everybody who already holds a pack now holds an old one.
  const requiresReacknowledgement = state.issues.filter((issue) => !issue.revoked).map((issue) => issue.partyId);
  const issues = state.issues.map((issue) => (issue.revoked ? issue : { ...issue, reacknowledgementDue: revision }));

  write(ctx, {
    eventType: 'ENQUIRY_PACK_REVISED',
    entity: { refType: 'Enquiry', refId: enquiryId },
    nextState: { ...record.state, revisions: [...state.revisions, composed], issues },
  });

  return { revision, contentHash, missing, requiresReacknowledgement };
}

/**
 * Approve the revision for issue.
 *
 * A separate act from composing it, and by a different person: the composer
 * assembles what they were given, and somebody with commercial authority takes
 * responsibility for what is about to bind the firms who price it.
 */
export function approveRevision(ctx: EngineContext, enquiryId: string): { revision: number; approvedAt: string } {
  authorise(ctx, 'PROCUREMENT_AWARD', 'A', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireEnquiry(ctx, enquiryId);
  const state = stateOf(record);
  const revision = latestRevision(state);

  if (!revision) throw new DomainError('NOTHING_TO_APPROVE', `${state.reference} has no composed revision.`);
  if (revision.approvedAt) {
    throw new DomainError('REVISION_ALREADY_APPROVED', `Revision ${revision.revision} was approved on ${revision.approvedAt}.`);
  }
  if (revision.composedBy === ctx.auth.actorId) {
    throw new ForbiddenError(
      'The person who assembled the pack does not approve it. Approval is somebody taking responsibility for what is about to ' +
        'bind every firm that prices it, and that is not a second click by the same person.',
      'SELF_APPROVAL_REFUSED',
    );
  }

  const approvedAt = new Date().toISOString();

  write(ctx, {
    eventType: 'ENQUIRY_PACK_APPROVED',
    entity: { refType: 'Enquiry', refId: enquiryId },
    nextState: {
      ...record.state,
      revisions: state.revisions.map((r) =>
        r.revision === revision.revision ? { ...r, approvedBy: ctx.auth.actorId, approvedAt } : r,
      ),
    },
  });

  return { revision: revision.revision, approvedAt };
}

/**
 * Issue the approved revision to named firms.
 *
 * `AC-T-WF-04-01`. Each recipient gets their own record naming the revision and
 * its content hash. Re-issuing to a firm that already holds an older revision
 * replaces their record and clears the re-acknowledgement — that is what
 * sending them the addendum means.
 */
export function issueTo(
  ctx: EngineContext,
  enquiryId: string,
  input: { recipients: Array<{ partyId: string; name: string }> },
): { revision: number; issued: number; reissued: number } {
  authorise(ctx, 'PROCUREMENT_AWARD', 'I', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireEnquiry(ctx, enquiryId);
  const state = stateOf(record);

  if (state.status === 'CLOSED') {
    throw new DomainError('ENQUIRY_CLOSED', `${state.reference} closed for returns; there is no time left to price it.`);
  }

  const revision = latestRevision(state);
  if (!revision) throw new DomainError('NOTHING_TO_ISSUE', `${state.reference} has no composed revision.`);
  if (!revision.approvedAt) {
    throw new DomainError(
      'REVISION_NOT_APPROVED',
      `Revision ${revision.revision} has not been approved. A pack that goes out unapproved binds the firms who price it and ` +
        'nobody has taken responsibility for what is in it.',
    );
  }

  if (input.recipients.length === 0) {
    throw new DomainError('NO_RECIPIENTS', 'An enquiry issued to nobody is an enquiry nobody has.');
  }

  const revoked = state.issues.filter((issue) => issue.revoked).map((issue) => issue.partyId);
  const barred = input.recipients.filter((recipient) => revoked.includes(recipient.partyId));
  if (barred.length > 0) {
    throw new DomainError(
      'ACCESS_REVOKED',
      `${barred.map((r) => r.name).join(', ')} had access to ${state.reference} revoked. Re-inviting a removed firm is a ` +
        'decision somebody has to make deliberately, not a side effect of a distribution list.',
    );
  }

  const issuedAt = new Date().toISOString();
  const existing = new Map(state.issues.map((issue) => [issue.partyId, issue]));
  let reissued = 0;

  const updated = input.recipients.map((recipient) => {
    const previous = existing.get(recipient.partyId);
    if (previous) reissued += 1;
    const issue: BidderIssue = {
      partyId: recipient.partyId,
      name: recipient.name,
      revision: revision.revision,
      contentHash: revision.contentHash,
      issuedAt,
      issuedBy: ctx.auth.actorId,
      state: 'SENT',
      // The earlier states are kept. A firm that opened revision 1 opened it,
      // and a dispute about timing is answered from the whole history.
      history: [...(previous?.history ?? []), { state: 'SENT' as const, at: issuedAt }],
      // Sending the addendum does not discharge the debt — it moves it onto the
      // revision they now hold. Being sent a pack is not agreeing to price it,
      // and clearing the flag here would report the firm as up to date the
      // moment the email left, which is precisely the fiction this exists to
      // prevent.
      ...(previous?.reacknowledgementDue !== undefined ? { reacknowledgementDue: revision.revision } : {}),
    };
    return issue;
  });

  const touched = new Set(updated.map((issue) => issue.partyId));
  const issues = [...state.issues.filter((issue) => !touched.has(issue.partyId)), ...updated];

  const evidence = registerEvidence(ctx, {
    type: 'ENQUIRY_ISSUE_RECORD',
    hash: hashEvidence(JSON.stringify({ revision: revision.revision, contentHash: revision.contentHash, recipients: input.recipients, issuedAt })),
    description:
      `${state.reference} revision ${revision.revision} issued to ${input.recipients.length} firm` +
      `${input.recipients.length === 1 ? '' : 's'}`,
    linkedEntities: [{ refType: 'Enquiry', refId: enquiryId }],
  });

  write(ctx, {
    eventType: 'ENQUIRY_ISSUED',
    entity: { refType: 'Enquiry', refId: enquiryId },
    nextState: { ...record.state, issues, status: 'ISSUED' },
    evidenceRefs: [evidence],
  });

  return { revision: revision.revision, issued: input.recipients.length, reissued };
}

/**
 * Move one firm's state along: delivered, opened, acknowledged, declined.
 *
 * Forward only. A delivery receipt arriving after an acknowledgement is an
 * out-of-order webhook, not a firm un-acknowledging, and treating it as the
 * latter would lose the acknowledgement that matters.
 */
export function recordIssueState(
  ctx: EngineContext,
  enquiryId: string,
  input: { partyId: string; state: IssueState; at?: string },
): { state: IssueState; moved: boolean } {
  const record = requireEnquiry(ctx, enquiryId);
  const state = stateOf(record);

  const issue = state.issues.find((i) => i.partyId === input.partyId);
  if (!issue) throw new DomainError('NOT_A_RECIPIENT', `${input.partyId} was not issued ${state.reference}.`, 404);
  if (issue.revoked) {
    throw new DomainError('ACCESS_REVOKED', `${issue.name} no longer has access to ${state.reference}.`, 403);
  }

  // A firm reports its own state; anybody in the tenancy may record one on its
  // behalf, because a decline arrives by telephone as often as by portal.
  if (ctx.auth.roles.includes('SUPPLIER') && ctx.auth.partyId !== input.partyId) {
    throw new ForbiddenError('A firm reports only its own position on an enquiry.', 'SUPPLIER_IDENTITY_MISMATCH');
  }
  if (!ctx.auth.roles.includes('SUPPLIER')) {
    authorise(ctx, 'PROCUREMENT_AWARD', 'U', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });
  }

  if (rank(input.state) <= rank(issue.state)) {
    return { state: issue.state, moved: false };
  }

  const at = input.at ?? new Date().toISOString();
  const acknowledging = input.state === 'ACKNOWLEDGED';

  write(ctx, {
    eventType: 'BIDDER_ACKNOWLEDGED',
    entity: { refType: 'Enquiry', refId: enquiryId },
    nextState: {
      ...record.state,
      issues: state.issues.map((i) =>
        i.partyId === input.partyId
          ? {
              ...i,
              state: input.state,
              history: [...i.history, { state: input.state, at }],
              // Acknowledging the revision they hold clears the debt; anything
              // less does not, because opening a pack is not agreeing to it.
              ...(acknowledging && i.reacknowledgementDue === i.revision ? { reacknowledgementDue: undefined } : {}),
            }
          : i,
      ),
    },
  });

  return { state: input.state, moved: true };
}

/**
 * Remove a firm from the enquiry.
 *
 * The specification's second exception control, and the whole of it: the issue
 * evidence stays. That firm did receive revision 2 on the Thursday, and the
 * revocation is an additional fact rather than a correction of the earlier one.
 */
export function revokeAccess(
  ctx: EngineContext,
  enquiryId: string,
  input: { partyId: string; reason: string },
): { revokedAt: string } {
  authorise(ctx, 'PROCUREMENT_AWARD', 'A', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireEnquiry(ctx, enquiryId);
  const state = stateOf(record);

  const issue = state.issues.find((i) => i.partyId === input.partyId);
  if (!issue) throw new DomainError('NOT_A_RECIPIENT', `${input.partyId} was not issued ${state.reference}.`, 404);
  if (issue.revoked) throw new DomainError('ALREADY_REVOKED', `${issue.name}'s access was already revoked.`);
  if (!input.reason.trim()) {
    throw new DomainError('REASON_REQUIRED', 'Removing a firm from an enquiry is a decision. Say what it was.');
  }

  const revokedAt = new Date().toISOString();

  write(ctx, {
    eventType: 'BIDDER_ACCESS_REVOKED',
    entity: { refType: 'Enquiry', refId: enquiryId },
    nextState: {
      ...record.state,
      issues: state.issues.map((i) =>
        i.partyId === input.partyId ? { ...i, revoked: { at: revokedAt, reason: input.reason, by: ctx.auth.actorId } } : i,
      ),
    },
  });

  return { revokedAt };
}

// --- What one bidder may see ------------------------------------------------

export type BidderView = {
  enquiry: { reference: string; title: string; packageReference: string; returnDeadline: string };
  revision: number;
  contentHash: string;
  documents: PackDocument[];
  exception?: PackException;
  issuedAt: string;
  state: IssueState;
  reacknowledgementDue: boolean;
  returnsOpen: boolean;
};

/**
 * `AC-T-WF-04-02`. What this firm is entitled to see, and nothing else.
 *
 * A refusal in the domain rather than a filter applied when rendering, because
 * the commercially fatal disclosure is one bidder learning who else was asked —
 * and a filter is something a later screen forgets to apply.
 *
 * Note what is absent from the return type: no other firm, no count of them, no
 * acknowledgement rates. A bidder cannot infer the size of the field.
 */
export function bidderView(ctx: EngineContext, enquiryId: string, partyId: string): BidderView {
  const record = requireEnquiry(ctx, enquiryId);
  const state = stateOf(record);

  if (ctx.auth.roles.includes('SUPPLIER') && ctx.auth.partyId !== partyId) {
    throw new ForbiddenError('A firm sees only its own enquiry.', 'SUPPLIER_IDENTITY_MISMATCH');
  }
  if (!ctx.auth.roles.includes('SUPPLIER')) {
    authorise(ctx, 'PROCUREMENT_AWARD', 'R', { dataSensitivity: 'COMMERCIAL_L3' });
  }

  const issue = state.issues.find((i) => i.partyId === partyId);
  if (!issue || issue.revoked) {
    // The same answer either way. Distinguishing "never invited" from "removed"
    // would tell a firm something about a process it is not part of.
    throw new DomainError('NO_ENQUIRY', 'There is no enquiry issued to you here.', 404);
  }

  const revision = state.revisions.find((r) => r.revision === issue.revision)!;

  return {
    enquiry: {
      reference: state.reference,
      title: state.title,
      packageReference: state.packageReference,
      returnDeadline: state.returnDeadline,
    },
    revision: issue.revision,
    contentHash: issue.contentHash,
    documents: revision.documents,
    exception: revision.exception,
    issuedAt: issue.issuedAt,
    state: issue.state,
    reacknowledgementDue: issue.reacknowledgementDue !== undefined,
    returnsOpen: state.status !== 'CLOSED',
  };
}

// --- The return workspace ---------------------------------------------------

/**
 * Close the return period.
 *
 * `AC-T-WF-04-03`, first half. After this the workspace takes nothing without a
 * person putting their name to it.
 */
export function closeReturns(
  ctx: EngineContext,
  enquiryId: string,
): { closedAt: string; returned: string[]; silent: string[] } {
  authorise(ctx, 'PROCUREMENT_AWARD', 'A', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireEnquiry(ctx, enquiryId);
  const state = stateOf(record);

  if (state.status === 'CLOSED') {
    throw new DomainError('ALREADY_CLOSED', `${state.reference} closed on ${String(state.closedAt).slice(0, 10)}.`);
  }
  if (state.status === 'DRAFT') {
    throw new DomainError('NEVER_ISSUED', `${state.reference} was never issued, so there is no return period to close.`);
  }

  const live = state.issues.filter((issue) => !issue.revoked);
  const returned = live.filter((issue) => issue.state === 'ACKNOWLEDGED').map((issue) => issue.name);
  const silent = live
    .filter((issue) => issue.state !== 'ACKNOWLEDGED' && issue.state !== 'DECLINED')
    .map((issue) => issue.name);
  const closedAt = new Date().toISOString();

  write(ctx, {
    eventType: 'RETURN_PERIOD_CLOSED',
    entity: { refType: 'Enquiry', refId: enquiryId },
    nextState: { ...record.state, status: 'CLOSED', closedAt, closedBy: ctx.auth.actorId },
  });

  return { closedAt, returned, silent };
}

/**
 * The authorised way through the lock.
 *
 * `AC-T-WF-04-03`, second half. A late return is not refused — refusing one
 * outright only moves the decision into an email — but it costs an approval and
 * a named authority, and it is on the record beside every return that was on
 * time.
 */
export function acceptLateReturn(
  ctx: EngineContext,
  enquiryId: string,
  input: { partyId: string; reason: string; authority: string },
): { acceptedAt: string; minutesAfterDeadline: number } {
  authorise(ctx, 'PROCUREMENT_AWARD', 'A', { lifecyclePhase: currentPhase(ctx), dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireEnquiry(ctx, enquiryId);
  const state = stateOf(record);

  if (state.status !== 'CLOSED') {
    throw new DomainError(
      'RETURNS_STILL_OPEN',
      `${state.reference} has not closed. A return arriving before the deadline is simply a return.`,
    );
  }

  const issue = state.issues.find((i) => i.partyId === input.partyId);
  if (!issue || issue.revoked) {
    throw new DomainError('NOT_A_RECIPIENT', `${input.partyId} is not a live recipient of ${state.reference}.`, 404);
  }
  if (state.lateReturns.some((late) => late.partyId === input.partyId)) {
    throw new DomainError('ALREADY_ACCEPTED', `${issue.name}'s late return has already been accepted.`);
  }
  if (!input.reason.trim() || !input.authority.trim()) {
    throw new DomainError(
      'AUTHORITY_REQUIRED',
      'Accepting a return after the deadline names why and under whose authority. Every other bidder met the date, and the ' +
        'question afterwards is always who decided this one did not have to.',
    );
  }

  const acceptedAt = new Date().toISOString();
  // Measured against the stated deadline and deliberately not clamped at zero.
  // A negative figure means the return period was closed before the deadline it
  // published, which is a real thing to have done by mistake and worth seeing —
  // clamping it to zero would report a return as exactly on time when the
  // interesting fact is that the workspace shut early.
  const minutesAfterDeadline = Math.round((Date.parse(acceptedAt) - Date.parse(state.returnDeadline)) / 60_000);

  write(ctx, {
    eventType: 'LATE_RETURN_ACCEPTED',
    entity: { refType: 'Enquiry', refId: enquiryId },
    nextState: {
      ...record.state,
      lateReturns: [
        ...state.lateReturns,
        { partyId: input.partyId, acceptedAt, acceptedBy: ctx.auth.actorId, reason: input.reason, authority: input.authority },
      ],
    },
  });

  return { acceptedAt, minutesAfterDeadline };
}

// --- The position -----------------------------------------------------------

export type EnquiryPosition = {
  enquiries: Array<{
    enquiryId: string;
    reference: string;
    packageReference: string;
    title: string;
    status: string;
    returnDeadline: string;
    revision: number;
    approved: boolean;
    exception?: PackException;
    issued: number;
    acknowledged: number;
    declined: number;
    revoked: number;
    /** Firms holding a pack older than the current revision. */
    stale: string[];
    lateReturns: number;
  }>;
  summary: string;
};

export function enquiryPosition(ctx: EngineContext): EnquiryPosition {
  authorise(ctx, 'PROCUREMENT_AWARD', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const enquiries = ctx.ledger.list(ctx.projectId, 'Enquiry').map((record) => {
    const state = stateOf(record);
    const revision = latestRevision(state);
    const live = state.issues.filter((issue) => !issue.revoked);
    return {
      enquiryId: state.id,
      reference: state.reference,
      packageReference: state.packageReference,
      title: state.title,
      status: state.status,
      returnDeadline: state.returnDeadline,
      revision: revision?.revision ?? 0,
      approved: Boolean(revision?.approvedAt),
      exception: revision?.exception,
      issued: live.length,
      acknowledged: live.filter((issue) => issue.state === 'ACKNOWLEDGED').length,
      declined: live.filter((issue) => issue.state === 'DECLINED').length,
      revoked: state.issues.length - live.length,
      stale: live
        .filter((issue) => issue.reacknowledgementDue !== undefined || issue.revision !== (revision?.revision ?? 0))
        .map((issue) => issue.name)
        .sort((a, b) => a.localeCompare(b)),
      lateReturns: state.lateReturns.length,
    };
  });

  const stale = enquiries.reduce((n, enquiry) => n + enquiry.stale.length, 0);
  const parts = [`${enquiries.length} enquir${enquiries.length === 1 ? 'y' : 'ies'}`];
  if (stale > 0) parts.push(`${stale} firm${stale === 1 ? '' : 's'} holding a superseded pack`);

  return { enquiries, summary: parts.join(', ') + '.' };
}
