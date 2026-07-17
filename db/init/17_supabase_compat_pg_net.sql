-- =============================================================================
-- 17_supabase_compat_pg_net.sql — pg_net compatibility on a FRESH boot.
-- -----------------------------------------------------------------------------
-- Single source of truth: includes the canonical migration. Existing databases
-- get the same SQL via `laetoli-data migrate` (0017_supabase_compat_pg_net.sql).
-- =============================================================================
\i /migrations/0017_supabase_compat_pg_net.sql
