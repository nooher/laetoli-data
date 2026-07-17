-- =============================================================================
-- 0020_admin_user_ops.sql — account suspension flag for admin user-ops
-- -----------------------------------------------------------------------------
-- MIGRATION (run once on an EXISTING database — `laetoli-data migrate`). Also
-- mirrored into db/init/20_admin_user_ops.sql so a FRESH boot gets it too.
-- Idempotent: ALTER TABLE ... ADD COLUMN IF NOT EXISTS.
--
-- WHAT THIS ADDS — the ONE new column the admin service's user-ops need:
--   * auth.users.suspended_at — NULL = active, set = the account is suspended.
--       Checked by the auth service on every token-ISSUING path (password
--       login, OTP verify, magic-link verify, OAuth callback, refresh) so a
--       suspended account cannot obtain a new session. An access token already
--       issued before suspension still works until its (short) exp, same as
--       every other revocation in this service — pair a suspend with the
--       companion "revoke sessions" admin op for immediate effect.
--
-- The other 3 admin user-ops (revoke-sessions, reset-mfa, invite) need NO new
-- schema — they operate on auth.refresh_tokens / auth.mfa_factors (already
-- admin-writable) and the existing magic-link flow (invite = the SAME
-- find-or-create-and-email flow as self-service magic-link, just admin-
-- triggered — see admin/src/handlers.ts:handleInviteUser).
-- =============================================================================

ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS suspended_at timestamptz;

COMMENT ON COLUMN auth.users.suspended_at IS
  'NULL = active. Set by an admin (admin service /users/:id/suspend) to block '
  'new token issuance; does NOT invalidate already-issued access tokens (pair '
  'with /users/:id/revoke-sessions for immediate lockout).';

CREATE INDEX IF NOT EXISTS users_suspended_idx
  ON auth.users (suspended_at) WHERE suspended_at IS NOT NULL;

-- No new GRANT needed: table-level grants (auth.users → laetoli_auth,
-- laetoli_admin) already cover this new column.
