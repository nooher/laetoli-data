# Scheduled Jobs (sovereign cron)

Time-driven automation for Laetoli Data. The scheduler is the cron counterpart
to the event-driven [webhooks](./WEBHOOKS.md): instead of reacting to row
changes, it runs **registered jobs on a cron schedule**. Each job performs an
**action** — run a SQL statement, or POST to an HTTP endpoint — and every
execution is recorded in a run log.

- **Worker service:** `scheduler/` (`@laetoli/scheduler`), port **9992**.
- **Schema:** `scheduler.jobs` (registered jobs) + `scheduler.runs` (run log).
- **DB role:** `laetoli_scheduler` (LOGIN, member of `laetoli_admin`).
- **Migration:** `db/migrations/0008_scheduler.sql` (init: `db/init/11_scheduler.sql`).

The worker wakes on a short interval (default **30s**, `SCHEDULER_TICK_MS`),
finds jobs whose `next_run` is due, executes each, writes a `scheduler.runs`
row, and advances `next_run` to the next cron instant. A brand-new job is not
fired immediately on registration — its first `next_run` is computed on the next
tick and it fires once that instant passes.

---

## Registering a job

Jobs are **admin-managed only** (see [SQL security](#sql-security-caveat)).
Register them via SQL as `laetoli_admin` / through the admin service — never via
PostgREST or any untrusted path.

### A SQL job

```sql
INSERT INTO scheduler.jobs (name, cron, kind, sql)
VALUES (
  'nightly-rollup',
  '0 2 * * *',                       -- 02:00 UTC daily
  'sql',
  $$INSERT INTO public.daily_stats (day, n)
    SELECT current_date, count(*) FROM public.events$$
);
```

`kind='sql'` runs the `sql` statement against this database as
`laetoli_scheduler`. The run log records `info = 'rows: <n>'` on success.

### An HTTP job

```sql
INSERT INTO scheduler.jobs (name, cron, kind, url, body, secret, headers)
VALUES (
  'hourly-ping',
  '0 * * * *',                       -- top of every hour
  'http',
  'http://functions:9995/cron-tick',
  '{"source":"scheduler"}'::jsonb,   -- request body (defaults to {} if null)
  'a-long-random-secret',            -- optional HMAC signing key
  '{"X-Env":"prod"}'::jsonb          -- optional extra request headers
);
```

`kind='http'` POSTs a JSON envelope to `url`:

```json
{ "job": { "id": "<uuid>", "name": "hourly-ping" }, "body": { "source": "scheduler" } }
```

Headers always include `Content-Type: application/json`,
`User-Agent: Laetoli-Data-Scheduler/0.1`, and `X-Laetoli-Job: <id>`. When
`secret` is set, the body is HMAC-SHA256 signed and sent as
`X-Laetoli-Signature: sha256=<hex>` — identical to the webhooks convention, so
the same receiver-side verification works.

---

## Cron format

Standard 5-field cron, evaluated in **UTC**:

```
┌─ minute (0–59)
│ ┌─ hour (0–23)
│ │ ┌─ day of month (1–31)
│ │ │ ┌─ month (1–12)
│ │ │ │ ┌─ day of week (0–6, Sun=0; 7 also = Sun)
│ │ │ │ │
* * * * *
```

Each field accepts `*`, a list `a,b,c`, a range `a-b`, a step `*/n` or `a-b/n`.
Day-of-month / day-of-week use the standard Vixie-cron OR semantics when both
are restricted. Examples:

| Cron          | Meaning                          |
|---------------|----------------------------------|
| `*/5 * * * *` | every 5 minutes                  |
| `0 2 * * *`   | 02:00 UTC daily                  |
| `0 * * * *`   | top of every hour                |
| `0 0 * * 1`   | 00:00 UTC every Monday           |
| `30 6 1 * *`  | 06:30 UTC on the 1st of the month|

(The parser is vendored from `backup/src/cron.ts` — the same dependency-free
module the backup service uses.)

---

## Run now

To execute a job immediately on demand (testing, ops, or a one-off), POST to the
worker:

```
POST /run/:jobId
```

```bash
# Internal Docker network (or via the host if you publish/proxy the port):
curl -X POST http://scheduler:9992/run/<job-uuid>
```

Response:

```json
{ "jobId": "<uuid>", "triggered": "manual",
  "result": { "ok": true, "statusCode": null, "error": null, "info": "rows: 3" } }
```

This runs the job once, records a `scheduler.runs` row (just like a cron tick),
but does **not** alter `next_run`.

### Gating run-now

- **Unset key (default):** run-now is open. This is safe because the service is
  only reachable on the internal Docker network — it is *not* published to the
  host and *not* proxied by caddy unless you add a route.
- **Set `SCHEDULER_ADMIN_KEY`** (falls back to `ADMIN_API_KEY`): run-now then
  requires the key via `X-Admin-Key: <key>` or `Authorization: Bearer <key>`.

```bash
curl -X POST http://scheduler:9992/run/<job-uuid> -H "X-Admin-Key: $ADMIN_API_KEY"
```

---

## The run log

Every execution appends one row to `scheduler.runs`:

| column        | meaning                                                    |
|---------------|-----------------------------------------------------------|
| `job_id`      | the job that ran (FK, cascade-deleted)                     |
| `started_at`  | when execution began                                      |
| `finished_at` | when execution completed                                  |
| `ok`          | `true` when it succeeded (SQL ran / HTTP returned 2xx)    |
| `status_code` | HTTP status for `kind=http` (NULL for `kind=sql`)         |
| `error`       | failure message (NULL when `ok`)                          |
| `info`        | success detail, e.g. `rows: 3` or `POST <url> -> 200`     |

Inspect recent runs:

```sql
SELECT j.name, r.started_at, r.ok, r.status_code, r.error, r.info
  FROM scheduler.runs r JOIN scheduler.jobs j ON j.id = r.job_id
 ORDER BY r.started_at DESC LIMIT 20;
```

Health + status endpoints:

```bash
curl http://scheduler:9992/health   # {"status":"ok","service":"laetoli-scheduler"}
curl http://scheduler:9992/status   # tickMs, runs {total,ok}, lastRun, nextDue
```

---

## SQL security caveat

> **`kind='sql'` jobs run ARBITRARY SQL as the scheduler's DB role.**

The `laetoli_scheduler` role is a **member of `laetoli_admin`** so it can run
whatever statement an operator registers (DDL/DML across schemas) — this is the
honest model for "a cron that runs admin tasks." The capability is contained by
**access control on registration**:

- Only `laetoli_admin` (the admin service / a DBA) can write `scheduler.jobs`.
- **Never expose `scheduler.jobs` through PostgREST or to untrusted callers.**
  If only admins can register jobs, only admins can cause privileged SQL to run.

For a least-privilege deployment, either:

1. restrict `laetoli_scheduler` to a narrow set of schemas/tables and only
   register `kind='sql'` jobs within that scope, or
2. use `kind='http'` jobs exclusively (they run **no** SQL — the worker only
   makes an outbound HTTP call), and let the receiving endpoint do any privileged
   work behind its own auth.

Treat a job's `secret` like a password.

---

## Worked example

**1) Nightly SQL aggregation.** Roll up yesterday's events into a stats table at
02:00 UTC:

```sql
CREATE TABLE IF NOT EXISTS public.daily_stats (day date PRIMARY KEY, n bigint);

INSERT INTO scheduler.jobs (name, cron, kind, sql)
VALUES ('nightly-rollup', '0 2 * * *', 'sql',
        $$INSERT INTO public.daily_stats (day, n)
          SELECT current_date - 1, count(*) FROM public.events
          WHERE created_at::date = current_date - 1
          ON CONFLICT (day) DO UPDATE SET n = EXCLUDED.n$$);
```

Verify without waiting for 02:00 — run it now:

```bash
JOB=$(psql ... -tAc "SELECT id FROM scheduler.jobs WHERE name='nightly-rollup'")
curl -X POST http://scheduler:9992/run/$JOB
psql ... -c "SELECT ok, info FROM scheduler.runs ORDER BY started_at DESC LIMIT 1"
```

**2) Hourly HTTP ping to a function.** Trigger an edge function every hour:

```sql
INSERT INTO scheduler.jobs (name, cron, kind, url, body, secret)
VALUES ('hourly-fn', '0 * * * *', 'http',
        'http://functions:9995/heartbeat',
        '{"source":"scheduler"}'::jsonb, 'a-long-random-secret');
```

The function receives the signed POST; the run log records `status_code` and
`info = "POST <url> -> 200"`. Run it now the same way (`POST /run/:id`).

---

## Configuration (env)

| Env                    | Default              | Meaning                                   |
|------------------------|----------------------|-------------------------------------------|
| `SCHEDULER_PORT`       | `9992`               | HTTP port                                 |
| `SCHEDULER_TICK_MS`    | `30000`              | how often the worker scans for due jobs   |
| `SCHEDULER_TIMEOUT_MS` | `10000`              | per-request timeout for `kind=http`       |
| `SCHEDULER_ADMIN_KEY`  | (unset → `ADMIN_API_KEY`) | gate run-now when set                |
| `DATABASE_URL`         | —                    | connects AS `laetoli_scheduler`           |
