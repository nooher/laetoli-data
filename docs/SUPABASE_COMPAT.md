# Supabase compatibility — what's real, tested against a live app

Laetoli Data's RLS/JWT model is deliberately Supabase-shaped (`auth.uid()`, `anon`/
`authenticated` roles) so migrating off Supabase doesn't mean rewriting your schema. This page
records what was actually verified, not what's theoretically supposed to work.

## The test (2026-07-17)

All 57 real, production migration files from **THOS** (Tanzania Health Operating System — a
national health platform, `thos/supabase/migrations/`) were applied in order against a fresh
Laetoli Data instance (built from `db/Dockerfile`, PostGIS + pgvector). THOS was picked because
it's the most demanding schema in the Laetoli portfolio to date: PostGIS geography columns,
114+ tables, RLS on nearly every one, storage buckets, realtime chat, and Supabase-Auth-specific
SQL (`auth.users` triggers, `service_role` grants).

**Result: 57/57 pass, zero changes made to THOS's own migration files.** Three small, reusable
compatibility additions went into Laetoli Data itself instead — every future ported Supabase
migration benefits from the same three fixes, not just THOS's.

Confirmed after the run (not just "no SQL errors" — actual functional checks):
- 149 real tables, 267 real RLS policies landed correctly
- THOS's own `providers_near()` PostGIS RPC executes and returns real seeded data (Dar es Salaam
  facilities/physicians) with correct calculated distances — the geo-search feature genuinely
  works end-to-end, not just "the CREATE FUNCTION statement didn't error"

## The compatibility fixes

| Migration | Fixes | What it does |
|---|---|---|
| [`0013_supabase_compat_roles.sql`](../db/migrations/0013_supabase_compat_roles.sql) | `role "service_role" does not exist` (hit 15 of THOS's 57 files — the single largest failure category) | Creates `service_role` as a real second BYPASSRLS role alongside `laetoli_admin`, so `GRANT ... TO service_role` from ported Supabase SQL just works |
| [`0014_supabase_compat_storage.sql`](../db/migrations/0014_supabase_compat_storage.sql) | `storage.buckets.id`, `storage.objects.bucket_id`, `storage.objects.name` don't exist (Laetoli Data's native columns are `buckets.name` as PK, `objects.bucket`, `objects.path`) | Adds the Supabase-named columns as compatibility columns (a trigger for `buckets.id`, `STORED GENERATED` mirrors for the other two — always in sync, can't drift). Native Laetoli Data storage code is untouched; it never reads/writes the new columns |
| [`0015_supabase_compat_realtime.sql`](../db/migrations/0015_supabase_compat_realtime.sql) | `publication "supabase_realtime" does not exist` | Creates the publication so `ALTER PUBLICATION supabase_realtime ADD TABLE ...` doesn't error. **Read the caveat below — this one is schema-compatible only, not functionally complete.** |

## The one honest gap: realtime

Supabase Realtime streams changes via Postgres **logical replication** (a publication, consumed
via wal2json/pgoutput). Laetoli Data's realtime service (`realtime/`) is architecturally
different — a **LISTEN/NOTIFY** relay on a single channel (see `realtime/src/listener.ts`).

`0015_supabase_compat_realtime.sql` stops the `ALTER PUBLICATION` statement itself from erroring
— nothing more. Adding a table to that publication does **not** make it realtime through Laetoli
Data; nothing consumes it. Two additional things are needed before a ported table's realtime
feature (e.g. THOS's live chat, `messages` table) actually works:

1. `wal_level = logical` set in Postgres config (confirmed via testing: the default `replica`
   level throws `WARNING: wal_level is insufficient to publish logical changes` the moment the
   publication is created — this requires a Postgres restart to change, not just a migration).
2. A trigger on the specific table doing `PERFORM pg_notify('laetoli_realtime', ...)` with a
   payload shape matching what `realtime/src/hub.ts` expects — genuine, table-specific work, not
   a generic compatibility shim.

Treat any ported table's realtime feature as **schema-compatible, functionality not yet
wired** until that trigger exists. This is a real architectural difference, not a bug — Laetoli
Data's simpler LISTEN/NOTIFY approach is lighter-weight and Pi-friendly; it just isn't a drop-in
publication consumer.

## Reproducing this test yourself

```bash
cd laetoli-data
cp .env.example .env   # fill in POSTGRES_PASSWORD, JWT_SECRET
docker compose up -d --build db
# copy in another project's Supabase migrations and apply in order, e.g.:
docker compose cp /path/to/other-project/supabase/migrations db:/tmp/migrations
docker compose exec db sh -c 'cd /tmp/migrations && for f in $(ls *.sql | sort); do psql -U laetoli -d laetoli -v ON_ERROR_STOP=1 -f "$f" || echo "FAIL: $f"; done'
```

If you hit a new incompatibility porting a different app's schema, the pattern to follow is the
same as above: fix it in Laetoli Data as a numbered `db/migrations/00NN_supabase_compat_*.sql`
file (reusable for everyone), not by editing the source app's migrations, unless the
incompatibility is architectural (like realtime) rather than naming/schema — in which case
document the real gap here instead of papering over it.
