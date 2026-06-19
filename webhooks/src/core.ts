// core.ts — the PURE webhook logic. No `pg`, no network, no node-specific I/O.
//
// This is the heart of the worker and is exhaustively unit-testable:
//   * parseNotification  — turn a raw NOTIFY string into a typed Notification.
//   * matchEndpoint      — does an endpoint care about this change?
//   * sign               — HMAC-SHA256 of a body (the X-Laetoli-Signature value).
//   * shouldRetry        — given an attempt outcome, do we try again?
//   * backoffMs          — how long to wait before attempt N.
//
// `sign` needs an HMAC primitive; rather than import node:crypto here (which
// would couple this module to Node and complicate testing), the caller injects
// a tiny `hmacSha256Hex` function. server.ts wires in the node:crypto one.

export type ChangeEvent = 'INSERT' | 'UPDATE' | 'DELETE';

/** A row-change notification, as published by the realtime.notify() trigger. */
export interface Notification {
  schema: string;
  table: string;
  type: ChangeEvent;
  record: Record<string, unknown> | null;
  old: Record<string, unknown> | null;
  /** true when the row was too large for NOTIFY and `record` was dropped. */
  truncated?: boolean;
}

/** A registered webhook endpoint (a row of webhooks.endpoints). */
export interface Endpoint {
  id: string;
  name: string | null;
  table_name: string;
  events: string[];
  url: string;
  secret: string | null;
  active: boolean;
}

/** The outcome of a single HTTP attempt. */
export interface AttemptResult {
  ok: boolean;
  statusCode: number | null;
  error: string | null;
}

const EVENTS: ReadonlySet<string> = new Set(['INSERT', 'UPDATE', 'DELETE']);

/**
 * Parse a raw NOTIFY payload string into a typed Notification, or null if it is
 * malformed / not a recognized change event. Mirrors realtime's parseNotification.
 */
export function parseNotification(raw: string): Notification | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.schema !== 'string' || typeof o.table !== 'string') return null;
  if (typeof o.type !== 'string' || !EVENTS.has(o.type)) return null;
  const record = isPlainObject(o.record) ? (o.record as Record<string, unknown>) : null;
  const old = isPlainObject(o.old) ? (o.old as Record<string, unknown>) : null;
  return {
    schema: o.schema,
    table: o.table,
    type: o.type as ChangeEvent,
    record,
    old,
    truncated: o.truncated === true,
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Does this endpoint fire for this change?
 *   * active must be true,
 *   * the event must be in the endpoint's events[],
 *   * the table_name must match — either a bare name against the NOTIFY `table`,
 *     or a qualified "schema.table" against `schema.table` (case-sensitive, as
 *     Postgres identifiers in the trigger are unquoted/lowercased already).
 */
export function matchEndpoint(ep: Endpoint, note: Notification): boolean {
  if (!ep.active) return false;
  if (!Array.isArray(ep.events) || !ep.events.includes(note.type)) return false;
  const target = (ep.table_name ?? '').trim();
  if (target.length === 0) return false;
  if (target.includes('.')) {
    return target === `${note.schema}.${note.table}`;
  }
  return target === note.table;
}

/** The exact JSON body POSTed to an endpoint. Stable shape for HMAC signing. */
export function buildBody(note: Notification): string {
  return JSON.stringify({
    schema: note.schema,
    table: note.table,
    type: note.type,
    record: note.record,
    old: note.old,
    ...(note.truncated ? { truncated: true } : {}),
  });
}

/**
 * Compute the X-Laetoli-Signature header value for a body + secret, given an
 * injected HMAC-SHA256-hex primitive. Returns null when no secret is set
 * (unsigned delivery). Format: "sha256=<hex>".
 */
export function sign(
  body: string,
  secret: string | null | undefined,
  hmacSha256Hex: (key: string, message: string) => string
): string | null {
  if (!secret) return null;
  return `sha256=${hmacSha256Hex(secret, body)}`;
}

/**
 * Should we make another attempt? Retry on network error or a 5xx / 429; do NOT
 * retry a 2xx (success) or other 4xx (client rejected it — retrying won't help).
 * Only while attempts remain.
 */
export function shouldRetry(result: AttemptResult, attempt: number, maxAttempts: number): boolean {
  if (attempt >= maxAttempts) return false;
  if (result.ok) return false;
  if (result.statusCode === null) return true; // network/timeout error
  if (result.statusCode === 429) return true; // rate-limited
  if (result.statusCode >= 500) return true; // server error
  return false; // other 4xx: client error, not retryable
}

/** Exponential backoff (ms) before a given 1-based attempt number. */
export function backoffMs(attempt: number, baseMs: number): number {
  // attempt 1 has no preceding wait; attempt 2 waits base, attempt 3 waits 2*base...
  if (attempt <= 1) return 0;
  return baseMs * 2 ** (attempt - 2);
}
