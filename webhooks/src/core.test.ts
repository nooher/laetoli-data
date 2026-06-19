import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  parseNotification,
  matchEndpoint,
  buildBody,
  sign,
  shouldRetry,
  backoffMs,
  type Endpoint,
  type Notification,
} from './core.js';

const hmac = (key: string, msg: string) =>
  crypto.createHmac('sha256', key).update(msg).digest('hex');

function ep(over: Partial<Endpoint> = {}): Endpoint {
  return {
    id: 'e1',
    name: 'test',
    table_name: 'notes',
    events: ['INSERT', 'UPDATE', 'DELETE'],
    url: 'https://x/hook',
    secret: null,
    active: true,
    ...over,
  };
}

function note(over: Partial<Notification> = {}): Notification {
  return {
    schema: 'public',
    table: 'notes',
    type: 'INSERT',
    record: { id: 1, body: 'hi' },
    old: null,
    ...over,
  };
}

describe('parseNotification', () => {
  it('parses a valid INSERT payload', () => {
    const n = parseNotification(
      JSON.stringify({ schema: 'public', table: 'notes', type: 'INSERT', record: { id: 1 }, old: null })
    );
    expect(n).toEqual({ schema: 'public', table: 'notes', type: 'INSERT', record: { id: 1 }, old: null, truncated: false });
  });

  it('carries the truncated flag', () => {
    const n = parseNotification(
      JSON.stringify({ schema: 'public', table: 'big', type: 'UPDATE', record: { id: 9 }, old: null, truncated: true })
    );
    expect(n?.truncated).toBe(true);
  });

  it('returns null on invalid JSON', () => {
    expect(parseNotification('{not json')).toBeNull();
  });

  it('returns null on an unknown event type', () => {
    expect(parseNotification(JSON.stringify({ schema: 's', table: 't', type: 'TRUNCATE' }))).toBeNull();
  });

  it('returns null when schema/table missing', () => {
    expect(parseNotification(JSON.stringify({ type: 'INSERT' }))).toBeNull();
  });

  it('coerces a non-object record to null', () => {
    const n = parseNotification(JSON.stringify({ schema: 'p', table: 't', type: 'DELETE', record: 'x', old: { id: 1 } }));
    expect(n?.record).toBeNull();
    expect(n?.old).toEqual({ id: 1 });
  });
});

describe('matchEndpoint', () => {
  it('matches a bare table name + event', () => {
    expect(matchEndpoint(ep({ table_name: 'notes' }), note())).toBe(true);
  });

  it('matches a schema-qualified name', () => {
    expect(matchEndpoint(ep({ table_name: 'public.notes' }), note())).toBe(true);
  });

  it('does not match a different schema for a qualified name', () => {
    expect(matchEndpoint(ep({ table_name: 'other.notes' }), note())).toBe(false);
  });

  it('rejects a non-matching table', () => {
    expect(matchEndpoint(ep({ table_name: 'orders' }), note())).toBe(false);
  });

  it('rejects an event not in events[]', () => {
    expect(matchEndpoint(ep({ events: ['INSERT'] }), note({ type: 'DELETE' }))).toBe(false);
  });

  it('rejects an inactive endpoint', () => {
    expect(matchEndpoint(ep({ active: false }), note())).toBe(false);
  });

  it('rejects an empty table_name', () => {
    expect(matchEndpoint(ep({ table_name: '   ' }), note())).toBe(false);
  });
});

describe('buildBody + sign', () => {
  it('builds the {schema,table,type,record,old} body', () => {
    const body = buildBody(note());
    expect(JSON.parse(body)).toEqual({ schema: 'public', table: 'notes', type: 'INSERT', record: { id: 1, body: 'hi' }, old: null });
  });

  it('includes truncated when set', () => {
    const body = buildBody(note({ truncated: true }));
    expect(JSON.parse(body).truncated).toBe(true);
  });

  it('returns null signature when no secret', () => {
    expect(sign('body', null, hmac)).toBeNull();
  });

  it('produces a verifiable sha256= signature with a secret', () => {
    const body = buildBody(note());
    const sig = sign(body, 's3cr3t', hmac);
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    // Receiver-side verification reproduces the same value.
    expect(sig).toBe(`sha256=${hmac('s3cr3t', body)}`);
  });
});

describe('shouldRetry', () => {
  it('retries on a network error (null status) while attempts remain', () => {
    expect(shouldRetry({ ok: false, statusCode: null, error: 'timeout' }, 1, 3)).toBe(true);
  });

  it('retries on 5xx', () => {
    expect(shouldRetry({ ok: false, statusCode: 503, error: 'x' }, 1, 3)).toBe(true);
  });

  it('retries on 429', () => {
    expect(shouldRetry({ ok: false, statusCode: 429, error: 'x' }, 1, 3)).toBe(true);
  });

  it('does NOT retry a 2xx success', () => {
    expect(shouldRetry({ ok: true, statusCode: 200, error: null }, 1, 3)).toBe(false);
  });

  it('does NOT retry a 4xx client error', () => {
    expect(shouldRetry({ ok: false, statusCode: 404, error: 'x' }, 1, 3)).toBe(false);
  });

  it('stops once attempts are exhausted', () => {
    expect(shouldRetry({ ok: false, statusCode: 500, error: 'x' }, 3, 3)).toBe(false);
  });
});

describe('backoffMs', () => {
  it('no wait before the first attempt', () => {
    expect(backoffMs(1, 500)).toBe(0);
  });
  it('exponential thereafter', () => {
    expect(backoffMs(2, 500)).toBe(500);
    expect(backoffMs(3, 500)).toBe(1000);
    expect(backoffMs(4, 500)).toBe(2000);
  });
});
