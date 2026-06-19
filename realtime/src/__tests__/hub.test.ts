import { describe, it, expect } from 'vitest';
import {
  Hub,
  matchesFilter,
  parseNotification,
  recipientsFor,
  broadcastRecipients,
  PresenceRegistry,
  type Notification,
  type SubscriberView,
} from '../hub.js';
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
    // subscribe acks with `subscribed`, then a presence `sync` snapshot follows.
    expect(c.messages).toContainEqual({ type: 'subscribed', channel: 'notes' });
    expect(hub.subscriptionCount()).toBe(1);
  });

  it('defaults event to "*" when omitted', () => {
    const hub = new Hub();
    const c = new FakeClient();
    hub.add(c, CLAIMS);
    hub.handleMessage(c, JSON.stringify({ type: 'subscribe', channel: 'notes' }));
    expect(c.messages.map((m) => m.type)).toContain('subscribed');
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

  it('passes through the truncated flag to an entitled (admin) subscriber', () => {
    // Truncated rows fail closed for owner-scoped subscribers (the owner cannot
    // be determined), but admin/service connections still receive them — and the
    // truncated flag must survive on the frame.
    const hub = new Hub();
    const c = new FakeClient();
    hub.add(c, { sub: 'svc', role: 'service' });
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

describe('recipientsFor — owner-scoped filtering (pure)', () => {
  const sub = (s: string, event = '*', role = 'authenticated'): SubscriberView => ({
    claims: { sub: s, role },
    sub: { channel: 'notes', event: event as SubscriberView['sub']['event'] },
  });

  it('owner-scoped row: only the matching sub is a recipient', () => {
    const subs = [sub('u1'), sub('u2'), sub('u3')];
    const got = recipientsFor(note({ record: { id: '1', user_id: 'u2' } }), subs);
    expect(got).toHaveLength(1);
    expect(got[0].claims.sub).toBe('u2');
  });

  it('respects the configured owner-column order (owner before fallback)', () => {
    const subs = [sub('owner-x'), sub('uid-y')];
    // Row carries BOTH; first configured column (owner) wins.
    const got = recipientsFor(
      note({ record: { id: '1', owner: 'owner-x', user_id: 'uid-y' } }),
      subs,
      ['owner', 'user_id'],
    );
    expect(got.map((g) => g.claims.sub)).toEqual(['owner-x']);
  });

  it('honors a custom owner column', () => {
    const subs = [sub('u1'), sub('u2')];
    const got = recipientsFor(note({ record: { id: '1', tenant: 'u2' } }), subs, ['tenant']);
    expect(got.map((g) => g.claims.sub)).toEqual(['u2']);
  });

  it('table with NO owner column: everyone is a recipient (back-compat)', () => {
    const subs = [sub('u1'), sub('u2')];
    const got = recipientsFor(note({ record: { id: '1', body: 'public-ish' } }), subs);
    expect(got).toHaveLength(2);
  });

  it('DELETE uses old to resolve the owner', () => {
    const subs = [sub('u1'), sub('u2')];
    const got = recipientsFor(
      note({ type: 'DELETE', record: null, old: { id: '1', user_id: 'u1' } }),
      subs,
    );
    expect(got.map((g) => g.claims.sub)).toEqual(['u1']);
  });

  it('admin/service role bypasses owner scoping', () => {
    const subs = [sub('svc', '*', 'service'), sub('adm', '*', 'laetoli_admin'), sub('u9')];
    const got = recipientsFor(note({ record: { id: '1', user_id: 'someone-else' } }), subs);
    expect(got.map((g) => g.claims.sub).sort()).toEqual(['adm', 'svc']);
  });

  it('FAIL CLOSED: truncated owner-scoped row → no non-admin recipients', () => {
    const subs = [sub('u1'), sub('u2')];
    const got = recipientsFor(note({ record: { id: '1' }, truncated: true }), subs);
    expect(got).toHaveLength(0);
  });

  it('FAIL CLOSED: truncated row still reaches admin/service connections', () => {
    const subs = [sub('u1'), sub('svc', '*', 'service')];
    const got = recipientsFor(note({ record: { id: '1' }, truncated: true }), subs);
    expect(got.map((g) => g.claims.sub)).toEqual(['svc']);
  });

  it('tolerates a numeric owner value vs string sub', () => {
    const subs = [sub('42'), sub('7')];
    const got = recipientsFor(note({ record: { id: '1', user_id: 42 } }), subs);
    expect(got.map((g) => g.claims.sub)).toEqual(['42']);
  });

  it('excludes everyone when the owner value is null', () => {
    const subs = [sub('u1'), sub('u2')];
    const got = recipientsFor(note({ record: { id: '1', user_id: null } }), subs);
    expect(got).toHaveLength(0);
  });
});

describe('Hub — owner-scoped fan-out (integration)', () => {
  const ownerClaims = (s: string, role = 'authenticated') => ({ sub: s, role });

  it('delivers an owner-scoped change ONLY to the owner', () => {
    const hub = new Hub();
    const a = new FakeClient();
    const b = new FakeClient();
    hub.add(a, ownerClaims('u1'));
    hub.add(b, ownerClaims('u2'));
    hub.handleMessage(a, JSON.stringify({ type: 'subscribe', channel: 'notes' }));
    hub.handleMessage(b, JSON.stringify({ type: 'subscribe', channel: 'notes' }));

    hub.dispatch(note({ record: { id: '1', user_id: 'u1', body: 'A only' } }));
    expect(a.changes).toHaveLength(1);
    expect(b.changes).toHaveLength(0);
  });

  it('a table without an owner column still broadcasts to all', () => {
    const hub = new Hub();
    const a = new FakeClient();
    const b = new FakeClient();
    hub.add(a, ownerClaims('u1'));
    hub.add(b, ownerClaims('u2'));
    hub.handleMessage(a, JSON.stringify({ type: 'subscribe', channel: 'logs' }));
    hub.handleMessage(b, JSON.stringify({ type: 'subscribe', channel: 'logs' }));

    hub.dispatch(note({ table: 'logs', record: { id: '1', message: 'boot' } }));
    expect(a.changes).toHaveLength(1);
    expect(b.changes).toHaveLength(1);
  });

  it('truncated owner-scoped row is NOT delivered to a regular subscriber', () => {
    const hub = new Hub();
    const a = new FakeClient();
    hub.add(a, ownerClaims('u1'));
    hub.handleMessage(a, JSON.stringify({ type: 'subscribe', channel: 'notes' }));
    hub.dispatch(note({ record: { id: '1' }, truncated: true }));
    expect(a.changes).toHaveLength(0);
  });

  it('owner gate composes with the equality filter', () => {
    const hub = new Hub();
    const a = new FakeClient();
    hub.add(a, ownerClaims('u1'));
    // owner matches, but filter on body excludes
    hub.handleMessage(
      a,
      JSON.stringify({ type: 'subscribe', channel: 'notes', filter: { column: 'body', value: 'keep' } }),
    );
    hub.dispatch(note({ record: { id: '1', user_id: 'u1', body: 'drop' } }));
    expect(a.changes).toHaveLength(0);
    hub.dispatch(note({ record: { id: '2', user_id: 'u1', body: 'keep' } }));
    expect(a.changes).toHaveLength(1);
  });

  it('a custom ownerColumns config gates fan-out', () => {
    const hub = new Hub(['tenant']);
    const a = new FakeClient();
    const b = new FakeClient();
    hub.add(a, ownerClaims('t1'));
    hub.add(b, ownerClaims('t2'));
    hub.handleMessage(a, JSON.stringify({ type: 'subscribe', channel: 'notes' }));
    hub.handleMessage(b, JSON.stringify({ type: 'subscribe', channel: 'notes' }));
    hub.dispatch(note({ record: { id: '1', tenant: 't2', user_id: 't1' } }));
    // user_id is NOT in the configured set, so only tenant matters → b only.
    expect(a.changes).toHaveLength(0);
    expect(b.changes).toHaveLength(1);
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

describe('broadcastRecipients — pure', () => {
  it('excludes the sender by default', () => {
    const a = {}, b = {}, c = {};
    expect(broadcastRecipients([a, b, c], a)).toEqual([b, c]);
  });

  it('echoes to the sender when echoSelf=true', () => {
    const a = {}, b = {};
    expect(broadcastRecipients([a, b], a, true)).toEqual([a, b]);
  });

  it('handles a sender that is not in the subscriber list', () => {
    const a = {}, b = {}, outsider = {};
    expect(broadcastRecipients([a, b], outsider)).toEqual([a, b]);
  });

  it('returns empty when the only subscriber is the sender', () => {
    const a = {};
    expect(broadcastRecipients([a], a)).toEqual([]);
  });
});

describe('PresenceRegistry — pure', () => {
  it('tracks and snapshots a presence', () => {
    const reg = new PresenceRegistry<object>();
    const c = {};
    const entry = reg.track('room', c, 'u1', { name: 'Ada' });
    expect(entry.sub).toBe('u1');
    expect(reg.snapshot('room')).toEqual([{ ref: entry.ref, sub: 'u1', state: { name: 'Ada' } }]);
    expect(reg.has('room', c)).toBe(true);
  });

  it('assigns a stable ref per connection across channels', () => {
    const reg = new PresenceRegistry<object>();
    const c = {};
    const r1 = reg.track('a', c, 'u1', {}).ref;
    const r2 = reg.track('b', c, 'u1', {}).ref;
    expect(r1).toBe(r2);
  });

  it('untrack removes one channel and reports whether it removed', () => {
    const reg = new PresenceRegistry<object>();
    const c = {};
    reg.track('room', c, 'u1', {});
    expect(reg.untrack('room', c)).toBe(true);
    expect(reg.untrack('room', c)).toBe(false);
    expect(reg.snapshot('room')).toEqual([]);
  });

  it('removeConnection clears all channels and lists them', () => {
    const reg = new PresenceRegistry<object>();
    const c = {};
    reg.track('a', c, 'u1', {});
    reg.track('b', c, 'u1', {});
    expect(reg.removeConnection(c).sort()).toEqual(['a', 'b']);
    expect(reg.snapshot('a')).toEqual([]);
    expect(reg.snapshot('b')).toEqual([]);
  });

  it('keeps separate entries per connection, even same sub', () => {
    const reg = new PresenceRegistry<object>();
    const c1 = {}, c2 = {};
    reg.track('room', c1, 'u1', { tab: 1 });
    reg.track('room', c2, 'u1', { tab: 2 });
    expect(reg.snapshot('room')).toHaveLength(2);
  });
});

describe('Hub — broadcast (ephemeral relay)', () => {
  it('relays a broadcast to OTHER subscribers, not the sender', () => {
    const hub = new Hub();
    const a = new FakeClient();
    const b = new FakeClient();
    hub.add(a, CLAIMS);
    hub.add(b, { sub: 'u2', role: 'authenticated' });
    hub.handleMessage(a, JSON.stringify({ type: 'subscribe', channel: 'room' }));
    hub.handleMessage(b, JSON.stringify({ type: 'subscribe', channel: 'room' }));
    hub.handleMessage(a, JSON.stringify({ type: 'broadcast', channel: 'room', event: 'cursor', payload: { x: 1 } }));
    expect(b.broadcasts).toHaveLength(1);
    expect(b.broadcasts[0]).toMatchObject({ channel: 'room', event: 'cursor', payload: { x: 1 }, from: 'u1' });
    expect(a.broadcasts).toHaveLength(0); // sender excluded by default
  });

  it('echoes to the sender when broadcastSelf=true', () => {
    const hub = new Hub(undefined, true);
    const a = new FakeClient();
    hub.add(a, CLAIMS);
    hub.handleMessage(a, JSON.stringify({ type: 'subscribe', channel: 'room' }));
    hub.handleMessage(a, JSON.stringify({ type: 'broadcast', channel: 'room', event: 'ping', payload: 1 }));
    expect(a.broadcasts).toHaveLength(1);
  });

  it('ignores owner-RLS — broadcast reaches every channel subscriber', () => {
    const hub = new Hub();
    const a = new FakeClient();
    const b = new FakeClient();
    hub.add(a, { sub: 'u1', role: 'authenticated' });
    hub.add(b, { sub: 'u2', role: 'authenticated' });
    hub.handleMessage(a, JSON.stringify({ type: 'subscribe', channel: 'room' }));
    hub.handleMessage(b, JSON.stringify({ type: 'subscribe', channel: 'room' }));
    hub.handleMessage(a, JSON.stringify({ type: 'broadcast', channel: 'room', event: 'e', payload: 'x' }));
    expect(b.broadcasts).toHaveLength(1);
  });

  it('does not relay to subscribers of a different channel', () => {
    const hub = new Hub();
    const a = new FakeClient();
    const b = new FakeClient();
    hub.add(a, CLAIMS);
    hub.add(b, CLAIMS);
    hub.handleMessage(a, JSON.stringify({ type: 'subscribe', channel: 'room' }));
    hub.handleMessage(b, JSON.stringify({ type: 'subscribe', channel: 'other' }));
    hub.handleMessage(a, JSON.stringify({ type: 'broadcast', channel: 'room', event: 'e', payload: 1 }));
    expect(b.broadcasts).toHaveLength(0);
  });

  it('errors on a broadcast missing channel or event', () => {
    const hub = new Hub();
    const a = new FakeClient();
    hub.add(a, CLAIMS);
    hub.handleMessage(a, JSON.stringify({ type: 'broadcast', event: 'e', payload: 1 }));
    expect(a.last?.type).toBe('error');
    hub.handleMessage(a, JSON.stringify({ type: 'broadcast', channel: 'room', payload: 1 }));
    expect(a.last?.type).toBe('error');
  });
});

describe('Hub — presence', () => {
  it('sends a presence sync (empty) right after subscribe', () => {
    const hub = new Hub();
    const a = new FakeClient();
    hub.add(a, CLAIMS);
    hub.handleMessage(a, JSON.stringify({ type: 'subscribe', channel: 'room' }));
    expect(a.presences).toHaveLength(1);
    expect(a.presences[0]).toMatchObject({ channel: 'room', event: 'sync', presences: [] });
  });

  it('track announces a join to all channel subscribers including the tracker', () => {
    const hub = new Hub();
    const a = new FakeClient();
    const b = new FakeClient();
    hub.add(a, { sub: 'u1', role: 'authenticated' });
    hub.add(b, { sub: 'u2', role: 'authenticated' });
    hub.handleMessage(a, JSON.stringify({ type: 'subscribe', channel: 'room' }));
    hub.handleMessage(b, JSON.stringify({ type: 'subscribe', channel: 'room' }));
    hub.handleMessage(a, JSON.stringify({ type: 'presence_track', channel: 'room', state: { name: 'Ada' } }));
    // both A and B should see a join frame showing A's presence
    const aJoin = a.presences.filter((p) => p.event === 'join');
    const bJoin = b.presences.filter((p) => p.event === 'join');
    expect(aJoin).toHaveLength(1);
    expect(bJoin).toHaveLength(1);
    expect((bJoin[0].presences as unknown[])).toHaveLength(1);
    expect((bJoin[0].presences as Array<Record<string, unknown>>)[0]).toMatchObject({ sub: 'u1', state: { name: 'Ada' } });
  });

  it('a late subscriber gets the current roster in its sync', () => {
    const hub = new Hub();
    const a = new FakeClient();
    const b = new FakeClient();
    hub.add(a, { sub: 'u1', role: 'authenticated' });
    hub.add(b, { sub: 'u2', role: 'authenticated' });
    hub.handleMessage(a, JSON.stringify({ type: 'subscribe', channel: 'room' }));
    hub.handleMessage(a, JSON.stringify({ type: 'presence_track', channel: 'room', state: { name: 'Ada' } }));
    hub.handleMessage(b, JSON.stringify({ type: 'subscribe', channel: 'room' }));
    const bSync = b.presences.find((p) => p.event === 'sync');
    expect((bSync?.presences as unknown[])).toHaveLength(1);
  });

  it('untrack announces a leave', () => {
    const hub = new Hub();
    const a = new FakeClient();
    const b = new FakeClient();
    hub.add(a, { sub: 'u1', role: 'authenticated' });
    hub.add(b, { sub: 'u2', role: 'authenticated' });
    hub.handleMessage(a, JSON.stringify({ type: 'subscribe', channel: 'room' }));
    hub.handleMessage(b, JSON.stringify({ type: 'subscribe', channel: 'room' }));
    hub.handleMessage(a, JSON.stringify({ type: 'presence_track', channel: 'room', state: {} }));
    hub.handleMessage(a, JSON.stringify({ type: 'presence_untrack', channel: 'room' }));
    const bLeave = b.presences.filter((p) => p.event === 'leave');
    expect(bLeave).toHaveLength(1);
    expect((bLeave[0].presences as unknown[])).toHaveLength(0);
  });

  it('disconnect (remove) announces a leave to remaining subscribers', () => {
    const hub = new Hub();
    const a = new FakeClient();
    const b = new FakeClient();
    hub.add(a, { sub: 'u1', role: 'authenticated' });
    hub.add(b, { sub: 'u2', role: 'authenticated' });
    hub.handleMessage(a, JSON.stringify({ type: 'subscribe', channel: 'room' }));
    hub.handleMessage(b, JSON.stringify({ type: 'subscribe', channel: 'room' }));
    hub.handleMessage(a, JSON.stringify({ type: 'presence_track', channel: 'room', state: {} }));
    hub.remove(a);
    const bLeave = b.presences.filter((p) => p.event === 'leave');
    expect(bLeave).toHaveLength(1);
    expect((bLeave.at(-1)!.presences as unknown[])).toHaveLength(0);
  });

  it('unsubscribe also drops presence with a leave', () => {
    const hub = new Hub();
    const a = new FakeClient();
    const b = new FakeClient();
    hub.add(a, { sub: 'u1', role: 'authenticated' });
    hub.add(b, { sub: 'u2', role: 'authenticated' });
    hub.handleMessage(a, JSON.stringify({ type: 'subscribe', channel: 'room' }));
    hub.handleMessage(b, JSON.stringify({ type: 'subscribe', channel: 'room' }));
    hub.handleMessage(a, JSON.stringify({ type: 'presence_track', channel: 'room', state: {} }));
    hub.handleMessage(a, JSON.stringify({ type: 'unsubscribe', channel: 'room' }));
    expect(b.presences.filter((p) => p.event === 'leave')).toHaveLength(1);
  });

  it('errors on presence_track without a channel', () => {
    const hub = new Hub();
    const a = new FakeClient();
    hub.add(a, CLAIMS);
    hub.handleMessage(a, JSON.stringify({ type: 'presence_track', state: {} }));
    expect(a.last?.type).toBe('error');
  });
});
