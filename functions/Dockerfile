# Laetoli Data — functions runner. node:22-alpine, arm64-compatible (pure-JS deps).
# Multi-stage: build TS, then run a slim production image.
#
# Operator-provided functions are NOT baked in — they are mounted read-only at
# /functions (FUNCTIONS_ROOT) from ./functions/src on the host. tsx is kept as a
# runtime dependency so mounted .ts (and .js) functions import natively.

# ---- build ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY server ./server
RUN npm run build

# ---- runtime ----
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# The functions root: operator functions are mounted here read-only.
ENV FUNCTIONS_ROOT=/functions
RUN mkdir -p /functions && chown -R node:node /functions

# Drop root.
USER node
EXPOSE 9995
# `--import tsx/esm` lets mounted .ts functions be imported at runtime.
CMD ["node", "--import", "tsx/esm", "dist/server.js"]
