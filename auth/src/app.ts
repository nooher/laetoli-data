// Express app factory. The Db and config are injected, so the app can be
// constructed in tests with a fake Db (no Postgres required).

import express, { type Express, type Request, type Response } from 'express';
import type { Db } from './db.js';
import {
  handleSignup,
  handleToken,
  handleAnonymous,
  handleGetUser,
  type HandlerDeps,
} from './handlers.js';
import { createRateLimiter, type RateLimiter } from './ratelimit.js';

export interface AppDeps {
  db: Db;
  jwtSecret: string;
  jwtExpiry: number;
  /** Optional override; defaults to a sensible auth limiter. */
  limiter?: RateLimiter;
}

function clientKey(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '16kb' }));

  const handlerDeps: HandlerDeps = {
    db: deps.db,
    jwtSecret: deps.jwtSecret,
    jwtExpiry: deps.jwtExpiry,
  };

  // 30 auth attempts / minute / IP — protects signup/token/anonymous.
  const limiter =
    deps.limiter ?? createRateLimiter({ windowMs: 60_000, max: 30 });

  const guard = (req: Request, res: Response): boolean => {
    if (!limiter.check(clientKey(req))) {
      res
        .status(429)
        .json({ error: 'Maombi mengi mno. Tafadhali jaribu tena baadaye.' });
      return false;
    }
    return true;
  };

  const send = (res: Response, r: { status: number; body: unknown }) =>
    res.status(r.status).json(r.body);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'laetoli-auth' });
  });

  app.post('/signup', async (req, res, next) => {
    if (!guard(req, res)) return;
    try {
      send(res, await handleSignup(handlerDeps, req.body ?? {}));
    } catch (e) {
      next(e);
    }
  });

  app.post('/token', async (req, res, next) => {
    if (!guard(req, res)) return;
    try {
      send(res, await handleToken(handlerDeps, req.body ?? {}));
    } catch (e) {
      next(e);
    }
  });

  app.post('/anonymous', async (req, res, next) => {
    if (!guard(req, res)) return;
    try {
      send(res, await handleAnonymous(handlerDeps));
    } catch (e) {
      next(e);
    }
  });

  app.get('/user', async (req, res, next) => {
    try {
      send(res, await handleGetUser(handlerDeps, req.header('authorization')));
    } catch (e) {
      next(e);
    }
  });

  // JSON 404 + error handler (never leak internals).
  app.use((_req, res) => {
    res.status(404).json({ error: 'Njia haipatikani.' });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use(
    (
      e: unknown,
      _req: Request,
      res: Response,
      _next: express.NextFunction
    ) => {
      // Bad JSON body etc.
      if (e && typeof e === 'object' && 'type' in e && (e as { type?: string }).type === 'entity.parse.failed') {
        res.status(400).json({ error: 'Mwili wa ombi si JSON sahihi.' });
        return;
      }
      console.error('[auth] unhandled error:', e);
      res.status(500).json({ error: 'Hitilafu ya seva.' });
    }
  );

  return app;
}
