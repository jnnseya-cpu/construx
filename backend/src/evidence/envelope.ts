import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.ts';
import { DomainError } from '../core/errors.ts';

/**
 * Envelope encryption for evidence at rest.
 *
 * ## The threat this addresses, stated exactly
 *
 * Somebody obtains the volume, the bucket, a backup, or a disk that was
 * decommissioned without being wiped. Without this, that is a **readable
 * archive**: every site photograph, every signed instruction, every drawing and
 * every scanned contract, for every customer on the deployment, in a directory
 * tree already sorted by tenancy.
 *
 * With it, the same theft yields ciphertext and a set of wrapped keys that
 * cannot be unwrapped without the master key, which is not on the volume.
 *
 * ## What it does not address, stated just as exactly
 *
 * **A live process is not protected.** Anything that can call `decrypt` — the
 * application, or code running as it — reads plaintext, because it must. This
 * is encryption at rest and nothing more; a control that also defended against
 * the running process would have to keep the key somewhere the process cannot
 * reach, which is an HSM, and there is not one here.
 *
 * **A stolen master key is a stolen archive.** The master is the whole of the
 * secret. Where `EVIDENCE_MASTER_KEY` is set from a file on the same volume as
 * the evidence, this control does nothing at all — and `posture()` below says so
 * in those words rather than reporting "encryption: on".
 *
 * ## Why per-tenancy keys
 *
 * One key for the deployment would make every customer's evidence recoverable
 * from one compromise, and would make "delete this customer's data" a promise
 * about a delete rather than about a key. A per-tenancy data key means erasing a
 * tenancy can destroy its key, after which its ciphertext is unreadable by
 * anybody including this platform — which is a materially stronger statement to
 * a customer than "we deleted the files".
 *
 * The data keys are themselves derived rather than stored: HKDF from the master
 * with the tenancy as the info parameter. That keeps the key register empty,
 * which is one fewer thing to back up, lose, or leak. Rotation is by moving the
 * master to a new version and re-wrapping, which `rotate` supports and which the
 * posture reports as outstanding until it is done.
 *
 * ## The format
 *
 * ```
 * CXE1 ‖ version(1) ‖ iv(12) ‖ tag(16) ‖ ciphertext
 * ```
 *
 * AES-256-GCM. The tenancy id is bound in as **additional authenticated data**,
 * so a ciphertext moved from one tenancy's prefix to another's fails to
 * authenticate rather than decrypting into the wrong customer's evidence — an
 * attack that a scheme without AAD is wide open to precisely because the store
 * is content-addressed and the paths are predictable.
 */

export const MAGIC = Buffer.from('CXE1', 'ascii');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + 1 + IV_BYTES + TAG_BYTES;

/** The key versions this build understands. */
export const CURRENT_VERSION = 1;

export type EnvelopePosture = {
  /** Whether evidence is encrypted at rest at all. */
  enabled: boolean;
  /** The cipher, named so nobody has to read this file to find out. */
  cipher: 'AES-256-GCM';
  keyVersion: number;
  /** Where the master key came from, without disclosing any of it. */
  keySource: 'ENVIRONMENT' | 'NOT_CONFIGURED';
  /**
   * What this protects against and what it does not, in the platform's own
   * words, so a customer's security questionnaire is answered from the code
   * rather than from a marketing page.
   */
  protects: string[];
  doesNotProtect: string[];
  /** Anything an operator must do. Empty where there is nothing outstanding. */
  actions: string[];
};

/**
 * The master key.
 *
 * Read on every call rather than cached at module load, because `config` is
 * read from the environment at import and a test that sets the variable after
 * importing would otherwise be testing the absence of a key it had just set.
 */
function master(): Buffer | undefined {
  const raw = config.evidence.masterKey;
  if (!raw) return undefined;
  // Base64 or hex, both accepted, because operators paste whichever their
  // secret manager hands them and a refusal here reads as "the key is wrong".
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new DomainError(
      'EVIDENCE_MASTER_KEY_INVALID',
      `EVIDENCE_MASTER_KEY must be 32 bytes as hex or base64; this one decodes to ${key.length}. ` +
        'A short key is refused rather than stretched — stretching it would produce a working system with a weaker key ' +
        'than the operator believes they configured.',
    );
  }
  return key;
}

