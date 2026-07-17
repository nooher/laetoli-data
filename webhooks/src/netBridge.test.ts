import { describe, it, expect, vi } from 'vitest';
import { NetBridge } from './netBridge.js';
import { FakeNetQueueStore, type QueuedRequest } from './netQueue.js';
import type { FetchLike } from './dispatcher.js';

function req(over: Partial<QueuedRequest> = {}): QueuedRequest {
  return {
    id: 1,
    method: 'POST',
    url: 'https://example.com/hook',
    headers: { 'Content-Type': 'application/json' },
    body: '{"hello":"world"}',
    timeout_milliseconds: 5000,
    ...over,
  };
}

describe('NetBridge', () => {
  it('processes a pending request and records a successful response', async () => {
    const store = new FakeNetQueueStore();
    store.queue.push(req());
    const fetchImpl: FetchLike = vi.fn(async () => ({ ok: true, status: 200 }));

    const bridge = new NetBridge({ store, fetch: fetchImpl });
    await bridge.drain();

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://example.com/hook',
      expect.objectContaining({ method: 'POST', body: '{"hello":"world"}' })
    );
    expect(store.queue).toHaveLength(0); // removed from the pending queue
    expect(store.responses).toHaveLength(1);
    expect(store.responses[0]).toMatchObject({ id: 1, statusCode: 200, errorMsg: null });
  });

  it('records a non-2xx response as a failed outcome without throwing', async () => {
    const store = new FakeNetQueueStore();
    store.queue.push(req());
    const fetchImpl: FetchLike = vi.fn(async () => ({ ok: false, status: 500 }));

    const bridge = new NetBridge({ store, fetch: fetchImpl });
    await bridge.drain();

    expect(store.responses[0]).toMatchObject({ id: 1, statusCode: 500, errorMsg: 'HTTP 500' });
    expect(store.queue).toHaveLength(0); // still removed — not retried forever
  });

  it('records a network failure (fetch throws) as an error outcome', async () => {
    const store = new FakeNetQueueStore();
    store.queue.push(req());
    const fetchImpl: FetchLike = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });

    const bridge = new NetBridge({ store, fetch: fetchImpl });
    await bridge.drain();

    expect(store.responses[0]).toMatchObject({ id: 1, statusCode: null, errorMsg: 'ECONNREFUSED' });
  });

  it('processes GET requests without a body', async () => {
    const store = new FakeNetQueueStore();
    store.queue.push(req({ method: 'GET', body: null }));
    const fetchImpl: FetchLike = vi.fn(async () => ({ ok: true, status: 200 }));

    const bridge = new NetBridge({ store, fetch: fetchImpl });
    await bridge.drain();

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://example.com/hook',
      expect.objectContaining({ method: 'GET', body: '' })
    );
  });

  it('processes multiple pending requests in one drain', async () => {
    const store = new FakeNetQueueStore();
    store.queue.push(req({ id: 1 }), req({ id: 2 }), req({ id: 3 }));
    const fetchImpl: FetchLike = vi.fn(async () => ({ ok: true, status: 200 }));

    const bridge = new NetBridge({ store, fetch: fetchImpl });
    await bridge.drain();

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(store.responses).toHaveLength(3);
  });

  it('a drain() called while one is already running coalesces into one more pass, not a pile-up', async () => {
    const store = new FakeNetQueueStore();
    store.queue.push(req({ id: 1 }));
    let firstFetchStarted: (() => void) | null = null;
    const firstFetchStartedPromise = new Promise<void>((r) => (firstFetchStarted = r));
    let callCount = 0;
    // Every call resolves quickly on its own (setTimeout 0) — only the FIRST
    // call is gated on a signal, so the test can deterministically queue a
    // second request + a coalesced drain() while the first is still in-flight,
    // without needing to hand-track a resolver per call.
    const fetchImpl: FetchLike = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) {
        firstFetchStarted?.();
        await new Promise((r) => setTimeout(r, 15));
      }
      return { ok: true, status: 200 };
    });

    const bridge = new NetBridge({ store, fetch: fetchImpl });
    const first = bridge.drain();
    await firstFetchStartedPromise; // wait until the first request's fetch is actually in-flight

    // Queue a second request and trigger a concurrent drain() while the first
    // request's fetch is still pending.
    store.queue.push(req({ id: 2 }));
    const second = bridge.drain(); // should coalesce, not run a parallel pass

    await Promise.all([first, second]);
    // Allow the coalesced follow-up pass (scheduled fire-and-forget) to settle.
    await new Promise((r) => setTimeout(r, 50));

    expect(store.responses.map((r) => r.id).sort()).toEqual([1, 2]);
    expect(callCount).toBe(2); // exactly one fetch per request, no duplicate processing
  });

  it('onProcessed reports ok/failure per request', async () => {
    const store = new FakeNetQueueStore();
    store.queue.push(req({ id: 1 }), req({ id: 2 }));
    let call = 0;
    const fetchImpl: FetchLike = vi.fn(async () => {
      call += 1;
      return call === 1 ? { ok: true, status: 200 } : { ok: false, status: 503 };
    });
    const events: Array<{ id: number; ok: boolean }> = [];

    const bridge = new NetBridge({
      store,
      fetch: fetchImpl,
      onProcessed: (id, ok) => events.push({ id, ok }),
    });
    await bridge.drain();

    expect(events).toEqual([
      { id: 1, ok: true },
      { id: 2, ok: false },
    ]);
  });
});
