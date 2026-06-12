-- 003_ingestion_per_state_fingerprint.sql
-- Change raw_records.fingerprint uniqueness from global to per-state.
--
-- Background: bulletin distribution (src/ingestion/modules/bulletin.js) is
-- expected to publish the same article body to multiple state targets.
-- Computing the fingerprint from the raw text and putting a global UNIQUE on
-- the column made the second state's insert crash on the unique constraint
-- even though it was a legitimate, expected insert.
--
-- The existing idx_raw_records_state_fingerprint (state, fingerprint) already
-- expressed the intended per-state dedup key. This migration makes the
-- constraint match.
--
-- Run in a single transaction; safe on a fresh or populated DB as long as no
-- existing rows collide on (state, fingerprint). The pre-check query is:
--   SELECT state, fingerprint, COUNT(*) FROM raw_records
--   GROUP BY state, fingerprint HAVING COUNT(*) > 1;
-- (Should return zero rows.)

BEGIN;

-- Drop the old global unique constraint. The default name when CREATE TABLE
-- declared the column UNIQUE is "<table>_<col>_key" — verified on the live
-- blotter database. IF EXISTS keeps the migration re-runnable.
ALTER TABLE raw_records DROP CONSTRAINT IF EXISTS raw_records_fingerprint_key;

-- Add the per-state unique constraint. The pre-existing btree index
-- idx_raw_records_state_fingerprint will be promoted to enforce the unique
-- constraint; Postgres will use it directly. No new index needed.
ALTER TABLE raw_records
  ADD CONSTRAINT raw_records_state_fingerprint_key UNIQUE (state, fingerprint);

COMMIT;
