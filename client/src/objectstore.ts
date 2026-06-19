import type { DataResult, PostgrestError } from './types';

/**
 * Object-storage client for the sovereign storage service (`/storage/*`).
 * Mirrors the supabase-js `storage` subset our apps use. Zero-dependency:
 * uses the global `fetch` injected by the parent client.
 *
 * Construct as `new StorageClient(baseUrl, () => token)`. `baseUrl` is the same
 * single Caddy endpoint the rest of the SDK targets; this client appends
 * `/storage`. The token getter returns the current bearer (or null for anon).
 */

interface FetchCtx {
  fetch: typeof fetch;
  extraHeaders: () => Record<string, string>;
}

export interface ObjectMeta {
  name: string;
  bucket: string;
  path: string;
  size: number;
  mime: string;
  owner: string;
  created_at: string;
  updated_at: string;
}

export interface BucketMeta {
  name: string;
  public: boolean;
  created_at: string;
}

export interface UploadOptions {
  /** MIME type stored with the object (defaults from the body or octet-stream). */
  contentType?: string;
}

/**
 * On-the-fly image transform options (Supabase-parity). Appended as query
 * params to a download URL; the storage service returns a resized/reformatted
 * variant when the object is a raster image. Omit to get the original bytes.
 */
export interface TransformOptions {
  /** Target width in px (server clamps to a max, e.g. 2000). */
  width?: number;
  /** Target height in px (server clamps to a max, e.g. 2000). */
  height?: number;
  /** Fit mode when both dims are set. Default 'cover'. */
  resize?: 'cover' | 'contain' | 'fill';
  /** Output format (re-encodes). */
  format?: 'webp' | 'jpeg' | 'png' | 'avif';
  /** Output quality, 1–100 (where the encoder supports it). */
  quality?: number;
}

/**
 * Build a `?width=…&format=…` query string from transform options. Pure +
 * exported so it can be unit-tested and reused. Returns '' when no options.
 */
