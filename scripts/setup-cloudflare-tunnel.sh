#!/usr/bin/env bash
# setup-cloudflare-tunnel.sh — publish this Laetoli Data node at a public
# hostname via a Cloudflare Tunnel. Outbound-only: no static IP, no port
# forwarding, and it keeps working unchanged when the Pi moves US -> Tanzania.
#
# Prereqs: a free Cloudflare account with your domain (e.g. laetoli.africa)
# added as a zone. Run AFTER provision-pi.sh, on the Pi:
#     bash scripts/setup-cloudflare-tunnel.sh
#
# Idempotent-ish: re-running reuses an existing tunnel of the same name.
set -euo pipefail
say()  { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

HOSTNAME="${1:-${TUNNEL_HOSTNAME:-data.laetoli.africa}}"
TUNNEL_NAME="${2:-${TUNNEL_NAME:-laetoli-data}}"
LOCAL_PORT="${3:-${LOCAL_PORT:-8088}}"
CF_DIR="/etc/cloudflared"

say "Tunnel plan: https://${HOSTNAME}  ->  http://localhost:${LOCAL_PORT}  (tunnel '${TUNNEL_NAME}')"

# ---- 1. install cloudflared (arm64/amd64) -----------------------------------
if ! command -v cloudflared >/dev/null 2>&1; then
  say "Installing cloudflared"
  case "$(uname -m)" in
    aarch64|arm64) PKG=arm64 ;;
    x86_64|amd64)  PKG=amd64 ;;
    armv7l|armhf)  PKG=arm ;;
    *) die "Unsupported arch $(uname -m)";;
  esac
  TMP="$(mktemp /tmp/cloudflared.XXXX.deb)"
  curl -fsSL -o "$TMP" "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${PKG}.deb"
  sudo dpkg -i "$TMP" || sudo apt-get -f install -y
  rm -f "$TMP"
else
  say "cloudflared present: $(cloudflared --version 2>/dev/null | head -1)"
fi

# ---- 2. login (interactive: opens / prints a URL to authorise your zone) ----
if [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
  say "Authorising with Cloudflare — a URL will appear; open it in any browser, pick your domain's zone, approve."
  cloudflared tunnel login
else
  say "Already authorised (cert.pem present)."
fi

# ---- 3. create (or reuse) the tunnel ----------------------------------------
if cloudflared tunnel list 2>/dev/null | awk '{print $2}' | grep -qx "$TUNNEL_NAME"; then
  say "Tunnel '${TUNNEL_NAME}' already exists — reusing."
else
  say "Creating tunnel '${TUNNEL_NAME}'"
  cloudflared tunnel create "$TUNNEL_NAME"
fi
UUID="$(cloudflared tunnel list 2>/dev/null | awk -v n="$TUNNEL_NAME" '$2==n{print $1}' | head -1)"
[ -n "$UUID" ] || die "Could not resolve the tunnel UUID."
CRED="$HOME/.cloudflared/${UUID}.json"
[ -f "$CRED" ] || die "Tunnel credentials file not found: $CRED"

# ---- 4. write config --------------------------------------------------------
say "Writing ${CF_DIR}/config.yml"
sudo mkdir -p "$CF_DIR"
sudo cp "$CRED" "${CF_DIR}/${UUID}.json"
sudo tee "${CF_DIR}/config.yml" >/dev/null <<YAML
tunnel: ${UUID}
credentials-file: ${CF_DIR}/${UUID}.json
ingress:
  - hostname: ${HOSTNAME}
    service: http://localhost:${LOCAL_PORT}
  - service: http_status:404
YAML

# ---- 5. route DNS + install service -----------------------------------------
say "Pointing ${HOSTNAME} at the tunnel (DNS)"
cloudflared tunnel route dns "$TUNNEL_NAME" "$HOSTNAME" || warn "DNS route may already exist — continuing."

say "Installing cloudflared as a system service (auto-start on boot)"
sudo cloudflared --config "${CF_DIR}/config.yml" service install 2>/dev/null || true
sudo systemctl enable --now cloudflared 2>/dev/null || true
sleep 4

# ---- 6. verify --------------------------------------------------------------
say "Verifying"
sudo systemctl --no-pager --full status cloudflared 2>/dev/null | head -5 || true
code="$(curl -s -o /dev/null -w '%{http_code}' "https://${HOSTNAME}/auth/health" || echo 000)"
printf '   https://%s/auth/health -> HTTP %s\n' "$HOSTNAME" "$code"

cat <<EOF

\033[1;32mTunnel live (or coming up — DNS can take a minute).\033[0m
  Public:  https://${HOSTNAME}      (Studio: https://${HOSTNAME}/studio/)
  Service: 'sudo systemctl status cloudflared' · logs: 'journalctl -u cloudflared -f'

IMPORTANT — lock CORS for public exposure (see SECURITY.md):
  In .env set CORS_ALLOWED_ORIGINS_REGEXP to your app origins, then:
     docker compose up -d caddy
When you carry the Pi to Tanzania: just power it on. The tunnel re-dials
outbound — the same https://${HOSTNAME} keeps working with no reconfig.
EOF
