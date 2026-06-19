// Express app factory. The loader + config are injected, so the app can be
// constructed in tests with temp function files and a fake importer (no real
// FUNCTIONS_ROOT required).

import express, { type Express, type Request, type Response } from 'express';
import { FunctionLoader, FunctionNotFoundError, InvalidFunctionError } from './loader.js';
import { runHandler, FunctionTimeoutError } from './runner.js';
import { userFromAuthHeader } from './jwt.js';
import { apikeyGuard, type ApiKeyStore } from './apikeyGuard.js';

export interface AppDeps {
  loader: FunctionLoader;
  /** Shared HS256 secret for optional ctx.user. Undefined = auth disabled. */
  jwtSecret?: string;
  /** Per-invocation timeout (ms). */
  timeoutMs: number;
  /** Max JSON body size for express.json(). */
  bodyLimit?: string;
  /** Hide error detail from clients (production). */
  production?: boolean;
  /** env bag exposed to functions as ctx.env (defaults to process.env). */
  env?: Record<string, string | undefined>;
  /**
   * Opt-in API-key enforcement. When false/undefined (the default) the guard is
   * a NO-OP and all existing flows are unchanged. When true, an `apiKeyStore`
   * MUST be provided and every invocation needs a valid `apikey`.
   */
  requireApiKey?: boolean;
  /** DB-backed (or fake) store used by the guard when requireApiKey is true. */
  apiKeyStore?: ApiKeyStore;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.set('trust proxy', true);
  // Cap the request body. JSON bodies are parsed to objects; any other
  // content type is captured as raw text. (express.json only consumes when the
  // content-type is JSON, so the text parser handles the remainder.)
  const limit = deps.bodyLimit ?? '1mb';
  app.use(express.json({ limit }));
  app.use(express.text({ type: '*/*', limit }));

  const env = deps.env ?? process.env;

  // --- meta routes --------------------------------------------------------

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'laetoli-functions', functions: deps.loader.names() });
  });

  app.get('/', (_req, res) => {
    res.json({ service: 'laetoli-functions', functions: deps.loader.names() });
  });

  // Optional admin: clear the module cache so edited functions reload.
  app.post('/_reload', (req, res) => {
    const name = typeof req.query.name === 'string' ? req.query.name : undefined;
    deps.loader.clear(name);
    res.json({ ok: true, reloaded: name ?? 'all' });
  });

  // --- opt-in API-key enforcement (multi-tenant) --------------------------
  // No-op unless requireApiKey is true (then apiKeyStore must be provided).
  // Mounted AFTER the meta routes (/health, /, /_reload) so they stay open.
  if (deps.requireApiKey) {
    if (!deps.apiKeyStore) {
      throw new Error(
        'FATAL: REQUIRE_API_KEY=true lakini apiKeyStore haijatolewa. ' +
          '(requireApiKey is on but no apiKeyStore was provided.)'
      );
    }
    app.use(apikeyGuard({ require: true, store: deps.apiKeyStore }));
  }

  // --- dispatch -----------------------------------------------------------

  const dispatch = async (req: Request, res: Response): Promise<void> => {
    const name = req.params.name;

    // `?reload=1` busts the cache for this function before invoking.
    if (req.query.reload === '1') deps.loader.clear(name);

    let loaded;
    try {
      loaded = await deps.loader.load(name);
    } catch (e) {
      if (e instanceof FunctionNotFoundError) {
        res.status(404).json({ error: `Function not found: ${name}` });
        return;
      }
      if (e instanceof InvalidFunctionError) {
        console.error('[functions] load error:', e.message);
        res.status(500).json({ error: deps.production ? 'Function failed to load.' : e.message });
        return;
      }
      throw e;
    }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers[k] = v;
      else if (Array.isArray(v)) headers[k] = v.join(', ');
    }

    // The trailing path after `/:name` (Express puts it in params[0] for `/*`).
    const rest = (req.params as Record<string, string>)[0];
    const path = rest ? `/${rest}` : '';

    const ctx = {
      method: req.method,
      headers,
      query: req.query as Record<string, string | string[]>,
      body: req.body,
      env,
      user: userFromAuthHeader(req.header('authorization'), deps.jwtSecret),
      path,
    };

    try {
      const outcome = await runHandler(loaded.handler, ctx, { timeoutMs: deps.timeoutMs });
      for (const [k, v] of Object.entries(outcome.headers)) res.setHeader(k, v);
      if (outcome.status === 204 || outcome.body === undefined) {
        res.status(outcome.status).end();
        return;
      }
      // Send objects/arrays as JSON; strings/buffers as-is.
      if (typeof outcome.body === 'string' || Buffer.isBuffer(outcome.body)) {
        res.status(outcome.status).send(outcome.body);
      } else {
        res.status(outcome.status).json(outcome.body);
      }
    } catch (e) {
      if (e instanceof FunctionTimeoutError) {
        console.error(`[functions] ${name} timed out after ${deps.timeoutMs}ms`);
        res.status(504).json({ error: 'Function timed out.' });
        return;
      }
      console.error(`[functions] ${name} threw:`, e);
      res.status(500).json({
        error: deps.production
          ? 'Function error.'
          : e instanceof Error
            ? e.message
            : String(e),
      });
    }
  };

  // ALL /:name and ALL /:name/* → invoke that function.
  app.all('/:name', (req, res, next) => {
    dispatch(req, res).catch(next);
  });
  app.all('/:name/*', (req, res, next) => {
    dispatch(req, res).catch(next);
  });

  // JSON 404 + error handler (never leak internals in production).
  app.use((_req, res) => {
    res.status(404).json({ error: 'Njia haipatikani.' });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use(
    (e: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
      if (
        e &&
        typeof e === 'object' &&
        'type' in e &&
        (e as { type?: string }).type === 'entity.too.large'
      ) {
        res.status(413).json({ error: 'Mwili wa ombi ni mkubwa mno.' });
        return;
      }
      console.error('[functions] unhandled error:', e);
      res.status(500).json({ error: 'Hitilafu ya seva.' });
    }
  );

  return app;
}
