'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'blotter-news-scheduler-'));
}

test('scheduler loads enabled news sources from control DB', () => {
  const dir = tempDir();
  process.env.CONTROL_DB_PATH = path.join(dir, 'control.db');

  const controlDb = require('../src/db/control');
  controlDb.close();
  controlDb.setup();

  const scheduler = require('../src/ingestion/scheduler');

  try {
    controlDb.createNewsSource({
      state_slug: 'idaho',
      source_name: 'Test RSS',
      source_url: 'https://example.com/feed',
      source_type: 'rss',
      strategy: 'rssBulletin',
      is_enabled: true,
      priority: 10,
      metadata_json: '{"max_entries": 3}',
    });
    controlDb.createNewsSource({
      state_slug: 'idaho',
      source_name: 'Disabled RSS',
      source_url: 'https://example.com/disabled',
      source_type: 'rss',
      strategy: 'rssBulletin',
      is_enabled: false,
    });

    const sources = scheduler.loadNewsSourcesFromDb('idaho');
    assert.equal(sources.length, 1);
    assert.equal(sources[0].state, 'idaho');
    assert.equal(sources[0].name, 'Test RSS');
    assert.equal(sources[0].url, 'https://example.com/feed');
    assert.equal(sources[0].strategy, 'rssBulletin');
    assert.equal(sources[0].maxEntries, 3);
  } finally {
    controlDb.close();
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.CONTROL_DB_PATH;
  }
});
