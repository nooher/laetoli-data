-- =============================================================================
-- 0007_webhooks.sql — database webhooks: registered endpoints + delivery log
-- -----------------------------------------------------------------------------
-- MIGRATION (run once, manually / via your migration runner — also wired into
-- db/init/10_webhooks.sql with \i for fresh boots). Idempotent: safe to re-run
-- (CREATE ... IF NOT EXISTS, DO-block guards, GRANTs are naturally re-runnable).
--
-- WHAT THIS IS
--   The "row change -> HTTP POST" automation primitive. An operator registers a
--   webhook in `webhooks.endpoints` (a table_name, the events it cares about,
--   and a destination url + optional HMAC secret). The webhook WORKER service
--   (webhooks/, :9993) holds a dedicated Postgres `LISTEN laetoli_realtime`
--   session — the SAME NOTIFY stream the realtime service consumes (we do NOT
--   add per-row polling). On each change it finds active endpoints matching the
--   table + event, POSTs the change payload to each url with a retry+backoff
--   budget, and records every attempt outcome in `webhooks.deliveries`.
--
-- DEPENDS ON
--   * 0002_realtime.sql — the realtime.notify() trigger + realtime.enable(table)
--     helper. A table only emits NOTIFYs (and therefore only fires webhooks)
--     once `SELECT realtime.enable('public.my_table')` has been run on it.
--
-- WHO CONNECTS / ACCESS
--   * The ADMIN service (admin/, as laetoli_admin_login, member of laetoli_admin
--     + BYPASSRLS) owns all writes to webhooks.endpoints — the GRANTs to
--     laetoli_admin below are inherited. Operators may also manage endpoints by
--     SQL directly.
--   * The WORKER connects AS the dedicated `laetoli_webhooks` LOGIN role. It
--     needs to SELECT active endpoints and INSERT a deliveries row per attempt;
--     it never registers/edits endpoints. GRANTs at the bottom give it exactly
--     that.
--
-- SECURITY
--   * `secret` (optional) is the HMAC-SHA256 signing key. When set, the worker
--     signs each request body and sends it as `X-Laetoli-Signature: sha256=<hex>`
--     so the receiver can verify authenticity. Treat the secret like a password.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

-- --- webhooks schema ----------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS webhooks AUTHORIZATION laetoli_admin;

COMMENT ON SCHEMA webhooks IS
  'Database webhooks: registered endpoints + per-attempt delivery log. '
  'Driven by the realtime NOTIFY stream (no per-row polling).';

-- --- laetoli_webhooks role (the Node worker connects AS this) -----------------
-- LOGIN, NOINHERIT. It holds the dedicated LISTEN session (LISTEN/NOTIFY needs
-- no special grant), reads active endpoints, and writes the delivery log. The
-- explicit GRANTs below are what it actually uses.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'laetoli_webhooks') THEN
    CREATE ROLE laetoli_webhooks LOGIN NOINHERIT;
  END IF;
END $$;

COMMENT ON ROLE laetoli_webhooks IS
  'Login role for the Node webhooks worker. Holds the LISTEN session; reads '
  'webhooks.endpoints and writes webhooks.deliveries.';

-- PASSWORD: like the other login roles (see db/init/00_passwords.sh), this file
-- is committed to git and does NOT hardcode a secret. 00_passwords.sh pre-creates
-- the role WITH a password at deploy time (reusing ${POSTGRES_PASSWORD} by
-- convention); this DO-block is then a no-op. The worker's DSN is:
--   postgres://laetoli_webhooks:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB}

