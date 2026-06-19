# db/migrations — repeatable schema migrations

The files in `db/init/` run **once**, only on a fresh Postgres data volume. For
an **existing** database you change the schema with *migrations*: small,
ordered, append-only SQL files applied by the CLI.

## Convention

- One change per file, named `NNNN_short_name.sql` — a zero-padded number then a
  snake_case description, e.g. `0001_storage.sql`, `0002_realtime.sql`,
  `0003_add_profiles.sql`.
- Files are applied in **lexicographic order** (that's why the numeric prefix is
  zero-padded). Pick the next free number.
- Migrations are **append-only**: once a file has been applied, never edit it.
  Need to change something? Add a new migration. The runner records a SHA-256
  **checksum** of each applied file and **refuses to run** if a previously
  applied file's contents changed (drift guard).

## How they run

```bash
laetoli-data migrate            # apply all pending migrations
laetoli-data migrate --status   # list applied / pending (no changes)
```

- Each migration runs inside its **own transaction** — a failure rolls back that
  file cleanly and stops the run; already-applied files stay applied.
- Applied migrations are tracked in `public._laetoli_migrations`
  (`name` PK, `applied_at`, `checksum`).
- The CLI connects via `DATABASE_URL` (or the `POSTGRES_*` vars) from `.env`.

## Writing a migration

Plain SQL — `CREATE TABLE`, `ALTER`, RLS policies, grants, etc. Use the
`db/init/03_example.sql` RLS block as the copy-paste pattern. Prefer idempotent
guards (`CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE`) where natural, though
the tracking table already prevents re-running an applied file.
