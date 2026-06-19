# Vectors — AI-native embeddings & similarity search

Laetoli Data ships **first-class vector search** via [pgvector](https://github.com/pgvector/pgvector),
inside the same sovereign Postgres that already holds your tables, auth, and
storage. Store embeddings, run cosine-similarity search, and keep everything on
your own VPS — or a Raspberry Pi. This is the sovereign equivalent of Supabase's
pgvector/AI features, and the **memory/knowledge store for Akili**.

> **Embeddings are bring-your-own.** Laetoli Data **stores + searches** vectors;
> it does **not** run an embedding model. You compute the float array (client-side
> or in an edge function) and write it here. This keeps the stack dependency-free
> and Pi-ready. See [Bringing your own embeddings](#bringing-your-own-embeddings).

> **Want keyword + semantic together?** See [**Search**](./SEARCH.md) — it adds
> Postgres full-text search to this same `documents` table and fuses it with the
> vector search via Reciprocal Rank Fusion (`hybrid_search`), the standard RAG
> retrieval pattern.

---

## 1. Prerequisite: the pgvector database image

The `vector` extension is **not** in stock `postgres:16-alpine`. Switch the `db`
service to the official pgvector image — a **drop-in superset of Postgres 16**
(same env vars, volumes, healthcheck; Debian-based, multi-arch incl. arm64):

```yaml
# docker-compose.yml — db service
    image: pgvector/pgvector:pg16
```

Then bring the stack up. On a **fresh** volume, `db/init/08_vectors.sql` runs
automatically. On an **existing** database, apply the migration:

```bash
laetoli-data migrate              # runs db/migrations/0005_vectors.sql
# or: psql "$DATABASE_URL" -f db/migrations/0005_vectors.sql
```

---

## 2. The `documents` table

`db/migrations/0005_vectors.sql` creates a template embedding store:

| column       | type            | notes                                              |
|--------------|-----------------|----------------------------------------------------|
| `id`         | `uuid` PK       | `gen_random_uuid()`                                 |
| `owner`      | `uuid`          | defaults to `auth.uid()` — clients can't spoof it   |
| `content`    | `text`          | the source text (optional)                          |
| `embedding`  | `vector(384)`   | your embedding; **384** by default                  |
| `metadata`   | `jsonb`         | free-form tags used for filtering (`{}` default)    |
| `created_at` | `timestamptz`   | `now()`                                             |

### Row-Level Security (owner-scoped)

`documents` mirrors the `notes` template (`db/init/03_example.sql`): RLS confines
every row to its owner. A signed-in user can only `SELECT/INSERT/UPDATE/DELETE`
rows where `auth.uid() = owner`. `anon` gets no access. The `match_documents`
function runs **`SECURITY INVOKER`**, so the *same* RLS applies inside search — a
caller only ever matches against their **own** rows.

### Index

An **IVFFlat** index on `embedding vector_cosine_ops` (`lists = 100`) accelerates
cosine ANN search. IVFFlat is the lean, Pi-friendly default. For higher recall
without training, swap to **HNSW**:

```sql
DROP INDEX IF EXISTS public.documents_embedding_cos_idx;
CREATE INDEX documents_embedding_cos_idx
  ON public.documents USING hnsw (embedding vector_cosine_ops);
```

---

## 3. `match_documents()` — top-N by cosine similarity

```sql
public.match_documents(
  query_embedding vector(384),
  match_count     int   DEFAULT 5,
  filter          jsonb DEFAULT '{}'
) RETURNS TABLE (id uuid, content text, metadata jsonb, similarity double precision)
```

- `similarity = 1 - (embedding <=> query_embedding)` — the `<=>` operator is
  cosine **distance**; `1 - distance` gives similarity in `(-1 .. 1]`, where
  `1.0` means identical direction. Rows come back most-similar first.
- `filter` is matched with jsonb containment (`metadata @> filter`), e.g.
  `{"source":"akili"}` restricts to rows whose metadata contains that pair.

### From SQL

```sql
SELECT id, content, similarity
FROM public.match_documents(
  '[0.01, 0.02, ... 384 numbers ...]'::vector,
  5,
  '{"source":"akili"}'::jsonb
);
```

### From the SDK (`@laetoli/data`)

The client exposes a generic **RPC** call plus a typed convenience helper:

```ts
import { createClient } from '@laetoli/data';

const db = createClient('https://data.laetoli.tz', { apikey: ANON_KEY });
await db.auth.signIn({ username, password }); // RLS scopes results to this user

// Compute the query embedding however you like (see "BYO embeddings" below).
const queryEmbedding: number[] = await embed('How do I export a backup?');

// Convenience helper:
const { data, error } = await db.matchDocuments(queryEmbedding, {
  count: 5,
  filter: { source: 'akili' },
});
// data: { id, content, metadata, similarity }[]

// ...or call any SQL function directly:
const res = await db.rpc('match_documents', {
  query_embedding: queryEmbedding,
  match_count: 5,
  filter: { source: 'akili' },
});
```

Both return the standard `{ data, error, status, statusText }` envelope.
`db.vectors.matchDocuments(...)` and `db.vectors.rpc(...)` are the same methods.

### Inserting embeddings

Insert is just an ordinary `from('documents')` write — `owner` defaults to the
signed-in user:

```ts
await db.from('documents').insert({
  content: 'Backups run nightly at 03:00 and keep 14 dumps.',
  embedding: await embed('Backups run nightly...'), // number[] of length 384
  metadata: { source: 'akili', doc: 'backup' },
});
```

PostgREST accepts the JSON number array and casts it to `vector`.

---

## 4. Bringing your own embeddings

Laetoli Data is sovereign — there is **no built-in model** and no call to an
external AI provider. You supply the vectors. Two recommended paths:

1. **Client-side / in your app** — run a small model (e.g.
   `all-MiniLM-L6-v2`, `bge-small`, `gte-small` — all 384-dim) via
   `transformers.js`, ONNX Runtime, or a local inference service, then write the
   resulting `number[]`. Fully offline-capable.
2. **Edge function** — put the model behind a Laetoli Data
   [edge function](../functions) (`/functions/embed`) so clients POST text and
   get back a vector. Keeps model/weights server-side; still sovereign.

**Embedding generation is an Akili concern.** Akili computes embeddings and uses
`documents` + `match_documents` as its retrieval/memory layer — Laetoli Data is
the durable, RLS-secured store underneath.

> Always embed the **query** with the **same model** you used for the stored
> documents, or similarity scores are meaningless.

---

## 5. Changing the dimension

384 is a good small default. To use a different model width (e.g. 768 for
`bge-base`, 1536 for OpenAI `text-embedding-3-small`), the column type **and** the
function signature must match. Edit `db/migrations/0005_vectors.sql` (change every
`384`) and apply:

```sql
-- 1. resize the column
ALTER TABLE public.documents ALTER COLUMN embedding TYPE vector(768);

-- 2. recreate the function with the new width (re-run the CREATE OR REPLACE
--    FUNCTION block from the migration, with vector(768))

-- 3. recreate the index (it must match the new column type)
DROP INDEX IF EXISTS public.documents_embedding_cos_idx;
CREATE INDEX documents_embedding_cos_idx
  ON public.documents USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

> ⚠️ Resizing requires the column to be empty or all existing vectors to already
> be that width — re-embed your corpus when you switch models.

`.env.example` carries a **doc-only** `VECTOR_DIM=384` knob so operators record
which width a deployment uses; it does **not** change the schema by itself.

---

## 6. Make your own vector tables

`documents` is a **template**. To add another embedding store (e.g. `memories`,
`chunks`), copy the table + RLS + index block and write a sibling
`match_<table>()` function. Keep `SECURITY INVOKER` so RLS stays enforced.
