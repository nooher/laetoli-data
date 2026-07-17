-- =============================================================================
-- 0018_oauth_identities.sql — Google OAuth (signInWithOAuth compatibility)
-- -----------------------------------------------------------------------------
-- MIGRATION (run once on an EXISTING database — `laetoli-data migrate`). Also
-- mirrored into db/init/18_oauth_identities.sql for a FRESH boot. Idempotent.
--
-- WHAT THIS ADDS
--   auth.oauth_identities links a Postgres auth.users row to an external
--   provider identity (provider + provider_user_id, e.g. Google's `sub`).
--   Deliberately NOT matched by email — matching by email alone would let an
--   attacker who pre-registers a victim's email with a password "capture"
--   the victim's Google sign-in later. The identity link is the source of
--   truth; email is stored for reference only.
--
-- WHY THIS EXISTS
--   Found by auditing Kasuku's real auth usage: it calls
--   `supabase.auth.signInWithOAuth({provider: 'google'})`. Laetoli Data had
--   no OAuth support at all before this — see docs/OAUTH.md for the full flow
--   (auth/src/oauth.ts + the /oauth/google/* handlers).
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS auth.oauth_identities (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider          text        NOT NULL CHECK (provider = 'google'),
  provider_user_id  text        NOT NULL,
  email             text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE auth.oauth_identities IS
  'Links a local user to an external OAuth identity (provider + provider_user_id). The source of truth for OAuth login — email is reference-only, never used to match/merge accounts.';

CREATE UNIQUE INDEX IF NOT EXISTS oauth_identities_provider_user_unique
  ON auth.oauth_identities (provider, provider_user_id);
CREATE INDEX IF NOT EXISTS oauth_identities_user_idx ON auth.oauth_identities (user_id);

-- --- grants -------------------------------------------------------------------
GRANT SELECT, INSERT ON auth.oauth_identities TO laetoli_auth;
GRANT ALL ON ALL TABLES IN SCHEMA auth TO laetoli_admin;
