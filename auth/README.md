# Laetoli Data — Auth Service

Lean GoTrue-equivalent. Username/password + anonymous sign-in, issuing **HS256**
JWTs that PostgREST and Postgres RLS trust (signed with the shared `JWT_SECRET`).
Runs on `:9999`; Caddy routes `/auth/*` here.

## Endpoints
(As the service sees them, after Caddy strips `/auth`.)

| Method | Path                     | Body                              | Success                                                  | Errors |
|--------|--------------------------|-----------------------------------|----------------------------------------------------------|--------|
| POST   | `/signup`                | `{username, password, email?}`    | `201 {user, access_token, refresh_token, token_type, expires_in}` | `400` invalid (Kiswahili), `409` taken |
| POST   | `/token`                 | `{username, password}`            | `200 {user, access_token, refresh_token, …}`             | `401` bad creds (Kiswahili) |
| POST   | `/anonymous`             | —                                 | `201 {user, access_token, refresh_token, …}` (is_anonymous) | — |
| POST   | `/refresh`               | `{refresh_token}`                 | `200 {user, access_token, refresh_token, …}` (rotated)   | `401` invalid/expired/reused |
| POST   | `/logout`                | `{refresh_token?}`                | `200 {message}` (idempotent)                             | — |
| POST   | `/password/forgot`       | `{username?, email?}`             | `200 {message, reset_token?}` (token only when `RESET_DELIVERY=log`) | — |
| POST   | `/password/reset`        | `{token, password}`              | `200 {message}` (revokes all refresh tokens)            | `400` invalid/expired |
| POST   | `/email/verify/request`  | `Authorization: Bearer`           | `200 {message, verification_token?}` (token only when `EMAIL_DELIVERY=log`) | `400` no email, `401` no/invalid token |
| POST   | `/email/verify/confirm`  | `{token}`                         | `200 {message}`                                          | `400` invalid/expired |
| POST   | `/otp/request`           | `{phone}`                         | `200 {message, code?}` (code only in `log` mode); else SMS | `400` invalid phone |
| POST   | `/otp/verify`            | `{phone, code}`                   | `200 {user, access_token, refresh_token, …}`             | `400` wrong/expired/over-attempt |
| GET    | `/user`                  | `Authorization: Bearer`           | `200 {user}`                                             | `401` invalid/expired/unknown |
| GET    | `/health`                | —                                 | `200 {status:"ok"}`                                      | — |

`user` shape: `{ id, username, is_anonymous, email, email_verified, phone }` — **never** `password_hash`.

## Sessions: access + refresh

The **access token** is the HS256 JWT PostgREST/Postgres trust; keep its lifetime
modest (`JWT_EXPIRY`). The **refresh token** is an opaque, high-entropy random
value (`crypto.randomBytes`), stored **only as its SHA-256 hash**. Clients keep
the refresh token and call `POST /refresh` to get a fresh access JWT plus a
**rotated** refresh token (the old one is revoked).

**Rotation + reuse-detection.** Every refresh chain shares a `family_id`. On
`/refresh` the presented token is revoked and a new one issued in the same
family. If an **already-revoked** token is presented again (reuse — e.g. a
stolen token replayed), the **entire family is revoked** and the call fails,
forcing a fresh login. `/logout` revokes the presented token and its family.

> Access JWTs remain valid until their `exp` by design (PostgREST verifies them
> statelessly). That is why `JWT_EXPIRY` should stay small; revocation acts on
> the refresh layer.

## Password reset + email verification

`/password/forgot` issues a single-use, short-lived token stored hashed in
`auth.reset_tokens`; `/password/reset` consumes it, sets a new bcrypt hash, and
revokes **all** of the user's refresh tokens. Email is **optional**;
`/email/verify/request` + `/email/verify/confirm` use
`auth.email_verification_tokens` the same way. Both flows deliver via the
`*_DELIVERY` seam, which now **actually sends**:

- `log` (default, offline-first) — logs + returns the token for dev.
- `email` — composes a reset/verify message (a clickable link when `BASE_URL`/
  `APP_URL` is set, else the raw token) and sends it over **real SMTP** (any
  server the operator runs, via `nodemailer`). If `SMTP_HOST` is unset the mailer
  **degrades gracefully** to a logged no-op — it never crashes the node.
- `sms` — texts the token to the user's phone via the operator's **own NextSMS
  account** (`messaging-service.co.tz`). If `SMS_API_TOKEN` is unset it degrades
  to a logged no-op.

