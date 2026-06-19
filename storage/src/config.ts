// Configuration loaded from environment. Fails fast on missing secrets.
// Mirrors auth/src/config.ts so the two services share one JWT_SECRET and the
// same Postgres connection conventions.

export interface StorageConfig {
  jwtSecret: string;
  port: number;
  /** Filesystem root where object bytes are stored. */
  storageRoot: string;
  /** Max upload size in bytes (default 50 MiB — friendly to a Pi). */
  maxUploadBytes: number;
  /**
   * Opt-in API-key enforcement (multi-tenant). Default false → the apikeyGuard
   * is a no-op and all existing flows are unchanged. Set REQUIRE_API_KEY=true
   * to require a valid `apikey` header/query on every request.
   */
  requireApiKey: boolean;
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
export function loadConfig(env: NodeJS.ProcessEnv = process.env): StorageConfig {
  const jwtSecret = env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.trim().length === 0) {
    throw new Error(
      'FATAL: JWT_SECRET haijawekwa. Weka JWT_SECRET (angalau herufi 32) ' +
        'ili kuendana na auth na PostgREST. (JWT_SECRET is required and must match the auth service.)'
    );
  }
  if (jwtSecret.length < 32) {
    throw new Error(
      'FATAL: JWT_SECRET ni fupi mno (inahitaji angalau herufi 32). ' +
        '(JWT_SECRET must be at least 32 characters.)'
    );
  }

  const port = Number.parseInt(env.STORAGE_PORT ?? env.PORT ?? '9998', 10);

  const maxUploadBytes = Number.parseInt(
    env.STORAGE_MAX_UPLOAD_BYTES ?? String(50 * 1024 * 1024),
    10
  );
  if (!Number.isFinite(maxUploadBytes) || maxUploadBytes <= 0) {
    throw new Error(
      'FATAL: STORAGE_MAX_UPLOAD_BYTES si sahihi (lazima iwe baiti chanya).'
    );
  }

  return {
    jwtSecret,
    port,
    storageRoot: env.STORAGE_ROOT ?? '/data/storage',
    maxUploadBytes,
    requireApiKey: (env.REQUIRE_API_KEY ?? 'false').toLowerCase() === 'true',
    databaseUrl: env.DATABASE_URL,
    pg: {
      host: env.POSTGRES_HOST ?? 'db',
      port: Number.parseInt(env.POSTGRES_PORT ?? '5432', 10),
      user: env.POSTGRES_USER ?? 'laetoli_storage',
      password: env.POSTGRES_PASSWORD ?? '',
      database: env.POSTGRES_DB ?? 'laetoli',
    },
  };
}
