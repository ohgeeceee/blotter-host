'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'blotter-news-sources-'));
}

function makeResponse() {
  return {
    statusCode: 200,
    headers: {},
    jsonBody: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.jsonBody = value;
      this.headers['content-type'] = 'application/json';
      return this;
    },
    send(value) {
      this.body = value;
      return this;
    },
  };
}

function invoke(handler, req) {
  const res = makeResponse();
  return new Promise((resolve, reject) => {
    let settled = false;
    const next = (err) => {
      if (settled) return;
      settled = true;
      err ? reject(err) : resolve({ req, res });
    };
    try {
      const maybe = handler(req, res, next);
      if (maybe && typeof maybe.then === 'function') {
        maybe.then(() => {
          if (!settled) {
            settled = true;
            resolve({ req, res });
          }
        }).catch((err) => {
          if (!settled) {
            settled = true;
            reject(err);
          }
        });
      } else if (!settled) {
        settled = true;
        resolve({ req, res });
      }
    } catch (err) {
      if (!settled) {
        settled = true;
        reject(err);
      }
    }
  });
}

function findRoute(router, method, path) {
  const routeLayer = router.stack.find((layer) => {
    if (!layer.route) return false;
    return layer.route.path === path && layer.route.methods[method];
  });
  // The last handler in the stack is the actual route handler (middleware come first).
  return routeLayer.route.stack[routeLayer.route.stack.length - 1].handle;
}

test('news sources API CRUD and validation', async () => {
  const dir = tempDir();
  process.env.CONTROL_DB_PATH = path.join(dir, 'control.db');
  process.env.ADMIN_COOKIE_SECRET = 'test-secret';

  const controlDb = require('../src/db/control');
  controlDb.close();
  controlDb.setup();

  const apiRouter = require('../src/control/api');
  const list = findRoute(apiRouter, 'get', '/news-sources');
  const create = findRoute(apiRouter, 'post', '/news-sources');
  const getOne = findRoute(apiRouter, 'get', '/news-sources/:id');
  const update = findRoute(apiRouter, 'put', '/news-sources/:id');
  const del = findRoute(apiRouter, 'delete', '/news-sources/:id');

  try {
    // List empty
    const empty = await invoke(list, { query: {}, headers: {} });
    assert.equal(empty.res.statusCode, 200);
    assert.deepEqual(empty.res.jsonBody.sources, []);

    // Create with validation errors
    const bad = await invoke(create, {
      body: { state_slug: 'unknown', source_url: 'not-a-url' },
      headers: { 'x-requested-with': 'XMLHttpRequest' },
    });
    assert.equal(bad.res.statusCode, 400);
    assert.equal(bad.res.jsonBody.ok, false);

    // Create valid source
    const created = await invoke(create, {
      body: {
        state_slug: 'idaho',
        source_name: 'Idaho Statesman',
        source_url: 'https://www.idahostatesman.com/feed',
        source_type: 'rss',
        strategy: 'rssBulletin',
        priority: 50,
      },
      headers: { 'x-requested-with': 'XMLHttpRequest' },
    });
    assert.equal(created.res.statusCode, 201);
    assert.equal(created.res.jsonBody.source.state_slug, 'idaho');
    assert.equal(created.res.jsonBody.source.source_name, 'Idaho Statesman');
    const id = created.res.jsonBody.source.id;

    // List shows it
    const listed = await invoke(list, { query: {}, headers: {} });
    assert.equal(listed.res.jsonBody.sources.length, 1);

    // Get one
    const got = await invoke(getOne, { params: { id: String(id) }, headers: {} });
    assert.equal(got.res.jsonBody.source.id, id);

    // Update
    const updated = await invoke(update, {
      params: { id: String(id) },
      body: { source_name: 'Idaho Statesman Updated', is_enabled: false },
      headers: { 'x-requested-with': 'XMLHttpRequest' },
    });
    assert.equal(updated.res.jsonBody.source.source_name, 'Idaho Statesman Updated');
    assert.equal(updated.res.jsonBody.source.is_enabled, false);

    // Delete
    const deleted = await invoke(del, {
      params: { id: String(id) },
      headers: { 'x-requested-with': 'XMLHttpRequest' },
    });
    assert.equal(deleted.res.jsonBody.ok, true);

    const listed2 = await invoke(list, { query: {}, headers: {} });
    assert.equal(listed2.res.jsonBody.sources.length, 0);
  } finally {
    controlDb.close();
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.CONTROL_DB_PATH;
    delete process.env.ADMIN_COOKIE_SECRET;
  }
});
