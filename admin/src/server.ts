// Entry point: load config (fail fast — refuses to start without ADMIN_API_KEY),
// wire the pg-backed Db (connects AS a BYPASSRLS role), start listening on :9996.

import { loadConfig } from './config.js';
import { createPgDb } from './db.js';
import { createApp } from './app.js';

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
  const app = createApp({ db, adminApiKey: config.adminApiKey });

  const server = app.listen(config.port, () => {
    console.log(
      `[admin] Laetoli Data admin API listening on :${config.port} ` +
        `(BYPASSRLS — keys-to-the-kingdom; gated by ADMIN_API_KEY)`
    );
  });

  const shutdown = (signal: string) => {
    console.log(`[admin] ${signal} received, shutting down...`);
    server.close(() => {
      db.close().finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
