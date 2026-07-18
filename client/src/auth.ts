import type {
  AuthResponse,
  AuthStateChangeCallback,
  Credentials,
  LaetoliUser,
  MfaChallengeResponse,
  MfaEnrollResponse,
  MfaListFactorsResponse,
  MfaUnenrollResponse,
  MfaVerifyResponse,
  OAuthProvider,
  OAuthResponse,
  OtpResponse,
  PostgrestError,
  Session,
  SessionResponse,
  SignUpOptions,
  TokenStorage,
} from './types';

interface AuthCtx {
  authUrl: string; // e.g. https://host/auth
  fetch: typeof fetch;
  storage: TokenStorage;
  storageKey: string;
  baseHeaders: () => Record<string, string>;
}

/**
 * Lean auth client targeting the sovereign auth service (`/auth/*`).
 * Mirrors the supabase-js `auth` subset our apps call.
 */
export class AuthClient {
  private listeners = new Set<AuthStateChangeCallback>();
  private currentToken: string | null;
  /** `auth.mfa.*` — matches Supabase's nested TOTP-enrollment client shape. */
  readonly mfa: MfaClient;

  constructor(private readonly ctx: AuthCtx) {
    this.currentToken = ctx.storage.getItem(ctx.storageKey);
    this.detectSessionInUrl();
    this.mfa = new MfaClient(ctx, () => this.currentToken);
  }

  /**
   * Redirect the browser to sign in via an external provider — matches
   * supabase-js's signInWithOAuth({provider}) shape/behavior closely enough
   * that a client already built against it needs minimal changes: build the
   * provider's start URL and (unless `skipBrowserRedirect`) navigate there.
   * After the provider + auth-service round trip, the browser lands back on
   * `options.redirectTo` (default: the current page) with
   * `#access_token=...&refresh_token=...` in the URL — picked up
   * automatically by `detectSessionInUrl()` on the next page load.
   */
  signInWithOAuth(input: {
    provider: OAuthProvider;
    options?: { redirectTo?: string; skipBrowserRedirect?: boolean };
  }): OAuthResponse {
    const redirectTo =
      input.options?.redirectTo ??
      (typeof window !== 'undefined' ? window.location.href : undefined);
    if (!redirectTo) {
      return {
        data: null,
        error: { message: 'redirectTo is required outside a browser context.', code: 'no_redirect_to' },
      };
    }
    const url = `${this.ctx.authUrl}/oauth/${input.provider}/start?redirect_to=${encodeURIComponent(redirectTo)}`;
    if (!input.options?.skipBrowserRedirect && typeof window !== 'undefined') {
      window.location.assign(url);
    }
    return { data: { provider: input.provider, url }, error: null };
  }

