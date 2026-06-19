# Laetoli Data — Sovereign Backend

**A self-hostable, sovereign backend for the Laetoli ecosystem.** Run your own
database + auto REST API + auth on a Tanzanian VPS — or a **Raspberry Pi** — so you
own your data and stop paying per-project SaaS fees. Open, offline-capable,
Swahili-aware. By Laetoli Ltd · Apache-2.0.

> We do **not** reinvent Supabase. Laetoli Data assembles the proven open stack
> (**PostgreSQL + PostgREST**) plus a lean sovereign **auth** service and a
> drop-in **client SDK**, packaged to run anywhere — including a Pi in a classroom
> with no internet ("shule ndani ya kisanduku").

## Architecture (the contract every component targets)

```
            ┌──────────────────────────── Caddy (80/443, TLS) ───────────────────────────┐
  client →  │   /rest/*  → PostgREST (:3000)        /auth/*  → Auth service (:9999)        │
            └───────────────┬───────────────────────────────┬───────────────────────────┘
                            │                                │
                     PostgreSQL (:5432)  ◄────── shared JWT secret (HS256) ──────┘
                     roles: anon · authenticated · laetoli_admin
                     RLS enforced via JWT claims (role, sub = user id)
```

- **PostgreSQL** — the database. Roles `anon`, `authenticated`, `laetoli_admin`. Row-Level Security uses the JWT `sub` (user id) + `role` claims — the SAME model as Supabase, so existing RLS migrations port directly.
- **PostgREST** — auto REST API over Postgres. Verifies JWTs with `PGRST_JWT_SECRET`; anonymous role `anon`.
- **Auth service** (`auth/`, Node/Express, `:9999`) — lean GoTrue-equivalent: signup / login (username + password, bcrypt) / **anonymous sign-in**; issues HS256 JWTs signed with the **same** `JWT_SECRET`, claims `{ sub, role, exp }`. Users live in `auth.users`.
- **Caddy** — single TLS endpoint; routes `/rest/*` → PostgREST, `/auth/*` → auth.
- **@laetoli/data** (`client/`) — JS/TS SDK mirroring the Supabase-JS subset our apps use: `from(table).select/insert/update/delete/eq/order/limit`, `auth.signUp/signInWithPassword/signInAnonymously/getUser/signOut`. Swap `createClient(URL, KEY)` → point at your Laetoli Data endpoint.

## Layout
- `docker-compose.yml` · `Caddyfile` · `.env.example` — the stack
- `db/` — schema, roles, RLS, init
- `auth/` — the sovereign auth service (+ Dockerfile, tests)
- `client/` — `@laetoli/data` SDK (+ tests)
- `DEPLOY.md` · `RASPBERRY_PI.md` — run it on a VPS or a Pi (+ backups)

## Quick start
```bash
cp .env.example .env   # set POSTGRES_PASSWORD + JWT_SECRET (long random)
docker compose up -d   # Postgres + PostgREST + Auth + Caddy
```
Then from an app: `import { createClient } from '@laetoli/data'`.

Apache-2.0 · © 2026 Laetoli Ltd · part of the Laetoli sovereign stack.
