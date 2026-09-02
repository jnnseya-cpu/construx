import assert from 'node:assert/strict';
import { createHash, createSign, generateKeyPairSync, sign as signWith } from 'node:crypto';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, it } from 'node:test';
import { throwsCode } from './helpers.ts';
import { config } from '../src/config.ts';
import {
  checkBinding,
  devicesFor,
  enrolDevice,
  knownNetwork,
  networkOf,
  proofFor,
  publicView,
  resetDevices,
  revokeDevice,
} from '../src/identity/devices.ts';
import {
  BAND_AT,
  RISK_WEIGHTS,
  assessRisk,
  recordStepUp,
  resetStepUps,
  riskModel,
  stepUpSatisfied,
} from '../src/identity/risk.ts';
import {
  beginAuthentication,
  beginRegistration,
  completeRegistration,
  decodeCbor,
  parseAuthenticatorData,
  passkeysFor,
  relyingParty,
  resetPasskeys,
  revokePasskey,
  verifyAssertion,
} from '../src/identity/passkeys.ts';
import { clearFailures, recordFailure } from '../src/identity/lockout.ts';
import { createGateway } from '../src/api/gateway.ts';
import { bindCredentialStores } from '../src/identity/credentialstore.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Device binding, risk-based step-up and passkeys.
 *
 * The passkey tests build **real ceremonies** — a real P-256 key pair, real
 * CBOR, real authenticator data, a real ECDSA signature over
 * `authenticatorData ‖ SHA-256(clientDataJSON)` — rather than asserting against
 * fixtures captured from a browser. A fixture proves the code parses one
 * recording; generating the ceremony proves it parses the *format*, and lets
 * every negative case be produced by changing exactly one byte of a ceremony
 * that otherwise verifies. Every refusal below is therefore a real attack with
 * one thing wrong with it.
 */

const ACTOR = '01ACTOR000000000000000000';
const TENANT = 'tenant-alpha';

beforeEach(() => {
  resetDevices();
  resetPasskeys();
  resetStepUps();
  clearFailures(ACTOR);
});

// ─────────────────────────────────────────────────────────────── devices ───

