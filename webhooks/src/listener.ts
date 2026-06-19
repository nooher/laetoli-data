// listener.ts — the Postgres LISTEN source, behind an interface.
//
// Mirrors realtime/src/listener.ts: the worker holds ONE dedicated pg client
// that runs `LISTEN laetoli_realtime` and forwards each NOTIFY payload to a
// callback. Production uses `createPgListener`; tests inject a `FakeListener`.

import pg from 'pg';
import type { WebhooksConfig } from './config.js';

/** A source of raw NOTIFY payload strings on the realtime channel. */
export interface NotificationSource {
  /** Begin listening; `onPayload` is called with each raw NOTIFY string. */
  start(onPayload: (raw: string) => void): Promise<void>;
  /** Liveness for /health (true when the LISTEN connection is up). */
  isHealthy(): boolean;
  stop(): Promise<void>;
}

/**
 * Postgres-backed listener. Uses a single dedicated pg.Client (NOT a pool —
 * LISTEN is connection-scoped). Reconnects with backoff if the connection drops.
 */
export function createPgListener(config: WebhooksConfig): NotificationSource {
  let client: pg.Client | null = null;
  let healthy = false;
  let stopped = false;
  let onPayload: ((raw: string) => void) | null = null;
  let backoffMs = 1000;
  const MAX_BACKOFF = 30_000;

  const connectArgs: pg.ClientConfig = config.databaseUrl
    ? { connectionString: config.databaseUrl }
    : {
        host: config.pg.host,
        port: config.pg.port,
        user: config.pg.user,
        password: config.pg.password,
        database: config.pg.database,
      };

  async function connect(): Promise<void> {
    if (stopped) return;
    const c = new pg.Client(connectArgs);
    client = c;
    c.on('notification', (msg) => {
      if (msg.channel === config.channel && msg.payload && onPayload) {
        onPayload(msg.payload);
      }
    });
    c.on('error', (err) => {
      console.error('[webhooks] pg listen error:', err.message);
      healthy = false;
      scheduleReconnect();
    });
    try {
      await c.connect();
      await c.query(`LISTEN ${quoteIdent(config.channel)}`);
      healthy = true;
      backoffMs = 1000; // reset on a clean connect
      console.log(`[webhooks] LISTEN ${config.channel} established`);
    } catch (e) {
      healthy = false;
      console.error('[webhooks] pg connect failed:', e instanceof Error ? e.message : String(e));
      scheduleReconnect();
    }
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    const delay = backoffMs;
    backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF);
    setTimeout(() => {
      void connect();
    }, delay).unref?.();
  }

  return {
    async start(cb) {
      onPayload = cb;
      await connect();
    },
    isHealthy() {
      return healthy;
    },
    async stop() {
      stopped = true;
      healthy = false;
      if (client) {
        try {
          await client.end();
        } catch {
          /* ignore */
        }
        client = null;
      }
    },
  };
}

/** A fake, in-memory source for tests — `emit(raw)` feeds the callback. */
export class FakeListener implements NotificationSource {
  private cb: ((raw: string) => void) | null = null;
  private healthy = false;

  async start(onPayload: (raw: string) => void): Promise<void> {
    this.cb = onPayload;
    this.healthy = true;
  }
  emit(raw: string): void {
    this.cb?.(raw);
  }
  isHealthy(): boolean {
    return this.healthy;
  }
  async stop(): Promise<void> {
    this.healthy = false;
    this.cb = null;
  }
}

/** Quote a Postgres identifier for use in LISTEN. */
function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}
