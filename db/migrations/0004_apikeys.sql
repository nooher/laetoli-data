-- =============================================================================
-- 0004_apikeys.sql — API keys + projects + quotas (multi-tenant foundation)
-- -----------------------------------------------------------------------------
-- MIGRATION (run once, manually / via your migration runner — also wired into
-- db/init/07_apikeys.sql with \i for fresh boots). Idempotent: safe to re-run
-- (CREATE ... IF NOT EXISTS, DO-block guards, GRANTs are naturally re-runnable).
--
-- WHAT THIS IS
--   The "issuable key" layer that turns Laetoli Data into a multi-tenant
--   backend. A `project` is a logical tenant; each project mints `api_keys`
--   (anon or service). The ADMIN service (admin/, :9996) owns all writes here —
--   it generates a secret with crypto, stores ONLY a sha256 hash + a short
--   display prefix, and returns the full key to the operator exactly once.
--
--   The storage + functions services may OPT IN to enforcing these keys via the
--   apikeyGuard middleware (env REQUIRE_API_KEY=true). When that flag is false
--   (the default) nothing here is consulted and all existing flows are unchanged.
--
-- WHO CONNECTS / ACCESS
--   The admin service connects AS laetoli_admin_login (member of laetoli_admin,
--   BYPASSRLS — see 0003_admin.sql), so the GRANTs below to laetoli_admin are
--   inherited. The storage/functions guards read these tables through their own
--   pg connections (laetoli_storage / a functions login); the GRANTs at the
--   bottom give those roles read access (and usage UPDATE) so enforcement works.
--
-- SECURITY
--   * Raw key secrets are NEVER stored — only sha256(secret) + a short prefix.
--   * A leaked DB dump cannot be replayed: the hash is not the presented key.
--   * Revocation is a soft delete (revoked_at) so usage history is retained.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

-- --- schema -------------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS keys AUTHORIZATION laetoli_admin;

-- --- keys.projects (logical tenants) -----------------------------------------
CREATE TABLE IF NOT EXISTS keys.projects (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text        UNIQUE NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE keys.projects IS 'Logical tenants. Each project mints its own API keys.';

-- --- keys.api_keys ------------------------------------------------------------
-- Store ONLY a hash of the secret + a short display prefix; never the raw key.
CREATE TABLE IF NOT EXISTS keys.api_keys (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id         uuid        NOT NULL REFERENCES keys.projects(id) ON DELETE CASCADE,
  name               text,
  role               text        NOT NULL CHECK (role IN ('anon','service')),
  key_prefix         text        NOT NULL,
  key_hash           text        NOT NULL,
  rate_limit_per_min int         NOT NULL DEFAULT 120,
  created_at         timestamptz NOT NULL DEFAULT now(),
  revoked_at         timestamptz
);

COMMENT ON TABLE  keys.api_keys IS 'Issued API keys. key_hash = sha256(secret); raw key never stored.';
COMMENT ON COLUMN keys.api_keys.role IS 'anon = public/RLS-bound; service = elevated (treat like a service-role key).';
COMMENT ON COLUMN keys.api_keys.key_prefix IS 'Short non-secret display prefix (e.g. ld_abc12345) shown in dashboards.';
COMMENT ON COLUMN keys.api_keys.key_hash IS 'sha256 hex of the secret portion. Verification re-hashes the presented secret.';
COMMENT ON COLUMN keys.api_keys.revoked_at IS 'Soft-delete: when set the key is rejected (401). Usage history retained.';

CREATE INDEX IF NOT EXISTS api_keys_project_idx ON keys.api_keys (project_id);
-- The guard looks keys up by hash among active (non-revoked) keys; index helps.
CREATE INDEX IF NOT EXISTS api_keys_hash_idx    ON keys.api_keys (key_hash) WHERE revoked_at IS NULL;

-- --- keys.usage (daily counters) ---------------------------------------------
CREATE TABLE IF NOT EXISTS keys.usage (
  key_id uuid   NOT NULL REFERENCES keys.api_keys(id) ON DELETE CASCADE,
  day    date   NOT NULL,
  count  bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, day)
);

COMMENT ON TABLE keys.usage IS 'Per-key daily request counters, incremented best-effort by the guards.';

-- --- default project seed -----------------------------------------------------
-- A "default" tenant so a fresh stack can mint a key immediately. Idempotent.
INSERT INTO keys.projects (name)
  VALUES ('default')
  ON CONFLICT (name) DO NOTHING;

-- --- grants -------------------------------------------------------------------
-- The admin service (as laetoli_admin / laetoli_admin_login) manages everything.
GRANT ALL ON SCHEMA keys TO laetoli_admin;
GRANT ALL ON ALL TABLES IN SCHEMA keys TO laetoli_admin;

-- The enforcement services (storage + functions) need to READ keys to verify a
-- presented secret, and to UPSERT the daily usage counter. They never create or
-- revoke keys. Grant USAGE + SELECT on key tables, and write on usage.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'laetoli_storage') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA keys TO laetoli_storage';
    EXECUTE 'GRANT SELECT ON keys.api_keys, keys.projects TO laetoli_storage';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON keys.usage TO laetoli_storage';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'laetoli_functions') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA keys TO laetoli_functions';
    EXECUTE 'GRANT SELECT ON keys.api_keys, keys.projects TO laetoli_functions';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON keys.usage TO laetoli_functions';
  END IF;
END $$;

-- =============================================================================
-- NOTE: enforcement is OPT-IN. Until a service is started with REQUIRE_API_KEY=
-- true, these tables are inert — the apikeyGuard middleware is a NO-OP and the
-- live stack behaves exactly as before. Mint keys via the admin API
-- (POST /projects/:id/keys) which returns the full key ONCE.
-- =============================================================================
