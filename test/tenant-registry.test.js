'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const registry = require('../tenants.json');
const stateRegistry = require('../src/data/state-registry');

test('tenants.json registers all 50 state subdomains', () => {
  const tenants = registry.tenants || [];
  const slugs = new Set(tenants.map((t) => t.slug));
  const codes = new Set(tenants.map((t) => t.code));

  assert.equal(tenants.length, 50);
  assert.equal(slugs.size, 50);
  assert.equal(codes.size, 50);
  assert.equal(slugs.has('alabama'), true);
  assert.equal(slugs.has('montana'), true);
  assert.equal(slugs.has('wyoming'), true);
  assert.equal(codes.has('AL'), true);
  assert.equal(codes.has('MT'), true);
  assert.equal(codes.has('WY'), true);
});

test('state registry resolves every tenant slug and state code', () => {
  stateRegistry._resetCache();
  for (const tenant of registry.tenants || []) {
    assert.equal(stateRegistry.getBySlug(tenant.slug).code, tenant.code);
    assert.equal(stateRegistry.getByCode(tenant.code).slug, tenant.slug);
  }
});
