import { DomainError } from '../core/errors.ts';
import { formatRef, ulid } from '../core/ids.ts';
import { authorise, registerEvidence, write, type EngineContext } from '../engines/context.ts';
import type { EntityRecord } from '../goldenthread/ledger.ts';

/**
 * The evidence registry — `L7.2`, `RSP-001`, `GE-EV-01`.
 *
 * ---
 *
 * **What the platform already had, and what it did not.** `EvidenceItem` is a
 * file with a hash on it, registered beside the event that needed it. That
 * proves nothing was altered. It does not prove anything was *true*: it does
 * not say what the document is offered as evidence of, whether anybody checked
 * that it says so, or when it stops being current.
 *
 * A submission is a stack of sentences somebody will score. *We achieved 98%
 * on-time delivery. We hold ISO 14001. Our public liability cover is £10m.*
 * Each is a claim, each can be checked, and each loses the tender if it turns
 * out to be untrue — not marked down, disqualified, with everything else in the
 * submission spent for nothing. The sentence is what the evaluator reads; the
 * certificate is what makes it safe to write.
 *
 * So a claim is its own record: **what is asserted, what proves it, who checked,
 * and when it stops.**
 *
 * ## The four rules
 *
 * **The asserter may not be the verifier.** Attaching a certificate to a
 * sentence is clerical. Deciding the certificate actually proves the sentence is
 * a judgement, and one person doing both is not a check. This is the same
 * segregation the payment cycle and the signature ceremony already carry.
 *
 * **A claim expires, and expiry is computed against the day it matters.** An
 * insurance certificate valid today and lapsed on the return date is not
 * evidence for that submission. `standingOf` therefore takes the date to judge
 * against rather than assuming today, so the issue check can ask the question
 * the buyer will ask.
 *
 * **Verification cannot be granted retrospectively over an expired document.**
 * Approving something already lapsed produces a green record for a claim nobody
 * can stand behind, which is worse than no record.
 *
 * **A rejection is kept.** A claim somebody looked at and refused is part of the
 * history of the bid. Deleting it means the next person re-attaches the same
 * certificate and the same reviewer refuses it again.
 *
 * ## What this is not
 *
 * It is not a document store. `EvidenceItem` holds the bytes and the hash, and
 * this points at one. Duplicating the file here would give the platform two
 * answers to *where is the certificate*, and the settled decision is one source
 * of truth per concept.
 *
 * ## Why `ESTIMATE_TENDER` rather than `EVIDENCE_AUDIT`
 *
 * `EvidenceItem` sits under `EVIDENCE_AUDIT`, and a claim is not an audit act.
 * `EVIDENCE_AUDIT` carries `R` and `I` in the permission matrix and no role
 * holds `C` or `A` on it — which is correct, because nobody *authors* the audit
 * trail. A claim is authored: it is a sentence the business intends to put in
 * front of a buyer, and the authority to write one is the authority to write
 * the submission it goes into. So asserting is `C` and verifying is `A` on
 * `ESTIMATE_TENDER`, the same two the response pack already uses, and the
 * matrix is untouched.
 *
 * It also does not parse the certificate. Nobody here reads a PDF and decides
 * whether it says what the claim says — a person does that, and the record says
 * which person and by what method. A machine that graded its own evidence would
 * be the confident wrong answer this platform exists not to give.
 */

export const CLAIM_KIND = [
  'CERTIFICATE',
  'CASE_STUDY',
  'KPI',
  'CV',
  'POLICY',
  'ACCREDITATION',
  'INSURANCE',
  'FINANCIAL',
  'TEST_RESULT',
  'REFERENCE',
  'METHOD',
  'CALCULATION',
] as const;
export type ClaimKind = (typeof CLAIM_KIND)[number];

/**
 * Where a claim stands on a given day.
 *
 * `EXPIRED` is derived rather than stored, because storing it would need
 * something to run at midnight and a claim's standing would then depend on
 * whether that job ran.
 */
export type ClaimStanding = 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';

