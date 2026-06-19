'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const settings = require('../src/control/settings');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'blotter-settings-'));
}

test('returns production-ready defaults when no settings file exists', () => {
  const dir = tempDir();
  const loaded = settings.getSettings({ dataDir: dir });

  assert.equal(loaded.network.platformName, "America's Transparency Public Data Portal");
  assert.equal(loaded.network.rootDomain, 'blotter.host');
  assert.equal(loaded.network.adminHost, 'admin.blotter.host');
  assert.equal(loaded.network.launchMode, 'staging');
  assert.equal(loaded.production.tlsMode, 'self_signed');
});

test('saves only supported settings fields and loads them back', () => {
  const dir = tempDir();
  const saved = settings.saveSettings({
    network: {
      platformName: 'Blotter Test',
      launchMode: 'production',
      supportEmail: 'ops@example.test',
      ignored: 'nope',
    },
    production: {
      tlsMode: 'wildcard_lets_encrypt',
      databaseMode: 'postgres',
    },
    fleet: {
      maxConcurrentScrapers: 12,
      alertEmail: 'alerts@example.test',
      ignoredFleet: 'nope',
    },
  }, { dataDir: dir });

  assert.equal(saved.network.platformName, 'Blotter Test');
  assert.equal(saved.network.launchMode, 'production');
  assert.equal(saved.network.supportEmail, 'ops@example.test');
  assert.equal(saved.network.ignored, undefined);
  assert.equal(saved.production.tlsMode, 'wildcard_lets_encrypt');
  assert.equal(saved.fleet.maxConcurrentScrapers, 12);
  assert.equal(saved.fleet.alertEmail, 'alerts@example.test');
  assert.equal(saved.fleet.ignoredFleet, undefined);

  const reloaded = settings.getSettings({ dataDir: dir });
  assert.equal(reloaded.network.platformName, 'Blotter Test');
  assert.equal(reloaded.production.databaseMode, 'postgres');
  assert.equal(reloaded.fleet.maxConcurrentScrapers, 12);
});

test('normalizes fleet defaults and rejects invalid values', () => {
  const dir = tempDir();
  const saved = settings.saveSettings({
    fleet: {
      defaultScraperSchedule: 'not a cron',
      maxConcurrentScrapers: 500,
      scraperTimeoutMinutes: 0,
      autoPublishDrafts: 'true',
      maxArticlesPerRun: 2000,
      alertWebhookUrl: 'ftp://bad.example/hook',
      alertEmail: 'not-an-email',
    },
  }, { dataDir: dir });

  assert.equal(saved.fleet.defaultScraperSchedule, '0 */3 * * *');
  assert.equal(saved.fleet.maxConcurrentScrapers, 100);
  assert.equal(saved.fleet.scraperTimeoutMinutes, 1);
  assert.equal(saved.fleet.autoPublishDrafts, true);
  assert.equal(saved.fleet.maxArticlesPerRun, 1000);
  assert.equal(saved.fleet.alertWebhookUrl, '');
  assert.equal(saved.fleet.alertEmail, '');

  const valid = settings.saveSettings({
    fleet: {
      defaultScraperSchedule: '0 4 * * *',
      maxConcurrentScrapers: 3,
      scraperTimeoutMinutes: 60,
      autoPublishDrafts: false,
      maxArticlesPerRun: 25,
      alertWebhookUrl: 'https://hooks.example.com/blotter',
      alertEmail: 'ops@example.test',
    },
  }, { dataDir: dir });

  assert.equal(valid.fleet.defaultScraperSchedule, '0 4 * * *');
  assert.equal(valid.fleet.maxConcurrentScrapers, 3);
  assert.equal(valid.fleet.scraperTimeoutMinutes, 60);
  assert.equal(valid.fleet.autoPublishDrafts, false);
  assert.equal(valid.fleet.maxArticlesPerRun, 25);
  assert.equal(valid.fleet.alertWebhookUrl, 'https://hooks.example.com/blotter');
  assert.equal(valid.fleet.alertEmail, 'ops@example.test');
});

test('builds readiness checks and state launch rows', () => {
  const dir = tempDir();
  const tenantsPath = path.join(dir, 'tenants.json');
  fs.writeFileSync(tenantsPath, JSON.stringify({
    tenants: [
      { slug: 'montana', code: 'MT', name: 'Montana', scraperCommand: 'node scrape.js' },
      { slug: 'wyoming', code: 'WY', name: 'Wyoming' },
    ],
  }));

  const settingsPayload = settings.saveSettings({
    states: {
      montana: { launchStatus: 'live', publicEnabled: true },
      wyoming: { launchStatus: 'configured', publicEnabled: false },
    },
  }, { dataDir: dir });

  const readiness = settings.getReadiness(settingsPayload, {
    dataDir: dir,
    tenantsPath,
    env: {
      ADMIN_PASSWORD_HASH: 'hash',
      ADMIN_COOKIE_SECRET: 'secret',
      DATABASE_URL: 'postgres://example',
    },
    nginxConfigPath: tenantsPath,
    migrationPath: tenantsPath,
  });

  assert.equal(readiness.some((row) => row.key === 'admin_auth' && row.status === 'ok'), true);
  assert.equal(readiness.some((row) => row.key === 'postgres' && row.status === 'ok'), true);

  const rows = settings.getStateLaunchRows(settingsPayload, { tenantsPath });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.slug), ['montana', 'wyoming']);
  assert.equal(rows[0].launchStatus, 'live');
  assert.equal(rows[0].hasCommand, true);
  assert.equal(rows[1].publicEnabled, false);
});