/** Whether this deployment encrypts evidence at rest. */
export function enabled(): boolean {
  return master() !== undefined;
}

/**
 * The data key for a tenancy, derived from the master.
 *
 * Derived rather than stored: a key register is another thing to back up, lose
 * and leak, and derivation gives the same per-tenancy isolation with nothing to
 * keep. The version is in the salt, so rotating the master version produces a
 * different key for the same tenancy without any coordination.
 */
export function dataKey(tenantId: string, version: number): Buffer {
  const key = master();
  if (!key) throw new DomainError('EVIDENCE_NOT_ENCRYPTED', 'This deployment has no evidence master key configured');
  return Buffer.from(
    hkdfSync('sha256', key, Buffer.from(`construx-evidence-v${version}`), Buffer.from(tenantId, 'utf8'), 32),
  );
}

/**
 * Encrypt for a tenancy.
 *
 * Returns the plaintext unchanged where no master key is configured, so a
 * deployment without one behaves exactly as it did before this file existed.
 * That is the honest default: turning encryption on by generating a key at boot
 * would produce a deployment whose evidence becomes unreadable on restart.
 */
export function encrypt(tenantId: string, plaintext: Buffer): Buffer {
  if (!enabled()) return plaintext;

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', dataKey(tenantId, CURRENT_VERSION), iv);
  // The tenancy, bound in. A ciphertext moved into another customer's prefix
  // then fails to authenticate instead of decrypting into their evidence.
  cipher.setAAD(Buffer.from(tenantId, 'utf8'));
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return Buffer.concat([MAGIC, Buffer.from([CURRENT_VERSION]), iv, cipher.getAuthTag(), body]);
}

/** True where these bytes are an envelope this build wrote. */
export function isEnvelope(bytes: Buffer): boolean {
  return bytes.length >= HEADER_BYTES && bytes.subarray(0, MAGIC.length).equals(MAGIC);
}

/**
 * Decrypt for a tenancy.
 *
 * Plaintext that is not an envelope passes through untouched, which is what
 * makes turning encryption **on** a non-event: files written before the key
 * existed are still readable afterwards, and new ones are encrypted. There is no
 * migration to run and no window where the store is half readable.
 *
 * Turning it **off** is the asymmetric direction and is stated rather than
 * implied: existing envelopes become unreadable, because the key is gone. The
 * posture says so.
 */
