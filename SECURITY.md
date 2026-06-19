# Security — Laetoli Data

Laetoli Data is a sovereign, self-hostable backend. You run it, you own it, and
you are responsible for its keys and exposure. This document describes the
security model, what is hardened, and how to report issues.

## Reporting a vulnerability

Email **security@laetoli.tz** (or open a private security advisory on
`nooher/laetoli-data`). Please do not file public issues for vulnerabilities.
We aim to acknowledge within 72 hours.

## Trust & identity model

- **Users** authenticate via the auth service (username + password, or anonymous)
  and receive an **HS256 JWT** signed with the shared `JWT_SECRET`, carrying
  `{ sub, role: 'authenticated', exp }`. PostgREST and every service verify it
  with the same secret.
- **Row-Level Security** in PostgreSQL is the real gatekeeper: policies key off
  `auth.uid()` (the JWT `sub`) and the `role` claim — the same model as Supabase,
  so existing RLS migrations port directly. The request roles (`anon`,
  `authenticated`) hold no privileges beyond what RLS grants.
- **`ADMIN_API_KEY`** is the admin/Studio "service-role key". The admin service
  connects as `laetoli_admin_login` (**BYPASSRLS**) and can read/write/DROP
  anything. The service **refuses to start if the key is unset**, compares it in
  constant time, and is reached only behind Caddy at `/admin/*`. Treat this key
  like a database superuser password — never ship it to a browser bundle (the
  Studio asks the operator to paste it at runtime; it lives in `sessionStorage`).
- **API keys** (multi-tenant): per-project keys (`anon` / `service`) are minted
  in the Studio / admin API. Only a SHA-256 **hash** + a short display prefix are
  stored; the full secret is shown **once**. Enforcement on storage + functions
  is gated by `REQUIRE_API_KEY` (off by default).

## What is hardened

- **Secrets never in git.** `.env` is gitignored; `.env.example` ships empty
  values with `openssl` generation hints. Login-role passwords are set at deploy
  time by `db/init/00_passwords.sh` from env, never hardcoded.
- **Edge security headers** at Caddy on every response: `X-Content-Type-Options:
  nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy:
  strict-origin-when-cross-origin`, and the `Server` header stripped. Set
  `CADDY_DOMAIN` to a real domain for **automatic HTTPS**.
- **Least-privilege DB roles** — each service connects as its own LOGIN role
  (`laetoli_auth`, `laetoli_storage`, `laetoli_realtime`, `laetoli_admin_login`),
  granted only what it needs. The powerful `laetoli_admin` capability role stays
  `NOLOGIN`.
- **Input safety** — parameterized SQL everywhere; the admin table/SQL endpoints
  validate identifiers against the live catalog; storage rejects path traversal;
  request bodies are size-capped; uploads are bounded by `STORAGE_MAX_UPLOAD_BYTES`.
- **Rate limiting** — the auth service rate-limits sensitive endpoints; the
  multi-tenant API-key layer enforces per-key `rate_limit_per_min` (429 on
  excess) when enabled.
- **Backups & recovery** — scheduled `pg_dump` + retention; optional WAL
  archiving for point-in-time recovery (`docs/PITR.md`).
- **Supply chain** — Dependabot watches every package + GitHub Actions; CI runs
  typecheck + tests + build + a docker build/integration smoke on every push.
- **Observability** — Prometheus `/metrics` per service (internal-only by
  default; do not expose publicly without an allow-list).

## Known limitations (v1) — read before production

- **Realtime fan-out is table-level, not per-subscriber RLS.** A client
  subscribed to a table receives all of that table's change events. Only enable
  realtime on tables whose changes are safe for any subscriber, or treat the
  stream as a "something changed" hint and re-fetch authoritative rows via
  PostgREST (which enforces RLS). Per-subscriber RLS is a v2 item. See
  `db/migrations/0002_realtime.sql`.
- **Edge functions run in-process** (operator-trusted, no sandbox). Only deploy
  functions you trust. Stronger isolation (Deno / V8 isolates) is a v2 option.
- **CORS defaults to `*`.** Lock `Access-Control-Allow-Origin` to your app
  origins in the `Caddyfile` for production browser deployments.
- **Identity is username + password** (no email verification / OAuth / OTP yet).

## Operator checklist

- [ ] Strong, unique `POSTGRES_PASSWORD`, `JWT_SECRET` (≥32 chars), `ADMIN_API_KEY` (≥24).
- [ ] `CADDY_DOMAIN` set to your domain (enables HTTPS); never serve admin over plain HTTP on the public internet.
- [ ] Restrict CORS origins for production.
- [ ] Keep `/metrics`, the admin API, and Postgres off the public network (reach via Caddy / private network only).
- [ ] Verify backups run (`/status`) and test a restore (`docs/PITR.md`).
- [ ] Rotate `JWT_SECRET` / role passwords periodically (re-run the `ALTER ROLE` step).

© 2026 Laetoli Ltd · Apache-2.0
