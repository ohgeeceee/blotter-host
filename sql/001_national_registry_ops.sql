-- 001_national_registry_ops.sql
-- National registry and scraper operations schema for America's Transparency Public Data Portal.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS registry;
CREATE SCHEMA IF NOT EXISTS ops;

CREATE OR REPLACE FUNCTION registry.state_code_to_fips(code char(2))
RETURNS char(2)
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE code
    WHEN 'AL' THEN '01' WHEN 'AK' THEN '02' WHEN 'AZ' THEN '04' WHEN 'AR' THEN '05'
    WHEN 'CA' THEN '06' WHEN 'CO' THEN '08' WHEN 'CT' THEN '09' WHEN 'DE' THEN '10'
    WHEN 'DC' THEN '11' WHEN 'FL' THEN '12' WHEN 'GA' THEN '13' WHEN 'HI' THEN '15'
    WHEN 'ID' THEN '16' WHEN 'IL' THEN '17' WHEN 'IN' THEN '18' WHEN 'IA' THEN '19'
    WHEN 'KS' THEN '20' WHEN 'KY' THEN '21' WHEN 'LA' THEN '22' WHEN 'ME' THEN '23'
    WHEN 'MD' THEN '24' WHEN 'MA' THEN '25' WHEN 'MI' THEN '26' WHEN 'MN' THEN '27'
    WHEN 'MS' THEN '28' WHEN 'MO' THEN '29' WHEN 'MT' THEN '30' WHEN 'NE' THEN '31'
    WHEN 'NV' THEN '32' WHEN 'NH' THEN '33' WHEN 'NJ' THEN '34' WHEN 'NM' THEN '35'
    WHEN 'NY' THEN '36' WHEN 'NC' THEN '37' WHEN 'ND' THEN '38' WHEN 'OH' THEN '39'
    WHEN 'OK' THEN '40' WHEN 'OR' THEN '41' WHEN 'PA' THEN '42' WHEN 'RI' THEN '44'
    WHEN 'SC' THEN '45' WHEN 'SD' THEN '46' WHEN 'TN' THEN '47' WHEN 'TX' THEN '48'
    WHEN 'UT' THEN '49' WHEN 'VT' THEN '50' WHEN 'VA' THEN '51' WHEN 'WA' THEN '53'
    WHEN 'WV' THEN '54' WHEN 'WI' THEN '55' WHEN 'WY' THEN '56'
    ELSE NULL
  END
$$;

CREATE OR REPLACE FUNCTION ops.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS registry.states (
  state_code  char(2) PRIMARY KEY,
  state_name  text NOT NULL,
  state_fips  char(2) NOT NULL UNIQUE,
  slug        text NOT NULL UNIQUE,
  is_enabled  boolean NOT NULL DEFAULT true,
  metadata    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT states_state_code_upper CHECK (state_code ~ '^[A-Z]{2}$'),
  CONSTRAINT states_state_fips_digits CHECK (state_fips ~ '^[0-9]{2}$'),
  CONSTRAINT states_slug_shape CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$')
);

CREATE TABLE IF NOT EXISTS registry.counties (
  county_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_code    char(2) NOT NULL REFERENCES registry.states(state_code) ON UPDATE CASCADE,
  county_fips   char(5) NOT NULL,
  county_name   text NOT NULL,
  slug          text NOT NULL,
  county_seat   text,
  centroid_lat  numeric(9,6),
  centroid_lng  numeric(9,6),
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT counties_county_fips_digits CHECK (county_fips ~ '^[0-9]{5}$'),
  CONSTRAINT counties_slug_shape CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT counties_lat_range CHECK (centroid_lat IS NULL OR centroid_lat BETWEEN -90 AND 90),
  CONSTRAINT counties_lng_range CHECK (centroid_lng IS NULL OR centroid_lng BETWEEN -180 AND 180),
  CONSTRAINT counties_state_fips_match CHECK (left(county_fips, 2) = registry.state_code_to_fips(state_code)),
  CONSTRAINT counties_state_fips_unique UNIQUE (state_code, county_fips),
  CONSTRAINT counties_state_slug_unique UNIQUE (state_code, slug),
  CONSTRAINT counties_id_state_unique UNIQUE (county_id, state_code)
);

