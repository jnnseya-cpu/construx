import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, beforeEach, describe, it } from 'node:test';
import { readiness } from '../src/api/readiness.ts';
import { assertProductionSafety, config } from '../src/config.ts';
import * as envelope from '../src/evidence/envelope.ts';
import { EvidenceStore, hashBytes } from '../src/evidence/store.ts';
import { issueTokens, verifyToken } from '../src/identity/auth.ts';
import { deriveKey, keyId, resetSigningTallies, signFor, signingPosition, verifyFor } from '../src/identity/secrets.ts';
import { unsubscribeToken, verifyUnsubscribeToken } from '../src/messaging/audience.ts';

/**
 * One secret, a key per purpose, each with an id, and a rotation that signs
 * nobody out.
 *
 * `GATEWAY_JWT_SECRET` signed everything with the raw secret as the key, so a
 * rotation invalidated every session and every export tag ever handed to a
 * third party — which is why it was never rotated. What is asserted here:
 * the keys differ by purpose; every signature names its key; a token, a tag
 * and a link signed under the old secret verify while it is kept in
 * `GATEWAY_JWT_SECRET_PREVIOUS` and stop when it is dropped; and everything
 * signed in the form that predates derivation still verifies.
 */

const auth = config.auth as unknown as { jwtSecret: string; jwtSecretPrevious: string };
const ORIGINAL = { current: auth.jwtSecret, previous: auth.jwtSecretPrevious };
const OLD = 'the-secret-of-the-first-year';
const NEW = 'the-secret-of-the-second-year';

function secrets(current: string, previous = ''): void {
  auth.jwtSecret = current;
  auth.jwtSecretPrevious = previous;
}

beforeEach(() => {
  secrets(OLD);
  resetSigningTallies();
});

after(() => {
  secrets(ORIGINAL.current, ORIGINAL.previous);
});

describe('keys', () => {
  it('differ by purpose, and the id names a secret without revealing it', () => {
    const session = deriveKey('session', OLD);
    const tag = deriveKey('export-tag', OLD);
    assert.equal(session.length, 32);
    assert.notEqual(session.toString('hex'), tag.toString('hex'));
    assert.notEqual(session.toString('hex'), Buffer.from(OLD).toString('hex'));
    assert.match(keyId(OLD), /^[0-9a-f]{8}$/);
    assert.notEqual(keyId(OLD), keyId(NEW));
    assert.equal(keyId(OLD), keyId(OLD), 'stable');
  });

  it('sign under the current secret and say which', () => {
    const signed = signFor('session', 'hello');
    assert.equal(signed.kid, keyId(OLD));
    const verified = verifyFor('session', 'hello', signed.signature);
    assert.equal(verified.valid, true);
    if (verified.valid) {
      assert.equal(verified.kid, keyId(OLD));
      assert.equal(verified.legacy, false);
      assert.equal(verified.previous, false);
    }
    assert.equal(verifyFor('export-tag', 'hello', signed.signature).valid, false, 'a session signature is not an export tag');
    assert.equal(verifyFor('session', 'hello', '').valid, false);
    assert.equal(verifyFor('session', 'hello', 'nonsense').valid, false);
  });
});

describe('a session token', () => {
  const claims = { actorId: 'u1', tenantId: 't1', roles: ['PM' as const], mfaSatisfied: true };

  it('carries the key id in its header', () => {
    const { accessToken } = issueTokens(claims);
    const header = JSON.parse(Buffer.from(accessToken.split('.')[0]!, 'base64url').toString('utf8')) as { alg: string; kid: string };
    assert.equal(header.alg, 'HS256');
    assert.equal(header.kid, keyId(OLD));
    assert.equal(verifyToken(accessToken).actorId, 'u1');
  });

  it('survives a rotation while the old secret is kept, and stops when it is dropped', () => {
    const { accessToken } = issueTokens(claims);
    secrets(NEW, OLD);
    assert.equal(verifyToken(accessToken).actorId, 'u1', 'signed under the old key, verified under the previous secret');
    assert.equal(signingPosition().previousAccepted, 1);
    assert.deepEqual(signingPosition().previous, [keyId(OLD)]);
    assert.equal(signingPosition().rotationInProgress, true);

    const fresh = issueTokens(claims).accessToken;
    const header = JSON.parse(Buffer.from(fresh.split('.')[0]!, 'base64url').toString('utf8')) as { kid: string };
    assert.equal(header.kid, keyId(NEW), 'new tokens are signed under the new key');

    secrets(NEW);
    assert.throws(() => verifyToken(accessToken), /Invalid token signature/);
    assert.equal(verifyToken(fresh).actorId, 'u1');
    assert.equal(signingPosition().rotationInProgress, false);
  });

  it('minted the way the build before derivation minted it still opens', () => {
    const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const header = b64({ alg: 'HS256', typ: 'JWT' });
    const body = b64({ sub: 'u-old', tid: 't1', roles: ['PM'], scopes: [], jti: 'legacy-1', mfa: true, iat: now, iss: 'https://construxvg.com', aud: 'construx-gateway', typ: 'access', exp: now + 900 });
    const legacy = `${header}.${body}.${createHmac('sha256', OLD).update(`${header}.${body}`).digest('base64url')}`;
    assert.equal(verifyToken(legacy).actorId, 'u-old');
    assert.equal(signingPosition().legacyAccepted, 1);
    // And still after a rotation, through the previous secret's legacy form.
    secrets(NEW, OLD);
    assert.equal(verifyToken(legacy).actorId, 'u-old');
    secrets(NEW);
    assert.throws(() => verifyToken(legacy), /Invalid token signature/);
  });
});

