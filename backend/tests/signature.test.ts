import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { EvidenceStore, hashBytes } from '../src/evidence/store.ts';
import type { EngineContext } from '../src/engines/context.ts';
import {
  ASSURANCE,
  declineSignature,
  requestSignature,
  signatureRegister,
  signDocument,
  SigningAuthority,
  statementBytes,
  type SigningStatement,
} from '../src/signing/signature.ts';
import type { AuthContext } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * The signing ceremony.
 *
 * The claim under test is deliberately narrow, because the wrong claim here is a
 * legal problem rather than a bug. The platform holds the key, so a signature
 * proves that an identity the platform authenticated, with multi-factor
 * satisfied, affirmed a named document hash at a recorded time. It does not
 * prove that a key under the signatory's sole control was used, because there is
 * no such key — this is a simple electronic signature with an evidenced trail,
 * not an advanced or a qualified one.
 *
 * So the assertions are the things that would make even that narrow claim false:
 * a signature that still verifies after the statement is altered, one made
 * without multi-factor, one made by somebody nobody asked, a document the
 * platform cannot show anybody, and a deployment with no key behaving as though
 * it had one.
 *
 * The key is generated here and handed to the platform, which is the point of
 * `SigningAuthority` taking one: an earlier version of this file read the boot
 * configuration snapshot and every interesting assertion sat behind a branch
 * that never ran.
 */

const PEM = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

let directory: string;
let store: EvidenceStore;
let platform: Platform;
let seed: SeedResult;

const DOCUMENT = Buffer.from('Payment certificate 07 — £412,880 gross, £38,110 retention.', 'utf8');
const DOCUMENT_HASH = hashBytes(DOCUMENT);

function ctxFor(who: string, options: { mfa?: boolean } = {}): EngineContext {
  const auth = seed.users[who]!.auth;
  const session: AuthContext = { ...auth, mfaSatisfied: options.mfa ?? true };
  return platform.context(session, seed.projectId, { correlationId: 'signature-test' });
}

/** Register a document as evidence the way a domain command does. */
function registerDocument(ctx: EngineContext, hash: string, refId: string, description: string): void {
  ctx.ledger.commit({
    tenantId: ctx.tenantId,
    projectId: ctx.projectId,
    actor: { refType: 'User', refId: ctx.auth.actorId },
    source: 'WEB',
    correlationId: ctx.correlationId,
    eventType: 'EVIDENCE_REGISTERED',
    entity: { refType: 'EvidenceItem', refId },
    nextState: {
      id: refId,
      type: 'PAYMENT_CERTIFICATE',
      hash,
      description,
      linkedEntities: [],
      capturedAt: new Date().toISOString(),
      capturedBy: ctx.auth.actorId,
    },
  });
}

function signatories(): Array<{ actorId: string; name: string; capacity: string }> {
  return [
    { actorId: seed.users.qs!.id, name: 'Quantity surveyor', capacity: 'Commercial manager' },
    { actorId: seed.users.owner!.id, name: 'Asset owner', capacity: 'Employer' },
  ];
}

async function build(authority: SigningAuthority): Promise<void> {
  platform = new Platform(undefined, store, authority);
  seed = await seedDemoProject(platform);
  registerDocument(ctxFor('qs'), DOCUMENT_HASH, 'ev-certificate-07', 'Payment certificate 07');
  store.put(seed.tenantId, DOCUMENT_HASH, DOCUMENT, 'application/pdf');
}

before(() => {
  directory = mkdtempSync(join(tmpdir(), 'construx-signature-'));
  store = new EvidenceStore(directory);
});

after(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe('a deployment with no signing key', () => {
  before(async () => {
    await build(new SigningAuthority(''));
  });

  it('refuses rather than generating a key nothing can verify against tomorrow', () => {
    // An ephemeral key is worse than a refusal: every signature the platform had
    // made would fail verification after the next restart, and silently.
    assert.equal(platform.signing.available, false);

    throwsCode(
      () =>
        requestSignature(ctxFor('qs'), platform.signing, store, {
          documentHash: DOCUMENT_HASH,
          purpose: 'Agree the sum certified in payment certificate 07',
          area: 'PAYMENT_APPLICATIONS',
          requiredSignatories: signatories(),
        }),
      'SIGNING_KEY_UNCONFIGURED',
    );
  });

  it('refuses at the request, not at the first signature', () => {
    // A request raised where it could never be completed looks like progress
    // and produces nothing.
    assert.equal(platform.ledger.list(seed.projectId, 'SignatureRequest').length, 0);
  });

  it('says so on the register rather than reporting an empty one', () => {
    const register = signatureRegister(ctxFor('qs'), platform.signing);
    assert.equal(register.available, false);
    assert.equal(register.publicKeyPem, undefined);
  });

  it('refuses a key that is the wrong kind', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();
    assert.equal(new SigningAuthority(rsa).available, false);
    assert.equal(new SigningAuthority('not a key at all').available, false);
  });
});

