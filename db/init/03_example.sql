-- =============================================================================
-- 03_example.sql — public.notes: the end-to-end RLS template
-- -----------------------------------------------------------------------------
-- Proves the whole model: a signed-in user can only see/modify THEIR OWN rows,
-- enforced by Row-Level Security using auth.uid() (the JWT sub). Copy this file
-- as the starting point for any new owner-scoped table.
--
-- How it works at request time:
--   1. Client sends JWT -> Caddy -> PostgREST.
--   2. PostgREST verifies the JWT (PGRST_JWT_SECRET), SET ROLE to the "role"
--      claim (authenticated), and sets request.jwt.claims.
--   3. auth.uid() reads sub from those claims.
--   4. The policies below filter rows to auth.uid() = user_id.
--   5. On INSERT, user_id defaults to auth.uid() so clients never spoof owner.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.notes (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL DEFAULT auth.uid(),
  body       text,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.notes IS 'Demo owner-scoped table. RLS template for Laetoli Data.';

-- --- grants -------------------------------------------------------------------
-- Table privileges are necessary but NOT sufficient: RLS policies still gate
-- every row. We grant CRUD to authenticated; anon gets nothing (no public rows).
GRANT SELECT, INSERT, UPDATE, DELETE ON public.notes TO authenticated;
-- (Intentionally no grant to anon — flip this on if you want public reads.)

-- --- enable + force RLS -------------------------------------------------------
ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notes FORCE  ROW LEVEL SECURITY;  -- applies even to table owner

-- --- policies (idempotent) ----------------------------------------------------
DROP POLICY IF EXISTS notes_select_own ON public.notes;
CREATE POLICY notes_select_own ON public.notes
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS notes_insert_own ON public.notes;
CREATE POLICY notes_insert_own ON public.notes
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS notes_update_own ON public.notes;
CREATE POLICY notes_update_own ON public.notes
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS notes_delete_own ON public.notes;
CREATE POLICY notes_delete_own ON public.notes
  FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- =============================================================================
-- TEMPLATE: to make a new owner-scoped table, copy the block above and rename.
-- For a public-readable table, also: GRANT SELECT ... TO anon; and add a
-- SELECT policy `FOR SELECT TO anon USING (true);`.
-- =============================================================================
