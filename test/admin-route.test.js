'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const bcrypt = require('bcrypt');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'blotter-admin-'));
}

function makeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    status(code) {
      this.statusCode = code;
      return this;
    },
    type(value) {
      this.headers['content-type'] = value;
      return this;
    },
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    redirect(code, location) {
      this.statusCode = code;
      this.headers.location = location;
      this.body = '';
      return this;
    },
    send(value) {
      this.body = value;
      return this;
    },
    json(value) {
      this.headers['content-type'] = 'application/json';
      this.body = value;
      return this;
    },
  };
}

function invoke(handler, req) {
  const res = makeResponse();
  return new Promise((resolve, reject) => {
    let settled = false;
    const next = (err) => (err ? reject(err) : resolve({ req, res }));
    try {
      const maybe = handler(req, res, next);
      if (maybe && typeof maybe.then === 'function') {
        maybe.then(() => resolve({ req, res })).catch(reject);
      } else if (!settled) {
        settled = true;
        queueMicrotask(() => resolve({ req, res }));
      }
    } catch (err) {
      reject(err);
    }
  });
}

test('admin routes require SQLite-backed auth', async () => {
  const dir = tempDir();
  process.env.CONTROL_DB_PATH = path.join(dir, 'control.db');
  process.env.ADMIN_COOKIE_SECRET = 'test-secret';
  process.env.NODE_ENV = 'production';

  const controlDb = require('../src/db/control');
  const pg = require('../src/db/pg');
  controlDb.close();
  controlDb.setup();

  const conn = controlDb.getDb();
  const passwordHash = await bcrypt.hash('correct horse battery staple', 10);
  conn.prepare(
    `INSERT INTO admin_users (username, password_hash, role, is_active)
     VALUES (?, ?, 'admin', 1)`
  ).run('admin', passwordHash);

  const adminRouter = require('../src/routes/admin');
  const layers = adminRouter.stack;
  const getLogin = layers.find((layer) => layer.route && layer.route.path === '/login' && layer.route.methods.get).route.stack[0].handle;
  const postLogin = layers.find((layer) => layer.route && layer.route.path === '/login' && layer.route.methods.post).route.stack[0].handle;
  const requireAdmin = layers.find((layer) => layer.name === 'requireAdmin').handle;
  const getRoot = layers.find((layer) => layer.route && layer.route.path === '/' && layer.route.methods.get).route.stack[0].handle;
  const getDashboard = layers.find((layer) => layer.route && layer.route.path === '/dashboard' && layer.route.methods.get).route.stack[0].handle;
  const postUnpublish = layers.find((layer) => layer.route && layer.route.path === '/articles/:id/unpublish' && layer.route.methods.post).route.stack[0].handle;

  const originalAdminQuery = pg.adminQuery;
  const originalInit = pg.initializeDatabase;
  pg.initializeDatabase = async () => ({ ok: true });
  pg.adminQuery = async (sql, params) => {
    if (sql.startsWith('SELECT id, state, headline')) {
      return {
        ok: true,
        rows: [
          {
            id: 42,
            state: 'WA',
            headline: 'Cross-state headline',
            publication_status: 'draft',
            created_at: '2026-06-09T00:00:00Z',
          },
        ],
      };
    }
    if (sql.startsWith('UPDATE generated_articles')) {
      assert.deepEqual(params, [42]);
      return { ok: true, rows: [{ id: 42 }], rowCount: 1 };
    }
    throw new Error('Unexpected SQL: ' + sql);
  };

  try {
    const loginPage = await invoke(getLogin, {
      method: 'GET',
      url: '/login',
      path: '/login',
      headers: {},
    });
    assert.equal(loginPage.res.statusCode, 200);
    assert.match(String(loginPage.res.body), /Admin sign in/);

    const denied = await invoke(requireAdmin, {
      method: 'GET',
      url: '/',
      path: '/',
      headers: {},
    });
    assert.equal(denied.res.statusCode, 401);
    assert.match(String(denied.res.body), /Admin sign in/);

    const badLogin = await invoke(postLogin, {
      method: 'POST',
      url: '/login',
      path: '/login',
      headers: {},
      body: {
        username: 'admin',
        password: 'wrong-password',
      },
    });
    assert.equal(badLogin.res.statusCode, 401);
    assert.match(String(badLogin.res.body), /Invalid credentials/);

    const goodLogin = await invoke(postLogin, {
      method: 'POST',
      url: '/login',
      path: '/login',
      headers: {},
      body: {
        username: 'admin',
        password: 'correct horse battery staple',
      },
    });
    assert.equal(goodLogin.res.statusCode, 303);
    const cookie = goodLogin.res.headers['set-cookie'];
    assert.ok(cookie);
    assert.match(String(cookie), /blotter_control_session=/);

    const granted = await invoke(requireAdmin, {
      method: 'GET',
      url: '/',
      path: '/',
      headers: { cookie: String(cookie) },
    });
    assert.ok(granted.req);

    const rootRedirect = await invoke(getRoot, granted.req);
    assert.equal(rootRedirect.res.statusCode, 303);
    assert.equal(rootRedirect.res.headers.location, '/admin/dashboard');

    const dashboard = await invoke(getDashboard, granted.req);
    assert.equal(dashboard.res.statusCode, 200);
    assert.match(String(dashboard.res.body), /Latest Articles/);
    assert.match(String(dashboard.res.body), /Cross-state headline/);

    const moderation = await invoke(postUnpublish, {
      method: 'POST',
      url: '/articles/42/unpublish',
      path: '/articles/42/unpublish',
      params: { id: '42' },
      headers: { cookie: String(cookie) },
    });
    assert.equal(moderation.res.statusCode, 303);
    assert.equal(moderation.res.headers.location, '/admin/dashboard');
  } finally {
    pg.adminQuery = originalAdminQuery;
    pg.initializeDatabase = originalInit;
    controlDb.close();
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.CONTROL_DB_PATH;
    delete process.env.ADMIN_COOKIE_SECRET;
    delete process.env.NODE_ENV;
  }
});
