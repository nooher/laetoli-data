// config.ts — environment config for the webhooks worker.
//
// Mirrors realtime/src/config.ts: it LISTENs on the same NOTIFY channel and
// connects to Postgres AS its own dedicated role (laetoli_webhooks). Unlike the
// realtime/auth services it does NOT verify JWTs, so no JWT_SECRET is required.

export interface WebhooksConfig {
  port: number;
  /** Postgres NOTIFY channel the listener LISTENs on (shared with realtime). */
  channel: string;
  /** HTTP retry/backoff budget per delivery. */
  maxAttempts: number;
  /** Base backoff (ms); doubled each retry. */
  backoffBaseMs: number;
  /** Per-request fetch timeout (ms) — a slow/dead URL must never hang the worker. */
  requestTimeoutMs: number;
  // Postgres connection: prefer DATABASE_URL, else POSTGRES_* parts.
  // The worker connects AS the dedicated `laetoli_webhooks` role.
  databaseUrl?: string;
  pg: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  };
}

function intEnv(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Read and validate config from a given env bag (defaults to process.env). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): WebhooksConfig {
  const port = intEnv(env.WEBHOOKS_PORT ?? env.PORT, 9993);

  const pgUser = env.WEBHOOKS_DB_USER ?? env.POSTGRES_USER ?? 'laetoli_webhooks';

  return {
    port,
    channel: env.WEBHOOKS_CHANNEL ?? env.REALTIME_CHANNEL ?? 'laetoli_realtime',
    maxAttempts: intEnv(env.WEBHOOKS_MAX_ATTEMPTS, 3),
    backoffBaseMs: intEnv(env.WEBHOOKS_BACKOFF_MS, 500),
    requestTimeoutMs: intEnv(env.WEBHOOKS_TIMEOUT_MS, 10_000),
    // WEBHOOKS_DATABASE_URL lets the worker use its own role/DSN; falls back to
    // the shared DATABASE_URL.
    databaseUrl: env.WEBHOOKS_DATABASE_URL ?? env.DATABASE_URL,
    pg: {
      host: env.POSTGRES_HOST ?? 'db',
      port: intEnv(env.POSTGRES_PORT, 5432),
      user: pgUser,
      password: env.WEBHOOKS_DB_PASSWORD ?? env.POSTGRES_PASSWORD ?? '',
      database: env.POSTGRES_DB ?? 'laetoli',
    },
  };
}
