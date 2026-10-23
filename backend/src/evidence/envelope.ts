import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.ts';
import { DomainError } from '../core/errors.ts';
import { signFor, verifyFor } from '../identity/secrets.ts';

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
 *
 * ## The framed format, and why there are two
 *
 * ```
 * CXE1 ‖ format(2) ‖ keyVersion(1) ‖ frameBytes(4) ‖ frame*
 * frame = length(4) ‖ iv(12) ‖ tag(16) ‖ ciphertext(length)
 * ```
 *
 * The key version is its own byte here, where the single-shot format uses the
 * one version byte for both things. That conflation is what made the first cut
 * of this format unreadable by its own synchronous reader: the writer derived
 * its key under version 1 and the reader under version 2, and the only symptom
 * was every frame failing to authenticate. Separating them also means rotating
 * the master key needs no new container format.
 *
 * The single-shot format above cannot be streamed in either direction. Its tag
 * covers the whole file and sits *before* the body, so writing it means holding
 * the entire plaintext to compute the tag, and reading it means holding the
 * entire ciphertext before a byte can be trusted. At fifty megabytes that is
 * merely wasteful. Construction does not work at fifty megabytes: a drawing
 * set, a point cloud, a site walkthrough recorded on a phone and a scanned
 * historic pack are hundreds of megabytes to gigabytes each, and a format that
 * requires the whole file in memory puts a hard ceiling on what the platform
 * can hold — one that shows up as `EVIDENCE_TOO_LARGE` on exactly the files a
 * project most needs to keep.
 *
 * So version 2 encrypts in frames of one mebibyte, each with its own IV and its
 * own tag. Three things follow, and all three are the point:
 *
 *   - **It streams.** A frame is authenticated the moment it is read, so
 *     plaintext is released a frame at a time and nothing unverified is ever
 *     handed on — which is the property a single tag at the front of a
 *     gigabyte cannot offer at all.
 *   - **It is addressable.** Every frame but the last holds exactly
 *     `frameBytes` of plaintext and occupies exactly `frameBytes + 32` bytes on
 *     disk, so the frame containing any byte offset is arithmetic. That is what
 *     makes a range request — a browser seeking in a two-hour site video —
 *     possible without reading the file from the beginning.
 *   - **It cannot be truncated or reordered silently.** Each frame's AAD binds
 *     the tenancy, the frame's index and whether it is the last one. Dropping a
 *     frame, swapping two, or cutting the file short all fail authentication
 *     instead of yielding a shorter file that looks whole.
 *
 * Both formats are read by `decrypt`, so a file written either way is readable
 * by every caller; the version byte says which. `encrypt` still writes version
 * 1 for the callers that hold a whole buffer anyway, because changing what
 * those write would be a migration for no gain.
 */

export const MAGIC = Buffer.from('CXE1', 'ascii');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + 1 + IV_BYTES + TAG_BYTES;

/** The key versions this build understands. */
export const CURRENT_VERSION = 1;

/** The framed, streamable format. Written by `encryptFrames`, read by both paths. */
export const FRAMED_VERSION = 2;

/**
 * Plaintext per frame.
 *
 * One mebibyte: large enough that the 32 bytes of per-frame overhead are
 * noise (0.003%), small enough that a reader buffers a mebibyte rather than a
 * file, and a round number so the arithmetic that finds the frame holding a
 * byte offset is obvious rather than clever.
 *
 * It is written into the header of every object rather than assumed, so
 * changing it later leaves every file already on the volume readable.
 */
export const FRAME_BYTES = 1_048_576;

/** Length, IV and tag in front of each frame's ciphertext. */
export const FRAME_OVERHEAD_BYTES = 4 + IV_BYTES + TAG_BYTES;

/** The framed header: magic, the format, the key version, and the frame size. */
export const FRAMED_HEADER_BYTES = MAGIC.length + 1 + 1 + 4;

/** The frame size and key version a framed file was written with. */
export function framedLayout(head: Buffer): { keyVersion: number; frameBytes: number } {
  return { keyVersion: head[MAGIC.length + 1]!, frameBytes: head.readUInt32BE(MAGIC.length + 2) };
}

