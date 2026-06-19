'use strict';

let pool = null;
let poolError = null;

function buildConfig() {
  if (process.env.DATABASE_URL) {
    return {
      connectionString: process.env.DATABASE_URL,
      max: parseInt(process.env.PG_POOL_MAX, 10) || 10,
      idleTimeoutMillis: parseInt(process.env.PG_IDLE_MS, 10) || 30_000,
      connectionTimeoutMillis: parseInt(process.env.PG_CONNECT_MS, 10) || 5_000,
    };
  }

  if (process.env.PGHOST) {
    return {
      host: process.env.PGHOST,
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
  if (poolError) throw poolError;
  const cfg = buildConfig();
  if (!cfg) {
    poolError = new Error('No database configured. Set DATABASE_URL or PGHOST/PGUSER/PGPASSWORD/PGDATABASE.');
    throw poolError;
  }
  let Pool;
  try {
    ({ Pool } = require('pg'));
  } catch (err) {
    poolError = err;
    throw err;
  }
  pool = new Pool(cfg);
  pool.on('error', (err) => {
    console.error('[ingestion-pg] idle client error:', err.message);
  });
  return pool;
}

async function query(text, params = []) {
  const p = getPool();
  return p.query(text, params);
}

async function withClient(work) {
  const p = getPool();
  const client = await p.connect();
  try {
    return await work(client);
  } finally {
    client.release();
  }
}

async function fingerprintExists(fingerprint) {
  const normalized = String(fingerprint || '').trim();
  if (!normalized) {
    throw new Error('fingerprint is required');
  }

  const result = await module.exports.query(
    'SELECT 1 FROM raw_records WHERE fingerprint = $1 LIMIT 1',
    [normalized]
  );
  return result.rowCount > 0;
}

async function insertRawRecord(record) {
  const payload = {
    state: String(record.state || '').trim(),
    source_type: String(record.sourceType || record.source_type || '').trim(),
    source_url: String(record.sourceUrl || record.source_url || '').trim(),
    source_name: String(record.sourceName || record.source_name || '').trim(),
    fingerprint: String(record.fingerprint || '').trim(),
    raw_text: String(record.rawText || record.raw_text || '').trim(),
    raw_html: record.rawHtml || record.raw_html || null,
    raw_payload: record.rawPayload || record.raw_payload || null,
  };

  if (!payload.state || !payload.source_type || !payload.source_url || !payload.fingerprint) {
    throw new Error('state, source_type, source_url, and fingerprint are required');
  }

  const result = await module.exports.query(
    `INSERT INTO raw_records
      (state, source_type, source_url, source_name, fingerprint, raw_text, raw_html, raw_payload, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
     ON CONFLICT (state, fingerprint) DO NOTHING
     RETURNING id`,
    [
      payload.state,
      payload.source_type,
      payload.source_url,
      payload.source_name || null,
      payload.fingerprint,
      payload.raw_text,
      payload.raw_html,
      payload.raw_payload,
    ]
  );

  return {
    inserted: result.rowCount > 0,
    id: result.rows[0] ? result.rows[0].id : null,
  };
}

async function logIngestionEvent(event) {
  const payload = {
    state: String(event.state || '').trim(),
    source_type: String(event.sourceType || event.source_type || '').trim(),
    source_name: String(event.sourceName || event.source_name || '').trim(),
    source_url: String(event.sourceUrl || event.source_url || '').trim(),
    status: String(event.status || 'failed').trim(),
    error_type: String(event.errorType || event.error_type || '').trim(),
    error_message: String(event.errorMessage || event.error_message || '').trim(),
    stack_trace: String(event.stackTrace || event.stack_trace || '').trim(),
  };

  await module.exports.query(
    `INSERT INTO ingestion_logs
      (state, source_type, source_name, source_url, status, error_type, error_message, stack_trace, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
    [
      payload.state || null,
      payload.source_type || null,
      payload.source_name || null,
      payload.source_url || null,
      payload.status,
      payload.error_type || null,
      payload.error_message || null,
      payload.stack_trace || null,
    ]
  );
}

module.exports = {
  getPool,
  query,
  withClient,
  fingerprintExists,
  insertRawRecord,
  logIngestionEvent,
};
