import { createHmac, createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DomainError } from '../core/errors.ts';
import { config } from '../config.ts';

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
  readonly #maxBytes: number;
  readonly #linkTtlSeconds: number;
  readonly #secret: string;

  constructor(
    root: string = config.evidence.storePath,
    options: { maxBytes?: number; linkTtlSeconds?: number; secret?: string } = {},
  ) {
    this.#root = root;
    this.#maxBytes = options.maxBytes ?? config.evidence.maxBytes;
    this.#linkTtlSeconds = options.linkTtlSeconds ?? config.evidence.linkTtlSeconds;
    // The gateway's own secret rather than a second one: another secret is
    // another thing to rotate, and the blast radius of either leaking is
    // already the same.
    this.#secret = options.secret ?? config.auth.jwtSecret;
  }

  /** Whether a store is configured at all. Empty root means hashes without files. */
  get configured(): boolean {
    return this.#root !== '';
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
      throw new DomainError('EVIDENCE_STORE_UNCONFIGURED', 'No object store is configured', 503);
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
    writeFileSync(temporary, bytes);
    renameSync(temporary, target);
    // The content type is metadata, not content, and it is deliberately not
    // part of the address: the same bytes are the same object however they were
    // labelled on the way in.
    writeFileSync(`${target}.type`, contentType);

    return {
      hash: claimedHash,
      bytes: bytes.length,
      contentType,
      storedAt: new Date().toISOString(),
    };
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
    const bytes = readFileSync(target);

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
    let removed = false;
    for (const path of [target, `${target}.type`, `${target}.partial`]) {
      if (existsSync(path)) {
        rmSync(path);
        removed = removed || path === target || path === `${target}.partial`;
      }
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
