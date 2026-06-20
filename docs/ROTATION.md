# Secret rotation

**Rotate your secrets without downtime drama.** Laetoli Data has three classes
of secret. Rotating them is a routine operation — especially before/after
exposing the stack publicly (e.g. over a Cloudflare tunnel) or whenever a key
may have leaked.

| Secret              | What it protects                                              | Blast radius on rotation                       |
| ------------------- | ------------------------------------------------------------ | ---------------------------------------------- |
| `POSTGRES_PASSWORD` | Every DB **login role** (`authenticator`, `laetoli_auth`, `laetoli_storage`, `laetoli_realtime`, `laetoli_admin_login`, `laetoli_webhooks`, `laetoli_scheduler`) + the superuser | All services must reconnect (brief restart)    |
| `JWT_SECRET`        | Signs/verifies every HS256 JWT (auth ↔ PostgREST ↔ services) | **All existing tokens become invalid** — users re-login |
| `ADMIN_API_KEY`     | The admin / Studio service-role key (BYPASSRLS)              | Operators must re-paste the key in Studio      |

By convention all login roles **reuse `POSTGRES_PASSWORD`** (see
`db/init/00_passwords.sh`), so DB rotation is a single secret to manage. You can
give each role its own password via the `LAETOLI_*_PASSWORD` overrides in
`.env`; if you do, rotate those by hand (the script rotates the shared one).

## The scripted path (recommended)

```bash
# from the repo root, with the stack running (docker compose up -d)
scripts/rotate-secrets.sh            # rotate ALL three
scripts/rotate-secrets.sh --jwt      # rotate just JWT_SECRET
scripts/rotate-secrets.sh --db       # rotate just the DB password
scripts/rotate-secrets.sh --admin    # rotate just ADMIN_API_KEY
scripts/rotate-secrets.sh --dry-run  # show what would happen, change nothing
```

What it does, in order:

1. **Backs up `.env`** to `.env.bak.<timestamp>` (so you can roll back).
2. **`--db`**: generates a new password, runs `ALTER ROLE … WITH PASSWORD` for
   the superuser + every login role **inside the running `db` container** (the
   old password still authenticates the `ALTER`), then writes the new
   `POSTGRES_PASSWORD` to `.env`.
3. **`--jwt`** / **`--admin`**: generates a new value and writes it to `.env`.
4. **Restarts the affected services in the right order** with
   `docker compose up -d --force-recreate` so each reconnects with the new env:
   - DB or JWT change → `rest auth storage realtime functions webhooks scheduler backup` (and `admin`), then `caddy`.
   - The `db` container itself is **not** recreated for a password change — the
     role passwords were `ALTER`ed live and persist in the data volume.

## Restart order (why it matters)

- **DB password**: roles are altered *while connected with the old password*, so
  do the `ALTER ROLE` **first**, then restart the clients. If you restart a
  client before altering, it fails auth; if you alter without restarting,
  clients keep using stale (now-wrong) credentials and drop on reconnect.
- **JWT_SECRET**: `auth` and every verifier (`rest`, `storage`, `realtime`,
  `functions`) must restart **together** so the signer and verifiers share the
  new secret. There is a brief window where in-flight old tokens fail — expected;
  clients simply re-authenticate.
- **ADMIN_API_KEY**: only the `admin` service reads it; restart `admin`, then
  re-paste the new key in Studio (it lives in the browser `sessionStorage`).

## Manual rotation (no script)

```bash
# 1) DB password — alter live, then persist + restart clients
NEW=$(openssl rand -base64 24)
docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "
  ALTER ROLE \"$POSTGRES_USER\"     WITH PASSWORD '$NEW';
  ALTER ROLE authenticator          WITH PASSWORD '$NEW';
  ALTER ROLE laetoli_auth           WITH PASSWORD '$NEW';
  ALTER ROLE laetoli_storage        WITH PASSWORD '$NEW';
  ALTER ROLE laetoli_realtime       WITH PASSWORD '$NEW';
  ALTER ROLE laetoli_admin_login    WITH PASSWORD '$NEW';
  ALTER ROLE laetoli_webhooks       WITH PASSWORD '$NEW';
  ALTER ROLE laetoli_scheduler      WITH PASSWORD '$NEW';"
# edit .env: POSTGRES_PASSWORD=$NEW
docker compose up -d --force-recreate rest auth storage realtime functions webhooks scheduler backup admin caddy

# 2) JWT_SECRET
#   edit .env: JWT_SECRET=$(openssl rand -base64 48)
docker compose up -d --force-recreate auth rest storage realtime functions

# 3) ADMIN_API_KEY
#   edit .env: ADMIN_API_KEY=$(openssl rand -base64 36)
docker compose up -d --force-recreate admin
```

## Rollback

If a service fails to come up after rotation, restore the previous env and
recreate:

```bash
cp .env.bak.<timestamp> .env
docker compose up -d --force-recreate
```

(For a DB password rollback you must also re-`ALTER ROLE` back to the old value,
since the live roles already took the new one.)

## Verify

```bash
laetoli-data status        # container health + /rest /auth probes
docker compose ps          # all services Up
```

© 2026 Laetoli Ltd · Apache-2.0
