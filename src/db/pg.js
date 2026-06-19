'use strict';

/**
 * pg.js — Dynamic-Context Database Wrapper
 * -----------------------------------------
 * The single seam between route handlers and PostgreSQL. Every public query
 * goes through one of:
 *
 *   db.tenantQuery(stateCode, sql, params)  // sets RLS context to <stateCode>
 *   db.adminQuery(sql, params)              // sets RLS context to '*' (no isolation)
 *   db.txn(stateCode, async (client) => …)  // explicit multi-statement transaction
 *
 * Internally each call:
 *   1. acquires a client from the pool
 *   2. BEGIN
 *   3. SELECT set_config('app.current_state_id', <value>, true)
 *   4. runs the caller's SQL
 *   5. COMMIT  (or ROLLBACK on error)
 *   6. releases the client
 *
 * The pool is created lazily so that requiring this module from a context
 * without DATABASE_URL set (e.g. unit tests) doesn't throw. If no DATABASE_URL
 * is configured, query helpers return a structured { ok: false, error } result
 * instead of throwing — the route layer can detect that and render a 503.
 *
 * Assumed RLS policy (created by the schema migration, not by this file):
 *
 *   CREATE POLICY tenant_isolation ON <table>
 *     USING (
 *       state_code = current_setting('app.current_state_id', true)
 *       OR current_setting('app.current_state_id', true) = '*'
 *     );
 *
 * 'app.current_state_id' is missing outside a transaction where SET LOCAL
 * hasn't been issued; the `, true` second arg to current_setting() makes
 * that case return NULL instead of erroring.
 */

const stateRegistry = require('../data/state-registry');

// Sentinel value for queries that are allowed to see every state's rows.
const WILDCARD = '*';

// Module-level pool reference. Null until first use (or until DATABASE_URL is set).
let pool = null;
let poolConfig = null;
let poolError = null;

function buildPoolConfig() {
  if (process.env.DATABASE_URL) {
    return {
      connectionString: process.env.DATABASE_URL,
      max: parseInt(process.env.PG_POOL_MAX, 10) || 10,
      idleTimeoutMillis: parseInt(process.env.PG_IDLE_MS, 10) || 30_000,
      connectionTimeoutMillis: parseInt(process.env.PG_CONNECT_MS, 10) || 5_000,
    };
  }
  // Fall back to discrete PG* env vars if no DATABASE_URL.
  const host = process.env.PGHOST;
  if (host) {
    return {
      host,
      port: parseInt(process.env.PGPORT, 10) || 5432,
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      database: process.env.PGDATABASE,
      max: parseInt(process.env.PG_POOL_MAX, 10) || 10,
      idleTimeoutMillis: parseInt(process.env.PG_IDLE_MS, 10) || 30_000,
      connectionTimeoutMillis: parseInt(process.env.PG_CONNECT_MS, 10) || 5_000,
    };
  }
  return null;
}

function getPool() {
  if (pool) return pool;
  if (poolError) return null;
  const cfg = buildPoolConfig();
  if (!cfg) {
    poolError = new Error(
      'No database configured. Set DATABASE_URL (or PGHOST/PGUSER/PGPASSWORD/PGDATABASE).'
    );
    return null;
  }
  try {
    // Lazy-require so the module loads even if `pg` is not installed.
    // In a healthy deployment `pg` is in package.json; this branch only fires
    // during local hacking or test runs.
    const { Pool } = require('pg');
    poolConfig = cfg;
    pool = new Pool(cfg);
    pool.on('error', (err) => {
      console.error('[pg] idle client error:', err.message);
    });
    return pool;
  } catch (err) {
    poolError = err;
    console.error('[pg] failed to initialize pool:', err.message);
    return null;
  }
}

function isConfigured() {
  return buildPoolConfig() !== null;
}

/**
 * Apply the tenant-context GUC inside an already-open transaction.
 * We use `SELECT set_config(name, value, is_local)` so the value is
 * parameterized — the GUC name is fixed, but the value is data.
 */
async function applyContext(client, value) {
  await client.query("SELECT set_config('app.current_state_id', $1, true)", [value]);
}

/**
 * Run a single query under a tenant context.
 * @param {string} stateCode   two-letter state code, or '*' for admin
 * @param {string} text        parameterized SQL
 * @param {Array}  [params]    bind values
 */
