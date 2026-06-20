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
- **Configurable CORS** — `Access-Control-Allow-Origin` is driven by env (see
  **CORS** below). Unset → permissive `*` for dev; set → only vetted origins are
  reflected, with `Vary: Origin`.
- **Rate limiting** — the auth service rate-limits sensitive endpoints (the
  guaranteed floor); an optional **edge** per-IP limiter at Caddy fronts the
  public API routes (see **Rate limiting** below); the multi-tenant API-key
  layer enforces per-key `rate_limit_per_min` (429 on excess) when enabled.
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
- **CORS defaults to `*`.** Convenient for dev; **lock it down for any public
  deployment** by setting `CORS_ALLOWED_ORIGINS_REGEXP` (see **CORS** below).
- **Edge rate limiting needs a plugin.** The base `caddy:2-alpine` image does
  not bundle the `rate_limit` handler, so the edge limiter is OFF until you
  build a Caddy with it (see **Rate limiting**). The auth service's app-level
  limiter is always on as the floor.
- **Identity is username + password** (no email verification / OAuth / OTP yet).

## CORS

`Access-Control-Allow-Origin` is configured at the edge (Caddy) via two env vars
wired through `docker-compose.yml`:

- **Unset (default):** `Access-Control-Allow-Origin: *` — every origin allowed.
  Good for local dev and the `@laetoli/data` SDK from anywhere; **not for a
  public deployment.**
- **Locked down (production):** leave `CORS_ALLOWED_ORIGINS` empty and set
  `CORS_ALLOWED_ORIGINS_REGEXP` to an **anchored alternation** of your app
  origins. A request whose `Origin` matches is **reflected** back as the
  `Allow-Origin` value with `Vary: Origin`; non-matching origins get **no**
  `Allow-Origin`, so the browser blocks the cross-origin read.

Turn a comma list into the regexp (escape dots, no trailing slash):

```
# origins: https://app.example.tz, https://admin.example.tz
CORS_ALLOWED_ORIGINS_REGEXP=^(https://app\.example\.tz|https://admin\.example\.tz)$
```

Validate the config after editing: `docker compose run --rm --entrypoint caddy
caddy validate --config /etc/caddy/Caddyfile` (or `caddy validate` if Caddy is
installed locally).

## Rate limiting

Two layers, defence in depth:

1. **App-level (always on, the floor):** the auth service per-IP rate-limits its
   sensitive endpoints regardless of edge config. This cannot be bypassed by a
   missing plugin.
2. **Edge (optional, recommended for public exposure):** a Caddy `rate_limit`
   handler fronts the public API routes (`/rest`, `/auth`, `/storage`,
   `/functions`) per client IP, returning **429** on abuse. Tuned by
   `RATE_LIMIT_RPS` / `RATE_LIMIT_BURST` (gentle defaults: 10 rps, burst 120/min).

   **Plugin caveat:** the base `caddy:2-alpine` image does **not** include the
   `rate_limit` handler. Build a Caddy with it (the `rate_limit` block in the
   `Caddyfile` is commented out until you do):

   ```dockerfile
   # Dockerfile.caddy
   FROM caddy:2-builder AS build
   RUN xcaddy build --with github.com/mholt/caddy-ratelimit
   FROM caddy:2-alpine
   COPY --from=build /usr/bin/caddy /usr/bin/caddy
   ```

   Point the `caddy` service at it (`build: { dockerfile: Dockerfile.caddy }`),
   then uncomment the `rate_limit` block in the `Caddyfile`.

## RLS audit

RLS in Postgres is the real gatekeeper, so **every application table must have
RLS enabled with at least one policy.** Migration `db/migrations/0009_rls_audit.sql`
adds an operator helper to verify this — it surfaces gaps, it does **not**
force-enable RLS (and it never touches system schemas):

```sql
SELECT * FROM public.rls_audit;          -- gaps only; EMPTY == all tables protected
SELECT * FROM public.rls_audit_all;      -- every app table + RLS status
SELECT * FROM public.rls_audit_summary();-- one-row digest (total / protected / gaps)
```

`rls_audit` lists any table in a non-system schema that has **RLS disabled** or
is **enabled with zero policies** (default-deny — confirm it is intentional).
Run it before exposing the stack publicly and gate your deploy on `gaps = 0`.
The views/function are granted to `laetoli_admin` only (the catalog of
unprotected tables is operator information).

## Secret rotation

Rotate `JWT_SECRET`, the DB role passwords, and `ADMIN_API_KEY` periodically and
after any suspected leak. Scripted path:

```bash
scripts/rotate-secrets.sh            # all three
scripts/rotate-secrets.sh --jwt      # just one
scripts/rotate-secrets.sh --dry-run  # preview
```

It backs up `.env`, runs the live `ALTER ROLE` for DB rotation, and restarts the
affected services **in the correct order** so they reconnect cleanly. Full guide
(including manual steps, restart-order rationale, and rollback) in
[`docs/ROTATION.md`](docs/ROTATION.md).

## Operator checklist

- [ ] Strong, unique `POSTGRES_PASSWORD`, `JWT_SECRET` (≥32 chars), `ADMIN_API_KEY` (≥24).
- [ ] `CADDY_DOMAIN` set to your domain (enables HTTPS); never serve admin over plain HTTP on the public internet.
- [ ] Restrict CORS origins for production (`CORS_ALLOWED_ORIGINS_REGEXP` — see **CORS**).
- [ ] Enable edge rate limiting for public exposure (build Caddy with `rate_limit`, uncomment the block — see **Rate limiting**).
- [ ] Run the RLS audit and confirm `gaps = 0` (`SELECT * FROM public.rls_audit_summary();` — see **RLS audit**).
- [ ] Keep `/metrics`, the admin API, and Postgres off the public network (reach via Caddy / private network only).
- [ ] Verify backups run (`/status`) and test a restore (`docs/PITR.md`).
- [ ] Rotate `JWT_SECRET` / role passwords / `ADMIN_API_KEY` periodically (`scripts/rotate-secrets.sh` — see **Secret rotation**).

© 2026 Laetoli Ltd · Apache-2.0
