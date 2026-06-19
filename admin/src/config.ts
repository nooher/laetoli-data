// Configuration loaded from environment. Fails fast on a missing admin key.
//
// SECURITY: ADMIN_API_KEY is the sovereign "service role key" — the
// keys-to-the-kingdom. The admin service connects to Postgres as a BYPASSRLS
// role, so anyone holding this key can read/write/DROP anything in the database,
// bypassing Row Level Security entirely. Treat it like a root password: never
// ship it to a browser, never log it, rotate it if leaked. If it is unset the
// service refuses to start — we NEVER run open.

export interface AdminConfig {
  adminApiKey: string;
  port: number;
  // Postgres connection: prefer DATABASE_URL, else PG* parts.
  databaseUrl?: string;
  pg: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  };
  /** Per-statement timeout (ms) applied to the SQL console. */
  statementTimeoutMs: number;
}

/**
 * Read and validate config from a given env bag (defaults to process.env).
 * Throws a clear error if ADMIN_API_KEY is missing/too weak (fail fast).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AdminConfig {
  const adminApiKey = env.ADMIN_API_KEY;
  if (!adminApiKey || adminApiKey.trim().length === 0) {
    throw new Error(
      'FATAL: ADMIN_API_KEY haijawekwa. Weka ADMIN_API_KEY (angalau herufi 24) ' +
        'kabla ya kuanzisha huduma ya admin — hatuendeshi bila ufunguo. ' +
        '(ADMIN_API_KEY is required; the admin service never runs open.)'
    );
  }
  if (adminApiKey.length < 24) {
    throw new Error(
      'FATAL: ADMIN_API_KEY ni fupi mno (inahitaji angalau herufi 24). ' +
        'Tengeneza: openssl rand -base64 36. ' +
        '(ADMIN_API_KEY must be at least 24 characters.)'
    );
  }

  const port = Number.parseInt(env.ADMIN_PORT ?? env.PORT ?? '9996', 10);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error('FATAL: ADMIN_PORT si sahihi (lazima iwe namba chanya).');
  }

  const statementTimeoutMs = Number.parseInt(
    env.ADMIN_STATEMENT_TIMEOUT_MS ?? '15000',
    10
  );

  return {
    adminApiKey,
    port,
    statementTimeoutMs:
      Number.isFinite(statementTimeoutMs) && statementTimeoutMs > 0
        ? statementTimeoutMs
        : 15000,
    databaseUrl: env.DATABASE_URL,
    pg: {
      host: env.PGHOST ?? env.POSTGRES_HOST ?? 'db',
      port: Number.parseInt(env.PGPORT ?? env.POSTGRES_PORT ?? '5432', 10),
      user: env.PGUSER ?? env.POSTGRES_USER ?? 'laetoli_admin_login',
      password: env.PGPASSWORD ?? env.POSTGRES_PASSWORD ?? '',
      database: env.PGDATABASE ?? env.POSTGRES_DB ?? 'laetoli',
    },
  };
}
