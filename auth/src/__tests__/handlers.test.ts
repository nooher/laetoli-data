import { describe, it, expect } from 'vitest';
import {
  handleSignup,
  handleToken,
  handleAnonymous,
  handleGetUser,
  type HandlerDeps,
} from '../handlers.js';
import { createFakeDb } from './fakeDb.js';
import { issueAccessToken } from '../jwt.js';

const SECRET = 's'.repeat(40);

function deps(): HandlerDeps {
  return { db: createFakeDb(), jwtSecret: SECRET, jwtExpiry: 3600 };
}

describe('handleSignup', () => {
  it('happy path: creates user, returns token, no password_hash', async () => {
    const d = deps();
    const r = await handleSignup(d, { username: 'asha', password: 'siri1234' });
    expect(r.status).toBe(201);
    const body = r.body as any;
    expect(body.user.username).toBe('asha');
    expect(body.user.is_anonymous).toBe(false);
    expect(body.user.id).toBeTruthy();
    expect(body.user.password_hash).toBeUndefined();
    expect(typeof body.access_token).toBe('string');
  });

  it('duplicate username → 409', async () => {
    const d = deps();
    await handleSignup(d, { username: 'asha', password: 'siri1234' });
    const r = await handleSignup(d, { username: 'asha', password: 'nyingine9' });
    expect(r.status).toBe(409);
  });

  it('concurrent unique-violation also → 409', async () => {
    const db = createFakeDb();
    const d: HandlerDeps = { db, jwtSecret: SECRET, jwtExpiry: 3600 };
    db.failNextCreateWithUniqueViolation();
    const r = await handleSignup(d, { username: 'asha', password: 'siri1234' });
    expect(r.status).toBe(409);
  });

  it('invalid input → 400 Kiswahili', async () => {
    const d = deps();
    const r = await handleSignup(d, { username: 'a', password: 'siri1234' });
    expect(r.status).toBe(400);
    expect((r.body as any).error).toMatch(/Jina/);
  });
});

describe('handleToken', () => {
  it('valid creds → 200 + token', async () => {
    const d = deps();
    await handleSignup(d, { username: 'juma', password: 'siri1234' });
    const r = await handleToken(d, { username: 'juma', password: 'siri1234' });
    expect(r.status).toBe(200);
    expect((r.body as any).access_token).toBeTruthy();
  });

  it('wrong password → 401', async () => {
    const d = deps();
    await handleSignup(d, { username: 'juma', password: 'siri1234' });
    const r = await handleToken(d, { username: 'juma', password: 'baya0000' });
    expect(r.status).toBe(401);
  });

  it('unknown user → 401', async () => {
    const d = deps();
    const r = await handleToken(d, { username: 'hewa', password: 'siri1234' });
    expect(r.status).toBe(401);
  });

  it('missing fields → 401 (no leak)', async () => {
    const d = deps();
    const r = await handleToken(d, {});
    expect(r.status).toBe(401);
  });
});

describe('handleAnonymous', () => {
  it('issues an anonymous user + token', async () => {
    const d = deps();
    const r = await handleAnonymous(d);
    expect(r.status).toBe(201);
    const body = r.body as any;
    expect(body.user.is_anonymous).toBe(true);
    expect(body.user.username).toBeNull();
    expect(body.access_token).toBeTruthy();
  });
});

describe('handleGetUser', () => {
  it('valid bearer → 200 with user', async () => {
    const d = deps();
    const signup = await handleSignup(d, {
      username: 'asha',
      password: 'siri1234',
    });
    const token = (signup.body as any).access_token;
    const r = await handleGetUser(d, `Bearer ${token}`);
    expect(r.status).toBe(200);
    expect((r.body as any).user.username).toBe('asha');
    expect((r.body as any).user.password_hash).toBeUndefined();
  });

  it('missing header → 401', async () => {
    expect((await handleGetUser(deps(), undefined)).status).toBe(401);
  });

  it('invalid token → 401', async () => {
    expect((await handleGetUser(deps(), 'Bearer garbage')).status).toBe(401);
  });

  it('valid signature but unknown sub → 401', async () => {
    const d = deps();
    const token = issueAccessToken('nonexistent-id', {
      secret: SECRET,
      expirySeconds: 60,
    });
    const r = await handleGetUser(d, `Bearer ${token}`);
    expect(r.status).toBe(401);
  });
});
