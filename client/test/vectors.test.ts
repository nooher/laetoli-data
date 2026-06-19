import { describe, it, expect } from 'vitest';
import { createClient } from '../src/index';
import { VectorClient } from '../src/vectors';
import { makeFetch, baseOpts } from './helpers';

const URL = 'https://data.laetoli.tz';
const REST = `${URL}/rest`;

function vclient(fn: typeof fetch, token: string | null = 'tok-123') {
  return new VectorClient({
    restUrl: REST,
    headers: (): Record<string, string> => (token ? { Authorization: `Bearer ${token}` } : {}),
    fetch: fn,
  });
}

// A trivial 384-d vector for tests (content doesn't matter to the mock).
const VEC384 = Array.from({ length: 384 }, (_, i) => (i % 7) / 10);

describe('VectorClient.rpc', () => {
  it('POSTs JSON args to /rest/rpc/:fn and returns the data envelope', async () => {
    const { fn, calls } = makeFetch([{ json: [{ ok: true }] }]);
    const { data, error } = await vclient(fn).rpc('some_fn', { a: 1, b: 'x' });
    expect(error).toBeNull();
    expect(data).toEqual([{ ok: true }]);
    expect(calls[0].url).toBe(`${REST}/rpc/some_fn`);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers['Content-Type']).toBe('application/json');
    expect(calls[0].headers['Authorization']).toBe('Bearer tok-123');
    expect(calls[0].body).toEqual({ a: 1, b: 'x' });
  });

  it('defaults args to an empty object', async () => {
    const { fn, calls } = makeFetch([{ json: [] }]);
    await vclient(fn).rpc('no_args');
    expect(calls[0].body).toEqual({});
  });

  it('encodes the function name', async () => {
    const { fn, calls } = makeFetch([{ json: [] }]);
    await vclient(fn).rpc('weird fn');
    expect(calls[0].url).toBe(`${REST}/rpc/weird%20fn`);
  });

  it('maps a non-2xx response to a PostgREST error envelope', async () => {
    const { fn } = makeFetch([{ status: 400, json: { message: 'bad dims', code: '22000' } }]);
    const { data, error, status } = await vclient(fn).rpc('match_documents', {});
    expect(data).toBeNull();
    expect(error?.message).toBe('bad dims');
    expect(error?.code).toBe('22000');
    expect(status).toBe(400);
  });

  it('returns a fetch_error envelope when fetch throws', async () => {
    const fn = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const { data, error, status } = await vclient(fn).rpc('match_documents');
    expect(data).toBeNull();
    expect(error?.code).toBe('fetch_error');
    expect(error?.message).toBe('network down');
    expect(status).toBe(0);
  });
});

describe('VectorClient.matchDocuments', () => {
  it('calls match_documents with query_embedding + defaults (count 5, empty filter)', async () => {
    const { fn, calls } = makeFetch([
      { json: [{ id: 'd1', content: 'hi', metadata: {}, similarity: 0.91 }] },
    ]);
    const { data, error } = await vclient(fn).matchDocuments(VEC384);
    expect(error).toBeNull();
    expect(data?.[0].similarity).toBe(0.91);
    expect(calls[0].url).toBe(`${REST}/rpc/match_documents`);
    const body = calls[0].body as Record<string, unknown>;
    expect((body.query_embedding as number[]).length).toBe(384);
    expect(body.match_count).toBe(5);
    expect(body.filter).toEqual({});
  });

  it('passes count + filter through', async () => {
    const { fn, calls } = makeFetch([{ json: [] }]);
    await vclient(fn).matchDocuments(VEC384, { count: 3, filter: { source: 'akili' } });
    const body = calls[0].body as Record<string, unknown>;
    expect(body.match_count).toBe(3);
    expect(body.filter).toEqual({ source: 'akili' });
  });
});

describe('client.rpc / client.matchDocuments wiring', () => {
  it('client.rpc carries the signed-in bearer + apikey to /rest/rpc/:fn', async () => {
    const { fn, calls } = makeFetch([{ json: { result: 42 } }]);
    const c = createClient(URL, baseOpts(fn, { apikey: 'anon-key' }));
    const { data } = await c.rpc<{ result: number }>('answer', { q: 'life' });
    expect(data).toEqual({ result: 42 });
    expect(calls[0].url).toBe(`${REST}/rpc/answer`);
    expect(calls[0].headers['apikey']).toBe('anon-key');
    // No session → anon apikey is used as the bearer fallback (mirrors .from()).
    expect(calls[0].headers['Authorization']).toBe('Bearer anon-key');
  });

  it('client.matchDocuments is a shortcut for vectors.matchDocuments', async () => {
    const { fn, calls } = makeFetch([{ json: [] }]);
    const c = createClient(URL, baseOpts(fn));
    await c.matchDocuments(VEC384, { count: 2 });
    expect(calls[0].url).toBe(`${REST}/rpc/match_documents`);
    expect((calls[0].body as Record<string, unknown>).match_count).toBe(2);
  });
});
