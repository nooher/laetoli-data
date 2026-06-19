// On-the-fly image transforms (Supabase-parity).
//
// Two concerns, kept separate so the pure logic is unit-testable WITHOUT the
// native `sharp` binary:
//   * parseTransform()/transformCacheKey()/isTransformable() — pure functions.
//   * runTransform() — the actual sharp pipeline (imported lazily so a missing
//     binary never crashes module load; only a transform REQUEST touches it).
//
// A GET on an object may carry transform query params (width/height/resize/
// format/quality). When present AND the stored object is a raster image, the
// download path returns a transformed variant; otherwise it serves the original
// bytes unchanged. Results are cached on disk keyed by a hash of
// bucket+path+params, so repeat requests are cheap.

import { createHash } from 'node:crypto';

/** Hard cap on any single dimension — protects CPU/memory on a Pi. */
export const MAX_DIMENSION = 2000;

export type ResizeMode = 'cover' | 'contain' | 'fill';
export type OutputFormat = 'webp' | 'jpeg' | 'png' | 'avif';

const RESIZE_MODES: ReadonlySet<string> = new Set(['cover', 'contain', 'fill']);
const OUTPUT_FORMATS: ReadonlySet<string> = new Set([
  'webp',
  'jpeg',
  'png',
  'avif',
]);

/** Map an output format to the response Content-Type. */
const FORMAT_MIME: Record<OutputFormat, string> = {
  webp: 'image/webp',
  jpeg: 'image/jpeg',
  png: 'image/png',
  avif: 'image/avif',
};

/** A validated, normalized transform request. */
export interface TransformParams {
  width?: number;
  height?: number;
  resize: ResizeMode;
  format?: OutputFormat;
  quality?: number;
}

export interface ParseResult {
  /** Present + valid params (null when no transform params were supplied). */
  params: TransformParams | null;
  /** A Kiswahili error when a param was clearly malformed (→ 400). */
  error?: string;
}

/** Raw query bag (Express `req.query` values are string | string[] | undefined). */
export type QueryBag = Record<string, unknown>;

function firstString(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && typeof v[0] === 'string') return v[0];
  return undefined;
}

/**
 * Parse + validate transform query params. Returns `{ params: null }` when no
 * transform-related params are present (caller then serves the original). A
 * clearly-bad value (non-numeric width, unknown format/resize, out-of-range
 * quality) yields `{ error }` so the caller can return a clean 400. Valid
 * numeric dimensions are clamped to [1, MAX_DIMENSION].
 */
export function parseTransform(query: QueryBag): ParseResult {
  const wRaw = firstString(query.width);
  const hRaw = firstString(query.height);
  const rRaw = firstString(query.resize);
  const fRaw = firstString(query.format);
  const qRaw = firstString(query.quality);

  // No transform intent at all → original path, unchanged.
  if (
    wRaw === undefined &&
    hRaw === undefined &&
    rRaw === undefined &&
    fRaw === undefined &&
    qRaw === undefined
  ) {
    return { params: null };
  }

  const width = parseDim(wRaw);
  if (width === 'bad') {
    return { params: null, error: 'width si sahihi (lazima iwe namba chanya).' };
  }
  const height = parseDim(hRaw);
  if (height === 'bad') {
    return { params: null, error: 'height si sahihi (lazima iwe namba chanya).' };
  }

  let resize: ResizeMode = 'cover';
  if (rRaw !== undefined) {
    if (!RESIZE_MODES.has(rRaw)) {
      return {
        params: null,
        error: 'resize si sahihi (tumia cover, contain au fill).',
      };
    }
    resize = rRaw as ResizeMode;
  }

  let format: OutputFormat | undefined;
  if (fRaw !== undefined) {
    const f = fRaw.toLowerCase();
    if (!OUTPUT_FORMATS.has(f)) {
      return {
        params: null,
        error: 'format si sahihi (tumia webp, jpeg, png au avif).',
      };
    }
    format = f as OutputFormat;
  }

  let quality: number | undefined;
  if (qRaw !== undefined) {
    const q = Number.parseInt(qRaw, 10);
    if (!Number.isFinite(q) || q < 1 || q > 100) {
      return { params: null, error: 'quality si sahihi (1–100).' };
    }
    quality = q;
  }

  // Need at least one dimension OR a format change to be a real transform.
  if (width === undefined && height === undefined && format === undefined) {
    // Only resize/quality given with no dimension or format → nothing to do.
    return { params: null };
  }

  return {
    params: {
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      resize,
      ...(format !== undefined ? { format } : {}),
      ...(quality !== undefined ? { quality } : {}),
    },
  };
}