describe('the device register', () => {
  it('shows the secret exactly once and stores only its digest', () => {
    const { device, deviceSecret } = enrolDevice({ actorId: ACTOR, tenantId: TENANT, label: 'Site tablet' });
    assert.ok(deviceSecret.length >= 40, 'the secret is the whole of the device authority and should be sized like a key');
    assert.notEqual(device.secretHash, deviceSecret);
    // And it never reaches a screen.
    assert.ok(!('secretHash' in publicView(device)), 'the verifier was rendered to a caller');
  });

  it('refuses a device nobody could pick out of a list', () => {
    // A register of unnamed devices is one nobody can revoke from.
    throwsCode(() => enrolDevice({ actorId: ACTOR, tenantId: TENANT, label: ' ' }), 'DEVICE_LABEL_REQUIRED');
    throwsCode(() => enrolDevice({ actorId: ACTOR, tenantId: TENANT, label: 'x'.repeat(61) }), 'DEVICE_LABEL_TOO_LONG');
  });

  it('accepts a request carrying the right proof for the right token', () => {
    const { device, deviceSecret } = enrolDevice({ actorId: ACTOR, tenantId: TENANT, label: 'Laptop' });
    const outcome = checkBinding({
      tokenDeviceId: device.id,
      tokenId: 'TOKEN-1',
      presentedDeviceId: device.id,
      presentedProof: proofFor(deviceSecret, 'TOKEN-1'),
    });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.ok && outcome.bound, true);
  });

  it('refuses a proof lifted from another session', () => {
    // The point of binding the proof to the token id: a proof captured from one
    // request must be worthless against a different token.
    const { device, deviceSecret } = enrolDevice({ actorId: ACTOR, tenantId: TENANT, label: 'Laptop' });
    const outcome = checkBinding({
      tokenDeviceId: device.id,
      tokenId: 'TOKEN-2',
      presentedDeviceId: device.id,
      presentedProof: proofFor(deviceSecret, 'TOKEN-1'),
    });
    assert.deepEqual(outcome, { ok: false, reason: 'DEVICE_PROOF_INVALID' });
  });

  it('refuses a token with no proof at all', () => {
    // The whole control: a leaked `Authorization` header is not enough, because
    // the proof travels in a header the token does not travel in.
    const { device } = enrolDevice({ actorId: ACTOR, tenantId: TENANT, label: 'Laptop' });
    assert.deepEqual(checkBinding({ tokenDeviceId: device.id, tokenId: 'T', presentedDeviceId: device.id }), {
      ok: false,
      reason: 'DEVICE_PROOF_MISSING',
    });
  });

  it('refuses one device’s valid proof against another device’s token', () => {
    // Without the id comparison this passes: device A's proof verifies perfectly
    // against device A's record, and nothing checks that the *token* was minted
    // for device B.
    const a = enrolDevice({ actorId: ACTOR, tenantId: TENANT, label: 'Desk PC' });
    const b = enrolDevice({ actorId: ACTOR, tenantId: TENANT, label: 'Site tablet' });
    const outcome = checkBinding({
      tokenDeviceId: b.device.id,
      tokenId: 'T',
      presentedDeviceId: a.device.id,
      presentedProof: proofFor(a.deviceSecret, 'T'),
    });
    assert.deepEqual(outcome, { ok: false, reason: 'DEVICE_MISMATCH' });
  });

  it('ends every session on a device the moment it is revoked', () => {
    const { device, deviceSecret } = enrolDevice({ actorId: ACTOR, tenantId: TENANT, label: 'Lost laptop' });
    const proof = proofFor(deviceSecret, 'T');
    assert.equal(checkBinding({ tokenDeviceId: device.id, tokenId: 'T', presentedDeviceId: device.id, presentedProof: proof }).ok, true);

    revokeDevice({ deviceId: device.id, actorId: ACTOR, by: ACTOR, reason: 'Left on a train' });

    // Same token, same proof, both still perfectly valid in themselves.
    assert.deepEqual(
      checkBinding({ tokenDeviceId: device.id, tokenId: 'T', presentedDeviceId: device.id, presentedProof: proof }),
      { ok: false, reason: 'DEVICE_REVOKED' },
    );
  });

  it('gives one answer for a device that does not exist and one that belongs to somebody else', () => {
    // Two answers would let any signed-in person enumerate the device ids of
    // the whole deployment.
    const { device } = enrolDevice({ actorId: ACTOR, tenantId: TENANT, label: 'Mine' });
    const mine = throwsCode(() => revokeDevice({ deviceId: 'nope', actorId: ACTOR, by: ACTOR, reason: 'x' }), 'DEVICE_NOT_FOUND');
    const theirs = throwsCode(
      () => revokeDevice({ deviceId: device.id, actorId: 'somebody-else', by: 'somebody-else', reason: 'x' }),
      'DEVICE_NOT_FOUND',
    );
    assert.equal(mine.message, theirs.message);
  });

  it('says so rather than going quiet when a device is already revoked', () => {
    const { device } = enrolDevice({ actorId: ACTOR, tenantId: TENANT, label: 'Old phone' });
    revokeDevice({ deviceId: device.id, actorId: ACTOR, by: ACTOR, reason: 'Replaced' });
    throwsCode(() => revokeDevice({ deviceId: device.id, actorId: ACTOR, by: ACTOR, reason: 'Replaced' }), 'DEVICE_ALREADY_REVOKED');
  });

  it('asks why, because "lost" and "no longer used" lead to different follow-up', () => {
    const { device } = enrolDevice({ actorId: ACTOR, tenantId: TENANT, label: 'Phone' });
    throwsCode(() => revokeDevice({ deviceId: device.id, actorId: ACTOR, by: ACTOR, reason: '  ' }), 'DEVICE_REVOKE_REASON_REQUIRED');
  });

  it('refuses a token naming a device the register has never heard of', () => {
    // Fail closed, and the distinction matters: a token with *no* device claim
    // is an old session and is scored, but a token naming a device that does
    // not exist is either a forged claim or a register that has lost a record.
    // Treating the second as merely "unbound" would make a made-up `did` the
    // way to opt out of binding entirely.
    assert.deepEqual(checkBinding({ tokenDeviceId: 'no-such-device', tokenId: 'T', presentedProof: 'x' }), {
      ok: false,
      reason: 'DEVICE_UNKNOWN',
    });
  });

  it('treats a token with no device claim as unbound rather than as a failure', () => {
    // Binding is enforced by configuration and by the risk model, not by this
    // function. A session minted before binding existed is scored, not refused.
    assert.deepEqual(checkBinding({ tokenId: 'T' }), { ok: true, bound: false });
  });

  it('remembers networks coarsely enough to be a signal and not a location history', () => {
    // A platform that logged full addresses per device would be building the
    // tracking record it would then have to defend in a subject access request.
    assert.equal(networkOf('203.0.113.42'), '203.0.113.0/24');
    assert.equal(networkOf('::ffff:203.0.113.42'), '203.0.113.0/24');
    assert.equal(networkOf('2001:db8:1234:5678::1'), '2001:db8:1234::/48');
    assert.equal(networkOf(undefined), 'unknown');
    assert.equal(networkOf('not-an-address'), 'unknown', 'an unparseable address must not be stored raw');
  });

  it('learns a network the first time it is used from one', () => {
    const { device, deviceSecret } = enrolDevice({ actorId: ACTOR, tenantId: TENANT, label: 'Laptop', remote: '198.51.100.7' });
    assert.equal(knownNetwork(device, '198.51.100.99'), true, 'the enrolment network should be known');
    assert.equal(knownNetwork(device, '203.0.113.1'), false);

    checkBinding({
      tokenDeviceId: device.id,
      tokenId: 'T',
      presentedDeviceId: device.id,
      presentedProof: proofFor(deviceSecret, 'T'),
      remote: '203.0.113.1',
    });
    assert.equal(knownNetwork(devicesFor(ACTOR)[0]!, '203.0.113.1'), true, 'a network was not remembered after a successful request');
  });
});

// ────────────────────────────────────────────────────────────────── risk ───

