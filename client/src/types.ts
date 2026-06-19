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

export interface Credentials {
  username: string;
  password: string;
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
