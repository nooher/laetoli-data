# Observability — Laetoli Data

Every Node service exposes Prometheus-format metrics on its own internal port.
No external dependency is pulled in — each service ships a tiny `metrics.ts`
(counter / gauge / histogram registry) and renders the text exposition format
itself. Endpoints are **internal-only** (on the Docker network, not via Caddy).

## What each service exposes

| Service   | Port  | Endpoint   | Service-specific metric |
|-----------|-------|------------|-------------------------|
| auth      | 9999  | `/metrics` | `auth_tokens_issued_total` (counter) |
| storage   | 9998  | `/metrics` | `storage_objects_served_total` (counter) |
| realtime  | 9997  | `/metrics` | `realtime_active_connections`, `realtime_active_subscriptions` (gauges) |
| backup    | 9994  | `/status`, `/health` (JSON; not Prometheus) | last run / last success / count / total size / next run |

Common metrics on auth / storage / realtime:

- `process_uptime_seconds` — gauge, seconds since process start.
- `http_requests_total{route,status}` — counter, every HTTP request.
- `http_request_duration_seconds{route}` — histogram (`_bucket`/`_sum`/`_count`),
  request latency in seconds.

> The `backup` service reports JSON at `/status` (last run, last success, last
> error, dump count, total bytes, next run) rather than Prometheus text, since a
> daemon with one periodic job is better observed as a status snapshot. Use a
> JSON exporter or a simple blackbox `/health` probe to alert on it.

## Viewing metrics locally

Endpoints aren't published to the host by default. Reach them either by exposing
a port temporarily or via `docker compose exec`:

```bash
# Option A — curl from inside the network (no host port needed):
docker compose exec auth     wget -qO- http://localhost:9999/metrics
docker compose exec storage  wget -qO- http://localhost:9998/metrics
docker compose exec realtime wget -qO- http://localhost:9997/metrics
docker compose exec backup   wget -qO- http://localhost:9994/status

# Option B — temporarily publish a port (add to the service in compose):
#   ports: ["9999:9999"]
# then: curl http://localhost:9999/metrics
```

## Sample `prometheus.yml`

Run Prometheus on the same Docker network (e.g. add a `prometheus` service to
the compose file, or `--network laetoli-data_default`) so it can resolve the
service names:

```yaml
global:
  scrape_interval: 30s

scrape_configs:
  - job_name: laetoli-auth
    metrics_path: /metrics
    static_configs:
      - targets: ['auth:9999']

  - job_name: laetoli-storage
    metrics_path: /metrics
    static_configs:
      - targets: ['storage:9998']

  - job_name: laetoli-realtime
    metrics_path: /metrics
    static_configs:
      - targets: ['realtime:9997']

  # The backup service serves JSON at /status, not Prometheus text. Scrape its
  # liveness here; use a json_exporter or blackbox_exporter for the /status body.
  - job_name: laetoli-backup-health
    metrics_path: /health
    static_configs:
      - targets: ['backup:9994']
```

## Notes

- **Keep `/metrics` internal.** It is not authenticated and is not proxied
  through Caddy. If you must reach it from outside, put it behind the edge with
  auth or an allow-list — don't expose it raw on the internet.
- Route labels are collapsed to a fixed, low-cardinality set (`/health`,
  `/metrics`, the known API routes, and `other`) so the time series count stays
  bounded regardless of traffic shape.
