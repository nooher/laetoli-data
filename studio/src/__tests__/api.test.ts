import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  loadCredentials,
  saveCredentials,
  clearCredentials,
  AdminApi,
  ApiError,
} from '../api';

describe('credentials in sessionStorage', () => {
  beforeEach(() => sessionStorage.clear());

  it('returns null when nothing is stored', () => {
    expect(loadCredentials()).toBeNull();
  });

  it('round-trips saved credentials', () => {
    saveCredentials({ baseUrl: 'https://x.tz/admin', key: 'secret' });
    expect(loadCredentials()).toEqual({ baseUrl: 'https://x.tz/admin', key: 'secret' });
  });

  it('clears credentials on sign out', () => {
    saveCredentials({ baseUrl: '/admin', key: 'k' });
    clearCredentials();
    expect(loadCredentials()).toBeNull();
  });
});

describe('AdminApi request wiring', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  function ok(body: unknown) {
    return Promise.resolve(
      new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
  }

  it('sends Bearer auth on keyed calls and builds the URL', async () => {
    fetchMock.mockReturnValue(ok({ users: 1, tables: 2, buckets: 0, objects: 0, db_size_pretty: '8 MB' }));
    const api = new AdminApi({ baseUrl: '/admin', key: 'svc-key' });
    const stats = await api.stats();
    expect(stats.tables).toBe(2);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/admin/stats');
    expect((init.headers as Headers).get('Authorization')).toBe('Bearer svc-key');
  });

  it('does NOT send auth on /health', async () => {
    fetchMock.mockReturnValue(ok({ status: 'ok' }));
    const api = new AdminApi({ baseUrl: '/admin', key: 'svc-key' });
    await api.health();
    const [, init] = fetchMock.mock.calls[0];
    expect((init.headers as Headers).get('Authorization')).toBeNull();
  });

  it('encodes path params for table rows', async () => {
    fetchMock.mockReturnValue(ok({ rows: [], count: 0 }));
    const api = new AdminApi({ baseUrl: '/admin', key: 'k' });
    await api.tableRows('public', 'my table', { limit: 10, offset: 20, order: 'id' });
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('/admin/table/public/my%20table?limit=10&offset=20&order=id');
  });

  it('throws a friendly ApiError on 401', async () => {
    // Fresh Response per call — a body can only be read once.
    fetchMock.mockImplementation(() => Promise.resolve(new Response('nope', { status: 401 })));
    const api = new AdminApi({ baseUrl: '/admin', key: 'bad' });
    await expect(api.stats()).rejects.toBeInstanceOf(ApiError);
    await expect(api.stats()).rejects.toMatchObject({ status: 401 });
  });

  it('wraps network failures as ApiError status 0', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const api = new AdminApi({ baseUrl: '/admin', key: 'k' });
    await expect(api.health()).rejects.toMatchObject({ status: 0 });
  });
});
