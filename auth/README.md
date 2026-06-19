# Laetoli Data — Auth Service

Lean GoTrue-equivalent. Username/password + anonymous sign-in, issuing **HS256**
JWTs that PostgREST and Postgres RLS trust (signed with the shared `JWT_SECRET`).
Runs on `:9999`; Caddy routes `/auth/*` here.

## Endpoints
(As the service sees them, after Caddy strips `/auth`.)

| Method | Path         | Body                     | Success                                   | Errors |
|--------|--------------|--------------------------|-------------------------------------------|--------|
| POST   | `/signup`    | `{username, password}`   | `201 {user, access_token}`                | `400` invalid (Kiswahili), `409` taken |
| POST   | `/token`     | `{username, password}`   | `200 {user, access_token}`                | `401` bad creds (Kiswahili) |
| POST   | `/anonymous` | —                        | `201 {user, access_token}` (is_anonymous) | — |
| GET    | `/user`      | `Authorization: Bearer`  | `200 {user}`                              | `401` invalid/expired/unknown |
| GET    | `/health`    | —                        | `200 {status:"ok"}`                       | — |

`user` shape: `{ id, username, is_anonymous }` — **never** `password_hash`.

## JWT claims
HS256, `{ sub: <user id>, role: "authenticated", iat, exp }` where
`exp = iat + JWT_EXPIRY` (default 3600s). `auth.uid()` in Postgres reads `sub`.
Anonymous users are still `role: "authenticated"` — they are distinguished only
by the `auth.users.is_anonymous` flag, so RLS can scope them per-device.

## Config (env)
`JWT_SECRET` (required, ≥32 chars — fails fast otherwise), `JWT_EXPIRY` (sec),
and either `DATABASE_URL` or `POSTGRES_HOST/PORT/USER/PASSWORD/DB`.

## Architecture / testability
- `config.ts` — env load + fail-fast validation
- `jwt.ts` / `password.ts` / `validation.ts` — pure, unit-tested cores
- `db.ts` — the **`Db` interface** is the dependency-injection seam; `createPgDb`
  is the real (parameterized-SQL) implementation, faked in tests
- `handlers.ts` — DB-injected logic returning `{status, body}` (no HTTP/DB coupling)
- `app.ts` — Express wiring + in-memory rate limiter (`createApp({db,...})`)
- `server.ts` — entry point: load config → `createPgDb` → `createApp` → listen

## Develop / test
```bash
npm install
npm test            # vitest — no live Postgres needed (fake Db)
npx tsc --noEmit    # type-check
npm run build && npm start
```