CREATE TABLE IF NOT EXISTS registry.agencies (
  agency_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  state_code         char(2) NOT NULL REFERENCES registry.states(state_code) ON UPDATE CASCADE,
  county_id          uuid,
  agency_name        text NOT NULL,
  slug               text NOT NULL,
  agency_type        text NOT NULL,
  jurisdiction_type  text NOT NULL DEFAULT 'municipal',
  ori_code           text,
  ncic_code          text,
  website_url        text,
  contact_phone      text,
  status             text NOT NULL DEFAULT 'active',
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agencies_county_state_fk
    FOREIGN KEY (county_id, state_code)
    REFERENCES registry.counties(county_id, state_code)
    ON UPDATE CASCADE
    ON DELETE RESTRICT,
  CONSTRAINT agencies_slug_shape CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT agencies_type_allowed CHECK (
    agency_type IN (
      'sheriff',
      'police',
      'jail',
      'detention_center',
      'state_police',
      'campus_police',
      'tribal_police',
      'marshal',
      'constable',
      'other'
    )
  ),
  CONSTRAINT agencies_jurisdiction_allowed CHECK (
    jurisdiction_type IN ('municipal', 'county', 'state', 'tribal', 'campus', 'regional', 'federal', 'other')
  ),
  CONSTRAINT agencies_status_allowed CHECK (status IN ('active', 'inactive', 'pending', 'retired', 'error')),
  CONSTRAINT agencies_state_slug_unique UNIQUE (state_code, slug),
  CONSTRAINT agencies_id_state_unique UNIQUE (agency_id, state_code)
);

CREATE TABLE IF NOT EXISTS ops.agent_profiles (
  agent_profile_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_key       text NOT NULL UNIQUE,
  display_name      text NOT NULL,
  agent_engine      text NOT NULL DEFAULT 'openclaw',
  mission_path      text,
  soul_path         text,
  definition        jsonb NOT NULL DEFAULT '{}'::jsonb,
  pii_policy        jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_schema     jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_enabled        boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_profiles_key_shape CHECK (profile_key ~ '^[a-z0-9]+(?:_[a-z0-9]+)*$'),
  CONSTRAINT agent_profiles_engine_allowed CHECK (agent_engine IN ('openclaw', 'kimi_lmm', 'node_worker', 'manual', 'other'))
);

CREATE TABLE IF NOT EXISTS registry.scrape_targets (
  target_id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agency_id              uuid NOT NULL,
  state_code             char(2) NOT NULL REFERENCES registry.states(state_code) ON UPDATE CASCADE,
  target_type            text NOT NULL,
  source_url             text NOT NULL,
  vendor_hint            text,
  access_method          text NOT NULL DEFAULT 'browser_agent',
  expected_payload_type  text NOT NULL DEFAULT 'unknown',
  agent_profile_id       uuid REFERENCES ops.agent_profiles(agent_profile_id) ON UPDATE CASCADE ON DELETE SET NULL,
  is_enabled             boolean NOT NULL DEFAULT true,
  priority               integer NOT NULL DEFAULT 100,
  metadata               jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scrape_targets_agency_state_fk
    FOREIGN KEY (agency_id, state_code)
    REFERENCES registry.agencies(agency_id, state_code)
    ON UPDATE CASCADE
    ON DELETE CASCADE,
  CONSTRAINT scrape_targets_type_allowed CHECK (
    target_type IN (
      'jail_roster',
      'bookings',
      'calls_for_service',
      'police_blotter',
      'incident_feed',
      'warrants',
      'arrests',
      'court_calendar',
      'discovery',
      'other'
    )
  ),
  CONSTRAINT scrape_targets_access_allowed CHECK (
    access_method IN ('public_web', 'browser_agent', 'api_json', 'arcgis', 'pdf', 'rss', 'html', 'csv', 'manual', 'other')
  ),
  CONSTRAINT scrape_targets_payload_allowed CHECK (
    expected_payload_type IN ('json', 'html', 'pdf', 'text', 'csv', 'xml', 'mixed', 'unknown')
  ),
  CONSTRAINT scrape_targets_priority_nonnegative CHECK (priority >= 0)
);

