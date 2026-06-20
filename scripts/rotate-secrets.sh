#!/usr/bin/env bash
# =============================================================================
# rotate-secrets.sh — rotate Laetoli Data secrets in place
# -----------------------------------------------------------------------------
# Rotates one or more of:
#   --db      the database LOGIN-role password(s) — POSTGRES_PASSWORD and every
#             laetoli_* / authenticator login role that reuses it (ALTER ROLE)
#   --jwt     JWT_SECRET (shared HS256 secret for auth + PostgREST + services)
#   --admin   ADMIN_API_KEY (the admin/Studio service-role key)
#   --all     all of the above (default if no flag is given)
#
# It edits .env in place (after a timestamped backup), runs the necessary
# `ALTER ROLE ... WITH PASSWORD` for DB rotation, and restarts services IN THE
# RIGHT ORDER so every service reconnects with the new values. Self-hostable,
# zero deps beyond docker + openssl. See docs/ROTATION.md for the full guide.
#
# Usage:
#   scripts/rotate-secrets.sh [--db] [--jwt] [--admin] [--all] [--dry-run]
#
# Run from the repo root (where .env and docker-compose.yml live).
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env"

ROTATE_DB=0
ROTATE_JWT=0
ROTATE_ADMIN=0
DRY_RUN=0

if [ $# -eq 0 ]; then ROTATE_DB=1; ROTATE_JWT=1; ROTATE_ADMIN=1; fi
for arg in "$@"; do
  case "$arg" in
    --db)      ROTATE_DB=1 ;;
    --jwt)     ROTATE_JWT=1 ;;
    --admin)   ROTATE_ADMIN=1 ;;
    --all)     ROTATE_DB=1; ROTATE_JWT=1; ROTATE_ADMIN=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "Unknown flag: $arg (try --help)" >&2; exit 2 ;;
  esac
done

[ -f "$ENV_FILE" ] || { echo "Hitilafu: .env not found at $ENV_FILE — run from the repo root." >&2; exit 1; }
command -v openssl >/dev/null || { echo "Hitilafu: openssl is required." >&2; exit 1; }

# Resolve the docker compose invocation (v2 plugin or legacy binary).
if docker compose version >/dev/null 2>&1; then DC=(docker compose);
elif command -v docker-compose >/dev/null 2>&1; then DC=(docker-compose);
else echo "Hitilafu: docker compose not found." >&2; exit 1; fi

gen() { openssl rand -base64 "${1:-36}" | tr -d '\n' | tr '/+' '_-'; }

# Read a KEY=value from .env (last wins; tolerant of surrounding quotes).
getenv() { grep -E "^$1=" "$ENV_FILE" | tail -n1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }

# Replace (or append) KEY=value in .env, preserving the rest of the file.
setenv() {
  local key="$1" val="$2"
  if grep -qE "^$key=" "$ENV_FILE"; then
    # Use a non-/ delimiter since secrets may contain /.
    awk -v k="$key" -v v="$val" 'BEGIN{FS=OFS="="} $1==k{print k "=" v; next} {print}' "$ENV_FILE" > "$ENV_FILE.tmp"
    mv "$ENV_FILE.tmp" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}

POSTGRES_USER="$(getenv POSTGRES_USER)"; POSTGRES_USER="${POSTGRES_USER:-laetoli}"
POSTGRES_DB="$(getenv POSTGRES_DB)";     POSTGRES_DB="${POSTGRES_DB:-laetoli}"

# The login roles that reuse POSTGRES_PASSWORD by convention (00_passwords.sh).
DB_ROLES=(authenticator laetoli_auth laetoli_storage laetoli_realtime laetoli_admin_login laetoli_webhooks laetoli_scheduler)

echo "== Laetoli Data secret rotation =="
echo "   db=$ROTATE_DB jwt=$ROTATE_JWT admin=$ROTATE_ADMIN dry-run=$DRY_RUN"

if [ "$DRY_RUN" = "1" ]; then
  echo "(dry-run) would back up .env, then:"
  [ "$ROTATE_DB" = 1 ]    && echo "  - generate new POSTGRES_PASSWORD, ALTER ROLE for: ${DB_ROLES[*]} + $POSTGRES_USER, restart all services"
  [ "$ROTATE_JWT" = 1 ]   && echo "  - generate new JWT_SECRET, restart auth + rest + storage + realtime + functions"
  [ "$ROTATE_ADMIN" = 1 ] && echo "  - generate new ADMIN_API_KEY, restart admin"
  exit 0
fi

# Always back up .env first.
BACKUP="$ENV_FILE.bak.$(date +%Y%m%d-%H%M%S)"
cp "$ENV_FILE" "$BACKUP"
echo "Backed up .env -> $BACKUP"

# --- DB role passwords -------------------------------------------------------
if [ "$ROTATE_DB" = "1" ]; then
  NEW_PW="$(gen 24)"
  echo "Rotating DB password (POSTGRES_PASSWORD + ${#DB_ROLES[@]} login roles + $POSTGRES_USER)…"
  # 1) ALTER every login role WHILE the old password still authenticates us. We
  #    connect as the superuser through the running db container.
  SQL="ALTER ROLE \"$POSTGRES_USER\" WITH PASSWORD '$NEW_PW';"
  for r in "${DB_ROLES[@]}"; do SQL+=" ALTER ROLE \"$r\" WITH PASSWORD '$NEW_PW';"; done
  "${DC[@]}" exec -T db psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$SQL"
  # 2) Persist to .env so restarted containers use the new password.
  setenv POSTGRES_PASSWORD "$NEW_PW"
  echo "  DB password rotated in Postgres + .env."
fi

# --- JWT secret --------------------------------------------------------------
if [ "$ROTATE_JWT" = "1" ]; then
  NEW_JWT="$(gen 48)"
  setenv JWT_SECRET "$NEW_JWT"
  echo "Rotated JWT_SECRET in .env (existing tokens become invalid → users re-login)."
fi

# --- Admin API key -----------------------------------------------------------
if [ "$ROTATE_ADMIN" = "1" ]; then
  NEW_ADMIN="$(gen 36)"
  setenv ADMIN_API_KEY "$NEW_ADMIN"
  echo "Rotated ADMIN_API_KEY in .env (re-paste it in Studio)."
fi

# --- Restart in the right order ----------------------------------------------
# db reads its password from the volume (already ALTERed live), so it does NOT
# need recreation for a password change. Every CLIENT service must be recreated
# to pick up the new env. Order: db settle -> data-plane services -> edge.
echo "Restarting services to pick up new values…"
RESTART=()
if [ "$ROTATE_DB" = "1" ] || [ "$ROTATE_JWT" = "1" ]; then
  RESTART+=(rest auth storage realtime functions webhooks scheduler backup)
fi
if [ "$ROTATE_DB" = "1" ]; then RESTART+=(admin); fi
if [ "$ROTATE_ADMIN" = "1" ]; then RESTART+=(admin); fi
# De-duplicate.
mapfile -t RESTART < <(printf '%s\n' "${RESTART[@]}" | awk '!seen[$0]++')

if [ "${#RESTART[@]}" -gt 0 ]; then
  # up -d --force-recreate re-reads .env env vars for just these services.
  "${DC[@]}" up -d --force-recreate "${RESTART[@]}"
  # Edge last (no secrets, but keep it consistent if it depends on the above).
  "${DC[@]}" up -d caddy
fi

echo "Done. Verify: laetoli-data status   (or: ${DC[*]} ps)"
echo "If anything fails, restore the previous .env: cp \"$BACKUP\" \"$ENV_FILE\" && ${DC[*]} up -d --force-recreate"
