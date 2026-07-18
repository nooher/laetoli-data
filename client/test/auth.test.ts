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

describe('auth.signInWithOAuth', () => {
  it('outside a browser (no window): returns the start URL without redirecting, requires redirectTo', () => {
    const { fn } = makeFetch();
    const c = createClient(URL, { fetch: fn, storage: memoryStorage() });

    const noRedirectTo = c.auth.signInWithOAuth({ provider: 'google' });
    expect(noRedirectTo.error?.code).toBe('no_redirect_to');

    const { data, error } = c.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: 'https://app.example.tz/callback' },
    });
    expect(error).toBeNull();
    expect(data?.provider).toBe('google');
    expect(data?.url).toBe(
      `${URL}/auth/oauth/google/start?redirect_to=${encodeURIComponent('https://app.example.tz/callback')}`
    );
  });

  it('in a browser: redirects window.location to the start URL by default', () => {
    const { fn } = makeFetch();
    const c = createClient(URL, { fetch: fn, storage: memoryStorage() });

    const assign = vi.fn();
    // @ts-expect-error — minimal window stub for this test only.
    globalThis.window = { location: { assign, href: 'https://app.example.tz/page' } };
    try {
      const { data } = c.auth.signInWithOAuth({ provider: 'google' });
      expect(assign).toHaveBeenCalledWith(data?.url);
      expect(data?.url).toContain(encodeURIComponent('https://app.example.tz/page'));
    } finally {
      // @ts-expect-error — cleanup the stub.
      delete globalThis.window;
    }
  });

  it('skipBrowserRedirect: true returns the URL without navigating', () => {
    const { fn } = makeFetch();
    const c = createClient(URL, { fetch: fn, storage: memoryStorage() });

    const assign = vi.fn();
    // @ts-expect-error — minimal window stub for this test only.
    globalThis.window = { location: { assign, href: 'https://app.example.tz/page' } };
    try {
      const { data } = c.auth.signInWithOAuth({
        provider: 'google',
        options: { skipBrowserRedirect: true },
      });
      expect(assign).not.toHaveBeenCalled();
      expect(data?.url).toBeTruthy();
    } finally {
      // @ts-expect-error — cleanup the stub.
      delete globalThis.window;
    }
  });
});

