import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  isDue,
  computeNextRun,
  planAction,
  sign,
  buildHttpBody,
  buildHttpHeaders,
  authorizeRunNow,
  type Job,
} from './core.js';

const hmac = (key: string, msg: string) =>
  crypto.createHmac('sha256', key).update(msg).digest('hex');

function job(over: Partial<Job> = {}): Job {
  return {
    id: 'j1',
    name: 'test',
    cron: '*/5 * * * *',
    kind: 'sql',
    sql: 'SELECT 1',
    url: null,
    headers: null,
    body: null,
    secret: null,
    active: true,
    next_run: null,
    ...over,
  };
}

describe('isDue', () => {
  const now = new Date('2026-06-19T12:00:00Z');

  it('is not due when inactive', () => {
    expect(isDue(job({ active: false, next_run: '2026-06-19T11:00:00Z' }), now)).toBe(false);
  });
  it('is not due with no next_run (brand-new job)', () => {
    expect(isDue(job({ next_run: null }), now)).toBe(false);
  });
  it('is due when next_run is in the past', () => {
    expect(isDue(job({ next_run: '2026-06-19T11:59:00Z' }), now)).toBe(true);
  });
  it('is due exactly at next_run', () => {
    expect(isDue(job({ next_run: '2026-06-19T12:00:00Z' }), now)).toBe(true);
  });
  it('is not due when next_run is in the future', () => {
    expect(isDue(job({ next_run: '2026-06-19T12:01:00Z' }), now)).toBe(false);
  });
  it('is not due with an unparseable next_run', () => {
    expect(isDue(job({ next_run: 'not-a-date' }), now)).toBe(false);
  });
});

describe('computeNextRun', () => {
  it('computes the next 5-minute boundary strictly after from', () => {
    const next = computeNextRun('*/5 * * * *', new Date('2026-06-19T12:02:30Z'));
    expect(next.toISOString()).toBe('2026-06-19T12:05:00.000Z');
  });
  it('computes daily 02:00 next instant', () => {
    const next = computeNextRun('0 2 * * *', new Date('2026-06-19T12:00:00Z'));
    expect(next.toISOString()).toBe('2026-06-20T02:00:00.000Z');
  });
  it('throws on a malformed cron string', () => {
    expect(() => computeNextRun('not a cron', new Date())).toThrow();
  });
  it('throws on a 3-field cron string', () => {
    expect(() => computeNextRun('0 2 *', new Date())).toThrow();
  });
});

describe('planAction', () => {
  it('plans a valid sql job', () => {
    expect(planAction(job({ kind: 'sql', sql: 'SELECT 1' }))).toEqual({
      kind: 'sql',
      sql: 'SELECT 1',
    });
  });
  it('rejects a sql job with empty sql', () => {
    const p = planAction(job({ kind: 'sql', sql: '   ' }));
    expect(p.kind).toBe('invalid');
  });
  it('rejects a sql job with null sql', () => {
    const p = planAction(job({ kind: 'sql', sql: null }));
    expect(p.kind).toBe('invalid');
  });
  it('plans a valid http job', () => {
    const p = planAction(job({ kind: 'http', sql: null, url: 'https://x/hook' }));
    expect(p).toEqual({ kind: 'http', url: 'https://x/hook' });
  });
  it('accepts http:// urls', () => {
    const p = planAction(job({ kind: 'http', sql: null, url: 'http://functions:9995/tick' }));
    expect(p.kind).toBe('http');
  });
  it('rejects a http job with empty url', () => {
    const p = planAction(job({ kind: 'http', sql: null, url: '' }));
    expect(p.kind).toBe('invalid');
  });
  it('rejects a http job with a non-http url scheme', () => {
    const p = planAction(job({ kind: 'http', sql: null, url: 'ftp://x/hook' }));
    expect(p.kind).toBe('invalid');
  });
});

describe('sign', () => {
  it('returns null without a secret', () => {
    expect(sign('body', null, hmac)).toBeNull();
    expect(sign('body', '', hmac)).toBeNull();
  });
  it('returns sha256=<hex> with a secret', () => {
    const s = sign('body', 'k', hmac);
    expect(s).toBe(`sha256=${hmac('k', 'body')}`);
    expect(s).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
});

describe('buildHttpBody', () => {
  it('wraps a null body as {}', () => {
    const b = JSON.parse(buildHttpBody(job({ kind: 'http', body: null })));
    expect(b).toEqual({ job: { id: 'j1', name: 'test' }, body: {} });
  });
  it('preserves an operator-supplied body', () => {
    const b = JSON.parse(buildHttpBody(job({ kind: 'http', body: { source: 'cron' } })));
    expect(b.body).toEqual({ source: 'cron' });
  });
  it('is stable / deterministic for signing', () => {
    const j = job({ kind: 'http', body: { a: 1 } });
    expect(buildHttpBody(j)).toBe(buildHttpBody(j));
  });
});

describe('buildHttpHeaders', () => {
  it('includes the standard headers + job id', () => {
    const body = buildHttpBody(job({ kind: 'http' }));
    const h = buildHttpHeaders(job({ kind: 'http' }), body, hmac);
    expect(h['Content-Type']).toBe('application/json');
    expect(h['X-Laetoli-Job']).toBe('j1');
    expect(h['User-Agent']).toContain('Laetoli-Data-Scheduler');
  });
  it('adds the signature when a secret is set', () => {
    const j = job({ kind: 'http', secret: 'k' });
    const body = buildHttpBody(j);
    const h = buildHttpHeaders(j, body, hmac);
    expect(h['X-Laetoli-Signature']).toBe(`sha256=${hmac('k', body)}`);
  });
  it('omits the signature without a secret', () => {
    const j = job({ kind: 'http', secret: null });
    const h = buildHttpHeaders(j, buildHttpBody(j), hmac);
    expect(h['X-Laetoli-Signature']).toBeUndefined();
  });
  it('merges operator-supplied string headers', () => {
    const j = job({ kind: 'http', headers: { 'X-Custom': 'v', 'X-Num': 7 as unknown as string } });
    const h = buildHttpHeaders(j, buildHttpBody(j), hmac);
    expect(h['X-Custom']).toBe('v');
    expect(h['X-Num']).toBe('7');
  });
});

describe('authorizeRunNow', () => {
  it('allows everything when no key is configured', () => {
    expect(authorizeRunNow(null, {})).toBe(true);
  });
  it('allows a matching X-Admin-Key', () => {
    expect(authorizeRunNow('secret', { adminKey: 'secret' })).toBe(true);
  });
  it('allows a matching Bearer token', () => {
    expect(authorizeRunNow('secret', { authorization: 'Bearer secret' })).toBe(true);
  });
  it('rejects a wrong key', () => {
    expect(authorizeRunNow('secret', { adminKey: 'nope' })).toBe(false);
  });
  it('rejects a missing key when one is configured', () => {
    expect(authorizeRunNow('secret', {})).toBe(false);
  });
});
