// Request handlers as small, dependency-injected functions.
//
// Two flavours:
//   * JSON handlers return a { status, body } result (unit-testable directly).
//   * Byte handlers (download/signed) return a { status, body? } for the error
//     case OR a { stream, mime, size } for the success case, so app.ts decides
//     whether to res.json(...) or pipe the stream.
//
// Auth: the same HS256 bearer the auth service issues. Public buckets allow
// anonymous reads. For non-public buckets, ANY authenticated user may read
// (documented choice — keeps sharing simple); writes/deletes are owner-scoped.

import type { Db, ObjectRow } from './db.js';
import type { ObjectStore } from './store.js';
import { clampLimit } from './db.js';
import {
  verifyAccessToken,
  parseBearer,
  issueSignedToken,
  verifySignedToken,
} from './jwt.js';
import { validateBucketName, validateObjectPath } from './validation.js';
import {
  type TransformParams,
  transformCacheKey,
  isTransformable,
  runTransform,
} from './transform.js';

export interface HandlerDeps {
  db: Db;
  store: ObjectStore;
  jwtSecret: string;
}

export interface JsonResult {
  status: number;
  body: unknown;
}

export interface StreamResult {
  stream: NodeJS.ReadableStream;
  mime: string;
  size: number;
}

/** A fully-buffered transformed image variant served from memory. */
export interface BufferResult {
  buffer: Buffer;
  mime: string;
}

function err(message: string): { error: string } {
  return { error: message };
}

/** Verify a bearer header → { sub } or null. */
function authUser(
  deps: HandlerDeps,
  authorization: string | undefined
): { sub: string } | null {
  const token = parseBearer(authorization);
  if (!token) return null;
  try {
    const claims = verifyAccessToken(token, deps.jwtSecret);
    return { sub: claims.sub };
  } catch {
    return null;
  }
}

