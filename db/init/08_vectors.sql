-- =============================================================================
-- 08_vectors.sql — pgvector embeddings + similarity search on a FRESH boot.
-- -----------------------------------------------------------------------------
-- Single source of truth: includes the canonical migration. Existing databases
-- get the same SQL via `laetoli-data migrate` (0005_vectors.sql).
--
-- REQUIRES the `vector` extension — use the `pgvector/pgvector:pg16` db image
-- (a drop-in superset of postgres:16). On stock postgres:16-alpine this fails.
-- =============================================================================
\i /migrations/0005_vectors.sql
