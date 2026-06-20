# Raspberry Pi Setup — set up in the US, carry to Tanzania

Goal: a self-contained Laetoli Data node on a Pi you configure on good US
internet, then carry to Tanzania where it keeps working — reachable from any
network, no static IP. Two scripts do the heavy lifting:
`scripts/provision-pi.sh` (the stack) and `scripts/setup-cloudflare-tunnel.sh`
(public reachability). See `RASPBERRY_PI.md` for hardware notes and `RUNBOOK.md`
for day-to-day operation.

## 0. Hardware
Pi 5 (8 GB) · official 27 W USB-C PSU · active cooler · **256 GB+ USB-3 SSD
(run from SSD, not microSD)** · case · ethernet · a mini-UPS (TZ power cuts).

## 1. Flash the OS (on your laptop)
1. Raspberry Pi Imager → **Raspberry Pi OS Lite (64-bit)** → write to the **SSD**.
2. In Imager's settings (gear): set hostname (e.g. `laetoli`), **enable SSH**,
   set a username/password, and Wi-Fi if you won't use ethernet.
3. Boot the Pi from the SSD; SSH in: `ssh <user>@laetoli.local`.

## 2. Provision the stack (on the Pi, on good US internet)
```bash
sudo apt update && sudo apt install -y git curl
git clone https://github.com/nooher/laetoli-data
cd laetoli-data
bash scripts/provision-pi.sh
```
This installs Docker, generates `.env` with strong secrets (chmod 600), pulls +
builds all arm64 images **while you have fast internet** (so it later runs
offline), starts the 12-service stack, applies migrations, and prints a health
summary. Re-runnable safely.

> If Docker was just installed, you may need to log out/in once (group change),
> then re-run the script.

**Back up `.env`** somewhere safe — it holds your `POSTGRES_PASSWORD`,
`JWT_SECRET`, and `ADMIN_API_KEY`. Losing it = losing access to encrypted data.

## 3. Publish it (Cloudflare Tunnel — works the same US ↔ TZ)
Prereq: a free Cloudflare account with your domain (`laetoli.africa`) added.
```bash
bash scripts/setup-cloudflare-tunnel.sh            # defaults to data.laetoli.africa
# or: bash scripts/setup-cloudflare-tunnel.sh sub.yourdomain.tz mytunnel 8088
```
It installs `cloudflared`, opens a browser URL for you to authorise your zone,
creates the tunnel, points the hostname at it, and installs it as a boot
service. Outbound-only → no port forwarding, no static IP. When the Pi moves to
TZ, just power on: the same `https://data.laetoli.africa` keeps working.

## 4. Lock it down for public use
In `.env` set the CORS allow-list, then reload Caddy:
```bash
# .env
CORS_ALLOWED_ORIGINS=
CORS_ALLOWED_ORIGINS_REGEXP=^(https://app\.laetoli\.africa|https://yourapp\.tz)$
```
```bash
docker compose up -d caddy
```
(See `SECURITY.md` for rate-limiting via an xcaddy build, and secret rotation.)

## 5. Turn on off-device backups
Mount a second USB drive and set it as the mirror so backups survive an SSD
failure:
```bash
# .env
BACKUP_MIRROR_DIR=/mnt/backupusb         # a mounted USB path
# (BACKUP_STORAGE_DIR=/storage is set by the provisioner)
```
```bash
docker compose up -d backup
```
Practise a restore now (see `RUNBOOK.md` §2) so you trust it before TZ.

## 6. Acceptance test (the real gate)
From a phone on mobile data (simulating a TZ user), against
`https://data.laetoli.africa`:
1. **signup** → get tokens · **/refresh** keeps the session.
2. write a row (RLS: only your user sees it) · read it back.
3. realtime: subscribe, insert, see the event.
4. storage: upload a file, fetch its signed URL.
5. backups: `curl .../backup/status` shows a recent success; do a restore drill.
6. **pull the power** → power back on → confirm the DB recovers and data is intact.

When all six pass, the node is production-ready. Carry it to Tanzania, plug it
in, power on — it comes back on the same URL with your data on Tanzanian soil.
