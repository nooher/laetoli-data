# Daftari — a real app on Laetoli Data

**Daftari** (*"notebook"* in Swahili) is the worked example for Laetoli Data: a
small, complete app that a developer builds on their **own sovereign node** — no
SaaS, no internet required. The companion book walks through this exact code.

In ~300 lines of plain Vite + TypeScript it exercises the whole stack through the
[`@laetoli/data`](../../client) SDK:

| Capability | Where it shows up |
|---|---|
| **Auth** | sign up / sign in / sign out (`db.auth.*`), session resumes on reload |
| **RLS** | every note is scoped to the signed-in user — the app never sends a `user_id`; the node derives it from the JWT |
| **CRUD** | create / list / toggle / delete notes over the auto REST API (`db.from('daftari_notes')`) |
| **Storage** | attach an image to a note → upload to a **private** bucket, read it back via a short-lived **signed URL** |
| **Realtime** | the note list updates **live** as rows change (this tab or another device) |

No framework, two dev dependencies (`vite`, `typescript`), and one runtime
dependency: the SDK. That is the point — the teaching is about Laetoli Data, not
about React.

---

## What you need

A **running Laetoli Data node** reachable over HTTP. Locally that is the repo's
Docker stack; on a Pi or VPS it is your deployed node (see
[`docs/PI_SETUP.md`](../../docs/PI_SETUP.md) and [`DEPLOY.md`](../../DEPLOY.md)).

```bash
# from the repo root — bring up Postgres + PostgREST + Auth + Storage + Realtime + Caddy
cp .env.example .env          # set POSTGRES_PASSWORD + JWT_SECRET + ADMIN_API_KEY
docker compose up -d          # or: node cli/dist/index.js up
```

The node's public endpoint defaults to `http://localhost:8088`.

> A fresh boot already includes the realtime migration, so
> `realtime.enable(...)` works the moment you apply the schema below.

---

## Step 1 — apply the schema

Create the `daftari_notes` table, its RLS policies (own-rows-only), and turn on
realtime for it. Either via `psql`:

```bash
psql "postgres://laetoli:$POSTGRES_PASSWORD@localhost:5432/laetoli" \
  -f examples/daftari/schema.sql
```

…or paste [`schema.sql`](./schema.sql) into the **Admin Studio** SQL Console at
`http://localhost:8088/studio/` (sign in with your `ADMIN_API_KEY`).

The file is idempotent — re-running it is safe. It mirrors the canonical RLS
template in [`db/init/03_example.sql`](../../db/init/03_example.sql), so once you
understand `daftari_notes` you understand every owner-scoped table.

## Step 2 — point the SDK at your node

```bash
cd examples/daftari
cp .env.example .env.local        # edit if your node isn't on localhost:8088
npm install
```

`.env.local`:

```
VITE_LAETOLI_DATA_URL=http://localhost:8088
VITE_LAETOLI_ANON_KEY=            # only if your node enforces an anon apikey
```

That URL is the *entire* "connect to the backend" step — see
[`src/db.ts`](./src/db.ts):

```ts
import { createClient } from '@laetoli/data';
export const db = createClient(import.meta.env.VITE_LAETOLI_DATA_URL);
```

## Step 3 — seed some data (optional)

Creates a demo user (`daftari_demo` / `Habari123!`), ensures the private
`daftari` storage bucket exists, and inserts a few notes — all through the SDK,
exactly as the app does:

```bash
LAETOLI_DATA_URL=http://localhost:8088 npm run seed
```

## Step 4 — run it

```bash
npm run dev      # http://localhost:5180
```

Sign in as `daftari_demo` / `Habari123!` (or create your own account) and you
will see the seeded notes.

---

## See RLS, storage, and realtime for real

**RLS — each user sees only their own notes.**
Open the app in one browser and create a note as user **A**. In a *private /
incognito* window, create account **B**. Neither sees the other's notes — yet
both read and write the *same* `daftari_notes` table. You wrote **zero**
filtering code: the policies in `schema.sql` (`auth.uid() = user_id`) enforce it
at the database, and the SDK attaches each user's JWT automatically.

**Storage — private bytes, signed reads.**
Attach an image when adding a note. It is `PUT` to the **private** `daftari`
bucket under your `user_id/…` prefix. The bytes are *not* publicly reachable;
the card loads the image through a `createSignedUrl(path, 300)` URL that expires
in 5 minutes. Delete the note and the object is removed too.

**Realtime — the list updates live.**
With the app open in two tabs (same user), add or complete a note in one — it
appears in the other within a beat, no refresh. Fan-out is **owner-aware**: the
node only streams a row to the subscriber whose JWT `sub` owns it (see
[`db/migrations/0002_realtime.sql`](../../db/migrations/0002_realtime.sql)). The
"● live" badge in the header shows the socket is connected.

---

## How the pieces map to the SDK

```ts
// AUTH
await db.auth.signUp({ username, password });
await db.auth.signInWithPassword({ username, password });
await db.auth.signOut();

// CRUD (RLS-scoped — no user_id ever sent)
await db.from('daftari_notes').insert({ title, body }).select().single();
await db.from('daftari_notes').select('*').order('created_at', { ascending: false });
await db.from('daftari_notes').update({ done: true }).eq('id', id);
await db.from('daftari_notes').delete().eq('id', id);

// STORAGE (private bucket + signed URL)
await db.storage.createBucket('daftari', { public: false });
await db.storage.from('daftari').upload(path, file, { contentType: file.type });
const { data } = await db.storage.from('daftari').createSignedUrl(path, 300);

// REALTIME (owner-aware live updates)
db.channel('daftari_notes')
  .on('*', (change) => applyChange(change), { column: 'user_id', value: userId })
  .subscribe();
```

---

## Files

| File | What it teaches |
|---|---|
| [`schema.sql`](./schema.sql) | the table + RLS policies + `realtime.enable` |
| [`seed.mjs`](./seed.mjs) | seeding via the SDK (auth → bucket → insert) |
| [`src/db.ts`](./src/db.ts) | creating the client (the one connect step) |
| [`src/main.ts`](./src/main.ts) | the whole app: auth, CRUD, storage, realtime |
| [`src/style.css`](./src/style.css) | solid-fill UI, phone-first |

## Verify the code (no node required)

The app type-checks and builds without a running backend — useful in CI or when
following the book offline:

```bash
npm run typecheck
npm run build
```

(Running the app and the seed script *do* need a live node.)

---

Apache-2.0 · © 2026 Laetoli Ltd · part of the Laetoli sovereign stack.
