-- =============================================================================
-- 0003_admin.sql — login role for the sovereign admin API service (admin/, :9996)
-- -----------------------------------------------------------------------------
-- MIGRATION (run once, manually / via your migration runner — NOT in db/init).
-- Idempotent: safe to run more than once (DO-block guarded CREATE; ALTER/GRANT
-- are naturally re-runnable).
--
-- WHY A NEW ROLE?
--   The admin service (the Admin Studio dashboard backend) needs full,
--   RLS-bypassing access to the database to do schema introspection, run the SQL
--   console, and manage auth/storage/RLS. The existing `laetoli_admin` role is
--   exactly that elevated, BYPASSRLS role (see db/init/01_roles.sql) — BUT it is
--   NOLOGIN, so the service can't connect AS it directly.
--
--   We do NOT add LOGIN to `laetoli_admin` itself: keeping the powerful role
--   NOLOGIN is good hygiene (it stays a pure "capability" role that other roles
--   are granted, never a connectable account). Instead we create a dedicated
--   connectable account, `laetoli_admin_login`, and:
--
--     1. GRANT laetoli_admin TO laetoli_admin_login   — so it INHERITS all of
--        laetoli_admin's object privileges (schema USAGE, table ALL, default
--        privileges, etc.). Membership + INHERIT gives it the *privileges*.
--
--     2. ALTER ROLE laetoli_admin_login WITH BYPASSRLS — because BYPASSRLS is an
--         atTRIBUTE, NOT a privilege, and is therefore **NOT inherited via role
--        membership**. It must be set explicitly on the login role itself.
--
--   Net result: laetoli_admin_login can LOG IN, sees every row (BYPASSRLS), and
--   can manage every object laetoli_admin can.
--
-- THE ADMIN SERVICE CONNECTS AS:
--     postgres://laetoli_admin_login:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB}
--
-- PASSWORD: like the other LOGIN roles (01_roles.sql, 0001_storage.sql), this
-- file does NOT hardcode a password. After running it once, set the secret:
--     ALTER ROLE laetoli_admin_login WITH PASSWORD '${POSTGRES_PASSWORD}';
-- By convention it reuses ${POSTGRES_PASSWORD} (the single deploy secret). The
-- companion 00_passwords.sh (generated at deploy time) must set this on fresh
-- boots — see the note returned to the orchestrator.
--
-- !! SECURITY !! laetoli_admin_login is the keys-to-the-kingdom DB account: it
-- bypasses ALL Row Level Security. Only the admin service should hold its
-- credentials, and the admin service itself is gated by ADMIN_API_KEY.
-- =============================================================================

-- --- role: laetoli_admin_login (the Node admin service connects AS this) -------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'laetoli_admin_login') THEN
    -- INHERIT (default) so it picks up laetoli_admin's object privileges.
    CREATE ROLE laetoli_admin_login LOGIN INHERIT;
  END IF;
END $$;

-- Inherit laetoli_admin's object privileges (schema USAGE, table ALL, defaults).
GRANT laetoli_admin TO laetoli_admin_login;

-- BYPASSRLS is an attribute, NOT inherited via membership — set it explicitly.
ALTER ROLE laetoli_admin_login WITH BYPASSRLS;

-- Make sure it can also reach the auth + storage + realtime schemas it manages
-- (laetoli_admin already has ALL on public + storage + realtime via the earlier
-- files; these GRANTs are belt-and-braces / future-proofing and are idempotent).
GRANT USAGE ON SCHEMA public TO laetoli_admin_login;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'auth') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA auth TO laetoli_admin_login';
    EXECUTE 'GRANT ALL ON ALL TABLES IN SCHEMA auth TO laetoli_admin_login';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = 'storage') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA storage TO laetoli_admin_login';
    EXECUTE 'GRANT ALL ON ALL TABLES IN SCHEMA storage TO laetoli_admin_login';
  END IF;
END $$;

COMMENT ON ROLE laetoli_admin_login IS
  'LOGIN account for the admin API service (admin/, :9996). Member of laetoli_admin '
  '(inherits its privileges) and explicitly BYPASSRLS. Keys-to-the-kingdom — '
  'guard its password; the service is gated by ADMIN_API_KEY.';
