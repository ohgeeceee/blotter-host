'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const processor = require('../src/ingestion/processor');

test('fetchUnprocessedRecords asks for up to 10 unprocessed raw records', async () => {
  const calls = [];
  const rows = [
    { id: 1, state: 'wa', source_type: 'bulletin', source_url: 'https://example.test/1', raw_text: 'Alpha' },
  ];

  const result = await processor.fetchUnprocessedRecords(25, {
    queryFn: async (sql, params) => {
      calls.push({ sql, params });
      return { ok: true, rows, rowCount: rows.length };
    },
  });

  assert.equal(result.length, 1);
  assert.match(calls[0].sql, /LEFT JOIN generated_articles ga/);
  assert.match(calls[0].sql, /rr\.processed_at IS NULL/);
  assert.equal(calls[0].params[0], 10);
});

test('buildClaudeMessages includes the raw record context', () => {
  const messages = processor.buildClaudeMessages({
    state: 'wa',
    source_type: 'bulletin',
    source_name: 'Example Agency',
    source_url: 'https://example.test/1',
    raw_text: 'Alpha',
  });

  assert.equal(messages[0].role, 'user');
  assert.match(messages[0].content[0].text, /State: wa/);
  assert.match(messages[0].content[0].text, /Raw record:/);
  assert.match(messages[0].content[0].text, /Alpha/);
});

test('prepareRecordsForClaude turns records into Claude prompts', async () => {
  const prepared = await processor.prepareRecordsForClaude(10, {
    records: [
      {
        id: 7,
        state: 'wa',
        source_type: 'bulletin',
        source_url: 'https://example.test/7',
        raw_text: 'Hello world',
      },
    ],
  });

  assert.equal(prepared.ok, true);
  assert.equal(prepared.count, 1);
  assert.equal(prepared.records[0].raw_record_id, 7);
  assert.equal(prepared.records[0].prompt.model, 'claude-3-5-sonnet-latest');
  assert.match(prepared.records[0].prompt.system, /Return ONLY valid JSON/);
});

test('parseClaudeResponse extracts the JSON article payload and categories', () => {
  const article = processor.parseClaudeResponse({
    content: [
      {
        text: JSON.stringify({
          headline: 'Daily summary',
          body_html: '<p>Plain-language body</p>',
          source_type: 'bulletin',
          categories: ['public safety', 'crime'],
        }),
      },
    ],
  });

  assert.deepEqual(article, {
    headline: 'Daily summary',
    body_html: '<p>Plain-language body</p>',
    source_type: 'bulletin',
    categories: ['public safety', 'crime'],
  });
});

test('normalizeHeadline strips punctuation and lowercases', () => {
  assert.equal(processor.normalizeHeadline('Man Arrested: After Robbery!'), 'man arrested after robbery');
  assert.equal(processor.normalizeHeadline('  Multiple   Spaces  '), 'multiple spaces');
});

test('normalizeCategories trims and limits tags', () => {
  assert.deepEqual(
    processor.normalizeCategories([' Crime ', 'Public Safety', '', 'x'.repeat(60)]),
    ['crime', 'public safety']
  );
});

test('processRecordsWithClaude uses an injected Anthropic client', async () => {
  const responses = [];
  const result = await processor.processRecordsWithClaude(10, {
    records: [
      {
        id: 11,
        state: 'wa',
        source_type: 'bulletin',
        source_url: 'https://example.test/11',
        raw_text: 'Hello world',
      },
    ],
    client: {
      messages: {
        async create(prompt) {
          responses.push(prompt);
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  headline: 'Claude summary',
                  body_html: '<p>Claude body</p>',
                  source_type: 'bulletin',
                  categories: ['crime'],
                }),
              },
            ],
          };
        },
      },
    },
    queryFn: async (sql) => {
      // Check INSERT first: the INSERT statement also contains the
      // headline_fingerprint column name, so a naive includes() order
      // would mis-route it.
      if (sql.includes('INSERT INTO generated_articles')) {
        return { ok: true, rows: [{ id: 22 }], rowCount: 1 };
      }
      if (sql.includes('UPDATE raw_records')) {
        return { ok: true, rows: [{ id: 11 }], rowCount: 1 };
      }
      if (sql.includes('headline_fingerprint =')) {
        return { ok: true, rows: [], rowCount: 0 };
      }
      if (sql.includes('make_interval')) {
        return { ok: true, rows: [], rowCount: 0 };
      }
      return { ok: true, rows: [], rowCount: 0 };
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.count, 1);
  assert.equal(responses.length, 1);
  assert.match(responses[0].messages[0].content[0].text, /Hello world/);
  assert.equal(result.results[0].generated_article_id, 22);
  assert.equal(result.results[0].article.headline, 'Claude summary');
  assert.equal(result.results[0].source_type, 'bulletin');
  assert.equal(result.results[0].duplicate, false);
  assert.ok(result.results[0].headline_fingerprint);
  assert.ok(result.results[0].content_fingerprint);
});

