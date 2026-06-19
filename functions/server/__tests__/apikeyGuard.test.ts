import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createHash } from 'node:crypto';
import {
  apikeyGuard,
  extractApiKey,
  type ApiKeyStore,
  type ActiveKey,
} from '../apikeyGuard.js';

function sha256(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** A fake store seeded with one active key. */
function fakeStore(opts: { secret: string; key: ActiveKey } | null) {
  const usage: string[] = [];
  const store: ApiKeyStore & { usage: string[] } = {
    usage,
    async findActiveByHash(hash) {
      if (!opts) return null;
      return hash === sha256(opts.secret) ? opts.key : null;
    },
    async recordUsage(keyId) {
      usage.push(keyId);
    },
  };
  return store;
}

const ACTIVE: ActiveKey = {
  key_id: 'k1',
  project_id: 'p1',
  role: 'service',
  rate_limit_per_min: 3,
};

/** Build a tiny app that mounts the guard then echoes req.apiKey. */
function app(guardMw: express.RequestHandler) {
  const a = express();
  a.use(guardMw);
  a.get('/ping', (req, res) => res.json({ ok: true, apiKey: req.apiKey ?? null }));
  return a;
}

describe('apikeyGuard — disabled (default)', () => {
  it('is a no-op: passes through with no key and never touches the store', async () => {
    let touched = false;
    const store: ApiKeyStore = {
      async findActiveByHash() {
        touched = true;
        return null;
      },
      async recordUsage() {
        touched = true;
      },
    };
    const res = await request(app(apikeyGuard({ require: false, store }))).get('/ping');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.apiKey).toBeNull();
    expect(touched).toBe(false);
  });
});

describe('apikeyGuard — enabled', () => {
  it('401 when no key is presented', async () => {
    const store = fakeStore({ secret: 'sekret', key: ACTIVE });
    const res = await request(app(apikeyGuard({ require: true, store }))).get('/ping');
    expect(res.status).toBe(401);
  });

  it('401 for an unknown/revoked key', async () => {
    const store = fakeStore({ secret: 'sekret', key: ACTIVE });
    const res = await request(app(apikeyGuard({ require: true, store })))
      .get('/ping')
      .set('apikey', 'ld_x.wrong');
    expect(res.status).toBe(401);
  });

  it('passes a valid key (prefix.secret), attaches req.apiKey, records usage', async () => {
    const store = fakeStore({ secret: 'sekret', key: ACTIVE });
    const res = await request(app(apikeyGuard({ require: true, store })))
      .get('/ping')
      .set('apikey', 'ld_abc.sekret');
    expect(res.status).toBe(200);
    expect(res.body.apiKey).toMatchObject({ key_id: 'k1', project_id: 'p1', role: 'service' });
    // usage recorded best-effort (await microtask flush)
    await new Promise((r) => setTimeout(r, 0));
    expect((store as ApiKeyStore & { usage: string[] }).usage).toContain('k1');
  });

  it('accepts a bare secret (no prefix)', async () => {
    const store = fakeStore({ secret: 'sekret', key: ACTIVE });
    const res = await request(app(apikeyGuard({ require: true, store })))
      .get('/ping')
      .set('apikey', 'sekret');
    expect(res.status).toBe(200);
  });

  it('accepts the key via ?apikey= query too', async () => {
    const store = fakeStore({ secret: 'sekret', key: ACTIVE });
    const res = await request(app(apikeyGuard({ require: true, store }))).get(
      '/ping?apikey=ld_abc.sekret'
    );
    expect(res.status).toBe(200);
  });

  it('429 once the per-minute limit is exceeded (fixed clock)', async () => {
    const store = fakeStore({ secret: 'sekret', key: { ...ACTIVE, rate_limit_per_min: 2 } });
    const fixed = 1_000_000;
    const a = app(apikeyGuard({ require: true, store, now: () => fixed }));
    const hit = () => request(a).get('/ping').set('apikey', 'ld_abc.sekret');
    expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(429); // 3rd within the same minute
  });

  it('window slides: after 60s the limit resets', async () => {
    const store = fakeStore({ secret: 'sekret', key: { ...ACTIVE, rate_limit_per_min: 1 } });
    let t = 1_000_000;
    const a = app(apikeyGuard({ require: true, store, now: () => t }));
    const hit = () => request(a).get('/ping').set('apikey', 'ld_abc.sekret');
    expect((await hit()).status).toBe(200);
    expect((await hit()).status).toBe(429);
    t += 61_000; // advance past the window
    expect((await hit()).status).toBe(200);
  });

  it('401 (fail closed) if the store throws on lookup', async () => {
    const store: ApiKeyStore = {
      async findActiveByHash() {
        throw new Error('db down');
      },
      async recordUsage() {},
    };
    const res = await request(app(apikeyGuard({ require: true, store })))
      .get('/ping')
      .set('apikey', 'ld_abc.sekret');
    expect(res.status).toBe(401);
  });
});

describe('extractApiKey', () => {
  it('reads header then query', () => {
    const fakeReq = (h?: string, q?: string) =>
      ({ header: () => h, query: q ? { apikey: q } : {} }) as unknown as Parameters<typeof extractApiKey>[0];
    expect(extractApiKey(fakeReq('hkey'))).toBe('hkey');
    expect(extractApiKey(fakeReq(undefined, 'qkey'))).toBe('qkey');
    expect(extractApiKey(fakeReq())).toBeNull();
  });
});
