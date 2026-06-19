// API key minting + hashing + verification.
//
// A key shown to an operator looks like:   ld_<prefixrand>.<secret>
//   * key_prefix  = "ld_<prefixrand>"  — a short, NON-secret display handle
//                   stored in the DB and shown in dashboards.
//   * secret      = a long random string — the actual credential. We store ONLY
//                   sha256(secret) (key_hash); the raw secret is returned to the
//                   caller EXACTLY ONCE at mint time and never persisted.
//
// Verification re-hashes the presented secret and compares (constant-time)
// against the stored hash. Because the stored value is a hash, a leaked DB dump
// cannot be replayed as a key.
//
// Pure, dependency-free (node:crypto only) so it unit-tests in isolation.

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

export interface MintedKey {
  /** Non-secret display prefix, e.g. "ld_8f3a1c0b". Stored + shown. */
  prefix: string;
  /** The secret portion (random). Returned once; NEVER stored raw. */
  secret: string;
  /** sha256(secret) hex — what we persist as key_hash. */
  hash: string;
  /** The full presentable key: "<prefix>.<secret>". Returned once. */
  apikey: string;
}

/** URL/header-safe base62-ish alphabet (no +/= so keys travel cleanly in headers/URLs). */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomToken(bytes: number): string {
  const buf = randomBytes(bytes);
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    out += ALPHABET[buf[i] % ALPHABET.length];
  }
  return out;
}

/** sha256 hex of a string. */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/**
 * Mint a fresh key. Returns {prefix, secret, hash, apikey}. Persist `prefix` and
 * `hash`; hand `apikey` (= prefix.secret) to the operator ONCE.
 */
export function mintKey(): MintedKey {
  const prefix = `ld_${randomToken(8)}`;
  const secret = randomToken(40);
  const hash = hashSecret(secret);
  return { prefix, secret, hash, apikey: `${prefix}.${secret}` };
}

/**
 * Split a presented "<prefix>.<secret>" into its parts. Returns null if the
 * shape is wrong (no dot / empty halves).
 */
export function splitApiKey(presented: string): { prefix: string; secret: string } | null {
  if (typeof presented !== 'string') return null;
  const dot = presented.indexOf('.');
  if (dot <= 0 || dot >= presented.length - 1) return null;
  return { prefix: presented.slice(0, dot), secret: presented.slice(dot + 1) };
}

/** Constant-time compare of two hex strings of equal length. */
function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return timingSafeEqual(ab, bb);
}

/**
 * Verify a presented full key (or bare secret) against a stored hash.
 * Accepts either "<prefix>.<secret>" or just "<secret>" — it hashes the secret
 * portion and constant-time compares to `storedHash`.
 */
export function verifyKey(presented: string, storedHash: string): boolean {
  if (typeof presented !== 'string' || typeof storedHash !== 'string') return false;
  const split = splitApiKey(presented);
  const secret = split ? split.secret : presented;
  if (secret.length === 0) return false;
  return constantTimeEqualHex(hashSecret(secret), storedHash);
}
