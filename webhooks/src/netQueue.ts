// netQueue.ts — the database gateway for the pg_net compatibility bridge
// (net.http_request_queue / net.http_response). Separate from db.ts's `Store`
// (webhooks.endpoints/deliveries) on purpose: these are two distinct
// concerns — table-change fan-out vs. arbitrary queued HTTP calls — that
// happen to share a deployable process because it already has HTTP+retry
// infrastructure, not because they're the same thing.

import pg from 'pg';
import type { WebhooksConfig } from './config.js';

export interface QueuedRequest {
  id: number;
  method: 'GET' | 'POST';
  url: string;
  headers: Record<string, string>;
  body: string | null;
  timeout_milliseconds: number;
}

export interface ResponseRecord {
  id: number;
  statusCode: number | null;
  headers: Record<string, string> | null;
  content: string | null;
  errorMsg: string | null;
}

export interface NetQueueStore {
  /** All not-yet-processed requests, oldest first (poll-drain on start, then per-NOTIFY). */
  pending(): Promise<QueuedRequest[]>;
  /** Record the outcome and remove the row from the pending queue (one net.http_response row remains). */
  complete(r: ResponseRecord): Promise<void>;
  close(): Promise<void>;
}

export function createPgNetQueueStore(config: WebhooksConfig): NetQueueStore {
  const pool = config.databaseUrl
    ? new pg.Pool({ connectionString: config.databaseUrl, max: 4 })
    : new pg.Pool({
        host: config.pg.host,
        port: config.pg.port,
        user: config.pg.user,
        password: config.pg.password,
        database: config.pg.database,
        max: 4,
      });

  return {
    async pending() {
      const { rows } = await pool.query(
        `SELECT id, method, url, headers, body, timeout_milliseconds
           FROM net.http_request_queue
          ORDER BY id ASC`
      );
      return rows as QueuedRequest[];
    },
    async complete(r) {
      // Both statements run even if one fails independently — a missing
      // response row is recoverable (caller can requeue); a queue row stuck
      // forever is not, so DELETE happens regardless of the response insert.
      try {
        await pool.query(
          `INSERT INTO net.http_response (id, status_code, headers, content, error_msg)
           VALUES ($1, $2, $3::jsonb, $4, $5)
           ON CONFLICT (id) DO UPDATE SET
             status_code = EXCLUDED.status_code,
             headers = EXCLUDED.headers,
             content = EXCLUDED.content,
             error_msg = EXCLUDED.error_msg,
             created_at = now()`,
          [r.id, r.statusCode, JSON.stringify(r.headers ?? {}), r.content, r.errorMsg]
        );
      } finally {
        await pool.query(`DELETE FROM net.http_request_queue WHERE id = $1`, [r.id]);
      }
    },
    async close() {
      await pool.end();
    },
  };
}

/** In-memory store for tests. */
export class FakeNetQueueStore implements NetQueueStore {
  queue: QueuedRequest[] = [];
  responses: ResponseRecord[] = [];

  async pending(): Promise<QueuedRequest[]> {
    return [...this.queue];
  }
  async complete(r: ResponseRecord): Promise<void> {
    this.responses.push(r);
    this.queue = this.queue.filter((q) => q.id !== r.id);
  }
  async close(): Promise<void> {
    /* no-op */
  }
}
