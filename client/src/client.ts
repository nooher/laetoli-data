import { AuthClient } from './auth';
import { QueryBuilder } from './query';
import { DEFAULT_STORAGE_KEY, resolveStorage } from './storage';
import { StorageClient } from './objectstore';
import { RealtimeClient, type RealtimeChannel } from './realtime';
import { FunctionsClient } from './functions';
import type { ClientOptions } from './types';

/**
 * The Laetoli Data client — a near drop-in for the supabase-js subset our
 * apps use. Routes `.from()` to PostgREST (`/rest`) and `.auth` to the
 * sovereign auth service (`/auth`) behind a single Caddy endpoint.
 */
export class LaetoliDataClient {
  readonly auth: AuthClient;
  /** Object storage (buckets + files) — `.storage.from(bucket).upload(...)`. */
  readonly storage: StorageClient;
  /** Realtime — `.realtime.channel(table)` or the `.channel(table)` shortcut. */
  readonly realtime: RealtimeClient;
  /** Edge functions — `.functions.invoke(name, { body })`. */
  readonly functions: FunctionsClient;
  private readonly restUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly apikey?: string;
  private readonly extraHeaders: Record<string, string>;

  constructor(url: string, opts: ClientOptions = {}) {
    const base = stripTrailingSlash(url);
    this.restUrl = `${base}/rest`;
    this.apikey = opts.apikey;
    this.extraHeaders = opts.headers ?? {};

    const f = opts.fetch ?? globalThis.fetch;
    if (!f) {
      throw new Error(
        '@laetoli/data: no global fetch available — pass opts.fetch (Node < 18 / non-standard runtime).',
      );
    }
    // Bind to avoid "Illegal invocation" when calling detached global fetch.
    this.fetchImpl = f.bind(globalThis);

    const storage = resolveStorage(opts.storage);
    const storageKey = opts.storageKey ?? DEFAULT_STORAGE_KEY;

    this.auth = new AuthClient({
      authUrl: `${base}/auth`,
      fetch: this.fetchImpl,
      storage,
      storageKey,
      baseHeaders: () => this.baseHeaders(),
    });

    // Object storage + realtime share the bearer/anon-key the auth client holds.
    const token = () => this.auth.token ?? this.apikey ?? null;
    this.storage = new StorageClient(base, token, {
      fetch: this.fetchImpl,
      headers: () => this.baseHeaders(),
    });
    this.realtime = new RealtimeClient(base, token);
    this.functions = new FunctionsClient(base, token, {
      fetch: this.fetchImpl,
      headers: () => this.baseHeaders(),
    });
  }

  /** Begin a PostgREST query against a table or view. */
  from<T = unknown>(table: string): QueryBuilder<T> {
    return new QueryBuilder<T>(
      {
        restUrl: this.restUrl,
        headers: () => this.restHeaders(),
        fetch: this.fetchImpl,
      },
      table,
    );
  }

  /** Subscribe to realtime changes on a table — shortcut for `.realtime.channel()`. */
  channel(name: string): RealtimeChannel {
    return this.realtime.channel(name);
  }

  /** Headers common to every request (apikey + caller extras). */
  private baseHeaders(): Record<string, string> {
    const h: Record<string, string> = { ...this.extraHeaders };
    if (this.apikey) h['apikey'] = this.apikey;
    return h;
  }

  /** REST headers — base plus the signed-in bearer (or anon apikey fallback). */
  private restHeaders(): Record<string, string> {
    const h = this.baseHeaders();
    const token = this.auth.token ?? this.apikey;
    if (token) h['Authorization'] = `Bearer ${token}`;
    return h;
  }
}

export function createClient(url: string, opts?: ClientOptions): LaetoliDataClient {
  return new LaetoliDataClient(url, opts);
}

function stripTrailingSlash(u: string): string {
  return u.replace(/\/+$/, '');
}
