-- =============================================================================
-- 13_supabase_compat_roles.sql — `service_role` alias on a FRESH boot.
-- -----------------------------------------------------------------------------
-- Single source of truth: includes the canonical migration. Existing databases
-- get the same SQL via `laetoli-data migrate` (0013_supabase_compat_roles.sql).
-- =============================================================================
\i /migrations/0013_supabase_compat_roles.sql
