# Laetoli Data — storage service. node:22-alpine, arm64-compatible (pure-JS deps).
# Multi-stage: build TS, then run a slim production image.

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
