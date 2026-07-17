# Laetoli Data — Postgres 16 + pgvector (AI-native vector search) + PostGIS
# (geo/location queries — provider-near-me search, delivery zones, any
# location-aware Laetoli product; THOS specifically needs this to migrate off
# Supabase, since its schema uses geography columns + PostGIS distance RPCs).
#
# Built on top of pgvector/pgvector:pg16 rather than the official
# postgis/postgis image so BOTH extensions ship in one image, multi-arch
# (amd64 + arm64 — this project's base image already publishes arm64 builds
# for Pi 4/5; postgis/postgis's official builds don't reliably do the same).
# pgvector/pgvector:pg16 is itself built on the official postgres:16 image, so
# the PGDG apt repo (where postgresql-16-postgis-3 lives) is already
# configured — no extra repo setup needed here.
FROM pgvector/pgvector:pg16

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       postgresql-16-postgis-3 \
       postgresql-16-postgis-3-scripts \
  && rm -rf /var/lib/apt/lists/*