function publicObject(row: ObjectRow): Record<string, unknown> {
  return {
    name: row.path,
    bucket: row.bucket,
    path: row.path,
    size: row.size,
    mime: row.mime,
    owner: row.owner,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ---- buckets --------------------------------------------------------------

export async function handleCreateBucket(
  deps: HandlerDeps,
  authorization: string | undefined,
  input: { name?: unknown; public?: unknown }
): Promise<JsonResult> {
  const user = authUser(deps, authorization);
  if (!user) return { status: 401, body: err('Tafadhali tuma tokeni ya idhini.') };

  const v = validateBucketName(input.name);
  if (!v.ok) return { status: 400, body: err(v.error!) };

  const name = (input.name as string).trim();
  const isPublic = input.public === true;

  const existing = await deps.db.getBucket(name);
  if (existing) {
    return { status: 409, body: err('Ndoo yenye jina hilo tayari ipo.') };
  }

  try {
    const row = await deps.db.createBucket({ name, public: isPublic });
    return { status: 201, body: { bucket: row } };
  } catch (e) {
    if (isUniqueViolation(e)) {
      return { status: 409, body: err('Ndoo yenye jina hilo tayari ipo.') };
    }
    throw e;
  }
}

export async function handleListBuckets(
  deps: HandlerDeps,
  authorization: string | undefined
): Promise<JsonResult> {
  const user = authUser(deps, authorization);
  if (!user) return { status: 401, body: err('Tafadhali tuma tokeni ya idhini.') };
  const rows = await deps.db.listBuckets();
  return { status: 200, body: { buckets: rows } };
}

export async function handleDeleteBucket(
  deps: HandlerDeps,
  authorization: string | undefined,
  name: string
): Promise<JsonResult> {
  const user = authUser(deps, authorization);
  if (!user) return { status: 401, body: err('Tafadhali tuma tokeni ya idhini.') };
  const existing = await deps.db.getBucket(name);
  if (!existing) return { status: 404, body: err('Ndoo haipatikani.') };
  await deps.db.deleteBucket(name);
  return { status: 200, body: { deleted: name } };
}

// ---- objects --------------------------------------------------------------

export async function handleUpload(
  deps: HandlerDeps,
  authorization: string | undefined,
  bucket: string,
  rawPath: string,
  body: NodeJS.ReadableStream,
  contentType: string | undefined
): Promise<JsonResult> {
  const user = authUser(deps, authorization);
  if (!user) return { status: 401, body: err('Tafadhali tuma tokeni ya idhini.') };

  const p = validateObjectPath(rawPath);
  if (!p.ok) return { status: 400, body: err(p.error!) };

  const bkt = await deps.db.getBucket(bucket);
  if (!bkt) return { status: 404, body: err('Ndoo haipatikani.') };

  const mime = normalizeMime(contentType);
  let size: number;
  try {
    size = await deps.store.put(bucket, p.path!, body as never);
  } catch (e) {
    if (isTraversal(e)) return { status: 400, body: err('Njia ya faili haina ruhusa.') };
    throw e;
  }

  const row = await deps.db.upsertObject({
    bucket,
    path: p.path!,
    size,
    mime,
    owner: user.sub,
  });
  return { status: 200, body: { object: publicObject(row) } };
}

/**
 * Resolve a download. Returns either a JSON error result OR a StreamResult.
 * `public` buckets skip auth; otherwise a valid bearer is required.
 */
export async function handleDownload(
  deps: HandlerDeps,
  authorization: string | undefined,
  bucket: string,
  rawPath: string,
  transform: TransformParams | null = null
): Promise<JsonResult | StreamResult | BufferResult> {
  const p = validateObjectPath(rawPath);
  if (!p.ok) return { status: 400, body: err(p.error!) };

  const bkt = await deps.db.getBucket(bucket);
  if (!bkt) return { status: 404, body: err('Ndoo haipatikani.') };

  if (!bkt.public) {
    const user = authUser(deps, authorization);
    if (!user) {
      return { status: 401, body: err('Tafadhali tuma tokeni ya idhini.') };
    }
  }

  return openObject(deps, bucket, p.path!, transform);
}

export async function handleList(
  deps: HandlerDeps,
  authorization: string | undefined,
  bucket: string,
  query: { prefix?: unknown; limit?: unknown }
): Promise<JsonResult> {
  const user = authUser(deps, authorization);
  if (!user) return { status: 401, body: err('Tafadhali tuma tokeni ya idhini.') };

  const bkt = await deps.db.getBucket(bucket);
  if (!bkt) return { status: 404, body: err('Ndoo haipatikani.') };

  const prefix = typeof query.prefix === 'string' ? query.prefix : undefined;
  const limit =
    typeof query.limit === 'string' ? Number.parseInt(query.limit, 10) : undefined;

  const rows = await deps.db.listObjects({
    bucket,
    prefix,
    limit: clampLimit(limit),
  });
  return { status: 200, body: { objects: rows.map(publicObject) } };
}

export async function handleDelete(
  deps: HandlerDeps,
  authorization: string | undefined,
  bucket: string,
  rawPath: string
): Promise<JsonResult> {
  const user = authUser(deps, authorization);
  if (!user) return { status: 401, body: err('Tafadhali tuma tokeni ya idhini.') };

  const p = validateObjectPath(rawPath);
  if (!p.ok) return { status: 400, body: err(p.error!) };

  const row = await deps.db.getObject(bucket, p.path!);
  if (!row) return { status: 404, body: err('Faili haipatikani.') };

  // Owner-only delete.
  if (row.owner !== user.sub) {
    return { status: 403, body: err('Hauruhusiwi kufuta faili hili.') };
  }

  await deps.store.remove(bucket, p.path!);
  await deps.db.deleteObject(bucket, p.path!);
  return { status: 200, body: { deleted: p.path } };
}

// ---- signed URLs ----------------------------------------------------------

export async function handleSign(
  deps: HandlerDeps,
  authorization: string | undefined,
  bucket: string,
  rawPath: string,
  input: { expiresIn?: unknown }
): Promise<JsonResult> {
  const user = authUser(deps, authorization);
  if (!user) return { status: 401, body: err('Tafadhali tuma tokeni ya idhini.') };

  const p = validateObjectPath(rawPath);
  if (!p.ok) return { status: 400, body: err(p.error!) };

  const bkt = await deps.db.getBucket(bucket);
  if (!bkt) return { status: 404, body: err('Ndoo haipatikani.') };

  const row = await deps.db.getObject(bucket, p.path!);
  if (!row) return { status: 404, body: err('Faili haipatikani.') };

  const expiresIn = normalizeExpiry(input.expiresIn);
  if (expiresIn === null) {
    return { status: 400, body: err('expiresIn si sahihi (sekunde 1–604800).') };
  }

  const token = issueSignedToken(bucket, p.path!, {
    secret: deps.jwtSecret,
    expiresInSeconds: expiresIn,
  });

  // Caddy strips /storage, so the client-facing URL re-adds it.
  const signedUrl = `/storage/signed/${encodeURIComponent(bucket)}/${p
    .path!.split('/')
    .map(encodeURIComponent)
    .join('/')}?token=${encodeURIComponent(token)}`;

  return { status: 200, body: { signedUrl, token, expiresIn } };
}

/** Verify a signed token and resolve the object stream (no bearer needed). */
export async function handleSigned(
  deps: HandlerDeps,
  bucket: string,
  rawPath: string,
  token: unknown,
  transform: TransformParams | null = null
): Promise<JsonResult | StreamResult | BufferResult> {
  if (typeof token !== 'string' || token.length === 0) {
    return { status: 401, body: err('Tokeni ya kiungo inahitajika.') };
  }
  const p = validateObjectPath(rawPath);
  if (!p.ok) return { status: 400, body: err(p.error!) };

  try {
    verifySignedToken(token, deps.jwtSecret, { bucket, path: p.path! });
  } catch {
    return { status: 401, body: err('Kiungo si halali au muda wake umeisha.') };
  }

  const bkt = await deps.db.getBucket(bucket);
  if (!bkt) return { status: 404, body: err('Ndoo haipatikani.') };

  return openObject(deps, bucket, p.path!, transform);
}

// ---- shared ---------------------------------------------------------------

async function openObject(
  deps: HandlerDeps,
  bucket: string,
  path: string,
  transform: TransformParams | null = null
): Promise<JsonResult | StreamResult | BufferResult> {
  const row = await deps.db.getObject(bucket, path);
  if (!row) return { status: 404, body: err('Faili haipatikani.') };

  const onDisk = await deps.store.stat(bucket, path);
  if (!onDisk) return { status: 404, body: err('Faili haipatikani.') };

  // Transform path: only for raster images. Non-images (or unsupported types)
  // with transform params fall through to the original bytes (documented).
  if (transform && isTransformable(row.mime)) {
    const variant = await openTransformed(deps, bucket, path, row.mime, transform, onDisk);
    if (variant) return variant;
    // null → any failure (corrupt image, sharp error): serve the original.
  }

  let stream: NodeJS.ReadableStream;
  try {
    stream = deps.store.get(bucket, path);
  } catch (e) {
    if (isTraversal(e)) return { status: 400, body: err('Njia ya faili haina ruhusa.') };
    throw e;
  }
  return { stream, mime: row.mime, size: onDisk.size };
}

/**
 * Produce (or fetch from cache) a transformed image variant. Returns a
 * BufferResult on success, or null on ANY failure so the caller can fall back
 * to the original — a corrupt image or sharp error must never 500 the service.
 */
async function openTransformed(
  deps: HandlerDeps,
  bucket: string,
  path: string,
  sourceMime: string,
  transform: TransformParams,
  onDisk: { size: number; mtimeMs: number }
): Promise<BufferResult | null> {
  const key = transformCacheKey(bucket, path, transform, onDisk);

  // 1) Serve from cache when present.
  try {
    const cached = await deps.store.getCached(key);
    if (cached) {
      return { buffer: cached, mime: transformMime(transform, sourceMime) };
    }
  } catch {
    /* cache miss/error → fall through to generate */
  }

  // 2) Generate.
  try {
    const input = await deps.store.readAll(bucket, path);
    const out = await runTransform(input, transform, sourceMime);
    // 3) Cache (best-effort; never blocks/throws into the response).
    await deps.store.putCached(key, out.data);
    return { buffer: out.data, mime: out.mime };
  } catch (e) {
    console.warn(
      `[storage] transform failed for ${bucket}/${path} — serving original:`,
      e instanceof Error ? e.message : String(e)
    );
    return null;
  }
}

/** Content-Type for a cached variant (format → its mime, else source). */
function transformMime(transform: TransformParams, sourceMime: string): string {
  return transform.format
    ? { webp: 'image/webp', jpeg: 'image/jpeg', png: 'image/png', avif: 'image/avif' }[
        transform.format
      ]
    : sourceMime;
}

export function isStreamResult(
  r: JsonResult | StreamResult | BufferResult
): r is StreamResult {
  return (r as StreamResult).stream !== undefined;
}

export function isBufferResult(
  r: JsonResult | StreamResult | BufferResult
): r is BufferResult {
  return Buffer.isBuffer((r as BufferResult).buffer);
}

function normalizeMime(contentType: string | undefined): string {
  if (!contentType) return 'application/octet-stream';
  // Strip charset etc.
  const base = contentType.split(';')[0].trim().toLowerCase();
  return base || 'application/octet-stream';
}

function normalizeExpiry(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value ?? 3600);
  if (!Number.isFinite(n)) return null;
  const secs = Math.floor(n);
  if (secs < 1 || secs > 604_800) return null; // 1s .. 7 days
  return secs;
}

function isUniqueViolation(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    (e as { code?: unknown }).code === '23505'
  );
}

function isTraversal(e: unknown): boolean {
  return e instanceof Error && /traversal/i.test(e.message);
}
