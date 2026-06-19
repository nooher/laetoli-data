-- =============================================================================
-- 0005_vectors.sql — pgvector embeddings + similarity search (AI-native layer)
-- -----------------------------------------------------------------------------
-- MIGRATION (run once, manually / via your migration runner — also wired into
-- db/init/08_vectors.sql with \i for fresh boots). Idempotent: safe to re-run
-- (CREATE EXTENSION/TABLE/INDEX ... IF NOT EXISTS, DROP POLICY IF EXISTS,
-- CREATE OR REPLACE FUNCTION, GRANTs are naturally re-runnable).
--
-- WHAT THIS IS
--   The AI-native storage layer: store embeddings and run cosine similarity
--   search inside the sovereign Postgres — the equivalent of Supabase's
--   pgvector/AI features, and the memory/knowledge store for Akili. Laetoli
--   Data STORES + SEARCHES vectors; it does NOT generate embeddings (that is a
--   bring-your-own / Akili concern — compute them client-side or in an edge
--   function and write the resulting float array here). See docs/VECTORS.md.
--
-- REQUIRES
--   The `vector` extension, shipped by the `pgvector/pgvector:pg16` image
--   (a drop-in superset of postgres:16). On stock postgres:16-alpine the
--   CREATE EXTENSION below fails — switch the db image first (see docs).
--
-- DIMENSION (384)
--   The template `documents.embedding` is vector(384). 384 is a common small
--   sentence-embedding width (e.g. all-MiniLM-L6-v2 / bge-small / gte-small) —
--   compact, Pi-friendly, good recall. To use a different model, change the
--   384 in BOTH the column type and the match_documents signature (they must
--   match), then re-create the index. See docs/VECTORS.md "Changing the
--   dimension".
--
-- WHO CONNECTS / ACCESS
--   `public.documents` is an owner-scoped table reached through PostgREST as the
--   request role (authenticated). It mirrors public.notes (03_example.sql):
--   RLS confines every row to its owner via auth.uid(). match_documents() runs
--   SECURITY INVOKER so the SAME RLS applies inside the function — a caller can
--   only match against rows they own.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS vector;    -- pgvector: the `vector` type + ops

-- --- public.documents (owner-scoped embedding store) -------------------------
CREATE TABLE IF NOT EXISTS public.documents (
  id         uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  owner      uuid         NOT NULL DEFAULT auth.uid(),
  content    text,
  embedding  vector(384),
  metadata   jsonb        NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz  NOT NULL DEFAULT now()
);

COMMENT ON TABLE  public.documents IS 'AI-native embedding store (template). Owner-scoped via RLS; searched by public.match_documents().';
COMMENT ON COLUMN public.documents.owner    IS 'auth.users.id of the owner (JWT sub). Defaults to auth.uid() so clients never spoof it.';
COMMENT ON COLUMN public.documents.embedding IS 'pgvector embedding. Default width 384 (small sentence-embedding models). BYO embeddings.';
COMMENT ON COLUMN public.documents.metadata IS 'Free-form JSON tags used to scope/filter matches (see match_documents filter arg).';

-- Quick owner lookups (RLS predicate). The vector index handles similarity.
CREATE INDEX IF NOT EXISTS documents_owner_idx ON public.documents (owner);

-- --- vector index (IVFFlat, cosine) ------------------------------------------
-- IVFFlat with vector_cosine_ops accelerates `<=>` (cosine distance) ANN search.
-- `lists` ~= sqrt(rows); 100 is a sane default for up to ~1M rows. IVFFlat needs
-- data to train its centroids — on an empty table it still builds (one list) and
-- works; for best recall, REINDEX once the table has a representative volume.
-- (HNSW is an alternative — better recall/no training, more build cost/RAM:
--    CREATE INDEX ... USING hnsw (embedding vector_cosine_ops);
--  IVFFlat is chosen here as the lean, Pi-friendly default.)
CREATE INDEX IF NOT EXISTS documents_embedding_cos_idx
  ON public.documents USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- --- grants -------------------------------------------------------------------
-- CRUD to authenticated; RLS still gates every row. anon gets nothing.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.documents TO authenticated;
-- (Intentionally no grant to anon — flip on for a public knowledge base.)

-- --- enable + force RLS -------------------------------------------------------
ALTER TABLE public.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents FORCE  ROW LEVEL SECURITY;  -- applies even to table owner

-- --- policies (owner-scoped, idempotent) -------------------------------------
DROP POLICY IF EXISTS documents_select_own ON public.documents;
CREATE POLICY documents_select_own ON public.documents
  FOR SELECT TO authenticated
  USING (auth.uid() = owner);

DROP POLICY IF EXISTS documents_insert_own ON public.documents;
CREATE POLICY documents_insert_own ON public.documents
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = owner);

DROP POLICY IF EXISTS documents_update_own ON public.documents;
CREATE POLICY documents_update_own ON public.documents
  FOR UPDATE TO authenticated
  USING (auth.uid() = owner)
  WITH CHECK (auth.uid() = owner);

DROP POLICY IF EXISTS documents_delete_own ON public.documents;
CREATE POLICY documents_delete_own ON public.documents
  FOR DELETE TO authenticated
  USING (auth.uid() = owner);

-- --- public.match_documents() — top-N by cosine similarity -------------------
-- Returns the closest rows to query_embedding, most-similar first. similarity =
-- 1 - cosine_distance, so it ranges (−1..1]; 1.0 == identical direction.
--
-- SECURITY INVOKER (the default, stated explicitly): the function runs with the
-- CALLER's privileges, so RLS on public.documents applies — a user only ever
-- matches against their OWN rows. The optional `filter` jsonb is matched with
-- the `@>` containment operator against documents.metadata (e.g.
-- {"source":"akili"} → only rows whose metadata contains that pair).
--
-- The vector(384) here MUST match the column width. If you change the dimension,
-- change it in BOTH places and recreate the index.
CREATE OR REPLACE FUNCTION public.match_documents(
  query_embedding vector(384),
  match_count     int   DEFAULT 5,
  filter          jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  id         uuid,
  content    text,
  metadata   jsonb,
  similarity double precision
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    d.id,
    d.content,
    d.metadata,
    1 - (d.embedding <=> query_embedding) AS similarity
  FROM public.documents d
  WHERE d.embedding IS NOT NULL
    AND d.metadata @> COALESCE(filter, '{}'::jsonb)
  ORDER BY d.embedding <=> query_embedding   -- ascending distance = most similar
  LIMIT GREATEST(COALESCE(match_count, 5), 0);
$$;

COMMENT ON FUNCTION public.match_documents(vector, int, jsonb)
  IS 'Top-N cosine-similarity search over public.documents (RLS-scoped to caller). similarity = 1 - (embedding <=> query). filter is jsonb containment on metadata.';

-- PostgREST exposes this as POST /rest/rpc/match_documents. Let authenticated
-- (and anon, harmless under RLS — anon owns no rows) call it.
GRANT EXECUTE ON FUNCTION public.match_documents(vector, int, jsonb) TO authenticated, anon;

-- =============================================================================
-- NOTE: embeddings are BRING-YOUR-OWN. Laetoli Data does not run a model — it
-- stores the float[] you compute (client-side or in an edge function) and does
-- the similarity math in-database. This keeps the stack sovereign and Pi-ready.
-- To resize: ALTER the column type + match_documents signature to the new dim,
-- then DROP/CREATE the ivfflat index. See docs/VECTORS.md.
-- =============================================================================
