# @laetoli/data

**Client SDK ya Laetoli Data — kibadala cha karibu-cha-moja-kwa-moja kwa sehemu ya Supabase JS tunayotumia.**
*Near drop-in replacement for the subset of the Supabase JS client used across Laetoli apps.*

Zero runtime dependencies. Pure `fetch`. Browser + Node 18+. Apache-2.0.

It talks to a single Laetoli Data endpoint (Caddy) that routes:
- `/rest/*` → **PostgREST** (auto REST API over PostgreSQL)
- `/auth/*` → the sovereign **auth** service (HS256 JWT)

---

## Usage / Matumizi

```ts
import { createClient } from '@laetoli/data';

// Point at your Laetoli Data endpoint (VPS or a Raspberry Pi).
const db = createClient('https://data.yangu.tz', {
  apikey: 'optional-anon-key', // sent as `apikey` + used as the anon bearer
});
```

### Query / Hoji (`.from`)

```ts
// SELECT with filters, ordering, limit
const { data, error } = await db
  .from('works')
  .select('id, title, author_id')
  .eq('type', 'pulse')
  .order('created_at', { ascending: false })
  .limit(20);

// One row
const { data: work } = await db.from('works').select('*').eq('id', id).single();
// or .maybeSingle() — returns null (no error) when nothing matches

// INSERT (returns the inserted rows)
const { data: created } = await db
  .from('communities')
  .insert({ name: 'Waandishi', emoji: '📚' })
  .select('id')
  .single();

// UPDATE
await db.from('profiles').update({ avatar_url: url }).eq('id', userId);

// DELETE
await db.from('follows').delete().eq('follower_id', me).eq('following_id', them);
```

Supported filters: `eq, neq, gt, gte, lt, lte, like, ilike, is, in`.
Shaping: `select, order, limit, range, single, maybeSingle`.

### Auth / Uthibitishaji (`.auth`)

```ts
// Sign up / Jisajili  (username + password)
await db.auth.signUp({ username: 'naim', password: 'siri-ndefu' });

// Sign in / Ingia
await db.auth.signInWithPassword({ username: 'naim', password: 'siri-ndefu' });

// Anonymous / Bila jina
await db.auth.signInAnonymously();

// Current user / Mtumiaji wa sasa
const { data: { user } } = await db.auth.getUser();

// Sign out / Toka
await db.auth.signOut();

// React to auth changes / Fuatilia mabadiliko
const { data: { subscription } } = db.auth.onAuthStateChange((event, session) => {
  console.log(event, session?.user?.id);
});
// subscription.unsubscribe();
```

The access token is persisted (default key `laetoli-data:token`) in `localStorage`
when in a browser, and in an in-memory store otherwise (Node / SSR / private mode).
Once signed in, **every `.from()` request automatically carries
`Authorization: Bearer <token>`**, so PostgREST RLS sees the user's `sub` + `role`.

---

## Drop-in for the Supabase subset / Migration notes

This SDK mirrors the exact methods our apps already call, so most migrations are a
one-line import swap:

```diff
- import { createClient } from '@supabase/supabase-js';
+ import { createClient } from '@laetoli/data';

- const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
+ const supabase = createClient(LAETOLI_DATA_URL, { apikey: ANON_KEY });
```

Same shapes preserved:
- `from(t).select/insert/update/delete/eq/neq/order/limit/single/maybeSingle` → `{ data, error }`
- `auth.signUp / signInWithPassword / signInAnonymously / getUser / signOut / onAuthStateChange`
- error envelope `{ data, error, status, statusText }`

Differences to note when porting:
- **Auth identity is `username`, not `email`.** Supabase calls take `{ email, password }`;
  here they take `{ username, password }`. Map your handle/email field accordingly.
- Email-link / OAuth / OTP flows (`signInWithOtp`, `signInWithOAuth`, `updateUser`)
  are **not** part of this sovereign subset — the auth service is username+password+anonymous.
- `select('*', { count: 'exact', head: true })` count mode and advanced filters
  (`not`, `or`, full-text) are not yet implemented — add as apps need them.
- RLS migrations port directly: the JWT carries `{ sub, role }`, the same model as Supabase.

---

Apache-2.0 · © 2026 Laetoli Ltd · part of the Laetoli sovereign stack.
