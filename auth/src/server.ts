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
  const app = createApp({
    db,
    jwtSecret: config.jwtSecret,
    jwtExpiry: config.jwtExpiry,
    refreshExpiry: config.refreshExpiry,
    resetExpiry: config.resetExpiry,
    emailVerifyExpiry: config.emailVerifyExpiry,
    resetDelivery: config.resetDelivery,
    emailDelivery: config.emailDelivery,
    baseUrl: config.baseUrl,
    mailer,
    sms,
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
