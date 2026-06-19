'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const guard = require('../src/ingestion/ingestion_guard');
const staticScraper = require('../src/ingestion/static_scraper');
const playwrightScraper = require('../src/ingestion/playwright_scraper');
const ingest = require('../src/ingest');
const db = require('../src/db/pg');

test('normalizeText collapses whitespace before hashing', () => {
  assert.equal(guard.normalizeText('  hello\n\nworld  '), 'hello world');
  assert.equal(
    guard.sha256Fingerprint('  hello\n\nworld  '),
    guard.sha256Fingerprint('hello world')
  );
});

test('buildFailurePayload preserves source metadata', () => {
  const payload = guard.buildFailurePayload({
    state: 'montana',
    sourceType: 'bulletin',
    sourceName: 'Example Agency',
    sourceUrl: 'https://example.gov/bulletin',
    errorType: 'TimeoutError',
    errorMessage: 'Timed out',
    stackTrace: 'stack',
  });

  assert.equal(payload.state, 'montana');
  assert.equal(payload.source_type, 'bulletin');
  assert.equal(payload.source_name, 'Example Agency');
  assert.equal(payload.error_type, 'TimeoutError');
});

test('stripHtml removes scripts, styles, and tags', () => {
  const text = staticScraper.stripHtml('<style>a{}</style><h1>Hi</h1><script>1</script>');
  assert.match(text.trim(), /Hi/);
  assert.doesNotMatch(text, /script|style|<h1>/i);
});

test('static scraper uses injected fetch implementation', async () => {
  const result = await staticScraper.scrapeStaticPage('https://example.test/bulletin', {
    fetchImpl: async () => ({
      ok: true,
      text: async () => '<html><body><h1>Bulletin</h1><p>Arrest report</p></body></html>',
    }),
  });

  assert.equal(result.text, 'Bulletin Arrest report');
  assert.match(result.rawHtml, /Arrest report/);
});

test('playwright extractor scrolls and extracts rendered content', async () => {
  const page = {
    url: null,
    scrolls: 0,
    waits: 0,
    async goto(url) {
      this.url = url;
    },
    async evaluate(fn) {
      const src = String(fn);
      if (src.includes('document.body.scrollHeight')) {
        this.scrolls += 1;
        return this.scrolls < 2 ? 1000 : 1000;
      }
      return undefined;
    },
    async waitForTimeout() {
      this.waits += 1;
    },
    async content() {
      return '<html><body><div>Loaded</div></body></html>';
    },
  };

  const result = await playwrightScraper.extractWithPage(page, 'https://example.test/dynamic');
  assert.equal(page.url, 'https://example.test/dynamic');
  assert.match(result.text, /Loaded/);
});

test('ingestOne skips duplicates when fingerprint already exists', async () => {
  const result = await ingest.ingestOne(
    {
      state: 'wa',
      sourceType: 'bulletin',
      sourceUrl: 'https://example.test/bulletin',
      sourceName: 'Example Agency',
      mode: 'static',
    },
    {
      scrapeStaticPage: async () => ({ text: 'Hello world', rawHtml: '<p>Hello world</p>' }),
      fingerprintExists: async () => true,
      insertRawRecord: async () => ({ inserted: false, id: null }),
      runGuarded: async (task) => ({ ok: true, status: 'success', result: await task() }),
    }
  );

  assert.equal(result.status, 'success');
  assert.equal(result.result.status, 'duplicate_skipped');
});

test('ingestOne inserts a new record when the fingerprint is new', async () => {
  const inserted = [];
  const result = await ingest.ingestOne(
    {
      state: 'wa',
      sourceType: 'bulletin',
      sourceUrl: 'https://example.test/bulletin',
      sourceName: 'Example Agency',
      mode: 'static',
    },
    {
      scrapeStaticPage: async () => ({ text: 'Hello world', rawHtml: '<p>Hello world</p>' }),
      fingerprintExists: async () => false,
      insertRawRecord: async (record) => {
        inserted.push(record);
        return { inserted: true, id: 99 };
      },
      runGuarded: async (task) => ({ ok: true, status: 'success', result: await task() }),
    }
  );

  assert.equal(result.status, 'success');
  assert.equal(result.result.status, 'inserted');
  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].fingerprint.length, 64);
});

test('parseArgs reads the ingestion CLI flags', () => {
  const args = ingest.parseArgs([
    '--state', 'wa',
    '--source-type', 'bulletin',
    '--source-url', 'https://example.test/bulletin',
    '--mode', 'static',
  ]);

  assert.deepEqual(args, {
    state: 'wa',
    sourceType: 'bulletin',
    sourceUrl: 'https://example.test/bulletin',
    sourceName: '',
    mode: 'static',
  });
});

test('postgres wrapper exposes the schema initializer', () => {
  assert.equal(typeof db.initializeDatabase, 'function');
});
