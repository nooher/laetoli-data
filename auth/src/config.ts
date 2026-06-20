// Configuration loaded from environment. Fails fast on missing secrets.

/** How a generated token (reset / email-verify) is delivered to the user. */
export type DeliveryMode = 'log' | 'email';

export interface AuthConfig {
  jwtSecret: string;
  jwtExpiry: number; // seconds — access-token (JWT) lifetime
  refreshExpiry: number; // seconds — refresh-token lifetime
  resetExpiry: number; // seconds — password-reset token lifetime
  emailVerifyExpiry: number; // seconds — email-verification token lifetime
  // Delivery seams: 'log' (default, dev/offline) writes the token to the log and
  // returns it in the response; 'email' is the wiring point for a future
  // mailer/SMS sender (no external call is made by this service).
  resetDelivery: DeliveryMode;
  emailDelivery: DeliveryMode;
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

  function parsePositiveSeconds(
    raw: string | undefined,
    fallback: number,
    name: string
  ): number {
    if (raw === undefined || raw.trim() === '') return fallback;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`FATAL: ${name} si sahihi (lazima iwe sekunde chanya).`);
    }
    return n;
  }

  function parseDelivery(raw: string | undefined): DeliveryMode {
    const v = (raw ?? 'log').trim().toLowerCase();
    if (v === 'log' || v === 'email') return v;
    throw new Error(
      `FATAL: *_DELIVERY si sahihi ("${v}"). Tumia "log" au "email".`
    );
  }

  // Refresh tokens default to 30 days; reset/verify default to 1 hour / 24h.
  const refreshExpiry = parsePositiveSeconds(
    env.REFRESH_EXPIRY,
    60 * 60 * 24 * 30,
    'REFRESH_EXPIRY'
  );
  const resetExpiry = parsePositiveSeconds(
    env.RESET_EXPIRY,
    60 * 60,
    'RESET_EXPIRY'
  );
  const emailVerifyExpiry = parsePositiveSeconds(
    env.EMAIL_VERIFY_EXPIRY,
    60 * 60 * 24,
    'EMAIL_VERIFY_EXPIRY'
  );

  const resetDelivery = parseDelivery(env.RESET_DELIVERY);
  const emailDelivery = parseDelivery(env.EMAIL_DELIVERY);

  const port = Number.parseInt(env.AUTH_PORT ?? env.PORT ?? '9999', 10);

  return {
    jwtSecret,
    jwtExpiry,
    refreshExpiry,
    resetExpiry,
    emailVerifyExpiry,
    resetDelivery,
    emailDelivery,
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
