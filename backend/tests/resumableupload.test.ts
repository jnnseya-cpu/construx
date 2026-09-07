import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { rejectsCode, throwsCode } from './helpers.ts';
import { createGateway } from '../src/api/gateway.ts';
import { EvidenceStore, hashBytes } from '../src/evidence/store.ts';
import { retentionPosition } from '../src/evidence/registry.ts';
import { sweepHygiene } from '../src/ops/hygiene.ts';
import { issueTokens } from '../src/identity/auth.ts';
import { Platform } from '../src/platform.ts';
import { seedDemoProject, type SeedResult } from '../src/seed.ts';

/**
 * Resumable upload with checksummed parts — §15.2.
 *
 * The platform could already take a file in parts. What it could not do was
 * notice that one of them had not survived the connection: a part was written,
 * its bytes were never checked against anything, and the first thing that
 * noticed was the whole-file hash after the last part arrived — at which point
 * every part was discarded. So a phone at a site gate uploaded three hundred
 * megabytes of video, lost it to one bad chunk, uploaded it again, and lost it
 * again the same way. The gap table's words for this were "a dropped connection
 * loses a whole video, repeatedly", and that is the failure these tests are
 * about.
 *
 * Three things close it, and each is asserted on the property that matters
 * rather than on the happy path.
 *
 * **A part carries its own checksum.** Refused at the part, and — this is the
 * whole point — *only* that part. A refusal that took the rest of the upload
 * with it would be the same failure with a better error message.
 *
 * **The chunking is fixed by the first part.** A device that reboots and
 * resumes with a different chunk size would otherwise interleave two splits of
 * the same file, and the only symptom would be a whole-file hash failure that
 * threw everything away for a reason nobody could see.
 *
 * **A part that fails on the volume is dropped alone and named.** The device is
 * told which part to send again. That is the difference between re-sending four
 * megabytes and re-sending the file.
 *
 * The store is driven directly for the properties, and through the gateway for
 * the parts of the feature that are the route: a query parameter nobody reads
 * is not a checksum, and an upload nobody can abandon is not resumable.
 */

const root = mkdtempSync(join(tmpdir(), 'construx-resumable-'));
/**
 * A second volume for the sweep, which walks a whole root rather than one
 * tenancy. Sharing the first would make every other test in this file a hidden
 * input to it — and a sweep test whose result depends on what ran before it
 * proves nothing about the sweep.
 */
const sweepRoot = mkdtempSync(join(tmpdir(), 'construx-resumable-sweep-'));
after(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(sweepRoot, { recursive: true, force: true });
});

const store = (): EvidenceStore => new EvidenceStore(root, { maxBytes: 1_048_576, secret: 'a-test-secret' });

/** A file big enough to be worth splitting, and three parts of it. */
const whole = Buffer.concat([Buffer.alloc(400, 1), Buffer.alloc(400, 2), Buffer.alloc(300, 3)]);
const parts = [whole.subarray(0, 400), whole.subarray(400, 800), whole.subarray(800)];
const address = hashBytes(whole);

/** Where the parts of an unfinished upload live, so a test can damage one. */
function chunkDirIn(volume: string, hash: string, tenantId: string): string {
  const digest = hash.slice('sha256:'.length);
  return join(volume, tenantId, digest.slice(0, 2), digest.slice(2, 4), `${digest}.chunks`);
}
const chunkDir = (hash: string, tenantId: string): string => chunkDirIn(root, hash, tenantId);
const sweepChunkDir = (hash: string, tenantId: string): string => chunkDirIn(sweepRoot, hash, tenantId);

