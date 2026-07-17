-- =============================================================================
-- 0017_supabase_compat_pg_net.sql — pg_net compatibility (net.http_post/http_get)
-- -----------------------------------------------------------------------------
-- MIGRATION (run once on an EXISTING database — `laetoli-data migrate`). Also
-- mirrored into db/init/17_supabase_compat_pg_net.sql for a FRESH boot.
-- Idempotent.
--
-- WHAT THIS IS
--   Supabase ships `pg_net`, letting a trigger/function call an outbound HTTP
--   endpoint directly from SQL: `SELECT net.http_post(url, body, ...)`. Found
--   by testing Kasuku's real triggers against this project — `notify_on_call()`
--   and a gifts trigger both do exactly this, synchronously invoking Edge
--   Functions (push notifications) the moment a row is inserted.
--
--   pg_net itself is NOT actually synchronous — despite the trigger-call
--   syntax looking like one, Supabase's real implementation queues the
--   request and a background worker performs it, returning a bigint request
--   id immediately. This migration replicates that same real architecture
--   rather than faking a simpler one: `net.http_post()`/`net.http_get()`
--   INSERT into `net.http_request_queue` and return the new row's id — a
--   ported trigger calling them needs ZERO changes. The actual HTTP call is
--   made by the webhooks worker (webhooks/src/netBridge.ts), which LISTENs
--   for new queue rows the same way it already listens for realtime
--   notifications, and records the outcome in `net.http_response` — again
--   matching pg_net's real table shape, so `net._http_response`-style
--   inspection queries a ported app might run also work unmodified.
--
-- SECURITY
--   SECURITY DEFINER on both functions, EXECUTE granted broadly (anon,
--   authenticated, service_role, laetoli_admin) — matching pg_net's own
--   permissive default. The trust boundary here isn't "who can call
--   http_post" (any SQL trigger already has full database access by
--   definition); it's what URLs get called, which is the trigger author's
--   responsibility, identical to real pg_net.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS net AUTHORIZATION laetoli_admin;
COMMENT ON SCHEMA net IS
  'pg_net compatibility — outbound HTTP calls queued from SQL, drained by the webhooks worker. See docs/SUPABASE_COMPAT.md.';

