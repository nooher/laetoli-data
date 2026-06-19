// Configuration loaded from environment. Fails fast on missing secrets.

export interface AuthConfig {
  jwtSecret: string;
  jwtExpiry: number; // seconds
  port: number;
  // Postgres connection: prefer DATABASE_URL, else POSTGRES_* parts.
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
 * Throws a clear error if JWT_SECRET is missing/too weak.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const jwtSecret = env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.trim().length === 0) {
    throw new Error(
      'FATAL: JWT_SECRET haijawekwa. Weka JWT_SECRET (angalau herufi 32) ' +
        'ili kuendana na PostgREST. (JWT_SECRET is required and must match PostgREST.)'
    );
  }
  if (jwtSecret.length < 32) {
    throw new Error(
      'FATAL: JWT_SECRET ni fupi mno (inahitaji angalau herufi 32). ' +
        '(JWT_SECRET must be at least 32 characters.)'
    );
  }

  const jwtExpiry = Number.parseInt(env.JWT_EXPIRY ?? '3600', 10);
  if (!Number.isFinite(jwtExpiry) || jwtExpiry <= 0) {
    throw new Error('FATAL: JWT_EXPIRY si sahihi (lazima iwe sekunde chanya).');
  }

  const port = Number.parseInt(env.AUTH_PORT ?? env.PORT ?? '9999', 10);

  return {
    jwtSecret,
    jwtExpiry,
    port,
    databaseUrl: env.DATABASE_URL,
    pg: {
      host: env.POSTGRES_HOST ?? 'db',
      port: Number.parseInt(env.POSTGRES_PORT ?? '5432', 10),
      user: env.POSTGRES_USER ?? 'laetoli',
      password: env.POSTGRES_PASSWORD ?? '',
      database: env.POSTGRES_DB ?? 'laetoli',
    },
  };
}
