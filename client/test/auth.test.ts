import { describe, it, expect, vi } from 'vitest';
import { createClient } from '../src/index';
import { memoryStorage } from '../src/storage';
import { makeFetch, baseOpts, makeJwt } from './helpers';

const URL = 'https://data.laetoli.tz';
const STORAGE_KEY = 'laetoli-data:token';

describe('auth.signUp', () => {
  it('POSTs /auth/signup and stores the token', async () => {
    const storage = memoryStorage();
    const token = makeJwt({ sub: 'u1', role: 'authenticated', exp: 9999999999 });
    const { fn, calls } = makeFetch([{ status: 201, json: { access_token: token, user: { id: 'u1', username: 'naim' } } }]);
    const c = createClient(URL, { fetch: fn, storage });

    const { data, error } = await c.auth.signUp({ username: 'naim', password: 'pw' });
    expect(error).toBeNull();
    expect(calls[0].url).toBe(`${URL}/auth/signup`);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ username: 'naim', password: 'pw' });
    expect(data.user?.id).toBe('u1');
    expect(data.session?.access_token).toBe(token);
    expect(storage.getItem(STORAGE_KEY)).toBe(token);
  });
});

describe('auth.signInWithPassword', () => {
  it('POSTs /auth/token and persists token; REST then attaches bearer', async () => {
    const storage = memoryStorage();
    const token = makeJwt({ sub: 'u2', role: 'authenticated' });
    const { fn, calls } = makeFetch([
      { json: { access_token: token, user: { id: 'u2' } } },
      { json: [] }, // the from() call
    ]);
    const c = createClient(URL, { fetch: fn, storage });

    await c.auth.signInWithPassword({ username: 'a', password: 'b' });
    expect(calls[0].url).toBe(`${URL}/auth/token`);
    expect(storage.getItem(STORAGE_KEY)).toBe(token);

    await c.from('works').select();
    expect(calls[1].headers['Authorization']).toBe(`Bearer ${token}`);
  });
});

describe('auth.signInAnonymously', () => {
  it('POSTs /auth/anonymous with empty body and stores token', async () => {
    const storage = memoryStorage();
    const token = makeJwt({ sub: 'anon1', role: 'anon', is_anonymous: true });
    const { fn, calls } = makeFetch([{ json: { access_token: token } }]);
    const c = createClient(URL, { fetch: fn, storage });

    const { data } = await c.auth.signInAnonymously();
    expect(calls[0].url).toBe(`${URL}/auth/anonymous`);
    expect(calls[0].body).toEqual({});
    expect(data.session?.user?.is_anonymous).toBe(true);
    expect(storage.getItem(STORAGE_KEY)).toBe(token);
  });
});

describe('auth.getUser', () => {
  it('returns null user when not signed in (no request)', async () => {
    const { fn, calls } = makeFetch([]);
    const c = createClient(URL, baseOpts(fn));
    const { data } = await c.auth.getUser();
    expect(data.user).toBeNull();
    expect(calls.length).toBe(0);
  });

  it('GETs /auth/user with bearer when signed in', async () => {
    const storage = memoryStorage();
    const token = makeJwt({ sub: 'u3' });
    storage.setItem(STORAGE_KEY, token);
    const { fn, calls } = makeFetch([{ json: { user: { id: 'u3', username: 'x' } } }]);
    const c = createClient(URL, { fetch: fn, storage });

    const { data } = await c.auth.getUser();
    expect(calls[0].url).toBe(`${URL}/auth/user`);
    expect(calls[0].headers['Authorization']).toBe(`Bearer ${token}`);
    expect(data.user?.id).toBe('u3');
  });
});

describe('auth.signOut', () => {
  it('clears the token and unsets the bearer on later requests', async () => {
    const storage = memoryStorage();
    const token = makeJwt({ sub: 'u4' });
    storage.setItem(STORAGE_KEY, token);
    const { fn, calls } = makeFetch([{ json: {} }, { json: [] }]);
    const c = createClient(URL, { fetch: fn, storage });

    await c.auth.signOut();
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
    expect(calls[0].url).toBe(`${URL}/auth/logout`);

    await c.from('works').select();
    expect(calls[1].headers['Authorization']).toBeUndefined();
  });
});

describe('auth.onAuthStateChange', () => {
  it('emits INITIAL_SESSION then SIGNED_IN / SIGNED_OUT', async () => {
    const storage = memoryStorage();
    const token = makeJwt({ sub: 'u5', role: 'authenticated' });
    const { fn } = makeFetch([{ json: { access_token: token, user: { id: 'u5' } } }, { json: {} }]);
    const c = createClient(URL, { fetch: fn, storage });

    const events: string[] = [];
    const { data } = c.auth.onAuthStateChange((e) => events.push(e));
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(events).toContain('INITIAL_SESSION');

    await c.auth.signInWithPassword({ username: 'a', password: 'b' });
    expect(events).toContain('SIGNED_IN');

    await c.auth.signOut();
    expect(events).toContain('SIGNED_OUT');

    data.subscription.unsubscribe();
    const before = events.length;
    await c.auth.signInAnonymously().catch(() => {});
    // After unsubscribe, no further events for this listener.
    expect(events.length).toBe(before);
  });
});

describe('auth error handling', () => {
  it('maps a failed login to an error envelope and does not store a token', async () => {
    const storage = memoryStorage();
    const { fn } = makeFetch([{ status: 401, statusText: 'Unauthorized', json: { message: 'bad creds' } }]);
    const c = createClient(URL, { fetch: fn, storage });
    const { data, error } = await c.auth.signInWithPassword({ username: 'a', password: 'wrong' });
    expect(data.session).toBeNull();
    expect(error?.message).toBe('bad creds');
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });
});

describe('apikey + headers', () => {
  it('sends apikey header on rest + auth and uses it as anon bearer', async () => {
    const { fn, calls } = makeFetch([{ json: [] }]);
    const c = createClient(URL, baseOpts(fn, { apikey: 'anon-key', headers: { 'x-app': 'kasuku' } }));
    await c.from('works').select();
    expect(calls[0].headers['apikey']).toBe('anon-key');
    expect(calls[0].headers['x-app']).toBe('kasuku');
    // No session → anon apikey used as the bearer.
    expect(calls[0].headers['Authorization']).toBe('Bearer anon-key');
  });
});

describe('createClient validation', () => {
  it('throws a clear error when no fetch is available', () => {
    const orig = globalThis.fetch;
    // @ts-expect-error force-remove for the test
    delete globalThis.fetch;
    try {
      expect(() => createClient(URL)).toThrow(/no global fetch/);
    } finally {
      globalThis.fetch = orig;
    }
  });

  it('strips a trailing slash from the base url', async () => {
    const { fn, calls } = makeFetch([{ json: [] }]);
    const c = createClient(`${URL}/`, baseOpts(fn));
    await c.from('works').select();
    expect(calls[0].url.startsWith(`${URL}/rest/works`)).toBe(true);
    expect(calls[0].url).not.toContain('//rest');
  });
});

// keep vi import used even if a test is trimmed
void vi;
