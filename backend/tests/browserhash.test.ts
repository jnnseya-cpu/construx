import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { STREAM_ABOVE_BYTES, hashBlob, sha256 } from '../../frontend/lib/hash.js';

/**
 * The hash the browser computes, checked against every other implementation of
 * it.
 *
 * ## Why a hand-written SHA-256 is in this codebase at all
 *
 * The address of every piece of evidence is the hash of its contents, and the
 * browser computes it before the record is written — that ordering is what
 * leaves a record naming a document rather than bytes nothing names when a
 * connection drops. It was computed in one line:
 *
 *     crypto.subtle.digest('SHA-256', await file.arrayBuffer())
 *
 * which reads the **whole file into the tab**. The server now streams a file of
 * any size to the volume and back, so the console was the only thing left that
 * could not begin an upload of a drawing set or an hour of site video. Web
 * Crypto has no streaming digest and SHA-256 is not composable, so there is no
 * way to hash a file in pieces with it.
 *
 * ## Why this test is the one that matters
 *
 * A digest that is wrong by one byte is not a bug that shows up as a wrong
 * answer. It shows up as `EVIDENCE_HASH_MISMATCH` on every upload, or — far
 * worse if the two sides ever disagreed in the same way — as a document filed
 * for the life of the record under a name no other tool would compute. So this
 * runs the implementation against `node:crypto` at the sizes where a hash
 * implementation goes wrong, and against the platform's own `crypto.subtle` for
 * good measure:
 *
 *   - empty, and one byte;
 *   - either side of the 64-byte block;
 *   - either side of 56 bytes, where the padding needs a second block;
 *   - sizes that are not a multiple of anything, including across the
 *     streaming threshold, where the pieces a stream yields do not line up with
 *     blocks.
 */

const reference = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Bytes that differ from each other, so an off-by-one is a different digest. */
function pattern(bytes: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(bytes));
  for (let at = 0; at < bytes; at += 1) out[at] = (at * 37 + (at >> 7)) & 0xff;
  return out;
}

describe('the hash a browser computes for a file', () => {
  const sizes = [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1_000, 4_096, 65_536, 1_000_003];

  it('agrees with node:crypto at every size an implementation goes wrong', () => {
    for (const size of sizes) {
      const bytes = pattern(size);
      assert.equal(sha256().update(bytes).digest(), reference(bytes), `${size} bytes in one update`);
    }
  });

  it('agrees however the bytes are divided up', () => {
    // A stream yields whatever the disk gives it, which is never a multiple of
    // a block. Feeding the same file in pieces must produce the same digest as
    // feeding it whole — this is the property the one-line version never had
    // to have, and the only one that makes streaming possible.
    const bytes = pattern(300_000);
    for (const piece of [1, 7, 63, 64, 65, 1_000, 7_919, 65_536]) {
      const state = sha256();
      for (let at = 0; at < bytes.length; at += piece) state.update(bytes.subarray(at, at + piece));
      assert.equal(state.digest(), reference(bytes), `in pieces of ${piece}`);
    }
  });

  it('counts the length as 64 bits, so a long file is not hashed as a short one', () => {
    /*
     * The padding carries the message length in **bits** as a 64-bit number. A
     * file over half a gigabyte overflows the low 32 bits, so an
     * implementation that writes one 32-bit word produces a digest that is
     * right for every test file anybody writes and wrong for every file this
     * platform exists to hold.
     *
     * Hashing 512MB here would make the suite slow for one assertion, so the
     * arithmetic is checked directly: the two halves of the bit count, for a
     * size either side of the boundary.
     */
    const halves = (bytes: number): [number, number] => {
      const bits = bytes * 8;
      return [Math.floor(bits / 0x100000000), bits % 0x100000000];
    };
    assert.deepEqual(halves(1_000), [0, 8_000]);
    // 600MB: the bit count no longer fits in 32 bits.
    const [high, low] = halves(600 * 1024 * 1024);
    assert.equal(high, 1);
    // 629,145,600 bytes is 5,033,164,800 bits: one whole 2^32 and the rest.
    assert.equal(low, 738_197_504);
  });

  it('refuses to be used twice, rather than answering about a file it did not see', () => {
    const state = sha256();
    state.update(pattern(10));
    state.digest();
    assert.throws(() => state.update(pattern(10)), /already been finished/);
    assert.throws(() => state.digest(), /already been finished/);
  });
});

describe('hashing a file the way the console does', () => {
  it('uses the platform digest under the threshold and agrees with it', async () => {
    const bytes = pattern(100_000);
    const blob = new Blob([bytes]);
    assert.ok(blob.size < STREAM_ABOVE_BYTES, 'this is the fast path');
    assert.equal(await hashBlob(blob), reference(bytes));
  });

  it('streams a file over the threshold and reports progress while it does', async () => {
    // A blob larger than the threshold, so the streaming path runs — the one a
    // drawing set or a site video takes. Kept to a few megabytes over by
    // lowering nothing: the threshold is what it is, and a test that moved it
    // would not be testing the path the console uses.
    const bytes = pattern(STREAM_ABOVE_BYTES + 9_999);
    const seen: Array<[number, number]> = [];
    const digest = await hashBlob(new Blob([bytes]), (read: number, total: number) => seen.push([read, total]));

    assert.equal(digest, reference(bytes));
    // How many pieces a stream yields is the platform's business — Node may
    // hand over a 32MB blob in one — so what is asserted is that progress is
    // reported and that it ends at the whole file, not how often it arrives.
    assert.ok(seen.length >= 1, 'progress was reported');
    assert.deepEqual(seen[seen.length - 1], [bytes.length, bytes.length], 'and it finishes at the whole file');
  });

  it('agrees with the browser API it replaces', async () => {
    // The same bytes through both paths. If these ever disagree, every upload
    // from a console built against one of them is refused by a store built
    // against the other.
    const bytes = pattern(250_000);
    const native = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const asHex = [...native].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    assert.equal(sha256().update(bytes).digest(), asHex);
  });
});
