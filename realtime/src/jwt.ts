// JWT verification — HS256, shared JWT_SECRET with the auth service.
// WS clients present a Bearer JWT (claims { sub, role, exp }); we only verify,
// never issue. Pure functions so they are testable without a socket or DB.

import jwt from 'jsonwebtoken';

export interface AccessTokenClaims {
  sub: string;
  role: string;
  iat: number;
  exp: number;
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
