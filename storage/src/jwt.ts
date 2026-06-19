// JWT verify + signed-URL HMAC tokens.
// Bearer verification mirrors auth/src/jwt.ts (HS256, claims { sub, role }).
// Signed URLs use the SAME JWT_SECRET to HMAC a compact token embedding the
// bucket/path/exp, so private files can be shared via time-limited links
// without a bearer.

import jwt from 'jsonwebtoken';

export const AUTHENTICATED_ROLE = 'authenticated';

export interface AccessTokenClaims {
  sub: string;
  role: string;
  iat: number;
  exp: number;
}

/**
 * Verify an HS256 bearer token and return its claims.
 * Throws on bad signature, expiry, or wrong algorithm.
 */
export function verifyAccessToken(
  token: string,
  secret: string
): AccessTokenClaims {
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

// ---- signed URLs ----------------------------------------------------------

export interface SignedUrlClaims {
  /** Marks the token as a storage signed-url grant (not an access token). */
  scope: 'storage-signed';
  bucket: string;
  path: string;
  iat: number;
  exp: number;
}

export interface SignOptions {
  secret: string;
  expiresInSeconds: number;
  nowSeconds?: number;
}

/**
 * Issue an HS256 signed-URL token for a single object. Time-limited; bound to a
 * specific bucket + path so it cannot be replayed against another object.
 */
export function issueSignedToken(
  bucket: string,
  path: string,
  opts: SignOptions
): string {
  const iat = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
  const exp = iat + opts.expiresInSeconds;
  const claims: SignedUrlClaims = {
    scope: 'storage-signed',
    bucket,
    path,
    iat,
    exp,
  };
  return jwt.sign(claims, opts.secret, {
    algorithm: 'HS256',
    mutatePayload: false,
  });
}

/**
 * Verify a signed-URL token AND confirm it was issued for the given object.
 * Throws on bad signature, expiry, wrong scope, or bucket/path mismatch.
 */
export function verifySignedToken(
  token: string,
  secret: string,
  expect: { bucket: string; path: string }
): SignedUrlClaims {
  const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] });
  if (typeof decoded === 'string' || decoded === null) {
    throw new Error('Invalid signed token');
  }
  const o = decoded as Record<string, unknown>;
  if (o.scope !== 'storage-signed') {
    throw new Error('Wrong token scope');
  }
  if (o.bucket !== expect.bucket || o.path !== expect.path) {
    throw new Error('Signed token does not match this object');
  }
  return {
    scope: 'storage-signed',
    bucket: String(o.bucket),
    path: String(o.path),
    iat: typeof o.iat === 'number' ? o.iat : 0,
    exp: typeof o.exp === 'number' ? o.exp : 0,
  };
}
