// core.ts — the PURE scheduler logic. No `pg`, no network, no node-specific I/O.
//
// This is the heart of the worker and is exhaustively unit-testable:
//   * isDue        — given a job + now, is it due to run?
//   * computeNextRun — the cron instant strictly after a reference time.
//   * planAction   — decide what a job's execution should DO (sql vs http) and
//                    validate it, without performing any I/O.
//   * sign         — HMAC-SHA256 of a body (the X-Laetoli-Signature value).
//   * buildHttp    — the exact body + headers for a kind=http POST.
//   * authorizeRunNow — does an incoming run-now request carry a valid key?
//
// `sign` needs an HMAC primitive; rather than import node:crypto here (which
// would couple this module to Node and complicate testing), the caller injects
// a tiny `hmacSha256Hex` function. server.ts wires in the node:crypto one.

import { parseCron, nextRun } from './cron.js';

export type JobKind = 'sql' | 'http';

/** A registered job (a row of scheduler.jobs). */
export interface Job {
  id: string;
  name: string | null;
  cron: string;
  kind: JobKind;
  sql: string | null;
  url: string | null;
  headers: Record<string, unknown> | null;
  body: unknown;
  secret: string | null;
  active: boolean;
  next_run: string | null; // ISO timestamp or null
}

/** The outcome of executing a job once. */
export interface RunResult {
  ok: boolean;
  /** HTTP status for kind=http (null for kind=sql or on network error). */
  statusCode: number | null;
  error: string | null;
  /** Free-form success detail, e.g. "rows: 3". */
  info: string | null;
}

/**
 * Is this job due to run at `now`?
 *   * active must be true,
 *   * next_run must be set AND <= now.
 * A job with a null next_run is NOT due yet — the worker computes its next_run
 * first (see computeNextRun) and only fires once that instant has passed. This
 * avoids firing a brand-new job immediately on registration.
 */
export function isDue(job: Job, now: Date): boolean {
  if (!job.active) return false;
  if (!job.next_run) return false;
  const due = Date.parse(job.next_run);
  if (!Number.isFinite(due)) return false;
  return due <= now.getTime();
}

/**
 * The next cron instant strictly after `from`. Throws if the cron string is
 * malformed (callers catch + log so one bad job never crashes the worker).
 */
export function computeNextRun(cron: string, from: Date): Date {
  return nextRun(parseCron(cron), from);
}

/** A validated, ready-to-execute action plan for a job. */
export type ActionPlan =
  | { kind: 'sql'; sql: string }
  | { kind: 'http'; url: string }
  | { kind: 'invalid'; reason: string };

/**
 * Decide what executing this job entails — purely from its fields, no I/O.
 * Validates the action so the executor can fail fast with a clear error that
 * still gets logged as a (failed) run.
 */
export function planAction(job: Job): ActionPlan {
  if (job.kind === 'sql') {
    const sql = (job.sql ?? '').trim();
    if (sql.length === 0) return { kind: 'invalid', reason: 'kind=sql job has empty sql' };
    return { kind: 'sql', sql };
  }
  if (job.kind === 'http') {
    const url = (job.url ?? '').trim();
    if (url.length === 0) return { kind: 'invalid', reason: 'kind=http job has empty url' };
    if (!/^https?:\/\//i.test(url)) {
      return { kind: 'invalid', reason: `kind=http job url must be http(s): "${url}"` };
    }
    return { kind: 'http', url };
  }
  return { kind: 'invalid', reason: `unknown job kind: "${String((job as Job).kind)}"` };
}

/**
 * Compute the X-Laetoli-Signature header value for a body + secret, given an
 * injected HMAC-SHA256-hex primitive. Returns null when no secret is set
 * (unsigned delivery). Format: "sha256=<hex>". Identical to webhooks.
 */
export function sign(
  body: string,
  secret: string | null | undefined,
  hmacSha256Hex: (key: string, message: string) => string
): string | null {
  if (!secret) return null;
  return `sha256=${hmacSha256Hex(secret, body)}`;
}

/** The exact JSON body POSTed for a kind=http job. Stable shape for HMAC. */
export function buildHttpBody(job: Job): string {
  // job.body is the operator-supplied payload (defaults to {}). We wrap it with
  // a small envelope so receivers know which job fired.
  const payload = job.body === null || job.body === undefined ? {} : job.body;
  return JSON.stringify({
    job: { id: job.id, name: job.name },
    body: payload,
  });
}

/** Build the full header set for a kind=http POST (incl. optional signature). */
export function buildHttpHeaders(
  job: Job,
  body: string,
  hmacSha256Hex: (key: string, message: string) => string
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'Laetoli-Data-Scheduler/0.1',
    'X-Laetoli-Job': job.id,
  };
  // Operator-supplied extra headers (string values only).
  if (job.headers && typeof job.headers === 'object') {
    for (const [k, v] of Object.entries(job.headers)) {
      if (typeof v === 'string') headers[k] = v;
      else if (v !== null && v !== undefined) headers[k] = String(v);
    }
  }
  const signature = sign(body, job.secret, hmacSha256Hex);
  if (signature) headers['X-Laetoli-Signature'] = signature;
  return headers;
}

/**
 * Is an incoming run-now request authorized? When no key is configured, allow
 * (the endpoint is internal-only). When a key is configured, the request must
 * present it via `X-Admin-Key` or `Authorization: Bearer <key>`.
 */
export function authorizeRunNow(
  configuredKey: string | null,
  presented: { adminKey?: string | null; authorization?: string | null }
): boolean {
  if (!configuredKey) return true;
  if (presented.adminKey && presented.adminKey === configuredKey) return true;
  const auth = presented.authorization ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  if (m && m[1] === configuredKey) return true;
  return false;
}