export function buildTransformQuery(t?: TransformOptions): string {
  if (!t) return '';
  const parts: string[] = [];
  if (t.width != null) parts.push(`width=${encodeURIComponent(String(t.width))}`);
  if (t.height != null) parts.push(`height=${encodeURIComponent(String(t.height))}`);
  if (t.resize) parts.push(`resize=${encodeURIComponent(t.resize)}`);
  if (t.format) parts.push(`format=${encodeURIComponent(t.format)}`);
  if (t.quality != null)
    parts.push(`quality=${encodeURIComponent(String(t.quality))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

export type StorageBody = Blob | ArrayBuffer | Uint8Array | string;

/** A single-bucket handle, returned by `.from(bucket)`. */
export class BucketApi {
  constructor(
    private readonly ctx: FetchCtx,
    private readonly storageUrl: string,
    private readonly bucket: string,
  ) {}

  async upload(
    path: string,
    body: StorageBody,
    opts: UploadOptions = {},
  ): Promise<DataResult<ObjectMeta>> {
    const headers = this.ctx.extraHeaders();
    const contentType = opts.contentType ?? inferContentType(body);
    if (contentType) headers['Content-Type'] = contentType;
    return request<ObjectMeta>(
      this.ctx,
      `${this.storageUrl}/object/${enc(this.bucket)}/${encPath(path)}`,
      { method: 'PUT', headers, body: toBodyInit(body) },
      (parsed) => extract<ObjectMeta>(parsed, 'object') ?? ({} as ObjectMeta),
    );
  }

  /** Download an object's bytes as a Blob (mirrors supabase-js). */
  async download(path: string): Promise<DataResult<Blob>> {
    let res: Response;
    try {
      res = await this.ctx.fetch(
        `${this.storageUrl}/object/${enc(this.bucket)}/${encPath(path)}`,
        { method: 'GET', headers: this.ctx.extraHeaders() },
      );
    } catch (e) {
      return fetchError<Blob>(e);
    }
    if (!res.ok) {
      const parsed = await safeJson(res);
      return { data: null, error: toErr(parsed, res), status: res.status, statusText: res.statusText };
    }
    const blob = await res.blob();
    return { data: blob, error: null, status: res.status, statusText: res.statusText };
  }

  async list(prefix?: string): Promise<DataResult<ObjectMeta[]>> {
    const qs = prefix ? `?prefix=${encodeURIComponent(prefix)}` : '';
    return request<ObjectMeta[]>(
      this.ctx,
      `${this.storageUrl}/list/${enc(this.bucket)}${qs}`,
      { method: 'GET', headers: this.ctx.extraHeaders() },
      (parsed) => extract<ObjectMeta[]>(parsed, 'objects') ?? [],
    );
  }

  /** Remove one or more objects. Returns the paths that were deleted. */
  async remove(paths: string[]): Promise<DataResult<{ path: string }[]>> {
    const results: { path: string }[] = [];
    let lastErr: PostgrestError | null = null;
    let lastStatus = 200;
    let lastStatusText = '';
    for (const path of paths) {
      let res: Response;
      try {
        res = await this.ctx.fetch(
          `${this.storageUrl}/object/${enc(this.bucket)}/${encPath(path)}`,
          { method: 'DELETE', headers: this.ctx.extraHeaders() },
        );
      } catch (e) {
        return fetchError<{ path: string }[]>(e);
      }
      lastStatus = res.status;
      lastStatusText = res.statusText;
      const parsed = await safeJson(res);
      if (!res.ok) {
        lastErr = toErr(parsed, res);
      } else {
        results.push({ path });
      }
    }
    if (lastErr) {
      return { data: null, error: lastErr, status: lastStatus, statusText: lastStatusText };
    }
    return { data: results, error: null, status: lastStatus, statusText: lastStatusText };
  }

  /**
   * Build a public URL for an object in a PUBLIC bucket. Synchronous, like
   * supabase-js — no network call, no auth. Pass `{ transform }` to request an
   * on-the-fly resized/reformatted image variant.
   */
  getPublicUrl(
    path: string,
    opts: { transform?: TransformOptions } = {},
  ): { data: { publicUrl: string }; publicUrl: string } {
    const qs = buildTransformQuery(opts.transform);
    const publicUrl = `${this.storageUrl}/object/${enc(this.bucket)}/${encPath(path)}${qs}`;
    return { data: { publicUrl }, publicUrl };
  }

  /**
   * Build a transform URL for an object (resized/reformatted image variant).
   * Convenience over getPublicUrl — same result, transform-first signature.
   * For private buckets, append the same query params to a signed URL instead.
   */
  transformUrl(path: string, transform: TransformOptions): string {
    return `${this.storageUrl}/object/${enc(this.bucket)}/${encPath(path)}${buildTransformQuery(transform)}`;
  }

  /** Create a time-limited signed URL for a private object. */
  async createSignedUrl(
    path: string,
    expiresIn: number,
  ): Promise<DataResult<{ signedUrl: string }>> {
    const headers = this.ctx.extraHeaders();
    headers['Content-Type'] = 'application/json';
    return request<{ signedUrl: string }>(
      this.ctx,
      `${this.storageUrl}/sign/${enc(this.bucket)}/${encPath(path)}`,
      { method: 'POST', headers, body: JSON.stringify({ expiresIn }) },
      (parsed) => {
        const o = (parsed ?? {}) as Record<string, unknown>;
        const signedUrl = typeof o.signedUrl === 'string' ? o.signedUrl : '';
        return { signedUrl };
      },
    );
  }
}

export class StorageClient {
  private readonly storageUrl: string;
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
    this.storageUrl = `${base}/storage`;
    const f = opts.fetch ?? globalThis.fetch;
    if (!f) {
      throw new Error(
        '@laetoli/data: no global fetch available — pass opts.fetch (Node < 18 / non-standard runtime).',
      );
    }
    this.fetchImpl = f.bind(globalThis);
  }

  private ctx(): FetchCtx {
    return {
      fetch: this.fetchImpl,
      extraHeaders: () => {
        const h: Record<string, string> = { ...(this.opts.headers?.() ?? {}) };
        const token = this.getToken();
        if (token) h['Authorization'] = `Bearer ${token}`;
        return h;
      },
    };
  }

  /** A handle scoped to one bucket. */
  from(bucket: string): BucketApi {
    return new BucketApi(this.ctx(), this.storageUrl, bucket);
  }

  async createBucket(
    name: string,
    options: { public?: boolean } = {},
  ): Promise<DataResult<BucketMeta>> {
    const ctx = this.ctx();
    const headers = ctx.extraHeaders();
    headers['Content-Type'] = 'application/json';
    return request<BucketMeta>(
      ctx,
      `${this.storageUrl}/bucket`,
      { method: 'POST', headers, body: JSON.stringify({ name, public: options.public === true }) },
      (parsed) => extract<BucketMeta>(parsed, 'bucket') ?? ({} as BucketMeta),
    );
  }

  async listBuckets(): Promise<DataResult<BucketMeta[]>> {
    const ctx = this.ctx();
    return request<BucketMeta[]>(
      ctx,
      `${this.storageUrl}/bucket`,
      { method: 'GET', headers: ctx.extraHeaders() },
      (parsed) => extract<BucketMeta[]>(parsed, 'buckets') ?? [],
    );
  }

  async deleteBucket(name: string): Promise<DataResult<{ deleted: string }>> {
    const ctx = this.ctx();
    return request<{ deleted: string }>(
      ctx,
      `${this.storageUrl}/bucket/${enc(name)}`,
      { method: 'DELETE', headers: ctx.extraHeaders() },
      (parsed) => (parsed ?? { deleted: name }) as { deleted: string },
    );
  }
}

// ---- helpers -------------------------------------------------------------

async function request<T>(
  ctx: FetchCtx,
  url: string,
  init: RequestInit,
  pick: (parsed: unknown) => T,
): Promise<DataResult<T>> {
  let res: Response;
  try {
    res = await ctx.fetch(url, init);
  } catch (e) {
    return fetchError<T>(e);
  }
  const parsed = await safeJson(res);
  if (!res.ok) {
    return { data: null, error: toErr(parsed, res), status: res.status, statusText: res.statusText };
  }
  return { data: pick(parsed), error: null, status: res.status, statusText: res.statusText };
}

function extract<T>(parsed: unknown, key: string): T | null {
  if (parsed && typeof parsed === 'object' && key in (parsed as object)) {
    return (parsed as Record<string, unknown>)[key] as T;
  }
  return null;
}

function fetchError<T>(e: unknown): DataResult<T> {
  return {
    data: null,
    error: { message: e instanceof Error ? e.message : String(e), code: 'fetch_error' },
    status: 0,
    statusText: '',
  };
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
      message: typeof m === 'string' ? m : res.statusText || 'Storage request failed',
      code: (o.code as string) ?? String(res.status),
    };
  }
  return {
    message: typeof parsed === 'string' && parsed ? parsed : res.statusText || 'Storage request failed',
    code: String(res.status),
  };
}

/** Encode a single path segment (bucket / file name). */
function enc(s: string): string {
  return encodeURIComponent(s);
}

/** Encode an object path, preserving the `/` separators. */
function encPath(path: string): string {
  return path
    .replace(/^\/+/, '')
    .split('/')
    .map(encodeURIComponent)
    .join('/');
}

function inferContentType(body: StorageBody): string | undefined {
  if (typeof body === 'string') return 'text/plain;charset=utf-8';
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    return body.type || 'application/octet-stream';
  }
  return 'application/octet-stream';
}

function toBodyInit(body: StorageBody): BodyInit {
  if (typeof body === 'string') return body;
  if (typeof Blob !== 'undefined' && body instanceof Blob) return body;
  if (body instanceof Uint8Array) return body as unknown as BodyInit;
  return body as ArrayBuffer as unknown as BodyInit;
}
