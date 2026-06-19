// Entry point: load config (fail fast), wire the function loader, start listening.

import { loadConfig } from './config.js';
import { FunctionLoader } from './loader.js';
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

  if (!config.jwtSecret) {
    console.warn(
      '[functions] JWT_SECRET not set — ctx.user will always be null ' +
        '(functions run unauthenticated). Set JWT_SECRET to enable bearer context.'
    );
  }

  const loader = new FunctionLoader({ root: config.functionsRoot });
  const app = createApp({
    loader,
    jwtSecret: config.jwtSecret,
    timeoutMs: config.timeoutMs,
    bodyLimit: config.bodyLimit,
    production: config.production,
  });

  const server = app.listen(config.port, () => {
    const fns = loader.names();
    console.log(
      `[functions] Laetoli Data functions runner listening on :${config.port} ` +
        `(root ${config.functionsRoot}, timeout ${config.timeoutMs}ms, ${fns.length} function(s): ${fns.join(', ') || 'none'})`
    );
  });

  const shutdown = (signal: string) => {
    console.log(`[functions] ${signal} received, shutting down...`);
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
