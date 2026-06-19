'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const bulletin = require('../src/ingestion/modules/bulletin');
const db = require('../src/db/pg');

test('cleanBulletinText collapses whitespace and extra blank lines', () => {
  const cleaned = bulletin.cleanBulletinText('Line 1  \r\n\r\n\r\nLine   2\t\t');
  assert.equal(cleaned, 'Line 1\n\nLine 2');
});

test('ingestBulletin returns duplicate when ON CONFLICT skips the insert', async () => {
  const original = db.adminQuery;
  const calls = [];
  db.adminQuery = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.startsWith('INSERT INTO raw_records')) {
      return { ok: true, rows: [], rowCount: 0 };
    }
    return { ok: true, rows: [], rowCount: 0 };
  };

  try {
    const result = await bulletin.ingestBulletin({
      state: 'wa',
      sourceType: 'bulletin',
      sourceUrl: 'https://example.test/bulletin',
      sourceName: 'Example Agency',
      text: 'Hello   world',
    });

    assert.equal(result.inserted, false);
    assert.equal(result.duplicate, true);
    assert.equal(result.id, null);
    assert.equal(calls.length, 2);
    const recentCall = calls.find((c) => c.sql.includes('make_interval'));
    const insertCall = calls.find((c) => c.sql.startsWith('INSERT INTO raw_records'));
    assert.ok(recentCall, 'should check for a recent source_url row');
    assert.equal(recentCall.params[0], 'wa');
    assert.equal(recentCall.params[1], 'https://example.test/bulletin');
    assert.ok(insertCall);
    assert.match(insertCall.sql, /ON CONFLICT \(state, fingerprint\) DO NOTHING/);
  } finally {
    db.adminQuery = original;
  }
});

test('ingestBulletin inserts a new bulletin record with a sha256 fingerprint', async () => {
  const original = db.adminQuery;
  const calls = [];
  db.adminQuery = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.startsWith('INSERT INTO raw_records')) {
      return { ok: true, rows: [{ id: 42 }], rowCount: 1 };
    }
    return { ok: true, rows: [], rowCount: 0 };
  };

  try {
    const result = await bulletin.ingestBulletin({
      state: 'wa',
      sourceType: 'bulletin',
      sourceUrl: 'https://example.test/bulletin',
      sourceName: 'Example Agency',
      text: 'Hello   world',
    });

    assert.equal(result.inserted, true);
    assert.equal(result.duplicate, false);
    assert.equal(result.id, 42);
    assert.equal(result.fingerprint.length, 64);
    assert.equal(calls.length, 2);
    const recentCall = calls.find((c) => c.sql.includes('make_interval'));
    const insertCall = calls.find((c) => c.sql.startsWith('INSERT INTO raw_records'));
    assert.ok(recentCall, 'should check for a recent source_url row');
    assert.ok(insertCall);
    assert.match(insertCall.sql, /INSERT INTO raw_records/);
  } finally {
    db.adminQuery = original;
  }
});

test('ingestBulletin allows the same fingerprint to be inserted for a different state', async () => {
  // This is the network-distribution case: the same bulletin body fanned out
  // to several state targets. Each state gets its own raw_records row.
  const original = db.adminQuery;
  const calls = [];
  let callIndex = 0;
  db.adminQuery = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.startsWith('INSERT INTO raw_records')) {
      callIndex += 1;
      return { ok: true, rows: [{ id: 100 + callIndex }], rowCount: 1 };
    }
    return { ok: true, rows: [], rowCount: 0 };
  };

  try {
    const text = 'Multi-state alert body';
    const [waResult, orResult, idResult] = await Promise.all([
      bulletin.ingestBulletin({ state: 'wa', sourceUrl: 'https://src.test/a', text }),
      bulletin.ingestBulletin({ state: 'or', sourceUrl: 'https://src.test/a', text }),
      bulletin.ingestBulletin({ state: 'id', sourceUrl: 'https://src.test/a', text }),
    ]);

    assert.equal(waResult.inserted, true);
    assert.equal(orResult.inserted, true);
    assert.equal(idResult.inserted, true);
    assert.equal(waResult.fingerprint, orResult.fingerprint);
    assert.equal(orResult.fingerprint, idResult.fingerprint);
    assert.notEqual(waResult.id, orResult.id);
    assert.notEqual(orResult.id, idResult.id);
    // Each state gets one recent-record check + one insert = 6 total calls.
    assert.equal(calls.length, 6);
  } finally {
    db.adminQuery = original;
  }
});

test('fingerprintExists rejects missing state argument', async () => {
  await assert.rejects(
    () => bulletin.fingerprintExists('abc123'),
    /state is required/
  );
});

test('fingerprintExists rejects missing fingerprint argument', async () => {
  await assert.rejects(
    () => bulletin.fingerprintExists('', 'wa'),
    /fingerprint is required/
  );
});

test('fingerprintExists scopes the lookup to the given state', async () => {
  const original = db.adminQuery;
  const calls = [];
  db.adminQuery = async (sql, params) => {
    calls.push({ sql, params });
    return { ok: true, rows: [{ 1: 1 }], rowCount: 1 };
  };

  try {
    const found = await bulletin.fingerprintExists('fp_hash', 'wa');
    assert.equal(found, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /WHERE state = \$1 AND fingerprint = \$2/);
    assert.deepEqual(calls[0].params, ['wa', 'fp_hash']);
  } finally {
    db.adminQuery = original;
  }
});

test('ingestBulletin skips insert when a recent source_url row exists', async () => {
  const original = db.adminQuery;
  const calls = [];
  db.adminQuery = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('make_interval')) {
      return { ok: true, rows: [{ id: 777 }], rowCount: 1 };
    }
    return { ok: true, rows: [], rowCount: 0 };
  };

  try {
    const result = await bulletin.ingestBulletin({
      state: 'wa',
      sourceType: 'bulletin',
      sourceUrl: 'https://example.test/bulletin',
      sourceName: 'Example Agency',
      text: 'Hello again',
    });

    assert.equal(result.inserted, false);
    assert.equal(result.duplicate, true);
    assert.equal(result.reason, 'recent_source_url');
    assert.equal(result.existing_raw_record_id, 777);
    assert.equal(result.id, null);
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /make_interval/);
    assert.equal(calls[0].params[0], 'wa');
    assert.equal(calls[0].params[1], 'https://example.test/bulletin');
  } finally {
    db.adminQuery = original;
  }
});

test('resolveRecentSourceUrlWindowHours returns default and respects env', () => {
  const original = process.env.RECENT_SOURCE_URL_WINDOW_HOURS;
  try {
    delete process.env.RECENT_SOURCE_URL_WINDOW_HOURS;
    assert.equal(bulletin.resolveRecentSourceUrlWindowHours(), 6);
    process.env.RECENT_SOURCE_URL_WINDOW_HOURS = '12';
    assert.equal(bulletin.resolveRecentSourceUrlWindowHours(), 12);
    process.env.RECENT_SOURCE_URL_WINDOW_HOURS = 'bad';
    assert.equal(bulletin.resolveRecentSourceUrlWindowHours(), 6);
  } finally {
    process.env.RECENT_SOURCE_URL_WINDOW_HOURS = original;
  }
});
