'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_DATA_DIR = path.join(ROOT, 'data');
const DEFAULT_SETTINGS_PATH = path.join(DEFAULT_DATA_DIR, 'settings.json');
const DEFAULT_TENANTS_PATH = path.join(ROOT, 'tenants.json');
const DEFAULT_NGINX_CONFIG_PATH = '/etc/nginx/sites-enabled/blotter-host.conf';
const DEFAULT_MIGRATION_PATH = path.join(ROOT, 'sql', '001_national_registry_ops.sql');

const DEFAULT_SETTINGS = Object.freeze({
  network: {
    platformName: "America's Transparency Public Data Portal",
    rootDomain: 'blotter.host',
    adminHost: 'admin.blotter.host',
    launchMode: 'staging',
    supportEmail: '',
    publicDisclaimer: 'Public records are provided for transparency from legally available sources. Verify details with the originating agency.',
  },
  admin: {
    sessionHours: 8,
    notes: 'Private mission control for state rollout, scraper controls, and production readiness.',
  },
  production: {
    dnsProvider: 'namecheap',
    tlsMode: 'self_signed',
    databaseMode: 'local_or_unset',
    scraperControllerMode: 'manual',
  },
  fleet: {
    defaultScraperSchedule: '0 */3 * * *',
    maxConcurrentScrapers: 5,
    scraperTimeoutMinutes: 30,
    autoPublishDrafts: false,
    maxArticlesPerRun: 50,
    alertWebhookUrl: '',
    alertEmail: '',
  },
  states: {},
});

const ALLOWED = {
  network: new Set(['platformName', 'rootDomain', 'adminHost', 'launchMode', 'supportEmail', 'publicDisclaimer']),
  admin: new Set(['sessionHours', 'notes']),
  production: new Set(['dnsProvider', 'tlsMode', 'databaseMode', 'scraperControllerMode']),
  fleet: new Set(['defaultScraperSchedule', 'maxConcurrentScrapers', 'scraperTimeoutMinutes', 'autoPublishDrafts', 'maxArticlesPerRun', 'alertWebhookUrl', 'alertEmail']),
};

