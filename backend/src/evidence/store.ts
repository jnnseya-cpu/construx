import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DomainError } from '../core/errors.ts';
import { config } from '../config.ts';
import { signFor, verifyFor } from '../identity/secrets.ts';
import * as envelope from './envelope.ts';
import { S3Client } from '../store/s3.ts';

/**
 * The most parts one upload may be split into.
 *
 * A ceiling rather than a size: the device picks a chunk size for the link it
 * is on, and this bounds how many files an unfinished upload can leave on the
 * volume. At the store's own size limit this is a floor of well under a
 * megabyte per part, which is smaller than any link worth chunking for.
 */
const MAX_CHUNKS = 512;

/**
 * The largest file a deployment with **no volume** can take.
 *
 * `S3Client.put` sends a body in one request from one buffer, and multipart
 * upload is not built, so an object-store-only deployment is bounded by memory
 * rather than by disk. Named and refused at a stated size instead of being
 * discovered as an out-of-memory kill in the middle of somebody else's request.
 */
const REMOTE_SINGLE_PUT_BYTES = 256 * 1_048_576;

/** `CXE1 ‖ version ‖ iv ‖ tag` — the single-shot envelope's header. */
const ENVELOPE_V1_HEADER_BYTES = envelope.MAGIC.length + 1 + 12 + 16;

/**
 * The plaintext length of a framed object, from the size of the file.
 *
 * Every frame but the last carries exactly `frameBytes` of plaintext and
 * occupies exactly `frameBytes + FRAME_OVERHEAD_BYTES` on disk, and AES-GCM
 * ciphertext is the same length as its plaintext — so this is arithmetic. Kept
 * as arithmetic rather than as a sidecar file because a second copy of a
 * number is a number that can disagree with the bytes.
 */
export function plaintextBytesOf(fileSize: number, frameBytes: number = envelope.FRAME_BYTES): number {
  const header = envelope.FRAMED_HEADER_BYTES;
  const stride = frameBytes + envelope.FRAME_OVERHEAD_BYTES;
  const body = Math.max(0, fileSize - header);
  const whole = Math.floor(body / stride);
  const tail = body - whole * stride;
  return whole * frameBytes + Math.max(0, tail - envelope.FRAME_OVERHEAD_BYTES);
}

/**
 * The object store this deployment is configured for, built once.
 *
 * A module-level singleton rather than a field built per `EvidenceStore`,
 * because every store in a process addresses the same bucket and building a
 * client per instance would mean a test constructing three stores opened three
 * clients to the same place.
 */
let shared: S3Client | undefined;
function defaultS3(): S3Client {
  shared ??= new S3Client(config.objectStore);
  return shared;
}

/**
 * The object store for field evidence.
 *
 * Until now the platform proved a document *with a given hash* was the
 * evidence, and did not hold the document. That is a real chain — the hash is
 * computed in the browser over the real bytes and written into an append-only
 * event — but it only works while somebody else still has the file. On a
 * dispute three years after practical completion, the person who took the
 * photograph has left the company and the phone has been wiped.
 *
 * I previously called this a gap that needed infrastructure. It does not.
 * `node:fs` and `node:crypto` give a tenant-scoped, content-addressed store
 * with expiring signed URLs and no runtime dependency, which is the same
 * argument the durable ledger journal already makes. S3 becomes a driver behind
 * this interface when there is somewhere to deploy it; the semantics do not
 * change.
 *
 * ---
 *
 * **Content-addressed, and the address is the integrity check.** An object
 * lives at its own SHA-256. Storing the same file twice is one object, and a
 * corrupted or substituted file cannot be served under the hash the ledger
 * recorded, because the path *is* the hash.
 *
 * **The bytes are verified against the claimed hash on write.** The browser
 * computes the hash and the event records it; if the upload were trusted to
 * declare its own address, a client could store bytes under somebody else's
 * hash and poison the evidence chain at its root. Hashing again on the server
 * costs one pass over the file and removes that entirely.
 *
 * **Tenant-scoped paths, and deduplication stops at the tenant boundary.** Two
 * tenants uploading the same file get two objects. That looks wasteful and is
 * correct: erasing one tenant's data must not remove another tenant's evidence,
 * and a shared object would make one tenant's retention decision reach into
 * another's record.
 *
 * **URLs expire and are bound to the tenant.** An HMAC over tenant, hash and
 * expiry, compared in constant time. A link forwarded outside the tenancy is
 * useless, and a link that leaks stops working.
 */

/**
 * A hash the filesystem may be shown.
 *
 * Anchored, fixed length, lower-case hex. This is the only thing standing
 * between a caller-supplied string and a path join, so it is a whitelist rather
 * than a check for `..` — a blacklist here is a traversal waiting for an
 * encoding somebody has not thought of.
 */
const HASH = /^sha256:[0-9a-f]{64}$/;

export type StoredObject = {
  hash: string;
  bytes: number;
  contentType: string;
  storedAt: string;
};

/**
 * One part of an unfinished upload, as the platform holds it.
 *
 * The hash is of the *plaintext* part, computed by the platform when the part
 * arrived — not copied from what the device declared. A checksum a client
 * supplies and nobody recomputes proves nothing at all.
 */
export type UploadPart = {
  index: number;
  bytes: number;
  /**
   * Absent only on a part written before the platform recorded checksums, where
   * the length is the encrypted length on the volume. Inventing a hash for one
   * of those would be a measurement nobody made.
   */
  hash?: string;
};

/**
 * Where a resumable upload has got to — §15.2.
 *
 * `held` keeps its original shape, so every existing caller reads it unchanged;
 * everything else is additional. `missing` is the list a device actually needs:
 * it says which parts to send, rather than leaving the device to subtract two
 * arrays and hope it agreed with the platform about the part count.
 */
export type UploadProgress = {
  held: number[];
  complete: boolean;
  parts: UploadPart[];
  heldBytes: number;
  /** The part count this upload was begun with, which fixes its shape. */
  chunks?: number;
  startedAt?: string;
  missing?: number[];
};

/** An unfinished upload on the volume, for the retention position and the sweep. */
export type UnfinishedUpload = { hash: string; parts: number; chunks?: number; bytes: number; startedAt: string };

/**
 * The shape an upload was begun with, written beside its parts.
 *
 * Recorded rather than re-declared per part because a device that reboots and
 * resumes with a different chunk size would otherwise mix two splits of the
 * same file into an assembly that cannot possibly hash correctly — and the only
 * symptom would be a whole-file hash failure after the last part, which throws
 * everything away. This turns that into a refusal at the first mismatched part.
 */
type ChunkSession = { chunks: number; contentType: string; startedAt: string };

/** The session file's name inside a chunk directory. Not an integer, so it is never read as a part. */
const CHUNK_SESSION = 'session';

