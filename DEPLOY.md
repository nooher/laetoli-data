# Deploying Laetoli Data on a Tanzanian VPS

This guide takes a fresh Linux VPS (Ubuntu 22.04/24.04 LTS recommended — e.g. a
droplet, a local TZ provider, or any cloud VM) to a running, TLS-secured
sovereign backend: **PostgreSQL + PostgREST + Auth + Caddy**.

> For a Raspberry Pi / classroom-LAN deployment, see **RASPBERRY_PI.md**.

---

## 1. Prerequisites

- A 64-bit Linux VPS, **1 GB RAM minimum** (2 GB+ comfortable), ~10 GB disk.
- A domain (optional but recommended for HTTPS), e.g. `data.yourorg.tz`,
  with an **A record** pointing at the VPS public IP.
- **Docker Engine + Compose plugin**:

  ```bash
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER"   # log out/in so this applies
  docker compose version            # verify the v2 compose plugin
  ```

- Open firewall ports **80** and **443** (Caddy handles HTTP→HTTPS + certs):

  ```bash
  sudo ufw allow 80,443/tcp && sudo ufw enable
  ```

---

## 2. Get the code + configure `.env`

```bash
git clone <your-laetoli-data-repo> laetoli-data
cd laetoli-data
cp .env.example .env
```

Edit `.env` and set **strong secrets** (never commit `.env` — it's gitignored):

```bash
# Generate a strong DB password and a long shared JWT secret:
echo "POSTGRES_PASSWORD=$(openssl rand -base64 24)"
echo "JWT_SECRET=$(openssl rand -base64 48)"
```

Paste those values in. Key variables:

| Variable | Purpose |
|---|---|
| `POSTGRES_USER` / `POSTGRES_DB` | DB superuser + database name |
| `POSTGRES_PASSWORD` | DB password; **also** the password for the `authenticator` (PostgREST) and `laetoli_auth` (auth service) login roles |
| `JWT_SECRET` | **Shared HS256 secret** — PostgREST verifies and the auth service signs with the SAME value. Must be identical. ≥ 32 chars. |
| `JWT_EXPIRY` | Token lifetime in seconds (default 3600) |
| `PGRST_DB_ANON_ROLE` | `anon` |
| `PGRST_DB_SCHEMAS` | `public` (comma-separate to expose more) |
| `CADDY_DOMAIN` | Your domain → enables automatic HTTPS. **Leave blank for local HTTP.** |
| `LAETOLI_DATA_URL` | The public base URL apps will point at |

Optional compose-only overrides (defaults shown):

| Variable | Default | Purpose |
|---|---|---|
| `CADDY_HTTP` | `8088` | Host port mapped to Caddy :80 |
| `CADDY_HTTPS` | `8443` | Host port mapped to Caddy :443 |
| `AUTHENTICATOR_PASSWORD` | = `POSTGRES_PASSWORD` | Separate PostgREST login secret (advanced) |
| `LAETOLI_AUTH_PASSWORD` | = `POSTGRES_PASSWORD` | Separate auth-service login secret (advanced) |

> **For real public HTTPS on 80/443**, set `CADDY_HTTP=80` and `CADDY_HTTPS=443`
> in `.env` (so the browser hits standard ports) and set `CADDY_DOMAIN`.

---

## 3. Bring up the stack

```bash
docker compose up -d
docker compose ps          # all services healthy/running
docker compose logs -f db  # watch the init SQL run on first boot
```

On the **first** boot the `db` service runs, in order:

1. `db/init/00_passwords.sh` — sets `authenticator` + `laetoli_auth` passwords.
2. `db/init/01_roles.sql` — roles `anon`, `authenticated`, `laetoli_admin`, etc.
3. `db/init/02_auth.sql` — `auth` schema, `auth.users`, `auth.uid()`.
4. `db/init/03_example.sql` — demo `public.notes` table with RLS.

> These init scripts run **only when the data volume is empty**. To re-run them
> you must drop the volume: `docker compose down -v` (⚠️ destroys all data).

---

## 4. Point a domain + automatic TLS

1. Create a DNS **A record**: `data.yourorg.tz` → VPS IP.
2. In `.env`: `CADDY_DOMAIN=data.yourorg.tz`, `CADDY_HTTP=80`, `CADDY_HTTPS=443`.
3. `docker compose up -d caddy` (or restart the stack).

Caddy automatically obtains and renews a Let's Encrypt certificate. Verify:

```bash
curl https://data.yourorg.tz/rest/        # PostgREST root
curl https://data.yourorg.tz/auth/health  # auth service (per its routes)
```

---

## 5. How an app points at it

Apps use the `@laetoli/data` SDK and target the Caddy edge:

```js
import { createClient } from '@laetoli/data'
const db = createClient(process.env.LAETOLI_DATA_URL) // e.g. https://data.yourorg.tz
```

- REST goes to `LAETOLI_DATA_URL/rest/*` (Caddy strips `/rest`).
- Auth goes to `LAETOLI_DATA_URL/auth/*` (Caddy strips `/auth`).

Set `LAETOLI_DATA_URL=https://data.yourorg.tz` in each app's environment.

---

## 6. Backups (`pg_dump` cron)

Take a daily logical backup and keep 14 days. Create `/opt/laetoli/backup.sh`:

```bash
#!/bin/bash
set -euo pipefail
cd /home/<user>/laetoli-data
mkdir -p /opt/laetoli/backups
STAMP=$(date +%F_%H%M)
# Read DB creds from .env
set -a; . ./.env; set +a
docker compose exec -T db \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists \
  | gzip > "/opt/laetoli/backups/${POSTGRES_DB}_${STAMP}.sql.gz"
# prune older than 14 days
find /opt/laetoli/backups -name '*.sql.gz' -mtime +14 -delete
```

```bash
chmod +x /opt/laetoli/backup.sh
crontab -e
# every day at 02:30:
30 2 * * * /opt/laetoli/backup.sh >> /var/log/laetoli-backup.log 2>&1
```

**Restore:**

```bash
gunzip -c /opt/laetoli/backups/<file>.sql.gz \
  | docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
```

> Copy backups off the host (rsync/object storage) — a VPS can die. Also keep a
> copy of `.env` somewhere safe; without `JWT_SECRET` you can't verify old tokens.

---

## 7. Upgrades

```bash
cd laetoli-data
git pull                       # get new code (compose/Caddyfile/db/auth)
docker compose pull            # pull newer pinned images
docker compose up -d --build   # rebuild auth, recreate changed services
docker compose ps
```

- **Schema changes** for an EXISTING database: the `db/init` scripts do NOT
  re-run on upgrade (they only run on an empty volume). Apply migrations with
  `docker compose exec db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -f -` or
  your migration tool. The `03_example.sql` RLS block is your copy-paste pattern.
- **Postgres major upgrades** (16 → 17) need a dump/restore, not just an image
  bump — `pg_dump` on the old version, then restore into the new one.

---

## 8. Operations cheat-sheet

```bash
docker compose ps                 # status
docker compose logs -f rest       # PostgREST logs
docker compose logs -f auth       # auth service logs
docker compose restart rest       # restart one service
docker compose exec db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"  # SQL shell
docker compose down               # stop (keeps data)
docker compose down -v            # stop + DELETE all data (⚠️)
```

**Security checklist:** strong `POSTGRES_PASSWORD` + `JWT_SECRET`; firewall to
80/443 only; don't publish `5432` to the internet; back up off-host; rotate
`JWT_SECRET` deliberately (invalidates all live tokens).
