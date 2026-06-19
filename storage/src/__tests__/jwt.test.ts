import { describe, it, expect } from 'vitest';
import {
  verifyAccessToken,
  parseBearer,
  issueSignedToken,
  verifySignedToken,
} from '../jwt.js';
import { SECRET, makeToken } from './helpers.js';

describe('verifyAccessToken', () => {
  it('verifies a valid HS256 token', () => {
    const t = makeToken('user-1');
    const claims = verifyAccessToken(t, SECRET);
    expect(claims.sub).toBe('user-1');
    expect(claims.role).toBe('authenticated');
  });

  it('rejects a token signed with a different secret', () => {
    const t = makeToken('user-1', { secret: 'x'.repeat(40) });
    expect(() => verifyAccessToken(t, SECRET)).toThrow();
  });

  it('rejects an expired token', () => {
    const t = makeToken('user-1', { expiresInSeconds: -10 });
    expect(() => verifyAccessToken(t, SECRET)).toThrow();
  });
});

describe('parseBearer', () => {
  it('extracts the token', () => {
    expect(parseBearer('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(parseBearer('bearer xyz')).toBe('xyz');
  });
  it('returns null on missing/malformed headers', () => {
    expect(parseBearer(undefined)).toBeNull();
    expect(parseBearer('Token abc')).toBeNull();
  });
});

describe('signed URL tokens', () => {
  it('round-trips for the same bucket/path', () => {
    const t = issueSignedToken('docs', 'a/b.pdf', {
      secret: SECRET,
      expiresInSeconds: 60,
    });
    const claims = verifySignedToken(t, SECRET, { bucket: 'docs', path: 'a/b.pdf' });
    expect(claims.scope).toBe('storage-signed');
    expect(claims.bucket).toBe('docs');
  });

  it('rejects mismatched bucket/path (cannot replay on another object)', () => {
    const t = issueSignedToken('docs', 'a/b.pdf', {
      secret: SECRET,
      expiresInSeconds: 60,
    });
    expect(() =>
      verifySignedToken(t, SECRET, { bucket: 'docs', path: 'other.pdf' })
    ).toThrow();
    expect(() =>
      verifySignedToken(t, SECRET, { bucket: 'private', path: 'a/b.pdf' })
    ).toThrow();
  });

  it('rejects an expired signed token', () => {
    const t = issueSignedToken('docs', 'a/b.pdf', {
      secret: SECRET,
      expiresInSeconds: -5,
    });
    expect(() =>
      verifySignedToken(t, SECRET, { bucket: 'docs', path: 'a/b.pdf' })
    ).toThrow();
  });

  it('rejects an access token used as a signed token (wrong scope)', () => {
    const access = makeToken('user-1');
    expect(() =>
      verifySignedToken(access, SECRET, { bucket: 'docs', path: 'a/b.pdf' })
    ).toThrow();
  });
});
