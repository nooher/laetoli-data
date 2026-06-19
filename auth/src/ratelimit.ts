// Simple in-memory rate limiter (fixed window per key). Good enough for a
// single-node sovereign deployment; swap for Redis if you scale horizontally.

export interface RateLimiter {
  /** Returns true if the request is allowed, false if over the limit. */
  check(key: string): boolean;
}

export function createRateLimiter(opts: {
  windowMs: number;
  max: number;
  now?: () => number;
}): RateLimiter {
  const hits = new Map<string, { count: number; resetAt: number }>();
  const now = opts.now ?? (() => Date.now());

  return {
    check(key: string): boolean {
      const t = now();
      const entry = hits.get(key);
      if (!entry || t >= entry.resetAt) {
        hits.set(key, { count: 1, resetAt: t + opts.windowMs });
        return true;
      }
      if (entry.count >= opts.max) {
        return false;
      }
      entry.count += 1;
      return true;
    },
  };
}
