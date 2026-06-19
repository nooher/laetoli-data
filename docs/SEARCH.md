# Search — full-text, vector & hybrid (the sovereign RAG retrieval layer)

Laetoli Data ships **hybrid search**: Postgres **full-text** (keyword) search and
**pgvector** (semantic) search over the *same* owner-scoped `public.documents`
table, fused into one call. This is the standard RAG retrieval pattern — keyword
precision *and* semantic recall — running entirely inside your sovereign Postgres,
on a VPS or a Raspberry Pi. No external search service, no external AI provider.

It builds directly on [Vectors](./VECTORS.md) (`0005_vectors.sql`). Read that
first; this layer (`0006_search.sql`) only **adds** to the `documents` table.

> **Embeddings are still bring-your-own.** The semantic leg needs a query vector
> you compute with the **same model** used for the stored embeddings (see
> [BYO embeddings](./VECTORS.md#4-bringing-your-own-embeddings)). The keyword leg
> needs only the raw query text — no model at all.

---

## 1. The three modes

| Mode          | Function              | Matches on           | Good at                                  |
|---------------|-----------------------|----------------------|------------------------------------------|
| **Full-text** | `search_documents`    | exact words / phrases | names, codes, rare terms, exact quotes   |
| **Vector**    | `match_documents`     | meaning (cosine)      | paraphrase, synonyms, fuzzy intent       |
| **Hybrid**    | `hybrid_search`       | both, fused via RRF   | general-purpose RAG retrieval — use this |

Keyword search nails the literal token a user typed; vector search finds
semantically related passages that share no words. **Hybrid** gives you both and
is the recommended default for retrieval-augmented generation.

---

## 2. Prerequisite & install

Full-text search needs **no extension** (it is stock Postgres) — but `0006`
extends the `documents` table from `0005_vectors.sql`, so apply that first.
The `db` image is already `pgvector/pgvector:pg16`; **no docker-compose change**
is needed.

On a **fresh** volume, `db/init/09_search.sql` runs automatically (after
`08_vectors.sql`). On an **existing** database, apply the migration:

```bash
laetoli-data migrate              # runs db/migrations/0006_search.sql
# or: psql "$DATABASE_URL" -f db/migrations/0006_search.sql
```

`0006_search.sql` adds to `public.documents`:

- a **generated** `content_tsv tsvector` column —
  `GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content,''))) STORED`.
  Postgres maintains it automatically on every insert/update; no triggers.
- a **GIN index** (`documents_content_tsv_idx`) on that column.
- the `search_documents()` and `hybrid_search()` functions (both
  **`SECURITY INVOKER`**, so owner RLS applies inside them).

---

## 3. Why the `'simple'` text-search config (not `'english'`)

`to_tsvector('english', …)` applies an **English stemmer** and an **English
stop-word list**. Laetoli Data is **Swahili-first**, and Postgres ships **no
Swahili dictionary** — so an English config would stem/strip Swahili tokens
incorrectly and silently drop Swahili-shaped words it mistakes for English
stop-words.

The **`'simple'`** configuration does **no stemming** and has **no stop-word
list** — it just lower-cases and splits on word boundaries. That is robust and
language-neutral: it works acceptably for Swahili, English, and mixed text alike,
which matches real Tanzanian usage.

> **Later, if you want more:** a Swahili dictionary (custom `ispell`/synonym
> dictionary) or the `unaccent` extension (to fold diacritics) can be layered in
> **without reshaping this schema** — change the config inside the generated
> column definition and reindex. The column/function shape stays the same.

---

## 4. `search_documents()` — keyword full-text

```sql
public.search_documents(
  query       text,
  match_count int   DEFAULT 10,
  filter      jsonb DEFAULT '{}'
) RETURNS TABLE (id uuid, content text, metadata jsonb, rank double precision)
```

- Parses `query` with `websearch_to_tsquery('simple', query)` — a forgiving,
  user-friendly grammar: `"quoted phrases"` match as a phrase, `or` is an OR, and
  a leading `-term` negates.
- Ranks with `ts_rank_cd` (cover-density: rewards matches close together),
  highest first.
- `filter` is jsonb containment (`metadata @> filter`).
- RLS-scoped: a caller only sees rows they own.

```sql
SELECT id, content, rank
FROM public.search_documents('mfumo wa afya', 10, '{"source":"akili"}'::jsonb);
```

---

## 5. `hybrid_search()` — full-text + vector, fused via RRF *(the headline)*

```sql
public.hybrid_search(
  query            text,
  query_embedding  vector(384),
  match_count      int   DEFAULT 10,
  full_text_weight float DEFAULT 1.0,
  semantic_weight  float DEFAULT 1.0,
  rrf_k            int   DEFAULT 50,
  filter           jsonb DEFAULT '{}'
) RETURNS TABLE (id uuid, content text, metadata jsonb, score double precision)
```

It runs **both** retrievers over the same owner-scoped rows, then fuses them.

### Reciprocal Rank Fusion (RRF)

Each retriever produces a ranked list. For a document at position `rank` in a
list, RRF contributes `weight / (rrf_k + rank)`. A document's final score sums
its contributions across both lists:

```
score(doc) =  full_text_weight / (rrf_k + ft_rank)
            + semantic_weight  / (rrf_k + sem_rank)
```

Why RRF instead of just adding the two scores together? Because `ts_rank_cd`
(unbounded, keyword-specific) and cosine similarity (`-1..1`) live on **wildly
different scales** — naively summing them lets one metric dominate. RRF fuses by
**rank position**, not raw score, so a `#1` result contributes the same
`1/(rrf_k+1)` no matter which retriever produced it. No normalisation required.

- **`rrf_k`** (default `50`) damps lower ranks — larger `k` flattens the curve so
  deep results still count a little; smaller `k` makes the top ranks dominate.
- **Weights** let you lean the blend: `full_text_weight: 2, semantic_weight: 1`
  favours exact keyword hits; the reverse favours semantic recall.
- A document appearing in only one list simply contributes that one term.
- Each leg is internally capped at `match_count` for efficiency.

```sql
SELECT id, content, score
FROM public.hybrid_search(
  'how do I export a backup',
  '[0.01, 0.02, ... 384 numbers ...]'::vector,
  10,        -- match_count
  1.0,       -- full_text_weight
  1.0,       -- semantic_weight
  50,        -- rrf_k
  '{"source":"akili"}'::jsonb
);
```

---

## 6. From the SDK (`@laetoli/data`)

```ts
import { createClient } from '@laetoli/data';

const db = createClient('https://data.laetoli.tz', { apikey: ANON_KEY });
await db.auth.signIn({ username, password }); // RLS scopes results to this user

// --- keyword only ---------------------------------------------------------
const kw = await db.searchDocuments('mfumo wa afya', {
  count: 10,
  filter: { source: 'akili' },
});
// kw.data: { id, content, metadata, rank }[]

// --- hybrid (the RAG default) --------------------------------------------
const queryEmbedding: number[] = await embed('how do I export a backup');
const hits = await db.hybridSearch('how do I export a backup', queryEmbedding, {
  count: 10,
  fullTextWeight: 1.0,
  semanticWeight: 1.0,
  rrfK: 50,
  filter: { source: 'akili' },
});
// hits.data: { id, content, metadata, score }[]

// --- or call the SQL functions directly via rpc --------------------------
await db.rpc('search_documents', { query: 'backups', match_count: 5, filter: {} });
await db.rpc('hybrid_search', {
  query: 'backups',
  query_embedding: queryEmbedding,
  match_count: 5,
  full_text_weight: 1.0,
  semantic_weight: 1.0,
  rrf_k: 50,
  filter: {},
});
```

All return the standard `{ data, error, status, statusText }` envelope.
`db.vectors.searchDocuments(...)` / `db.vectors.hybridSearch(...)` are the same
methods. Inserting documents is unchanged — see
[Vectors §3 "Inserting embeddings"](./VECTORS.md#3-match_documents--top-n-by-cosine-similarity);
`content_tsv` populates itself from `content`, no extra work.

---

## 7. Notes

- **Same RLS as everything else.** Both functions are `SECURITY INVOKER`; a user
  only ever searches their own `documents` rows.
- **BYO embeddings.** Hybrid's semantic leg needs a query vector from the same
  model as the stored vectors. The keyword leg needs none. See
  [Vectors §4](./VECTORS.md#4-bringing-your-own-embeddings).
- **Tuning.** Start with hybrid + defaults. Raise `full_text_weight` for
  ID/code/name-heavy corpora; raise `semantic_weight` for conversational ones.
