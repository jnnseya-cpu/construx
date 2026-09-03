import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DomainError } from '../core/errors.ts';
import { config } from '../config.ts';
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
  readonly #secret: string;
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
    // another thing to rotate, and the blast radius of either leaking is
    // already the same.
    this.#secret = options.secret ?? config.auth.jwtSecret;
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
    if (!remote) return this.get(tenantId, hash);

    const held = await remote.get(this.#keyFor(tenantId, hash));
    if (!held) {
      throw new DomainError('EVIDENCE_NOT_STORED', 'The platform holds no bytes for this evidence', 404);
    }
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
    if (!remote) return this.put(tenantId, claimedHash, bytes, contentType);

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
    if (!HASH.test(hash)) throw new DomainError('EVIDENCE_HASH_INVALID', 'Not a sha256 content hash');
    if (!/^[0-9A-Za-z_-]{1,64}$/.test(tenantId)) {
      throw new DomainError('EVIDENCE_TENANT_INVALID', 'Not a tenant identifier');
    }
    const digest = hash.slice('sha256:'.length);
    // Two levels of fan-out. A single directory holding a million objects is
    // slow to list and, on some filesystems, slow to open.
    return join(this.#root, tenantId, digest.slice(0, 2), digest.slice(2, 4), digest);
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
    return `${this.#pathFor(tenantId, hash)}.chunks`;
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
  ): { held: number[]; chunks: number; complete: boolean; object?: StoredObject } {
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

    const target = this.#pathFor(tenantId, claimedHash);
    // Already complete. A device that missed the answer to its last part gets
    // the object rather than a refusal, which is the resumable case working.
    if (existsSync(target)) {
      const stat = statSync(target);
      return {
        held: Array.from({ length: chunks }, (_, i) => i),
        chunks,
        complete: true,
        object: { hash: claimedHash, bytes: stat.size, contentType, storedAt: stat.mtime.toISOString() },
      };
    }

    const dir = this.#chunkDir(tenantId, claimedHash);
    mkdirSync(dir, { recursive: true });

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

    const held = this.#heldChunks(dir);
    if (held.length < chunks) return { held, chunks, complete: false };

    // Every part is in. Assemble in index order and hand the whole thing to
    // `put`, which re-checks the hash — the parts were never trusted, only the
    // assembled bytes are, and that is the guard that makes the chain worth
    // having.
    const assembled = Buffer.concat(held.map((i) => envelope.decrypt(tenantId, readFileSync(join(dir, String(i))))));
    let object: StoredObject;
    try {
      object = this.put(tenantId, claimedHash, assembled, contentType);
    } finally {
      // Removed either way. A set of parts that does not hash to its address is
      // not a partial upload to resume; it is one to start again.
      rmSync(dir, { recursive: true, force: true });
    }
    return { held, chunks, complete: true, object };
  }

  /**
   * What is held for an unfinished upload, so a device knows where to resume.
   *
   * Answers for a completed object too: `complete: true` and nothing left to
   * send, which is the answer a device that lost the last response needs.
   */
  uploadState(tenantId: string, hash: string): { held: number[]; complete: boolean } {
    if (!this.configured) return { held: [], complete: false };
    if (existsSync(this.#pathFor(tenantId, hash))) return { held: [], complete: true };
    const dir = this.#chunkDir(tenantId, hash);
    return { held: existsSync(dir) ? this.#heldChunks(dir) : [], complete: false };
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
    return createHmac('sha256', this.#secret).update(`${tenantId}\n${hash}\n${expires}`).digest('hex');
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

    const expected = Buffer.from(this.#sign(tenantId, hash, expires), 'hex');
    let given: Buffer;
    try {
      given = Buffer.from(signature, 'hex');
    } catch {
      return false;
    }
    // Length must match before timingSafeEqual, which throws on a mismatch —
    // and the throw would itself be a timing signal.
    if (given.length !== expected.length) return false;
    return timingSafeEqual(expected, given);
  }
}
