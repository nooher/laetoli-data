# Laetoli Data — backup service. node:22-alpine, arm64-compatible.
# Multi-stage: build TS, then a slim runtime that bundles the Postgres client
# (pg_dump) so scheduled dumps work without any host tooling.

# ---- build ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app

# pg_dump / psql — required for the scheduled dumps. Pin postgresql16-client to
# match the db image major (postgres:16-alpine).
RUN apk add --no-cache postgresql16-client

COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# The backups volume mount point; make it writable by the non-root node user.
RUN mkdir -p /backups && chown -R node:node /backups
VOLUME ["/backups"]

# Drop root.
USER node
EXPOSE 9994
CMD ["node", "dist/server.js"]