-- --- net.http_request_queue ----------------------------------------------------
CREATE TABLE IF NOT EXISTS net.http_request_queue (
  id                  bigserial   PRIMARY KEY,
  method              text        NOT NULL CHECK (method IN ('GET', 'POST')),
  url                 text        NOT NULL,
  headers             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  body                text,
  timeout_milliseconds integer    NOT NULL DEFAULT 5000,
  created_at          timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE net.http_request_queue IS
  'Queued outbound HTTP calls from net.http_post()/http_get(). Drained by the webhooks worker (netBridge.ts), same real async shape as Supabase''s pg_net.';

-- --- net.http_response ---------------------------------------------------------
-- Deliberately NO foreign key to http_request_queue: the two tables are
-- independent lifecycles (queue = pending work, deleted once processed;
-- response = the permanent record of what happened), not parent/child. A
-- first version of this migration referenced http_request_queue(id) ON
-- DELETE CASCADE — found via live testing that the intentional DELETE of the
-- queue row in netQueue.ts's complete() silently cascaded and deleted the
-- response row it had just inserted, losing every outcome. Fixed by dropping
-- the FK entirely.
CREATE TABLE IF NOT EXISTS net.http_response (
  id           bigint      PRIMARY KEY,
  status_code  integer,
  headers      jsonb,
  content      text,
  error_msg    text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE net.http_response IS
  'One row per completed (or failed) queued request — status_code/content on success, error_msg on failure. Mirrors pg_net''s net._http_response shape closely enough for inspection queries to port. No FK to http_request_queue by design (see table comment history) — that table''s rows are transient, this one is the permanent record.';

-- --- notify the worker on every new queued request ------------------------------
-- Dedicated channel, kept separate from the realtime/webhooks NOTIFY stream
-- (laetoli_realtime) even though the same worker process listens to both —
-- this queue is a distinct concern (arbitrary outbound calls, not table-change
-- fan-out) and should stay independently reasoned about.
CREATE OR REPLACE FUNCTION net._notify_queued()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_notify('laetoli_net_queue', NEW.id::text);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS http_request_queue_notify ON net.http_request_queue;
CREATE TRIGGER http_request_queue_notify
  AFTER INSERT ON net.http_request_queue
  FOR EACH ROW
  EXECUTE FUNCTION net._notify_queued();

-- --- net.http_post() / net.http_get() -------------------------------------------
CREATE OR REPLACE FUNCTION net.http_post(
  url                  text,
  body                 jsonb DEFAULT NULL,
  params               jsonb DEFAULT '{}'::jsonb,
  headers              jsonb DEFAULT '{"Content-Type": "application/json"}'::jsonb,
  timeout_milliseconds integer DEFAULT 5000
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = net, pg_temp
AS $$
DECLARE
  full_url text;
  req_id   bigint;
BEGIN
  -- `params` is treated as query-string parameters appended to url, matching
  -- pg_net's own signature (kept simple: only used when non-empty).
  full_url := url;
  IF params IS NOT NULL AND params != '{}'::jsonb THEN
    full_url := url || (CASE WHEN url LIKE '%?%' THEN '&' ELSE '?' END) ||
      (SELECT string_agg(format('%s=%s', key, value), '&')
       FROM jsonb_each_text(params));
  END IF;

  INSERT INTO net.http_request_queue (method, url, headers, body, timeout_milliseconds)
  VALUES ('POST', full_url, COALESCE(headers, '{}'::jsonb), body::text, timeout_milliseconds)
  RETURNING id INTO req_id;

  RETURN req_id;
END;
$$;

CREATE OR REPLACE FUNCTION net.http_get(
  url                  text,
  params               jsonb DEFAULT '{}'::jsonb,
  headers              jsonb DEFAULT '{}'::jsonb,
  timeout_milliseconds integer DEFAULT 5000
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = net, pg_temp
AS $$
DECLARE
  full_url text;
  req_id   bigint;
BEGIN
  full_url := url;
  IF params IS NOT NULL AND params != '{}'::jsonb THEN
    full_url := url || (CASE WHEN url LIKE '%?%' THEN '&' ELSE '?' END) ||
      (SELECT string_agg(format('%s=%s', key, value), '&')
       FROM jsonb_each_text(params));
  END IF;

  INSERT INTO net.http_request_queue (method, url, headers, timeout_milliseconds)
  VALUES ('GET', full_url, COALESCE(headers, '{}'::jsonb), timeout_milliseconds)
  RETURNING id INTO req_id;

  RETURN req_id;
END;
$$;

COMMENT ON FUNCTION net.http_post(text, jsonb, jsonb, jsonb, integer) IS
  'pg_net-compatible: queues a POST, returns the request id immediately (real async, matching Supabase). Ported trigger SQL calling this needs no changes.';
COMMENT ON FUNCTION net.http_get(text, jsonb, jsonb, integer) IS
  'pg_net-compatible: queues a GET, returns the request id immediately.';

-- --- grants ---------------------------------------------------------------------
-- SECURITY DEFINER functions broadly callable (matches pg_net's own permissive
-- default — the trust boundary is the URL being called, the trigger author's
-- responsibility, not who may call http_post).
GRANT USAGE ON SCHEMA net TO anon, authenticated, service_role, laetoli_admin;
GRANT EXECUTE ON FUNCTION net.http_post(text, jsonb, jsonb, jsonb, integer) TO anon, authenticated, service_role, laetoli_admin;
GRANT EXECUTE ON FUNCTION net.http_get(text, jsonb, jsonb, integer) TO anon, authenticated, service_role, laetoli_admin;

-- The worker (laetoli_webhooks — same role that dispatches table-change
-- webhooks, since it's the same deployable process) drains the queue and
-- records outcomes.
GRANT USAGE ON SCHEMA net TO laetoli_webhooks;
GRANT SELECT, DELETE ON net.http_request_queue TO laetoli_webhooks;
-- UPDATE is required even though every insert here is a fresh id (no real
-- conflict expected) — `INSERT ... ON CONFLICT DO UPDATE` needs UPDATE
-- privilege on the table to be planned at all, not just when a conflict
-- actually occurs. Found by live-testing this migration, not assumed.
GRANT SELECT, INSERT, UPDATE ON net.http_response TO laetoli_webhooks;

GRANT ALL ON ALL TABLES IN SCHEMA net TO laetoli_admin;
