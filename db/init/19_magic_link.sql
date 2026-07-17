-- =============================================================================
-- 19_magic_link.sql — email magic-link login on a FRESH boot.
-- -----------------------------------------------------------------------------
-- Single source of truth: includes the canonical migration. Existing databases
-- get the same SQL via `laetoli-data migrate` (0019_magic_link.sql).
-- =============================================================================
\i /migrations/0019_magic_link.sql
