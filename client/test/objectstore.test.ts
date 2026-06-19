import { describe, it, expect } from 'vitest';
// Import directly from the module — index.ts wiring is done by the orchestrator.
import { StorageClient, buildTransformQuery } from '../src/objectstore';
import { makeFetch } from './helpers';

const URL = 'https://data.laetoli.tz';
const STORAGE = `${URL}/storage`;

function client(fn: typeof fetch, token: string | null = 'tok-123') {
  return new StorageClient(URL, () => token, { fetch: fn });
}

describe('StorageClient.from().upload', () => {
  it('PUTs to /storage/object/:bucket/* with bearer + content-type', async () => {
    const { fn, calls } = makeFetch([
      { json: { object: { name: 'a.txt', bucket: 'docs', path: 'a.txt', size: 3, mime: 'text/plain', owner: 'u1', created_at: 't', updated_at: 't' } } },
    ]);
    const { data, error } = await client(fn).from('docs').upload('a.txt', 'abc', { contentType: 'text/plain' });
    expect(error).toBeNull();
    expect(calls[0].url).toBe(`${STORAGE}/object/docs/a.txt`);
    expect(calls[0].method).toBe('PUT');
    expect(calls[0].headers['Authorization']).toBe('Bearer tok-123');
    expect(calls[0].headers['Content-Type']).toBe('text/plain');
    expect(data?.path).toBe('a.txt');
  });

  it('encodes nested paths but preserves slashes', async () => {
    const { fn, calls } = makeFetch([{ json: { object: {} } }]);
    await client(fn).from('docs').upload('dir/sub/file name.txt', 'x');
    expect(calls[0].url).toBe(`${STORAGE}/object/docs/dir/sub/file%20name.txt`);
  });

  it('omits Authorization when there is no token', async () => {
    const { fn, calls } = makeFetch([{ json: { object: {} } }]);
    await client(fn, null).from('public').upload('a.txt', 'x');
    expect(calls[0].headers['Authorization']).toBeUndefined();
  });
});

