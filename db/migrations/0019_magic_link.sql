-- =============================================================================
-- 0019_magic_link.sql — sovereign email magic-link login
-- -----------------------------------------------------------------------------
-- MIGRATION (run once on an EXISTING database — `laetoli-data migrate`). Also
-- mirrored into db/init/19_magic_link.sql so a FRESH boot gets it too.
-- Idempotent: CREATE ... IF NOT EXISTS, CREATE OR REPLACE.
--
-- WHAT THIS ADDS — passwordless email login via a clickable link, matching
-- Supabase's `signInWithOtp({ email })` UX:
--   * auth.magic_link_tokens — single-use, sha256-HASHED tokens with a short
--       expiry. POST /magiclink issues + emails a link; GET /magiclink/verify
--       consumes it and issues the normal access + refresh tokens.
--
-- SECURITY
--   * The token VALUE is never stored — only its SHA-256 digest, same pattern
--     as reset_tokens / email_verification_tokens (tokens.ts).
--   * Single-use (used_at) + short TTL (default 15 minutes, see config.ts).
--   * Only the laetoli_auth service role gets write access. Never exposed
--     through PostgREST.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

CREATE TABLE IF NOT EXISTS auth.magic_link_tokens (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token_hash text        NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE auth.magic_link_tokens IS
  'Single-use, short-lived email magic-link tokens (sha256-hashed). used_at '
  'marks consumption. Never exposed through PostgREST.';
CREATE INDEX IF NOT EXISTS magic_link_tokens_user_idx   ON auth.magic_link_tokens (user_id);
CREATE INDEX IF NOT EXISTS magic_link_tokens_expiry_idx ON auth.magic_link_tokens (expires_at);

-- --- fold into the existing token-cleanup housekeeping ------------------------
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
  DELETE FROM auth.otp_codes
    WHERE expires_at < now() OR used_at IS NOT NULL;
  DELETE FROM auth.magic_link_tokens
    WHERE expires_at < now() OR used_at IS NOT NULL;
$$;
COMMENT ON FUNCTION auth.cleanup_expired_tokens() IS
  'Deletes expired/consumed auth tokens + OTP codes + magic-link tokens. Schedule nightly via scheduler.jobs.';

-- --- grants -------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON auth.magic_link_tokens TO laetoli_auth;

GRANT ALL ON ALL TABLES IN SCHEMA auth TO laetoli_admin;
