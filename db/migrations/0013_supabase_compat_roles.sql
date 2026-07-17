-- =============================================================================
-- 0013_supabase_compat_roles.sql — `service_role` compatibility alias.
-- -----------------------------------------------------------------------------
-- MIGRATION (run once, manually / via your migration runner — also wired into
-- db/init/13_supabase_compat_roles.sql with \i for fresh boots). Idempotent.
--
-- WHAT THIS IS
--   Laetoli Data's elevated/trusted role is `laetoli_admin` (NOLOGIN NOINHERIT
--   BYPASSRLS — see db/init/01_roles.sql). Supabase's equivalent is named
--   `service_role`. Any SQL authored for Supabase that does
--   `GRANT ... TO service_role` fails on a stock Laetoli Data instance with
--   `role "service_role" does not exist` — found by testing THOS's real
--   Supabase migrations against this project: 15 of THOS's 57 migrations hit
--   exactly this, more than any other single incompatibility.
--
--   Rather than rewrite every ported Supabase migration to say
--   `laetoli_admin` instead, this creates `service_role` as a genuine second
--   elevated role with the SAME properties, so Supabase-authored SQL runs
--   here UNMODIFIED. Both roles are real BYPASSRLS roles going forward — pick
--   whichever your migration already says.
-- =============================================================================

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END $$;

GRANT service_role TO authenticator;

GRANT USAGE ON SCHEMA public TO service_role;
GRANT ALL   ON SCHEMA public TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;

COMMENT ON ROLE service_role IS
  'Supabase-compatibility alias for laetoli_admin — same BYPASSRLS elevated role under the name ported Supabase SQL expects. Added after testing THOS''s real migrations (see docs/SUPABASE_COMPAT.md).';