describe('auth.signInWithOtp', () => {
  it('POSTs /auth/magiclink with email + redirect_to (defaulting to window.location.href)', async () => {
    const { fn, calls } = makeFetch([{ status: 200, json: { message: 'ok' } }]);
    const c = createClient(URL, { fetch: fn, storage: memoryStorage() });

    // @ts-expect-error — minimal window stub for this test only.
    globalThis.window = { location: { href: 'https://app.example.tz/page' } };
    try {
      const { data, error } = await c.auth.signInWithOtp({ email: 'asha@example.com' });
      expect(error).toBeNull();
      expect(data).toEqual({});
      expect(calls[0].url).toBe(`${URL}/auth/magiclink`);
      expect(calls[0].body).toEqual({
        email: 'asha@example.com',
        redirect_to: 'https://app.example.tz/page',
      });
    } finally {
      // @ts-expect-error — cleanup the stub.
      delete globalThis.window;
    }
  });

  it('uses options.emailRedirectTo when given, and does not store a session (no token yet)', async () => {
    const storage = memoryStorage();
    const { fn, calls } = makeFetch([{ status: 200, json: { message: 'ok' } }]);
    const c = createClient(URL, { fetch: fn, storage });

    await c.auth.signInWithOtp({
      email: 'asha@example.com',
      options: { emailRedirectTo: 'https://app.example.tz/callback' },
    });
    expect(calls[0].body).toEqual({
      email: 'asha@example.com',
      redirect_to: 'https://app.example.tz/callback',
    });
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('maps a failed request to an error envelope', async () => {
    const { fn } = makeFetch([{ status: 400, json: { error: 'Barua pepe si sahihi.' } }]);
    const c = createClient(URL, { fetch: fn, storage: memoryStorage() });

    const { data, error } = await c.auth.signInWithOtp({ email: 'bad' });
    expect(data).toEqual({});
    expect(error?.message).toBe('Barua pepe si sahihi.');
  });
});

describe('detectSessionInUrl (OAuth callback landing)', () => {
  it('adopts #access_token=... from the URL on construction and cleans the fragment', () => {
    const storage = memoryStorage();
    const token = makeJwt({ sub: 'u3', role: 'authenticated' });
    const replaceState = vi.fn();
    // Cast (not @ts-expect-error): a multi-line stub object's "missing
    // Location/History properties" errors attribute to the NESTED lines, past
    // where a single directive on the assignment line could suppress them.
    globalThis.window = {
      location: {
        hash: `#access_token=${token}&refresh_token=r1&token_type=bearer&expires_in=3600`,
        pathname: '/callback',
        search: '',
      },
      history: { replaceState },
    } as unknown as Window & typeof globalThis;
    try {
      const { fn } = makeFetch();
      const c = createClient(URL, { fetch: fn, storage });
      expect(storage.getItem(STORAGE_KEY)).toBe(token);
      expect(replaceState).toHaveBeenCalledWith(null, '', '/callback');
      // Constructing the client itself does no network call.
      expect(fn).not.toHaveBeenCalled();
      void c;
    } finally {
      // @ts-expect-error — cleanup the stub.
      delete globalThis.window;
    }
  });

  it('is a no-op when there is no access_token in the hash', () => {
    const storage = memoryStorage();
    // @ts-expect-error — minimal window stub for this test only.
    globalThis.window = { location: { hash: '#other=1', pathname: '/', search: '' } };
    try {
      const { fn } = makeFetch();
      createClient(URL, { fetch: fn, storage });
      expect(storage.getItem(STORAGE_KEY)).toBeNull();
    } finally {
      // @ts-expect-error — cleanup the stub.
      delete globalThis.window;
    }
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

describe('auth.signUp / signInWithPassword — email-based identity (Supabase-compat)', () => {
  it('signUp({email, password}) derives a valid username and sends BOTH username + the real email', async () => {
    const { fn, calls } = makeFetch([{ status: 201, json: { access_token: makeJwt({ sub: 'u1' }), user: { id: 'u1' } } }]);
    const c = createClient(URL, { fetch: fn, storage: memoryStorage() });

    await c.auth.signUp({ email: 'Asha.Juma+clinic@Medicalincs.com', password: 'siri1234' });
    expect(calls[0].url).toBe(`${URL}/auth/signup`);
    const body = calls[0].body as { username: string; email: string; password: string };
    expect(body.email).toBe('Asha.Juma+clinic@Medicalincs.com');
    expect(body.username).toMatch(/^[a-z0-9][a-z0-9._-]{2,31}$/); // matches the server's USERNAME_RE
    expect(body.password).toBe('siri1234');
  });

  it('signUp options.data becomes the wire "metadata" field', async () => {
    const { fn, calls } = makeFetch([{ status: 201, json: { access_token: makeJwt({ sub: 'u1' }), user: { id: 'u1' } } }]);
    const c = createClient(URL, { fetch: fn, storage: memoryStorage() });

    await c.auth.signUp({
      email: 'asha@example.com',
      password: 'siri1234',
      options: { data: { full_name: 'Asha Juma', role: 'citizen' } },
    });
    const body = calls[0].body as { metadata: unknown };
    expect(body.metadata).toEqual({ full_name: 'Asha Juma', role: 'citizen' });
  });

  it('the SAME email derives the SAME username on signUp and a later signInWithPassword', async () => {
    const { fn, calls } = makeFetch([
      { status: 201, json: { access_token: makeJwt({ sub: 'u1' }), user: { id: 'u1' } } },
      { status: 200, json: { access_token: makeJwt({ sub: 'u1' }), user: { id: 'u1' } } },
    ]);
    const c = createClient(URL, { fetch: fn, storage: memoryStorage() });

    await c.auth.signUp({ email: 'asha@example.com', password: 'siri1234' });
    await c.auth.signInWithPassword({ email: 'asha@example.com', password: 'siri1234' });

    const signUpBody = calls[0].body as { username: string };
    const loginBody = calls[1].body as { username: string };
    expect(loginBody.username).toBe(signUpBody.username);
  });

  it('still accepts the native {username, password} shape unchanged', async () => {
    const { fn, calls } = makeFetch([{ status: 200, json: { access_token: makeJwt({ sub: 'u1' }), user: { id: 'u1' } } }]);
    const c = createClient(URL, { fetch: fn, storage: memoryStorage() });

    await c.auth.signInWithPassword({ username: 'asha_juma', password: 'siri1234' });
    const body = calls[0].body as { username: string; email?: string };
    expect(body.username).toBe('asha_juma');
    expect(body.email).toBeUndefined();
  });
});

describe('auth.getSession', () => {
  it('returns null when not signed in, with no network call', async () => {
    const { fn } = makeFetch();
    const c = createClient(URL, baseOpts(fn));
    const { data, error } = await c.auth.getSession();
    expect(error).toBeNull();
    expect(data.session).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it('returns the current session after signing in, with no network call', async () => {
    const { fn, calls } = makeFetch([{ json: { access_token: makeJwt({ sub: 'u1', role: 'authenticated' }), user: { id: 'u1' } } }]);
    const c = createClient(URL, baseOpts(fn));
    await c.auth.signInWithPassword({ username: 'a', password: 'b' });

    const before = calls.length;
    const { data } = await c.auth.getSession();
    expect(data.session?.user?.id).toBe('u1');
    expect(calls.length).toBe(before); // getSession made no new request
  });
});

describe('auth.mfa', () => {
  it('enroll() POSTs /auth/factors with the bearer and friendly_name', async () => {
    const token = makeJwt({ sub: 'u1', role: 'authenticated' });
    const { fn, calls } = makeFetch([
      { json: { access_token: token, user: { id: 'u1' } } },
      { json: { id: 'f1', type: 'totp', totp: { qr_code: 'data:...', secret: 'ABC', uri: 'otpauth://...' } } },
    ]);
    const c = createClient(URL, baseOpts(fn));
    await c.auth.signInWithPassword({ username: 'a', password: 'b' });

    const { data, error } = await c.auth.mfa.enroll({ friendlyName: 'My phone' });
    expect(error).toBeNull();
    expect(data?.id).toBe('f1');
    expect(calls[1].url).toBe(`${URL}/auth/factors`);
    expect(calls[1].method).toBe('POST');
    expect(calls[1].headers['Authorization']).toBe(`Bearer ${token}`);
    expect(calls[1].body).toEqual({ friendly_name: 'My phone' });
  });

  it('listFactors() GETs /auth/factors and returns {totp, all}', async () => {
    const token = makeJwt({ sub: 'u1', role: 'authenticated' });
    const { fn, calls } = makeFetch([
      { json: { access_token: token, user: { id: 'u1' } } },
      { json: { totp: [{ id: 'f1', status: 'verified', friendly_name: null, created_at: 'x' }], all: [] } },
    ]);
    const c = createClient(URL, baseOpts(fn));
    await c.auth.signInWithPassword({ username: 'a', password: 'b' });

    const { data } = await c.auth.mfa.listFactors();
    expect(data?.totp).toHaveLength(1);
    expect(calls[1].method).toBe('GET');
  });

  it('challenge() then verify() hit the right factor-scoped endpoints', async () => {
    const token = makeJwt({ sub: 'u1', role: 'authenticated' });
    const { fn, calls } = makeFetch([
      { json: { access_token: token, user: { id: 'u1' } } },
      { json: { id: 'c1', expires_at: '2026-01-01T00:00:00Z' } },
      { json: { id: 'f1', status: 'verified' } },
    ]);
    const c = createClient(URL, baseOpts(fn));
    await c.auth.signInWithPassword({ username: 'a', password: 'b' });

    const challenge = await c.auth.mfa.challenge({ factorId: 'f1' });
    expect(calls[1].url).toBe(`${URL}/auth/factors/f1/challenge`);
    expect(challenge.data?.id).toBe('c1');

    const verify = await c.auth.mfa.verify({ factorId: 'f1', challengeId: 'c1', code: '123456' });
    expect(calls[2].url).toBe(`${URL}/auth/factors/f1/verify`);
    expect(calls[2].body).toEqual({ challenge_id: 'c1', code: '123456' });
    expect(verify.data?.status).toBe('verified');
  });

  it('unenroll() DELETEs the factor', async () => {
    const token = makeJwt({ sub: 'u1', role: 'authenticated' });
    const { fn, calls } = makeFetch([
      { json: { access_token: token, user: { id: 'u1' } } },
      { json: { id: 'f1' } },
    ]);
    const c = createClient(URL, baseOpts(fn));
    await c.auth.signInWithPassword({ username: 'a', password: 'b' });

    const { data } = await c.auth.mfa.unenroll({ factorId: 'f1' });
    expect(calls[1].method).toBe('DELETE');
    expect(data?.id).toBe('f1');
  });

  it('surfaces a server error cleanly (e.g. 404 factor not found)', async () => {
    const token = makeJwt({ sub: 'u1', role: 'authenticated' });
    const { fn } = makeFetch([
      { json: { access_token: token, user: { id: 'u1' } } },
      { status: 404, json: { error: 'Factor haipatikani.' } },
    ]);
    const c = createClient(URL, baseOpts(fn));
    await c.auth.signInWithPassword({ username: 'a', password: 'b' });

    const { data, error } = await c.auth.mfa.challenge({ factorId: 'nope' });
    expect(data).toBeNull();
    expect(error?.message).toBe('Factor haipatikani.');
  });
});

// keep vi import used even if a test is trimmed
void vi;