describe('StorageClient.from().download', () => {
  it('GETs the object and returns a Blob', async () => {
    // The shared makeFetch helper only stubs text(); download() needs blob(),
    // so use a local fetch mock that returns a real Blob.
    const calls: string[] = [];
    const fn = (async (url: string) => {
      calls.push(url);
      return {
        ok: true,
        status: 200,
        statusText: '',
        blob: async () => new Blob(['hello-bytes']),
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const { data, error } = await client(fn).from('docs').download('a.txt');
    expect(error).toBeNull();
    expect(calls[0]).toBe(`${STORAGE}/object/docs/a.txt`);
    expect(data).toBeInstanceOf(Blob);
    expect(await data!.text()).toBe('hello-bytes');
  });

  it('maps a 404 to an error envelope', async () => {
    const { fn } = makeFetch([{ status: 404, json: { error: 'Faili haipatikani.' } }]);
    const { data, error } = await client(fn).from('docs').download('missing');
    expect(data).toBeNull();
    expect(error?.message).toBe('Faili haipatikani.');
  });
});

describe('StorageClient.from().list', () => {
  it('GETs /storage/list/:bucket with a prefix and returns the array', async () => {
    const { fn, calls } = makeFetch([{ json: { objects: [{ path: 'img/a.png' }, { path: 'img/b.png' }] } }]);
    const { data } = await client(fn).from('docs').list('img/');
    expect(calls[0].url).toBe(`${STORAGE}/list/docs?prefix=img%2F`);
    expect(data?.length).toBe(2);
  });
});

describe('StorageClient.from().remove', () => {
  it('DELETEs each path and returns the removed list', async () => {
    const { fn, calls } = makeFetch([{ json: { deleted: 'a.txt' } }, { json: { deleted: 'b.txt' } }]);
    const { data, error } = await client(fn).from('docs').remove(['a.txt', 'b.txt']);
    expect(error).toBeNull();
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toBe(`${STORAGE}/object/docs/a.txt`);
    expect(calls[1].url).toBe(`${STORAGE}/object/docs/b.txt`);
    expect(data?.map((d) => d.path)).toEqual(['a.txt', 'b.txt']);
  });

  it('surfaces a delete error (e.g. 403 non-owner)', async () => {
    const { fn } = makeFetch([{ status: 403, json: { error: 'Hauruhusiwi.' } }]);
    const { data, error } = await client(fn).from('docs').remove(['x.txt']);
    expect(data).toBeNull();
    expect(error?.message).toBe('Hauruhusiwi.');
  });
});

describe('StorageClient.from().getPublicUrl', () => {
  it('builds a public URL synchronously without a request', () => {
    const { fn, calls } = makeFetch([]);
    const { data, publicUrl } = client(fn).from('public').getPublicUrl('logo.png');
    expect(publicUrl).toBe(`${STORAGE}/object/public/logo.png`);
    expect(data.publicUrl).toBe(publicUrl);
    expect(calls.length).toBe(0);
  });
});

describe('buildTransformQuery', () => {
  it('returns an empty string for no options', () => {
    expect(buildTransformQuery()).toBe('');
    expect(buildTransformQuery({})).toBe('');
  });

  it('builds width + format', () => {
    expect(buildTransformQuery({ width: 40, format: 'webp' })).toBe('?width=40&format=webp');
  });

  it('builds all params in a stable order', () => {
    expect(
      buildTransformQuery({ width: 100, height: 200, resize: 'contain', format: 'jpeg', quality: 80 }),
    ).toBe('?width=100&height=200&resize=contain&format=jpeg&quality=80');
  });
});

describe('StorageClient.from().getPublicUrl with transform', () => {
  it('appends transform query params', () => {
    const { fn, calls } = makeFetch([]);
    const { publicUrl } = client(fn)
      .from('public')
      .getPublicUrl('logo.png', { transform: { width: 40, format: 'webp' } });
    expect(publicUrl).toBe(`${STORAGE}/object/public/logo.png?width=40&format=webp`);
    expect(calls.length).toBe(0);
  });

  it('returns the plain URL when no transform is given', () => {
    const { fn } = makeFetch([]);
    const { publicUrl } = client(fn).from('public').getPublicUrl('logo.png');
    expect(publicUrl).toBe(`${STORAGE}/object/public/logo.png`);
  });
});

describe('StorageClient.from().transformUrl', () => {
  it('builds an object URL with transform params', () => {
    const { fn } = makeFetch([]);
    const url = client(fn).from('photos').transformUrl('a/b.png', {
      width: 200,
      height: 200,
      resize: 'cover',
      format: 'avif',
      quality: 70,
    });
    expect(url).toBe(`${STORAGE}/object/photos/a/b.png?width=200&height=200&resize=cover&format=avif&quality=70`);
  });
});

describe('StorageClient.from().createSignedUrl', () => {
  it('POSTs /storage/sign/:bucket/* with expiresIn and returns signedUrl', async () => {
    const { fn, calls } = makeFetch([{ json: { signedUrl: '/storage/signed/docs/a.txt?token=abc' } }]);
    const { data, error } = await client(fn).from('docs').createSignedUrl('a.txt', 120);
    expect(error).toBeNull();
    expect(calls[0].url).toBe(`${STORAGE}/sign/docs/a.txt`);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ expiresIn: 120 });
    expect(data?.signedUrl).toContain('token=abc');
  });
});

describe('StorageClient buckets', () => {
  it('createBucket POSTs /storage/bucket', async () => {
    const { fn, calls } = makeFetch([{ status: 201, json: { bucket: { name: 'docs', public: false, created_at: 't' } } }]);
    const { data, error } = await client(fn).createBucket('docs', { public: false });
    expect(error).toBeNull();
    expect(calls[0].url).toBe(`${STORAGE}/bucket`);
    expect(calls[0].body).toEqual({ name: 'docs', public: false });
    expect(data?.name).toBe('docs');
  });

  it('listBuckets GETs /storage/bucket', async () => {
    const { fn, calls } = makeFetch([{ json: { buckets: [{ name: 'a' }, { name: 'b' }] } }]);
    const { data } = await client(fn).listBuckets();
    expect(calls[0].url).toBe(`${STORAGE}/bucket`);
    expect(data?.length).toBe(2);
  });

  it('deleteBucket DELETEs /storage/bucket/:name', async () => {
    const { fn, calls } = makeFetch([{ json: { deleted: 'docs' } }]);
    const { data, error } = await client(fn).deleteBucket('docs');
    expect(error).toBeNull();
    expect(calls[0].method).toBe('DELETE');
    expect(calls[0].url).toBe(`${STORAGE}/bucket/docs`);
    expect(data?.deleted).toBe('docs');
  });
});

describe('StorageClient base url handling', () => {
  it('strips a trailing slash before appending /storage', async () => {
    const { fn, calls } = makeFetch([{ json: { buckets: [] } }]);
    await new StorageClient(`${URL}/`, () => null, { fetch: fn }).listBuckets();
    expect(calls[0].url).toBe(`${STORAGE}/bucket`);
    expect(calls[0].url).not.toContain('//storage');
  });
});
