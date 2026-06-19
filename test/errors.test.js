'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { render } = require('../src/render/template');

test('404 template renders for a normal request', () => {
  const html = render('errors/404.html', {
    REQUEST_HOST: 'washington.blotter.host',
    REQUEST_PATH: '/some/missing/path',
  });
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /404/);
  assert.match(html, /washington\.blotter\.host/);
  assert.match(html, /\/some\/missing\/path/);
});

test('404 template escapes user-controlled path to prevent XSS', () => {
  const html = render('errors/404.html', {
    REQUEST_HOST: 'evil.example',
    REQUEST_PATH: '/<script>alert(1)</script>',
  });
  // The raw <script> tag must not survive in the output.
  assert.doesNotMatch(html, /<script>alert/);
  // The browser will see an escaped, harmless text node.
  assert.match(html, /&lt;script&gt;alert/);
});

test('404 template handles empty/missing context without throwing', () => {
  // The server may pass empty strings if the request is unusual;
  // the template should still render a valid HTML document.
  const html = render('errors/404.html', {});
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /404/);
  // No unfilled {{TOKEN}} placeholders should leak to the response.
  assert.doesNotMatch(html, /\{\{[A-Z_]/);
});

test('500 template renders without any required context', () => {
  const html = render('errors/500.html', {});
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /500/);
  // 500 page must not echo the request path or host — it has no tokens,
  // and we should never add one (would leak /admin/... paths to attackers).
  assert.doesNotMatch(html, /\{\{[A-Z_]/);
  assert.doesNotMatch(html, /\/admin/);
});

test('500 template is a full standalone document (no partials)', () => {
  const html = render('errors/500.html', {});
  // No <script> or <link> to external assets — the page must render
  // even if CSS/JS hosting is broken.
  assert.doesNotMatch(html, /<script\b/i);
  assert.doesNotMatch(html, /<link\b/i);
});
