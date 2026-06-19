// Input validation — pure functions. The admin surface is key-gated, but we
// still validate identifiers (defence in depth) and reject obviously malformed
// pagination so the catalog whitelist in handlers has clean inputs to work with.

export interface ValidationResult {
  ok: boolean;
  error?: string;
}

const OK: ValidationResult = { ok: true };

// A SQL identifier we are willing to even ASK the catalog about. The real
// authority is the live catalog (handlers compare against getTableShape), but
// this cheap pre-filter rejects junk and keeps error messages clean.
// Allows unicode letters/digits/underscore; 1–63 bytes (Postgres NAMEDATALEN).
const IDENT_RE = /^[\p{L}_][\p{L}\p{N}_$]{0,62}$/u;

export function isValidIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENT_RE.test(value);
}

export function validateIdentifier(value: unknown, what: string): ValidationResult {
  if (!isValidIdentifier(value)) {
    return {
      ok: false,
      error: `Kitambulisho si sahihi: ${what}. (Invalid identifier: ${what}.)`,
    };
  }
  return OK;
}

/** Clamp a query-string limit to a sane range. Default 100, max 1000. */
export function parseLimit(value: unknown, def = 100, max = 1000): number {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(n, max);
}

/** Parse a non-negative offset. */
export function parseOffset(value: unknown): number {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}

/**
 * Parse an `order` query param of the form `column` or `column.asc` /
 * `column.desc`. Returns null when absent. The column is validated as an
 * identifier here and re-checked against the table's columns in the handler.
 */
export function parseOrder(
  value: unknown
): { column: string; dir: 'asc' | 'desc' } | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const [col, rawDir] = value.split('.');
  if (!isValidIdentifier(col)) return null;
  const dir = rawDir?.toLowerCase() === 'desc' ? 'desc' : 'asc';
  return { column: col, dir };
}

/** A plain object suitable as a values/where/set map (no arrays, no null root). */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v)
  );
}
