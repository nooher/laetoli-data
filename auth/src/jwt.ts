// JWT issue/verify — HS256, claims { sub, role: 'authenticated', iat, exp }.
// Pure functions so they are testable without a DB or HTTP layer.

import jwt from 'jsonwebtoken';

export const AUTHENTICATED_ROLE = 'authenticated';

export interface AccessTokenClaims {
  sub: string;
  role: string;
  iat: number;
  exp: number;
}

export interface IssueOptions {
  secret: string;
  expirySeconds: number;
  /** Optional override for "now" (seconds). Defaults to current time. */
  nowSeconds?: number;
}

/**
 * Issue an HS256 access token for a user id (sub).
 * Role is always 'authenticated' (anonymous users are authenticated too —
 * they simply have is_anonymous=true; RLS distinguishes them via the table).
 */
export function issueAccessToken(sub: string, opts: IssueOptions): string {
  const iat = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const exp = iat + opts.expirySeconds;
  const claims: AccessTokenClaims = {
    sub,
    role: AUTHENTICATED_ROLE,
    iat,
    exp,
  };
  // We provide iat/exp explicitly in the payload. `mutatePayload: false` keeps
  // our object intact; we do NOT pass `expiresIn`/`noTimestamp` (which would
  // strip or override our timestamps). jsonwebtoken would normally inject its
  // own `iat`, but since the payload already has one it is preserved as-is.
  return jwt.sign(claims, opts.secret, {
    algorithm: 'HS256',
    mutatePayload: false,
  });
}

/**
 * Verify an HS256 token and return its claims.
 * Throws on bad signature, expiry, or wrong algorithm.
 */
export function verifyAccessToken(token: string, secret: string): AccessTokenClaims {
  const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] });
  if (typeof decoded === 'string' || decoded === null) {
    throw new Error('Invalid token payload');
  }
  const { sub, role, iat, exp } = decoded as Record<string, unknown>;
  if (typeof sub !== 'string' || typeof role !== 'string') {
    throw new Error('Invalid token claims');
  }
  return {
    sub,
    role,
    iat: typeof iat === 'number' ? iat : 0,
    exp: typeof exp === 'number' ? exp : 0,
  };
}

/** Extract a bearer token from an Authorization header value, or null. */
export function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}
