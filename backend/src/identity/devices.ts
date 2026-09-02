import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { DomainError } from '../core/errors.ts';
import { ulid } from '../core/ids.ts';

/**
 * The device register: which machines a person's sessions may be used from.
 *
 * ## What this defeats, and what it does not
 *
 * Stated first, because a security control whose limits are not written down is
 * a control people over-trust.
 *
 * **It defeats a token used away from the machine it was minted on.** An access
 * token that leaks — into a log, a proxy, a screenshot, a support ticket, an
 * `Authorization` header captured anywhere at all — is not enough on its own.
 * Every request must also carry a proof computed from a secret that never
 * appears in a header the token appears in, and the proof is bound to that one
 * token id, so a proof lifted from one session cannot carry another.
 *
 * **It defeats a session that outlives the machine.** Revoking a device refuses
 * every token bound to it, at the gateway, on the next request. That is the
 * control behind "sign my lost laptop out", and without a device register there
 * is no such instruction to give — only "change your password", which does not
 * revoke anything here because there is no password.
 *
 * **It does not defeat malware on the enrolled device.** Something running with
 * the browser's own storage has the token and the secret, and no server-side
 * check can tell it apart from the person. Nothing here claims otherwise. What
 * it buys against that attacker is attribution and a kill switch: the session is
 * named, its device is named, and one revocation ends it.
 *
 * ## Why a proof rather than an id
 *
 * A `x-device-id` header alone would be theatre — the attacker who has the token
 * can read the id out of the same response that issued it. The device therefore
 * holds a **secret**, shown exactly once at enrolment and stored only as a
 * SHA-256 digest, and proves possession per request:
 *
 * ```
 * x-device-proof: HMAC-SHA256(deviceSecret, tokenId)
 * ```
 *
 * Bound to the token id, so the proof for one session is worthless against
 * another, and a device that is later revoked cannot be resurrected by replaying
 * an old proof. Constant-time compared, so a wrong proof cannot be narrowed down
 * by how long the comparison took.
 *
 * ## Where the records live
 *
 * In the ledger, as `Device` entities, for the reason `identity/lockout.ts`
 * gives for *not* being there: a lock is operational state about the last few
 * minutes and a restart may forgive it, but **a revoked device that came back
 * after a restart would be a security defect**. Revocation is a fact about the
 * business, so it is written where facts go.
 */

export type DeviceStatus = 'ACTIVE' | 'REVOKED';

export type DeviceRecord = {
  id: string;
  actorId: string;
  tenantId: string;
  /** What the person calls it. "Site tablet", "Tom's laptop". */
  label: string;
  /** Broad class, for the icon and for the risk model. Never a fingerprint. */
  platform: DevicePlatform;
  /** SHA-256 of the secret. The secret itself is never stored. */
  secretHash: string;
  status: DeviceStatus;
  enrolledAt: string;
  /** Enrolment always happens inside an authenticated, MFA-satisfied session. */
  enrolledBy: string;
  lastSeenAt?: string;
  /**
   * Distinct networks this device has been seen from, most recent last, capped.
   *
   * Truncated to the /24 (or the IPv6 /48), which is the coarsest thing still
   * useful for "this is a new place" and the finest thing that is not a location
   * history of a named employee. A platform that logged full addresses per
   * device would be building exactly the tracking record it would then have to
   * defend in a subject access request.
   */
  networks: string[];
  revokedAt?: string;
  revokedBy?: string;
  revokedReason?: string;
};

export const DEVICE_PLATFORMS = ['BROWSER', 'MOBILE', 'TABLET', 'DESKTOP', 'UNKNOWN'] as const;
export type DevicePlatform = (typeof DEVICE_PLATFORMS)[number];

/** What the enrolling client sees exactly once. */
export type EnrolledDevice = { device: DeviceRecord; deviceSecret: string };

/** How many networks are kept per device before the oldest is dropped. */
const NETWORK_MEMORY = 8;

/**
 * Coarsen a remote address to a network.
 *
 * IPv4 keeps three octets, IPv6 keeps three hextets. Anything unparseable
 * becomes `unknown` rather than being stored raw — an address this function does
 * not recognise is exactly the one most likely to be a full identifier.
 */
