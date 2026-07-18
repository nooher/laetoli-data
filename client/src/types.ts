// Supabase-shaped result envelope used everywhere in this SDK.
export interface PostgrestError {
  message: string;
  details?: string | null;
  hint?: string | null;
  code?: string | null;
}

export interface DataResult<T> {
  data: T | null;
  error: PostgrestError | null;
  /** HTTP status, mirroring supabase-js for callers that read it. */
  status: number;
  statusText: string;
}

/** A signed-in (or anonymous) Laetoli Data user. */
export interface LaetoliUser {
  id: string;
  username?: string | null;
  role?: string | null;
  is_anonymous?: boolean;
  /** Supabase-compat: caller-supplied signup metadata (signUp({options:{data}})). */
  user_metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface Session {
  access_token: string;
  token_type: 'bearer';
  user: LaetoliUser | null;
  expires_at?: number | null;
}

export type AuthChangeEvent =
  | 'SIGNED_IN'
  | 'SIGNED_OUT'
  | 'INITIAL_SESSION'
  | 'USER_UPDATED';

export type AuthStateChangeCallback = (
  event: AuthChangeEvent,
  session: Session | null,
) => void;

export interface AuthResponse {
  data: { user: LaetoliUser | null; session: Session | null };
  error: PostgrestError | null;
}

/**
 * Accepts EITHER laetoli-data's native `{username}` identity or Supabase's
 * real `{email}` shape — a ported app that calls `signUp({email, password})`
 * / `signInWithPassword({email, password})` needs no change. When only an
 * email is given, the client derives a valid username from it deterministically
 * (see `usernameFromEmail` in auth.ts) so the SAME email always maps to the
 * SAME account across signup and every later login.
 */
export type Credentials =
  | { username: string; password: string; email?: never }
  | { email: string; password: string; username?: never };

/** Supabase's real signUp() options shape — `data` becomes `user_metadata`. */
export interface SignUpOptions {
  options?: { data?: Record<string, unknown> };
}

/** Providers laetoli-data's auth service supports for signInWithOAuth(). */
export type OAuthProvider = 'google';

export interface OAuthResponse {
  data: { provider: OAuthProvider; url: string } | null;
  error: PostgrestError | null;
}

export interface OtpResponse {
  data: Record<string, never>;
  error: PostgrestError | null;
}

/** Matches Supabase's `auth.mfa.*` factor summary shape. */
export interface MfaFactor {
  id: string;
  status: 'unverified' | 'verified';
  friendly_name: string | null;
  created_at: string;
}

export interface MfaListFactorsResponse {
  data: { totp: MfaFactor[]; all: MfaFactor[] } | null;
  error: PostgrestError | null;
}

export interface MfaEnrollResponse {
  data: { id: string; type: 'totp'; totp: { qr_code: string; secret: string; uri: string } } | null;
  error: PostgrestError | null;
}

export interface MfaChallengeResponse {
  data: { id: string; expires_at: string } | null;
  error: PostgrestError | null;
}

export interface MfaVerifyResponse {
  data: { id: string; status: 'verified' } | null;
  error: PostgrestError | null;
}

export interface MfaUnenrollResponse {
  data: { id: string } | null;
  error: PostgrestError | null;
}

export interface SessionResponse {
  data: { session: Session | null };
  error: PostgrestError | null;
}

export interface ClientOptions {
  /**
   * Optional anon/public key. Sent as `apikey` header and as the default
   * bearer when no user session exists — mirrors the Supabase anon key.
   */
  apikey?: string;
  /** Override the storage key for the persisted access token. */
  storageKey?: string;
  /** Inject a custom storage (defaults to localStorage, then in-memory). */
  storage?: TokenStorage;
  /** Inject a fetch implementation (defaults to global fetch). */
  fetch?: typeof fetch;
  /** Extra headers added to every request. */
  headers?: Record<string, string>;
}

export interface TokenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
