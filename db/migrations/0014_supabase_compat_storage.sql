-- =============================================================================
-- 0014_supabase_compat_storage.sql — `storage.buckets.id` compatibility column.
-- -----------------------------------------------------------------------------
-- MIGRATION (run once, manually / via your migration runner — also wired into
-- db/init/14_supabase_compat_storage.sql with \i for fresh boots). Idempotent.
--
-- WHAT THIS IS
--   Laetoli Data's storage.buckets uses `name` as its primary key (0001_storage.sql)
--   — a deliberate simplification, since Laetoli Data has no separate bucket-id
--   concept. Supabase's storage.buckets has both `id` and `name`, and
--   Supabase-authored SQL conventionally does
--     insert into storage.buckets (id, name, public) values ('x', 'x', false)
--   with id and name always equal. Similarly, Supabase's storage.objects has
--   `bucket_id` and `name` where Laetoli Data's are `bucket` and `path`. Found
--   by testing THOS's real migrations against this project — 4 of THOS's 57
--   migrations hit all three of these in sequence (buckets.id, then
--   objects.bucket_id, then objects.name, each surfacing only once the
--   previous one was fixed) inside their storage RLS policies.
--
--   Adds `storage.buckets.id` as a genuine unique column, plus
--   `storage.objects.bucket_id` and `storage.objects.name` as STORED
--   GENERATED columns mirroring `bucket`/`path` (always in sync, no trigger
--   drift possible for the generated pair; buckets.id uses a trigger since it
--   isn't a strict 1:1 function of another column on insert). Does NOT change
--   either table's primary key or the existing `bucket`/`path` columns —
--   additive compatibility, not a redesign of the simpler native shape.
--   Laetoli Data's own storage code (storage/src/db.ts) is unaffected; it
--   only ever reads/writes `bucket`/`path` and can keep doing so.
-- =============================================================================

ALTER TABLE storage.buckets ADD COLUMN IF NOT EXISTS id text;

-- Backfill any existing rows (native laetoli-data buckets never set id).
UPDATE storage.buckets SET id = name WHERE id IS NULL;

ALTER TABLE storage.buckets ALTER COLUMN id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS buckets_id_unique ON storage.buckets (id);

-- Default id to name on insert when the caller omits it (native code path);
-- Supabase-style inserts that pass id explicitly are left untouched.
CREATE OR REPLACE FUNCTION storage.buckets_default_id()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS NULL THEN
    NEW.id := NEW.name;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS buckets_default_id_trg ON storage.buckets;
CREATE TRIGGER buckets_default_id_trg
  BEFORE INSERT ON storage.buckets
  FOR EACH ROW
  EXECUTE FUNCTION storage.buckets_default_id();

COMMENT ON COLUMN storage.buckets.id IS
  'Supabase-compatibility column — defaults to name via trigger when omitted. name stays the real primary key; this is additive, not a redesign. See docs/SUPABASE_COMPAT.md.';

-- --- storage.objects.bucket_id (mirrors `bucket`, always in sync) ------------
ALTER TABLE storage.objects ADD COLUMN IF NOT EXISTS bucket_id text
  GENERATED ALWAYS AS (bucket) STORED;

CREATE INDEX IF NOT EXISTS objects_bucket_id_idx ON storage.objects (bucket_id);

COMMENT ON COLUMN storage.objects.bucket_id IS
  'Supabase-compatibility column — STORED GENERATED mirror of `bucket`, always in sync (cannot drift). Ported Supabase RLS policies reference bucket_id directly. See docs/SUPABASE_COMPAT.md.';

-- --- storage.objects.name (mirrors `path`, always in sync) -------------------
-- Supabase's object-path column is `name`; Laetoli Data's is `path`. Same
-- STORED GENERATED mirror pattern as bucket_id above.
ALTER TABLE storage.objects ADD COLUMN IF NOT EXISTS name text
  GENERATED ALWAYS AS (path) STORED;

CREATE INDEX IF NOT EXISTS objects_name_idx ON storage.objects (name);

COMMENT ON COLUMN storage.objects.name IS
  'Supabase-compatibility column — STORED GENERATED mirror of `path`, always in sync (cannot drift). Ported Supabase RLS policies/functions reference objects.name directly (e.g. split_part(storage.objects.name, ...)). See docs/SUPABASE_COMPAT.md.';
