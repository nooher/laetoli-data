-- =============================================================================
-- 0006_search.sql — hybrid search: Postgres full-text + pgvector (RAG layer)
-- -----------------------------------------------------------------------------
-- MIGRATION (run once, manually / via your migration runner — also wired into
-- db/init/09_search.sql with \i for fresh boots). Idempotent: safe to re-run
-- (ADD COLUMN IF NOT EXISTS, CREATE INDEX IF NOT EXISTS, CREATE OR REPLACE
-- FUNCTION, GRANTs are naturally re-runnable).
--
-- WHAT THIS IS
--   The AI-native *retrieval* layer that sits on top of 0005_vectors.sql. It
--   adds keyword (full-text) search to the same owner-scoped public.documents
--   table and fuses it with the existing vector search so apps get BOTH keyword
--   precision and semantic recall from one call — the standard RAG retrieval
--   pattern, fully sovereign. See docs/SEARCH.md.
--
--   - search_documents()  → keyword full-text search (BM25-ish, ts_rank_cd).
--   - hybrid_search()     → fuse full-text + vector via Reciprocal Rank Fusion.
--
-- REQUIRES
--   0005_vectors.sql (the public.documents table + the `vector` type). Run that
--   first. Full-text search itself needs no extension — to_tsvector / GIN are
--   stock Postgres.
--
-- WHY THE 'simple' TEXT-SEARCH CONFIG (not 'english')
--   to_tsvector('english', ...) applies an English stemmer + English stop-word
--   list. Laetoli Data is Swahili-first, and Postgres ships NO Swahili
--   dictionary, so an English config would mangle Swahili tokens and drop
--   Swahili-shaped words it mistakes for English stop-words. The 'simple'
--   configuration does NO stemming and has NO stop-word list — it just folds
--   case and tokenises on word boundaries. That is robust and language-neutral:
--   it works acceptably for Swahili, English, and mixed text alike. A proper
--   Swahili dictionary (or `unaccent` for diacritics) can be layered in later
--   without changing this schema's shape — see docs/SEARCH.md.
--
-- ACCESS / SECURITY
--   Both functions run SECURITY INVOKER, so the SAME owner RLS from
--   0005_vectors.sql applies inside them — a caller only ever searches rows they
--   own. The optional `filter` jsonb is matched with `@>` containment against
--   documents.metadata (e.g. {"source":"akili"}).
-- =============================================================================

-- --- full-text column (generated tsvector) -----------------------------------
-- A STORED generated column: Postgres maintains documents.content_tsv from
-- content automatically on every insert/update — no triggers to keep in sync.
-- 'simple' config (see header) → no stemming/stop-words, Swahili-safe.
ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS content_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('simple', coalesce(content, ''))) STORED;

COMMENT ON COLUMN public.documents.content_tsv IS
  'Generated full-text vector of content (config: simple — no stemmer/stop-words, Swahili-safe). Searched by search_documents()/hybrid_search().';

-- --- GIN index for full-text search ------------------------------------------
-- GIN over the tsvector accelerates @@ matching (websearch_to_tsquery).
CREATE INDEX IF NOT EXISTS documents_content_tsv_idx
  ON public.documents USING gin (content_tsv);

