import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import { Dispatcher, type FetchLike, type DispatcherDeps } from './dispatcher.js';
import { FakeStore } from './db.js';
import type { Endpoint, Notification } from './core.js';

const hmac = (key: string, msg: string) =>
  crypto.createHmac('sha256', key).update(msg).digest('hex');

function ep(over: Partial<Endpoint> = {}): Endpoint {
  return {
    id: 'e1',
    name: 't',
    table_name: 'notes',
    events: ['INSERT', 'UPDATE', 'DELETE'],
    url: 'https://x/hook',
    secret: null,
    active: true,
    ...over,
  };
}

function note(over: Partial<Notification> = {}): Notification {
  return { schema: 'public', table: 'notes', type: 'INSERT', record: { id: 1 }, old: null, ...over };
}

function makeDispatcher(
  store: FakeStore,
  fetchImpl: FetchLike,
  over: Partial<DispatcherDeps> = {}
): { d: Dispatcher; sleeps: number[] } {
  const sleeps: number[] = [];
  const d = new Dispatcher({
    store,
    fetch: fetchImpl,
    hmacSha256Hex: hmac,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    maxAttempts: 3,
    backoffBaseMs: 500,
    requestTimeoutMs: 1000,
    ...over,
  });
  return { d, sleeps };
}

describe('Dispatcher.handle', () => {
  it('POSTs to a matching endpoint and logs an ok delivery', async () => {
    const store = new FakeStore([ep()]);
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }));
    const { d } = makeDispatcher(store, fetchImpl);

    await d.handle(note());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(store.deliveries).toHaveLength(1);
    expect(store.deliveries[0]).toMatchObject({ endpointId: 'e1', event: 'INSERT', ok: true, statusCode: 200, attempts: 1 });
  });

  it('does not POST when no endpoint matches', async () => {
    const store = new FakeStore([ep({ table_name: 'orders' })]);
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }));
    const { d } = makeDispatcher(store, fetchImpl);

    await d.handle(note());

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(store.deliveries).toHaveLength(0);
  });

  it('signs the body with HMAC when a secret is set', async () => {
    const store = new FakeStore([ep({ secret: 'topsecret' })]);
    let seenHeaders: Record<string, string> = {};
    let seenBody = '';
    const fetchImpl: FetchLike = vi.fn(async (_url, init) => {
      seenHeaders = init.headers;
      seenBody = init.body;
      return { ok: true, status: 200 };
    });
    const { d } = makeDispatcher(store, fetchImpl);

    await d.handle(note());

    expect(seenHeaders['X-Laetoli-Signature']).toBe(`sha256=${hmac('topsecret', seenBody)}`);
  });

  it('omits the signature header when no secret', async () => {
    const store = new FakeStore([ep({ secret: null })]);
    let seenHeaders: Record<string, string> = {};
    const fetchImpl: FetchLike = vi.fn(async (_url, init) => {
      seenHeaders = init.headers;
      return { ok: true, status: 200 };
    });
    const { d } = makeDispatcher(store, fetchImpl);

    await d.handle(note());

    expect(seenHeaders['X-Laetoli-Signature']).toBeUndefined();
  });

  it('retries on 5xx then succeeds; records final ok with attempt count', async () => {
    const store = new FakeStore([ep()]);
    const fetchImpl = vi
      .fn<Parameters<FetchLike>, ReturnType<FetchLike>>()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const { d, sleeps } = makeDispatcher(store, fetchImpl);

    await d.handle(note());

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([500]); // one backoff before attempt 2
    expect(store.deliveries[0]).toMatchObject({ ok: true, statusCode: 200, attempts: 2 });
  });

  it('gives up after maxAttempts on persistent 5xx and logs the failure', async () => {
    const store = new FakeStore([ep()]);
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500 }));
    const { d, sleeps } = makeDispatcher(store, fetchImpl);

    await d.handle(note());

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([500, 1000]);
    expect(store.deliveries[0]).toMatchObject({ ok: false, statusCode: 500, attempts: 3 });
    expect(store.deliveries[0].error).toContain('500');
  });

  it('does NOT retry a 4xx client error', async () => {
    const store = new FakeStore([ep()]);
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 400 }));
    const { d } = makeDispatcher(store, fetchImpl);

    await d.handle(note());

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(store.deliveries[0]).toMatchObject({ ok: false, statusCode: 400, attempts: 1 });
  });

  it('treats a thrown fetch (network/timeout) as a retryable error', async () => {
    const store = new FakeStore([ep()]);
    const fetchImpl = vi
      .fn<Parameters<FetchLike>, ReturnType<FetchLike>>()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce({ ok: true, status: 200 });
    const { d } = makeDispatcher(store, fetchImpl);

    await d.handle(note());

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(store.deliveries[0]).toMatchObject({ ok: true, attempts: 2 });
  });

  it('a persistently bad URL never throws and is logged as failed', async () => {
    const store = new FakeStore([ep()]);
    const fetchImpl = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND');
    });
    const { d } = makeDispatcher(store, fetchImpl);

    await expect(d.handle(note())).resolves.toBeUndefined();
    expect(store.deliveries[0]).toMatchObject({ ok: false, statusCode: null, attempts: 3 });
    expect(store.deliveries[0].error).toContain('ENOTFOUND');
  });

  it('fans out to multiple matching endpoints', async () => {
    const store = new FakeStore([ep({ id: 'a' }), ep({ id: 'b', url: 'https://y/hook' })]);
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }));
    const { d } = makeDispatcher(store, fetchImpl);

    await d.handle(note());

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(store.deliveries.map((x) => x.endpointId).sort()).toEqual(['a', 'b']);
  });

  it('a delivery-log write failure does not crash the worker', async () => {
    const store = new FakeStore([ep()]);
    store.recordShouldThrow = true;
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }));
    const { d } = makeDispatcher(store, fetchImpl);

    await expect(d.handle(note())).resolves.toBeUndefined();
  });

  it('an endpoint-load failure is swallowed (no throw)', async () => {
    const store = new FakeStore([ep()]);
    store.activeEndpoints = async () => {
      throw new Error('db down');
    };
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }));
    const { d } = makeDispatcher(store, fetchImpl);

    await expect(d.handle(note())).resolves.toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports the last delivery via onDelivery', async () => {
    const store = new FakeStore([ep()]);
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }));
    const snaps: unknown[] = [];
    const { d } = makeDispatcher(store, fetchImpl, { onDelivery: (s) => snaps.push(s) });

    await d.handle(note({ type: 'UPDATE' }));

    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({ endpointId: 'e1', event: 'UPDATE', ok: true, statusCode: 200 });
  });
});