export type EvidenceClaim = {
  id: string;
  reference: string;
  kind: ClaimKind;
  /** The sentence this evidence proves. Written as it would appear in a submission. */
  claim: string;
  /** The registered `EvidenceItem` holding the document. */
  evidenceId: string;
  sourceHash: string;
  issuedBy?: string;
  issuedAt?: string;
  /** Inclusive last day the document is current. Absent means it does not lapse. */
  expiresAt?: string;
  /** Compliance matrix references this claim answers, where it answers any. */
  covers: string[];
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  assertedBy: string;
  assertedAt: string;
  verifiedBy?: string;
  verifiedAt?: string;
  /** How it was checked — "compared against the insurer's schedule", not "yes". */
  verificationMethod?: string;
  rejectedBy?: string;
  rejectedAt?: string;
  rejectedReason?: string;
};

const CLAIM_MIN = 12;
const METHOD_MIN = 12;

function claimsOf(ctx: EngineContext): EvidenceClaim[] {
  return ctx.ledger.list(ctx.projectId, 'EvidenceClaim').map((record) => record.state as unknown as EvidenceClaim);
}

function requireClaim(ctx: EngineContext, claimId: string): EntityRecord {
  const record = ctx.ledger.get({ refType: 'EvidenceClaim', refId: claimId });
  if (!record || record.tenantId !== ctx.tenantId) {
    throw new DomainError('EVIDENCE_CLAIM_NOT_FOUND', `No evidence claim ${claimId}`, 404);
  }
  return record;
}

/** Where a claim stands on a given day. */
export function standingOf(claim: EvidenceClaim, asAt: string): ClaimStanding {
  if (claim.status === 'REJECTED') return 'REJECTED';
  if (claim.expiresAt && claim.expiresAt < asAt) return 'EXPIRED';
  return claim.status;
}

/**
 * Assert that a document proves a sentence.
 *
 * `ESTIMATE_TENDER` `C`. Clerical and reversible, so it is the one act here an
 * agent may perform — an agent that files a certificate against the claim it
 * evidently supports is doing useful work, and nothing it files counts for
 * anything until a person verifies it.
 */
export function assertClaim(
  ctx: EngineContext,
  input: {
    kind: ClaimKind;
    claim: string;
    /** The document's hash. Registered as an `EvidenceItem` here if it is new. */
    sourceHash: string;
    uri?: string;
    issuedBy?: string;
    issuedAt?: string;
    expiresAt?: string;
    covers?: string[];
  },
): EvidenceClaim {
  authorise(ctx, 'ESTIMATE_TENDER', 'C', { dataSensitivity: 'COMMERCIAL_L3' });

  const claim = input.claim.trim();
  if (claim.length < CLAIM_MIN) {
    throw new DomainError(
      'CLAIM_REQUIRED',
      `Write the sentence this document proves, as it would appear in a submission — at least ${CLAIM_MIN} characters. ` +
        'A certificate filed against "insurance" evidences nothing in particular, and the next person has to open it to ' +
        'find out what it was for.',
      422,
      [{ field: 'claim', message: `At least ${CLAIM_MIN} characters` }],
    );
  }

  if (input.expiresAt && !/^\d{4}-\d{2}-\d{2}/.test(input.expiresAt)) {
    throw new DomainError('EXPIRY_INVALID', 'An expiry is a date, YYYY-MM-DD.', 422, [
      { field: 'expiresAt', message: 'A date, YYYY-MM-DD' },
    ]);
  }
  if (input.issuedAt && input.expiresAt && input.expiresAt < input.issuedAt.slice(0, 10)) {
    throw new DomainError(
      'EXPIRY_BEFORE_ISSUE',
      `A document issued ${input.issuedAt.slice(0, 10)} cannot expire ${input.expiresAt}. One of the two dates is wrong, ` +
        'and which one changes whether this evidence is usable at all.',
    );
  }

  const existing = claimsOf(ctx).find(
    (candidate) => candidate.sourceHash === input.sourceHash && candidate.claim === claim && candidate.status !== 'REJECTED',
  );
  if (existing) {
    throw new DomainError(
      'CLAIM_ALREADY_ASSERTED',
      `${existing.reference} already asserts that claim against this document. Two records of one fact is two things to ` +
        'keep current, and the stale one is whichever nobody remembers.',
      409,
    );
  }

  const evidence = registerEvidence(ctx, {
    type: input.kind,
    hash: input.sourceHash,
    ...(input.uri === undefined ? {} : { uri: input.uri }),
    description: claim,
  });

  const sequence = ctx.ledger.list(ctx.projectId, 'EvidenceClaim').length + 1;
  const id = ulid();
  const record: EvidenceClaim = {
    id,
    reference: formatRef('EVC', sequence),
    kind: input.kind,
    claim,
    evidenceId: evidence.refId,
    sourceHash: input.sourceHash,
    ...(input.issuedBy === undefined ? {} : { issuedBy: input.issuedBy }),
    ...(input.issuedAt === undefined ? {} : { issuedAt: input.issuedAt.slice(0, 10) }),
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt.slice(0, 10) }),
    covers: input.covers ?? [],
    status: 'PENDING',
    assertedBy: ctx.auth.actorId,
    assertedAt: new Date().toISOString(),
  };

  write(ctx, {
    eventType: 'EVIDENCE_CLAIM_ASSERTED',
    entity: { refType: 'EvidenceClaim', refId: id },
    nextState: record as unknown as Record<string, unknown>,
    evidenceRefs: [evidence],
    // The certificate issued in March and filed in June. The claim became true
    // on the day the document was issued, not the day somebody attached it, and
    // an adjudicator asking what cover was in place in April must get the
    // certificate rather than "nothing was on file yet". Absent where no issue
    // date is stated, which leaves the two axes coincident as they are for
    // nearly every other event.
    ...(record.issuedAt === undefined ? {} : { validFrom: `${record.issuedAt}T00:00:00.000Z` }),
  });

  return record;
}

