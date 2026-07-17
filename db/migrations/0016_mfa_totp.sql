-- =============================================================================
-- 0016_mfa_totp.sql — TOTP (authenticator-app) multi-factor authentication
-- -----------------------------------------------------------------------------
-- MIGRATION (run once on an EXISTING database — `laetoli-data migrate`). Also
-- mirrored into db/init/16_mfa_totp.sql for a FRESH boot. Idempotent.
--
-- WHAT THIS ADDS — self-service TOTP enrollment, matching the Supabase
-- `auth.mfa.*` client contract so apps that already built against it (THOS's
-- MfaEnrollment.tsx, built directly on `supabase.auth.mfa.enroll/challenge/
-- verify/unenroll`) need minimal changes to run against Laetoli Data instead:
--   * auth.mfa_factors — one row per enrolled/pending factor. `secret_enc` is
--     AES-256-GCM ciphertext (auth/src/encryption.ts), never plaintext at
--     rest — unlike passwords this can't be one-way hashed, since verifying a
--     TOTP code requires recomputing it from the secret on every check.
--   * auth.mfa_challenges — short-lived challenge rows (the two-step
--     enroll→challenge→verify flow Supabase's API uses), NOT auth.otp_codes,
--     since Supabase's factor/challenge model doesn't collapse to a single
--     request/verify pair the way phone-OTP login does.
--
-- SCOPE NOTE: this migration adds ENROLLMENT + FACTOR MANAGEMENT (what
-- self-service "turn on 2FA" needs). It does NOT yet enforce a second factor
-- at LOGIN time (an AAL1/AAL2 step-up concept, like Supabase's `aal` claim) —
-- that's real additional work, intentionally out of scope here rather than
-- half-built. Track it as a follow-up before treating MFA as fully enforced.
--
-- SECURITY
--   * secret_enc: AES-256-GCM, key derived from JWT_SECRET (see
--     auth/src/encryption.ts) — never exposed through PostgREST, never
--     returned to the client after initial enrollment (the client sees the
--     secret/QR once, at enroll time, exactly like Supabase's own flow).
--   * Only the laetoli_auth service role gets write access. These tables are
--     NEVER exposed through PostgREST — mfa is entirely mediated by the auth
--     service's own REST endpoints (POST /factors, /factors/:id/challenge,
--     /factors/:id/verify, DELETE /factors/:id), not PostgREST CRUD.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

-- --- auth.mfa_factors ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth.mfa_factors (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  factor_type   text        NOT NULL DEFAULT 'totp' CHECK (factor_type = 'totp'),
  status        text        NOT NULL DEFAULT 'unverified' CHECK (status IN ('unverified', 'verified')),
  secret_enc    text        NOT NULL,
  friendly_name text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  verified_at   timestamptz
);
COMMENT ON TABLE auth.mfa_factors IS
  'Enrolled TOTP factors. secret_enc is AES-256-GCM ciphertext (auth/src/encryption.ts) — '
  'never plaintext at rest, never exposed through PostgREST.';
COMMENT ON COLUMN auth.mfa_factors.status IS
  'unverified = enrolled but the first code has not been confirmed yet (pending, per Supabase''s own flow). verified = active, real 2FA.';
CREATE INDEX IF NOT EXISTS mfa_factors_user_idx ON auth.mfa_factors (user_id);

-- --- auth.mfa_challenges (the enroll→challenge→verify handshake) -------------
CREATE TABLE IF NOT EXISTS auth.mfa_challenges (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  factor_id  uuid        NOT NULL REFERENCES auth.mfa_factors(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE auth.mfa_challenges IS
  'Short-lived challenge rows for the factor/challenge/verify handshake. A challenge must exist and be unexpired before /verify accepts a code.';
CREATE INDEX IF NOT EXISTS mfa_challenges_factor_idx ON auth.mfa_challenges (factor_id);
CREATE INDEX IF NOT EXISTS mfa_challenges_expiry_idx ON auth.mfa_challenges (expires_at);

-- --- cleanup: fold into the existing housekeeping function --------------------
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
  DELETE FROM auth.mfa_challenges
    WHERE expires_at < now() OR verified_at IS NOT NULL;
  DELETE FROM auth.mfa_factors
    WHERE status = 'unverified' AND created_at < now() - interval '1 day';
$$;
COMMENT ON FUNCTION auth.cleanup_expired_tokens() IS
  'Deletes expired/consumed auth tokens, OTP codes, and stale MFA challenges/unverified factors. Schedule nightly via scheduler.jobs.';

-- --- grants -------------------------------------------------------------------
-- Only the auth service role writes these; never exposed through PostgREST.
GRANT SELECT, INSERT, UPDATE, DELETE ON auth.mfa_factors    TO laetoli_auth;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth.mfa_challenges TO laetoli_auth;

GRANT ALL ON ALL TABLES IN SCHEMA auth TO laetoli_admin;
