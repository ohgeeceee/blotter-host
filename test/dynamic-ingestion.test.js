'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const dynamic = require('../src/ingestion/dynamic');
const bulletin = require('../src/ingestion/modules/bulletin');

test('stripHtml removes script/style content', () => {
  const cleaned = dynamic.stripHtml('<style>.x{}</style><main><h1>Hi</h1></main><script>bad()</script>');
  assert.match(cleaned, /Hi/);
  assert.doesNotMatch(cleaned, /bad\(\)|style|script/i);
});

test('loadDynamicPage uses an injected browser and extracts rendered body text', async () => {
  const calls = [];
  const fakeBrowser = {
    async newPage() {
      return {
        async goto(url, opts) {
          calls.push(['goto', url, opts]);
        },
        async waitForNetworkIdle(opts) {
          calls.push(['waitForNetworkIdle', opts]);
        },
        async evaluate(fn) {
          calls.push(['evaluate', String(fn)]);
          return 'Rendered body text';
        },
        async content() {
          calls.push(['content']);
          return '<html><body>Rendered body text</body></html>';
        },
        async close() {
          calls.push(['page.close']);
        },
      };
    },
    async close() {
      calls.push(['browser.close']);
    },
  };

  const result = await dynamic.loadDynamicPage('https://example.test/dynamic', {
    browser: fakeBrowser,
  });

  assert.equal(result.text, 'Rendered body text');
  assert.equal(result.url, 'https://example.test/dynamic');
  assert.ok(calls.some(([name]) => name === 'waitForNetworkIdle'));
});

test('ingestDynamicPage passes rendered text to the bulletin pipeline', async () => {
  const original = bulletin.ingestBulletin;
  const received = [];
  bulletin.ingestBulletin = async (input) => {
    received.push(input);
    return { ok: true, inserted: true, id: 7, fingerprint: 'f'.repeat(64) };
  };

  try {
    const result = await dynamic.ingestDynamicPage(
      {
        state: 'wa',
        sourceType: 'bulletin',
        sourceUrl: 'https://example.test/dynamic',
        sourceName: 'Example Agency',
      },
      {
        browser: {
          async newPage() {
            return {
              async goto() {},
              async waitForNetworkIdle() {},
              async evaluate() { return 'Hello   from dynamic page'; },
              async content() { return '<html><body>Hello   from dynamic page</body></html>'; },
              async close() {},
            };
          },
          async close() {},
        },
      }
    );

    assert.equal(result.inserted, true);
    assert.equal(received.length, 1);
    assert.equal(received[0].text, 'Hello from dynamic page');
    assert.equal(received[0].rawPayload.mode, 'dynamic');
  } finally {
    bulletin.ingestBulletin = original;
  }
});
