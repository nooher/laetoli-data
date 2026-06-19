import { describe, it, expect, vi } from 'vitest';
import crypto from 'node:crypto';
import { Executor, type FetchLike } from './executor.js';
import { FakeStore, type SqlExecResult } from './db.js';
import type { Job } from './core.js';

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

const fixedNow = new Date('2026-06-19T12:02:30Z');

/** A fetch stub recording its last call and returning a canned response. */
function fakeFetch(status = 200): { fn: FetchLike; calls: Array<{ url: string; init: any }> } {
  const calls: Array<{ url: string; init: any }> = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status };
  };
  return { fn, calls };
}

function makeExecutor(
  store: FakeStore,
  fetchImpl: FetchLike = fakeFetch().fn,
  now: () => Date = () => fixedNow
) {
  return new Executor({
    store,
    fetch: fetchImpl,
    hmacSha256Hex: hmac,
    now,
    requestTimeoutMs: 1000,
  });
}

describe('Executor.run — sql', () => {
  it('runs a sql job and records ok=true with rowcount info', async () => {
    const store = new FakeStore([job()]);
    store.sqlResults = [{ ok: true, rowCount: 3, error: null }];
    const ex = makeExecutor(store);

    const res = await ex.run(job(), 'manual');
    expect(res.ok).toBe(true);
    expect(res.statusCode).toBeNull();
    expect(res.info).toBe('rows: 3');
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0].ok).toBe(true);
    expect(store.runs[0].info).toBe('rows: 3');
    expect(store.runs[0].jobId).toBe('j1');
  });

  it('records ok=false with the error when sql fails', async () => {
    const store = new FakeStore([job()]);
    store.sqlResults = [{ ok: false, rowCount: null, error: 'syntax error' }];
    const ex = makeExecutor(store);

    const res = await ex.run(job(), 'cron');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('syntax error');
    expect(store.runs[0].ok).toBe(false);
    expect(store.runs[0].error).toBe('syntax error');
  });

  it('records an invalid (empty-sql) job as a failed run without touching the db', async () => {
    const store = new FakeStore();
    const sqlSpy = vi.spyOn(store, 'runJobSql');
    const ex = makeExecutor(store);

    const res = await ex.run(job({ sql: '' }), 'manual');
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/empty sql/);
    expect(sqlSpy).not.toHaveBeenCalled();
    expect(store.runs[0].ok).toBe(false);
  });
});

describe('Executor.run — http', () => {
  it('POSTs the body and records ok=true on 2xx', async () => {
    const store = new FakeStore();
    const f = fakeFetch(200);
    const ex = makeExecutor(store, f.fn);

    const j = job({ kind: 'http', sql: null, url: 'https://x/hook', body: { a: 1 } });
    const res = await ex.run(j, 'manual');

    expect(res.ok).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe('https://x/hook');
    expect(f.calls[0].init.method).toBe('POST');
    const sent = JSON.parse(f.calls[0].init.body);
    expect(sent).toEqual({ job: { id: 'j1', name: 'test' }, body: { a: 1 } });
    expect(store.runs[0].ok).toBe(true);
  });

  it('signs the request with HMAC when a secret is set', async () => {
    const store = new FakeStore();
    const f = fakeFetch(200);
    const ex = makeExecutor(store, f.fn);

    const j = job({ kind: 'http', sql: null, url: 'https://x/hook', secret: 'k' });
    await ex.run(j, 'manual');

    const sentBody = f.calls[0].init.body;
    expect(f.calls[0].init.headers['X-Laetoli-Signature']).toBe(`sha256=${hmac('k', sentBody)}`);
  });

  it('records ok=false on a non-2xx response', async () => {
    const store = new FakeStore();
    const f = fakeFetch(500);
    const ex = makeExecutor(store, f.fn);

    const res = await ex.run(job({ kind: 'http', sql: null, url: 'https://x/hook' }), 'cron');
    expect(res.ok).toBe(false);
    expect(res.statusCode).toBe(500);
    expect(res.error).toBe('HTTP 500');
  });

  it('records ok=false on a network error (fetch throws)', async () => {
    const store = new FakeStore();
    const throwing: FetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    const ex = makeExecutor(store, throwing);

    const res = await ex.run(job({ kind: 'http', sql: null, url: 'https://x/hook' }), 'cron');
    expect(res.ok).toBe(false);
    expect(res.statusCode).toBeNull();
    expect(res.error).toBe('ECONNREFUSED');
  });

  it('rejects an http job with a bad url scheme before any fetch', async () => {
    const store = new FakeStore();
    const f = fakeFetch(200);
    const ex = makeExecutor(store, f.fn);

    const res = await ex.run(job({ kind: 'http', sql: null, url: 'ftp://x' }), 'manual');
    expect(res.ok).toBe(false);
    expect(f.calls).toHaveLength(0);
  });
});

