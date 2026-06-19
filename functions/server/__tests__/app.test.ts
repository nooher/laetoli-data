import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { FunctionLoader } from '../loader.js';
import { tempFns, makeToken, SECRET, type TempFns } from './helpers.js';

let fns: TempFns | undefined;
afterEach(() => {
  fns?.cleanup();
  fns = undefined;
});

function app(root: string, over: { jwtSecret?: string; timeoutMs?: number; production?: boolean; env?: Record<string, string> } = {}) {
  const loader = new FunctionLoader({ root });
  return createApp({
    loader,
    jwtSecret: 'jwtSecret' in over ? over.jwtSecret : SECRET,
    timeoutMs: over.timeoutMs ?? 1000,
    production: over.production,
    env: over.env,
  });
}

describe('functions app', () => {
  it('GET /health lists the available functions', async () => {
    fns = tempFns();
    fns.write('hello.mjs', 'export default async () => ({ message: "hi" });');
    const res = await request(app(fns.root)).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.functions).toContain('hello');
  });

  it('GET / lists functions', async () => {
    fns = tempFns();
    fns.write('a.mjs', 'export default () => ({});');
    fns.write('b/index.mjs', 'export default () => ({});');
    const res = await request(app(fns.root)).get('/');
    expect(res.body.functions).toEqual(['a', 'b']);
  });

  it('dispatches to a function and returns a bare JSON value as 200', async () => {
    fns = tempFns();
    fns.write(
      'hello.mjs',
      'export default async (ctx) => ({ message: "Habari, " + (ctx.query.jina ?? "Dunia") });'
    );
    const res = await request(app(fns.root)).get('/hello?jina=Asha');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ message: 'Habari, Asha' });
  });

  it('honours a Response-like { status, body } envelope', async () => {
    fns = tempFns();
    fns.write('made.mjs', 'export default () => ({ status: 201, headers: { "X-Test": "1" }, body: { created: true } });');
    const res = await request(app(fns.root)).post('/made');
    expect(res.status).toBe(201);
    expect(res.headers['x-test']).toBe('1');
    expect(res.body).toEqual({ created: true });
  });

  it('passes the request body + method + trailing path to the handler', async () => {
    fns = tempFns();
    fns.write(
      'echo.mjs',
      'export default (ctx) => ({ gotMethod: ctx.method, gotBody: ctx.body, gotPath: ctx.path });'
    );
    const res = await request(app(fns.root)).put('/echo/sub/dir').send({ a: 1 });
    expect(res.body).toEqual({ gotMethod: 'PUT', gotBody: { a: 1 }, gotPath: '/sub/dir' });
  });

  it('404s an unknown function', async () => {
    fns = tempFns();
    const res = await request(app(fns.root)).get('/ghost');
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('ghost');
  });

  it('returns 504 when a handler exceeds the timeout', async () => {
    fns = tempFns();
    fns.write('slow.mjs', 'export default () => new Promise(() => {});');
    const res = await request(app(fns.root, { timeoutMs: 30 })).get('/slow');
    expect(res.status).toBe(504);
    expect(res.body.error).toMatch(/timed out/i);
  });

  it('returns a clean 500 when a handler throws (message hidden in prod)', async () => {
    fns = tempFns();
    fns.write('boom.mjs', 'export default () => { throw new Error("secret detail"); };');

    const dev = await request(app(fns.root)).get('/boom');
    expect(dev.status).toBe(500);
    expect(dev.body.error).toBe('secret detail');

    const prod = await request(app(fns.root, { production: true })).get('/boom');
    expect(prod.status).toBe(500);
    expect(prod.body.error).toBe('Function error.');
    expect(JSON.stringify(prod.body)).not.toContain('secret detail');
  });

  it('populates ctx.user from a valid Bearer token', async () => {
    fns = tempFns();
    fns.write('whoami.mjs', 'export default (ctx) => ctx.user ?? ({ status: 401, body: { error: "no" } });');

    const anon = await request(app(fns.root)).get('/whoami');
    expect(anon.status).toBe(401);

    const token = makeToken('user-7', { role: 'authenticated' });
    const authed = await request(app(fns.root)).get('/whoami').set('Authorization', `Bearer ${token}`);
    expect(authed.status).toBe(200);
    expect(authed.body).toEqual({ sub: 'user-7', role: 'authenticated' });
  });

  it('ignores an invalid token (ctx.user stays null)', async () => {
    fns = tempFns();
    fns.write('whoami.mjs', 'export default (ctx) => ({ user: ctx.user });');
    const res = await request(app(fns.root)).get('/whoami').set('Authorization', 'Bearer not.a.jwt');
    expect(res.body).toEqual({ user: null });
  });

  it('exposes ctx.env to the function', async () => {
    fns = tempFns();
    fns.write('cfg.mjs', 'export default (ctx) => ({ v: ctx.env.MY_SETTING });');
    const res = await request(app(fns.root, { env: { MY_SETTING: 'tanzania' } })).get('/cfg');
    expect(res.body).toEqual({ v: 'tanzania' });
  });

  it('POST /_reload clears the cache so the next call re-imports', async () => {
    // Drive the loader with an injected importer (deterministic across runtimes;
    // native import() query-busting is exercised in the loader unit tests).
    let version = 1;
    const loader = new FunctionLoader({
      root: '/virtual',
      fileSystem: { existsSync: () => true } as never,
      // Capture `version` at import time so a cached module stays frozen.
      importer: async () => {
        const v = version;
        return { default: () => ({ v }) };
      },
    });
    const a = createApp({ loader, timeoutMs: 1000 });

    expect((await request(a).get('/ver')).body).toEqual({ v: 1 });
    version = 2;
    // Cached → still v1.
    expect((await request(a).get('/ver')).body).toEqual({ v: 1 });
    await request(a).post('/_reload?name=ver');
    expect((await request(a).get('/ver')).body).toEqual({ v: 2 });

    // `?reload=1` busts a single function inline.
    version = 3;
    expect((await request(a).get('/ver?reload=1')).body).toEqual({ v: 3 });
  });
});
