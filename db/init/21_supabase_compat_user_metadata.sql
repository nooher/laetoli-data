-- =============================================================================
-- 21_supabase_compat_user_metadata.sql — raw_user_meta_data on a FRESH boot.
-- -----------------------------------------------------------------------------
-- Single source of truth: includes the canonical migration. Existing databases
-- get the same SQL via `laetoli-data migrate` (0021_supabase_compat_user_metadata.sql).
-- =============================================================================
\i /migrations/0021_supabase_compat_user_metadata.sql
