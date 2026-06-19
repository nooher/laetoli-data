-- =============================================================================
-- 02_auth.sql — auth schema, users table, and auth.uid() helper
-- -----------------------------------------------------------------------------
-- Provides the Supabase-compatible identity layer:
--   * schema   auth
--   * table    auth.users
--   * function auth.uid()  — reads the JWT "sub" claim, exactly like Supabase,
--                            so RLS policies can be written `auth.uid() = ...`.
--
-- The Node auth service (auth/, :9999) connects AS the `laetoli_auth` LOGIN role
-- (defined in 01_roles.sql) and is the ONLY role granted write access to
-- auth.users. PostgREST's request roles (anon/authenticated) get NO direct
-- access to auth.users — identity is opaque to the REST API surface.
-- =============================================================================

-- pgcrypto gives us gen_random_uuid() (built into PG13+ core too, but ensure it).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION laetoli_admin;

-- --- auth.users ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth.users (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text        UNIQUE,
  password_hash text,
  is_anonymous  boolean     NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  auth.users IS 'Identity store. Written only by the laetoli_auth service role.';
COMMENT ON COLUMN auth.users.password_hash IS 'bcrypt hash; NULL for anonymous users.';
COMMENT ON COLUMN auth.users.is_anonymous  IS 'true for signInAnonymously() accounts.';

-- --- auth.uid(): the JWT subject (current user id) ----------------------------
-- PostgREST injects the verified JWT claims as the `request.jwt.claims` GUC.
-- We read "sub" from it. Returns NULL when there is no JWT (anonymous request),
-- so policies like `auth.uid() = user_id` simply deny anon access by default.
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(
           current_setting('request.jwt.claims', true)::json ->> 'sub',
           ''
         )::uuid
$$;

COMMENT ON FUNCTION auth.uid() IS
  'Current user id from the JWT sub claim (Supabase-compatible). NULL if anonymous.';

-- --- auth.role(): the JWT role claim (convenience, Supabase-compatible) --------
CREATE OR REPLACE FUNCTION auth.role()
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(
           current_setting('request.jwt.claims', true)::json ->> 'role',
           ''
         )
$$;

COMMENT ON FUNCTION auth.role() IS 'Current role from the JWT role claim. NULL if anonymous.';

-- --- grants -------------------------------------------------------------------
-- The auth service role owns read/write on auth.users.
GRANT USAGE ON SCHEMA auth TO laetoli_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth.users TO laetoli_auth;

-- Request roles (and authenticator) need EXECUTE on the helpers so RLS policies
-- that call auth.uid()/auth.role() work, plus USAGE on the schema to resolve them.
GRANT USAGE ON SCHEMA auth TO anon, authenticated, authenticator;
GRANT EXECUTE ON FUNCTION auth.uid()  TO anon, authenticated, authenticator;
GRANT EXECUTE ON FUNCTION auth.role() TO anon, authenticated, authenticator;

-- laetoli_admin can manage everything in auth.
GRANT ALL ON SCHEMA auth TO laetoli_admin;
GRANT ALL ON ALL TABLES IN SCHEMA auth TO laetoli_admin;