async function tenantQuery(stateCode, text, params = []) {
  const p = getPool();
  if (!p) {
    return {
      ok: false,
      error: poolError ? poolError.message : 'pg pool unavailable',
      rows: [],
      rowCount: 0,
    };
  }

  if (stateCode !== WILDCARD) {
    if (typeof stateCode !== 'string' || !stateRegistry.STATE_CODE_RE.test(stateCode)) {
      const e = new Error('Invalid state code: ' + JSON.stringify(stateCode));
      e.code = 'INVALID_STATE_CODE';
      throw e;
    }
    if (!stateRegistry.getByCode(stateCode)) {
      const e = new Error('Unknown state code (not in registry): ' + stateCode);
      e.code = 'UNKNOWN_STATE_CODE';
      throw e;
    }
  }

  const client = await p.connect().catch((err) => {
    poolError = err;
    return null;
  });
  if (!client) {
    return {
      ok: false,
      error: 'could not acquire pg client: ' + (poolError ? poolError.message : 'unknown'),
      code: poolError && poolError.code,
      rows: [],
      rowCount: 0,
    };
  }

  try {
    await client.query('BEGIN');
    await applyContext(client, stateCode);
    const result = await client.query(text, params);
    await client.query('COMMIT');
    return { ok: true, rows: result.rows, rowCount: result.rowCount || 0 };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_e) { /* ignore */ }
    return { ok: false, error: err.message, code: err.code, rows: [], rowCount: 0 };
  } finally {
    client.release();
  }
}

/**
 * Run a query that is allowed to see every state (cross-state search,
 * network-wide metrics, etc.). Equivalent to `tenantQuery('*', …)`.
 */
function adminQuery(text, params = []) {
  return tenantQuery(WILDCARD, text, params);
}

/**
 * Open a transaction, apply the tenant context, hand the client to the
 * caller's async function, then COMMIT (or ROLLBACK if the function throws).
 *
 *   const { rows } = await db.txn('WA', async (c) => {
 *     await c.query('INSERT INTO blotters …', […]);
 *     const r = await c.query('SELECT … RETURNING id');
 *     return r.rows[0];
 *   });
 */
