# The worked example — Daftari

Laetoli Data ships with one **complete, real app** so you can learn the platform
by building, not by reading API tables. It is the spine of the companion book:
*"build a real app on your sovereign Laetoli Data node."*

> **Where the code lives:** [`examples/daftari/`](../examples/daftari/) — start
> with its [README](../examples/daftari/README.md), which is the step-by-step the
> book mirrors.

## What it is

**Daftari** (*"notebook"*) is a personal notes/tasks app in plain Vite +
TypeScript (~300 lines, no framework, one runtime dependency: the
[`@laetoli/data`](../client/README.md) SDK). It runs entirely against a node you
own — a local Docker stack, a VPS, or a Raspberry Pi with no internet.

## What it demonstrates

| Capability | How Daftari shows it |
|---|---|
| **Auth** | username+password sign-up / sign-in / sign-out; the session resumes on reload (`db.auth.*`). |
| **RLS** | the app never sends a `user_id`. Each note's owner is set by the node from the verified JWT (`auth.uid()`), and the policies in [`schema.sql`](../examples/daftari/schema.sql) limit every read/write to the owner. Two users share one table and never see each other's rows. |
| **CRUD** | create / list / toggle-done / delete over the auto REST API (`db.from('daftari_notes')`). |
| **Storage** | attach an image → uploaded to a **private** bucket under the user's prefix; the card reads it back through a 5-minute **signed URL**; deleting the note removes the object. |
| **Realtime** | `db.channel('daftari_notes').on('*', …).subscribe()` updates the list live. Fan-out is **owner-aware** (the table has a `user_id` column), so the node only streams a row to the subscriber who owns it. |

These map one-to-one to the platform pieces described in the
[root README](../README.md) and exercised by the smoke test
[`examples/poc.mjs`](../examples/poc.mjs).

## The three steps

1. **Apply the schema** — [`examples/daftari/schema.sql`](../examples/daftari/schema.sql)
   creates the table, the own-rows-only RLS policies, and calls
   `realtime.enable('public.daftari_notes')`. It mirrors the canonical RLS
   template in [`db/init/03_example.sql`](../db/init/03_example.sql), so the
   pattern transfers to any owner-scoped table you add later.
2. **Point the SDK at your node** — set `VITE_LAETOLI_DATA_URL` and call
   `createClient(url)`. That single line is the entire "connect to the backend"
   step ([`src/db.ts`](../examples/daftari/src/db.ts)).
3. **Seed and run** — `npm run seed` (a demo user + a few notes, created through
   the SDK) then `npm run dev`.

## Verifying without a node

The app type-checks and builds offline (`npm run typecheck`, `npm run build`),
so the *code* can be validated in CI or while reading the book on a plane.
Actually running it — and the seed script — needs a live node:

- Local: `docker compose up -d` (or `node cli/dist/index.js up`).
- Edge: [`docs/PI_SETUP.md`](PI_SETUP.md) + [`RASPBERRY_PI.md`](../RASPBERRY_PI.md).
- Production: [`DEPLOY.md`](../DEPLOY.md).

## Related

- [`docs/RUNBOOK.md`](RUNBOOK.md) — operating the node the app runs against.
- [`SECURITY.md`](../SECURITY.md) — RLS audit, CORS lockdown, the service-role key.
- [`docs/STORAGE-TRANSFORMS.md`](STORAGE-TRANSFORMS.md) — on-the-fly image
  resizing for the attachments Daftari uploads.

---

Apache-2.0 · © 2026 Laetoli Ltd · part of the Laetoli sovereign stack.