const ENUMS = {
  launchMode: new Set(['staging', 'production']),
  tlsMode: new Set(['self_signed', 'http_only', 'single_domain_lets_encrypt', 'wildcard_lets_encrypt']),
  databaseMode: new Set(['local_or_unset', 'postgres']),
  scraperControllerMode: new Set(['manual', 'systemd', 'cron', 'agentic_queue']),
  launchStatus: new Set(['not_started', 'configured', 'live', 'needs_attention']),
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function paths(opts = {}) {
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR;
  return {
    dataDir,
    settingsPath: opts.settingsPath || path.join(dataDir, 'settings.json'),
    tenantsPath: opts.tenantsPath || DEFAULT_TENANTS_PATH,
    nginxConfigPath: opts.nginxConfigPath || DEFAULT_NGINX_CONFIG_PATH,
    migrationPath: opts.migrationPath || DEFAULT_MIGRATION_PATH,
  };
}

function mergeDefaults(raw) {
  const base = clone(DEFAULT_SETTINGS);
  if (!raw || typeof raw !== 'object') return base;

  for (const group of ['network', 'admin', 'production', 'fleet']) {
    if (!raw[group] || typeof raw[group] !== 'object') continue;
    for (const key of ALLOWED[group]) {
      if (raw[group][key] !== undefined) base[group][key] = raw[group][key];
    }
  }

  if (raw.states && typeof raw.states === 'object') {
    base.states = sanitizeStates(raw.states);
  }

  return normalizeSettings(base);
}

function normalizeSettings(input) {
  const s = clone(input);
  s.network.platformName = cleanString(s.network.platformName, DEFAULT_SETTINGS.network.platformName);
  s.network.rootDomain = cleanHost(s.network.rootDomain, DEFAULT_SETTINGS.network.rootDomain);
  s.network.adminHost = cleanHost(s.network.adminHost, DEFAULT_SETTINGS.network.adminHost);
  s.network.launchMode = cleanEnum(s.network.launchMode, ENUMS.launchMode, DEFAULT_SETTINGS.network.launchMode);
  s.network.supportEmail = cleanString(s.network.supportEmail, '');
  s.network.publicDisclaimer = cleanString(s.network.publicDisclaimer, DEFAULT_SETTINGS.network.publicDisclaimer);

  s.admin.sessionHours = Math.max(1, Math.min(72, parseInt(s.admin.sessionHours, 10) || DEFAULT_SETTINGS.admin.sessionHours));
  s.admin.notes = cleanString(s.admin.notes, DEFAULT_SETTINGS.admin.notes);

  s.production.dnsProvider = cleanString(s.production.dnsProvider, DEFAULT_SETTINGS.production.dnsProvider);
  s.production.tlsMode = cleanEnum(s.production.tlsMode, ENUMS.tlsMode, DEFAULT_SETTINGS.production.tlsMode);
  s.production.databaseMode = cleanEnum(s.production.databaseMode, ENUMS.databaseMode, DEFAULT_SETTINGS.production.databaseMode);
  s.production.scraperControllerMode = cleanEnum(
    s.production.scraperControllerMode,
    ENUMS.scraperControllerMode,
    DEFAULT_SETTINGS.production.scraperControllerMode
  );

  s.fleet.defaultScraperSchedule = cleanCron(s.fleet.defaultScraperSchedule, DEFAULT_SETTINGS.fleet.defaultScraperSchedule);
  s.fleet.maxConcurrentScrapers = cleanInt(s.fleet.maxConcurrentScrapers, DEFAULT_SETTINGS.fleet.maxConcurrentScrapers, 1, 100);
  s.fleet.scraperTimeoutMinutes = cleanInt(s.fleet.scraperTimeoutMinutes, DEFAULT_SETTINGS.fleet.scraperTimeoutMinutes, 1, 240);
  s.fleet.autoPublishDrafts = s.fleet.autoPublishDrafts === true || s.fleet.autoPublishDrafts === 'true';
  s.fleet.maxArticlesPerRun = cleanInt(s.fleet.maxArticlesPerRun, DEFAULT_SETTINGS.fleet.maxArticlesPerRun, 1, 1000);
  s.fleet.alertWebhookUrl = cleanUrl(s.fleet.alertWebhookUrl, '');
  s.fleet.alertEmail = cleanEmail(s.fleet.alertEmail, '');

  s.states = sanitizeStates(s.states);
  return s;
}

function cleanString(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length ? trimmed.slice(0, 4000) : fallback;
}

function cleanHost(value, fallback) {
  const host = cleanString(value, fallback).toLowerCase();
  return /^[a-z0-9.-]+$/.test(host) ? host : fallback;
}

function cleanEnum(value, allowed, fallback) {
  return allowed.has(value) ? value : fallback;
}

function cleanInt(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function cleanCron(value, fallback) {
  const expr = cleanString(value, fallback).toLowerCase();
  // Allow classic 5-field cron plus optional @keyword shortcuts.
  if (/^@(yearly|annually|monthly|weekly|daily|midnight|hourly)$/.test(expr)) return expr;
  const parts = expr.split(/\s+/);
  if (parts.length === 5) return expr;
  return fallback;
}

function cleanUrl(value, fallback) {
  const s = cleanString(value, fallback);
  if (!s) return fallback;
  try {
    const url = new URL(s);
    return url.protocol === 'http:' || url.protocol === 'https:' ? s : fallback;
  } catch (_err) {
    return fallback;
  }
}

function cleanEmail(value, fallback) {
  const s = cleanString(value, fallback);
  if (!s) return fallback;
  // Loose but practical: require something@something.tld with no spaces.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : fallback;
}

function sanitizeStates(input) {
  const output = {};
  if (!input || typeof input !== 'object') return output;

  for (const [slug, row] of Object.entries(input)) {
    const cleanSlug = String(slug || '').toLowerCase();
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(cleanSlug)) continue;
    const source = row && typeof row === 'object' ? row : {};
    output[cleanSlug] = {
      publicEnabled: source.publicEnabled === false ? false : true,
      launchStatus: cleanEnum(source.launchStatus, ENUMS.launchStatus, 'not_started'),
      notes: typeof source.notes === 'string' ? source.notes.trim().slice(0, 1000) : '',
    };
  }
  return output;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_err) {
    return null;
  }
}

