# MFA — TOTP authenticator-app enrollment

Laetoli Data ships self-service TOTP (RFC 6238) multi-factor auth — the same kind of "scan a QR
code with Google Authenticator" flow Supabase provides via `auth.mfa.*`. The REST shape is
deliberately the same, so a client already built against Supabase's MFA API needs minimal changes
to target Laetoli Data instead.

**Scope, stated plainly:** this is enrollment and factor management. It does **not** yet enforce
a second factor at login time — see [Login-time enforcement](#login-time-enforcement-not-yet-built)
below before assuming MFA is "on."

## Endpoints

| Method | Path | Auth | What it does |
|---|---|---|---|
| `POST` | `/factors` | Bearer | Enroll a new TOTP factor. Returns `{id, type: 'totp', totp: {qr_code, secret, uri}}` — the secret/QR are shown **once**. |
| `GET` | `/factors` | Bearer | List the caller's factors: `{totp: [...], all: [...]}`. |
| `POST` | `/factors/:id/challenge` | Bearer | Start a challenge. Returns `{id, expires_at}` — required before `/verify`. |
| `POST` | `/factors/:id/verify` | Bearer + `{challenge_id, code}` | Check the 6-digit code. On success, an `unverified` factor flips to `verified`. |
| `DELETE` | `/factors/:id` | Bearer | Unenroll (remove) a factor. |

Every endpoint requires the same `Authorization: Bearer <access_token>` as `/user`, and every
factor/challenge lookup checks ownership (`factor.user_id === caller`) — one user can't
challenge, verify, or delete another user's factor (404, not a hint that the factor exists).

## From the SDK

If you're calling this directly (rather than through a Supabase-compatible client), the shape
matches `supabase.auth.mfa.*` closely enough to copy the calling pattern:

```ts
// Enroll
const enroll = await fetch(`${AUTH_URL}/factors`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({}),
}).then(r => r.json());
// enroll.totp.qr_code is a data:image/svg+xml;base64,... — render directly in an <img>.
// enroll.totp.secret is base32 — show as a manual-entry fallback.

// User scans the QR / enters the secret, then types the 6-digit code their app shows.
const challenge = await fetch(`${AUTH_URL}/factors/${enroll.id}/challenge`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${accessToken}` },
}).then(r => r.json());

const verify = await fetch(`${AUTH_URL}/factors/${enroll.id}/verify`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ challenge_id: challenge.id, code: userEnteredCode }),
}).then(r => r.json());
// verify.status === 'verified' on success.
```

## Security notes

- **Secrets are encrypted at rest**, not hashed — `auth/src/encryption.ts`, AES-256-GCM with a
  key derived from `JWT_SECRET`. Unlike a password, a TOTP secret has to be recovered on every
  verification (the server recomputes the expected code from it), so one-way hashing isn't
  possible here. Decryption fails closed on a wrong key or tampered ciphertext (GCM auth tag).
- **±1 time-step tolerance** (±30s) on verification to absorb normal clock drift between the
  server and the user's phone, without meaningfully widening the guessable window.
- **Constant-time comparison** on every candidate code (`auth/src/totp.ts`) — no timing signal on
  which time-step (if any) matched.
- **Challenges are single-use** — `mfa_challenges.verified_at` is set on success and a second
  `/verify` against the same challenge fails, even with a correct code.
- **Never exposed through PostgREST.** `auth.mfa_factors`/`auth.mfa_challenges` are written only
  by the `laetoli_auth` service role; the auth service's own REST endpoints are the only way in.

## Login-time enforcement — not yet built

Supabase's real MFA model is a step-up: a password login for an account with a verified factor
issues a **lower-trust (AAL1) session**, and the client must complete a TOTP challenge to reach
**AAL2** before sensitive actions are allowed (or before the session is treated as fully
authenticated at all, depending on how strict the app wants to be). This service does not do that
yet — `/token` issues a full session regardless of whether the account has a verified factor.

Building this needs, roughly:
1. `/token` checking for a verified factor and, if present, issuing a restricted/AAL1 token (or a
   short-lived "pending MFA" token) instead of a normal session.
2. A way to exchange a completed `/factors/:id/verify` for the real, full session token when it
   was triggered by a login rather than enrollment.
3. Deciding what AAL1 can and can't do in the meantime (nothing, per Supabase's own default, is
   the simplest and safest starting point).

Track this as the next real piece of work before telling users "2FA is required" — today it's
"2FA is available and enrollable," which is a meaningfully different (and weaker) claim.
