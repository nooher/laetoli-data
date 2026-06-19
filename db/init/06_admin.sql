-- =============================================================================
-- 06_admin.sql — admin API login role on a FRESH database boot.
-- -----------------------------------------------------------------------------
-- Single source of truth: includes the canonical migration. On fresh boot
-- 00_passwords.sh already created `laetoli_admin_login` (LOGIN INHERIT) with its
-- password, so the migration's guarded CREATE is a no-op and it just adds the
-- laetoli_admin membership + BYPASSRLS attribute + schema grants. Existing
-- databases get the same SQL via `laetoli-data migrate` (0003_admin.sql).
-- =============================================================================
\i /migrations/0003_admin.sql
