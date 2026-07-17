# OAuth — Google sign-in

Laetoli Data's auth service supports "Sign in with Google" via the standard OAuth 2.0
Authorization Code flow, wired to match `supabase-js`'s `signInWithOAuth({ provider })` UX
closely enough that a client already built against Supabase needs minimal changes.

## Flow

```
browser → GET /oauth/google/start?redirect_to=<app-page>
        → 302 to accounts.google.com (with a signed, stateless `state`)
user consents on Google
        → 302 back to GET /oauth/google/callback?code=...&state=...
auth service exchanges code for tokens at Google, decodes the id_token
        → finds-or-creates the local user + oauth identity
        → 302 to <app-page>#access_token=...&refresh_token=...&token_type=bearer&expires_in=...
browser lands back on the app; the SDK's detectSessionInUrl() adopts the session automatically
```

No server-side session/state storage is used for the CSRF `state` parameter — it's an
HMAC-SHA256-signed, 10-minute-TTL token (`auth/src/oauth.ts`: `signState`/`verifyState`)
embedding `redirect_to`, so a single stateless auth-service instance handles the round trip with
no shared cache or sticky sessions required.

## Config (all three required to enable the route)

```bash
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=https://your-auth-host/oauth/google/callback   # must match the Google Cloud console entry exactly
OAUTH_ALLOWED_REDIRECT_ORIGINS_REGEXP=^https://app\.example\.tz$   # fail-closed allow-list for redirect_to
```

If only some of the three Google values are set, the service still starts (never crashes on a
partial config) but `/oauth/google/*` returns `503` until all three are present — see
`auth/src/server.ts`.

`OAUTH_ALLOWED_REDIRECT_ORIGINS_REGEXP` is **fail-closed**: unlike CORS's typical fail-open
default, any `redirect_to` that doesn't match the configured regexp is rejected with `400` before
Google is ever involved (`auth/src/oauth.ts`: `isAllowedRedirect`). Set it to match your app's
real origin(s).

## From the SDK

```ts
import { createClient } from '@laetoli/data';
const db = createClient(URL, { apikey: ANON });

// Redirects the browser to Google. Lands back on the current page (or
// options.redirectTo) with the session already adopted.
db.auth.signInWithOAuth({ provider: 'google' });

// Get the URL without navigating (e.g. to render your own "Continue with
// Google" button instead of redirecting immediately):
const { data } = db.auth.signInWithOAuth({
  provider: 'google',
  options: { redirectTo: 'https://app.example.tz/callback', skipBrowserRedirect: true },
});
// data.url -> navigate there yourself when the user clicks
```

On the callback page, no extra code is needed — the `AuthClient` constructor calls
`detectSessionInUrl()`, which reads `#access_token=...` off `window.location.hash`, persists it,
strips the fragment via `history.replaceState`, and fires the same `SIGNED_IN` event as a
password login.

## Identity model — matched by (provider, provider_user_id), never by email

`auth.oauth_identities` is keyed `UNIQUE(provider, provider_user_id)`. A Google sign-in is matched
to an existing local account **only** by that pair. A pre-existing password account that happens
to share an email with a Google account is **not** silently merged into — Google sign-in creates
a brand-new user in that case. This is deliberate: matching by email would let anyone who
registers `victim@example.com`'s email with Google take over a pre-existing password account with
the same address. See `auth/src/__tests__/oauthHandlers.test.ts` for the explicit test proving
this.

## What's verified live (not just unit-tested)

- `GET /oauth/google/start` against a running Docker container produces a real `302` to
  `https://accounts.google.com/o/oauth2/v2/auth` with correctly-encoded `client_id`,
  `redirect_uri`, `scope`, and a signed `state` — confirmed byte-for-byte against Google's real
  endpoint, not a mock.
- `GET /oauth/google/callback` with a deliberately invalid `code` makes a **real** network call to
  Google's real token endpoint (`https://oauth2.googleapis.com/token`) and handles Google's
  real rejection cleanly — `400`, a clean JSON error body, no crash or hang.
- The token-exchange → id_token decode → user/identity creation → session issuance path (the part
  that needs a *successful* Google response) is covered by handler-level tests with an injectable
  `fetch` (`oauthFetch` in `HandlerDeps`), since that requires real Google Cloud credentials this
  environment doesn't have. This is the honest achievable verification ceiling without an operator
  supplying real credentials — see `auth/src/__tests__/oauthHandlers.test.ts`.

## Scope — what this is not

Only Google is implemented. Adding another provider (GitHub, Apple, etc.) means a new
`buildXAuthUrl`/token-exchange pair in `oauth.ts` plus a new `/oauth/<provider>/start|callback`
route pair — the `state` signing, redirect allow-list, and identity-linking model are already
provider-agnostic and don't need to change.
