// In-memory fake Db for tests — the dependency-injection seam in action.
// No Postgres required. Mirrors auth/src/__tests__/fakeDb.ts.

import { randomUUID } from 'node:crypto';
import type {
  Db,
  BucketRow,
  ObjectRow,
  ListObjectsInput,
  UpsertObjectInput,
} from '../db.js';
import { clampLimit } from '../db.js';

export function createMemoryDb(): Db & {
  buckets: BucketRow[];
  objects: ObjectRow[];
} {
  const buckets: BucketRow[] = [];
  const objects: ObjectRow[] = [];

  return {
    buckets,
    objects,

    async getBucket(name) {
      return buckets.find((b) => b.name === name) ?? null;
    },

    async listBuckets() {
      return [...buckets].sort((a, b) => a.name.localeCompare(b.name));
    },

    async createBucket({ name, public: isPublic }) {
      if (buckets.some((b) => b.name === name)) {
        const e = new Error('duplicate key') as Error & { code: string };
        e.code = '23505';
        throw e;
      }
      const row: BucketRow = {
        name,
        public: isPublic,
        created_at: new Date().toISOString(),
      };
      buckets.push(row);
      return row;
    },

    async deleteBucket(name) {
      const i = buckets.findIndex((b) => b.name === name);
      if (i >= 0) buckets.splice(i, 1);
      // Cascade objects, like the FK ON DELETE CASCADE in the migration.
      for (let j = objects.length - 1; j >= 0; j--) {
        if (objects[j].bucket === name) objects.splice(j, 1);
      }
    },

    async getObject(bucket, path) {
      return (
        objects.find((o) => o.bucket === bucket && o.path === path) ?? null
      );
    },

    async listObjects({ bucket, prefix, limit }: ListObjectsInput) {
      const lim = clampLimit(limit);
      return objects
        .filter(
          (o) =>
            o.bucket === bucket &&
            (!prefix || prefix.length === 0 || o.path.startsWith(prefix))
        )
        .sort((a, b) => a.path.localeCompare(b.path))
        .slice(0, lim);
    },

    async upsertObject({ bucket, path, size, mime, owner }: UpsertObjectInput) {
      const existing = objects.find(
        (o) => o.bucket === bucket && o.path === path
      );
      const now = new Date().toISOString();
      if (existing) {
        existing.size = size;
        existing.mime = mime;
        existing.updated_at = now;
        return existing;
      }
      const row: ObjectRow = {
        id: randomUUID(),
        bucket,
        path,
        size,
        mime,
        owner,
        created_at: now,
        updated_at: now,
      };
      objects.push(row);
      return row;
    },

    async deleteObject(bucket, path) {
      const i = objects.findIndex(
        (o) => o.bucket === bucket && o.path === path
      );
      if (i >= 0) objects.splice(i, 1);
    },

    async ping() {
      /* always healthy */
    },

    async close() {
      /* no-op */
    },
  };
}
