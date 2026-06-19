# National Registry And Operations Schema Design

## Scope

This first pass defines the PostgreSQL schema for the national agency registry and scraper operations layer used by `admin.blotter.host`.

It intentionally does not define final normalized incident, booking, inmate, charge, or public display tables. Those tables will be added in a later migration after the raw ingestion and normalization queue shape is stable.

## Goals

- Track the hierarchy from state to county to law enforcement agency.
- Track one or more public scrape targets per agency.
- Assign reusable agent profiles to targets without hard-coded selectors.
- Record scraper schedules, run history, latest health, raw payloads, and normalization queue state.
- Preserve each raw payload unmodified for compliance and auditability.
- Keep all operational tables lightweight enough for parallel workers.
- Support state-aware row-level security through the existing `app.current_state_id` PostgreSQL setting.

## Non-Goals

- No crawler implementation in this migration.
- No normalized incident or booking fact tables in this migration.
- No irreversible assumptions about vendor-specific field layouts.
- No heavy queue dependency such as Redis, BullMQ, or Kafka.

## Schema Layout

The schema uses two PostgreSQL namespaces:

- `registry`: stable public-record source directory.
- `ops`: scraper scheduling, execution, payload, and health tracking.

## Registry Tables

### `registry.states`

Authoritative state table keyed by two-letter postal code.

Important columns:

- `state_code`
- `state_name`
- `state_fips`
- `slug`
- `is_enabled`
- `metadata`

### `registry.counties`

State-scoped county registry.

Important columns:

- `state_code`
- `county_fips`
- `county_name`
- `slug`
- `county_seat`
- `centroid_lat`
- `centroid_lng`
- `metadata`

County uniqueness is enforced by `(state_code, county_fips)` and by `(state_code, slug)`.

### `registry.agencies`

Directory of county sheriffs, municipal police departments, jails, detention centers, state agencies, and other law enforcement entities.

Important columns:

- `state_code`
- `county_id`
- `agency_name`
- `agency_type`
- `jurisdiction_type`
- `ori_code`
- `ncic_code`
- `website_url`
- `contact_phone`
- `status`
- `metadata`

Agencies are not forced to have a county because state agencies and multi-county agencies exist.

### `registry.scrape_targets`

One row per public data source.

Examples:

- County jail roster URL.
- Municipal calls-for-service page.
- ArcGIS FeatureServer endpoint.
- Daily police blotter PDF feed.
- Vendor portal landing page for agent navigation.

Important columns:

- `agency_id`
- `state_code`
- `target_type`
- `source_url`
- `vendor_hint`
- `access_method`
- `expected_payload_type`
- `agent_profile_id`
- `is_enabled`
- `priority`
- `metadata`

The table stores source hints, not brittle selectors. Agent definitions decide how to navigate and extract.

## Operations Tables

### `ops.agent_profiles`

Reusable agent definitions for target classes.

Examples:

- `zuercher_jail_roster`
- `tyler_calls_for_service`
- `arcgis_incident_feed`
- `pdf_daily_blotter`
- `generic_public_records_discovery`

Important columns:

- `profile_key`
- `display_name`
- `agent_engine`
- `mission_path`
- `soul_path`
- `definition`
- `pii_policy`
- `output_schema`
- `is_enabled`

`definition`, `pii_policy`, and `output_schema` use `jsonb` to support OpenClaw/Kimi-style missions without schema churn.

### `ops.scrape_schedules`

Dispatch policy per target.

Important columns:

- `target_id`
- `cron_expr`
- `interval_seconds`
- `timezone`
- `max_runtime_seconds`
- `max_retries`
- `jitter_seconds`
- `is_paused`
- `next_run_at`

A target can be scheduled by cron expression or fixed interval. Workers use `next_run_at` for cheap dispatch scans.

### `ops.scrape_runs`

Immutable run ledger.

Important columns:

- `run_id`
- `target_id`
- `agency_id`
- `state_code`
- `agent_profile_id`
- `status`
- `started_at`
- `finished_at`
- `records_seen`
- `records_emitted`
- `error_code`
- `error_message`
- `worker_id`
- `trace`

