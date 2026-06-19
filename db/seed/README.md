# db/seed — optional sample / reference data

Put `*.sql` files here to load **non-schema** data (demo rows, lookup tables,
reference data) into an already-migrated database. Run them with:

```bash
laetoli-data seed
```

- Files run in **lexicographic order** (e.g. `01_regions.sql`, `02_demo.sql`).
- Seeds are **not** tracked or checksum-guarded like migrations — they are meant
  to be re-runnable, so write them defensively (`INSERT ... ON CONFLICT DO
  NOTHING`, `TRUNCATE` + reload, etc.).
- Use migrations (`db/migrations/`) for schema; use seeds only for data.
- The CLI connects via `DATABASE_URL` / `POSTGRES_*` from `.env`.