/** Magic and a format byte, which is all a stream has to go on before it reads further. */
function startsAsEnvelope(head: Buffer): boolean {
  return head.length > MAGIC.length && head.subarray(0, MAGIC.length).equals(MAGIC);
}

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
  return (
    bytes.length >= FRAMED_HEADER_BYTES &&
    bytes.subarray(0, MAGIC.length).equals(MAGIC) &&
    // A single-shot envelope is at least a header; a framed one is at least a
    // header and one frame. Below either, these are not an envelope at all —
    // which is how a four-byte file that happens to start `CXE1` stays
    // readable instead of becoming a decrypt failure.
    (bytes[MAGIC.length] === FRAMED_VERSION ? bytes.length >= FRAMED_HEADER_BYTES + FRAME_OVERHEAD_BYTES : bytes.length >= HEADER_BYTES)
  );
}

/** The additional authenticated data for one frame. Binds tenancy, order and the end. */
function frameAAD(tenantId: string, index: number, last: boolean): Buffer {
  return Buffer.from(`${tenantId}|${index}|${last ? 'END' : 'MORE'}`, 'utf8');
}

/**
 * Encrypt a stream of plaintext into a stream of frames.
 *
 * Re-chunks whatever the source yields into frames of exactly `FRAME_BYTES`,
 * because the frame size is what makes a byte offset arithmetic rather than a
 * search. The source is read once and nothing larger than one frame is held.
 *
 * Yields the plaintext unchanged where no master key is configured, exactly as
 * `encrypt` does, so a deployment without one behaves as it always did.
 */
export async function* encryptFrames(
  tenantId: string,
  source: AsyncIterable<Buffer> | Iterable<Buffer>,
): AsyncGenerator<Buffer> {
  if (!enabled()) {
    for await (const chunk of source) yield chunk;
    return;
  }

  const key = dataKey(tenantId, CURRENT_VERSION);
  const header = Buffer.alloc(FRAMED_HEADER_BYTES);
  MAGIC.copy(header, 0);
  header[MAGIC.length] = FRAMED_VERSION;
  // The key version, written down rather than assumed to be the format's. The
  // first cut of this derived the writer's key from the format byte, so the
  // synchronous reader derived a different key and every frame failed.
  header[MAGIC.length + 1] = CURRENT_VERSION;
  header.writeUInt32BE(FRAME_BYTES, MAGIC.length + 2);
  yield header;

  let index = 0;
  const sealed = (plaintext: Buffer, last: boolean): Buffer => {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(frameAAD(tenantId, index, last));
    const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(body.length, 0);
    index += 1;
    return Buffer.concat([length, iv, cipher.getAuthTag(), body]);
  };

  // One frame's worth is held back so the final frame can be sealed as the
  // last one. Without that marker a truncated file would authenticate
  // perfectly and read as a shorter, whole file.
  let pending: Buffer = Buffer.alloc(0);
  for await (const chunk of source) {
    pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
    while (pending.length > FRAME_BYTES) {
      yield sealed(pending.subarray(0, FRAME_BYTES), false);
      pending = pending.subarray(FRAME_BYTES);
    }
  }
  // Exactly `FRAME_BYTES` remaining is still the last frame, which is why the
  // loop above stops at `>` rather than `>=`.
  yield sealed(pending, true);
}

/**
 * The frames of a stored object, decrypted and authenticated one at a time.
 *
 * Every version is handled here so a caller never has to ask which format it
 * is looking at:
 *
 *   - **Not an envelope** — passed through. A deployment that has not turned
 *     encryption on reads its files.
 *   - **Version 1** — accumulated and decrypted in one go, because that is the
 *     only way a single tag over a whole file can be checked. Those files were
 *     written under the old ceiling, so the memory is bounded by it.
 *   - **Version 2** — streamed, a frame authenticated before it is yielded.
 *
 * `skipBytes` and `takeBytes` serve a range request: whole frames before the
 * range are skipped without being decrypted, and the generator stops as soon
 * as the range is satisfied rather than reading the rest of the file.
 */