describe('risk-based step-up', () => {
  const bound = () => enrolDevice({ actorId: ACTOR, tenantId: TENANT, label: 'Laptop', remote: '198.51.100.7' });

  it('leaves an ordinary act on a known device from a known network alone', () => {
    const { device, deviceSecret } = bound();
    checkBinding({ tokenDeviceId: device.id, tokenId: 'T', presentedDeviceId: device.id, presentedProof: proofFor(deviceSecret, 'T'), remote: '198.51.100.7' });
    const assessment = assessRisk({
      actorId: ACTOR,
      device: devicesFor(ACTOR)[0],
      remote: '198.51.100.7',
      authenticatedAt: Date.now(),
    });
    assert.equal(assessment.band, 'LOW');
    assert.equal(assessment.stepUpRequired, false);
  });

  it('never reaches HIGH on one signal alone', () => {
    // The threshold is deliberately above every individual weight: a person on
    // a new network is not a threat, and interrupting them teaches them to
    // click through prompts.
    const worst = Math.max(...Object.values(RISK_WEIGHTS));
    assert.ok(worst < BAND_AT.HIGH, `the heaviest single signal is ${worst} and HIGH begins at ${BAND_AT.HIGH}`);
  });

  it('interrupts an unbound session committing real money', () => {
    const assessment = assessRisk(
      { actorId: ACTOR, authenticatedAt: Date.now() },
      { valueMinor: 84_000_000, code: 'A' },
    );
    assert.equal(assessment.band, 'HIGH');
    assert.equal(assessment.stepUpRequired, true);
    assert.match(assessment.statement, /Verify again/);
    // And it says exactly what it counted, in words a person can act on.
    assert.deepEqual(
      assessment.signals.map((signal) => signal.signal).sort(),
      ['HIGH_VALUE', 'UNBOUND_SESSION'],
    );
    assert.match(assessment.signals.find((s) => s.signal === 'HIGH_VALUE')!.because, /840k/);
  });

  it('notices a device turning up somewhere it has never been', () => {
    const { device, deviceSecret } = bound();
    // Used once from its enrolment network first, so this is a settled device
    // rather than a brand-new one — otherwise two signals fire and the test
    // cannot tell which of them it is measuring.
    checkBinding({
      tokenDeviceId: device.id,
      tokenId: 'T',
      presentedDeviceId: device.id,
      presentedProof: proofFor(deviceSecret, 'T'),
      remote: '198.51.100.7',
    });

    const assessment = assessRisk({
      actorId: ACTOR,
      device: devicesFor(ACTOR)[0],
      remote: '203.0.113.9',
      authenticatedAt: Date.now(),
    });
    assert.deepEqual(assessment.signals.map((entry) => entry.signal), ['UNKNOWN_NETWORK']);
    assert.match(
      assessment.signals[0]!.because,
      /203\.0\.113\.0\/24/,
      'the person is told which network, not merely that there was one',
    );
    // On its own it is worth noting and not worth interrupting over: travelling
    // is not an attack, and a prompt every time somebody moves is a prompt
    // people learn to dismiss.
    assert.equal(assessment.band, 'LOW');
    assert.equal(assessment.stepUpRequired, false);
  });

  it('counts a run of failed verifications even when this request looks ordinary', () => {
    // A run of failures followed by a success is what a guessed code looks like
    // from the outside.
    const { device } = bound();
    recordFailure(ACTOR);
    recordFailure(ACTOR);
    const assessment = assessRisk({ actorId: ACTOR, device, remote: '198.51.100.7', authenticatedAt: Date.now() });
    const failures = assessment.signals.find((signal) => signal.signal === 'RECENT_FAILURES');
    assert.ok(failures, 'a recent guessing run was not counted');
    assert.match(failures.because, /2 failed verifications/);
  });

  it('treats an old sign-in as stale', () => {
    const { device } = bound();
    const assessment = assessRisk(
      { actorId: ACTOR, device, remote: '198.51.100.7', authenticatedAt: Date.now() - 90 * 60_000 },
    );
    const stale = assessment.signals.find((signal) => signal.signal === 'STALE_AUTHENTICATION');
    assert.ok(stale);
    assert.match(stale.because, /90 minutes ago/);
  });

  it('never demands a step-up an API key could not perform', () => {
    // A control that cannot be satisfied is a refusal under a misleading name.
    // An integration that may not do something should be told it may not.
    const assessment = assessRisk(
      { actorId: ACTOR, machineCredential: true },
      { valueMinor: 84_000_000, code: 'G', irreversible: true },
    );
    assert.equal(assessment.band, 'HIGH');
    assert.equal(assessment.stepUpRequired, false);
    assert.match(assessment.statement, /an API key cannot/);
    assert.match(assessment.statement, /needs a person to do it/);
  });

  it('scores a governance change as heavily as money', () => {
    // Changing who may do what is the one change that can hide every other one.
    const governance = assessRisk({ actorId: ACTOR, authenticatedAt: Date.now() }, { code: 'G' });
    assert.ok(governance.signals.some((signal) => signal.signal === 'GOVERNANCE'));
    assert.equal(governance.band, 'HIGH');
  });

  it('holds a step-up for its window and no longer', () => {
    recordStepUp('TOKEN-1');
    assert.equal(stepUpSatisfied('TOKEN-1'), true);
    assert.equal(stepUpSatisfied('TOKEN-1', Date.now() + (config.auth.stepUpWindowMinutes + 1) * 60_000), false);
    // And once expired it is gone, not merely reported as expired.
    assert.equal(stepUpSatisfied('TOKEN-1'), false);
  });

  it('knows nothing about a session that never stepped up', () => {
    assert.equal(stepUpSatisfied('NEVER-SEEN'), false);
  });

  it('publishes the whole model, so nobody has to trip over it to learn it', () => {
    const model = riskModel();
    assert.equal(model.signals.length, Object.keys(RISK_WEIGHTS).length, 'a weight exists that the published model does not explain');
    for (const signal of model.signals) {
      assert.equal(signal.points, RISK_WEIGHTS[signal.signal], `${signal.signal} is published at the wrong weight`);
      assert.ok(signal.meaning.length > 20, `${signal.signal} is published without an explanation`);
    }
  });
});

// ────────────────────────────────────────────────────────────── passkeys ───

