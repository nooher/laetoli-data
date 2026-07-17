// Supabase Storage URL compat — a ported app's hardcoded
// `{URL}/storage/v1/object/public/...` and
// `{URL}/storage/v1/render/image/public/...?width=&height=&resize=&quality=`
// URLs (Caddy strips the leading `/storage`, so `/v1/...` is what reaches this
// service) must work with ZERO app-side changes. Real-world trigger: KasukuGames'
// api/invite.ts builds exactly this render/image URL for WhatsApp OG previews.

import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { createMemoryDb } from './fakeDb.js';
import { createFsStore } from '../store.js';
import { SECRET, makeToken, tempRoot } from './helpers.js';

let cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.forEach((c) => c());
  cleanups = [];
});

function app() {
  const { root, cleanup } = tempRoot();
  cleanups.push(cleanup);
  const db = createMemoryDb();
  const store = createFsStore(root);
  return createApp({ db, store, jwtSecret: SECRET });
}

const USER = makeToken('user-1');

describe('GET /v1/object/public/:bucket/* (Supabase plain-object alias)', () => {
  it('serves the same bytes as /object/:bucket/*, no app-side change needed', async () => {
    const a = app();
    await request(a).post('/bucket').set('Authorization', `Bearer ${USER}`).send({ name: 'avatars', public: true });
    await request(a)
      .put('/object/avatars/u1/pic.txt')
      .set('Authorization', `Bearer ${USER}`)
      .set('Content-Type', 'text/plain')
      .send('habari');

    const res = await request(a).get('/v1/object/public/avatars/u1/pic.txt');
    expect(res.status).toBe(200);
    expect(res.text).toBe('habari');
  });

  it('still enforces the same auth rules for a private bucket', async () => {
    const a = app();
    await request(a).post('/bucket').set('Authorization', `Bearer ${USER}`).send({ name: 'priv', public: false });
    await request(a)
      .put('/object/priv/secret.txt')
      .set('Authorization', `Bearer ${USER}`)
      .send('shh');

    const res = await request(a).get('/v1/object/public/priv/secret.txt');
    expect(res.status).toBe(401);
  });
});

describe('GET /v1/render/image/public/:bucket/* (Supabase transform alias)', () => {
  it('accepts the exact query shape a ported app already sends (?width=&height=&resize=&quality=)', async () => {
    const a = app();
    await request(a).post('/bucket').set('Authorization', `Bearer ${USER}`).send({ name: 'avatars', public: true });
    await request(a)
      .put('/object/avatars/u1/note.txt')
      .set('Authorization', `Bearer ${USER}`)
      .set('Content-Type', 'text/plain')
      .send('not an image, but proves the params parse + route resolves');

    // Exactly KasukuGames' api/invite.ts ogSized() query shape.
    const res = await request(a).get(
      '/v1/render/image/public/avatars/u1/note.txt?width=600&height=600&resize=cover&quality=75'
    );
    expect(res.status).toBe(200);
    expect(res.text).toContain('proves the params parse');
  });

  it('a real image is actually transformed through the alias route (not just passed through)', async () => {
    let sharp: typeof import('sharp').default | null;
    try {
      sharp = (await import('sharp')).default;
    } catch {
      console.warn('[supabaseCompat.app.test] sharp not installed — skipping live pipeline');
      return;
    }
    const png = await sharp({
      create: { width: 200, height: 200, channels: 3, background: { r: 10, g: 200, b: 10 } },
    })
      .png()
      .toBuffer();

    const a = app();
    await request(a).post('/bucket').set('Authorization', `Bearer ${USER}`).send({ name: 'avatars', public: true });
    await request(a)
      .put('/object/avatars/u1/pic.png')
      .set('Authorization', `Bearer ${USER}`)
      .set('Content-Type', 'image/png')
      .send(png);

    const res = await request(a)
      .get('/v1/render/image/public/avatars/u1/pic.png?width=600&height=600&resize=cover&quality=75')
      .responseType('blob');
    expect(res.status).toBe(200);
    const meta = await sharp!(res.body as Buffer).metadata();
    expect(meta.width).toBe(600);
    expect(meta.height).toBe(600);
  });

  it('a malformed transform query on the alias route still 400s cleanly', async () => {
    const a = app();
    await request(a).post('/bucket').set('Authorization', `Bearer ${USER}`).send({ name: 'avatars', public: true });
    await request(a).put('/object/avatars/x.txt').set('Authorization', `Bearer ${USER}`).send('hi');

    const res = await request(a).get('/v1/render/image/public/avatars/x.txt?width=not-a-number');
    expect(res.status).toBe(400);
  });
});
