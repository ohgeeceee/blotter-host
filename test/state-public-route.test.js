'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const router = require('../src/routes/state-public');
const db = require('../src/db/pg');

function invoke(req) {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      headers: {},
      body: '',
      set(name, value) {
        this.headers[String(name).toLowerCase()] = value;
        return this;
      },
      type(value) {
        this.headers['content-type'] = value;
        return this;
      },
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(value) {
        this.headers['content-type'] = 'application/json';
        this.body = value;
        resolve({ req, res });
        return this;
      },
      send(value) {
        this.body = value;
        resolve({ req, res });
        return this;
      },
    };
    router.handle(req, res, (err) => (err ? reject(err) : resolve({ req, res })));
  });
}

test('state-public homepage reads generated articles for the active state', async () => {
  const original = db.tenantQuery;
  const calls = [];
  db.tenantQuery = async (stateCode, sql, params) => {
    calls.push({ stateCode, sql, params });
    return {
      ok: true,
      rows: [
        {
          id: 17,
          state: 'washington',
          title: 'Generated headline',
          summary: '<p>Generated body</p>',
          agency: 'Washington State Patrol',
          published_at: new Date('2026-06-05T00:00:00Z'),
        },
      ],
      rowCount: 1,
    };
  };

  try {
    const result = await invoke({
      method: 'GET',
      url: '/',
      path: '/',
      query: {},
      headers: { host: 'washington.blotter.host' },
      stateContext: 'WA',
      tenant: {
        slug: 'washington',
        code: 'WA',
        name: 'Washington',
        public: {
          agency: 'Washington State Patrol',
          tagline: 'Public safety blotter for the Evergreen State.',
          blotters: [],
        },
      },
      subdomain: 'washington',
    });

    assert.equal(result.res.statusCode, 200);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].stateCode, 'WA');
    assert.match(calls[0].sql, /FROM generated_articles ga/);
    assert.match(String(result.res.body), /Generated headline/);
    assert.match(String(result.res.body), /Washington State Patrol/);
  } finally {
    db.tenantQuery = original;
  }
});

test('state-public healthz returns the parsed state context', async () => {
  const result = await invoke({
    method: 'GET',
    url: '/healthz',
    path: '/healthz',
    headers: { host: 'washington.blotter.host' },
    stateContext: 'WA',
  });

  assert.equal(result.res.statusCode, 200);
  assert.deepEqual(result.res.body, { ok: true, surface: 'state-public', state: 'WA' });
});

test('state-public api list exposes published_at for generated articles', async () => {
  const original = db.tenantQuery;
  db.tenantQuery = async () => ({
    ok: true,
    rows: [
      {
        id: 21,
        state: 'washington',
        title: 'API headline',
        summary: 'API body',
        agency: 'Washington State Patrol',
        published_at: new Date('2026-06-04T00:00:00Z'),
      },
    ],
    rowCount: 1,
  });

  try {
    const result = await invoke({
      method: 'GET',
      url: '/api/blotters',
      path: '/api/blotters',
      query: { limit: '1' },
      headers: { host: 'washington.blotter.host' },
      stateContext: 'WA',
      tenant: { slug: 'washington', code: 'WA', name: 'Washington', public: {} },
      subdomain: 'washington',
    });

    assert.equal(result.res.statusCode, 200);
    assert.equal(result.res.body.ok, true);
    assert.equal(result.res.body.blotters[0].published_at, '2026-06-04');
  } finally {
    db.tenantQuery = original;
  }
});