describe('a part that carries its own checksum', () => {
  it('is accepted when the checksum matches what arrived', () => {
    const s = store();
    const state = s.putChunk('c1', address, 0, 3, parts[0]!, 'image/jpeg', { partHash: hashBytes(parts[0]!) });
    assert.equal(state.complete, false);
    assert.deepEqual(state.held, [0]);
    assert.deepEqual(state.missing, [1, 2]);
    assert.equal(state.heldBytes, parts[0]!.length);
    assert.deepEqual(
      state.parts,
      [{ index: 0, bytes: parts[0]!.length, hash: hashBytes(parts[0]!) }],
      'the platform reports what it measured the part to be, not what the device said',
    );
  });

  it('is refused when it does not, and every other part of the upload survives', () => {
    const s = store();
    s.putChunk('c2', address, 0, 3, parts[0]!, 'image/jpeg', { partHash: hashBytes(parts[0]!) });
    s.putChunk('c2', address, 2, 3, parts[2]!, 'image/jpeg', { partHash: hashBytes(parts[2]!) });

    // Part 1, truncated on the way — which is what a dropped connection
    // actually looks like from here.
    throwsCode(
      () => s.putChunk('c2', address, 1, 3, parts[1]!.subarray(0, 200), 'image/jpeg', { partHash: hashBytes(parts[1]!) }),
      'EVIDENCE_PART_HASH_MISMATCH',
    );

    // The assertion the whole feature turns on. Before this, nothing noticed
    // until the end and then discarded all three.
    const after = s.uploadState('c2', address);
    assert.deepEqual(after.held, [0, 2], 'the parts that did arrive are still held');
    assert.deepEqual(after.missing, [1], 'and the device is told the one part to send again');

    // Sending it again finishes the upload. Nothing was lost but the bad part.
    const done = s.putChunk('c2', address, 1, 3, parts[1]!, 'image/jpeg', { partHash: hashBytes(parts[1]!) });
    assert.equal(done.complete, true);
    assert.deepEqual(s.get('c2', address).bytes, whole);
  });

  it('refuses a checksum that is not a checksum, rather than ignoring it', () => {
    const s = store();
    throwsCode(
      () => s.putChunk('c3', address, 0, 3, parts[0]!, 'image/jpeg', { partHash: 'md5:whatever' }),
      'EVIDENCE_PART_HASH_INVALID',
    );
    assert.deepEqual(s.uploadState('c3', address).held, [], 'nothing was written for a part that was never checked');
  });

  it('is optional, so every client that sends no checksum behaves exactly as before', () => {
    const s = store();
    assert.equal(s.putChunk('c4', address, 0, 3, parts[0]!, 'image/jpeg').complete, false);
    assert.equal(s.putChunk('c4', address, 1, 3, parts[1]!, 'image/jpeg').complete, false);
    assert.equal(s.putChunk('c4', address, 2, 3, parts[2]!, 'image/jpeg').complete, true);
    assert.deepEqual(s.get('c4', address).bytes, whole);
  });

  it('is checked identically by the asynchronous form', async () => {
    const s = store();
    await rejectsCode(
      () => s.writeChunk('c5', address, 0, 3, parts[1]!, 'image/jpeg', { partHash: hashBytes(parts[0]!) }),
      'EVIDENCE_PART_HASH_MISMATCH',
    );
    const held = await s.writeChunk('c5', address, 0, 3, parts[0]!, 'image/jpeg', { partHash: hashBytes(parts[0]!) });
    assert.deepEqual(held.held, [0]);
    assert.deepEqual(held.missing, [1, 2]);
  });
});

