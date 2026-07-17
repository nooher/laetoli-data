# Geo — location storage & radius search

Laetoli Data ships **first-class geo/location queries** via [PostGIS](https://postgis.net/),
inside the same sovereign Postgres that already holds your tables, auth, and
storage. Store coordinates, run radius/"near me" search, and keep everything on
your own VPS — or a Raspberry Pi. This is the sovereign equivalent of Supabase's
PostGIS support, and it's what unblocks migrating a location-aware app (a
provider directory, a delivery-zone lookup, a facility finder) off Supabase.

---

## 1. Prerequisite: the PostGIS-enabled database image

The `postgis` extension is **not** in the stock `pgvector/pgvector:pg16` image.
This project ships its own `db/Dockerfile`, which layers PostGIS on top of that
image (both extensions, one image, still multi-arch incl. arm64 for the Pi):

```yaml
# docker-compose.yml — db service
    build:
      context: ./db
      dockerfile: Dockerfile
    image: laetoli-data-db:pg16-postgis
```

This is the default in this repo's `docker-compose.yml` already — `docker
compose up` builds it automatically. On a **fresh** volume, `db/init/12_geo.sql`
then runs automatically. On an **existing** database, apply the migration:

```bash
laetoli-data migrate              # runs db/migrations/0012_postgis.sql
# or: psql "$DATABASE_URL" -f db/migrations/0012_postgis.sql
```

---

## 2. The `places` table

`db/migrations/0012_postgis.sql` creates a template location store:

| column       | type                     | notes                                            |
|--------------|--------------------------|---------------------------------------------------|
| `id`         | `uuid` PK                | `gen_random_uuid()`                                |
| `owner`      | `uuid`                   | defaults to `auth.uid()` — clients can't spoof it  |
| `name`       | `text`                   | required                                           |
| `category`   | `text`                   | optional, used as an exact-match filter            |
| `location`   | `geography(Point, 4326)` | WGS84 lon/lat — insert with `ST_MakePoint(lng, lat)::geography` |
| `metadata`   | `jsonb`                  | free-form tags (`{}` default)                      |
| `created_at` | `timestamptz`            | `now()`                                            |

### Row-Level Security (owner-scoped by default)

`places` mirrors the `documents` template (`0005_vectors.sql`): RLS confines
every row to its owner. A signed-in user can only `SELECT/INSERT/UPDATE/DELETE`
rows where `auth.uid() = owner`. `anon` gets no access.

**This is a template default, not the only shape.** A provider/facility
directory is usually **world-readable** (anyone can search it) with
**owner-scoped writes** (only the provider edits their own listing) — exactly
the pattern THOS's own `providers_read` / `providers_self_write` Supabase
policies use today. To switch to that shape:

```sql
DROP POLICY IF EXISTS places_select_own ON public.places;
CREATE POLICY places_read ON public.places FOR SELECT USING (true);
GRANT SELECT ON public.places TO anon;
GRANT EXECUTE ON FUNCTION public.nearby_places(double precision, double precision, double precision, text) TO anon;
-- keep places_insert_own / places_update_own / places_delete_own as-is —
-- writes stay owner-scoped even though reads are now public.
```

### Index

A **GiST** index on `location` (`places_location_gix`) accelerates both
`ST_DWithin` (radius filtering) and `<->` (nearest-neighbor ordering) — the
standard PostGIS index shape, same one THOS's own schema uses
(`providers_location_gix`).

---

## 3. `nearby_places()` — radius search, nearest-first

```sql
public.nearby_places(
  lat      double precision,
  lng      double precision,
  max_km   double precision DEFAULT 25,
  category text             DEFAULT NULL
) RETURNS TABLE (id uuid, name text, category text, metadata jsonb, distance_km double precision)
```

- Returns rows within `max_km` of `(lat, lng)`, **nearest first**, with
  `distance_km` computed via `ST_Distance`.
- `category` is an optional exact-match filter (pass `NULL` to search all
  categories).
- Runs `SECURITY INVOKER` — the same RLS applies inside the function, so under
  the default owner-scoped policy a caller only ever finds their **own** rows.
  Once the table is switched to world-readable (above), the function
  automatically searches everyone's rows too — no function change needed.

### From SQL

```sql
SELECT id, name, distance_km
FROM public.nearby_places(-6.7924, 39.2083, 25, 'clinic');  -- 25km around Dar es Salaam
```

### From the SDK (`@laetoli/data`)

```ts
import { createClient } from '@laetoli/data';

const db = createClient('https://data.laetoli.tz', { apikey: ANON_KEY });

const { data, error } = await db.rpc('nearby_places', {
  lat: -6.7924,
  lng: 39.2083,
  max_km: 25,
  category: 'clinic',
});
// data: { id, name, category, metadata, distance_km }[]
```

### Inserting a location

```ts
await db.from('places').insert({
  name: 'Mnazi Mmoja Hospital',
  category: 'hospital',
  location: 'POINT(39.2833 -6.8167)',   // PostGIS WKT: POINT(lng lat) — note lng FIRST
  metadata: { specialty: 'general', accepts_nhif: true },
});
```

PostgREST/PostGIS accepts WKT (`POINT(lng lat)`) or GeoJSON for geography
columns. **Longitude comes first** in both — the opposite order from how
lat/lng is usually spoken out loud; a common source of silently-wrong
coordinates.

---

## 4. Make your own location tables

`places` is a **template**, same pattern as `documents` in `0005_vectors.sql`.
To model a real domain (providers, facilities, delivery zones, incident
reports), copy the table + RLS + function block from
`db/migrations/0012_postgis.sql`, rename it, and decide read/write visibility
per §2 above. Keep `SECURITY INVOKER` on any search function so RLS stays
enforced.

---

## 5. Migrating an existing Supabase/PostGIS schema

Because this is the same PostGIS engine Supabase runs, an existing schema that
uses `geography`/`geometry` columns, `ST_*` functions, and `auth.uid()`-scoped
RLS (THOS's schema is a direct example — see `thos/supabase/migrations/0001_init.sql`'s
`providers` table and `providers_near()` RPC) should port with **no PostGIS-
specific rewriting** — the extension, types, and functions are identical.
What changes when moving off Supabase is the auth/JWT layer (this project's
own auth service, not Supabase Auth) and the client SDK import — not the
spatial SQL itself.
