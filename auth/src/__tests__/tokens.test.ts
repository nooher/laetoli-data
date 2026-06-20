import { describe, it, expect } from 'vitest';
import {
  generateToken,
  hashToken,
  safeEqualHex,
  tokenMatchesHash,
  expiryFromNow,
  isExpired,
} from '../tokens.js';

describe('tokens', () => {
  it('generateToken returns high-entropy unique base64url values', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding
    expect(a.length).toBeGreaterThanOrEqual(40);
  });

  it('hashToken is deterministic and not the plaintext', () => {
    const v = generateToken();
    expect(hashToken(v)).toBe(hashToken(v));
    expect(hashToken(v)).not.toBe(v);
    expect(hashToken(v)).toMatch(/^[0-9a-f]{64}$/); // sha256 hex
  });

  it('tokenMatchesHash verifies a value against its stored digest', () => {
    const v = generateToken();
    const stored = hashToken(v);
    expect(tokenMatchesHash(v, stored)).toBe(true);
    expect(tokenMatchesHash(generateToken(), stored)).toBe(false);
  });

  it('safeEqualHex is false for length mismatch / empty', () => {
    expect(safeEqualHex('', '')).toBe(false);
    expect(safeEqualHex('ab', 'abcd')).toBe(false);
    expect(safeEqualHex('abcd', 'abcd')).toBe(true);
  });

  it('expiryFromNow + isExpired round-trip', () => {
    const base = 1_000_000_000_000;
    const future = expiryFromNow(3600, base);
    expect(isExpired(future, base)).toBe(false);
    expect(isExpired(future, base + 3600_001)).toBe(true);
    expect(isExpired(expiryFromNow(-1, base), base)).toBe(true);
  });
});