async function txn(stateCode, work) {
  const p = getPool();
  if (!p) throw poolError || new Error('pg pool unavailable');

  if (stateCode !== WILDCARD) {
    if (typeof stateCode !== 'string' || !stateRegistry.STATE_CODE_RE.test(stateCode)) {
      const e = new Error('Invalid state code: ' + JSON.stringify(stateCode));
      e.code = 'INVALID_STATE_CODE';
      throw e;
    }
  }

  const client = await p.connect();
  try {
    await client.query('BEGIN');
    await applyContext(client, stateCode);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_e) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

async function saveRawRecord(state, type, textPayload, fingerprint) {
  const normalizedState = String(state || '').trim();
  const normalizedType = String(type || '').trim();
  const normalizedText = String(textPayload || '').trim();
  const normalizedFingerprint = String(fingerprint || '').trim();

  if (!normalizedState || !normalizedType || !normalizedText || !normalizedFingerprint) {
    throw new Error('state, type, textPayload, and fingerprint are required');
  }

  const result = await adminQuery(
    `
      INSERT INTO raw_records (
        state,
        source_type,
        raw_text,
        fingerprint,
        created_at
      ) VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (state, fingerprint) DO NOTHING
      RETURNING id
    `,
    [normalizedState, normalizedType, normalizedText, normalizedFingerprint]
  );

  if (!result.ok) {
    throw new Error(result.error || 'raw_records insert failed');
  }

  return {
    inserted: result.rowCount > 0,
    id: result.rows[0] ? result.rows[0].id : null,
  };
}

async function healthCheck() {
  const p = getPool();
  if (!p) return { ok: false, error: poolError ? poolError.message : 'not configured' };
  const client = await p.connect().catch((err) => ({ error: err }));
  if (!client || client.error) {
    return { ok: false, error: client ? client.error.message : 'connect failed' };
  }
  try {
    const r = await client.query(
      "SELECT 1 AS one, current_setting('app.current_state_id', true) AS ctx"
    );
    return {
      ok: true,
      one: r.rows[0].one,
      poolMax: poolConfig ? poolConfig.max : null,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    if (client && typeof client.release === 'function') client.release();
  }
}

async function close() {
  if (!pool) return;
  await pool.end();
  pool = null;
}

async function initializeDatabase() {
  // Each table is bootstrapped in its own transaction so a single missing
  // column or failed index on one table can't poison the rest. Idempotent
  // everywhere — safe to call on every startup.
  const statements = [
    // raw_records: bring existing tables up to the columns the app expects
    'ALTER TABLE raw_records ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ',
    'ALTER TABLE raw_records ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()',
    'ALTER TABLE raw_records ADD COLUMN IF NOT EXISTS county TEXT',
    // raw_records: create-if-missing (no-op if columns were just added above)
    `CREATE TABLE IF NOT EXISTS raw_records (
      id BIGSERIAL PRIMARY KEY,
      state TEXT NOT NULL,
      county TEXT,
      source_type TEXT,
      source_url TEXT,
      source_name TEXT,
      fingerprint TEXT NOT NULL UNIQUE,
      raw_text TEXT NOT NULL,
      raw_html TEXT,
      raw_payload JSONB,
      processed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    'CREATE INDEX IF NOT EXISTS idx_raw_records_state_created_at ON raw_records (state, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_raw_records_state_fingerprint ON raw_records (state, fingerprint)',
    'CREATE INDEX IF NOT EXISTS idx_raw_records_state_source_type_created_at ON raw_records (state, source_type, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_raw_records_processed_at ON raw_records (processed_at)',
    'CREATE INDEX IF NOT EXISTS idx_raw_records_state_county_created_at ON raw_records (state, county, created_at DESC)',
  ];

  const generatedStatements = [
    `CREATE TABLE IF NOT EXISTS generated_articles (
      id BIGSERIAL PRIMARY KEY,
      raw_record_id BIGINT NOT NULL REFERENCES raw_records(id) ON DELETE CASCADE,
      state TEXT NOT NULL,
      county TEXT,
      headline TEXT NOT NULL,
      headline_fingerprint TEXT,
      body TEXT NOT NULL,
      categories JSONB,
      publication_status TEXT NOT NULL DEFAULT 'draft',
      published_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
    'ALTER TABLE generated_articles ADD COLUMN IF NOT EXISTS headline_fingerprint TEXT',
    'ALTER TABLE generated_articles ADD COLUMN IF NOT EXISTS categories JSONB',
    'ALTER TABLE generated_articles ADD COLUMN IF NOT EXISTS county TEXT',
    'CREATE INDEX IF NOT EXISTS idx_generated_articles_state_created_at ON generated_articles (state, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_generated_articles_state_publication_status_created_at ON generated_articles (state, publication_status, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_generated_articles_raw_record_id ON generated_articles (raw_record_id)',
    'CREATE INDEX IF NOT EXISTS idx_generated_articles_state_headline_fingerprint ON generated_articles (state, headline_fingerprint)',
    'CREATE INDEX IF NOT EXISTS idx_generated_articles_state_county_created_at ON generated_articles (state, county, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_generated_articles_county_created_at ON generated_articles (county, created_at DESC) WHERE county IS NOT NULL',
  ];

  // Run raw_records statements one-per-transaction so a single failure
  // (e.g. a column already exists with a different type) doesn't roll back
  // the rest. Each statement is its own micro-commit; CREATE INDEX IF NOT
  // EXISTS and ADD COLUMN IF NOT EXISTS are already safe to re-run.
  const p = getPool();
  const client = await p.connect();
  try {
    for (const sql of statements) {
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[pg] bootstrap step failed (continuing):', err.message, '\n  SQL:', sql.split('\n')[0].trim());
      }
    }
  } finally {
    client.release();
  }

  // Now bootstrap generated_articles with its own client — needs raw_records
  // to exist with the right shape, which the loop above guarantees.
  const client2 = await p.connect();
  try {
    for (const sql of generatedStatements) {
      await client2.query('BEGIN');
      try {
        await client2.query(sql);
        await client2.query('COMMIT');
      } catch (err) {
        await client2.query('ROLLBACK').catch(() => {});
        console.error('[pg] bootstrap step failed (continuing):', err.message, '\n  SQL:', sql.split('\n')[0].trim());
      }
    }
  } finally {
    client2.release();
  }

  return { ok: true };
}

module.exports = {
  WILDCARD,
  isConfigured,
  healthCheck,
  initializeDatabase,
  saveRawRecord,
  tenantQuery,
  adminQuery,
  txn,
  close,
};
