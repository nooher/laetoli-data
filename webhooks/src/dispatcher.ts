// dispatcher.ts — orchestrates one notification end-to-end:
//   parse -> match active endpoints -> for each: POST (HMAC-signed) with
//   retry+backoff -> record a deliveries row with the final outcome.
//
// Everything I/O is INJECTED (fetch, store, hmac, sleep) so the whole flow is
// unit-testable with no Postgres and no network. server.ts wires in the real
// node fetch + node:crypto HMAC + a real sleep + the pg store.

import {
  type Notification,
  type Endpoint,
  type AttemptResult,
  matchEndpoint,
  buildBody,
  sign,
  shouldRetry,
  backoffMs,
} from './core.js';
import type { Store } from './db.js';

/** A minimal fetch surface — node's global fetch satisfies this. */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  }
) => Promise<{ ok: boolean; status: number }>;

export interface DispatcherDeps {
  store: Store;
  fetch: FetchLike;
  hmacSha256Hex: (key: string, message: string) => string;
  sleep: (ms: number) => Promise<void>;
  maxAttempts: number;
  backoffBaseMs: number;
  requestTimeoutMs: number;
  /** Optional sink for the last-delivery snapshot used by /status. */
  onDelivery?: (snapshot: DeliverySnapshot) => void;
}

export interface DeliverySnapshot {
  endpointId: string;
  url: string;
  event: string;
  ok: boolean;
  statusCode: number | null;
  attempts: number;
  at: string; // ISO timestamp
}

export class Dispatcher {
  constructor(private readonly deps: DispatcherDeps) {}

  /**
   * Handle one parsed notification: fan out to every matching active endpoint.
   * Endpoints are processed concurrently; a failure on one never affects others
   * or crashes the worker.
   */
  async handle(note: Notification): Promise<void> {
    let endpoints: Endpoint[];
    try {
      endpoints = await this.deps.store.activeEndpoints();
    } catch (e) {
      console.error('[webhooks] failed to load endpoints:', errMsg(e));
      return;
    }
    const matches = endpoints.filter((ep) => matchEndpoint(ep, note));
    if (matches.length === 0) return;

    await Promise.all(
      matches.map((ep) =>
        this.deliver(ep, note).catch((e) =>
          // deliver() already swallows its own errors; this is belt-and-braces.
          console.error('[webhooks] unexpected deliver error:', errMsg(e))
        )
      )
    );
  }

  /** POST to one endpoint with retry+backoff, then record the final outcome. */
  private async deliver(ep: Endpoint, note: Notification): Promise<void> {
    const body = buildBody(note);
    const signature = sign(body, ep.secret, this.deps.hmacSha256Hex);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'Laetoli-Data-Webhooks/0.1',
      'X-Laetoli-Event': note.type,
      'X-Laetoli-Table': `${note.schema}.${note.table}`,
      'X-Laetoli-Delivery-Endpoint': ep.id,
    };
    if (signature) headers['X-Laetoli-Signature'] = signature;

    let attempt = 0;
    let last: AttemptResult = { ok: false, statusCode: null, error: 'no attempt made' };

    while (attempt < this.deps.maxAttempts) {
      attempt += 1;
      const wait = backoffMs(attempt, this.deps.backoffBaseMs);
      if (wait > 0) await this.deps.sleep(wait);

      last = await this.attempt(ep.url, headers, body);
      if (!shouldRetry(last, attempt, this.deps.maxAttempts)) break;
    }

    // Record the final outcome — one deliveries row per delivery.
    try {
      await this.deps.store.recordDelivery({
        endpointId: ep.id,
        event: note.type,
        statusCode: last.statusCode,
        ok: last.ok,
        error: last.ok ? null : last.error,
        attempts: attempt,
        payload: body,
      });
    } catch (e) {
      // A logging failure must never bubble up and kill the worker.
      console.error('[webhooks] failed to record delivery:', errMsg(e));
    }

    this.deps.onDelivery?.({
      endpointId: ep.id,
      url: ep.url,
      event: note.type,
      ok: last.ok,
      statusCode: last.statusCode,
      attempts: attempt,
      at: new Date().toISOString(),
    });
  }

  /** A single HTTP attempt with a hard timeout. Never throws. */
  private async attempt(
    url: string,
    headers: Record<string, string>,
    body: string
  ): Promise<AttemptResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deps.requestTimeoutMs);
    timer.unref?.();
    try {
      const res = await this.deps.fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      return { ok: res.ok, statusCode: res.status, error: res.ok ? null : `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, statusCode: null, error: errMsg(e) };
    } finally {
      clearTimeout(timer);
    }
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
