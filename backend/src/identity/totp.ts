import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords — RFC 6238 over RFC 4226 — with no dependency.
 *
 * The second factor a person carries in an authenticator app: Google
 * Authenticator, Microsoft Authenticator, 1Password, Authy and the rest all
 * implement exactly this. Thirty-second steps, six digits, HMAC-SHA1, the
 * secret shared once at enrolment as base32 and never again. SHA1 is what the
 * apps expect and is not a weakness here: the construction is HMAC over a
 * moving counter, not a digest of a secret anybody can offline-attack.
 *
 * Everything that makes this safe to accept a code from is around the
 * algorithm rather than in it, and lives in `authenticators.ts`: a code is
 * accepted once (the counter it matched is recorded and never accepted again),
 * within one step either side of now (clock drift on a phone, not a window an
 * attacker can use), against an identity that is not locked out.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    value = (value << 5) | ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A fresh 160-bit secret, as the apps expect it: base32, no padding. */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

/** RFC 4226: HMAC-SHA1 over the big-endian counter, dynamically truncated. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeUInt32BE(Math.floor(counter / 0x1_0000_0000), 0);
  message.writeUInt32BE(counter >>> 0, 4);
  const digest = createHmac('sha1', secret).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) | ((digest[offset + 1]! & 0xff) << 16) | ((digest[offset + 2]! & 0xff) << 8) | (digest[offset + 3]! & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The counter for a moment in time. */
export function counterAt(nowMs: number, stepSeconds = TOTP_STEP_SECONDS): number {
  return Math.floor(nowMs / 1000 / stepSeconds);
}

/** RFC 6238: the code for a moment in time. */
export function totp(secretBase32: string, nowMs = Date.now(), stepSeconds = TOTP_STEP_SECONDS, digits = TOTP_DIGITS): string {
  return hotp(base32Decode(secretBase32), counterAt(nowMs, stepSeconds), digits);
}

/**
 * Which counter a code matches, within `window` steps either side of now, or
 * null. The caller decides whether that counter has been used before; this
 * function only knows about time.
 */
export function matchTotp(
  secretBase32: string,
  code: string,
  nowMs = Date.now(),
  window = 1,
  stepSeconds = TOTP_STEP_SECONDS,
): number | null {
  const offered = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(offered)) return null;
  const secret = base32Decode(secretBase32);
  const centre = counterAt(nowMs, stepSeconds);
  for (let delta = -window; delta <= window; delta += 1) {
    const counter = centre + delta;
    const expected = hotp(secret, counter);
    if (expected.length === offered.length && timingSafeEqual(Buffer.from(expected), Buffer.from(offered))) return counter;
  }
  return null;
}

/**
 * The URI an authenticator app scans or is handed. Issuer in both places, as
 * the apps expect; the account label is the person's address so the entry in
 * the app reads as what it is.
 */
export function otpauthUri(issuer: string, account: string, secretBase32: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * Recovery codes: ten, each eight characters from an alphabet with no
 * ambiguous glyphs, shown once and kept only as digests. Each works once.
 */
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const bytes = randomBytes(8);
    let code = '';
    for (const byte of bytes) code += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length];
    codes.push(`${code.slice(0, 4)}-${code.slice(4)}`);
  }
  return codes;
}

/** Normalise what a person typed: case, spaces and the hyphen do not matter. */
export function normaliseRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}
