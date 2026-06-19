// Filesystem object store. Bytes live on a mounted volume at STORAGE_ROOT;
// metadata lives in Postgres (see db.ts). This module ONLY touches bytes.
//
// Layout: <root>/<bucket>/<path...>  — path is the validated object path.
// Path-safety is enforced twice: callers pass validated paths (validation.ts),
// and resolveSafe() re-checks that the resolved absolute path stays inside the
// bucket directory (defence in depth against traversal).

import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export interface StoredStat {
  size: number;
  /** Last-modified time, ms since epoch. */
  mtimeMs: number;
}

export interface ObjectStore {
  /** Stream `body` to <bucket>/<objectPath>; returns bytes written. */
  put(bucket: string, objectPath: string, body: Readable): Promise<number>;
  /** Open a read stream for an object. Throws ENOENT if missing. */
  get(bucket: string, objectPath: string): NodeJS.ReadableStream;
  /** fs.stat for an object, or null if it does not exist. */
  stat(bucket: string, objectPath: string): Promise<StoredStat | null>;
  /** Delete an object's bytes. No-op if already gone. */
  remove(bucket: string, objectPath: string): Promise<void>;
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
  };
}

function isENOENT(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    (e as { code?: unknown }).code === 'ENOENT'
  );
}