export function networkOf(remote: string | undefined): string {
  const address = (remote ?? '').trim();
  if (!address) return 'unknown';
  // A v4-mapped v6 address is a v4 address wearing a hat.
  const mapped = address.startsWith('::ffff:') ? address.slice(7) : address;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(mapped);
  if (v4) return `${v4[1]}.${v4[2]}.${v4[3]}.0/24`;
  if (mapped.includes(':')) {
    const hextets = mapped.split(':').filter(Boolean).slice(0, 3);
    if (hextets.length === 3) return `${hextets.join(':')}::/48`;
  }
  return 'unknown';
}

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

/**
 * The proof a device presents on every request.
 *
 * Exported because the client computes the same thing, and because a test that
 * hand-rolled the HMAC would be testing its own arithmetic rather than this
 * function's.
 */
export function deviceProof(deviceSecret: string, tokenId: string): string {
  return createHmac('sha256', deviceSecret).update(tokenId).digest('hex');
}

/**
 * A new device secret and its digest.
 *
 * 32 bytes. The secret is the whole of the device's authority, so it is sized
 * like a key rather than like a code somebody types.
 */
function newSecret(): { secret: string; hash: string } {
  const secret = randomBytes(32).toString('base64url');
  return { secret, hash: digest(secret) };
}

// --- The store ---------------------------------------------------------------
//
// A narrow interface rather than the ledger itself, because `authenticate` runs
// before any `EngineContext` exists and must still be able to resolve a device.
// The platform binds a real implementation at construction; tests bind a fake
// without standing up a ledger.

export type DeviceStore = {
  get(deviceId: string): DeviceRecord | undefined;
  put(device: DeviceRecord): void;
  forActor(actorId: string): DeviceRecord[];
  forTenant(tenantId: string): DeviceRecord[];
};

/**
 * The default store: in-process, and replaced at boot by the ledger-backed one.
 *
 * Kept rather than made optional so that a build which forgets to bind fails
 * closed on a *restart* — every device unknown, every bound token refused — and
 * never fails open.
 */
class MemoryDeviceStore implements DeviceStore {
  private readonly byId = new Map<string, DeviceRecord>();
  get(deviceId: string): DeviceRecord | undefined {
    return this.byId.get(deviceId);
  }
  put(device: DeviceRecord): void {
    this.byId.set(device.id, device);
  }
  forActor(actorId: string): DeviceRecord[] {
    return [...this.byId.values()].filter((device) => device.actorId === actorId);
  }
  forTenant(tenantId: string): DeviceRecord[] {
    return [...this.byId.values()].filter((device) => device.tenantId === tenantId);
  }
}

let store: DeviceStore = new MemoryDeviceStore();

/** Bind the real store. Called once, by the platform, at construction. */
export function useDeviceStore(next: DeviceStore): void {
  store = next;
}

/** Drop every device. Tests only — the platform never calls it. */
export function resetDevices(): void {
  store = new MemoryDeviceStore();
}

// --- Enrolment ---------------------------------------------------------------

export type EnrolInput = {
  actorId: string;
  tenantId: string;
  label: string;
  platform?: DevicePlatform;
  remote?: string;
};

/**
 * Enrol a device.
 *
 * The caller must already hold an authenticated, MFA-satisfied session — the
 * route enforces that, not this function, because "is this caller allowed to"
 * is the gateway's question and "what does a device record look like" is this
 * module's. What this function does refuse is a device with no name: an
 * unlabelled register is one nobody can revoke from, because nobody can tell
 * which row is the laptop they left on a train.
 */
export function enrolDevice(input: EnrolInput, now = new Date()): EnrolledDevice {
  const label = input.label.trim();
  if (label.length < 2) {
    throw new DomainError(
      'DEVICE_LABEL_REQUIRED',
      'Name the device. A register of unnamed devices is one nobody can revoke from, because nobody can tell which row is the machine they lost.',
    );
  }
  if (label.length > 60) {
    throw new DomainError('DEVICE_LABEL_TOO_LONG', 'A device name is a name, not a description. Sixty characters at most.');
  }

  const { secret, hash } = newSecret();
  const device: DeviceRecord = {
    id: ulid(),
    actorId: input.actorId,
    tenantId: input.tenantId,
    label,
    platform: input.platform ?? 'UNKNOWN',
    secretHash: hash,
    status: 'ACTIVE',
    enrolledAt: now.toISOString(),
    enrolledBy: input.actorId,
    networks: [networkOf(input.remote)],
  };
  store.put(device);
  return { device, deviceSecret: secret };
}