function getSettings(opts = {}) {
  const p = paths(opts);
  return mergeDefaults(readJson(p.settingsPath));
}

function saveSettings(payload, opts = {}) {
  const p = paths(opts);
  const current = getSettings(opts);
  const next = mergeDefaults({ ...current, ...(payload || {}) });
  fs.mkdirSync(p.dataDir, { recursive: true });
  fs.writeFileSync(p.settingsPath, JSON.stringify(next, null, 2) + '\n');
  return next;
}

function loadTenants(tenantsPath) {
  const parsed = readJson(tenantsPath);
  return Array.isArray(parsed && parsed.tenants) ? parsed.tenants : [];
}

function getStateLaunchRows(settingsPayload, opts = {}) {
  const p = paths(opts);
  const s = mergeDefaults(settingsPayload);
  return loadTenants(p.tenantsPath)
    .map((tenant) => {
      const slug = String(tenant.slug || '').toLowerCase();
      const override = s.states[slug] || {};
      return {
        slug,
        code: tenant.code || '',
        name: tenant.name || slug,
        host: slug ? `${slug}.${s.network.rootDomain}` : '',
        publicEnabled: override.publicEnabled !== false,
        launchStatus: override.launchStatus || 'not_started',
        hasCommand: !!tenant.scraperCommand,
        notes: override.notes || tenant.notes || '',
      };
    })
    .filter((row) => row.slug)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function check(key, label, ok, detail) {
  return {
    key,
    label,
    status: ok ? 'ok' : 'needs_attention',
    detail: detail || '',
  };
}

function getReadiness(settingsPayload, opts = {}) {
  const p = paths(opts);
  const env = opts.env || process.env;
  const s = mergeDefaults(settingsPayload);
  const tenants = loadTenants(p.tenantsPath);

  let settingsWritable = false;
  try {
    fs.mkdirSync(p.dataDir, { recursive: true });
    fs.accessSync(p.dataDir, fs.constants.W_OK);
    settingsWritable = true;
  } catch (_err) {
    settingsWritable = false;
  }

  const hasPg = !!(env.DATABASE_URL || env.PGHOST);
  const tlsOk = s.network.launchMode !== 'production' || s.production.tlsMode === 'wildcard_lets_encrypt';

  return [
    check('admin_auth', 'Admin authentication secrets', !!(env.ADMIN_PASSWORD_HASH && env.ADMIN_COOKIE_SECRET), 'Required before mission control can run.'),
    check('settings_file', 'Local settings storage', settingsWritable, p.dataDir),
    check('service_env', 'Production service mode', env.NODE_ENV === 'production', `NODE_ENV=${env.NODE_ENV || ''}`),
    check('postgres', 'PostgreSQL configuration', hasPg, hasPg ? 'Configured' : 'Set DATABASE_URL or PGHOST.'),
    check('registry_migration', 'Registry migration file', fs.existsSync(p.migrationPath), p.migrationPath),
    check('state_registry', 'State tenant registry', tenants.length >= 50, `${tenants.length} tenants registered`),
    check('nginx', 'Nginx blotter host config', fs.existsSync(p.nginxConfigPath), p.nginxConfigPath),
    check('tls', 'Production TLS mode', tlsOk, `tlsMode=${s.production.tlsMode}`),
  ];
}

function buildSettingsResponse(opts = {}) {
  const settingsPayload = getSettings(opts);
  return {
    settings: settingsPayload,
    readiness: getReadiness(settingsPayload, opts),
    states: getStateLaunchRows(settingsPayload, opts),
  };
}

module.exports = {
  DEFAULT_SETTINGS,
  getSettings,
  saveSettings,
  getReadiness,
  getStateLaunchRows,
  buildSettingsResponse,
};