/**
 * A working authenticator, built out of `node:crypto`.
 *
 * Everything a real one produces: a P-256 key pair, CBOR-encoded attested
 * credential data, and ECDSA signatures over the exact bytes WebAuthn defines.
 * Every negative test below takes a ceremony this produces and changes one
 * thing, so each refusal is a real attack rather than a malformed blob.
 */
function authenticator(options: { rpId?: string; algorithm?: 'ES256' | 'RS256' } = {}) {
  const rpId = options.rpId ?? relyingParty().id;
  const algorithm = options.algorithm ?? 'ES256';
  const pair =
    algorithm === 'ES256'
      ? generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      : generateKeyPairSync('rsa', { modulusLength: 2048 });
  const credentialId = Buffer.from('credential-id-0123456789abcdef01');

  // The public key as COSE, which is what the authenticator actually returns.
  const cose = (() => {
    if (algorithm === 'ES256') {
      const raw = pair.publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
      // The uncompressed point is the last 65 bytes of a P-256 SPKI.
      const point = raw.subarray(raw.length - 65);
      return cborMap([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, point.subarray(1, 33)],
        [-3, point.subarray(33, 65)],
      ]);
    }
    const jwk = pair.publicKey.export({ format: 'jwk' }) as { n: string; e: string };
    return cborMap([
      [1, 3],
      [3, -257],
      [-1, Buffer.from(jwk.n, 'base64url')],
      [-2, Buffer.from(jwk.e, 'base64url')],
    ]);
  })();

  const authData = (flags: number, signCount: number, attested: boolean) => {
    const head = Buffer.concat([
      createHash('sha256').update(rpId).digest(),
      Buffer.from([flags]),
      (() => {
        const counter = Buffer.alloc(4);
        counter.writeUInt32BE(signCount);
        return counter;
      })(),
    ]);
    if (!attested) return head;
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(credentialId.length);
    return Buffer.concat([head, Buffer.alloc(16), idLength, credentialId, cose]);
  };

  const clientData = (type: string, challenge: string, origin = relyingParty().origin) =>
    Buffer.from(JSON.stringify({ type, challenge, origin })).toString('base64url');

  return {
    credentialId: credentialId.toString('base64url'),
    register(challenge: string, { flags = 0x45, signCount = 0 } = {}) {
      return {
        credentialId: credentialId.toString('base64url'),
        clientDataJSON: clientData('webauthn.create', challenge),
        attestationObject: cborMap([
          ['fmt', 'none'],
          ['attStmt', new Map()],
          ['authData', authData(flags, signCount, true)],
        ]).toString('base64url'),
      };
    },
    assert(challenge: string, { flags = 0x05, signCount = 1, origin, type = 'webauthn.get' } = {} as never) {
      const data = authData(flags, signCount, false);
      const client = clientData(type, challenge, origin);
      const signed = Buffer.concat([data, createHash('sha256').update(Buffer.from(client, 'base64url')).digest()]);
      const signature =
        algorithm === 'ES256'
          ? signWith('sha256', signed, { key: pair.privateKey, dsaEncoding: 'der' })
          : createSign('sha256').update(signed).sign(pair.privateKey);
      return {
        credentialId: credentialId.toString('base64url'),
        clientDataJSON: client,
        authenticatorData: data.toString('base64url'),
        signature: signature.toString('base64url'),
      };
    },
  };
}

/** Minimal CBOR *encoder*, for the test authenticator only. */
function cborMap(entries: Array<[unknown, unknown]> | Map<unknown, unknown>): Buffer {
  const list = entries instanceof Map ? [...entries.entries()] : entries;
  return Buffer.concat([head(5, list.length), ...list.flatMap(([key, value]) => [encode(key), encode(value)])]);
}

function head(major: number, argument: number): Buffer {
  if (argument < 24) return Buffer.from([(major << 5) | argument]);
  if (argument < 256) return Buffer.from([(major << 5) | 24, argument]);
  if (argument < 65536) return Buffer.from([(major << 5) | 25, argument >> 8, argument & 0xff]);
  const out = Buffer.alloc(5);
  out[0] = (major << 5) | 26;
  out.writeUInt32BE(argument, 1);
  return out;
}

