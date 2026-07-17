// netBridge.ts — drains net.http_request_queue and performs the actual HTTP
// call, matching real pg_net's async architecture (queue → worker → response
// row), so `net.http_post()`/`net.http_get()` called from a ported Supabase
// trigger need no changes to keep working. See 0017_supabase_compat_pg_net.sql.
//
// Poll-drain-then-listen: on start, and after every NOTIFY, process ALL
// pending rows (not just the one that triggered the NOTIFY) — a missed
// notification during a restart must not strand a queued request forever.

import type { FetchLike } from './dispatcher.js';
import type { NetQueueStore, QueuedRequest } from './netQueue.js';

export interface NetBridgeDeps {
  store: NetQueueStore;
  fetch: FetchLike;
  /** Called once per processed request, for /status or logging. */
  onProcessed?: (id: number, ok: boolean) => void;
}

export class NetBridge {
  private draining = false;
  private drainAgain = false;

  constructor(private readonly deps: NetBridgeDeps) {}

  /** Process every currently-pending request. Coalesces concurrent triggers
   *  (a NOTIFY arriving mid-drain just schedules one more pass, not a pile-up). */
  async drain(): Promise<void> {
    if (this.draining) {
      this.drainAgain = true;
      return;
    }
    this.draining = true;
    try {
      let requests: QueuedRequest[];
      try {
        requests = await this.deps.store.pending();
      } catch (e) {
        console.error('[webhooks/net] failed to load pending requests:', errMsg(e));
        return;
      }
      for (const req of requests) {
        await this.process(req);
      }
    } finally {
      this.draining = false;
      if (this.drainAgain) {
        this.drainAgain = false;
        void this.drain();
      }
    }
  }

  private async process(req: QueuedRequest): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), req.timeout_milliseconds);
    timer.unref?.();

    let statusCode: number | null = null;
    let content: string | null = null;
    let errorMsg: string | null = null;
    let ok = false;

    try {
      const res = await this.deps.fetch(req.url, {
        method: req.method,
        headers: req.headers ?? {},
        body: req.body ?? '',
        signal: controller.signal,
      });
      statusCode = res.status;
      ok = res.ok;
      if (!res.ok) errorMsg = `HTTP ${res.status}`;
    } catch (e) {
      errorMsg = errMsg(e);
    } finally {
      clearTimeout(timer);
    }

    try {
      await this.deps.store.complete({ id: req.id, statusCode, headers: null, content, errorMsg });
    } catch (e) {
      console.error(`[webhooks/net] failed to record outcome for request ${req.id}:`, errMsg(e));
    }
    this.deps.onProcessed?.(req.id, ok);
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
