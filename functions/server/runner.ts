// Invokes a loaded handler under a timeout and normalizes its result into a
// concrete `{ status, headers, body }`. Pure/injectable — no Express here, so
// it is trivially unit-testable.

import {
  isResponseLike,
  type FunctionContext,
  type FunctionHandler,
  type ResponseLike,
} from './types.js';

export interface InvokeOutcome {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export class FunctionTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Function timed out after ${timeoutMs}ms`);
    this.name = 'FunctionTimeoutError';
  }
}

export interface RunnerOptions {
  timeoutMs: number;
  /** Override "now"/scheduling for tests; defaults to global timers. */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

/**
 * Run a handler with a hard timeout. The handler receives `ctx.signal` (an
 * AbortSignal) and may honour it, but even a handler that ignores it cannot
 * extend the response past the timeout: we race it against the deadline and
 * reject with FunctionTimeoutError. (Node can't forcibly kill a runaway sync
 * loop in-process — that's the documented v2/Deno-isolate upgrade.)
 */
export async function runHandler(
  handler: FunctionHandler,
  ctx: Omit<FunctionContext, 'signal'>,
  opts: RunnerOptions
): Promise<InvokeOutcome> {
  const setT = opts.setTimeoutFn ?? setTimeout;
  const clearT = opts.clearTimeoutFn ?? clearTimeout;
  const controller = new AbortController();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setT(() => {
      controller.abort();
      reject(new FunctionTimeoutError(opts.timeoutMs));
    }, opts.timeoutMs);
  });

  const fullCtx: FunctionContext = { ...ctx, signal: controller.signal };

  try {
    const result = await Promise.race([
      Promise.resolve().then(() => handler(fullCtx)),
      timeout,
    ]);
    return normalize(result);
  } finally {
    if (timer) clearT(timer);
  }
}

/** Coerce a handler's return value into a concrete HTTP outcome. */
export function normalize(result: unknown): InvokeOutcome {
  if (result === undefined) {
    return { status: 204, headers: {}, body: undefined };
  }
  if (isResponseLike(result)) {
    const r = result as ResponseLike;
    const status = typeof r.status === 'number' ? r.status : 200;
    const headers = r.headers ?? {};
    return { status, headers, body: r.body };
  }
  // Bare JSON-serializable value → 200 JSON.
  return { status: 200, headers: {}, body: result };
}
