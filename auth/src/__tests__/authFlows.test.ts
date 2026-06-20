// Deepened auth: refresh rotation + reuse-detection, logout revocation,
// password forgot→reset (+ refresh revocation), email verify request→confirm.
// All hermetic — fake Db only, no Postgres.

import { describe, it, expect } from 'vitest';
import {
  handleSignup,
  handleToken,
  handleAnonymous,
  handleRefresh,
  handleLogout,
  handlePasswordForgot,
  handlePasswordReset,
  handleEmailVerifyRequest,
  handleEmailVerifyConfirm,
  type HandlerDeps,
} from '../handlers.js';
import { createFakeDb } from './fakeDb.js';

const SECRET = 'r'.repeat(40);

function deps(over?: Partial<HandlerDeps>): HandlerDeps & {
  db: ReturnType<typeof createFakeDb>;
} {
  const db = createFakeDb();
  return {
    db,
    jwtSecret: SECRET,
    jwtExpiry: 3600,
    refreshExpiry: 60 * 60 * 24 * 30,
    resetExpiry: 3600,
    emailVerifyExpiry: 3600,
    resetDelivery: 'log',
    emailDelivery: 'log',
    ...over,
  } as HandlerDeps & { db: ReturnType<typeof createFakeDb> };
}

describe('signup/token issue refresh tokens', () => {
  it('signup returns access + refresh token (still backward-compatible shape)', async () => {
    const d = deps();
    const r = await handleSignup(d, { username: 'asha', password: 'siri1234' });
    expect(r.status).toBe(201);
    const b = r.body as any;
    expect(b.access_token).toBeTruthy();
    expect(b.refresh_token).toBeTruthy();
    expect(b.token_type).toBe('bearer');
    expect(b.expires_in).toBe(3600);
    expect(b.user.username).toBe('asha');
    expect(b.user.email).toBeNull();
    expect(b.user.email_verified).toBe(false);
    expect(d.db.refreshTokens.length).toBe(1);
  });

  it('anonymous also gets a refresh token', async () => {
    const d = deps();
    const r = await handleAnonymous(d);
    expect((r.body as any).refresh_token).toBeTruthy();
  });

  it('signup accepts optional email + rejects duplicate email', async () => {
    const d = deps();
    const r1 = await handleSignup(d, {
      username: 'neema',
      password: 'siri1234',
      email: 'Neema@Example.com',
    });
    expect(r1.status).toBe(201);
    expect((r1.body as any).user.email).toBe('neema@example.com');

    const r2 = await handleSignup(d, {
      username: 'other',
      password: 'siri1234',
      email: 'neema@example.com',
    });
    expect(r2.status).toBe(409);
  });

  it('invalid email → 400', async () => {
    const d = deps();
    const r = await handleSignup(d, {
      username: 'juma',
      password: 'siri1234',
      email: 'not-an-email',
    });
    expect(r.status).toBe(400);
  });
});

