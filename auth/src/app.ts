// Express app factory. The Db and config are injected, so the app can be
// constructed in tests with a fake Db (no Postgres required).

import express, { type Express, type Request, type Response } from 'express';
import type { Db } from './db.js';
import {
  handleSignup,
  handleToken,
  handleAnonymous,
  handleGetUser,
  handleRefresh,
  handleLogout,
  handlePasswordForgot,
  handlePasswordReset,
  handleEmailVerifyRequest,
  handleEmailVerifyConfirm,
  type HandlerDeps,
} from './handlers.js';
import { createRateLimiter, type RateLimiter } from './ratelimit.js';
import { Registry } from './metrics.js';
import type { DeliveryMode } from './config.js';

export interface AppDeps {
  db: Db;
  jwtSecret: string;
  jwtExpiry: number;
  refreshExpiry?: number;
  resetExpiry?: number;
  emailVerifyExpiry?: number;
  resetDelivery?: DeliveryMode;
  emailDelivery?: DeliveryMode;
  /** Optional override; defaults to a sensible auth limiter. */
  limiter?: RateLimiter;
  /** Optional shared metrics registry (defaults to a fresh one). */
  registry?: Registry;
}

function clientKey(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

/** Collapse unknown paths to a stable, low-cardinality metrics label. */
function routeLabel(path: string): string {
  const known = [
    '/health',
    '/metrics',
    '/signup',
    '/token',
    '/anonymous',
    '/user',
    '/refresh',
    '/logout',
    '/password/forgot',
    '/password/reset',
    '/email/verify/request',
    '/email/verify/confirm',
  ];
  return known.includes(path) ? path : 'other';
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.set('trust proxy', true);

  // ---- observability: Prometheus metrics ---------------------------------
  const registry = deps.registry ?? new Registry();
  const httpRequests = registry.counter(
    'http_requests_total',
    'Total HTTP requests by route and status.'
  );
  const httpDuration = registry.histogram(
    'http_request_duration_seconds',
    'HTTP request duration in seconds.'
  );
  // Service-specific gauge: tokens (access JWTs) issued by signup/token/anon.
  const tokensIssued = registry.counter(
    'auth_tokens_issued_total',
    'Access tokens issued (signup/token/anonymous, 2xx responses).'
  );

  // Time + count every request; label by the matched route (low cardinality).
  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const route = (req.route?.path as string) ?? routeLabel(req.path);
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      const labels = { route, status: String(res.statusCode) };
      httpRequests.inc(labels);
      httpDuration.observe(seconds, { route });
      if (
        res.statusCode < 300 &&
        (req.path === '/signup' ||
          req.path === '/token' ||
          req.path === '/anonymous' ||
          req.path === '/refresh')
      ) {
        tokensIssued.inc();
      }
    });
    next();
  });

  app.get('/metrics', (_req, res) => {
    res.setHeader('Content-Type', Registry.contentType);
    res.send(registry.render());
  });

  app.use(express.json({ limit: '16kb' }));

  const handlerDeps: HandlerDeps = {
    db: deps.db,
    jwtSecret: deps.jwtSecret,
    jwtExpiry: deps.jwtExpiry,
    refreshExpiry: deps.refreshExpiry,
    resetExpiry: deps.resetExpiry,
    emailVerifyExpiry: deps.emailVerifyExpiry,
    resetDelivery: deps.resetDelivery,
    emailDelivery: deps.emailDelivery,
  };

  const ua = (req: Request): string | null => req.header('user-agent') ?? null;

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
      send(res, await handleSignup(handlerDeps, req.body ?? {}, ua(req)));
    } catch (e) {
      next(e);
    }
  });

  app.post('/token', async (req, res, next) => {
    if (!guard(req, res)) return;
    try {
      send(res, await handleToken(handlerDeps, req.body ?? {}, ua(req)));
    } catch (e) {
      next(e);
    }
  });

  app.post('/anonymous', async (req, res, next) => {
    if (!guard(req, res)) return;
    try {
      send(res, await handleAnonymous(handlerDeps, ua(req)));
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

  // Swap a refresh token for a fresh access JWT + rotated refresh token.
  app.post('/refresh', async (req, res, next) => {
    if (!guard(req, res)) return;
    try {
      send(res, await handleRefresh(handlerDeps, req.body ?? {}, ua(req)));
    } catch (e) {
      next(e);
    }
  });

  // Revoke the presented refresh token + its rotation family.
  app.post('/logout', async (req, res, next) => {
    if (!guard(req, res)) return;
    try {
      send(res, await handleLogout(handlerDeps, req.body ?? {}));
    } catch (e) {
      next(e);
    }
  });

  // Issue a single-use password-reset token (delivery seam).
  app.post('/password/forgot', async (req, res, next) => {
    if (!guard(req, res)) return;
    try {
      send(res, await handlePasswordForgot(handlerDeps, req.body ?? {}));
    } catch (e) {
      next(e);
    }
  });

  // Consume a reset token → set new password + revoke all refresh tokens.
  app.post('/password/reset', async (req, res, next) => {
    if (!guard(req, res)) return;
    try {
      send(res, await handlePasswordReset(handlerDeps, req.body ?? {}));
    } catch (e) {
      next(e);
    }
  });

  // Issue a single-use email-verification token for the authenticated user.
  app.post('/email/verify/request', async (req, res, next) => {
    if (!guard(req, res)) return;
    try {
      send(
        res,
        await handleEmailVerifyRequest(handlerDeps, req.header('authorization'))
      );
    } catch (e) {
      next(e);
    }
  });

  // Consume an email-verification token → mark the email verified.
  app.post('/email/verify/confirm', async (req, res, next) => {
    if (!guard(req, res)) return;
    try {
      send(res, await handleEmailVerifyConfirm(handlerDeps, req.body ?? {}));
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
