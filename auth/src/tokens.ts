// Opaque secret tokens — refresh / password-reset / email-verification.
//
// Design (sovereign, offline, no external calls):
//   * The token VALUE returned to the client is high-entropy random bytes,
//     base64url-encoded. It is NEVER stored.
//   * Only the SHA-256 digest of the value is persisted (token_hash), so a DB
//     leak does not expose usable tokens.
//   * Lookups hash the presented value and compare to the stored digest using a
//     constant-time comparison (timingSafeEqual) to avoid timing oracles.
//
// Pure functions, no DB / HTTP — directly unit-testable.

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

/** Number of random bytes per opaque token (256 bits of entropy). */
const TOKEN_BYTES = 32;

/** Generate a new opaque token value (base64url, no padding). */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/** SHA-256 digest (hex) of a token value — what we store at rest. */
export function hashToken(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Constant-time equality for two hex digests.
 * Returns false on any length mismatch (without leaking via early return time
 * beyond the unavoidable length check).
 */
export function safeEqualHex(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ab.length !== bb.length || ab.length === 0) return false;
  return timingSafeEqual(ab, bb);
}

/** Convenience: does this plaintext value hash to the stored digest? */
export function tokenMatchesHash(value: string, storedHash: string): boolean {
  return safeEqualHex(hashToken(value), storedHash);
}

/**
 * Generate a numeric one-time code (default 6 digits) for SMS OTP. Uses
 * rejection-free modular reduction over crypto bytes — fine for a short-lived,
 * attempt-limited code (entropy is bounded by the digit count by design).
 */
export function generateOtpCode(digits = 6): string {
  const max = 10 ** digits;
  // 6 random bytes → 48 bits, far above 10^6, so modulo bias is negligible.
  const n = Number(randomBytes(6).readUIntBE(0, 6) % max);
  return n.toString().padStart(digits, '0');
}

/** Seconds → an absolute ISO expiry timestamp from a base time (default now). */
export function expiryFromNow(seconds: number, nowMs: number = Date.now()): string {
  return new Date(nowMs + seconds * 1000).toISOString();
}

/** True when an ISO timestamp is in the past relative to `nowMs`. */
export function isExpired(iso: string, nowMs: number = Date.now()): boolean {
  const t = Date.parse(iso);
  return !Number.isFinite(t) || t <= nowMs;
}
