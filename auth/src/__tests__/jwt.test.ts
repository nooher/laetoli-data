import { describe, it, expect } from 'vitest';
import {
  issueAccessToken,
  verifyAccessToken,
  parseBearer,
  AUTHENTICATED_ROLE,
} from '../jwt.js';

const SECRET = 'a'.repeat(40);

describe('jwt', () => {
  it('sign → verify round-trips with correct claims', () => {
    const token = issueAccessToken('user-123', {
      secret: SECRET,
      expirySeconds: 3600,
    });
    const claims = verifyAccessToken(token, SECRET);
    expect(claims.sub).toBe('user-123');
    expect(claims.role).toBe(AUTHENTICATED_ROLE);
    expect(claims.exp - claims.iat).toBe(3600);
  });

  it('rejects a token signed with a different secret', () => {
    const token = issueAccessToken('u', { secret: SECRET, expirySeconds: 60 });
    expect(() => verifyAccessToken(token, 'b'.repeat(40))).toThrow();
  });

  it('respects exp — an expired token is rejected', () => {
    const past = Math.floor(Date.now() / 1000) - 10_000;
    const token = issueAccessToken('u', {
      secret: SECRET,
      expirySeconds: 5, // exp = past + 5, long gone
      nowSeconds: past,
    });
    expect(() => verifyAccessToken(token, SECRET)).toThrow();
  });

  it('honors nowSeconds for iat/exp (verify within validity window)', () => {
    // Token issued "10s ago" with a 100s lifetime — still valid now.
    const now = Math.floor(Date.now() / 1000);
    const token = issueAccessToken('u', {
      secret: SECRET,
      expirySeconds: 100,
      nowSeconds: now - 10,
    });
    const claims = verifyAccessToken(token, SECRET);
    expect(claims.iat).toBe(now - 10);
    expect(claims.exp).toBe(now - 10 + 100);
  });

  it('parseBearer extracts the token', () => {
    expect(parseBearer('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(parseBearer('bearer xyz')).toBe('xyz');
    expect(parseBearer('Token abc')).toBeNull();
    expect(parseBearer(undefined)).toBeNull();
    expect(parseBearer('')).toBeNull();
  });
});