export function decrypt(tenantId: string, stored: Buffer): Buffer {
  if (!isEnvelope(stored)) return stored;
  if (!enabled()) {
    throw new DomainError(
      'EVIDENCE_KEY_UNAVAILABLE',
      'This file is encrypted and no evidence master key is configured. The bytes are intact; the key is missing. ' +
        'Restore EVIDENCE_MASTER_KEY — the file cannot be recovered without it, by this platform or by anybody else.',
      503,
    );
  }

  const version = stored[MAGIC.length]!;
  if (version !== CURRENT_VERSION) {
    throw new DomainError(
      'EVIDENCE_KEY_VERSION_UNKNOWN',
      `This file was written with key version ${version} and this build understands ${CURRENT_VERSION}`,
      503,
    );
  }

  const iv = stored.subarray(MAGIC.length + 1, MAGIC.length + 1 + IV_BYTES);
  const tag = stored.subarray(MAGIC.length + 1 + IV_BYTES, HEADER_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', dataKey(tenantId, version), iv);
  decipher.setAAD(Buffer.from(tenantId, 'utf8'));
  decipher.setAuthTag(tag);

  try {
    return Buffer.concat([decipher.update(stored.subarray(HEADER_BYTES)), decipher.final()]);
  } catch {
    // GCM authentication failed: the bytes were altered, the tenancy is wrong,
    // or the master key has changed. All three are the same refusal, because
    // distinguishing them would tell an attacker which of their guesses was
    // closer.
    throw new DomainError(
      'EVIDENCE_DECRYPT_FAILED',
      'This file did not authenticate. It has been altered, it belongs to a different tenancy, or the master key has changed.',
      500,
    );
  }
}

/**
 * Re-encrypt under the current key version.
 *
 * The rotation primitive. Not called on a schedule by anything — rotating a
 * master key is an operator decision with a maintenance window behind it, and a
 * platform that rotated silently would be one where a failure halfway through
 * leaves half an archive unreadable with nobody watching.
 */
export function rotate(tenantId: string, stored: Buffer): Buffer {
  return encrypt(tenantId, decrypt(tenantId, stored));
}

/**
 * What this deployment can honestly say about evidence at rest.
 *
 * Written as claims and non-claims rather than as a boolean, because "encrypted
 * at rest: yes" is the answer every product gives and it tells a customer's
 * security team nothing about what was actually done.
 */
export function posture(): EnvelopePosture {
  const on = enabled();
  return {
    enabled: on,
    cipher: 'AES-256-GCM',
    keyVersion: CURRENT_VERSION,
    keySource: on ? 'ENVIRONMENT' : 'NOT_CONFIGURED',
    protects: on
      ? [
          'A stolen volume, bucket, backup or decommissioned disk yields ciphertext rather than a readable archive.',
          'Each tenancy has its own derived key, so one customer’s evidence cannot be read with another’s.',
          'The tenancy is bound in as authenticated data, so a file moved into another customer’s prefix fails to ' +
            'authenticate rather than decrypting into their record.',
          'Erasing a tenancy can destroy its key, after which its ciphertext is unreadable by anybody — including this ' +
            'platform. That is a stronger statement than “the files were deleted”.',
        ]
      : [],
    doesNotProtect: [
      'A live process. Anything that can call the decrypt path reads plaintext, because it must. This is encryption at ' +
        'rest and nothing else.',
      'A stolen master key. The master is the whole of the secret, and a key kept on the same volume as the evidence ' +
        'makes this control worth nothing.',
      'Metadata. File sizes, content hashes and which tenancy holds how many objects are visible without the key.',
    ],
    actions: on
      ? []
      : [
          'Set EVIDENCE_MASTER_KEY to 32 random bytes as hex or base64, from a secret manager rather than from a file on ' +
            'the evidence volume. Until then a stolen volume is a readable archive of every customer’s site photographs, ' +
            'signed instructions and scanned contracts.',
        ],
  };
}

/**
 * A detached verification tag for an exported document.
 *
 * Separate from the envelope and answering a different question: an envelope
 * proves a file at rest has not been altered *and* hides it; this proves a
 * document that has **left** the platform is the one the platform issued, to
 * somebody who has the document and no access at all.
 *
 * `sha256:…` alone does not do that. A content hash proves integrity against
 * itself: anybody who alters a document can recompute the hash, so a hash on the
 * document proves nothing to a recipient. What makes it a proof is that the tag
 * is an HMAC only this platform can produce, and the verification endpoint is
 * the only thing that can check it.
 */
export function issueTag(input: { contentHash: string; reference: string; tenantId: string }): string {
  // `|` separates the three fields, and appears in none of them: a tenancy is a
  // ULID, a reference is prefix-and-digits, a content hash is `sha256:` and hex.
  // A separator that could occur inside a field would let two different
  // documents produce one tag by shifting the boundary between them.
  return createHmac('sha256', `${config.auth.jwtSecret}:export-verification`)
    .update(`${input.tenantId}|${input.reference}|${input.contentHash}`)
    .digest('base64url');
}

/** Whether a presented tag is one this platform issued for this document. */
export function verifyTag(
  input: { contentHash: string; reference: string; tenantId: string },
  presented: string,
): boolean {
  const expected = Buffer.from(issueTag(input));
  const offered = Buffer.from(presented);
  return expected.length === offered.length && timingSafeEqual(expected, offered);
}
