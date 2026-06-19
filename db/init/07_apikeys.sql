-- =============================================================================
-- 07_apikeys.sql — API keys + projects + quotas on a FRESH database boot.
-- -----------------------------------------------------------------------------
-- Single source of truth: includes the canonical migration. Existing databases
-- get the same SQL via `laetoli-data migrate` (0004_apikeys.sql).
-- =============================================================================
\i /migrations/0004_apikeys.sql
