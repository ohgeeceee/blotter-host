'use strict';

// Live integration smoke test for the per-state fingerprint fix.
// Uses the real Postgres DB to confirm:
//   1. Same fingerprint to two different states both insert (no crash).
//   2. Re-running the same insert for the same state hits ON CONFLICT (no crash).
//   3. Cleanup leaves the table in the same state as it started.
//
// Run: sudo -u postgres node test/raw_records_dedup.live.test.js
// (or just `node`, since pg connects via DATABASE_URL from .env)

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
require('../src/lib/load-env').loadEnvFile(path.join(__dirname, '..', '.env'));

const db = require('../src/db/pg');
const bulletin = require('../src/ingestion/modules/bulletin');

const STATE_A = `dedup_live_${Date.now()}_a`;
const STATE_B = `dedup_live_${Date.now()}_b`;
const UNIQUE_BODY = `Live test body ${Date.now()} — same text in two states.`;
const URL = `https://example.test/live-${Date.now()}`;

test.after(async () => {
  await db.adminQuery(
    'DELETE FROM raw_records WHERE state IN ($1, $2)',
    [STATE_A, STATE_B]
  );
  // Close the pg pool so the node:test runner can exit cleanly.
  if (typeof db.close === 'function') {
    await db.close();
  }
});

test('live: same fingerprint to two different states both insert', async () => {
  const a = await bulletin.ingestBulletin({
    state: STATE_A,
    sourceUrl: URL,
    text: UNIQUE_BODY,
    sourceType: 'bulletin',
  });
  const b = await bulletin.ingestBulletin({
    state: STATE_B,
    sourceUrl: URL,
    text: UNIQUE_BODY,
    sourceType: 'bulletin',
  });

  assert.equal(a.inserted, true, 'first state should insert');
  assert.equal(b.inserted, true, 'second state should insert (no global-unique crash)');
  assert.equal(a.fingerprint, b.fingerprint, 'fingerprint derived from text must match');
  assert.notEqual(a.id, b.id, 'different states get different row ids');

  const result = await db.adminQuery(
    'SELECT state, fingerprint FROM raw_records WHERE state IN ($1, $2) AND fingerprint = $3 ORDER BY state',
    [STATE_A, STATE_B, a.fingerprint]
  );
  assert.equal(result.ok, true);
  assert.equal(result.rows.length, 2, 'both rows should be present');
});

test('live: re-inserting the same fingerprint for the same state hits ON CONFLICT', async () => {
  const second = await bulletin.ingestBulletin({
    state: STATE_A,
    sourceUrl: URL,
    text: UNIQUE_BODY,
    sourceType: 'bulletin',
  });

  assert.equal(second.inserted, false, 'second insert for same state should be a duplicate');
  assert.equal(second.duplicate, true);
  assert.equal(second.id, null);
});
