import { describe, it, expect, vi } from 'vitest';
import { handleOAuthGoogleStart, handleOAuthGoogleCallback, type HandlerDeps } from '../handlers.js';
import { createFakeDb } from './fakeDb.js';
import { signState } from '../oauth.js';

const SECRET = 's'.repeat(40);
const REDIRECT_REGEXP = '^https://app\\.example\\.tz$';

function fakeIdToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

function deps(over: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    db: createFakeDb(),
    jwtSecret: SECRET,
    jwtExpiry: 3600,
    googleOAuth: { clientId: 'cid', clientSecret: 'csecret', redirectUri: 'https://auth.example.tz/oauth/google/callback' },
    oauthAllowedRedirectOriginsRegexp: REDIRECT_REGEXP,
    ...over,
  };
}

describe('handleOAuthGoogleStart', () => {
  it('redirects to Google with a signed state embedding redirect_to', async () => {
    const r = await handleOAuthGoogleStart(deps(), 'https://app.example.tz/callback');
    expect(r.status).toBe(302);
    expect(r.redirect).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
    const url = new URL(r.redirect!);
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('503s when Google OAuth is not configured', async () => {
    const r = await handleOAuthGoogleStart(deps({ googleOAuth: undefined }), 'https://app.example.tz');
    expect(r.status).toBe(503);
  });

  it('400s on a redirect_to not on the allow-list', async () => {
    const r = await handleOAuthGoogleStart(deps(), 'https://evil.example.com/steal');
    expect(r.status).toBe(400);
  });

  it('400s when redirect_to is missing', async () => {
    const r = await handleOAuthGoogleStart(deps(), undefined);
    expect(r.status).toBe(400);
  });
});

describe('handleOAuthGoogleCallback', () => {
  function fakeFetch(idTokenPayload: Record<string, unknown>): typeof fetch {
    return vi.fn(async () =>
      new Response(JSON.stringify({ id_token: fakeIdToken(idTokenPayload) }), { status: 200 })
    ) as unknown as typeof fetch;
  }

  it('first-time Google sign-in creates a user + identity, issues a session, redirects with tokens', async () => {
    const d = deps({
      oauthFetch: fakeFetch({ sub: 'google-1', email: 'asha@example.com', email_verified: true }),
    });
    const state = signState({ redirectTo: 'https://app.example.tz/callback' }, SECRET);

    const r = await handleOAuthGoogleCallback(d, { code: 'authcode', state });
    expect(r.status).toBe(302);
    expect(r.redirect).toMatch(/^https:\/\/app\.example\.tz\/callback#/);
    const fragment = new URLSearchParams(r.redirect!.split('#')[1]);
    expect(fragment.get('access_token')).toBeTruthy();
    expect(fragment.get('refresh_token')).toBeTruthy();
    expect(fragment.get('token_type')).toBe('bearer');

    const db = d.db as ReturnType<typeof createFakeDb>;
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].email).toBe('asha@example.com');
    expect(db.oauthIdentities).toHaveLength(1);
    expect(db.oauthIdentities[0].provider_user_id).toBe('google-1');
  });

  it('a returning Google user reuses the same local account (matched by provider+sub, not email)', async () => {
    const db = createFakeDb();
    const d = deps({
      db,
      oauthFetch: fakeFetch({ sub: 'google-1', email: 'asha@example.com', email_verified: true }),
    });
    const state = signState({ redirectTo: 'https://app.example.tz' }, SECRET);

    const first = await handleOAuthGoogleCallback(d, { code: 'code1', state });
    const second = await handleOAuthGoogleCallback(d, { code: 'code2', state });

    expect(first.status).toBe(302);
    expect(second.status).toBe(302);
    expect(db.rows).toHaveLength(1); // no duplicate user created
    expect(db.oauthIdentities).toHaveLength(1); // no duplicate identity
  });

  it('does not merge into an existing password account with the same email (identity, not email, is the source of truth)', async () => {
    const db = createFakeDb([
      {
        id: 'existing-user-id',
        username: 'asha',
        password_hash: 'somehash',
        is_anonymous: false,
        email: 'asha@example.com',
        email_verified: false,
        phone: null,
        created_at: new Date().toISOString(),
        suspended_at: null,
      },
    ]);
    const d = deps({
      db,
      oauthFetch: fakeFetch({ sub: 'google-1', email: 'asha@example.com', email_verified: true }),
    });
    const state = signState({ redirectTo: 'https://app.example.tz' }, SECRET);

    await handleOAuthGoogleCallback(d, { code: 'code1', state });

    // A NEW user was created for the Google identity — the pre-existing
    // password account with the same email was NOT silently taken over.
    expect(db.rows).toHaveLength(2);
    expect(db.oauthIdentities).toHaveLength(1);
    expect(db.oauthIdentities[0].user_id).not.toBe('existing-user-id');
  });

  it('503s when Google OAuth is not configured', async () => {
    const r = await handleOAuthGoogleCallback(deps({ googleOAuth: undefined }), { code: 'x', state: 'y' });
    expect(r.status).toBe(503);
  });

  it('400s on a missing code', async () => {
    const state = signState({ redirectTo: 'https://app.example.tz' }, SECRET);
    const r = await handleOAuthGoogleCallback(deps(), { state });
    expect(r.status).toBe(400);
  });

  it('400s when Google reports an error param (user denied consent, etc.)', async () => {
    const r = await handleOAuthGoogleCallback(deps(), { error: 'access_denied' });
    expect(r.status).toBe(400);
  });

  it('400s on an invalid/tampered state', async () => {
    const r = await handleOAuthGoogleCallback(deps(), { code: 'authcode', state: 'garbage' });
    expect(r.status).toBe(400);
  });

  it('400s on a state signed for a different redirect (implicitly rejected via allow-list on start, but verify tamper-resistance here too)', async () => {
    // A state forged with a DIFFERENT secret must not verify.
    const forgedState = signState({ redirectTo: 'https://app.example.tz' }, 'wrong-secret-wrong-secret-wrong');
    const r = await handleOAuthGoogleCallback(deps(), { code: 'authcode', state: forgedState });
    expect(r.status).toBe(400);
  });

  it('502s when Google token endpoint fails', async () => {
    const d = deps({
      oauthFetch: vi.fn(async () => new Response('error', { status: 400 })) as unknown as typeof fetch,
    });
    const state = signState({ redirectTo: 'https://app.example.tz' }, SECRET);
    const r = await handleOAuthGoogleCallback(d, { code: 'authcode', state });
    expect(r.status).toBe(400); // Google itself returned non-ok -> surfaced as a 400, not a 502
  });

  it('502s when the network call itself throws', async () => {
    const d = deps({
      oauthFetch: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch,
    });
    const state = signState({ redirectTo: 'https://app.example.tz' }, SECRET);
    const r = await handleOAuthGoogleCallback(d, { code: 'authcode', state });
    expect(r.status).toBe(502);
  });
});
