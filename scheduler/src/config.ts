// config.ts — environment config for the scheduler worker.
//
// Mirrors webhooks/src/config.ts: it connects to Postgres AS its own dedicated
// role (laetoli_scheduler). It does NOT verify JWTs, so no JWT_SECRET. Unlike
// webhooks it is TIME-driven (a poll interval), not NOTIFY-driven, so there is
// no channel.

export interface SchedulerConfig {
  port: number;
  /** How often (ms) the worker wakes to look for due jobs. */
  tickMs: number;
  /** Per-request fetch timeout (ms) for kind=http jobs. */
  requestTimeoutMs: number;
  /**
   * Optional admin key. When set, POST /run/:jobId requires a matching
   * `X-Admin-Key` (or `Authorization: Bearer`) header. When unset, run-now is
   * open — which is fine because the service is only reachable on the internal
   * Docker network (not published to the host / not proxied by caddy unless you
   * add a route). Document this in docs/SCHEDULER.md.
   */
  adminApiKey: string | null;
  // Postgres connection: prefer DATABASE_URL, else POSTGRES_* parts.
  // The worker connects AS the dedicated `laetoli_scheduler` role.
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
export function loadConfig(env: NodeJS.ProcessEnv = process.env): SchedulerConfig {
  const port = intEnv(env.SCHEDULER_PORT ?? env.PORT, 9992);
  const pgUser = env.SCHEDULER_DB_USER ?? env.POSTGRES_USER ?? 'laetoli_scheduler';
  const adminApiKey = (env.SCHEDULER_ADMIN_KEY ?? env.ADMIN_API_KEY ?? '').trim();

  return {
    port,
    tickMs: intEnv(env.SCHEDULER_TICK_MS, 30_000),
    requestTimeoutMs: intEnv(env.SCHEDULER_TIMEOUT_MS, 10_000),
    adminApiKey: adminApiKey.length > 0 ? adminApiKey : null,
    // SCHEDULER_DATABASE_URL lets the worker use its own role/DSN; falls back to
    // the shared DATABASE_URL.
    databaseUrl: env.SCHEDULER_DATABASE_URL ?? env.DATABASE_URL,
    pg: {
      host: env.POSTGRES_HOST ?? 'db',
      port: intEnv(env.POSTGRES_PORT, 5432),
      user: pgUser,
      password: env.SCHEDULER_DB_PASSWORD ?? env.POSTGRES_PASSWORD ?? '',
      database: env.POSTGRES_DB ?? 'laetoli',
    },
  };
}
