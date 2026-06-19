'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const homeView = require('../src/render/views/home');

test('renderHomeFeed iterates over articles and renders news cards', () => {
  const html = homeView.renderHomeFeed([
    {
      headline: 'Example headline',
      published_at: '2026-06-09T12:00:00Z',
      source_url: 'https://example.test/article',
      body_html: '<p>Example body</p>',
    },
  ]);

  assert.match(html, /news-card/);
  assert.match(html, /Example headline/);
  assert.match(html, /Read more/);
  assert.match(html, /example\.test\/article/);
});