CREATE TABLE IF NOT EXISTS ops.scrape_schedules (
  schedule_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id            uuid NOT NULL REFERENCES registry.scrape_targets(target_id) ON UPDATE CASCADE ON DELETE CASCADE,
  state_code           char(2) NOT NULL REFERENCES registry.states(state_code) ON UPDATE CASCADE,
  cron_expr            text,
  interval_seconds     integer,
  timezone             text NOT NULL DEFAULT 'UTC',
  max_runtime_seconds  integer NOT NULL DEFAULT 1800,
  max_retries          integer NOT NULL DEFAULT 2,
  jitter_seconds       integer NOT NULL DEFAULT 0,
  is_paused            boolean NOT NULL DEFAULT false,
  next_run_at          timestamptz,
  metadata             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scrape_schedules_target_state_unique UNIQUE (target_id, state_code),
  CONSTRAINT scrape_schedules_interval_positive CHECK (interval_seconds IS NULL OR interval_seconds > 0),
  CONSTRAINT scrape_schedules_has_policy CHECK (cron_expr IS NOT NULL OR interval_seconds IS NOT NULL),
  CONSTRAINT scrape_schedules_runtime_positive CHECK (max_runtime_seconds > 0),
  CONSTRAINT scrape_schedules_retries_nonnegative CHECK (max_retries >= 0),
  CONSTRAINT scrape_schedules_jitter_nonnegative CHECK (jitter_seconds >= 0)
);

CREATE TABLE IF NOT EXISTS ops.scrape_runs (
  run_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id         uuid NOT NULL REFERENCES registry.scrape_targets(target_id) ON UPDATE CASCADE ON DELETE CASCADE,
  agency_id         uuid NOT NULL REFERENCES registry.agencies(agency_id) ON UPDATE CASCADE ON DELETE CASCADE,
  state_code        char(2) NOT NULL REFERENCES registry.states(state_code) ON UPDATE CASCADE,
  agent_profile_id  uuid REFERENCES ops.agent_profiles(agent_profile_id) ON UPDATE CASCADE ON DELETE SET NULL,
  status            text NOT NULL DEFAULT 'queued',
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  records_seen      integer,
  records_emitted   integer,
  error_code        text,
  error_message     text,
  worker_id         text,
  trace             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT scrape_runs_status_allowed CHECK (
    status IN ('queued', 'running', 'success', 'failed', 'timeout', 'cancelled', 'skipped')
  ),
  CONSTRAINT scrape_runs_records_seen_nonnegative CHECK (records_seen IS NULL OR records_seen >= 0),
  CONSTRAINT scrape_runs_records_emitted_nonnegative CHECK (records_emitted IS NULL OR records_emitted >= 0),
  CONSTRAINT scrape_runs_finished_after_start CHECK (finished_at IS NULL OR finished_at >= started_at)
);

CREATE TABLE IF NOT EXISTS ops.raw_payloads (
  payload_id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id                uuid NOT NULL REFERENCES ops.scrape_runs(run_id) ON UPDATE CASCADE ON DELETE CASCADE,
  target_id             uuid NOT NULL REFERENCES registry.scrape_targets(target_id) ON UPDATE CASCADE ON DELETE CASCADE,
  state_code            char(2) NOT NULL REFERENCES registry.states(state_code) ON UPDATE CASCADE,
  payload_kind          text NOT NULL DEFAULT 'source',
  content_type          text,
  source_url            text,
  raw_payload           text NOT NULL,
  raw_sha256            text GENERATED ALWAYS AS (encode(digest(raw_payload, 'sha256'), 'hex')) STORED,
  captured_at           timestamptz NOT NULL DEFAULT now(),
  agent_extracted_json  jsonb,
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT raw_payloads_kind_allowed CHECK (payload_kind IN ('source', 'agent_output', 'download', 'snapshot', 'other')),
  CONSTRAINT raw_payloads_sha_unique UNIQUE (target_id, raw_sha256)
);

CREATE TABLE IF NOT EXISTS ops.normalization_jobs (
  job_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payload_id     uuid NOT NULL REFERENCES ops.raw_payloads(payload_id) ON UPDATE CASCADE ON DELETE CASCADE,
  state_code     char(2) NOT NULL REFERENCES registry.states(state_code) ON UPDATE CASCADE,
  target_type    text NOT NULL,
  status         text NOT NULL DEFAULT 'queued',
  attempts       integer NOT NULL DEFAULT 0,
  available_at   timestamptz NOT NULL DEFAULT now(),
  locked_at      timestamptz,
  locked_by      text,
  finished_at    timestamptz,
  error_message  text,
  metadata       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT normalization_jobs_status_allowed CHECK (
    status IN ('queued', 'running', 'success', 'failed', 'dead')
  ),
  CONSTRAINT normalization_jobs_attempts_nonnegative CHECK (attempts >= 0),
  CONSTRAINT normalization_jobs_finished_after_available CHECK (finished_at IS NULL OR finished_at >= available_at),
  CONSTRAINT normalization_jobs_payload_unique UNIQUE (payload_id)
);

