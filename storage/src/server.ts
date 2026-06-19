// Entry point: load config (fail fast), wire pg-backed Db + fs store, listen.

import { mkdirSync } from 'node:fs';
import { loadConfig } from './config.js';
import { createPgDb } from './db.js';
import { createFsStore } from './store.js';
import { createApp } from './app.js';
import { createPgApiKeyStore } from './apikeyStore.js';

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
    return;
  }

  // Ensure the storage root exists (the volume is mounted here).
  try {
    mkdirSync(config.storageRoot, { recursive: true });
  } catch (e) {
    console.error(
      `[storage] cannot create STORAGE_ROOT (${config.storageRoot}):`,
      e instanceof Error ? e.message : String(e)
    );
    process.exit(1);
    return;
  }

  const db = createPgDb(config);
  const store = createFsStore(config.storageRoot);
  // Only construct the key store when enforcement is enabled (default off).
  const apiKeyStore = config.requireApiKey
    ? createPgApiKeyStore({ databaseUrl: config.databaseUrl, pg: config.pg })
    : undefined;
  const app = createApp({
    db,
    store,
    jwtSecret: config.jwtSecret,
    maxUploadBytes: config.maxUploadBytes,
    requireApiKey: config.requireApiKey,
    apiKeyStore,
  });
  if (config.requireApiKey) {
    console.log('[storage] REQUIRE_API_KEY=true — apikeyGuard enforcing API keys.');
  }

  const server = app.listen(config.port, () => {
    console.log(
      `[storage] Laetoli Data storage service listening on :${config.port} ` +
        `(root ${config.storageRoot}, max upload ${config.maxUploadBytes} bytes)`
    );
  });

  const shutdown = (signal: string) => {
    console.log(`[storage] ${signal} received, shutting down...`);
    server.close(() => {
      db.close().finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
