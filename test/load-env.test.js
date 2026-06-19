'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { loadEnvFile } = require('../src/lib/load-env');

test('loads key value pairs without overriding existing environment values', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blotter-env-'));
  const envPath = path.join(dir, '.env');
  fs.writeFileSync(envPath, [
    'ADMIN_PASSWORD_HASH=$2b$04$example',
    'ADMIN_COOKIE_SECRET="secret value"',
    'EXISTING_VALUE=from-file',
    '# ignored comment',
    '',
  ].join('\n'));

  const oldExisting = process.env.EXISTING_VALUE;
  process.env.EXISTING_VALUE = 'from-process';
  delete process.env.ADMIN_PASSWORD_HASH;
  delete process.env.ADMIN_COOKIE_SECRET;

  try {
    const loaded = loadEnvFile(envPath);
    assert.equal(loaded, true);
    assert.equal(process.env.ADMIN_PASSWORD_HASH, '$2b$04$example');
    assert.equal(process.env.ADMIN_COOKIE_SECRET, 'secret value');
    assert.equal(process.env.EXISTING_VALUE, 'from-process');
  } finally {
    delete process.env.ADMIN_PASSWORD_HASH;
    delete process.env.ADMIN_COOKIE_SECRET;
    if (oldExisting === undefined) delete process.env.EXISTING_VALUE;
    else process.env.EXISTING_VALUE = oldExisting;
  }
});
