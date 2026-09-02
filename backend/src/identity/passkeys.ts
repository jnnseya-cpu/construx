import { createHash, createPublicKey, createVerify, randomBytes, verify as verifySignature } from 'node:crypto';
import { config } from '../config.ts';
import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';

/**
 * Passkeys — WebAuthn, verified here rather than by a library.
 *
 * ## Why this exists
 *
 * A one-time code sent to an inbox is a shared secret in transit, and every
 * serious attack on an account like these ends with somebody reading one out. A
 * passkey cannot be read out, cannot be phished onto a lookalike domain — the
 * origin is signed over and checked here — and cannot be replayed, because the
 * challenge is single-use and server-issued.
 *
 * ## Why there is no library
 *
 * Zero runtime dependencies is settled, and what a WebAuthn library does is
 * three things this file does in about four hundred lines: decode a small CBOR
 * structure, read a COSE key out of it, and check one signature with primitives
 * `node:crypto` already ships. The parts that are genuinely hard in WebAuthn —
 * attestation chains back to a manufacturer root, metadata service lookups — are
 * **deliberately not done**, and that is stated in `attestation` below rather
 * than implied by silence.
 *
 * ## What is verified, in order
 *
 * Every one of these is a real attack if it is skipped, and each says which.
 *
 * 1. **The challenge is one this server issued, for this ceremony, and is now
 *    spent.** Without it a captured assertion replays forever.
 * 2. **`clientDataJSON.type`** is `webauthn.create` for registration and
 *    `webauthn.get` for authentication. Without it a registration ceremony's
 *    signature is accepted as a sign-in.
 * 3. **The origin** matches the configured one exactly. This is the anti-phishing
 *    property, and it is the whole reason passkeys beat codes.
 * 4. **The RP ID hash** in the authenticator data matches SHA-256 of the relying
 *    party id. Without it a credential registered for another site is accepted.
 * 5. **The user-present flag.** Without it a key that signed without anybody
 *    touching it counts as a person acting.
 * 6. **The signature** over `authenticatorData ‖ SHA-256(clientDataJSON)`, with
 *    the stored public key.
 * 7. **The signature counter never goes backwards.** A counter that decreases is
 *    the documented signal of a cloned authenticator.
 */

// --- CBOR --------------------------------------------------------------------
//
// Only the subset WebAuthn actually uses: unsigned and negative integers, byte
// strings, text strings, arrays and maps. Everything else is refused by name
// rather than skipped, because a decoder that silently ignores what it does not
// understand is one that can be fed a structure meaning something other than
// what it returned.

type CborValue = number | string | Uint8Array | CborValue[] | Map<CborValue, CborValue>;

class CborReader {
  private offset = 0;
  private readonly bytes: Uint8Array;

