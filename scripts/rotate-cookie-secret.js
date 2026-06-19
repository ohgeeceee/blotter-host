#!/usr/bin/env node
'use strict';

/**
 * scripts/rotate-cookie-secret.js
 *
 * Generates a fresh 32-byte random secret and writes it to
 * ADMIN_COOKIE_SECRET in .env. Backs up .env first. The password
 * hash is left untouched. All existing blotter_admin cookies
 * become invalid (they're HMAC-signed with the old secret).
 *
 * Usage:
 *   node scripts/rotate-cookie-secret.js
 *   node scripts/rotate-cookie-secret.js 'explicit-secret'   # restore from backup
 *   npm run rotate-cookie-secret
 *   node scripts/rotate-cookie-secret.js --help
 *
 * After running:
 *   systemctl restart blotter-host
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENV_PATH = path.resolve(__dirname, '..', '.env');
const FIELD = 'ADMIN_COOKIE_SECRET';
const SECRET_BYTES = 32;
const MIN_SECRET_LENGTH = 32;

function printHelp() {
  process.stdout.write(
    [
      'Usage: node scripts/rotate-cookie-secret.js [SECRET]',
      '',
      'Generates a fresh 32-byte random secret and writes it to',
      'ADMIN_COOKIE_SECRET in .env. The password hash is left untouched.',
      'All existing cookies become invalid.',
      '',
      'SECRET:',
      '  Pass an explicit value to restore a specific secret (e.g. from',
      '  a backup). Otherwise a fresh random value is generated.',
      '',
      'Options:',
      '  -h, --help    Show this help',
      '',
      'After running:',
      '  systemctl restart blotter-host',
      '',
    ].join('\n')
  );
}

function generateSecret() {
  return crypto.randomBytes(SECRET_BYTES).toString('base64url');
}

function patchEnv(text, newValue) {
  const lines = text.split('\n');
  let replaced = false;
  const out = lines.map((line) => {
    if (line.startsWith(FIELD + '=')) {
      replaced = true;
      return FIELD + '=' + newValue;
    }
    return line;
  });
  if (!replaced) out.push(FIELD + '=' + newValue);
  return out.join('\n');
}

function backupName() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return ENV_PATH + '.bak.' + stamp;
}

async function main() {
  if (process.argv.includes('-h') || process.argv.includes('--help')) {
    printHelp();
    process.exit(0);
  }

  const arg = process.argv[2];
  const secret = typeof arg === 'string' && arg.length > 0 ? arg : generateSecret();
  if (secret.length < MIN_SECRET_LENGTH) {
    console.error(
      `Error: secret must be at least ${MIN_SECRET_LENGTH} characters.`
    );
    process.exit(2);
  }

  let envText;
  try {
    envText = fs.readFileSync(ENV_PATH, 'utf8');
  } catch (err) {
    console.error(`Error: cannot read ${ENV_PATH}: ${err.message}`);
    process.exit(1);
  }

  const backupPath = backupName();
  try {
    fs.writeFileSync(backupPath, envText);
  } catch (err) {
    console.error(`Error: cannot write backup ${backupPath}: ${err.message}`);
    process.exit(1);
  }

  const updated = patchEnv(envText, secret);
  try {
    fs.writeFileSync(ENV_PATH, updated);
  } catch (err) {
    console.error(`Error: cannot write ${ENV_PATH}: ${err.message}`);
    console.error('Original .env preserved at ' + backupPath);
    process.exit(1);
  }

  console.log('Updated  ' + ENV_PATH);
  console.log('Backup   ' + backupPath);
  console.log('Secret   ' + secret);
  console.log('');
  console.log('Apply with:');
  console.log('  systemctl restart blotter-host');
}

main().catch((err) => {
  console.error('Fatal: ' + (err && err.message ? err.message : err));
  process.exit(1);
});
