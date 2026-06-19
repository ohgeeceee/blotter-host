BEGIN;

CREATE TABLE IF NOT EXISTS raw_records (
  id BIGSERIAL PRIMARY KEY,
  state TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_name TEXT,
  fingerprint TEXT NOT NULL UNIQUE,
  raw_text TEXT NOT NULL,
  raw_html TEXT,
  raw_payload JSONB,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Bring pre-existing raw_records tables (created before processed_at /
-- updated_at were added) up to the current schema. Idempotent.
ALTER TABLE raw_records ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ;
ALTER TABLE raw_records ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_raw_records_state_created_at
  ON raw_records (state, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_raw_records_state_fingerprint
  ON raw_records (state, fingerprint);

CREATE INDEX IF NOT EXISTS idx_raw_records_state_source_type_created_at
  ON raw_records (state, source_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_raw_records_source_type_created_at
  ON raw_records (source_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_raw_records_processed_at
  ON raw_records (processed_at);

CREATE TABLE IF NOT EXISTS ingestion_logs (
  id BIGSERIAL PRIMARY KEY,
  state TEXT,
  source_type TEXT,
  source_name TEXT,
  source_url TEXT,
  status TEXT NOT NULL,
  error_type TEXT,
  error_message TEXT,
  stack_trace TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ingestion_logs_state_created_at
  ON ingestion_logs (state, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ingestion_logs_source_type_created_at
  ON ingestion_logs (source_type, created_at DESC);

-- Generated articles: produced by the Claude summarization step from
-- raw_records. The public site (state-public router) reads from this table
-- via RLS-scoped tenant queries. Keep in sync with
-- src/db/pg.js :: initializeDatabase().
CREATE TABLE IF NOT EXISTS generated_articles (
  id BIGSERIAL PRIMARY KEY,
  raw_record_id BIGINT NOT NULL REFERENCES raw_records(id) ON DELETE CASCADE,
  state TEXT NOT NULL,
  headline TEXT NOT NULL,
  headline_fingerprint TEXT,
  body TEXT NOT NULL,
  categories JSONB,
  publication_status TEXT NOT NULL DEFAULT 'draft',
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_generated_articles_state_created_at
  ON generated_articles (state, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_generated_articles_state_publication_status_created_at
  ON generated_articles (state, publication_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_generated_articles_raw_record_id
  ON generated_articles (raw_record_id);

CREATE INDEX IF NOT EXISTS idx_generated_articles_state_headline_fingerprint
  ON generated_articles (state, headline_fingerprint);

COMMIT;
