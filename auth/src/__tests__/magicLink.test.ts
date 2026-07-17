import { describe, it, expect } from 'vitest';
import { handleMagicLinkRequest, handleMagicLinkVerify, type HandlerDeps } from '../handlers.js';
import { createFakeDb } from './fakeDb.js';
import { verifyAccessToken } from '../jwt.js';

const SECRET = 's'.repeat(40);
const REDIRECT_REGEXP = '^https://app\\.example\\.tz$';

function deps(over: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    db: createFakeDb(),
    jwtSecret: SECRET,
    jwtExpiry: 3600,
    magicLinkDelivery: 'log',
    oauthAllowedRedirectOriginsRegexp: REDIRECT_REGEXP,
    ...over,
  };
}

describe('handleMagicLinkRequest', () => {
  it('creates a passwordless user + a magic-link token; returns the token in log mode', async () => {
    const d = deps();
    const r = await handleMagicLinkRequest(d, { email: 'asha@example.com' });
    expect(r.status).toBe(200);
    const body = r.body as { magic_link_token?: string };
    expect(body.magic_link_token).toBeTruthy();

    const db = d.db as ReturnType<typeof createFakeDb>;
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].email).toBe('asha@example.com');
    expect(db.magicLinkTokens).toHaveLength(1);
  });

  it('reuses the existing user on a second request for the same email (no duplicate)', async () => {
    const db = createFakeDb();
    const d = deps({ db });
    await handleMagicLinkRequest(d, { email: 'asha@example.com' });
    await handleMagicLinkRequest(d, { email: 'asha@example.com' });
    expect(db.rows).toHaveLength(1);
    expect(db.magicLinkTokens).toHaveLength(2); // a fresh token each request
  });

  it('400s on an invalid email', async () => {
    const r = await handleMagicLinkRequest(deps(), { email: 'not-an-email' });
    expect(r.status).toBe(400);
  });

  it('400s on a redirect_to not on the allow-list', async () => {
    const r = await handleMagicLinkRequest(deps(), {
      email: 'asha@example.com',
      redirect_to: 'https://evil.example.com/steal',
    });
    expect(r.status).toBe(400);
  });

  it('does not return the token in email delivery mode (no enumeration/leak via response)', async () => {
    const d = deps({ magicLinkDelivery: 'email' });
    const r = await handleMagicLinkRequest(d, { email: 'asha@example.com' });
    expect(r.status).toBe(200);
    const body = r.body as { magic_link_token?: string };
    expect(body.magic_link_token).toBeUndefined();
  });
});

describe('handleMagicLinkVerify', () => {
  it('consumes a valid token and returns a session directly when no redirect_to is given', async () => {
    const db = createFakeDb();
    const d = deps({ db });
    const req = await handleMagicLinkRequest(d, { email: 'asha@example.com' });
    const token = (req.body as { magic_link_token: string }).magic_link_token;

    const r = await handleMagicLinkVerify(d, { token });
    expect(r.status).toBe(200);
    const body = r.body as { access_token: string; user: { email: string } };
    expect(body.access_token).toBeTruthy();
    expect(body.user.email).toBe('asha@example.com');
    const claims = verifyAccessToken(body.access_token, SECRET);
    expect(claims.sub).toBe(db.rows[0].id);
  });

  it('marks the email verified on successful verify (clicking the link proves ownership)', async () => {
    const db = createFakeDb();
    const d = deps({ db });
    const req = await handleMagicLinkRequest(d, { email: 'asha@example.com' });
    const token = (req.body as { magic_link_token: string }).magic_link_token;
    expect(db.rows[0].email_verified).toBe(false);

    await handleMagicLinkVerify(d, { token });
    expect(db.rows[0].email_verified).toBe(true);
  });

  it('the SAME response that performs the verification already reflects email_verified: true (not stale)', async () => {
    const db = createFakeDb();
    const d = deps({ db });
    const req = await handleMagicLinkRequest(d, { email: 'asha@example.com' });
    const token = (req.body as { magic_link_token: string }).magic_link_token;

    const r = await handleMagicLinkVerify(d, { token });
    const body = r.body as { user: { email_verified: boolean } };
    expect(body.user.email_verified).toBe(true);
  });

  it('redirects with tokens in the URL fragment when redirect_to is given', async () => {
    const db = createFakeDb();
    const d = deps({ db });
    const req = await handleMagicLinkRequest(d, { email: 'asha@example.com' });
    const token = (req.body as { magic_link_token: string }).magic_link_token;

    const r = await handleMagicLinkVerify(d, { token, redirect_to: 'https://app.example.tz' });
    expect(r.status).toBe(302);
    expect(r.redirect).toMatch(/^https:\/\/app\.example\.tz#/);
    const fragment = new URLSearchParams(r.redirect!.split('#')[1]);
    expect(fragment.get('access_token')).toBeTruthy();
  });

  it('400s on a redirect_to not on the allow-list, without consuming the token', async () => {
    const db = createFakeDb();
    const d = deps({ db });
    const req = await handleMagicLinkRequest(d, { email: 'asha@example.com' });
    const token = (req.body as { magic_link_token: string }).magic_link_token;

    const bad = await handleMagicLinkVerify(d, { token, redirect_to: 'https://evil.example.com' });
    expect(bad.status).toBe(400);
    expect(db.magicLinkTokens[0].used_at).toBeNull();

    // The token is still valid afterwards (not burned by the rejected redirect).
    const ok = await handleMagicLinkVerify(d, { token });
    expect(ok.status).toBe(200);
  });

  it('400s on a missing token', async () => {
    const r = await handleMagicLinkVerify(deps(), {});
    expect(r.status).toBe(400);
  });

  it('400s on an unknown token', async () => {
    const r = await handleMagicLinkVerify(deps(), { token: 'bogus' });
    expect(r.status).toBe(400);
  });

  it('400s when the same token is used twice (single-use)', async () => {
    const db = createFakeDb();
    const d = deps({ db });
    const req = await handleMagicLinkRequest(d, { email: 'asha@example.com' });
    const token = (req.body as { magic_link_token: string }).magic_link_token;

    const first = await handleMagicLinkVerify(d, { token });
    expect(first.status).toBe(200);
    const second = await handleMagicLinkVerify(d, { token });
    expect(second.status).toBe(400);
  });

  it('400s on an expired token', async () => {
    const db = createFakeDb();
    const d = deps({ db, magicLinkExpiry: -1 }); // already expired on issue
    const req = await handleMagicLinkRequest(d, { email: 'asha@example.com' });
    const token = (req.body as { magic_link_token: string }).magic_link_token;

    const r = await handleMagicLinkVerify(d, { token });
    expect(r.status).toBe(400);
  });
});
