-- =============================================================================
-- 0015_supabase_compat_realtime.sql — `supabase_realtime` publication shim.
-- -----------------------------------------------------------------------------
-- MIGRATION (run once, manually / via your migration runner — also wired into
-- db/init/15_supabase_compat_realtime.sql with \i for fresh boots). Idempotent.
--
-- WHAT THIS IS, AND WHAT IT ISN'T
--   Supabase Realtime is built on Postgres logical replication: it reads a
--   `supabase_realtime` PUBLICATION via wal2json/pgoutput. Laetoli Data's
--   realtime service (realtime/) is architecturally different — it's a
--   LISTEN/NOTIFY relay on a single `laetoli_realtime` channel
--   (realtime/src/listener.ts), not a logical-replication consumer.
--
--   This migration creates the publication ONLY so that Supabase-authored SQL
--   like `ALTER PUBLICATION supabase_realtime ADD TABLE messages` — which
--   THOS's 0004_realtime_chat.sql does — applies without erroring. Found by
--   testing THOS's real migrations against this project.
--
--   IT DOES NOT MAKE REALTIME DELIVERY WORK. Adding a table to this
--   publication does nothing on its own here — nothing consumes it. A table
--   added via a ported Supabase migration will NOT get live updates through
--   Laetoli Data's realtime service until you additionally give it a trigger
--   that does `PERFORM pg_notify('laetoli_realtime', ...)` on
--   insert/update/delete, matching the payload shape realtime/src/hub.ts
--   expects. That is real, table-specific work — this migration only stops
--   the CREATE/ALTER PUBLICATION statement itself from failing. Treat any
--   ported table's realtime feature as "schema compatible, functionality
--   not yet wired" until that trigger exists. See docs/SUPABASE_COMPAT.md.
-- =============================================================================

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END $$;

COMMENT ON PUBLICATION supabase_realtime IS
  'Compatibility shim so ported Supabase SQL (ALTER PUBLICATION supabase_realtime ADD TABLE ...) does not error. NOT consumed by Laetoli Data''s realtime service (LISTEN/NOTIFY-based, not logical replication) — adding a table here does not make it realtime. See docs/SUPABASE_COMPAT.md.';
