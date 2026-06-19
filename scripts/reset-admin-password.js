#!/usr/bin/env node
'use strict';

/**
 * scripts/reset-admin-password.js
 *
 * Generates a fresh bcrypt hash for a new admin password and writes
 * it to ADMIN_PASSWORD_HASH in .env. Backs up .env first. The cookie
 * secret (ADMIN_COOKIE_SECRET) is intentionally left untouched.
 *
 * Usage:
 *   node scripts/reset-admin-password.js 'new-plaintext'
 *   echo 'new-plaintext' | node scripts/reset-admin-password.js
 *   npm run reset-admin-password -- 'new-plaintext'
 *   node scripts/reset-admin-password.js --help
 *
 * After running:
 *   systemctl restart blotter-host
 */

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');

const ENV_PATH = path.resolve(__dirname, '..', '.env');
const COST = 12;
const MIN_PASSWORD_LENGTH = 8;

function printHelp() {
  process.stdout.write(
    [
      'Usage: node scripts/reset-admin-password.js [PASSWORD]',
      '',
      'Generates a fresh bcrypt hash and writes it to ADMIN_PASSWORD_HASH',
      'in .env. The cookie secret is left untouched.',
      '',
      'PASSWORD:',
      '  Pass the new plaintext as the first argument, or pipe it on stdin',
      '  (use `read -s` in bash to keep it out of your shell history).',
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

function getPasswordFromArgv() {
  const arg = process.argv[2];
  if (typeof arg === 'string' && arg.length > 0) return arg;
  return null;
}

function getPasswordFromStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buf += chunk;
    });
    process.stdin.on('end', () => {
      resolve(buf.replace(/\r?\n$/, ''));
    });
    process.stdin.on('error', reject);
  });
}

async function getPassword() {
  if (process.argv.includes('-h') || process.argv.includes('--help')) {
    printHelp();
    process.exit(0);
  }
  const fromArg = getPasswordFromArgv();
  if (fromArg) return fromArg;
  if (process.stdin.isTTY) {
    console.error('Error: no password provided.');
    console.error('Pass it as the first argument, or pipe it on stdin.');
    console.error('Run with --help for usage.');
    process.exit(2);
  }
  return getPasswordFromStdin();
}

function patchEnv(text, newHash) {
  const lines = text.split('\n');
  let replaced = false;
  const out = lines.map((line) => {
    if (line.startsWith('ADMIN_PASSWORD_HASH=')) {
      replaced = true;
      return 'ADMIN_PASSWORD_HASH=' + newHash;
    }
    return line;
  });
  if (!replaced) out.push('ADMIN_PASSWORD_HASH=' + newHash);
  return out.join('\n');
}

function backupName() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return ENV_PATH + '.bak.' + stamp;
}

async function main() {
  const password = await getPassword();
  if (!password) {
    console.error('Error: empty password.');
    process.exit(2);
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(
      `Error: password must be at least ${MIN_PASSWORD_LENGTH} characters.`
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

  const hash = await bcrypt.hash(password, COST);
  const backupPath = backupName();

  try {
    fs.writeFileSync(backupPath, envText);
  } catch (err) {
    console.error(`Error: cannot write backup ${backupPath}: ${err.message}`);
    process.exit(1);
  }

  const updated = patchEnv(envText, hash);
  try {
    fs.writeFileSync(ENV_PATH, updated);
  } catch (err) {
    console.error(`Error: cannot write ${ENV_PATH}: ${err.message}`);
    console.error('Original .env preserved at ' + backupPath);
    process.exit(1);
  }

  console.log('Updated  ' + ENV_PATH);
  console.log('Backup   ' + backupPath);
  console.log('Hash     ' + hash);
  console.log('');
  console.log('Apply with:');
  console.log('  systemctl restart blotter-host');
}

main().catch((err) => {
  console.error('Fatal: ' + (err && err.message ? err.message : err));
  process.exit(1);
});