  /**
   * Passwordless email sign-in: emails a single-use "magic link". Clicking it
   * lands the browser on `options.emailRedirectTo` (default: the current
   * page) with `#access_token=...` in the URL — picked up automatically by
   * `detectSessionInUrl()`, same as the OAuth callback. Matches
   * supabase-js's `signInWithOtp({ email })` shape/behavior.
   */
  async signInWithOtp(input: {
    email: string;
    options?: { emailRedirectTo?: string };
  }): Promise<OtpResponse> {
    const redirectTo =
      input.options?.emailRedirectTo ??
      (typeof window !== 'undefined' ? window.location.href : undefined);
    let res: Response;
    try {
      res = await this.ctx.fetch(`${this.ctx.authUrl}/magiclink`, {
        method: 'POST',
        headers: { ...this.ctx.baseHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: input.email, redirect_to: redirectTo }),
      });
    } catch (e) {
      return { data: {}, error: { message: msg(e), code: 'fetch_error' } };
    }
    const parsed = await safeJson(res);
    if (!res.ok) {
      return { data: {}, error: toErr(parsed, res) };
    }
    return { data: {}, error: null };
  }

  /** The persisted access token, if signed in. Used by the REST layer. */
  get token(): string | null {
    return this.currentToken;
  }

  /**
   * Accepts EITHER `{username, password}` (native) or Supabase's real
   * `{email, password, options: {data}}` shape — a ported app's signUp()
   * call needs no change. `options.data` becomes `user_metadata`, readable
   * back via `getUser()`/`getSession()` and by a ported `handle_new_user()`-
   * style Postgres trigger reading `auth.users.raw_user_meta_data`.
   */
  async signUp(creds: Credentials & SignUpOptions): Promise<AuthResponse> {
    const { username, email } = resolveIdentity(creds);
    return this.post(
      '/signup',
      { username, password: creds.password, email, metadata: creds.options?.data },
      'SIGNED_IN',
    );
  }

  /** Accepts EITHER `{username, password}` or `{email, password}` — see signUp(). */
  async signInWithPassword(creds: Credentials): Promise<AuthResponse> {
    const { username } = resolveIdentity(creds);
    return this.post('/token', { username, password: creds.password }, 'SIGNED_IN');
  }

  async signInAnonymously(): Promise<AuthResponse> {
    return this.post('/anonymous', {}, 'SIGNED_IN');
  }

  /**
   * Returns the current session from local state — no network call, matching
   * supabase-js's getSession() (which reads its local storage first too).
   */
  async getSession(): Promise<SessionResponse> {
    return { data: { session: this.sessionFromToken(this.currentToken) }, error: null };
  }

  /** Fetch the current user from the auth service using the stored token. */
  async getUser(): Promise<{ data: { user: LaetoliUser | null }; error: PostgrestError | null }> {
    if (!this.currentToken) {
      return { data: { user: null }, error: null };
    }
    let res: Response;
    try {
      res = await this.ctx.fetch(`${this.ctx.authUrl}/user`, {
        method: 'GET',
        headers: {
          ...this.ctx.baseHeaders(),
          Authorization: `Bearer ${this.currentToken}`,
        },
      });
    } catch (e) {
      return { data: { user: null }, error: { message: msg(e), code: 'fetch_error' } };
    }
    const parsed = await safeJson(res);
    if (!res.ok) {
      return { data: { user: null }, error: toErr(parsed, res) };
    }
    const user = extractUser(parsed);
    return { data: { user }, error: null };
  }

  async signOut(): Promise<{ error: PostgrestError | null }> {
    const token = this.currentToken;
    this.setSession(null, 'SIGNED_OUT');
    if (token) {
      // Best-effort server-side revoke; never blocks local sign-out.
      try {
        await this.ctx.fetch(`${this.ctx.authUrl}/logout`, {
          method: 'POST',
          headers: {
            ...this.ctx.baseHeaders(),
            Authorization: `Bearer ${token}`,
          },
        });
      } catch {
        /* ignore — local session already cleared */
      }
    }
    return { error: null };
  }

  /**
   * Subscribe to sign-in / sign-out events. Returns an unsubscribe handle
   * shaped like supabase-js: `{ data: { subscription: { unsubscribe } } }`.
   */
  onAuthStateChange(cb: AuthStateChangeCallback): {
    data: { subscription: { unsubscribe: () => void } };
  } {
    this.listeners.add(cb);
    // Emit the initial state asynchronously, like supabase-js.
    Promise.resolve().then(() => {
      cb('INITIAL_SESSION', this.sessionFromToken(this.currentToken));
    });
    return {
      data: {
        subscription: {
          unsubscribe: () => void this.listeners.delete(cb),
        },
      },
    };
  }

  // ---- internals ---------------------------------------------------------

  /**
   * On construction, check window.location.hash for `access_token=...`
   * (what the OAuth callback redirect leaves behind) and, if present, adopt
   * it as the session and strip it from the visible URL. Matches
   * supabase-js's default `detectSessionInUrl: true` behavior. A no-op
   * outside a browser (SSR, Node, tests without a `window`).
   */
  private detectSessionInUrl(): void {
    if (typeof window === 'undefined' || !window.location?.hash) return;
    const hash = window.location.hash.startsWith('#')
      ? window.location.hash.slice(1)
      : window.location.hash;
    const params = new URLSearchParams(hash);
    const token = params.get('access_token');
    if (!token) return;

    this.setSession(token, 'SIGNED_IN');

    // Clean the fragment off the visible URL, same as supabase-js.
    if (typeof window.history?.replaceState === 'function') {
      const clean = window.location.pathname + window.location.search;
      window.history.replaceState(null, '', clean);
    }
  }

  private async post(
    path: string,
    body: unknown,
    event: 'SIGNED_IN',
  ): Promise<AuthResponse> {
    let res: Response;
    try {
      res = await this.ctx.fetch(`${this.ctx.authUrl}${path}`, {
        method: 'POST',
        headers: { ...this.ctx.baseHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      return { data: { user: null, session: null }, error: { message: msg(e), code: 'fetch_error' } };
    }
    const parsed = await safeJson(res);
    if (!res.ok) {
      return { data: { user: null, session: null }, error: toErr(parsed, res) };
    }
    const token = extractToken(parsed);
    const user = extractUser(parsed);
    if (token) this.setSession(token, event);
    const session = token ? this.sessionFromToken(token, user) : null;
    return { data: { user, session }, error: null };
  }

  private setSession(token: string | null, event: 'SIGNED_IN' | 'SIGNED_OUT'): void {
    this.currentToken = token;
    if (token) this.ctx.storage.setItem(this.ctx.storageKey, token);
    else this.ctx.storage.removeItem(this.ctx.storageKey);
    const session = this.sessionFromToken(token);
    for (const cb of this.listeners) {
      try {
        cb(event, session);
      } catch {
        /* listener errors must not break auth */
      }
    }
  }

  private sessionFromToken(token: string | null, user?: LaetoliUser | null): Session | null {
    if (!token) return null;
    const claims = decodeJwt(token);
    const resolvedUser: LaetoliUser | null =
      user ??
      (claims
        ? {
            id: String(claims.sub ?? ''),
            role: (claims.role as string) ?? null,
            is_anonymous: claims.role === 'anon' || claims.is_anonymous === true,
          }
        : null);
    return {
      access_token: token,
      token_type: 'bearer',
      user: resolvedUser,
      expires_at: typeof claims?.exp === 'number' ? claims.exp : null,
    };
  }
}

// ---- helpers -------------------------------------------------------------

function extractToken(parsed: unknown): string | null {
  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    const t = o.access_token ?? o.token ?? o.accessToken;
    if (typeof t === 'string') return t;
  }
  return null;
}

function extractUser(parsed: unknown): LaetoliUser | null {
  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    if (o.user && typeof o.user === 'object') return o.user as LaetoliUser;
    if (typeof o.id === 'string') return o as unknown as LaetoliUser;
  }
  return null;
}

