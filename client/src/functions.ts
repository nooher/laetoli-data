import type { DataResult, PostgrestError } from './types';

/**
 * Functions client for the sovereign edge-functions runner (`/functions/*`).
 * Mirrors supabase-js `functions.invoke()`. Zero-dependency: uses the global
 * `fetch` injected by the parent client.
 *
 * Construct as `new FunctionsClient(baseUrl, () => token)`. `baseUrl` is the
 * same single Caddy endpoint the rest of the SDK targets; this client appends
 * `/functions`. The token getter returns the current bearer (or null for anon —
 * functions decide whether they require auth).
 */

export interface InvokeOptions {
  /** Request body. Objects/arrays are JSON-encoded; strings sent as-is. */
  body?: unknown;
  /** HTTP method (defaults to POST, like supabase-js). */
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Extra headers for this call. */
  headers?: Record<string, string>;
}

export class FunctionsClient {
  private readonly functionsUrl: string;
  private readonly fetchImpl: typeof fetch;

  /**
   * @param baseUrl   the single Caddy endpoint (e.g. https://data.laetoli.tz)
   * @param getToken  returns the current bearer token, or null for anonymous
   * @param opts.fetch / opts.headers — optional injected fetch + extra headers
   */
  constructor(
    baseUrl: string,
    private readonly getToken: () => string | null,
    private readonly opts: { fetch?: typeof fetch; headers?: () => Record<string, string> } = {},
  ) {
    const base = baseUrl.replace(/\/+$/, '');
    this.functionsUrl = `${base}/functions`;
    const f = opts.fetch ?? globalThis.fetch;
    if (!f) {
      throw new Error(
        '@laetoli/data: no global fetch available — pass opts.fetch (Node < 18 / non-standard runtime).',
      );
    }
    this.fetchImpl = f.bind(globalThis);
  }

  /** Invoke a deployed function by name. Returns the SDK `DataResult` envelope. */
  async invoke<T = unknown>(name: string, options: InvokeOptions = {}): Promise<DataResult<T>> {
    const method = options.method ?? 'POST';
    const headers: Record<string, string> = { ...(this.opts.headers?.() ?? {}), ...(options.headers ?? {}) };

    const token = this.getToken();
    if (token && !headers['Authorization']) headers['Authorization'] = `Bearer ${token}`;

    let body: BodyInit | undefined;
    if (options.body !== undefined && method !== 'GET') {
      if (typeof options.body === 'string') {
        body = options.body;
        if (!headers['Content-Type']) headers['Content-Type'] = 'text/plain;charset=utf-8';
      } else {
        body = JSON.stringify(options.body);
        if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
      }
    }

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.functionsUrl}/${encodeURIComponent(name)}`, {
        method,
        headers,
        body,
      });
    } catch (e) {
      return {
        data: null,
        error: { message: e instanceof Error ? e.message : String(e), code: 'fetch_error' },
        status: 0,
        statusText: '',
      };
    }

    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!res.ok) {
      return { data: null, error: toError(parsed, res), status: res.status, statusText: res.statusText };
    }

    return {
      data: (parsed as T) ?? null,
      error: null,
      status: res.status,
      statusText: res.statusText,
    };
  }
}

function toError(parsed: unknown, res: Response): PostgrestError {
  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    const m = o.message ?? o.error ?? o.msg;
    return {
      message: typeof m === 'string' ? m : res.statusText || 'Function request failed',
      code: (o.code as string) ?? String(res.status),
    };
  }
  return {
    message: typeof parsed === 'string' && parsed ? parsed : res.statusText || 'Function request failed',
    code: String(res.status),
  };
}
