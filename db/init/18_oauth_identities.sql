-- =============================================================================
-- 18_oauth_identities.sql — Google OAuth identities on a FRESH boot.
-- -----------------------------------------------------------------------------
-- Single source of truth: includes the canonical migration. Existing databases
-- get the same SQL via `laetoli-data migrate` (0018_oauth_identities.sql).
-- =============================================================================
\i /migrations/0018_oauth_identities.sql
