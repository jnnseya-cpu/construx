import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { rejectsCode } from './helpers.ts';
import { EvidenceStore, hashBytes } from '../src/evidence/store.ts';

/**
 * The evidence store off the event loop.
 *
 * `put`, `get` and `putChunk` read and wrote the volume synchronously and
 * held the one process that serves everybody for the whole of a fifty-
 * megabyte transfer. `write`, `read` and `writeChunk` are the same three
 * through `fs/promises`: what is asserted is that they make the same
 * decisions — the same refusals, the same idempotence, the same objects at
 * the same addresses — so a file stored by one form is read by the other.
 */

const root = mkdtempSync(join(tmpdir(), 'construx-evidence-async-'));
after(() => rmSync(root, { recursive: true, force: true }));

const store = () => new EvidenceStore(root, { maxBytes: 1_048_576, secret: 'a-test-secret' });
const bytesOf = (text: string) => Buffer.from(text, 'utf8');

describe('write and read', () => {
  it('store the bytes under their hash and read them back re-verified', async () => {
    const s = store();
    const bytes = bytesOf('a site diary entry, photographed');
    const hash = hashBytes(bytes);
    const stored = await s.write('tenant-a', hash, bytes, 'text/plain');
    assert.equal(stored.hash, hash);
    assert.equal(stored.bytes, bytes.length);
    const read = await s.read('tenant-a', hash);
    assert.deepEqual(read.bytes, bytes);
    assert.equal(read.contentType, 'text/plain');
    // The synchronous form finds exactly the same object.
    assert.deepEqual(s.get('tenant-a', hash).bytes, bytes);
    assert.equal(s.has('tenant-a', hash), true);
    assert.equal(await s.holds('tenant-a', hash), true);
  });

  it('make the same refusals as the synchronous forms', async () => {
    const s = store();
    const bytes = bytesOf('a specification page');
    await rejectsCode(() => s.write('tenant-a', hashBytes(bytes), bytesOf('different bytes'), 'text/plain'), 'EVIDENCE_HASH_MISMATCH');
    await rejectsCode(() => s.write('tenant-a', hashBytes(Buffer.alloc(0)), Buffer.alloc(0), 'text/plain'), 'EVIDENCE_EMPTY');
    const big = Buffer.alloc(1_048_577, 1);
    await rejectsCode(() => s.write('tenant-a', hashBytes(big), big, 'application/octet-stream'), 'EVIDENCE_TOO_LARGE');
    await rejectsCode(() => s.write('../../root', hashBytes(bytes), bytes, 'text/plain'), 'EVIDENCE_TENANT_INVALID');
    await rejectsCode(() => s.read('tenant-a', 'sha256:not-a-hash'), 'EVIDENCE_HASH_INVALID');
    await rejectsCode(() => s.read('tenant-a', hashBytes(bytes)), 'EVIDENCE_NOT_STORED');
    const unconfigured = new EvidenceStore('', { secret: 'x' });
    await rejectsCode(() => unconfigured.write('tenant-a', hashBytes(bytes), bytes, 'text/plain'), 'EVIDENCE_STORE_UNCONFIGURED');
    await rejectsCode(() => unconfigured.read('tenant-a', hashBytes(bytes)), 'EVIDENCE_NOT_STORED');
  });

  it('are idempotent, keep tenancies apart, and refuse a file that no longer hashes', async () => {
    const s = store();
    const bytes = bytesOf('an inspection photograph');
    const hash = hashBytes(bytes);
    const first = await s.write('tenant-a', hash, bytes, 'image/jpeg');
    const second = await s.write('tenant-a', hash, bytes, 'image/jpeg');
    assert.equal(second.bytes, first.bytes);
    // A second write is the first object: it answers with the file's own
    // time, exactly as the synchronous form does for the same object.
    assert.equal(second.storedAt, s.put('tenant-a', hash, bytes, 'image/jpeg').storedAt);
    await rejectsCode(() => s.read('tenant-b', hash), 'EVIDENCE_NOT_STORED');
    assert.equal(s.usage('tenant-a') > 0, true);

    // Corrupt the object on the volume; the read refuses rather than serving it.
    const digest = hash.slice('sha256:'.length);
    writeFileSync(join(root, 'tenant-a', digest.slice(0, 2), digest.slice(2, 4), digest), bytesOf('tampered'));
    await rejectsCode(() => s.read('tenant-a', hash), 'EVIDENCE_CORRUPT');
  });
});

describe('writeChunk', () => {
  const whole = Buffer.concat([Buffer.alloc(400, 1), Buffer.alloc(400, 2), Buffer.alloc(300, 3)]);
  const parts = [whole.subarray(0, 400), whole.subarray(400, 800), whole.subarray(800)];

  it('assembles the parts into the object in any order, resumably', async () => {
    const s = store();
    const address = hashBytes(whole);
    assert.equal((await s.writeChunk('t', address, 2, 3, parts[2]!, 'image/jpeg')).complete, false);
    assert.equal((await s.writeChunk('t', address, 0, 3, parts[0]!, 'image/jpeg')).complete, false);
    assert.deepEqual(s.uploadState('t', address).held, [0, 2], 'the synchronous state sees the same parts');
    const done = await s.writeChunk('t', address, 1, 3, parts[1]!, 'image/jpeg');
    assert.equal(done.complete, true);
    assert.equal(done.object?.bytes, whole.length);
    assert.deepEqual((await s.read('t', address)).bytes, whole);
    // A part re-sent after completion is answered with the object, not a refusal.
    const again = await s.writeChunk('t', address, 1, 3, parts[1]!, 'image/jpeg');
    assert.equal(again.complete, true);
    assert.deepEqual(again.held, [0, 1, 2]);
  });

  it('refuses parts that do not assemble to the address, and starts again', async () => {
    const s = store();
    const address = hashBytes(whole);
    await s.writeChunk('t2', address, 0, 2, parts[0]!, 'image/jpeg');
    await rejectsCode(() => s.writeChunk('t2', address, 1, 2, bytesOf('not the rest of that photograph'), 'image/jpeg'), 'EVIDENCE_HASH_MISMATCH');
    assert.deepEqual(s.uploadState('t2', address).held, [], 'the parts are gone; there is nothing to resume');
    await rejectsCode(() => s.writeChunk('t2', address, 3, 3, parts[0]!, 'image/jpeg'), 'EVIDENCE_CHUNK_INDEX_INVALID');
    await rejectsCode(() => s.writeChunk('t2', address, 0, 0, parts[0]!, 'image/jpeg'), 'EVIDENCE_CHUNK_COUNT_INVALID');
    await rejectsCode(() => s.writeChunk('t2', address, 0, 2, Buffer.alloc(0), 'image/jpeg'), 'EVIDENCE_EMPTY');
  });

  it('stops an upload that would cross the ceiling at the part that crosses it', async () => {
    const s = new EvidenceStore(root, { maxBytes: 1_000, secret: 'x' });
    const large = Buffer.alloc(1_200, 7);
    const address = hashBytes(large);
    await s.writeChunk('t3', address, 0, 2, large.subarray(0, 600), 'application/octet-stream');
    await rejectsCode(() => s.writeChunk('t3', address, 1, 2, large.subarray(600), 'application/octet-stream'), 'EVIDENCE_TOO_LARGE');
    assert.deepEqual(s.uploadState('t3', address).held, []);
  });
});
