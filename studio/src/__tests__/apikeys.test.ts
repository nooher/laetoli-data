import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { maskKey, formatCount } from '../lib';
import { AdminApi } from '../api';

describe('maskKey', () => {
  it('shows the prefix then a fixed run of bullets', () => {
    expect(maskKey('ld_pub_a1b2')).toBe('ld_pub_a1b2••••••••');
  });
  it('never reveals the secret half of a full "prefix.secret" key', () => {
    const masked = maskKey('ld_pub_a1b2.SUPERSECRETVALUE');
    expect(masked).toBe('ld_pub_a1b2••••••••');
    expect(masked).not.toContain('SUPERSECRETVALUE');
  });
  it('falls back to bullets for empty/nullish input', () => {
    expect(maskKey('')).toBe('••••••••');
    expect(maskKey(null)).toBe('••••••••');
    expect(maskKey(undefined)).toBe('••••••••');
  });
});

describe('formatCount', () => {
  it('formats numbers with locale grouping', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(1234)).toBe((1234).toLocaleString());
  });
  it('renders an em dash for missing values', () => {
    expect(formatCount(null)).toBe('—');
    expect(formatCount(undefined)).toBe('—');
    expect(formatCount(Number.NaN)).toBe('—');
  });
});

describe('AdminApi project/key endpoints', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  function ok(body: unknown) {
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }

  it('GET /projects sends Bearer auth to the right URL', async () => {
    fetchMock.mockReturnValue(ok([{ id: 'p1', name: 'App' }]));
    const api = new AdminApi({ baseUrl: '/admin', key: 'svc' });
    const list = await api.projects();
    expect(list[0].id).toBe('p1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/admin/projects');
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer svc');
  });

  it('POST /projects sends the name as JSON', async () => {
    fetchMock.mockReturnValue(ok({ id: 'p2', name: 'New' }));
    const api = new AdminApi({ baseUrl: '/admin', key: 'k' });
    await api.createProject('New');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/admin/projects');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'New' });
  });

  it('encodes project id when listing keys', async () => {
    fetchMock.mockReturnValue(ok([]));
    const api = new AdminApi({ baseUrl: '/admin', key: 'k' });
    await api.projectKeys('a/b');
    expect(fetchMock.mock.calls[0][0]).toBe('/admin/projects/a%2Fb/keys');
  });

  it('POST a key carries name, role and rate limit', async () => {
    fetchMock.mockReturnValue(ok({ id: 'k1', apikey: 'pre.secret', name: 'iOS', role: 'anon', key_prefix: 'pre' }));
    const api = new AdminApi({ baseUrl: '/admin', key: 'k' });
    const created = await api.createKey('p1', { name: 'iOS', role: 'anon', rate_limit_per_min: 120 });
    expect(created.apikey).toBe('pre.secret');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/admin/projects/p1/keys');
    expect(JSON.parse(init.body as string)).toEqual({ name: 'iOS', role: 'anon', rate_limit_per_min: 120 });
  });

  it('revokeKey DELETEs /keys/:id', async () => {
    fetchMock.mockReturnValue(ok({}));
    const api = new AdminApi({ baseUrl: '/admin', key: 'k' });
    await api.revokeKey('k9');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/admin/keys/k9');
    expect(init.method).toBe('DELETE');
  });

  it('usage sets project_id query param', async () => {
    fetchMock.mockReturnValue(ok({ usage: [] }));
    const api = new AdminApi({ baseUrl: '/admin', key: 'k' });
    await api.usage('p1');
    expect(fetchMock.mock.calls[0][0]).toBe('/admin/usage?project_id=p1');
  });
});
