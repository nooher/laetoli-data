// Configuration loaded from environment. Fails fast on missing secrets.
// Mirrors auth/src/config.ts so the two services share the same JWT_SECRET
// and Postgres connection conventions.

export interface RealtimeConfig {
  jwtSecret: string;
  port: number;
  /** Postgres NOTIFY channel the listener LISTENs on. */
  channel: string;
  /** Grace window (ms) for a {type:'auth'} message when no ?token= was given. */
  authGraceMs: number;
  // Postgres connection: prefer DATABASE_URL, else POSTGRES_* parts.
  // The realtime service connects AS the dedicated `laetoli_realtime` role.
  databaseUrl?: string;
  pg: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  };
}

/**
 * Read and validate config from a given env bag (defaults to process.env).
 * Throws a clear error if JWT_SECRET is missing/too weak (same rule as auth).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): RealtimeConfig {
  const jwtSecret = env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.trim().length === 0) {
    throw new Error(
      'FATAL: JWT_SECRET haijawekwa. Weka JWT_SECRET (angalau herufi 32) ' +
        'ili kuendana na auth + PostgREST. (JWT_SECRET is required and must match auth.)'
    );
  }
  if (jwtSecret.length < 32) {
    throw new Error(
      'FATAL: JWT_SECRET ni fupi mno (inahitaji angalau herufi 32). ' +
        '(JWT_SECRET must be at least 32 characters.)'
    );
  }

  const port = Number.parseInt(env.REALTIME_PORT ?? env.PORT ?? '9997', 10);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error('FATAL: REALTIME_PORT si sahihi (lazima iwe namba chanya).');
  }

  // The realtime role defaults to a dedicated, minimally-privileged login role.
  const pgUser = env.REALTIME_DB_USER ?? env.POSTGRES_USER ?? 'laetoli_realtime';

  return {
    jwtSecret,
    port,
    channel: env.REALTIME_CHANNEL ?? 'laetoli_realtime',
    authGraceMs: Number.parseInt(env.REALTIME_AUTH_GRACE_MS ?? '5000', 10),
    // REALTIME_DATABASE_URL lets the realtime service use its own role/DSN;
    // falls back to the shared DATABASE_URL if not set.
    databaseUrl: env.REALTIME_DATABASE_URL ?? env.DATABASE_URL,
    pg: {
      host: env.POSTGRES_HOST ?? 'db',
      port: Number.parseInt(env.POSTGRES_PORT ?? '5432', 10),
      user: pgUser,
      password: env.REALTIME_DB_PASSWORD ?? env.POSTGRES_PASSWORD ?? '',
      database: env.POSTGRES_DB ?? 'laetoli',
    },
  };
}
