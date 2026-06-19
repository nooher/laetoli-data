import { describe, it, expect } from 'vitest';
import { Hub, matchesFilter, parseNotification, type Notification } from '../hub.js';
import { FakeClient } from './fakeClient.js';

const CLAIMS = { sub: 'u1', role: 'authenticated' };

function note(overrides: Partial<Notification> = {}): Notification {
  return {
    schema: 'public',
    table: 'notes',
    type: 'INSERT',
    record: { id: '1', user_id: 'u1', body: 'hi' },
    old: null,
    ...overrides,
  };
}

describe('Hub — subscribe / acks', () => {
  it('acks a valid subscribe and tracks it', () => {
    const hub = new Hub();
    const c = new FakeClient();
    hub.add(c, CLAIMS);
    hub.handleMessage(c, JSON.stringify({ type: 'subscribe', channel: 'notes', event: '*' }));
    expect(c.last).toEqual({ type: 'subscribed', channel: 'notes' });
    expect(hub.subscriptionCount()).toBe(1);
  });

  it('defaults event to "*" when omitted', () => {
    const hub = new Hub();
    const c = new FakeClient();
    hub.add(c, CLAIMS);
    hub.handleMessage(c, JSON.stringify({ type: 'subscribe', channel: 'notes' }));
    expect(c.last?.type).toBe('subscribed');
    hub.dispatch(note({ type: 'DELETE', record: null, old: { id: '1', user_id: 'u1' } }));
    expect(c.changes).toHaveLength(1);
  });

  it('rejects subscribe with no channel', () => {
    const hub = new Hub();
    const c = new FakeClient();
    hub.add(c, CLAIMS);
    hub.handleMessage(c, JSON.stringify({ type: 'subscribe' }));
    expect(c.last?.type).toBe('error');
    expect(hub.subscriptionCount()).toBe(0);
  });

  it('rejects subscribe with an invalid event', () => {
    const hub = new Hub();
    const c = new FakeClient();
    hub.add(c, CLAIMS);
    hub.handleMessage(c, JSON.stringify({ type: 'subscribe', channel: 'notes', event: 'UPSERT' }));
    expect(c.last?.type).toBe('error');
    expect(hub.subscriptionCount()).toBe(0);
  });

  it('rejects subscribe with a malformed filter', () => {
    const hub = new Hub();
    const c = new FakeClient();
    hub.add(c, CLAIMS);
    hub.handleMessage(c, JSON.stringify({ type: 'subscribe', channel: 'notes', filter: { column: 'id' } }));
    expect(c.last?.type).toBe('error');
    expect(hub.subscriptionCount()).toBe(0);
  });

  it('re-subscribing the same channel replaces the prior subscription', () => {
    const hub = new Hub();
    const c = new FakeClient();
    hub.add(c, CLAIMS);
    hub.handleMessage(c, JSON.stringify({ type: 'subscribe', channel: 'notes', event: 'INSERT' }));
    hub.handleMessage(c, JSON.stringify({ type: 'subscribe', channel: 'notes', event: 'DELETE' }));
    expect(hub.subscriptionCount()).toBe(1);
    hub.dispatch(note({ type: 'INSERT' }));
    expect(c.changes).toHaveLength(0); // now only DELETE matches
    hub.dispatch(note({ type: 'DELETE', record: null, old: { id: '1' } }));
    expect(c.changes).toHaveLength(1);
  });
});

describe('Hub — unsubscribe', () => {
  it('unsubscribe stops delivery and acks', () => {
    const hub = new Hub();
    const c = new FakeClient();
    hub.add(c, CLAIMS);
    hub.handleMessage(c, JSON.stringify({ type: 'subscribe', channel: 'notes' }));
    hub.handleMessage(c, JSON.stringify({ type: 'unsubscribe', channel: 'notes' }));
    expect(c.last).toEqual({ type: 'unsubscribed', channel: 'notes' });
    expect(hub.subscriptionCount()).toBe(0);
    hub.dispatch(note());
    expect(c.changes).toHaveLength(0);
  });

  it('unsubscribe without channel errors', () => {
    const hub = new Hub();
    const c = new FakeClient();
    hub.add(c, CLAIMS);
    hub.handleMessage(c, JSON.stringify({ type: 'unsubscribe' }));
    expect(c.last?.type).toBe('error');
  });
});

