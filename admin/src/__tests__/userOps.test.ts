import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { createFakeDb, type FakeDb } from './fakeDb.js';

const KEY = 'k'.repeat(40);

function app(over: { db?: FakeDb; authFetch?: typeof fetch } = {}) {
  return createApp({
    db: over.db ?? createFakeDb(),
    adminApiKey: KEY,
    authInternalUrl: 'http://auth:9999',
    authFetch: over.authFetch,
  });
}

function auth(req: request.Test) {
  return req.set('Authorization', `Bearer ${KEY}`);
}

describe('POST /users/invite', () => {
  it('proxies to the auth service /magiclink and returns invited:true', async () => {
    const authFetch = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('http://auth:9999/magiclink');
      expect(JSON.parse(init!.body as string)).toEqual({
        email: 'asha@example.com',
        redirect_to: undefined,
      });
      return new Response(JSON.stringify({ message: 'ok' }), { status: 200 });
    }) as unknown as typeof fetch;

    const res = await auth(
      request(app({ authFetch })).post('/users/invite').send({ email: 'asha@example.com' })
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ invited: true, email: 'asha@example.com' });
    expect(authFetch).toHaveBeenCalledTimes(1);
  });

  it('passes redirect_to through when given', async () => {
    const authFetch = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(init!.body as string).redirect_to).toBe('https://app.example.tz/welcome');
      return new Response(JSON.stringify({ message: 'ok' }), { status: 200 });
    }) as unknown as typeof fetch;

    const res = await auth(
      request(app({ authFetch }))
        .post('/users/invite')
        .send({ email: 'asha@example.com', redirect_to: 'https://app.example.tz/welcome' })
    );
    expect(res.status).toBe(200);
  });

  it('400s on a missing email (never calls the auth service)', async () => {
    const authFetch = vi.fn();
    const res = await auth(
      request(app({ authFetch: authFetch as unknown as typeof fetch })).post('/users/invite').send({})
    );
    expect(res.status).toBe(400);
    expect(authFetch).not.toHaveBeenCalled();
  });

  it('surfaces the auth service\'s own error + status (e.g. invalid email)', async () => {
    const authFetch = vi.fn(async () => new Response(JSON.stringify({ error: 'Barua pepe si sahihi.' }), { status: 400 })) as unknown as typeof fetch;
    const res = await auth(
      request(app({ authFetch })).post('/users/invite').send({ email: 'not-an-email' })
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Barua pepe si sahihi.');
  });

  it('502s when the auth service is unreachable', async () => {
    const authFetch = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const res = await auth(
      request(app({ authFetch })).post('/users/invite').send({ email: 'asha@example.com' })
    );
    expect(res.status).toBe(502);
  });

  it('requires the admin key like every other route', async () => {
    const res = await request(app()).post('/users/invite').send({ email: 'asha@example.com' });
    expect(res.status).toBe(401);
  });
});

describe('POST /users/:id/suspend', () => {
  it('suspends a user AND revokes their existing sessions in the same call', async () => {
    const db = createFakeDb();
    expect(db.refreshTokenCounts.get('u1')).toBe(2); // seeded

    const res = await auth(request(app({ db })).post('/users/u1/suspend').send({}));
    expect(res.status).toBe(200);
    expect(res.body.suspended).toBe(true);
    expect(res.body.suspended_at).toBeTruthy();
    expect(res.body.sessions_revoked).toBe(2);
    expect(db.refreshTokenCounts.get('u1')).toBe(0);
  });

  it('unsuspends with { suspend: false } and does NOT revoke sessions', async () => {
    const db = createFakeDb();
    await auth(request(app({ db })).post('/users/u1/suspend').send({}));
    const res = await auth(request(app({ db })).post('/users/u1/suspend').send({ suspend: false }));
    expect(res.status).toBe(200);
    expect(res.body.suspended).toBe(false);
    expect(res.body.suspended_at).toBeNull();
    expect(res.body.sessions_revoked).toBe(0);
  });

  it('404s for an unknown user id', async () => {
    const res = await auth(request(app()).post('/users/does-not-exist/suspend').send({}));
    expect(res.status).toBe(404);
  });
});

describe('POST /users/:id/revoke-sessions', () => {
  it('revokes all sessions and reports the count, without touching suspension', async () => {
    const db = createFakeDb();
    const res = await auth(request(app({ db })).post('/users/u1/revoke-sessions'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'u1', sessions_revoked: 2 });

    const users = await auth(request(app({ db })).get('/auth/users'));
    const u1 = users.body.users.find((u: { id: string }) => u.id === 'u1');
    expect(u1.suspended_at).toBeNull();
  });

  it('a user with no active sessions reports 0, not an error', async () => {
    const res = await auth(request(app()).post('/users/u2/revoke-sessions'));
    expect(res.status).toBe(200);
    expect(res.body.sessions_revoked).toBe(0);
  });
});

describe('POST /users/:id/reset-mfa', () => {
  it('removes enrolled factors and reports the count', async () => {
    const db = createFakeDb();
    expect(db.mfaFactorCounts.get('u1')).toBe(1);
    const res = await auth(request(app({ db })).post('/users/u1/reset-mfa'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: 'u1', factors_removed: 1 });
    expect(db.mfaFactorCounts.get('u1')).toBe(0);
  });
});
