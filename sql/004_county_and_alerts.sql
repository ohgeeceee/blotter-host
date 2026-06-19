-- 004_county_and_alerts.sql
-- Add county-level drill-down, reader alerts, and transparency scoring support.

BEGIN;

-- County extraction on raw records and generated articles.
ALTER TABLE raw_records ADD COLUMN IF NOT EXISTS county TEXT;
ALTER TABLE generated_articles ADD COLUMN IF NOT EXISTS county TEXT;

-- Helpful indexes for county filtering.
CREATE INDEX IF NOT EXISTS idx_raw_records_state_county_created_at
  ON raw_records (state, county, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_generated_articles_state_county_created_at
  ON generated_articles (state, county, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_generated_articles_county_created_at
  ON generated_articles (county, created_at DESC)
  WHERE county IS NOT NULL;

COMMIT;
