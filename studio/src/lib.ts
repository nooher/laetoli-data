// Pure, dependency-free helpers — kept out of components and unit-tested.

import type { Column, Row } from './types';

/** Normalize an admin API base URL: trim, drop trailing slashes. Empty -> '/admin'. */
export function normalizeBaseUrl(input: string | null | undefined): string {
  const v = (input ?? '').trim();
  if (!v) return '/admin';
  return v.replace(/\/+$/, '');
}

/** Join a normalized base with a path that begins with '/'. */
export function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${b}${p}`;
}

/**
 * Build a pk-based `where` object for PATCH/DELETE from a row + its columns.
 * Prefers primary-key columns; falls back to ALL columns if no pk is defined
 * (so updates/deletes still target a single row by full-value match).
 * Returns null when no usable identifying columns exist.
 */
export function buildWhereFromRow(
  columns: Column[],
  row: Row,
): Record<string, unknown> | null {
  const pks = columns.filter((c) => c.is_pk);
  const keyCols = pks.length > 0 ? pks : columns;
  if (keyCols.length === 0) return null;
  const where: Record<string, unknown> = {};
  for (const c of keyCols) {
    where[c.name] = row[c.name] ?? null;
  }
  return where;
}

/** Whether a row can be uniquely identified for edit/delete. */
export function hasPrimaryKey(columns: Column[]): boolean {
  return columns.some((c) => c.is_pk);
}

/** Human display of any cell value for a read-only grid. */
export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '∅';
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** True when the value should render in the "null/empty" style. */
export function isNullish(value: unknown): boolean {
  return value === null || value === undefined;
}

/** Pretty byte sizes for storage objects. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || Number.isNaN(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const fixed = v.toFixed(v >= 10 ? 0 : 1).replace(/\.0$/, '');
  return `${fixed} ${units[i]}`;
}

/** ISO-ish timestamp -> compact local string; passthrough on failure. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Coerce a string from a text input into a JSON-ish value for insert/update.
 * Empty string -> null. "true"/"false"/"null" -> primitives. Numeric -> number.
 * Anything wrapped in {}/[] -> parsed JSON. Otherwise the raw string.
 */
export function coerceInput(raw: string): unknown {
  const t = raw.trim();
  if (t === '') return null;
  if (t === 'null') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try {
      return JSON.parse(t);
    } catch {
      return raw;
    }
  }
  return raw;
}

/** Turn a cell value into an editable text representation. */
export function toInputString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * Mask an API key for display: show the public prefix, then a fixed run of
 * bullets standing in for the (never-displayed) secret. Never reveals the secret.
 * Accepts either a bare prefix or a full "<prefix>.<secret>" string.
 */
export function maskKey(prefix: string | null | undefined): string {
  const p = (prefix ?? '').trim();
  const head = p.includes('.') ? p.split('.')[0] : p;
  if (!head) return '••••••••';
  return `${head}••••••••`;
}

/** Compact display for a request count (e.g. usage totals). */
export function formatCount(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return n.toLocaleString();
}

/** Group policies (or any keyed records) by "schema.table". */
export function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = map.get(k);
    if (arr) arr.push(it);
    else map.set(k, [it]);
  }
  return map;
}