CREATE TABLE IF NOT EXISTS ops.target_health (
  target_id             uuid PRIMARY KEY REFERENCES registry.scrape_targets(target_id) ON UPDATE CASCADE ON DELETE CASCADE,
  state_code            char(2) NOT NULL REFERENCES registry.states(state_code) ON UPDATE CASCADE,
  last_run_id           uuid REFERENCES ops.scrape_runs(run_id) ON UPDATE CASCADE ON DELETE SET NULL,
  last_success_at       timestamptz,
  last_failure_at       timestamptz,
  consecutive_failures  integer NOT NULL DEFAULT 0,
  health_status         text NOT NULL DEFAULT 'unknown',
  last_error_message    text,
  metadata              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT target_health_status_allowed CHECK (health_status IN ('unknown', 'healthy', 'degraded', 'failed', 'paused')),
  CONSTRAINT target_health_failures_nonnegative CHECK (consecutive_failures >= 0)
);

ALTER TABLE registry.counties
  DROP CONSTRAINT IF EXISTS counties_state_fips_match;

ALTER TABLE registry.counties
  ADD CONSTRAINT counties_state_fips_match CHECK (left(county_fips, 2) = registry.state_code_to_fips(state_code));

CREATE INDEX IF NOT EXISTS idx_counties_state_name
  ON registry.counties(state_code, county_name);

CREATE INDEX IF NOT EXISTS idx_agencies_state_type_status
  ON registry.agencies(state_code, agency_type, status);

CREATE INDEX IF NOT EXISTS idx_agencies_county
  ON registry.agencies(county_id)
  WHERE county_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_agencies_state_ori_unique
  ON registry.agencies(state_code, ori_code)
  WHERE ori_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_scrape_targets_state_type_enabled
  ON registry.scrape_targets(state_code, target_type, is_enabled);

