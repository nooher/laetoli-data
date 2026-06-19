-- =============================================================================
-- 01_roles.sql — Laetoli Data role model (mirrors Supabase / PostgREST)
-- -----------------------------------------------------------------------------
-- Runs once on first DB boot (Postgres initdb) inside POSTGRES_DB, owned by
-- POSTGRES_USER (the cluster superuser, here `laetoli`).
--
-- Role model:
--   anon            NOLOGIN  — anonymous/public role. PostgREST switches to it
--                              for requests with no JWT (or role claim "anon").
--   authenticated   NOLOGIN  — role for any signed-in user (JWT role claim
--                              "authenticated").
--   authenticator   LOGIN    — the role PostgREST itself connects AS. Has almost
--                              no rights of its own; it can only SET ROLE to
--                              anon / authenticated / laetoli_admin per the
--                              verified JWT "role" claim.
--   laetoli_admin   NOLOGIN  — elevated role (BYPASSRLS) for trusted server-side
--                              jobs, migrations and dashboards.
--   laetoli_auth    LOGIN    — the role the Node auth service connects AS to
--                              read/write auth.users (see 02_auth.sql for its
--                              table grants).
--
-- PASSWORDS (authenticator + laetoli_auth):
--   This file is committed to git, so it does NOT hardcode passwords. The
--   docker-entrypoint exports POSTGRES_PASSWORD into the init shell, and the
--   companion 00_passwords.sh script (generated at deploy time, see DEPLOY.md)
--   runs `ALTER ROLE ... WITH PASSWORD` using that env var BEFORE the .sql files.
--   By convention both login roles reuse ${POSTGRES_PASSWORD} so there is a
--   single secret. The connection strings must match:
--     PostgREST  : postgres://authenticator:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB}
--     Auth svc   : postgres://laetoli_auth:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB}
--   (See docker-compose.yml.) If you rotate POSTGRES_PASSWORD, re-run the ALTERs.
-- =============================================================================

-- --- anon ---------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
END $$;

-- --- authenticated ------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
END $$;

-- --- laetoli_admin (elevated; bypasses RLS) -----------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'laetoli_admin') THEN
    CREATE ROLE laetoli_admin NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
END $$;

-- --- authenticator (PostgREST connects AS this) -------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator LOGIN NOINHERIT;
  END IF;
END $$;

-- --- laetoli_auth (the Node auth service connects AS this) ---------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'laetoli_auth') THEN
    CREATE ROLE laetoli_auth LOGIN NOINHERIT;
  END IF;
END $$;

-- authenticator must be allowed to assume the request-time roles.
GRANT anon          TO authenticator;
GRANT authenticated TO authenticator;
GRANT laetoli_admin TO authenticator;

-- --- schema usage / grants ----------------------------------------------------
-- USAGE only on public for request roles; table-level grants live with each
-- table (see 03_example.sql), keeping RLS the gatekeeper.
GRANT USAGE ON SCHEMA public TO anon, authenticated, laetoli_admin;
GRANT ALL   ON SCHEMA public TO laetoli_admin;

-- Future tables created by the superuser: let admin manage them by default.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES    TO laetoli_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO laetoli_admin;
