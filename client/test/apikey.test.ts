import { describe, it, expect } from 'vitest';
import { createClient } from '../src/client';
import { makeFetch, baseOpts } from './helpers';

const URL = 'https://data.laetoli.tz';
const STORAGE = `${URL}/storage`;
const FUNCTIONS = `${URL}/functions`;

// The SDK forwards the configured `apikey` (the anon/public key) as the `apikey`
// header on every request — REST, storage, and functions — via baseHeaders().
// These tests confirm that contract so the opt-in apikeyGuard on storage +
// functions can authenticate SDK calls without any extra wiring.

describe('createClient forwards apikey to all services', () => {
  it('sends the apikey header on storage requests', async () => {
    const { fn, calls } = makeFetch([{ json: { buckets: [] } }]);
    const client = createClient(URL, baseOpts(fn, { apikey: 'anon-123' }));
    await client.storage.listBuckets();
    expect(calls[0].url).toBe(`${STORAGE}/bucket`);
    expect(calls[0].headers['apikey']).toBe('anon-123');
  });

  it('sends the apikey header on functions invocations', async () => {
    const { fn, calls } = makeFetch([{ json: { ok: true } }]);
    const client = createClient(URL, baseOpts(fn, { apikey: 'anon-123' }));
    await client.functions.invoke('hello', { body: { x: 1 } });
    expect(calls[0].url).toBe(`${FUNCTIONS}/hello`);
    expect(calls[0].headers['apikey']).toBe('anon-123');
  });

  it('sends the apikey header on REST (.from) requests', async () => {
    const { fn, calls } = makeFetch([{ json: [] }]);
    const client = createClient(URL, baseOpts(fn, { apikey: 'anon-123' }));
    await client.from('notes').select('*');
    expect(calls[0].headers['apikey']).toBe('anon-123');
  });

  it('omits apikey when none is configured', async () => {
    const { fn, calls } = makeFetch([{ json: { buckets: [] } }]);
    const client = createClient(URL, baseOpts(fn));
    await client.storage.listBuckets();
    expect(calls[0].headers['apikey']).toBeUndefined();
  });
});
