-- =============================================================================
-- 15_supabase_compat_realtime.sql — supabase_realtime publication on a FRESH boot.
-- -----------------------------------------------------------------------------
-- Single source of truth: includes the canonical migration. Existing databases
-- get the same SQL via `laetoli-data migrate` (0015_supabase_compat_realtime.sql).
-- Schema-compatibility only — see the migration file for what this does NOT do.
-- =============================================================================
\i /migrations/0015_supabase_compat_realtime.sql