This table supports debugging, run history, and metrics. It does not store raw payload bodies.

### `ops.raw_payloads`

Compliance and audit store for unmodified source output.

Important columns:

- `payload_id`
- `run_id`
- `target_id`
- `state_code`
- `payload_kind`
- `content_type`
- `source_url`
- `raw_payload`
- `raw_sha256`
- `captured_at`
- `agent_extracted_json`
- `metadata`

`raw_payload` must be inserted exactly as fetched or emitted by the scraping agent. Any redacted or normalized representation belongs in separate fields or downstream normalized tables.

### `ops.normalization_jobs`

Minimal queue for normalizing raw payloads into public-record tables.

Important columns:

- `job_id`
- `payload_id`
- `state_code`
- `target_type`
- `status`
- `attempts`
- `available_at`
- `locked_at`
- `locked_by`
- `finished_at`
- `error_message`

Workers claim jobs with row locks and `SKIP LOCKED`, keeping execution dependency-light.

### `ops.target_health`

Latest target status rollup for dashboards and dispatch decisions.

Important columns:

- `target_id`
- `state_code`
- `last_run_id`
- `last_success_at`
- `last_failure_at`
- `consecutive_failures`
- `health_status`
- `last_error_message`
- `updated_at`

This table avoids scanning `ops.scrape_runs` for common admin dashboard views.

## State Isolation

Every table that contains state-specific records includes `state_code`.

RLS policies should match the existing application convention:

```sql
state_code = current_setting('app.current_state_id', true)
OR current_setting('app.current_state_id', true) = '*'
```

Cross-state admin routes use the wildcard context already exposed by `db.adminQuery`.

## Data Flow

1. Admin or seed process creates states, counties, agencies, scrape targets, and schedules.
2. Dispatcher selects due targets from `ops.scrape_schedules`.
3. Worker runs the target's assigned `ops.agent_profiles` definition.
4. Worker creates one `ops.scrape_runs` row.
5. Worker writes one or more `ops.raw_payloads` rows with unmodified payload bodies.
6. Worker creates one `ops.normalization_jobs` row per payload.
7. Health rollup is updated in `ops.target_health`.
8. Normalization workers claim jobs and produce downstream normalized records in a future schema.

## Error Handling

- Failed scraper runs remain in `ops.scrape_runs` with `status = 'failed'`.
- Timeout and retry policy lives in `ops.scrape_schedules`.
- Consecutive failures are tracked in `ops.target_health`.
- Raw payload insert failures should fail the run because raw preservation is a compliance requirement.
- Normalization failures do not mutate raw payloads; they only update `ops.normalization_jobs`.

## Indexing Strategy

Indexes should favor dispatch and dashboard reads:

- Due schedules by `next_run_at`.
- Targets by `state_code`, `agency_id`, and `target_type`.
- Runs by `target_id` and `started_at`.
- Payloads by `run_id`, `target_id`, and `raw_sha256`.
- Normalization jobs by `status` and `available_at`.
- Health by `state_code` and `health_status`.

## Implementation Notes

- Use generated UUIDs with `gen_random_uuid()`.
- Use `jsonb` for source metadata, agent definitions, extraction JSON, and trace data.
- Use constrained text checks for enums rather than PostgreSQL enum types, so future statuses and source types can be changed with lighter migrations.
- Keep SQL idempotent with `CREATE SCHEMA IF NOT EXISTS`, `CREATE TABLE IF NOT EXISTS`, and named indexes.
- Do not migrate the existing SQLite control-room tables in this first pass. The new PostgreSQL operations layer can coexist until the admin UI is wired to it.

## Acceptance Criteria

- A PostgreSQL migration can create all registry and operations tables from an empty database.
- RLS is enabled on state-scoped tables.
- Admin wildcard queries can read all state-scoped rows.
- Tenant queries can read only matching `state_code` rows.
- Raw payload rows preserve unmodified payload text.
- Dispatch workers can claim due schedules and normalization jobs without a separate queue service.
