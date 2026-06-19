# Database Webhooks

**Row change → HTTP POST.** Register a webhook in Laetoli Data and every time a
row changes on a chosen table, the **webhooks worker** (`webhooks/`, `:9993`)
POSTs the change to your URL — HMAC-signed, with retries and a delivery log.

It reuses the *same* Postgres `LISTEN/NOTIFY` stream that powers realtime (the
`realtime.notify()` trigger on channel `laetoli_realtime`). There is **no
per-row polling**: a change fires a NOTIFY, the worker matches registered
endpoints, and delivers. This is the classic backend-automation primitive —
e.g. "when an `orders` row is inserted, call an edge function" or "ping an
external service whenever a profile changes".

```
  INSERT/UPDATE/DELETE on an enabled table
        │  (realtime.notify trigger → pg_notify 'laetoli_realtime')
        ▼
  webhooks worker  ── LISTEN laetoli_realtime ──┐
        │  match active webhooks.endpoints (table + event)
        ▼
  POST {schema,table,type,record,old}  ──►  your URL
        │  X-Laetoli-Signature: sha256=<hmac>   (when secret set)
        │  retry 3× with backoff on 5xx/429/network error
        ▼
  webhooks.deliveries  ◄── one row per delivery (final outcome + attempt count)
```

## 1. Enable + register

A table only emits changes once realtime is enabled on it (shared trigger), then
you register an endpoint. Both are SQL — run via the Admin Studio SQL Console,
`psql`, or the admin API's SQL endpoint.

```sql
-- (a) make the table emit row-change NOTIFYs (idempotent; shared with realtime)
SELECT realtime.enable('public.orders');

-- (b) register a webhook
INSERT INTO webhooks.endpoints (name, table_name, events, url, secret)
VALUES (
  'notify-orders',
  'public.orders',                 -- bare 'orders' or qualified 'public.orders'
  '{INSERT,UPDATE}',               -- any subset of {INSERT,UPDATE,DELETE}
  'https://example.com/hooks/orders',
  'a-long-random-shared-secret'    -- optional; enables HMAC signing
);
```

> **Management note.** The `webhooks` schema is **not** exposed through PostgREST
> by default (it is not in `PGRST_DB_SCHEMAS`), so endpoints are managed by SQL /
> the admin service — not via `client.from(...)`. This is deliberate: the
> `secret` column should never be reachable over the public REST API. To manage
> endpoints over HTTP, use the admin service (connects as `laetoli_admin_login`,
> gated by `ADMIN_API_KEY`) and run the SQL above through its SQL console.

Columns of `webhooks.endpoints`:

| column       | meaning |
|--------------|---------|
| `table_name` | watched table — bare `notes` or qualified `public.notes` |
| `events`     | subset of `{INSERT,UPDATE,DELETE}` to fire on |
| `url`        | HTTP(S) destination |
| `secret`     | optional HMAC-SHA256 signing key |
| `active`     | soft on/off; inactive endpoints are skipped |

## 2. The payload

The worker POSTs JSON — the same shape as the realtime change frame:

```json
{
  "schema": "public",
  "table": "orders",
  "type": "INSERT",
  "record": { "id": 42, "total": 1500, "status": "new" },
  "old": null
}
```

- `record` is the new row (`INSERT`/`UPDATE`) or `null` (`DELETE`).
- `old` is the previous row (`UPDATE`/`DELETE`) or `null` (`INSERT`).
- `"truncated": true` may appear when the row exceeded Postgres' 8000-byte NOTIFY
  cap; in that case `record`/`old` carry only the `id` (re-fetch over PostgREST).

Headers sent with every delivery:

| header | value |
|--------|-------|
| `Content-Type` | `application/json` |
| `X-Laetoli-Event` | `INSERT` / `UPDATE` / `DELETE` |
| `X-Laetoli-Table` | `schema.table` |
| `X-Laetoli-Delivery-Endpoint` | the endpoint `id` |
| `X-Laetoli-Signature` | `sha256=<hex>` — only when `secret` is set |

## 3. Verify the signature

When the endpoint has a `secret`, the worker signs the **raw request body** with
HMAC-SHA256 and sends `X-Laetoli-Signature: sha256=<hex>`. Verify on the
**raw bytes** before parsing JSON. Node receiver:

```js
import crypto from 'node:crypto';

function verify(rawBody, header, secret) {
  const expected = 'sha256=' + crypto.createHmac('sha256', secret)
    .update(rawBody).digest('hex');
  const a = Buffer.from(header ?? '');
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// express, with the raw body captured:
app.post('/hooks/orders', express.raw({ type: 'application/json' }), (req, res) => {
  if (!verify(req.body, req.get('X-Laetoli-Signature'), process.env.WEBHOOK_SECRET)) {
    return res.status(401).end();
  }
  const change = JSON.parse(req.body.toString());
  // ... handle change.record / change.old ...
  res.status(200).end();
});
```

## 4. Retries + the deliveries log

Each delivery is attempted up to **3 times** (configurable via
`WEBHOOKS_MAX_ATTEMPTS`) with exponential backoff (`WEBHOOKS_BACKOFF_MS`, default
500ms → 1000ms → …). Every request has a hard timeout
(`WEBHOOKS_TIMEOUT_MS`, default 10s) so a dead URL can never hang the worker.

Retry decision:

- **2xx** → success, stop.
- **5xx / 429 / network error / timeout** → retryable, back off and retry.
- **other 4xx** → client rejected it; not retryable, stop.

The **final outcome** of each delivery is recorded as one row in
`webhooks.deliveries`:

```sql
SELECT created_at, event, status_code, ok, attempts, error
  FROM webhooks.deliveries
 WHERE endpoint_id = '<id>'
 ORDER BY created_at DESC
 LIMIT 20;
```

| column | meaning |
|--------|---------|
| `status_code` | HTTP status of the final attempt (`NULL` on network/timeout) |
| `ok` | `true` when the final attempt was 2xx |
| `attempts` | total attempts made (1..max) |
| `error` | error of the final failing attempt (`NULL` when ok) |
| `payload` | the JSON body that was POSTed |

## 5. Health + status

The worker exposes (internal; behind Caddy at `/webhooks/*` if proxied):

- `GET /health` → `{ status, service, listening }` — `listening` is the LISTEN
  connection state.
- `GET /status` → adds `{ deliveries: { total, ok }, lastDelivery }`.

## 6. Worked example — webhook → a Laetoli Data edge function

Drop an edge function that receives the change (verifies the signature, then
acts on it):

`functions/src/order-created/index.js`

```js
import crypto from 'node:crypto';

export default async function (req) {
  const raw = await req.text();
  const sig = req.headers.get('x-laetoli-signature');
  const expected = 'sha256=' + crypto
    .createHmac('sha256', process.env.WEBHOOK_SECRET ?? '')
    .update(raw).digest('hex');
  if (sig !== expected) return new Response('unauthorized', { status: 401 });

  const change = JSON.parse(raw);
  // e.g. notify, enqueue, fan out, write an audit row...
  console.log('order created:', change.record?.id);
  return new Response('ok');
}
```

Register the webhook to point at it (functions are served at `/functions/<name>`;
the worker reaches it over the internal network at `http://functions:9995`):

```sql
SELECT realtime.enable('public.orders');

INSERT INTO webhooks.endpoints (name, table_name, events, url, secret)
VALUES (
  'orders-to-function',
  'public.orders',
  '{INSERT}',
  'http://functions:9995/order-created',
  'a-long-random-shared-secret'
);
```

Now `INSERT INTO orders ...` → NOTIFY → worker matches the endpoint → POSTs the
change to the edge function with a valid HMAC → a `webhooks.deliveries` row is
written with `ok = true`.

## Configuration

| env | default | meaning |
|-----|---------|---------|
| `WEBHOOKS_PORT` | `9993` | HTTP port (`/health`, `/status`) |
| `WEBHOOKS_CHANNEL` | `laetoli_realtime` | NOTIFY channel to LISTEN on |
| `WEBHOOKS_MAX_ATTEMPTS` | `3` | max delivery attempts |
| `WEBHOOKS_BACKOFF_MS` | `500` | base backoff, doubled per retry |
| `WEBHOOKS_TIMEOUT_MS` | `10000` | per-request fetch timeout |
| `DATABASE_URL` | — | connect AS `laetoli_webhooks` (or `POSTGRES_*` parts) |

The worker connects to Postgres as the dedicated, minimally-privileged
`laetoli_webhooks` LOGIN role: `SELECT` on `webhooks.endpoints` and `INSERT` on
`webhooks.deliveries`, nothing more.