describe('Hub — event matching', () => {
  it('"*" receives all event types', () => {
    const hub = new Hub();
    const c = new FakeClient();
    hub.add(c, CLAIMS);
    hub.handleMessage(c, JSON.stringify({ type: 'subscribe', channel: 'notes', event: '*' }));
    hub.dispatch(note({ type: 'INSERT' }));
    hub.dispatch(note({ type: 'UPDATE' }));
    hub.dispatch(note({ type: 'DELETE', record: null, old: { id: '1' } }));
    expect(c.changes).toHaveLength(3);
  });

  it('a specific event only receives that event', () => {
    const hub = new Hub();
    const c = new FakeClient();
    hub.add(c, CLAIMS);
    hub.handleMessage(c, JSON.stringify({ type: 'subscribe', channel: 'notes', event: 'UPDATE' }));
    hub.dispatch(note({ type: 'INSERT' }));
    hub.dispatch(note({ type: 'UPDATE' }));
    expect(c.changes).toHaveLength(1);
    expect(c.changes[0].event).toBe('UPDATE');
  });

  it('does not deliver changes for a different table', () => {
    const hub = new Hub();
    const c = new FakeClient();
    hub.add(c, CLAIMS);
    hub.handleMessage(c, JSON.stringify({ type: 'subscribe', channel: 'notes' }));
    hub.dispatch(note({ table: 'other' }));
    expect(c.changes).toHaveLength(0);
  });
});

describe('Hub — filter matching', () => {
  it('delivers only rows matching the equality filter', () => {
    const hub = new Hub();
    const c = new FakeClient();
    hub.add(c, CLAIMS);
    hub.handleMessage(
      c,
      JSON.stringify({ type: 'subscribe', channel: 'notes', filter: { column: 'user_id', value: 'u1' } }),
    );
    hub.dispatch(note({ record: { id: '1', user_id: 'u1' } }));
    hub.dispatch(note({ record: { id: '2', user_id: 'u2' } }));
    expect(c.changes).toHaveLength(1);
    expect((c.changes[0].record as Record<string, unknown>).id).toBe('1');
  });

  it('tolerates number/string equality across the wire', () => {
    expect(matchesFilter({ column: 'id', value: 5 }, note({ record: { id: '5' } }))).toBe(true);
    expect(matchesFilter({ column: 'id', value: '5' }, note({ record: { id: 5 } }))).toBe(true);
  });

  it('filter on DELETE falls back to old', () => {
    expect(
      matchesFilter({ column: 'user_id', value: 'u1' }, note({ type: 'DELETE', record: null, old: { user_id: 'u1' } })),
    ).toBe(true);
  });

  it('excludes when column is absent or row missing', () => {
    expect(matchesFilter({ column: 'missing', value: 1 }, note())).toBe(false);
    expect(matchesFilter({ column: 'id', value: 1 }, note({ record: null, old: null }))).toBe(false);
  });
});

