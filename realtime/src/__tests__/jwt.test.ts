import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import { verifyAccessToken, parseBearer } from '../jwt.js';

const SECRET = 'a'.repeat(40);

function sign(claims: Record<string, unknown>, secret = SECRET): string {
  return jwt.sign(claims, secret, { algorithm: 'HS256' });
}

describe('verifyAccessToken', () => {
  it('verifies a valid HS256 token and returns claims', () => {
    const now = Math.floor(Date.now() / 1000);
    const token = sign({ sub: 'user-123', role: 'authenticated', iat: now, exp: now + 3600 });
    const claims = verifyAccessToken(token, SECRET);
    expect(claims.sub).toBe('user-123');
    expect(claims.role).toBe('authenticated');
    expect(claims.exp - claims.iat).toBe(3600);
  });

  it('rejects a token signed with a different secret', () => {
    const token = sign({ sub: 'u', role: 'authenticated' });
    expect(() => verifyAccessToken(token, 'b'.repeat(40))).toThrow();
  });

  it('rejects an expired token', () => {
    const past = Math.floor(Date.now() / 1000) - 10_000;
    const token = sign({ sub: 'u', role: 'authenticated', iat: past, exp: past + 5 });
    expect(() => verifyAccessToken(token, SECRET)).toThrow();
  });

  it('rejects a non-HS256 alg (alg confusion guard)', () => {
    const token = jwt.sign({ sub: 'u', role: 'authenticated' }, SECRET, { algorithm: 'HS512' });
    expect(() => verifyAccessToken(token, SECRET)).toThrow();
  });

  it('rejects tokens missing required claims', () => {
    const token = sign({ role: 'authenticated' }); // no sub
    expect(() => verifyAccessToken(token, SECRET)).toThrow();
  });

  it('defaults iat/exp to 0 when absent', () => {
    // jsonwebtoken always adds iat; strip it via noTimestamp + no exp.
    const token = jwt.sign({ sub: 'u', role: 'authenticated' }, SECRET, {
      algorithm: 'HS256',
      noTimestamp: true,
    });
    const claims = verifyAccessToken(token, SECRET);
    expect(claims.iat).toBe(0);
    expect(claims.exp).toBe(0);
  });
});

describe('parseBearer', () => {
  it('extracts the token from a Bearer header', () => {
    expect(parseBearer('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(parseBearer('bearer xyz')).toBe('xyz');
  });

  it('returns null for missing or malformed headers', () => {
    expect(parseBearer(undefined)).toBeNull();
    expect(parseBearer('Basic abc')).toBeNull();
    expect(parseBearer('')).toBeNull();
  });
});