/** Parse a dimension: undefined→undefined, valid int→clamped, junk→'bad'. */
function parseDim(raw: string | undefined): number | undefined | 'bad' {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || !/^\d+$/.test(raw.trim())) return 'bad';
  return Math.min(n, MAX_DIMENSION);
}

/**
 * Stable cache key for a transformed variant. Deterministic across requests so
 * the same params always hit the same cached file; different params → new key
 * (natural invalidation). Includes the source object's identity + a content
 * fingerprint (size+mtime) so re-uploads bust the cache.
 */
export function transformCacheKey(
  bucket: string,
  path: string,
  params: TransformParams,
  fingerprint: { size: number; mtimeMs: number }
): string {
  const canonical = JSON.stringify({
    b: bucket,
    p: path,
    w: params.width ?? 0,
    h: params.height ?? 0,
    r: params.resize,
    f: params.format ?? 'orig',
    q: params.quality ?? 0,
    s: fingerprint.size,
    m: Math.floor(fingerprint.mtimeMs),
  });
  const hash = createHash('sha256').update(canonical).digest('hex');
  // Group by bucket for tidy on-disk layout; keep the extension for clarity.
  const ext = params.format ?? 'img';
  return `${bucket}/${hash}.${ext}`;
}

/** True when a stored MIME denotes a raster image sharp can likely process. */
export function isTransformable(mime: string | undefined): boolean {
  if (!mime) return false;
  const m = mime.toLowerCase();
  // SVG is an image/* but not a raster sharp resize target by default → skip.
  if (m === 'image/svg+xml') return false;
  return m.startsWith('image/');
}

/** The Content-Type to send for a given (possibly format-changing) transform. */
export function outputMime(
  params: TransformParams,
  sourceMime: string
): string {
  if (params.format) return FORMAT_MIME[params.format];
  return sourceMime;
}

export interface TransformOutput {
  data: Buffer;
  mime: string;
  width: number;
  height: number;
}

/**
 * Run the sharp pipeline over `input` and return the transformed bytes +
 * metadata. Imports sharp lazily. Throws on a non-image / corrupt buffer or any
 * sharp error — callers MUST catch and fall back to the original.
 */
export async function runTransform(
  input: Buffer,
  params: TransformParams,
  sourceMime: string
): Promise<TransformOutput> {
  const { default: sharp } = await import('sharp');
  // `failOn: 'none'` makes sharp tolerant of slightly-truncated inputs rather
  // than throwing immediately; a truly corrupt buffer still rejects below.
  let pipeline = sharp(input, { failOn: 'none' });

  // Validate it really is a raster image sharp understands.
  const meta = await pipeline.metadata();
  if (!meta.format || !meta.width || !meta.height) {
    throw new Error('Not a decodable raster image');
  }

  if (params.width || params.height) {
    pipeline = pipeline.resize({
      width: params.width,
      height: params.height,
      fit: params.resize,
      withoutEnlargement: false,
    });
  }

  const q = params.quality;
  switch (params.format) {
    case 'webp':
      pipeline = pipeline.webp(q ? { quality: q } : {});
      break;
    case 'jpeg':
      pipeline = pipeline.jpeg(q ? { quality: q } : {});
      break;
    case 'png':
      pipeline = pipeline.png(q ? { quality: q } : {});
      break;
    case 'avif':
      pipeline = pipeline.avif(q ? { quality: q } : {});
      break;
    default:
      // No format change: re-encode in the source format, applying quality
      // where the encoder supports it.
      if (q && (meta.format === 'jpeg' || meta.format === 'jpg')) {
        pipeline = pipeline.jpeg({ quality: q });
      } else if (q && meta.format === 'webp') {
        pipeline = pipeline.webp({ quality: q });
      }
      break;
  }

  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  return {
    data,
    mime: outputMime(params, sourceMime),
    width: info.width,
    height: info.height,
  };
}
