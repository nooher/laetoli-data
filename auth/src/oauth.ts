// Google OAuth (authorization code flow) — the pure/testable pieces: building
// the redirect URL, signing/verifying the CSRF `state` parameter, and
// decoding Google's id_token. Network calls (the actual code→token exchange)
// live in handlers.ts, injectable like every other I/O in this service.
//
// Matches Supabase's own `signInWithOAuth({provider:'google'})` UX: the
// browser is redirected to Google, then back to this service, then on to the
// app with `#access_token=...&refresh_token=...` in the URL fragment — a
// client already built against Supabase's flow needs no changes beyond
// pointing at this service's /oauth/google/start URL instead.

import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes — plenty for a consent-screen round trip

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/** Build the URL to send the browser to Google's consent screen. */
export function buildGoogleAuthUrl(config: GoogleOAuthConfig, state: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account',
  });
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
}

/**
 * The `state` parameter is a stateless, HMAC-signed value — no DB round trip
 * needed to validate it on callback (unlike a DB-backed CSRF token table).
 * Encodes `redirect_to` + a nonce + an expiry, base64url(json) . hmac.
 */
export function signState(
  payload: { redirectTo: string },
  jwtSecret: string,
  nowMs: number = Date.now()
): string {
  const body = JSON.stringify({
    redirectTo: payload.redirectTo,
    nonce: randomBytes(12).toString('base64url'),
    exp: nowMs + STATE_TTL_MS,
  });
  const bodyB64 = Buffer.from(body, 'utf8').toString('base64url');
  const sig = createHmac('sha256', jwtSecret).update(bodyB64).digest('base64url');
  return `${bodyB64}.${sig}`;
}

/** Verify a state value's signature + expiry; returns the redirectTo, or null if invalid/expired. */
export function verifyState(
  state: string,
  jwtSecret: string,
  nowMs: number = Date.now()
): { redirectTo: string } | null {
  const parts = state.split('.');
  if (parts.length !== 2) return null;
  const [bodyB64, sig] = parts;

  const expectedSig = createHmac('sha256', jwtSecret).update(bodyB64).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expectedSig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let parsed: { redirectTo?: unknown; exp?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(bodyB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof parsed.redirectTo !== 'string' || typeof parsed.exp !== 'number') return null;
  if (parsed.exp < nowMs) return null;

  return { redirectTo: parsed.redirectTo };
}

/** The claims we actually use out of Google's id_token — everything else is ignored. */
export interface GoogleIdTokenClaims {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
}

/**
 * Decode (NOT verify the signature of) a Google id_token JWT payload.
 * Deliberately safe without signature verification here: the token was
 * obtained via a direct, client-secret-authenticated server-to-server POST
 * to Google's own token endpoint (see exchangeCode in handlers.ts) — not
 * received from the browser, which is the scenario signature verification
 * actually protects against.
 */
export function decodeGoogleIdToken(idToken: string): GoogleIdTokenClaims | null {
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (typeof payload.sub !== 'string') return null;
    return {
      sub: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      email_verified: payload.email_verified === true,
      name: typeof payload.name === 'string' ? payload.name : undefined,
    };
  } catch {
    return null;
  }
}

export { GOOGLE_TOKEN_ENDPOINT };

/** Does `origin` match the operator's allow-list regexp? False-closed (no regexp configured → nothing matches). */
export function isAllowedRedirect(url: string, allowedOriginsRegexp: string | undefined): boolean {
  if (!allowedOriginsRegexp) return false;
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return false;
  }
  try {
    return new RegExp(allowedOriginsRegexp).test(origin);
  } catch {
    return false; // a malformed operator-configured regexp fails closed, not open
  }
}
