# Admin user-ops — invite / suspend / revoke-sessions / reset-mfa

The admin service (`admin/`, gated by `ADMIN_API_KEY`) exposes four account-management
operations mirroring the Supabase Admin API surface (`supabase.auth.admin.*`) that server-side
code — an Edge Function, a backend job, an operator script — calls with the service-role key.
None of these are exposed through `@laetoli/data`'s client SDK; they're not user-facing, the same
way Supabase's admin API is never called from a browser with the anon key.

## Endpoints

All require `Authorization: Bearer <ADMIN_API_KEY>` (or `x-admin-key`), same as every other admin
route.

| Method | Path | Body | What it does |
|---|---|---|---|
| `POST` | `/users/invite` | `{email, redirect_to?}` | Find-or-create a user for `email` and email them a sign-in link. |
| `POST` | `/users/:id/suspend` | `{suspend?: boolean}` (default `true`) | Block new logins; suspending ALSO revokes existing sessions. |
| `POST` | `/users/:id/revoke-sessions` | — | Force re-login everywhere, without suspending the account. |
| `POST` | `/users/:id/reset-mfa` | — | Remove all enrolled TOTP factors. |

## Invite — reuses the magic-link flow, doesn't duplicate it

`handleInviteUser` (`admin/src/handlers.ts`) does not implement its own token/email machinery. It
makes one internal HTTP call to the auth service's own `POST /magiclink` (`AUTH_INTERNAL_URL`,
defaults to `http://auth:9999` — the compose service name, works out of the box in the standard
stack). This means there's exactly one place in the codebase that knows how to mint and deliver a
sign-in token, not two half-maintained copies. The only difference between an admin invite and
self-service `signInWithOtp` is *who* triggered it — the resulting account, link, and expiry all
behave identically. See `docs/MAGIC_LINK.md`.

A consequence worth knowing: the auth service's own validation runs (email format, etc.), and its
error response is passed straight back through the admin endpoint's `status`/`body` — an admin
inviting `"not-an-email"` gets the same 400 a self-service caller would.

## Suspend — blocks new logins immediately; kills existing sessions too

`auth.users.suspended_at` (new column, `db/migrations/0020_admin_user_ops.sql`) is checked by the
auth service on every token-**issuing** path: password login, OTP verify, magic-link verify,
OAuth callback, and refresh. A suspended account gets a `403` with a clear message instead of a
session.

Suspending also calls `revokeUserSessions` in the same request — so it's not just "block future
logins," it's "block future logins AND kill sessions already in flight." This matters because an
already-issued access token in this service lives out its (short) `exp` regardless of anything an
admin does afterward — that's a documented, deliberate property of the JWT model (see
`SECURITY.md`), not a bug. Suspend closes that gap for the *refresh* path (a suspended session
can't renew itself), which is the practical equivalent of immediate lockout for any client that
refreshes on a normal cadence.

`{suspend: false}` un-suspends and does **not** touch sessions (there are none left to revoke by
that point in the normal flow, and un-suspending shouldn't have side effects beyond restoring
login).

## Revoke-sessions — the narrower op

Same underlying action as the auto-revoke inside suspend (`UPDATE auth.refresh_tokens SET
revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`), exposed standalone for the case
where an admin wants "force re-login everywhere" without banning the account — e.g. suspected
session theft, a lost device, or after a password change made elsewhere.

## Reset-mfa — for a lost authenticator

Deletes every row in `auth.mfa_factors` for the user (`DELETE ... WHERE user_id = $1`). The user
logs in with their password/OTP/magic-link as normal afterward (there's no login-time MFA
enforcement yet — see the "Login-time enforcement" section of `docs/MFA.md` — so this mainly
matters once that's built) and re-enrolls a new factor from scratch.

## What's verified live (not just unit-tested)

Full loop run against a running Docker `db`+`auth`+`admin` stack, admin calling auth over the
real internal Docker network (`http://auth:9999`), not mocked:

1. `POST /users/invite` → a real user appears in `GET /auth/users` with `suspended_at: null`.
2. A password-based signup logs in fine, then `POST /users/:id/suspend` → the *same* login now
   `403`s, and the refresh token issued *before* suspension is dead (`401` on `/refresh` — proof
   the auto-revoke-on-suspend actually ran, not just the `suspended_at` flag).
3. `{suspend: false}` → login works again immediately.
4. `POST /users/:id/revoke-sessions` on a fresh session → the refresh token from that session dies,
   but login itself remains allowed (unlike suspend).
5. Enroll a real TOTP factor over `/factors`, `POST /users/:id/reset-mfa`, then `GET /factors`
   confirms an empty list.

## Scope — what this is not

- No admin UI (Studio) screen for these yet — they're API-only, matching what a server-side caller
  (Kasuku's Edge Functions, an operator script) actually needs. Adding Studio buttons is a
  follow-up, not a functional gap.
- `invite`'s emailed copy is the same generic magic-link message as self-service sign-in, not
  bespoke "you've been invited" wording — a known simplification (see `docs/MAGIC_LINK.md`'s
  `composeMessage`), not a missing feature.
- Suspend doesn't retroactively kill an access token that's still within its `exp` — by design,
  consistent with every other revocation in this service.