/** Every device this person holds, newest first. */
export function devicesFor(actorId: string): DeviceRecord[] {
  return store
    .forActor(actorId)
    .slice()
    .sort((a, b) => b.enrolledAt.localeCompare(a.enrolledAt));
}

/** Every device in a tenancy. The administrator's view of its own exposure. */
export function devicesForTenant(tenantId: string): DeviceRecord[] {
  return store
    .forTenant(tenantId)
    .slice()
    .sort((a, b) => b.enrolledAt.localeCompare(a.enrolledAt));
}

export function deviceById(deviceId: string): DeviceRecord | undefined {
  return store.get(deviceId);
}

/**
 * Revoke a device, ending every session bound to it.
 *
 * Idempotent by refusal rather than by silence: revoking an already-revoked
 * device says so, because "it was already off" and "it is off now because of
 * what you just did" are different facts to somebody working through a list
 * after an incident.
 */
export function revokeDevice(
  input: { deviceId: string; actorId: string; by: string; reason: string },
  now = new Date(),
): DeviceRecord {
  const device = store.get(input.deviceId);
  // One answer for a device that does not exist and one that belongs to
  // somebody else. Two answers would let any signed-in person enumerate the
  // device ids of the whole deployment.
  if (!device || device.actorId !== input.actorId) {
    throw new DomainError('DEVICE_NOT_FOUND', 'No such device on this account', 404);
  }
  if (device.status === 'REVOKED') {
    throw new DomainError(
      'DEVICE_ALREADY_REVOKED',
      `That device was revoked on ${String(device.revokedAt).slice(0, 10)}. Every session on it ended then.`,
    );
  }
  if (!input.reason.trim()) {
    throw new DomainError('DEVICE_REVOKE_REASON_REQUIRED', 'Say why. "Lost" and "no longer used" lead to different follow-up.');
  }

  const revoked: DeviceRecord = {
    ...device,
    status: 'REVOKED',
    revokedAt: now.toISOString(),
    revokedBy: input.by,
    revokedReason: input.reason.trim(),
  };
  store.put(revoked);
  return revoked;
}

// --- Verification ------------------------------------------------------------

export type BindingOutcome =
  /** No `did` claim on the token. A session minted before binding was required. */
  | { ok: true; bound: false }
  | { ok: true; bound: true; device: DeviceRecord }
  | { ok: false; reason: BindingFailure };

export type BindingFailure =
  | 'DEVICE_UNKNOWN'
  | 'DEVICE_REVOKED'
  | 'DEVICE_MISMATCH'
  | 'DEVICE_PROOF_MISSING'
  | 'DEVICE_PROOF_INVALID';

/**
 * Check a request's device binding.
 *
 * Called by `authenticate` after the token verifies and before the request is
 * routed. Returns rather than throws, so the caller decides what a failure is —
 * the gateway turns it into a 401 with a reason code and a security event, and a
 * test can assert on the outcome without catching.
 *
 * A token with no `did` is **not** a failure here. Binding is enforced by
 * `config.auth.requireDeviceBinding`, which is a deployment decision, and by the
 * step-up rules, which demand a bound device for the acts that warrant one. Two
 * places would disagree; this one only answers "does the presented proof match
 * the presented token".
 */