describe('the shape an upload was begun with', () => {
  it('is fixed by the first part, and a part from a different split is refused', () => {
    const s = store();
    s.putChunk('s1', address, 0, 3, parts[0]!, 'image/jpeg');

    // The same file, re-split into two after a reboot. Interleaving the two
    // splits could only ever produce bytes that do not hash to the address, and
    // the old code would not have found out until the last part.
    throwsCode(() => s.putChunk('s1', address, 1, 2, parts[1]!, 'image/jpeg'), 'EVIDENCE_CHUNK_COUNT_CHANGED');

    const state = s.uploadState('s1', address);
    assert.equal(state.chunks, 3, 'the upload keeps the shape it was begun with');
    assert.deepEqual(state.held, [0], 'and the part that was legitimately sent is still held');
    assert.ok(state.startedAt, 'an upload has a start time, so a sweep can date it');
  });

  it('is what the refusal names, so the device knows which way to continue', () => {
    const s = store();
    s.putChunk('s2', address, 0, 4, parts[0]!, 'image/jpeg');
    assert.throws(
      () => s.putChunk('s2', address, 1, 2, parts[1]!, 'image/jpeg'),
      /begun in 4 parts.*arrived as one of 2/s,
    );
  });

  it('is abandoned on request, which is the other half of that refusal', () => {
    const s = store();
    s.putChunk('s3', address, 0, 3, parts[0]!, 'image/jpeg');
    s.putChunk('s3', address, 1, 3, parts[1]!, 'image/jpeg');

    const abandoned = s.abandonUpload('s3', address);
    assert.equal(abandoned.abandoned, true);
    assert.equal(abandoned.parts, 2);
    assert.equal(abandoned.bytes, parts[0]!.length + parts[1]!.length);
    assert.deepEqual(s.uploadState('s3', address).held, []);

    // And the upload can now be begun again in whatever shape the device wants.
    assert.equal(s.putChunk('s3', address, 0, 2, whole.subarray(0, 500), 'image/jpeg').complete, false);
    assert.equal(s.putChunk('s3', address, 1, 2, whole.subarray(500), 'image/jpeg').complete, true);
  });

  it('is not abandoned when there is nothing to abandon, and never touches a finished object', () => {
    const s = store();
    assert.deepEqual(s.abandonUpload('s4', address), { abandoned: false, parts: 0, bytes: 0 });

    s.put('s4', address, whole, 'image/jpeg');
    assert.deepEqual(s.abandonUpload('s4', address), { abandoned: false, parts: 0, bytes: 0 });
    assert.equal(s.has('s4', address), true, 'a completed object is evidence and is not removed by this path');
  });
});

describe('a part that fails on the volume', () => {
  it('is dropped alone and named, rather than taking the upload with it', () => {
    const s = store();
    s.putChunk('v1', address, 0, 3, parts[0]!, 'image/jpeg');
    s.putChunk('v1', address, 1, 3, parts[1]!, 'image/jpeg');

    // Part 1 rots on the disk between arriving and the upload completing. The
    // checksum recorded when it arrived is what catches it.
    writeFileSync(join(chunkDir(address, 'v1'), '1'), Buffer.alloc(400, 9));

    throwsCode(() => s.putChunk('v1', address, 2, 3, parts[2]!, 'image/jpeg'), 'EVIDENCE_PART_CORRUPT');

    const state = s.uploadState('v1', address);
    assert.deepEqual(state.held, [0, 2], 'the sound parts are still held');
    assert.deepEqual(state.missing, [1], 'and the damaged one is what the device is asked for');

    const done = s.putChunk('v1', address, 1, 3, parts[1]!, 'image/jpeg');
    assert.equal(done.complete, true);
    assert.deepEqual(s.get('v1', address).bytes, whole);
  });

  it('names the part in words a person can act on', () => {
    const s = store();
    s.putChunk('v2', address, 0, 2, whole.subarray(0, 500), 'image/jpeg');
    writeFileSync(join(chunkDir(address, 'v2'), '0'), Buffer.alloc(500, 4));
    assert.throws(() => s.putChunk('v2', address, 1, 2, whole.subarray(500), 'image/jpeg'), /Part 0 .*Send that part again/s);
  });

  it('is distinguished from parts that are each sound but do not assemble to the file', () => {
    // Every part matches its own checksum and the whole still does not hash to
    // the address — a different file, or the wrong order. That is not a partial
    // upload to resume, and it is discarded, which is the behaviour that was
    // already right and must not change.
    const s = store();
    s.putChunk('v3', address, 0, 2, parts[0]!, 'image/jpeg');
    throwsCode(() => s.putChunk('v3', address, 1, 2, Buffer.from('not the rest of that photograph'), 'image/jpeg'), 'EVIDENCE_HASH_MISMATCH');
    assert.deepEqual(s.uploadState('v3', address).held, [], 'there is nothing here to resume');
  });
});