export async function* decryptFrames(
  tenantId: string,
  source: AsyncIterable<Buffer>,
  window: {
    skipBytes?: number;
    takeBytes?: number;
    /**
     * The file's layout, where the caller has already read the header and is
     * handing over a stream that starts at a **frame boundary**.
     *
     * Without this the reader would consume ten more bytes as a header that is
     * not there — which is what a caller opening the file at a frame offset
     * does, and the symptom is a file that reads back as the same length and
     * different bytes.
     */
    layout?: { keyVersion: number; frameBytes: number };
    /**
     * Which frame the stream begins at.
     *
     * Each frame's position is bound into what authenticates it, so a reader
     * starting at frame 7 and counting from 0 authenticates nothing. That is
     * the protection working — a frame moved is a frame refused — and it means
     * random access has to say where it started.
     */
    startIndex?: number;
  } = {},
): AsyncGenerator<Buffer> {
  const reader = byteReader(source);
  const head = await reader.peek(FRAMED_HEADER_BYTES);
  // Magic and a format byte is all this needs to decide, and all a ten-byte
  // peek can show: `isEnvelope` answers for a whole buffer and would say no to
  // a header on its own.
  const sealed = startsAsEnvelope(head);

  let skip = Math.max(0, window.skipBytes ?? 0);
  let take = window.takeBytes === undefined ? Number.POSITIVE_INFINITY : Math.max(0, window.takeBytes);

  /** What of this piece of plaintext the window actually wants. */
  const windowed = (plaintext: Buffer): Buffer | undefined => {
    if (take <= 0) return undefined;
    let piece = plaintext;
    if (skip > 0) {
      if (skip >= piece.length) {
        skip -= piece.length;
        return undefined;
      }
      piece = piece.subarray(skip);
      skip = 0;
    }
    if (piece.length > take) piece = piece.subarray(0, take);
    take -= piece.length;
    return piece.length > 0 ? piece : undefined;
  };

  if (window.layout) {
    // Already positioned at a frame. Nothing to detect and no header to read.
    yield* framesFrom(tenantId, reader, window.layout, window.startIndex ?? 0, windowed, () => take);
    return;
  }

  if (!sealed) {
    for await (const chunk of reader.rest()) {
      const piece = windowed(chunk);
      if (piece) yield piece;
      if (take <= 0) return;
    }
    return;
  }

  if (!enabled()) {
    throw new DomainError(
      'EVIDENCE_KEY_UNAVAILABLE',
      'This file is encrypted and no evidence master key is configured. The bytes are intact; the key is missing. ' +
        'Restore EVIDENCE_MASTER_KEY — the file cannot be recovered without it, by this platform or by anybody else.',
      503,
    );
  }

  const version = head[MAGIC.length]!;

  if (version === CURRENT_VERSION) {
    const whole: Buffer[] = [];
    for await (const chunk of reader.rest()) whole.push(chunk);
    const piece = windowed(decrypt(tenantId, Buffer.concat(whole)));
    if (piece) yield piece;
    return;
  }

  if (version !== FRAMED_VERSION) {
    throw new DomainError(
      'EVIDENCE_KEY_VERSION_UNKNOWN',
      `This file was written with key version ${version} and this build understands ${CURRENT_VERSION} and ${FRAMED_VERSION}`,
      503,
    );
  }

  await reader.take(FRAMED_HEADER_BYTES);
  yield* framesFrom(tenantId, reader, framedLayout(head), 0, windowed, () => take);
}

/**
 * The frames of a stream that is positioned at a frame boundary.
 *
 * Shared by the two ways in — a whole file whose header has just been read,
 * and a range that opened the file at a frame offset — because a second copy of
 * this loop is a second place the authentication rules can be got wrong.
 */