/**
 * Check that the document says what the claim says.
 *
 * `ESTIMATE_TENDER` `A`, `aiAllowed: false`, and the asserter may not do it.
 */
export function verifyClaim(
  ctx: EngineContext,
  claimId: string,
  input: { method: string },
): EvidenceClaim {
  authorise(ctx, 'ESTIMATE_TENDER', 'A', { dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireClaim(ctx, claimId);
  const claim = record.state as unknown as EvidenceClaim;

  if (claim.status === 'APPROVED') {
    throw new DomainError('CLAIM_ALREADY_VERIFIED', `${claim.reference} was verified by ${claim.verifiedBy}.`, 409);
  }
  if (claim.status === 'REJECTED') {
    throw new DomainError(
      'CLAIM_REJECTED',
      `${claim.reference} was rejected: ${claim.rejectedReason}. Assert a new claim against better evidence rather than ` +
        'reversing this one — the refusal is part of the history of the bid.',
      409,
    );
  }

  // Segregation. One person attaching a certificate and then declaring it
  // proves the sentence is not a check, it is the same opinion written twice.
  if (claim.assertedBy === ctx.auth.actorId) {
    throw new DomainError(
      'SELF_VERIFICATION_REFUSED',
      `${claim.reference} was asserted by you. Somebody else has to be the one who says the document proves the claim, ` +
        'because a check done by the person being checked is not a check.',
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  if (claim.expiresAt && claim.expiresAt < today) {
    throw new DomainError(
      'EVIDENCE_EXPIRED',
      `That document expired on ${claim.expiresAt}. Verifying it now would produce an approved claim nobody can stand ` +
        'behind, which is worse than no claim at all. File the current document and assert against that.',
    );
  }

  const method = input.method.trim();
  if (method.length < METHOD_MIN) {
    throw new DomainError(
      'VERIFICATION_METHOD_REQUIRED',
      `Say how it was checked — at least ${METHOD_MIN} characters. "Compared against the insurer's schedule" is a method; ` +
        '"yes" is a signature on nothing.',
      422,
      [{ field: 'method', message: `At least ${METHOD_MIN} characters` }],
    );
  }

  const verified: EvidenceClaim = {
    ...claim,
    status: 'APPROVED',
    verifiedBy: ctx.auth.actorId,
    verifiedAt: new Date().toISOString(),
    verificationMethod: method,
  };

  write(ctx, {
    eventType: 'EVIDENCE_CLAIM_VERIFIED',
    entity: { refType: 'EvidenceClaim', refId: claimId },
    nextState: verified as unknown as Record<string, unknown>,
  });

  return verified;
}

/** Refuse a claim, with the reason. Kept on the record. */
export function rejectClaim(ctx: EngineContext, claimId: string, input: { reason: string }): EvidenceClaim {
  authorise(ctx, 'ESTIMATE_TENDER', 'A', { dataSensitivity: 'COMMERCIAL_L3' });

  const record = requireClaim(ctx, claimId);
  const claim = record.state as unknown as EvidenceClaim;
  if (claim.status === 'REJECTED') {
    throw new DomainError('CLAIM_REJECTED', `${claim.reference} is already rejected.`, 409);
  }

  const reason = input.reason.trim();
  if (!reason) {
    throw new DomainError(
      'REJECTION_REASON_REQUIRED',
      'Say why. Without it the next person attaches the same document and the same reviewer refuses it again.',
      422,
      [{ field: 'reason', message: 'Required' }],
    );
  }

  const rejected: EvidenceClaim = {
    ...claim,
    status: 'REJECTED',
    rejectedBy: ctx.auth.actorId,
    rejectedAt: new Date().toISOString(),
    rejectedReason: reason,
  };

  write(ctx, {
    eventType: 'EVIDENCE_CLAIM_REJECTED',
    entity: { refType: 'EvidenceClaim', refId: claimId },
    nextState: rejected as unknown as Record<string, unknown>,
  });

  return rejected;
}

/**
 * Every claim that would still be good on a given day.
 *
 * The date is the argument because that is the whole point: a certificate
 * current today and lapsed on the return date is not evidence for that
 * submission, and asking "is it valid now" answers the wrong question.
 */
export function approvedOn(ctx: EngineContext, asAt: string): EvidenceClaim[] {
  return claimsOf(ctx).filter((claim) => standingOf(claim, asAt) === 'APPROVED');
}

export type EvidenceRegister = {
  asAt: string;
  claims: Array<EvidenceClaim & { standing: ClaimStanding }>;
  approved: number;
  pending: number;
  expired: number;
  rejected: number;
  /** Approved today and lapsing inside the window. The list somebody acts on. */
  lapsingSoon: Array<{ reference: string; claim: string; expiresAt: string; daysLeft: number }>;
  summary: string;
};

const LAPSE_WINDOW_DAYS = 60;

/** The register, judged against a day. */
export function evidenceRegister(ctx: EngineContext, asAt?: string): EvidenceRegister {
  authorise(ctx, 'ESTIMATE_TENDER', 'R', { dataSensitivity: 'COMMERCIAL_L3' });

  const day = asAt ?? new Date().toISOString().slice(0, 10);
  const claims = claimsOf(ctx)
    .map((claim) => ({ ...claim, standing: standingOf(claim, day) }))
    .sort((a, b) => (b.assertedAt ?? '').localeCompare(a.assertedAt ?? ''));

  const count = (standing: ClaimStanding): number => claims.filter((claim) => claim.standing === standing).length;

  const horizon = new Date(Date.parse(`${day}T00:00:00Z`) + LAPSE_WINDOW_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const lapsingSoon = claims
    .filter((claim) => claim.standing === 'APPROVED' && claim.expiresAt !== undefined && claim.expiresAt <= horizon)
    .map((claim) => ({
      reference: claim.reference,
      claim: claim.claim,
      expiresAt: claim.expiresAt!,
      daysLeft: Math.round((Date.parse(`${claim.expiresAt!}T00:00:00Z`) - Date.parse(`${day}T00:00:00Z`)) / 86_400_000),
    }))
    .sort((a, b) => a.daysLeft - b.daysLeft);

  const approved = count('APPROVED');
  const pending = count('PENDING');
  const expired = count('EXPIRED');
  const rejected = count('REJECTED');

  return {
    asAt: day,
    claims,
    approved,
    pending,
    expired,
    rejected,
    lapsingSoon,
    summary:
      claims.length === 0
        ? 'Nothing is registered. A claim in a submission with no evidence behind it is the one that loses the tender.'
        : `${approved} claim(s) verified and current` +
          (pending > 0 ? `, ${pending} waiting on somebody to check` : '') +
          (expired > 0 ? `, ${expired} expired` : '') +
          (rejected > 0 ? `, ${rejected} refused` : '') +
          (lapsingSoon.length > 0 ? `. ${lapsingSoon.length} lapse within ${LAPSE_WINDOW_DAYS} days.` : '.'),
  };
}
