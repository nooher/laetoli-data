import type { DataResult, PostgrestError } from './types';

/**
 * Vector / RPC client — the AI-native surface of Laetoli Data.
 *
 * Two things live here:
 *   1. `rpc(fn, args)` — call any PostgREST RPC (a SQL function), POSTing a JSON
 *      body to `{restUrl}/rpc/<fn>`. Returns the standard `DataResult` envelope.
 *   2. `matchDocuments(embedding, opts)` — a thin convenience over the
 *      `match_documents` SQL function (db/migrations/0005_vectors.sql): cosine
 *      similarity search over the owner-scoped `public.documents` table.
 *
 * Embeddings are BRING-YOUR-OWN: compute the float[] client-side or in an edge
 * function and pass it here. Laetoli Data stores + searches; it does not run a
 * model. See docs/VECTORS.md.
 *
 * Zero-dependency: uses the fetch + REST headers injected by the parent client.
 */

/** One matched row returned by `match_documents`. */
export interface MatchedDocument<M = Record<string, unknown>> {
  id: string;
  content: string | null;
  metadata: M;
  /** 1 - cosine_distance; higher = more similar (1.0 == identical direction). */
  similarity: number;
}

export interface MatchOptions {
  /** Max rows to return (maps to match_count; default 5, matching the SQL). */
  count?: number;
  /** jsonb containment filter on documents.metadata (e.g. { source: 'akili' }). */
  filter?: Record<string, unknown>;
}

interface Ctx {
  /** Base REST url, e.g. https://host/rest (no trailing slash). */
  restUrl: string;
  /** Build the headers (incl. bearer + apikey) at request time. */
  headers: () => Record<string, string>;
  fetch: typeof fetch;
}

export class VectorClient {
  constructor(private readonly ctx: Ctx) {}

  /**
   * Call a PostgREST RPC (SQL function). POSTs `args` as JSON to
   * `{restUrl}/rpc/<fnName>` and returns the `{ data, error, status }` envelope.
   */
  async rpc<T = unknown>(fnName: string, args: Record<string, unknown> = {}): Promise<DataResult<T>> {
    const url = `${this.ctx.restUrl}/rpc/${encodeURIComponent(fnName)}`;
    const headers: Record<string, string> = {
      ...this.ctx.headers(),
      'Content-Type': 'application/json',
    };

    let res: Response;
    try {
      res = await this.ctx.fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(args),
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
      return {
        data: null,
        error: toError(parsed, res),
        status: res.status,
        statusText: res.statusText,
      };
    }

    return {
      data: (parsed as T) ?? null,
      error: null,
      status: res.status,
      statusText: res.statusText,
    };
  }

  /**
   * Cosine-similarity search over `public.documents` via the `match_documents`
   * SQL function. RLS scopes results to the signed-in caller's own rows.
   *
   * @param embedding  the query vector (length must match the column dim, 384 by default)
   * @param opts.count  max rows (default 5)
   * @param opts.filter jsonb containment filter on metadata
   */
  matchDocuments<M = Record<string, unknown>>(
    embedding: readonly number[],
    opts: MatchOptions = {},
  ): Promise<DataResult<MatchedDocument<M>[]>> {
    return this.rpc<MatchedDocument<M>[]>('match_documents', {
      query_embedding: embedding,
      match_count: opts.count ?? 5,
      filter: opts.filter ?? {},
    });
  }
}

function toError(parsed: unknown, res: Response): PostgrestError {
  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    return {
      message: typeof o.message === 'string' ? o.message : res.statusText || 'Request failed',
      details: (o.details as string) ?? null,
      hint: (o.hint as string) ?? null,
      code: (o.code as string) ?? String(res.status),
    };
  }
  return {
    message: typeof parsed === 'string' && parsed ? parsed : res.statusText || 'Request failed',
    code: String(res.status),
  };
}
