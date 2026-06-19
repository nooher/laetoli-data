// server.ts — wires the pg store, the executor, the tick interval, and a tiny
// HTTP API. The scheduler is TIME-driven (a poll interval), not NOTIFY-driven.
//
// HTTP surface:
//   * GET  /health        — JSON liveness.
//   * GET  /status        — last run + run counts + next due job.
//   * POST /run/:jobId     — "run now": execute a job immediately on demand.
//       Gated by config.adminApiKey when set (X-Admin-Key / Bearer); otherwise
//       open, since the service is only reachable on the internal Docker network.
//
// On an interval (config.tickMs) the worker loads active jobs, schedules any
// without a next_run, and runs those that are due — recording a scheduler.runs
// row per execution and advancing jobs.next_run.

import http from 'node:http';
import crypto from 'node:crypto';
import type { SchedulerConfig } from './config.js';
import { loadConfig } from './config.js';
import { authorizeRunNow } from './core.js';
import { createPgStore, type Store } from './db.js';
import { Executor, type FetchLike, type RunSnapshot } from './executor.js';

export interface ServerDeps {
  config: SchedulerConfig;
  /** Injected for tests; default to the real implementations. */
  store?: Store;
  fetch?: FetchLike;
  now?: () => Date;
}

export interface SchedulerServer {
  httpServer: http.Server;
  store: Store;
  executor: Executor;
  /** Run one scan-and-execute cycle now (used by the interval + tests). */
  tick(): Promise<void>;
  listen(): Promise<void>;
  close(): Promise<void>;
}

/** HMAC-SHA256 hex of a message under a key (the node:crypto primitive). */
export function hmacSha256Hex(key: string, message: string): string {
  return crypto.createHmac('sha256', key).update(message).digest('hex');
}

export function createServer(deps: ServerDeps): SchedulerServer {
  const { config } = deps;
  const store = deps.store ?? createPgStore(config);
  const fetchImpl: FetchLike =
    deps.fetch ?? ((url, init) => fetch(url, init) as unknown as ReturnType<FetchLike>);
  const now = deps.now ?? (() => new Date());

  let lastRun: RunSnapshot | null = null;
  let timer: NodeJS.Timeout | null = null;

  const executor = new Executor({
    store,
    fetch: fetchImpl,
    hmacSha256Hex,
    now,
    requestTimeoutMs: config.requestTimeoutMs,
    onRun: (snap) => {
      lastRun = snap;
    },
  });

  async function tick(): Promise<void> {
    await executor.tick();
  }

  function arm(): void {
    timer = setInterval(() => {
      void tick().catch((e) =>
        console.error('[scheduler] tick error:', e instanceof Error ? e.message : String(e))
      );
    }, config.tickMs);
    timer.unref?.();
  }

  const httpServer = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];

    if (req.method === 'GET' && (path === '/health' || path === '/scheduler/health')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'laetoli-scheduler' }));
      return;
    }

    if (req.method === 'GET' && (path === '/status' || path === '/scheduler/status')) {
      void (async () => {
        let counts = { total: 0, ok: 0 };
        let nextDue: { id: string; name: string | null; next_run: string | null } | null = null;
        try {
          counts = await store.counts();
          const jobs = await store.activeJobs();
          const dated = jobs
            .filter((j) => j.next_run)
            .sort((a, b) => Date.parse(a.next_run!) - Date.parse(b.next_run!));
          if (dated[0]) {
            nextDue = { id: dated[0].id, name: dated[0].name, next_run: dated[0].next_run };
          }
        } catch {
          /* report zeros if the DB is unreachable */
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'ok',
            service: 'laetoli-scheduler',
            tickMs: config.tickMs,
            runs: counts,
            lastRun,
            nextDue,
          })
        );
      })();
      return;
    }

    // POST /run/:jobId — run-now trigger.
    const runMatch = /^\/(?:scheduler\/)?run\/([^/]+)$/.exec(path);
    if (req.method === 'POST' && runMatch) {
      const jobId = decodeURIComponent(runMatch[1]);
      const authorized = authorizeRunNow(config.adminApiKey, {
        adminKey: header(req, 'x-admin-key'),
        authorization: header(req, 'authorization'),
      });
      if (!authorized) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Hauruhusiwi. (unauthorized)' }));
        return;
      }
      void (async () => {
        try {
          const job = await store.getJob(jobId);
          if (!job) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Kazi haipatikani. (job not found)' }));
            return;
          }
          const result = await executor.run(job, 'manual');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ jobId, triggered: 'manual', result }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ error: e instanceof Error ? e.message : String(e) })
          );
        }
      })();
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Njia haipatikani.' }));
  });

  return {
    httpServer,
    store,
    executor,
    tick,
    async listen() {
      // Prime next_run for any unscheduled jobs immediately, then start ticking.
      await tick();
      arm();
      await new Promise<void>((resolve) => {
        httpServer.listen(config.port, () => {
          console.log(
            `[scheduler] Laetoli Data scheduler worker listening on :${config.port} ` +
              `(tick ${config.tickMs}ms${config.adminApiKey ? ', run-now gated' : ''})`
          );
          resolve();
        });
      });
    },
    async close() {
      if (timer) clearInterval(timer);
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await store.close();
    },
  };
}

function header(req: http.IncomingMessage, name: string): string | null {
  const v = req.headers[name];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
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
    console.log(`[scheduler] ${signal} received, shutting down...`);
    server.close().finally(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

// Run only when executed directly (not when imported by tests).
if (import.meta.url.endsWith('/server.js')) {
  void main();
}
