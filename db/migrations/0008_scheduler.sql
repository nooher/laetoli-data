-- =============================================================================
-- 0008_scheduler.sql — scheduled jobs (sovereign cron): registered jobs + run log
-- -----------------------------------------------------------------------------
-- MIGRATION (run once, manually / via your migration runner — also wired into
-- db/init/11_scheduler.sql with \i for fresh boots). Idempotent: safe to re-run
-- (CREATE ... IF NOT EXISTS, DO-block guards, GRANTs are naturally re-runnable).
--
-- WHAT THIS IS
--   The time-driven automation primitive — the cron counterpart to the
--   event-driven webhooks (0007). An operator registers a JOB in scheduler.jobs
--   (a 5-field cron string + an ACTION). The scheduler WORKER service
--   (scheduler/, :9992) wakes on a short interval, finds jobs whose next_run is
--   due, and executes each one:
--     * kind='sql'  — runs the job's `sql` statement against this database.
--     * kind='http' — POSTs {job,body} to the job's `url`, HMAC-signed with
--                     `X-Laetoli-Signature: sha256=<hex>` when `secret` is set
--                     (identical signing convention to webhooks, 0007).
--   Every execution appends one row to scheduler.runs (the run log), and the
--   worker advances jobs.next_run to the next cron instant.
--
-- WHO CONNECTS / ACCESS
--   * The ADMIN service (admin/, as laetoli_admin_login, member of laetoli_admin
--     + BYPASSRLS) owns all writes to scheduler.jobs — the GRANTs to
--     laetoli_admin below are inherited. Operators may also manage jobs by SQL
--     directly. Registering jobs is an ADMIN-ONLY operation (see SECURITY).
--   * The WORKER connects AS the dedicated `laetoli_scheduler` LOGIN role. It
--     reads active jobs, writes scheduler.runs, updates jobs.next_run, AND for
--     kind='sql' it must be able to actually run the job's statement. See the
--     SECURITY note for why this role is intentionally privileged.
--
-- SECURITY  (READ THIS)
--   * kind='sql' jobs run ARBITRARY SQL as the scheduler's DB role. That is, by
--     design, a privileged capability — equivalent to a stored admin task.
--     Therefore: registering jobs MUST be an admin-only operation. Only
--     laetoli_admin (the admin service / a DBA) is granted write on
--     scheduler.jobs; no anon/authenticated/PostgREST-exposed path can insert a
--     job. Never expose scheduler.jobs through PostgREST or to untrusted callers.
--   * The `laetoli_scheduler` role is made a MEMBER of `laetoli_admin` so it can
--     execute whatever SQL an operator registers (DDL/DML across schemas), and
--     it runs with INHERIT so those privileges are live. This is the simplest,
--     most honest model: a cron that can "run admin tasks" needs admin reach.
--     The risk is contained by the access rule above — if only admins can
--     register jobs, only admins can cause the scheduler to run privileged SQL.
--     If you want a least-privilege deployment, restrict the role to a narrow
--     set of schemas/tables and only register kind='sql' jobs within that scope
--     (or use kind='http' jobs exclusively, which run NO SQL).
--   * `secret` (optional, kind='http') is the HMAC-SHA256 signing key. Treat it
--     like a password.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

-- --- scheduler schema ---------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS scheduler AUTHORIZATION laetoli_admin;

COMMENT ON SCHEMA scheduler IS
  'Scheduled jobs (sovereign cron): registered jobs + per-execution run log. '
  'Time-driven automation; the cron counterpart to event-driven webhooks.';

-- --- laetoli_scheduler role (the Node worker connects AS this) ----------------
-- LOGIN, INHERIT, MEMBER of laetoli_admin (see SECURITY above): it must run
-- whatever SQL an admin registers in a kind='sql' job, plus write the run log
-- and advance next_run. The membership is granted further down (after the role
-- and schema exist). 00_passwords.sh pre-creates the role WITH a password.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'laetoli_scheduler') THEN
    CREATE ROLE laetoli_scheduler LOGIN INHERIT;
  END IF;
END $$;

COMMENT ON ROLE laetoli_scheduler IS
  'Login role for the Node scheduler worker. Member of laetoli_admin so it can '
  'execute registered kind=sql jobs; reads scheduler.jobs, writes scheduler.runs.';

-- PASSWORD: like the other login roles (see db/init/00_passwords.sh), this file
-- is committed to git and does NOT hardcode a secret. 00_passwords.sh pre-creates
-- the role WITH a password at deploy time (reusing ${POSTGRES_PASSWORD} by
-- convention); this DO-block is then a no-op. The worker's DSN is:
--   postgres://laetoli_scheduler:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB}

