import { randomBytes } from 'node:crypto';

/**
 * ULID — lexicographically sortable, 26 chars, Crockford base32.
 * Sortability matters: the replay engine orders events by (timestamp, eventId),
 * so the id itself has to break ties in creation order.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RANDOM_LEN = 16;

let lastTime = -1;
let lastRandom: number[] = [];

function encodeTime(now: number): string {
  let out = '';
  let t = now;
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    out = ALPHABET[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function randomChars(): number[] {
  const bytes = randomBytes(RANDOM_LEN);
  return Array.from(bytes, (b: number) => b % 32);
}

/** Increment the random component so two ULIDs minted in the same millisecond stay ordered. */
function bumpRandom(chars: number[]): number[] {
  const out = chars.slice();
  for (let i = out.length - 1; i >= 0; i--) {
    const v = out[i] ?? 0;
    if (v < 31) {
      out[i] = v + 1;
      return out;
    }
    out[i] = 0;
  }
  return randomChars();
}

export function ulid(now: number = Date.now()): string {
  if (now === lastTime) {
    lastRandom = bumpRandom(lastRandom);
  } else {
    lastTime = now;
    lastRandom = randomChars();
  }
  return encodeTime(now) + lastRandom.map((c) => ALPHABET[c]).join('');
}

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isUlid(value: unknown): value is string {
  return typeof value === 'string' && ULID_RE.test(value);
}

/**
 * Human-readable reference numbers (RFI-0001, VAR-0007, ...).
 * Correspondence, RFIs, variations and notices are all referred to by number in
 * the field and in court, so numbering is a first-class domain concern.
 */
export function formatRef(prefix: string, sequence: number, width = 4): string {
  return `${prefix}-${String(sequence).padStart(width, '0')}`;
}
