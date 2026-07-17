-- =============================================================================
-- 16_mfa_totp.sql — TOTP multi-factor auth tables on a FRESH boot.
-- -----------------------------------------------------------------------------
-- Single source of truth: includes the canonical migration. Existing databases
-- get the same SQL via `laetoli-data migrate` (0016_mfa_totp.sql).
-- =============================================================================
\i /migrations/0016_mfa_totp.sql
