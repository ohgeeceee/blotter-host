'use strict';

/**
 * Tenant registry + status aggregator for the blotter.host control room.
 *
 * This is the single seam between the router and the rest of the network.
 * The view layer asks `getNetworkStatus()` and gets back everything it needs;
 * a future scraper/operator service just swaps the mock `readScrapeHealth`
 * for a real implementation that hits each tenant's scrape log.
 *
 * Design notes
 * ------------
 * - Each tenant declares its slug, display name, and the *paths* to its
 *   artifacts (db file, scrape log). The aggregator resolves those paths
 *   at request time, never at module load time, so a missing tenant can't
 *   crash the whole dashboard.
 * - "Active" is defined strictly: a tenant is Active iff its most recent
 *   successful scrape finished within OFFLINE_AFTER_MS. Anything older is
 *   Offline, even if the HTTP endpoint is still up.
 * - Per-tenant record count comes from a tiny `tenant_stats.json` file
 *   that each tenant's processor writes on every ingestion. The DB file
 *   itself is stat'd for size only — we do not open it from the router.
 */

const fs = require('fs');
const path = require('path');
const { ROOT_DOMAIN } = require('../middleware/subdomain');

const OFFLINE_AFTER_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Tenant registry. In production this would be sourced from a config file
 * or a small `tenants` table. Hard-coded for now — there are <60 of them.
 */
const TENANTS = [
  {
    slug: 'montana',
    displayName: 'Montana',
    region: 'US-West',
    dbPath: '/var/lib/blotter/montana/blotter.db',
    scrapeLogPath: '/var/log/blotter/montana/scrape.log',
    scraperName: 'mt-court-scraper',
  },
  {
    slug: 'idaho',
    displayName: 'Idaho',
    region: 'US-West',
    dbPath: '/var/lib/blotter/idaho/blotter.db',
    scrapeLogPath: '/var/log/blotter/idaho/scrape.log',
    scraperName: 'idaho-scraper',
  },
  {
    slug: 'wyoming',
    displayName: 'Wyoming',
    region: 'US-West',
    dbPath: '/var/lib/blotter/wyoming/blotter.db',
    scrapeLogPath: '/var/log/blotter/wyoming/scrape.log',
    scraperName: 'wy-scraper',
  },
  {
    slug: 'oregon',
    displayName: 'Oregon',
    region: 'US-West',
    dbPath: '/var/lib/blotter/oregon/blotter.db',
    scrapeLogPath: '/var/log/blotter/oregon/scrape.log',
    scraperName: 'or-scraper',
  },
  {
    slug: 'utah',
    displayName: 'Utah',
    region: 'US-West',
    dbPath: '/var/lib/blotter/utah/blotter.db',
    scrapeLogPath: '/var/log/blotter/utah/scrape.log',
    scraperName: 'ut-scraper',
  },
  {
    slug: 'colorado',
    displayName: 'Colorado',
    region: 'US-Mountain',
    dbPath: '/var/lib/blotter/colorado/blotter.db',
    scrapeLogPath: '/var/log/blotter/colorado/scrape.log',
    scraperName: 'co-scraper',
  },
];

/* ------------------------------------------------------------------ */
/* File-system readers                                                */
/* ------------------------------------------------------------------ */

function statSafe(p) {
  try {
    return fs.statSync(p);
  } catch (_e) {
    return null;
  }
}

function readDbSize(p) {
  const st = statSafe(p);
  return st ? st.size : null;
}

/**
 * The tenant writes a `tenant_stats.json` next to its DB on every
 * successful scrape. Shape:
 *   { "records": 123456, "last_successful_run": "2026-06-06T07:10:00Z" }
 *
 * If the file is missing or malformed, we surface that as null — the
 * dashboard then shows "—" rather than a stale value.
 */
function readScrapeHealth(tenant) {
  const statsPath = path.join(path.dirname(tenant.dbPath), 'tenant_stats.json');

  let records = null;
  let lastSuccessfulRun = null;

  try {
    const raw = fs.readFileSync(statsPath, 'utf8');
    const obj = JSON.parse(raw);
    if (Number.isFinite(obj.records)) records = obj.records;
    if (typeof obj.last_successful_run === 'string') {
      const t = Date.parse(obj.last_successful_run);
      if (!Number.isNaN(t)) lastSuccessfulRun = new Date(t);
    }
  } catch (_e) {
    // Missing or malformed — treat as no signal.
  }

  const pidPath = path.join(path.dirname(tenant.dbPath), 'scraper.pid');
  const scraperRunning = statSafe(pidPath) !== null;

  return { records, lastSuccessfulRun, scraperRunning };
}

