import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { config } from '../src/config.ts';
import * as envelope from '../src/evidence/envelope.ts';
import { EvidenceStore, hashBytes, plaintextBytesOf } from '../src/evidence/store.ts';
import { byteRange } from '../src/api/gateway.ts';
import { postJson, VendorTransportError } from '../src/ai/providers/transport.ts';
import { rejectsCode } from './helpers.ts';

/**
 * Large everything.
 *
 * Construction does not produce small files. A drawing set is hundreds of
 * megabytes, a federated model more, an hour of site walkthrough about a
 * gigabyte, and a scanned historic pack for a refurbishment is whatever the
 * archive sent. The platform's ceiling was fifty megabytes — and the number was
 * not really the ceiling, because `put` took a buffer, `read` returned one and a
 * resumable upload concatenated every part before writing. The real limit was
 * the heap of the one process that serves everybody, so raising the
 * configuration value would have turned a clean 413 into an out-of-memory kill
 * in the middle of somebody else's request.
 *
 * What this file holds to:
 *
 *   1. A file is written to the volume and read back **a frame at a time**,
 *      whatever its size, and the bytes that come back are the bytes that went
 *      in.
 *   2. The streaming and buffered readers agree, so one store does not hold two
 *      kinds of object with two sets of callers.
 *   3. Every guarantee the buffered path made still holds: the hash is verified
 *      against the address the ledger records, a mismatch stores nothing, and a
 *      file cut short, reordered or moved between tenancies fails to
 *      authenticate rather than reading as a shorter whole file.
 *   4. A range is answered, which is the difference between a two-hour site
 *      video somebody can seek in and one nobody watches.
 *   5. Holding a file and analysing one are different acts with different
 *      costs, and the second has its own named ceiling.
 */

const KEY = Buffer.alloc(32, 11).toString('base64');

/** Set a master key for the duration of a block and put back whatever was there. */
async function withKey<T>(key: string | undefined, run: () => Promise<T> | T): Promise<T> {
  const held = config.evidence.masterKey;
  (config.evidence as { masterKey?: string }).masterKey = key;
  try {
    return await run();
  } finally {
    (config.evidence as { masterKey?: string }).masterKey = held;
  }
}

/**
 * Bytes that compress badly and repeat predictably.
 *
 * A fixture of one repeated byte would hide an off-by-one inside a frame: every
 * slice of it looks like every other slice. This is derived from a counter, so
 * a frame boundary read one byte out is a different value rather than the same
 * one.
 */
function pattern(bytes: number): Buffer {
  const out = Buffer.alloc(bytes);
  for (let at = 0; at < bytes; at += 1) out[at] = (at * 31 + (at >> 8)) & 0xff;
  return out;
}

/** The stream form, in pieces that deliberately do not line up with frames. */
async function* inPieces(bytes: Buffer, piece = 7_919): AsyncGenerator<Buffer> {
  for (let at = 0; at < bytes.length; at += piece) yield bytes.subarray(at, at + piece);
}

async function collect(source: AsyncIterable<Buffer>): Promise<Buffer> {
  const pieces: Buffer[] = [];
  for await (const piece of source) pieces.push(piece);
  return Buffer.concat(pieces);
}

/**
 * The same bytes, asserted without printing them.
 *
 * `assert.deepEqual` on two multi-megabyte buffers does not merely fail — the
 * runner builds a diff of every byte, and the test process is killed for memory
 * before it can report anything. Comparing length and digest says the same
 * thing in two lines of output, which is the difference between a failure
 * somebody can read and a SIGKILL.
 */
function same(actual: Buffer, expected: Buffer, what = 'the bytes'): void {
  assert.equal(actual.length, expected.length, `${what}: length`);
  assert.equal(
    createHash('sha256').update(actual).digest('hex'),
    createHash('sha256').update(expected).digest('hex'),
    `${what}: content`,
  );
}

