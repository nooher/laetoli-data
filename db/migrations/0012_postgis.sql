-- =============================================================================
-- 0012_postgis.sql — PostGIS (geo/location queries) on a FRESH boot.
-- -----------------------------------------------------------------------------
-- MIGRATION (run once, manually / via your migration runner — also wired into
-- db/init/12_geo.sql with \i for fresh boots). Idempotent: safe to re-run
-- (CREATE EXTENSION/TABLE/INDEX ... IF NOT EXISTS, DROP POLICY IF EXISTS,
-- CREATE OR REPLACE FUNCTION, GRANTs are naturally re-runnable).
--
-- WHAT THIS IS
--   The geo/location layer: geography columns + distance/radius search inside
--   the sovereign Postgres — the equivalent of Supabase's PostGIS support.
--   Needed by any location-aware Laetoli product (provider-near-me search,
--   delivery zones, facility finders) — THOS specifically requires this to
--   migrate off Supabase, since its schema stores provider locations as
--   geography(Point,4326) and searches them with ST_DWithin.
--
-- REQUIRES
--   The `postgis` extension, shipped by this project's own db/Dockerfile
--   (pgvector/pgvector:pg16 + postgresql-16-postgis-3 layered on top). On the
--   stock pgvector/pgvector:pg16 image (without this Dockerfile) the CREATE
--   EXTENSION below fails — build the db image from db/Dockerfile first (see
--   docs/GEO.md).
--
-- WHO CONNECTS / ACCESS
--   `public.places` is an owner-scoped table reached through PostgREST as the
--   request role (authenticated). It mirrors public.notes (03_example.sql)
--   and public.documents (0005_vectors.sql): RLS confines every row to its
--   owner via auth.uid(). nearby_places() runs SECURITY INVOKER so the SAME
--   RLS applies inside the function — a caller can only search against rows
--   they own. For a WORLD-READABLE directory (e.g. a public provider
--   directory, THOS's actual use case), drop the owner-scoped SELECT policy
--   and grant SELECT to anon instead — see the comment above the policy block.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS postgis;   -- geography/geometry types + ST_* functions

-- --- public.places (owner-scoped location store, template) -------------------
CREATE TABLE IF NOT EXISTS public.places (
  id         uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  owner      uuid         NOT NULL DEFAULT auth.uid(),
  name       text         NOT NULL,
  category   text,
  location   geography(Point, 4326) NOT NULL,
  metadata   jsonb        NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz  NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.places IS 'Geo-tagged location store (template). Owner-scoped via RLS by default; searched by public.nearby_places(). See docs/GEO.md for a world-readable directory variant.';
COMMENT ON COLUMN public.places.owner    IS 'auth.users.id of the owner (JWT sub). Defaults to auth.uid() so clients never spoof it.';
COMMENT ON COLUMN public.places.location IS 'geography(Point,4326) — WGS84 lon/lat. Insert with ST_MakePoint(lng, lat)::geography.';
COMMENT ON COLUMN public.places.metadata IS 'Free-form JSON tags used to filter search (e.g. specialty, insurance accepted).';

-- Quick owner lookups (RLS predicate).
CREATE INDEX IF NOT EXISTS places_owner_idx ON public.places (owner);

-- --- spatial index (GiST) ------------------------------------------------------
-- GiST accelerates ST_DWithin / distance ordering — the standard PostGIS index.
CREATE INDEX IF NOT EXISTS places_location_gix ON public.places USING gist (location);

-- --- grants -------------------------------------------------------------------
-- CRUD to authenticated; RLS still gates every row. anon gets nothing by
-- default — see docs/GEO.md to flip this table to a public directory instead.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.places TO authenticated;

-- --- enable + force RLS -------------------------------------------------------
ALTER TABLE public.places ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.places FORCE  ROW LEVEL SECURITY;  -- applies even to table owner

-- --- policies (owner-scoped, idempotent) --------------------------------------
DROP POLICY IF EXISTS places_select_own ON public.places;
CREATE POLICY places_select_own ON public.places
  FOR SELECT TO authenticated
  USING (auth.uid() = owner);

DROP POLICY IF EXISTS places_insert_own ON public.places;
CREATE POLICY places_insert_own ON public.places
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = owner);

DROP POLICY IF EXISTS places_update_own ON public.places;
CREATE POLICY places_update_own ON public.places
  FOR UPDATE TO authenticated
  USING (auth.uid() = owner)
  WITH CHECK (auth.uid() = owner);

DROP POLICY IF EXISTS places_delete_own ON public.places;
CREATE POLICY places_delete_own ON public.places
  FOR DELETE TO authenticated
  USING (auth.uid() = owner);

-- --- public.nearby_places() — radius search, nearest-first --------------------
-- Returns places within max_km of (lat, lng), nearest first, with distance in
-- kilometres. Mirrors the shape of a typical "providers near me" RPC.
--
-- SECURITY INVOKER (the default, stated explicitly): the function runs with the
-- CALLER's privileges, so RLS on public.places applies — a user only ever
-- searches their OWN rows under the default owner-scoped policy above. For a
-- public directory, grant EXECUTE to anon too (see below) once the table's
-- policy is switched to world-readable.
CREATE OR REPLACE FUNCTION public.nearby_places(
  lat      double precision,
  lng      double precision,
  max_km   double precision DEFAULT 25,
  category text             DEFAULT NULL
)
RETURNS TABLE (
  id         uuid,
  name       text,
  category   text,
  metadata   jsonb,
  distance_km double precision
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    p.id,
    p.name,
    p.category,
    p.metadata,
    ST_Distance(p.location, ST_MakePoint(lng, lat)::geography) / 1000.0 AS distance_km
  FROM public.places p
  WHERE ST_DWithin(p.location, ST_MakePoint(lng, lat)::geography, max_km * 1000)
    AND (category IS NULL OR p.category = category)
  ORDER BY p.location <-> ST_MakePoint(lng, lat)::geography  -- KNN index scan, nearest first
  LIMIT 200;
$$;

COMMENT ON FUNCTION public.nearby_places(double precision, double precision, double precision, text)
  IS 'Radius search over public.places (RLS-scoped to caller by default). Returns rows within max_km, nearest first, with distance_km.';

-- PostgREST exposes this as POST /rest/rpc/nearby_places.
GRANT EXECUTE ON FUNCTION public.nearby_places(double precision, double precision, double precision, text) TO authenticated;
-- To open to anon too (only sensible once the table itself is world-readable):
-- GRANT EXECUTE ON FUNCTION public.nearby_places(double precision, double precision, double precision, text) TO anon;

-- =============================================================================
-- NOTE: `places` is a TEMPLATE, same pattern as `documents` in 0005_vectors.sql.
-- For a real provider/facility directory (THOS's use case), copy this table +
-- RLS + function block, rename to your domain (e.g. providers), and switch the
-- SELECT policy to `USING (true)` + `GRANT SELECT ... TO anon` for a
-- world-readable directory while keeping INSERT/UPDATE/DELETE owner-scoped —
-- exactly the pattern THOS's own providers_read/providers_self_write policies
-- use today. See docs/GEO.md "Make your own location tables".
-- =============================================================================