/** Decode a JWT payload without verifying (verification happens server-side). */
function decodeJwt(token: string): Record<string, unknown> | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const json =
      typeof atob === 'function'
        ? atob(b64)
        : Buffer.from(b64, 'base64').toString('binary');
    // Handle UTF-8 payloads.
    const decoded = decodeURIComponent(
      Array.prototype.map
        .call(json, (c: string) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join(''),
    );
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function safeJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function toErr(parsed: unknown, res: Response): PostgrestError {
  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    const m = o.message ?? o.error ?? o.msg;
    return {
      message: typeof m === 'string' ? m : res.statusText || 'Auth request failed',
      code: (o.code as string) ?? String(res.status),
    };
  }
  return {
    message: typeof parsed === 'string' && parsed ? parsed : res.statusText || 'Auth request failed',
    code: String(res.status),
  };
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Resolve a `Credentials` union into the wire `{username, email?}` laetoli-data expects. */
function resolveIdentity(creds: Credentials): { username: string; email?: string } {
  if ('email' in creds && creds.email) {
    return { username: usernameFromEmail(creds.email), email: creds.email };
  }
  return { username: (creds as { username: string }).username };
}

/**
 * Deterministically derives a valid laetoli-data username from an email —
 * the SAME email always maps to the SAME username, so signup and every
 * later login (both going through this function) resolve to the same
 * account. laetoli-data's server-side rule: 3-32 chars, starts with a
 * letter/digit, only [a-zA-Z0-9._-] after that.
 */
function usernameFromEmail(email: string): string {
  let u = email.trim().toLowerCase().replace(/[^a-z0-9._-]/g, '_');
  if (!/^[a-z0-9]/.test(u)) u = `u${u}`;
  if (u.length < 3) u = u.padEnd(3, '0');
  if (u.length > 32) u = u.slice(0, 32);
  return u;
}

/**
 * `auth.mfa.*` — self-service TOTP enrollment, matching Supabase's nested
 * client shape (`supabase.auth.mfa.enroll()` etc). Thin wrapper over the
 * auth service's `/factors*` REST endpoints (see docs/MFA.md). Enrollment
 * and management only — no login-time step-up, same scope as the server.
 */
class MfaClient {
  constructor(
    private readonly ctx: AuthCtx,
    private readonly token: () => string | null,
  ) {}

  private authHeaders(): Record<string, string> {
    const t = this.token();
    return { ...this.ctx.baseHeaders(), ...(t ? { Authorization: `Bearer ${t}` } : {}) };
  }

  async enroll(input: { friendlyName?: string } = {}): Promise<MfaEnrollResponse> {
    return this.request('POST', '/factors', { friendly_name: input.friendlyName });
  }

  async listFactors(): Promise<MfaListFactorsResponse> {
    return this.request('GET', '/factors');
  }

  async challenge(input: { factorId: string }): Promise<MfaChallengeResponse> {
    return this.request('POST', `/factors/${encodeURIComponent(input.factorId)}/challenge`);
  }

  async verify(input: { factorId: string; challengeId: string; code: string }): Promise<MfaVerifyResponse> {
    return this.request('POST', `/factors/${encodeURIComponent(input.factorId)}/verify`, {
      challenge_id: input.challengeId,
      code: input.code,
    });
  }

  async unenroll(input: { factorId: string }): Promise<MfaUnenrollResponse> {
    return this.request('DELETE', `/factors/${encodeURIComponent(input.factorId)}`);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ data: T | null; error: PostgrestError | null }> {
    let res: Response;
    try {
      res = await this.ctx.fetch(`${this.ctx.authUrl}${path}`, {
        method,
        headers: {
          ...this.authHeaders(),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      return { data: null, error: { message: msg(e), code: 'fetch_error' } };
    }
    const parsed = await safeJson(res);
    if (!res.ok) return { data: null, error: toErr(parsed, res) };
    return { data: parsed as T, error: null };
  }
}
