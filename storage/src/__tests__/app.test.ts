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
  return { app: createApp({ db, store, jwtSecret: SECRET }), db };
}

const USER = makeToken('user-1');
const OTHER = makeToken('user-2');

describe('GET /health', () => {
  it('returns ok', async () => {
    const res = await request(app().app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('buckets', () => {
  it('creates, lists and deletes a bucket', async () => {
    const a = app().app;
    const create = await request(a)
      .post('/bucket')
      .set('Authorization', `Bearer ${USER}`)
      .send({ name: 'avatars', public: false });
    expect(create.status).toBe(201);
    expect(create.body.bucket.name).toBe('avatars');

    const list = await request(a)
      .get('/bucket')
      .set('Authorization', `Bearer ${USER}`);
    expect(list.status).toBe(200);
    expect(list.body.buckets.map((b: { name: string }) => b.name)).toContain(
      'avatars'
    );

    const del = await request(a)
      .delete('/bucket/avatars')
      .set('Authorization', `Bearer ${USER}`);
    expect(del.status).toBe(200);
  });

  it('rejects bucket creation without a token', async () => {
    const res = await request(app().app)
      .post('/bucket')
      .send({ name: 'x', public: true });
    expect(res.status).toBe(401);
  });

  it('rejects a duplicate bucket', async () => {
    const a = app().app;
    await request(a)
      .post('/bucket')
      .set('Authorization', `Bearer ${USER}`)
      .send({ name: 'dup' });
    const again = await request(a)
      .post('/bucket')
      .set('Authorization', `Bearer ${USER}`)
      .send({ name: 'dup' });
    expect(again.status).toBe(409);
  });

  it('rejects an invalid bucket name', async () => {
    const res = await request(app().app)
      .post('/bucket')
      .set('Authorization', `Bearer ${USER}`)
      .send({ name: 'BAD NAME' });
    expect(res.status).toBe(400);
  });
});

describe('object upload + download', () => {
  it('uploads then downloads bytes with the stored mime', async () => {
    const a = app().app;
    await request(a)
      .post('/bucket')
      .set('Authorization', `Bearer ${USER}`)
      .send({ name: 'docs' });

    const up = await request(a)
      .put('/object/docs/notes/a.txt')
      .set('Authorization', `Bearer ${USER}`)
      .set('Content-Type', 'text/plain')
      .send('habari za leo');
    expect(up.status).toBe(200);
    expect(up.body.object.path).toBe('notes/a.txt');
    expect(up.body.object.mime).toBe('text/plain');
    expect(up.body.object.owner).toBe('user-1');

    const down = await request(a)
      .get('/object/docs/notes/a.txt')
      .set('Authorization', `Bearer ${USER}`);
    expect(down.status).toBe(200);
    expect(down.headers['content-type']).toContain('text/plain');
    expect(down.text).toBe('habari za leo');
  });

  it('upload requires a token', async () => {
    const a = app().app;
    await request(a)
      .post('/bucket')
      .set('Authorization', `Bearer ${USER}`)
      .send({ name: 'docs' });
    const up = await request(a)
      .put('/object/docs/x.txt')
      .set('Content-Type', 'text/plain')
      .send('x');
    expect(up.status).toBe(401);
  });

  it('upload to a missing bucket → 404', async () => {
    const up = await request(app().app)
      .put('/object/nope/x.txt')
      .set('Authorization', `Bearer ${USER}`)
      .send('x');
    expect(up.status).toBe(404);
  });

  it('rejects path traversal in the object path', async () => {
    const a = app().app;
    await request(a)
      .post('/bucket')
      .set('Authorization', `Bearer ${USER}`)
      .send({ name: 'docs' });
    const up = await request(a)
      .put('/object/docs/..%2f..%2fescape.txt')
      .set('Authorization', `Bearer ${USER}`)
      .send('x');
    expect(up.status).toBe(400);
  });
});

describe('public vs private download auth', () => {
  it('public bucket downloads without a token', async () => {
    const a = app().app;
    await request(a)
      .post('/bucket')
      .set('Authorization', `Bearer ${USER}`)
      .send({ name: 'public', public: true });
    await request(a)
      .put('/object/public/logo.txt')
      .set('Authorization', `Bearer ${USER}`)
      .set('Content-Type', 'text/plain')
      .send('LOGO');

    const down = await request(a).get('/object/public/logo.txt');
    expect(down.status).toBe(200);
    expect(down.text).toBe('LOGO');
  });

  it('private bucket download without a token → 401', async () => {
    const a = app().app;
    await request(a)
      .post('/bucket')
      .set('Authorization', `Bearer ${USER}`)
      .send({ name: 'priv', public: false });
    await request(a)
      .put('/object/priv/secret.txt')
      .set('Authorization', `Bearer ${USER}`)
      .send('SECRET');

    const down = await request(a).get('/object/priv/secret.txt');
    expect(down.status).toBe(401);

    const ok = await request(a)
      .get('/object/priv/secret.txt')
      .set('Authorization', `Bearer ${OTHER}`);
    // Any authenticated user may read (documented choice).
    expect(ok.status).toBe(200);
  });
});

describe('list', () => {
  it('lists objects with a prefix filter', async () => {
    const a = app().app;
    await request(a)
      .post('/bucket')
      .set('Authorization', `Bearer ${USER}`)
      .send({ name: 'docs' });
    for (const p of ['img/a.png', 'img/b.png', 'text/c.txt']) {
      await request(a)
        .put(`/object/docs/${p}`)
        .set('Authorization', `Bearer ${USER}`)
        .send('x');
    }
    const all = await request(a)
      .get('/list/docs')
      .set('Authorization', `Bearer ${USER}`);
    expect(all.body.objects.length).toBe(3);

    const imgs = await request(a)
      .get('/list/docs?prefix=img/')
      .set('Authorization', `Bearer ${USER}`);
    expect(imgs.body.objects.length).toBe(2);
  });

  it('list requires a token', async () => {
    const res = await request(app().app).get('/list/docs');
    expect(res.status).toBe(401);
  });
});

describe('delete (owner-only)', () => {
  it('owner can delete; non-owner gets 403', async () => {
    const a = app().app;
    await request(a)
      .post('/bucket')
      .set('Authorization', `Bearer ${USER}`)
      .send({ name: 'docs' });
    await request(a)
      .put('/object/docs/mine.txt')
      .set('Authorization', `Bearer ${USER}`)
      .send('x');

    const forbidden = await request(a)
      .delete('/object/docs/mine.txt')
      .set('Authorization', `Bearer ${OTHER}`);
    expect(forbidden.status).toBe(403);

    const ok = await request(a)
      .delete('/object/docs/mine.txt')
      .set('Authorization', `Bearer ${USER}`);
    expect(ok.status).toBe(200);

    const gone = await request(a)
      .get('/object/docs/mine.txt')
      .set('Authorization', `Bearer ${USER}`);
    expect(gone.status).toBe(404);
  });
});

describe('signed URLs', () => {
  it('signs a private object and streams it via /signed without a bearer', async () => {
    const a = app().app;
    await request(a)
      .post('/bucket')
      .set('Authorization', `Bearer ${USER}`)
      .send({ name: 'priv', public: false });
    await request(a)
      .put('/object/priv/report.txt')
      .set('Authorization', `Bearer ${USER}`)
      .set('Content-Type', 'text/plain')
      .send('RAPOTI');

    const sign = await request(a)
      .post('/sign/priv/report.txt')
      .set('Authorization', `Bearer ${USER}`)
      .send({ expiresIn: 120 });
    expect(sign.status).toBe(200);
    expect(sign.body.signedUrl).toContain('/storage/signed/priv/report.txt');
    const token = sign.body.token as string;

    const down = await request(a).get(
      `/signed/priv/report.txt?token=${encodeURIComponent(token)}`
    );
    expect(down.status).toBe(200);
    expect(down.text).toBe('RAPOTI');
  });

  it('rejects /signed with a missing or bad token', async () => {
    const a = app().app;
    await request(a)
      .post('/bucket')
      .set('Authorization', `Bearer ${USER}`)
      .send({ name: 'priv' });
    await request(a)
      .put('/object/priv/r.txt')
      .set('Authorization', `Bearer ${USER}`)
      .send('x');

    const noTok = await request(a).get('/signed/priv/r.txt');
    expect(noTok.status).toBe(401);

    const badTok = await request(a).get('/signed/priv/r.txt?token=garbage');
    expect(badTok.status).toBe(401);
  });

  it('a signed token cannot be replayed against a different object', async () => {
    const a = app().app;
    await request(a)
      .post('/bucket')
      .set('Authorization', `Bearer ${USER}`)
      .send({ name: 'priv' });
    for (const p of ['one.txt', 'two.txt']) {
      await request(a)
        .put(`/object/priv/${p}`)
        .set('Authorization', `Bearer ${USER}`)
        .send('x');
    }
    const sign = await request(a)
      .post('/sign/priv/one.txt')
      .set('Authorization', `Bearer ${USER}`)
      .send({ expiresIn: 120 });
    const token = sign.body.token as string;

    const replay = await request(a).get(
      `/signed/priv/two.txt?token=${encodeURIComponent(token)}`
    );
    expect(replay.status).toBe(401);
  });
});

describe('errors', () => {
  it('unknown route → 404 JSON', async () => {
    const res = await request(app().app).get('/nope');
    expect(res.status).toBe(404);
    expect(res.body.error).toBeTruthy();
  });
});
