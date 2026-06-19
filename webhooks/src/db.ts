// db.ts — the database gateway, behind an interface so the dispatcher can be
// tested with no live Postgres. Production uses `createPgStore` (a pg.Pool);
// tests inject a `FakeStore`.

import pg from 'pg';
import type { WebhooksConfig } from './config.js';
import type { Endpoint } from './core.js';

/** A recorded delivery outcome to persist into webhooks.deliveries. */
export interface DeliveryRecord {
  endpointId: string;
  event: string;
  statusCode: number | null;
  ok: boolean;
  error: string | null;
  attempts: number;
  payload: string; // the JSON body string that was POSTed
}

/** Everything the dispatcher needs from the database. */
export interface Store {
  /** Active endpoints — the dispatcher filters in-memory via matchEndpoint. */
  activeEndpoints(): Promise<Endpoint[]>;
  /** Append one delivery-log row. Must never throw the worker down. */
  recordDelivery(d: DeliveryRecord): Promise<void>;
  /** For /status: total + ok delivery counts. */
  counts(): Promise<{ total: number; ok: number }>;
  close(): Promise<void>;
}

/** Postgres-backed store (pg.Pool). Connects AS laetoli_webhooks. */
export function createPgStore(config: WebhooksConfig): Store {
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
    async activeEndpoints() {
      const { rows } = await pool.query(
        `SELECT id, name, table_name, events, url, secret, active
           FROM webhooks.endpoints
          WHERE active = true`
      );
      return rows as Endpoint[];
    },
    async recordDelivery(d) {
      await pool.query(
        `INSERT INTO webhooks.deliveries
           (endpoint_id, event, status_code, ok, error, attempts, payload)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [d.endpointId, d.event, d.statusCode, d.ok, d.error, d.attempts, d.payload]
      );
    },
    async counts() {
      const { rows } = await pool.query(
        `SELECT count(*)::bigint AS total,
                count(*) FILTER (WHERE ok)::bigint AS ok
           FROM webhooks.deliveries`
      );
      const r = rows[0] ?? { total: '0', ok: '0' };
      return { total: Number(r.total), ok: Number(r.ok) };
    },
    async close() {
      await pool.end();
    },
  };
}

/** In-memory store for tests. */
export class FakeStore implements Store {
  endpoints: Endpoint[] = [];
  deliveries: DeliveryRecord[] = [];
  recordShouldThrow = false;

  constructor(endpoints: Endpoint[] = []) {
    this.endpoints = endpoints;
  }
  async activeEndpoints(): Promise<Endpoint[]> {
    return this.endpoints.filter((e) => e.active);
  }
  async recordDelivery(d: DeliveryRecord): Promise<void> {
    if (this.recordShouldThrow) throw new Error('db down');
    this.deliveries.push(d);
  }
  async counts(): Promise<{ total: number; ok: number }> {
    return {
      total: this.deliveries.length,
      ok: this.deliveries.filter((d) => d.ok).length,
    };
  }
  async close(): Promise<void> {
    /* no-op */
  }
}
