-- =============================================================================
-- 0001_storage.sql — object storage schema (buckets + object metadata)
-- -----------------------------------------------------------------------------
-- This is a MIGRATION (run once against an existing DB), not an initdb file.
-- It is written to be idempotent-ish: re-running it is safe (IF NOT EXISTS /
-- DROP POLICY IF EXISTS / CREATE OR REPLACE everywhere).
--
-- Companion to the Node storage service (storage/, :9998), which connects AS the
-- `laetoli_storage` LOGIN role and is the ONLY role granted write access to
-- these tables. Object BYTES live on a mounted filesystem volume at
-- STORAGE_ROOT; only METADATA lives here. The service enforces owner/public
-- rules in application code; the RLS below is defence in depth for any direct
-- PostgREST access via the authenticated request role.
--
-- Apply manually (see DEPLOY.md):
--   psql "$DATABASE_URL" -f db/migrations/0001_storage.sql
--
-- PASSWORD: like the other LOGIN roles (01_roles.sql), this file does NOT
-- hardcode a password. After running it once, set the login secret:
--   ALTER ROLE laetoli_storage WITH PASSWORD '${POSTGRES_PASSWORD}';
-- The storage service connects as:
--   postgres://laetoli_storage:${POSTGRES_PASSWORD}@db:5432/${POSTGRES_DB}
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

-- --- role: laetoli_storage (the Node storage service connects AS this) --------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'laetoli_storage') THEN
    CREATE ROLE laetoli_storage LOGIN NOINHERIT;
  END IF;
END $$;

-- --- schema -------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS storage AUTHORIZATION laetoli_admin;

-- --- storage.buckets ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS storage.buckets (
  name       text        PRIMARY KEY,
  public     boolean     NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE  storage.buckets IS 'Storage buckets. public=true means anonymous downloads are allowed.';
COMMENT ON COLUMN storage.buckets.public IS 'true → GET /object/<bucket>/* requires no JWT.';

-- --- storage.objects ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS storage.objects (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket     text        NOT NULL REFERENCES storage.buckets(name) ON DELETE CASCADE,
  path       text        NOT NULL,
  size       bigint      NOT NULL DEFAULT 0,
  mime       text        NOT NULL DEFAULT 'application/octet-stream',
  owner      uuid        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bucket, path)
);

COMMENT ON TABLE  storage.objects IS 'Object metadata. Bytes live on the filesystem volume at STORAGE_ROOT.';
COMMENT ON COLUMN storage.objects.owner IS 'auth.users.id of the uploader (JWT sub).';

CREATE INDEX IF NOT EXISTS objects_bucket_path_idx ON storage.objects (bucket, path);
CREATE INDEX IF NOT EXISTS objects_owner_idx       ON storage.objects (owner);

-- --- grants -------------------------------------------------------------------
-- The storage service role owns read/write on both tables.
GRANT USAGE ON SCHEMA storage TO laetoli_storage;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.buckets TO laetoli_storage;
GRANT SELECT, INSERT, UPDATE, DELETE ON storage.objects TO laetoli_storage;

-- Request roles get USAGE so RLS-gated reads work if exposed via PostgREST.
GRANT USAGE ON SCHEMA storage TO anon, authenticated, authenticator;
-- Authenticated users may read object metadata directly (RLS still applies);
-- writes go exclusively through the storage service (laetoli_storage).
GRANT SELECT ON storage.objects TO authenticated;
GRANT SELECT ON storage.buckets TO anon, authenticated;

-- laetoli_admin can manage everything in storage.
GRANT ALL ON SCHEMA storage TO laetoli_admin;
GRANT ALL ON ALL TABLES IN SCHEMA storage TO laetoli_admin;

-- --- RLS (owner-based; defence in depth) --------------------------------------
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.objects FORCE  ROW LEVEL SECURITY;  -- applies even to table owner
ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.buckets FORCE  ROW LEVEL SECURITY;

-- The storage service role bypasses RLS for its own role via explicit policies
-- (it is NOT laetoli_admin / BYPASSRLS): grant it full row access.
DROP POLICY IF EXISTS objects_service_all ON storage.objects;
CREATE POLICY objects_service_all ON storage.objects
  FOR ALL TO laetoli_storage
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS buckets_service_all ON storage.buckets;
CREATE POLICY buckets_service_all ON storage.buckets
  FOR ALL TO laetoli_storage
  USING (true) WITH CHECK (true);

-- Authenticated request role: may read its OWN objects, plus objects in PUBLIC
-- buckets. (Mirrors the service's download rule; keeps direct PostgREST safe.)
DROP POLICY IF EXISTS objects_select_own_or_public ON storage.objects;
CREATE POLICY objects_select_own_or_public ON storage.objects
  FOR SELECT TO authenticated
  USING (
    owner = auth.uid()
    OR EXISTS (
      SELECT 1 FROM storage.buckets b
      WHERE b.name = storage.objects.bucket AND b.public
    )
  );

-- Anyone (anon + authenticated) may read bucket rows so public-bucket checks
-- resolve; no write policy for request roles (writes are service-only).
DROP POLICY IF EXISTS buckets_select_all ON storage.buckets;
CREATE POLICY buckets_select_all ON storage.buckets
  FOR SELECT TO anon, authenticated
  USING (true);

-- =============================================================================
-- NOTE: object bytes are on the filesystem, so deleting a row here does NOT
-- delete the file — always go through the storage service (DELETE /object/...)
-- which removes both. The ON DELETE CASCADE above only cleans metadata when a
-- bucket row is removed.
-- =============================================================================