describe('Hub — fan-out to multiple clients', () => {
  it('delivers to every matching client, skips non-matching', () => {
    const hub = new Hub();
    const a = new FakeClient();
    const b = new FakeClient();
    const d = new FakeClient();
    hub.add(a, CLAIMS);
    hub.add(b, CLAIMS);
    hub.add(d, CLAIMS);
    hub.handleMessage(a, JSON.stringify({ type: 'subscribe', channel: 'notes' }));
    hub.handleMessage(b, JSON.stringify({ type: 'subscribe', channel: 'notes', event: 'INSERT' }));
    hub.handleMessage(d, JSON.stringify({ type: 'subscribe', channel: 'other' }));

    hub.dispatch(note({ type: 'INSERT' }));
    expect(a.changes).toHaveLength(1);
    expect(b.changes).toHaveLength(1);
    expect(d.changes).toHaveLength(0);
  });

  it('a throwing client does not abort fan-out to others', () => {
    const hub = new Hub();
    const bad = new FakeClient();
    bad.send.mockImplementation(() => {
      throw new Error('dead socket');
    });
    const good = new FakeClient();
    hub.add(bad, CLAIMS);
    hub.add(good, CLAIMS);
    // subscribe good directly (bad's ack will throw but that's fine)
    hub.handleMessage(good, JSON.stringify({ type: 'subscribe', channel: 'notes' }));
    // manually register bad's subscription by re-adding state via subscribe attempt
    hub.handleMessage(bad, JSON.stringify({ type: 'subscribe', channel: 'notes' }));
    expect(() => hub.dispatch(note())).not.toThrow();
    expect(good.changes).toHaveLength(1);
  });

  it('change frame carries channel, event, record, and old', () => {
    const hub = new Hub();
    const c = new FakeClient();
    hub.add(c, CLAIMS);
    hub.handleMessage(c, JSON.stringify({ type: 'subscribe', channel: 'notes' }));
    hub.dispatch(note({ type: 'UPDATE', record: { id: '1', body: 'new' }, old: { id: '1', body: 'old' } }));
    expect(c.changes[0]).toEqual({
      type: 'change',
      channel: 'notes',
      event: 'UPDATE',
      record: { id: '1', body: 'new' },
      old: { id: '1', body: 'old' },
    });
  });

  it('passes through the truncated flag', () => {
    const hub = new Hub();
    const c = new FakeClient();
    hub.add(c, CLAIMS);
    hub.handleMessage(c, JSON.stringify({ type: 'subscribe', channel: 'notes' }));
    hub.dispatch(note({ record: { id: '1' }, truncated: true }));
    expect(c.changes[0].truncated).toBe(true);
  });
});

describe('Hub — malformed messages & lifecycle', () => {
  it('rejects non-JSON frames with an error', () => {
    const hub = new Hub();
    const c = new FakeClient();
    hub.add(c, CLAIMS);
    hub.handleMessage(c, 'not json{');
    expect(c.last?.type).toBe('error');
  });

  it('rejects unknown message types', () => {
    const hub = new Hub();
    const c = new FakeClient();
    hub.add(c, CLAIMS);
    hub.handleMessage(c, JSON.stringify({ type: 'frobnicate' }));
    expect(c.last?.type).toBe('error');
  });

  it('ignores messages from unregistered targets', () => {
    const hub = new Hub();
    const c = new FakeClient();
    // not added
    hub.handleMessage(c, JSON.stringify({ type: 'subscribe', channel: 'notes' }));
    expect(c.send).not.toHaveBeenCalled();
  });

  it('remove() drops subscriptions; no delivery after disconnect', () => {
    const hub = new Hub();
    const c = new FakeClient();
    hub.add(c, CLAIMS);
    hub.handleMessage(c, JSON.stringify({ type: 'subscribe', channel: 'notes' }));
    expect(hub.clientCount).toBe(1);
    hub.remove(c);
    expect(hub.clientCount).toBe(0);
    hub.dispatch(note());
    expect(c.changes).toHaveLength(0);
  });

  it('treats {type:"auth"} as a benign no-op after connect', () => {
    const hub = new Hub();
    const c = new FakeClient();
    hub.add(c, CLAIMS);
    hub.handleMessage(c, JSON.stringify({ type: 'auth', token: 'whatever' }));
    expect(c.send).not.toHaveBeenCalled();
  });
});

describe('parseNotification', () => {
  it('parses a well-formed payload', () => {
    const n = parseNotification(
      JSON.stringify({ schema: 'public', table: 'notes', type: 'INSERT', record: { id: '1' }, old: null }),
    );
    expect(n).not.toBeNull();
    expect(n?.table).toBe('notes');
    expect(n?.type).toBe('INSERT');
  });

  it('returns null on invalid JSON', () => {
    expect(parseNotification('{bad')).toBeNull();
  });

  it('returns null on missing/invalid fields', () => {
    expect(parseNotification(JSON.stringify({ schema: 'public' }))).toBeNull();
    expect(parseNotification(JSON.stringify({ schema: 'public', table: 'x', type: 'UPSERT' }))).toBeNull();
  });

  it('reads the truncated flag', () => {
    const n = parseNotification(
      JSON.stringify({ schema: 'public', table: 'notes', type: 'UPDATE', record: { id: '1' }, old: null, truncated: true }),
    );
    expect(n?.truncated).toBe(true);
  });
});
