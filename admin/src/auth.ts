// Admin authentication — a single shared secret (ADMIN_API_KEY), the sovereign
// "service role key". This is NOT user-JWT auth: our auth service only issues
// role:'authenticated' tokens, so the admin surface is gated by one out-of-band
// key that the Admin Studio dashboard holds. Constant-time comparison defeats
// timing attacks that would otherwise leak the key byte-by-byte.

import { timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

/**
 * Constant-time string compare. Always hashes through Buffer.from so the work
 * is independent of where the first differing byte is. Returns false for length
 * mismatch (after doing equal work via a length-normalising compare).
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // timingSafeEqual throws on differing lengths; compare lengths in a way that
  // still performs a fixed comparison so we don't early-return on length alone.
  if (ab.length !== bb.length) {
    // Compare ab against itself to spend comparable time, then fail.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** Pull the presented key from `Authorization: Bearer <key>` or `x-admin-key`. */
export function extractKey(req: Request): string | null {
  const header = req.header('authorization');
  if (header) {
    const m = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (m) return m[1].trim();
  }
  const x = req.header('x-admin-key');
  if (x && x.trim().length > 0) return x.trim();
  return null;
}

/**
 * Express middleware factory. Rejects with 401 unless the request presents the
 * exact admin key (constant-time). Mount this on every route except /health.
 */
export function requireAdminKey(adminApiKey: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const presented = extractKey(req);
    if (presented === null || !constantTimeEqual(presented, adminApiKey)) {
      res.status(401).json({
        error: 'Ufunguo wa admin haukubaliki. (Invalid or missing admin key.)',
      });
      return;
    }
    next();
  };
}
