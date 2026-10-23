/**
 * SHA-256 over a file the browser must never hold.
 *
 * ## Why this exists
 *
 * The address of every piece of evidence on this platform is the hash of its
 * contents, and the browser computes it: the record is written with the hash
 * first and the bytes follow it, so a dropped connection leaves a record naming
 * a document rather than bytes nothing names. That worked through one line —
 *
 *     crypto.subtle.digest('SHA-256', await file.arrayBuffer())
 *
 * — which reads the **whole file into the tab's memory** before hashing it.
 * `arrayBuffer()` on a two-gigabyte site video does not return a buffer; it
 * fails, or takes the tab with it. So the server could hold a file of any size
 * and the console could not begin to send one: the upload that mattered most
 * was the one that could not be started.
 *
 * `crypto.subtle` has no streaming digest — it is one call over one buffer, and
 * SHA-256 is not composable, so a file cannot be hashed in pieces with it.
 * Hence this: the algorithm itself, fed from `blob.stream()`, holding sixty-four
 * bytes at a time.
 *
 * ## It is checked against the real thing
 *
 * A hand-written hash is only worth having if it agrees with every other
 * implementation of it, because the digest it produces is the name a document
 * is filed under for the life of the record. `backend/tests/browserhash.test.ts`
 * runs this against `node:crypto` across the sizes where an implementation goes
 * wrong — empty, one byte, either side of a block, either side of the padding
 * boundary, and sizes that are not multiples of anything — and against
 * `crypto.subtle` itself.
 *
 * ## The small-file path is still the fast one
 *
 * Under the threshold below, `crypto.subtle` does the work: it is native, it is
 * faster, and a site photograph does not need any of this. The streaming path
 * is for what construction actually produces.
 */

/** The first thirty-two bits of the fractional parts of the cube roots of the first sixty-four primes. */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** Files below this are hashed by the platform underneath, which is faster. */
export const STREAM_ABOVE_BYTES = 32 * 1024 * 1024;

/**
 * An incremental SHA-256.
 *
 * `update` may be called with any sizes — a stream yields whatever the disk and
 * the network give it — and only the tail of an incomplete 64-byte block is
 * kept between calls.
 */
export function sha256() {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const tail = new Uint8Array(64);
  let tailBytes = 0;
  let total = 0;
  let finished = false;

  const rotr = (value, by) => (value >>> by) | (value << (32 - by));

  /** One 64-byte block, read big-endian out of `block` at `at`. */
  const compress = (block, at) => {
    for (let i = 0; i < 16; i += 1) {
      w[i] = (block[at + i * 4] << 24) | (block[at + i * 4 + 1] << 16) | (block[at + i * 4 + 2] << 8) | block[at + i * 4 + 3];
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }

    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];

    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choose = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + choose + K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + majority) | 0;

      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }

    h[0] = (h[0] + a) | 0;
    h[1] = (h[1] + b) | 0;
    h[2] = (h[2] + c) | 0;
    h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0;
    h[5] = (h[5] + f) | 0;
    h[6] = (h[6] + g) | 0;
    h[7] = (h[7] + hh) | 0;
  };

  return {
    update(bytes) {
      if (finished) throw new Error('this digest has already been finished');
      const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      total += input.length;
      let at = 0;

      // Finish the block held from last time before touching the new bytes.
      if (tailBytes > 0) {
        const wanted = Math.min(64 - tailBytes, input.length);
        tail.set(input.subarray(0, wanted), tailBytes);
        tailBytes += wanted;
        at = wanted;
        if (tailBytes < 64) return this;
        compress(tail, 0);
        tailBytes = 0;
      }

      // Whole blocks straight out of the input, with no copying.
      while (at + 64 <= input.length) {
        compress(input, at);
        at += 64;
      }

      // Whatever is left is the start of the next block.
      if (at < input.length) {
        tail.set(input.subarray(at), 0);
        tailBytes = input.length - at;
      }
      return this;
    },

    /** The digest as lower-case hex. The object is finished afterwards. */
    digest() {
      if (finished) throw new Error('this digest has already been finished');
      finished = true;

      /*
       * The padding, and the one place a long file is different from a short
       * one: the length is appended as a **64-bit** count of bits, so a file
       * over half a gigabyte overflows the low 32 bits. Written as two halves
       * from the byte count rather than shifted into one, because
       * `bytes * 8 << 0` is exactly the silent wrong answer this is here to
       * avoid.
       */
      const padded = new Uint8Array(tailBytes + 1 <= 56 ? 64 : 128);
      padded.set(tail.subarray(0, tailBytes), 0);
      padded[tailBytes] = 0x80;
      const bits = total * 8;
      const high = Math.floor(bits / 0x100000000);
      const low = bits % 0x100000000;
      const view = new DataView(padded.buffer);
      view.setUint32(padded.length - 8, high);
      view.setUint32(padded.length - 4, low >>> 0);
      for (let at = 0; at < padded.length; at += 64) compress(padded, at);

      let hex = '';
      for (let i = 0; i < 8; i += 1) hex += (h[i] >>> 0).toString(16).padStart(8, '0');
      return hex;
    },
  };
}

/**
 * The hash of a file, in the form the ledger records it.
 *
 * `onProgress` is called with the bytes read so far and the total, because
 * hashing a gigabyte takes seconds a person needs to be told about — a console
 * that looks frozen is one somebody reloads half way through.
 */
export async function hashBlob(blob, onProgress) {
  if (blob.size <= STREAM_ABOVE_BYTES && typeof crypto !== 'undefined' && crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
    if (onProgress) onProgress(blob.size, blob.size);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  const state = sha256();
  let read = 0;

  // `blob.stream()` reads from the disk in pieces and is the whole point: the
  // file is never in memory, only the piece being hashed.
  if (typeof blob.stream === 'function') {
    const reader = blob.stream().getReader();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      state.update(next.value);
      read += next.value.length;
      if (onProgress) onProgress(read, blob.size);
    }
    return state.digest();
  }

  // No streams: slice it instead. Older engines, and `File` objects that some
  // environments hand over without a stream.
  const piece = 8 * 1024 * 1024;
  for (let at = 0; at < blob.size; at += piece) {
    state.update(new Uint8Array(await blob.slice(at, at + piece).arrayBuffer()));
    read = Math.min(at + piece, blob.size);
    if (onProgress) onProgress(read, blob.size);
  }
  return state.digest();
}
