# =============================================================================
# Laetoli Data — Admin Studio (static SPA)
# Multi-stage: build the Vite app, then serve dist/ with Caddy on :80.
# The app is built with base '/studio/', so it lives behind the edge Caddy at
# /studio/*. This inner Caddy does SPA fallback (any unknown sub-path -> index).
# =============================================================================

# ---- build ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci 2>/dev/null || npm install
COPY . .
RUN npm run build

# ---- serve ----
FROM caddy:2-alpine
# Static files are served from /srv/studio so paths line up with the /studio/ base.
COPY --from=build /app/dist /srv/studio
COPY Caddyfile /etc/caddy/Caddyfile
EXPOSE 80