test('processRecordsWithClaude skips headline duplicates', async () => {
  const result = await processor.processRecordsWithClaude(10, {
    records: [
      {
        id: 12,
        state: 'wa',
        source_type: 'bulletin',
        source_url: 'https://example.test/12',
        raw_text: 'Duplicate story text',
      },
    ],
    client: {
      messages: {
        async create() {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  headline: 'Duplicate Headline!',
                  body_html: '<p>body</p>',
                  source_type: 'bulletin',
                  categories: ['crime'],
                }),
              },
            ],
          };
        },
      },
    },
    queryFn: async (sql) => {
      if (sql.includes('headline_fingerprint')) {
        return { ok: true, rows: [{ id: 99 }], rowCount: 1 };
      }
      if (sql.includes('UPDATE raw_records')) {
        return { ok: true, rows: [{ id: 12 }], rowCount: 1 };
      }
      return { ok: true, rows: [], rowCount: 0 };
    },
  });

  assert.equal(result.results[0].duplicate, true);
  assert.equal(result.results[0].reason, 'headline_fingerprint');
  assert.equal(result.results[0].generated_article_id, null);
  assert.equal(result.results[0].existing_generated_article_id, 99);
});

test('contentFingerprint ignores case punctuation html and spacing', () => {
  const a = processor.contentFingerprint('Man Arrested: After Robbery!', '<p>Police say a man was arrested.</p>');
  const b = processor.contentFingerprint('man arrested after robbery', 'Police say a man was arrested.');
  assert.equal(a, b);
  assert.equal(a.length, 64);
});

test('processRecordsWithClaude skips content-fingerprint duplicates', async () => {
  const result = await processor.processRecordsWithClaude(10, {
    records: [
      {
        id: 13,
        state: 'wa',
        source_type: 'bulletin',
        source_url: 'https://example.test/13',
        raw_text: 'Similar story text',
      },
    ],
    client: {
      messages: {
        async create() {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  headline: 'Slightly Different Headline!',
                  body_html: '<p>The same body text.</p>',
                  source_type: 'bulletin',
                  categories: ['crime'],
                }),
              },
            ],
          };
        },
      },
    },
    queryFn: async (sql) => {
      if (sql.includes('INSERT INTO generated_articles')) {
        return { ok: true, rows: [{ id: 77 }], rowCount: 1 };
      }
      if (sql.includes('UPDATE raw_records')) {
        return { ok: true, rows: [{ id: 13 }], rowCount: 1 };
      }
      if (sql.includes('headline_fingerprint =')) {
        return { ok: true, rows: [], rowCount: 0 };
      }
      if (sql.includes('make_interval')) {
        return {
          ok: true,
          rows: [
            {
              id: 88,
              headline: 'SLIGHTLY different Headline',
              body: '<p>The same body text.</p>',
            },
          ],
          rowCount: 1,
        };
      }
      return { ok: true, rows: [], rowCount: 0 };
    },
  });

  assert.equal(result.results[0].duplicate, true);
  assert.equal(result.results[0].reason, 'content_fingerprint');
  assert.equal(result.results[0].generated_article_id, null);
  assert.equal(result.results[0].existing_generated_article_id, 88);
  assert.ok(result.results[0].content_fingerprint);
});
