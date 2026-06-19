# CI/CD — Laetoli Data

Laetoli Data is a **multi-package monorepo**: each package (`auth`, `storage`,
`realtime`, `admin`, `functions`, `backup`, `cli`, `client`, `studio`) is fully
self-contained with its own `package.json` and `package-lock.json`. It is **not**
an npm-workspaces repo, so every package installs and builds independently.

## `ci.yml` — runs on every push and pull request

Three jobs:

### 1. `test` (matrix over all 9 packages)
For each package, in its own directory:

```
npm ci → npm run typecheck --if-present → npm test → npm run build --if-present
```

- `actions/setup-node@v4`, **Node 22**, with the npm cache keyed per package via
  `cache-dependency-path: <pkg>/package-lock.json`.
- `fail-fast: false` so every package reports its own result.
- All 9 packages currently have `test`, `typecheck`, and `build` scripts. `build`
  and `typecheck` are guarded with `--if-present` for forward-safety; `test` is
  required (it exists everywhere). Build tooling per package: services use `tsc`,
  `client` uses `tsup`, `studio` uses `tsc -b && vite build`.

### 2. `docker-build` (image smoke)
Copies `.env.example → .env` (compose needs the vars to interpolate), runs
`docker compose config -q` to validate the compose file, then `docker compose
build` to confirm every service image (`auth`, `storage`, `realtime`, `admin`,
`functions`, `backup`, `studio`) builds. `db`, `rest`, and `caddy` are pulled
images.

### 3. `integration` (best-effort end-to-end)
`needs: docker-build`, `continue-on-error: true` (container start timing can be
flaky in CI). Generates throwaway `POSTGRES_PASSWORD` / `JWT_SECRET` /
`ADMIN_API_KEY` with `openssl rand`, runs `docker compose up -d --build`, then
probes each service's `/health` through the Caddy edge on `http://localhost:8088`
(`/auth/health`, `/storage/health`, `/admin/health`, `/functions/health`,
`/realtime/health`, plus PostgREST root `/rest/`) with retry + timeout. Logs are
dumped on failure and the stack + volumes are always torn down (`down -v`).

## `../dependabot.yml`
Weekly, grouped dependency updates: one **npm** entry per package directory (all
9) plus a **github-actions** entry for the workflow action versions.
