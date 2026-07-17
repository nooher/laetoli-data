// Entry point: load config (fail fast), wire pg-backed Db, start listening.

import { loadConfig } from './config.js';
import { createPgDb } from './db.js';
import { createApp } from './app.js';
import { createMailer } from './mailer.js';
import { createSmsSender } from './sms.js';

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
    return;
  }

  const db = createPgDb(config);
  // Build the real senders from env. Both degrade gracefully (log + no-op) when
  // unconfigured, so a half-set-up node still serves requests.
  const mailer = createMailer(config);
  const sms = createSmsSender(config);
  // Google OAuth: only wired when ALL three are set — a partial config (e.g.
  // clientId without clientSecret) is treated the same as unset (503 on the
  // route) rather than crashing the whole service at startup.
  const googleOAuth =
    config.googleOAuth.clientId && config.googleOAuth.clientSecret && config.googleOAuth.redirectUri
      ? {
          clientId: config.googleOAuth.clientId,
          clientSecret: config.googleOAuth.clientSecret,
          redirectUri: config.googleOAuth.redirectUri,
        }
      : undefined;
  if (config.googleOAuth.clientId || config.googleOAuth.clientSecret) {
    if (!googleOAuth) {
      console.warn(
        '[auth] GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/GOOGLE_REDIRECT_URI must ALL be set for ' +
          'Google OAuth — partial config detected, /oauth/google/* will 503 until all three are set.'
      );
    }
  }

  const app = createApp({
    db,
    jwtSecret: config.jwtSecret,
    jwtExpiry: config.jwtExpiry,
    refreshExpiry: config.refreshExpiry,
    resetExpiry: config.resetExpiry,
    emailVerifyExpiry: config.emailVerifyExpiry,
    resetDelivery: config.resetDelivery,
    emailDelivery: config.emailDelivery,
    magicLinkExpiry: config.magicLinkExpiry,
    magicLinkDelivery: config.magicLinkDelivery,
    baseUrl: config.baseUrl,
    mailer,
    sms,
    googleOAuth,
    oauthAllowedRedirectOriginsRegexp: config.oauthAllowedRedirectOriginsRegexp,
  });

  const server = app.listen(config.port, () => {
    console.log(
      `[auth] Laetoli Data auth service listening on :${config.port} ` +
        `(JWT exp ${config.jwtExpiry}s)`
    );
  });

  const shutdown = (signal: string) => {
    console.log(`[auth] ${signal} received, shutting down...`);
    server.close(() => {
      db.close().finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
