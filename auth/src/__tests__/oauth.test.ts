import { describe, it, expect } from 'vitest';
import {
  buildGoogleAuthUrl,
  signState,
  verifyState,
  decodeGoogleIdToken,
  isAllowedRedirect,
} from '../oauth.js';

const SECRET = 's'.repeat(40);

describe('buildGoogleAuthUrl', () => {
  it('builds a well-formed Google consent-screen URL', () => {
    const url = buildGoogleAuthUrl(
      { clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://auth.example.tz/oauth/google/callback' },
      'somestate'
    );
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(parsed.searchParams.get('client_id')).toBe('cid');
    expect(parsed.searchParams.get('redirect_uri')).toBe('https://auth.example.tz/oauth/google/callback');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('scope')).toBe('openid email profile');
    expect(parsed.searchParams.get('state')).toBe('somestate');
  });
});

describe('signState / verifyState', () => {
  it('round-trips redirectTo through sign/verify', () => {
    const state = signState({ redirectTo: 'https://app.example.tz/callback' }, SECRET);
    const verified = verifyState(state, SECRET);
    expect(verified).toEqual({ redirectTo: 'https://app.example.tz/callback' });
  });

  it('rejects a state signed with a different secret', () => {
    const state = signState({ redirectTo: 'https://app.example.tz' }, SECRET);
    expect(verifyState(state, 'x'.repeat(40))).toBeNull();
  });

  it('rejects a tampered state', () => {
    const state = signState({ redirectTo: 'https://app.example.tz' }, SECRET);
    const tampered = state.slice(0, -2) + (state.slice(-2) === 'AA' ? 'BB' : 'AA');
    expect(verifyState(tampered, SECRET)).toBeNull();
  });

  it('rejects an expired state', () => {
    const now = 1_700_000_000_000;
    const state = signState({ redirectTo: 'https://app.example.tz' }, SECRET, now);
    // 11 minutes later — past the 10-minute TTL.
    expect(verifyState(state, SECRET, now + 11 * 60_000)).toBeNull();
  });

  it('rejects malformed state strings without throwing', () => {
    expect(verifyState('', SECRET)).toBeNull();
    expect(verifyState('not.a.valid.state', SECRET)).toBeNull();
    expect(verifyState('nodothere', SECRET)).toBeNull();
  });
});

function fakeIdToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.fakesignature`;
}

describe('decodeGoogleIdToken', () => {
  it('extracts sub/email/email_verified/name from a well-formed token', () => {
    const token = fakeIdToken({
      sub: 'google-user-123',
      email: 'asha@example.com',
      email_verified: true,
      name: 'Asha Juma',
    });
    expect(decodeGoogleIdToken(token)).toEqual({
      sub: 'google-user-123',
      email: 'asha@example.com',
      email_verified: true,
      name: 'Asha Juma',
    });
  });

  it('returns null when sub is missing', () => {
    const token = fakeIdToken({ email: 'x@example.com' });
    expect(decodeGoogleIdToken(token)).toBeNull();
  });

  it('returns null for a malformed token', () => {
    expect(decodeGoogleIdToken('not-a-jwt')).toBeNull();
    expect(decodeGoogleIdToken('a.b')).toBeNull();
  });

  it('defaults email_verified to false when absent/not exactly true', () => {
    const token = fakeIdToken({ sub: 'u1', email_verified: 'true' }); // string, not boolean
    expect(decodeGoogleIdToken(token)?.email_verified).toBe(false);
  });
});

describe('isAllowedRedirect', () => {
  const REGEXP = '^(https://app\\.example\\.tz|https://admin\\.example\\.tz)$';

  it('allows an origin matching the regexp', () => {
    expect(isAllowedRedirect('https://app.example.tz/callback', REGEXP)).toBe(true);
  });

  it('rejects a non-matching origin', () => {
    expect(isAllowedRedirect('https://evil.example.com/steal', REGEXP)).toBe(false);
  });

  it('rejects everything when no regexp is configured (fail closed, unlike CORS)', () => {
    expect(isAllowedRedirect('https://app.example.tz', undefined)).toBe(false);
  });

  it('rejects a malformed URL without throwing', () => {
    expect(isAllowedRedirect('not a url', REGEXP)).toBe(false);
  });
});
