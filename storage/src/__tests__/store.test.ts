import { describe, it, expect, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import { createFsStore } from '../store.js';
import { tempRoot } from './helpers.js';

function streamToString(s: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    s.on('data', (c) => chunks.push(Buffer.from(c)));
    s.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    s.on('error', reject);
  });
}

let cleanups: Array<() => void> = [];
afterEach(() => {
  cleanups.forEach((c) => c());
  cleanups = [];
});

function freshStore() {
  const { root, cleanup } = tempRoot();
  cleanups.push(cleanup);
  return createFsStore(root);
}

describe('fs store', () => {
  it('puts, stats, gets and removes an object', async () => {
    const store = freshStore();
    const size = await store.put('b1', 'dir/hello.txt', Readable.from('habari'));
    expect(size).toBe(Buffer.byteLength('habari'));

    const st = await store.stat('b1', 'dir/hello.txt');
    expect(st?.size).toBe(size);

    const text = await streamToString(store.get('b1', 'dir/hello.txt'));
    expect(text).toBe('habari');

    await store.remove('b1', 'dir/hello.txt');
    expect(await store.stat('b1', 'dir/hello.txt')).toBeNull();
  });

  it('overwrites on re-put', async () => {
    const store = freshStore();
    await store.put('b', 'f', Readable.from('one'));
    const n = await store.put('b', 'f', Readable.from('second'));
    expect(n).toBe(6);
    expect(await streamToString(store.get('b', 'f'))).toBe('second');
  });

  it('stat returns null for a missing object', async () => {
    const store = freshStore();
    expect(await store.stat('b', 'missing')).toBeNull();
  });

  it('remove is a no-op for a missing object', async () => {
    const store = freshStore();
    await expect(store.remove('b', 'missing')).resolves.toBeUndefined();
  });

  it('rejects path traversal at the store layer', async () => {
    const store = freshStore();
    await expect(
      store.put('b', '../escape.txt', Readable.from('x'))
    ).rejects.toThrow(/traversal/i);
    expect(() => store.get('b', '../escape.txt')).toThrow(/traversal/i);
  });
});