-- --- webhooks.endpoints (a registered webhook) -------------------------------
CREATE TABLE IF NOT EXISTS webhooks.endpoints (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text,
  -- The table to watch. Either a bare name ('notes') matched against the NOTIFY
  -- `table`, or 'schema.table' ('public.notes') matched against `schema.table`.
  table_name text        NOT NULL,
  events     text[]      NOT NULL DEFAULT '{INSERT,UPDATE,DELETE}',
  url        text        NOT NULL,
  secret     text,
  active     boolean     NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  webhooks.endpoints IS 'Registered webhooks: table_name + events -> url (HMAC-signed when secret set).';
COMMENT ON COLUMN webhooks.endpoints.table_name IS 'Watched table: bare "notes" or qualified "public.notes".';
COMMENT ON COLUMN webhooks.endpoints.events IS 'Subset of {INSERT,UPDATE,DELETE} this endpoint fires on.';
COMMENT ON COLUMN webhooks.endpoints.url IS 'HTTP(S) destination POSTed with the JSON change payload.';
COMMENT ON COLUMN webhooks.endpoints.secret IS 'Optional HMAC-SHA256 signing key; when set the worker adds X-Laetoli-Signature.';
COMMENT ON COLUMN webhooks.endpoints.active IS 'Soft on/off switch; inactive endpoints are skipped by the worker.';

-- The worker filters by active; index helps the lookup on each change.
CREATE INDEX IF NOT EXISTS endpoints_active_idx     ON webhooks.endpoints (active) WHERE active;
CREATE INDEX IF NOT EXISTS endpoints_table_name_idx ON webhooks.endpoints (table_name);

-- --- webhooks.deliveries (per-attempt delivery log) --------------------------
CREATE TABLE IF NOT EXISTS webhooks.deliveries (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint_id uuid        REFERENCES webhooks.endpoints(id) ON DELETE CASCADE,
  event       text,
  status_code int,
  ok          boolean     NOT NULL DEFAULT false,
  error       text,
  attempts    int         NOT NULL DEFAULT 0,
  payload     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  webhooks.deliveries IS 'Delivery log: one row per endpoint POST outcome (final attempt result + attempt count).';
COMMENT ON COLUMN webhooks.deliveries.status_code IS 'HTTP status of the final attempt (NULL on network/timeout error).';
COMMENT ON COLUMN webhooks.deliveries.ok IS 'true when the final attempt returned a 2xx status.';
COMMENT ON COLUMN webhooks.deliveries.error IS 'Error message of the final failing attempt (NULL when ok).';
COMMENT ON COLUMN webhooks.deliveries.attempts IS 'Total attempts made (1..max) before success or giving up.';
COMMENT ON COLUMN webhooks.deliveries.payload IS 'The JSON body that was POSTed: {schema,table,type,record,old}.';

CREATE INDEX IF NOT EXISTS deliveries_endpoint_idx ON webhooks.deliveries (endpoint_id, created_at DESC);

-- --- grants -------------------------------------------------------------------
-- The admin service (as laetoli_admin / laetoli_admin_login) manages everything.
GRANT ALL ON SCHEMA webhooks TO laetoli_admin;
GRANT ALL ON ALL TABLES IN SCHEMA webhooks TO laetoli_admin;

-- The worker reads active endpoints and writes the delivery log. It never edits
-- endpoints. Grant USAGE + SELECT on endpoints, and write on deliveries.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'laetoli_webhooks') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA webhooks TO laetoli_webhooks';
    EXECUTE 'GRANT SELECT ON webhooks.endpoints TO laetoli_webhooks';
    EXECUTE 'GRANT SELECT, INSERT ON webhooks.deliveries TO laetoli_webhooks';
  END IF;
END $$;

-- =============================================================================
-- ENABLE WEBHOOKS ON A TABLE (operator step):
--   1) Ensure the table emits NOTIFYs (shared with realtime):
--        SELECT realtime.enable('public.my_table');
--   2) Register an endpoint:
--        INSERT INTO webhooks.endpoints (name, table_name, events, url, secret)
--        VALUES ('notify-orders', 'public.orders', '{INSERT,UPDATE}',
--                'https://example.com/hook', 'a-long-random-secret');
-- The worker (webhooks/, :9993) does the rest. See docs/WEBHOOKS.md.
-- =============================================================================
