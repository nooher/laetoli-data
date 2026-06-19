// executor.ts — orchestrates job execution end-to-end:
//   plan action -> execute (sql via pg | http POST with HMAC) -> record a
//   scheduler.runs row -> advance jobs.next_run to the next cron instant.
//
// Everything I/O is INJECTED (store, fetch, hmac, clock) so the whole flow is
// unit-testable with no Postgres and no network. server.ts wires in the real
// node fetch + node:crypto HMAC + the pg store + a real clock.

import {
  type Job,
  type RunResult,
  planAction,
  computeNextRun,
  buildHttpBody,
  buildHttpHeaders,
} from './core.js';
import type { Store, RunRecord } from './db.js';

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

export interface ExecutorDeps {
  store: Store;
  fetch: FetchLike;
  hmacSha256Hex: (key: string, message: string) => string;
  /** Injected clock so tests are deterministic. */
  now: () => Date;
  requestTimeoutMs: number;
  /** Optional sink for the last-run snapshot used by /status. */
  onRun?: (snapshot: RunSnapshot) => void;
  log?: (msg: string) => void;
}

export interface RunSnapshot {
  jobId: string;
  name: string | null;
  kind: string;
  ok: boolean;
  statusCode: number | null;
  error: string | null;
  info: string | null;
  at: string; // ISO
  trigger: 'cron' | 'manual';
}

export class Executor {
  constructor(private readonly deps: ExecutorDeps) {}

  /**
   * Scan active jobs: schedule any with no next_run, then run those that are due.
   * One bad job never affects others or crashes the worker.
   */
  async tick(): Promise<void> {
    let jobs: Job[];
    try {
      jobs = await this.deps.store.activeJobs();
    } catch (e) {
      this.log(`failed to load jobs: ${errMsg(e)}`);
      return;
    }
    const now = this.deps.now();
    await Promise.all(
      jobs.map((job) =>
        this.maybeRun(job, now).catch((e) =>
          this.log(`unexpected error for job ${job.id}: ${errMsg(e)}`)
        )
      )
    );
  }

  /** For one job: if it has no next_run, schedule it; if due, run it. */
  private async maybeRun(job: Job, now: Date): Promise<void> {
    // No next_run yet -> compute the first one and persist (don't run now).
    if (!job.next_run) {
      await this.scheduleNext(job, now);
      return;
    }
    const due = Date.parse(job.next_run);
    if (!Number.isFinite(due) || due > now.getTime()) return; // not due
    await this.run(job, 'cron');
    // After a cron run, advance to the next instant.
    await this.scheduleNext(job, this.deps.now());
  }

  /** Compute + persist the next cron instant for a job. Never throws. */
  private async scheduleNext(job: Job, from: Date): Promise<void> {
    try {
      const next = computeNextRun(job.cron, from);
      await this.deps.store.setNextRun(job.id, next.toISOString());
    } catch (e) {
      // Bad cron string — log it; the job simply won't fire until fixed.
      this.log(`job ${job.id} has invalid cron "${job.cron}": ${errMsg(e)}`);
    }
  }

  /**
   * Execute a job ONCE (used by cron ticks and by run-now). Records a run row
   * and returns the outcome. Never throws.
   */
  async run(job: Job, trigger: 'cron' | 'manual'): Promise<RunResult> {
    const startedAt = this.deps.now().toISOString();
    const result = await this.execute(job);
    const finishedAt = this.deps.now().toISOString();

    const record: RunRecord = {
      jobId: job.id,
      startedAt,
      finishedAt,
      ok: result.ok,
      statusCode: result.statusCode,
      error: result.ok ? null : result.error,
      info: result.info,
    };
    try {
      await this.deps.store.recordRun(record);
    } catch (e) {
      // A logging failure must never bubble up and kill the worker.
      this.log(`failed to record run for job ${job.id}: ${errMsg(e)}`);
    }

    this.deps.onRun?.({
      jobId: job.id,
      name: job.name,
      kind: job.kind,
      ok: result.ok,
      statusCode: result.statusCode,
      error: result.ok ? null : result.error,
      info: result.info,
      at: finishedAt,
      trigger,
    });
    return result;
  }

  /** Perform the action (no logging) — sql via pg, http via fetch. */
  private async execute(job: Job): Promise<RunResult> {
    const plan = planAction(job);
    if (plan.kind === 'invalid') {
      return { ok: false, statusCode: null, error: plan.reason, info: null };
    }
    if (plan.kind === 'sql') {
      const res = await this.deps.store.runJobSql(plan.sql);
      return {
        ok: res.ok,
        statusCode: null,
        error: res.ok ? null : res.error,
        info: res.ok ? `rows: ${res.rowCount ?? 0}` : null,
      };
    }
    // kind === 'http'
    return this.postHttp(job, plan.url);
  }

  /** A single HTTP POST with a hard timeout. Never throws. */
  private async postHttp(job: Job, url: string): Promise<RunResult> {
    const body = buildHttpBody(job);
    const headers = buildHttpHeaders(job, body, this.deps.hmacSha256Hex);
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
      return {
        ok: res.ok,
        statusCode: res.status,
        error: res.ok ? null : `HTTP ${res.status}`,
        info: res.ok ? `POST ${url} -> ${res.status}` : null,
      };
    } catch (e) {
      return { ok: false, statusCode: null, error: errMsg(e), info: null };
    } finally {
      clearTimeout(timer);
    }
  }

  private log(msg: string): void {
    (this.deps.log ?? ((m: string) => console.error(`[scheduler] ${m}`)))(msg);
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