async function* framesFrom(
  tenantId: string,
  reader: { take: (count: number) => Promise<Buffer> },
  layout: { keyVersion: number; frameBytes: number },
  startIndex: number,
  windowed: (plaintext: Buffer) => Buffer | undefined,
  remaining: () => number,
): AsyncGenerator<Buffer> {
  const frameBytes = layout.frameBytes;
  if (frameBytes <= 0 || frameBytes > 64 * 1_048_576) {
    throw new DomainError('EVIDENCE_DECRYPT_FAILED', 'This file declares a frame size nothing wrote', 500);
  }
  const key = dataKey(tenantId, layout.keyVersion);

  let index = startIndex;
  let ended = false;
  while (!ended) {
    const prefix = await reader.take(FRAME_OVERHEAD_BYTES);
    if (prefix.length < FRAME_OVERHEAD_BYTES) {
      // The file stopped between frames, so no frame ever claimed to be the
      // last one. A truncation, not an end.
      throw new DomainError('EVIDENCE_DECRYPT_FAILED', 'This file ends part way through a frame', 500);
    }
    const length = prefix.readUInt32BE(0);
    if (length > frameBytes + 64) {
      throw new DomainError('EVIDENCE_DECRYPT_FAILED', 'A frame declares more ciphertext than a frame can hold', 500);
    }
    const body = await reader.take(length);
    if (body.length < length) {
      throw new DomainError('EVIDENCE_DECRYPT_FAILED', 'This file ends part way through a frame', 500);
    }

    /*
     * Which frame is the last one is not read from the file — it is *tried*.
     *
     * A frame authenticates against exactly one of the two AADs, and only the
     * writer could have produced the `END` one. So a file cut short fails here
     * rather than ending early, and a frame moved or dropped fails on its
     * index. Both attempts are cheap; the alternative is a length field an
     * attacker gets to choose.
     */
    const open = (last: boolean): Buffer | undefined => {
      const decipher = createDecipheriv('aes-256-gcm', key, prefix.subarray(4, 4 + IV_BYTES));
      decipher.setAAD(frameAAD(tenantId, index, last));
      decipher.setAuthTag(prefix.subarray(4 + IV_BYTES, FRAME_OVERHEAD_BYTES));
      try {
        return Buffer.concat([decipher.update(body), decipher.final()]);
      } catch {
        return undefined;
      }
    };

    const more = open(false);
    const plaintext = more ?? open(true);
    if (!plaintext) {
      throw new DomainError(
        'EVIDENCE_DECRYPT_FAILED',
        'This file did not authenticate. It has been altered, it belongs to a different tenancy, or the master key has changed.',
        500,
      );
    }
    ended = more === undefined;
    index += 1;

    const piece = windowed(plaintext);
    if (piece) yield piece;
    // Satisfied: the rest of the file is not read at all, which is what makes a
    // range request over a two-gigabyte video cheap.
    if (remaining() <= 0) return;
  }
}

/**
 * Where in a framed file a plaintext byte offset lives.
 *
 * Arithmetic, not a search, because every frame but the last holds exactly
 * `frameBytes` of plaintext and occupies exactly `frameBytes + 32` bytes. This
 * is what lets a range request open the file at the right place.
 */
export function framePosition(
  offset: number,
  frameBytes: number = FRAME_BYTES,
): { skipFrames: number; byteOffset: number; withinFrame: number } {
  const skipFrames = Math.floor(offset / frameBytes);
  return {
    skipFrames,
    byteOffset: FRAMED_HEADER_BYTES + skipFrames * (frameBytes + FRAME_OVERHEAD_BYTES),
    withinFrame: offset - skipFrames * frameBytes,
  };
}

/**
 * Whether a stored file is the framed format, from its first bytes.
 *
 * Deliberately the cheap check — magic and the format byte — because the
 * caller has a header and not a file. `isEnvelope` answers for a whole buffer
 * and requires a frame to be present, so asking it about ten bytes of header
 * says no about a file that certainly is framed, and the file then reads as
 * plaintext: ciphertext served to somebody as their document.
 */
export function isFramed(head: Buffer): boolean {
  return startsAsEnvelope(head) && head[MAGIC.length] === FRAMED_VERSION;
}

/**
 * A pull reader over a stream of chunks.
 *
 * Needed because the framed format is read in exact lengths — a header, then a
 * prefix and a body per frame — and a stream yields whatever sizes it likes.
 * Nothing larger than one frame plus one source chunk is ever held.
 */
