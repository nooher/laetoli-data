// Filesystem object store. Bytes live on a mounted volume at STORAGE_ROOT;
// metadata lives in Postgres (see db.ts). This module ONLY touches bytes.
//
// Layout: <root>/<bucket>/<path...>  — path is the validated object path.
// Path-safety is enforced twice: callers pass validated paths (validation.ts),
// and resolveSafe() re-checks that the resolved absolute path stays inside the
// bucket directory (defence in depth against traversal).

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface StoredStat {
  size: number;
  /** Last-modified time, ms since epoch. */
  mtimeMs: number;
}

/**
 * Reserved directory under STORAGE_ROOT for cached image-transform variants.
 * Leading `_` keeps it out of the bucket-name space (buckets must start alnum),
 * so it can never collide with a real bucket.
 */
export const TRANSFORM_CACHE_DIR = '_transforms';

export interface ObjectStore {
  /** Stream `body` to <bucket>/<objectPath>; returns bytes written. */
  put(bucket: string, objectPath: string, body: Readable): Promise<number>;
  /** Open a read stream for an object. Throws ENOENT if missing. */
  get(bucket: string, objectPath: string): NodeJS.ReadableStream;
  /** Read an object fully into memory (used by the transform pipeline). */
  readAll(bucket: string, objectPath: string): Promise<Buffer>;
  /** fs.stat for an object, or null if it does not exist. */
  stat(bucket: string, objectPath: string): Promise<StoredStat | null>;
  /** Delete an object's bytes. No-op if already gone. */
  remove(bucket: string, objectPath: string): Promise<void>;

  /** Return cached transform bytes for `key`, or null if not cached. */
  getCached(key: string): Promise<Buffer | null>;
  /** Write transform bytes for `key`. Best-effort: never throws. */
  putCached(key: string, data: Buffer): Promise<void>;
}

/** Reject anything that escapes the bucket directory. */
function resolveSafe(root: string, bucket: string, objectPath: string): string {
  const bucketDir = path.resolve(root, bucket);
  const full = path.resolve(bucketDir, objectPath);
  const rel = path.relative(bucketDir, full);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('Path traversal rejected');
  }
  return full;
}

export function createFsStore(root: string): ObjectStore {
  return {
    async put(bucket, objectPath, body) {
      const full = resolveSafe(root, bucket, objectPath);
      await mkdir(path.dirname(full), { recursive: true });
      const ws = createWriteStream(full);
      await pipeline(body, ws);
      const s = await stat(full);
      return s.size;
    },

    get(bucket, objectPath) {
      const full = resolveSafe(root, bucket, objectPath);
      return createReadStream(full);
    },

    async readAll(bucket, objectPath) {
      const full = resolveSafe(root, bucket, objectPath);
      return readFile(full);
    },

    async stat(bucket, objectPath) {
      const full = resolveSafe(root, bucket, objectPath);
      try {
        const s = await stat(full);
        return { size: s.size, mtimeMs: s.mtimeMs };
      } catch (e) {
        if (isENOENT(e)) return null;
        throw e;
      }
    },

    async remove(bucket, objectPath) {
      const full = resolveSafe(root, bucket, objectPath);
      await rm(full, { force: true });
    },

    async getCached(key) {
      const full = resolveCacheKey(root, key);
      if (!full) return null;
      try {
        return await readFile(full);
      } catch (e) {
        if (isENOENT(e)) return null;
        return null; // never let a cache read break serving
      }
    },

    async putCached(key, data) {
      const full = resolveCacheKey(root, key);
      if (!full) return;
      try {
        await mkdir(path.dirname(full), { recursive: true });
        await writeFile(full, data);
      } catch {
        /* best-effort cache; a failure must not break the response */
      }
    },
  };
}

/**
 * Resolve a transform-cache key to an absolute path inside the cache dir.
 * Defence-in-depth path safety: the key is hash-derived, but we still verify it
 * stays under <root>/_transforms. Returns null on any traversal attempt.
 */
function resolveCacheKey(root: string, key: string): string | null {
  const cacheRoot = path.resolve(root, TRANSFORM_CACHE_DIR);
  const full = path.resolve(cacheRoot, key);
  const rel = path.relative(cacheRoot, full);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return null;
  }
  return full;
}

function isENOENT(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    (e as { code?: unknown }).code === 'ENOENT'
  );
}
