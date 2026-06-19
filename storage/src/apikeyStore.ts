// apikeyStore.ts — pg-backed ApiKeyStore for the apikeyGuard.
//
// SAME file copied into storage/ and functions/ (duplicated like metrics.ts).
// Reads the `keys` schema (see db/migrations/0004_apikeys.sql). Only used when
// REQUIRE_API_KEY=true; when the flag is off the guard is a no-op and this
// store is never constructed, so the DB is never touched.

import pg from 'pg';
import type { ApiKeyStore, ActiveKey } from './apikeyGuard.js';

export interface PgConn {
  databaseUrl?: string;
  pg: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  };
}

/** Build a pg-backed ApiKeyStore plus a close() to release the pool. */
export function createPgApiKeyStore(conn: PgConn): ApiKeyStore & { close(): Promise<void> } {
  const pool = conn.databaseUrl
    ? new pg.Pool({ connectionString: conn.databaseUrl })
    : new pg.Pool({
        host: conn.pg.host,
        port: conn.pg.port,
        user: conn.pg.user,
        password: conn.pg.password,
        database: conn.pg.database,
      });

  return {
    async findActiveByHash(hash: string): Promise<ActiveKey | null> {
      const { rows } = await pool.query<{
        id: string;
        project_id: string;
        role: 'anon' | 'service';
        rate_limit_per_min: number;
      }>(
        `SELECT id, project_id, role, rate_limit_per_min
           FROM keys.api_keys
          WHERE key_hash = $1 AND revoked_at IS NULL
          LIMIT 1`,
        [hash]
      );
      const r = rows[0];
      if (!r) return null;
      return {
        key_id: r.id,
        project_id: r.project_id,
        role: r.role,
        rate_limit_per_min: r.rate_limit_per_min,
      };
    },

    async recordUsage(keyId: string): Promise<void> {
      // UPSERT today's counter. Best-effort; the guard swallows any rejection.
      await pool.query(
        `INSERT INTO keys.usage (key_id, day, count)
           VALUES ($1, CURRENT_DATE, 1)
         ON CONFLICT (key_id, day)
           DO UPDATE SET count = keys.usage.count + 1`,
        [keyId]
      );
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}
