-- =============================================================================
-- 0002_realtime.sql — realtime schema, role, trigger function, and enabler
-- -----------------------------------------------------------------------------
-- MIGRATION (run once, manually / via your migration runner — NOT in db/init).
-- Idempotent: safe to run more than once.
--
-- Powers the sovereign realtime service (realtime/, :9997). The Node service
-- connects AS the dedicated `laetoli_realtime` LOGIN role and runs
--   LISTEN laetoli_realtime;
-- The trigger function below fires AFTER INSERT/UPDATE/DELETE on enabled tables
-- and publishes the row change via pg_notify('laetoli_realtime', payload), where
-- payload is JSON:
--   { schema, table, type: 'INSERT'|'UPDATE'|'DELETE', record, old }
--
-- 8000-byte NOTIFY cap: Postgres truncates/aborts NOTIFY payloads over 8000
-- bytes. If the serialized payload would exceed a safe budget we DROP the heavy
-- `record`/`old` bodies and instead send just the primary-key/id plus
-- `truncated: true`, so the client can re-fetch the row over PostgREST (subject
-- to RLS).
--
-- !! RLS NOTE (v1 scope) !!
-- Fan-out is TABLE-LEVEL, not per-subscriber row-level. The realtime service
-- broadcasts a table's changes to every client subscribed to that table. It
-- does NOT (yet) re-evaluate each table's RLS policy per connected user. THE
-- IMPLICATION: only enable realtime on tables whose rows are safe for any
-- subscriber to see, OR rely on the optional server-side equality `filter`
-- (e.g. filter user_id = <me>) which the client must set — note that a filter is
-- a convenience, not a security boundary. For owner-private tables, treat the
-- realtime stream as a "something changed" hint and fetch the actual rows via
-- PostgREST, which DOES enforce RLS. Full per-subscriber RLS is a v2 item.
-- =============================================================================

-- --- realtime schema ----------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS realtime AUTHORIZATION laetoli_admin;

COMMENT ON SCHEMA realtime IS
  'Realtime change-data-capture: NOTIFY trigger function + enable() helper.';

-- --- laetoli_realtime role (the Node realtime service connects AS this) --------
-- LOGIN, no inherited rights of its own. It only needs to LISTEN on the channel;
-- LISTEN/NOTIFY require no special grant in Postgres (any role with a session
-- can LISTEN), so we keep this role minimal. Give it USAGE on public so it can
-- resolve table names if it ever needs to (it does not write).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'laetoli_realtime') THEN
    CREATE ROLE laetoli_realtime LOGIN NOINHERIT;
  END IF;
END $$;

COMMENT ON ROLE laetoli_realtime IS
  'Login role for the Node realtime service. Holds the dedicated LISTEN session.';

GRANT USAGE ON SCHEMA public   TO laetoli_realtime;
GRANT USAGE ON SCHEMA realtime TO laetoli_realtime;

-- PASSWORD: like the other login roles (see db/init/01_roles.sql), this file is
-- committed to git and does NOT hardcode a secret. Set it at deploy time, e.g.:
--   ALTER ROLE laetoli_realtime WITH PASSWORD '...';
-- By convention reuse ${POSTGRES_PASSWORD}; the realtime service's DSN is
--   postgres://laetoli_realtime:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB}

-- --- realtime.notify(): the generic trigger function ---------------------------
-- AFTER row trigger. Builds the JSON payload and pg_notify()s it on the
-- 'laetoli_realtime' channel, honoring the 8000-byte cap.
CREATE OR REPLACE FUNCTION realtime.notify()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  rec        jsonb;
  old_rec    jsonb;
  payload    jsonb;
  payload_txt text;
  -- Keep a safety margin under the hard 8000-byte NOTIFY limit.
  max_bytes  constant int := 7500;
  pk_id      jsonb;
BEGIN
  IF (TG_OP = 'INSERT') THEN
    rec := to_jsonb(NEW); old_rec := NULL;
  ELSIF (TG_OP = 'UPDATE') THEN
    rec := to_jsonb(NEW); old_rec := to_jsonb(OLD);
  ELSIF (TG_OP = 'DELETE') THEN
    rec := NULL; old_rec := to_jsonb(OLD);
  END IF;

  payload := jsonb_build_object(
    'schema', TG_TABLE_SCHEMA,
    'table',  TG_TABLE_NAME,
    'type',   TG_OP,
    'record', rec,
    'old',    old_rec
  );
  payload_txt := payload::text;

  -- If too large, drop the heavy bodies and send just an id + truncated flag.
  IF (octet_length(payload_txt) > max_bytes) THEN
    -- Best-effort primary key: prefer an "id" column from the surviving row.
    pk_id := COALESCE(rec -> 'id', old_rec -> 'id');
    payload := jsonb_build_object(
      'schema',    TG_TABLE_SCHEMA,
      'table',     TG_TABLE_NAME,
      'type',      TG_OP,
      'record',    CASE WHEN pk_id IS NOT NULL
                        THEN jsonb_build_object('id', pk_id) ELSE NULL END,
      'old',       NULL,
      'truncated', true
    );
    payload_txt := payload::text;
  END IF;

  PERFORM pg_notify('laetoli_realtime', payload_txt);
  RETURN NULL; -- AFTER trigger; return value ignored.
END;
$$;

COMMENT ON FUNCTION realtime.notify() IS
  'Generic AFTER trigger: publishes row changes via pg_notify(laetoli_realtime). '
  'Drops record/old and sets truncated=true when over the 8000-byte NOTIFY cap.';

-- --- realtime.enable(table): attach the trigger to a table --------------------
-- Idempotent helper. Usage:  SELECT realtime.enable('public.notes');
CREATE OR REPLACE FUNCTION realtime.enable(target regclass)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  trig_name text := 'realtime_notify';
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s', trig_name, target::text);
  EXECUTE format(
    'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %s '
    'FOR EACH ROW EXECUTE FUNCTION realtime.notify()',
    trig_name, target::text
  );
END;
$$;

COMMENT ON FUNCTION realtime.enable(regclass) IS
  'Attach the realtime AFTER INSERT/UPDATE/DELETE row trigger to a table. '
  'Idempotent. Example: SELECT realtime.enable(''public.notes'');';

-- Optional companion: realtime.disable(table) to detach.
CREATE OR REPLACE FUNCTION realtime.disable(target regclass)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  EXECUTE format('DROP TRIGGER IF EXISTS %I ON %s', 'realtime_notify', target::text);
END;
$$;

COMMENT ON FUNCTION realtime.disable(regclass) IS
  'Detach the realtime trigger from a table. Idempotent.';

-- --- grants -------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION realtime.enable(regclass)  TO laetoli_admin;
GRANT EXECUTE ON FUNCTION realtime.disable(regclass) TO laetoli_admin;
GRANT ALL ON SCHEMA realtime TO laetoli_admin;

-- --- worked example: enable realtime on public.notes --------------------------
-- The demo owner-scoped table from db/init/03_example.sql. Per the RLS NOTE
-- above, prefer subscribing with a server-side filter on user_id, and re-fetch
-- via PostgREST for authoritative, RLS-enforced rows.
SELECT realtime.enable('public.notes');

-- =============================================================================
-- TO ENABLE REALTIME ON ANOTHER TABLE (operator step):
--   SELECT realtime.enable('public.my_table');
-- TO DISABLE:
--   SELECT realtime.disable('public.my_table');
-- =============================================================================
