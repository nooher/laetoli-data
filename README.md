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
        ┌──────────────────────────── Caddy (80/443, TLS) ────────────────────────────┐
client →│ /rest/* → PostgREST  /auth/* → Auth  /storage/* → Storage  /realtime → Realtime│
        └──────┬──────────────────┬───────────────────┬───────────────────┬────────────┘
               │                  │                   │ (filesystem vol)   │ (LISTEN/NOTIFY)
        PostgreSQL (:5432) ◄────── shared JWT secret (HS256) ──────────────┘
        roles: anon · authenticated · laetoli_admin · laetoli_storage · laetoli_realtime
        RLS enforced via JWT claims (role, sub = user id)
```

- **PostgreSQL** — the database. Roles `anon`, `authenticated`, `laetoli_admin`. Row-Level Security uses the JWT `sub` (user id) + `role` claims — the SAME model as Supabase, so existing RLS migrations port directly.
- **PostgREST** — auto REST API over Postgres. Verifies JWTs with `PGRST_JWT_SECRET`; anonymous role `anon`.
- **Auth service** (`auth/`, Node/Express, `:9999`) — lean GoTrue-equivalent: signup / login (username + password, bcrypt) / **anonymous sign-in**; issues HS256 JWTs signed with the **same** `JWT_SECRET`, claims `{ sub, role, exp }`. Users live in `auth.users`.
- **Storage service** (`storage/`, Node/Express, `:9998`) — sovereign object storage. Buckets + object metadata in Postgres (`storage` schema, RLS), bytes on a **filesystem volume** (no MinIO/S3 — lighter on a Pi). Public & private buckets, owner-scoped writes, time-limited **signed URLs**.
- **Realtime service** (`realtime/`, Node/`ws`, `:9997`) — Postgres `LISTEN/NOTIFY` → **WebSocket** fan-out of row changes. Enable per table with `SELECT realtime.enable('public.my_table')`. JWT-gated; subscribe by table with an optional equality filter. **Owner-aware fan-out:** a change to an owner-scoped table (one with a `user_id`/`owner` column, configurable via `REALTIME_OWNER_COLUMNS`) is delivered only to the subscriber whose JWT `sub` owns the row; tables with no owner column broadcast to all (back-compat); truncated payloads fail closed. See the note in `db/migrations/0002_realtime.sql`.)
- **Admin API** (`admin/`, Node/Express, `:9996`) — schema introspection, table CRUD, SQL console, RLS-policy/roles/users/storage browsing + `/stats`. Connects as `laetoli_admin_login` (BYPASSRLS); gated by the `ADMIN_API_KEY` "service-role key".
- **Admin Studio** (`studio/`, Vite+React, served at `/studio/`) — the sovereign dashboard: Table Editor, SQL Console, Auth users, Storage browser, RLS Policies viewer, stats. Paste the `ADMIN_API_KEY` to sign in.
- **Edge Functions** (`functions/`, Node, `:9995`) — operator-provided serverless functions over HTTP at `/functions/<name>`; per-invocation timeout, optional JWT `ctx.user`.
- **Backups + PITR** (`backup/`, `:9994`) — scheduled `pg_dump` + retention; optional WAL archiving for point-in-time recovery (see `docs/PITR.md`).
- **Observability** — each service exposes Prometheus `/metrics` (internal); see `docs/OBSERVABILITY.md`.
- **Caddy** — single TLS endpoint; routes `/rest/*`→PostgREST, `/auth/*`→auth, `/storage/*`→storage, `/realtime`→realtime (WS), `/admin/*`→admin, `/functions/*`→functions, `/studio/*`→Studio.
- **@laetoli/data** (`client/`) — JS/TS SDK mirroring the Supabase-JS subset our apps use: `from(table).select/insert/update/delete/eq/order/limit`, `auth.signUp/signInWithPassword/signInAnonymously/getUser/signOut`, **`storage.from(bucket).upload/download/list/createSignedUrl`**, **`channel(table).on(event, cb).subscribe()`**. Swap `createClient(URL, KEY)` → point at your Laetoli Data endpoint.

## Layout
- `docker-compose.yml` · `Caddyfile` · `.env.example` — the stack
- `db/` — schema, roles, RLS, `init/` (fresh boot) + `migrations/` (upgrade path) + `seed/`
- `auth/` · `storage/` · `realtime/` · `admin/` · `functions/` · `backup/` — the sovereign services (each + Dockerfile, tests)
- `studio/` — the Admin Studio dashboard (Vite+React, served at `/studio/`)
- `client/` — `@laetoli/data` SDK (+ tests)
- `cli/` — `laetoli-data` CLI (init / up / migrate / backup / …)
- `docs/` — `PITR.md`, `OBSERVABILITY.md` · `DEPLOY.md` · `RASPBERRY_PI.md`

## Quick start
```bash
# Option A — the CLI does the setup for you:
cd cli && npm install && npm run build && node dist/index.js init   # writes .env with fresh secrets
node cli/dist/index.js up                                           # docker compose up -d

# Option B — by hand:
cp .env.example .env   # set POSTGRES_PASSWORD + JWT_SECRET (long random)
docker compose up -d   # Postgres + PostgREST + Auth + Storage + Realtime + Caddy
```
A fresh boot ships the full schema (auth, storage, realtime — incl. the `notes`
example with realtime enabled). On an EXISTING database, apply new schema with
`node cli/dist/index.js migrate`. Enable realtime on your own tables with
`SELECT realtime.enable('public.my_table');`.

Then from an app:
```ts
import { createClient } from '@laetoli/data';
const db = createClient(URL, { apikey: ANON });
await db.auth.signUp({ username, password });
await db.from('notes').insert({ body: 'habari' });
await db.storage.from('media').upload('a.png', file);
db.channel('notes').on('INSERT', (e) => console.log(e.record)).subscribe();
await db.functions.invoke('hello', { body: { jina: 'Asha' } });
```

Open the **Admin Studio** at `http://localhost:8088/studio/` and sign in with
your `ADMIN_API_KEY` to browse tables, run SQL, and manage auth/storage/RLS.

## CLI (`laetoli-data`)
| Command | Does |
|---|---|
| `init` | create `.env` with fresh `POSTGRES_PASSWORD` + `JWT_SECRET` (never overwrites) |
| `up` / `down` | start / stop the stack (`down -- -v` also wipes data) |
| `status` | container status + health-probe the public URL |
| `migrate` / `migrate --status` | apply pending `db/migrations/*.sql` (transactional, checksum-guarded) |
| `seed` | run `db/seed/*.sql` |
| `backup [--out f]` / `restore <f> --force` | `pg_dump` / restore via docker |
| `secret` | print a strong random secret |

Apache-2.0 · © 2026 Laetoli Ltd · part of the Laetoli sovereign stack.
