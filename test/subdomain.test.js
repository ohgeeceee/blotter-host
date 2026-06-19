'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyHost,
  isAdminHost,
  normalizeHost,
  parseStateFromHost,
  subdomainMiddleware,
} = require('../src/middleware/subdomain');

test('classifies admin.blotter.host as the admin control host', () => {
  assert.deepEqual(classifyHost('admin.blotter.host'), { kind: 'admin' });
  assert.equal(isAdminHost({ headers: { host: 'admin.blotter.host' } }), true);
});

test('keeps the apex host available for the admin control surface', () => {
  assert.deepEqual(classifyHost('blotter.host'), { kind: 'apex' });
  assert.equal(isAdminHost({ headers: { host: 'blotter.host' } }), true);
});

test('normalizes admin host with port before classification', () => {
  assert.equal(normalizeHost('admin.blotter.host:443'), 'admin.blotter.host');
  assert.deepEqual(classifyHost(normalizeHost('admin.blotter.host:443')), { kind: 'admin' });
});

test('continues blocking other reserved subdomains', () => {
  assert.deepEqual(classifyHost('api.blotter.host'), { kind: 'reserved', slug: 'api' });
});

test('parses a tenant state from the host header', () => {
  assert.deepEqual(parseStateFromHost('washington.blotter.host'), {
    isRootDomain: false,
    state: 'washington',
    host: 'washington.blotter.host',
  });
});

test('flags the apex and www hosts as the root domain', () => {
  assert.deepEqual(parseStateFromHost('blotter.host'), {
    isRootDomain: true,
    state: null,
    host: 'blotter.host',
  });
  assert.deepEqual(parseStateFromHost('www.blotter.host'), {
    isRootDomain: true,
    state: null,
    host: 'www.blotter.host',
  });
});

test('middleware attaches req.state for tenant requests', () => {
  const req = { headers: { host: 'washington.blotter.host' } };
  let called = false;
  subdomainMiddleware(req, null, () => {
    called = true;
  });

  assert.equal(called, true);
  assert.deepEqual(req.state, {
    name: 'washington',
    slug: 'washington',
    isRootDomain: false,
    host: 'washington.blotter.host',
    rootDomain: 'blotter.host',
  });
});
