'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const tenantRoute = require('../src/routes/tenant');
const db = require('../src/db/pg');
const { render } = require('../src/render/template');

test('tenant route exports an express router', () => {
  assert.equal(typeof tenantRoute.handle, 'function');
});

test('tenant homepage query requests the latest 15 generated articles by state', async () => {
  const original = db.adminQuery;
  const calls = [];
  db.adminQuery = async (sql, params) => {
    calls.push({ sql, params });
    return {
      ok: true,
      rows: [
        {
          id: 1,
          state: 'washington',
          source_type: 'bulletin',
          headline: 'Example headline',
          body_html: '<p>Example body</p>',
        },
      ],
    };
  };

  try {
    const req = { state: { code: 'WA', name: 'Washington', slug: 'washington' } };
    const html = await new Promise((resolve, reject) => {
      const res = {
        headers: {},
        set() {},
        type() { return this; },
        status(code) { this.statusCode = code; return this; },
        send(body) { resolve(body); return this; },
      };
      tenantRoute.handle({ ...req, method: 'GET', url: '/', path: '/', headers: {}, state: req.state }, res, reject);
    });

    assert.match(html, /Washington Blotter/);
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /FROM generated_articles/);
    assert.equal(calls[0].params[0], 'washington');
    assert.match(html, /Example headline/);
  } finally {
    db.adminQuery = original;
  }
});

test('tenant article detail route joins raw_records and renders the summary', async () => {
  const original = db.adminQuery;
  const calls = [];
  db.adminQuery = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('FROM generated_articles ga')) {
      return {
        ok: true,
        rows: [
          {
            id: 9,
            state: 'washington',
            source_type: 'bulletin',
            headline: 'Detail headline',
            body_html: '<p>Detail body</p>',
            source_url: 'https://example.test/source',
            source_name: 'Example Agency',
            raw_text: 'Source raw text',
          },
        ],
      };
    }
    return { ok: true, rows: [], rowCount: 0 };
  };

  try {
    const req = { state: { code: 'WA', name: 'Washington', slug: 'washington' } };
    const html = await new Promise((resolve, reject) => {
      const res = {
        headers: {},
        set() {},
        type() { return this; },
        status(code) { this.statusCode = code; return this; },
        send(body) { resolve(body); return this; },
      };
      tenantRoute.handle({ ...req, method: 'GET', url: '/article/9', path: '/article/9', params: { id: '9' }, headers: {}, state: req.state }, res, reject);
    });

    assert.match(html, /Detail headline/);
    assert.match(html, /Detail body/);
    assert.match(html, /Source raw text/);
    assert.match(html, /View Raw Public Record/);
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /JOIN raw_records rr/);
    assert.deepEqual(calls[0].params, ['washington', 9]);
  } finally {
    db.adminQuery = original;
  }
});

test('tenant header renders the authority browse masthead', () => {
  const html = render('tenant/header.html', {
    STATE_NAME: 'Washington',
    STATE_SLUG: 'washington',
    CANONICAL_HOST: 'washington.blotter.host',
    REQUEST_PATH: '/',
    PAGE_TITLE: 'Washington Blotter',
    PAGE_DESCRIPTION: 'Public safety blotter for Washington.',
    ACCENT_COLOR: '#1f2933',
    AGENCY: 'Washington State Patrol',
  });

  assert.match(html, /site-header--authority/);
  assert.match(html, /nav-toggle--authority/);
  assert.match(html, /site-nav--authority/);
  assert.match(html, /Browse/);
  assert.match(html, /Network/);
  assert.match(html, /Washington State Patrol/);
});

test('state homepage template emphasizes the headline over supporting text', () => {
  const html = require('../src/render/template').render('state/index.html', {
    STATE_NAME: 'Washington',
    AGENCY: 'Washington State Patrol',
    TAGLINE: 'Public safety blotter for the Evergreen State.',
    BLOTTER_LIST_HTML: '<li>Example blotter</li>',
  });

  assert.match(html, /Washington Blotter/);
  assert.match(html, /Public safety blotter for the Evergreen State\./);
  assert.match(html, /Recent reports/);
  assert.match(html, /hero--state/);
  assert.match(html, /blotters--state/);
});
