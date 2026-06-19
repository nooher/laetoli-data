import type { DataResult, PostgrestError } from './types';

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface Ctx {
  /** Base REST url, e.g. https://host/rest (no trailing slash). */
  restUrl: string;
  /** Build the headers (incl. bearer + apikey) at request time. */
  headers: () => Record<string, string>;
  fetch: typeof fetch;
}

/**
 * PostgREST query builder mirroring the supabase-js subset our apps use.
 * It is thenable: `await client.from('t').select()` resolves a
 * `{ data, error, status, statusText }` envelope.
 */
export class QueryBuilder<T = unknown> implements PromiseLike<DataResult<T>> {
  private method: Method = 'GET';
  private columns = '*';
  private body: unknown;
  private filters: string[] = [];
  private orderParts: string[] = [];
  private limitN?: number;
  private offsetN?: number;
  private wantSingle = false;
  /** maybeSingle tolerates 0 rows; single errors on != 1. */
  private singleStrict = true;

  constructor(
    private readonly ctx: Ctx,
    private readonly table: string,
  ) {}

  // ---- verbs -------------------------------------------------------------

  select(columns = '*'): this {
    // .select() after insert/update/delete keeps the write verb but asks
    // PostgREST to return the affected rows (return=representation handles it).
    if (this.method === 'GET') this.method = 'GET';
    this.columns = columns || '*';
    return this;
  }

  insert(rows: unknown): this {
    this.method = 'POST';
    this.body = rows;
    return this;
  }

  update(values: unknown): this {
    this.method = 'PATCH';
    this.body = values;
    return this;
  }

  delete(): this {
    this.method = 'DELETE';
    return this;
  }

  // ---- filters -----------------------------------------------------------

  eq(column: string, value: unknown): this {
    this.filters.push(`${column}=eq.${encodeURIComponent(stringify(value))}`);
    return this;
  }

  neq(column: string, value: unknown): this {
    this.filters.push(`${column}=neq.${encodeURIComponent(stringify(value))}`);
    return this;
  }

  gt(column: string, value: unknown): this {
    this.filters.push(`${column}=gt.${encodeURIComponent(stringify(value))}`);
    return this;
  }

  gte(column: string, value: unknown): this {
    this.filters.push(`${column}=gte.${encodeURIComponent(stringify(value))}`);
    return this;
  }

  lt(column: string, value: unknown): this {
    this.filters.push(`${column}=lt.${encodeURIComponent(stringify(value))}`);
    return this;
  }

  lte(column: string, value: unknown): this {
    this.filters.push(`${column}=lte.${encodeURIComponent(stringify(value))}`);
    return this;
  }

  like(column: string, pattern: string): this {
    this.filters.push(`${column}=like.${encodeURIComponent(pattern)}`);
    return this;
  }

  ilike(column: string, pattern: string): this {
    this.filters.push(`${column}=ilike.${encodeURIComponent(pattern)}`);
    return this;
  }

  is(column: string, value: null | boolean): this {
    this.filters.push(`${column}=is.${value === null ? 'null' : String(value)}`);
    return this;
  }

  in(column: string, values: readonly unknown[]): this {
    const list = values.map((v) => encodeURIComponent(stringify(v))).join(',');
    this.filters.push(`${column}=in.(${list})`);
    return this;
  }

  // ---- shaping -----------------------------------------------------------

  order(column: string, opts?: { ascending?: boolean; nullsFirst?: boolean }): this {
    const dir = opts?.ascending === false ? 'desc' : 'asc';
    let part = `${column}.${dir}`;
    if (opts?.nullsFirst !== undefined) {
      part += opts.nullsFirst ? '.nullsfirst' : '.nullslast';
    }
    this.orderParts.push(part);
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  range(from: number, to: number): this {
    this.offsetN = from;
    this.limitN = to - from + 1;
    return this;
  }

  single(): this {
    this.wantSingle = true;
    this.singleStrict = true;
    return this;
  }

  maybeSingle(): this {
    this.wantSingle = true;
    this.singleStrict = false;
    return this;
  }

  // ---- execution ---------------------------------------------------------

  private buildUrl(): string {
    const params: string[] = [];
    // PostgREST uses `select` for column projection on every verb.
    if (this.method === 'GET' || this.columns !== '*') {
      params.push(`select=${encodeURIComponent(this.columns)}`);
    }
    params.push(...this.filters);
    if (this.orderParts.length) {
      params.push(`order=${encodeURIComponent(this.orderParts.join(','))}`);
    }
    if (this.limitN !== undefined) params.push(`limit=${this.limitN}`);
    if (this.offsetN !== undefined) params.push(`offset=${this.offsetN}`);
    const qs = params.length ? `?${params.join('&')}` : '';
    return `${this.ctx.restUrl}/${this.table}${qs}`;
  }

  private buildHeaders(): Record<string, string> {
    const h: Record<string, string> = { ...this.ctx.headers() };
    if (this.method !== 'GET') {
      h['Content-Type'] = 'application/json';
      // Return the affected rows so insert/update/delete behave like supabase-js.
      h['Prefer'] = 'return=representation';
    }
    if (this.wantSingle) {
      // PostgREST returns a single object (not array) with this Accept header.
      h['Accept'] = 'application/vnd.pgrst.object+json';
    }
    return h;
  }

  private async run(): Promise<DataResult<T>> {
    let res: Response;
    try {
      res = await this.ctx.fetch(this.buildUrl(), {
        method: this.method,
        headers: this.buildHeaders(),
        body: this.body !== undefined ? JSON.stringify(this.body) : undefined,
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
      const err = toError(parsed, res);
      // maybeSingle on 0 rows → PostgREST 406; surface as null data, no error.
      if (this.wantSingle && !this.singleStrict && res.status === 406) {
        return { data: null, error: null, status: res.status, statusText: res.statusText };
      }
      return { data: null, error: err, status: res.status, statusText: res.statusText };
    }

    return {
      data: (parsed as T) ?? null,
      error: null,
      status: res.status,
      statusText: res.statusText,
    };
  }

  // PromiseLike — makes the builder awaitable.
  then<R1 = DataResult<T>, R2 = never>(
    onfulfilled?: ((value: DataResult<T>) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.run().then(onfulfilled, onrejected);
  }
}

function stringify(v: unknown): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v : String(v);
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
