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
  (oldest first). Only files matching `laetoli-*.sql.gz` (and storage archives
  `laetoli-*.storage.tar.gz`) are ever deleted — foreign files are never touched.
- **Off-device durability (all optional, fail-soft):** mirrors each backup to a
  second path (`BACKUP_MIRROR_DIR`, e.g. a USB drive), runs an operator off-site
  push command (`BACKUP_OFFSITE_CMD`, e.g. rclone/scp), and can archive the
  object-storage volume (`BACKUP_STORAGE_DIR` -> a `tar.gz` next to the dump).
  A mirror / off-site / archive failure logs + increments an error metric but
  **never aborts the primary dump**. Retention prunes both targets.
- Serves `GET /health` (liveness), `GET /status` (JSON), and `GET /metrics`
  (Prometheus exposition) on port **9994**. `/status` and `/metrics` report the
  primary dump health plus per-target success timestamps, sizes, and error
  counts so an operator can SEE every backup leg is healthy.

## Configuration

| Env var                 | Default       | Meaning |
|-------------------------|---------------|---------|
| `BACKUP_CRON`           | `0 3 * * *`   | 5-field cron. Takes priority over interval mode when set. |
| `BACKUP_INTERVAL_HOURS` | `24`          | Simpler alternative; used only when `BACKUP_CRON` is empty. |
| `BACKUP_KEEP`           | `14`          | Number of dumps (and storage archives) to retain. |
| `BACKUP_DIR`            | `/backups`    | Output directory (the mounted volume). |
| `BACKUP_MIRROR_DIR`     | — (off)       | Second target each backup is copied to (e.g. a mounted USB drive). Fail-soft. |
| `BACKUP_OFFSITE_CMD`    | — (off)       | Shell template run per artifact after a successful dump; `{file}`/`{name}` are substituted (e.g. `rclone copy {file} remote:laetoli`). Fail-soft. |
| `BACKUP_STORAGE_DIR`    | — (off)       | Object-storage root (the `storage_data` volume). When set, each run also writes a `tar.gz` of it next to the dump. |
| `BACKUP_PORT`           | `9994`        | HTTP observability port. |
| `DATABASE_URL`          | —             | Full DSN; if set, used instead of the PG* parts. |
| `PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE` | `db`/`5432`/`laetoli`/—/`laetoli` | Connection parts. |

Either a cron string **or** an interval works; cron wins if both are set.

## Restore

### Built-in restore CLI (guarded)

The service ships a restore CLI (`npm run restore` / `node dist/restore.js`).
Dumps are taken with `pg_dump --clean --if-exists`, so applying one **drops and
recreates** every object — restore is therefore gated behind `--force`. Without
`--force` it prints the plan (dry run) and changes nothing.

```bash
# inside the backup container (it already has the PG* env + the /backups volume):
docker compose exec backup node dist/restore.js --list                 # show restorable backups
docker compose exec backup node dist/restore.js --latest               # DRY RUN (prints the plan)
docker compose exec backup node dist/restore.js --latest --force       # restore newest dump
docker compose exec backup node dist/restore.js --dump laetoli-2026-06-19T03-00-00Z.sql.gz --force
docker compose exec backup node dist/restore.js --latest --storage --force  # DB then storage bytes
```

Ordering/safety: the database restore runs **first** (it owns the `--clean`
drop/recreate); the optional storage archive is extracted into
`BACKUP_STORAGE_DIR` only **after** the DB restore succeeds.

### Manual one-liner

Decompress and pipe into psql directly:

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
