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

async function loadSharp(): Promise<typeof import('sharp').default | null> {
  try {
    return (await import('sharp')).default;
  } catch {
    return null;
  }
}

describe('image transforms — bad params (no sharp needed)', () => {
  it('returns 400 for a clearly-bad width', async () => {
    const a = app();
    await request(a).post('/bucket').set('Authorization', `Bearer ${USER}`).send({ name: 'pub', public: true });
    await request(a)
      .put('/object/pub/x.txt')
      .set('Authorization', `Bearer ${USER}`)
      .set('Content-Type', 'text/plain')
      .send('hello');

    const res = await request(a).get('/object/pub/x.txt?width=abc');
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('returns 400 for an unknown format', async () => {
    const a = app();
    await request(a).post('/bucket').set('Authorization', `Bearer ${USER}`).send({ name: 'pub', public: true });
    await request(a).put('/object/pub/x.txt').set('Authorization', `Bearer ${USER}`).send('hi');
    const res = await request(a).get('/object/pub/x.txt?format=gif');
    expect(res.status).toBe(400);
  });
});

describe('image transforms — non-image fallback (no sharp needed)', () => {
  it('serves the original bytes for a non-image even with transform params', async () => {
    const a = app();
    await request(a).post('/bucket').set('Authorization', `Bearer ${USER}`).send({ name: 'pub', public: true });
    await request(a)
      .put('/object/pub/note.txt')
      .set('Authorization', `Bearer ${USER}`)
      .set('Content-Type', 'text/plain')
      .send('habari');

    const res = await request(a).get('/object/pub/note.txt?width=40&format=webp');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toBe('habari');
  });
});

describe('image transforms — auth rules preserved (no sharp needed)', () => {
  it('private image with transform params still requires auth', async () => {
    const a = app();
    await request(a).post('/bucket').set('Authorization', `Bearer ${USER}`).send({ name: 'priv', public: false });
    await request(a)
      .put('/object/priv/a.png')
      .set('Authorization', `Bearer ${USER}`)
      .set('Content-Type', 'image/png')
      .send('not-really-a-png');

    const res = await request(a).get('/object/priv/a.png?width=40');
    expect(res.status).toBe(401);
  });
});

describe('image transforms — real pipeline (requires sharp binary)', () => {
  it('GET ?width=40&format=webp returns image/webp at width 40', async () => {
    const sharp = await loadSharp();
    if (!sharp) {
      console.warn('[transforms.app.test] sharp not installed — skipping live pipeline');
      return;
    }
    const png = await sharp({
      create: { width: 200, height: 200, channels: 3, background: { r: 200, g: 30, b: 30 } },
    })
      .png()
      .toBuffer();

    const a = app();
    await request(a).post('/bucket').set('Authorization', `Bearer ${USER}`).send({ name: 'pub', public: true });
    await request(a)
      .put('/object/pub/red.png')
      .set('Authorization', `Bearer ${USER}`)
      .set('Content-Type', 'image/png')
      .send(png);

    const res = await request(a)
      .get('/object/pub/red.png?width=40&format=webp')
      .responseType('blob');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/webp');
    const meta = await sharp(res.body as Buffer).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(40);

    // No params → original PNG unchanged.
    const orig = await request(a).get('/object/pub/red.png').responseType('blob');
    expect(orig.headers['content-type']).toBe('image/png');
    const origMeta = await sharp(orig.body as Buffer).metadata();
    expect(origMeta.format).toBe('png');
    expect(origMeta.width).toBe(200);
  });

  it('serves a transformed variant from cache on the second request', async () => {
    const sharp = await loadSharp();
    if (!sharp) return;
    const png = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 0, g: 0, b: 255 } },
    })
      .png()
      .toBuffer();

    const a = app();
    await request(a).post('/bucket').set('Authorization', `Bearer ${USER}`).send({ name: 'pub', public: true });
    await request(a)
      .put('/object/pub/blue.png')
      .set('Authorization', `Bearer ${USER}`)
      .set('Content-Type', 'image/png')
      .send(png);

    const url = '/object/pub/blue.png?width=20&format=webp';
    const first = await request(a).get(url).responseType('blob');
    const second = await request(a).get(url).responseType('blob');
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((second.body as Buffer).equals(first.body as Buffer)).toBe(true);
  });

  it('falls back to original bytes when the stored image is corrupt', async () => {
    const sharp = await loadSharp();
    if (!sharp) return;
    const a = app();
    await request(a).post('/bucket').set('Authorization', `Bearer ${USER}`).send({ name: 'pub', public: true });
    // Declared image/png but the bytes are garbage → sharp errors → fall back.
    await request(a)
      .put('/object/pub/broken.png')
      .set('Authorization', `Bearer ${USER}`)
      .set('Content-Type', 'image/png')
      .send('this is not a png');

    const res = await request(a).get('/object/pub/broken.png?width=40&format=webp');
    expect(res.status).toBe(200); // never 500
    expect(res.headers['content-type']).toContain('image/png');
  });
});
