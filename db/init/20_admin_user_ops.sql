-- =============================================================================
-- 20_admin_user_ops.sql — account suspension flag on a FRESH boot.
-- -----------------------------------------------------------------------------
-- Single source of truth: includes the canonical migration. Existing databases
-- get the same SQL via `laetoli-data migrate` (0020_admin_user_ops.sql).
-- =============================================================================
\i /migrations/0020_admin_user_ops.sql