describe('the framed envelope', () => {
  // Three and a half frames: two whole ones, a part, and a boundary in the
  // middle of the fixture rather than at the end of it.
  const plain = pattern(Math.round(envelope.FRAME_BYTES * 3.5));

  it('round-trips a file larger than one frame', async () => {
    await withKey(KEY, async () => {
      const sealed = await collect(envelope.encryptFrames('tenant-a', inPieces(plain)));
      assert.ok(envelope.isFramed(sealed.subarray(0, 16)), 'written in the framed format');
      assert.ok(sealed.length > plain.length, 'each frame carries its own IV and tag');
      same(await collect(envelope.decryptFrames('tenant-a', inPieces(sealed))), plain, 'streamed back');
    });
  });

  it('is read identically by the buffered reader, so one store has one set of callers', async () => {
    await withKey(KEY, async () => {
      const sealed = await collect(envelope.encryptFrames('tenant-a', inPieces(plain)));
      // `decrypt` is what the PDF renderer, the document reader and the
      // retention sweep all go through. A file the streaming writer produced
      // has to be readable by every one of them.
      same(envelope.decrypt('tenant-a', sealed), plain, 'read whole');
    });
  });

  it('refuses a file cut short, rather than reading it as a shorter whole file', async () => {
    await withKey(KEY, async () => {
      const sealed = await collect(envelope.encryptFrames('tenant-a', inPieces(plain)));
      // Exactly one frame removed from the end. Every remaining frame
      // authenticates on its own; what fails is that none of them claims to be
      // the last — which is the whole reason the end is bound into the AAD.
      const short = sealed.subarray(0, envelope.MAGIC.length + 1 + 4 + 2 * (envelope.FRAME_BYTES + envelope.FRAME_OVERHEAD_BYTES));
      await assert.rejects(
        () => collect(envelope.decryptFrames('tenant-a', inPieces(short))),
        /did not authenticate|ends part way/,
      );
      assert.throws(() => envelope.decrypt('tenant-a', short), /did not authenticate|ends part way/);
    });
  });

  it('refuses a frame moved out of its place', async () => {
    await withKey(KEY, async () => {
      const sealed = await collect(envelope.encryptFrames('tenant-a', inPieces(pattern(envelope.FRAME_BYTES * 3))));
      const header = envelope.MAGIC.length + 1 + 4;
      const stride = envelope.FRAME_BYTES + envelope.FRAME_OVERHEAD_BYTES;
      const swapped = Buffer.concat([
        sealed.subarray(0, header),
        sealed.subarray(header + stride, header + 2 * stride),
        sealed.subarray(header, header + stride),
        sealed.subarray(header + 2 * stride),
      ]);
      await assert.rejects(() => collect(envelope.decryptFrames('tenant-a', inPieces(swapped))), /did not authenticate/);
    });
  });

  it('refuses a file moved into another tenancy, as the single-shot format does', async () => {
    await withKey(KEY, async () => {
      const sealed = await collect(envelope.encryptFrames('tenant-a', inPieces(pattern(2_048))));
      await assert.rejects(() => collect(envelope.decryptFrames('tenant-b', inPieces(sealed))), /did not authenticate/);
    });
  });

  it('answers a range without reading the file from the beginning', async () => {
    await withKey(KEY, async () => {
      const sealed = await collect(envelope.encryptFrames('tenant-a', inPieces(plain)));
      // A range that starts inside the third frame and ends inside the fourth,
      // which is the case a naive implementation gets wrong in both directions.
      const offset = envelope.FRAME_BYTES * 2 + 1_234;
      const length = envelope.FRAME_BYTES + 77;
      const position = envelope.framePosition(offset);
      assert.equal(position.skipFrames, 2);
      assert.equal(position.withinFrame, 1_234);

      const window = await collect(
        envelope.decryptFrames('tenant-a', inPieces(sealed.subarray(position.byteOffset)), {
          skipBytes: position.withinFrame,
          takeBytes: length,
          // Opened at a frame boundary: there is no header here, and each
          // frame's position is part of what authenticates it.
          layout: envelope.framedLayout(sealed),
          startIndex: position.skipFrames,
        }),
      );
      same(window, plain.subarray(offset, offset + length), 'the range');
    });
  });

  it('passes plaintext through where no key is configured, as the old format did', async () => {
    await withKey(undefined, async () => {
      const through = await collect(envelope.encryptFrames('tenant-a', inPieces(plain)));
      same(through, plain, 'nothing is encrypted and nothing is wrapped');
      same(await collect(envelope.decryptFrames('tenant-a', inPieces(through))), plain, 'plaintext round trip');
    });
  });

  it('works out the plaintext length from the size of the file', async () => {
    await withKey(KEY, async () => {
      for (const size of [1, 4_096, envelope.FRAME_BYTES - 1, envelope.FRAME_BYTES, envelope.FRAME_BYTES + 1, envelope.FRAME_BYTES * 2 + 17]) {
        const sealed = await collect(envelope.encryptFrames('tenant-a', inPieces(pattern(size))));
        assert.equal(plaintextBytesOf(sealed.length), size, `${size} bytes`);
      }
    });
  });
});