CREATE INDEX IF NOT EXISTS idx_scrape_targets_agency
  ON registry.scrape_targets(agency_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_scrape_targets_agency_url_type_unique
  ON registry.scrape_targets(agency_id, source_url, target_type);

CREATE INDEX IF NOT EXISTS idx_agent_profiles_enabled
  ON ops.agent_profiles(is_enabled, profile_key);

CREATE INDEX IF NOT EXISTS idx_scrape_schedules_due
  ON ops.scrape_schedules(next_run_at, is_paused)
  WHERE next_run_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_scrape_schedules_target
  ON ops.scrape_schedules(target_id);

CREATE INDEX IF NOT EXISTS idx_scrape_runs_target_started
  ON ops.scrape_runs(target_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_scrape_runs_state_status_started
  ON ops.scrape_runs(state_code, status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_raw_payloads_run
  ON ops.raw_payloads(run_id);

CREATE INDEX IF NOT EXISTS idx_raw_payloads_target_captured
  ON ops.raw_payloads(target_id, captured_at DESC);

CREATE INDEX IF NOT EXISTS idx_normalization_jobs_claim
  ON ops.normalization_jobs(status, available_at, job_id)
  WHERE status IN ('queued', 'failed');

CREATE INDEX IF NOT EXISTS idx_normalization_jobs_locked
  ON ops.normalization_jobs(locked_by, locked_at)
  WHERE locked_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_target_health_state_status
  ON ops.target_health(state_code, health_status);

DROP TRIGGER IF EXISTS trg_states_touch_updated_at ON registry.states;
CREATE TRIGGER trg_states_touch_updated_at
BEFORE UPDATE ON registry.states
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

DROP TRIGGER IF EXISTS trg_counties_touch_updated_at ON registry.counties;
CREATE TRIGGER trg_counties_touch_updated_at
BEFORE UPDATE ON registry.counties
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

DROP TRIGGER IF EXISTS trg_agencies_touch_updated_at ON registry.agencies;
CREATE TRIGGER trg_agencies_touch_updated_at
BEFORE UPDATE ON registry.agencies
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

DROP TRIGGER IF EXISTS trg_scrape_targets_touch_updated_at ON registry.scrape_targets;
CREATE TRIGGER trg_scrape_targets_touch_updated_at
BEFORE UPDATE ON registry.scrape_targets
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

DROP TRIGGER IF EXISTS trg_agent_profiles_touch_updated_at ON ops.agent_profiles;
CREATE TRIGGER trg_agent_profiles_touch_updated_at
BEFORE UPDATE ON ops.agent_profiles
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

DROP TRIGGER IF EXISTS trg_scrape_schedules_touch_updated_at ON ops.scrape_schedules;
CREATE TRIGGER trg_scrape_schedules_touch_updated_at
BEFORE UPDATE ON ops.scrape_schedules
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

DROP TRIGGER IF EXISTS trg_normalization_jobs_touch_updated_at ON ops.normalization_jobs;
CREATE TRIGGER trg_normalization_jobs_touch_updated_at
BEFORE UPDATE ON ops.normalization_jobs
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

DROP TRIGGER IF EXISTS trg_target_health_touch_updated_at ON ops.target_health;
CREATE TRIGGER trg_target_health_touch_updated_at
BEFORE UPDATE ON ops.target_health
FOR EACH ROW EXECUTE FUNCTION ops.touch_updated_at();

ALTER TABLE registry.states ENABLE ROW LEVEL SECURITY;
ALTER TABLE registry.counties ENABLE ROW LEVEL SECURITY;
ALTER TABLE registry.agencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE registry.scrape_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.scrape_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.scrape_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.raw_payloads ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.normalization_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ops.target_health ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS states_state_isolation ON registry.states;
CREATE POLICY states_state_isolation ON registry.states
USING (
  state_code = current_setting('app.current_state_id', true)
  OR current_setting('app.current_state_id', true) = '*'
)
WITH CHECK (
  state_code = current_setting('app.current_state_id', true)
  OR current_setting('app.current_state_id', true) = '*'
);

DROP POLICY IF EXISTS counties_state_isolation ON registry.counties;
CREATE POLICY counties_state_isolation ON registry.counties
USING (
  state_code = current_setting('app.current_state_id', true)
  OR current_setting('app.current_state_id', true) = '*'
)
WITH CHECK (
  state_code = current_setting('app.current_state_id', true)
  OR current_setting('app.current_state_id', true) = '*'
);

DROP POLICY IF EXISTS agencies_state_isolation ON registry.agencies;
CREATE POLICY agencies_state_isolation ON registry.agencies
USING (
  state_code = current_setting('app.current_state_id', true)
  OR current_setting('app.current_state_id', true) = '*'
)
WITH CHECK (
  state_code = current_setting('app.current_state_id', true)
  OR current_setting('app.current_state_id', true) = '*'
);

DROP POLICY IF EXISTS scrape_targets_state_isolation ON registry.scrape_targets;
CREATE POLICY scrape_targets_state_isolation ON registry.scrape_targets
USING (
  state_code = current_setting('app.current_state_id', true)
  OR current_setting('app.current_state_id', true) = '*'
)
WITH CHECK (
  state_code = current_setting('app.current_state_id', true)
  OR current_setting('app.current_state_id', true) = '*'
);

DROP POLICY IF EXISTS scrape_schedules_state_isolation ON ops.scrape_schedules;
CREATE POLICY scrape_schedules_state_isolation ON ops.scrape_schedules
USING (
  state_code = current_setting('app.current_state_id', true)
  OR current_setting('app.current_state_id', true) = '*'
)
WITH CHECK (
  state_code = current_setting('app.current_state_id', true)
  OR current_setting('app.current_state_id', true) = '*'
);

DROP POLICY IF EXISTS scrape_runs_state_isolation ON ops.scrape_runs;
CREATE POLICY scrape_runs_state_isolation ON ops.scrape_runs
USING (
  state_code = current_setting('app.current_state_id', true)
  OR current_setting('app.current_state_id', true) = '*'
)
WITH CHECK (
  state_code = current_setting('app.current_state_id', true)
  OR current_setting('app.current_state_id', true) = '*'
);

DROP POLICY IF EXISTS raw_payloads_state_isolation ON ops.raw_payloads;
CREATE POLICY raw_payloads_state_isolation ON ops.raw_payloads
USING (
  state_code = current_setting('app.current_state_id', true)
  OR current_setting('app.current_state_id', true) = '*'
)
WITH CHECK (
  state_code = current_setting('app.current_state_id', true)
  OR current_setting('app.current_state_id', true) = '*'
);

DROP POLICY IF EXISTS normalization_jobs_state_isolation ON ops.normalization_jobs;
CREATE POLICY normalization_jobs_state_isolation ON ops.normalization_jobs
USING (
  state_code = current_setting('app.current_state_id', true)
  OR current_setting('app.current_state_id', true) = '*'
)
WITH CHECK (
  state_code = current_setting('app.current_state_id', true)
  OR current_setting('app.current_state_id', true) = '*'
);

DROP POLICY IF EXISTS target_health_state_isolation ON ops.target_health;
CREATE POLICY target_health_state_isolation ON ops.target_health
USING (
  state_code = current_setting('app.current_state_id', true)
  OR current_setting('app.current_state_id', true) = '*'
)
WITH CHECK (
  state_code = current_setting('app.current_state_id', true)
  OR current_setting('app.current_state_id', true) = '*'
);

INSERT INTO registry.states (state_code, state_name, state_fips, slug)
VALUES
  ('AL', 'Alabama', '01', 'alabama'),
  ('AK', 'Alaska', '02', 'alaska'),
  ('AZ', 'Arizona', '04', 'arizona'),
  ('AR', 'Arkansas', '05', 'arkansas'),
  ('CA', 'California', '06', 'california'),
  ('CO', 'Colorado', '08', 'colorado'),
  ('CT', 'Connecticut', '09', 'connecticut'),
  ('DE', 'Delaware', '10', 'delaware'),
  ('DC', 'District of Columbia', '11', 'district-of-columbia'),
  ('FL', 'Florida', '12', 'florida'),
  ('GA', 'Georgia', '13', 'georgia'),
  ('HI', 'Hawaii', '15', 'hawaii'),
  ('ID', 'Idaho', '16', 'idaho'),
  ('IL', 'Illinois', '17', 'illinois'),
  ('IN', 'Indiana', '18', 'indiana'),
  ('IA', 'Iowa', '19', 'iowa'),
  ('KS', 'Kansas', '20', 'kansas'),
  ('KY', 'Kentucky', '21', 'kentucky'),
  ('LA', 'Louisiana', '22', 'louisiana'),
  ('ME', 'Maine', '23', 'maine'),
  ('MD', 'Maryland', '24', 'maryland'),
  ('MA', 'Massachusetts', '25', 'massachusetts'),
  ('MI', 'Michigan', '26', 'michigan'),
  ('MN', 'Minnesota', '27', 'minnesota'),
  ('MS', 'Mississippi', '28', 'mississippi'),
  ('MO', 'Missouri', '29', 'missouri'),
  ('MT', 'Montana', '30', 'montana'),
  ('NE', 'Nebraska', '31', 'nebraska'),
  ('NV', 'Nevada', '32', 'nevada'),
  ('NH', 'New Hampshire', '33', 'new-hampshire'),
  ('NJ', 'New Jersey', '34', 'new-jersey'),
  ('NM', 'New Mexico', '35', 'new-mexico'),
  ('NY', 'New York', '36', 'new-york'),
  ('NC', 'North Carolina', '37', 'north-carolina'),
  ('ND', 'North Dakota', '38', 'north-dakota'),
  ('OH', 'Ohio', '39', 'ohio'),
  ('OK', 'Oklahoma', '40', 'oklahoma'),
  ('OR', 'Oregon', '41', 'oregon'),
  ('PA', 'Pennsylvania', '42', 'pennsylvania'),
  ('RI', 'Rhode Island', '44', 'rhode-island'),
  ('SC', 'South Carolina', '45', 'south-carolina'),
  ('SD', 'South Dakota', '46', 'south-dakota'),
  ('TN', 'Tennessee', '47', 'tennessee'),
  ('TX', 'Texas', '48', 'texas'),
  ('UT', 'Utah', '49', 'utah'),
  ('VT', 'Vermont', '50', 'vermont'),
  ('VA', 'Virginia', '51', 'virginia'),
  ('WA', 'Washington', '53', 'washington'),
  ('WV', 'West Virginia', '54', 'west-virginia'),
  ('WI', 'Wisconsin', '55', 'wisconsin'),
  ('WY', 'Wyoming', '56', 'wyoming')
ON CONFLICT (state_code) DO UPDATE SET
  state_name = EXCLUDED.state_name,
  state_fips = EXCLUDED.state_fips,
  slug = EXCLUDED.slug;

COMMIT;