-- --- scheduler.jobs (a registered job) ---------------------------------------
CREATE TABLE IF NOT EXISTS scheduler.jobs (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text,
  -- 5-field cron string (minute hour day-of-month month day-of-week), parsed by
  -- the worker's own dependency-free cron module (vendored from backup/).
  cron       text        NOT NULL,
  -- 'sql'  -> run the `sql` statement; 'http' -> POST to `url`.
  kind       text        NOT NULL CHECK (kind IN ('sql', 'http')),
  sql        text,
  url        text,
  headers    jsonb,
  body       jsonb,
  secret     text,
  active     boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  -- The next instant this job is due (UTC). NULL means "compute on next tick".
  next_run   timestamptz
);

COMMENT ON TABLE  scheduler.jobs IS 'Registered scheduled jobs: a cron string + an action (sql or http POST).';
COMMENT ON COLUMN scheduler.jobs.cron IS '5-field cron (min hour dom month dow), UTC; e.g. "0 2 * * *" = 02:00 daily.';
COMMENT ON COLUMN scheduler.jobs.kind IS 'Action type: "sql" runs the sql statement, "http" POSTs to url.';
COMMENT ON COLUMN scheduler.jobs.sql IS 'For kind=sql: the statement run AS laetoli_scheduler (ADMIN-ONLY to register; see migration SECURITY).';
COMMENT ON COLUMN scheduler.jobs.url IS 'For kind=http: HTTP(S) destination POSTed with the JSON body.';
COMMENT ON COLUMN scheduler.jobs.headers IS 'For kind=http: optional extra request headers (JSON object of string->string).';
COMMENT ON COLUMN scheduler.jobs.body IS 'For kind=http: optional JSON request body (defaults to {} when null).';
COMMENT ON COLUMN scheduler.jobs.secret IS 'For kind=http: optional HMAC-SHA256 signing key; when set the worker adds X-Laetoli-Signature.';
COMMENT ON COLUMN scheduler.jobs.active IS 'Soft on/off switch; inactive jobs are skipped by the worker.';
COMMENT ON COLUMN scheduler.jobs.next_run IS 'Next due instant (UTC). The worker advances this after each run; NULL = compute on next tick.';

-- The worker scans active jobs each tick; index helps that lookup + due ordering.
CREATE INDEX IF NOT EXISTS jobs_active_next_idx ON scheduler.jobs (active, next_run) WHERE active;

-- --- scheduler.runs (per-execution run log) ----------------------------------
CREATE TABLE IF NOT EXISTS scheduler.runs (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id      uuid        REFERENCES scheduler.jobs(id) ON DELETE CASCADE,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  ok          boolean     NOT NULL DEFAULT false,
  status_code int,
  error       text,
  info        text
);

COMMENT ON TABLE  scheduler.runs IS 'Run log: one row per job execution (cron tick or manual run-now).';
COMMENT ON COLUMN scheduler.runs.ok IS 'true when the execution succeeded (sql ran / http returned 2xx).';
COMMENT ON COLUMN scheduler.runs.status_code IS 'For kind=http: HTTP status of the POST (NULL for kind=sql or on network error).';
COMMENT ON COLUMN scheduler.runs.error IS 'Error message when the execution failed (NULL when ok).';
COMMENT ON COLUMN scheduler.runs.info IS 'Free-form success detail, e.g. "rows: 3" for sql or "trigger: manual" context.';

CREATE INDEX IF NOT EXISTS runs_job_idx ON scheduler.runs (job_id, started_at DESC);

-- --- grants -------------------------------------------------------------------
-- The admin service (as laetoli_admin / laetoli_admin_login) manages everything.
GRANT ALL ON SCHEMA scheduler TO laetoli_admin;
GRANT ALL ON ALL TABLES IN SCHEMA scheduler TO laetoli_admin;

-- The worker: make it a member of laetoli_admin (so it can run registered SQL +
-- read/write the scheduler tables), then grant the explicit object privileges it
-- relies on directly (belt-and-braces; membership already covers these).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'laetoli_scheduler') THEN
    EXECUTE 'GRANT laetoli_admin TO laetoli_scheduler';
    EXECUTE 'GRANT USAGE ON SCHEMA scheduler TO laetoli_scheduler';
    EXECUTE 'GRANT SELECT, UPDATE ON scheduler.jobs TO laetoli_scheduler';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON scheduler.runs TO laetoli_scheduler';
  END IF;
END $$;

-- =============================================================================
-- REGISTER A JOB (operator step — ADMIN ONLY):
--   -- nightly SQL aggregation at 02:00 UTC:
--   INSERT INTO scheduler.jobs (name, cron, kind, sql)
--   VALUES ('nightly-rollup', '0 2 * * *', 'sql',
--           'INSERT INTO public.daily_stats (day, n) '
--           'SELECT current_date, count(*) FROM public.events');
--
--   -- hourly HTTP ping to an edge function (HMAC-signed):
--   INSERT INTO scheduler.jobs (name, cron, kind, url, body, secret)
--   VALUES ('hourly-ping', '0 * * * *', 'http',
--           'http://functions:9995/cron-tick', '{"source":"scheduler"}'::jsonb,
--           'a-long-random-secret');
-- The worker (scheduler/, :9992) does the rest. See docs/SCHEDULER.md.
-- =============================================================================
