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
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  username       text        UNIQUE,
  password_hash  text,
  is_anonymous   boolean     NOT NULL DEFAULT false,
  email          text,
  email_verified boolean     NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Email is OPTIONAL (username/password + anonymous must still work). It is
-- unique only WHEN PRESENT — a partial unique index allows many NULL emails.
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique
  ON auth.users (email) WHERE email IS NOT NULL;

COMMENT ON TABLE  auth.users IS 'Identity store. Written only by the laetoli_auth service role.';
COMMENT ON COLUMN auth.users.password_hash  IS 'bcrypt hash; NULL for anonymous users.';
COMMENT ON COLUMN auth.users.is_anonymous   IS 'true for signInAnonymously() accounts.';
COMMENT ON COLUMN auth.users.email          IS 'Optional contact email; unique when present.';
COMMENT ON COLUMN auth.users.email_verified IS 'true once the email has been confirmed.';

-- --- auth token tables (refresh / reset / email-verification) ----------------
-- All token VALUES are opaque crypto.randomBytes, returned once to the client
-- and stored ONLY as their SHA-256 hash (token_hash). See 0009_auth_tokens.sql
-- for the full rationale; kept here so fresh boots get the schema too.

CREATE TABLE IF NOT EXISTS auth.refresh_tokens (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token_hash text        NOT NULL UNIQUE,
  family_id  uuid        NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  user_agent text
);
COMMENT ON TABLE auth.refresh_tokens IS
  'Opaque rotating refresh tokens (sha256-hashed). A family_id ties a rotation '
  'chain together so reuse of a revoked token can revoke the whole family.';
CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx   ON auth.refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_family_idx ON auth.refresh_tokens (family_id);
CREATE INDEX IF NOT EXISTS refresh_tokens_expiry_idx ON auth.refresh_tokens (expires_at);

CREATE TABLE IF NOT EXISTS auth.reset_tokens (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token_hash text        NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE auth.reset_tokens IS
  'Single-use, short-lived password-reset tokens (sha256-hashed).';
CREATE INDEX IF NOT EXISTS reset_tokens_user_idx   ON auth.reset_tokens (user_id);
CREATE INDEX IF NOT EXISTS reset_tokens_expiry_idx ON auth.reset_tokens (expires_at);

CREATE TABLE IF NOT EXISTS auth.email_verification_tokens (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token_hash text        NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE auth.email_verification_tokens IS
  'Single-use, short-lived email-verification tokens (sha256-hashed).';
CREATE INDEX IF NOT EXISTS email_verification_tokens_user_idx
  ON auth.email_verification_tokens (user_id);
CREATE INDEX IF NOT EXISTS email_verification_tokens_expiry_idx
  ON auth.email_verification_tokens (expires_at);

-- Cleanup helper: delete expired (and consumed/revoked) token rows. Run from a
-- scheduler.jobs kind='sql' entry, e.g. nightly.
CREATE OR REPLACE FUNCTION auth.cleanup_expired_tokens()
RETURNS void
LANGUAGE sql
AS $$
  DELETE FROM auth.refresh_tokens
    WHERE expires_at < now() OR revoked_at < now() - interval '7 days';
  DELETE FROM auth.reset_tokens
    WHERE expires_at < now() OR used_at IS NOT NULL;
  DELETE FROM auth.email_verification_tokens
    WHERE expires_at < now() OR used_at IS NOT NULL;
$$;
COMMENT ON FUNCTION auth.cleanup_expired_tokens() IS
  'Deletes expired/consumed auth tokens. Schedule nightly via scheduler.jobs.';

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
GRANT SELECT, INSERT, UPDATE, DELETE ON auth.refresh_tokens TO laetoli_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth.reset_tokens TO laetoli_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth.email_verification_tokens TO laetoli_auth;

-- Request roles (and authenticator) need EXECUTE on the helpers so RLS policies
-- that call auth.uid()/auth.role() work, plus USAGE on the schema to resolve them.
GRANT USAGE ON SCHEMA auth TO anon, authenticated, authenticator;
GRANT EXECUTE ON FUNCTION auth.uid()  TO anon, authenticated, authenticator;
GRANT EXECUTE ON FUNCTION auth.role() TO anon, authenticated, authenticator;

-- laetoli_admin can manage everything in auth.
GRANT ALL ON SCHEMA auth TO laetoli_admin;
GRANT ALL ON ALL TABLES IN SCHEMA auth TO laetoli_admin;
