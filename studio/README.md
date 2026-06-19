# Admin Studio — `@laetoli/studio`

The sovereign dashboard for **Laetoli Data** — the self-hostable Supabase
alternative. A dependency-lean Vite + React 19 + TypeScript SPA, served behind
the edge Caddy at **`/studio/`**.

It is the operator's console: dashboard, table editor, SQL console, auth users,
storage browser and an RLS policy viewer.

## Auth — the admin key

The Studio talks to the **admin API** (gated by `ADMIN_API_KEY`, the
"service-role key"). On the **Login** screen the operator pastes the key (and,
optionally, the API base URL). The key is stored in **`sessionStorage`** (so it
clears when the tab closes) and sent as `Authorization: Bearer <key>` on every
admin request. `GET /health` is the only unauthenticated call. **Sign out**
clears it. No key is ever hardcoded.

By default the API base is the same origin's **`/admin`** (behind Caddy). You
can override it on the Login screen, or bake a different default at build time
with `VITE_ADMIN_API_BASE` (see `.env.example`).

## Screens

| Screen | API | Notes |
|---|---|---|
| Dashboard | `/stats`, `/health` | tiles + service health |
| Table Editor | `/schema`, `/table/:schema/:name` (+ POST/PATCH/DELETE) | paginated rows, inline add/edit/delete by primary key, column types |
| SQL Console | `/sql` | textarea + Run, result grid, errors, history in sessionStorage |
| Authentication | `/auth/users`, `DELETE /auth/users/:id` | list + delete (confirm) |
| Storage | `/storage/buckets`, `/storage/objects` | buckets → objects (path, size, mime, owner, created) |
| Policies | `/policies` | RLS policies grouped by table + RLS-enabled status |

## Develop

```bash
npm install
npm run dev         # http://localhost:5180/studio/
npm run typecheck
npm test            # vitest
npm run build       # -> dist/ (base '/studio/')
npm run preview
```

With no backend running, the app gracefully shows the Login screen; a wrong key
or unreachable API surfaces a clean error.

## Docker

Multi-stage build → static `dist/` served by `caddy:2-alpine` on **port 80**
with SPA fallback for `/studio/*`.

```bash
docker build -t laetoli-studio ./studio
```

The edge Caddy reverse-proxies `/studio/*` to this container. See the repo
root wiring (docker-compose `studio` service + Caddyfile route).

Apache-2.0 · © 2026 Laetoli Ltd · part of the Laetoli sovereign stack.