  // Written out rather than as a parameter property: `erasableSyntaxOnly` is on,
  // and a parameter property is syntax that has to be compiled rather than
  // stripped.
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }

  get consumed(): number {
    return this.offset;
  }

  private byte(): number {
    if (this.offset >= this.bytes.length) throw new DomainError('PASSKEY_CBOR_TRUNCATED', 'The attestation object ended mid-value');
    return this.bytes[this.offset++]!;
  }

  private take(length: number): Uint8Array {
    if (this.offset + length > this.bytes.length) {
      throw new DomainError('PASSKEY_CBOR_TRUNCATED', 'The attestation object ended mid-value');
    }
    const out = this.bytes.subarray(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }

  /** The argument encoded in the low five bits, per RFC 8949 §3. */
  private argument(info: number): number {
    if (info < 24) return info;
    if (info === 24) return this.byte();
    if (info === 25) return (this.byte() << 8) | this.byte();
    if (info === 26) return ((this.byte() << 24) >>> 0) + (this.byte() << 16) + (this.byte() << 8) + this.byte();
    if (info === 27) {
      // 64-bit. Read it, and refuse anything past the safe integer range rather
      // than returning a number that has quietly lost its low bits.
      let value = 0;
      for (let i = 0; i < 8; i += 1) value = value * 256 + this.byte();
      if (!Number.isSafeInteger(value)) throw new DomainError('PASSKEY_CBOR_TOO_LARGE', 'A CBOR value is larger than this decoder will carry');
      return value;
    }
    throw new DomainError('PASSKEY_CBOR_UNSUPPORTED', `CBOR additional information ${info} is not used by WebAuthn`);
  }

  read(): CborValue {
    const initial = this.byte();
    const major = initial >> 5;
    const info = initial & 0x1f;

    switch (major) {
      case 0:
        return this.argument(info);
      case 1:
        return -1 - this.argument(info);
      case 2:
        return this.take(this.argument(info));
      case 3:
        return Buffer.from(this.take(this.argument(info))).toString('utf8');
      case 4: {
        const length = this.argument(info);
        return Array.from({ length }, () => this.read());
      }
      case 5: {
        const length = this.argument(info);
        const map = new Map<CborValue, CborValue>();
        for (let i = 0; i < length; i += 1) {
          const key = this.read();
          map.set(key as CborValue, this.read());
        }
        return map;
      }
      default:
        // Tags (6) and simple/float (7). Neither appears in the structures
        // WebAuthn defines, so accepting them would be accepting something this
        // code has no interpretation for.
        throw new DomainError('PASSKEY_CBOR_UNSUPPORTED', `CBOR major type ${major} is not used by WebAuthn`);
    }
  }
}

export function decodeCbor(bytes: Uint8Array): { value: CborValue; consumed: number } {
  const reader = new CborReader(bytes);
  const value = reader.read();
  return { value, consumed: reader.consumed };
}

// --- COSE keys ---------------------------------------------------------------

/**
 * The two algorithms this accepts, and why only two.
 *
 * ES256 is what every platform authenticator produces — Touch ID, Windows Hello,
 * Android, every FIDO2 key. RS256 is what a handful of older Windows Hello
 * implementations produce. Accepting more algorithms means accepting weaker
 * ones, and the list of things an attacker would like this to accept is exactly
 * the list of things nobody's authenticator actually uses.
 */
export const SUPPORTED_ALGORITHMS = { ES256: -7, RS256: -257 } as const;
export type PasskeyAlgorithm = keyof typeof SUPPORTED_ALGORITHMS;

/** A COSE_Key, turned into something `node:crypto` will verify with. */
function coseToKey(cose: Map<CborValue, CborValue>): { key: ReturnType<typeof createPublicKey>; algorithm: PasskeyAlgorithm } {
  const kty = cose.get(1);
  const alg = cose.get(3);

  if (alg === SUPPORTED_ALGORITHMS.ES256) {
    if (kty !== 2) throw new DomainError('PASSKEY_KEY_UNSUPPORTED', 'ES256 requires an elliptic-curve key');
    if (cose.get(-1) !== 1) throw new DomainError('PASSKEY_KEY_UNSUPPORTED', 'ES256 requires the P-256 curve');
    const x = cose.get(-2);
    const y = cose.get(-3);
    if (!(x instanceof Uint8Array) || !(y instanceof Uint8Array) || x.length !== 32 || y.length !== 32) {
      throw new DomainError('PASSKEY_KEY_MALFORMED', 'The elliptic-curve point is not a valid P-256 coordinate pair');
    }
    // SPKI for id-ecPublicKey + prime256v1, then the uncompressed point. The
    // prefix is fixed for P-256, so it is a constant rather than a DER writer.
    const prefix = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');
    const spki = Buffer.concat([prefix, Buffer.from([0x04]), Buffer.from(x), Buffer.from(y)]);
    return { key: createPublicKey({ key: spki, format: 'der', type: 'spki' }), algorithm: 'ES256' };
  }

  if (alg === SUPPORTED_ALGORITHMS.RS256) {
    if (kty !== 3) throw new DomainError('PASSKEY_KEY_UNSUPPORTED', 'RS256 requires an RSA key');
    const n = cose.get(-1);
    const e = cose.get(-2);
    if (!(n instanceof Uint8Array) || !(e instanceof Uint8Array)) {
      throw new DomainError('PASSKEY_KEY_MALFORMED', 'The RSA key is missing its modulus or exponent');
    }
    return { key: createPublicKey({ key: rsaSpki(Buffer.from(n), Buffer.from(e)), format: 'der', type: 'spki' }), algorithm: 'RS256' };
  }

  throw new DomainError(
    'PASSKEY_ALGORITHM_UNSUPPORTED',
    'This authenticator offered an algorithm the platform does not accept. ES256 and RS256 are the two every current authenticator produces.',
  );
}

