#!/usr/bin/env bash
# provision-pi.sh — take a fresh Raspberry Pi (Pi OS Lite 64-bit, booted from an
# SSD) to a fully running Laetoli Data stack. Idempotent: safe to re-run.
#
# Run it from inside the cloned repo:
#     git clone https://github.com/nooher/laetoli-data && cd laetoli-data
#     bash scripts/provision-pi.sh
#
# Then run scripts/setup-cloudflare-tunnel.sh to publish it (see docs/PI_SETUP.md).
set -euo pipefail

say()  { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"
[ -f docker-compose.yml ] || die "Run this from the laetoli-data repo (docker-compose.yml not found)."

# ---- 0. preflight -----------------------------------------------------------
say "Preflight"
ARCH="$(uname -m)"
[ "$ARCH" = "aarch64" ] || warn "Architecture is '$ARCH' (expected aarch64). Continuing anyway."
if findmnt -no SOURCE / | grep -qiE 'mmcblk'; then
  warn "Root filesystem looks like a microSD card. For a database, boot/run from an SSD."
fi

# ---- 1. Docker --------------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  say "Installing Docker (get.docker.com)"
  curl -fsSL https://get.docker.com | sh
  sudo usermod -aG docker "$USER" || true
  sudo systemctl enable --now docker || true
  warn "Added $USER to the 'docker' group. If the next step fails with a permission error, log out/in (or 'newgrp docker') and re-run."
else
  say "Docker present: $(docker --version)"
fi
docker compose version >/dev/null 2>&1 || die "Docker Compose plugin missing. Install 'docker-compose-plugin'."

# ---- 2. .env (generate secrets once; never overwrite) -----------------------
gen() { openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
if [ ! -f .env ]; then
  say "Creating .env with fresh secrets"
  cp .env.example .env
  set_kv() { # set_kv KEY VALUE  (replace 'KEY=' line, value may contain slashes)
    local k="$1" v="$2"
    if grep -qE "^${k}=" .env; then
      awk -v k="$k" -v v="$v" 'BEGIN{FS=OFS="="} $1==k{$0=k"="v} {print}' .env > .env.tmp && mv .env.tmp .env
    else
      printf '%s=%s\n' "$k" "$v" >> .env
    fi
  }
  set_kv POSTGRES_PASSWORD "$(gen)"
  set_kv JWT_SECRET "$(gen)$(gen)"      # ≥32 bytes; doubled for margin
  set_kv ADMIN_API_KEY "$(gen)"
  set_kv CADDY_DOMAIN ":80"             # tunnel terminates TLS; LAN serves :80
  set_kv BACKUP_STORAGE_DIR "/storage"  # compose mounts storage_data:/storage:ro into backup
  chmod 600 .env
  warn "Secrets written to .env (gitignored, chmod 600). Back this file up securely — it is your keys."
  warn "Optional: set BACKUP_MIRROR_DIR to a mounted USB path (e.g. /mnt/backupusb) for off-device copies."
else
  say ".env already exists — keeping your secrets unchanged."
fi

# ---- 3. images + bring up ---------------------------------------------------
say "Pulling + building images (do this on good internet; it then runs offline)"
docker compose pull || warn "Some images couldn't be pulled (will build locally)."
docker compose build
say "Starting the stack"
docker compose up -d

# ---- 4. wait for Postgres ---------------------------------------------------
say "Waiting for Postgres to become healthy"
PU="$(grep -E '^POSTGRES_USER=' .env | cut -d= -f2-)"; PU="${PU:-laetoli}"
PD="$(grep -E '^POSTGRES_DB=' .env | cut -d= -f2-)"; PD="${PD:-laetoli}"
for i in $(seq 1 60); do
  if docker compose exec -T db pg_isready -U "$PU" -d "$PD" >/dev/null 2>&1; then break; fi
  sleep 2
  [ "$i" = 60 ] && die "Postgres did not become ready in time. Check: docker compose logs db"
done
say "Postgres is ready."

# ---- 5. migrations (idempotent; covers anything not pulled in by db/init) ----
say "Applying migrations (idempotent)"
docker compose exec -T db sh -lc '
  for f in /migrations/*.sql; do
    [ -f "$f" ] || continue
    echo ">> $(basename "$f")"
    psql -U "'"$PU"'" -d "'"$PD"'" -f "$f" >/dev/null 2>&1 || echo "   (skipped/already applied)"
  done
' || warn "Migration pass reported issues — review: docker compose logs db"

# ---- 6. health summary ------------------------------------------------------
say "Health check"
docker compose ps
PORT="$(grep -E '^CADDY_HTTP=' .env | cut -d= -f2-)"; PORT="${PORT:-8088}"
for p in auth/health storage/health realtime/health admin/health backup/status; do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${PORT}/${p}" || echo 000)"
  printf '   /%s -> HTTP %s\n' "$p" "$code"
done

cat <<EOF

\033[1;32mLaetoli Data is up.\033[0m
  Local:   http://localhost:${PORT}   (Studio at /studio/)
  Secrets: ./.env  (ADMIN_API_KEY is your service key — keep it safe)

Next:
  1) Publish it from anywhere (US ↔ TZ, no static IP):
       bash scripts/setup-cloudflare-tunnel.sh
  2) Verify end-to-end + practise a restore drill: see docs/RUNBOOK.md
  3) Set a USB mirror for off-device backups: BACKUP_MIRROR_DIR in .env, then 'docker compose up -d backup'
EOF