describe('what a signature is over', () => {
  const statement: SigningStatement = {
    requestId: '01ABCDEF',
    documentHash: DOCUMENT_HASH,
    purpose: 'Agree the sum certified in payment certificate 07',
    signatory: 'user-1',
    signatoryName: 'A Surveyor',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    signedAt: '2026-08-21T09:00:00.000Z',
    assurance: ASSURANCE,
  };

  it('canonicalises, so verification is reproducible anywhere', () => {
    // Key order must not change the bytes, or a signature verifies on the
    // machine that made it and nowhere else.
    const reordered = {
      assurance: statement.assurance,
      signedAt: statement.signedAt,
      projectId: statement.projectId,
      tenantId: statement.tenantId,
      signatoryName: statement.signatoryName,
      signatory: statement.signatory,
      purpose: statement.purpose,
      documentHash: statement.documentHash,
      requestId: statement.requestId,
    } as SigningStatement;

    assert.equal(statementBytes(statement).toString('utf8'), statementBytes(reordered).toString('utf8'));
  });

  it('binds the request, the document, the purpose, the person and the time', () => {
    // Each field is here because dropping it lets a signature be lifted
    // somewhere it does not belong — a signature on one request proving a
    // signature on another over the same document, and so on.
    const base = statementBytes(statement).toString('utf8');
    for (const field of ['requestId', 'documentHash', 'purpose', 'signatory', 'signedAt'] as const) {
      assert.notEqual(
        statementBytes({ ...statement, [field]: 'something-else' }).toString('utf8'),
        base,
        `${field} does not affect what is signed`,
      );
    }
  });

  it('names its own assurance level, so nobody has to infer it', () => {
    assert.equal(ASSURANCE, 'WITNESSED_BY_PLATFORM');
    assert.ok(!/QUALIFIED|ADVANCED/.test(ASSURANCE), 'the record claims an assurance level the platform cannot provide');
  });
});

