'use strict';

const db = require('../../db/pg');
const { normalizeText, sha256Fingerprint } = require('../ingestion_guard');

function cleanBulletinText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function buildPayload(input) {
  return {
    state: String(input.state || '').trim(),
    source_type: String(input.sourceType || input.source_type || 'bulletin').trim() || 'bulletin',
    source_url: String(input.sourceUrl || input.source_url || '').trim(),
    source_name: String(input.sourceName || input.source_name || '').trim(),
    raw_text: cleanBulletinText(input.text || input.rawText || input.raw_text || ''),
    raw_html: input.rawHtml || input.raw_html || null,
    raw_payload: input.rawPayload || input.raw_payload || null,
  };
}

function resolveRecentSourceUrlWindowHours() {
  const raw = String(process.env.RECENT_SOURCE_URL_WINDOW_HOURS || '').trim();
  if (!raw) return 6;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 6;
}

async function findRecentRawRecord(state, sourceUrl, hours) {
  const normalizedState = String(state || '').trim();
  const normalizedUrl = String(sourceUrl || '').trim();
  const windowHours = Number.isFinite(hours) && hours >= 0 ? hours : resolveRecentSourceUrlWindowHours();

  if (!normalizedState || !normalizedUrl || windowHours <= 0) {
    return null;
  }

  const result = await db.adminQuery(
    `SELECT id FROM raw_records
     WHERE state = $1 AND source_url = $2
       AND created_at > NOW() - make_interval(hours => $3)
     ORDER BY created_at DESC
     LIMIT 1`,
    [normalizedState, normalizedUrl, windowHours]
  );

  if (!result.ok) {
    throw new Error(result.error || 'recent raw_records lookup failed');
  }
  return result.rows[0] || null;
}

async function fingerprintExists(fingerprint, state) {
  const normalizedFingerprint = String(fingerprint || '').trim();
  const normalizedState = String(state || '').trim();
  if (!normalizedFingerprint) {
    throw new Error('fingerprint is required');
  }
  if (!normalizedState) {
    throw new Error('state is required');
  }

  const result = await db.adminQuery(
    'SELECT 1 FROM raw_records WHERE state = $1 AND fingerprint = $2 LIMIT 1',
    [normalizedState, normalizedFingerprint]
  );
  if (!result.ok) {
    throw new Error(result.error || 'raw_records lookup failed');
  }
  return result.rows.length > 0;
}

async function insertBulletinRecord(input) {
  const payload = buildPayload(input);
  if (!payload.state) {
    throw new Error('state is required');
  }
  if (!payload.source_url) {
    throw new Error('source_url is required');
  }
  if (!payload.raw_text) {
    throw new Error('raw_text is required');
  }

  const recent = await findRecentRawRecord(
    payload.state,
    payload.source_url,
    resolveRecentSourceUrlWindowHours()
  );
  if (recent) {
    return {
      ok: true,
      inserted: false,
      duplicate: true,
      reason: 'recent_source_url',
      existing_raw_record_id: recent.id,
      id: null,
      state: payload.state,
    };
  }

  const fingerprint = sha256Fingerprint(payload.raw_text);

  // Same bulletin body legitimately fans out to multiple state targets, so
  // the dedup key is (state, fingerprint), not fingerprint alone. ON CONFLICT
  // also makes the insert atomic w.r.t. concurrent runs — no TOCTOU race.
  const result = await db.adminQuery(
    `INSERT INTO raw_records
      (state, source_type, source_url, source_name, fingerprint, raw_text, raw_html, raw_payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (state, fingerprint) DO NOTHING
     RETURNING id`,
    [
      payload.state,
      payload.source_type,
      payload.source_url,
      payload.source_name || null,
      fingerprint,
      payload.raw_text,
      payload.raw_html,
      payload.raw_payload,
    ]
  );

  if (!result.ok) {
    throw new Error(result.error || 'raw_records insert failed');
  }

  const inserted = result.rows.length > 0;
  return {
    ok: true,
    inserted,
    duplicate: !inserted,
    id: inserted && result.rows[0] ? result.rows[0].id : null,
    fingerprint,
    state: payload.state,
  };
}

async function ingestBulletin(input) {
  return insertBulletinRecord(input);
}

async function runScheduledIngestion({ targets = null, ingestFn = ingestBulletin } = {}) {
  const targetList = Array.isArray(targets)
    ? targets
    : (process.env.BULLETIN_INGESTION_TARGETS ? JSON.parse(process.env.BULLETIN_INGESTION_TARGETS) : []);

  if (!targetList.length) {
    return {
      ok: true,
      skipped: true,
      reason: 'no targets configured',
      count: 0,
      results: [],
    };
  }

  const results = [];
  for (const target of targetList) {
    try {
      results.push({
        target: target.sourceUrl || target.source_url || null,
        result: await ingestFn(target),
        ok: true,
      });
    } catch (err) {
      results.push({
        target: target.sourceUrl || target.source_url || null,
        ok: false,
        error: err.message,
      });
    }
  }

  return {
    ok: true,
    skipped: false,
    count: results.length,
    results,
  };
}

module.exports = {
  cleanBulletinText,
  buildPayload,
  fingerprintExists,
  findRecentRawRecord,
  resolveRecentSourceUrlWindowHours,
  insertBulletinRecord,
  ingestBulletin,
  runScheduledIngestion,
};
