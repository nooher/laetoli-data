# Laetoli Data on a Raspberry Pi — "shule ndani ya kisanduku"

> *A school in a box.* The entire sovereign backend — database, REST API, auth —
> running on a Raspberry Pi on a classroom LAN, **with no internet**. Students
> and teachers use Laetoli apps against a server that fits in your hand and costs
> a few dollars to run.

This is the edge story: schools, clinics, field offices, demos, and any place
where connectivity is intermittent or sovereignty matters. For **national /
production** workloads, use a real VPS (see **DEPLOY.md**) — a Pi is perfect for
edge and teaching, not for serving a whole country.

---

## 1. What you need

- **Raspberry Pi 4 (4 GB+) or Pi 5** — the 4 GB/8 GB models are comfortable.
  A Pi 3 will technically run but is tight; prefer a 4 or 5.
- A **64-bit OS**. This is required — our images are `linux/arm64`:
  - **Raspberry Pi OS (64-bit)**, or Ubuntu Server 24.04 for arm64.
  - Verify after install: `uname -m` must print `aarch64` (not `armv7l`).
- A good-quality **microSD (32 GB+, A2 class)** — *or better, boot from a USB
  SSD* (see §6, strongly recommended for reliability).
- Power: use the **official PSU** (Pi 5 wants 5 V/5 A). Brownouts corrupt data.

All four images are multi-arch and pulled automatically for arm64:
`postgres:16-alpine`, `postgrest/postgrest`, `caddy:2-alpine`, plus the
locally-built `auth` service (Node, arm64-native).

---

## 2. Install Docker on the Pi

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"     # log out/in after this
docker compose version
```

---

## 3. Run it (local LAN, no TLS)

```bash
git clone <your-laetoli-data-repo> laetoli-data
cd laetoli-data
cp .env.example .env
```

Edit `.env`:

- Set `POSTGRES_PASSWORD` and `JWT_SECRET` (`openssl rand -base64 48`).
- **Leave `CADDY_DOMAIN` blank** → Caddy serves plain HTTP, no certificates
  (you can't get public TLS certs for a LAN-only box anyway).
- Optionally set `CADDY_HTTP=80` so apps can use the bare LAN address.

```bash
docker compose up -d
docker compose ps
```

Find the Pi's LAN IP (`hostname -I`), e.g. `192.168.1.50`. Apps on the same
network point at it:

```
LAETOLI_DATA_URL=http://192.168.1.50:8088     # or :80 if CADDY_HTTP=80
```

REST: `http://192.168.1.50:8088/rest/` · Auth: `http://192.168.1.50:8088/auth/`.

> **Nicer LAN name:** Raspberry Pi OS advertises `raspberrypi.local` via mDNS,
> so `http://raspberrypi.local:8088` often works from phones/laptops on the LAN
> without typing an IP.

---

## 4. Offline-LAN classroom setup

The point of "shule ndani ya kisanduku": **no internet required after setup.**

1. **One-time, with internet:** pull the images so they're cached locally —
   `docker compose pull` then `docker compose build` (builds `auth`). After this
   the stack starts fully offline.
2. **Make a network.** Easiest: plug the Pi into a cheap Wi-Fi router/AP that
   serves the classroom. Devices join that Wi-Fi; no uplink needed.
   - Advanced: turn the Pi itself into an access point (`hostapd` + `dnsmasq`),
     so the Pi *is* the Wi-Fi. Students connect straight to it.
3. **Auto-start on boot:** the compose services use `restart: unless-stopped`,
   so they come back automatically after a power cycle — power on the Pi and the
   backend is live. (Confirm Docker itself is enabled: `sudo systemctl enable docker`.)
4. Teachers/students open the Laetoli app pointed at the Pi's LAN URL. Sign-up,
   sign-in (incl. anonymous), notes, RLS — all works with zero internet.

---

## 5. Resource notes

- **RAM:** the stack idles around ~250–400 MB. Postgres is the heavyweight; on a
  4 GB Pi you have plenty of headroom for a classroom of clients.
- **CPU:** light at rest; PostgREST + Postgres handle classroom-scale read/write
  easily on a Pi 4/5. Heavy analytics or hundreds of concurrent writers are a
  VPS job.
- **Add swap** on a 2 GB Pi if you see memory pressure (e.g. `dphys-swapfile`),
  but prefer 4 GB+ and avoid heavy swapping to the SD card.
- Keep the box **cool** — a heatsink/fan helps the Pi sustain load without
  thermal throttling.

---

## 6. microSD / backup cautions (read this)

microSD cards **wear out and fail**, often without warning, and a database does
a lot of writes. Protect the data:

- **Boot from a USB SSD** instead of microSD where possible — far more reliable
  and faster for Postgres. Pi 4/5 both support USB boot.
- **Back up regularly**, exactly like the VPS guide (`pg_dump` → gzip), and copy
  the dump **off the Pi** — to a teacher's laptop, a USB stick, or upstream when
  internet is available. See **DEPLOY.md §6** for the script (it works verbatim
  on the Pi).
- **Power matters:** never yank power mid-write. Use the official PSU; consider a
  small UPS/battery hat for areas with unstable mains.
- Keep a copy of `.env` somewhere safe — losing `JWT_SECRET` invalidates issued
  tokens, and losing the password locks you out of the DB.

> Treat the SD card as disposable and the backups as the source of truth. A dead
> card should cost you a re-flash, not your data.

---

## 7. When to graduate to a VPS

A Pi is ideal for **schools, clinics, edge nodes, demos, and development**. Move
to a real VPS (DEPLOY.md) when you need: public HTTPS on a domain, many
concurrent users beyond a single site, 24/7 uptime guarantees, or national-scale
production. The stack is **identical** — same compose file, same `.env`, same
data model — so a Pi pilot ports straight to a server with a `pg_dump`/restore.
