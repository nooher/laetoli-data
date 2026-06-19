import { describe, it, expect } from 'vitest';
import { createClient } from '../src/index';
import { makeFetch, baseOpts, queryEntries } from './helpers';

const URL = 'https://data.laetoli.tz';

describe('from().select — GET request building', () => {
  it('GETs the table with a select=* param by default', async () => {
    const { fn, calls } = makeFetch([{ json: [{ id: 1 }] }]);
    const c = createClient(URL, baseOpts(fn));
    const { data, error } = await c.from('works').select();
    expect(error).toBeNull();
    expect(data).toEqual([{ id: 1 }]);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url.startsWith(`${URL}/rest/works?`)).toBe(true);
    expect(queryEntries(calls[0].url)).toContainEqual(['select', '*']);
  });

  it('encodes explicit columns', async () => {
    const { fn, calls } = makeFetch([{ json: [] }]);
    const c = createClient(URL, baseOpts(fn));
    await c.from('profiles').select('id,handle,name');
    expect(queryEntries(calls[0].url)).toContainEqual(['select', 'id%2Chandle%2Cname']);
  });

  it('builds eq / neq filters', async () => {
    const { fn, calls } = makeFetch([{ json: [] }]);
    const c = createClient(URL, baseOpts(fn));
    await c.from('works').select().eq('type', 'pulse').neq('community_id', 'x');
    const q = calls[0].url;
    expect(q).toContain('type=eq.pulse');
    expect(q).toContain('community_id=neq.x');
  });

  it('builds order with ascending:false → desc', async () => {
    const { fn, calls } = makeFetch([{ json: [] }]);
    const c = createClient(URL, baseOpts(fn));
    await c.from('works').select().order('created_at', { ascending: false });
    expect(calls[0].url).toContain('order=created_at.desc');
  });

  it('defaults order to asc', async () => {
    const { fn, calls } = makeFetch([{ json: [] }]);
    const c = createClient(URL, baseOpts(fn));
    await c.from('works').select().order('created_at');
    expect(calls[0].url).toContain('order=created_at.asc');
  });

  it('builds limit', async () => {
    const { fn, calls } = makeFetch([{ json: [] }]);
    const c = createClient(URL, baseOpts(fn));
    await c.from('works').select().limit(25);
    expect(calls[0].url).toContain('limit=25');
  });

  it('chains eq + order + limit in one query string', async () => {
    const { fn, calls } = makeFetch([{ json: [] }]);
    const c = createClient(URL, baseOpts(fn));
    await c
      .from('works')
      .select('*')
      .eq('type', 'pulse')
      .order('created_at', { ascending: false })
      .limit(40);
    const q = calls[0].url;
    expect(q).toContain('type=eq.pulse');
    expect(q).toContain('order=created_at.desc');
    expect(q).toContain('limit=40');
  });

  it('in() builds a parenthesised list', async () => {
    const { fn, calls } = makeFetch([{ json: [] }]);
    const c = createClient(URL, baseOpts(fn));
    await c.from('members').select().in('id', ['a', 'b', 'c']);
    expect(calls[0].url).toContain('id=in.(a,b,c)');
  });

  it('is() handles null', async () => {
    const { fn, calls } = makeFetch([{ json: [] }]);
    const c = createClient(URL, baseOpts(fn));
    await c.from('works').select().is('community_id', null);
    expect(calls[0].url).toContain('community_id=is.null');
  });
});

describe('from().single / maybeSingle', () => {
  it('single() sets the pgrst object Accept header and returns object', async () => {
    const { fn, calls } = makeFetch([{ json: { id: 7 } }]);
    const c = createClient(URL, baseOpts(fn));
    const { data } = await c.from('works').select('id').eq('id', 7).single();
    expect(calls[0].headers['Accept']).toBe('application/vnd.pgrst.object+json');
    expect(data).toEqual({ id: 7 });
  });

  it('maybeSingle() returns null data without error on 406', async () => {
    const { fn } = makeFetch([{ status: 406, statusText: 'Not Acceptable', text: '' }]);
    const c = createClient(URL, baseOpts(fn));
    const { data, error } = await c.from('works').select('id').eq('id', 999).maybeSingle();
    expect(data).toBeNull();
    expect(error).toBeNull();
  });
});

describe('from().insert / update / delete', () => {
  it('insert → POST with return=representation and JSON body', async () => {
    const { fn, calls } = makeFetch([{ status: 201, json: [{ id: 1 }] }]);
    const c = createClient(URL, baseOpts(fn));
    const row = { name: 'Anaim', emoji: '📚' };
    const { data } = await c.from('communities').insert(row);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers['Content-Type']).toBe('application/json');
    expect(calls[0].headers['Prefer']).toBe('return=representation');
    expect(calls[0].body).toEqual(row);
    expect(data).toEqual([{ id: 1 }]);
  });

  it('insert().select().single() → POST with object Accept', async () => {
    const { fn, calls } = makeFetch([{ status: 201, json: { id: 9 } }]);
    const c = createClient(URL, baseOpts(fn));
    const { data } = await c.from('works').insert({ x: 1 }).select('id').single();
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers['Accept']).toBe('application/vnd.pgrst.object+json');
    expect(calls[0].url).toContain('select=id');
    expect(data).toEqual({ id: 9 });
  });

  it('update → PATCH with body + eq filter', async () => {
    const { fn, calls } = makeFetch([{ json: [{ id: 1 }] }]);
    const c = createClient(URL, baseOpts(fn));
    await c.from('profiles').update({ avatar_url: null }).eq('id', 'u1');
    expect(calls[0].method).toBe('PATCH');
    expect(calls[0].body).toEqual({ avatar_url: null });
    expect(calls[0].url).toContain('id=eq.u1');
    expect(calls[0].headers['Prefer']).toBe('return=representation');
  });

  it('delete → DELETE with eq filter', async () => {
    const { fn, calls } = makeFetch([{ json: [] }]);
    const c = createClient(URL, baseOpts(fn));
    await c.from('follows').delete().eq('follower_id', 'a').eq('following_id', 'b');
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toContain('follower_id=eq.a');
    expect(calls[0].url).toContain('following_id=eq.b');
  });
});

describe('error + envelope handling', () => {
  it('maps PostgREST error JSON to { data:null, error }', async () => {
    const { fn } = makeFetch([
      { status: 400, statusText: 'Bad Request', json: { message: 'boom', code: '22P02', hint: 'fix it' } },
    ]);
    const c = createClient(URL, baseOpts(fn));
    const { data, error, status } = await c.from('works').select();
    expect(data).toBeNull();
    expect(status).toBe(400);
    expect(error?.message).toBe('boom');
    expect(error?.code).toBe('22P02');
    expect(error?.hint).toBe('fix it');
  });

  it('surfaces network errors as error envelope', async () => {
    const fn = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    const c = createClient(URL, baseOpts(fn));
    const { data, error } = await c.from('works').select();
    expect(data).toBeNull();
    expect(error?.message).toBe('offline');
    expect(error?.code).toBe('fetch_error');
  });
});