-- =============================================================================
-- public.search_documents() — keyword (full-text) search
-- -----------------------------------------------------------------------------
-- websearch_to_tsquery('simple', query) parses a human query string (supports
-- "quoted phrases", OR, and -negation) into a tsquery. Rows are ranked by
-- ts_rank_cd (cover-density rank — rewards matches that are close together),
-- highest first. RLS-scoped (SECURITY INVOKER); metadata @> filter restricts.
-- Returns id, content, metadata, rank (double precision; higher = better).
-- =============================================================================
CREATE OR REPLACE FUNCTION public.search_documents(
  query       text,
  match_count int   DEFAULT 10,
  filter      jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  id       uuid,
  content  text,
  metadata jsonb,
  rank     double precision
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
    ts_rank_cd(d.content_tsv, websearch_to_tsquery('simple', COALESCE(query, ''))) AS rank
  FROM public.documents d
  WHERE d.content_tsv @@ websearch_to_tsquery('simple', COALESCE(query, ''))
    AND d.metadata @> COALESCE(filter, '{}'::jsonb)
  ORDER BY rank DESC, d.created_at DESC
  LIMIT GREATEST(COALESCE(match_count, 10), 0);
$$;

COMMENT ON FUNCTION public.search_documents(text, int, jsonb) IS
  'Keyword full-text search over public.documents (RLS-scoped). websearch_to_tsquery(simple) + ts_rank_cd. filter is jsonb containment on metadata.';

GRANT EXECUTE ON FUNCTION public.search_documents(text, int, jsonb) TO authenticated, anon;

-- =============================================================================
-- public.hybrid_search() — full-text + vector fused via Reciprocal Rank Fusion
-- -----------------------------------------------------------------------------
-- THE HEADLINE FUNCTION. Runs both retrievers over the SAME owner-scoped rows:
--   1. full-text  — rank by ts_rank_cd (keyword precision)
--   2. semantic   — rank by cosine distance to query_embedding (semantic recall)
-- then fuses the two ranked lists with Reciprocal Rank Fusion (RRF):
--
--     score(doc) =  full_text_weight / (rrf_k + ft_rank)
--                 + semantic_weight  / (rrf_k + sem_rank)
--
-- RRF combines lists by RANK POSITION, not raw score, so the wildly different
-- scales of ts_rank_cd and cosine similarity never have to be normalised — a
-- doc that ranks #1 in either list contributes ~1/(rrf_k+1) regardless of the
-- underlying metric. rrf_k (default 50) damps the contribution of lower ranks;
-- larger k flattens the curve. Weights let callers lean keyword vs semantic.
--
-- Each sub-query is itself capped at match_count for efficiency (a doc outside
-- the top match_count of BOTH lists can't make the fused top match_count). A
-- doc present in only one list simply contributes that one term (FULL OUTER
-- JOIN on id). RLS-enforced (SECURITY INVOKER); metadata @> filter on both.
-- Returns id, content, metadata, score (fused RRF score; higher = better).
--
-- vector(384) MUST match the documents.embedding width (see 0005 header).
-- =============================================================================
CREATE OR REPLACE FUNCTION public.hybrid_search(
  query            text,
  query_embedding  vector(384),
  match_count      int   DEFAULT 10,
  full_text_weight float DEFAULT 1.0,
  semantic_weight  float DEFAULT 1.0,
  rrf_k            int   DEFAULT 50,
  filter           jsonb DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  id       uuid,
  content  text,
  metadata jsonb,
  score    double precision
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH lim AS (
    SELECT GREATEST(COALESCE(match_count, 10), 0) AS n
  ),
  full_text AS (
    SELECT
      d.id,
      row_number() OVER (
        ORDER BY ts_rank_cd(d.content_tsv, websearch_to_tsquery('simple', COALESCE(query, ''))) DESC,
                 d.created_at DESC
      ) AS rank
    FROM public.documents d
    WHERE COALESCE(query, '') <> ''
      AND d.content_tsv @@ websearch_to_tsquery('simple', COALESCE(query, ''))
      AND d.metadata @> COALESCE(filter, '{}'::jsonb)
    ORDER BY rank
    LIMIT (SELECT n FROM lim)
  ),
  semantic AS (
    SELECT
      d.id,
      row_number() OVER (ORDER BY d.embedding <=> query_embedding) AS rank
    FROM public.documents d
    WHERE query_embedding IS NOT NULL
      AND d.embedding IS NOT NULL
      AND d.metadata @> COALESCE(filter, '{}'::jsonb)
    ORDER BY rank
    LIMIT (SELECT n FROM lim)
  ),
  fused AS (
    SELECT
      COALESCE(ft.id, sm.id) AS id,
      COALESCE(COALESCE(full_text_weight, 1.0) / (COALESCE(rrf_k, 50) + ft.rank), 0.0)
        + COALESCE(COALESCE(semantic_weight, 1.0) / (COALESCE(rrf_k, 50) + sm.rank), 0.0)
        AS score
    FROM full_text ft
    FULL OUTER JOIN semantic sm ON ft.id = sm.id
  )
  SELECT
    d.id,
    d.content,
    d.metadata,
    f.score
  FROM fused f
  JOIN public.documents d ON d.id = f.id
  ORDER BY f.score DESC, d.created_at DESC
  LIMIT (SELECT n FROM lim);
$$;

COMMENT ON FUNCTION public.hybrid_search(text, vector, int, float, float, int, jsonb) IS
  'Hybrid retrieval over public.documents (RLS-scoped): full-text + vector fused via Reciprocal Rank Fusion (weight/(rrf_k+rank)). The headline RAG search. filter is jsonb containment on metadata.';

GRANT EXECUTE ON FUNCTION public.hybrid_search(text, vector, int, float, float, int, jsonb) TO authenticated, anon;

-- =============================================================================
-- NOTE: as with 0005, embeddings are BRING-YOUR-OWN — hybrid_search takes a
-- query_embedding you compute with the SAME model used for the stored vectors,
-- plus the raw query text for the keyword leg. The 'simple' tsvector config is
-- deliberate (Swahili-safe; see header). A Swahili dictionary / unaccent can be
-- layered in later without reshaping this schema. See docs/SEARCH.md.
-- =============================================================================
