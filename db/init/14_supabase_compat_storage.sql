-- =============================================================================
-- 14_supabase_compat_storage.sql — storage.buckets.id on a FRESH boot.
-- -----------------------------------------------------------------------------
-- Single source of truth: includes the canonical migration. Existing databases
-- get the same SQL via `laetoli-data migrate` (0014_supabase_compat_storage.sql).
-- =============================================================================
\i /migrations/0014_supabase_compat_storage.sql
