// Optional JWT context — verify HS256 with the shared JWT_SECRET, same as the
// auth service. Pure functions so they are testable without HTTP.

import jwt from 'jsonwebtoken';

/** Minimal user context handed to a function (`ctx.user`). */
export interface FunctionUser {
  sub: string;
  role: string;
}

/** Extract a bearer token from an Authorization header value, or null. */
export function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/**
 * Verify a bearer token and return `{ sub, role }`, or null if there is no
 * token, no configured secret, or the token is invalid/expired. Never throws —
 * auth is optional, so a bad token simply means an anonymous caller.
 */
export function userFromAuthHeader(
  header: string | undefined,
  secret: string | undefined
): FunctionUser | null {
  if (!secret) return null;
  const token = parseBearer(header);
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] });
    if (typeof decoded === 'string' || decoded === null) return null;
    const { sub, role } = decoded as Record<string, unknown>;
    if (typeof sub !== 'string') return null;
    return { sub, role: typeof role === 'string' ? role : 'authenticated' };
  } catch {
    return null;
  }
}