Delivery failures are caught + logged and **never** change the response, so
`/password/forgot` always returns the same generic `200` (no enumeration). No
third-party SaaS SDK is used — SMTP is the operator's server, SMS is the
operator's NextSMS account. For an **admin recovery** path (locked-out user),
see the SQL block at the bottom of `db/migrations/0009_auth_tokens.sql`.

## Phone-OTP (sovereign passwordless login)

`/otp/request {phone}` finds-or-creates a phone-only account, generates a
6-digit code stored **hashed** (sha256) with a short expiry (`OTP_EXPIRY`, 5 min
default) and an attempt counter (`OTP_MAX_ATTEMPTS`, 5 default) in
`auth.otp_codes`, and texts it via the NextSMS channel. `/otp/verify {phone,
code}` checks hash + expiry + attempts and, on success, issues the **normal
access + refresh tokens** (identical to login). Wrong codes increment the
counter; an exhausted/expired/used code is rejected. In `log` mode (no SMS
sender wired) the code is returned/logged for dev. The route is rate-limited by
the same per-IP limiter as the rest of the service.

## JWT claims
HS256, `{ sub: <user id>, role: "authenticated", iat, exp }` where
`exp = iat + JWT_EXPIRY` (default 3600s). `auth.uid()` in Postgres reads `sub`.
Anonymous users are still `role: "authenticated"` — they are distinguished only
by the `auth.users.is_anonymous` flag, so RLS can scope them per-device.

## Config (env)
| Var | Default | Meaning |
|-----|---------|---------|
| `JWT_SECRET` | — (required, ≥32 chars; fails fast) | HS256 signing key, **must match PostgREST** |
| `JWT_EXPIRY` | `3600` | Access-token (JWT) lifetime, seconds — keep modest |
| `REFRESH_EXPIRY` | `2592000` (30d) | Refresh-token lifetime, seconds |
| `RESET_EXPIRY` | `3600` (1h) | Password-reset token lifetime, seconds |
| `EMAIL_VERIFY_EXPIRY` | `86400` (24h) | Email-verification token lifetime, seconds |
| `RESET_DELIVERY` | `log` | `log` (return/log token), `email` (SMTP) or `sms` (NextSMS) |
| `EMAIL_DELIVERY` | `log` | `log`, `email` or `sms` |
| `OTP_EXPIRY` | `300` (5m) | Phone-OTP code lifetime, seconds |
| `OTP_MAX_ATTEMPTS` | `5` | Max wrong OTP guesses before a code is dead |
| `BASE_URL` / `APP_URL` | — (falls back to `LAETOLI_DATA_URL`) | Public base for reset/verify links; raw token sent when unset |
| `SMTP_HOST` | — (unset → email degrades to log) | SMTP server hostname |
| `SMTP_PORT` | `587` | SMTP port (465 ⇒ `secure` defaults true) |
| `SMTP_SECURE` | auto (`true` on 465) | Use implicit TLS |
| `SMTP_USER` / `SMTP_PASS` | — | SMTP auth (omit for open relays) |
| `SMTP_FROM` | `Laetoli Data <no-reply@laetoli.africa>` | From header |
| `SMS_API_URL` | `https://messaging-service.co.tz` | NextSMS base URL |
| `SMS_API_TOKEN` | — (unset → sms degrades to log) | **Operator's own** NextSMS Basic-auth token |
| `SMS_DEFAULT_SENDER_ID` | `LAETOLI` | NextSMS sender id |

SMTP is **any server the operator runs**; SMS is the **operator's own NextSMS
account** — no third-party SaaS lock-in. Both default to the offline-first `log`
behaviour when unconfigured.

Plus either `DATABASE_URL` or `POSTGRES_HOST/PORT/USER/PASSWORD/DB`.

## DB schema
`db/init/02_auth.sql` (fresh boots) and `db/migrations/0009_auth_tokens.sql`
(existing DBs) add: `auth.users.email` (optional, unique-when-present) +
`email_verified`; `auth.refresh_tokens`, `auth.reset_tokens`,
`auth.email_verification_tokens` (all token values **sha256-hashed at rest**,
FK→`auth.users`, indexed); and `auth.cleanup_expired_tokens()` to schedule
nightly. `db/migrations/0011_phone_otp.sql` adds `auth.users.phone` (optional,
unique-when-present) and `auth.otp_codes` (sha256-hashed 6-digit codes with an
attempt counter + short expiry), and folds OTP cleanup into the same nightly
function.

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
