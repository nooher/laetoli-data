-- =============================================================================
-- 0021_supabase_compat_user_metadata.sql — auth.users.raw_user_meta_data
-- -----------------------------------------------------------------------------
-- MIGRATION (run once on an EXISTING database — `laetoli-data migrate`). Also
-- mirrored into db/init/21_supabase_compat_user_metadata.sql so a FRESH boot
-- gets it too. Idempotent: ALTER TABLE ... ADD COLUMN IF NOT EXISTS.
--
-- WHAT THIS ADDS: a Supabase-named `auth.users.raw_user_meta_data` jsonb
-- column. Ported Supabase apps commonly install a `handle_new_user()` trigger
-- (`AFTER INSERT ON auth.users`) that reads `NEW.raw_user_meta_data->>'...'`
-- to populate an app-specific profile row (full name, role, phone, etc.) at
-- signup — found via THOS's own migrations (0001_init.sql, 0036_security_
-- hardening.sql). Without this column, that trigger fails on the very first
-- signup with "column raw_user_meta_data does not exist" — this is schema
-- compat only; the auth service (see auth/src/handlers.ts) is what actually
-- WRITES a caller-supplied metadata object into it on signup.
-- =============================================================================

ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN auth.users.raw_user_meta_data IS
  'Caller-supplied signup metadata (Supabase-compat name/shape). Written by '
  'the auth service from signUp({options:{data}}); read by ported apps'' own '
  'handle_new_user()-style triggers. Never used by laetoli-data itself.';

-- No new GRANT needed: table-level grants (auth.users -> laetoli_auth,
-- laetoli_admin) already cover this new column.
