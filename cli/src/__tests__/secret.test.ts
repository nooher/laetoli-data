import { describe, it, expect } from 'vitest';
import { generateSecret, generatePassword, generateJwtSecret } from '../lib/secret.js';

describe('secret generation', () => {
  it('produces url-safe strings (base64url, no +/=)', () => {
    const s = generateSecret(24);
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('produces different values each call', () => {
    expect(generateSecret()).not.toBe(generateSecret());
  });

  it('jwt secret is long enough (>= 32 chars)', () => {
    expect(generateJwtSecret().length).toBeGreaterThanOrEqual(32);
  });

  it('password has reasonable length', () => {
    expect(generatePassword().length).toBeGreaterThanOrEqual(24);
  });
});
