// TOTP (RFC 6238) — time-based one-time passwords for authenticator-app MFA.
//
// Pure functions, no DB / HTTP — directly unit-testable, same shape as
// tokens.ts. Uses only node:crypto (HMAC-SHA1, per RFC 6238's default and what
// every authenticator app — Google Authenticator, Authy, 1Password — expects;
// SHA1 here is fine, it's a MAC primitive, not used for collision resistance).
//
// Design:
//   * generateSecret() returns raw random bytes (160 bits / 20 bytes, the
//     RFC-recommended width for HMAC-SHA1).
//   * base32Encode/base32Decode implement RFC 4648 base32 (no padding on
//     encode; padding-tolerant on decode) — the format authenticator apps and
//     `otpauth://` URIs use for the secret, not the raw bytes.
//   * totp()/verifyTotp() implement the RFC 6238 algorithm directly: HOTP
//     (RFC 4226) over the 30-second time-step counter, with a ±1 step window
//     on verification to tolerate normal clock drift between the server and
//     the user's phone.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const STEP_SECONDS = 30;
const CODE_DIGITS = 6;
/** Verification tolerance: accept the current step plus this many steps
 *  either side (±30s * WINDOW), covering realistic phone/server clock drift
 *  without materially widening the guessable window. */
const WINDOW = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Generate a new TOTP secret — 160 bits (20 bytes), the RFC-recommended width for HMAC-SHA1. */
export function generateSecret(): Buffer {
  return randomBytes(20);
}

/** RFC 4648 base32 encode, no padding (the form authenticator apps expect). */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

/** RFC 4648 base32 decode — tolerant of lowercase, whitespace, and '=' padding. */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** HOTP (RFC 4226): dynamically-truncated HMAC-SHA1 over an 8-byte big-endian counter. */
function hotp(secret: Buffer, counter: number): string {
  const counterBuf = Buffer.alloc(8);
  // JS numbers are safe integers well past any realistic TOTP counter value
  // (counter = unixtime/30 won't exceed 2^53 for ~285 million years).
  counterBuf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  counterBuf.writeUInt32BE(counter >>> 0, 4);

  const hmac = createHmac('sha1', secret).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binCode =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  return String(binCode % 10 ** CODE_DIGITS).padStart(CODE_DIGITS, '0');
}

/** Current TOTP code for `secret` at `atMs` (default now). */
export function totp(secret: Buffer, atMs: number = Date.now()): string {
  const counter = Math.floor(atMs / 1000 / STEP_SECONDS);
  return hotp(secret, counter);
}

/**
 * Verify a user-entered code against `secret`, tolerating ±WINDOW time steps
 * of clock drift. Constant-time comparison per candidate to avoid a timing
 * oracle on which step (if any) matched.
 */
export function verifyTotp(secret: Buffer, code: string, atMs: number = Date.now()): boolean {
  const trimmed = code.trim();
  if (!/^\d{6}$/.test(trimmed)) return false;
  const counter = Math.floor(atMs / 1000 / STEP_SECONDS);
  const candidate = Buffer.from(trimmed, 'utf8');

  for (let delta = -WINDOW; delta <= WINDOW; delta++) {
    const expected = Buffer.from(hotp(secret, counter + delta), 'utf8');
    if (expected.length === candidate.length && timingSafeEqual(expected, candidate)) {
      return true;
    }
  }
  return false;
}

/** Build the standard `otpauth://totp/...` URI authenticator apps scan/import. */
export function otpauthUri(opts: {
  secret: Buffer;
  accountName: string;
  issuer?: string;
}): string {
  const issuer = opts.issuer ?? 'Laetoli Data';
  const label = encodeURIComponent(`${issuer}:${opts.accountName}`);
  const params = new URLSearchParams({
    secret: base32Encode(opts.secret),
    issuer,
    algorithm: 'SHA1',
    digits: String(CODE_DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
