# Laetoli Data — Operator Runbook

Practical, day-to-day operation of a Laetoli Data node — written for a single
box (a Raspberry Pi 5 or a small VPS) serving real users, including in
Tanzania. Pair this with `DEPLOY.md` (first install), `RASPBERRY_PI.md` (Pi
specifics), `SECURITY.md` (CORS / RLS / rotation), and `PITR.md`.

All commands run from the repo root unless noted. `docker compose` = the stack.

---

## 0. One-glance health

```bash
docker compose ps                 # every service should be "Up (healthy)"
curl -s localhost:8088/auth/health        # {"status":"ok",...}  (adjust port/host)
curl -s localhost:8088/storage/health
curl -s localhost:8088/realtime/health
curl -s localhost:8088/admin/health
curl -s localhost:8088/backup/status      # last backup run + per-target state
```
If anything is not healthy → see §7 Troubleshooting.

---

## 1. Start / stop / restart

```bash
docker compose up -d              # start (or apply config changes)
docker compose stop               # stop without removing
docker compose down               # stop + remove containers (DATA SAFE: volumes persist)
docker compose restart <svc>      # bounce one service, e.g. auth, postgrest, caddy
docker compose logs -f <svc>      # tail logs (Ctrl-C to exit)
```
Data lives in named volumes (`pgdata`, `storage_data`) — `down` never deletes
them. Only `docker compose down -v` destroys data; **never run `-v` in prod.**

---

## 2. Backups — the most important habit

Backups run automatically (`backup` service, cron `BACKUP_CRON`, default 03:00),
keeping the last `BACKUP_KEEP` dumps. Hardened targets (all optional, set in
`.env`): `BACKUP_MIRROR_DIR` (a second/USB disk), `BACKUP_OFFSITE_CMD` (e.g.
rclone/scp push), `BACKUP_STORAGE_DIR` (also archive the uploaded files).

**Check backups are healthy (do this weekly):**
```bash
curl -s localhost:8088/backup/status | jq      # lastSuccess, errorCount per target
ls -lh <BACKUP_DIR>                             # dumps present + recent
ls -lh <BACKUP_MIRROR_DIR>                      # mirror in sync (USB)
```
A mirror/offsite/storage failure is logged + metered but never aborts the
primary dump — so a green primary with a red mirror means "fix the USB," not
"data lost."

**Restore drill (practise this BEFORE you need it):**
```bash
docker compose exec backup node dist/restore.js --list           # see available dumps
docker compose exec backup node dist/restore.js --latest --force # DB (+ --storage for files)
```
Restore is a dry run (prints the plan) unless `--force`. DB restores first
(it owns the --clean drop/recreate), then the storage archive extracts.

---

## 3. Reachability (US ↔ Tanzania, no static IP)

The node is published with a **Cloudflare Tunnel** so it's reachable on the same
domain whether it's on US Wi-Fi or a Dar mobile hotspot — nothing to reconfigure
when it moves.

```bash
cloudflared tunnel list                 # tunnel is registered
docker compose logs -f cloudflared      # (or systemctl status cloudflared) — connection healthy
```
- Domain → tunnel mapping is set once (e.g. `data.laetoli.africa`).
- LAN-only mode (no tunnel): reach it at `http://<pi-ip>:8088` on the same
  network — fully offline/sovereign.
- After landing in TZ: just power on. The tunnel re-dials outbound; the public
  URL keeps working. Confirm with `/auth/health` over the domain from a phone.

---

## 4. Updates

```bash
git pull
docker compose pull            # newer pinned images
docker compose build           # rebuild locally-built services (auth, storage, …)
docker compose up -d           # apply
docker compose exec <cli> laetoli-data migrate   # run any new DB migrations
```
Do updates while on **good internet** (US) so images cache; the box then runs
offline. Take a fresh backup (§2) before any update.

---

## 5. Auth operations (new in the hardened build)

- **Sessions:** access JWTs are short-lived; clients use the rotating
  **refresh token** (`POST /refresh`) to stay signed in. `REFRESH_EXPIRY`
  (default 30d) controls how long a session can be kept alive.
- **Logout** revokes the refresh-token family (`POST /logout`).
- **Forgotten password:** `POST /password/forgot` → (in `RESET_DELIVERY=log`)
  the reset token appears in the auth logs; `POST /password/reset` consumes it
  and revokes all that user's refresh tokens. Wire an email/SMS sender later by
  switching `RESET_DELIVERY=email`.
- **Admin recovery** (locked-out user): see the admin SQL block in
  `db/migrations/0009_auth_tokens.sql`.
- **Token housekeeping:** `SELECT auth.cleanup_expired_tokens();` (or schedule it)
  prunes expired refresh/reset/verify rows.

---

## 6. Security checks (periodic)

```bash
# Every app table must have RLS + at least one policy:
docker compose exec db psql -U postgres -c "SELECT * FROM public.rls_audit;"   # EMPTY == good
docker compose exec db psql -U postgres -c "SELECT * FROM public.rls_audit_summary();"
```
- **CORS:** in production set `CORS_ALLOWED_ORIGINS_REGEXP` (leave
  `CORS_ALLOWED_ORIGINS` empty) so only your app origins are reflected. See
  `SECURITY.md`.
- **Rotate secrets** if ever exposed: `bash scripts/rotate-secrets.sh` (see
  `docs/ROTATION.md`).

---

## 7. Troubleshooting

| Symptom | Check / fix |
|---|---|
| A service is `Restarting`/unhealthy | `docker compose logs <svc>` — usually a missing/empty env var. Confirm `.env` has `POSTGRES_PASSWORD`, `JWT_SECRET` (≥32), `ADMIN_API_KEY`. |
| `auth`/`admin` won't start | `ADMIN_API_KEY` unset → admin refuses to boot. Set it, `up -d`. |
| 401 on every request | Clocks/secret mismatch: all services must share the same `JWT_SECRET`. Re-`up -d` after any change. |
| DB won't accept connections | `docker compose logs db`; wait for `pg_isready`. If after a hard power loss, see §8. |
| Disk full (Pi) | Old backups: lower `BACKUP_KEEP`; check `storage_data` size; ensure backups go to the USB mirror, not the boot disk. |
| Studio/API unreachable remotely | `cloudflared` down (§3) or DNS not pointed at the tunnel. |

---

## 8. Power-cut recovery (Tanzania reality)

1. A **mini-UPS** should let Postgres shut down cleanly — keep it charged.
2. After an unclean power loss: `docker compose up -d`; watch `docker compose
   logs -f db`. Postgres replays its WAL and comes up on its own in almost all
   cases (fsync is on).
3. If the DB will not start (rare disk corruption): restore the latest backup
   (§2). This is why off-device backups (USB + offsite) are non-negotiable.
4. Prefer an **SSD over microSD** — SD cards are the usual casualty of power
   cuts under database load.

---

## 9. Routine cadence

- **Daily:** glance at `docker compose ps` + `/backup/status`.
- **Weekly:** verify a backup file exists on the USB mirror; skim auth/error logs.
- **Monthly:** do a real **restore drill** into a throwaway dir; run `rls_audit`.
- **Before travel/updates:** take a fresh backup and copy it off the box.
