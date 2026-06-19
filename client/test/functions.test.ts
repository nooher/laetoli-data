import { describe, it, expect } from 'vitest';
// Import directly from the module — index.ts wiring is done by the orchestrator.
import { FunctionsClient } from '../src/functions';
import { makeFetch } from './helpers';

const URL = 'https://data.laetoli.tz';
const FUNCTIONS = `${URL}/functions`;

function client(fn: typeof fetch, token: string | null = 'tok-123') {
  return new FunctionsClient(URL, () => token, { fetch: fn });
}

describe('FunctionsClient.invoke', () => {
  it('POSTs to /functions/:name with bearer + JSON body by default', async () => {
    const { fn, calls } = makeFetch([{ json: { message: 'Habari, Asha' } }]);
    const { data, error } = await client(fn).invoke('hello', { body: { jina: 'Asha' } });
    expect(error).toBeNull();
    expect(calls[0].url).toBe(`${FUNCTIONS}/hello`);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers['Authorization']).toBe('Bearer tok-123');
    expect(calls[0].headers['Content-Type']).toBe('application/json');
    expect(calls[0].body).toEqual({ jina: 'Asha' });
    expect(data).toEqual({ message: 'Habari, Asha' });
  });

  it('supports GET with no body', async () => {
    const { fn, calls } = makeFetch([{ json: { ok: true } }]);
    await client(fn).invoke('hello', { method: 'GET' });
    expect(calls[0].method).toBe('GET');
    expect(calls[0].body).toBeUndefined();
  });

  it('omits Authorization when there is no token', async () => {
    const { fn, calls } = makeFetch([{ json: {} }]);
    await client(fn, null).invoke('public-fn');
    expect(calls[0].headers['Authorization']).toBeUndefined();
  });

  it('sends a string body as text/plain', async () => {
    const { fn, calls } = makeFetch([{ json: {} }]);
    await client(fn).invoke('raw', { body: 'hello-bytes' });
    expect(calls[0].headers['Content-Type']).toContain('text/plain');
    expect(calls[0].body).toBe('hello-bytes');
  });

  it('merges caller headers and lets them override', async () => {
    const { fn, calls } = makeFetch([{ json: {} }]);
    await client(fn).invoke('hello', { headers: { 'X-Trace': 'abc' } });
    expect(calls[0].headers['X-Trace']).toBe('abc');
  });

  it('encodes the function name', async () => {
    const { fn, calls } = makeFetch([{ json: {} }]);
    await client(fn).invoke('my fn');
    expect(calls[0].url).toBe(`${FUNCTIONS}/my%20fn`);
  });

  it('maps a non-2xx response to an error envelope', async () => {
    const { fn } = makeFetch([{ status: 401, json: { error: 'Hujaingia.' } }]);
    const { data, error, status } = await client(fn).invoke('whoami', { method: 'GET' });
    expect(data).toBeNull();
    expect(error?.message).toBe('Hujaingia.');
    expect(status).toBe(401);
  });

  it('maps a 504 timeout to an error envelope', async () => {
    const { fn } = makeFetch([{ status: 504, json: { error: 'Function timed out.' } }]);
    const { error, status } = await client(fn).invoke('slow');
    expect(status).toBe(504);
    expect(error?.message).toMatch(/timed out/i);
  });

  it('returns a fetch_error envelope when fetch throws', async () => {
    const fn = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    const { data, error, status } = await client(fn).invoke('hello');
    expect(data).toBeNull();
    expect(error?.code).toBe('fetch_error');
    expect(error?.message).toBe('network down');
    expect(status).toBe(0);
  });

  it('strips a trailing slash before appending /functions', async () => {
    const { fn, calls } = makeFetch([{ json: {} }]);
    await new FunctionsClient(`${URL}/`, () => null, { fetch: fn }).invoke('hello', { method: 'GET' });
    expect(calls[0].url).toBe(`${FUNCTIONS}/hello`);
    expect(calls[0].url).not.toContain('//functions');
  });
});
