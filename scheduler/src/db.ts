// db.ts — the database gateway, behind an interface so the executor can be
// tested with no live Postgres. Production uses `createPgStore` (a pg.Pool);
// tests inject a `FakeStore`.

import pg from 'pg';
import type { SchedulerConfig } from './config.js';
import type { Job } from './core.js';

/** A run-log row to persist into scheduler.runs. */
export interface RunRecord {
  jobId: string;
  startedAt: string; // ISO
  finishedAt: string; // ISO
  ok: boolean;
  statusCode: number | null;
  error: string | null;
  info: string | null;
}

/** Outcome of running a job's SQL statement. */
export interface SqlExecResult {
  ok: boolean;
  rowCount: number | null;
  error: string | null;
}

/** Everything the executor needs from the database. */
export interface Store {
  /** Active jobs — the executor filters/dues in-memory via isDue. */
  activeJobs(): Promise<Job[]>;
  /** Fetch one job by id (for run-now). Null when missing. */
  getJob(id: string): Promise<Job | null>;
  /** Run a job's SQL statement; capture rowcount / error. Never throws. */
  runJobSql(sql: string): Promise<SqlExecResult>;
  /** Append one run-log row. Must never throw the worker down. */
  recordRun(r: RunRecord): Promise<void>;
  /** Advance a job's next_run (ISO) after a run / on first scheduling. */
  setNextRun(jobId: string, nextRunIso: string): Promise<void>;
  /** For /status: total + ok run counts. */
  counts(): Promise<{ total: number; ok: number }>;
  close(): Promise<void>;
}

const JOB_COLUMNS =
  'id, name, cron, kind, sql, url, headers, body, secret, active, ' +
  "to_char(next_run AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS next_run";

/** Postgres-backed store (pg.Pool). Connects AS laetoli_scheduler. */
export function createPgStore(config: SchedulerConfig): Store {
  const pool = config.databaseUrl
    ? new pg.Pool({ connectionString: config.databaseUrl, max: 4 })
    : new pg.Pool({
        host: config.pg.host,
        port: config.pg.port,
        user: config.pg.user,
        password: config.pg.password,
        database: config.pg.database,
        max: 4,
      });

  return {
    async activeJobs() {
      const { rows } = await pool.query(
        `SELECT ${JOB_COLUMNS} FROM scheduler.jobs WHERE active = true`
      );
      return rows as Job[];
    },
    async getJob(id) {
      const { rows } = await pool.query(
        `SELECT ${JOB_COLUMNS} FROM scheduler.jobs WHERE id = $1`,
        [id]
      );
      return (rows[0] as Job | undefined) ?? null;
    },
    async runJobSql(sql) {
      // A dedicated client so a failing/aborting statement doesn't poison the
      // pool. The statement runs AS laetoli_scheduler (member of laetoli_admin).
      const client = await pool.connect();
      try {
        const res = await client.query(sql);
        // Multi-statement strings return an array of results; take the last.
        const last = Array.isArray(res) ? res[res.length - 1] : res;
        const rowCount = last && typeof last.rowCount === 'number' ? last.rowCount : null;
        return { ok: true, rowCount, error: null };
      } catch (e) {
        return { ok: false, rowCount: null, error: errMsg(e) };
      } finally {
        client.release();
      }
    },
    async recordRun(r) {
      await pool.query(
        `INSERT INTO scheduler.runs
           (job_id, started_at, finished_at, ok, status_code, error, info)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [r.jobId, r.startedAt, r.finishedAt, r.ok, r.statusCode, r.error, r.info]
      );
    },
    async setNextRun(jobId, nextRunIso) {
      await pool.query(`UPDATE scheduler.jobs SET next_run = $2 WHERE id = $1`, [
        jobId,
        nextRunIso,
      ]);
    },
    async counts() {
      const { rows } = await pool.query(
        `SELECT count(*)::bigint AS total,
                count(*) FILTER (WHERE ok)::bigint AS ok
           FROM scheduler.runs`
      );
      const r = rows[0] ?? { total: '0', ok: '0' };
      return { total: Number(r.total), ok: Number(r.ok) };
    },
    async close() {
      await pool.end();
    },
  };
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** In-memory store for tests. */
export class FakeStore implements Store {
  jobs: Job[] = [];
  runs: RunRecord[] = [];
  nextRuns: Record<string, string> = {};
  /** Queue of canned SQL outcomes, consumed FIFO by runJobSql. */
  sqlResults: SqlExecResult[] = [];
  recordShouldThrow = false;

  constructor(jobs: Job[] = []) {
    this.jobs = jobs;
  }
  async activeJobs(): Promise<Job[]> {
    return this.jobs.filter((j) => j.active);
  }
  async getJob(id: string): Promise<Job | null> {
    return this.jobs.find((j) => j.id === id) ?? null;
  }
  async runJobSql(_sql: string): Promise<SqlExecResult> {
    return this.sqlResults.shift() ?? { ok: true, rowCount: 0, error: null };
  }
  async recordRun(r: RunRecord): Promise<void> {
    if (this.recordShouldThrow) throw new Error('db down');
    this.runs.push(r);
  }
  async setNextRun(jobId: string, nextRunIso: string): Promise<void> {
    this.nextRuns[jobId] = nextRunIso;
    const j = this.jobs.find((x) => x.id === jobId);
    if (j) j.next_run = nextRunIso;
  }
  async counts(): Promise<{ total: number; ok: number }> {
    return { total: this.runs.length, ok: this.runs.filter((r) => r.ok).length };
  }
  async close(): Promise<void> {
    /* no-op */
  }
}
