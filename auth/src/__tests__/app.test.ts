import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { createFakeDb } from './fakeDb.js';
import { createRateLimiter } from '../ratelimit.js';

const SECRET = 'h'.repeat(40);

function app(extra?: { max?: number }) {
  return createApp({
    db: createFakeDb(),
    jwtSecret: SECRET,
    jwtExpiry: 3600,
    limiter: createRateLimiter({ windowMs: 60_000, max: extra?.max ?? 1000 }),
  });
}

describe('HTTP routes (supertest, fake Db)', () => {
  it('GET /health → ok', async () => {
    const res = await request(app()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('full flow: signup → /user with returned token', async () => {
    const a = app();
    const signup = await request(a)
      .post('/signup')
      .send({ username: 'neema', password: 'siri1234' });
    expect(signup.status).toBe(201);
    const token = signup.body.access_token;

    const me = await request(a)
      .get('/user')
      .set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.user.username).toBe('neema');
  });

  it('POST /token bad creds → 401', async () => {
    const a = app();
    await request(a).post('/signup').send({ username: 'x9', password: 'siri1234' });
    const res = await request(a)
      .post('/token')
      .send({ username: 'x9', password: 'wrongpass' });
    expect(res.status).toBe(401);
  });

  it('POST /anonymous → 201 token', async () => {
    const res = await request(app()).post('/anonymous').send();
    expect(res.status).toBe(201);
    expect(res.body.user.is_anonymous).toBe(true);
    expect(res.body.access_token).toBeTruthy();
  });

  it('GET /user without token → 401', async () => {
    const res = await request(app()).get('/user');
    expect(res.status).toBe(401);
  });

  it('rate limiter returns 429 when exceeded', async () => {
    const a = app({ max: 1 });
    await request(a).post('/anonymous').send(); // allowed
    const blocked = await request(a).post('/anonymous').send(); // over limit
    expect(blocked.status).toBe(429);
  });

  it('full flow: signup → /refresh → rotated token works, old fails', async () => {
    const a = app();
    const signup = await request(a)
      .post('/signup')
      .send({ username: 'rafiki', password: 'siri1234' });
    const rt1 = signup.body.refresh_token;
    expect(rt1).toBeTruthy();

    const refreshed = await request(a).post('/refresh').send({ refresh_token: rt1 });
    expect(refreshed.status).toBe(200);
    const rt2 = refreshed.body.refresh_token;
    expect(rt2).not.toBe(rt1);

    // Reuse of rt1 now fails (revoked).
    const reuse = await request(a).post('/refresh').send({ refresh_token: rt1 });
    expect(reuse.status).toBe(401);
  });

  it('POST /logout revokes the refresh token', async () => {
    const a = app();
    const signup = await request(a)
      .post('/signup')
      .send({ username: 'tatu', password: 'siri1234' });
    const rt = signup.body.refresh_token;

    const out = await request(a).post('/logout').send({ refresh_token: rt });
    expect(out.status).toBe(200);

    const after = await request(a).post('/refresh').send({ refresh_token: rt });
    expect(after.status).toBe(401);
  });

  it('POST /password/forgot → /password/reset over HTTP', async () => {
    const a = app();
    await request(a).post('/signup').send({ username: 'wema', password: 'siri1234' });
    const forgot = await request(a).post('/password/forgot').send({ username: 'wema' });
    expect(forgot.status).toBe(200);
    const token = forgot.body.reset_token;
    expect(token).toBeTruthy();
    const reset = await request(a)
      .post('/password/reset')
      .send({ token, password: 'mpyaSiri9' });
    expect(reset.status).toBe(200);
    const login = await request(a)
      .post('/token')
      .send({ username: 'wema', password: 'mpyaSiri9' });
    expect(login.status).toBe(200);
  });

  it('unknown route → 404 JSON', async () => {
    const res = await request(app()).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.error).toBeTruthy();
  });

  it('malformed JSON → 400', async () => {
    const res = await request(app())
      .post('/signup')
      .set('Content-Type', 'application/json')
      .send('{not json');
    expect(res.status).toBe(400);
  });
});
