# Laetoli Data — storage service. node:22-alpine, multi-arch (x64 + arm64).
# Multi-stage: build TS, then run a slim production image.
#
# sharp (image transforms) ships prebuilt musl binaries via its optional
# @img/sharp-linuxmusl-{x64,arm64} packages, so `npm install` pulls the right
# native binary per build arch — no apk build deps required on node:22-alpine.
# If a future sharp release drops a prebuild for your arch, add build deps:
#   RUN apk add --no-cache vips-dev build-base python3
# and set SHARP_IGNORE_GLOBAL_LIBVIPS / rebuild from source.

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
COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Object bytes live here; mount a volume at this path (see docker-compose.yml).
ENV STORAGE_ROOT=/data/storage
RUN mkdir -p /data/storage && chown -R node:node /data

# Drop root.
USER node
EXPOSE 9998
CMD ["node", "dist/server.js"]