/** Hash bytes the way the browser does, so the two agree. */
export function hashBytes(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/**
 * The store, holding its own root.
 *
 * A class rather than module functions reading configuration directly, because
 * that is how the rest of the platform is assembled: `Journal` takes a path,
 * `main.ts` reads the configuration, and the composition root is the only place
 * that knows about the environment. It also means a test drives a real store in
 * a temporary directory rather than a mocked one.
 */
export class EvidenceStore {
  readonly #root: string;
  /**
   * An S3-compatible store, where one is configured.
   *
   * The volume is correct for a single instance and it is precisely why the
   * application tier cannot be replicated: two containers on separate volumes
   * each hold half the evidence, and a request routed to the wrong one answers
   * "the platform holds the hash of this evidence but not the file" about a file
   * the platform certainly holds.
   *
   * When this is set, the object store is the only store — not a cache in front
   * of the volume. A write-through cache would mean two places a file might be
   * and two answers to "is it held", and the whole point of a content-addressed
   * evidence store is that there is one answer.
   */
  readonly #objects: S3Client | undefined;
  readonly #maxBytes: number;
  readonly #linkTtlSeconds: number;
  /** A secret of the store's own, for a test; absent, the deployment's, with its rotation chain. */
  readonly #secret: string | undefined;
  /** Bytes per tenancy, lazily filled and maintained by put and discard. */
  readonly #usage = new Map<string, number>();

  constructor(
    root: string = config.evidence.storePath,
    options: { maxBytes?: number; linkTtlSeconds?: number; secret?: string; objects?: S3Client } = {},
  ) {
    this.#root = root;
    this.#objects = options.objects ?? (defaultS3().configured ? defaultS3() : undefined);
    this.#maxBytes = options.maxBytes ?? config.evidence.maxBytes;
    this.#linkTtlSeconds = options.linkTtlSeconds ?? config.evidence.linkTtlSeconds;
    // The gateway's own secret rather than a second one: another secret is
    // another thing to rotate. Links are signed under the evidence-link key
    // derived from it (`identity/secrets.ts`), so a leaked link signature is
    // not a session key, and a rotation keeps a link minted a moment before
    // it good for the rest of its five minutes.
    this.#secret = options.secret;
  }

  /** Whether a store is configured at all. Neither means hashes without files. */
  get configured(): boolean {
    return this.#root !== '' || this.#remote !== undefined;
  }

  /** The object store, where one is in use. Named so callers can say where they looked. */
  get #remote(): S3Client | undefined {
    return this.#objects?.configured ? this.#objects : undefined;
  }

  /** Where this deployment keeps evidence, in words, with no credential in it. */
  get backend(): string {
    if (this.#remote) return this.#remote.address;
    return this.#root === '' ? 'none — hashes only' : this.#root;
  }

  /**
   * The object key for a tenancy's file.
   *
   * The same fan-out as the filesystem path, for the same reason and one more:
   * S3 partitions by key prefix, so a million objects under one flat prefix is
   * a hot partition as well as an unreadable listing.
   */
  #keyFor(tenantId: string, hash: string): string {
    if (!HASH.test(hash)) throw new DomainError('EVIDENCE_HASH_INVALID', 'Not a sha256 content hash');
    if (!/^[0-9A-Za-z_-]{1,64}$/.test(tenantId)) {
      throw new DomainError('EVIDENCE_TENANT_INVALID', 'Not a tenant identifier');
    }
    const digest = hash.slice('sha256:'.length);
    return `${tenantId}/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}`;
  }

  /**
   * Is this file held, asked of whichever store is in use.
   *
   * Async because an object store is over a network and there is no honest
   * synchronous answer to a question that requires a round trip. Every caller
   * that decides whether a file can be read uses this one.
   *
   * An unreachable object store **throws** rather than answering false. "Not
   * held" and "cannot tell" are different facts, and conflating them is how an
   * evidence register reports files as missing during an outage and somebody
   * re-uploads what was already there.
   */
  async holds(tenantId: string, hash: string): Promise<boolean> {
    const remote = this.#remote;
    if (!remote) return this.has(tenantId, hash);
    if (!HASH.test(hash)) return false;
    return remote.has(this.#keyFor(tenantId, hash));
  }

  /** Read the bytes, from whichever store is in use, re-verifying the hash. */
  async fetch(tenantId: string, hash: string): Promise<{ bytes: Buffer; contentType: string }> {
    const remote = this.#remote;
    if (!remote) return this.read(tenantId, hash);

    const held = await remote.get(this.#keyFor(tenantId, hash));
    if (!held) {
      throw new DomainError('EVIDENCE_NOT_STORED', 'The platform holds no bytes for this evidence', 404);
    }
    this.#assertBufferable(held.bytes.length);
    const bytes = envelope.decrypt(tenantId, held.bytes);

    // Re-verified on read exactly as the filesystem path does. An object store
    // is more reliable than a volume and it is still somewhere else's disk, and
    // the whole point of the record is that it can be trusted years later.
    if (hashBytes(bytes) !== hash) {
      throw new DomainError('EVIDENCE_CORRUPT', 'The stored bytes no longer match their hash', 500);
    }
    return { bytes, contentType: held.contentType };
  }

  /** Store the bytes in whichever store is in use. */
  async store(tenantId: string, claimedHash: string, bytes: Buffer, contentType: string): Promise<StoredObject> {
    const remote = this.#remote;
    if (!remote) return this.write(tenantId, claimedHash, bytes, contentType);

    if (bytes.length === 0) throw new DomainError('EVIDENCE_EMPTY', 'An empty file is not evidence');
    if (bytes.length > this.#maxBytes) {
      throw new DomainError(
        'EVIDENCE_TOO_LARGE',
        `An object over ${Math.round(this.#maxBytes / 1_048_576)}MB cannot be stored`,
        413,
      );
    }
    // The hash is checked before the bytes travel, not after. Uploading first
    // and discovering the mismatch afterwards leaves an object in the bucket
    // that no record names, which is exactly what the retention sweep then has
    // to reason about.
    const actual = hashBytes(bytes);
    if (actual !== claimedHash) {
      throw new DomainError(
        'EVIDENCE_HASH_MISMATCH',
        `These bytes hash to ${actual}, not to the ${claimedHash} recorded as this evidence`,
      );
    }

    await remote.put(this.#keyFor(tenantId, claimedHash), envelope.encrypt(tenantId, bytes), contentType);
    this.#usage.delete(tenantId);
    return { hash: claimedHash, bytes: bytes.length, contentType, storedAt: new Date().toISOString() };
  }

  /** Everything held for a tenancy, from whichever store is in use. */
  async held(tenantId: string): Promise<Array<{ hash: string; bytes: number; storedAt: string; partial: boolean }>> {
    const remote = this.#remote;
    if (!remote) return this.list(tenantId);
    if (!/^[0-9A-Za-z_-]{1,64}$/.test(tenantId)) {
      throw new DomainError('EVIDENCE_TENANT_INVALID', 'Not a tenant identifier');
    }
    return (await remote.list(`${tenantId}/`))
      .map((object) => {
        const digest = object.key.split('/').pop() ?? '';
        return { hash: `sha256:${digest}`, bytes: object.size, storedAt: '', partial: false };
      })
      .filter((object) => /^sha256:[0-9a-f]{64}$/.test(object.hash));
  }

  #pathFor(tenantId: string, hash: string): string {
    return this.#fanout(this.#root, tenantId, hash);
  }

  /**
   * The tenant-scoped, fanned-out path for an address under some root.
   *
   * Taken as a parameter because objects and the parts of an unfinished upload
   * do not necessarily live on the same volume — see `#stagingRoot`. The
   * validation is here rather than at each call site: this is the only thing
   * standing between a caller-supplied string and a path join.
   */
  #fanout(root: string, tenantId: string, hash: string): string {
    if (!HASH.test(hash)) throw new DomainError('EVIDENCE_HASH_INVALID', 'Not a sha256 content hash');
    if (!/^[0-9A-Za-z_-]{1,64}$/.test(tenantId)) {
      throw new DomainError('EVIDENCE_TENANT_INVALID', 'Not a tenant identifier');
    }
    const digest = hash.slice('sha256:'.length);
    // Two levels of fan-out. A single directory holding a million objects is
    // slow to list and, on some filesystems, slow to open.
    return join(root, tenantId, digest.slice(0, 2), digest.slice(2, 4), digest);
  }

  /**
   * Where the parts of an unfinished upload are staged.
   *
   * Parts are always local, whichever store the finished object goes to: an
   * upload is assembled and hashed before anything is stored, so the pieces
   * have to land somewhere a process can read back.
   *
   * The volume where there is one. Where there is not — `OBJECT_STORE_*`
   * configured and `EVIDENCE_STORE_PATH` unset, which is a legitimate
   * deployment — the previous code joined against an empty root and staged
   * parts **relative to the process working directory**. That put customer
   * photography in whatever directory the container happened to start in, where
   * nothing lists it, nothing sweeps it and nothing expects it. A named
   * temporary directory is the honest answer: it is somewhere parts are
   * supposed to be, the sweep can find it, and losing it on a restart costs a
   * device one re-send of an upload it had not finished anyway.
   */
  get #stagingRoot(): string {
    if (this.#root !== '') return this.#root;
    return this.#remote ? join(tmpdir(), 'construx-upload-staging') : '';
  }

  /**
   * Store the bytes behind a hash that has already been recorded as evidence.
   *
   * Idempotent: storing the same object twice is a no-op, because the second
   * write would produce identical bytes at an identical path. That matters for
   * the offline outbox, which retries.
   */
  put(tenantId: string, claimedHash: string, bytes: Buffer, contentType: string): StoredObject {
    if (!this.configured) {
      throw new DomainError(
        'EVIDENCE_STORE_UNCONFIGURED',
        'This deployment has nowhere to keep files: no object store is configured. The operator sets ' +
          'EVIDENCE_STORE_PATH to a volume, or the OBJECT_STORE_* settings, and restarts. Records are unaffected.',
        503,
      );
    }
    if (bytes.length === 0) throw new DomainError('EVIDENCE_EMPTY', 'An empty file is not evidence');
    if (bytes.length > this.#maxBytes) {
      throw new DomainError(
        'EVIDENCE_TOO_LARGE',
        `Evidence exceeds the ${Math.round(this.#maxBytes / 1_048_576)}MB limit`,
        413,
      );
    }

    // The guard that makes the chain worth having. Without it a client could
    // store arbitrary bytes under a hash the ledger already trusts.
    const actual = hashBytes(bytes);
    if (actual !== claimedHash) {
      throw new DomainError(
        'EVIDENCE_HASH_MISMATCH',
        'The uploaded bytes do not hash to the recorded evidence hash',
        422,
      );
    }

    const target = this.#pathFor(tenantId, claimedHash);
    if (existsSync(target)) {
      const stat = statSync(target);
      return { hash: claimedHash, bytes: stat.size, contentType, storedAt: stat.mtime.toISOString() };
    }

    mkdirSync(dirname(target), { recursive: true });
    // Write beside and rename, so a reader never sees a half-written object
    // under a hash that claims to describe it. Same discipline as the journal.
    const temporary = `${target}.partial`;
    // Encrypted on the way to disk, where a master key is configured. The hash
    // was checked against the *plaintext* above and the address is still the
    // plaintext hash — which is deliberate: an address derived from ciphertext
    // would change every time the key rotated, and every record naming that
    // evidence would stop resolving.
    writeFileSync(temporary, envelope.encrypt(tenantId, bytes));
    renameSync(temporary, target);
    // The content type is metadata, not content, and it is deliberately not
    // part of the address: the same bytes are the same object however they were
    // labelled on the way in.
    writeFileSync(`${target}.type`, contentType);

    // Only here, after the write that actually added bytes. The idempotent
    // branch above returns before this point, so storing the same object twice
    // is counted once — which is what the offline outbox's retries depend on.
    const known = this.#usage.get(tenantId);
    if (known !== undefined) this.#usage.set(tenantId, known + bytes.length);

    return {
      hash: claimedHash,
      bytes: bytes.length,
      contentType,
      storedAt: new Date().toISOString(),
    };
  }

  // --- the same, off the event loop ------------------------------------------
  //
  // `put`, `get` and `putChunk` read and write the volume synchronously, which
  // held the one process that serves everybody for the whole of a fifty-
  // megabyte write or read. Every request path now goes through these three:
  // the same checks in the same order, the same paths, the same envelope, the
  // same answers — and the bytes move through `fs/promises`, so the loop is
  // free while the disk works. The synchronous forms stay for the callers
  // that are synchronous by nature (a PDF renderer resolving an image, an
  // issuance rendered in one step) and for the tests that drive the store
  // directly; both forms hold the same objects at the same addresses.

  /** The checks `put` makes before touching the disk, shared so the two cannot drift. */
  #checkedForWrite(claimedHash: string, bytes: Buffer): void {
    if (!this.configured) {
      throw new DomainError(
        'EVIDENCE_STORE_UNCONFIGURED',
        'This deployment has nowhere to keep files: no object store is configured. The operator sets ' +
          'EVIDENCE_STORE_PATH to a volume, or the OBJECT_STORE_* settings, and restarts. Records are unaffected.',
        503,
      );
    }
    if (bytes.length === 0) throw new DomainError('EVIDENCE_EMPTY', 'An empty file is not evidence');
    if (bytes.length > this.#maxBytes) {
      throw new DomainError('EVIDENCE_TOO_LARGE', `Evidence exceeds the ${Math.round(this.#maxBytes / 1_048_576)}MB limit`, 413);
    }
    if (hashBytes(bytes) !== claimedHash) {
      throw new DomainError('EVIDENCE_HASH_MISMATCH', 'The uploaded bytes do not hash to the recorded evidence hash', 422);
    }
  }

  /**
   * The checks a part passes before it is written, shared by both forms.
   *
   * Shared rather than written twice for the reason the chain body was: a rule
   * applied at two call sites is a rule with one hole in it, and the two forms
   * of this upload differ only in whether the disk is awaited.
   *
   * Returns the part's own hash, so the caller records what the platform
   * measured rather than what the device claimed.
   */
  #checkedForChunk(index: number, chunks: number, bytes: Buffer, declaredPartHash?: string): string {
    if (!this.configured) {
      throw new DomainError(
        'EVIDENCE_STORE_UNCONFIGURED',
        'This deployment has nowhere to keep files: no object store is configured. The operator sets ' +
          'EVIDENCE_STORE_PATH to a volume, or the OBJECT_STORE_* settings, and restarts. Records are unaffected.',
        503,
      );
    }
    if (!Number.isInteger(chunks) || chunks < 1 || chunks > MAX_CHUNKS) {
      throw new DomainError('EVIDENCE_CHUNK_COUNT_INVALID', `An upload has between 1 and ${MAX_CHUNKS} parts`, 422);
    }
    if (!Number.isInteger(index) || index < 0 || index >= chunks) {
      throw new DomainError('EVIDENCE_CHUNK_INDEX_INVALID', `Part ${index} is outside an upload of ${chunks}`, 422);
    }
    if (bytes.length === 0) throw new DomainError('EVIDENCE_EMPTY', 'An empty part is not evidence');

    const partHash = hashBytes(bytes);

    // The checksum on the part, and the reason the whole feature exists.
    //
    // Without it a truncated or corrupted part is undetectable until every part
    // is in, the assembled file fails its hash, and the *entire* upload is
    // discarded — so a phone on a bad link re-sends three hundred megabytes to
    // lose them the same way again. With it the bad part is refused at the
    // part, and the device re-sends one chunk.
    if (declaredPartHash !== undefined) {
      if (!HASH.test(declaredPartHash)) {
        throw new DomainError('EVIDENCE_PART_HASH_INVALID', 'A part checksum is a sha256 content hash', 422);
      }
      if (declaredPartHash !== partHash) {
        throw new DomainError(
          'EVIDENCE_PART_HASH_MISMATCH',
          `Part ${index} arrived as ${partHash}, not as the ${declaredPartHash} sent with it, so it did not survive ` +
            'the connection intact. Send this part again; every other part of this upload is still held.',
          422,
        );
      }
    }
    return partHash;
  }

  /** The shape this upload was begun with, or nothing if this is its first part. */
  #chunkSession(dir: string): ChunkSession | undefined {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, CHUNK_SESSION), 'utf8')) as ChunkSession;
      return Number.isInteger(parsed.chunks) && parsed.chunks > 0 ? parsed : undefined;
    } catch {
      // Missing, or written by a build before sessions existed. Either way this
      // upload has no recorded shape, and an upload with no recorded shape is
      // treated as one being begun now rather than refused — a device part-way
      // through when the platform was deployed keeps its parts.
      return undefined;
    }
  }

  /**
   * Fix this upload's shape, or refuse a part that does not fit the one it has.
   *
   * Returns the session in force.
   */
  #openChunkSession(dir: string, index: number, chunks: number, contentType: string): ChunkSession {
    const existing = this.#chunkSession(dir);
    if (existing) {
      if (existing.chunks !== chunks) {
        throw new DomainError(
          'EVIDENCE_CHUNK_COUNT_CHANGED',
          `This upload was begun in ${existing.chunks} parts and part ${index} arrived as one of ${chunks}. Parts ` +
            `from two different splits of the same file cannot be assembled. Continue in ${existing.chunks} parts, ` +
            'or abandon the upload and begin again.',
          409,
        );
      }
      return existing;
    }
    const opened: ChunkSession = { chunks, contentType, startedAt: new Date().toISOString() };
    writeFileSync(join(dir, CHUNK_SESSION), JSON.stringify(opened));
    return opened;
  }

  /** What the platform measured a held part to be, where it recorded it. */
  #partMeta(dir: string, index: number): { index: number; bytes: number; hash: string } | undefined {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, `${index}.meta`), 'utf8')) as { bytes: number; hash: string };
      return typeof parsed.hash === 'string' && HASH.test(parsed.hash) && Number.isInteger(parsed.bytes)
        ? { index, bytes: parsed.bytes, hash: parsed.hash }
        : undefined;
    } catch {
      return undefined;
    }
  }

  /** Every held part, with what the platform measured it to be. */
  #partsOf(dir: string, held: number[]): { parts: UploadPart[]; heldBytes: number } {
    const parts = held.map((index) => {
      const meta = this.#partMeta(dir, index);
      if (meta) return meta;
      const path = join(dir, String(index));
      return { index, bytes: existsSync(path) ? statSync(path).size : 0 };
    });
    return { parts, heldBytes: parts.reduce((total, part) => total + part.bytes, 0) };
  }

  #recordPart(dir: string, index: number, bytes: number, hash: string): void {
    writeFileSync(join(dir, `${index}.meta`), JSON.stringify({ index, bytes, hash }));
  }

  /**
   * Assemble, checking every part against the checksum recorded when it arrived.
   *
   * A part that no longer matches is dropped **on its own** and named in the
   * refusal, because the difference between re-sending one chunk and re-sending
   * the file is the difference between an upload that finishes on a site gate's
   * signal and one that never does.
   */
  #assemble(dir: string, held: number[], pieces: Buffer[]): Buffer {
    const corrupt: number[] = [];
    for (let i = 0; i < held.length; i += 1) {
      const meta = this.#partMeta(dir, held[i]!);
      if (meta && hashBytes(pieces[i]!) !== meta.hash) corrupt.push(held[i]!);
    }
    if (corrupt.length === 0) return Buffer.concat(pieces);

    for (const index of corrupt) {
      rmSync(join(dir, String(index)), { force: true });
      rmSync(join(dir, `${index}.meta`), { force: true });
    }
    const one = corrupt.length === 1;
    throw new DomainError(
      'EVIDENCE_PART_CORRUPT',
      `Part${one ? '' : 's'} ${corrupt.join(', ')} of this upload ${one ? 'no longer matches' : 'no longer match'} ` +
        `the checksum recorded when ${one ? 'it' : 'they'} arrived, and ${one ? 'has' : 'have'} been dropped. ` +
        `Send ${one ? 'that part' : 'those parts'} again; the rest of the upload is still held.`,
      422,
    );
  }

  /** `put`, with the disk waited on rather than blocked on. */
  async write(tenantId: string, claimedHash: string, bytes: Buffer, contentType: string): Promise<StoredObject> {
    this.#checkedForWrite(claimedHash, bytes);
    const target = this.#pathFor(tenantId, claimedHash);
    const existing = await stat(target).catch(() => undefined);
    if (existing) return { hash: claimedHash, bytes: existing.size, contentType, storedAt: existing.mtime.toISOString() };

    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.partial`;
    await writeFile(temporary, envelope.encrypt(tenantId, bytes));
    await rename(temporary, target);
    await writeFile(`${target}.type`, contentType);

    const known = this.#usage.get(tenantId);
    if (known !== undefined) this.#usage.set(tenantId, known + bytes.length);
    return { hash: claimedHash, bytes: bytes.length, contentType, storedAt: new Date().toISOString() };
  }

  /** `get`, with the disk waited on rather than blocked on. */
  async read(tenantId: string, hash: string): Promise<{ bytes: Buffer; contentType: string }> {
    if (!this.configured) throw new DomainError('EVIDENCE_NOT_STORED', 'The platform holds no bytes for this evidence', 404);
    const target = this.#pathFor(tenantId, hash);
    const held = await stat(target).catch(() => undefined);
    if (held) this.#assertBufferable(held.size);
    let sealed: Buffer;
    try {
      sealed = await readFile(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new DomainError('EVIDENCE_NOT_STORED', 'The platform holds no bytes for this evidence', 404);
      }
      throw error;
    }
    const bytes = envelope.decrypt(tenantId, sealed);
    if (hashBytes(bytes) !== hash) throw new DomainError('EVIDENCE_CORRUPT', 'The stored bytes no longer match their hash', 500);
    const contentType = await readFile(`${target}.type`, 'utf8').catch(() => 'application/octet-stream');
    return { bytes, contentType };
  }

  // --- any size at all ------------------------------------------------------
  //
  // Construction does not work at fifty megabytes. A drawing set is hundreds of
  // megabytes, a federated model more, a site walkthrough recorded on a phone
  // is a gigabyte an hour, and a scanned historic pack for a refurbishment is
  // whatever the archive sent. Every path above holds the whole file in memory
  // — `put` takes a Buffer, `read` returns one, and the chunked assembly
  // concatenates every part before it writes — so the ceiling was not really
  // `EVIDENCE_MAX_BYTES` at all. It was the heap of the one process that serves
  // everybody, and raising the configured number without changing any of this
  // would have turned a clean 413 into an out-of-memory kill in the middle of
  // somebody else's request.
  //
  // `putStream` and `readStream` move a file through the volume a frame at a
  // time, holding one mebibyte, whatever the file's size. They are what the
  // upload and download routes use; the buffered forms above stay for the
  // callers that need a whole file in hand anyway — a PDF to render, a document
  // to read — and both forms address the same objects, because
  // `envelope.decrypt` reads the framed format too.

  /**
   * Refuse to read a file into memory that has no business being there.
   *
   * The one choke point for it, rather than a check at each caller. Holding a
   * file and analysing one are different acts: the store can keep a
   * two-gigabyte site video, and `get`, `read` and `fetch` hand a caller the
   * whole thing in a Buffer — so every inspection, text extraction, PDF render
   * and document reading behind them would try to hold it in the heap of the
   * one process that serves everybody. Guarding the readers means a path that
   * was never written with a gigabyte in mind cannot find one.
   *
   * The refusal says what is true: the file is held, it can be downloaded and
   * streamed, and what cannot be done is buffer it.
   */
  #assertBufferable(bytes: number): void {
    const limit = config.evidence.analyseMaxBytes;
    if (limit <= 0 || bytes <= limit) return;
    const mb = (value: number): string => `${Math.round(value / 1_048_576)}MB`;
    throw new DomainError(
      'EVIDENCE_TOO_LARGE_TO_READ',
      `This file is ${mb(bytes)} and the most this deployment will read into memory in one piece is ${mb(limit)}. ` +
        'The file is held and intact: it can be downloaded, streamed, served in ranges and kept as evidence for as ' +
        'long as the record needs it. What cannot be done is hold all of it at once to inspect, extract or render it ' +
        '— raise EVIDENCE_ANALYSE_MAX_BYTES where the container has the memory, or work from a smaller copy.',
      413,
    );
  }

  /**
   * The temporary name a streamed write lands under.
   *
   * Random rather than `.partial`, because two devices can be sending the same
   * file at the same time — the same photograph from two phones, the same
   * drawing from two people — and a shared temporary name means each truncates
   * the other's write and neither hashes correctly at the end.
   */
  #stagingName(target: string): string {
    return `${target}.incoming-${randomBytes(6).toString('hex')}`;
  }

  /**
   * Store a file of any size, streaming it to the volume.
   *
   * The plaintext is hashed as it passes through, so the guarantee is the one
   * `put` makes and not a weaker version of it: the bytes are verified against
   * the hash the ledger already records, and a mismatch stores nothing. The
   * difference is only that neither the plaintext nor the ciphertext is ever
   * held whole.
   *
   * `declaredBytes` is the `Content-Length` where the caller has one. It is
   * used to refuse an oversized upload before a byte is read rather than after
   * it has all arrived; the real size is still enforced as the stream runs,
   * because a declared length is a claim.
   */
  async putStream(
    tenantId: string,
    claimedHash: string,
    source: AsyncIterable<Buffer>,
    contentType: string,
    options: { declaredBytes?: number } = {},
  ): Promise<StoredObject & { alreadyHeld?: true }> {
    if (!this.configured) {
      throw new DomainError(
        'EVIDENCE_STORE_UNCONFIGURED',
        'This deployment has nowhere to keep files: no object store is configured. The operator sets ' +
          'EVIDENCE_STORE_PATH to a volume, or the OBJECT_STORE_* settings, and restarts. Records are unaffected.',
        503,
      );
    }
    if (options.declaredBytes !== undefined && options.declaredBytes > this.#maxBytes) {
      throw new DomainError('EVIDENCE_TOO_LARGE', this.#tooLarge(options.declaredBytes), 413);
    }

    // An object store has no streaming write here: `S3Client.put` takes a
    // buffer, and multipart upload is not built. Said as a named boundary
    // rather than discovered as an out-of-memory kill.
    const remote = this.#remote;
    if (remote && this.#root === '') {
      if ((options.declaredBytes ?? 0) > REMOTE_SINGLE_PUT_BYTES) {
        throw new DomainError(
          'EVIDENCE_REMOTE_TOO_LARGE',
          `This deployment keeps evidence only in an object store, and a file over ` +
            `${Math.round(REMOTE_SINGLE_PUT_BYTES / 1_048_576)}MB cannot be written there in one request — multipart ` +
            'upload is not built. Configure EVIDENCE_STORE_PATH with a volume to hold files of any size.',
          413,
        );
      }
      const whole: Buffer[] = [];
      let held = 0;
      for await (const chunk of source) {
        held += chunk.length;
        if (held > REMOTE_SINGLE_PUT_BYTES) {
          throw new DomainError('EVIDENCE_REMOTE_TOO_LARGE', 'This file is larger than an object-store write can carry here', 413);
        }
        whole.push(chunk);
      }
      return this.store(tenantId, claimedHash, Buffer.concat(whole), contentType);
    }

    const target = this.#pathFor(tenantId, claimedHash);
    const existing = await stat(target).catch(() => undefined);
    if (existing) {
      /*
       * Already held — and still hashed before anything is answered.
       *
       * Returning success on the strength of the address alone would make the
       * platform accept *any* bytes under a hash it already holds. The reply
       * would say stored, the claim would be unverified, and the one guard
       * that makes a content-addressed chain worth having would be skipped
       * exactly where a caller is most likely to be confused about which file
       * they are sending. So the upload is read and hashed, nothing is
       * written, and a mismatch is refused as it would be on a first upload.
       *
       * The body is read either way rather than abandoned in the socket:
       * whatever the client sends next on that connection would otherwise be
       * parsed as a continuation of it.
       */
      const digest = createHash('sha256');
      for await (const chunk of source) digest.update(chunk);
      const actual = `sha256:${digest.digest('hex')}`;
      if (actual !== claimedHash) {
        throw new DomainError(
          'EVIDENCE_HASH_MISMATCH',
          `These bytes hash to ${actual}, not to the ${claimedHash} recorded as this evidence`,
          422,
        );
      }
      return {
        hash: claimedHash,
        // The length of the file, not of its ciphertext. An envelope adds a
        // header and a tag per frame, and reporting that back would tell a
        // caller their document had grown.
        bytes: await this.#plaintextSize(target, existing.size),
        contentType,
        storedAt: existing.mtime.toISOString(),
        alreadyHeld: true,
      };
    }

    await mkdir(dirname(target), { recursive: true });
    const temporary = this.#stagingName(target);
    const digest = createHash('sha256');
    let plaintextBytes = 0;

    // The plaintext, counted and hashed on its way past. Written as a
    // generator so the hashing happens inside the same single pass the
    // encryption does — two passes over a gigabyte is a gigabyte of reading
    // nobody needs.
    const self = this;
    async function* measured(): AsyncGenerator<Buffer> {
      for await (const chunk of source) {
        plaintextBytes += chunk.length;
        if (plaintextBytes > self.#maxBytes) {
          throw new DomainError('EVIDENCE_TOO_LARGE', self.#tooLarge(plaintextBytes), 413);
        }
        digest.update(chunk);
        yield chunk;
      }
    }

    const handle = await open(temporary, 'wx');
    try {
      for await (const frame of envelope.encryptFrames(tenantId, measured())) {
        await handle.write(frame);
      }
      await handle.close();

      if (plaintextBytes === 0) throw new DomainError('EVIDENCE_EMPTY', 'An empty file is not evidence');

      // The guard that makes the chain worth having, applied to a stream: a
      // client that could store arbitrary bytes under a hash the ledger
      // already trusts would poison the evidence chain at its root.
      const actual = `sha256:${digest.digest('hex')}`;
      if (actual !== claimedHash) {
        throw new DomainError(
          'EVIDENCE_HASH_MISMATCH',
          `These bytes hash to ${actual}, not to the ${claimedHash} recorded as this evidence`,
          422,
        );
      }

      await rename(temporary, target);
      await writeFile(`${target}.type`, contentType);
      const known = this.#usage.get(tenantId);
      if (known !== undefined) this.#usage.set(tenantId, known + plaintextBytes);
      return { hash: claimedHash, bytes: plaintextBytes, contentType, storedAt: new Date().toISOString() };
    } catch (error) {
      await handle.close().catch(() => undefined);
      // Nothing half-written is left behind under a name a reader could find,
      // and nothing is left on the volume to be swept later.
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  /** What a refusal over the ceiling says, in one place so both forms say it the same way. */
  #tooLarge(bytes: number): string {
    const mb = (value: number): string => `${(value / 1_048_576).toFixed(value > 1_048_576 * 100 ? 0 : 1)}MB`;
    return `That file is ${mb(bytes)} and this deployment's ceiling is ${mb(this.#maxBytes)}. Raise ` +
      'EVIDENCE_MAX_BYTES if the volume has room for it — the platform streams a file of any size, so the limit is ' +
      'the disk rather than this process.';
  }

  /**
   * Read a held file as a stream, optionally one range of it.
   *
   * `bytes` is the plaintext length, worked out from the file on the volume
   * rather than kept in a sidecar: a framed object is a header plus frames of a
   * known size, and GCM does not change a length, so the arithmetic is exact
   * and there is no second copy of the number to drift.
   *
   * **On verification.** The buffered `read` hashes the whole file before it
   * returns a byte, which a stream cannot do — the first frame is on its way
   * out before the last one is read. What takes its place is stronger for an
   * encrypted store and weaker for one without a key, and both are stated
   * rather than implied: every frame is authenticated against the tenancy, its
   * own position and the end of the file before it is yielded, so altered,
   * reordered or truncated bytes fail where they are rather than at the end.
   * Where no master key is configured there is nothing to authenticate, so the
   * plaintext hash is computed as the file streams and a mismatch throws after
   * the fact — which the gateway turns into a destroyed connection rather than
   * a file that looks complete.
   */
  async readStream(
    tenantId: string,
    hash: string,
    range?: { offset: number; length?: number },
  ): Promise<{ contentType: string; bytes: number; stream: AsyncGenerator<Buffer> }> {
    const remote = this.#remote;
    if (remote) {
      // An object store read is a single GET in this client. Buffered, as it
      // always was, and handed back in the streaming shape so one caller
      // serves both deployments.
      const file = await this.fetch(tenantId, hash);
      const slice = range
        ? file.bytes.subarray(range.offset, range.length === undefined ? undefined : range.offset + range.length)
        : file.bytes;
      async function* one(): AsyncGenerator<Buffer> {
        yield slice;
      }
      return { contentType: file.contentType, bytes: slice.length, stream: one() };
    }

    if (!this.configured) throw new DomainError('EVIDENCE_NOT_STORED', 'The platform holds no bytes for this evidence', 404);
    const target = this.#pathFor(tenantId, hash);
    const file = await stat(target).catch(() => undefined);
    if (!file) throw new DomainError('EVIDENCE_NOT_STORED', 'The platform holds no bytes for this evidence', 404);

    const contentType = await readFile(`${target}.type`, 'utf8').catch(() => 'application/octet-stream');
    const head = await this.#headOf(target);
    const framed = envelope.isFramed(head);
    const frameBytes = framed ? envelope.framedLayout(head).frameBytes : envelope.FRAME_BYTES;
    const total = framed
      ? plaintextBytesOf(file.size, frameBytes)
      : envelope.isEnvelope(head)
        ? file.size - ENVELOPE_V1_HEADER_BYTES
        : file.size;

    const offset = Math.min(Math.max(0, range?.offset ?? 0), total);
    const length = Math.max(0, Math.min(range?.length ?? total - offset, total - offset));

    // Only a framed file can be opened part way through. For the two older
    // shapes the whole file is read and sliced, which is what they always
    // required — they were written under the old ceiling and are small.
    if (!framed) {
      const whole = await this.read(tenantId, hash);
      const slice = whole.bytes.subarray(offset, offset + length);
      async function* one(): AsyncGenerator<Buffer> {
        yield slice;
      }
      return { contentType: whole.contentType, bytes: slice.length, stream: one() };
    }

    const position = envelope.framePosition(offset, frameBytes);
    const source = createReadStream(target, { start: position.byteOffset });
    // The layout and the starting frame, both told rather than re-detected:
    // the header is behind us, and each frame's position is part of what
    // authenticates it, so a reader that began at frame 7 has to count from 7.
    const layout = envelope.framedLayout(head);
    const encrypted = envelope.enabled();
    const expected = hash;

    async function* framesOut(): AsyncGenerator<Buffer> {
      const digest = createHash('sha256');
      let seen = 0;
      for await (const piece of envelope.decryptFrames(tenantId, source as AsyncIterable<Buffer>, {
        skipBytes: position.withinFrame,
        takeBytes: length,
        layout,
        startIndex: position.skipFrames,
      })) {
        if (!encrypted) digest.update(piece);
        seen += piece.length;
        yield piece;
      }
      // Whole-file reads on an unencrypted store are checked at the end: there
      // is no per-frame tag to trust, and a corrupted volume must not serve
      // something that is no longer the evidence anybody recorded.
      if (!encrypted && offset === 0 && seen === total && `sha256:${digest.digest('hex')}` !== expected) {
        throw new DomainError('EVIDENCE_CORRUPT', 'The stored bytes no longer match their hash', 500);
      }
    }

    return { contentType, bytes: length, stream: framesOut() };
  }

  /**
   * The plaintext length of a held file, without reading it.
   *
   * The register needs it to show a size, and a range response needs it to say
   * what the whole file is. Reading a gigabyte to learn it is a gigabyte is the
   * thing this exists to avoid.
   */
  async sizeOf(tenantId: string, hash: string): Promise<number | undefined> {
    const remote = this.#remote;
    if (remote) {
      const listed = await remote.list(this.#keyFor(tenantId, hash));
      return listed[0]?.size;
    }
    if (!this.configured) return undefined;
    const target = this.#pathFor(tenantId, hash);
    const file = await stat(target).catch(() => undefined);
    if (!file) return undefined;
    return this.#plaintextSize(target, file.size);
  }

  /**
   * The length of a stored file's contents, given the size on disk.
   *
   * An envelope is longer than what it holds — a header, and an IV and a tag
   * per frame — so the size of the file is not the size of the document. Every
   * answer that goes back to a caller reports the document's length.
   */
  async #plaintextSize(target: string, fileSize: number): Promise<number> {
    const head = await this.#headOf(target);
    if (envelope.isFramed(head)) return plaintextBytesOf(fileSize, envelope.framedLayout(head).frameBytes);
    return envelope.isEnvelope(head) ? fileSize - ENVELOPE_V1_HEADER_BYTES : fileSize;
  }

  /** The first bytes of a stored file, enough to tell which format it is. */
  async #headOf(target: string): Promise<Buffer> {
    const handle = await open(target, 'r');
    try {
      const head = Buffer.alloc(ENVELOPE_V1_HEADER_BYTES);
      const read = await handle.read(head, 0, head.length, 0);
      return head.subarray(0, read.bytesRead);
    } finally {
      await handle.close();
    }
  }

  /** `putChunk`, with the disk waited on rather than blocked on. */
  async writeChunk(
    tenantId: string,
    claimedHash: string,
    index: number,
    chunks: number,
    bytes: Buffer,
    contentType: string,
    options: { partHash?: string } = {},
  ): Promise<UploadProgress & { chunks: number; object?: StoredObject }> {
    const partHash = this.#checkedForChunk(index, chunks, bytes, options.partHash);

    const target = this.#pathFor(tenantId, claimedHash);
    const done = await stat(target).catch(() => undefined);
    if (done) {
      const bytes = await this.#plaintextSize(target, done.size);
      return {
        held: Array.from({ length: chunks }, (_, i) => i),
        chunks,
        complete: true,
        parts: [],
        heldBytes: bytes,
        missing: [],
        object: { hash: claimedHash, bytes, contentType, storedAt: done.mtime.toISOString() },
      };
    }

    const dir = this.#chunkDir(tenantId, claimedHash);
    await mkdir(dir, { recursive: true });
    const session = this.#openChunkSession(dir, index, chunks, contentType);
    const existing = await this.#heldChunksAsync(dir);
    let alreadyHave = 0;
    for (const i of existing) alreadyHave += (await stat(join(dir, String(i)))).size;
    if (!existing.includes(index) && alreadyHave + bytes.length > this.#maxBytes) {
      await rm(dir, { recursive: true, force: true });
      throw new DomainError('EVIDENCE_TOO_LARGE', `Evidence exceeds the ${Math.round(this.#maxBytes / 1_048_576)}MB limit`, 413);
    }

    const part = join(dir, String(index));
    if (!(await stat(part).catch(() => undefined))) await writeFile(part, envelope.encrypt(tenantId, bytes));
    // Recorded whether or not the part was newly written, so a part held from
    // before checksums existed gains one the next time its device retries.
    if (!this.#partMeta(dir, index)) this.#recordPart(dir, index, bytes.length, partHash);

    const held = await this.#heldChunksAsync(dir);
    if (held.length < chunks) {
      return {
        held,
        chunks,
        complete: false,
        ...this.#partsOf(dir, held),
        startedAt: session.startedAt,
        missing: Array.from({ length: chunks }, (_, i) => i).filter((i) => !held.includes(i)),
      };
    }

    /*
     * Assembled as a stream, not as one buffer.
     *
     * This read every part, concatenated them and handed the whole file to
     * `store` — so a resumable upload, which exists precisely so a device on a
     * bad link can send something large in pieces, reassembled the large thing
     * in memory at the end. Twenty parts of fifty megabytes is a gigabyte in
     * the heap of the one process that serves everybody, and the bigger the
     * file the more certain the failure.
     *
     * `putStream` takes the parts as they are read: one part held at a time,
     * each checked against the checksum recorded when it arrived, and the
     * whole-file hash computed as the pieces pass. Nothing is stored unless
     * that hash is the address the ledger already names.
     */
    let object: StoredObject;
    try {
      object = await this.putStream(tenantId, claimedHash, this.#partsInOrder(tenantId, dir, held), contentType);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    return { held, chunks, complete: true, parts: [], heldBytes: object.bytes, missing: [], object };
  }

  /**
   * Every part of a finished upload, in order, one at a time.
   *
   * Each part is checked against the checksum recorded when it arrived before
   * it is yielded — the same rule `#assemble` applies, applied as the bytes go
   * past rather than to a buffer holding all of them. A part that no longer
   * matches is dropped and named, so the device re-sends that part rather than
   * the file, and the write in progress is abandoned with nothing stored.
   */
  async *#partsInOrder(tenantId: string, dir: string, held: readonly number[]): AsyncGenerator<Buffer> {
    for (const index of held) {
      const bytes = envelope.decrypt(tenantId, await readFile(join(dir, String(index))));
      const meta = this.#partMeta(dir, index);
      if (meta && hashBytes(bytes) !== meta.hash) {
        await rm(join(dir, String(index)), { force: true });
        await rm(join(dir, `${index}.meta`), { force: true });
        throw new DomainError(
          'EVIDENCE_PART_CORRUPT',
          `Part ${index} of this upload no longer matches the checksum recorded when it arrived, and has been ` +
            'dropped. Send that part again; the rest of the upload is still held.',
          422,
        );
      }
      yield bytes;
    }
  }

  async #heldChunksAsync(dir: string): Promise<number[]> {
    const names = await readdir(dir).catch(() => [] as string[]);
    return names
      .map((name) => Number(name))
      .filter((index) => Number.isInteger(index) && index >= 0)
      .sort((a, b) => a - b);
  }

  // --- resumable upload -----------------------------------------------------
  //
  // A photograph taken at the bottom of a shaft is uploaded over whatever
  // signal the gate has, and the specification's own budget is 20 photographs
  // in a batch, resumable on drop. `put` takes the whole file: a connection
  // that dies at 90% starts again at nothing, and on a bad enough link it never
  // finishes at all — the record exists, the evidence never arrives, and the
  // hash on the chain points at a file nobody holds.
  //
  // **The content hash is the upload id.** The device already knows it — it
  // hashed the file to make the evidence record — so there is no handshake to
  // lose, no upload token to expire, and a device that reboots mid-upload
  // resumes by asking what is held under a hash it still has.
  //
  // Chunks live beside the object rather than in it, and the object appears only
  // when every chunk is present and the assembled bytes hash to the address they
  // were sent to. Until then there is nothing for a reader to find, which is the
  // same discipline as the write-and-rename in `put`.

  /** Where the parts of an unfinished upload are kept. */
  #chunkDir(tenantId: string, hash: string): string {
    return `${this.#fanout(this.#stagingRoot, tenantId, hash)}.chunks`;
  }

  /**
   * Store one part. Returns what is held, and the object once the last part
   * completes it.
   *
   * Idempotent per chunk: re-sending one already held is a no-op, which is what
   * a device retrying an ambiguous request needs.
   */
  putChunk(
    tenantId: string,
    claimedHash: string,
    index: number,
    chunks: number,
    bytes: Buffer,
    contentType: string,
    options: { partHash?: string } = {},
  ): UploadProgress & { chunks: number; object?: StoredObject } {
    const partHash = this.#checkedForChunk(index, chunks, bytes, options.partHash);

    const target = this.#pathFor(tenantId, claimedHash);
    // Already complete. A device that missed the answer to its last part gets
    // the object rather than a refusal, which is the resumable case working.
    if (existsSync(target)) {
      const stat = statSync(target);
      return {
        held: Array.from({ length: chunks }, (_, i) => i),
        chunks,
        complete: true,
        parts: [],
        heldBytes: stat.size,
        missing: [],
        object: { hash: claimedHash, bytes: stat.size, contentType, storedAt: stat.mtime.toISOString() },
      };
    }

    const dir = this.#chunkDir(tenantId, claimedHash);
    mkdirSync(dir, { recursive: true });
    // The shape is fixed by the first part, so a device that resumes with a
    // different chunk size is refused here rather than after the last part.
    const session = this.#openChunkSession(dir, index, chunks, contentType);

    // The running total is checked as parts arrive, not only at the end: a
    // device that would exceed the limit is told at the part that crosses it,
    // rather than after uploading everything.
    const existing = this.#heldChunks(dir);
    const alreadyHave = existing.reduce((total, i) => total + statSync(join(dir, String(i))).size, 0);
    if (!existing.includes(index) && alreadyHave + bytes.length > this.#maxBytes) {
      rmSync(dir, { recursive: true, force: true });
      throw new DomainError(
        'EVIDENCE_TOO_LARGE',
        `Evidence exceeds the ${Math.round(this.#maxBytes / 1_048_576)}MB limit`,
        413,
      );
    }

    // Encrypted per part with the same envelope the whole object uses, so an
    // interrupted upload does not leave plaintext site photography on the
    // volume for however long it takes the device to come back.
    const part = join(dir, String(index));
    if (!existsSync(part)) writeFileSync(part, envelope.encrypt(tenantId, bytes));
    // Recorded whether or not the part was newly written, so a part held from
    // before checksums existed gains one the next time its device retries.
    if (!this.#partMeta(dir, index)) this.#recordPart(dir, index, bytes.length, partHash);

    const held = this.#heldChunks(dir);
    if (held.length < chunks) {
      return {
        held,
        chunks,
        complete: false,
        ...this.#partsOf(dir, held),
        startedAt: session.startedAt,
        missing: Array.from({ length: chunks }, (_, i) => i).filter((i) => !held.includes(i)),
      };
    }

    // Every part is in. Each is checked against the checksum recorded when it
    // arrived — a part that failed in storage is dropped alone and named, so
    // the device re-sends one chunk rather than the file — and the assembled
    // bytes then go to `put`, which re-checks the whole hash. The parts were
    // never trusted; only the assembled bytes are, and that is the guard that
    // makes the chain worth having.
    const assembled = this.#assemble(
      dir,
      held,
      held.map((i) => envelope.decrypt(tenantId, readFileSync(join(dir, String(i))))),
    );
    let object: StoredObject;
    try {
      object = this.put(tenantId, claimedHash, assembled, contentType);
    } finally {
      // Removed either way. A set of parts that each match their own checksum
      // but do not assemble into the claimed file is not a partial upload to
      // resume; it is one to start again.
      rmSync(dir, { recursive: true, force: true });
    }
    return { held, chunks, complete: true, parts: [], heldBytes: object.bytes, missing: [], object };
  }

  /**
   * What is held for an unfinished upload, so a device knows where to resume.
   *
   * Answers for a completed object too: `complete: true` and nothing left to
   * send, which is the answer a device that lost the last response needs.
   */
  uploadState(tenantId: string, hash: string): UploadProgress {
    if (!this.configured) return { held: [], complete: false, parts: [], heldBytes: 0 };
    const target = this.#pathFor(tenantId, hash);
    if (existsSync(target)) {
      return { held: [], complete: true, parts: [], heldBytes: statSync(target).size, missing: [] };
    }
    const dir = this.#chunkDir(tenantId, hash);
    if (!existsSync(dir)) return { held: [], complete: false, parts: [], heldBytes: 0 };

    const held = this.#heldChunks(dir);
    const session = this.#chunkSession(dir);
    return {
      held,
      complete: false,
      ...this.#partsOf(dir, held),
      // A device resuming needs the part count it began with and the parts still
      // to send. Both are absent where the upload predates the session file
      // rather than guessed at from the parts present, which would report a
      // three-part upload as complete after its first three parts arrived.
      ...(session ? { chunks: session.chunks, startedAt: session.startedAt } : {}),
      ...(session
        ? { missing: Array.from({ length: session.chunks }, (_, i) => i).filter((i) => !held.includes(i)) }
        : {}),
    };
  }

  /**
   * Give up on an unfinished upload and take its parts off the volume.
   *
   * The one honest answer to `EVIDENCE_CHUNK_COUNT_CHANGED`: a device that has
   * re-split the file cannot continue the upload it began, and without this its
   * parts would sit on the volume until a sweep found them while every retry was
   * refused. Removes nothing but parts — a completed object is evidence, and
   * evidence is removed through the registry's orphan check or not at all.
   */
  abandonUpload(tenantId: string, hash: string): { abandoned: boolean; parts: number; bytes: number } {
    if (!this.configured) return { abandoned: false, parts: 0, bytes: 0 };
    const dir = this.#chunkDir(tenantId, hash);
    if (!existsSync(dir)) return { abandoned: false, parts: 0, bytes: 0 };
    const held = this.#heldChunks(dir);
    const { heldBytes } = this.#partsOf(dir, held);
    rmSync(dir, { recursive: true, force: true });
    return { abandoned: true, parts: held.length, bytes: heldBytes };
  }

  /**
   * Uploads this tenancy began and never finished.
   *
   * Invisible to `list` and to the meter, because parts are directories rather
   * than objects — which is correct for both (a part is not evidence and nobody
   * should be billed for one) and leaves a phone that lost signal at part four
   * of nine holding a claim on the volume that nothing reports. This is what
   * reports it.
   */
  unfinishedUploads(tenantId: string): UnfinishedUpload[] {
    const staging = this.#stagingRoot;
    if (staging === '') return [];
    if (!/^[0-9A-Za-z_-]{1,64}$/.test(tenantId)) {
      throw new DomainError('EVIDENCE_TENANT_INVALID', 'Not a tenant identifier');
    }
    const root = join(staging, tenantId);
    if (!existsSync(root)) return [];

    const found: UnfinishedUpload[] = [];
    for (const first of readdirSync(root, { withFileTypes: true })) {
      if (!first.isDirectory()) continue;
      for (const second of readdirSync(join(root, first.name), { withFileTypes: true })) {
        if (!second.isDirectory()) continue;
        const level = join(root, first.name, second.name);
        for (const entry of readdirSync(level, { withFileTypes: true })) {
          if (!entry.isDirectory() || !entry.name.endsWith('.chunks')) continue;
          const digest = entry.name.slice(0, -'.chunks'.length);
          if (!/^[0-9a-f]{64}$/.test(digest)) continue;
          const dir = join(level, entry.name);
          const held = this.#heldChunks(dir);
          const session = this.#chunkSession(dir);
          found.push({
            hash: `sha256:${digest}`,
            parts: held.length,
            ...(session ? { chunks: session.chunks } : {}),
            bytes: this.#partsOf(dir, held).heldBytes,
            // The directory's own timestamp where no session was recorded: an
            // upload begun before sessions existed still has an age, and a
            // sweep that could not date it could never remove it.
            startedAt: session?.startedAt ?? statSync(dir).mtime.toISOString(),
          });
        }
      }
    }
    return found.sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
  }

  /**
   * Remove the parts of uploads nobody came back for.
   *
   * A device that is switched off part-way through an upload never returns to
   * finish it, and its parts are not reachable through any register, not counted
   * against the tenancy and not removable through the orphan path — so without
   * this they stay on the volume for the life of the deployment. The window is
   * generous on purpose: a phone can be off site for a week and still be the
   * only copy of the photographs, and re-sending three hundred megabytes because
   * a sweep was impatient is the failure this whole feature exists to prevent.
   */
  sweepUploads(
    olderThanMs: number,
    now = Date.now(),
  ): { removed: Array<UnfinishedUpload & { tenantId: string }>; bytes: number } {
    const staging = this.#stagingRoot;
    if (staging === '' || !existsSync(staging)) return { removed: [], bytes: 0 };
    const removed: Array<UnfinishedUpload & { tenantId: string }> = [];
    for (const entry of readdirSync(staging, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!/^[0-9A-Za-z_-]{1,64}$/.test(entry.name)) continue;
      for (const upload of this.unfinishedUploads(entry.name)) {
        if (now - Date.parse(upload.startedAt) < olderThanMs) continue;
        this.abandonUpload(entry.name, upload.hash);
        // The tenancy is on the row because an operator reading "twelve
        // abandoned uploads removed" needs to know whose photographs those
        // were before deciding whether the window is right.
        removed.push({ ...upload, tenantId: entry.name });
      }
    }
    return { removed, bytes: removed.reduce((total, upload) => total + upload.bytes, 0) };
  }

  /** Part indices present, in order. */
  #heldChunks(dir: string): number[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .map((name) => Number(name))
      .filter((index) => Number.isInteger(index) && index >= 0)
      .sort((a, b) => a - b);
  }

  has(tenantId: string, hash: string): boolean {
    return this.configured && HASH.test(hash) && existsSync(this.#pathFor(tenantId, hash));
  }

  /**
   * The media type of a held object, without reading the object.
   *
   * The register needs it to say which files can be read by a perception task,
   * and reading a 40MB drawing to learn it is a PDF would make listing a
   * project's evidence proportional to the size of everything in it.
   */
  contentTypeOf(tenantId: string, hash: string): string | undefined {
    if (!this.has(tenantId, hash)) return undefined;
    const typeFile = `${this.#pathFor(tenantId, hash)}.type`;
    return existsSync(typeFile) ? readFileSync(typeFile, 'utf8') : 'application/octet-stream';
  }

  get(tenantId: string, hash: string): { bytes: Buffer; contentType: string } {
    if (!this.configured) {
      throw new DomainError('EVIDENCE_NOT_STORED', 'The platform holds no bytes for this evidence', 404);
    }
    const target = this.#pathFor(tenantId, hash);
    if (!existsSync(target)) {
      throw new DomainError('EVIDENCE_NOT_STORED', 'The platform holds no bytes for this evidence', 404);
    }
    this.#assertBufferable(statSync(target).size);
    // Decrypted on the way back, and a file written before the key existed
    // passes through untouched — which is what makes turning encryption on a
    // non-event rather than a migration.
    const bytes = envelope.decrypt(tenantId, readFileSync(target));

    // Re-verify on read. Cheap insurance against a corrupted volume serving
    // something that is no longer the evidence anybody recorded — and the whole
    // point of the record is that it can be trusted years later.
    if (hashBytes(bytes) !== hash) {
      throw new DomainError('EVIDENCE_CORRUPT', 'The stored bytes no longer match their hash', 500);
    }

    const typeFile = `${target}.type`;
    return {
      bytes,
      contentType: existsSync(typeFile) ? readFileSync(typeFile, 'utf8') : 'application/octet-stream',
    };
  }

  // --- metering -------------------------------------------------------------

  /**
   * Bytes held for one tenancy.
   *
   * Cached, because this is asked on the path of every upload and the honest
   * answer costs a directory walk. The cache is populated lazily on first ask
   * and maintained by `put` and `discard`, which are the only two things that
   * change the answer — so it rebuilds itself naturally after a restart rather
   * than needing to be persisted, and there is no second copy of the number to
   * drift from the volume.
   */
  usage(tenantId: string): number {
    const cached = this.#usage.get(tenantId);
    if (cached !== undefined) return cached;

    const total = this.list(tenantId).reduce((sum, object) => sum + object.bytes, 0);
    this.#usage.set(tenantId, total);
    return total;
  }

  // --- retention ------------------------------------------------------------

  /**
   * Everything this tenancy's store holds.
   *
   * Walking the fan-out directories rather than reading the ledger, because the
   * question retention asks is the opposite one: not "what does the record say
   * exists" but "what is actually on the volume". The two disagreeing is the
   * finding.
   */
  list(tenantId: string): Array<{ hash: string; bytes: number; storedAt: string; partial: boolean }> {
    if (!this.configured) return [];
    if (!/^[0-9A-Za-z_-]{1,64}$/.test(tenantId)) {
      throw new DomainError('EVIDENCE_TENANT_INVALID', 'Not a tenant identifier');
    }
    const root = join(this.#root, tenantId);
    if (!existsSync(root)) return [];

    const found: Array<{ hash: string; bytes: number; storedAt: string; partial: boolean }> = [];
    for (const first of readdirSync(root, { withFileTypes: true })) {
      if (!first.isDirectory()) continue;
      for (const second of readdirSync(join(root, first.name), { withFileTypes: true })) {
        if (!second.isDirectory()) continue;
        const dir = join(root, first.name, second.name);
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isFile()) continue;
          // `.type` sidecars are metadata for an object, not objects.
          if (entry.name.endsWith('.type')) continue;
          const partial = entry.name.endsWith('.partial');
          const digest = partial ? entry.name.slice(0, -'.partial'.length) : entry.name;
          if (!/^[0-9a-f]{64}$/.test(digest)) continue;
          const stat = statSync(join(dir, entry.name));
          found.push({
            hash: `sha256:${digest}`,
            bytes: stat.size,
            storedAt: stat.mtime.toISOString(),
            partial,
          });
        }
      }
    }
    return found.sort((a, b) => (a.storedAt < b.storedAt ? -1 : 1));
  }

  /**
   * Remove an object.
   *
   * Deliberately unconditional here and deliberately never called that way: the
   * caller in `registry.ts` refuses anything the ledger names, and that refusal
   * is where the policy lives. Putting the ledger check inside the store would
   * make the store depend on the ledger to delete a file, which is the wrong
   * shape — the store holds bytes and knows nothing about what they prove.
   */
  discard(tenantId: string, hash: string): boolean {
    if (!this.configured) return false;
    const target = this.#pathFor(tenantId, hash);
    // Measured before the unlink, because afterwards there is nothing to stat.
    const freed = existsSync(target) ? statSync(target).size : 0;
    let removed = false;
    for (const path of [target, `${target}.type`, `${target}.partial`]) {
      if (existsSync(path)) {
        rmSync(path);
        removed = removed || path === target || path === `${target}.partial`;
      }
    }
    // Give the bytes back to the meter, but only where it has already been
    // populated: an untouched cache must stay untouched, or the next read
    // returns a total that was never measured.
    if (removed) {
      const known = this.#usage.get(tenantId);
      if (known !== undefined) this.#usage.set(tenantId, Math.max(0, known - freed));
    }
    return removed;
  }

  // --- signed links ---------------------------------------------------------

  /** A link that expires and is useless outside the tenancy it was minted for. */
  signedUrl(tenantId: string, hash: string, ttlSeconds = this.#linkTtlSeconds): { url: string; expiresAt: string } {
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    const signature = this.#sign(tenantId, hash, expires);
    // The tenancy is in the link because the holder of the link has no session
    // to read it from — that is the entire point of a signed link. It is not a
    // secret: a tenant id already appears in the console's own URLs, and
    // knowing it grants nothing without a signature that covers it.
    const query = `tenant=${encodeURIComponent(tenantId)}&expires=${expires}&signature=${signature}`;
    return {
      url: `/v1/evidence/${encodeURIComponent(hash)}?${query}`,
      expiresAt: new Date(expires * 1000).toISOString(),
    };
  }

  #sign(tenantId: string, hash: string, expires: number): string {
    return signFor('evidence-link', `${tenantId}\n${hash}\n${expires}`, 'hex', this.#secret).signature;
  }

  /**
   * Whether a link is currently good for this tenant and this object.
   *
   * Expiry is checked first and separately, so an expired link is refused
   * without a signature comparison at all — there is nothing to learn from
   * timing a request that was never going to be served.
   */
  verifySignedUrl(tenantId: string, hash: string, expires: number, signature: string): boolean {
    if (!Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000)) return false;
    if (typeof signature !== 'string' || !/^[0-9a-f]+$/i.test(signature)) return false;
    return verifyFor('evidence-link', `${tenantId}\n${hash}\n${expires}`, signature.toLowerCase(), 'hex', this.#secret !== undefined ? { secret: this.#secret } : {}).valid;
  }
}
