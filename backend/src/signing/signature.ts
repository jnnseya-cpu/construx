import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, type KeyObject } from 'node:crypto';
import { canonicalize } from '../core/canonical.ts';
import { DomainError, ForbiddenError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';
import { config } from '../config.ts';
import type { EvidenceStore } from '../evidence/store.ts';
import { findByHash } from '../evidence/registry.ts';
import type { CapabilityArea } from '../identity/roles.ts';
import { authorise, currentPhase, write, type EngineContext } from '../engines/context.ts';

/**
 * The signing ceremony.
 *
 * What this is, said plainly, because the wrong answer here is a legal problem
 * rather than a bug: **this is a witnessed signature, not a qualified electronic
 * signature.** The platform holds the key. It attests that an identity it
 * authenticated, with multi-factor satisfied, affirmed a named document — by its
 * content hash — at a recorded time, and it writes that attestation into an
 * append-only chain. It does not attest that a private key under the signatory's
 * sole control was used, because there is no such key.
 *
 * That distinction is the whole design. Under eIDAS and its UK equivalent a
 * signature made with a key the signatory alone controls is an *advanced*
 * signature; one made with a certified device is *qualified*. This is neither.
 * It is a simple electronic signature with unusually good evidence behind it,
 * which is admissible and is what the overwhelming majority of construction
 * documents are signed with in practice — and calling it anything else would be
 * exactly the kind of claim the platform exists not to make. Every signature
 * record says so in its own `assurance` field rather than relying on anyone
 * having read this comment.
 *
 * ---
 *
 * **No external signing service.** Two settled decisions rule it out — zero
 * runtime dependencies, and secrets that never leave the server — and neither
 * needed bending: `node:crypto` has Ed25519, and what a signing service sells
 * beyond that is a certificate authority relationship this platform is not in.
 *
 * **The key is configured or the feature is off.** An ephemeral key generated at
 * boot would invalidate every signature the platform had ever made on the next
 * restart, and would do it silently. Unset means signing is refused, the same
 * way the evidence store refuses when it has nowhere to put a file.
 *
 * **You cannot sign a document the platform cannot show you.** The bytes must be
 * held, not merely hashed. A signature over a hash of a document nobody has is a
 * signature over a number.
 *
 * **What is signed is a statement, not the file.** The statement names the
 * document hash, the signatory, the request, the purpose and the time, and it is
 * canonicalised before signing so that verification is reproducible by anybody
 * holding the public key and the record.
 */

/** What a signature is worth, stated on the record rather than implied. */
export const ASSURANCE = 'WITNESSED_BY_PLATFORM' as const;

export type SignatureAssurance = typeof ASSURANCE;

/**
 * The platform's signing key, held by an object rather than read from
 * configuration wherever it happens to be needed.
 *
 * The same pattern as `EvidenceStore` and `Journal`: the composition root knows
 * about the environment and everything else is handed what it needs. It is not
 * only tidiness — a module that reads a boot-time configuration snapshot
 * directly is a module whose configured behaviour no test can reach, and the
 * behaviour here is a security control.
 */
export class SigningAuthority {
  readonly #pem: string;
  #privateKey: KeyObject | undefined;
  #publicKey: KeyObject | undefined;

  constructor(privateKeyPem: string = config.signing.privateKeyPem) {
    this.#pem = privateKeyPem;
  }

  /** Whether this deployment can witness a signature at all. */
  get available(): boolean {
    if (this.#pem === '') return false;
    try {
      this.#keys();
      return true;
    } catch {
      return false;
    }
  }

  #keys(): { privateKey: KeyObject; publicKey: KeyObject } {
    if (this.#pem === '') {
      throw new DomainError(
        'SIGNING_KEY_UNCONFIGURED',
        'No signing key is configured, so the platform cannot witness a signature.',
        503,
      );
    }
    if (!this.#privateKey || !this.#publicKey) {
      let parsed: KeyObject;
      try {
        parsed = createPrivateKey(this.#pem);
      } catch (error) {
        throw new DomainError('SIGNING_KEY_INVALID', `The configured signing key could not be read: ${String(error)}`, 503);
      }
      // Ed25519 rather than RSA: small signatures, no parameter choices to get
      // wrong, and no padding mode anybody can misconfigure.
      if (parsed.asymmetricKeyType !== 'ed25519') {
        throw new DomainError('SIGNING_KEY_INVALID', 'The signing key must be Ed25519', 503);
      }
      this.#privateKey = parsed;
      this.#publicKey = createPublicKey(parsed);
    }
    return { privateKey: this.#privateKey, publicKey: this.#publicKey };
  }

  /** The public half, so a signature can be verified outside the platform. */
  publicKeyPem(): string {
    return this.#keys().publicKey.export({ type: 'spki', format: 'pem' }).toString();
  }

  /** Refuse early, where a request is being raised rather than answered. */
  assertAvailable(): void {
    this.#keys();
  }

  sign(statement: SigningStatement): string {
    return edSign(null, statementBytes(statement), this.#keys().privateKey).toString('base64');
  }

  /** Verify a signature against its statement and this authority's public key. */
  verify(statement: SigningStatement, signature: string): boolean {
    try {
      return edVerify(null, statementBytes(statement), this.#keys().publicKey, Buffer.from(signature, 'base64'));
    } catch {
      return false;
    }
  }
}

/**
 * Exactly what gets signed.
 *
 * Every field is here because leaving it out would let the signature be lifted
 * somewhere it does not belong: without `requestId` a signature on one request
 * proves a signature on another for the same document; without `purpose` a
 * signature agreeing to a payment certificate would equally prove agreement to a
 * settlement; without `signatory` anybody's signature proves everybody's.
 */
export type SigningStatement = {
  requestId: string;
  documentHash: string;
  purpose: string;
  signatory: string;
  signatoryName: string;
  tenantId: string;
  projectId: string;
  signedAt: string;
  assurance: SignatureAssurance;
};

export function statementBytes(statement: SigningStatement): Buffer {
  return Buffer.from(canonicalize(statement), 'utf8');
}

export type SignatureRequestState = {
  id: string;
  projectId: string;
  documentHash: string;
  documentDescription: string;
  purpose: string;
  area: CapabilityArea;
  /** Identities that must sign. All of them, or the request is not complete. */
  requiredSignatories: Array<{ actorId: string; name: string; capacity: string }>;
  status: 'OPEN' | 'COMPLETE' | 'ABANDONED';
  requestedBy: string;
  requestedAt: string;
  dueBy?: string;
  signedBy: string[];
  declinedBy: string[];
};

/**
 * Ask named people to sign a document the platform holds.
 *
 * The document has to exist as evidence and its bytes have to be held, for the
 * same reason a paper signature goes under the text rather than beside it.
 */
export function requestSignature(
  ctx: EngineContext,
  authority: SigningAuthority,
  store: EvidenceStore,
  input: {
    documentHash: string;
    purpose: string;
    area: CapabilityArea;
    requiredSignatories: Array<{ actorId: string; name: string; capacity: string }>;
    dueBy?: string;
  },
): { requestId: string } {
  authorise(ctx, input.area, 'C', { lifecyclePhase: currentPhase(ctx) });

  if (input.requiredSignatories.length === 0) {
    throw new DomainError('SIGNATORIES_REQUIRED', 'A signature request with nobody to sign it is not a request');
  }

  const record = findByHash(ctx.ledger, ctx.tenantId, input.documentHash);
  if (!record) {
    throw new DomainError('SIGNATURE_DOCUMENT_UNKNOWN', 'No evidence record in this tenancy references that hash', 404);
  }
  if (!store.has(ctx.tenantId, input.documentHash)) {
    throw new DomainError(
      'SIGNATURE_DOCUMENT_NOT_HELD',
      'The platform holds the hash of this document but not the document. Nobody can be asked to sign what cannot be shown to them.',
      409,
    );
  }
  // Refused here rather than at the first signature, so a request is never
  // raised on a deployment that could never complete it.
  authority.assertAvailable();

  const requestId = ulid();
  const state: SignatureRequestState = {
    id: requestId,
    projectId: ctx.projectId,
    documentHash: input.documentHash,
    documentDescription: String((record.state as { description?: string }).description ?? 'Document'),
    purpose: input.purpose,
    area: input.area,
    requiredSignatories: input.requiredSignatories,
    status: 'OPEN',
    requestedBy: ctx.auth.actorId,
    requestedAt: new Date().toISOString(),
    dueBy: input.dueBy,
    signedBy: [],
    declinedBy: [],
  };

  write(ctx, {
    eventType: 'SIGNATURE_REQUESTED',
    entity: { refType: 'SignatureRequest', refId: requestId },
    nextState: state as unknown as Record<string, unknown>,
    evidenceRefs: [{ refType: 'EvidenceItem', refId: record.refId }],
  });

  return { requestId };
}

function requireOpenRequest(ctx: EngineContext, requestId: string): SignatureRequestState {
  const record = ctx.ledger.get({ refType: 'SignatureRequest', refId: requestId });
  if (!record || record.tenantId !== ctx.tenantId) {
    throw new DomainError('SIGNATURE_REQUEST_NOT_FOUND', `No signature request ${requestId}`, 404);
  }
  const state = record.state as unknown as SignatureRequestState;
  if (state.status !== 'OPEN') {
    throw new DomainError('SIGNATURE_REQUEST_CLOSED', `This request is ${state.status.toLowerCase()}`, 409);
  }
  return state;
}

/**
 * Sign.
 *
 * Four things have to be true, and each is a way a signature could otherwise be
 * worth nothing: the request is open, the person is one of those asked, they
 * have not already answered, and their session satisfied multi-factor. The last
 * is the one that matters most — a signature made from a session that presented
 * one factor is a signature made by whoever had the password.
 */
export function signDocument(
  ctx: EngineContext,
  authority: SigningAuthority,
  input: { requestId: string; signatoryName: string; capacity?: string; affirmation: string },
): { signatureId: string; signature: string; statement: SigningStatement; complete: boolean } {
  const request = requireOpenRequest(ctx, input.requestId);
  // Read, not approve.
  //
  // Signing is agreeing to a document as a party to it, which is a different
  // thing from holding approval authority in the capability area it belongs to.
  // A quantity surveyor holds PAYMENT_APPLICATIONS 'C' and not 'A' — they
  // prepare the application, the employer certifies it — and requiring 'A' to
  // sign meant the person who prepared a certificate could not put their name
  // to it. The authorisation that decides *who signs* is the request, made by
  // somebody who does hold 'C' in the area; what is checked here is that the
  // signatory may see what they are signing.
  authorise(ctx, request.area, 'R', { lifecyclePhase: currentPhase(ctx) });

  const expected = request.requiredSignatories.find((s) => s.actorId === ctx.auth.actorId);
  if (!expected) {
    throw new ForbiddenError('You were not asked to sign this document', 'NOT_A_REQUESTED_SIGNATORY');
  }
  if (request.signedBy.includes(ctx.auth.actorId) || request.declinedBy.includes(ctx.auth.actorId)) {
    throw new DomainError('ALREADY_ANSWERED', 'You have already answered this signature request', 409);
  }
  if (!ctx.auth.mfaSatisfied) {
    // The single strongest thing this ceremony can assert about who signed.
    throw new ForbiddenError(
      'A signature requires a session that satisfied multi-factor authentication',
      'MFA_REQUIRED_TO_SIGN',
    );
  }
  if (input.affirmation.trim().length < 4) {
    throw new DomainError('AFFIRMATION_REQUIRED', 'Say what you are agreeing to. A blank affirmation signs nothing.');
  }

  const statement: SigningStatement = {
    requestId: request.id,
    documentHash: request.documentHash,
    purpose: request.purpose,
    signatory: ctx.auth.actorId,
    signatoryName: input.signatoryName,
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    signedAt: new Date().toISOString(),
    assurance: ASSURANCE,
  };

  const signature = authority.sign(statement);
  const signatureId = ulid();

  write(ctx, {
    eventType: 'DOCUMENT_SIGNED',
    entity: { refType: 'Signature', refId: signatureId },
    nextState: {
      id: signatureId,
      requestId: request.id,
      projectId: ctx.projectId,
      documentHash: request.documentHash,
      purpose: request.purpose,
      signatory: ctx.auth.actorId,
      signatoryName: input.signatoryName,
      capacity: input.capacity ?? expected.capacity,
      affirmation: input.affirmation,
      statement,
      signature,
      // Carried on the record, not looked up at verification time. A key that
      // is later rotated must not silently invalidate what it signed.
      publicKeyPem: authority.publicKeyPem(),
      assurance: ASSURANCE,
      // The one sentence somebody reading this record in a dispute needs.
      assuranceNote:
        'Witnessed by the platform: an authenticated identity with multi-factor satisfied affirmed this document hash at this time. ' +
        'The signing key is held by the platform, not by the signatory, so this is a simple electronic signature with an evidenced audit trail — ' +
        'not an advanced or qualified electronic signature.',
      signedAt: statement.signedAt,
    },
    evidenceRefs: [{ refType: 'EvidenceItem', refId: evidenceRefFor(ctx, request.documentHash) }],
  });

  const signedBy = [...request.signedBy, ctx.auth.actorId];
  const complete = request.requiredSignatories.every((s) => signedBy.includes(s.actorId));

  // Written as two branches rather than a ternary on the event type. Both are
  // real events in the catalogue and each needs to be findable as one — a
  // computed event name is a dead event as far as anything reading this file is
  // concerned, including the test that checks the catalogue has no dead events.
  const documentEvidence = [{ refType: 'EvidenceItem', refId: evidenceRefFor(ctx, request.documentHash) }];
  if (complete) {
    write(ctx, {
      eventType: 'SIGNATURE_REQUEST_SETTLED',
      entity: { refType: 'SignatureRequest', refId: request.id },
      nextState: { ...request, signedBy, status: 'COMPLETE', completedAt: statement.signedAt },
      evidenceRefs: documentEvidence,
    });
  } else {
    write(ctx, {
      eventType: 'SIGNATURE_REQUEST_PROGRESSED',
      entity: { refType: 'SignatureRequest', refId: request.id },
      nextState: { ...request, signedBy, status: 'OPEN' },
      evidenceRefs: documentEvidence,
    });
  }

  return { signatureId, signature, statement, complete };
}

/**
 * Decline, with a reason.
 *
 * Recorded rather than left as silence. A signature request that somebody
 * refused is a materially different fact from one nobody got round to, and on a
 * certificate or a settlement it is often the more important of the two.
 */
export function declineSignature(
  ctx: EngineContext,
  input: { requestId: string; reason: string },
): { requestId: string } {
  const request = requireOpenRequest(ctx, input.requestId);
  // Same as signing: refusing is answering, and it takes the same standing.
  authorise(ctx, request.area, 'R', { lifecyclePhase: currentPhase(ctx) });

  if (!request.requiredSignatories.some((s) => s.actorId === ctx.auth.actorId)) {
    throw new ForbiddenError('You were not asked to sign this document', 'NOT_A_REQUESTED_SIGNATORY');
  }
  if (request.signedBy.includes(ctx.auth.actorId) || request.declinedBy.includes(ctx.auth.actorId)) {
    throw new DomainError('ALREADY_ANSWERED', 'You have already answered this signature request', 409);
  }
  if (input.reason.trim().length < 4) {
    throw new DomainError('DECLINE_REASON_REQUIRED', 'Say why you are not signing');
  }

  const signatureId = ulid();
  const evidenceRef = { refType: 'EvidenceItem', refId: evidenceRefFor(ctx, request.documentHash) };

  write(ctx, {
    eventType: 'SIGNATURE_DECLINED',
    entity: { refType: 'Signature', refId: signatureId },
    nextState: {
      id: signatureId,
      requestId: request.id,
      projectId: ctx.projectId,
      documentHash: request.documentHash,
      purpose: request.purpose,
      signatory: ctx.auth.actorId,
      declined: true,
      reason: input.reason,
      declinedAt: new Date().toISOString(),
    },
    evidenceRefs: [evidenceRef],
  });

  // One refusal ends the request. Leaving it open would let the remaining
  // signatures accumulate against a document that is not going to be agreed,
  // and a half-signed document reads as progress.
  write(ctx, {
    eventType: 'SIGNATURE_REQUEST_SETTLED',
    entity: { refType: 'SignatureRequest', refId: request.id },
    nextState: {
      ...request,
      declinedBy: [...request.declinedBy, ctx.auth.actorId],
      status: 'ABANDONED',
      abandonedReason: input.reason,
      abandonedAt: new Date().toISOString(),
    },
    evidenceRefs: [evidenceRef],
  });

  return { requestId: request.id };
}

function evidenceRefFor(ctx: EngineContext, hash: string): string {
  const record = findByHash(ctx.ledger, ctx.tenantId, hash);
  if (!record) throw new DomainError('SIGNATURE_DOCUMENT_UNKNOWN', 'The document this request names has left the record', 409);
  return record.refId;
}

/**
 * Everything signed on a project, with each signature re-verified as it is read.
 *
 * Verifying on read rather than trusting the stored flag is the same discipline
 * the object store applies to bytes: the record's value is that it can be
 * checked years later, and a check nobody ever runs is a check that does not
 * work.
 */
export function signatureRegister(
  ctx: EngineContext,
  authority: SigningAuthority,
): {
  available: boolean;
  publicKeyPem?: string;
  requests: SignatureRequestState[];
  signatures: Array<Record<string, unknown> & { verified: boolean }>;
} {
  const available = authority.available;
  return {
    available,
    publicKeyPem: available ? authority.publicKeyPem() : undefined,
    requests: ctx.ledger
      .list(ctx.projectId, 'SignatureRequest')
      .map((record) => record.state as unknown as SignatureRequestState)
      .sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1)),
    signatures: ctx.ledger.list(ctx.projectId, 'Signature').map((record) => {
      const state = record.state as Record<string, unknown>;
      return {
        ...state,
        verified:
          state.declined === true
            ? false
            : available && authority.verify(state.statement as SigningStatement, String(state.signature)),
      };
    }),
  };
}