function byteReader(source: AsyncIterable<Buffer>): {
  peek: (count: number) => Promise<Buffer>;
  take: (count: number) => Promise<Buffer>;
  rest: () => AsyncGenerator<Buffer>;
} {
  const iterator = source[Symbol.asyncIterator]();
  let held: Buffer = Buffer.alloc(0);
  let done = false;

  const fill = async (count: number): Promise<void> => {
    while (held.length < count && !done) {
      const next = await iterator.next();
      if (next.done) {
        done = true;
        return;
      }
      held = held.length === 0 ? next.value : Buffer.concat([held, next.value]);
    }
  };

  return {
    async peek(count) {
      await fill(count);
      return held.subarray(0, count);
    },
    async take(count) {
      await fill(count);
      const out = held.subarray(0, count);
      held = held.subarray(out.length);
      return out;
    },
    async *rest() {
      if (held.length > 0) {
        yield held;
        held = Buffer.alloc(0);
      }
      while (!done) {
        const next = await iterator.next();
        if (next.done) {
          done = true;
          return;
        }
        yield next.value;
      }
    },
  };
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

  /*
   * A framed file, read whole.
   *
   * Every caller that holds a buffer — the PDF renderer, the document reader,
   * the retention sweep, `rotate` — goes through this function, and a file
   * written by the streaming path must be readable by all of them or the store
   * would hold two kinds of object with two sets of callers. So the frames are
   * walked here as well, synchronously, and the whole plaintext comes back.
   *
   * The memory cost is the file, which is exactly what a caller asking for a
   * whole buffer has already accepted. A caller that cannot afford it reads
   * `decryptFrames` instead, and the large-file paths do.
   */
  if (version === FRAMED_VERSION) return decryptFramesSync(tenantId, stored);

  if (version !== CURRENT_VERSION) {
    throw new DomainError(
      'EVIDENCE_KEY_VERSION_UNKNOWN',
      `This file was written with key version ${version} and this build understands ${CURRENT_VERSION} and ${FRAMED_VERSION}`,
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
 * The framed format, walked over a buffer rather than a stream.
 *
 * The same rules as `decryptFrames` — per-frame authentication, the index and
 * the end bound into the AAD — in the form `decrypt` needs, which is one
 * buffer in and one buffer out. The two are tested against each other: a file
 * written by the streaming writer is read by both, and they agree byte for
 * byte, or the store holds objects only half of it can read.
 */
function decryptFramesSync(tenantId: string, stored: Buffer): Buffer {
  const layout = framedLayout(stored);
  const frameBytes = layout.frameBytes;
  if (frameBytes <= 0 || frameBytes > 64 * 1_048_576) {
    throw new DomainError('EVIDENCE_DECRYPT_FAILED', 'This file declares a frame size nothing wrote', 500);
  }
  const key = dataKey(tenantId, layout.keyVersion);
  const pieces: Buffer[] = [];

  let at = FRAMED_HEADER_BYTES;
  let index = 0;
  for (;;) {
    if (at + FRAME_OVERHEAD_BYTES > stored.length) {
      throw new DomainError('EVIDENCE_DECRYPT_FAILED', 'This file ends part way through a frame', 500);
    }
    const length = stored.readUInt32BE(at);
    const iv = stored.subarray(at + 4, at + 4 + IV_BYTES);
    const tag = stored.subarray(at + 4 + IV_BYTES, at + FRAME_OVERHEAD_BYTES);
    const body = stored.subarray(at + FRAME_OVERHEAD_BYTES, at + FRAME_OVERHEAD_BYTES + length);
    if (body.length < length) {
      throw new DomainError('EVIDENCE_DECRYPT_FAILED', 'This file ends part way through a frame', 500);
    }

    const open = (last: boolean): Buffer | undefined => {
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAAD(frameAAD(tenantId, index, last));
      decipher.setAuthTag(tag);
      try {
        return Buffer.concat([decipher.update(body), decipher.final()]);
      } catch {
        return undefined;
      }
    };

    const more = open(false);
    const plaintext = more ?? open(true);
    if (!plaintext) {
      throw new DomainError(
        'EVIDENCE_DECRYPT_FAILED',
        'This file did not authenticate. It has been altered, it belongs to a different tenancy, or the master key has changed.',
        500,
      );
    }
    pieces.push(plaintext);
    at += FRAME_OVERHEAD_BYTES + length;
    index += 1;
    if (more === undefined) break;
  }

  return Buffer.concat(pieces);
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
  //
  // Under the export-tag key derived for the current secret. A tag is handed
  // to a third party and verified years later, which is exactly why the
  // secret could never be rotated while every purpose shared the raw one;
  // `identity/secrets.ts` verifies against the previous secrets too, and the
  // form this signed in before, so what is out there keeps verifying.
  return signFor('export-tag', `${input.tenantId}|${input.reference}|${input.contentHash}`).signature;
}

/** Whether a presented tag is one this platform issued for this document. */
export function verifyTag(
  input: { contentHash: string; reference: string; tenantId: string },
  presented: string,
): boolean {
  return verifyFor('export-tag', `${input.tenantId}|${input.reference}|${input.contentHash}`, presented).valid;
}