describe('Executor.tick — scheduling + due logic', () => {
  it('schedules (does NOT run) a brand-new job with no next_run', async () => {
    const store = new FakeStore([job({ next_run: null })]);
    store.sqlResults = [{ ok: true, rowCount: 1, error: null }];
    const ex = makeExecutor(store);

    await ex.tick();
    // next_run computed, but no run yet.
    expect(store.runs).toHaveLength(0);
    expect(store.jobs[0].next_run).toBe('2026-06-19T12:05:00.000Z');
  });

  it('runs a due job and advances next_run', async () => {
    const store = new FakeStore([job({ next_run: '2026-06-19T12:00:00Z' })]);
    store.sqlResults = [{ ok: true, rowCount: 2, error: null }];
    const ex = makeExecutor(store);

    await ex.tick();
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0].ok).toBe(true);
    // advanced to the next */5 boundary after now (12:02:30) -> 12:05.
    expect(store.jobs[0].next_run).toBe('2026-06-19T12:05:00.000Z');
  });

  it('does not run a job whose next_run is in the future', async () => {
    const store = new FakeStore([job({ next_run: '2026-06-19T12:10:00Z' })]);
    const ex = makeExecutor(store);
    await ex.tick();
    expect(store.runs).toHaveLength(0);
  });

  it('skips inactive jobs entirely', async () => {
    const store = new FakeStore([job({ active: false, next_run: '2026-06-19T11:00:00Z' })]);
    const ex = makeExecutor(store);
    await ex.tick();
    expect(store.runs).toHaveLength(0);
  });

  it('a bad cron string does not crash the tick; the job just is not scheduled', async () => {
    const store = new FakeStore([job({ cron: 'garbage', next_run: null })]);
    const ex = makeExecutor(store);
    await expect(ex.tick()).resolves.toBeUndefined();
    expect(store.jobs[0].next_run).toBeNull();
  });

  it('one failing job does not prevent another from running', async () => {
    const good = job({ id: 'good', next_run: '2026-06-19T12:00:00Z' });
    const bad = job({ id: 'bad', cron: 'garbage', next_run: '2026-06-19T12:00:00Z' });
    const store = new FakeStore([bad, good]);
    store.sqlResults = [
      { ok: true, rowCount: 1, error: null },
      { ok: true, rowCount: 1, error: null },
    ];
    const ex = makeExecutor(store);
    await ex.tick();
    // The good job ran (its run is recorded).
    expect(store.runs.some((r) => r.jobId === 'good')).toBe(true);
  });
});

describe('Executor.run — resilience', () => {
  it('does not throw when recordRun fails', async () => {
    const store = new FakeStore();
    store.recordShouldThrow = true;
    store.sqlResults = [{ ok: true, rowCount: 1, error: null }];
    const ex = makeExecutor(store);
    await expect(ex.run(job(), 'manual')).resolves.toMatchObject({ ok: true });
  });

  it('invokes the onRun snapshot sink', async () => {
    const store = new FakeStore();
    store.sqlResults = [{ ok: true, rowCount: 5, error: null }];
    const snaps: any[] = [];
    const ex = new Executor({
      store,
      fetch: fakeFetch().fn,
      hmacSha256Hex: hmac,
      now: () => fixedNow,
      requestTimeoutMs: 1000,
      onRun: (s) => snaps.push(s),
    });
    await ex.run(job(), 'manual');
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({ jobId: 'j1', ok: true, trigger: 'manual', info: 'rows: 5' });
  });
});

// keep the SqlExecResult import meaningful for type-checking
const _typecheck: SqlExecResult = { ok: true, rowCount: 0, error: null };
void _typecheck;
