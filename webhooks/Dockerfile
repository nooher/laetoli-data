# Laetoli Data — webhooks worker. node:22-alpine, arm64-compatible (pure-JS deps).
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

# Drop root.
USER node
EXPOSE 9993
CMD ["node", "dist/server.js"]
