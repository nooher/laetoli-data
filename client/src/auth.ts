import type {
  AuthResponse,
  AuthStateChangeCallback,
  Credentials,
  LaetoliUser,
  PostgrestError,
  Session,
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

  constructor(private readonly ctx: AuthCtx) {
    this.currentToken = ctx.storage.getItem(ctx.storageKey);
  }

  /** The persisted access token, if signed in. Used by the REST layer. */
  get token(): string | null {
    return this.currentToken;
  }

  async signUp(creds: Credentials): Promise<AuthResponse> {
    return this.post('/signup', creds, 'SIGNED_IN');
  }

  async signInWithPassword(creds: Credentials): Promise<AuthResponse> {
    return this.post('/token', creds, 'SIGNED_IN');
  }

  async signInAnonymously(): Promise<AuthResponse> {
    return this.post('/anonymous', {}, 'SIGNED_IN');
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
