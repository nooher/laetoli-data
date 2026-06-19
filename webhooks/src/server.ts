// server.ts — wires the Postgres listener, the dispatcher, and a tiny HTTP API.
//
// The worker has no WebSocket surface (unlike realtime). It exposes only:
//   * GET /health  — JSON liveness (reports the LISTEN connection state).
//   * GET /status  — last delivery + delivery counts (for ops dashboards).
//
// The dedicated pg listener feeds every NOTIFY into Dispatcher.handle(), which
// matches active endpoints, POSTs (HMAC-signed) with retry/backoff, and logs
// each outcome to webhooks.deliveries.

import http from 'node:http';
import crypto from 'node:crypto';
import type { WebhooksConfig } from './config.js';
import { loadConfig } from './config.js';
import { parseNotification } from './core.js';
import { createPgListener, type NotificationSource } from './listener.js';
import { createPgStore, type Store } from './db.js';
import { Dispatcher, type FetchLike, type DeliverySnapshot } from './dispatcher.js';

export interface ServerDeps {
  config: WebhooksConfig;
  /** Injected for tests; default to the real implementations. */
  listener?: NotificationSource;
  store?: Store;
  fetch?: FetchLike;
}

export interface WebhooksServer {
  httpServer: http.Server;
  listener: NotificationSource;
  store: Store;
  dispatcher: Dispatcher;
  listen(): Promise<void>;
  close(): Promise<void>;
}

/** HMAC-SHA256 hex of a message under a key (the node:crypto primitive). */
export function hmacSha256Hex(key: string, message: string): string {
  return crypto.createHmac('sha256', key).update(message).digest('hex');
}

export function createServer(deps: ServerDeps): WebhooksServer {
  const { config } = deps;
  const listener = deps.listener ?? createPgListener(config);
  const store = deps.store ?? createPgStore(config);
  const fetchImpl: FetchLike =
    deps.fetch ?? ((url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>);

  let lastDelivery: DeliverySnapshot | null = null;

  const dispatcher = new Dispatcher({
    store,
    fetch: fetchImpl,
    hmacSha256Hex,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms).unref?.()),
    maxAttempts: config.maxAttempts,
    backoffBaseMs: config.backoffBaseMs,
    requestTimeoutMs: config.requestTimeoutMs,
    onDelivery: (snap) => {
      lastDelivery = snap;
    },
  });

  const httpServer = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];

    if (req.method === 'GET' && (path === '/health' || path === '/webhooks/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          service: 'laetoli-webhooks',
          listening: listener.isHealthy(),
        })
      );
      return;
    }

    if (req.method === 'GET' && (path === '/status' || path === '/webhooks/status')) {
      void (async () => {
        let counts = { total: 0, ok: 0 };
        try {
          counts = await store.counts();
        } catch {
          /* report zeros if the DB is unreachable */
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'ok',
            service: 'laetoli-webhooks',
            listening: listener.isHealthy(),
            deliveries: counts,
            lastDelivery,
          })
        );
      })();
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Njia haipatikani.' }));
  });

  return {
    httpServer,
    listener,
    store,
    dispatcher,
    async listen() {
      await listener.start((raw) => {
        const note = parseNotification(raw);
        if (!note) {
          console.warn('[webhooks] dropped malformed NOTIFY payload');
          return;
        }
        // Fire-and-forget; handle() swallows its own errors.
        void dispatcher.handle(note);
      });
      await new Promise<void>((resolve) => {
        httpServer.listen(config.port, () => {
          console.log(
            `[webhooks] Laetoli Data webhooks worker listening on :${config.port} ` +
              `(LISTEN ${config.channel})`
          );
          resolve();
        });
      });
    },
    async close() {
      await listener.stop();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await store.close();
    },
  };
}

// ---- entry point ----------------------------------------------------------

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
    return;
  }

  const server = createServer({ config });
  await server.listen();

  const shutdown = (signal: string) => {
    console.log(`[webhooks] ${signal} received, shutting down...`);
    server.close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Run only when executed directly (not when imported by tests).
if (import.meta.url.endsWith('/server.js')) {
  void main();
}
