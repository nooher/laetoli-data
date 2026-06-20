-- =============================================================================
-- examples/daftari/schema.sql — the Daftari worked-example schema
-- -----------------------------------------------------------------------------
-- Daftari ("notebook" in Swahili) is the hands-on app the Laetoli Data book
-- walks readers through. It proves the whole sovereign model end to end on ONE
-- owner-scoped table:
--
--   * AUTH    — every row is stamped with the signed-in user (auth.uid()).
--   * RLS     — each user sees / edits ONLY their own notes (and nobody else's).
--   * CRUD    — insert / select / update / delete over the auto REST API.
--   * STORAGE — an optional image attachment per note, in a private bucket.
--   * REALTIME— row changes stream to the owner's other tabs/devices live.
--
-- Apply it to YOUR node (replace the URL/role as your deploy dictates):
--   psql "$DATABASE_URL" -f examples/daftari/schema.sql
-- or paste it into the Admin Studio SQL Console (http://localhost:8088/studio/).
--
-- It is idempotent: re-running is safe (IF NOT EXISTS / DROP POLICY IF EXISTS).
-- This file deliberately mirrors db/init/03_example.sql (the canonical `notes`
-- RLS template) so the book can explain the pattern once and reuse it.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

-- --- the table ----------------------------------------------------------------
-- user_id DEFAULTs to auth.uid(), so a client NEVER sets (or spoofs) the owner —
-- it is taken from the verified JWT at insert time. attachment_path points at an
-- object in the private `daftari` storage bucket (NULL when the note has no file).
CREATE TABLE IF NOT EXISTS public.daftari_notes (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid        NOT NULL DEFAULT auth.uid(),
  title           text        NOT NULL DEFAULT '',
  body            text        NOT NULL DEFAULT '',
  done            boolean     NOT NULL DEFAULT false,
  attachment_path text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.daftari_notes IS
  'Daftari worked-example: owner-scoped notes. RLS limits every row to its user.';

-- Keep updated_at honest on every UPDATE (the realtime stream surfaces it).
CREATE OR REPLACE FUNCTION public.daftari_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS daftari_notes_touch ON public.daftari_notes;
CREATE TRIGGER daftari_notes_touch
  BEFORE UPDATE ON public.daftari_notes
  FOR EACH ROW EXECUTE FUNCTION public.daftari_touch_updated_at();

-- A per-owner, newest-first read is the app's hot path.
CREATE INDEX IF NOT EXISTS daftari_notes_user_created_idx
  ON public.daftari_notes (user_id, created_at DESC);

-- --- grants -------------------------------------------------------------------
-- Table privileges are necessary but NOT sufficient — RLS still gates each row.
-- authenticated gets CRUD; anon gets nothing (no public notes).
GRANT SELECT, INSERT, UPDATE, DELETE ON public.daftari_notes TO authenticated;

-- --- enable + FORCE RLS -------------------------------------------------------
ALTER TABLE public.daftari_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daftari_notes FORCE  ROW LEVEL SECURITY;  -- applies even to owner

-- --- policies (idempotent) — own-rows-only on every verb ----------------------
DROP POLICY IF EXISTS daftari_select_own ON public.daftari_notes;
CREATE POLICY daftari_select_own ON public.daftari_notes
  FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS daftari_insert_own ON public.daftari_notes;
CREATE POLICY daftari_insert_own ON public.daftari_notes
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS daftari_update_own ON public.daftari_notes;
CREATE POLICY daftari_update_own ON public.daftari_notes
  FOR UPDATE TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS daftari_delete_own ON public.daftari_notes;
CREATE POLICY daftari_delete_own ON public.daftari_notes
  FOR DELETE TO authenticated
  USING (auth.uid() = user_id);

-- --- realtime -----------------------------------------------------------------
-- Attach the realtime trigger so INSERT/UPDATE/DELETE stream over the WebSocket.
-- daftari_notes has a `user_id` column, so fan-out is OWNER-AWARE: a change is
-- delivered only to the WS subscriber whose JWT `sub` owns the row (see
-- db/migrations/0002_realtime.sql). Requires the realtime migration applied.
SELECT realtime.enable('public.daftari_notes');

-- =============================================================================
-- STORAGE: the app uploads note attachments to a PRIVATE bucket named `daftari`
-- and reads them back through short-lived SIGNED URLs. Buckets are created via
-- the storage service (the SDK: db.storage.createBucket('daftari')) or the
-- Admin Studio Storage browser — NOT in this SQL file, because object bytes live
-- on the filesystem volume, not in Postgres. The seed script creates it for you.
-- =============================================================================
