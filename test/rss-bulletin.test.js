'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const rssBulletin = require('../src/ingestion/modules/rssBulletin');

test('buildRawText combines feed title, entry title, summary, date and link', () => {
  const text = rssBulletin.buildRawText({
    title: 'Test Headline',
    contentSnippet: 'A short summary.',
    link: 'https://example.com/article',
    isoDate: '2026-06-14T12:00:00Z',
  }, 'Example Feed');

  assert.match(text, /Feed: Example Feed/);
  assert.match(text, /Title: Test Headline/);
  assert.match(text, /Published: 2026-06-14T12:00:00Z/);
  assert.match(text, /Summary: A short summary/);
  assert.match(text, /Link: https:\/\/example.com\/article/);
});

test('runBatch ingests RSS entries into raw_records with per-state dedup', async () => {
  const ingested = [];
  const deps = {
    rssParser: {
      parseURL: async () => ({
        title: 'Test Feed',
        items: [
          { title: 'One', contentSnippet: 'First', link: 'https://example.com/1', isoDate: '2026-06-14T10:00:00Z' },
          { title: 'Two', contentSnippet: 'Second', link: 'https://example.com/2', isoDate: '2026-06-14T11:00:00Z' },
        ],
      }),
    },
  };

  // Inject a fake bulletin.ingestBulletin by passing a module override through deps is not
  // supported by the current strategy, so we monkey-patch the required module.
  const bulletin = require('../src/ingestion/modules/bulletin');
  const originalIngest = bulletin.ingestBulletin;
  bulletin.ingestBulletin = async (input) => {
    ingested.push(input);
    return { ok: true, inserted: true, id: ingested.length, fingerprint: 'f' + ingested.length };
  };

  try {
    const result = await rssBulletin.runBatch({
      state: 'idaho',
      sourceUrl: 'https://example.com/feed',
      sourceName: 'Test Feed',
      sourceType: 'news_bulletin',
      maxEntries: 5,
    }, deps);

    assert.equal(result.ok, true);
    assert.equal(result.entriesAttempted, 2);
    assert.equal(ingested.length, 2);
    assert.equal(ingested[0].state, 'idaho');
    assert.equal(ingested[0].sourceType, 'news_bulletin');
    assert.match(ingested[0].text, /One/);
    assert.equal(ingested[0].rawPayload.mode, 'rss');
    assert.equal(ingested[1].rawPayload.feedUrl, 'https://example.com/feed');
  } finally {
    bulletin.ingestBulletin = originalIngest;
  }
});
