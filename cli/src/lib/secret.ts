// secret.ts — strong-secret generation (pure, deterministic given a byte source).
import { randomBytes } from 'node:crypto';

/**
 * Generate a URL-safe strong secret string of roughly `bytes` of entropy.
 * Base64url so it survives .env / shell / connection-string usage without
 * needing quoting (no `+`, `/`, `=`). Defaults give ~32 chars (24 bytes).
 */
export function generateSecret(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

/** A DB password: 24 bytes -> 32 base64url chars. */
export function generatePassword(): string {
  return generateSecret(24);
}

/** A JWT signing secret: 48 bytes -> 64 base64url chars (>= 32 required). */
export function generateJwtSecret(): string {
  return generateSecret(48);
}