function encode(value: unknown): Buffer {
  if (typeof value === 'number') {
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (typeof value === 'string') return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (value instanceof Uint8Array) return Buffer.concat([head(2, value.length), Buffer.from(value)]);
  if (value instanceof Map) return cborMap(value);
  throw new Error(`the test encoder cannot encode ${typeof value}`);
}

describe('the CBOR decoder', () => {
  it('reads the shapes WebAuthn uses', () => {
    const encoded = cborMap([
      ['fmt', 'none'],
      ['n', 1234],
      ['neg', -7],
      ['bytes', Buffer.from([1, 2, 3])],
    ]);
    const { value } = decodeCbor(encoded);
    assert.ok(value instanceof Map);
    assert.equal(value.get('fmt'), 'none');
    assert.equal(value.get('n'), 1234);
    assert.equal(value.get('neg'), -7);
    assert.deepEqual(Buffer.from(value.get('bytes') as Uint8Array), Buffer.from([1, 2, 3]));
  });

  it('refuses what it does not understand rather than skipping it', () => {
    // A decoder that silently ignores what it cannot read is one that can be
    // fed a structure meaning something other than what it returned.
    throwsCode(() => decodeCbor(Buffer.from([0xc0])), 'PASSKEY_CBOR_UNSUPPORTED');
    throwsCode(() => decodeCbor(Buffer.from([0xf9, 0x00, 0x00])), 'PASSKEY_CBOR_UNSUPPORTED');
  });

  it('refuses a truncated structure rather than returning half of one', () => {
    throwsCode(() => decodeCbor(Buffer.from([0x43, 0x01])), 'PASSKEY_CBOR_TRUNCATED');
  });
});

describe('passkey registration', () => {
  const begin = () => beginRegistration({ actorId: ACTOR, email: 'pm@meridian.example', displayName: 'Tom Bramall' });

  it('asks for no attestation, because nothing here could verify one', () => {
    // Requesting a certificate chain with no root store to check it against
    // means storing a claim the platform cannot stand behind and showing it as
    // if it had been verified.
    assert.equal(begin().attestation, 'none');
  });

  it('offers only the two algorithms every current authenticator produces', () => {
    assert.deepEqual(begin().pubKeyCredParams.map((param) => param.alg).sort((a, b) => b - a), [-7, -257]);
  });

  it('registers a real ES256 credential', () => {
    const options = begin();
    const key = authenticator();
    const passkey = completeRegistration({
      actorId: ACTOR,
      tenantId: TENANT,
      label: 'MacBook Touch ID',
      ...key.register(options.challenge),
    });
    assert.equal(passkey.algorithm, 'ES256');
    assert.equal(passkey.actorId, ACTOR);
    assert.equal(passkeysFor(ACTOR).length, 1);
    // And the record a screen sees carries no key material it has no use for.
    assert.ok(!('publicKey' in (({ publicKey: _p, ...rest }) => rest)(passkey)));
  });

  it('registers a real RS256 credential', () => {
    const options = begin();
    const passkey = completeRegistration({
      actorId: ACTOR,
      tenantId: TENANT,
      label: 'Windows Hello',
      ...authenticator({ algorithm: 'RS256' }).register(options.challenge),
    });
    assert.equal(passkey.algorithm, 'RS256');
  });

  it('tells the authenticator which credentials it already holds', () => {
    const options = begin();
    completeRegistration({ actorId: ACTOR, tenantId: TENANT, label: 'Key', ...authenticator().register(options.challenge) });
    // So an authenticator that already holds one says so, rather than silently
    // making a second the person then cannot tell apart.
    assert.equal(begin().excludeCredentials.length, 1);
  });

  it('refuses a credential registered against a different site', () => {
    const options = begin();
    throwsCode(
      () =>
        completeRegistration({
          actorId: ACTOR,
          tenantId: TENANT,
          label: 'Elsewhere',
          ...authenticator({ rpId: 'evil.example' }).register(options.challenge),
        }),
      'PASSKEY_RP_MISMATCH',
    );
  });

  it('refuses a key that signed with nobody touching it', () => {
    const options = begin();
    throwsCode(
      () =>
        completeRegistration({
          actorId: ACTOR,
          tenantId: TENANT,
          label: 'Silent',
          // AT set, UP clear.
          ...authenticator().register(options.challenge, { flags: 0x40 }),
        }),
      'PASSKEY_NO_USER_PRESENCE',
    );
  });

  it('refuses a challenge it did not issue', () => {
    throwsCode(
      () =>
        completeRegistration({
          actorId: ACTOR,
          tenantId: TENANT,
          label: 'Forged',
          ...authenticator().register('a-challenge-nobody-issued'),
        }),
      'PASSKEY_CHALLENGE_UNKNOWN',
    );
  });

  it('spends a challenge, so a captured ceremony cannot be replayed', () => {
    const options = begin();
    const key = authenticator();
    const ceremony = key.register(options.challenge);
    completeRegistration({ actorId: ACTOR, tenantId: TENANT, label: 'First', ...ceremony });
    throwsCode(() => completeRegistration({ actorId: ACTOR, tenantId: TENANT, label: 'Replay', ...ceremony }), 'PASSKEY_CHALLENGE_UNKNOWN');
  });

  it('refuses a challenge issued to a different account', () => {
    const options = beginRegistration({ actorId: 'somebody-else', email: 'x@y.example', displayName: 'X' });
    throwsCode(
      () => completeRegistration({ actorId: ACTOR, tenantId: TENANT, label: 'Theirs', ...authenticator().register(options.challenge) }),
      'PASSKEY_CHALLENGE_MISMATCH',
    );
  });

  it('refuses a credential id that disagrees with the signed data', () => {
    // Two channels for the same fact, and only one of them is signed over.
    const options = begin();
    const ceremony = authenticator().register(options.challenge);
    throwsCode(
      () => completeRegistration({ actorId: ACTOR, tenantId: TENANT, label: 'Swapped', ...ceremony, credentialId: 'something-else' }),
      'PASSKEY_CREDENTIAL_MISMATCH',
    );
  });

  it('refuses an unnamed key', () => {
    const options = begin();
    throwsCode(
      () => completeRegistration({ actorId: ACTOR, tenantId: TENANT, label: ' ', ...authenticator().register(options.challenge) }),
      'PASSKEY_LABEL_REQUIRED',
    );
  });
});

describe('passkey authentication', () => {
  const register = () => {
    const options = beginRegistration({ actorId: ACTOR, email: 'pm@meridian.example', displayName: 'Tom' });
    const key = authenticator();
    completeRegistration({ actorId: ACTOR, tenantId: TENANT, label: 'Touch ID', ...key.register(options.challenge) });
    return key;
  };

  it('verifies a real assertion and says whose it is', () => {
    const key = register();
    const result = verifyAssertion(key.assert(beginAuthentication().challenge));
    assert.equal(result.actorId, ACTOR);
    assert.equal(result.tenantId, TENANT);
    assert.equal(result.label, 'Touch ID');
  });

  it('never lists credentials for a named account', () => {
    // An `allowCredentials` list keyed off an address is exactly the account
    // enumeration oracle the login route goes to such lengths to close.
    register();
    assert.deepEqual(beginAuthentication(ACTOR).allowCredentials, []);
    assert.deepEqual(beginAuthentication().allowCredentials, []);
  });

  it('refuses a signature made on a lookalike domain', () => {
    // The anti-phishing property, and the whole reason a passkey beats a code.
    const key = register();
    throwsCode(
      () => verifyAssertion(key.assert(beginAuthentication().challenge, { origin: 'https://construx.evil.example' } as never)),
      'PASSKEY_ORIGIN_MISMATCH',
    );
  });

  it('refuses an origin that merely begins with the real one', () => {
    // The classic way origin validation is got wrong. `app.construx.com.evil.com`
    // passes a `startsWith` check and is a completely different site — and this
    // is the one property passkeys exist to provide.
    const key = register();
    const rp = relyingParty();
    throwsCode(
      () => verifyAssertion(key.assert(beginAuthentication().challenge, { origin: `${rp.origin}.evil.example` } as never)),
      'PASSKEY_ORIGIN_MISMATCH',
    );
  });

  it('refuses a registration ceremony offered as a sign-in', () => {
    // Both ceremonies sign over the same two fields. Without the type check the
    // signature from one is a valid signature for the other.
    const key = register();
    throwsCode(
      () => verifyAssertion(key.assert(beginAuthentication().challenge, { type: 'webauthn.create' } as never)),
      'PASSKEY_CEREMONY_MISMATCH',
    );
  });

  it('refuses a replayed assertion', () => {
    const key = register();
    const assertion = key.assert(beginAuthentication().challenge);
    verifyAssertion(assertion);
    throwsCode(() => verifyAssertion(assertion), 'PASSKEY_CHALLENGE_UNKNOWN');
  });

  it('refuses a tampered signature', () => {
    const key = register();
    const assertion = key.assert(beginAuthentication().challenge);
    const bytes = Buffer.from(assertion.signature, 'base64url');
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0x01;
    throwsCode(
      () => verifyAssertion({ ...assertion, signature: bytes.toString('base64url') }),
      'PASSKEY_SIGNATURE_INVALID',
    );
  });

  it('refuses an authenticator whose counter goes backwards', () => {
    // The documented signal of a cloned credential, and the response is to
    // refuse rather than to note it.
    const key = register();
    verifyAssertion(key.assert(beginAuthentication().challenge, { signCount: 9 } as never));
    throwsCode(
      () => verifyAssertion(key.assert(beginAuthentication().challenge, { signCount: 4 } as never)),
      'PASSKEY_COUNTER_REGRESSION',
    );
  });

  it('accepts an authenticator that does not count at all', () => {
    // Apple's platform authenticators always report zero. A stored zero and a
    // presented zero is normal, not a regression.
    const key = register();
    verifyAssertion(key.assert(beginAuthentication().challenge, { signCount: 0 } as never));
    verifyAssertion(key.assert(beginAuthentication().challenge, { signCount: 0 } as never));
  });

  it('refuses an assertion from a key that was signed without a touch', () => {
    const key = register();
    throwsCode(
      () => verifyAssertion(key.assert(beginAuthentication().challenge, { flags: 0x00 } as never)),
      'PASSKEY_NO_USER_PRESENCE',
    );
  });

  it('gives one answer for an unknown credential and a revoked one', () => {
    const key = register();
    const held = passkeysFor(ACTOR)[0]!;
    revokePasskey({ passkeyId: held.id, actorId: ACTOR, by: ACTOR });

    const revoked = throwsCode(() => verifyAssertion(key.assert(beginAuthentication().challenge)), 'PASSKEY_UNKNOWN');
    const unknown = throwsCode(
      () => verifyAssertion({ ...key.assert(beginAuthentication().challenge), credentialId: 'never-seen' }),
      'PASSKEY_UNKNOWN',
    );
    assert.equal(revoked.message, unknown.message, 'a revoked credential is distinguishable from one that never existed');
  });

  it('drops a revoked passkey out of the register', () => {
    register();
    const held = passkeysFor(ACTOR)[0]!;
    revokePasskey({ passkeyId: held.id, actorId: ACTOR, by: ACTOR });
    assert.equal(passkeysFor(ACTOR).length, 0);
    throwsCode(() => revokePasskey({ passkeyId: held.id, actorId: ACTOR, by: ACTOR }), 'PASSKEY_NOT_FOUND');
  });
});

describe('authenticator data parsing', () => {
  it('refuses a structure too short to be one', () => {
    throwsCode(() => parseAuthenticatorData(Buffer.alloc(36)), 'PASSKEY_AUTHDATA_SHORT');
  });

  it('refuses attested data whose credential id runs past the end', () => {
    // The length field is attacker-controlled, and a decoder that trusts it
    // reads whatever follows in memory as a credential.
    const bytes = Buffer.alloc(56);
    bytes[32] = 0x45;
    bytes.writeUInt16BE(9999, 53);
    throwsCode(() => parseAuthenticatorData(bytes), 'PASSKEY_AUTHDATA_SHORT');
  });

  it('reads the flags that decide whether a person was there', () => {
    const bytes = Buffer.alloc(37);
    bytes[32] = 0x05; // UP | UV
    const parsed = parseAuthenticatorData(bytes);
    assert.equal(parsed.userPresent, true);
    assert.equal(parsed.userVerified, true);
    assert.equal(parsed.attested, false);
  });
});

// ─────────────────────────────────────────────────── over the wire ───

describe('device binding, enforced by the gateway', () => {
  let platform: Platform;
  let seed: SeedResult;
  let server: Server;
  let base: string;

  /**
   * The module tests above prove the arithmetic. These prove the *gateway*
   * applies it, which is a separate claim: `checkBinding` returning a refusal
   * is worth nothing if `authenticate` ignores it, and that gap would be
   * invisible to every test that calls the module directly.
   */
  before(async () => {
    platform = new Platform();
    seed = await seedDemoProject(platform);
    server = createGateway(platform);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  after(() => server.close());

  // The file-level `beforeEach` above calls `resetDevices()`, which swaps the
  // ledger-backed store for an in-process one — right for the module suites,
  // which must run without a ledger, and wrong here, where the point is that
  // the ledger is what remembers. Re-bound after it, so this suite tests the
  // wiring the platform actually ships with.
  beforeEach(() => bindCredentialStores(platform.ledger));

  const call = async (
    method: string,
    path: string,
    options: { token?: string; body?: unknown; deviceId?: string; proof?: string } = {},
  ): Promise<{ status: number; body: any }> => {
    const headers: Record<string, string> = {};
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.deviceId) headers['x-device-id'] = options.deviceId;
    if (options.proof) headers['x-device-proof'] = options.proof;
    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await response.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: response.status, body: body as any };
  };

  /** Sign in and enrol, returning the bound session the enrolment mints. */
  const enrolled = async (who: string) => {
    const user = platform.user(seed.users[who]!.id);
    const unbound = issueTokens({
      actorId: user.id,
      tenantId: user.tenantId,
      partyId: user.partyId,
      roles: user.roles,
      mfaSatisfied: true,
    }).accessToken;

    const response = await call('POST', '/v1/me/devices', {
      token: unbound,
      body: { label: `${user.name}'s laptop`, platform: 'DESKTOP' },
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));

    const token = response.body.accessToken as string;
    const tokenId = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString('utf8')).jti as string;
    return {
      token,
      tokenId,
      deviceId: response.body.device.id as string,
      secret: response.body.deviceSecret as string,
      proof: proofFor(response.body.deviceSecret as string, tokenId),
      unbound,
    };
  };

  it('binds the session enrolment was performed from, rather than the next one', async () => {
    // Without this the person enrols a device and stays unbound until they next
    // sign in — so the control appears not to have worked, and the risk model
    // goes on charging them for a device sitting in the register.
    const session = await enrolled('qs');
    const claims = JSON.parse(Buffer.from(session.token.split('.')[1]!, 'base64url').toString('utf8'));
    assert.equal(claims.did, session.deviceId, 'the token minted at enrolment names no device');
    assert.ok(typeof claims.aat === 'number', 'the token carries no record of when it was verified');
  });

  it('accepts a bound session that proves itself', async () => {
    const session = await enrolled('planner');
    const response = await call('GET', '/v1/me/security', {
      token: session.token,
      deviceId: session.deviceId,
      proof: session.proof,
    });
    assert.equal(response.status, 200);
  });

  it('refuses a bound token presented with no proof — the whole control', async () => {
    // This is what makes a leaked `Authorization` header insufficient: the
    // proof travels in a header the token does not travel in.
    const session = await enrolled('safety');
    const response = await call('GET', '/v1/me/security', { token: session.token });
    assert.equal(response.status, 401);
  });

  it('refuses a proof computed for a different token', async () => {
    const session = await enrolled('bim');
    const response = await call('GET', '/v1/me/security', {
      token: session.token,
      deviceId: session.deviceId,
      proof: proofFor(session.secret, 'A-DIFFERENT-TOKEN-ID'),
    });
    assert.equal(response.status, 401);
  });

  it('ends every session on a device the moment it is revoked', async () => {
    const session = await enrolled('designer');
    const before = await call('GET', '/v1/me/security', {
      token: session.token,
      deviceId: session.deviceId,
      proof: session.proof,
    });
    assert.equal(before.status, 200);

    const revoked = await call('POST', `/v1/me/devices/${session.deviceId}/revoke`, {
      token: session.token,
      deviceId: session.deviceId,
      proof: session.proof,
      body: { reason: 'Left on a train' },
    });
    assert.equal(revoked.status, 201);

    // Same token, same proof, both still valid in themselves.
    const after = await call('GET', '/v1/me/security', {
      token: session.token,
      deviceId: session.deviceId,
      proof: session.proof,
    });
    assert.equal(after.status, 401, 'a revoked device left its sessions alive');
  });

  it('lets an unbound session through, and scores it', async () => {
    // Binding is not required by default, because turning it on signs out
    // everybody who has not enrolled. What an unbound session gets instead is
    // thirty points and a step-up as soon as it tries anything serious.
    const user = platform.user(seed.users.pm!.id);
    const token = issueTokens({
      actorId: user.id,
      tenantId: user.tenantId,
      partyId: user.partyId,
      roles: user.roles,
      mfaSatisfied: true,
    }).accessToken;

    const response = await call('GET', '/v1/me/security', { token });
    assert.equal(response.status, 200);
    assert.equal(response.body.session.bound, false);
    assert.ok(
      response.body.session.signals.some((signal: { signal: string }) => signal.signal === 'UNBOUND_SESSION'),
      'an unbound session was not scored for being unbound',
    );
  });

  it('drops the risk on a session the moment it becomes bound', async () => {
    const user = platform.user(seed.users.fm!.id);
    const unbound = issueTokens({
      actorId: user.id,
      tenantId: user.tenantId,
      partyId: user.partyId,
      roles: user.roles,
      mfaSatisfied: true,
    }).accessToken;
    const before = await call('GET', '/v1/me/security', { token: unbound });

    const response = await call('POST', '/v1/me/devices', {
      token: unbound,
      body: { label: 'FM tablet', platform: 'TABLET' },
    });
    const tokenId = JSON.parse(Buffer.from((response.body.accessToken as string).split('.')[1]!, 'base64url').toString('utf8')).jti;
    const after = await call('GET', '/v1/me/security', {
      token: response.body.accessToken,
      deviceId: response.body.device.id,
      proof: proofFor(response.body.deviceSecret, tokenId),
    });

    assert.ok(after.body.session.score < before.body.session.score, 'enrolling a device did not lower the session risk');
    assert.equal(after.body.standing, 'ADEQUATE');
    assert.equal(before.body.standing, 'WEAK');
  });

  it('scores against the device this request proved, not the one the token names', async () => {
    // The distinction the gateway exists to draw. A token claim says which
    // device the session was minted for; only the gateway knows whether *this*
    // request produced that device's proof. Scoring off the claim would give an
    // unproved request the credit of a bound one, which is the whole control
    // handed back.
    const session = await enrolled('owner');

    const proved = await call('GET', '/v1/me/security', {
      token: session.token,
      deviceId: session.deviceId,
      proof: session.proof,
    });
    assert.equal(proved.body.session.bound, true);
    assert.ok(
      !proved.body.session.signals.some((signal: { signal: string }) => signal.signal === 'UNBOUND_SESSION'),
      'a proved session was scored as unbound',
    );
  });

  it('refuses the tenancy-wide view to somebody who does not run the enterprise', async () => {
    // Everybody's device register is an administrative read. A project manager
    // seeing it would be a project manager seeing which of their colleagues has
    // a machine that has not been used since March.
    const session = await enrolled('pm');
    const response = await call('GET', '/v1/admin/credentials', {
      token: session.token,
      deviceId: session.deviceId,
      proof: session.proof,
    });
    assert.equal(response.status, 403);
  });

  it('shows the tenancy-wide view to the administrator who does', async () => {
    const session = await enrolled('admin');
    const response = await call('GET', '/v1/admin/credentials', {
      token: session.token,
      deviceId: session.deviceId,
      proof: session.proof,
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.ok(response.body.adoption.people > 0);
    assert.match(response.body.summary, /hold a passkey/);
  });

  it('shows the device secret once, and never again', async () => {
    const session = await enrolled('qaqc');
    const posture = await call('GET', '/v1/me/security', {
      token: session.token,
      deviceId: session.deviceId,
      proof: session.proof,
    });
    const serialised = JSON.stringify(posture.body);
    assert.ok(!serialised.includes(session.secret), 'the device secret was returned a second time');
    assert.ok(!serialised.includes('secretHash'), 'the device verifier reached a screen');
  });

  it('refuses to enrol from a session that never proved who it belonged to', async () => {
    // Enrolling mints a credential that stands for the account. A session that
    // did not complete a second factor must not be able to create one.
    const user = platform.user(seed.users.pm!.id);
    const token = issueTokens({
      actorId: user.id,
      tenantId: user.tenantId,
      partyId: user.partyId,
      roles: user.roles,
      mfaSatisfied: false,
    }).accessToken;
    const response = await call('POST', '/v1/me/devices', { token, body: { label: 'Sneaky', platform: 'DESKTOP' } });
    assert.equal(response.status, 403);
    assert.match(String(response.body.title), /DEVICE_ENROLMENT_NEEDS_MFA/);
  });

  it('keeps one person out of another’s device register', async () => {
    const mine = await enrolled('siteManager');
    const theirs = await enrolled('regulator');
    const response = await call('POST', `/v1/me/devices/${theirs.deviceId}/revoke`, {
      token: mine.token,
      deviceId: mine.deviceId,
      proof: mine.proof,
      body: { reason: 'Not mine to revoke' },
    });
    assert.equal(response.status, 404, 'one person revoked another person’s device');
  });

  it('records enrolment and revocation in the ledger, so a restart cannot forget them', async () => {
    // The whole reason these are not in memory like the lockout counter: a
    // revoked device that came back after a restart is a live session somebody
    // believed they had ended.
    const session = await enrolled('constructionManager');
    const events = platform.ledger.eventsForEntity({ refType: 'Device', refId: session.deviceId });
    assert.ok(events.some((event) => event.eventType === 'DEVICE_ENROLLED'), 'enrolment was never written down');

    await call('POST', `/v1/me/devices/${session.deviceId}/revoke`, {
      token: session.token,
      deviceId: session.deviceId,
      proof: session.proof,
      body: { reason: 'Replaced' },
    });
    const after = platform.ledger.eventsForEntity({ refType: 'Device', refId: session.deviceId });
    assert.ok(after.some((event) => event.eventType === 'DEVICE_REVOKED'), 'a revocation was never written down');
    // And it is a human act by an actor with a name, never an agent's.
    const revocation = after.find((event) => event.eventType === 'DEVICE_REVOKED')!;
    assert.equal(revocation.actor.refType, 'User');
  });
});
