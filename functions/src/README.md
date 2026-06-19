# Laetoli Data — Functions

This folder is the **functions root** (`FUNCTIONS_ROOT`, mounted read-only into
the runner at `/functions`). Every `.ts` / `.js` file here becomes an HTTP
endpoint served behind Caddy at `/functions/<name>`.

> **Trust model:** functions are **operator-provided and trusted** — they run
> in the same Node process as the runner (no sandbox). Only deploy code you
> wrote or audited. Stronger isolation (Deno / V8 isolates / a worker pool) is a
> planned v2 option; today the guarantee is a per-invocation **timeout** and
> request **body-size cap**, not isolation.

## Writing a function

A function **default-exports** an async handler. It receives a `ctx` and returns
either a Response-like object or a plain JSON-serializable value.

```ts
// hello.ts  ->  GET /functions/hello?jina=Asha
export default async function hello(ctx) {
  const jina = typeof ctx.query.jina === 'string' ? ctx.query.jina : 'Dunia';
  return { message: 'Habari, ' + jina };   // bare value -> 200 application/json
}
```

```ts
// whoami.ts  ->  GET /functions/whoami  (needs a valid Bearer token)
export default async function whoami(ctx) {
  if (!ctx.user) return { status: 401, body: { error: 'Hujaingia.' } };
  return ctx.user;                          // { sub, role }
}
```

### Layout

A function `foo` can be either:

```
functions/src/foo.ts            (or .js, .mjs, .cjs)
functions/src/foo/index.ts      (or .js, .mjs, .cjs)
```

Names must match `[A-Za-z0-9_-]+` (no slashes, no `..`).

## The context (`ctx`)

| field        | description                                                        |
|--------------|--------------------------------------------------------------------|
| `ctx.method` | HTTP method (`GET`, `POST`, …)                                     |
| `ctx.headers`| lower-cased request headers                                        |
| `ctx.query`  | parsed query string (`{ jina: 'Asha' }`)                          |
| `ctx.body`   | parsed JSON body (or raw text for non-JSON)                        |
| `ctx.env`    | environment bag (`ctx.env.MY_SETTING`)                            |
| `ctx.user`   | `{ sub, role }` if a valid `Authorization: Bearer` is present, else `null` |
| `ctx.path`   | trailing path after `/<name>` (e.g. `/a/b` for `/foo/a/b`), or `""` |
| `ctx.signal` | an `AbortSignal` that fires when the timeout is reached            |

For editor types, optionally:

```ts
import type { FunctionContext, FunctionResult } from '@laetoli/functions';
export default async function (ctx: FunctionContext): Promise<FunctionResult> { … }
```

## Return shapes

- **Bare JSON value** (`object`, `array`, `string`, `number`, …) → `200` JSON.
- **`{ status?, headers?, body }`** → that exact status/headers/body.
  - `body` that is a string/Buffer is sent verbatim; objects/arrays are JSON.
- **`undefined`** → `204 No Content`.

## Auth

Auth is **optional** — the runner never rejects an unauthenticated request; the
function decides. When `JWT_SECRET` is configured (same value as the auth
service), a valid HS256 Bearer token populates `ctx.user`. Otherwise `ctx.user`
is `null`.

## Routes

| route                          | behaviour                              |
|--------------------------------|----------------------------------------|
| `ALL /functions/<name>`        | invoke `<name>`                        |
| `ALL /functions/<name>/*`      | invoke `<name>` (rest in `ctx.path`)   |
| `GET /functions/`              | list available functions               |
| `GET /functions/health`        | `{ ok, functions: [...] }`             |
| `POST /functions/_reload`      | clear the module cache (or `?name=x`)  |
| `?reload=1`                    | clear+reload this one function         |

## Behaviour notes

- Modules are **lazy-loaded and cached** on first request. Edit a file and hit
  `?reload=1` (or `POST /functions/_reload`) to pick up changes without a restart.
- A handler that exceeds `FUNCTION_TIMEOUT_MS` (default 10000) gets a `504`.
- A handler that throws gets a clean `500` (the stack is hidden in production).
