# National Registry Operations Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a local PostgreSQL migration for the national agency registry and scraper operations layer.

**Architecture:** Add one idempotent SQL migration under `sql/` that creates `registry` and `ops` schemas, state-aware tables, indexes, RLS policies, and trigger helpers. Keep the migration standalone so it can be run with `psql` and does not require a Node migration framework.

**Tech Stack:** PostgreSQL, SQL, existing `pg.js` RLS context convention using `app.current_state_id`.

---

### Task 1: Create Migration Skeleton

**Files:**
- Create: `/root/blotter-host/sql/001_national_registry_ops.sql`

- [ ] **Step 1: Write the migration header and extension setup**

```sql
-- 001_national_registry_ops.sql
-- National registry and scraper operations schema for America's Transparency Public Data Portal.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS registry;
CREATE SCHEMA IF NOT EXISTS ops;

COMMIT;
```

- [ ] **Step 2: Verify basic SQL can be parsed**

Run: `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f /root/blotter-host/sql/001_national_registry_ops.sql`

Expected: succeeds when `DATABASE_URL` points to a PostgreSQL database where extensions can be created.

### Task 2: Add Registry Tables

**Files:**
- Modify: `/root/blotter-host/sql/001_national_registry_ops.sql`

- [ ] **Step 1: Add `registry.states`, `registry.counties`, `registry.agencies`, and `registry.scrape_targets`**

Use `state_code` on every state-scoped table. Add foreign keys from counties to states, agencies to counties, and targets to agencies.

- [ ] **Step 2: Add indexes for registry lookup**

Create indexes for county/state lookup, agency state/type/status lookup, target agency lookup, target due-source lookup, and URL uniqueness.

### Task 3: Add Operations Tables

**Files:**
- Modify: `/root/blotter-host/sql/001_national_registry_ops.sql`

- [ ] **Step 1: Add `ops.agent_profiles`**

Store agent engine, mission path, soul path, JSON definitions, PII policy, and output schema.

- [ ] **Step 2: Add `ops.scrape_schedules`**

Store cron or interval scheduling, pause state, timeout/retry policy, jitter, and `next_run_at`.

- [ ] **Step 3: Add `ops.scrape_runs`**

Store the immutable run ledger with status, counters, worker metadata, and trace JSON.

- [ ] **Step 4: Add `ops.raw_payloads`**

Store unmodified `raw_payload`, derived `raw_sha256`, extracted JSON, source URL, content type, and capture timestamp.

- [ ] **Step 5: Add `ops.normalization_jobs`**

Store the lightweight queue for downstream normalization workers.

- [ ] **Step 6: Add `ops.target_health`**

Store latest target health rollup for admin dashboard queries.

### Task 4: Add RLS And Helpers

**Files:**
- Modify: `/root/blotter-host/sql/001_national_registry_ops.sql`

- [ ] **Step 1: Create `ops.touch_updated_at()`**

Create a trigger function that refreshes `updated_at` on mutable tables.

- [ ] **Step 2: Add update triggers**

Attach `ops.touch_updated_at()` to states, counties, agencies, scrape targets, agent profiles, schedules, normalization jobs, and target health.

- [ ] **Step 3: Enable RLS on state-scoped tables**

Enable RLS on tables containing `state_code`.

- [ ] **Step 4: Add tenant isolation policies**

Add policies matching:

```sql
state_code = current_setting('app.current_state_id', true)
OR current_setting('app.current_state_id', true) = '*'
```

For `ops.agent_profiles`, do not enable RLS because profiles are reusable global definitions.

### Task 5: Verification

**Files:**
- Read: `/root/blotter-host/sql/001_national_registry_ops.sql`

- [ ] **Step 1: Check for placeholders**

Run: `rg -n "TBD|TODO|placeholder|FIXME" /root/blotter-host/sql/001_national_registry_ops.sql`

Expected: no matches.

- [ ] **Step 2: Check migration structure**

Run: `rg -n "CREATE TABLE|ALTER TABLE .*ENABLE ROW LEVEL SECURITY|CREATE POLICY|CREATE INDEX|CREATE TRIGGER" /root/blotter-host/sql/001_national_registry_ops.sql`

Expected: output shows all planned tables, indexes, policies, and triggers.

- [ ] **Step 3: Optionally apply to a configured local PostgreSQL database**

Run: `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f /root/blotter-host/sql/001_national_registry_ops.sql`

Expected: succeeds if `DATABASE_URL` is configured and the database user can create `pgcrypto`.

## Notes

- Do not stage, commit, push, or publish this project.
- Do not migrate the existing SQLite control-room database in this pass.
- Do not add normalized incident or booking fact tables in this pass.