/* ------------------------------------------------------------------ */
/* Mock fallback (development)                                        */
/* ------------------------------------------------------------------ */

const MOCK_HEALTH = {
  montana: { records: 1_284_312, lastSuccessfulRunDeltaMin: 38, scraperRunning: false },
  idaho: { records: 612_007, lastSuccessfulRunDeltaMin: 142, scraperRunning: false },
  wyoming: { records: 198_445, lastSuccessfulRunDeltaMin: 14, scraperRunning: true },
  oregon: { records: 0, lastSuccessfulRunDeltaMin: null, scraperRunning: false },
  utah: { records: 401_223, lastSuccessfulRunDeltaMin: 92, scraperRunning: false },
  colorado: { records: 884_901, lastSuccessfulRunDeltaMin: 8, scraperRunning: false },
};

function applyMockIfNoFs(tenant) {
  // If the file system has no DB at all for this tenant, fall back to
  // a deterministic mock so the dashboard still renders in dev.
  const realSize = readDbSize(tenant.dbPath);
  if (realSize !== null) return null;

  const mock = MOCK_HEALTH[tenant.slug];
  if (!mock) {
    return {
      records: null,
      dbSizeBytes: null,
      lastSuccessfulRun: null,
      scraperRunning: false,
      mocked: true,
    };
  }

  return {
    records: mock.records,
    dbSizeBytes: estimateDbSize(mock.records),
    lastSuccessfulRun:
      mock.lastSuccessfulRunDeltaMin == null
        ? null
        : new Date(Date.now() - mock.lastSuccessfulRunDeltaMin * 60_000),
    scraperRunning: mock.scraperRunning,
    mocked: true,
  };
}

function estimateDbSize(records) {
  // ~280 bytes per row of mixed blotter content, rounded to look real.
  return Math.round(records * 280 * (1 + Math.random() * 0.05));
}

/* ------------------------------------------------------------------ */
/* Public API                                                         */
/* ------------------------------------------------------------------ */

function isActive(lastSuccessfulRun, now = Date.now()) {
  if (!lastSuccessfulRun) return false;
  return now - lastSuccessfulRun.getTime() <= OFFLINE_AFTER_MS;
}

function buildTenantRow(tenant, now) {
  const fsHealth = readScrapeHealth(tenant);
  const mock = applyMockIfNoFs(tenant);
  const health = mock || {
    records: fsHealth.records,
    dbSizeBytes: readDbSize(tenant.dbPath),
    lastSuccessfulRun: fsHealth.lastSuccessfulRun,
    scraperRunning: fsHealth.scraperRunning,
    mocked: false,
  };

  return {
    slug: tenant.slug,
    displayName: tenant.displayName,
    region: tenant.region,
    host: `${tenant.slug}.${ROOT_DOMAIN}`,
    status: isActive(health.lastSuccessfulRun, now) ? 'active' : 'offline',
    lastSuccessfulRun: health.lastSuccessfulRun,
    records: health.records,
    dbSizeBytes: health.dbSizeBytes,
    scraperName: tenant.scraperName,
    scraperRunning: health.scraperRunning,
    mocked: !!health.mocked,
  };
}

function getNetworkStatus() {
  const now = Date.now();
  const tenants = TENANTS.map((t) => buildTenantRow(t, now));

  const network = tenants.reduce(
    (acc, t) => {
      acc.totalRecords += t.records || 0;
      acc.totalDbSizeBytes += t.dbSizeBytes || 0;
      if (t.scraperName) acc.configuredScrapers += 1;
      if (t.scraperRunning) acc.activeScrapers += 1;
      return acc;
    },
    { totalRecords: 0, totalDbSizeBytes: 0, configuredScrapers: 0, activeScrapers: 0 }
  );

  return {
    generatedAt: new Date(now).toISOString(),
    offlineAfterMs: OFFLINE_AFTER_MS,
    network: {
      ...network,
      tenantCount: tenants.length,
      activeTenants: tenants.filter((t) => t.status === 'active').length,
    },
    tenants,
  };
}

module.exports = {
  TENANTS,
  OFFLINE_AFTER_MS,
  isActive,
  getNetworkStatus,
};
