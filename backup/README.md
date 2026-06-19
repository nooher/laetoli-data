# @laetoli/backup

Automated backup daemon for Laetoli Data. Runs scheduled `pg_dump` (gzip),
prunes old dumps by retention, and exposes a tiny HTTP status endpoint for
observability. Dependency-light (no cron library, no framework) and
arm64-compatible — runs on a Raspberry Pi.

## What it does

- On a schedule (`BACKUP_CRON` 5-field cron, or `BACKUP_INTERVAL_HOURS`), runs
  `pg_dump --clean --if-exists`, streams it through gzip to
  `/backups/laetoli-<ISO-timestamp>.sql.gz`.
- After each successful dump, prunes managed dumps beyond `BACKUP_KEEP`
  (oldest first). Only files matching `laetoli-*.sql.gz` are ever deleted —
  foreign files in the volume are never touched.
- Serves `GET /health` (liveness) and `GET /status` (last run, last success,
  last error, dump count, total bytes, next run) on port **9994**.

## Configuration

| Env var                 | Default       | Meaning |
|-------------------------|---------------|---------|
| `BACKUP_CRON`           | `0 3 * * *`   | 5-field cron. Takes priority over interval mode when set. |
| `BACKUP_INTERVAL_HOURS` | `24`          | Simpler alternative; used only when `BACKUP_CRON` is empty. |
| `BACKUP_KEEP`           | `14`          | Number of dumps to retain. |
| `BACKUP_DIR`            | `/backups`    | Output directory (the mounted volume). |
| `BACKUP_PORT`           | `9994`        | HTTP observability port. |
| `DATABASE_URL`          | —             | Full DSN; if set, used instead of the PG* parts. |
| `PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE` | `db`/`5432`/`laetoli`/—/`laetoli` | Connection parts. |

Either a cron string **or** an interval works; cron wins if both are set.

## Restore

Decompress and pipe into psql (or use the existing CLI `laetoli-data restore`):

```bash
gunzip -c backups/laetoli-2026-06-19T03-00-00Z.sql.gz | \
  docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```

For continuous point-in-time recovery (restore to any second, not just nightly),
see [`docs/PITR.md`](../docs/PITR.md).

## Develop

```bash
npm install
npm test          # vitest — pure cron/retention/filename logic + a daemon test
npm run typecheck
```

Tests inject a fake dump runner, so `pg_dump` is never spawned during testing.