/** Minimal DER: a length-prefixed value, long form where it needs one. */
function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derInteger(value: Buffer): Buffer {
  // Strip leading zeroes, then re-add one where the high bit is set — a DER
  // INTEGER is signed, and an unsigned modulus with its top bit set would
  // otherwise decode as negative.
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start += 1;
  const trimmed = value.subarray(start);
  const body = trimmed[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed;
  return Buffer.concat([Buffer.from([0x02]), derLength(body.length), body]);
}

function rsaSpki(modulus: Buffer, exponent: Buffer): Buffer {
  const sequence = (body: Buffer) => Buffer.concat([Buffer.from([0x30]), derLength(body.length), body]);
  const rsaKey = sequence(Buffer.concat([derInteger(modulus), derInteger(exponent)]));
  const algorithm = Buffer.from('300d06092a864886f70d0101010500', 'hex');
  const bitString = Buffer.concat([Buffer.from([0x03]), derLength(rsaKey.length + 1), Buffer.from([0x00]), rsaKey]);
  return sequence(Buffer.concat([algorithm, bitString]));
}

// --- Authenticator data ------------------------------------------------------

export type AuthenticatorData = {
  rpIdHash: Buffer;
  userPresent: boolean;
  userVerified: boolean;
  /** True where the structure carries a newly created credential. */
  attested: boolean;
  signCount: number;
  credentialId?: Buffer;
  publicKey?: Map<CborValue, CborValue>;
};

/**
 * Parse authenticator data, per WebAuthn §6.1.
 *
 * Fixed layout: 32 bytes of RP ID hash, one flags byte, four bytes of counter,
 * then — only where the AT flag is set — the attested credential data.
 */
export function parseAuthenticatorData(bytes: Buffer): AuthenticatorData {
  if (bytes.length < 37) {
    throw new DomainError('PASSKEY_AUTHDATA_SHORT', 'The authenticator data is too short to be valid');
  }
  const flags = bytes[32]!;
  const base: AuthenticatorData = {
    rpIdHash: bytes.subarray(0, 32),
    userPresent: (flags & 0x01) !== 0,
    userVerified: (flags & 0x04) !== 0,
    attested: (flags & 0x40) !== 0,
    signCount: bytes.readUInt32BE(33),
  };
  if (!base.attested) return base;

  // 16 bytes of AAGUID, two of credential id length, the id, then the COSE key.
  if (bytes.length < 55) throw new DomainError('PASSKEY_AUTHDATA_SHORT', 'The attested credential data is truncated');
  const idLength = bytes.readUInt16BE(53);
  const idEnd = 55 + idLength;
  if (bytes.length < idEnd) throw new DomainError('PASSKEY_AUTHDATA_SHORT', 'The credential id is truncated');

  const decoded = decodeCbor(bytes.subarray(idEnd));
  if (!(decoded.value instanceof Map)) throw new DomainError('PASSKEY_KEY_MALFORMED', 'The credential public key is not a COSE key');

  return { ...base, credentialId: bytes.subarray(55, idEnd), publicKey: decoded.value };
}

// --- Records -----------------------------------------------------------------

export type PasskeyRecord = {
  id: string;
  actorId: string;
  tenantId: string;
  /** The credential id, base64url. What the browser sends back to identify it. */
  credentialId: string;
  /** SPKI DER, base64. Public by definition — safe to store and to show. */
  publicKey: string;
  algorithm: PasskeyAlgorithm;
  /** What the person calls it. */
  label: string;
  signCount: number;
  /** True where the authenticator itself verified the person (PIN, biometric). */
  userVerified: boolean;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
  revokedBy?: string;
};

export type PasskeyStore = {
  get(credentialId: string): PasskeyRecord | undefined;
  put(passkey: PasskeyRecord): void;
  forActor(actorId: string): PasskeyRecord[];
  forTenant(tenantId: string): PasskeyRecord[];
};

class MemoryPasskeyStore implements PasskeyStore {
  private readonly byCredential = new Map<string, PasskeyRecord>();
  get(credentialId: string) {
    return this.byCredential.get(credentialId);
  }
  put(passkey: PasskeyRecord) {
    this.byCredential.set(passkey.credentialId, passkey);
  }
  forActor(actorId: string) {
    return [...this.byCredential.values()].filter((passkey) => passkey.actorId === actorId);
  }
  forTenant(tenantId: string) {
    return [...this.byCredential.values()].filter((passkey) => passkey.tenantId === tenantId);
  }
}

let store: PasskeyStore = new MemoryPasskeyStore();

export function usePasskeyStore(next: PasskeyStore): void {
  store = next;
}

export function resetPasskeys(): void {
  store = new MemoryPasskeyStore();
  challenges.clear();
}

export function passkeysFor(actorId: string): PasskeyRecord[] {
  return store.forActor(actorId).filter((passkey) => !passkey.revokedAt);
}

export function passkeysForTenant(tenantId: string): PasskeyRecord[] {
  return store.forTenant(tenantId);
}

// --- Challenges --------------------------------------------------------------

type Challenge = { challenge: string; actorId?: string; ceremony: 'create' | 'get'; expiresAt: number };

const challenges = new Map<string, Challenge>();

/** Five minutes, the same window the one-time code gets. */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function issueChallenge(ceremony: 'create' | 'get', actorId?: string): Challenge {
  const challenge = randomBytes(32).toString('base64url');
  const record: Challenge = { challenge, actorId, ceremony, expiresAt: Date.now() + CHALLENGE_TTL_MS };
  challenges.set(challenge, record);
  return record;
}

/**
 * Spend a challenge.
 *
 * Deleted on the way out whatever the outcome, so a replayed assertion fails
 * against a challenge that is no longer there. A challenge that survived a
 * failed attempt would let an attacker grind against one that a real browser
 * had already produced a signature for.
 */
function spendChallenge(challenge: string, ceremony: 'create' | 'get'): Challenge {
  const held = challenges.get(challenge);
  challenges.delete(challenge);
  if (!held) throw new DomainError('PASSKEY_CHALLENGE_UNKNOWN', 'That challenge was not issued by this server, or has already been used', 401);
  if (held.expiresAt < Date.now()) throw new DomainError('PASSKEY_CHALLENGE_EXPIRED', 'That challenge has expired. Start again.', 401);
  if (held.ceremony !== ceremony) {
    throw new DomainError('PASSKEY_CEREMONY_MISMATCH', 'That challenge was issued for a different ceremony', 401);
  }
  return held;
}

// --- Relying party -----------------------------------------------------------

/**
 * The relying party id and the origin the browser must have been on.
 *
 * Derived from `PUBLIC_BASE_URL`, which the deployment already has to set, so
 * there is no second place for these to be configured and disagree. A passkey
 * registered against the wrong RP id is one that silently stops working the day
 * the setting is corrected.
 */
export function relyingParty(): { id: string; origin: string; name: string } {
  const origin = config.publicBaseUrl.replace(/\/+$/, '');
  let host = 'localhost';
  try {
    host = new URL(origin).hostname;
  } catch {
    // A base URL that will not parse is a deployment fault, not a request
    // fault. Registration below refuses rather than guessing a host.
  }
  return { id: host, origin, name: 'CONSTRUX' };
}

// --- Registration ------------------------------------------------------------

export type RegistrationOptions = {
  challenge: string;
  rp: { id: string; name: string };
  user: { id: string; name: string; displayName: string };
  pubKeyCredParams: Array<{ type: 'public-key'; alg: number }>;
  timeout: number;
  attestation: 'none';
  authenticatorSelection: { residentKey: 'preferred'; userVerification: 'preferred' };
  excludeCredentials: Array<{ type: 'public-key'; id: string }>;
};

/**
 * Begin registration.
 *
 * `attestation: 'none'` is a decision, not an oversight. Requesting attestation
 * would return a certificate chain this platform has no root store to verify
 * against and no metadata service to look the AAGUID up in — so it would be
 * stored, shown, and believed, without ever having been checked. Asking for
 * evidence nobody verifies is worse than not asking: it puts a claim on the
 * screen that the platform cannot stand behind.
 *
 * `excludeCredentials` carries the person's existing passkeys, so an
 * authenticator that already holds one says so instead of silently making a
 * second.
 */
export function beginRegistration(input: {
  actorId: string;
  email: string;
  displayName: string;
}): RegistrationOptions {
  const rp = relyingParty();
  const { challenge } = issueChallenge('create', input.actorId);
  return {
    challenge,
    rp: { id: rp.id, name: rp.name },
    user: { id: Buffer.from(input.actorId).toString('base64url'), name: input.email, displayName: input.displayName },
    pubKeyCredParams: [
      { type: 'public-key', alg: SUPPORTED_ALGORITHMS.ES256 },
      { type: 'public-key', alg: SUPPORTED_ALGORITHMS.RS256 },
    ],
    timeout: CHALLENGE_TTL_MS,
    attestation: 'none',
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    excludeCredentials: passkeysFor(input.actorId).map((passkey) => ({ type: 'public-key', id: passkey.credentialId })),
  };
}

type ClientData = { type: string; challenge: string; origin: string; crossOrigin?: boolean };

function readClientData(base64url: string, expected: 'webauthn.create' | 'webauthn.get'): ClientData {
  let parsed: ClientData;
  try {
    parsed = JSON.parse(Buffer.from(base64url, 'base64url').toString('utf8')) as ClientData;
  } catch {
    throw new DomainError('PASSKEY_CLIENT_DATA_UNREADABLE', 'The client data is not readable JSON', 400);
  }
  // Type first. Without this check a registration ceremony's signature is a
  // valid sign-in, because both sign over the same two fields.
  if (parsed.type !== expected) {
    throw new DomainError('PASSKEY_CEREMONY_MISMATCH', `This was signed as ${parsed.type}, not ${expected}`, 401);
  }
  const rp = relyingParty();
  // Exact match, not a suffix. `construx.evil.com` ends with nothing useful, but
  // a `startsWith` or `includes` check is how origin validation is usually got
  // wrong, and this is the property passkeys exist for.
  if (parsed.origin !== rp.origin) {
    throw new DomainError(
      'PASSKEY_ORIGIN_MISMATCH',
      `That was signed on ${parsed.origin}, and this platform is ${rp.origin}. This is the check that makes a passkey unphishable.`,
      401,
    );
  }
  if (parsed.crossOrigin === true) {
    throw new DomainError('PASSKEY_CROSS_ORIGIN', 'A passkey ceremony inside a cross-origin frame is refused', 401);
  }
  return parsed;
}

export function completeRegistration(
  input: {
    actorId: string;
    tenantId: string;
    label: string;
    credentialId: string;
    clientDataJSON: string;
    attestationObject: string;
  },
  now = new Date(),
): PasskeyRecord {
  const label = input.label.trim();
  if (label.length < 2) throw new DomainError('PASSKEY_LABEL_REQUIRED', 'Name the key. "Security key 2" is not a name a person can revoke by.');

  const clientData = readClientData(input.clientDataJSON, 'webauthn.create');
  const challenge = spendChallenge(clientData.challenge, 'create');
  if (challenge.actorId !== input.actorId) {
    throw new DomainError('PASSKEY_CHALLENGE_MISMATCH', 'That challenge was issued to a different account', 401);
  }

  const attestation = decodeCbor(Buffer.from(input.attestationObject, 'base64url')).value;
  if (!(attestation instanceof Map)) throw new DomainError('PASSKEY_ATTESTATION_MALFORMED', 'The attestation object is not a CBOR map');
  const authDataBytes = attestation.get('authData');
  if (!(authDataBytes instanceof Uint8Array)) throw new DomainError('PASSKEY_ATTESTATION_MALFORMED', 'The attestation object carries no authenticator data');

  const authData = parseAuthenticatorData(Buffer.from(authDataBytes));
  assertRpIdHash(authData);
  if (!authData.userPresent) {
    throw new DomainError('PASSKEY_NO_USER_PRESENCE', 'The authenticator signed without anybody touching it', 401);
  }
  if (!authData.attested || !authData.credentialId || !authData.publicKey) {
    throw new DomainError('PASSKEY_NO_CREDENTIAL', 'The authenticator returned no new credential', 400);
  }

  // The id the browser reported and the id inside the signed data must be the
  // same. They are two channels for the same fact, and only one of them is
  // signed over.
  const credentialId = Buffer.from(authData.credentialId).toString('base64url');
  if (credentialId !== input.credentialId) {
    throw new DomainError('PASSKEY_CREDENTIAL_MISMATCH', 'The credential id does not match the one inside the signed data', 401);
  }
  if (store.get(credentialId)) {
    throw new DomainError('PASSKEY_ALREADY_REGISTERED', 'That authenticator is already registered on this platform');
  }

  const { key, algorithm } = coseToKey(authData.publicKey);
  const passkey: PasskeyRecord = {
    id: ulid(),
    actorId: input.actorId,
    tenantId: input.tenantId,
    credentialId,
    publicKey: key.export({ format: 'der', type: 'spki' }).toString('base64'),
    algorithm,
    label,
    signCount: authData.signCount,
    userVerified: authData.userVerified,
    createdAt: now.toISOString(),
  };
  store.put(passkey);
  return passkey;
}

function assertRpIdHash(authData: AuthenticatorData): void {
  const expected = createHash('sha256').update(relyingParty().id).digest();
  if (!authData.rpIdHash.equals(expected)) {
    throw new DomainError(
      'PASSKEY_RP_MISMATCH',
      'That credential belongs to a different site. Without this check a key registered elsewhere would sign in here.',
      401,
    );
  }
}

// --- Authentication ----------------------------------------------------------

export type AuthenticationOptions = {
  challenge: string;
  rpId: string;
  timeout: number;
  userVerification: 'preferred';
  allowCredentials: Array<{ type: 'public-key'; id: string }>;
};

/**
 * Begin authentication.
 *
 * `allowCredentials` is empty where no account is named — a discoverable
 * credential lets the browser offer whatever it holds, and, more to the point,
 * an `allowCredentials` list keyed off an email address is an account
 * enumeration oracle exactly like the one `POST /v1/auth/login` goes to such
 * lengths to close. An address with no passkeys and an address with none
 * registered here must produce the same list.
 */
export function beginAuthentication(actorId?: string): AuthenticationOptions {
  const { challenge } = issueChallenge('get', actorId);
  return {
    challenge,
    rpId: relyingParty().id,
    timeout: CHALLENGE_TTL_MS,
    userVerification: 'preferred',
    allowCredentials: [],
  };
}

export type AssertionInput = {
  credentialId: string;
  clientDataJSON: string;
  authenticatorData: string;
  signature: string;
};

export type AssertionResult = {
  actorId: string;
  tenantId: string;
  passkeyId: string;
  label: string;
  /** True where the authenticator itself checked a PIN or a biometric. */
  userVerified: boolean;
};

/**
 * Verify an assertion, and return whose it is.
 *
 * The counter check at the end is the one people leave out. An authenticator
 * increments a counter on every signature; a counter that does not advance is
 * the documented signal that the credential has been cloned, and the response is
 * to refuse rather than to note it. Authenticators that always report zero — the
 * platform ones on Apple hardware, among others — are handled explicitly: zero
 * means "this authenticator does not count", and a stored zero with a presented
 * zero is not a regression.
 */
export function verifyAssertion(input: AssertionInput, now = new Date()): AssertionResult {
  const clientData = readClientData(input.clientDataJSON, 'webauthn.get');
  spendChallenge(clientData.challenge, 'get');

  const passkey = store.get(input.credentialId);
  // One answer for an unknown credential and a revoked one, so nobody can
  // enumerate which credentials this platform holds.
  if (!passkey || passkey.revokedAt) {
    throw new DomainError('PASSKEY_UNKNOWN', 'That passkey is not registered here', 401);
  }

  const authDataBytes = Buffer.from(input.authenticatorData, 'base64url');
  const authData = parseAuthenticatorData(authDataBytes);
  assertRpIdHash(authData);
  if (!authData.userPresent) {
    throw new DomainError('PASSKEY_NO_USER_PRESENCE', 'The authenticator signed without anybody touching it', 401);
  }

  const signed = Buffer.concat([authDataBytes, createHash('sha256').update(Buffer.from(input.clientDataJSON, 'base64url')).digest()]);
  const key = createPublicKey({ key: Buffer.from(passkey.publicKey, 'base64'), format: 'der', type: 'spki' });
  const signature = Buffer.from(input.signature, 'base64url');

  const ok =
    passkey.algorithm === 'ES256'
      ? verifySignature('sha256', signed, { key, dsaEncoding: 'der' }, signature)
      : createVerify('sha256').update(signed).verify(key, signature);
  if (!ok) throw new DomainError('PASSKEY_SIGNATURE_INVALID', 'That signature does not verify against the registered key', 401);

  // Clone detection. Zero from both sides means the authenticator does not
  // count, which is normal and is not a regression.
  if (!(authData.signCount === 0 && passkey.signCount === 0) && authData.signCount <= passkey.signCount) {
    throw new DomainError(
      'PASSKEY_COUNTER_REGRESSION',
      'This authenticator has signed with a counter it has already used. That is the documented signal of a cloned credential, and it is refused.',
      401,
    );
  }

  store.put({ ...passkey, signCount: authData.signCount, lastUsedAt: now.toISOString(), userVerified: authData.userVerified });

  return {
    actorId: passkey.actorId,
    tenantId: passkey.tenantId,
    passkeyId: passkey.id,
    label: passkey.label,
    userVerified: authData.userVerified,
  };
}

/** Revoke a passkey. Same refusal for missing and someone else's. */
export function revokePasskey(input: { passkeyId: string; actorId: string; by: string }, now = new Date()): PasskeyRecord {
  const passkey = store.forActor(input.actorId).find((held) => held.id === input.passkeyId);
  if (!passkey || passkey.revokedAt) throw new DomainError('PASSKEY_NOT_FOUND', 'No such passkey on this account', 404);
  const revoked = { ...passkey, revokedAt: now.toISOString(), revokedBy: input.by };
  store.put(revoked);
  return revoked;
}

/** What a screen may see. The public key is public, but nobody needs to read it. */
export function publicView(passkey: PasskeyRecord): Omit<PasskeyRecord, 'publicKey'> {
  const { publicKey: _publicKey, ...rest } = passkey;
  return rest;
}