describe('the ceremony', () => {
  let authority: SigningAuthority;

  before(async () => {
    authority = new SigningAuthority(PEM);
    await build(authority);
  });

  function open(purpose: string): string {
    return requestSignature(ctxFor('qs'), authority, store, {
      documentHash: DOCUMENT_HASH,
      purpose,
      area: 'PAYMENT_APPLICATIONS',
      requiredSignatories: signatories(),
    }).requestId;
  }

  it('refuses somebody nobody asked', () => {
    const requestId = open('Agree the sum certified — unasked signatory');
    throwsCode(
      () => signDocument(ctxFor('pm'), authority, { requestId, signatoryName: 'A PM', affirmation: 'I agree' }),
      'NOT_A_REQUESTED_SIGNATORY',
    );
  });

  it('refuses a session that presented one factor', () => {
    // The strongest thing this ceremony can assert about who signed. Without it
    // a signature is made by whoever had the password.
    const requestId = open('Agree the sum certified — single factor');
    throwsCode(
      () =>
        signDocument(ctxFor('qs', { mfa: false }), authority, {
          requestId,
          signatoryName: 'Quantity surveyor',
          affirmation: 'I agree the sum certified',
        }),
      'MFA_REQUIRED_TO_SIGN',
    );
  });

  it('refuses a blank affirmation, because that records a click', () => {
    const requestId = open('Agree the sum certified — blank affirmation');
    throwsCode(
      () => signDocument(ctxFor('qs'), authority, { requestId, signatoryName: 'QS', affirmation: '  ' }),
      'AFFIRMATION_REQUIRED',
    );
  });

  it('produces a signature that verifies, and stops verifying if anything is altered', () => {
    const requestId = open('Agree the sum certified in payment certificate 07');
    const signed = signDocument(ctxFor('qs'), authority, {
      requestId,
      signatoryName: 'Quantity surveyor',
      affirmation: 'I agree the sum certified in certificate 07',
    });

    assert.equal(authority.verify(signed.statement, signed.signature), true);

    // The whole point. Each of these is a document somebody could later claim
    // was the one signed.
    const otherDocument = hashBytes(Buffer.from('a different certificate', 'utf8'));
    assert.equal(authority.verify({ ...signed.statement, documentHash: otherDocument }, signed.signature), false);
    assert.equal(authority.verify({ ...signed.statement, signatory: 'somebody-else' }, signed.signature), false);
    assert.equal(authority.verify({ ...signed.statement, purpose: 'Agree the final account' }, signed.signature), false);
    assert.equal(authority.verify({ ...signed.statement, requestId: 'a-different-request' }, signed.signature), false);
  });

  it('does not verify under a different key', () => {
    // A rotated or substituted key must not silently validate old signatures,
    // which is why each record carries the public key it was made under.
    const requestId = open('Agree the sum certified — key substitution');
    const signed = signDocument(ctxFor('qs'), authority, {
      requestId,
      signatoryName: 'Quantity surveyor',
      affirmation: 'I agree',
    });

    const other = new SigningAuthority(
      generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    );
    assert.equal(other.verify(signed.statement, signed.signature), false);
    assert.match(String(platform.ledger.get({ refType: 'Signature', refId: signed.signatureId })?.state.publicKeyPem), /BEGIN PUBLIC KEY/);
  });

  it('completes only when everybody asked has signed', () => {
    const requestId = open('Agree the sum certified — both parties');

    const first = signDocument(ctxFor('qs'), authority, {
      requestId,
      signatoryName: 'Quantity surveyor',
      affirmation: 'I agree the sum certified',
    });
    assert.equal(first.complete, false, 'one of two signatures completed the request');
    assert.equal(platform.ledger.get({ refType: 'SignatureRequest', refId: requestId })?.state.status, 'OPEN');

    // No second bite.
    throwsCode(
      () => signDocument(ctxFor('qs'), authority, { requestId, signatoryName: 'QS', affirmation: 'again' }),
      'ALREADY_ANSWERED',
    );

    const second = signDocument(ctxFor('owner'), authority, {
      requestId,
      signatoryName: 'Asset owner',
      affirmation: 'The employer agrees the certified sum',
    });
    assert.equal(second.complete, true);
    assert.equal(platform.ledger.get({ refType: 'SignatureRequest', refId: requestId })?.state.status, 'COMPLETE');
  });

  it('records a refusal as the fact it is, and ends the request', () => {
    // A signature request somebody refused is a materially different fact from
    // one nobody got round to, and a half-signed document left open reads as
    // progress towards an agreement that is not going to happen.
    const requestId = open('Agree the final account');
    throwsCode(() => declineSignature(ctxFor('owner'), { requestId, reason: 'no' }), 'DECLINE_REASON_REQUIRED');

    declineSignature(ctxFor('owner'), {
      requestId,
      reason: 'The retention release is not agreed and this certificate assumes it.',
    });

    const request = platform.ledger.get({ refType: 'SignatureRequest', refId: requestId });
    assert.equal(request?.state.status, 'ABANDONED');
    assert.match(String(request?.state.abandonedReason), /retention release/);

    throwsCode(
      () => signDocument(ctxFor('qs'), authority, { requestId, signatoryName: 'QS', affirmation: 'I agree' }),
      'SIGNATURE_REQUEST_CLOSED',
    );
  });

  it('re-verifies every signature as the register is read', () => {
    // The record's value is that it can be checked years later, and a check
    // nobody ever runs is a check that does not work. So the register verifies
    // rather than reporting a stored flag.
    const register = signatureRegister(ctxFor('qs'), authority);
    assert.equal(register.available, true);
    assert.ok(register.publicKeyPem?.includes('BEGIN PUBLIC KEY'));

    const witnessed = register.signatures.filter((s) => s.declined !== true);
    assert.ok(witnessed.length >= 3);
    assert.ok(witnessed.every((s) => s.verified), 'a stored signature does not verify when read back');
    assert.ok(witnessed.every((s) => s.assurance === ASSURANCE));
    // The sentence somebody reading this in a dispute needs, on the record.
    assert.ok(witnessed.every((s) => /not an advanced or qualified electronic signature/.test(String(s.assuranceNote))));

    // A declined answer is not a signature and must never read as verified.
    const declined = register.signatures.filter((s) => s.declined === true);
    assert.ok(declined.length >= 1);
    assert.ok(declined.every((s) => s.verified === false));
  });

  it('attributes every signature to a person, never to an AI actor', () => {
    // The same rule that keeps agents at PROPOSE. A signature is somebody
    // agreeing to something; nothing else can be the one who agreed.
    const events = platform.ledger
      .events({ projectId: seed.projectId })
      .filter((e) => e.eventType === 'DOCUMENT_SIGNED' || e.eventType === 'SIGNATURE_DECLINED');

    assert.ok(events.length >= 4);
    assert.ok(events.every((e) => e.actor.refType === 'User'));
    assert.ok(events.every((e) => e.source !== 'AI'));
  });
});

describe('a document nobody can be shown', () => {
  before(async () => {
    await build(new SigningAuthority(PEM));
  });

  it('cannot be put to signature, because that signs a number rather than a document', () => {
    const ctx = ctxFor('qs');
    const hash = hashBytes(Buffer.from('recorded but never uploaded', 'utf8'));
    registerDocument(ctx, hash, 'ev-unheld', 'A certificate the platform never received');

    throwsCode(
      () =>
        requestSignature(ctx, platform.signing, store, {
          documentHash: hash,
          purpose: 'Agree a document nobody holds',
          area: 'PAYMENT_APPLICATIONS',
          requiredSignatories: signatories(),
        }),
      'SIGNATURE_DOCUMENT_NOT_HELD',
    );
  });

  it('cannot be put to signature under a hash no record claims', () => {
    throwsCode(
      () =>
        requestSignature(ctxFor('qs'), platform.signing, store, {
          documentHash: hashBytes(Buffer.from('never registered as evidence', 'utf8')),
          purpose: 'Agree an unknown document',
          area: 'PAYMENT_APPLICATIONS',
          requiredSignatories: signatories(),
        }),
      'SIGNATURE_DOCUMENT_UNKNOWN',
    );
  });
});