describe('an export verification tag', () => {
  const document = { contentHash: 'sha256:abc', reference: 'CXD-000123', tenantId: 't-1' };

  it('issued under the old secret verifies through a rotation, and one issued before derivation still verifies', () => {
    const issued = envelope.issueTag(document);
    const preDerivation = createHmac('sha256', `${OLD}:export-verification`).update(`${document.tenantId}|${document.reference}|${document.contentHash}`).digest('base64url');
    assert.notEqual(issued, preDerivation, 'new tags are not made the old way');
    assert.equal(envelope.verifyTag(document, issued), true);
    assert.equal(envelope.verifyTag(document, preDerivation), true, 'a tag already handed to a third party');

    secrets(NEW, OLD);
    assert.equal(envelope.verifyTag(document, issued), true);
    assert.equal(envelope.verifyTag(document, preDerivation), true);
    assert.notEqual(envelope.issueTag(document), issued, 'a new tag is under the new key');

    secrets(NEW);
    assert.equal(envelope.verifyTag(document, issued), false, 'dropped with the old secret');
    assert.equal(envelope.verifyTag(document, preDerivation), false);
  });
});

describe('links', () => {
  it('unsubscribe: the old form and the old secret both keep working until dropped', () => {
    const preDerivation = createHmac('sha256', OLD).update('unsubscribe:user-9').digest('base64url');
    const token = unsubscribeToken('user-9');
    assert.notEqual(token, preDerivation);
    assert.equal(verifyUnsubscribeToken('user-9', token), true);
    assert.equal(verifyUnsubscribeToken('user-9', preDerivation), true);
    assert.equal(verifyUnsubscribeToken('user-8', token), false);
    secrets(NEW, OLD);
    assert.equal(verifyUnsubscribeToken('user-9', token), true);
    secrets(NEW);
    assert.equal(verifyUnsubscribeToken('user-9', token), false);
  });

  it('evidence: a link minted before a rotation is good for the rest of its minutes', () => {
    const store = new EvidenceStore('');
    const hash = hashBytes(Buffer.from('a photograph'));
    const { url } = store.signedUrl('tenant-a', hash, 300);
    const query = new URLSearchParams(url.split('?')[1]);
    const expires = Number(query.get('expires'));
    const signature = query.get('signature')!;
    assert.equal(store.verifySignedUrl('tenant-a', hash, expires, signature), true);
    // The form links carried before derivation.
    const preDerivation = createHmac('sha256', OLD).update(`tenant-a\n${hash}\n${expires}`).digest('hex');
    assert.equal(store.verifySignedUrl('tenant-a', hash, expires, preDerivation), true);
    secrets(NEW, OLD);
    assert.equal(store.verifySignedUrl('tenant-a', hash, expires, signature), true);
    secrets(NEW);
    assert.equal(store.verifySignedUrl('tenant-a', hash, expires, signature), false);
    assert.equal(store.verifySignedUrl('tenant-a', hash, expires, 'not hex!'), false);
  });

  it('evidence: a store carrying a secret of its own uses it alone', () => {
    const own = new EvidenceStore('', { secret: 'a-store-of-its-own' });
    const hash = hashBytes(Buffer.from('bytes'));
    const query = new URLSearchParams(own.signedUrl('tenant-a', hash, 300).url.split('?')[1]);
    assert.equal(own.verifySignedUrl('tenant-a', hash, Number(query.get('expires')), query.get('signature')!), true);
    const deployment = new EvidenceStore('');
    assert.equal(deployment.verifySignedUrl('tenant-a', hash, Number(query.get('expires')), query.get('signature')!), false, 'not the deployment’s key');
  });
});

describe('what the operator sees', () => {
  it('names the key and the rotation on readiness, and warns about a rotation that has not happened', () => {
    secrets(NEW, OLD);
    const capability = readiness().capabilities.find((entry) => entry.key === 'auth.secret')!;
    assert.equal(capability.state, 'CONFIGURED');
    assert.match(capability.detail, new RegExp(`key id ${keyId(NEW)}`));
    assert.match(capability.detail, /rotation is in progress/);
    assert.ok(capability.env.includes('GATEWAY_JWT_SECRET_PREVIOUS'));

    const previousEnv = config.env;
    (config as unknown as { env: string }).env = 'production';
    try {
      secrets(NEW, NEW);
      assert.ok(assertProductionSafety().some((warning) => /contains the current secret/.test(warning)));
      secrets(NEW, 'construx-development-secret');
      assert.ok(assertProductionSafety().some((warning) => /published development default/.test(warning)));
    } finally {
      (config as unknown as { env: string }).env = previousEnv;
    }
  });
});