describe('refresh: rotation + reuse-detection', () => {
  it('valid refresh → new access + rotated refresh, old token revoked', async () => {
    const d = deps();
    const signup = await handleSignup(d, { username: 'asha', password: 'siri1234' });
    const rt1 = (signup.body as any).refresh_token;

    const r = await handleRefresh(d, { refresh_token: rt1 });
    expect(r.status).toBe(200);
    const rt2 = (r.body as any).refresh_token;
    expect(rt2).toBeTruthy();
    expect(rt2).not.toBe(rt1);
    expect((r.body as any).access_token).toBeTruthy();

    // The old one is now revoked.
    const old = d.db.refreshTokens.find((t) => t.token_hash !== undefined && t.revoked_at);
    expect(old).toBeTruthy();
  });

  it('rotated tokens stay in the same family', async () => {
    const d = deps();
    const signup = await handleSignup(d, { username: 'asha', password: 'siri1234' });
    const rt1 = (signup.body as any).refresh_token;
    await handleRefresh(d, { refresh_token: rt1 });
    const families = new Set(d.db.refreshTokens.map((t) => t.family_id));
    expect(families.size).toBe(1);
  });

  it('reusing an already-rotated (revoked) token revokes the WHOLE family', async () => {
    const d = deps();
    const signup = await handleSignup(d, { username: 'asha', password: 'siri1234' });
    const rt1 = (signup.body as any).refresh_token;

    const r2 = await handleRefresh(d, { refresh_token: rt1 }); // rotate
    const rt2 = (r2.body as any).refresh_token;

    // Attacker replays the old token.
    const reuse = await handleRefresh(d, { refresh_token: rt1 });
    expect(reuse.status).toBe(401);

    // Family is now fully revoked → even the legit current token is dead.
    const legit = await handleRefresh(d, { refresh_token: rt2 });
    expect(legit.status).toBe(401);
    expect(d.db.refreshTokens.every((t) => t.revoked_at)).toBe(true);
  });

  it('unknown / empty refresh token → 401', async () => {
    const d = deps();
    expect((await handleRefresh(d, { refresh_token: 'nope' })).status).toBe(401);
    expect((await handleRefresh(d, {})).status).toBe(401);
  });

  it('expired refresh token → 401', async () => {
    const d = deps({ refreshExpiry: -10 }); // already expired on issue
    const signup = await handleSignup(d, { username: 'asha', password: 'siri1234' });
    const rt = (signup.body as any).refresh_token;
    expect((await handleRefresh(d, { refresh_token: rt })).status).toBe(401);
  });
});

describe('logout: revocation', () => {
  it('revokes the presented refresh token + family; refresh then fails', async () => {
    const d = deps();
    const signup = await handleSignup(d, { username: 'asha', password: 'siri1234' });
    const rt = (signup.body as any).refresh_token;

    const out = await handleLogout(d, { refresh_token: rt });
    expect(out.status).toBe(200);

    expect((await handleRefresh(d, { refresh_token: rt })).status).toBe(401);
    expect(d.db.refreshTokens.every((t) => t.revoked_at)).toBe(true);
  });

  it('logout without/with bad token still 200 (idempotent, no leak)', async () => {
    const d = deps();
    expect((await handleLogout(d, {})).status).toBe(200);
    expect((await handleLogout(d, { refresh_token: 'ghost' })).status).toBe(200);
  });
});

describe('password forgot → reset', () => {
  it('forgot returns reset_token in log mode; reset sets new password', async () => {
    const d = deps();
    await handleSignup(d, { username: 'asha', password: 'siri1234' });

    const forgot = await handlePasswordForgot(d, { username: 'asha' });
    expect(forgot.status).toBe(200);
    const token = (forgot.body as any).reset_token;
    expect(token).toBeTruthy();

    const reset = await handlePasswordReset(d, { token, password: 'mpyaSiri9' });
    expect(reset.status).toBe(200);

    // Old password fails, new password works.
    expect((await handleToken(d, { username: 'asha', password: 'siri1234' })).status).toBe(401);
    expect((await handleToken(d, { username: 'asha', password: 'mpyaSiri9' })).status).toBe(200);
  });

  it('reset revokes ALL of the user refresh tokens', async () => {
    const d = deps();
    const signup = await handleSignup(d, { username: 'asha', password: 'siri1234' });
    const rt = (signup.body as any).refresh_token;

    const forgot = await handlePasswordForgot(d, { username: 'asha' });
    const token = (forgot.body as any).reset_token;
    await handlePasswordReset(d, { token, password: 'mpyaSiri9' });

    expect((await handleRefresh(d, { refresh_token: rt })).status).toBe(401);
  });

  it('reset token is single-use', async () => {
    const d = deps();
    await handleSignup(d, { username: 'asha', password: 'siri1234' });
    const token = (await handlePasswordForgot(d, { username: 'asha' }).then(
      (r) => (r.body as any).reset_token
    )) as string;

    expect((await handlePasswordReset(d, { token, password: 'mpyaSiri9' })).status).toBe(200);
    expect((await handlePasswordReset(d, { token, password: 'tenaSiri9' })).status).toBe(400);
  });

  it('forgot for unknown user → generic 200 with no token (no enumeration)', async () => {
    const d = deps();
    const r = await handlePasswordForgot(d, { username: 'hewa' });
    expect(r.status).toBe(200);
    expect((r.body as any).reset_token).toBeUndefined();
  });

  it("forgot in 'email' mode does NOT return the token", async () => {
    const d = deps({ resetDelivery: 'email' });
    await handleSignup(d, { username: 'asha', password: 'siri1234' });
    const r = await handlePasswordForgot(d, { username: 'asha' });
    expect(r.status).toBe(200);
    expect((r.body as any).reset_token).toBeUndefined();
    expect(d.db.resetTokens.length).toBe(1); // token still issued + stored
  });

  it('reset with bad token → 400', async () => {
    const d = deps();
    expect((await handlePasswordReset(d, { token: 'x', password: 'mpyaSiri9' })).status).toBe(400);
  });
});

