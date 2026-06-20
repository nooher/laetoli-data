# Examples

Runnable code that uses the [`@laetoli/data`](../client/README.md) SDK against a
live Laetoli Data node, exactly as a real developer would.

| Example | What it is |
|---|---|
| **[`daftari/`](daftari/)** | The **worked example** — a small, complete notes/tasks app (plain Vite + TypeScript) demonstrating **auth + RLS + CRUD + private-bucket storage with signed URLs + owner-aware realtime**. This is the app the companion book builds. Start with its [README](daftari/README.md). |
| [`poc.mjs`](poc.mjs) | A one-file smoke test: sign up → insert a note → read it back (RLS-scoped) → sign out → confirm RLS blocks anon. Run `node examples/poc.mjs` against a live node. |

All examples need a **running node** (see the repo [README](../README.md)
Quick start). Daftari additionally type-checks and builds offline — handy in CI:

```bash
cd examples/daftari && npm install && npm run typecheck && npm run build
```

Apache-2.0 · © 2026 Laetoli Ltd · part of the Laetoli sovereign stack.
