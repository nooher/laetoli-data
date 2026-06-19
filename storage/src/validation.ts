// Input validation — pure functions, Kiswahili error messages.
// Bucket + object-path rules. Path safety (no traversal) lives here AND in
// store.ts (defence in depth).

export interface ValidationResult {
  ok: boolean;
  /** Kiswahili error message when ok === false. */
  error?: string;
}

const OK: ValidationResult = { ok: true };

// Bucket: 3–63 chars, lowercase letters/digits/.-_ , must start alnum.
const BUCKET_RE = /^[a-z0-9][a-z0-9._-]{2,62}$/;

export function validateBucketName(value: unknown): ValidationResult {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { ok: false, error: 'Jina la ndoo (bucket) linahitajika.' };
  }
  const v = value.trim();
  if (v.length < 3) {
    return { ok: false, error: 'Jina la ndoo ni fupi mno (angalau herufi 3).' };
  }
  if (v.length > 63) {
    return { ok: false, error: 'Jina la ndoo ni refu mno (zaidi ya herufi 63).' };
  }
  if (!BUCKET_RE.test(v)) {
    return {
      ok: false,
      error:
        'Jina la ndoo linaruhusu herufi ndogo, namba, nukta, mstari na kistari tu (lazima lianze na herufi au namba).',
    };
  }
  return OK;
}

/**
 * Validate + normalize an object path (the part after the bucket).
 * Rejects traversal (`..`), absolute paths, NUL bytes, and empty segments.
 * Returns a normalized forward-slash path on success.
 */
export function validateObjectPath(
  value: unknown
): ValidationResult & { path?: string } {
  if (typeof value !== 'string' || value.length === 0) {
    return { ok: false, error: 'Njia ya faili inahitajika.' };
  }
  if (value.includes('\0')) {
    return { ok: false, error: 'Njia ya faili si sahihi.' };
  }
  if (value.length > 1024) {
    return { ok: false, error: 'Njia ya faili ni refu mno.' };
  }
  // Normalize separators, drop leading slashes.
  const raw = value.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = raw.split('/');
  const clean: string[] = [];
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue; // collapse empty / current
    if (seg === '..') {
      return { ok: false, error: 'Njia ya faili haina ruhusa (".." imekatazwa).' };
    }
    clean.push(seg);
  }
  if (clean.length === 0) {
    return { ok: false, error: 'Njia ya faili inahitajika.' };
  }
  return { ok: true, path: clean.join('/') };
}
