// Account suspension (auth.users.suspended_at) — set by the admin service,
// enforced here on every token-ISSUING path. Hermetic — fake Db only.

import { describe, it, expect } from 'vitest';
import {
  handleToken,
  handleRefresh,
  handleOtpVerify,
  handleOtpRequest,
  handleMagicLinkRequest,
  handleMagicLinkVerify,
  type HandlerDeps,
} from '../handlers.js';
import { createFakeDb } from './fakeDb.js';
import { hashPassword } from '../password.js';

const SECRET = 'z'.repeat(40);

function deps(over: Partial<HandlerDeps> = {}): HandlerDeps & { db: ReturnType<typeof createFakeDb> } {
  const db = createFakeDb();
  return { db, jwtSecret: SECRET, jwtExpiry: 3600, ...over } as HandlerDeps & {
    db: ReturnType<typeof createFakeDb>;
  };
}

describe('suspended account — password login', () => {
  it('blocks a login with correct credentials once suspended (403, not the generic 401)', async () => {
    const d = deps();
    const passwordHash = await hashPassword('correct horse');
    await d.db.createUser({ username: 'asha', passwordHash });
    d.db.rows[0].suspended_at = new Date().toISOString();

    const r = await handleToken(d, { username: 'asha', password: 'correct horse' });
    expect(r.status).toBe(403);
  });

  it('an active (non-suspended) account still logs in normally', async () => {
    const d = deps();
    const passwordHash = await hashPassword('correct horse');
    await d.db.createUser({ username: 'asha', passwordHash });

    const r = await handleToken(d, { username: 'asha', password: 'correct horse' });
    expect(r.status).toBe(200);
  });
});

describe('suspended account — refresh', () => {
  it('a suspension mid-session blocks the next refresh and kills the whole token family', async () => {
    const d = deps();
    const passwordHash = await hashPassword('correct horse');
    await d.db.createUser({ username: 'asha', passwordHash });
    const login = await handleToken(d, { username: 'asha', password: 'correct horse' });
    const refreshToken = (login.body as { refresh_token: string }).refresh_token;

    d.db.rows[0].suspended_at = new Date().toISOString();

    const r = await handleRefresh(d, { refresh_token: refreshToken });
    expect(r.status).toBe(403);

    // The family is dead — even presenting it again doesn't recover.
    const retry = await handleRefresh(d, { refresh_token: refreshToken });
    expect(retry.status).toBe(401);
  });
});

describe('suspended account — OTP / magic-link', () => {
  it('blocks OTP verify for a suspended phone account', async () => {
    const d = deps();
    const req = await handleOtpRequest(d, { phone: '0700000000' });
    const code = (req.body as { code: string }).code;
    d.db.rows[0].suspended_at = new Date().toISOString();

    const r = await handleOtpVerify(d, { phone: '0700000000', code });
    expect(r.status).toBe(403);
  });

  it('blocks magic-link verify for a suspended email account', async () => {
    const d = deps();
    const req = await handleMagicLinkRequest(d, { email: 'asha@example.com' });
    const token = (req.body as { magic_link_token: string }).magic_link_token;
    d.db.rows[0].suspended_at = new Date().toISOString();

    const r = await handleMagicLinkVerify(d, { token });
    expect(r.status).toBe(403);
  });
});
