-- =============================================================================
-- 0009_rls_audit.sql — RLS policy guard (operator verification helper)
-- -----------------------------------------------------------------------------
-- This is a MIGRATION (run once against an existing DB via `laetoli-data
-- migrate`), not an initdb file. It is idempotent (CREATE OR REPLACE / IF NOT
-- EXISTS everywhere) and applied inside its own transaction by the runner.
--
-- It does NOT change any table's security. It only SURFACES gaps so an operator
-- can answer "is every app table protected?" before exposing the stack to the
-- public internet (e.g. over a Cloudflare tunnel). See SECURITY.md "RLS audit".
--
-- It inspects ONLY user/application schemas (public, storage, auth and any
-- other non-system schema) — never pg_catalog / information_schema / the
-- pg_toast et al. PostgREST exposes PGRST_DB_SCHEMAS (default `public`), so the
-- `public` rows are the ones that truly matter for browser-reachable data.
--
-- Apply:
--   laetoli-data migrate            # applies this with the rest
--   -- or manually:
--   psql "$DATABASE_URL" -f db/migrations/0009_rls_audit.sql
--
-- Use (as a superuser / laetoli_admin):
--   SELECT * FROM public.rls_audit;                 -- gaps only (the watchlist)
--   SELECT * FROM public.rls_audit_all;             -- every app table + status
--   SELECT * FROM public.rls_audit WHERE schema = 'public';
-- =============================================================================

-- --- public.rls_audit_all -----------------------------------------------------
-- One row per ordinary table in every non-system schema, with its RLS status.
--   rls_enabled : ALTER TABLE ... ENABLE ROW LEVEL SECURITY is in effect.
--   rls_forced  : ENABLE + FORCE (RLS also applies to the table owner).
--   policy_count: number of policies attached.
--   status      : human-readable verdict (see CASE below).
CREATE OR REPLACE VIEW public.rls_audit_all AS
SELECT
  n.nspname::text                                   AS schema,
  c.relname::text                                   AS table_name,
  c.relrowsecurity                                  AS rls_enabled,
  c.relforcerowsecurity                             AS rls_forced,
  COALESCE(p.policy_count, 0)::int                  AS policy_count,
  CASE
    WHEN NOT c.relrowsecurity                       THEN 'RLS DISABLED'
    WHEN COALESCE(p.policy_count, 0) = 0            THEN 'RLS enabled but NO POLICIES (default-deny)'
    WHEN NOT c.relforcerowsecurity                  THEN 'OK (not forced — table owner bypasses RLS)'
    ELSE 'OK (enabled + forced)'
  END                                               AS status
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN (
  SELECT schemaname, tablename, COUNT(*) AS policy_count
  FROM pg_policies
  GROUP BY schemaname, tablename
) p ON p.schemaname = n.nspname AND p.tablename = c.relname
WHERE c.relkind = 'r'                          -- ordinary tables only
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND n.nspname NOT LIKE 'pg_toast%'
  AND n.nspname NOT LIKE 'pg_temp%'
ORDER BY n.nspname, c.relname;

COMMENT ON VIEW public.rls_audit_all IS
  'Every application table with its RLS status. See public.rls_audit for gaps only. Added by 0009_rls_audit.sql.';

-- --- public.rls_audit ---------------------------------------------------------
-- The watchlist: only tables with a GAP (RLS disabled, or enabled with zero
-- policies → default-deny but worth confirming it is intentional). Empty result
-- == every app table is protected.
CREATE OR REPLACE VIEW public.rls_audit AS
SELECT *
FROM public.rls_audit_all
WHERE NOT rls_enabled
   OR policy_count = 0;

COMMENT ON VIEW public.rls_audit IS
  'Application tables with an RLS gap (disabled, or enabled-with-no-policies). Empty == all tables protected. Added by 0009_rls_audit.sql.';

-- --- public.rls_audit_summary() ----------------------------------------------
-- A one-row digest for scripts/healthchecks: total app tables, how many are
-- protected, and how many have a gap. Lets an operator gate a deploy on
-- "gaps = 0" without parsing the detail views.
CREATE OR REPLACE FUNCTION public.rls_audit_summary()
RETURNS TABLE (total_tables int, protected int, gaps int)
LANGUAGE sql
STABLE
AS $$
  SELECT
    COUNT(*)::int                                            AS total_tables,
    COUNT(*) FILTER (WHERE rls_enabled AND policy_count > 0)::int AS protected,
    COUNT(*) FILTER (WHERE NOT rls_enabled OR policy_count = 0)::int AS gaps
  FROM public.rls_audit_all;
$$;

COMMENT ON FUNCTION public.rls_audit_summary() IS
  'One-row RLS digest (total/protected/gaps). gaps=0 means every app table is protected. Added by 0009_rls_audit.sql.';

-- --- grants -------------------------------------------------------------------
-- Visible to laetoli_admin (the Studio / admin API) only. The request roles
-- (anon, authenticated) are deliberately NOT granted: the catalog of which
-- tables lack RLS is operator information, not public.
GRANT SELECT ON public.rls_audit_all TO laetoli_admin;
GRANT SELECT ON public.rls_audit     TO laetoli_admin;
GRANT EXECUTE ON FUNCTION public.rls_audit_summary() TO laetoli_admin;

-- =============================================================================
-- SELF-TEST (manual; run after applying):
--   -- expect 0 rows once every app table is locked down:
--   SELECT * FROM public.rls_audit;
--   -- expect gaps = 0:
--   SELECT * FROM public.rls_audit_summary();
-- The shipped tables (public.notes, storage.objects/buckets, auth.*) all enable
-- RLS in their own migrations, so on a clean install rls_audit returns only any
-- tables an operator added without protection — exactly the gaps to review.
-- =============================================================================
