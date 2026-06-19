// Database seam for bucket + object METADATA (bytes live on disk, see store.ts).
// Handlers depend on the `Db` interface, NOT on `pg` directly. Tests inject a
// fake Db (createMemoryDb) so they run without Postgres.

import pg from 'pg';
import type { StorageConfig } from './config.js';

export interface BucketRow {
  name: string;
  public: boolean;
  created_at: string;
}

export interface ObjectRow {
  id: string;
  bucket: string;
  path: string;
  size: number;
  mime: string;
  owner: string;
  created_at: string;
  updated_at: string;
}

export interface UpsertObjectInput {
  bucket: string;
  path: string;
  size: number;
  mime: string;
  owner: string;
}

export interface ListObjectsInput {
  bucket: string;
  prefix?: string;
  limit?: number;
}

/**
 * The dependency-injection seam. Implemented for real by `createPgDb`, faked in
 * tests by `createMemoryDb`.
 */
export interface Db {
  getBucket(name: string): Promise<BucketRow | null>;
  listBuckets(): Promise<BucketRow[]>;
  createBucket(input: { name: string; public: boolean }): Promise<BucketRow>;
  deleteBucket(name: string): Promise<void>;

  getObject(bucket: string, path: string): Promise<ObjectRow | null>;
  listObjects(input: ListObjectsInput): Promise<ObjectRow[]>;
  upsertObject(input: UpsertObjectInput): Promise<ObjectRow>;
  deleteObject(bucket: string, path: string): Promise<void>;

  /** Liveness check for /health. */
  ping(): Promise<void>;
  close(): Promise<void>;
}

const BUCKET_COLS = 'name, public, created_at';
const OBJECT_COLS =
  'id, bucket, path, size, mime, owner, created_at, updated_at';

/** Postgres-backed Db. Parameterized SQL only. */
export function createPgDb(config: StorageConfig): Db {
  const pool = config.databaseUrl
    ? new pg.Pool({ connectionString: config.databaseUrl })
    : new pg.Pool({
        host: config.pg.host,
        port: config.pg.port,
        user: config.pg.user,
        password: config.pg.password,
        database: config.pg.database,
      });

  return {
    async getBucket(name) {
      const { rows } = await pool.query<BucketRow>(
        `SELECT ${BUCKET_COLS} FROM storage.buckets WHERE name = $1 LIMIT 1`,
        [name]
      );
      return rows[0] ?? null;
    },

    async listBuckets() {
      const { rows } = await pool.query<BucketRow>(
        `SELECT ${BUCKET_COLS} FROM storage.buckets ORDER BY name ASC`
      );
      return rows;
    },

    async createBucket({ name, public: isPublic }) {
      const { rows } = await pool.query<BucketRow>(
        `INSERT INTO storage.buckets (name, public)
         VALUES ($1, $2)
         RETURNING ${BUCKET_COLS}`,
        [name, isPublic]
      );
      return rows[0];
    },

    async deleteBucket(name) {
      await pool.query(`DELETE FROM storage.buckets WHERE name = $1`, [name]);
    },

    async getObject(bucket, path) {
      const { rows } = await pool.query<ObjectRow>(
        `SELECT ${OBJECT_COLS} FROM storage.objects
         WHERE bucket = $1 AND path = $2 LIMIT 1`,
        [bucket, path]
      );
      return rows[0] ?? null;
    },

    async listObjects({ bucket, prefix, limit }) {
      const lim = clampLimit(limit);
      if (prefix && prefix.length > 0) {
        const { rows } = await pool.query<ObjectRow>(
          `SELECT ${OBJECT_COLS} FROM storage.objects
           WHERE bucket = $1 AND path LIKE $2 || '%'
           ORDER BY path ASC LIMIT $3`,
          [bucket, prefix, lim]
        );
        return rows;
      }
      const { rows } = await pool.query<ObjectRow>(
        `SELECT ${OBJECT_COLS} FROM storage.objects
         WHERE bucket = $1 ORDER BY path ASC LIMIT $2`,
        [bucket, lim]
      );
      return rows;
    },

    async upsertObject({ bucket, path, size, mime, owner }) {
      const { rows } = await pool.query<ObjectRow>(
        `INSERT INTO storage.objects (bucket, path, size, mime, owner)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (bucket, path) DO UPDATE
           SET size = EXCLUDED.size,
               mime = EXCLUDED.mime,
               updated_at = now()
         RETURNING ${OBJECT_COLS}`,
        [bucket, path, size, mime, owner]
      );
      return rows[0];
    },

    async deleteObject(bucket, path) {
      await pool.query(
        `DELETE FROM storage.objects WHERE bucket = $1 AND path = $2`,
        [bucket, path]
      );
    },

    async ping() {
      await pool.query('SELECT 1');
    },

    async close() {
      await pool.end();
    },
  };
}

export function clampLimit(limit?: number): number {
  if (!limit || !Number.isFinite(limit) || limit <= 0) return 100;
  return Math.min(Math.floor(limit), 1000);
}