describe('what an unfinished upload is to the platform', () => {
  it('is reported to the tenancy, because nothing else reports it', () => {
    // Parts are directories rather than objects, so `list` does not see them and
    // the meter does not count them. Both are correct — a part is not evidence
    // and nobody should be billed for one — and it left a device that lost
    // signal at part four of nine holding a claim on the volume that no register
    // showed.
    const s = store();
    s.putChunk('u1', address, 0, 3, parts[0]!, 'image/jpeg');
    s.putChunk('u1', address, 1, 3, parts[1]!, 'image/jpeg');

    const [upload] = s.unfinishedUploads('u1');
    assert.ok(upload);
    assert.equal(upload.hash, address);
    assert.equal(upload.parts, 2);
    assert.equal(upload.chunks, 3);
    assert.equal(upload.bytes, parts[0]!.length + parts[1]!.length);
    assert.ok(Date.parse(upload.startedAt) > 0);

    assert.equal(s.list('u1').length, 0, 'and it is not an object, so it is not listed as one');
  });

  it('stops being reported the moment it completes', () => {
    const s = store();
    s.putChunk('u2', address, 0, 2, whole.subarray(0, 500), 'image/jpeg');
    assert.equal(s.unfinishedUploads('u2').length, 1);
    s.putChunk('u2', address, 1, 2, whole.subarray(500), 'image/jpeg');
    assert.equal(s.unfinishedUploads('u2').length, 0);
    assert.equal(s.list('u2').length, 1);
  });

  it('is swept only once nobody has come back for it', () => {
    const s = new EvidenceStore(sweepRoot, { maxBytes: 1_048_576, secret: 'a-test-secret' });
    s.putChunk('u3', address, 0, 3, parts[0]!, 'image/jpeg');

    // A window a real upload could never exceed: nothing is removed.
    assert.deepEqual(s.sweepUploads(7 * 24 * 3_600_000).removed, []);
    assert.equal(s.unfinishedUploads('u3').length, 1);

    // Aged past the window — asserted by moving the clock rather than the file,
    // so the sweep's own arithmetic is what is being tested.
    const swept = s.sweepUploads(3_600_000, Date.now() + 2 * 3_600_000);
    assert.equal(swept.removed.length, 1);
    assert.equal(swept.removed[0]?.hash, address);
    assert.equal(swept.removed[0]?.tenantId, 'u3', 'the sweep says whose photographs it took off the volume');
    assert.equal(swept.bytes, parts[0]!.length);
    assert.equal(s.unfinishedUploads('u3').length, 0);
  });

  it('is swept even when it predates the session file, because an undateable upload is unremovable', () => {
    const s = new EvidenceStore(sweepRoot, { maxBytes: 1_048_576, secret: 'a-test-secret' });
    s.putChunk('u4', address, 0, 3, parts[0]!, 'image/jpeg');
    // An upload begun by a build before uploads recorded their shape.
    rmSync(join(sweepChunkDir(address, 'u4'), 'session'), { force: true });
    const aged = new Date(Date.now() - 30 * 24 * 3_600_000);
    utimesSync(sweepChunkDir(address, 'u4'), aged, aged);

    const state = s.uploadState('u4', address);
    assert.deepEqual(state.held, [0], 'its parts are still readable');
    assert.equal(state.chunks, undefined, 'and its shape is unknown rather than guessed at from the parts present');

    assert.equal(s.sweepUploads(14 * 24 * 3_600_000).removed.length, 1);
  });

  it('is left alone by a store with no volume, rather than sweeping a relative path', () => {
    const nowhere = new EvidenceStore('', { secret: 'x' });
    assert.deepEqual(nowhere.unfinishedUploads('u5'), []);
    assert.deepEqual(nowhere.sweepUploads(1).removed, []);
  });
});