describe('a file of any size, through the store', () => {
  let directory: string;
  let store: EvidenceStore;
  // Larger than one frame, and not a multiple of it.
  const file = pattern(Math.round(envelope.FRAME_BYTES * 2.3));
  const hash = hashBytes(file);

  before(() => {
    directory = mkdtempSync(join(tmpdir(), 'construx-large-'));
    store = new EvidenceStore(join(directory, 'store'));
  });

  after(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('streams it in and streams it back, byte for byte', async () => {
    await withKey(KEY, async () => {
      const stored = await store.putStream('tenant-a', hash, inPieces(file), 'application/pdf');
      assert.equal(stored.bytes, file.length);
      assert.equal(stored.hash, hash);

      const read = await store.readStream('tenant-a', hash);
      assert.equal(read.contentType, 'application/pdf');
      assert.equal(read.bytes, file.length);
      same(await collect(read.stream), file, 'streamed out');
      assert.equal(await store.sizeOf('tenant-a', hash), file.length);
    });
  });

  it('is the same file to the buffered readers', async () => {
    await withKey(KEY, async () => {
      // `get` and `read` are what a PDF render and a document reading use. A
      // file written by the streaming path has to be the same object to them.
      same(store.get('tenant-a', hash).bytes, file, 'get');
      same((await store.read('tenant-a', hash)).bytes, file, 'read');
    });
  });

  it('answers a range from the middle of it', async () => {
    await withKey(KEY, async () => {
      const offset = envelope.FRAME_BYTES + 5_000;
      const length = 20_000;
      const read = await store.readStream('tenant-a', hash, { offset, length });
      assert.equal(read.bytes, length);
      same(await collect(read.stream), file.subarray(offset, offset + length), 'the range');
    });
  });

  it('refuses bytes that do not hash to the address, and stores nothing', async () => {
    await withKey(KEY, async () => {
      const other = pattern(9_000);
      await rejectsCode(
        () => store.putStream('tenant-a', hashBytes(pattern(1_000)), inPieces(other), 'application/pdf'),
        'EVIDENCE_HASH_MISMATCH',
      );
      // Nothing half-written left under a name a reader could find.
      assert.equal(store.has('tenant-a', hashBytes(pattern(1_000))), false);
      assert.equal(store.has('tenant-a', hashBytes(other)), false);
    });
  });

  it('refuses the wrong bytes under an address it already holds', async () => {
    await withKey(KEY, async () => {
      // The address alone is not proof. Answering "stored" here would let any
      // bytes be sent under a hash the ledger already trusts.
      await rejectsCode(() => store.putStream('tenant-a', hash, inPieces(pattern(4_096)), 'application/pdf'), 'EVIDENCE_HASH_MISMATCH');
      same(store.get('tenant-a', hash).bytes, file, 'the file that is held is untouched');
    });
  });

  it('is idempotent for the same bytes twice', async () => {
    await withKey(KEY, async () => {
      const again = await store.putStream('tenant-a', hash, inPieces(file), 'application/pdf');
      assert.equal(again.bytes, file.length);
      assert.equal((again as { alreadyHeld?: true }).alreadyHeld, true);
    });
  });

  it('refuses a declared length over the ceiling before reading a byte of it', async () => {
    await withKey(KEY, async () => {
      // Its own store with its own ceiling: the limit is read when a store is
      // constructed, which is what makes a deployment's configuration a fixed
      // fact for the life of the process rather than something a request can
      // find halfway changed.
      const tight = new EvidenceStore(join(directory, 'tight'), { maxBytes: 1_024 });
      let read = 0;
      async function* counted(): AsyncGenerator<Buffer> {
        read += 1;
        yield pattern(8_192);
      }
      await rejectsCode(
        () => tight.putStream('tenant-a', hashBytes(pattern(8_192)), counted(), 'video/mp4', { declaredBytes: 50 * 1_048_576 }),
        'EVIDENCE_TOO_LARGE',
      );
      assert.equal(read, 0, 'refused before the upload was read, not after it had all arrived');
    });
  });

  it('enforces the ceiling on what actually arrives, not on what was declared', async () => {
    await withKey(KEY, async () => {
      const tight = new EvidenceStore(join(directory, 'tight'), { maxBytes: 64 * 1_024 });
      const big = pattern(200_000);
      await rejectsCode(
        // A declared length that fits, and a body that does not.
        () => tight.putStream('tenant-a', hashBytes(big), inPieces(big), 'video/mp4', { declaredBytes: 1_000 }),
        'EVIDENCE_TOO_LARGE',
      );
      assert.equal(tight.has('tenant-a', hashBytes(big)), false, 'and nothing half-written is left behind');
    });
  });

  it('refuses to read a file into memory that is too large to hold, and says the file is fine', async () => {
    await withKey(KEY, async () => {
      const held = config.evidence.analyseMaxBytes;
      (config.evidence as { analyseMaxBytes?: number }).analyseMaxBytes = 1_024;
      try {
        // Holding a file and analysing one are different acts. Every buffered
        // reader refuses, which is what stops a path written with a 40MB
        // drawing in mind from finding a two-gigabyte video.
        const refusal = await rejectsCode(() => store.read('tenant-a', hash), 'EVIDENCE_TOO_LARGE_TO_READ');
        assert.match(refusal.message ?? '', /held and intact/);
        assert.match(refusal.message ?? '', /EVIDENCE_ANALYSE_MAX_BYTES/);

        // And the streaming path is unaffected: the file is still readable,
        // which is exactly what the refusal above promises.
        const read = await store.readStream('tenant-a', hash);
        same(await collect(read.stream), file, 'still streamable');
      } finally {
        (config.evidence as { analyseMaxBytes?: number }).analyseMaxBytes = held;
      }
    });
  });

  it('assembles a resumable upload without ever holding the whole of it', async () => {
    await withKey(KEY, async () => {
      // Three parts, each larger than one frame, so the assembly crosses frame
      // boundaries the way a real upload does.
      const whole = pattern(Math.round(envelope.FRAME_BYTES * 3.3));
      const wholeHash = hashBytes(whole);
      const size = Math.ceil(whole.length / 3);
      const parts = [whole.subarray(0, size), whole.subarray(size, size * 2), whole.subarray(size * 2)];

      for (let index = 0; index < parts.length; index += 1) {
        const state = await store.writeChunk('tenant-a', wholeHash, index, parts.length, parts[index]!, 'video/mp4', {
          partHash: hashBytes(parts[index]!),
        });
        assert.equal(state.complete, index === parts.length - 1);
      }

      const read = await store.readStream('tenant-a', wholeHash);
      same(await collect(read.stream), whole, 'assembled');
    });
  });

  it('keeps reading a file written before any of this existed', async () => {
    await withKey(KEY, async () => {
      // The single-shot format, written by the buffered path. Both readers must
      // still answer for it, or turning the streaming path on would have been a
      // migration nobody ran.
      const old = pattern(12_345);
      const oldHash = hashBytes(old);
      await store.write('tenant-a', oldHash, old, 'image/jpeg');
      same((await store.read('tenant-a', oldHash)).bytes, old, 'the old format, buffered');
      const read = await store.readStream('tenant-a', oldHash);
      same(await collect(read.stream), old, 'the old format, streamed');
      assert.equal(await store.sizeOf('tenant-a', oldHash), old.length);

      const window = await store.readStream('tenant-a', oldHash, { offset: 100, length: 50 });
      same(await collect(window.stream), old.subarray(100, 150), 'a range of the old format');
    });
  });

  it('streams a file that was never encrypted at all', async () => {
    await withKey(undefined, async () => {
      const plain = pattern(Math.round(envelope.FRAME_BYTES * 1.4));
      const plainHash = hashBytes(plain);
      await store.putStream('tenant-b', plainHash, inPieces(plain), 'application/octet-stream');
      const read = await store.readStream('tenant-b', plainHash);
      same(await collect(read.stream), plain, 'never encrypted');
      // Nothing to authenticate, so the whole-file hash is what proves the
      // volume has not corrupted it. Verified as it streams.
      assert.equal(await store.sizeOf('tenant-b', plainHash), plain.length);
    });
  });

  it('notices a corrupted file where there is no key to authenticate it', async () => {
    await withKey(undefined, async () => {
      const plain = pattern(40_000);
      const plainHash = hashBytes(plain);
      await store.putStream('tenant-c', plainHash, inPieces(plain), 'application/octet-stream');

      // Reach past the store and alter the bytes on the volume, which is what a
      // failing disk does.
      const digest = plainHash.slice('sha256:'.length);
      const path = join(directory, 'store', 'tenant-c', digest.slice(0, 2), digest.slice(2, 4), digest);
      const size = statSync(path).size;
      assert.equal(size, plain.length);
      const { writeFileSync } = await import('node:fs');
      writeFileSync(path, pattern(size).map((value) => value ^ 0xff) as unknown as Buffer);

      /*
       * Refused, and refused *before* a byte goes out.
       *
       * An unencrypted file has no per-frame tag to authenticate, so what
       * proves it is still the evidence somebody recorded is its hash — and for
       * a file small enough to hold, the streaming read checks that the way the
       * buffered read always did: in full, before answering. A caller never
       * receives part of a corrupted file.
       */
      await assert.rejects(() => store.readStream('tenant-c', plainHash), /no longer match their hash/);
    });
  });
});

describe('what a browser asked for of a file', () => {
  it('reads a single byte range and ignores what it cannot serve', () => {
    assert.deepEqual(byteRange('bytes=0-499'), { offset: 0, length: 500 });
    assert.deepEqual(byteRange('bytes=1048576-'), { offset: 1_048_576 });
    // A suffix range and a multi-range request are not served, and ignoring a
    // range is always safe: the answer is then the whole file with a 200.
    assert.equal(byteRange('bytes=-500'), undefined);
    assert.equal(byteRange('bytes=0-100,200-300'), undefined);
    assert.equal(byteRange('items=0-100'), undefined);
    assert.equal(byteRange(undefined), undefined);
    // End before start is nonsense, not a range.
    assert.equal(byteRange('bytes=500-100'), undefined);
  });
});

describe('the transport that talks to a vendor', () => {
  let server: Server;
  let base: string;
  /** How long to wait before answering, so a clock can be caught. */
  let delayMs = 0;
  let behaviour: 'ANSWER' | 'DROP' = 'ANSWER';

  before(async () => {
    server = createServer((request, response) => {
      if (behaviour === 'DROP') {
        // Headers never sent, socket destroyed: the request arrived in full
        // and no answer came back, which is the shape that must not be
        // retried and must not be released.
        request.socket.destroy();
        return;
      }
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ answered: true }));
      }, delayMs);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('waits for an answer, because no AI task is cut short by a clock', async () => {
    /*
     * The defect this closes, reported from a live run:
     *
     *     AI_PROVIDER_DROPPED — … (UND_ERR_HEADERS_TIMEOUT)
     *
     * `fetch` aborts a call whose response headers have not arrived within 300
     * seconds and the limit cannot be turned off through its API — while this
     * platform states in two places that it imposes no deadline unless one is
     * configured, and sets none. A non-streaming completion sends no headers
     * until the model has finished writing, so every reasoning run over five
     * minutes was killed after the vendor had done and billed the work.
     *
     * A unit test cannot wait five minutes. What it can prove is that the
     * transport has no clock of its own: a reply that is slower than anything
     * `fetch` would tolerate per byte still arrives.
     */
    delayMs = 1_200;
    const reply = await postJson({ url: base, headers: { 'content-type': 'application/json' }, body: '{}', deadlineMs: 0 });
    delayMs = 0;
    assert.equal(reply.status, 200);
    assert.equal(reply.ok, true);
    assert.deepEqual(JSON.parse(reply.text), { answered: true });
  });

  it('applies a deadline only where the operator configured one', async () => {
    delayMs = 2_000;
    try {
      await assert.rejects(
        () => postJson({ url: base, headers: {}, body: '{}', deadlineMs: 250 }),
        (error: Error) => {
          // Named as a timeout so the orchestrator parks the hold rather than
          // releasing it: the vendor may have finished the work.
          assert.equal(error.name, 'TimeoutError');
          assert.equal((error as VendorTransportError).sent, true);
          return true;
        },
      );
    } finally {
      delayMs = 0;
    }
  });

  it('knows whether the request was sent, which decides what happens to the money', async () => {
    behaviour = 'DROP';
    try {
      await assert.rejects(
        () => postJson({ url: base, headers: {}, body: '{"a":1}', deadlineMs: 0 }),
        (error: Error) => {
          const failure = error as VendorTransportError;
          assert.equal(failure.sent, true, 'the body went out');
          assert.equal(failure.responded, false, 'and nothing came back');
          return true;
        },
      );
    } finally {
      behaviour = 'ANSWER';
    }
  });

  it('says a connection was never made, which is safe to retry', async () => {
    // A port with nothing on it. The vendor cannot have billed for a request
    // that was never written.
    await assert.rejects(
      () => postJson({ url: 'http://127.0.0.1:1/none', headers: {}, body: '{}', deadlineMs: 0 }),
      (error: Error) => {
        const failure = error as VendorTransportError;
        assert.equal(failure.sent, false);
        assert.equal(failure.responded, false);
        return true;
      },
    );
  });

  it('hands back the vendor’s status rather than interpreting it', async () => {
    const reply = await postJson({ url: `${base}/`, headers: {}, body: '{}', deadlineMs: 0 });
    assert.equal(reply.ok, true);
    assert.equal(createHash('sha256').update(reply.text).digest('hex').length, 64);
  });
});
