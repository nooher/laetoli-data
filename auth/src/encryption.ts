// At-rest encryption for secrets that must be READ BACK (unlike passwords/
// tokens elsewhere in this service, which are one-way hashed — a TOTP secret
// has to be recovered on every login to compute the expected code, so hashing
// isn't an option; AES-256-GCM is).
//
// The encryption key is derived from JWT_SECRET (already a required, ≥32-char
// secret validated in config.ts) via SHA-256, so no separate key/env var is
// needed. Deriving rather than reusing JWT_SECRET directly keeps the two uses
// cryptographically separate.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // 96-bit IV, the GCM-recommended size

function deriveKey(jwtSecret: string): Buffer {
  return createHash('sha256').update(`laetoli-data:mfa-secret-key:${jwtSecret}`).digest();
}

/** Encrypt `plaintext` bytes; returns `iv:ciphertext:authTag`, each base64url. */
export function encryptSecret(plaintext: Buffer, jwtSecret: string): string {
  const key = deriveKey(jwtSecret);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, ciphertext, authTag].map((b) => b.toString('base64url')).join(':');
}

/** Decrypt a value produced by encryptSecret(). Throws on tamper/wrong key (fails closed). */
export function decryptSecret(encoded: string, jwtSecret: string): Buffer {
  const [ivB64, ctB64, tagB64] = encoded.split(':');
  if (!ivB64 || !ctB64 || !tagB64) {
    throw new Error('Malformed encrypted secret.');
  }
  const key = deriveKey(jwtSecret);
  const iv = Buffer.from(ivB64, 'base64url');
  const ciphertext = Buffer.from(ctB64, 'base64url');
  const authTag = Buffer.from(tagB64, 'base64url');
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
