// apikeyGuard.ts — opt-in API-key enforcement middleware.
//
// This is the SAME file copied into storage/ and functions/ (each is a separate
// npm package, so we duplicate rather than share a module — like metrics.ts).
//
// BEHAVIOUR
//   * Gated by `require` (from env REQUIRE_API_KEY). When false (the DEFAULT)
//     the middleware is a NO-OP: it calls next() immediately and NOTHING here
//     runs — the live stack is completely unaffected.
//   * When true it:
//       - reads the key from the `apikey` header (or `?apikey=` query),
//       - looks up the active (non-revoked) key by sha256(secret) via an
//         injected ApiKeyStore (so tests need no Postgres),
//       - attaches { project_id, role, key_id } to req.apiKey,
//       - enforces rate_limit_per_min with an in-memory sliding window per key,
//       - increments today's usage counter best-effort (fire-and-forget),
//       - 401 on missing/invalid/revoked, 429 when over the per-minute limit.
//
// The DB lookup goes through ApiKeyStore (a tiny interface), so unit tests
// inject a fake store and the production wiring injects a pg-backed one.

import { createHash } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

/** The verified key context attached to the request when enforcement is on. */
export interface ApiKeyContext {
  key_id: string;
  project_id: string;
  role: 'anon' | 'service';
  rate_limit_per_min: number;
}

/** What the store returns for an active key lookup (null if none / revoked). */
export interface ActiveKey {
  key_id: string;
  project_id: string;
  role: 'anon' | 'service';
  rate_limit_per_min: number;
}

/** Injected DB seam — keeps Postgres out of unit tests. */
export interface ApiKeyStore {
  /** Look up an ACTIVE (not revoked) key by the sha256 hex of its secret. */
  findActiveByHash(hash: string): Promise<ActiveKey | null>;
  /** Best-effort: bump today's usage counter for a key. Never throws upward. */
  recordUsage(keyId: string): Promise<void>;
}

export interface GuardOptions {
  /** REQUIRE_API_KEY. When false the guard is a no-op (default behaviour). */
  require: boolean;
  store: ApiKeyStore;
  /** Injectable clock (ms) for deterministic rate-limit tests. */
  now?: () => number;
}

// Augment Express's Request so handlers can read req.apiKey if they wish.
declare module 'express-serve-static-core' {
  interface Request {
    apiKey?: ApiKeyContext;
  }
}

function sha256(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Extract the presented key from the `apikey` header or `?apikey=` query. */
export function extractApiKey(req: Request): string | null {
  const header = req.header('apikey');
  if (header && header.trim().length > 0) return header.trim();
  const q = req.query?.apikey;
  if (typeof q === 'string' && q.trim().length > 0) return q.trim();
  return null;
}

/** Take the secret portion of a "prefix.secret" key (or the whole string). */
function secretOf(presented: string): string {
  const dot = presented.indexOf('.');
  if (dot <= 0 || dot >= presented.length - 1) return presented;
  return presented.slice(dot + 1);
}

/**
 * In-memory sliding-window rate limiter keyed by key_id. Keeps a list of
 * request timestamps within the last 60s; over the limit → false.
 */
function makeRateLimiter(now: () => number) {
  const windows = new Map<string, number[]>();
  const WINDOW_MS = 60_000;
  return function allow(keyId: string, limitPerMin: number): boolean {
    const t = now();
    const cutoff = t - WINDOW_MS;
    const arr = (windows.get(keyId) ?? []).filter((ts) => ts > cutoff);
    if (arr.length >= limitPerMin) {
      windows.set(keyId, arr);
      return false;
    }
    arr.push(t);
    windows.set(keyId, arr);
    return true;
  };
}

/**
 * Build the Express middleware. When `require` is false this returns a no-op
 * that simply calls next() — the live stack is unchanged.
 */
export function apikeyGuard(opts: GuardOptions) {
  if (!opts.require) {
    // NO-OP. The default. Nothing about API keys is consulted.
    return (_req: Request, _res: Response, next: NextFunction): void => next();
  }

  const now = opts.now ?? (() => Date.now());
  const allow = makeRateLimiter(now);

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const presented = extractApiKey(req);
    if (!presented) {
      res.status(401).json({ error: 'Ufunguo wa API unahitajika. (API key required.)' });
      return;
    }

    let active: ActiveKey | null;
    try {
      active = await opts.store.findActiveByHash(sha256(secretOf(presented)));
    } catch {
      // Treat a lookup failure as an auth failure (fail closed when enforcing).
      res.status(401).json({ error: 'Ufunguo wa API haukubaliki. (Invalid API key.)' });
      return;
    }
    if (!active) {
      res.status(401).json({ error: 'Ufunguo wa API haukubaliki au umefutwa. (Invalid or revoked API key.)' });
      return;
    }

    if (!allow(active.key_id, active.rate_limit_per_min)) {
      res.status(429).json({ error: 'Umevuka kikomo cha maombi. (Rate limit exceeded.)' });
      return;
    }

    req.apiKey = {
      key_id: active.key_id,
      project_id: active.project_id,
      role: active.role,
      rate_limit_per_min: active.rate_limit_per_min,
    };

    // Best-effort usage accounting; never block or fail the request on it.
    void opts.store.recordUsage(active.key_id).catch(() => {
      /* swallow — usage is non-critical */
    });

    next();
  };
}
