# Point-in-Time Recovery (PITR) — Laetoli Data

Nightly `pg_dump` (the `backup` service) gives you a daily restore point. **PITR**
adds *continuous* WAL archiving so you can restore to **any second** between base
backups — the difference between "lose up to a day" and "lose up to ~5 minutes".

PITR is **opt-in**. The default `docker compose up` is unchanged: WAL archiving
stays off until you make the two edits below.

---

## 1. What PITR needs

1. A Postgres configured with `wal_level=replica`, `archive_mode=on`, and an
   `archive_command` that copies each completed WAL segment somewhere durable.
   These settings live in **`db/postgres.conf`** (already provided).
2. A place to keep the archived WAL — a **`wal_archive`** Docker volume mounted
   at `/wal_archive` (matching the path in `archive_command`).
3. A **base backup** (`pg_basebackup`) taken *after* archiving is on. Restore =
   base backup + replay of archived WAL up to your target time.

---

## 2. Enable it (two edits to `docker-compose.yml`)

Add a `wal_archive` volume and wire the config into the `db` service. The
orchestrator (not this service) makes these edits:

```yaml
services:
  db:
    image: postgres:16-alpine
    # ... existing env_file / environment / healthcheck ...
    # (A) start Postgres with the PITR config file:
    command:
      - "postgres"
      - "-c"
      - "config_file=/etc/postgresql/postgresql.conf"
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./db/init:/docker-entrypoint-initdb.d:ro
      - ./db/migrations:/migrations:ro
      # (B) mount the PITR config + the WAL archive volume:
      - ./db/postgres.conf:/etc/postgresql/postgresql.conf:ro
      - wal_archive:/wal_archive

volumes:
  pgdata:
  caddy_data:
  caddy_config:
  storage_data:
  wal_archive:          # <-- add this
```

> Alternative without a config file: keep the stock image and pass flags inline —
> `command: ["postgres", "-c", "wal_level=replica", "-c", "archive_mode=on", "-c", "archive_command=test ! -f /wal_archive/%f && cp %p /wal_archive/%f", "-c", "archive_timeout=300"]`.
> The config-file approach is cleaner and is what `db/postgres.conf` is for.

Then recreate the db container (archiving changes need a restart):

```bash
docker compose up -d db
docker compose exec db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SHOW archive_mode;"   # -> on
```

---

## 3. Take a base backup (do this right after enabling)

A base backup is the floor that WAL is replayed onto. Take one immediately, then
periodically (e.g. weekly) so replay never has to start from too far back.

```bash
# Writes a tar-format base backup + the WAL needed to make it consistent.
docker compose exec db \
  pg_basebackup -U "$POSTGRES_USER" -D /wal_archive/base-$(date +%F) -Ft -z -Xs -P
```

Copy the base backup off-box for real disaster recovery (the whole point of
sovereignty is *you* hold the backups).

---

## 4. Restore to a point in time (runbook)

> Restoring is destructive to the current data directory — practice on a copy.

1. **Stop the stack** and remove the live data volume (or restore into a fresh one):
   ```bash
   docker compose down
   ```
2. **Lay down the base backup** into a new `pgdata`:
   - Untar your most recent `base-YYYY-MM-DD/base.tar.gz` into the data dir.
   - Untar the accompanying `pg_wal.tar.gz` into `pg_wal/` inside it.
3. **Create `recovery.signal`** in the data directory (its presence puts Postgres
   into recovery mode on next start):
   ```bash
   touch $PGDATA/recovery.signal
   ```
4. **Add recovery settings** to `postgresql.conf` (or `postgresql.auto.conf`) in
   the data dir — tell Postgres how to fetch archived WAL and when to stop:
   ```conf
   restore_command = 'cp /wal_archive/%f %p'
   recovery_target_time = '2026-06-19 02:55:00+00'   # your target instant
   recovery_target_action = 'promote'                 # come up read/write at target
   ```
5. **Start Postgres.** It replays WAL from the archive up to
   `recovery_target_time`, then promotes. Watch the logs:
   ```bash
   docker compose up -d db
   docker compose logs -f db   # look for "recovery stopping before ... " + "database system is ready"
   ```
6. **Verify** the data is at the expected point, then bring the rest of the stack
   up (`docker compose up -d`). Take a **fresh base backup** afterwards.

### Notes
- Omit `recovery_target_time` to replay **all** available WAL (recover to the
  latest archived point — useful after losing the data dir but keeping the archive).
- Other targets exist: `recovery_target_lsn`, `recovery_target_xid`,
  `recovery_target_name` (a labeled `pg_create_restore_point`).
- Prune the WAL archive periodically with `pg_archivecleanup /wal_archive <oldest-base-WAL>`
  once a newer base backup exists, or the archive grows without bound.