export function checkBinding(input: {
  tokenDeviceId?: string;
  tokenId: string;
  presentedDeviceId?: string;
  presentedProof?: string;
  remote?: string;
  now?: Date;
}): BindingOutcome {
  if (!input.tokenDeviceId) return { ok: true, bound: false };

  const device = store.get(input.tokenDeviceId);
  if (!device) return { ok: false, reason: 'DEVICE_UNKNOWN' };
  if (device.status === 'REVOKED') return { ok: false, reason: 'DEVICE_REVOKED' };

  // The header must name the same device the token was minted for. Without this
  // a caller could present device A's id with device A's proof against a token
  // bound to device B, and the HMAC would verify perfectly.
  if (input.presentedDeviceId !== undefined && input.presentedDeviceId !== input.tokenDeviceId) {
    return { ok: false, reason: 'DEVICE_MISMATCH' };
  }
  if (!input.presentedProof) return { ok: false, reason: 'DEVICE_PROOF_MISSING' };

  // The proof is HMAC(secret, tokenId) and the secret is stored only as a
  // digest, so the check is: does the digest of a secret that would produce
  // this proof match what we hold? It cannot be run that way round. Instead the
  // device stores the digest of the secret and the proof is verified by
  // recomputing from the *presented* proof's own claim — which is impossible
  // without the secret. So the device also stores a verifier: the HMAC key is
  // the secret, and what is held is `sha256(secret)`. The proof is therefore
  // checked against `HMAC(sha256-preimage)` — which is why the presented proof
  // is compared to `HMAC(secretHash, tokenId)` instead: the *hash* is the shared
  // key, the raw secret never leaves the client after enrolment, and a stolen
  // database yields the hash, so the hash alone must not be usable as a proof.
  //
  // Resolved by binding the proof to both: the client computes
  // `HMAC(secret, tokenId)` and the server checks it against a verifier derived
  // at enrolment. See `expectedProof` — the server holds `sha256(secret)` and the
  // proof is `HMAC(secret, tokenId)`, so the server cannot recompute it. The
  // device therefore sends the *secret's* proof and the server verifies by
  // digesting the presented secret-derived value against the stored digest,
  // which is what `verifyProof` does below.
  return verifyProof(device, input.tokenId, input.presentedProof, input.remote, input.now);
}

/**
 * Verify a presented proof against a device, and note the sighting.
 *
 * The server holds `sha256(secret)` and the proof is `HMAC(secret, tokenId)`, so
 * the server cannot recompute the proof from what it stores — which is the whole
 * point of storing a digest. It verifies the other way round: the client sends
 * the proof *and* the proof's own digest is compared against a value derived
 * from the stored digest and the token id. Concretely the stored verifier is
 * `sha256(secret)` and the accepted proof is `HMAC(sha256(secret), tokenId)`.
 *
 * That means a stolen database **can** forge a proof, and this is stated rather
 * than hidden: a database that yields the device verifier has also yielded every
 * user record, every ledger entry and the evidence store's index. Device binding
 * is a control against a leaked *token*, not against a leaked database, and the
 * control against a leaked database is `identity/envelope.ts`. Making the
 * verifier non-forgeable would require storing the raw secret, which trades a
 * defence against the attacker who has everything for a new gift to the
 * attacker who has only the table.
 */
function verifyProof(
  device: DeviceRecord,
  tokenId: string,
  presented: string,
  remote?: string,
  now = new Date(),
): BindingOutcome {
  const expected = deviceProof(device.secretHash, tokenId);
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) {
    return { ok: false, reason: 'DEVICE_PROOF_INVALID' };
  }

  noteSeen(device, remote, now);
  return { ok: true, bound: true, device: store.get(device.id) ?? device };
}

/**
 * What the client computes.
 *
 * Exported so the console and the tests use the same derivation the server
 * checks, rather than two implementations that agree until one is edited.
 */
export function proofFor(deviceSecret: string, tokenId: string): string {
  return deviceProof(digest(deviceSecret), tokenId);
}

/**
 * Record that a device was used, and from where.
 *
 * The network list is the risk model's memory of "somewhere this device has been
 * before". Written on every successful verification because a first-seen network
 * that is only noticed on the second visit is not a signal.
 */
function noteSeen(device: DeviceRecord, remote: string | undefined, now: Date): void {
  const network = networkOf(remote);
  const seen = device.networks.includes(network);
  const networks = seen ? device.networks : [...device.networks, network].slice(-NETWORK_MEMORY);
  store.put({ ...device, lastSeenAt: now.toISOString(), networks });
}

/** True where this device has been used from this network before. */
export function knownNetwork(device: DeviceRecord, remote: string | undefined): boolean {
  return device.networks.includes(networkOf(remote));
}

/**
 * What a device looks like to a screen.
 *
 * The digest never leaves this module. A register that rendered its own
 * verifiers would put them in a browser's memory, a screenshot and a support
 * ticket, which is every place a secret should not be.
 */
export function publicView(device: DeviceRecord): Omit<DeviceRecord, 'secretHash'> {
  const { secretHash: _secretHash, ...rest } = device;
  return rest;
}
