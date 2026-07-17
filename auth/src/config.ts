// Configuration loaded from environment. Fails fast on missing secrets.

/** How a generated token (reset / email-verify / OTP) is delivered to the user. */
export type DeliveryMode = 'log' | 'email' | 'sms';

export interface AuthConfig {
  jwtSecret: string;
  jwtExpiry: number; // seconds — access-token (JWT) lifetime
  refreshExpiry: number; // seconds — refresh-token lifetime
  resetExpiry: number; // seconds — password-reset token lifetime
  emailVerifyExpiry: number; // seconds — email-verification token lifetime
  magicLinkExpiry: number; // seconds — email magic-link token lifetime
  // Delivery seams: 'log' (default, dev/offline) writes the token to the log and
  // returns it in the response; 'email' is the wiring point for a future
  // mailer/SMS sender (no external call is made by this service).
  resetDelivery: DeliveryMode;
  emailDelivery: DeliveryMode;
  magicLinkDelivery: DeliveryMode;
  port: number;
  // Public base URL used to build clickable reset / verify links in delivered
  // messages. When unset, the raw token is sent instead. Prefer BASE_URL, else
  // APP_URL, else the data URL the SDK already knows.
  baseUrl?: string;
  // SMTP (real email). When smtp.host is unset, the mailer degrades to 'log'.
  smtp: {
    host?: string;
    port: number;
    secure: boolean;
    user?: string;
    pass?: string;
    from: string;
  };
  // NextSMS / messaging-service.co.tz (the operator's OWN account). When
  // sms.apiToken is unset, the sender degrades to a no-op (log) — no lock-in.
  sms: {
    apiUrl: string;
    apiToken?: string;
    defaultSenderId: string;
  };
  // Google OAuth (signInWithOAuth({provider:'google'})). Unset clientId/Secret
  // degrades /oauth/google/start to a clear 503, same "optional, no lock-in"
  // pattern as SMTP/SMS above — the service still boots without them.
  googleOAuth: {
    clientId?: string;
    clientSecret?: string;
    /** Must exactly match a URI registered in the Google Cloud OAuth client. */
    redirectUri?: string;
  };
  // After a successful OAuth login, the browser is redirected back to the
  // app with tokens in the URL fragment. This allow-list (an anchored
  // alternation regex, same shape as CORS_ALLOWED_ORIGINS_REGEXP) prevents
  // an attacker from using the OAuth flow as an open redirect to steal
  // tokens. Unset → no redirect_to is accepted (safe default, not permissive
  // like CORS's unset-default, since this one can leak tokens).
  oauthAllowedRedirectOriginsRegexp?: string;
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
    if (v === 'log' || v === 'email' || v === 'sms') return v;
    throw new Error(
      `FATAL: *_DELIVERY si sahihi ("${v}"). Tumia "log", "email" au "sms".`
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
  const magicLinkExpiry = parsePositiveSeconds(
    env.MAGICLINK_EXPIRY,
    15 * 60,
    'MAGICLINK_EXPIRY'
  );

  const resetDelivery = parseDelivery(env.RESET_DELIVERY);
  const emailDelivery = parseDelivery(env.EMAIL_DELIVERY);
  const magicLinkDelivery = parseDelivery(env.MAGICLINK_DELIVERY ?? env.EMAIL_DELIVERY);

  const port = Number.parseInt(env.AUTH_PORT ?? env.PORT ?? '9999', 10);

  const baseUrl =
    env.BASE_URL ?? env.APP_URL ?? env.LAETOLI_DATA_URL ?? undefined;

  const smtpPort = Number.parseInt(env.SMTP_PORT ?? '587', 10);
  const smtp = {
    host: env.SMTP_HOST?.trim() || undefined,
    port: Number.isFinite(smtpPort) && smtpPort > 0 ? smtpPort : 587,
    // Default secure=true only on the implicit-TLS port 465; STARTTLS (587) is false.
    secure: env.SMTP_SECURE
      ? env.SMTP_SECURE.trim().toLowerCase() === 'true'
      : smtpPort === 465,
    user: env.SMTP_USER?.trim() || undefined,
    pass: env.SMTP_PASS || undefined,
    from: env.SMTP_FROM?.trim() || 'Laetoli Data <no-reply@laetoli.africa>',
  };

  const sms = {
    apiUrl: (env.SMS_API_URL?.trim() || 'https://messaging-service.co.tz').replace(
      /\/+$/,
      ''
    ),
    apiToken: env.SMS_API_TOKEN?.trim() || undefined,
    defaultSenderId: env.SMS_DEFAULT_SENDER_ID?.trim() || 'LAETOLI',
  };

  const googleOAuth = {
    clientId: env.GOOGLE_CLIENT_ID?.trim() || undefined,
    clientSecret: env.GOOGLE_CLIENT_SECRET?.trim() || undefined,
    redirectUri: env.GOOGLE_REDIRECT_URI?.trim() || undefined,
  };

  return {
    jwtSecret,
    jwtExpiry,
    refreshExpiry,
    resetExpiry,
    emailVerifyExpiry,
    magicLinkExpiry,
    resetDelivery,
    emailDelivery,
    magicLinkDelivery,
    port,
    baseUrl,
    smtp,
    sms,
    googleOAuth,
    oauthAllowedRedirectOriginsRegexp: env.OAUTH_ALLOWED_REDIRECT_ORIGINS_REGEXP?.trim() || undefined,
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
