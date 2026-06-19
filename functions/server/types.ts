// The function-authoring contract. Operator-provided modules import nothing
// from us at runtime (they just default-export a handler), but TypeScript
// authors can import these types for editor help:
//
//   import type { FunctionContext, FunctionResult } from '@laetoli/functions';
//
// (The types are also re-exported from server/index.ts.)

import type { FunctionUser } from './jwt.js';

/** Context passed to every function handler. */
export interface FunctionContext {
  /** HTTP method of the incoming request (GET, POST, ...). */
  method: string;
  /** Lower-cased request headers. */
  headers: Record<string, string>;
  /** Parsed query string parameters. */
  query: Record<string, string | string[]>;
  /** Parsed JSON body (or undefined / raw value for non-JSON). */
  body: unknown;
  /** Environment bag exposed to the function (process.env by default). */
  env: Record<string, string | undefined>;
  /** The authenticated user, or null. Functions decide whether to require it. */
  user: FunctionUser | null;
  /** The trailing path after `/:name` (e.g. "/a/b" for `/fn/a/b`), or "". */
  path: string;
  /** Aborts when the per-invocation timeout fires — handlers may honour it. */
  signal: AbortSignal;
}

/** A function handler default-exports this signature. */
export type FunctionHandler = (
  ctx: FunctionContext
) => FunctionResult | Promise<FunctionResult>;

/**
 * What a handler may return:
 *   - a Response-like `{ status?, headers?, body }`, or
 *   - any plain JSON-serializable value (→ 200 JSON).
 */
export type FunctionResult = ResponseLike | JsonValue;

export interface ResponseLike {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A loaded module — its default export is the handler. */
export interface LoadedFunction {
  name: string;
  handler: FunctionHandler;
}

/** Type guard: is this value a Response-like envelope (vs. a bare JSON value)? */
export function isResponseLike(v: unknown): v is ResponseLike {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const o = v as Record<string, unknown>;
  return 'status' in o || 'headers' in o || 'body' in o;
}