describe('the hygiene sweep', () => {
  it('reports what it took off the volume, and takes nothing when the window is not up', () => {
    const s = new EvidenceStore(mkdtempSync(join(tmpdir(), 'construx-hygiene-')), { secret: 'a-test-secret' });
    s.putChunk('h1', address, 0, 3, parts[0]!, 'image/jpeg');

    const quiet = sweepHygiene(Date.now(), s);
    assert.equal(quiet.abandonedUploads, 0);
    assert.equal(quiet.abandonedUploadBytes, 0);
    assert.equal(s.unfinishedUploads('h1').length, 1, 'a fortnight has not passed');

    const later = sweepHygiene(Date.now() + 30 * 24 * 3_600_000, s);
    assert.equal(later.abandonedUploads, 1);
    assert.equal(later.abandonedUploadBytes, parts[0]!.length);
    assert.equal(s.unfinishedUploads('h1').length, 0);
  });

  it('runs with no evidence store at all, because most deployments of it have none', () => {
    const report = sweepHygiene(Date.now(), undefined);
    assert.equal(report.abandonedUploads, 0);
    assert.equal(report.abandonedUploadBytes, 0);
  });
});

describe('resumable upload over HTTP', () => {
  let platform: Platform;
  let seed: SeedResult;
  let server: Server;
  let base: string;
  let token: string;
  let evidenceHash: string;

  before(async () => {
    platform = new Platform(undefined, new EvidenceStore(join(root, 'http'), { secret: 'a-test-secret' }));
    seed = await seedDemoProject(platform);
    server = createGateway(platform);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const user = platform.user(seed.users.pm!.id);
    token = issueTokens({
      actorId: user.id,
      tenantId: user.tenantId,
      partyId: user.partyId,
      roles: user.roles,
      mfaSatisfied: true,
    }).accessToken;

    // The ordering the upload route enforces: a domain command names the hash
    // first, and only then may bytes exist under it.
    const ctx = platform.context(seed.users.pm!.auth, seed.projectId, { correlationId: 'resumable-test' });
    const { registerEvidence } = await import('../src/engines/context.ts');
    evidenceHash = address;
    registerEvidence(ctx, {
      type: 'SITE_PHOTOGRAPH',
      hash: evidenceHash,
      description: 'A shaft-bottom photograph uploaded in parts over a site gate connection.',
    });
  });

  after(() => server.close());

  async function sendPart(
    index: number,
    chunks: number,
    body: Buffer,
    partHash?: string,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const query = new URLSearchParams({ chunks: String(chunks), index: String(index) });
    if (partHash !== undefined) query.set('partHash', partHash);
    const response = await fetch(`${base}/v1/evidence/${encodeURIComponent(evidenceHash)}?${query}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'image/jpeg' },
      body,
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : {} };
  }

  it('reads the part checksum off the request, and refuses one part without losing the others', async () => {
    const first = await sendPart(0, 3, parts[0]!, hashBytes(parts[0]!));
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.deepEqual(first.body.missing, [1, 2]);

    // A parameter nobody reads is not a checksum. This is the assertion that
    // the route actually passes it through to the store.
    const damaged = await sendPart(1, 3, parts[1]!.subarray(0, 100), hashBytes(parts[1]!));
    assert.equal(damaged.status, 422, JSON.stringify(damaged.body));
    assert.equal(damaged.body.title, 'EVIDENCE_PART_HASH_MISMATCH');
    assert.match(String(damaged.body.detail), /every other part of this upload is still held/);

    const resumed = await fetch(`${base}/v1/evidence/${encodeURIComponent(evidenceHash)}/chunks`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const state = (await resumed.json()) as { held: number[]; missing: number[]; chunks: number; parts: unknown[] };
    assert.deepEqual(state.held, [0]);
    assert.deepEqual(state.missing, [1, 2]);
    assert.equal(state.chunks, 3);
    assert.equal(state.parts.length, 1);
  });

  it('completes the upload when the missing parts arrive, and holds the file', async () => {
    assert.equal((await sendPart(1, 3, parts[1]!, hashBytes(parts[1]!))).status, 201);
    const done = await sendPart(2, 3, parts[2]!, hashBytes(parts[2]!));
    assert.equal(done.status, 201, JSON.stringify(done.body));
    assert.equal(done.body.complete, true);
    assert.equal(await platform.evidence.holds(seed.tenantId, evidenceHash), true);
    assert.deepEqual((await platform.evidence.fetch(seed.tenantId, evidenceHash)).bytes, whole);
  });

  it('abandons an upload on request, and leaves a finished object alone', async () => {
    // The finished object from the test above: abandoning must not touch it.
    const onFinished = await fetch(`${base}/v1/evidence/${encodeURIComponent(evidenceHash)}/chunks`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(onFinished.status, 200);
    assert.equal(((await onFinished.json()) as { abandoned: boolean }).abandoned, false);
    assert.equal(await platform.evidence.holds(seed.tenantId, evidenceHash), true);

    // A second file, part-uploaded and then given up on.
    const other = Buffer.alloc(900, 5);
    const otherHash = hashBytes(other);
    const ctx = platform.context(seed.users.pm!.auth, seed.projectId, { correlationId: 'resumable-abandon' });
    const { registerEvidence } = await import('../src/engines/context.ts');
    registerEvidence(ctx, { type: 'SITE_PHOTOGRAPH', hash: otherHash, description: 'Abandoned part-way up a lift shaft.' });

    await fetch(`${base}/v1/evidence/${encodeURIComponent(otherHash)}?chunks=3&index=0`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'image/jpeg' },
      body: other.subarray(0, 300),
    });
    assert.equal(platform.evidence.unfinishedUploads(seed.tenantId).length, 1);

    const abandoned = await fetch(`${base}/v1/evidence/${encodeURIComponent(otherHash)}/chunks`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(abandoned.status, 200);
    const outcome = (await abandoned.json()) as { abandoned: boolean; parts: number; bytes: number; projectId: string };
    assert.equal(outcome.abandoned, true);
    assert.equal(outcome.parts, 1);
    assert.equal(outcome.bytes, 300);
    assert.equal(outcome.projectId, seed.projectId);
    assert.equal(platform.evidence.unfinishedUploads(seed.tenantId).length, 0);
  });

  it('refuses to abandon an upload against a hash the project does not name', async () => {
    const stranger = hashBytes(Buffer.from('never registered as evidence anywhere', 'utf8'));
    const response = await fetch(`${base}/v1/evidence/${encodeURIComponent(stranger)}/chunks`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 404);
  });

  it('reports unfinished uploads on the retention position, separately from orphans', async () => {
    const pending = Buffer.alloc(700, 6);
    const pendingHash = hashBytes(pending);
    const ctx = platform.context(seed.users.pm!.auth, seed.projectId, { correlationId: 'resumable-retention' });
    const { registerEvidence } = await import('../src/engines/context.ts');
    registerEvidence(ctx, { type: 'SITE_PHOTOGRAPH', hash: pendingHash, description: 'Still on the handset.' });
    await fetch(`${base}/v1/evidence/${encodeURIComponent(pendingHash)}?chunks=2&index=0`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'image/jpeg' },
      body: pending.subarray(0, 350),
    });

    const position = await retentionPosition(platform.ledger, platform.evidence, seed.tenantId);
    assert.equal(position.unfinishedUploads.length, 1);
    assert.equal(position.unfinishedUploads[0]?.hash, pendingHash);
    assert.equal(position.unfinishedUploadBytes, 350);
    // Not an orphan: an orphan may be removed now, an unfinished upload is a
    // photograph somebody is still carrying.
    assert.equal(position.orphans.some((orphan) => orphan.hash === pendingHash), false);
  });

  it('leaves no part files behind once an upload completes', () => {
    // A stray part directory is a leak that no register would ever show, and
    // this is the cheapest place to notice one.
    const digest = evidenceHash.slice('sha256:'.length);
    const level = join(root, 'http', seed.tenantId, digest.slice(0, 2), digest.slice(2, 4));
    assert.equal(
      readdirSync(level).some((entry) => entry.endsWith('.chunks')),
      false,
    );
  });
});
