# Email magic-link — passwordless sign-in

Laetoli Data supports "sign in with a link we email you" — the same passwordless flow as
Supabase's `signInWithOtp({ email })`. No password, no code to type (though the token can also be
submitted directly as an API call, for non-browser clients).

## Flow

```
browser → POST /auth/magiclink { email, redirect_to? }
        → auth service finds-or-creates a user for that email, emails a single-use link
user clicks the emailed link:
        → GET /auth/magiclink/verify?token=...&redirect_to=...
        → 302 to <redirect_to>#access_token=...&refresh_token=...&token_type=bearer&expires_in=...
browser lands back on the app; the SDK's detectSessionInUrl() adopts the session automatically
```

If `redirect_to` is omitted (e.g. a non-browser client calling `/magiclink/verify` directly with
the token), the endpoint returns the session as a normal JSON body instead of redirecting —
useful for testing or a client that isn't a browser.

## Config

```bash
MAGICLINK_EXPIRY=900          # seconds — how long the link is valid (default 15 min)
MAGICLINK_DELIVERY=log        # 'log' (dev/offline default) | 'email' (real SMTP send)
BASE_URL=https://data.example.tz   # used to build the clickable link in the email
OAUTH_ALLOWED_REDIRECT_ORIGINS_REGEXP=^https://app\.example\.tz$   # same allow-list as OAuth
```

`MAGICLINK_DELIVERY` falls back to `EMAIL_DELIVERY` when unset, since it's the same "send an
email" channel as password-reset/email-verify. `OAUTH_ALLOWED_REDIRECT_ORIGINS_REGEXP` is reused
rather than duplicated — both OAuth and magic-link redirect the browser back to the app with
tokens in the URL fragment, so they share the same fail-closed allow-list (an unset regexp means
no `redirect_to` is ever accepted, not "accept anything").

In `log` mode (the default), the token is also returned in the `POST /magiclink` response body as
`magic_link_token` — dev/offline convenience, same pattern as password-reset and email-verify.

## From the SDK

```ts
import { createClient } from '@laetoli/data';
const db = createClient(URL, { apikey: ANON });

// Emails a link. Lands back on the current page (or options.emailRedirectTo)
// with the session already adopted — no further code needed.
await db.auth.signInWithOtp({ email: 'asha@example.tz' });

// Or send them to a specific callback page:
await db.auth.signInWithOtp({
  email: 'asha@example.tz',
  options: { emailRedirectTo: 'https://app.example.tz/callback' },
});
```

On the callback page, no extra code is needed — the `AuthClient` constructor's
`detectSessionInUrl()` reads `#access_token=...` off `window.location.hash`, persists it, strips
the fragment, and fires `SIGNED_IN` — the exact same landing mechanism as the OAuth callback.

## Identity model — find-or-create by email, verified on first successful click

Unlike OAuth (which deliberately does **not** merge into an existing password account sharing an
email — see `docs/OAUTH.md`), magic-link **does** find-or-create by email directly. This is
intentional and safe: the token is only ever delivered to the address the requester typed, so the
only way to complete a magic-link login is to control that inbox — the identical trust model this
service already uses for password-reset links (`handlers.ts`: `handlePasswordForgot`/
`handlePasswordReset`). Whoever clicks the link owns the account it points at, however that
account was created.

Following from that: **a successful click marks the account's email verified**, even if it wasn't
before. Completing the link IS the proof of ownership password/email-verification flows exist to
establish, so there's no reason to make the user separately verify afterward.

## What's verified live (not just unit-tested)

- `POST /magiclink` → `GET /magiclink/verify` round-tripped against a running Docker `auth`+`db`
  pair (real Postgres, not a fake store): a real user row created, a real single-use token issued
  and consumed, a real session (valid JWT) returned.
  - **Caught a real bug this way that a fake-store test could not**: the first response after a
    successful verify was returning a stale `email_verified: false` even though the database row
    had just been updated to `true` — because the in-memory `user` object used to build the
    session was read *before* the verification write, not after. The fake test `Db` aliases the
    same JS object for both the write and the later read, so it couldn't expose the staleness;
    only a real Postgres round trip (a fresh row on each query) did. Fixed in `handlers.ts` by
    updating the in-memory row alongside the DB write.
- Reuse of a consumed token correctly 400s; a fresh request for the same email reuses the same
  user (not a duplicate); the redirect-with-fragment flow produces a real `302` with a valid,
  independently-decodable JWT when `redirect_to` is on the allow-list.

## Scope — what this is not

There's no `verifyOtp({ email, token, type: 'email' })`-style 6-digit-code fallback (Supabase
supports both a clickable link and a typed code from the same email). Only the link is
implemented — adding the code fallback would mean generating and emailing a short numeric code
alongside the link and a matching `POST /magiclink/verify-code` endpoint; the phone-OTP code in
`handlers.ts` (`handleOtpRequest`/`handleOtpVerify`) is the pattern to mirror if that's ever
needed.