describe('email verify request → confirm', () => {
  it('request issues a token; confirm marks email verified', async () => {
    const d = deps();
    const signup = await handleSignup(d, {
      username: 'asha',
      password: 'siri1234',
      email: 'asha@example.com',
    });
    const access = (signup.body as any).access_token;

    const req = await handleEmailVerifyRequest(d, `Bearer ${access}`);
    expect(req.status).toBe(200);
    const token = (req.body as any).verification_token;
    expect(token).toBeTruthy();

    const confirm = await handleEmailVerifyConfirm(d, { token });
    expect(confirm.status).toBe(200);
    expect(d.db.rows[0].email_verified).toBe(true);
  });

  it('verification token is single-use', async () => {
    const d = deps();
    const signup = await handleSignup(d, {
      username: 'asha',
      password: 'siri1234',
      email: 'asha@example.com',
    });
    const access = (signup.body as any).access_token;
    const token = (await handleEmailVerifyRequest(d, `Bearer ${access}`).then(
      (r) => (r.body as any).verification_token
    )) as string;

    expect((await handleEmailVerifyConfirm(d, { token })).status).toBe(200);
    expect((await handleEmailVerifyConfirm(d, { token })).status).toBe(400);
  });

  it('request without bearer → 401', async () => {
    const d = deps();
    expect((await handleEmailVerifyRequest(d, undefined)).status).toBe(401);
  });

  it('request when user has no email → 400', async () => {
    const d = deps();
    const signup = await handleSignup(d, { username: 'asha', password: 'siri1234' });
    const access = (signup.body as any).access_token;
    expect((await handleEmailVerifyRequest(d, `Bearer ${access}`)).status).toBe(400);
  });

  it('confirm with bad token → 400', async () => {
    const d = deps();
    expect((await handleEmailVerifyConfirm(d, { token: 'nope' })).status).toBe(400);
  });
});

describe('backward compatibility: username + anonymous still work', () => {
  it('username login still issues a working session', async () => {
    const d = deps();
    await handleSignup(d, { username: 'juma', password: 'siri1234' });
    const r = await handleToken(d, { username: 'juma', password: 'siri1234' });
    expect(r.status).toBe(200);
    expect((r.body as any).access_token).toBeTruthy();
    expect((r.body as any).refresh_token).toBeTruthy();
  });

  it('anonymous user can refresh', async () => {
    const d = deps();
    const anon = await handleAnonymous(d);
    const rt = (anon.body as any).refresh_token;
    const r = await handleRefresh(d, { refresh_token: rt });
    expect(r.status).toBe(200);
    expect((r.body as any).user.is_anonymous).toBe(true);
  });
});
